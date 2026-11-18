import { useEffect, useState } from "react"

import styles from "./SchedulingSettings.module.less"

interface Field {
  key: string
  label: string
  min: number
  max: number
  hint: string
}
interface Provider {
  id: string
  label: string
  config: Record<string, number>
  fields: Field[]
}

async function request(path = "", init: RequestInit = {}) {
  const response = await fetch(`/admin/scheduling/api${path}`, {
    ...init,
    headers: { "content-type": "application/json" },
  })
  const body = await response.json()
  if (!response.ok)
    throw new Error(response.status === 400 ? (body.error ?? "配置无效") : "操作失败，请检查网络和登录状态后重试")
  return body
}

function SettingsForm({ provider }: { provider: Provider }) {
  const [savedValues, setSavedValues] = useState(() =>
    Object.fromEntries(provider.fields.map((field) => [field.key, String(provider.config[field.key])])),
  )
  const [values, setValues] = useState(savedValues)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState("")
  const [error, setError] = useState("")
  const validate = (field: Field, value = values[field.key]) => {
    const number = Number(value)
    return !value.trim() || !Number.isInteger(number) || number < field.min || number > field.max
      ? `请输入 ${field.min}–${field.max} 之间的整数`
      : ""
  }
  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return
    const invalid = Object.fromEntries(
      provider.fields.map((field) => [field.key, validate(field)]).filter(([, message]) => message),
    )
    if (Number(values.cooldownMinSeconds) > Number(values.cooldownMaxSeconds))
      invalid.cooldownMaxSeconds = "最长时间不能小于最短时间"
    setErrors(invalid)
    if (Object.keys(invalid).length) return
    const patch = Object.fromEntries(
      Object.entries(values)
        .filter(([key, value]) => Number(value) !== Number(savedValues[key]))
        .map(([key, value]) => [key, Number(value)]),
    )
    if (!Object.keys(patch).length) {
      setError("")
      setNotice("配置未改变")
      return
    }
    setBusy(true)
    setNotice("")
    setError("")
    try {
      await request(`/${provider.id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      })
      setSavedValues({ ...values })
      setNotice(`${provider.label} 配置已保存并立即生效，无需重启`)
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={save} noValidate aria-label={`${provider.label} 调度配置`} aria-busy={busy}>
      <fieldset disabled={busy} className={styles.fields}>
        <legend>{provider.label} 调度配置</legend>
        {provider.fields.map((field) => {
          const id = `scheduling-${provider.id}-${field.key}`
          return (
            <div key={field.key} className={styles.field}>
              <label htmlFor={id}>{field.label}</label>
              <input
                id={id}
                type="number"
                inputMode="numeric"
                min={field.min}
                max={field.max}
                step="1"
                value={values[field.key]}
                aria-invalid={!!errors[field.key]}
                aria-describedby={`${id}-hint${errors[field.key] ? ` ${id}-error` : ""}`}
                onChange={(event) => {
                  setValues({ ...values, [field.key]: event.target.value })
                  setNotice("")
                  setError("")
                  setErrors({ ...errors, [field.key]: "" })
                }}
                onBlur={() => setErrors((previous) => ({ ...previous, [field.key]: validate(field) }))}
              />
              <small id={`${id}-hint`}>{field.hint}</small>
              {errors[field.key] ? (
                <small id={`${id}-error`} role="alert">
                  {errors[field.key]}
                </small>
              ) : null}
            </div>
          )
        })}
      </fieldset>
      <div className={styles.actions}>
        <button type="submit" className="c2a-btn c2a-btn--primary" disabled={busy}>
          {busy ? "保存中…" : "保存并立即生效"}
        </button>
        {notice ? <span role="status">{notice}</span> : null}
        {error ? <span role="alert">{error}</span> : null}
      </div>
    </form>
  )
}

function SettingsContent() {
  const [providers, setProviders] = useState<Provider[]>([])
  const [selected, setSelected] = useState("codearts")
  const [error, setError] = useState("")
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let alive = true
    setError("")
    request()
      .then((body) => {
        if (alive) setProviders(body.providers)
      })
      .catch(() => {
        if (alive) setError("读取配置失败，请检查网络和登录状态后重试")
      })
    return () => {
      alive = false
    }
  }, [revision])
  if (error)
    return (
      <p role="alert">
        {error}{" "}
        <button type="button" className="c2a-btn" onClick={() => setRevision((value) => value + 1)}>
          重试
        </button>
      </p>
    )
  if (!providers.length) return <p role="status">正在读取调度配置…</p>
  const provider = providers.find((item) => item.id === selected)!
  return (
    <>
      <label className={styles.provider}>
        配置渠道{" "}
        <select value={selected} onChange={(event) => setSelected(event.target.value)}>
          {providers.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <p className={styles.hint}>
        配置按渠道独立保存；其他渠道沿用上游调度。保存后用于后续调度，已运行请求继续完成；已排队请求的超时、已有绑定及冷却期限按原计划结束。重启后保留界面保存值，优先于环境变量。
      </p>
      {providers.map((item) => (
        <div key={item.id} hidden={item.id !== provider.id}>
          <SettingsForm provider={item} />
        </div>
      ))}
    </>
  )
}

export function SchedulingSettings() {
  const [open, setOpen] = useState(false)
  return (
    <section className={styles.settings} aria-label="调度设置">
      <button
        type="button"
        className="c2a-btn"
        aria-expanded={open}
        aria-controls="scheduling-settings"
        onClick={() => setOpen((value) => !value)}
      >
        调度设置
      </button>
      {open ? (
        <div id="scheduling-settings" className={styles.content}>
          <SettingsContent />
        </div>
      ) : null}
    </section>
  )
}
