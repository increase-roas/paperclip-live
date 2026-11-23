import type { ComponentType } from "react";
import { HumanEmployeesBoard } from "./human-employees/HumanEmployeesBoard";
import { MarketingBoard } from "./marketing/MarketingBoard";
import { SalesBoard } from "./sales/SalesBoard";

export interface DashboardBoardEntry {
  id: string;
  title: string;
  component: ComponentType;
}

/**
 * Lane 2's boards. Lane 1 owns the shell registry; on merge these three lines
 * join its array. Each board accepts the shell's `companyId` prop and falls
 * back to the selected company when rendered on its own.
 */
export const dashboards: DashboardBoardEntry[] = [
  { id: "sales", title: "Sales", component: SalesBoard },
  { id: "marketing", title: "Marketing", component: MarketingBoard },
  { id: "human-employees", title: "Human employees", component: HumanEmployeesBoard },
];
