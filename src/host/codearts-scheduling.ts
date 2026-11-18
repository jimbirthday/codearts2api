import { AsyncLocalStorage } from "node:async_hooks"
import { createHash, randomUUID } from "node:crypto"
import { LlmError } from "@deepseek-ai/dsh-llm"

import { resolveCodeArtsScheduling } from "../config/env.ts"
import { assertCodeArtsSchedulingContract } from "../core/upstream.ts"
import { createAccountScheduler } from "../modules/scheduling/account-scheduler.ts"
import { installGatewayContext, type GatewayContext } from "./gateway-context.ts"

const ACCOUNT_FAILURES = new Set([
  "AUTH",
  "MISSING_CREDENTIAL",
  "INVALID_CREDENTIAL",
  "QUOTA",
  "QUOTA_EXCEEDED",
  "RATE_LIMIT",
  "QUEUE",
  "TRANSPORT",
  "TIMEOUT",
  "SERVER",
  "EMPTY_RESPONSE",
])

const accountFailure = (error: any) =>
  error instanceof LlmError ? ACCOUNT_FAILURES.has(error.code) : error?.name !== "AbortError"

export function installCodeArtsScheduling(ctx: any) {
  const config = resolveCodeArtsScheduling()
  const gateway = new AsyncLocalStorage<GatewayContext>()
  const dispatch = new AsyncLocalStorage<any>()
  const detach = installGatewayContext(gateway, Number(process.env.DSH_OPENAI_GATEWAY_PORT?.trim() || 8326))
  const llm = ctx.get("llm")
  const originalRegister = llm.registerAdapter
  let scheduler: ReturnType<typeof createAccountScheduler>

  llm.registerAdapter = function (providers: string[], adapter: any) {
    if (!providers.includes("codearts")) return originalRegister.call(this, providers, adapter)
    assertCodeArtsSchedulingContract(adapter)
    const options = adapter.options
    const pool = options.accountPool
    scheduler = createAccountScheduler({
      config,
      candidates: (model, excluded) => pool.candidateAccounts("codearts", model, excluded),
      resolve: (entry) => pool.resolveFirstCredential("codearts", [entry]),
    })
    const choose = async (state: any, excluded = state.excluded) => {
      if (!state.lease) {
        const started = performance.now()
        try {
          state.lease = await scheduler.acquire({
            model: state.model,
            sessionKey: state.sessionKey,
            excluded,
            signal: state.signal,
          })
          state.attempts++
          state.accounts.add(createHash("sha256").update(state.lease.entry.id).digest("hex").slice(0, 12))
        } finally {
          state.acquireMs += performance.now() - started
        }
      }
      return state.lease.account
    }
    const rejectQueue = async (state: any) => {
      if (state.lease) {
        // 复用上游的模型限流表，避免新会话不断撞回同一个排队账号。
        await pool.updateModelRateLimit(state.lease.entry.id, state.model, Date.now() + 10_000)
      }
      throw new LlmError("CodeArts 当前账号的模型排队中，请稍后重试", "QUEUE", { status: 429 })
    }
    const consumeSse = adapter.consumeSse
    adapter.consumeSse = async function* (...args: any[]) {
      try {
        yield* consumeSse.apply(this, args)
      } catch (error: any) {
        // 由上游解析业务码；只转换其已分类的排队信号，阻止内部静默重放。
        const state = dispatch.getStore()
        if (state && error?.name === "SseQueueRetryError") await rejectQueue(state)
        throw error
      }
    }
    const queryQueueStatus = adapter.queryQueueStatus
    adapter.queryQueueStatus = async function (...args: any[]) {
      const status = await queryQueueStatus.apply(this, args)
      const state = dispatch.getStore()
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
      if (state.lease) {
        state.excluded.add(state.lease.entry.id)
        state.lease.release("failure")
        state.lease = undefined
      }
      for (const id of excluded ?? []) state.excluded.add(id)
      if (pool.candidateAccounts("codearts", state.model, state.excluded).length === 0) return null
      return choose(state)
    }
    for (const property of ["chatId", "sessionId"]) {
      const fallback = adapter[property]
      Object.defineProperty(adapter, property, {
        configurable: true,
        get() {
          const state = dispatch.getStore()
          if (!state) return fallback
          // Chat-Id 属于会话；Session-Id 同时是队列 task_id，必须隔离并发推理任务。
          const identity = property === "chatId" ? (state.sessionKey ?? state.requestId) : state.requestId
          return createHash("sha256")
            .update(`${property}\0${identity}\0${state.lease?.entry.id ?? ""}`)
            .digest("hex")
            .slice(0, 32)
        },
      })
    }

    const run = (open: () => AsyncIterable<any>, request: any) =>
      (async function* () {
        const context = gateway.getStore()
        const started = context?.started ?? performance.now()
        const state = {
          model: request.model,
          sessionKey: context?.sessionKey ?? (request.sessionId ? `internal:${request.sessionId}` : undefined),
          requestId: randomUUID(),
          signal: request.signal as AbortSignal | undefined,
          excluded: new Set<string>(),
          lease: undefined as any,
          started,
          dispatchMs: Math.round(performance.now() - started),
          acquireMs: 0,
          attempts: 0,
          accounts: new Set<string>(),
          emitted: false,
          firstChunkMs: undefined as number | undefined,
          firstTextMs: undefined as number | undefined,
        }
        let success = false
        let failed = false
        try {
          for (let attempt = 0; ; attempt++) {
            let iterator: AsyncIterator<any> | undefined
            let ended = false
            try {
              iterator = dispatch.run(state, open)[Symbol.asyncIterator]()
              for (;;) {
                const step = await dispatch.run(state, () => iterator!.next())
                if (step.done) {
                  ended = true
                  success = true
                  return
                }
                const chunk = step.value
                if (chunk.type === "finish") {
                  if (chunk.reason?.kind === "error" || chunk.reason?.kind === "aborted") {
                    const error = chunk.reason.failure
                    throw new LlmError(error?.message ?? "CodeArts 请求失败", error?.code ?? "SERVER", {
                      status: error?.status,
                    })
                  }
                  success = true
                } else if (chunk.type !== "usage") {
                  state.emitted = true
                  state.firstChunkMs ??= Math.round(performance.now() - state.started)
                  if (
                    (chunk.type === "text-delta" && chunk.text) ||
                    (chunk.type === "block-end" && chunk.block?.type === "text" && chunk.block.text)
                  ) {
                    state.firstTextMs ??= Math.round(performance.now() - state.started)
                  }
                }
                yield chunk
              }
            } catch (error: any) {
              if (state.signal?.aborted || state.emitted || !state.lease || !accountFailure(error) || attempt >= 2) {
                failed = accountFailure(error) && !state.signal?.aborted
                throw error
              }
              state.excluded.add(state.lease.entry.id)
              if (!pool.candidateAccounts("codearts", state.model, state.excluded).length) {
                failed = true
                throw error
              }
              state.lease.release("failure")
              state.lease = undefined
            } finally {
              if (!ended && iterator?.return) await dispatch.run(state, () => iterator!.return!())
            }
          }
        } finally {
          state.lease?.release(failed ? "failure" : success ? "success" : "cancel")
          ctx.logger?.debug?.(
            `[codearts-scheduling] ${JSON.stringify({
              request: state.requestId,
              model: state.model,
              accounts: [...state.accounts],
              dispatchMs: state.dispatchMs,
              acquireMs: Math.round(state.acquireMs),
              firstChunkMs: state.firstChunkMs,
              firstTextMs: state.firstTextMs,
              totalMs: Math.round(performance.now() - state.started),
              attempts: state.attempts,
              result: failed ? "failure" : success ? "success" : "cancel",
            })}`,
          )
        }
      })()
    const wrapped = new Proxy(adapter, {
      get(target, property) {
        if (property === "prepareCall")
          return async (...args: any[]) => {
            const call = await target.prepareCall(...args)
            return { ...call, stream: (request: any) => run(() => call.stream(request), request) }
          }
        if (property === "stream") return (request: any) => run(() => target.stream(request), request)
        const value = Reflect.get(target, property, target)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    return originalRegister.call(this, providers, wrapped)
  }

  ctx.effect(
    () => () => {
      llm.registerAdapter = originalRegister
      detach()
      scheduler?.close()
    },
    "codearts-scheduling",
  )
  return {
    assertReady() {
      if (!scheduler) throw new Error("上游未注册 CodeArts 调度入口，请核对 src/core/upstream.ts")
    },
    stats: () => scheduler?.stats(),
  }
}
