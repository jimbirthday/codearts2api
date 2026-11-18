import { createHash } from "node:crypto"

function text(content: any): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if (typeof part?.text === "string") return part.text
      return ["image_url", "input_image"].includes(part?.type) ? "[image]" : ""
    })
    .join("")
}

/** 只保留会话摘要；API Key、提示词和图片内容不进入绑定表或日志。 */
export function schedulingSessionKey(body: any, headers: Record<string, any>): string | undefined {
  const explicit = [
    body?.metadata?.conversation_id,
    body?.metadata?.conversationId,
    body?.conversation_id,
    body?.conversationId,
    body?.prompt_cache_key,
    headers["x-conversation-id"],
    headers["x-session-id"],
  ].find((value) => typeof value === "string" && value.trim() && value.length <= 2048)
  let identity: string[]
  if (explicit) {
    identity = ["explicit", explicit.trim()]
  } else {
    const messages = Array.isArray(body?.messages) ? body.messages : Array.isArray(body?.input) ? body.input : []
    const system =
      body?.instructions ?? text(messages.find((message) => ["system", "developer"].includes(message?.role))?.content)
    const user =
      typeof body?.input === "string" ? body.input : text(messages.find((message) => message?.role === "user")?.content)
    if (!user) return undefined
    // shortcut: 相同首轮内容可能属于不同会话，需要严格隔离时由客户端传显式会话键。
    identity = ["derived", typeof system === "string" ? system : "", user]
  }
  return createHash("sha256")
    .update(JSON.stringify([headers.authorization ?? "", headers["x-caller-id"] ?? "", ...identity]))
    .digest("hex")
}
