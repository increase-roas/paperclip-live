import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertCompanyAccess } from "./authz.js";
import { botsService } from "../services/bots.js";
import { botRegistrationService } from "../services/bot-registration.js";
import {
  createGatewayBotsClient,
  type GatewayBotSummary,
  type GatewayBotsClient,
} from "../services/gateway-bots.js";

export interface BotsRoutesOptions {
  /** Tests pass a fake client; production reads the server environment. */
  gateway?: GatewayBotsClient;
}

export function botsRoutes(db: Db, options: BotsRoutesOptions = {}) {
  const router = Router();
  const service = botsService(db);
  const registration = botRegistrationService(db);
  const gateway = options.gateway ?? createGatewayBotsClient();

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

  /**
   * Live gateway data for this company's bots only. The gateway answers with
   * every bot on the instance, so the company roster decides what leaves the
   * server: a bot in another company's roster never appears here.
   */
  router.get("/companies/:companyId/bots/gateway", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const bots = await service.list(companyId);
    const slugs = new Set(bots.map((bot) => bot.slug.toLowerCase()));
    const result = await gateway.list();
    if (!result.connected) {
      res.json({ connected: false, state: result.state, message: result.message, bots: [] });
      return;
    }
    const forCompany: GatewayBotSummary[] = result.bots.filter((bot) => slugs.has(bot.agent.toLowerCase()));
    res.json({
      connected: true,
      generatedAt: result.generatedAt,
      count: forCompany.length,
      bots: forCompany,
    });
  });

  router.get("/companies/:companyId/bots/:botId/gateway", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const botId = req.params.botId as string;
    const bot = await service.get(companyId, botId);
    if (!bot) {
      res.status(404).json({ error: "Bot not found" });
      return;
    }
    const result = await gateway.summary(bot.slug);
    res.json(result);
  });

  /**
   * Read-only registration plan for this company's catalog bots. It says which
   * bots would become agents and the exact row each create would insert;
   * nothing is written from this route.
   */
  router.get("/companies/:companyId/bots/registration", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const plan = await registration.plan(companyId);
    if (!plan) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json(plan);
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
