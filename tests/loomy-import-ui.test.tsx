/** @vitest-environment jsdom */
import assert from "node:assert/strict"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, test, vi } from "vite-plus/test"
import { prepareLoomyImport } from "../web/utils/loomy-import"
import { AccountImport } from "../web/pages/channels/AccountImport"
import { loomyFile, loomyLine } from "./fixtures/loomy-import"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test("Loomy TXT：先预览再确认、多文件与错误提示、追加导入，页面不泄露凭据", async () => {
  const fetcher = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      result: {
        ok: true,
        value: { accountsImported: 1, accountsSkipped: ["existing"], skipped: [], missingCredentials: 0 },
      },
    }),
  }))
  vi.stubGlobal("fetch", fetcher)
  const onImported = vi.fn()
  render(<AccountImport provider="loomy" onImported={onImported} />)
  const input = screen.getByLabelText("Loomy TXT 文件") as HTMLInputElement
  assert.match(input.accept, /\.txt/)
  assert.equal(input.multiple, true)
  fireEvent.change(input, {
    target: { files: [loomyFile(), loomyFile(`${loomyLine(2)}\ninvalid----SECRET`, "other.txt")] },
  })
  const confirm = await screen.findByRole("button", { name: "确认导入 2 个账号" })
  assert.equal(fetcher.mock.calls.length, 0)
  assert.match(screen.getByRole("region").textContent!, /格式错误 1 条/)
  const [phone, token] = loomyLine().split("----")
  assert.doesNotMatch(document.body.textContent!, new RegExp(`${phone}|${token}|SECRET`))
  fireEvent.click(confirm)
  await screen.findByText(/新增 1 个账号；已存在 1 个/)
  const body = JSON.parse((fetcher.mock.calls as any)[0][1].body).payload
  assert.equal(body.method, "backup.import")
  assert.equal(body.payload.mode, "merge")
  assert.ok(body.payload.payload.accounts.every((account: any) => account.provider === "loomy"))
  assert.equal(onImported.mock.calls.length, 1)
})

test("Loomy TXT：忙时禁用重复提交，失败保留预览与重试入口", async () => {
  let fail!: (error: Error) => void
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject
        }),
    ),
  )
  render(<AccountImport provider="loomy" onImported={() => {}} />)
  fireEvent.change(screen.getByLabelText("Loomy TXT 文件"), { target: { files: [loomyFile()] } })
  const confirm = (await screen.findByRole("button", { name: "确认导入 1 个账号" })) as HTMLButtonElement
  fireEvent.click(confirm)
  await waitFor(() => assert.equal(confirm.disabled, true))
  fail(new Error("SECRET"))
  await screen.findByRole("alert")
  assert.equal(confirm.disabled, false)
  assert.doesNotMatch(document.body.textContent!, /SECRET/)
})

test("Loomy 导出只请求本渠道账号备份并下载三列 TXT，忙时防重复且页面不显示凭据", async () => {
  const batch = await prepareLoomyImport([loomyFile()])
  let finish!: (value: any) => void
  const fetcher = vi.fn(async (_url, init) => {
    const request = JSON.parse(init.body).payload
    if (request.method === "account.list") {
      assert.deepEqual(request.payload, { provider: "loomy" })
      return {
        ok: true,
        json: async () => ({
          result: { ok: true, value: { accounts: [...batch.payload.accounts, { id: "other", provider: "codearts" }] } },
        }),
      }
    }
    return new Promise((resolve) => {
      finish = resolve
    })
  })
  vi.stubGlobal("fetch", fetcher)
  const createObjectURL = vi.fn(() => "blob:loomy-export"),
    revokeObjectURL = vi.fn()
  vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL, revokeObjectURL }))
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function () {
    assert.match(this.download, /^loomy-accounts-.*\.txt$/)
    assert.equal(this.href, "blob:loomy-export")
  })
  render(<AccountImport provider="loomy" onImported={() => {}} />)
  fireEvent.click(screen.getByRole("button", { name: "导出 Loomy TXT" }))
  await waitFor(() => assert.equal(fetcher.mock.calls.length, 2))
  assert.equal((screen.getByRole("button", { name: "导出中…" }) as HTMLButtonElement).disabled, true)
  assert.equal((screen.getByRole("button", { name: "导入 Loomy TXT" }) as HTMLButtonElement).disabled, true)
  assert.deepEqual(JSON.parse(fetcher.mock.calls[1][1].body).payload.payload.accountIds, [batch.payload.accounts[0].id])
  finish({ ok: true, json: async () => ({ result: { ok: true, value: { payload: batch.payload } } }) })
  await screen.findByText("已导出 1 个账号")
  assert.equal(click.mock.calls.length, 1)
  const blob = createObjectURL.mock.calls[0][0] as Blob
  assert.equal(blob.type, "text/plain;charset=utf-8")
  const text = await new Promise<string>((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.readAsText(blob)
  })
  assert.equal(text, loomyLine() + "\n")
  const [phone, token, userid] = loomyLine().split("----")
  assert.doesNotMatch(document.body.textContent!, new RegExp(`${phone}|${token}|${userid}`))
  await waitFor(() => assert.equal(revokeObjectURL.mock.calls.length, 1))
})

test("Loomy 没有账号不请求全量备份；导出失败可重试且隐藏原始错误", async () => {
  const fetcher = vi.fn(async () => ({
    ok: true,
    json: async () => ({ result: { ok: true, value: { accounts: [] } } }),
  }))
  vi.stubGlobal("fetch", fetcher)
  render(<AccountImport provider="loomy" onImported={() => {}} />)
  fireEvent.click(screen.getByRole("button", { name: "导出 Loomy TXT" }))
  await screen.findByText("没有可导出的 Loomy 账号")
  assert.equal(fetcher.mock.calls.length, 1)
  fetcher.mockRejectedValueOnce(new Error("SECRET"))
  fireEvent.click(screen.getByRole("button", { name: "导出 Loomy TXT" }))
  await screen.findByText(/导出未完成/)
  assert.doesNotMatch(document.body.textContent!, /SECRET/)
  assert.equal((screen.getByRole("button", { name: "导出 Loomy TXT" }) as HTMLButtonElement).disabled, false)
})
