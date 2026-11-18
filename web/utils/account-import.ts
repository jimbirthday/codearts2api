export interface ImportRow {
  source: string
  status: "ready" | "skipped" | "invalid"
  message: string
}

export interface AccountImportBatch {
  payload: {
    format: "dsh-codearts-auth/backup"
    version: 1
    exportedAt: string
    credentials: Record<string, string>
    accounts: Array<{
      id: string
      provider: "codearts" | "loomy"
      nickname: string
      enabled: boolean
      credentialRef: string
      refreshable: boolean
      createdAt: number
      expiresAt?: number
    }>
    disabledModels: Record<string, never>
  }
  rows: ImportRow[]
}
