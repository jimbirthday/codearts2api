import type { AsyncLocalStorage } from "node:async_hooks"
import { subscribe, unsubscribe } from "node:diagnostics_channel"

import { BODY_LIMIT } from "../http/body.ts"
import { schedulingSessionKey } from "../modules/scheduling/session-key.ts"

export interface GatewayContext {
  sessionKey?: string
  started: number
}

/** 在 Node 的请求入口建立异步上下文，兼容代理入口与直接访问插件网关。 */
export function installGatewayContext(storage: AsyncLocalStorage<GatewayContext>, port: number) {
  const servers = new Map<any, { listeners: any[]; wrapped: any }>()
  const channel = "http.server.request.start"
  const start = ({ server }: any) => {
    if (server.address()?.port !== port || servers.has(server)) return
    const listeners = server.listeners("request")
    const original = listeners[0]
    const wrapped = (request: any, response: any) => {
      if (listeners.length !== 1 || typeof original !== "function") {
        response.writeHead(503, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            error: { code: "scheduling_contract_changed", message: "上游网关请求入口已变化，请检查宿主调度契约" },
          }),
        )
        return
      }
      const path = URL.parse(request.url ?? "/", "http://127.0.0.1")?.pathname
      if (request.method !== "POST" || !["/v1/chat/completions", "/v1/responses"].includes(path)) {
        original.call(server, request, response)
        return
      }
      const context: GatewayContext = {
        sessionKey: schedulingSessionKey(undefined, request.headers),
        started: performance.now(),
      }
      let chunks: Buffer[] = []
      let size = 0
      let discarded = false
      const discard = () => {
        discarded = true
        chunks = []
      }
      request.on("data", (chunk: Buffer) => {
        if (discarded) return
        size += chunk.length
        // shortcut: 超过宿主正文上限时仅使用会话请求头，需要更大正文时接上游解析钩子。
        if (size > BODY_LIMIT) discard()
        else chunks.push(chunk)
      })
      request.once("end", () => {
        if (!discarded) {
          try {
            context.sessionKey = schedulingSessionKey(
              JSON.parse(Buffer.concat(chunks).toString("utf8")),
              request.headers,
            )
          } catch {
            /* JSON 校验和错误响应仍由上游负责。 */
          }
        }
        discard()
      })
      response.once("close", discard)
      storage.run(context, () => original.call(server, request, response))
    }
    // Node 在 emit('request') 之前发布此事件；本次与后续请求均经过同一个入口。
    for (const listener of listeners) server.off("request", listener)
    server.on("request", wrapped)
    servers.set(server, { listeners, wrapped })
    server.once("close", () => servers.delete(server))
  }
  subscribe(channel, start)
  return () => {
    unsubscribe(channel, start)
    for (const [server, { listeners, wrapped }] of servers) {
      server.off("request", wrapped)
      for (const listener of listeners) server.on("request", listener)
    }
    servers.clear()
  }
}
