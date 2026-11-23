import type { ComponentType } from "react";
import { AiCostBoard } from "./ai-cost/AiCostBoard";
import { AutomationHealthBoard } from "./automation-health/AutomationHealthBoard";
import { ToolsConnectorsBoard } from "./tools-connectors/ToolsConnectorsBoard";
import { FulfillmentBoard } from "./fulfillment/FulfillmentBoard";

export interface DashboardRegistryEntry {
  id: string;
  title: string;
  component: ComponentType<{ companyId?: string }>;
}

/**
 * Lane 3 boards. Lane 1 owns the shell and combines the lane registries.
 * Keep the ids stable: they are the tab and URL identity.
 */
export const dashboards: DashboardRegistryEntry[] = [
  { id: "ai-cost", title: "AI cost", component: AiCostBoard },
  { id: "automation-health", title: "Automation health", component: AutomationHealthBoard },
  { id: "tools-connectors", title: "Tools & connectors", component: ToolsConnectorsBoard },
  { id: "fulfillment", title: "Fulfillment", component: FulfillmentBoard },
];

/** Alias so a shell that imports the generic name also finds the lane entries. */
export const dashboardRegistry = dashboards;

export default dashboards;
