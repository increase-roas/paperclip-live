import type { DashboardBoard, DashboardBoardId } from "@paperclipai/shared";
import { api } from "./client";

/**
 * Lane 2 boards. The server route is explicit per board, so another lane can
 * add its own `/dashboards/<id>` reads without a parameter collision.
 */
export const dashboardLane2BoardsApi = {
  get: (companyId: string, board: DashboardBoardId) =>
    api.get<DashboardBoard>(`/companies/${companyId}/dashboards/${board}`),
};
