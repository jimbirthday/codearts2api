import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import { exportLoomyAccounts } from "../web/utils/loomy-export"
import { prepareLoomyImport } from "../web/utils/loomy-import"
import { loomyFile, loomyLine } from "./fixtures/loomy-import"

test("Loomy 导出为三列 TXT，原始凭据可重新导入且不夹带其他渠道与额外字段", async () => {
  const input = await prepareLoomyImport([loomyFile(`${loomyLine()}\n${loomyLine(2)}`)])
  const first = input.payload.accounts[0]
  const payload = {
    ...input.payload,
    accounts: [...input.payload.accounts, { provider: "codearts", credentialRef: "OTHER" }],
    credentials: {
      ...input.payload.credentials,
      [first.credentialRef]: JSON.stringify({
        ...JSON.parse(input.payload.credentials[first.credentialRef]),
        extra: "PRIVATE_EXTRA",
      }),
      OTHER: '{"secret":"OTHER_SECRET"}',
    },
  }
  const { accounts, skipped } = exportLoomyAccounts(payload)
  assert.deepEqual(accounts, [loomyLine(), loomyLine(2)])
  assert.equal(skipped, 0)
  assert.doesNotMatch(accounts.join("\n"), /OTHER_SECRET|PRIVATE_EXTRA/)
  const imported = await prepareLoomyImport([loomyFile(accounts.join("\n") + "\n")])
  assert.deepEqual(imported.payload.credentials, input.payload.credentials)
})

test("Loomy 导出跳过缺失、损坏与不可导入凭据，全部不可用时不给空文件", async () => {
  const [phone, access_token, userid] = loomyLine().split("----")
  const payload = {
    accounts: ["valid", "missing", "broken", "incomplete", "newline"].map((id) => ({
      provider: "loomy",
      credentialRef: id,
    })),
    credentials: {
      valid: JSON.stringify({ phone: ` ${phone} `, access_token, userid }),
      broken: "SECRET",
      incomplete: JSON.stringify({ phone, access_token }),
      newline: JSON.stringify({ phone, access_token: access_token + "\nINJECT", userid }),
    },
  }
  const exported = exportLoomyAccounts(payload)
  assert.deepEqual(exported.accounts, [loomyLine()])
  assert.equal(exported.skipped, 4)
  assert.throws(() => exportLoomyAccounts({ ...payload, credentials: {} }), /没有可导出/)
  assert.throws(() => exportLoomyAccounts({ accounts: [] }), /没有可导出/)
})
