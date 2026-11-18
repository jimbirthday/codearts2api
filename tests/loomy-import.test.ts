import assert from "node:assert/strict"
import { stat } from "node:fs/promises"
import { test } from "vite-plus/test"

import { prepareLoomyImport } from "../web/utils/loomy-import"
import { loomyFile, loomyLine } from "./fixtures/loomy-import"
import { rpc, startTestApp } from "./helpers"

test("Loomy TXT：多文件、BOM、CRLF、空行、逐行判错与判重；预览不显示 token", async () => {
  const line = loomyLine()
  const [phone, token, userid] = line.split("----")
  const batch = await prepareLoomyImport([
    loomyFile(`\uFEFF${line}\r\n\r\n${loomyLine(2)}\r\ninvalid----SECRET----oops`),
    loomyFile(
      `${line}\n${loomyLine(3).replace(/\d+$/, userid)}\n${loomyLine(4).replace(/a+4/, token)}\n${loomyLine(5).replace(/^\d+/, phone)}`,
      "more.txt",
    ),
  ])
  assert.equal(batch.payload.accounts.length, 2)
  assert.deepEqual(
    batch.rows.map((row) => row.status),
    ["ready", "ready", "invalid", "skipped", "skipped", "skipped", "skipped"],
  )
  assert.match(batch.rows[2].source, /第 4 行/)
  assert.doesNotMatch(JSON.stringify(batch.rows), new RegExp(`${phone}|${token}|SECRET`))
  const [account] = batch.payload.accounts
  assert.equal(account.provider, "loomy")
  assert.equal(account.refreshable, false)
  assert.equal(account.expiresAt, undefined)
  assert.deepEqual(JSON.parse(batch.payload.credentials[account.credentialRef]), { phone, access_token: token, userid })
  assert.match(batch.rows[0].message, /有效期未知/)
})

test("Loomy TXT：超量在读取前拒绝；空文件、读取失败与非法字段不阻断其他行", async () => {
  await assert.rejects(prepareLoomyImport(Array(101).fill({ size: 1 })), /最多 100/)
  await assert.rejects(prepareLoomyImport([{ size: 2 * 1024 * 1024 + 1 } as File]), /2 MB/)
  const batch = await prepareLoomyImport([
    loomyFile(""),
    {
      name: "broken.txt",
      size: 1,
      text: async () => {
        throw new Error("SECRET")
      },
    } as File,
    loomyFile(
      ["x----a----1", loomyLine().replace(/a+1/, "z".repeat(32)), loomyLine() + "----extra", loomyLine()].join("\n"),
    ),
  ])
  assert.equal(batch.payload.accounts.length, 1)
  assert.equal(batch.rows.filter((row) => row.status === "invalid").length, 5)
  assert.doesNotMatch(JSON.stringify(batch.rows), /SECRET/)
})

test("Loomy TXT 经真实 RPC 追加与重启：凭据不丢、不覆盖既有账号或开关", async (t) => {
  let app = await startTestApp({ gatewayEnabled: false })
  t.onTestFinished(() => app.close())
  const existing = await prepareLoomyImport([loomyFile()])
  const payload = {
    ...existing.payload,
    disabledModels: { loomy: { disabled: true } },
    permanentLocks: { loomy: true },
  }
  assert.equal((await rpc(app.origin, "backup.import", { payload })).ok, true)
  const batch = await prepareLoomyImport([loomyFile(`${loomyLine()}\n${loomyLine(2)}`)])
  const imported = await rpc(app.origin, "backup.import", { payload: batch.payload, mode: "merge" })
  assert.equal(imported.ok, true)
  assert.equal(imported.value.accountsImported, 1)
  assert.equal(imported.value.accountsSkipped.length, 1)
  assert.equal(imported.value.credentialsImported, 1)
  const before = (await rpc(app.origin, "backup.export")).value.payload
  assert.deepEqual(before.disabledModels, payload.disabledModels)
  assert.deepEqual(before.permanentLocks, payload.permanentLocks)
  assert.equal((await stat(app.host.credentialsFile)).mode & 0o777, 0o600)
  const home = app.home
  await app.close()
  app = await startTestApp({ home, gatewayEnabled: false })
  const after = (await rpc(app.origin, "backup.export")).value.payload
  for (const account of batch.payload.accounts)
    assert.equal(after.credentials[account.credentialRef], batch.payload.credentials[account.credentialRef])
  const repeated = await rpc(app.origin, "backup.import", { payload: batch.payload, mode: "merge" })
  assert.equal(repeated.value.accountsImported, 0)
  assert.equal(repeated.value.accountsSkipped.length, 2)
  const unauthorized = await fetch(`${app.origin}/api/jet-hub`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  })
  assert.equal(unauthorized.status, 401)
})
