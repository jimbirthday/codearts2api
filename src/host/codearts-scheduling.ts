import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"
import { LlmError } from "@deepseek-ai/dsh-llm"

import {
  assertCodeArtsSchedulingContract,
  loadCodeArtsConcurrencyClassifier,
  loadSchedulingLedger,
} from "../core/upstream.ts"
import { createAccountScheduler } from "../modules/scheduling/account-scheduler.ts"
import { createModelCooldowns } from "../modules/scheduling/model-cooldowns.ts"
import type { ChannelSchedulingConfig } from "../modules/scheduling/scheduling-settings.service.ts"
import type { GatewayContext } from "./gateway-context.ts"
import { acquireScheduledAccount, wrapScheduledAdapter } from "./scheduled-adapter.ts"

function sessionId(state: any, task: boolean) {
  return createHash("sha256")
    .update(
      `sessionId\0${task ? state.requestId : (state.sessionKey ?? state.requestId)}\0${state.lease?.entry.id ?? ""}`,
    )
    .digest("hex")
    .slice(0, 32)
}

export async function installCodeArtsScheduling(
  ctx: any,
  gateway: AsyncLocalStorage<GatewayContext>,
  config: ChannelSchedulingConfig,
) {
  const isConcurrencyLimitError = await loadCodeArtsConcurrencyClassifier()
  const reportAccount = await loadSchedulingLedger()
  const dispatch = new AsyncLocalStorage<any>()
  const llm = ctx.get("llm")
  const originalRegister = llm.registerAdapter
  let scheduler: ReturnType<typeof createAccountScheduler>
  let cooldowns: ReturnType<typeof createModelCooldowns>

  llm.registerAdapter = function (providers: string[], adapter: any) {
    if (!providers.includes("codearts")) return originalRegister.call(this, providers, adapter)
    assertCodeArtsSchedulingContract(adapter)
    const options = adapter.options
    const pool = options.accountPool
    cooldowns = createModelCooldowns(pool, () => scheduler?.wake(), config)
    const queueError = () => new LlmError("CodeArts 当前账号的模型排队中，请稍后重试", "QUEUE", { status: 429 })
    scheduler = createAccountScheduler({
      config,
      candidates: (model, excluded) => {
        const now = Date.now()
        const available = pool.candidateAccounts("codearts", model, excluded)
        if (
          !available.length &&
          pool.candidateAccounts("codearts", "", excluded).some((entry: any) => entry.modelRateLimits?.[model] > now)
        ) {
          throw queueError()
        }
        return available
      },
      resolve: (entry) => pool.resolveFirstCredential("codearts", [entry]),
    })
    const choose = async (state: any) => {
      const account = await acquireScheduledAccount(state, scheduler)
      reportAccount("codearts", account.entry.id)
      return account
    }
    const rejectQueue = async (state: any, accountConcurrency = false) => {
      if (state.lease) {
        if (accountConcurrency) scheduler.blockAccount(state.lease.entry.id)
        else await pool.updateModelRateLimit(state.lease.entry.id, state.model, Date.now() + 60_000)
      }
      throw queueError()
    }
    const wrapFetch = (transport: any) =>
      async function (this: any, ...args: any[]) {
        const state = dispatch.getStore()
        if (state && typeof args[0] === "string" && args[0].endsWith("/chat/completions")) {
          // Session-Id 不参与签名；正文缓存键保持稳定，只有队列任务头按请求隔离。
          const headers = new Headers(args[1]?.headers)
          headers.set("Session-Id", sessionId(state, true))
          args[1] = { ...args[1], headers }
        }
        const chat = state && typeof args[0] === "string" && args[0].endsWith("/chat/completions")
        // 断连或超时不能确认远端未建会话，保守保留占位；明确拒绝时才回滚。
        if (chat) state.lease?.acceptSession()
        const response = await transport.apply(this, args)
        if (chat && !response.ok) state.lease?.rejectSession()
        if (state && !response.ok) {
          const body = await response.clone().text()
          // TM.00001041 可与 queue/status=working 同时出现，不能依赖队列状态判定。
          if (isConcurrencyLimitError(body)) {
            await response.body?.cancel().catch(() => {})
            await rejectQueue(state, true)
          }
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
    const consumeSse = adapter.consumeSse
    adapter.consumeSse = async function* (...args: any[]) {
      try {
        yield* consumeSse.apply(this, args)
      } catch (error: any) {
        // 由上游解析业务码；只转换其已分类的排队信号，阻止内部静默重放。
        const state = dispatch.getStore()
        if (state && error?.name === "SseQueueRetryError")
          await rejectQueue(state, isConcurrencyLimitError(JSON.stringify({ error_code: error.code })))
        throw error
      }
    }
    const queryQueueStatus = adapter.queryQueueStatus
    adapter.queryQueueStatus = async function (...args: any[]) {
      const state = dispatch.getStore()
      const status = await (state
        ? dispatch.run({ ...state, queueQuery: true }, () => queryQueueStatus.apply(this, args))
        : queryQueueStatus.apply(this, args))
      if (state && ["waiting", "queue_full"].includes(status?.status)) await rejectQueue(state)
      return status
    }
    const resolveCredential = options.resolveCredential
    options.resolveCredential = async (...args: any[]) => {
      const state = dispatch.getStore()
      return state ? (await choose(state)).credential : resolveCredential(...args)
    }
    const refresh = options.refresh
    options.refresh = async (...args: any[]) => {
      const state = dispatch.getStore()
      if (!state) return refresh(...args)
      const { entry } = await choose(state)
      await ctx.get("codeartsAuth").refreshAccountCredential(entry.credentialRef, pool, entry.id)
      const updated = await pool.resolveFirstCredential("codearts", [entry])
      if (!updated) throw new LlmError("CodeArts 续期后凭据不可读，请重新登录", "MISSING_CREDENTIAL")
      state.lease.account = updated
    }
    const getAvailable = pool.getAvailableAccount
    pool.getAvailableAccount = async function (
      provider: string,
      model: string,
      excluded?: Set<string>,
      ...rest: any[]
    ) {
      const state = dispatch.getStore()
      if (provider !== "codearts" || !state) return getAvailable.call(this, provider, model, excluded, ...rest)
      if (state.emitted) throw new LlmError("CodeArts 输出后账号受限，已停止重放，请重试", "QUOTA_EXCEEDED")
      if (state.lease) state.excluded.add(state.lease.entry.id)
      for (const id of excluded ?? []) state.excluded.add(id)
      if (pool.candidateAccounts("codearts", state.model, state.excluded).length === 0) return null
      // 重新打开适配器流，让换号后的正文缓存键与签名一起按新账号生成。
      throw new LlmError("CodeArts 当前账号模型受限，切换账号重试", "QUOTA_EXCEEDED")
    }
    for (const property of ["chatId", "sessionId"]) {
      const fallback = adapter[property]
      Object.defineProperty(adapter, property, {
        configurable: true,
        get() {
          const state = dispatch.getStore()
          if (!state) return fallback
          if (property === "sessionId") return sessionId(state, state.queueQuery === true)
          const identity = state.sessionKey ?? state.requestId
          return createHash("sha256")
            .update(`${property}\0${identity}\0${state.lease?.entry.id ?? ""}`)
            .digest("hex")
            .slice(0, 32)
        },
      })
    }

    const wrapped = wrapScheduledAdapter(adapter, {
      ctx,
      gateway,
      dispatch,
      config,
      candidates: (model: string, excluded: Set<string>) => pool.candidateAccounts("codearts", model, excluded),
      provider: "codearts",
      label: "CodeArts",
    })
    return originalRegister.call(this, providers, wrapped)
  }

  ctx.effect(
    () => () => {
      llm.registerAdapter = originalRegister
      scheduler?.close()
      cooldowns?.close()
    },
    "codearts-scheduling",
  )
  return {
    assertReady() {
      if (!scheduler) throw new Error("上游未注册 CodeArts 调度入口，请核对 src/core/upstream.ts")
    },
    normalizeCooldowns: () => cooldowns.normalize(),
    clearCooldowns: (selection: Parameters<typeof cooldowns.clear>[0]) => cooldowns.clear(selection),
    stats: () => scheduler?.stats(),
    wake: () => scheduler?.wake(),
  }
}
