import { LlmError } from "@deepseek-ai/dsh-llm"

export interface SchedulingConfig {
  maxInFlight: number
  queueLimit: number
  queueTimeoutMs: number
  stickyTtlMs: number
  stickyWaitMs: number
}

interface Selection {
  model: string
  sessionKey?: string
  excluded: Set<string>
  signal?: AbortSignal
  preferUntil?: number
  queueDeadline?: number
}

interface Binding {
  accountId: string
  expiresAt: number
  active: number
  confirmed: boolean
}

type ReleaseReason = "success" | "failure" | "cancel"

export function createAccountScheduler({
  candidates,
  resolve,
  config,
}: {
  candidates: (model: string, excluded: Set<string>) => any[]
  resolve: (entry: any) => Promise<any>
  config: SchedulingConfig
}) {
  const loads = new Map<string, { inFlight: number; lastUsed: number }>()
  const bindings = new Map<string, Binding>()
  const boundCounts = new Map<string, number>()
  const waiting = new Set<{ selection: Selection; ready: (slot: any) => void; fail: (error: unknown) => void }>()
  let sequence = 0
  let closed = false
  let pumping = false
  const busy = () =>
    new LlmError("CodeArts 账号繁忙，等待名额超时或队列已满，请稍后重试", "RATE_LIMIT", { status: 429 })

  function unbind(key: string, expected: Binding) {
    if (bindings.get(key) !== expected) return
    bindings.delete(key)
    const count = (boundCounts.get(expected.accountId) ?? 1) - 1
    if (count > 0) boundCounts.set(expected.accountId, count)
    else boundCounts.delete(expected.accountId)
  }

  function touch(key: string, binding: Binding) {
    if (bindings.get(key) !== binding) return
    binding.expiresAt = Date.now() + config.stickyTtlMs
    bindings.delete(key)
    bindings.set(key, binding)
  }

  function prune() {
    const now = Date.now()
    for (const [key, binding] of bindings) {
      if (binding.active === 0 && binding.expiresAt <= now) unbind(key, binding)
    }
    for (const [id, load] of loads) {
      if (load.inFlight === 0 && !boundCounts.has(id)) loads.delete(id)
    }
  }

  function reserve(selection: Selection) {
    if (closed) throw new LlmError("CodeArts 调度器正在关闭", "ABORTED", { status: 503 })
    selection.signal?.throwIfAborted()
    const available = candidates(selection.model, selection.excluded)
    const key = selection.sessionKey
    let binding = key ? bindings.get(key) : undefined
    if (
      binding &&
      ((binding.active === 0 && binding.expiresAt <= Date.now()) || !available.some((a) => a.id === binding.accountId))
    ) {
      unbind(key!, binding)
      binding = undefined
    }
    if (!available.length)
      throw new LlmError("当前模型没有可用的 CodeArts 账号，请检查账号启用状态、凭据和模型限额", "MISSING_CREDENTIAL", {
        status: 503,
      })

    if (
      binding &&
      (loads.get(binding.accountId)?.inFlight ?? 0) >= config.maxInFlight &&
      Date.now() >= (selection.preferUntil ?? Infinity) &&
      available.some(
        (entry) => entry.id !== binding!.accountId && (loads.get(entry.id)?.inFlight ?? 0) < config.maxInFlight,
      )
    ) {
      unbind(key!, binding)
      binding = undefined
    }

    const eligible = binding ? available.filter((entry) => entry.id === binding.accountId) : available
    let picked: any
    for (const entry of eligible) {
      const load = loads.get(entry.id)
      if ((load?.inFlight ?? 0) >= config.maxInFlight) continue
      if (!picked) {
        picked = entry
        continue
      }
      const left = [load?.inFlight ?? 0, boundCounts.get(entry.id) ?? 0, load?.lastUsed ?? 0]
      const rightLoad = loads.get(picked.id)
      const right = [rightLoad?.inFlight ?? 0, boundCounts.get(picked.id) ?? 0, rightLoad?.lastUsed ?? 0]
      const difference = left.findIndex((value, index) => value !== right[index])
      if (difference !== -1 && left[difference] < right[difference]) picked = entry
    }
    if (!picked) return null
    if (key && !binding) {
      if (bindings.size >= 10_000) {
        for (const [oldKey, item] of bindings) {
          if (item.active === 0) {
            unbind(oldKey, item)
            break
          }
        }
        if (bindings.size >= 10_000) throw busy()
      }
      binding = { accountId: picked.id, expiresAt: 0, active: 0, confirmed: false }
      bindings.set(key, binding)
      boundCounts.set(picked.id, (boundCounts.get(picked.id) ?? 0) + 1)
    }
    if (binding) {
      binding.active++
      touch(key!, binding)
    }
    const load = loads.get(picked.id) ?? { inFlight: 0, lastUsed: 0 }
    // 检查与占用之间不 await，避免多个并发请求争抢同一个剩余名额。
    load.inFlight++
    load.lastUsed = ++sequence
    loads.set(picked.id, load)
    let released = false
    return {
      entry: picked,
      release(reason: ReleaseReason = "cancel") {
        if (released) return
        released = true
        load.inFlight--
        if (binding) {
          binding.active--
          if (reason === "failure") unbind(key!, binding)
          else if (reason === "success") {
            binding.confirmed = true
            touch(key!, binding)
          } else if (binding.active === 0 && !binding.confirmed) unbind(key!, binding)
        }
        pump()
      },
    }
  }

  function pump() {
    if (pumping) return
    pumping = true
    try {
      for (const ticket of waiting) {
        try {
          const slot = reserve(ticket.selection)
          if (slot) ticket.ready(slot)
        } catch (error) {
          ticket.fail(error)
        }
      }
    } finally {
      pumping = false
    }
  }

  function take(selection: Selection): Promise<ReturnType<typeof reserve>> {
    pump()
    const slot = reserve(selection)
    if (slot) return Promise.resolve(slot)
    if (waiting.size >= config.queueLimit) throw busy()
    const waitMs = Math.min(config.queueTimeoutMs, (selection.queueDeadline ?? Infinity) - Date.now())
    if (waitMs <= 0) throw busy()
    return new Promise((ready, fail) => {
      const finish = (error: unknown, reserved?: any) => {
        if (!waiting.delete(ticket)) return
        clearTimeout(timer)
        clearTimeout(preferTimer)
        selection.signal?.removeEventListener("abort", abort)
        if (error) fail(error)
        else ready(reserved)
      }
      const abort = () => finish(selection.signal?.reason ?? new Error("aborted"))
      const ticket = {
        selection,
        ready: (reserved: any) => finish(null, reserved),
        fail: (error: unknown) => finish(error),
      }
      const timer = setTimeout(() => finish(busy()), waitMs)
      const preferTimer = setTimeout(pump, Math.max(0, (selection.preferUntil ?? Date.now()) - Date.now()))
      waiting.add(ticket)
      selection.signal?.addEventListener("abort", abort, { once: true })
      if (selection.signal?.aborted) abort()
    })
  }

  const timer = setInterval(() => {
    prune()
    pump()
  }, 1000)
  timer.unref()
  return {
    async acquire(selection: Selection) {
      selection = { preferUntil: Date.now() + config.stickyWaitMs, ...selection }
      const excluded = new Set(selection.excluded)
      for (;;) {
        const slot = await take({ ...selection, excluded })
        try {
          const account = await resolve(slot.entry)
          selection.signal?.throwIfAborted()
          if (account && candidates(selection.model, excluded).some((entry) => entry.id === slot.entry.id)) {
            return { ...slot, account }
          }
        } catch (error) {
          slot.release(selection.signal?.aborted ? "cancel" : "failure")
          throw error
        }
        excluded.add(slot.entry.id)
        slot.release("failure")
      }
    },
    stats() {
      return {
        ...config,
        inFlight: [...loads.values()].reduce((sum, load) => sum + load.inFlight, 0),
        queued: waiting.size,
        bindings: bindings.size,
      }
    },
    wake: pump,
    close() {
      closed = true
      clearInterval(timer)
      pump()
      bindings.clear()
      boundCounts.clear()
    },
  }
}
