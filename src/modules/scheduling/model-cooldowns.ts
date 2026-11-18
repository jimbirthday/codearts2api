import { randomInt } from "node:crypto"

import { AppError } from "../../core/errors.ts"

/** CodeArts 的本地避让期限；状态读写与持久化仍由上游账号池负责。 */
export function createModelCooldowns(pool: any, changed: () => void) {
  const update = pool.updateModelRateLimit
  const clear = pool.clearModelRateLimits
  let pending = Promise.resolve<any>(undefined)
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = pending.then(work)
    pending = result.catch(() => {})
    return result
  }
  const until = () => Date.now() + randomInt(60, 181) * 1000
  const accounts = () => pool.getStateSnapshot().accounts.filter((entry: any) => entry.provider === "codearts")

  pool.updateModelRateLimit = function (id: string, model: string, resetAt: number) {
    if (pool.findAccount(id)?.provider !== "codearts") return update.call(this, id, model, resetAt)
    if (!Number.isFinite(resetAt) || resetAt <= Date.now() || resetAt > 8.64e15)
      return update.call(this, id, model, resetAt)
    return serial(async () => {
      const key = model.trim()
      const now = Date.now()
      const current = pool.findAccount(id)?.modelRateLimits?.[key]
      // 冷却期间的并发失败不续期；旧版本的长冷却在下次写入时收敛。
      if (current > now && current <= now + 180_000) return
      if (current > now + 180_000) await clear.call(pool, id, [key])
      await update.call(pool, id, key, until())
      changed()
    })
  }
  pool.clearModelRateLimits = function (id: string, models?: string[]) {
    if (pool.findAccount(id)?.provider !== "codearts") return clear.call(this, id, models)
    return serial(async () => {
      const count = await clear.call(pool, id, models)
      changed()
      return count
    })
  }

  return {
    normalize() {
      return serial(async () => {
        let shortened = 0
        for (const account of accounts()) {
          const limits = { ...account.modelRateLimits }
          let dirty = false
          for (const [model, resetAt] of Object.entries(limits)) {
            if (typeof resetAt === "number" && resetAt > Date.now() + 180_000) {
              limits[model] = until()
              dirty = true
              shortened++
            }
          }
          if (dirty) await pool.updateAccount(account.id, { modelRateLimits: limits })
        }
        changed()
        return shortened
      })
    },
    clear: (selection: CooldownSelection) => clearModelCooldowns(pool, "codearts", selection),
    close() {
      pool.updateModelRateLimit = update
      pool.clearModelRateLimits = clear
    },
  }
}

interface CooldownSelection {
  all?: boolean
  modelIds?: unknown
  accountIds?: unknown
}

/** 只清本地标记；范围校验和写盘在两个渠道共用。 */
export async function clearModelCooldowns(pool: any, provider: string, selection: CooldownSelection) {
  const strings = (value: unknown, label: string): string[] => {
    if (
      !Array.isArray(value) ||
      !value.length ||
      value.length > 1000 ||
      value.some((id) => typeof id !== "string" || !id.trim() || id.length > 512)
    )
      throw new AppError(400, "invalid_selection", `${label} 必须是 1–1000 个有效字符串`)
    return [...new Set(value.map((id) => id.trim()))]
  }
  if (selection.all !== undefined && typeof selection.all !== "boolean")
    throw new AppError(400, "invalid_selection", "all 必须是布尔值")
  const modelIds =
    selection.all === true && selection.modelIds === undefined ? undefined : strings(selection.modelIds, "modelIds")
  const accountIds = selection.accountIds === undefined ? undefined : strings(selection.accountIds, "accountIds")
  const targets = pool
    .getStateSnapshot()
    .accounts.filter(
      (account: any) => account.provider === provider && (!accountIds || accountIds.includes(account.id)),
    )
  if (accountIds?.some((id) => !targets.some((account: any) => account.id === id)))
    throw new AppError(400, "invalid_selection", `accountIds 含不存在或不属于 ${provider} 的账号`)
  let cleared = 0
  let affectedAccounts = 0
  const failed: string[] = []
  for (const account of targets) {
    try {
      const count = await pool.clearModelRateLimits(account.id, modelIds)
      cleared += count
      if (count) affectedAccounts++
    } catch {
      failed.push(account.id)
    }
  }
  return { cleared, affectedAccounts, failed }
}
