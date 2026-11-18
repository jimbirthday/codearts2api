/** @vitest-environment jsdom */
import assert from "node:assert/strict"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, test, vi } from "vite-plus/test"
import { AccountImport } from "../web/pages/channels/AccountImport"
import { loomyFile, loomyLine } from "./fixtures/loomy-import"

afterEach(() => {
  cleanup()
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
