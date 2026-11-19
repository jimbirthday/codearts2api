import assert from "node:assert/strict"
import { credentialRef } from "@deepseek-ai/dsh-credentials"
import { test, vi } from "vite-plus/test"
import { resolveLoomyScheduling } from "../src/config/env.ts"
import { loadLoomyScheduling } from "../src/core/upstream.ts"
import { createLoomyModels } from "../src/host/loomy-models.ts"
import { prepareLoomyImport } from "../web/utils/loomy-import"
import { loomyFile, loomyLine } from "./fixtures/loomy-import"
import { rpc, startTestApp } from "./helpers"

const MODEL = "DeepSeek-V4.1-Flash"
const encoder = new TextEncoder()
const delta = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`
const end = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 3 } } })}\n\ndata: [DONE]\n\n`
const completion = () => new Response(delta("OK") + end, { headers: { "content-type": "text/event-stream" } })

async function setup(t: any, count = 2, config: Record<string, string> = {}, catalogs?: string[][]) {
  for (const [name, value] of Object.entries({ DSH_JET_HUB_AUTO_CHECKIN_DELAY_MS: "3600000", ...config }))
    vi.stubEnv(name, value)
  const app = await startTestApp()
  t.onTestFinished(async () => {
    await app.close()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })
  const batch = await prepareLoomyImport([
    loomyFile(Array.from({ length: count }, (_, i) => loomyLine(i + 1)).join("\n")),
  ])
  const adapter = app.host.ctx.get("llm").adapters.get("loomy").adapter
  const pool = app.host.ctx.get("accountPool")
  const availableModels = new Map(
    batch.payload.accounts.map((_account, i) => [loomyLine(i + 1).split("----")[1], catalogs?.[i] ?? [MODEL]]),
  )
  const catalogCalls: string[] = []
  const native = await loadLoomyScheduling()
  const balances = new Map(batch.payload.accounts.map((account) => [account.id, { daily: 100, permanent: 1000 }]))
  vi.spyOn(native.balanceCache(), "readStale").mockImplementation(async (_provider: string, id: string) => {
    const balance = balances.get(id)
    return {
      at: Date.now(),
      value: balance
        ? {
            packages: [
              { name: "每日赠送", remaining: balance.daily },
              { name: "永久积分", remaining: balance.permanent },
            ],
          }
        : undefined,
    }
  })
  const calls: Array<{ account: string; cacheKey: string; model: string; effort?: string }> = []
  let answer = async (_url: string, _init: any): Promise<Response> => completion()
  adapter.fetchImpl = (url: string, init: any) => {
    const token = new Headers(init.headers).get("token")!
    assert.ok(token)
    if (url.endsWith("/models")) {
      catalogCalls.push(token)
      return Promise.resolve(
        new Response(
          JSON.stringify({
            object: "list",
            data: (availableModels.get(token) ?? []).map((id) => ({
              id,
              name: id,
              type: "chat",
              context_length: 131072,
              reasoning_efforts: ["none", "low", "high"],
            })),
          }),
          { headers: { "content-type": "application/json" } },
        ),
      )
    }
    assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${token}`)
    calls.push({
      account: token,
      cacheKey: JSON.parse(init.body).prompt_cache_key,
      model: JSON.parse(init.body).model,
      effort: JSON.parse(init.body).reasoning_effort,
    })
    return answer(url, init)
  }
  assert.equal((await rpc(app.origin, "backup.import", { payload: batch.payload, mode: "merge" })).ok, true)
  const status = (await rpc(app.origin, "gateway.getEnabled")).value
  const send = (session: string, extra: any = {}, origin = app.origin, path = "/v1/chat/completions") => {
    const { signal, ...payload } = extra
    return fetch(origin + path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${status.apiKey.value}` },
      body: JSON.stringify({
        model: `loomy/${MODEL}`,
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
    pool,
    calls,
    send,
    batch,
    balances,
    availableModels,
    catalogCalls,
    direct: `http://${status.address.host}:${status.address.port}`,
    setAnswer(fn: typeof answer) {
      answer = fn
    },
  }
}

test("Loomy 配置独立、默认 2 在途，不保留华为会话窗口，非法值报 Loomy 变量名", () => {
  assert.equal(resolveLoomyScheduling({}).maxInFlight, 2)
  assert.equal(resolveLoomyScheduling({}).sessionTtlMs, 0)
  assert.equal(resolveLoomyScheduling({ CODEARTS_MAX_IN_FLIGHT: "9", LOOMY_MAX_IN_FLIGHT: "3" }).maxInFlight, 3)
  assert.throws(() => resolveLoomyScheduling({ LOOMY_MAX_IN_FLIGHT: "0" }), /LOOMY_MAX_IN_FLIGHT/)
})

test("Loomy Chat/Responses/直连：同会话固定账号与缓存键，不同会话分散", async (t) => {
  const env = await setup(t)
  for (const session of ["one", "two", "one"]) {
    const response = await env.send(session)
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal(body.usage.prompt_tokens_details.cached_tokens, 3)
  }
  const response = await env.send("one", { input: "hello", messages: undefined }, env.direct, "/v1/responses")
  assert.equal(response.status, 200, JSON.stringify(await response.json()))
  assert.deepEqual(env.calls[0], env.calls[2])
  assert.deepEqual(env.calls[0], env.calls[3])
  assert.notEqual(env.calls[0].account, env.calls[1].account)
  assert.notEqual(env.calls[0].cacheKey, env.calls[1].cacheKey)
  assert.equal(env.app.host.loomyScheduling.stats().inFlight, 0)
  assert.equal(env.app.host.loomyScheduling.stats().retainedSessions, 0)
  const ledger = (await rpc(env.app.origin, "usage.tokenLedger")).value.snapshot.entries
  assert.equal(ledger.length, 4)
  assert.ok(ledger.every((entry: any) => env.batch.payload.accounts.some((account) => account.id === entry.accountId)))
})

test("Loomy 默认并发：16 请求、2 账号每号峰值为 2，流结束后回收且不被队首阻塞", async (t) => {
  const env = await setup(t)
  const active = new Map<string, number>(),
    peak = new Map<string, number>()
  env.setAnswer(async (_url, init) => {
    const token = new Headers(init.headers).get("token")!
    active.set(token, (active.get(token) ?? 0) + 1)
    peak.set(token, Math.max(peak.get(token) ?? 0, active.get(token)!))
    return new Response(
      new ReadableStream({
        start(controller) {
          setTimeout(() => {
            active.set(token, active.get(token)! - 1)
            controller.enqueue(encoder.encode(delta("OK") + end))
            controller.close()
          }, 15)
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
  })
  await Promise.all(
    Array.from({ length: 16 }, async (_, i) => {
      const response = await env.send(`session-${i}`)
      assert.equal(response.status, 200, JSON.stringify(await response.json()))
    }),
  )
  assert.deepEqual([...peak.values()], [2, 2])
  assert.equal(env.app.host.loomyScheduling.stats().queued, 0)
  assert.equal(env.app.host.loomyScheduling.stats().inFlight, 0)
})

test("管理界面保存 Loomy 在途上限后，实际 HTTP 排队立即放行，正在输出的流继续完成", async (t) => {
  const env = await setup(t, 1, { LOOMY_MAX_IN_FLIGHT: "1" })
  let finish!: () => void
  env.setAnswer(async () => {
    if (env.calls.length > 1) return completion()
    return new Response(
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
  })
  const first = await env.send("first", { stream: true })
  const reader = first.body!.getReader()
  await reader.read()
  const waiting = env.send("second")
  await vi.waitFor(() => assert.equal(env.app.host.loomyScheduling.stats().queued, 1))
  const updated = await fetch(`${env.app.origin}/admin/scheduling/api/loomy`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.app.adminKey}` },
    body: JSON.stringify({ maxInFlight: 2 }),
  })
  assert.equal(updated.status, 200)
  const second = await waiting
  assert.equal(second.status, 200, JSON.stringify(await second.json()))
  assert.equal(env.calls.length, 2)
  assert.equal(env.app.host.loomyScheduling.stats().inFlight, 1)
  finish()
  while (!(await reader.read()).done) {
    /* 排空 SSE。 */
  }
  await vi.waitFor(() => assert.equal(env.app.host.loomyScheduling.stats().inFlight, 0))
})

test("Loomy 模型限流使用热更新后的冷却区间，积分耗尽规则不被替换", async (t) => {
  const env = await setup(t)
  await env.app.host.schedulingSettings.update("loomy", { cooldownMinSeconds: 2, cooldownMaxSeconds: 2 })
  env.setAnswer(async () => (env.calls.length === 1 ? new Response("rate limit", { status: 429 }) : completion()))
  const response = await env.send("configured-cooldown")
  assert.equal(response.status, 200, JSON.stringify(await response.json()))
  const resetAt = env.pool.findAccount(env.batch.payload.accounts[0].id).modelRateLimits[MODEL]
  assert.ok(resetAt > Date.now() + 1000 && resetAt <= Date.now() + 2000)
  env.setAnswer(async () => new Response("credits exhausted", { status: 402 }))
  const exhausted = await env.send("configured-quota")
  await exhausted.json()
  const quotaReset = env.pool.findAccount(env.batch.payload.accounts[1].id).modelRateLimits[MODEL]
  const local = new Date(quotaReset + 8 * 3600000)
  assert.equal(local.getUTCHours(), 0)
  assert.equal(local.getUTCMinutes(), 0)
})

for (const kind of ["rate", "quota", "auth", "sse-quota"]) {
  test(`Loomy ${kind} 输出前自动换号，缓存键随实际账号重建并持久化正确冷却`, async (t) => {
    const env = await setup(t, 4)
    env.setAnswer(async () => {
      if (env.calls.length > 1) return completion()
      if (kind === "auth")
        return new Response(JSON.stringify({ code: "100002", desc: "token expired" }), {
          headers: { "content-type": "application/json" },
        })
      if (kind === "sse-quota")
        return new Response('data: {"error":{"message":"credits exhausted"}}\n\n', {
          headers: { "content-type": "text/event-stream" },
        })
      return new Response(kind === "quota" ? "quota exhausted" : "rate limit exceeded", {
        status: kind === "quota" ? 402 : 429,
      })
    })
    const response = await env.send("failover")
    assert.equal(response.status, 200, JSON.stringify(await response.json()))
    assert.equal(env.calls.length, 2)
    assert.notEqual(env.calls[0].account, env.calls[1].account)
    assert.notEqual(env.calls[0].cacheKey, env.calls[1].cacheKey)
    const resetAt = env.pool.findAccount(env.batch.payload.accounts[0].id).modelRateLimits?.[MODEL]
    if (kind === "auth") {
      assert.equal(resetAt, undefined)
      assert.equal(env.app.host.loomyScheduling.stats().accountBackoffs, 1)
    } else if (kind.includes("quota")) {
      const day = new Date(resetAt + 8 * 3_600_000)
      assert.equal(day.getUTCHours(), 0)
      assert.equal(day.getUTCMinutes(), 0)
    } else assert.ok(resetAt >= Date.now() + 59_000 && resetAt <= Date.now() + 180_000)
    const repeated = await env.send("failover")
    assert.equal(repeated.status, 200, JSON.stringify(await repeated.json()))
    assert.deepEqual(env.calls[1], env.calls[2])
  })
}

test("Loomy 模型限流可尝试全池，全部冷却不再打上游也不假报未登录", async (t) => {
  const env = await setup(t, 5)
  env.setAnswer(async () => (env.calls.length < 5 ? new Response("rate limit", { status: 429 }) : completion()))
  let response = await env.send("all-accounts")
  assert.equal(response.status, 200, JSON.stringify(await response.json()))
  assert.equal(new Set(env.calls.map((call) => call.account)).size, 5)
  env.setAnswer(async () => new Response("rate limit", { status: 429 }))
  response = await env.send("now-full")
  assert.equal(response.status, 429, JSON.stringify(await response.json()))
  assert.equal(env.calls.length, 6)
  response = await env.send("no-send")
  assert.equal(response.status, 429, JSON.stringify(await response.json()))
  assert.equal(env.calls.length, 6)
})

test("Loomy 永久积分锁定、余额未知失败关闭；严格手动顺序优先于余额档位", async (t) => {
  const env = await setup(t)
  const [first, second] = env.batch.payload.accounts
  env.balances.set(first.id, { daily: 0, permanent: 1000 })
  let response = await env.send("daily-first")
  assert.equal(response.status, 200, JSON.stringify(await response.json()))
  assert.equal(env.calls[0].account, loomyLine(2).split("----")[1])
  vi.spyOn(env.pool, "strictManualOrder").mockReturnValue(true)
  response = await env.send("manual-first")
  assert.equal(response.status, 200, JSON.stringify(await response.json()))
  assert.equal(env.calls[1].account, loomyLine(1).split("----")[1])
  vi.spyOn(env.pool, "permanentLocked").mockReturnValue(true)
  env.balances.set(second.id, { daily: 0, permanent: 1000 })
  response = await env.send("locked")
  assert.notEqual(response.status, 200, JSON.stringify(await response.json()))
  assert.equal(env.calls.length, 2)
  env.balances.clear()
  response = await env.send("unknown")
  assert.notEqual(response.status, 200, JSON.stringify(await response.json()))
  assert.equal(env.calls.length, 2)
})

test("Loomy 输出后断流不重放，客户端取消会中止上游并释放名额", async (t) => {
  const env = await setup(t)
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
  let response = await env.send("partial", { stream: true })
  assert.match(await response.text(), /PARTIAL/)
  assert.equal(env.calls.length, 1)
  let upstreamSignal: AbortSignal | undefined
  env.setAnswer(async (_url, init) => {
    upstreamSignal = init.signal
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(delta("HELLO")))
          init.signal.addEventListener("abort", () => controller.error(init.signal.reason), { once: true })
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
  })
  const controller = new AbortController()
  response = await env.send("cancel", { stream: true, signal: controller.signal })
  const reader = response.body!.getReader()
  await reader.read()
  controller.abort()
  await vi.waitFor(() => assert.equal(upstreamSignal?.aborted, true))
  await vi.waitFor(() => assert.equal(env.app.host.loomyScheduling.stats().inFlight, 0))
})

test("Loomy 满载时会话等待与队列取消不占用额外上游名额", async (t) => {
  const env = await setup(t, 2, { LOOMY_MAX_IN_FLIGHT: "1" })
  let finish!: () => void
  env.setAnswer(async () => {
    if (env.calls.length > 1) return completion()
    return new Response(
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
  })
  const first = await env.send("sticky", { stream: true })
  const reader = first.body!.getReader()
  await reader.read()
  const abort = new AbortController()
  const waiting = env.send("sticky", { signal: abort.signal })
  const rejected = assert.rejects(waiting, (error: any) => error.name === "AbortError")
  await vi.waitFor(() => assert.equal(env.app.host.loomyScheduling.stats().queued, 1))
  const other = await env.send("other")
  assert.equal(other.status, 200, JSON.stringify(await other.json()))
  assert.notEqual(env.calls[0].account, env.calls[1].account)
  abort.abort()
  await rejected
  await vi.waitFor(() => assert.equal(env.app.host.loomyScheduling.stats().queued, 0))
  assert.equal(env.calls.length, 2)
  finish()
  while (!(await reader.read()).done) {
    /* 排空 SSE。 */
  }
  await vi.waitFor(() => assert.equal(env.app.host.loomyScheduling.stats().inFlight, 0))
})

test("Loomy 冷余额查询可取消，不会等余额端点返回后才释放请求", async (t) => {
  const env = await setup(t)
  const native = await loadLoomyScheduling()
  let reads = 0
  ;(native.balanceCache().readStale as any).mockImplementation(() => {
    reads++
    return new Promise(() => {})
  })
  const abort = new AbortController()
  const waiting = env.send("cold", { signal: abort.signal })
  const rejected = assert.rejects(waiting, (error: any) => error.name === "AbortError")
  await vi.waitFor(() => assert.ok(reads > 0))
  abort.abort()
  await rejected
  assert.equal(env.calls.length, 0)
  assert.equal(env.app.host.loomyScheduling.stats().inFlight, 0)
})

test("Loomy 冷却批量解除仅作用于指定渠道与模型，受管理鉴权保护", async (t) => {
  const env = await setup(t)
  const ids = env.batch.payload.accounts.map((account) => account.id)
  for (const id of ids) await env.pool.updateModelRateLimit(id, MODEL, Date.now() + 600_000)
  await env.pool.updateModelRateLimit(ids[0], "other", Date.now() + 600_000)
  const clear = (body: any, authorized = true) =>
    fetch(`${env.app.origin}/admin/models/api/loomy/cooldowns/clear`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorized ? { authorization: `Bearer ${env.app.adminKey}` } : {}),
      },
      body: JSON.stringify(body),
    })
  assert.equal((await clear({ all: true }, false)).status, 401)
  assert.equal((await clear({})).status, 400)
  assert.equal((await clear({ all: true, accountIds: ["unknown"] })).status, 400)
  const response = await clear({ modelIds: [MODEL] })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { cleared: 2, affectedAccounts: 2, failed: [] })
  assert.ok(env.pool.findAccount(ids[0]).modelRateLimits.other)
  assert.equal((await (await clear({ all: true })).json()).cleared, 1)
})

test("聚合到 Loomy 也经过同一调度，会话绑定与直连共享", async (t) => {
  const env = await setup(t)
  const aggregate = env.app.host.ctx.get("llm").adapters.get("aggregate").adapter
  aggregate.providerIds = () => ["loomy"]
  aggregate.options.expiryProbe = async () => Number.POSITIVE_INFINITY
  const catalog = await aggregate.refreshCatalog(true)
  assert.ok(catalog.length > 0)
  for (const model of catalog) await env.pool.setAggregateAllowed(model.key, "loomy", MODEL, true)
  const first = await env.send("shared", { model: "aggregate/auto" })
  assert.equal(first.status, 200, JSON.stringify(await first.json()))
  const direct = await env.send("shared")
  assert.equal(direct.status, 200, JSON.stringify(await direct.json()))
  assert.deepEqual(env.calls[0], env.calls[1])
})

test("Loomy 混合权限池聚合模型，大小写别名只派发支持账号并发送准确 ID", async (t) => {
  const env = await setup(t, 3, {}, [["spark-x2.6-low"], [MODEL], [MODEL, "GLM-5.3-Flash"]])
  const models = await (
    await fetch(env.app.origin + "/v1/models", {
      headers: { authorization: `Bearer ${(await rpc(env.app.origin, "gateway.getEnabled")).value.apiKey.value}` },
    })
  ).json()
  const ids = models.data.map((model: any) => model.id)
  assert.ok(ids.includes(`loomy/${MODEL}`))
  assert.ok(ids.includes("loomy/GLM-5.3-Flash"))
  for (const session of ["alias-one", "alias-two", "alias-one"]) {
    const response = await env.send(session, { model: "loomy/deepseek-v4.1-flash", reasoning_effort: "none" })
    assert.equal(response.status, 200, JSON.stringify(await response.json()))
  }
  assert.ok(env.calls.every((call) => call.account !== loomyLine(1).split("----")[1]))
  assert.ok(env.calls.every((call) => call.model === MODEL && call.effort === "none"))
  assert.deepEqual(env.calls[0], env.calls[2])
  assert.notEqual(env.calls[0].account, env.calls[1].account)
})

for (const unknown of [false, true]) {
  test(`Loomy ${unknown ? "目录未知返回 503" : "全部不支持返回 404"}，不发送聊天请求或猜测 Spark`, async (t) => {
    const env = await setup(t, 2, {}, unknown ? [[], []] : [["spark-x2.6-low"], ["spark-x2.6-4b"]])
    const response = await env.send("unsupported", { model: "loomy/deepseek-v4.1-flash" })
    assert.equal(response.status, unknown ? 503 : 404, JSON.stringify(await response.json()))
    assert.equal(env.calls.length, 0)
  })
}

test("Loomy 模型目录热请求复用缓存，手动刷新与凭据替换读取新权限", async (t) => {
  const env = await setup(t)
  const before = env.catalogCalls.length
  await Promise.all(
    Array.from({ length: 6 }, async (_, i) => {
      const response = await env.send(`cached-${i}`)
      assert.equal(response.status, 200, JSON.stringify(await response.json()))
    }),
  )
  assert.equal(env.catalogCalls.length, before)
  await env.adapter.refresh()
  assert.equal(env.catalogCalls.length, before + 2)
  const account = env.batch.payload.accounts[0]
  const stored = JSON.parse(env.batch.payload.credentials[account.credentialRef])
  const replacement = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  env.availableModels.set(replacement, ["spark-x2.6-low"])
  await env.app.host.ctx.get("credentials").set(
    credentialRef(account.credentialRef),
    JSON.stringify({
      ...stored,
      access_token: replacement,
    }),
  )
  const response = await env.send("changed-token")
  assert.equal(response.status, 200, JSON.stringify(await response.json()))
  assert.equal(env.calls.at(-1)!.account, loomyLine(2).split("----")[1])
  assert.equal(env.catalogCalls.length, before + 3)
})

test("Loomy 大小写共用模型冷却，其他 Spark 账号空闲时仍正确返回 429", async (t) => {
  const env = await setup(t, 2, {}, [[MODEL], ["spark-x2.6-low"]])
  env.setAnswer(async () => new Response("rate limit", { status: 429 }))
  let response = await env.send("lower", { model: "loomy/deepseek-v4.1-flash" })
  assert.equal(response.status, 429, JSON.stringify(await response.json()))
  const limits = env.pool.findAccount(env.batch.payload.accounts[0].id).modelRateLimits
  assert.ok(limits[MODEL] > Date.now())
  assert.equal(limits[MODEL.toLowerCase()], undefined)
  response = await env.send("exact")
  assert.equal(response.status, 429, JSON.stringify(await response.json()))
  assert.equal(env.calls.length, 1)
  await env.pool.clearModelRateLimits(env.batch.payload.accounts[0].id, [MODEL])
  await env.pool.updateModelRateLimit(env.batch.payload.accounts[0].id, MODEL.toLowerCase(), Date.now() + 60000)
  response = await env.send("old-alias")
  assert.equal(response.status, 429, JSON.stringify(await response.json()))
  assert.equal(env.calls.length, 1)
})

test("Loomy 代理逐段输出推理和正文，完整响应结束前客户端均已收到", async (t) => {
  const env = await setup(t)
  let pushText!: () => void, finish!: () => void
  env.setAnswer(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"THINK"}}]}\n\n'))
            pushText = () => controller.enqueue(encoder.encode(delta("TEXT")))
            finish = () => {
              controller.enqueue(encoder.encode(end))
              controller.close()
            }
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  )
  const response = await env.send("chunks", { stream: true })
  const reader = response.body!.getReader(),
    decoder = new TextDecoder()
  let received = ""
  while (!received.includes("THINK")) received += decoder.decode((await reader.read()).value)
  assert.equal(env.app.host.loomyScheduling.stats().inFlight, 1)
  pushText()
  while (!received.includes("TEXT")) received += decoder.decode((await reader.read()).value)
  assert.equal(env.app.host.loomyScheduling.stats().inFlight, 1)
  finish()
  while (!(await reader.read()).done) {
    /* 排空 SSE。 */
  }
  await vi.waitFor(() => assert.equal(env.app.host.loomyScheduling.stats().inFlight, 0))
})

test("Loomy 目录并发读取合并网络请求，刷新不清空在途可用映射，删除账号移除旧权限", async () => {
  const native = await loadLoomyScheduling()
  let entries = [{ id: "fixture-account" }],
    release!: (value: Response) => void,
    requests = 0
  const catalog = createLoomyModels({
    native,
    adapter: { product: { apiBase: "https://fixture.invalid" } },
    pool: {
      candidateAccounts: () => entries,
      resolveFirstCredential: async (_provider: string, [entry]: any[]) => ({
        entry,
        credential: { access_token: "fixture-token" },
      }),
    },
    fetcher: () => {
      requests++
      return new Promise<Response>((resolve) => {
        release = resolve
      })
    },
  })
  const response = () => new Response(JSON.stringify({ data: [{ id: MODEL, type: "chat" }] }))
  const reads = [catalog.load(), catalog.load()]
  await vi.waitFor(() => assert.equal(requests, 1))
  release(response())
  await Promise.all(reads)
  assert.equal(catalog.modelFor("fixture-account", MODEL.toLowerCase()).id, MODEL)
  catalog.clear()
  const refreshed = catalog.load()
  await vi.waitFor(() => assert.equal(requests, 2))
  assert.equal(catalog.modelFor("fixture-account", MODEL).id, MODEL)
  release(response())
  await refreshed
  entries = []
  await catalog.load()
  assert.equal(catalog.modelFor("fixture-account", MODEL), undefined)
})
