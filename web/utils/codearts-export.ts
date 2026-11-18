import { normalizeCodeArtsCredential } from "./codearts-import"

/** 只转换上游备份中的 CodeArts 凭据，复用导入校验以保证导出的文件可以重新导入。 */
export function exportCodeArtsAccounts(payload: any) {
  const accounts: Record<string, unknown>[] = []
  let skipped = 0
  for (const entry of payload?.accounts ?? []) {
    if (entry.provider !== "codearts") continue
    try {
      const raw = JSON.parse(payload.credentials[entry.credentialRef])
      const { credential } = normalizeCodeArtsCredential(raw)
      const { security_token, expires_at, dpop_private_key_jwk, ...rest } = { ...raw, ...credential }
      accounts.push({
        ...rest,
        cloud_dragon_token: security_token,
        expiration: expires_at,
        ...(dpop_private_key_jwk ? { dpop_private_key: dpop_private_key_jwk } : {}),
      })
    } catch {
      skipped++
    }
  }
  if (!accounts.length) throw new Error("没有可导出的 CodeArts 凭据，请检查账号和凭据状态")
  return { accounts, skipped }
}
