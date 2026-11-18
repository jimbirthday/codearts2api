import assert from "node:assert/strict"
import { test, vi } from "vite-plus/test"
import { credentialRef } from "@deepseek-ai/dsh-credentials"
import { createHash } from "node:crypto"
import { subscribe, unsubscribe } from "node:diagnostics_channel"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createCallerGate } from "../src/modules/caller-gate/caller-gate.service.ts"
import { createUpstreamKeyReader } from "../src/modules/gateway/gateway-key.service.ts"

import { prepareCodeArtsImport } from "../web/utils/codearts-import"
import { codeArtsJson, jsonFile } from "./fixtures/codearts-import"
import { rpc, startTestApp } from "./helpers"

const MODEL = "deepseek-v4.1-flash"
const encoder = new TextEncoder()
const delta = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`
const end = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`
const completion = () => new Response(delta("OK") + end, { headers: { "content-type": "text/event-stream" } })

async function setup(t: any, count = 2, config: Record<string, string> = {}, options: any = {}) {
  for (const [name, value] of Object.entries({ CODEARTS_SESSION_TTL_MS: "0", ...config })) vi.stubEnv(name, value)
  const app = await startTestApp(options)
  t.onTestFinished(async () => {
    await app.close()
    vi.unstubAllEnvs()
  })
  const batch = await prepareCodeArtsImport(
    Array.from({ length: count }, (_, i) => jsonFile(`${i}.json`, codeArtsJson(`account-${i}`))),
  )
  assert.equal((await rpc(app.origin, "backup.import", { payload: batch.payload, mode: "merge" })).ok, true)
  const adapter = app.host.ctx.get("llm").adapters.get("codearts").adapter
  adapter.options.fetchRemoteModels = async () => [{ id: MODEL, name: "Test model", contextWindow: 131072 }]
  adapter.options.catalogComplete = () => true
  const status = (await rpc(app.origin, "gateway.getEnabled")).value
  const key = status.apiKey.value
  const calls: Array<{ account: string; chat: string; session: string; cacheKey: string }> = []
  let answer = async (_url: string, _init: any): Promise<Response> => completion()
  adapter.fetchImpl = (url: string, init: any) => {
    assert.match(url, /chat\/completions$|queue\/status\?/)
    const headers = new Headers(init.headers)
    const account = /Access=([^,\s]+)/.exec(headers.get("authorization")!)?.[1] ?? ""
    assert.ok(account)
    if (url.endsWith("/chat/completions"))
      calls.push({
        account,
        chat: headers.get("chat-id")!,
        session: headers.get("session-id")!,
        cacheKey: JSON.parse(init.body).prompt_cache_key,
      })
    return answer(url, init)
  }
  const send = (session: string, extra: any = {}, origin = app.origin, path = "/v1/chat/completions") => {
    const { signal, headers, ...payload } = extra
    return fetch(origin + path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}`, ...headers },
      body: JSON.stringify({
        model: `codearts/${MODEL}`,
        messages: [{ role: "user", content: "hello" }],
        metadata: { conversation_id: session },
        ...payload,
      }),
      signal,
    })
  }
  return {
    app,
    adapter,
    calls,
    send,
    batch,
    direct: `http://${status.address.host}:${status.address.port}`,
    setAnswer(fn: typeof answer) {
      answer = fn
    },
  }
}

test("真实 Chat/Responses/直连网关：会话固定账号与 Chat-Id，每个推理任务 Session-Id 独立", async (t) => {
  const env = await setup(t)
  for (const session of ["first", "second", "first"]) {
    const response = await env.send(session)
    assert.equal(response.status, 200, JSON.stringify(await response.json()))
  }
  assert.equal(env.calls[0].account, env.calls[2].account)
  assert.notEqual(env.calls[0].account, env.calls[1].account)
  assert.equal(env.calls[0].chat, env.calls[2].chat)
  assert.notEqual(env.calls[0].session, env.calls[2].session)
  assert.equal(env.calls[0].cacheKey, env.calls[2].cacheKey)
  assert.notEqual(env.calls[0].cacheKey, env.calls[1].cacheKey)
  assert.notEqual(env.calls[0].cacheKey, env.calls[0].session)
  const response = await env.send("first", { input: "hello", messages: undefined }, env.direct, "/v1/responses")
  assert.equal(response.status, 200, JSON.stringify(await response.json()))
  assert.equal(env.calls[0].account, env.calls[3].account)
  assert.equal(env.calls[0].chat, env.calls[3].chat)
  assert.equal(env.calls[0].cacheKey, env.calls[3].cacheKey)
  assert.notEqual(env.calls[0].session, env.calls[3].session)
  assert.notEqual(env.calls[0].chat, env.calls[1].chat)
  assert.equal(env.app.host.codeartsScheduling.stats().inFlight, 0)
})

test("默认 HTTP 并发：20 个请求在两账号上运行，每号最大在途为 3", async (t) => {
  vi.stubEnv("CODEARTS_MAX_IN_FLIGHT", undefined)
  const env = await setup(t)
  assert.equal(env.app.host.codeartsScheduling.stats().maxInFlight, 3)
  const active = new Map<string, number>()
  const peak = new Map<string, number>()
  env.setAnswer(async (_url, init) => {
    const account = /Access=([^,\s]+)/.exec(new Headers(init.headers).get("authorization")!)![1]
    active.set(account, (active.get(account) ?? 0) + 1)
    peak.set(account, Math.max(peak.get(account) ?? 0, active.get(account)!))
    return new Response(
      new ReadableStream({
        start(controller) {
          setTimeout(() => {
            active.set(account, active.get(account)! - 1)
            controller.enqueue(encoder.encode(delta("OK") + end))
            controller.close()
          }, 15)
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
  })
  await Promise.all(
    Array.from({ length: 20 }, async (_, i) => {
      const response = await env.send(`session-${i}`)
      assert.equal(response.status, 200, JSON.stringify(await response.json()))
    }),
  )
  assert.equal(peak.size, 2)
  assert.ok([...peak.values()].every((value) => value === 3))
  assert.equal(env.app.host.codeartsScheduling.stats().inFlight, 0)
  assert.equal(env.app.host.codeartsScheduling.stats().queued, 0)
})

test("流结束仍保留会话占位，后续请求预先换号，满池时不再发送上游", async (t) => {
  const env = await setup(t, 2, {
    CODEARTS_SESSION_LIMIT: "1",
    CODEARTS_SESSION_TTL_MS: "60000",
    CODEARTS_QUEUE_LIMIT: "0",
  })
  for (let index = 0; index < 2; index++) {
    const response = await env.send("same-session")
    assert.equal(response.status, 200, JSON.stringify(await response.json()))
  }
  assert.notEqual(env.calls[0].account, env.calls[1].account)
  assert.equal(env.app.host.codeartsScheduling.stats().retainedSessions, 2)
  assert.equal(env.app.host.codeartsScheduling.stats().inFlight, 0)
  const full = await env.send("third")
  assert.equal(full.status, 429)
  await full.json()
  assert.equal(env.calls.length, 2)
})

for (const kind of ["HTTP", "SSE"]) {
  test(`${kind} 并发上限避让整号，不写模型限流且其他模型也不再撞号`, async (t) => {
    const env = await setup(t)
    env.setAnswer(async () => {
      if (env.calls.length > 1) return completion()
      return kind === "HTTP"
        ? Response.json({ error_code: "TM.00001041" }, { status: 400 })
        : new Response('data: {"error_code":"TM.00001041","error_msg":"busy"}\n\n', {
            headers: { "content-type": "text/event-stream" },
          })
    })
    const response = await env.send("limited")
    assert.equal(response.status, 200, JSON.stringify(await response.json()))
    const other = await env.send("other", { model: "codearts/glm-5.3-flash" })
    assert.equal(other.status, 200, JSON.stringify(await other.json()))
    assert.equal(env.calls[1].account, env.calls[2].account)
    assert.notEqual(env.calls[0].account, env.calls[2].account)
    assert.equal(env.app.host.codeartsScheduling.stats().accountBackoffs, 1)
    const pool = env.app.host.ctx.get("accountPool")
    assert.ok(
      pool
        .getStateSnapshot()
        .accounts.filter((a: any) => a.provider === "codearts")
        .every((a: any) => !a.modelRateLimits?.[MODEL]),
    )
  })
}

test("流式输出期间继续占用名额；排队取消与生成取消都回收名额", async (t) => {
  const env = await setup(t, 1, {
    CODEARTS_MAX_IN_FLIGHT: "1",
    CODEARTS_SESSION_LIMIT: "1",
    CODEARTS_SESSION_TTL_MS: "60000",
    CODEARTS_QUEUE_LIMIT: "1",
    CODEARTS_QUEUE_TIMEOUT_MS: "1000",
  })
  let upstreamAborted = false
  env.setAnswer(
    async (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(delta("HELLO")))
            init.signal.addEventListener(
              "abort",
              () => {
                upstreamAborted = true
                controller.error(new Error("aborted"))
              },
              { once: true },
            )
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  )
  const abort = new AbortController()
  const first = await env.send("first", { stream: true, signal: abort.signal })
  const reader = first.body!.getReader()
  let received = ""
  while (!received.includes("HELLO")) received += new TextDecoder().decode((await reader.read()).value)
  assert.equal(env.app.host.codeartsScheduling.stats().inFlight, 1)
  const cancelQueue = new AbortController()
  const queued = env.send("second", { signal: cancelQueue.signal })
  const canceled = assert.rejects(queued, /abort/i)
  await vi.waitFor(() => assert.equal(env.app.host.codeartsScheduling.stats().queued, 1))
  const overflow = await env.send("overflow")
  assert.equal(overflow.status, 429)
  assert.equal((await overflow.json()).error.code, "RATE_LIMIT")
  cancelQueue.abort()
  await canceled
  await vi.waitFor(() => assert.equal(env.app.host.codeartsScheduling.stats().queued, 0))
  abort.abort()
  await reader.cancel().catch(() => {})
  await vi.waitFor(() => assert.equal(env.app.host.codeartsScheduling.stats().inFlight, 0))
  assert.equal(upstreamAborted, true)
  assert.equal(env.calls.length, 1)
  assert.equal(env.app.host.codeartsScheduling.stats().retainedSessions, 1)
})

for (const cancel of [false, true]) {
  test(`慢客户端暂停拉取模型流，${cancel ? "取消回收名额" : "drain 后继续输出"}`, async (t) => {
    const env = await setup(t, 1)
    let outgoing: any
    let blocked = false
    const listener = ({ server, response }: any) => {
      if (server.address()?.port !== Number(new URL(env.direct).port)) return
      outgoing = response
      Object.defineProperty(response, "writableNeedDrain", { get: () => blocked })
      const write = response.write
      response.write = function (...args: any[]) {
        if (String(args[0]).includes("HELLO")) blocked = true
        return write.apply(this, args)
      }
    }
    subscribe("http.server.request.start", listener)
    t.onTestFinished(() => unsubscribe("http.server.request.start", listener))
    env.setAnswer(
      async () =>
        new Response(delta("HELLO") + delta("LATER") + end, {
          headers: { "content-type": "text/event-stream" },
        }),
    )
    const abort = new AbortController()
    const response = await env.send("backpressure", { stream: true, signal: abort.signal })
    const reader = response.body!.getReader()
    let body = ""
    while (!body.includes("HELLO")) body += new TextDecoder().decode((await reader.read()).value)
    await vi.waitFor(() => assert.ok(outgoing.listenerCount("drain") > 0))
    assert.equal(env.app.host.codeartsScheduling.stats().inFlight, 1)
    assert.doesNotMatch(body, /LATER/)
    if (cancel) {
      abort.abort()
      await reader.cancel().catch(() => {})
    } else {
      blocked = false
      outgoing.emit("drain")
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        body += new TextDecoder().decode(next.value)
      }
      assert.match(body, /LATER/)
    }
    await vi.waitFor(() => assert.equal(env.app.host.codeartsScheduling.stats().inFlight, 0))
    assert.equal(outgoing.listenerCount("drain"), 0)
    assert.equal(env.calls.length, 1)
  })
}

test("内部模型额度换号经过同一租约，后续会话粘住最终成功账号", async (t) => {
  const env = await setup(t)
  env.setAnswer(async () =>
    env.calls.length === 1
      ? new Response('data: {"text":"[DONE]","error_code":"InferHub.4291.200","error_msg":"quota exhausted"}\n\n', {
          headers: { "content-type": "text/event-stream" },
        })
      : completion(),
  )
  const response = await env.send("same")
  assert.equal(response.status, 200, JSON.stringify(await response.json()))
  assert.equal(env.calls.length, 2)
  assert.notEqual(env.calls[0].account, env.calls[1].account)
  const later = await env.send("same")
  assert.equal(later.status, 200, JSON.stringify(await later.json()))
  assert.equal(env.calls[1].account, env.calls[2].account)
  assert.equal(env.calls[1].chat, env.calls[2].chat)
  assert.equal(env.calls[1].cacheKey, env.calls[2].cacheKey)
  assert.notEqual(env.calls[0].cacheKey, env.calls[1].cacheKey)
  const listed = await rpc(env.app.origin, "account.list", { provider: "codearts" })
  assert.ok(listed.value.accounts.some((account: any) => account.modelRateLimits?.[MODEL] > Date.now()))
  assert.equal(env.app.host.codeartsScheduling.stats().inFlight, 0)
})

test("模型限流轮换可遍历全部账号；普通传输失败仍最多尝试 3 个", async (t) => {
  const env = await setup(t, 5)
  env.setAnswer(async () =>
    env.calls.length < 5
      ? new Response('data: {"error_code":"InferHub.ModelArts.81111.429","error_msg":"busy"}\n\n', {
          headers: { "content-type": "text/event-stream" },
        })
      : completion(),
  )
  const response = await env.send("many")
  assert.equal(response.status, 200, JSON.stringify(await response.json()))
  assert.equal(env.calls.length, 5)
  assert.equal(new Set(env.calls.map((call) => call.account)).size, 5)
  assert.equal(env.app.host.codeartsScheduling.stats().inFlight, 0)
})

test("传输故障不会在大账号池无限轮转", async (t) => {
  const env = await setup(t, 5)
  env.setAnswer(async () => {
    throw new TypeError("fetch failed")
  })
  const response = await env.send("transport")
  assert.notEqual(response.status, 200)
  await response.json()
  assert.equal(env.calls.length, 3)
  assert.equal(env.app.host.codeartsScheduling.stats().inFlight, 0)
})

for (const kind of ["SSE", "HTTP"]) {
  test(`${kind} 上游排队立即换号，不持有租约等待 10 秒重试`, async (t) => {
    const env = await setup(t)
    env.setAnswer(async (url) => {
      if (url.includes("/queue/status")) {
        assert.equal(new URL(url).searchParams.get("task_id"), env.calls[0].session)
        return Response.json({ status: "waiting", queue_position: 2 })
      }
      if (env.calls.length !== 1) return completion()
      return kind === "SSE"
        ? new Response('data: {"error_code":"InferHub.ModelArts.81111.429","error_msg":"busy"}\n\n', {
            headers: { "content-type": "text/event-stream" },
          })
        : Response.json({ error_code: "TM.00001041" }, { status: 400 })
    })
    const response = await env.send("queued", { signal: AbortSignal.timeout(1500) })
    assert.equal(response.status, 200, JSON.stringify(await response.json()))
    assert.equal(env.calls.length, 2)
    assert.notEqual(env.calls[0].account, env.calls[1].account)
    const pool = env.app.host.ctx.get("accountPool")
    assert.equal(pool.candidateAccounts("codearts", MODEL, new Set()).length, kind === "SSE" ? 1 : 2)
    assert.equal(pool.candidateAccounts("codearts", "other-model", new Set()).length, 2)
    assert.equal(env.app.host.codeartsScheduling.stats().inFlight, 0)
    const later = await env.send("queued")
    assert.equal(later.status, 200, JSON.stringify(await later.json()))
    assert.equal(env.calls[1].account, env.calls[2].account)
  })
}

test("全部账号上游排队时快速返回 429，不在同号反复等待", async (t) => {
  const env = await setup(t)
  env.setAnswer(
    async () =>
      new Response('data: {"error_code":"InferHub.ModelArts.81111.429","error_msg":"busy"}\n\n', {
        headers: { "content-type": "text/event-stream" },
      }),
  )
  const response = await env.send("all-busy", { signal: AbortSignal.timeout(1500) })
  assert.equal(response.status, 429)
  assert.equal((await response.json()).error.code, "QUEUE")
  assert.equal(env.calls.length, 2)
  assert.equal(env.app.host.codeartsScheduling.stats().inFlight, 0)
  const later = await env.send("cooldown")
  assert.equal(later.status, 429)
  assert.equal((await later.json()).error.code, "QUEUE")
  assert.equal(env.calls.length, 2, "冷却期间不能重新打到上游，也不能误报凭据缺失")
})

test("真实 400 TM.00001041 即使队列报告 working 也立即换号", async (t) => {
  const env = await setup(t)
  let probes = 0
  env.setAnswer(async (url) => {
    if (url.includes("/queue/status")) {
      probes++
      return Response.json({ status: "working", queue_position: 0 })
    }
    return env.calls.length === 1
      ? Response.json(
          { error_code: "TM.00001041", error_msg: "并发会话数已达上限(3个)，请关闭部分会话后重试。" },
          { status: 400 },
        )
      : completion()
  })
  const response = await env.send("real-limit", { signal: AbortSignal.timeout(1500) })
  assert.equal(response.status, 200, JSON.stringify(await response.json()))
  assert.equal(env.calls.length, 2)
  assert.notEqual(env.calls[0].account, env.calls[1].account)
  assert.equal(probes, 0)
  assert.equal(env.app.host.codeartsScheduling.stats().inFlight, 0)
})

test("普通 400 参数错误保留上游处理，不换号、不惩罚账号", async (t) => {
  const env = await setup(t, 2, { CODEARTS_SESSION_LIMIT: "1", CODEARTS_SESSION_TTL_MS: "60000" })
  env.setAnswer(async (url) =>
    url.includes("/queue/status")
      ? Response.json({ status: "working", queue_position: 0 })
      : Response.json({ error_code: "INVALID_REQUEST", error_msg: "invalid parameter" }, { status: 400 }),
  )
  const response = await env.send("invalid")
  assert.notEqual(response.status, 200)
  assert.equal((await response.json()).error.code, "INVALID_REQUEST")
  assert.equal(env.calls.length, 1)
  assert.equal(env.app.host.ctx.get("accountPool").candidateAccounts("codearts", MODEL, new Set()).length, 2)
  assert.equal(env.app.host.codeartsScheduling.stats().retainedSessions, 0)
  env.setAnswer(async () => completion())
  const next = await env.send("after-invalid")
  assert.equal(next.status, 200, JSON.stringify(await next.json()))
  assert.equal(env.app.host.codeartsScheduling.stats().retainedSessions, 1)
})

for (const code of ["InferHub.ModelArts.81111.429", "InferHub.4291.200"]) {
  test(`输出后遇到 ${code} 也不允许适配器内部重放`, async (t) => {
    const env = await setup(t)
    env.setAnswer(
      async () =>
        new Response(delta("PARTIAL") + `data: ${JSON.stringify({ error_code: code, error_msg: "limited" })}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        }),
    )
    const response = await env.send("partial", { stream: true, signal: AbortSignal.timeout(1500) })
    const body = await response.text()
    assert.match(body, /PARTIAL/)
    assert.match(body, /error/)
    assert.equal(env.calls.length, 1)
    assert.equal(env.app.host.codeartsScheduling.stats().inFlight, 0)
  })
}

test("诊断区分首个推理块与最终正文补出，不记录提示词或凭据", async (t) => {
  const env = await setup(t)
  const log = vi.spyOn(env.app.host.ctx.logger, "debug")
  t.onTestFinished(() => log.mockRestore())
  env.setAnswer(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "thinking-only" } }] })}\n\n`,
              ),
            )
            setTimeout(() => {
              controller.enqueue(encoder.encode(end))
              controller.close()
            }, 80)
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  )
  const response = await env.send(
    "timing",
    { stream: true, input: "private-prompt", messages: undefined },
    env.app.origin,
    "/v1/responses",
  )
  const body = await response.text()
  assert.match(body, /response.reasoning_summary_text.delta/)
  assert.match(body, /response.output_text.done/)
  const message = log.mock.calls
    .map((args) => String(args[0]))
    .find((value) => value.startsWith("[codearts-scheduling] "))!
  assert.ok(message)
  const timing = JSON.parse(message.slice("[codearts-scheduling] ".length))
  assert.ok(timing.firstTextMs - timing.firstChunkMs >= 50)
  assert.ok(timing.totalMs >= timing.firstTextMs)
  assert.equal(timing.attempts, 1)
  assert.equal(timing.result, "success")
  assert.doesNotMatch(message, /private-prompt|thinking-only|TEST_AK|TEST_SK/)
  assert.ok(timing.accounts.every((id: string) => /^[a-f0-9]{12}$/.test(id)))
})

test("真实 SSE 粘性：绑定号忙时等待，其他会话仍能使用空闲账号", async (t) => {
  const env = await setup(t, 2, { CODEARTS_MAX_IN_FLIGHT: "1" })
  let finish: () => void = () => {}
  env.setAnswer(async () =>
    env.calls.length === 1
      ? new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(delta("HELLO")))
              finish = () => {
                controller.enqueue(encoder.encode(end))
                controller.close()
              }
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      : completion(),
  )
  const first = await env.send("sticky", { stream: true })
  const reader = first.body!.getReader()
  let content = ""
  while (!content.includes("HELLO")) content += new TextDecoder().decode((await reader.read()).value)
  const waiting = env.send("sticky")
  await vi.waitFor(() => assert.equal(env.app.host.codeartsScheduling.stats().queued, 1))
  const other = await env.send("other")
  assert.equal(other.status, 200, JSON.stringify(await other.json()))
  assert.equal(env.calls.length, 2)
  assert.notEqual(env.calls[0].account, env.calls[1].account)
  finish()
  const resumed = await waiting
  assert.equal(resumed.status, 200, JSON.stringify(await resumed.json()))
  while (!(await reader.read()).done) {
    /* 排空剩余 SSE。 */
  }
  assert.equal(env.calls[0].account, env.calls[2].account)
  assert.equal(env.calls[0].chat, env.calls[2].chat)
  assert.notEqual(env.calls[0].session, env.calls[2].session)
  assert.equal(env.app.host.codeartsScheduling.stats().inFlight, 0)
})

test("按需续期刷新当前粘性账号，不会刷新列表首号", async (t) => {
  const env = await setup(t)
  for (const session of ["first", "second"]) {
    const response = await env.send(session)
    assert.equal(response.status, 200, JSON.stringify(await response.json()))
  }
  const account = env.batch.payload.accounts[1]
  const credentials = env.app.host.ctx.get("credentials")
  const stored = JSON.parse(env.batch.payload.credentials[account.credentialRef])
  stored.expires_at = "2020-01-01T00:00:00Z"
  await credentials.set(credentialRef(account.credentialRef), JSON.stringify(stored))
  const refresh = vi
    .spyOn(env.app.host.ctx.get("codeartsAuth"), "refreshAccountCredential")
    .mockImplementation(async (ref: any) => {
      assert.equal(ref, account.credentialRef)
      await credentials.set(
        credentialRef(ref),
        JSON.stringify({
          ...stored,
          access_key_id: "TEST_AK_REFRESHED",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      )
    })
  t.onTestFinished(() => refresh.mockRestore())
  const response = await env.send("second")
  assert.equal(response.status, 200, JSON.stringify(await response.json()))
  assert.equal(refresh.mock.calls.length, 1)
  assert.equal(env.calls[2].account, "TEST_AK_REFRESHED")
  assert.equal(env.calls[2].chat, env.calls[1].chat)
  assert.equal(env.app.host.codeartsScheduling.stats().inFlight, 0)
})

test("输出前传输失败可以换号；输出后失败不拼接另一个账号的回答", async (t) => {
  const env = await setup(t)
  env.setAnswer(async () => {
    if (env.calls.length === 1) throw new TypeError("fetch failed")
    return completion()
  })
  const recovered = await env.send("retry")
  assert.equal(recovered.status, 200, JSON.stringify(await recovered.json()))
  assert.equal(env.calls.length, 2)
  assert.notEqual(env.calls[0].account, env.calls[1].account)

  env.setAnswer(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(delta("PARTIAL")))
            setTimeout(() => controller.error(new Error("socket failed")), 10)
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  )
  const failed = await env.send("partial", { stream: true })
  const body = await failed.text()
  assert.match(body, /PARTIAL/)
  assert.match(body, /error/)
  assert.equal(env.calls.length, 3, "正文已经发出后不能换号重发")
  assert.equal(env.app.host.codeartsScheduling.stats().inFlight, 0)
})

test("调用方 Key 隔离同名会话；伪造调用方头不能改变已有绑定", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "c2a-scheduling-callers-"))
  const keys = ["test-caller-one", "test-caller-two"]
  writeFileSync(
    join(home, "caller-keys.json"),
    JSON.stringify({
      version: 1,
      groups: [{ name: "all", allow: ["*"] }],
      keys: keys.map((key, index) => ({
        id: `caller-${index}`,
        group: "all",
        sha256: createHash("sha256").update(key).digest("hex"),
      })),
    }),
  )
  const callerGate = createCallerGate({ home, upstreamKey: createUpstreamKeyReader({ home }) })
  const env = await setup(t, 2, {}, { home, callerGate })
  for (const key of [keys[0], keys[1], keys[0]]) {
    const response = await env.send("same-id", {
      headers: { authorization: `Bearer ${key}`, "x-caller-id": "spoofed" },
    })
    assert.equal(response.status, 200, JSON.stringify(await response.json()))
  }
  assert.notEqual(env.calls[0].account, env.calls[1].account)
  assert.notEqual(env.calls[0].chat, env.calls[1].chat)
  assert.equal(env.calls[0].account, env.calls[2].account)
  assert.equal(env.calls[0].chat, env.calls[2].chat)
})

test("聚合派发到 CodeArts 时也经过调度，同会话绑定与直连共享", async (t) => {
  const env = await setup(t)
  const llm = env.app.host.ctx.get("llm")
  const aggregate = llm.adapters.get("aggregate").adapter
  // 只替换目录与余额探测，真实聚合 prepareCall/dispatch 和真实 CodeArts 适配器仍运行。
  aggregate.providerIds = () => ["codearts"]
  aggregate.options.expiryProbe = async () => Number.POSITIVE_INFINITY
  const catalog = await aggregate.refreshCatalog(true)
  assert.ok(catalog.length > 0)
  for (const model of catalog) {
    await env.app.host.ctx.get("accountPool").setAggregateAllowed(model.key, "codearts", MODEL, true)
  }
  const response = await env.send("aggregate-session", { model: "aggregate/auto" })
  assert.equal(response.status, 200, JSON.stringify(await response.json()))
  const direct = await env.send("aggregate-session")
  assert.equal(direct.status, 200, JSON.stringify(await direct.json()))
  assert.equal(env.calls.length, 2)
  assert.equal(env.calls[0].account, env.calls[1].account)
  assert.equal(env.calls[0].chat, env.calls[1].chat)
  assert.equal(env.app.host.codeartsScheduling.stats().inFlight, 0)
})
