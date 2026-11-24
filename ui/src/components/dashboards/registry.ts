import type { ComponentType } from "react";
import type { DashboardPeriod } from "./period";
import { CeoBoard } from "./ceo/CeoBoard";
import { SalesBoard } from "./sales/SalesBoard";
import { MarketingBoard } from "./marketing/MarketingBoard";
import { FulfillmentBoard } from "./fulfillment/FulfillmentBoard";
import { AiCostBoard } from "./ai-cost/AiCostBoard";
import { AutomationHealthBoard } from "./automation-health/AutomationHealthBoard";
import { ToolsConnectorsBoard } from "./tools-connectors/ToolsConnectorsBoard";
import { HumanEmployeesBoard } from "./human-employees/HumanEmployeesBoard";

/** Everything a board component receives. Company id is always explicit. */
export interface DashboardBoardProps {
  companyId: string;
  period: DashboardPeriod;
}

/**
 * One board. All eight INC boards register here in `dashboards`;
 * the tab bar renders them in DASHBOARD_BOARD_ORDER.
 */
export interface DashboardBoard {
  /** URL segment: /INC/dashboard/<id> */
  id: string;
  title: string;
  component: ComponentType<DashboardBoardProps>;
}

/**
 * The eight boards and their tab order (mission: Lane 1 owns the shell).
 */
export const DASHBOARD_BOARD_ORDER = [
  { id: "ceo", title: "CEO" },
  { id: "sales", title: "Sales" },
  { id: "marketing", title: "Marketing" },
  { id: "fulfillment", title: "Fulfillment" },
  { id: "ai-cost", title: "AI cost" },
  { id: "automation-health", title: "Automation health" },
  { id: "tools-connectors", title: "Tools/connectors" },
  { id: "human-employees", title: "Human employees" },
] as const;

export type DashboardBoardId = (typeof DASHBOARD_BOARD_ORDER)[number]["id"];

export const DEFAULT_DASHBOARD_BOARD_ID: DashboardBoardId = "ceo";

/**
 * Registered boards (the tab bar uses DASHBOARD_BOARD_ORDER).
 */
export const dashboards: DashboardBoard[] = [
  { id: "ceo", title: "CEO", component: CeoBoard },
  { id: "sales", title: "Sales", component: SalesBoard },
  { id: "marketing", title: "Marketing", component: MarketingBoard },
  { id: "fulfillment", title: "Fulfillment", component: FulfillmentBoard },
  { id: "ai-cost", title: "AI cost", component: AiCostBoard },
  { id: "automation-health", title: "Automation health", component: AutomationHealthBoard },
  { id: "tools-connectors", title: "Tools/connectors", component: ToolsConnectorsBoard },
  { id: "human-employees", title: "Human employees", component: HumanEmployeesBoard },
];

export const dashboardRegistry = dashboards;
export default dashboards;

export function dashboardBoardMeta(id: string): { id: DashboardBoardId; title: string } | null {
  return DASHBOARD_BOARD_ORDER.find((board) => board.id === id) ?? null;
}

export function registeredDashboard(id: string): DashboardBoard | undefined {
  return dashboards.find((board) => board.id === id);
}

/** Boards whose tab renders "Being built" until a lane registers a component. */
export function unregisteredBoardIds(): string[] {
  return DASHBOARD_BOARD_ORDER
    .filter((board) => !registeredDashboard(board.id))
    .map((board) => board.id);
}
