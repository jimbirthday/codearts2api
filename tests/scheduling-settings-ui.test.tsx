/** @vitest-environment jsdom */
import assert from "node:assert/strict"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, test, vi } from "vite-plus/test"
import { SchedulingSettings } from "../web/pages/channels/SchedulingSettings"

const data = {
  providers: ["codearts", "loomy"].map((id) => ({
    id,
    label: id === "codearts" ? "CodeArts" : "Loomy",
    config: { maxInFlight: id === "codearts" ? 3 : 2, cooldownMinSeconds: 60, cooldownMaxSeconds: 180 },
    fields: [
      { key: "maxInFlight", label: "每账号最大在途", min: 1, max: 100, hint: "账号独立计数" },
      { key: "cooldownMinSeconds", label: "最短冷却（秒）", min: 1, max: 86400, hint: "随机下限" },
      { key: "cooldownMaxSeconds", label: "最长冷却（秒）", min: 1, max: 86400, hint: "随机上限" },
    ],
  })),
}
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test("调度配置按需读取、分渠道编辑，保存时禁重复提交并显示即时生效结果", async () => {
  let finish!: (value: any) => void
  const fetcher = vi.fn(async (_url, init) =>
    init.method === "PATCH"
      ? new Promise((done) => {
          finish = done
        })
      : { ok: true, json: async () => structuredClone(data) },
  )
  vi.stubGlobal("fetch", fetcher)
  render(<SchedulingSettings />)
  assert.equal(fetcher.mock.calls.length, 0)
  fireEvent.click(screen.getByRole("button", { name: "调度设置" }))
  const first = await screen.findByRole("form", { name: "CodeArts 调度配置" })
  assert.equal((within(first).getByLabelText("每账号最大在途") as HTMLInputElement).value, "3")
  fireEvent.change(screen.getByRole("combobox", { name: "配置渠道" }), { target: { value: "loomy" } })
  const form = screen.getByRole("form", { name: "Loomy 调度配置" })
  const input = within(form).getByLabelText("每账号最大在途") as HTMLInputElement
  assert.equal(input.value, "2")
  fireEvent.change(input, { target: { value: "4" } })
  const save = within(form).getByRole("button", { name: "保存并立即生效" }) as HTMLButtonElement
  fireEvent.click(save)
  await waitFor(() => assert.equal(save.disabled, true))
  assert.equal(within(form).getByRole("group").hasAttribute("disabled"), true)
  const post = fetcher.mock.calls.find(([, init]) => init.method === "PATCH")!
  assert.equal(post[0], "/admin/scheduling/api/loomy")
  assert.deepEqual(JSON.parse(post[1].body), { maxInFlight: 4 })
  finish({ ok: true, json: async () => ({ config: { maxInFlight: 4 } }) })
  await screen.findByText("Loomy 配置已保存并立即生效，无需重启")
})

test("配置数字和冷却区间就地校验；失败保留输入、隐藏服务器内部错误，允许重试", async () => {
  const fetcher = vi.fn(async (_url, init) =>
    init.method === "PATCH"
      ? { ok: false, status: 500, json: async () => ({ error: "SECRET" }) }
      : { ok: true, json: async () => structuredClone(data) },
  )
  vi.stubGlobal("fetch", fetcher)
  render(<SchedulingSettings />)
  fireEvent.click(screen.getByRole("button", { name: "调度设置" }))
  const form = await screen.findByRole("form", { name: "CodeArts 调度配置" })
  const input = within(form).getByLabelText("每账号最大在途") as HTMLInputElement
  fireEvent.change(input, { target: { value: "0" } })
  fireEvent.blur(input)
  assert.equal(input.getAttribute("aria-invalid"), "true")
  fireEvent.click(within(form).getByRole("button", { name: "保存并立即生效" }))
  assert.equal(fetcher.mock.calls.length, 1)
  fireEvent.change(input, { target: { value: "6" } })
  fireEvent.change(within(form).getByLabelText("最长冷却（秒）"), { target: { value: "30" } })
  fireEvent.click(within(form).getByRole("button", { name: "保存并立即生效" }))
  assert.equal(fetcher.mock.calls.length, 1)
  await screen.findByText("最长时间不能小于最短时间")
  fireEvent.change(within(form).getByLabelText("最长冷却（秒）"), { target: { value: "180" } })
  fireEvent.click(within(form).getByRole("button", { name: "保存并立即生效" }))
  await screen.findByText("操作失败，请检查网络和登录状态后重试")
  assert.equal(input.value, "6")
  assert.doesNotMatch(document.body.textContent!, /SECRET/)
})

test("配置读取失败显示重试入口，重试后可正常编辑", async () => {
  let attempts = 0
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      if (++attempts === 1) throw new TypeError("network")
      return { ok: true, json: async () => structuredClone(data) }
    }),
  )
  render(<SchedulingSettings />)
  fireEvent.click(screen.getByRole("button", { name: "调度设置" }))
  fireEvent.click(await screen.findByRole("button", { name: "重试" }))
  await screen.findByRole("form", { name: "CodeArts 调度配置" })
})
