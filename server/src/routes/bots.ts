import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertCompanyAccess } from "./authz.js";
import { botsService } from "../services/bots.js";

export function botsRoutes(db: Db) {
  const router = Router();
  const service = botsService(db);

  // Bots are read-only here. Their gateway key id and policy come from agent
  // metadata; the key itself lives in the gateway and is never returned.
  router.get("/companies/:companyId/bots", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const [bots, suggestedAgents] = await Promise.all([
      service.list(companyId),
      service.suggestedAgents(companyId),
    ]);
    res.json({ bots, suggestedAgents });
  });

  router.get("/companies/:companyId/bots/:botId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const bot = await service.get(companyId, req.params.botId as string);
    if (!bot) {
      res.status(404).json({ error: "Bot not found" });
      return;
    }
    res.json(bot);
  });

  return router;
}
