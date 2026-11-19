import { createHash } from "node:crypto"

/** 每个账号的模型权限独立缓存；未知模型不能交给 Loomy 静默回退成 Spark。 */
export function createLoomyModels({ native, pool, adapter, fetcher }: any) {
  const snapshots = new Map<string, { key: string; cache: any; signal: AbortSignal }>()
  let loading: Promise<any[]> | undefined
  const models = new Map<string, any[] | undefined>()
  const read = async ({ entry, credential }: any, signal: AbortSignal) => {
    const key = createHash("sha256").update(String(credential.access_token)).digest("hex")
    let snapshot = snapshots.get(entry.id)
    if (snapshot?.key !== key) {
      snapshot = {
        key,
        signal,
        cache: new native.TtlCache({
          ttlMs: native.catalogTtlMs,
          ttlFor: (reading: any) => (reading.models ? native.catalogTtlMs : 15_000),
          load: async () => {
            try {
              const response = await fetcher(`${adapter.product.apiBase}/models`, {
                headers: native.businessHeaders(credential.access_token),
                signal: snapshot!.signal,
              })
              if (!response.ok) {
                await response.body?.cancel()
                return {}
              }
              const payload = await response.json()
              const envelope = native.envelope(payload)
              if (envelope.code && !envelope.ok) return {}
              const parsed = native.parseModels(payload)
              return parsed.length ? { models: parsed } : {}
            } catch {
              return {}
            }
          },
        }),
      }
      snapshots.set(entry.id, snapshot)
    }
    snapshot.signal = signal
    const reading = await snapshot.cache.get()
    if (snapshots.get(entry.id) === snapshot) models.set(entry.id, reading.models)
    return reading.models as any[] | undefined
  }
  const load = async () => {
    const entries = pool.candidateAccounts("loomy", "", new Set())
    const ids = new Set(entries.map((entry: any) => entry.id))
    for (const id of models.keys())
      if (!ids.has(id)) {
        snapshots.delete(id)
        models.delete(id)
      }
    const union = new Map<string, any>()
    // 冷池限制目录查询并发；热池的 TTL 命中不再发网络请求。
    let cursor = 0
    const timeout = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const work = Promise.all(
      Array.from({ length: Math.min(3, entries.length) }, async () => {
        for (;;) {
          if (timeout.signal.aborted) return
          const entry = entries[cursor++]
          if (!entry) return
          const account = await pool.resolveFirstCredential("loomy", [entry])
          if (!account) {
            models.delete(entry.id)
            continue
          }
          for (const model of (await read(account, timeout.signal)) ?? [])
            if (!union.has(model.id)) union.set(model.id, model)
        }
      }),
    )
    try {
      // 总预算覆盖整个池，不能把每批账号的超时串起来累加。
      await Promise.race([
        work,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            timeout.abort()
            resolve()
          }, 10_000)
        }),
      ])
    } finally {
      clearTimeout(timer!)
    }
    return [...union.values()]
  }
  return {
    load() {
      loading ??= load().finally(() => {
        loading = undefined
      })
      return loading
    },
    modelFor(id: string, requested: string) {
      const available = models.get(id) ?? []
      const exact = available.find((model: any) => model.id === requested)
      if (exact) return exact
      const matches = available.filter((model: any) => native.catalogKey(model.id) === native.catalogKey(requested))
      return matches.length === 1 ? matches[0] : undefined
    },
    known(id: string) {
      return models.get(id) !== undefined
    },
    clear() {
      snapshots.clear()
    },
  }
}
