/**
 * The period every dashboard tile is read for.
 *
 * Spec (DASHBOARD-SPEC.md §0) allows only these three views: last 7 days,
 * last 30 days, and the current calendar month. The period lives in the URL
 * (`?period=30d`) so a board someone is looking at can be sent to someone
 * else. A number without its period is not a number, so the picker value is
 * passed to every tile rather than held in component state.
 */
export const DASHBOARD_PERIODS = [
  { id: "7d", label: "7d" },
  { id: "30d", label: "30d" },
  { id: "month", label: "Month" },
] as const;

export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number]["id"];

/** 30 days is the CEO scorecard's primary view (cash collected, 30 days). */
export const DEFAULT_DASHBOARD_PERIOD: DashboardPeriod = "30d";

const PERIOD_LABELS: Record<DashboardPeriod, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  month: "Month to date",
};

export interface DashboardPeriodRange {
  from: Date;
  to: Date;
  fromIso: string;
  toIso: string;
  /** Human label for a tile ("Last 7 days"). */
  label: string;
}

export function isDashboardPeriod(value: unknown): value is DashboardPeriod {
  return DASHBOARD_PERIODS.some((period) => period.id === value);
}

/** Unknown or absent URL values fall back to the default view, never to a blank tile. */
export function parseDashboardPeriod(value: string | null | undefined): DashboardPeriod {
  return isDashboardPeriod(value) ? value : DEFAULT_DASHBOARD_PERIOD;
}

export function dashboardPeriodLabel(period: DashboardPeriod): string {
  return PERIOD_LABELS[period];
}

/**
 * Half-open at the start and open at the end (`to` is "now"), matching how the
 * cost summary filters by `occurredAt`.
 */
export function dashboardPeriodRange(
  period: DashboardPeriod,
  now: Date = new Date(),
): DashboardPeriodRange {
  const to = new Date(now);
  const from = period === "month"
    ? new Date(now.getFullYear(), now.getMonth(), 1)
    : new Date(now.getTime() - (period === "7d" ? 7 : 30) * 24 * 60 * 60 * 1000);

  return {
    from,
    to,
    fromIso: from.toISOString(),
    toIso: to.toISOString(),
    label: PERIOD_LABELS[period],
  };
}
