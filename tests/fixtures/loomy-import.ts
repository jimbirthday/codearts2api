import { jsonFile } from "./codearts-import"

export const loomyLine = (index = 1) =>
  `1380000${String(index).padStart(4, "0")}----${String(index).padStart(32, "a")}----${String(index).padStart(18, "2")}`
export const loomyFile = (text = loomyLine(), name = "accounts.txt") => jsonFile(name, text, true)
