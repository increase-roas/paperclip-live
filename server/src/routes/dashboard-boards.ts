import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { dashboardAiCostService } from "../services/dashboard-ai-cost.js";
import { dashboardAutomationHealthService } from "../services/dashboard-automation-health.js";
import { dashboardToolsConnectorsService } from "../services/dashboard-tools-connectors.js";
import { dashboardFulfillmentService } from "../services/dashboard-fulfillment.js";
import type { InspectDatabaseBackupHealthOptions } from "../services/database-backup-health.js";
import { assertCompanyAccess, hasBoardOrgAccess } from "./authz.js";

/**
 * Lane 3 operating boards. Each endpoint is a read-only aggregate over
 * Paperclip's own tables. A tile with no source returns a `notConnected`
 * entry instead of a number.
 */
export function dashboardBoardRoutes(
  db: Db,
  options: { databaseBackupHealth?: InspectDatabaseBackupHealthOptions } = {},
) {
  const router = Router();
  const aiCost = dashboardAiCostService(db);
  const automationHealth = dashboardAutomationHealthService(db, {
    databaseBackupHealth: options.databaseBackupHealth,
  });
  const tools = dashboardToolsConnectorsService(db);
  const fulfillment = dashboardFulfillmentService(db);

  router.get("/companies/:companyId/dashboards/ai-cost", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await aiCost.board(companyId));
  });

  router.get("/companies/:companyId/dashboards/automation-health", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await automationHealth.board(companyId, undefined, { includeRawErrors: hasBoardOrgAccess(req) }));
  });

  router.get("/companies/:companyId/dashboards/tools-connectors", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await tools.board(companyId, undefined, { includeInstancePlugins: hasBoardOrgAccess(req) }));
  });

  router.get("/companies/:companyId/dashboards/fulfillment", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await fulfillment.board(companyId));
  });

  return router;
}
