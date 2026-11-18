export interface ImportRow {
  source: string
  status: "ready" | "skipped" | "invalid"
  message: string
}

export interface CodeArtsImportBatch {
  payload: {
    format: "dsh-codearts-auth/backup"
    version: 1
    exportedAt: string
    credentials: Record<string, string>
    accounts: Array<{
      id: string
      provider: "codearts"
      nickname: string
      enabled: boolean
      credentialRef: string
      refreshable: boolean
      createdAt: number
      expiresAt: number
    }>
    disabledModels: Record<string, never>
  }
  rows: ImportRow[]
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("账号必须是 JSON 对象")
  return value as Record<string, unknown>
}

function text(value: unknown, field: string, required = true): string | undefined {
  if (!required && value === undefined) return undefined
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} 必须是非空字符串`)
  return value.trim()
}

function normalize(value: unknown) {
  const raw = object(value)
  const credential = {
    access_key_id: text(raw.access_key_id, "access_key_id")!,
    secret_access_key: text(raw.secret_access_key, "secret_access_key")!,
    security_token: text(raw.security_token ?? raw.cloud_dragon_token, "security_token / cloud_dragon_token")!,
    expires_at: text(raw.expires_at ?? raw.expiration, "expires_at / expiration")!,
    // shortcut: 跨来源缺少相同身份字段时可能重复，待上游统一身份判重后移除此限制。
    user_id: text(raw.user_id, "user_id", false),
    user_name: text(raw.user_name, "user_name", false),
    domain_id: text(raw.domain_id, "domain_id", false),
    refresh_token: text(raw.refresh_token, "refresh_token", false),
    code_verifier: text(raw.code_verifier, "code_verifier", false),
    dpop_private_key_jwk: undefined as Record<string, unknown> | undefined,
  }
  const expiresAt = Date.parse(credential.expires_at)
  if (!Number.isFinite(expiresAt)) throw new Error("expiration / expires_at 不是有效日期")
  if (credential.access_key_id.length > 256 || (credential.user_id?.length ?? 0) > 256) {
    throw new Error("access_key_id / user_id 不能超过 256 个字符")
  }
  credential.expires_at = new Date(expiresAt).toISOString()

  const jwk = raw.dpop_private_key_jwk ?? raw.dpop_private_key
  if (jwk !== undefined) {
    const key = object(jwk)
    if (
      key.kty !== "EC" ||
      key.crv !== "P-256" ||
      ![key.x, key.y, key.d].every((part) => typeof part === "string" && /^[\w-]{43}$/.test(part))
    ) {
      throw new Error("DPoP 私钥必须是包含 x、y、d 的 EC P-256 JWK")
    }
    credential.dpop_private_key_jwk = { kty: key.kty, crv: key.crv, x: key.x, y: key.y, d: key.d }
  }

  return { credential, expiresAt }
}

/** 只转换文件格式；凭据写入和账号合并仍由上游 backup.import 负责。 */
export async function prepareCodeArtsImport(files: File[]): Promise<CodeArtsImportBatch> {
  if (files.length > 100 || files.reduce((sum, file) => sum + file.size, 0) > 2 * 1024 * 1024) {
    throw new Error("每批最多 100 个 JSON 文件，总大小不超过 2 MB；请分批导入")
  }
  const now = Date.now()
  const batch: CodeArtsImportBatch = {
    payload: {
      format: "dsh-codearts-auth/backup",
      version: 1,
      exportedAt: new Date(now).toISOString(),
      credentials: {},
      accounts: [],
      disabledModels: {},
    },
    rows: [],
  }
  const identities = new Set<string>()
  for (const file of files) {
    let content: string
    try {
      content = await file.text()
    } catch {
      batch.rows.push({ source: file.name, status: "invalid", message: "文件读取失败，请重新选择" })
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(content.trimStart())
    } catch {
      batch.rows.push({ source: file.name, status: "invalid", message: "JSON 格式错误" })
      continue
    }
    const records = Array.isArray(parsed) ? parsed : [parsed]
    if (!records.length) batch.rows.push({ source: file.name, status: "invalid", message: "账号数组为空" })
    for (const [index, record] of records.entries()) {
      const source = Array.isArray(parsed) ? `${file.name} · 第 ${index + 1} 条` : file.name
      try {
        const { credential, expiresAt } = normalize(record)
        const keys = [`ak:${credential.access_key_id}`]
        if (credential.user_id) keys.push(`user:${credential.user_id}`)
        if (keys.some((key) => identities.has(key))) {
          batch.rows.push({ source, status: "skipped", message: "同批次重复账号，保留首条" })
          continue
        }
        // 用身份的 UTF-8 十六进制生成稳定 ref，普通 HTTP 部署也无需 Web Crypto。
        const suffix = Array.from(new TextEncoder().encode(keys.at(-1)!), (b) => b.toString(16).padStart(2, "0")).join(
          "",
        )
        const credentialRef = `CODEARTS_ACCOUNT_IMPORT_${suffix}`
        const refreshable = Boolean(
          credential.refresh_token && credential.code_verifier && credential.dpop_private_key_jwk,
        )
        const nickname = credential.user_name ?? credential.user_id ?? "CodeArts 导入账号"
        batch.payload.accounts.push({
          id: `codearts-import-${suffix}`,
          provider: "codearts",
          nickname,
          enabled: true,
          credentialRef,
          refreshable,
          createdAt: now,
          expiresAt,
        })
        batch.payload.credentials[credentialRef] = JSON.stringify(credential)
        keys.forEach((key) => identities.add(key))
        const state = expiresAt <= now ? "临时凭据已过期" : "临时凭据未过期"
        const renewal = refreshable ? "含自动续期材料" : "缺少完整续期材料，到期后需重新登录"
        batch.rows.push({ source, status: "ready", message: `${nickname}：${state}；${renewal}` })
      } catch (error) {
        batch.rows.push({ source, status: "invalid", message: (error as Error).message })
      }
    }
  }
  return batch
}
