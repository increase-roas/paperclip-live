import { Router, type Request, type Response } from "express";
import type { DashboardBoardId } from "@paperclipai/shared";
import { dashboardBoardService } from "../services/dashboard-boards.js";
import { assertCompanyAccess } from "./authz.js";

type Lane2Board = Extract<DashboardBoardId, "sales" | "marketing" | "human-employees">;

/**
 * Read-only board payloads for the Sales, Marketing and Human employees
 * boards. Company access is the only authorization: a board is a read of the
 * company's own numbers, and its tables are keyed by client id.
 *
 * Each board has an explicit literal path. A `:board` catch-all would swallow
 * the other lanes' `/dashboards/<id>` reads, because Express matches in order,
 * and literal paths keep the OpenAPI route-coverage check exact.
 */
export function dashboardLane2BoardRoutes(
  service: ReturnType<typeof dashboardBoardService> = dashboardBoardService(),
) {
  const router = Router();
  const read = (board: Lane2Board) => async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await service.board(board, companyId));
  };

  router.get("/companies/:companyId/dashboards/sales", read("sales"));
  router.get("/companies/:companyId/dashboards/marketing", read("marketing"));
  router.get("/companies/:companyId/dashboards/human-employees", read("human-employees"));

  return router;
}
