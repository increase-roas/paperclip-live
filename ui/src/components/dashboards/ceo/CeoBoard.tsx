import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { costsApi } from "@/api/costs";
import { approvalsApi } from "@/api/approvals";
import { issuesApi } from "@/api/issues";
import { dashboardBoardsApi, type CeoMoneyTile } from "@/api/dashboardBoards";
import { describeError } from "@/api/errors";
import { queryKeys } from "@/lib/queryKeys";
import { formatCents, formatNumber } from "@/lib/utils";
import { formatTileValue } from "../lane2-shared/formatTileValue";
import { dashboardPeriodRange } from "../period";
import { Tile } from "../Tile";
import { NotConnected } from "../NotConnected";
import type { DashboardBoardProps } from "../registry";
import {
  approvalGuardrail,
  blockedGuardrail,
  capGuardrail,
  countTaskStates,
  formatAgeHours,
  oldestPendingAgeHours,
} from "./ceo-metrics";

const LIVE_TILE_GRID = "grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4";
const MONEY_TILE_GRID = "grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3";

const CORE_CEO_MONEY_TILE_IDS = [
  "cash-collected",
  "30-day-cash-multiple",
  "ltgp-cac",
  "gross-margin",
  "churn",
  "cac-payback",
] as const;

function buildDefaultMoneyTiles(periodLabel: string): CeoMoneyTile[] {
  return [
    {
      id: "cash-collected",
      label: "Cash collected, last 30 days",
      source: "Agency QuickBooks Online (Settings → Gateway Access)",
      periodLabel: "Last 30 days",
      needs:
        "Click Connect on QuickBooks Online in Settings → Gateway Access to pull read-only agency P&L and payments. Kept strictly separate from client CRM/ad revenue.",
      target: "Must cover agency COGS + CAC for the same 30 days",
      value: { kind: "not_connected" },
    },
    {
      id: "30-day-cash-multiple",
      label: "30-day cash multiple",
      source: "Agency QuickBooks Online + agency CAC & COGS",
      periodLabel: "Last 30 days",
      needs:
        "Agency 30-day cash collected ÷ (agency CAC + delivery COGS). Click Connect on QuickBooks Online in Settings → Gateway Access — never mixed with client P&L.",
      target: "At least 2.0 — $2 of cash inside 30 days for every $1 spent to acquire and deliver",
      value: { kind: "not_connected" },
    },
    {
      id: "ltgp-cac",
      label: "LTGP : CAC, portfolio",
      source: "Agency QuickBooks Online + acquisition cost",
      periodLabel: "Portfolio, all time",
      needs:
        "Click Connect on QuickBooks Online in Settings → Gateway Access joined to agency acquisition cost.",
      target:
        "12:1 target with people at lead gen, sales and delivery — 3:1 all automated, 6:1 one manual, 9:1 two manual, 12:1 all three manual",
      value: { kind: "not_connected" },
    },
    {
      id: "gross-margin",
      label: "Gross margin, agency blended",
      source: "Agency QuickBooks Online + payroll & contractor ledger",
      periodLabel,
      needs:
        "Agency collected revenue minus direct delivery COGS. Click Connect on QuickBooks Online in Settings → Gateway Access plus Team & capital labor costs.",
      target: "At least 50% (Hormozi: at 50% gross margin there is no room for any other cost)",
      value: { kind: "not_connected" },
    },
    {
      id: "churn",
      label: "Client churn / NRR",
      source: "Agency subscription state (QBO / Authorize.net)",
      periodLabel: "Monthly and trailing 12 months",
      needs:
        "Connect read-only agency recurring billing (Authorize.net ARB or QBO recurring invoices) to track clients lost and net revenue retained.",
      target: "Under 3% per month and at least 80% per year",
      href: "/dashboard/fulfillment",
      value: { kind: "not_connected" },
    },
    {
      id: "cac-payback",
      label: "CAC payback",
      source: "Agency QuickBooks billing dates + acquisition cost",
      periodLabel: "Per client cohort, all time",
      needs:
        "Click Connect on QuickBooks Online in Settings → Gateway Access joined to agency acquisition spend to measure days until gross profit covers CAC.",
      target: "30 days or less; over 60 days red",
      value: { kind: "not_connected" },
    },
  ];
}

function SectionHeading({ id, title, description }: { id: string; title: string; description?: string }) {
  return (
    <div className="mb-3">
      <h2 id={id} className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
    </div>
  );
}

function readFailure(error: unknown): string {
  return describeError(error).body;
}

/**
 * CEO board (DASHBOARD-SPEC-v2-hormozi.md §3, read in the §1 order).
 *
 * Strictly CEO-level numbers: 4 live Paperclip control-plane tiles (each
 * linking to its drill-down) and the 6 core agency money metrics. Sales and
 * Marketing metrics live on their own tabs and in the ReadingOrderStrip above.
 */
export function CeoBoard({ companyId, period }: DashboardBoardProps) {
  const range = useMemo(() => dashboardPeriodRange(period), [period]);
  const monthRange = useMemo(() => dashboardPeriodRange("month"), []);

  const monthCosts = useQuery({
    queryKey: queryKeys.costs(companyId, monthRange.fromIso, monthRange.toIso),
    queryFn: () => costsApi.summary(companyId, monthRange.fromIso, monthRange.toIso),
  });
  const approvals = useQuery({
    queryKey: queryKeys.approvals.list(companyId, "pending"),
    queryFn: () => approvalsApi.list(companyId, "pending"),
  });
  const issues = useQuery({
    queryKey: queryKeys.issues.list(companyId),
    queryFn: () => issuesApi.list(companyId),
  });
  const ceoBoardQuery = useQuery({
    queryKey: ["dashboard-boards", companyId, "ceo", period],
    queryFn: async () => {
      try {
        return await dashboardBoardsApi.ceo(companyId, period);
      } catch {
        return null;
      }
    },
    retry: false,
    staleTime: 60_000,
  });

  const monthCostData = monthCosts.data;
  const monthCostError = monthCosts.error ? readFailure(monthCosts.error) : null;
  const monthCostReadAt = monthCostData ? monthCosts.dataUpdatedAt : null;
  const cap = capGuardrail(monthCostData?.spendCents ?? 0, monthCostData?.budgetCents ?? 0);

  const pendingApprovals = approvals.data ?? [];
  const pendingCount = pendingApprovals.length;
  const oldestApproval = oldestPendingAgeHours(pendingApprovals);
  const approvalsError = approvals.error ? readFailure(approvals.error) : null;

  const tasks = countTaskStates(issues.data ?? []);
  const issuesError = issues.error ? readFailure(issues.error) : null;

  const moneyTiles = useMemo(() => {
    const defaults = buildDefaultMoneyTiles(range.label);
    const liveById = new Map<string, CeoMoneyTile>();
    for (const tile of ceoBoardQuery.data?.moneyTiles ?? []) {
      liveById.set(tile.id, tile);
    }
    return CORE_CEO_MONEY_TILE_IDS.map((id) => {
      const fallback = defaults.find((item) => item.id === id)!;
      const incoming = liveById.get(id);
      if (!incoming) return fallback;
      return {
        ...fallback,
        ...incoming,
        href: incoming.href ?? fallback.href,
        periodLabel: incoming.periodLabel ?? fallback.periodLabel,
        target: incoming.target ?? fallback.target,
      };
    });
  }, [ceoBoardQuery.data?.moneyTiles, range.label]);

  const aiSpendCapValue = monthCostError ? (
    "—"
  ) : !monthCostData ? (
    "…"
  ) : cap.utilizationPercent === null ? (
    <span>{formatCents(monthCostData.spendCents)}</span>
  ) : (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
      <span>{formatCents(monthCostData.spendCents)}</span>
      <span className="text-base font-normal text-muted-foreground">
        / {formatCents(monthCostData.budgetCents)} (
        {formatNumber(cap.utilizationPercent, { maximumFractionDigits: 1 })}%)
      </span>
    </span>
  );

  const aiSpendCapNote = monthCostError
    ? `Could not read the monthly cap: ${monthCostError}`
    : !monthCostData
      ? "Reading the monthly cap."
      : !monthCostData.pricingComplete
        ? `${cap.note} ${formatNumber(monthCostData.unpricedEventCount)} unpriced, ${formatNumber(monthCostData.pendingRunCount)} awaiting receipt.`
        : cap.note;

  return (
    <div className="space-y-6">
      <section aria-labelledby="ceo-scorecard-live">
        <SectionHeading
          id="ceo-scorecard-live"
          title="Live from Paperclip"
          description="Control-plane spend, approvals, and execution health. Click any card to inspect."
        />
        <div className={LIVE_TILE_GRID}>
          <Tile
            testId="ceo-tile-ai-spend-cap"
            label="AI spend vs monthly cap"
            href="/dashboard/ai-cost"
            value={aiSpendCapValue}
            periodLabel="Month to date"
            redLine="Alert at 80% of cap; hard stop at 100%"
            state={monthCostError || !monthCostData ? "unknown" : cap.state}
            source="Paperclip budgets & run costs"
            readAt={monthCostReadAt}
            note={aiSpendCapNote}
          />
          <Tile
            testId="ceo-tile-approvals-waiting"
            label="Approvals waiting"
            href="/decisions"
            value={approvalsError ? "—" : !approvals.data ? "…" : formatNumber(pendingCount)}
            periodLabel="Right now"
            redLine="Under 4 hours in business hours; red past 24 hours"
            state={approvalsError || !approvals.data ? "unknown" : approvalGuardrail(oldestApproval)}
            source="Paperclip approvals"
            readAt={approvals.data ? approvals.dataUpdatedAt : null}
            note={
              approvalsError
                ? `Could not read approvals: ${approvalsError}`
                : !approvals.data
                  ? "Reading approvals."
                  : `Oldest waiting ${formatAgeHours(oldestApproval)}.`
            }
          />
          <Tile
            testId="ceo-tile-open-tasks"
            label="Open tasks"
            href="/issues"
            value={issuesError ? "—" : !issues.data ? "…" : formatNumber(tasks.open)}
            periodLabel="Right now"
            redLine="No target yet; watch the weekly change"
            state="unknown"
            source="Paperclip tasks"
            readAt={issues.data ? issues.dataUpdatedAt : null}
            note={
              issuesError
                ? `Could not read tasks: ${issuesError}`
                : !issues.data
                  ? "Reading tasks."
                  : `${formatNumber(tasks.inProgress)} in progress, blocked tasks included above.`
            }
          />
          <Tile
            testId="ceo-tile-blocked-tasks"
            label="Blocked tasks"
            href="/issues?view=needs_attention"
            value={issuesError ? "—" : !issues.data ? "…" : formatNumber(tasks.blocked)}
            periodLabel="Right now"
            redLine="Zero; any blocked task escalates to Javar"
            state={issuesError || !issues.data ? "unknown" : blockedGuardrail(tasks.blocked)}
            source="Paperclip tasks"
            readAt={issues.data ? issues.dataUpdatedAt : null}
            note={
              issuesError
                ? `Could not read tasks: ${issuesError}`
                : !issues.data
                  ? "Reading tasks."
                  : "A blocked task is work nobody is doing."
            }
          />
        </div>
      </section>

      <section aria-labelledby="ceo-money">
        <SectionHeading
          id="ceo-money"
          title="Money (6 core CEO metrics)"
          description="Agency-level P&L and retention in spec v2 §1 order. Client funnel metrics stay on Sales and Marketing and never mix into agency revenue."
        />
        <div className={MONEY_TILE_GRID}>
          {moneyTiles.map((tile) =>
            tile.value.kind === "live" ? (
              <Tile
                key={tile.id}
                testId={`ceo-tile-${tile.id}`}
                label={tile.label}
                value={formatTileValue(tile.value)}
                periodLabel={tile.periodLabel ?? range.label}
                redLine={tile.redLine ?? tile.target}
                state={tile.state ?? "unknown"}
                source={tile.source}
                readAt={tile.value.observedAt}
                note={tile.note}
                href={tile.href}
              />
            ) : (
              <NotConnected
                key={tile.id}
                testId={`ceo-tile-${tile.id}`}
                label={tile.label}
                source={tile.source}
                periodLabel={tile.periodLabel ?? range.label}
                needs={tile.needs}
                target={tile.redLine ?? tile.target}
                href={tile.href}
              />
            ),
          )}
        </div>
      </section>
    </div>
  );
}
