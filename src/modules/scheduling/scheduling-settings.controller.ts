import express from "express"

import { sendJson } from "../../http/respond.ts"
import type { SchedulingSettingsService } from "./scheduling-settings.service.ts"

export function createSchedulingSettingsController(service: SchedulingSettingsService) {
  const router = express.Router()
  router.use(express.json({ limit: "8kb", type: () => true }))
  router.get("/", (_request, response) => sendJson(response, 200, service.read()))
  router.patch("/:provider", async (request, response) => {
    sendJson(response, 200, await service.update(request.params.provider, request.body))
  })
  return router
}
