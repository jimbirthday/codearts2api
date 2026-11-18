import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { resolveCodeArtsScheduling, resolveLoomyScheduling } from "../../config/env.ts"
import { AppError } from "../../core/errors.ts"
import { writeJsonAtomic } from "../../core/fs-store.ts"
import type { SchedulingConfig } from "./account-scheduler.ts"

export type ChannelSchedulingConfig = SchedulingConfig & { cooldownMinSeconds: number; cooldownMaxSeconds: number }
type Provider = "codearts" | "loomy"

const commonFields = [
  {
    key: "maxInFlight",
    label: "每账号最大在途",
    min: 1,
    max: 100,
    hint: "同一账号的全部模型与调用方共用；各账号独立计数。",
  },
  { key: "queueLimit", label: "等待队列上限", min: 0, max: 10000, hint: "整个渠道的等待请求数；0 表示满载立即拒绝。" },
  { key: "queueTimeoutMs", label: "等待名额超时（毫秒）", min: 1, max: 120000, hint: "同一请求换号不会重置等待预算。" },
  {
    key: "stickyTtlMs",
    label: "会话绑定空闲有效期（毫秒）",
    min: 1,
    max: 86400000,
    hint: "优先复用同一会话的账号与缓存。",
  },
  {
    key: "stickyWaitMs",
    label: "粘性账号等待时间（毫秒）",
    min: 0,
    max: 120000,
    hint: "绑定账号忙时优先等待多久，再尝试其他空闲账号。",
  },
  {
    key: "cooldownMinSeconds",
    label: "模型限流冷却最短时间（秒）",
    min: 1,
    max: 86400,
    hint: "在最短与最长时间之间随机避让。",
  },
  {
    key: "cooldownMaxSeconds",
    label: "模型限流冷却最长时间（秒）",
    min: 1,
    max: 86400,
    hint: "随机冷却区间上界；已有冷却不会因保存而清除。",
  },
]
const codeartsFields = [
  {
    key: "sessionLimit",
    label: "每账号会话占位上限",
    min: 1,
    max: 100,
    hint: "包含正在运行和窗口内已结束的会话，体验版通常为 3。",
  },
  {
    key: "sessionTtlMs",
    label: "会话最短保留窗口（毫秒）",
    min: 0,
    max: 600000,
    hint: "华为实测约 60000；0 会关闭窗口保护，仅用于诊断。",
  },
]
const fields = (provider: Provider) => (provider === "codearts" ? [...commonFields, ...codeartsFields] : commonFields)
const invalid = (message: string) => new AppError(400, "invalid_scheduling", message)

function validate(provider: Provider, patch: any, current: ChannelSchedulingConfig) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || !Object.keys(patch).length)
    throw invalid("配置必须是非空对象")
  for (const [key, value] of Object.entries(patch)) {
    const field = fields(provider).find((item) => item.key === key)
    if (!field) throw invalid(`不支持的配置项：${key}`)
    if (typeof value !== "number" || !Number.isInteger(value) || value < field.min || value > field.max)
      throw invalid(`${field.label}必须是 ${field.min}–${field.max} 之间的整数`)
  }
  const next = { ...current, ...patch }
  if (next.cooldownMinSeconds > next.cooldownMaxSeconds) throw invalid("模型限流冷却最短时间不能大于最长时间")
  if (provider === "loomy") next.sessionLimit = next.maxInFlight
  return next as ChannelSchedulingConfig
}

/** 环境变量提供初值；界面保存的覆盖值持久化，成功落盘后再更新同一份运行配置。 */
export async function createSchedulingSettings({
  home,
  changed,
  env = process.env,
}: {
  home: string
  changed: (provider: Provider) => void
  env?: NodeJS.ProcessEnv
}) {
  const configs: Record<Provider, ChannelSchedulingConfig> = {
    codearts: { ...resolveCodeArtsScheduling(env), cooldownMinSeconds: 60, cooldownMaxSeconds: 180 },
    loomy: { ...resolveLoomyScheduling(env), cooldownMinSeconds: 60, cooldownMaxSeconds: 180 },
  }
  const file = join(home, "scheduling.json")
  let overrides: Partial<Record<Provider, Record<string, number>>> = {}
  try {
    const saved = JSON.parse(await readFile(file, "utf8"))
    if (
      saved?.version !== 1 ||
      !saved.providers ||
      typeof saved.providers !== "object" ||
      Array.isArray(saved.providers)
    )
      throw new Error("无法识别调度配置格式")
    for (const [provider, patch] of Object.entries(saved.providers)) {
      if (provider !== "codearts" && provider !== "loomy") throw new Error("调度配置包含未知渠道")
      Object.assign(configs[provider], validate(provider, patch, configs[provider]))
    }
    overrides = saved.providers
  } catch (error: any) {
    if (error.code !== "ENOENT") throw new Error(`读取调度配置失败：${error.message}`, { cause: error })
  }
  let pending = Promise.resolve<any>(undefined)
  return {
    configs,
    read() {
      return {
        providers: (["codearts", "loomy"] as const).map((id) => ({
          id,
          label: id === "codearts" ? "CodeArts" : "Loomy",
          config: { ...configs[id] },
          fields: fields(id),
        })),
      }
    },
    update(provider: string, patch: unknown) {
      const result = pending.then(async () => {
        if (provider !== "codearts" && provider !== "loomy") throw invalid("当前仅支持配置 CodeArts 和 Loomy")
        const next = validate(provider, patch, configs[provider])
        const saved = { ...overrides, [provider]: { ...overrides[provider], ...(patch as object) } }
        await writeJsonAtomic(file, { version: 1, providers: saved })
        overrides = saved
        Object.assign(configs[provider], next)
        changed(provider)
        return { config: { ...configs[provider] } }
      })
      pending = result.catch(() => {})
      return result
    },
  }
}

export type SchedulingSettingsService = Awaited<ReturnType<typeof createSchedulingSettings>>
