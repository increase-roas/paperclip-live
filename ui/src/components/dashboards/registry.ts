import type { ComponentType } from "react";
import type { DashboardPeriod } from "./period";
import { CeoBoard } from "./ceo/CeoBoard";
import { SalesBoard } from "./sales/SalesBoard";
import { MarketingBoard } from "./marketing/MarketingBoard";
import { HumanEmployeesBoard } from "./human-employees/HumanEmployeesBoard";

/** Everything a board component receives. Company id is always explicit. */
export interface DashboardBoardProps {
  companyId: string;
  period: DashboardPeriod;
}

/**
 * One board. Lanes 2 and 3 register their board here with a single line in
 * `dashboards`; the tab bar renders whatever is registered and shows
 * "Being built" for the rest.
 */
export interface DashboardBoard {
  /** URL segment: /INC/dashboard/<id> */
  id: string;
  title: string;
  component: ComponentType<DashboardBoardProps>;
}

/**
 * The eight boards and their tab order (mission: Lane 1 owns the shell).
 * A board id appears here before it has a component, so the tab exists from
 * day one and fills in when its lane registers.
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
 * Registered boards, in no particular order (the tab bar uses
 * DASHBOARD_BOARD_ORDER). Add one line per board — do not reorder.
 */
export const dashboards: DashboardBoard[] = [
  { id: "ceo", title: "CEO", component: CeoBoard },
  { id: "sales", title: "Sales", component: SalesBoard },
  { id: "marketing", title: "Marketing", component: MarketingBoard },
  { id: "human-employees", title: "Human employees", component: HumanEmployeesBoard },
];

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
