/** @vitest-environment jsdom */
import assert from "node:assert/strict"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, test, vi } from "vite-plus/test"

import { CodeArtsImport } from "../web/pages/channels/CodeArtsImport"
import { prepareCodeArtsImport } from "../web/utils/codearts-import"
import { codeArtsJson, jsonFile } from "./fixtures/codearts-import"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test("导出只请求 CodeArts 的最新备份并下载 JSON，页面不显示密钥", async () => {
  const batch = await prepareCodeArtsImport([jsonFile("one.json", codeArtsJson())])
  let finish: (value: any) => void = () => {}
  const fetcher = vi.fn(async (_url, init) => {
    const method = JSON.parse(init.body).payload.method
    if (method === "account.list") {
      return { ok: true, json: async () => ({ result: { ok: true, value: { accounts: batch.payload.accounts } } }) }
    }
    return new Promise((done) => {
      finish = done
    })
  })
  vi.stubGlobal("fetch", fetcher)
  const createObjectURL = vi.fn(() => "blob:export")
  const revokeObjectURL = vi.fn()
  vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL, revokeObjectURL }))
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function () {
    assert.match(this.download, /^codearts-accounts-.*\.json$/)
    assert.equal(this.href, "blob:export")
  })
  render(<CodeArtsImport onImported={() => {}} />)
  fireEvent.click(screen.getByRole("button", { name: "导出 CodeArts JSON" }))
  await waitFor(() => assert.equal(fetcher.mock.calls.length, 2))
  assert.equal((screen.getByRole("button", { name: "导出中…" }) as HTMLButtonElement).disabled, true)
  assert.equal((screen.getByRole("button", { name: "导入 CodeArts JSON" }) as HTMLButtonElement).disabled, true)
  const request = JSON.parse(fetcher.mock.calls[1][1].body)
  assert.equal(request.payload.method, "backup.export")
  assert.deepEqual(
    request.payload.payload.accountIds,
    batch.payload.accounts.map((account) => account.id),
  )
  finish({ ok: true, json: async () => ({ result: { ok: true, value: { payload: batch.payload, warnings: [] } } }) })
  await screen.findByText("已导出 1 个账号")
  assert.equal(click.mock.calls.length, 1)
  const blob = createObjectURL.mock.calls[0][0] as Blob
  const data = await new Promise<string>((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.readAsText(blob)
  })
  assert.equal(JSON.parse(data)[0].refresh_token, codeArtsJson().refresh_token)
  assert.doesNotMatch(document.body.textContent!, /TEST_SECRET|TEST_TOKEN|TEST_REFRESH/)
  await waitFor(() => assert.equal(revokeObjectURL.mock.calls.length, 1))
})

test("无 CodeArts 账号不请求全量备份；导出失败显示可重试信息", async () => {
  const fetcher = vi.fn(async () => ({
    ok: true,
    json: async () => ({ result: { ok: true, value: { accounts: [] } } }),
  }))
  vi.stubGlobal("fetch", fetcher)
  render(<CodeArtsImport onImported={() => {}} />)
  fireEvent.click(screen.getByRole("button", { name: "导出 CodeArts JSON" }))
  await screen.findByText("没有可导出的 CodeArts 账号")
  assert.equal(fetcher.mock.calls.length, 1)
  fetcher.mockRejectedValueOnce(new Error("sensitive error"))
  fireEvent.click(screen.getByRole("button", { name: "导出 CodeArts JSON" }))
  await screen.findByText(/导出未完成/)
  assert.doesNotMatch(document.body.textContent!, /sensitive error/)
  assert.equal((screen.getByRole("button", { name: "导出 CodeArts JSON" }) as HTMLButtonElement).disabled, false)
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
