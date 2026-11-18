/** @vitest-environment jsdom */
import assert from "node:assert/strict"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, test, vi } from "vite-plus/test"

import { ModelsPanel } from "../web/pages/channels/ModelsPanel"

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

function setup(provider = "codearts") {
  document.body.innerHTML = `<div class="dim-jh-providerRow" data-provider="${provider}"><button class="dim-jh-provider" aria-selected="true"><span class="dim-jh-providerLabel"><strong>${provider}</strong></span></button></div>`
  const data = {
    models: [
      { id: "a", name: "模型A", state: "limited", limitedAccounts: 2, enabledAccounts: 2, usableAccounts: 0 },
      { id: "b", name: "模型B", state: "partial", limitedAccounts: 1, enabledAccounts: 2, usableAccounts: 1 },
    ],
    counts: { total: 2, usable: 1, partial: 1, limited: 1, off: 0, dead: 0 },
  }
  let finish: (value: any) => void = () => {}
  const fetcher = vi.fn(async (_url: string, init: any) =>
    init.method === "POST"
      ? new Promise((done) => {
          finish = done
        })
      : { ok: true, json: async () => data },
  )
  vi.stubGlobal("fetch", fetcher)
  render(<ModelsPanel />)
  return { fetcher, finish: (value: any) => finish(value) }
}

test("按筛选选择多个模型批量解除，显示结果并禁用重复提交", async () => {
  const env = setup()
  const input = await screen.findByLabelText("模型A 冷却选择")
  fireEvent.click(input)
  fireEvent.click(screen.getByLabelText("模型B 冷却选择"))
  const button = screen.getByRole("button", { name: "解除所选冷却（2）" }) as HTMLButtonElement
  fireEvent.click(button)
  await waitFor(() => assert.equal(button.disabled, true))
  const post = env.fetcher.mock.calls.find((call) => call[1].method === "POST")!
  assert.equal(post[0], "/admin/models/api/codearts/cooldowns/clear")
  assert.deepEqual(JSON.parse(post[1].body), { modelIds: ["a", "b"] })
  env.finish({ ok: true, json: async () => ({ cleared: 3, affectedAccounts: 2, failed: [] }) })
  await screen.findByText("已解除 3 条模型冷却，涉及 2 个账号")
  assert.equal((screen.getByLabelText("模型A 冷却选择") as HTMLInputElement).checked, false)
})

test("解除全部显式传 all；失败保留选择且不展示敏感错误", async () => {
  const env = setup()
  fireEvent.click(await screen.findByLabelText("模型A 冷却选择"))
  fireEvent.click(screen.getByRole("button", { name: "解除全部冷却" }))
  await waitFor(() => assert.ok(env.fetcher.mock.calls.some((call) => call[1].method === "POST")))
  const post = env.fetcher.mock.calls.find((call) => call[1].method === "POST")!
  assert.deepEqual(JSON.parse(post[1].body), { all: true })
  env.finish({ ok: false, json: async () => ({ error: "sensitive error" }) })
  await screen.findByRole("alert")
  assert.equal((screen.getByLabelText("模型A 冷却选择") as HTMLInputElement).checked, true)
  assert.doesNotMatch(document.body.textContent!, /sensitive error/)
})

test("其他渠道不显示 CodeArts 冷却操作", async () => {
  setup("opencode")
  await screen.findByRole("switch", { name: "模型A 是否启用" })
  assert.equal(screen.queryByRole("button", { name: "解除全部冷却" }), null)
})

test("部分账号失败在刷新后仍提示，并保留模型选择供重试", async () => {
  const env = setup()
  fireEvent.click(await screen.findByLabelText("模型A 冷却选择"))
  fireEvent.click(screen.getByRole("button", { name: "解除所选冷却（1）" }))
  env.finish({ ok: true, json: async () => ({ cleared: 1, affectedAccounts: 1, failed: ["account"] }) })
  await screen.findByText("1 个账号解除失败，请重试")
  assert.equal((screen.getByLabelText("模型A 冷却选择") as HTMLInputElement).checked, true)
})
