import { generateKeyPairSync } from "node:crypto"

const privateKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "jwk" })

export function codeArtsJson(userId = "test-user-1") {
  return {
    user_id: userId,
    user_name: `测试账号 ${userId}`,
    domain_id: "test-domain",
    access_key_id: `TEST_AK_${userId}`,
    secret_access_key: "TEST_SECRET_DO_NOT_DISPLAY",
    cloud_dragon_token: "TEST_TOKEN_DO_NOT_DISPLAY",
    expiration: new Date(Date.now() + 24 * 3_600_000).toISOString(),
    refresh_token: "TEST_REFRESH_DO_NOT_DISPLAY",
    code_verifier: "v".repeat(43),
    dpop_private_key: privateKey,
    client_id: "codearts-agent",
    updated_at: 1,
  }
}

export function jsonFile(name: string, value: unknown, raw = false): File {
  const content = raw ? String(value) : JSON.stringify(value)
  return Object.assign(new File([content], name, { type: "application/json" }), { text: async () => content })
}
