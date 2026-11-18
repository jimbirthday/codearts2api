/**
 * 环境变量解析（进程启动配置）。
 *
 * 原则：非法值**显式失败**，不静默换值 —— 静默改端口/开关会让按文档配置的反代指向空。
 */

/** 默认管理端口。 */
export const DEFAULT_PORT = 8080

/** 解析端口（1–65535 整数，否则抛错）。 */
export function resolvePort(env = process.env): number {
  const raw = env.PORT
  if (raw === undefined || raw === "") return DEFAULT_PORT
  const port = Number.parseInt(raw, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== raw.trim()) {
    throw new Error(`PORT 必须是 1 到 65535 之间的整数，收到：${raw}`)
  }
  return port
}

/** 监听地址：默认全网卡（容器里必须如此，否则宿主访问不到）。 */
export function resolveHost(env = process.env): string {
  const raw = env.HOST?.trim()
  return raw === undefined || raw === "" ? "0.0.0.0" : raw
}

/**
 * 是否把 `/v1/*` 反代到插件网关（默认开启；`PROXY_GATEWAY=0/false/off/no` 关闭）。
 * 默认开启：否则容器里忘设就表现为「服务起来了但 /v1 全 404」，极难排查。
 */
export function resolveProxyGateway(env = process.env): boolean {
  const raw = env.PROXY_GATEWAY?.trim().toLowerCase()
  if (raw === undefined || raw === "") return true
  return !["0", "false", "off", "no"].includes(raw)
}

/**
 * 是否启用管理端鉴权（默认开启；`CODEARTS2API_ADMIN_AUTH=0/false/off/no` 关闭）。
 * 关闭仅用于本机调试。
 */
export function resolveAdminAuth(env = process.env): boolean {
  const raw = env.CODEARTS2API_ADMIN_AUTH?.trim().toLowerCase()
  if (raw === undefined || raw === "") return true
  return !["0", "false", "off", "no"].includes(raw)
}

function schedulingInteger(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number) {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || String(value) !== raw || value < min || value > max)
    throw new Error(`${name} 必须是 ${min} 到 ${max} 之间的整数`)
  return value
}

function commonScheduling(env: NodeJS.ProcessEnv, prefix: string, maxInFlight: number) {
  return {
    maxInFlight: schedulingInteger(env, `${prefix}_MAX_IN_FLIGHT`, maxInFlight, 1, 100),
    queueLimit: schedulingInteger(env, `${prefix}_QUEUE_LIMIT`, 100, 0, 10_000),
    queueTimeoutMs: schedulingInteger(env, `${prefix}_QUEUE_TIMEOUT_MS`, 15_000, 1, 120_000),
    stickyTtlMs: schedulingInteger(env, `${prefix}_STICKY_TTL_MS`, 1_800_000, 1, 86_400_000),
    stickyWaitMs: schedulingInteger(env, `${prefix}_STICKY_WAIT_MS`, 1000, 0, 120_000),
  }
}

export function resolveCodeArtsScheduling(env = process.env) {
  return {
    ...commonScheduling(env, "CODEARTS", 3),
    sessionLimit: schedulingInteger(env, "CODEARTS_SESSION_LIMIT", 3, 1, 100),
    sessionTtlMs: schedulingInteger(env, "CODEARTS_SESSION_TTL_MS", 60_000, 0, 600_000),
  }
}

export function resolveLoomyScheduling(env = process.env) {
  const config = commonScheduling(env, "LOOMY", 2)
  return { ...config, sessionLimit: config.maxInFlight, sessionTtlMs: 0 }
}
