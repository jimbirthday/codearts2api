import assert from "node:assert/strict"
import { stat } from "node:fs/promises"
import { test } from "vite-plus/test"

import { prepareCodeArtsImport } from "../web/utils/codearts-import"
import { codeArtsJson, jsonFile } from "./fixtures/codearts-import"
import { rpc, startTestApp } from "./helpers"

test("CodeArts JSON 经真实 RPC 导入：凭据可读、判重、不覆盖既有账号和模型设置", async (t) => {
  const app = await startTestApp({ gatewayEnabled: false })
  t.onTestFinished(() => app.close())
  const existing = await prepareCodeArtsImport([jsonFile("existing.json", codeArtsJson("existing"))])
  const payload = {
    ...existing.payload,
    disabledModels: { codearts: { "test-disabled": true } },
    permanentLocks: { loomy: true },
  }
  assert.equal((await rpc(app.origin, "backup.import", { payload })).ok, true)
  const before = (await rpc(app.origin, "backup.export")).value.payload

  const batch = await prepareCodeArtsImport([
    jsonFile("one.json", codeArtsJson("one")),
    jsonFile("more.json", [codeArtsJson("two"), codeArtsJson("existing")]),
  ])
  const imported = await rpc(app.origin, "backup.import", { payload: batch.payload, mode: "merge" })
  assert.equal(imported.ok, true)
  assert.equal(imported.value.accountsImported, 2)
  assert.equal(imported.value.accountsSkipped.length, 1)
  assert.equal(imported.value.credentialsImported, 2)
  assert.equal(imported.value.missingCredentials, 0)

  const listed = await rpc(app.origin, "account.list", { provider: "codearts" })
  assert.equal(listed.value.accounts.length, 3)
  assert.ok(listed.value.accounts.every((account) => account.source === "file"))
  const after = (await rpc(app.origin, "backup.export")).value.payload
  assert.deepEqual(after.disabledModels, before.disabledModels)
  assert.deepEqual(after.permanentLocks, before.permanentLocks)
  const existingRef = existing.payload.accounts[0].credentialRef
  assert.equal(after.credentials[existingRef], before.credentials[existingRef])
  for (const account of batch.payload.accounts.slice(0, 2)) {
    assert.equal(after.credentials[account.credentialRef], batch.payload.credentials[account.credentialRef])
    const stored = JSON.parse(after.credentials[account.credentialRef])
    assert.ok(stored.security_token && stored.expires_at && stored.dpop_private_key_jwk?.d)
    assert.ok(stored.refresh_token && stored.code_verifier)
  }
  assert.equal((await stat(app.host.credentialsFile)).mode & 0o777, 0o600)
  const repeated = await rpc(app.origin, "backup.import", { payload: batch.payload, mode: "merge" })
  assert.equal(repeated.value.accountsImported, 0)
  assert.equal(repeated.value.accountsSkipped.length, 3)

  const unauthorized = await fetch(`${app.origin}/api/jet-hub`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "client-request",
      rpcId: "unauthorized",
      method: "jet-hub",
      payload: {
        method: "backup.import",
        payload: { payload: batch.payload, mode: "merge" },
      },
    }),
  })
  assert.equal(unauthorized.status, 401)
})
