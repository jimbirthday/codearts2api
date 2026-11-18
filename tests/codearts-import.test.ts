import assert from "node:assert/strict"
import { test } from "vite-plus/test"

import { prepareCodeArtsImport } from "../web/utils/codearts-import"
import { codeArtsJson, jsonFile } from "./fixtures/codearts-import"

test("CodeArts：转换三个字段别名，完整保留续期材料，兼容上游标准字段", async () => {
  const raw = codeArtsJson()
  const batch = await prepareCodeArtsImport([jsonFile("account.json", raw)])
  const [account] = batch.payload.accounts
  const credential = JSON.parse(batch.payload.credentials[account.credentialRef])
  assert.equal(account.nickname, raw.user_name)
  assert.equal(account.expiresAt, Date.parse(raw.expiration))
  assert.equal(account.refreshable, true)
  assert.equal(credential.security_token, raw.cloud_dragon_token)
  assert.equal(credential.expires_at, raw.expiration)
  assert.deepEqual(credential.dpop_private_key_jwk, raw.dpop_private_key)
  assert.equal(credential.refresh_token, raw.refresh_token)
  assert.equal(credential.code_verifier, raw.code_verifier)
  assert.equal(credential.user_id, raw.user_id)
  assert.equal(credential.secret_access_key, raw.secret_access_key)
  assert.equal(credential.cloud_dragon_token, undefined)
  assert.equal(credential.dpop_private_key, undefined)
  assert.equal(credential.updated_at, undefined)

  const canonical = await prepareCodeArtsImport([jsonFile("standard.json", credential)])
  assert.equal(canonical.payload.accounts[0].id, account.id)
  assert.equal(canonical.payload.accounts[0].credentialRef, account.credentialRef)
  assert.equal(canonical.payload.credentials[account.credentialRef], batch.payload.credentials[account.credentialRef])
})

test("CodeArts：多文件、数组、BOM、坏 JSON、坏条目与同批判重互不干扰", async () => {
  const first = codeArtsJson("one")
  const batch = await prepareCodeArtsImport([
    jsonFile("first.json", `\uFEFF${JSON.stringify(first)}`, true),
    jsonFile("array.json", [codeArtsJson("two"), { ...first, access_key_id: "ROTATED_AK" }, null]),
    jsonFile("broken.json", '{"secret": "TEST_SECRET_DO_NOT_DISPLAY"', true),
    jsonFile("empty.json", []),
  ])
  assert.equal(batch.payload.accounts.length, 2)
  assert.equal(Object.keys(batch.payload.credentials).length, 2)
  assert.deepEqual(
    batch.rows.map((row) => row.status),
    ["ready", "ready", "skipped", "invalid", "invalid", "invalid"],
  )
  assert.doesNotMatch(JSON.stringify(batch.rows), /TEST_SECRET|TEST_TOKEN|TEST_REFRESH|ROTATED_AK/)
  const firstCredential = JSON.parse(Object.values(batch.payload.credentials)[0])
  assert.equal(firstCredential.access_key_id, first.access_key_id, "后来的重复账号不能覆盖首条凭据")
})

test("CodeArts：拒绝缺字段、坏日期与坏私钥；无续期材料与已过期凭据明确提示", async () => {
  const raw = codeArtsJson()
  const batch = await prepareCodeArtsImport([
    jsonFile("invalid.json", [
      { ...raw, cloud_dragon_token: undefined },
      { ...raw, expiration: "invalid" },
      { ...raw, dpop_private_key: { kty: "RSA", d: "SECRET" } },
    ]),
    jsonFile("legacy.json", { ...codeArtsJson("legacy"), refresh_token: undefined, dpop_private_key: undefined }),
    jsonFile("expired.json", { ...codeArtsJson("expired"), expiration: "2020-01-01T00:00:00Z" }),
  ])
  assert.equal(batch.rows.filter((row) => row.status === "invalid").length, 3)
  assert.equal(batch.payload.accounts[0].refreshable, false)
  assert.match(batch.rows[3].message, /缺少完整续期材料/)
  assert.equal(batch.payload.accounts[1].refreshable, true)
  assert.match(batch.rows[4].message, /临时凭据已过期；含自动续期材料/)
})

test("CodeArts：超量文件在读取前被拒绝，读取失败不阻断其余文件", async () => {
  await assert.rejects(prepareCodeArtsImport(Array(101).fill({ size: 1 })), /最多 100/)
  await assert.rejects(prepareCodeArtsImport([{ size: 2 * 1024 * 1024 + 1 } as File]), /2 MB/)
  const batch = await prepareCodeArtsImport([
    {
      name: "unreadable.json",
      size: 1,
      text: async () => {
        throw new Error("secret")
      },
    } as File,
    jsonFile("valid.json", codeArtsJson()),
  ])
  assert.equal(batch.payload.accounts.length, 1)
  assert.equal(batch.rows[0].message, "文件读取失败，请重新选择")
})
