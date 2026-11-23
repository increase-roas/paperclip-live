import { Router } from "express";
import type { DashboardBoardId } from "@paperclipai/shared";
import { dashboardBoardService } from "../services/dashboard-boards.js";
import { assertCompanyAccess } from "./authz.js";

const LANE2_BOARDS = ["sales", "marketing", "human-employees"] as const satisfies readonly DashboardBoardId[];

/**
 * Read-only board payloads for the Sales, Marketing and Human employees
 * boards. Company access is the only authorization: a board is a read of the
 * company's own numbers, and its tables are keyed by client id.
 *
 * Each board has an explicit path. A `:board` catch-all would swallow the
 * other lanes' `/dashboards/<id>` reads, because Express matches in order.
 */
export function dashboardLane2BoardRoutes(
  service: ReturnType<typeof dashboardBoardService> = dashboardBoardService(),
) {
  const router = Router();

  for (const board of LANE2_BOARDS) {
    router.get(`/companies/:companyId/dashboards/${board}`, async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      res.json(await service.board(board, companyId));
    });
  }

  return router;
}
