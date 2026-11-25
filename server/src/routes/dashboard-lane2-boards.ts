import { Router, type Request, type Response } from "express";
import { isDashboardPeriod, type DashboardBoardId, type DashboardPeriod } from "@paperclipai/shared";
import { ceoBoardRoutes, ceoBoardService } from "../ir/ceo-board.js";
import { dashboardBoardService } from "../services/dashboard-boards.js";
import { assertCompanyAccess } from "./authz.js";

type Lane2Board = Extract<DashboardBoardId, "sales" | "marketing" | "human-employees">;

function parsePeriodQuery(raw: unknown): DashboardPeriod {
  return isDashboardPeriod(raw) ? raw : "30d";
}

/**
 * Read-only board payloads for the Sales, Marketing, Human employees, CEO
 * money tiles and Reading Order boards. Company access is the only
 * authorization: a board is a read of the company's own numbers, and its
 * tables are keyed by client id.
 *
 * Each board has an explicit literal path. A `:board` catch-all would swallow
 * the other lanes' `/dashboards/<id>` reads, because Express matches in order,
 * and literal paths keep the OpenAPI route-coverage check exact.
 */
export function dashboardLane2BoardRoutes(
  service: ReturnType<typeof dashboardBoardService> = dashboardBoardService(),
  ceoService: ReturnType<typeof ceoBoardService> = ceoBoardService(),
) {
  const router = Router();
  const read = (board: Lane2Board) => async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const period = parsePeriodQuery(req.query.period);
    res.json(await service.board(board, companyId, period));
  };

  router.get("/companies/:companyId/dashboards/sales", read("sales"));
  router.get("/companies/:companyId/dashboards/marketing", read("marketing"));
  router.get("/companies/:companyId/dashboards/human-employees", read("human-employees"));
  router.use(ceoBoardRoutes(ceoService));

  return router;
}
