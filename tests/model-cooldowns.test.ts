import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "vite-plus/test"

import { prepareCodeArtsImport } from "../web/utils/codearts-import"
import { codeArtsJson, jsonFile } from "./fixtures/codearts-import"
import { rpc, startTestApp } from "./helpers"

async function setup(t: any) {
  const app = await startTestApp({ gatewayEnabled: false })
  t.onTestFinished(() => app.close())
  const batch = await prepareCodeArtsImport([jsonFile("accounts.json", [codeArtsJson("one"), codeArtsJson("two")])])
  assert.equal((await rpc(app.origin, "backup.import", { payload: batch.payload, mode: "merge" })).ok, true)
  const pool = app.host.ctx.get("accountPool")
  const ids = batch.payload.accounts.map((account) => account.id)
  const clear = (body: any, provider = "codearts", authorized = true) =>
    fetch(`${app.origin}/admin/models/api/${provider}/cooldowns/clear`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorized ? { authorization: `Bearer ${app.adminKey}` } : {}),
      },
      body: JSON.stringify(body),
    })
  return { app, pool, ids, clear }
}

test("CodeArts 冷却随机 1–3 分钟，并发失败不延长，其他渠道时长不变", async (t) => {
  const { app, pool, ids } = await setup(t)
  const before = Date.now()
  await pool.updateModelRateLimit(ids[0], "deepseek", before + 86_400_000)
  const first = pool.findAccount(ids[0]).modelRateLimits.deepseek
  assert.ok(first >= before + 60_000 && first <= Date.now() + 180_000)
  await Promise.all(
    Array.from({ length: 20 }, () => pool.updateModelRateLimit(ids[0], "deepseek", Date.now() + 86_400_000)),
  )
  assert.equal(pool.findAccount(ids[0]).modelRateLimits.deepseek, first)
  await pool.updateModelRateLimit(ids[0], "glm", Date.now() + 3_600_000)
  const glm = pool.findAccount(ids[0]).modelRateLimits.glm
  assert.ok(glm >= before + 60_000 && glm <= Date.now() + 180_000)
  await pool.updateModelRateLimit(ids[0], "invalid", Number.NaN)
  assert.equal(pool.findAccount(ids[0]).modelRateLimits.invalid, undefined)
  const other = pool.getStateSnapshot().accounts.find((entry: any) => entry.provider === "opencode")
  const exact = Date.now() + 3_600_000
  await pool.updateModelRateLimit(other.id, "other", exact)
  assert.equal(pool.findAccount(other.id).modelRateLimits.other, exact)
  const stored = JSON.parse(await readFile(join(app.home, "jet-hub/state.json"), "utf8"))
  assert.equal(stored.accounts.find((entry: any) => entry.id === ids[0]).modelRateLimits.deepseek, first)
})

test("旧长冷却收敛到 1–3 分钟；批量按模型解除并保留其他字段", async (t) => {
  const { app, pool, ids, clear } = await setup(t)
  await pool.updateAccount(ids[0], {
    modelRateLimits: { a: Date.now() + 86_400_000, b: Date.now() + 3_600_000 },
    enabled: false,
  })
  await pool.updateAccount(ids[1], { modelRateLimits: { a: Date.now() + 86_400_000 } })
  assert.equal(await app.host.codeartsScheduling.normalizeCooldowns(), 3)
  const after = pool.findAccount(ids[0]).modelRateLimits
  assert.ok(Object.values(after).every((at: any) => at > Date.now() + 59_000 && at <= Date.now() + 180_000))
  const response = await clear({ modelIds: ["a"] })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { cleared: 2, affectedAccounts: 2, failed: [] })
  assert.equal(pool.findAccount(ids[0]).modelRateLimits.a, undefined)
  assert.ok(pool.findAccount(ids[0]).modelRateLimits.b)
  assert.equal(pool.findAccount(ids[0]).enabled, false)
  const all = await clear({ all: true })
  assert.equal((await all.json()).cleared, 1)
  assert.equal(pool.findAccount(ids[0]).modelRateLimits, undefined)
  assert.equal(pool.findAccount(ids[0]).enabled, false)
})

test("解除冷却受鉴权与选择校验保护，空选择不会解除全部", async (t) => {
  const { pool, ids, clear } = await setup(t)
  await pool.updateModelRateLimit(ids[0], "a", Date.now() + 3_600_000)
  assert.equal((await clear({ all: true }, "codearts", false)).status, 401)
  for (const body of [
    {},
    { modelIds: [] },
    { all: "true" },
    { modelIds: [1] },
    { all: true, accountIds: [] },
    { all: true, accountIds: ["unknown"] },
  ]) {
    assert.equal((await clear(body)).status, 400)
  }
  assert.equal((await clear({ all: true }, "opencode")).status, 400)
  assert.ok(pool.findAccount(ids[0]).modelRateLimits.a)
  const selected = await clear({ modelIds: ["a"], accountIds: [ids[0]] })
  assert.equal((await selected.json()).cleared, 1)
})
