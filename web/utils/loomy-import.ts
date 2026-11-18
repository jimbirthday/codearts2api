import type { AccountImportBatch } from "./account-import"

/** 仅做格式转换；账号与凭据仍经上游 merge 导入。 */
export async function prepareLoomyImport(files: File[]): Promise<AccountImportBatch> {
  if (files.length > 100 || files.reduce((sum, file) => sum + file.size, 0) > 2 * 1024 * 1024)
    throw new Error("每批最多 100 个 TXT 文件，总大小不超过 2 MB；请分批导入")
  const now = Date.now()
  const batch: AccountImportBatch = {
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
  const seen = new Set<string>()
  for (const file of files) {
    let text: string
    try {
      text = await file.text()
    } catch {
      batch.rows.push({ source: file.name, status: "invalid", message: "文件读取失败，请重新选择" })
      continue
    }
    if (!text.trim()) batch.rows.push({ source: file.name, status: "invalid", message: "TXT 文件为空" })
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (!line.trim()) continue
      const source = `${file.name} · 第 ${index + 1} 行`
      const parts = line
        .trim()
        .split("----")
        .map((value) => value.trim())
      const [phone, access_token, userid] = parts
      if (
        parts.length !== 3 ||
        !/^1\d{10}$/.test(phone) ||
        !/^[a-f\d]{32}$/i.test(access_token) ||
        !/^\d{6,64}$/.test(userid)
      ) {
        batch.rows.push({ source, status: "invalid", message: "格式需为 手机号----32位 session token----userid" })
        continue
      }
      const keys = [`user:${userid}`, `token:${access_token}`, `phone:${phone}`]
      if (keys.some((key) => seen.has(key))) {
        batch.rows.push({ source, status: "skipped", message: "同批次重复账号，保留首条" })
        continue
      }
      keys.forEach((key) => seen.add(key))
      const credentialRef = `LOOMY_ACCOUNT_IMPORT_${userid}`
      const nickname = `Loomy ${phone.slice(0, 3)}****${phone.slice(-4)}`
      batch.payload.accounts.push({
        id: `loomy-import-${userid}`,
        provider: "loomy",
        nickname,
        enabled: true,
        credentialRef,
        refreshable: false,
        createdAt: now,
      })
      // TXT 不含到期时间，不能用导入时刻伪造新的 14 天有效期。
      batch.payload.credentials[credentialRef] = JSON.stringify({ phone, access_token, userid })
      batch.rows.push({ source, status: "ready", message: `${nickname}；有效期未知，失效后需重新登录` })
    }
  }
  return batch
}
