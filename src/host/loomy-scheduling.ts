import { AsyncLocalStorage } from "node:async_hooks"
import { createHash, randomInt } from "node:crypto"
import { LlmError } from "@deepseek-ai/dsh-llm"

import { assertLoomySchedulingContract, loadLoomyScheduling, loadSchedulingLedger } from "../core/upstream.ts"
import { createAccountScheduler } from "../modules/scheduling/account-scheduler.ts"
import { clearModelCooldowns } from "../modules/scheduling/model-cooldowns.ts"
import type { ChannelSchedulingConfig } from "../modules/scheduling/scheduling-settings.service.ts"
import type { GatewayContext } from "./gateway-context.ts"
import { acquireScheduledAccount, wrapScheduledAdapter } from "./scheduled-adapter.ts"
import { createLoomyModels } from "./loomy-models.ts"

async function waitForAbort<T>(work: Promise<T>, signal?: AbortSignal) {
  if (!signal) return work
  signal.throwIfAborted()
  let abort!: () => void
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
  })
  try {
    return await Promise.race([work, cancelled])
  } finally {
    signal.removeEventListener("abort", abort)
  }
}

export async function installLoomyScheduling(
  ctx: any,
  gateway: AsyncLocalStorage<GatewayContext>,
  config: ChannelSchedulingConfig,
) {
  const native = await loadLoomyScheduling()
  const reportAccount = await loadSchedulingLedger()
  const dispatch = new AsyncLocalStorage<any>()
  const llm = ctx.get("llm")
  const register = llm.registerAdapter
  let pool: any
  let scheduler: ReturnType<typeof createAccountScheduler>
  llm.registerAdapter = function (providers: string[], adapter: any) {
    if (!providers.includes("loomy")) return register.call(this, providers, adapter)
    assertLoomySchedulingContract(adapter)
    pool = adapter.options.accountPool
    const catalog = createLoomyModels({ native, pool, adapter, fetcher: (url: any, init: any) => fetchImpl(url, init) })
    adapter.options.fetchRemoteModels = () => {
      catalog.clear()
      return catalog.load()
    }
    const balances = new Map<string, any>()
    const manualOrder = new Map<string, number>()
    const cooling = (entry: any, model: string) =>
      Object.entries(entry.modelRateLimits ?? {}).some(
        ([id, until]: any) => native.catalogKey(id) === native.catalogKey(model) && until > Date.now(),
      )
    const baseCandidates = (model: string, excluded: Set<string>) =>
      pool.candidateAccounts("loomy", "", excluded).filter((entry: any) => !model || !cooling(entry, model))
    const candidates = (model: string, excluded: Set<string>) => {
      const entries = baseCandidates(model, excluded)
      const available = entries.filter((entry: any) => catalog.modelFor(entry.id, model))
      if (
        !available.length &&
        pool
          .candidateAccounts("loomy", "", new Set())
          .some((entry: any) => catalog.modelFor(entry.id, model) && cooling(entry, model))
      )
        throw new LlmError("Loomy 当前模型的账号均在冷却中，请稍后重试", "RATE_LIMIT", { status: 429 })
      if (!available.length && [...excluded].some((id) => catalog.modelFor(id, model))) return []
      if (entries.length && !available.length) {
        const unknown = entries.some((entry: any) => !catalog.known(entry.id))
        throw new LlmError(
          unknown ? "Loomy 账号模型权限暂时无法确认，请稍后重试" : `Loomy 模型不存在或当前账号均不支持：${model}`,
          unknown ? "TRANSPORT" : "INVALID_REQUEST",
          { status: unknown ? 503 : 404 },
        )
      }
      const options = { allowPermanent: !pool.permanentLocked("loomy") }
      const ranked = available.map((entry: any) => ({
        entry,
        tier: native.tier(balances.get(entry.id) ?? {}, options),
      }))
      if (!options.allowPermanent && ranked.length && ranked.every((item: any) => !native.tierUsable(item.tier))) {
        const unknown = available.some((entry: any) => !balances.get(entry.id)?.ok)
        throw new LlmError(
          unknown ? "Loomy 余额暂时无法确认，永久积分保持锁定，请稍后重试" : "Loomy 今日额度已用尽，永久积分保持锁定",
          unknown ? "TRANSPORT" : "QUOTA_EXCEEDED",
        )
      }
      const best = Math.min(...ranked.map((item: any) => item.tier))
      if (pool.strictManualOrder?.("loomy")) {
        const usable = ranked.filter((item: any) => native.tierUsable(item.tier))
        return (usable.length ? usable : ranked).map((item: any) => item.entry)
      }
      return ranked.filter((item: any) => item.tier === best).map((item: any) => item.entry)
    }
    scheduler = createAccountScheduler({
      config,
      label: "Loomy",
      candidates,
      priority: (entry) => (pool.strictManualOrder?.("loomy") ? (manualOrder.get(entry.id) ?? 0) : 0),
      resolve: (entry) => pool.resolveFirstCredential("loomy", [entry]),
    })
    const resolve = adapter.options.resolveCredential
    adapter.options.resolveCredential = async (...args: any[]) => {
      const state = dispatch.getStore()
      if (!state) return resolve(...args)
      if (!state.balancesReady) {
        await waitForAbort(catalog.load(), state.signal)
        const entries = baseCandidates(state.model, state.excluded).filter((entry: any) =>
          catalog.modelFor(entry.id, state.model),
        )
        const readings = await waitForAbort(
          Promise.all(
            entries.map(async (entry: any) => {
              const account = await pool.resolveFirstCredential("loomy", [entry])
              if (!account) return [entry.id, { ok: false }]
              const cache = native.balanceCache()
              if (cache) {
                const reading = await cache.readStale("loomy", entry.id, { credential: account.credential })
                const packages = reading.value?.packages ?? []
                // CreditBalance 的两池名称是上游注册表契约，余额值与缓存新鲜度由上游维护。
                const dailyBalance = packages.find((pkg: any) => pkg.name.includes("每日"))?.remaining
                const permanentBalance = packages.find((pkg: any) => pkg.name.includes("永久"))?.remaining
                return [
                  entry.id,
                  { ok: dailyBalance !== undefined || permanentBalance !== undefined, dailyBalance, permanentBalance },
                ]
              }
              const balance = await native.fetchBalance(account.credential, adapter.product, adapter.fetchImpl)
              return [entry.id, { ok: !!balance, dailyBalance: balance?.daily, permanentBalance: balance?.permanent }]
            }),
          ),
          state.signal,
        )
        for (const [id, balance] of readings) balances.set(id, balance)
        manualOrder.clear()
        baseCandidates("", new Set()).forEach((entry: any, index: number) => manualOrder.set(entry.id, index))
        state.balancesReady = true
      }
      state.signal?.throwIfAborted()
      const account = await acquireScheduledAccount(state, scheduler)
      reportAccount("loomy", account.entry.id)
      return account.credential
    }
    const refresh = adapter.options.refresh
    adapter.options.refresh = async (...args: any[]) => {
      const state = dispatch.getStore()
      return state?.lease ? refresh(state.lease.account.credential) : refresh(...args)
    }
    const markFailure = async (kind: string, state: any) => {
      if (!state.lease) return
      if (kind === "auth") scheduler.blockAccount(state.lease.entry.id)
      if (["quota", "rate"].includes(kind) && !cooling(pool.findAccount(state.lease.entry.id) ?? {}, state.model))
        await pool.updateModelRateLimit(
          state.lease.entry.id,
          catalog.modelFor(state.lease.entry.id, state.model)?.id ?? state.model,
          kind === "quota"
            ? native.quotaResetAt("quota")
            : Date.now() + randomInt(config.cooldownMinSeconds, config.cooldownMaxSeconds + 1) * 1000,
        )
    }
    const code = (kind: string) => (kind === "auth" ? "AUTH" : kind === "quota" ? "QUOTA_EXCEEDED" : "RATE_LIMIT")
    const getAvailable = pool.getAvailableAccount
    pool.getAvailableAccount = async function (provider: string, model: string, excluded: Set<string>, ...rest: any[]) {
      const state = dispatch.getStore()
      if (provider !== "loomy" || !state?.lease) return getAvailable.call(this, provider, model, excluded, ...rest)
      throw new LlmError("Loomy 当前账号受限，切换账号重试", "QUOTA_EXCEEDED")
    }
    const wrapFetch = (fetcher: any) =>
      async function (this: any, url: any, init: any = {}) {
        const state = dispatch.getStore()
        if (!state || !String(url).endsWith("/chat/completions")) return fetcher.call(this, url, init)
        const body = JSON.parse(init.body)
        const model = catalog.modelFor(state.lease?.entry.id, state.model)
        if (!model)
          throw new LlmError(`Loomy 模型不存在或当前账号不支持：${state.model}`, "INVALID_REQUEST", { status: 404 })
        body.model = model.id
        body.prompt_cache_key = createHash("sha256")
          .update(`loomy\0${state.sessionKey ?? state.requestId}\0${state.lease?.entry.id ?? ""}`)
          .digest("hex")
        const response = await fetcher.call(this, url, { ...init, body: JSON.stringify(body) })
        let kind = "other"
        if (!response.ok) kind = native.classify(await response.clone().text(), response.status)
        else if (response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
          const envelope = native.envelope(
            await response
              .clone()
              .json()
              .catch(() => ({})),
          )
          if (!envelope.ok)
            kind =
              envelope.code === "100002"
                ? "auth"
                : native.classify(`${envelope.code} ${envelope.message}`, response.status)
        }
        if (kind !== "other") {
          await response.body?.cancel().catch(() => {})
          await markFailure(kind, state)
          throw new LlmError(
            `Loomy 当前账号${kind === "auth" ? "凭据不可用" : "模型受限"}，正在尝试其他账号`,
            code(kind),
            { status: kind === "auth" ? 401 : 429 },
          )
        }
        return response
      }
    let fetchImpl = wrapFetch(adapter.fetchImpl)
    Object.defineProperty(adapter, "fetchImpl", {
      configurable: true,
      get: () => fetchImpl,
      set: (value) => {
        fetchImpl = wrapFetch(value)
      },
    })
    const wrapped = wrapScheduledAdapter(adapter, {
      ctx,
      gateway,
      dispatch,
      config,
      candidates,
      provider: "loomy",
      label: "Loomy",
      onError: async (error: any, state: any) => {
        const kind =
          error.code === "QUOTA_EXCEEDED"
            ? "quota"
            : error.code === "AUTH"
              ? "auth"
              : native.classify(
                  String(error.message),
                  ["RATE_LIMIT", "QUEUE"].includes(error.code) ? 429 : error.failure?.status,
                )
        if (kind === "other") return error
        await markFailure(kind, state)
        return new LlmError(error.message, code(kind), { status: error.failure?.status })
      },
    })
    return register.call(this, providers, wrapped)
  }
  ctx.effect(
    () => () => {
      llm.registerAdapter = register
      scheduler?.close()
    },
    "loomy-scheduling",
  )
  return {
    assertReady() {
      if (!scheduler) throw new Error("上游未注册 Loomy 调度入口，请核对 src/core/upstream.ts")
    },
    stats: () => scheduler?.stats(),
    wake: () => scheduler?.wake(),
    async clearCooldowns(selection: any) {
      const result = await clearModelCooldowns(pool, "loomy", selection)
      scheduler.wake()
      return result
    },
  }
}
