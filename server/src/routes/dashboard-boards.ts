import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { isDashboardPeriod, type DashboardPeriod } from "@paperclipai/shared";
import { dashboardAiCostService } from "../services/dashboard-ai-cost.js";
import { dashboardAutomationHealthService } from "../services/dashboard-automation-health.js";
import { dashboardToolsConnectorsService } from "../services/dashboard-tools-connectors.js";
import { dashboardFulfillmentService, type DashboardFulfillmentDeps } from "../services/dashboard-fulfillment.js";
import type { InspectDatabaseBackupHealthOptions } from "../services/database-backup-health.js";
import { assertCompanyAccess, hasBoardOrgAccess } from "./authz.js";

function parsePeriodQuery(raw: unknown): DashboardPeriod {
  return isDashboardPeriod(raw) ? raw : "30d";
}

function canReadInstanceDashboards(req: Request): boolean {
  return (
    req.actor.type === "board" &&
    (req.actor.source === "local_implicit" || Boolean(req.actor.isInstanceAdmin))
  );
}

/**
 * Lane 3 operating boards. Each endpoint is a read-only aggregate over
 * Paperclip's own tables (plus instance-admin gated client delivery feeds on
 * Fulfillment). A tile with no source returns a `notConnected` entry instead
 * of a number.
 */
export function dashboardBoardRoutes(
  db: Db,
  options: {
    databaseBackupHealth?: InspectDatabaseBackupHealthOptions;
    fulfillmentDeps?: DashboardFulfillmentDeps;
  } = {},
) {
  const router = Router();
  const aiCost = dashboardAiCostService(db);
  const automationHealth = dashboardAutomationHealthService(db, {
    databaseBackupHealth: options.databaseBackupHealth,
  });
  const tools = dashboardToolsConnectorsService(db);
  const fulfillment = dashboardFulfillmentService(db, options.fulfillmentDeps);

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
    res.json(await tools.board(companyId, undefined, { boardViewer: hasBoardOrgAccess(req) }));
  });

  router.get("/companies/:companyId/dashboards/fulfillment", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const period = parsePeriodQuery(req.query.period);
    res.json(
      await fulfillment.board(companyId, undefined, {
        period,
        boardViewer: canReadInstanceDashboards(req),
      }),
    );
  });

  return router;
}
