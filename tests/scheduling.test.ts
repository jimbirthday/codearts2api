import assert from "node:assert/strict"
import { setImmediate as nextTick } from "node:timers/promises"
import { test } from "vite-plus/test"

import { resolveCodeArtsScheduling } from "../src/config/env.ts"
import { createAccountScheduler } from "../src/modules/scheduling/account-scheduler.ts"
import { schedulingSessionKey } from "../src/modules/scheduling/session-key.ts"

function setup(t: any, config: any = {}, resolve?: (entry: any) => Promise<any>) {
  const entries = ["a", "b", "c"].map((id) => ({ id, enabled: true, blocked: new Set<string>() }))
  const scheduler = createAccountScheduler({
    config: { maxInFlight: 1, queueLimit: 100, queueTimeoutMs: 1000, stickyTtlMs: 30_000, ...config },
    candidates: (model, excluded) =>
      entries.filter((entry) => entry.enabled && !entry.blocked.has(model) && !excluded.has(entry.id)),
    resolve: resolve ?? (async (entry) => ({ entry, credential: { fake: true } })),
  })
  t.onTestFinished(() => scheduler.close())
  const acquire = (key?: string, signal?: AbortSignal, model = "model") =>
    scheduler.acquire({ model, sessionKey: key, signal, excluded: new Set() })
  return { entries, scheduler, acquire }
}

test("100 个并发请求：每号峰值不超过 2，负载分散且结束后名额归零", async (t) => {
  const { scheduler, acquire } = setup(t, { maxInFlight: 2 })
  const active = new Map<string, number>()
  const peaks = new Map<string, number>()
  await Promise.all(
    Array.from({ length: 100 }, async (_, i) => {
      const lease = await acquire(`session-${i}`)
      const id = lease.entry.id
      active.set(id, (active.get(id) ?? 0) + 1)
      peaks.set(id, Math.max(peaks.get(id) ?? 0, active.get(id)!))
      await nextTick()
      active.set(id, active.get(id)! - 1)
      lease.release("success")
      lease.release("success")
    }),
  )
  assert.equal(peaks.size, 3)
  assert.ok([...peaks.values()].every((peak) => peak === 2))
  assert.equal(scheduler.stats().inFlight, 0)
  assert.equal(scheduler.stats().queued, 0)
})

test("粘性账号满载时等待它；其他会话可用其余账号，不被队首阻塞", async (t) => {
  const { acquire, scheduler } = setup(t)
  const first = await acquire("sticky")
  const pending = acquire("sticky")
  assert.equal(scheduler.stats().queued, 1)
  const other = await acquire("other")
  assert.notEqual(other.entry.id, first.entry.id)
  assert.equal(scheduler.stats().queued, 1)
  first.release("success")
  const resumed = await pending
  assert.equal(resumed.entry.id, first.entry.id)
  resumed.release("success")
  other.release("success")
  const again = await acquire("sticky")
  assert.equal(again.entry.id, first.entry.id)
  again.release("success")
})

test("队列有上限、有超时，排队请求取消后立即退出", async (t) => {
  const { entries, acquire, scheduler } = setup(t, { queueLimit: 1, queueTimeoutMs: 30 })
  entries[1].enabled = entries[2].enabled = false
  const held = await acquire("held")
  const timedOut = assert.rejects(
    acquire("queued"),
    (error: any) => error.code === "RATE_LIMIT" && error.failure.status === 429,
  )
  await assert.rejects(acquire("overflow"), (error: any) => error.code === "RATE_LIMIT")
  await timedOut
  assert.equal(scheduler.stats().queued, 0)
  const abort = new AbortController()
  const canceled = assert.rejects(acquire("cancel", abort.signal), /stop/)
  abort.abort(new Error("stop"))
  await canceled
  assert.equal(scheduler.stats().queued, 0)
  held.release()
  assert.equal(scheduler.stats().inFlight, 0)
})

test("模型限额/停用会迁移绑定，旧请求完成不能覆盖新绑定", async (t) => {
  const { entries, acquire } = setup(t, { maxInFlight: 2 })
  const first = await acquire("same")
  const old = await acquire("same")
  entries[0].blocked.add("model")
  first.release("failure")
  const moved = await acquire("same")
  assert.equal(moved.entry.id, "b")
  old.release("success")
  moved.release("success")
  const stillBound = await acquire("same")
  assert.equal(stillBound.entry.id, "b")
  stillBound.release()
  const different = await acquire("different-model", undefined, "other-model")
  assert.ok(["a", "c"].includes(different.entry.id), "单模型限额不应封掉整个账号")
  different.release()
})

test("坏凭据跳过；读取期间取消和调度器关闭都不会遗留名额", async (t) => {
  const { acquire, scheduler } = setup(t, {}, async (entry) => (entry.id === "a" ? null : { entry, credential: {} }))
  const healthy = await acquire("first")
  assert.equal(healthy.entry.id, "b")
  healthy.release()
  assert.equal(scheduler.stats().inFlight, 0)

  let finish: () => void = () => {}
  const other = setup(t, {}, async (entry) => {
    await new Promise<void>((done) => {
      finish = done
    })
    return { entry }
  })
  const abort = new AbortController()
  const canceled = assert.rejects(other.acquire("cancel", abort.signal), /stop/)
  await nextTick()
  abort.abort(new Error("stop"))
  finish()
  await canceled
  assert.equal(other.scheduler.stats().inFlight, 0)
  const full = setup(t, { maxInFlight: 1 })
  full.entries[1].enabled = full.entries[2].enabled = false
  const held = await full.acquire("held")
  const closed = assert.rejects(full.acquire("held"), /关闭/)
  full.scheduler.close()
  await closed
  held.release()
  assert.equal(full.scheduler.stats().inFlight, 0)
})

test("绑定 TTL 滚动续期，过期后重新分配", async (t) => {
  const { acquire } = setup(t, { stickyTtlMs: 15 })
  const first = await acquire("same")
  first.release("success")
  await new Promise((done) => setTimeout(done, 25))
  const expired = await acquire("same")
  assert.notEqual(expired.entry.id, first.entry.id)
  expired.release()
})

test("会话键：显式 ID 优先、按调用方隔离、兼容 Responses，历史追加保持派生键", () => {
  const headers = { authorization: "Bearer test", "x-caller-id": "one" }
  const chat = { metadata: { conversation_id: "same" }, messages: [{ role: "user", content: "hello" }] }
  const responses = { prompt_cache_key: "same", input: "different" }
  assert.equal(schedulingSessionKey(chat, headers), schedulingSessionKey(responses, headers))
  assert.notEqual(schedulingSessionKey(chat, headers), schedulingSessionKey(chat, { ...headers, "x-caller-id": "two" }))
  assert.notEqual(
    schedulingSessionKey(chat, headers),
    schedulingSessionKey(chat, { ...headers, authorization: "Bearer other" }),
  )
  const initial = {
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: "first" },
    ],
  }
  const later = {
    messages: [...initial.messages, { role: "assistant", content: "reply" }, { role: "user", content: "next" }],
  }
  assert.equal(schedulingSessionKey(initial, headers), schedulingSessionKey(later, headers))
  assert.equal(schedulingSessionKey({}, headers), undefined)
  assert.doesNotMatch(schedulingSessionKey(initial, headers)!, /system|first|Bearer/)
})

test("调度配置非法值直接失败，默认保守限制每号 1 个在途", () => {
  assert.equal(resolveCodeArtsScheduling({}).maxInFlight, 1)
  assert.equal(resolveCodeArtsScheduling({ CODEARTS_QUEUE_LIMIT: "0" }).queueLimit, 0)
  for (const raw of ["0", "-1", "1.5", "Infinity", "001", "101"]) {
    assert.throws(() => resolveCodeArtsScheduling({ CODEARTS_MAX_IN_FLIGHT: raw }), /CODEARTS_MAX_IN_FLIGHT/)
  }
})
