import type {
  DashboardAiCostBoard,
  DashboardAutomationHealthBoard,
  DashboardFulfillmentBoard,
  DashboardToolsConnectorsBoard,
} from "@paperclipai/shared";
import { api } from "./client";

/**
 * Lane 3 operating boards. Each read is a server-side aggregate; a tile with no
 * source comes back as `notConnected` instead of a number.
 */
export const dashboardBoardsApi = {
  aiCost: (companyId: string) =>
    api.get<DashboardAiCostBoard>(`/companies/${companyId}/dashboards/ai-cost`),
  automationHealth: (companyId: string) =>
    api.get<DashboardAutomationHealthBoard>(`/companies/${companyId}/dashboards/automation-health`),
  toolsConnectors: (companyId: string) =>
    api.get<DashboardToolsConnectorsBoard>(`/companies/${companyId}/dashboards/tools-connectors`),
  fulfillment: (companyId: string) =>
    api.get<DashboardFulfillmentBoard>(`/companies/${companyId}/dashboards/fulfillment`),
};
