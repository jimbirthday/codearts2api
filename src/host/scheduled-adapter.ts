import { createHash, randomUUID } from "node:crypto"
import { once } from "node:events"
import { LlmError } from "@deepseek-ai/dsh-llm"

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

/** 流生命周期、输出前换号、背压与取消在各渠道共用。 */
export function wrapScheduledAdapter(
  adapter: any,
  { ctx, gateway, dispatch, config, candidates, provider, label, onError }: any,
) {
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
        queueDeadline: Date.now() + config.queueTimeoutMs,
      }
      let success = false
      let failed = false
      try {
        let otherFailures = 0
        for (;;) {
          let iterator: AsyncIterator<any> | undefined
          let ended = false
          try {
            iterator = dispatch.run(state, open)[Symbol.asyncIterator]()
            for (;;) {
              // 上游 SSE 写入不等待 drain；在继续拉取模型内容前传递客户端背压。
              if (context?.response.writableNeedDrain) await once(context.response, "drain", { signal: state.signal })
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
                  throw new LlmError(error?.message ?? `${label} 请求失败`, error?.code ?? "SERVER", {
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
          } catch (caught: any) {
            const error = onError ? await onError(caught, state) : caught
            const limited =
              error instanceof LlmError && ["QUEUE", "RATE_LIMIT", "QUOTA", "QUOTA_EXCEEDED"].includes(error.code)
            if (!limited) otherFailures++
            if (
              state.signal?.aborted ||
              state.emitted ||
              !state.lease ||
              !accountFailure(error) ||
              otherFailures >= 3
            ) {
              failed = accountFailure(error) && !state.signal?.aborted
              throw error
            }
            state.excluded.add(state.lease.entry.id)
            if (!candidates(state.model, state.excluded).length) {
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
          `[${provider}-scheduling] ${JSON.stringify({
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
  return wrapped
}

export async function acquireScheduledAccount(state: any, scheduler: any) {
  if (!state.lease) {
    const started = performance.now()
    try {
      state.lease = await scheduler.acquire({
        model: state.model,
        sessionKey: state.sessionKey,
        excluded: state.excluded,
        signal: state.signal,
        queueDeadline: state.queueDeadline,
      })
      state.attempts++
      state.accounts.add(createHash("sha256").update(state.lease.entry.id).digest("hex").slice(0, 12))
    } finally {
      state.acquireMs += performance.now() - started
    }
  }
  return state.lease.account
}
