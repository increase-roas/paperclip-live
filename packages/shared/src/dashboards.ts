/**
 * Contract for the Increase ROAS operating dashboards.
 *
 * Two rules this contract enforces:
 * 1. A tile either carries a live value with the time it was observed, or it
 *    carries no value at all and names the source that is missing. There is no
 *    third state, so a board cannot render a made-up number.
 * 2. Anything per client or per team member carries the id of that client or
 *    member, so two scopes can never be summed by accident.
 */

/** Boards owned by lane 2. The shell registry combines these with the rest. */
export const DASHBOARD_BOARD_IDS = ["sales", "marketing", "human-employees"] as const;
export type DashboardBoardId = (typeof DASHBOARD_BOARD_IDS)[number];

export function isDashboardBoardId(value: string): value is DashboardBoardId {
  return (DASHBOARD_BOARD_IDS as readonly string[]).includes(value);
}

/** Read-only systems a board tile can draw from. */
export const DASHBOARD_SOURCE_IDS = ["ghl", "wavv", "meta_ads", "team_capital"] as const;
export type DashboardSourceId = (typeof DASHBOARD_SOURCE_IDS)[number];

export type DashboardSourceStatus = "connected" | "not_connected";

/**
 * One external system. `detail` states what is true today and `needed` states
 * exactly what a person must provide to connect it. Paperclip never creates
 * that credential on its own.
 */
export interface DashboardSource {
  id: DashboardSourceId;
  /** Exact product name shown to the reader, e.g. "GoHighLevel (GHL)". */
  name: string;
  status: DashboardSourceStatus;
  detail: string;
  needed: string;
  lastSuccessfulSync: string | null;
}

export type DashboardUnit =
  | "count"
  | "percent"
  | "usd"
  | "ratio"
  | "seconds"
  | "minutes"
  | "hours"
  | "days";

/**
 * A tile value is either live or absent. `not_connected` carries no numeric
 * field by design: a missing source can never render as zero.
 */
export type DashboardTileValue =
  | { kind: "not_connected" }
  | { kind: "live"; value: number; unit: DashboardUnit; observedAt: string };

export interface DashboardTile {
  id: string;
  label: string;
  /** How the number is calculated, in plain words. */
  definition: string;
  /** The person accountable for the number. */
  owner: string;
  /** Green/red line from the dashboard spec. */
  target: string;
  sourceIds: DashboardSourceId[];
  value: DashboardTileValue;
}

export interface DashboardTableColumn {
  key: string;
  label: string;
}

export interface DashboardTableRow {
  /** Client id when scope is "client", team-member id when scope is "member". */
  id: string;
  cells: Record<string, string | number | null>;
}

export interface DashboardTable {
  id: string;
  title: string;
  description: string;
  /** What one row represents. */
  scope: "client" | "member";
  sourceIds: DashboardSourceId[];
  columns: DashboardTableColumn[];
  rows: DashboardTableRow[];
}

export interface DashboardBoardMeta {
  monthlyLaborUsd?: number;
  monthlyOverheadUsd?: number;
  monthlyBurnUsd?: number;
  runwayMonths?: number | null;
  activeHeadcount?: number;
  totalHeadcount?: number;
}

export interface DashboardBoard {
  board: DashboardBoardId;
  /** The company the payload was built for; every row is scoped to it. */
  companyId: string;
  generatedAt: string;
  sources: DashboardSource[];
  tiles: DashboardTile[];
  tables: DashboardTable[];
  meta?: DashboardBoardMeta;
}

export const DASHBOARD_PERIOD_IDS = ["7d", "30d", "month"] as const;
export type DashboardPeriod = (typeof DASHBOARD_PERIOD_IDS)[number];

export function isDashboardPeriod(value: unknown): value is DashboardPeriod {
  return typeof value === "string" && (DASHBOARD_PERIOD_IDS as readonly string[]).includes(value);
}

export type ReadingOrderStepId =
  | "cash"
  | "cash-multiple"
  | "ltgp-cac"
  | "gross-margin"
  | "churn"
  | "show-rate"
  | "speed-to-lead"
  | "cac";

export type ReadingOrderState = "ok" | "red" | "unknown";

export interface CeoMoneyTile {
  id:
    | "cash-collected"
    | "30-day-cash-multiple"
    | "ltgp-cac"
    | "gross-margin"
    | "churn"
    | "cac-payback";
  label: string;
  periodLabel: string;
  source: string;
  target: string;
  needs: string;
  href?: string;
  state: ReadingOrderState;
  value: DashboardTileValue;
  note?: string;
}

export interface DashboardCeoBoard {
  companyId: string;
  period: DashboardPeriod;
  generatedAt: string;
  moneyTiles: CeoMoneyTile[];
  readingOrder: Partial<Record<ReadingOrderStepId, ReadingOrderState>>;
  readingOrderMetrics: Partial<
    Record<ReadingOrderStepId, { displayValue: string; observedAt: string | null }>
  >;
}

export interface DashboardReadingOrderPayload {
  companyId: string;
  period: DashboardPeriod;
  generatedAt: string;
  statuses: Partial<Record<ReadingOrderStepId, ReadingOrderState>>;
  metrics: Partial<
    Record<ReadingOrderStepId, { displayValue: string; observedAt: string | null }>
  >;
}
