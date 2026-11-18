import assert from "node:assert/strict"
import { test } from "vite-plus/test"

import { exportCodeArtsAccounts } from "../web/utils/codearts-export"
import { prepareCodeArtsImport } from "../web/utils/codearts-import"
import { codeArtsJson, jsonFile } from "./fixtures/codearts-import"

test("CodeArts 导出可重新导入，续期材料不丢失且不夹带其他渠道", async () => {
  const input = await prepareCodeArtsImport([jsonFile("accounts.json", [codeArtsJson("one"), codeArtsJson("two")])])
  const payload = {
    ...input.payload,
    accounts: [...input.payload.accounts, { provider: "other", credentialRef: "OTHER" }],
    credentials: { ...input.payload.credentials, OTHER: '{"api_key":"OTHER_SECRET"}' },
  }
  const { accounts, skipped } = exportCodeArtsAccounts(payload)
  assert.equal(accounts.length, 2)
  assert.equal(skipped, 0)
  assert.equal(accounts[0].cloud_dragon_token, codeArtsJson().cloud_dragon_token)
  assert.ok(accounts[0].expiration)
  assert.deepEqual(accounts[0].dpop_private_key, codeArtsJson().dpop_private_key)
  assert.equal(accounts[0].security_token, undefined)
  assert.equal(accounts[0].dpop_private_key_jwk, undefined)
  assert.doesNotMatch(JSON.stringify(accounts), /OTHER_SECRET|OTHER/)
  const imported = await prepareCodeArtsImport([jsonFile("export.json", accounts)])
  assert.deepEqual(imported.payload.credentials, input.payload.credentials)
})

test("CodeArts 导出跳过缺失与损坏凭据，全部不可用时不给出空备份", async () => {
  const raw = codeArtsJson("valid")
  const payload = {
    accounts: ["valid", "missing", "broken", "incomplete"].map((id) => ({ provider: "codearts", credentialRef: id })),
    credentials: { valid: JSON.stringify(raw), broken: "bad SECRET", incomplete: '{"refresh_token":"SECRET"}' },
  }
  const exported = exportCodeArtsAccounts(payload)
  assert.equal(exported.accounts.length, 1)
  assert.equal(exported.skipped, 3)
  assert.throws(() => exportCodeArtsAccounts({ ...payload, credentials: {} }), /没有可导出/)
  assert.throws(() => exportCodeArtsAccounts({ accounts: [] }), /没有可导出/)
})
