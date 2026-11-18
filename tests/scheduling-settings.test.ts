import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, vi } from "vite-plus/test"

import { createAccountScheduler } from "../src/modules/scheduling/account-scheduler.ts"
import { createSchedulingSettings } from "../src/modules/scheduling/scheduling-settings.service.ts"
import { prepareCodeArtsImport } from "../web/utils/codearts-import"
import { codeArtsJson, jsonFile } from "./fixtures/codearts-import"
import { rpc, startTestApp } from "./helpers"

async function setup(t: any, env = {}) {
  const home = await mkdtemp(join(tmpdir(), "c2a-settings-"))
  t.onTestFinished(() => rm(home, { recursive: true, force: true }))
  const changed = vi.fn()
  const settings = await createSchedulingSettings({ home, changed, env })
  return { settings, changed, home }
}

test("调度设置：各渠道默认独立、串行保存不丢更新、覆盖值重启保留，未修改项继续读环境变量", async (t) => {
  const { settings, changed, home } = await setup(t, { CODEARTS_MAX_IN_FLIGHT: "4" })
  assert.equal(settings.configs.codearts.maxInFlight, 4)
  assert.equal(settings.configs.loomy.maxInFlight, 2)
  const reference = settings.configs.codearts
  await Promise.all([
    settings.update("codearts", { maxInFlight: 5 }),
    settings.update("loomy", { maxInFlight: 3 }),
    settings.update("codearts", { queueLimit: 30 }),
  ])
  assert.equal(settings.configs.codearts, reference)
  assert.equal(reference.maxInFlight, 5)
  assert.equal(reference.queueLimit, 30)
  assert.equal(settings.configs.loomy.sessionLimit, 3)
  assert.equal(changed.mock.calls.length, 3)
  assert.equal((await stat(join(home, "scheduling.json"))).mode & 0o777, 0o600)
  const restarted = await createSchedulingSettings({
    home,
    changed: () => {},
    env: { CODEARTS_MAX_IN_FLIGHT: "9", CODEARTS_QUEUE_TIMEOUT_MS: "8000" },
  })
  assert.equal(restarted.configs.codearts.maxInFlight, 5)
  assert.equal(restarted.configs.codearts.queueTimeoutMs, 8000)
  assert.equal(restarted.configs.codearts.queueLimit, 30)
  assert.equal(restarted.configs.loomy.maxInFlight, 3)
})

test("调度设置：非法数字、未知字段、交叉范围、其他渠道及空值不写盘；错误后仍可保存", async (t) => {
  const { settings, changed, home } = await setup(t)
  for (const patch of [
    null,
    [],
    {},
    { maxInFlight: "3" },
    { maxInFlight: 0 },
    { maxInFlight: 1.5 },
    { queueLimit: -1 },
    { queueTimeoutMs: 120001 },
    { cooldownMinSeconds: 181 },
    { cooldownMaxSeconds: 0 },
    { unknown: 3 },
    JSON.parse('{"__proto__":{"polluted":true}}'),
  ]) {
    await assert.rejects(settings.update("codearts", patch), (error: any) => error.status === 400)
  }
  await assert.rejects(settings.update("opencode", { maxInFlight: 3 }))
  await assert.rejects(settings.update("loomy", { sessionTtlMs: 60000 }))
  await assert.rejects(readFile(join(home, "scheduling.json")), (error: any) => error.code === "ENOENT")
  assert.equal(changed.mock.calls.length, 0)
  assert.equal(settings.configs.codearts.maxInFlight, 3)
  await settings.update("codearts", { cooldownMinSeconds: 5, cooldownMaxSeconds: 5 })
  assert.equal(settings.configs.codearts.cooldownMaxSeconds, 5)
})

test("调度设置：写盘失败不修改运行配置，损坏文件启动明确失败", async (t) => {
  const { settings, changed, home } = await setup(t)
  const file = join(home, "scheduling.json")
  await mkdir(file)
  await assert.rejects(settings.update("loomy", { maxInFlight: 4 }))
  assert.equal(settings.configs.loomy.maxInFlight, 2)
  assert.equal(changed.mock.calls.length, 0)
  await rm(file, { recursive: true })
  await writeFile(file, "broken json")
  await assert.rejects(createSchedulingSettings({ home, changed, env: {} }), /读取调度配置失败/)
})

test("运行调度：提高上限立刻唤醒旧队列，降低上限保留在途计数且不取消请求", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "c2a-settings-runtime-"))
  const settings = await createSchedulingSettings({ home, env: {}, changed: () => scheduler.wake() })
  const scheduler = createAccountScheduler({
    config: settings.configs.loomy,
    label: "Loomy",
    candidates: () => [{ id: "one" }],
    resolve: async (entry) => ({ entry, credential: {} }),
  })
  t.onTestFinished(() => {
    scheduler.close()
    return rm(home, { recursive: true, force: true })
  })
  const acquire = () => scheduler.acquire({ model: "model", excluded: new Set() })
  const first = await acquire(),
    second = await acquire()
  const waiting = acquire()
  assert.equal(scheduler.stats().queued, 1)
  await settings.update("loomy", { maxInFlight: 3 })
  const third = await waiting
  assert.equal(scheduler.stats().inFlight, 3)
  assert.equal(scheduler.stats().queued, 0)
  await settings.update("loomy", { maxInFlight: 1 })
  assert.equal(scheduler.stats().inFlight, 3)
  const abort = new AbortController()
  const next = scheduler.acquire({ model: "another-model", excluded: new Set(), signal: abort.signal })
  const rejected = assert.rejects(next)
  first.release("success")
  second.release("success")
  assert.equal(scheduler.stats().queued, 1)
  abort.abort()
  await rejected
  third.release("success")
  const last = await acquire()
  assert.equal(scheduler.stats().inFlight, 1)
  last.release("success")
})

test("保留窗口热更新只作用于新会话，已经发出的会话仍按原窗口释放", async (t) => {
  const { settings } = await setup(t)
  await settings.update("codearts", { sessionTtlMs: 600000 })
  const scheduler = createAccountScheduler({
    config: settings.configs.codearts,
    candidates: () => [{ id: "one" }],
    resolve: async (entry) => ({ entry, credential: {} }),
  })
  t.onTestFinished(() => scheduler.close())
  const lease = await scheduler.acquire({ model: "model", excluded: new Set() })
  await settings.update("codearts", { sessionTtlMs: 1 })
  lease.acceptSession()
  await new Promise((resolve) => setTimeout(resolve, 5))
  lease.release("success")
  assert.equal(scheduler.stats().retainedSessions, 1)
})

test("真实管理接口：读写受鉴权与大小写兜底保护，保存后 healthz 与冷却立即使用新值", async (t) => {
  let app = await startTestApp({ gatewayEnabled: false })
  t.onTestFinished(() => app.close())
  const call = (path = "", body?: any, authorized = true) =>
    fetch(`${app.origin}/admin/scheduling/api${path}`, {
      method: body === undefined ? "GET" : "PATCH",
      headers: {
        "content-type": "application/json",
        ...(authorized ? { authorization: `Bearer ${app.adminKey}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  assert.equal((await call("", undefined, false)).status, 401)
  assert.equal((await call("/codearts", { maxInFlight: 9 }, false)).status, 401)
  assert.equal((await fetch(`${app.origin}/ADMIN/SCHEDULING/API`)).status, 401)
  const listed = await (await call()).json()
  assert.equal(listed.providers[0].config.maxInFlight, 3)
  assert.equal(listed.providers[1].config.maxInFlight, 2)
  assert.equal((await call("/codearts", { maxInFlight: 5, cooldownMinSeconds: 4, cooldownMaxSeconds: 4 })).status, 200)
  const health = await (await fetch(`${app.origin}/healthz`)).json()
  assert.equal(health.scheduling.codearts.maxInFlight, 5)
  assert.equal(health.scheduling.loomy.maxInFlight, 2)
  assert.equal((await call("/loomy", { sessionLimit: 3 })).status, 400)
  const batch = await prepareCodeArtsImport([jsonFile("one.json", codeArtsJson())])
  await rpc(app.origin, "backup.import", { payload: batch.payload, mode: "merge" })
  const pool = app.host.ctx.get("accountPool")
  await pool.updateModelRateLimit(batch.payload.accounts[0].id, "test", Date.now() + 600000)
  const resetAt = pool.findAccount(batch.payload.accounts[0].id).modelRateLimits.test
  assert.ok(resetAt > Date.now() + 3000 && resetAt <= Date.now() + 4000)
  const home = app.home
  await app.close()
  app = await startTestApp({ home, gatewayEnabled: false })
  assert.equal(app.host.codeartsScheduling.stats().maxInFlight, 5)
  assert.equal(app.host.codeartsScheduling.stats().cooldownMaxSeconds, 4)
})
