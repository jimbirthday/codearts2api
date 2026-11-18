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
 */

/** Jet Hub 管理端点路径（上游 `JET_HUB_API_PATH`）。 */
export const JET_HUB_PATH = "/api/jet-hub"

/** zcode 内部载体的载体页路径（上游 `CAPTCHA_CARRIER_PATH`，可选功能）。 */
export const CARRIER_PATH = "/api/jet-hub/captcha-carrier"

/** RPC 线协议里的端点名（上游 `JET_HUB_ENDPOINT`）。 */
export const JET_HUB_ENDPOINT = "jet-hub"

/** 客户端 bundle 会注册的 slot 名（我们据此把页面组件捞出来）。 */
export const SETTINGS_SECTION_SLOT = "settings.section"

/** 宿主调度只接这些实例成员；不导入或复制上游内部模块。 */
export function assertCodeArtsSchedulingContract(adapter: any) {
  const pool = adapter?.options?.accountPool
  if (
    !pool ||
    !["candidateAccounts", "resolveFirstCredential", "getAvailableAccount", "updateModelRateLimit"].every(
      (name) => typeof pool[name] === "function",
    ) ||
    typeof adapter.options.resolveCredential !== "function" ||
    typeof adapter.options.refresh !== "function" ||
    typeof adapter.prepareCall !== "function" ||
    typeof adapter.consumeSse !== "function" ||
    typeof adapter.queryQueueStatus !== "function" ||
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
