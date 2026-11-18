import { LlmError } from "@deepseek-ai/dsh-llm"

export interface SchedulingConfig {
  maxInFlight: number
  sessionLimit: number
  sessionTtlMs: number
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
  label = "CodeArts",
  priority = () => 0,
}: {
  candidates: (model: string, excluded: Set<string>) => any[]
  resolve: (entry: any) => Promise<any>
  config: SchedulingConfig
  label?: string
  priority?: (entry: any) => number
}) {
  const loads = new Map<
    string,
    {
      inFlight: number
      lastUsed: number
      sessions: Set<{ accepted: boolean; expiresAt: number; retainUntil: number }>
      blockedUntil: number
    }
  >()
  const bindings = new Map<string, Binding>()
  const boundCounts = new Map<string, number>()
  const waiting = new Set<{ selection: Selection; ready: (slot: any) => void; fail: (error: unknown) => void }>()
  let sequence = 0
  let closed = false
  let pumping = false
  const busy = () =>
    new LlmError(`${label} 账号繁忙，等待名额超时或队列已满，请稍后重试`, "RATE_LIMIT", { status: 429 })

  function sessionFull(id: string) {
    const load = loads.get(id)
    if (!load) return false
    const now = Date.now()
    for (const session of load.sessions) if (session.expiresAt <= now) load.sessions.delete(session)
    return load.blockedUntil > now || (config.sessionTtlMs > 0 && load.sessions.size >= config.sessionLimit)
  }

  const free = (id: string) => !sessionFull(id) && (loads.get(id)?.inFlight ?? 0) < config.maxInFlight

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
      sessionFull(id)
      if (load.inFlight === 0 && !load.sessions.size && load.blockedUntil <= now && !boundCounts.has(id))
        loads.delete(id)
    }
  }

  function reserve(selection: Selection) {
    if (closed) throw new LlmError(`${label} 调度器正在关闭`, "ABORTED", { status: 503 })
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
      throw new LlmError(`当前模型没有可用的 ${label} 账号，请检查账号启用状态、凭据和模型限额`, "MISSING_CREDENTIAL", {
        status: 503,
      })
    if (available.every((entry) => (loads.get(entry.id)?.blockedUntil ?? 0) > Date.now()))
      throw new LlmError(`${label} 候选账号的会话名额均已满，请稍后重试`, "QUEUE", { status: 429 })

    if (
      binding &&
      !free(binding.accountId) &&
      (sessionFull(binding.accountId) || Date.now() >= (selection.preferUntil ?? Infinity)) &&
      available.some((entry) => entry.id !== binding!.accountId && free(entry.id))
    ) {
      unbind(key!, binding)
      binding = undefined
    }

    const eligible = binding ? available.filter((entry) => entry.id === binding.accountId) : available
    let picked: any
    for (const entry of eligible) {
      const load = loads.get(entry.id)
      if (!free(entry.id)) continue
      if (!picked) {
        picked = entry
        continue
      }
      const left = [
        priority(entry),
        load?.inFlight ?? 0,
        load?.sessions.size ?? 0,
        boundCounts.get(entry.id) ?? 0,
        load?.lastUsed ?? 0,
      ]
      const rightLoad = loads.get(picked.id)
      const right = [
        priority(picked),
        rightLoad?.inFlight ?? 0,
        rightLoad?.sessions.size ?? 0,
        boundCounts.get(picked.id) ?? 0,
        rightLoad?.lastUsed ?? 0,
      ]
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
    const load = loads.get(picked.id) ?? { inFlight: 0, lastUsed: 0, sessions: new Set(), blockedUntil: 0 }
    const session = { accepted: false, expiresAt: Infinity, retainUntil: 0 }
    load.sessions.add(session)
    // 检查与占用之间不 await，避免多个并发请求争抢同一个剩余名额。
    load.inFlight++
    load.lastUsed = ++sequence
    loads.set(picked.id, load)
    let released = false
    return {
      entry: picked,
      acceptSession() {
        if (!session.accepted) session.retainUntil = Date.now() + config.sessionTtlMs
        session.accepted = true
      },
      rejectSession() {
        session.accepted = false
      },
      release(reason: ReleaseReason = "cancel") {
        if (released) return
        released = true
        load.inFlight--
        // 实测名额至少保留到发出后约 60 秒，长流完成后无需再加完整窗口。
        if (session.accepted && config.sessionTtlMs > 0) {
          session.expiresAt =
            reason === "success" ? session.retainUntil : Math.max(session.retainUntil, Date.now() + config.sessionTtlMs)
          if (session.expiresAt <= Date.now()) load.sessions.delete(session)
        } else load.sessions.delete(session)
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
    const available = candidates(selection.model, selection.excluded)
    if (
      available.length &&
      available.every((entry) => (loads.get(entry.id)?.inFlight ?? 0) === 0 && sessionFull(entry.id))
    ) {
      const earliest = Math.min(
        ...available.map((entry) => {
          const load = loads.get(entry.id)!
          const expiry = [...load.sessions].map((session) => session.expiresAt).sort((a, b) => a - b)
          return Math.max(load.blockedUntil, expiry[expiry.length - config.sessionLimit] ?? 0)
        }),
      )
      if (earliest > Date.now() + waitMs)
        throw new LlmError(
          `${label} 会话名额尚未释放，预计 ${Math.ceil((earliest - Date.now()) / 1000)} 秒后可重试`,
          "RATE_LIMIT",
          { status: 429 },
        )
    }
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
      prune()
      return {
        ...config,
        inFlight: [...loads.values()].reduce((sum, load) => sum + load.inFlight, 0),
        queued: waiting.size,
        bindings: bindings.size,
        retainedSessions: [...loads.values()].reduce(
          (sum, load) => sum + [...load.sessions].filter((s) => Number.isFinite(s.expiresAt)).length,
          0,
        ),
        accountBackoffs: [...loads.values()].filter((load) => load.blockedUntil > Date.now()).length,
      }
    },
    blockAccount(id: string) {
      const load = loads.get(id)
      if (load && load.blockedUntil <= Date.now()) load.blockedUntil = Date.now() + (config.sessionTtlMs || 60_000)
      pump()
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
