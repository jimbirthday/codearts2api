import { normalizeLoomyCredential } from "./loomy-import"

/** 只导出 Loomy 的三列凭据，忽略缺失/损坏条目与其他渠道。 */
export function exportLoomyAccounts(payload: any) {
  const accounts: string[] = []
  let skipped = 0
  for (const entry of payload?.accounts ?? []) {
    if (entry.provider !== "loomy") continue
    try {
      const { phone, access_token, userid } = normalizeLoomyCredential(
        JSON.parse(payload.credentials[entry.credentialRef]),
      )
      accounts.push(`${phone}----${access_token}----${userid}`)
    } catch {
      skipped++
    }
  }
  if (!accounts.length) throw new Error("没有可导出的 Loomy 凭据，请检查账号和凭据状态")
  return { accounts, skipped }
}
