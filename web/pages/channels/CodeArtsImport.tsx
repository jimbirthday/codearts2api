import { useRef, useState } from "react"

import { hostRpcCall } from "../../api/rpc"
import { exportCodeArtsAccounts } from "../../utils/codearts-export"
import { prepareCodeArtsImport, type CodeArtsImportBatch } from "../../utils/codearts-import"
import styles from "./CodeArtsImport.module.less"

export function CodeArtsImport({ onImported }: { onImported: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [batch, setBatch] = useState<CodeArtsImportBatch | null>(null)
  const [busy, setBusy] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [notice, setNotice] = useState("")
  const [error, setError] = useState("")

  async function selectFiles(files: File[]) {
    if (!files.length || busy) return
    setBatch(null)
    setNotice("")
    setError("")
    setBusy(true)
    try {
      const prepared = await prepareCodeArtsImport(files)
      setBatch(prepared)
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function submit() {
    if (!batch || !batch.payload.accounts.length || busy) return
    setBusy(true)
    setError("")
    try {
      const result = await hostRpcCall("backup.import", { payload: batch.payload, mode: "merge" })
      const parts = [`新增 ${result.accountsImported} 个账号`, `已存在 ${result.accountsSkipped.length} 个（已跳过）`]
      if (result.expiredAccounts) parts.push(`${result.expiredAccounts} 个临时凭据已过期，续期失败时需重新登录`)
      if (result.skipped.length || result.missingCredentials) {
        setError("部分凭据未写入，请检查账号状态，删除凭据缺失的账号后重新导入")
      }
      setNotice(parts.join("；"))
      setBatch(null)
      onImported()
    } catch {
      setError("导入未完成，请检查网络和登录状态后重试；已导入的账号会自动跳过")
    } finally {
      setBusy(false)
    }
  }

  async function download() {
    if (busy) return
    setBusy(true)
    setExporting(true)
    setNotice("")
    setError("")
    try {
      const listed = await hostRpcCall("account.list", { provider: "codearts" })
      const accountIds = listed.accounts
        .filter((account: any) => account.provider === "codearts")
        .map((account: any) => account.id)
      if (!accountIds.length) {
        setError("没有可导出的 CodeArts 账号")
        return
      }
      const result = await hostRpcCall("backup.export", { accountIds })
      const { accounts, skipped } = exportCodeArtsAccounts(result.payload)
      const blob = new Blob([JSON.stringify(accounts, null, 2)], { type: "application/json" })
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = `codearts-accounts-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
      document.body.append(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 0)
      const missing =
        accountIds.length - result.payload.accounts.filter((account: any) => account.provider === "codearts").length
      setNotice(
        `已导出 ${accounts.length} 个账号${skipped + missing ? `；${skipped + missing} 个账号凭据不可用或已删除，未导出` : ""}`,
      )
    } catch {
      setError("导出未完成，请检查网络、登录和账号凭据状态后重试")
    } finally {
      setBusy(false)
      setExporting(false)
    }
  }

  const count = batch?.payload.accounts.length ?? 0
  const rows = batch?.rows ?? []
  return (
    <section className={styles.importer} aria-label="CodeArts JSON 导入与导出" aria-busy={busy}>
      <div className={styles.toolbar}>
        <button type="button" className="c2a-btn" disabled={busy} onClick={() => inputRef.current?.click()}>
          {busy && !exporting ? "处理中…" : "导入 CodeArts JSON"}
        </button>
        <button type="button" className="c2a-btn" disabled={busy} onClick={download}>
          {exporting ? "导出中…" : "导出 CodeArts JSON"}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".json,application/json"
          multiple
          hidden
          aria-label="CodeArts JSON 文件"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? [])
            event.target.value = ""
            void selectFiles(files)
          }}
        />
        <span className={styles.hint}>
          导入支持单个或多个文件，每批最多 100 个文件 / 2 MB；导出包含当前账号密钥与续期材料。
        </span>
      </div>
      {batch ? (
        <div className={styles.preview}>
          <p role="status">
            待导入 {count} 个，重复 {rows.filter((row) => row.status === "skipped").length} 个，格式错误{" "}
            {rows.filter((row) => row.status === "invalid").length} 条。仅追加账号，重复导入同一文件会跳过。
          </p>
          <ul className={styles.rows}>
            {rows.map((row, index) => (
              <li key={index} data-status={row.status}>
                <strong>{row.source}</strong>：{row.message}
              </li>
            ))}
          </ul>
          <div className={styles.toolbar}>
            <button type="button" className="c2a-btn c2a-btn--primary" disabled={busy || !count} onClick={submit}>
              确认导入 {count} 个账号
            </button>
            <button
              type="button"
              className="c2a-btn"
              disabled={busy}
              onClick={() => {
                setBatch(null)
                setError("")
              }}
            >
              取消
            </button>
          </div>
        </div>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  )
}
