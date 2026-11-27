/**
 * Contract for the Increase ROAS operating dashboards.
 *
 * Two rules this contract enforces:
 * 1. A tile carries a live value with the time it was observed, or it carries
 *    no number at all and says honestly why: its source is not connected, the
 *    connected source has no data for the period, or Paperclip does not map
 *    that series yet. A board can never render a made-up number or a zero for
 *    a missing reading.
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
 * A tile value. Only `live` carries a number.
 * - `not_connected`: at least one of the tile's sources is disconnected; the
 *   board's source list names the credential that is needed.
 * - `no_data`: every source is connected, but the series is empty or the
 *   denominator is zero for this period. `reason` says which inputs are empty.
 * - `not_mapped`: every source is connected, but Paperclip does not read the
 *   series this tile needs yet. `missing` names what is not read.
 */
export type DashboardTileValue =
  | { kind: "not_connected" }
  | { kind: "no_data"; reason: string }
  | { kind: "not_mapped"; missing: string }
  | { kind: "live"; value: number; unit: DashboardUnit; observedAt: string };

export type DashboardTileValueKind = DashboardTileValue["kind"];

/**
 * Keeps a tile honest about its sources: a non-live tile reads
 * `not_connected` exactly when one of its sources is disconnected. A tile whose
 * sources are all connected never says "not connected"; an unexplained miss
 * becomes `not_mapped`.
 */
export function reconcileTileValue(
  value: DashboardTileValue,
  sourceIds: readonly DashboardSourceId[],
  sources: readonly Pick<DashboardSource, "id" | "name" | "status">[],
): DashboardTileValue {
  if (value.kind === "live") return value;
  const tileSources = sourceIds.map((id) => sources.find((source) => source.id === id));
  if (tileSources.length === 0 || tileSources.some((source) => !source || source.status !== "connected")) {
    return { kind: "not_connected" };
  }
  if (value.kind !== "not_connected") return value;
  const names = tileSources.map((source) => source!.name).join(" + ");
  return { kind: "not_mapped", missing: `Paperclip does not compute this number from ${names} yet.` };
}

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
  monthlyLaborUsd?: number | null;
  monthlyOverheadUsd?: number | null;
  monthlyBurnUsd?: number | null;
  runwayMonths?: number | null;
  cashOnHandUsd?: number | null;
  activeHeadcount?: number | null;
  totalHeadcount?: number | null;
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
