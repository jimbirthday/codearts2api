/**
 * 与上游插件的**契约常量**集中在这里。
 *
 * ## 为什么要单独一个文件
 *
 * 本仓库是「薄胶水」，全部脆弱性都来自**对上游约定的假设**。把这些假设
 * 散落在各文件里（各处零散常量），升级上游
 * 时要靠 grep 找全，漏一处就是「一半能用一半 404」。
 *
 * 上游改名/改协议时先从这里核对；`UPSTREAM_CONTRACT` 与断言显式列出这些假设。
 *
 * ## 目前依赖上游的哪些约定
 *
 * | 约定 | 上游出处 | 变了会怎样 |
 * | --- | --- | --- |
 * | 管理端点路径 `/api/jet-hub` | `src/jet-hub-rpc.ts` 的 `JET_HUB_API_PATH` | 管理界面全部 404 |
 * | 载体页路径 `/api/jet-hub/captcha-carrier` | `CAPTCHA_CARRIER_PATH` | 仅 zcode 载体页 404（可选功能） |
 * | RPC 信封 `{type,rpcId,method,payload}` | `registerJetHubEndpoints` 的校验 | 管理界面全部报错 |
 * | 客户端 loader `window.__ModuleLoader__.load` | `plugin-src/client/build.mjs` | `/admin` 白屏 |
 * | slot 名 `settings.section` | `plugin-src/client/index.js` | `/admin` 抛出「未注册」 |
 * | 插件 `inject = ['credentials','commands','llm']` | `src/index.ts` | 缺服务则永久 pending |
 * | 网关绑 `127.0.0.1` | `openai-gateway/config.ts` | 容器必须走反代 |
 * | CodeArts 账号池、适配器 options / prepareCall / 会话字段 | `assertCodeArtsSchedulingContract` | 启动失败，核对宿主调度钩子 |
 * | 网关单个 request 监听器 | `host/gateway-context.ts` | 返回可读 503，核对请求入口 |
 * | `lib/llm-adapter.js` 的并发错误分类函数 | `loadCodeArtsConcurrencyClassifier` | 启动失败，核对版本契约 |
 * | Loomy 的协议、失败分类与余额缓存模块 | `loadLoomyScheduling` | 启动失败，核对版本契约 |
 * | 两渠道实际账号的账本回报 | `loadSchedulingLedger` | 启动失败，核对记账入口 |
 */

/** Jet Hub 管理端点路径（上游 `JET_HUB_API_PATH`）。 */
export const JET_HUB_PATH = "/api/jet-hub"

/** zcode 内部载体的载体页路径（上游 `CAPTCHA_CARRIER_PATH`，可选功能）。 */
export const CARRIER_PATH = "/api/jet-hub/captcha-carrier"

/** RPC 线协议里的端点名（上游 `JET_HUB_ENDPOINT`）。 */
export const JET_HUB_ENDPOINT = "jet-hub"

/** 客户端 bundle 会注册的 slot 名（我们据此把页面组件捞出来）。 */
export const SETTINGS_SECTION_SLOT = "settings.section"

/** 包根未重导出该纯函数；按固定版本的相邻模块加载，避免复制业务码解析。 */
export async function loadCodeArtsConcurrencyClassifier(): Promise<(body: string) => boolean> {
  const { isConcurrencyLimitError } = await import(
    new URL("./llm-adapter.js", import.meta.resolve("dsh-providers-hub")).href
  )
  if (typeof isConcurrencyLimitError !== "function") {
    throw new Error("CodeArts 并发错误分类契约已变化，请核对 src/core/upstream.ts")
  }
  return isConcurrencyLimitError
}

/** 调度更换选号入口后仍须向上游账本回报实际账号。 */
export async function loadSchedulingLedger(): Promise<(provider: string, accountId: string) => void> {
  const { reportLedgerAccount } = await import(
    new URL("./token-ledger.js", import.meta.resolve("dsh-providers-hub")).href
  )
  if (typeof reportLedgerAccount !== "function") throw new Error("上游账号记账契约已变化，请核对 src/core/upstream.ts")
  return reportLedgerAccount
}

/** Loomy 的协议、余额与失败分类继续复用锁定版本的上游模块。 */
export async function loadLoomyScheduling() {
  const base = import.meta.resolve("dsh-providers-hub")
  const [adapter, credits, ranks, runtime, protocol, catalog, cache, product] = await Promise.all([
    import(new URL("./loomy-adapter.js", base).href),
    import(new URL("./loomy-credits.js", base).href),
    import(new URL("./loomy-balance-rank.js", base).href),
    import(new URL("./provider-runtime.js", base).href),
    import(new URL("./loomy.js", base).href),
    import(new URL("./model-catalog.js", base).href),
    import(new URL("./ttl-cache.js", base).href),
    import(new URL("./loomy-product.js", base).href),
  ])
  const result = {
    classify: adapter.classifyLoomyFailure,
    quotaResetAt: adapter.loomyCooldownResetAtMs,
    fetchBalance: credits.fetchLoomyCreditDetail,
    tier: ranks.loomyBalanceTier,
    tierUsable: ranks.loomyTierUsable,
    balanceCache: runtime.balanceCacheOf,
    envelope: protocol.parseLoomyEnvelope,
    parseModels: adapter.parseLoomyRemoteModels,
    businessHeaders: protocol.loomyBusinessHeaders,
    catalogKey: product.loomyCatalogKey,
    TtlCache: cache.TtlCache,
  }
  if (Object.values(result).some((value) => typeof value !== "function"))
    throw new Error("Loomy 调度契约已变化，请核对 src/core/upstream.ts")
  if (!Number.isFinite(catalog.CATALOG_REFRESH_INTERVAL_MS) || catalog.CATALOG_REFRESH_INTERVAL_MS <= 0)
    throw new Error("Loomy 模型目录缓存契约已变化，请核对 src/core/upstream.ts")
  return { ...result, catalogTtlMs: catalog.CATALOG_REFRESH_INTERVAL_MS }
}

export function assertLoomySchedulingContract(adapter: any) {
  if (
    !adapter?.product?.apiBase ||
    !["prepareCall", "stream", "fetchImpl"].every((name) => typeof adapter[name] === "function") ||
    ![
      "candidateAccounts",
      "resolveFirstCredential",
      "getAvailableAccount",
      "updateModelRateLimit",
      "permanentLocked",
      "findAccount",
      "strictManualOrder",
    ].every((name) => typeof adapter.options?.accountPool?.[name] === "function") ||
    !["resolveCredential", "refresh"].every((name) => typeof adapter.options?.[name] === "function") ||
    !Object.getOwnPropertyDescriptor(adapter, "fetchImpl")?.configurable
  )
    throw new Error("Loomy 适配器契约已变化，请核对 src/core/upstream.ts")
}

/** 宿主调度只接这些实例成员；协议和凭据实现仍由上游负责。 */
export function assertCodeArtsSchedulingContract(adapter: any) {
  const pool = adapter?.options?.accountPool
  if (
    !pool ||
    ![
      "candidateAccounts",
      "resolveFirstCredential",
      "getAvailableAccount",
      "updateModelRateLimit",
      "clearModelRateLimits",
      "findAccount",
      "getStateSnapshot",
      "updateAccount",
    ].every((name) => typeof pool[name] === "function") ||
    typeof adapter.options.resolveCredential !== "function" ||
    typeof adapter.options.refresh !== "function" ||
    typeof adapter.prepareCall !== "function" ||
    typeof adapter.consumeSse !== "function" ||
    typeof adapter.queryQueueStatus !== "function" ||
    typeof adapter.fetchImpl !== "function" ||
    !Object.getOwnPropertyDescriptor(adapter, "fetchImpl")?.configurable ||
    !["chatId", "sessionId"].every(
      (name) => typeof adapter[name] === "string" && Object.getOwnPropertyDescriptor(adapter, name)?.configurable,
    )
  ) {
    throw new Error("CodeArts 调度契约已变化，请核对上游账号池、适配器 options 与会话字段（src/core/upstream.ts）")
  }
}

/** 服务端 RPC 的规范错误信封里用到的字段（仅文档用途）。 */
export const UPSTREAM_CONTRACT = Object.freeze({
  managementPath: JET_HUB_PATH,
  carrierPath: CARRIER_PATH,
  endpoint: JET_HUB_ENDPOINT,
  clientLoader: "window.__ModuleLoader__.load",
  settingsSlot: SETTINGS_SECTION_SLOT,
  requiredServices: ["credentials", "commands", "llm"],
  gatewayHost: "127.0.0.1",
})

/**
 * 构造一条 Jet Hub RPC 请求体。
 *
 * 三处（`/healthz` 探活、关闭前的端口探测、浏览器端 `rpcCall`）都用同一份
 * 信封形状；写成函数可以避免它们各自漂移 —— 上游改协议时只改这里。
 *
 * @param method - RPC 方法名，如 `gateway.getEnabled`。
 * @param payload - 方法载荷。
 * @param rpcId - 请求 id；默认生成一个。
 */
export function rpcEnvelope(method, payload, rpcId = "rpc") {
  return {
    type: "client-request",
    rpcId,
    method: JET_HUB_ENDPOINT,
    payload: { method, payload },
  }
}
