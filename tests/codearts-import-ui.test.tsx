/** @vitest-environment jsdom */
import assert from "node:assert/strict"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, test, vi } from "vite-plus/test"

import { CodeArtsImport } from "../web/pages/channels/CodeArtsImport"
import { codeArtsJson, jsonFile } from "./fixtures/codearts-import"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test("多文件先预览，确认后只追加有效账号；完成后刷新账号视图", async () => {
  const onImported = vi.fn()
  const fetcher = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      result: {
        ok: true,
        value: {
          accountsImported: 1,
          accountsSkipped: ["existing"],
          skipped: [],
          expiredAccounts: 0,
          missingCredentials: 0,
        },
      },
    }),
  }))
  vi.stubGlobal("fetch", fetcher)
  render(<CodeArtsImport onImported={onImported} />)
  const input = screen.getByLabelText("CodeArts JSON 文件") as HTMLInputElement
  assert.equal(input.multiple, true)
  fireEvent.change(input, {
    target: {
      files: [
        jsonFile("one.json", codeArtsJson("one")),
        jsonFile("two.json", [codeArtsJson("two"), null]),
        jsonFile("broken.json", "not json", true),
      ],
    },
  })
  const confirm = await screen.findByRole("button", { name: "确认导入 2 个账号" })
  assert.equal(fetcher.mock.calls.length, 0, "文件选择不能直接写入账号")
  assert.equal(onImported.mock.calls.length, 0)
  assert.match(screen.getByRole("region").textContent!, /格式错误 2 条/)
  assert.doesNotMatch(document.body.textContent!, /TEST_SECRET|TEST_TOKEN|TEST_REFRESH/)
  fireEvent.click(confirm)
  await screen.findByText(/新增 1 个账号；已存在 1 个/)
  const request = JSON.parse(fetcher.mock.calls[0][1].body)
  assert.equal(request.payload.method, "backup.import")
  assert.equal(request.payload.payload.mode, "merge")
  assert.equal(request.payload.payload.payload.accounts.length, 2)
  assert.equal(onImported.mock.calls.length, 1)
  assert.equal(screen.queryByRole("button", { name: /确认导入/ }), null)
})

test("导入失败保留预览可重试；请求进行中禁用重复提交", async () => {
  let rejectRequest: (error: Error) => void = () => {}
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          rejectRequest = reject
        }),
    ),
  )
  const onImported = vi.fn()
  render(<CodeArtsImport onImported={onImported} />)
  const input = screen.getByLabelText("CodeArts JSON 文件")
  fireEvent.change(input, { target: { files: [jsonFile("one.json", codeArtsJson())] } })
  const confirm = (await screen.findByRole("button", { name: "确认导入 1 个账号" })) as HTMLButtonElement
  fireEvent.click(confirm)
  await waitFor(() => assert.equal(confirm.disabled, true))
  assert.equal((screen.getByRole("button", { name: "取消" }) as HTMLButtonElement).disabled, true)
  rejectRequest(new Error("sensitive response"))
  await screen.findByRole("alert")
  assert.doesNotMatch(document.body.textContent!, /sensitive response/)
  assert.equal(confirm.disabled, false)
  assert.equal(onImported.mock.calls.length, 0)
  fireEvent.click(screen.getByRole("button", { name: "取消" }))
  assert.equal(screen.queryByRole("button", { name: /确认导入/ }), null)
})
