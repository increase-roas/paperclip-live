import type {
  DashboardAiCostBoard,
  DashboardAutomationHealthBoard,
  DashboardBoard,
  DashboardBoardId,
  DashboardBoardMeta,
  DashboardFulfillmentBoard,
  DashboardPeriod,
  DashboardTileValue,
  DashboardToolsConnectorsBoard,
  ReadingOrderState,
  ReadingOrderStepId,
} from "@paperclipai/shared";
import { api } from "./client";

type ReadingOrderStatusMap = Partial<Record<ReadingOrderStepId, ReadingOrderState>>;

export interface CeoMoneyTile {
  id: string;
  label: string;
  periodLabel?: string;
  source: string;
  needs: string;
  target?: string;
  redLine?: string;
  href?: string;
  state?: ReadingOrderState;
  note?: string;
  value: DashboardTileValue;
}

export interface ReadingOrderMetric {
  displayValue?: string | null;
  value?: string | number | null;
  formatted?: string | null;
  label?: string | null;
  observedAt?: string | null;
}

export type ReadingOrderMetricMap = Partial<
  Record<ReadingOrderStepId, string | ReadingOrderMetric | null>
>;

export interface DashboardReadingOrderResponse {
  period?: DashboardPeriod;
  generatedAt?: string;
  statuses?: ReadingOrderStatusMap;
  readingOrder?: ReadingOrderStatusMap;
  metrics?: ReadingOrderMetricMap;
  readingOrderMetrics?: ReadingOrderMetricMap;
}

export interface DashboardCeoBoard {
  companyId: string;
  period?: DashboardPeriod;
  generatedAt: string;
  moneyTiles: CeoMoneyTile[];
  readingOrder?: ReadingOrderStatusMap;
  readingOrderMetrics?: ReadingOrderMetricMap;
}

export interface TeamMemberEditable {
  id: string;
  name: string;
  role: string;
  rateType: string;
  rateAmount: number | null;
  hoursPerMonth: number | null;
  monthlyEstimateUsd?: number | null;
  responsibilities?: string;
  instructions?: string;
  performanceCriteria: string;
  status: string;
}

export interface HumanEmployeesBoardMeta extends DashboardBoardMeta {
  monthlyLabor?: number | null;
  monthlyLaborCents?: number | null;
  monthlyOverhead?: number | null;
  monthlyOverheadCents?: number | null;
  monthlyBurn?: number | null;
  monthlyBurnCents?: number | null;
  runway?: number | null;
  cashOnHand?: number | null;
  cashOnHandCents?: number | null;
  capital?: {
    monthlyLabor?: number | null;
    monthlyLaborUsd?: number | null;
    monthlyOverhead?: number | null;
    monthlyOverheadUsd?: number | null;
    monthlyBurn?: number | null;
    monthlyBurnUsd?: number | null;
    runwayMonths?: number | null;
    runway?: number | null;
    cashOnHand?: number | null;
    cashOnHandUsd?: number | null;
  };
  settings?: {
    cashOnHand?: number | null;
    cashOnHandUsd?: number | null;
    monthlyOverhead?: number | null;
    monthlyOverheadUsd?: number | null;
    fixedMonthlyCostUsd?: number | null;
  };
  members?: TeamMemberEditable[];
}

export interface DashboardBoardWithMeta extends DashboardBoard {
  meta?: HumanEmployeesBoardMeta;
}

export interface TeamMemberUpdatePayload {
  id: string;
  name: string;
  role: string;
  rateType: string;
  rateAmount: number;
  hoursPerMonth: number | null;
  monthlyEstimateUsd?: number | null;
  responsibilities: string;
  instructions: string;
  performanceCriteria: string;
  status: "active" | "inactive";
}

export interface TeamCapitalSettingsPayload {
  cashOnHandUsd?: number | null;
  fixedMonthlyCostUsd?: number | null;
  defaultHoursPerMonth?: number;
  monthlyCapacityJobs?: number | null;
  monthlyRevenueTargetUsd?: number | null;
}

export interface TeamAdminSnapshotResponse {
  ok?: boolean;
  members?: TeamMemberEditable[];
  settings?: TeamCapitalSettingsPayload;
}

/**
 * Operating dashboard board reads and Team & capital updates. Each read is a
 * server-side aggregate; a tile with no source comes back as `notConnected` /
 * `not_connected` instead of a guessed number.
 */
export const dashboardBoardsApi = {
  ceo: (companyId: string, period: DashboardPeriod) =>
    api.get<DashboardCeoBoard>(
      `/companies/${companyId}/dashboards/ceo?period=${encodeURIComponent(period)}`,
    ),
  readingOrder: (companyId: string, period: DashboardPeriod) =>
    api.get<DashboardReadingOrderResponse>(
      `/companies/${companyId}/dashboards/reading-order?period=${encodeURIComponent(period)}`,
    ),
  lane2: (companyId: string, board: DashboardBoardId, period: DashboardPeriod) =>
    api.get<DashboardBoardWithMeta>(
      `/companies/${companyId}/dashboards/${board}?period=${encodeURIComponent(period)}`,
    ),
  aiCost: (companyId: string) =>
    api.get<DashboardAiCostBoard>(`/companies/${companyId}/dashboards/ai-cost`),
  automationHealth: (companyId: string) =>
    api.get<DashboardAutomationHealthBoard>(`/companies/${companyId}/dashboards/automation-health`),
  toolsConnectors: (companyId: string) =>
    api.get<DashboardToolsConnectorsBoard>(`/companies/${companyId}/dashboards/tools-connectors`),
  fulfillment: (companyId: string, period: DashboardPeriod = "30d") =>
    api.get<DashboardFulfillmentBoard>(
      `/companies/${companyId}/dashboards/fulfillment?period=${encodeURIComponent(period)}`,
    ),
  getTeamAdmin: () =>
    api.get<TeamAdminSnapshotResponse>("/sales-dashboard/team"),
  getTeamSettings: () =>
    api.get<
      ({ ok?: boolean; settings?: TeamCapitalSettingsPayload } & TeamCapitalSettingsPayload)
    >("/sales-dashboard/team/settings"),
  updateTeam: (payload: TeamMemberUpdatePayload) =>
    api.put<unknown>("/sales-dashboard/team", payload),
  updateTeamSettings: (payload: TeamCapitalSettingsPayload) =>
    api.put<unknown>("/sales-dashboard/team/settings", payload),
};
