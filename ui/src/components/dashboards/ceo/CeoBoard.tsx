import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { costsApi } from "@/api/costs";
import { approvalsApi } from "@/api/approvals";
import { issuesApi } from "@/api/issues";
import { describeError } from "@/api/errors";
import { queryKeys } from "@/lib/queryKeys";
import { formatCents, formatNumber } from "@/lib/utils";
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

const TILE_GRID = "grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4";

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
 * Live tiles read only what Paperclip itself records: run cost, approvals,
 * tasks. The money tiles name the source they need (GHL payments /
 * Authorize.net, GHL appointments, Meta spend, WAVV) and show no value, because
 * no read-only source for them exists in this repo yet. See spec v2 §11.
 */
export function CeoBoard({ companyId, period }: DashboardBoardProps) {
  // `now` is captured once per period so the query keys stay stable; the tile
  // footer shows the actual read time.
  const range = useMemo(() => dashboardPeriodRange(period), [period]);
  const monthRange = useMemo(() => dashboardPeriodRange("month"), []);

  const periodCosts = useQuery({
    queryKey: queryKeys.costs(companyId, range.fromIso, range.toIso),
    queryFn: () => costsApi.summary(companyId, range.fromIso, range.toIso),
  });
  const monthCosts = useQuery({
    queryKey: queryKeys.costs(companyId, monthRange.fromIso, monthRange.toIso),
    queryFn: () => costsApi.summary(companyId, monthRange.fromIso, monthRange.toIso),
    enabled: period !== "month",
  });
  const approvals = useQuery({
    queryKey: queryKeys.approvals.list(companyId, "pending"),
    queryFn: () => approvalsApi.list(companyId, "pending"),
  });
  const issues = useQuery({
    queryKey: queryKeys.issues.list(companyId),
    queryFn: () => issuesApi.list(companyId),
  });

  const costs = periodCosts.data;
  const costsError = periodCosts.error ? readFailure(periodCosts.error) : null;
  const costsReadAt = costs ? periodCosts.dataUpdatedAt : null;

  const pendingApprovals = approvals.data ?? [];
  const pendingCount = pendingApprovals.length;
  const oldestApproval = oldestPendingAgeHours(pendingApprovals);
  const approvalsError = approvals.error ? readFailure(approvals.error) : null;

  const tasks = countTaskStates(issues.data ?? []);
  const issuesError = issues.error ? readFailure(issues.error) : null;

  const monthCostData = period === "month" ? periodCosts.data : monthCosts.data;
  const monthCostError = period === "month" ? costsError : monthCosts.error ? readFailure(monthCosts.error) : null;
  const monthCostReadAt = monthCostData
    ? (period === "month" ? periodCosts.dataUpdatedAt : monthCosts.dataUpdatedAt)
    : null;
  const cap = capGuardrail(monthCostData?.spendCents ?? 0, monthCostData?.budgetCents ?? 0);

  const costNote = costsError
    ? `Could not read run costs: ${costsError}`
    : !costs
      ? "Reading run costs."
      : !costs.pricingComplete
        ? `${formatNumber(costs.unpricedEventCount)} unpriced, ${formatNumber(costs.pendingRunCount)} awaiting receipt. The total may be low.`
        : "Sum of completed agent run receipts.";

  return (
    <div className="space-y-6">
      <section aria-labelledby="ceo-scorecard-live">
        <SectionHeading
          id="ceo-scorecard-live"
          title="Live from Paperclip"
          description="The only numbers this company's control plane can answer today."
        />
        <div className={TILE_GRID}>
          <Tile
            testId="ceo-tile-agent-run-cost"
            label="AI spend on agent runs"
            value={!costs ? (costsError ? "—" : "…") : formatCents(costs.spendCents)}
            periodLabel={range.label}
            redLine="None on the total; the monthly cap guardrail below is the line"
            state="unknown"
            source="Paperclip run costs"
            readAt={costsReadAt}
            note={costNote}
          />
          <Tile
            testId="ceo-tile-approvals-waiting"
            label="Approvals waiting"
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
          title="Money"
          description="Read in the spec v2 §1 order. Each tile needs a read-only source before it can show a number."
        />
        <div className={TILE_GRID}>
          <NotConnected
            testId="ceo-tile-cash-collected"
            label="Cash collected, last 30 days"
            source="GHL payments / Authorize.net"
            periodLabel="Last 30 days"
            needs="Read-only GHL payments and Authorize.net settlement access."
            target="Below COGS + CAC for the same 30 days"
          />
          <NotConnected
            testId="ceo-tile-30-day-cash-multiple"
            label="30-day cash multiple"
            source="GHL payments + Authorize.net + Meta spend"
            periodLabel="Last 30 days"
            needs="30-day cash collected ÷ (CAC + COGS). Cash comes from GHL payments and Authorize.net; CAC includes Meta spend."
            target="At least 2.0 — $2 of cash inside 30 days for every $1 spent to acquire and deliver"
          />
          <NotConnected
            testId="ceo-tile-ltgp-cac"
            label="LTGP : CAC, portfolio"
            source="Client revenue history + ad and sales cost"
            periodLabel="Portfolio, all time"
            needs="Lifetime gross profit per client joined to the cost of acquiring that client."
            target="12:1 target with people at lead gen, sales and delivery — 3:1 all automated, 6:1 one manual, 9:1 two manual, 12:1 all three manual"
          />
          <NotConnected
            testId="ceo-tile-gross-margin"
            label="Gross margin, agency blended"
            source="GHL payments / Authorize.net + payroll and contractor ledger"
            periodLabel={range.label}
            needs="Revenue per client plus direct delivery cost: setters, media buyer, CSM, editors, contractors."
            target="At least 50% (Hormozi: at 50% gross margin there is no room for any other cost)"
          />
          <NotConnected
            testId="ceo-tile-churn"
            label="Client churn / net revenue retention"
            source="GHL subscription state + Authorize.net"
            periodLabel="Monthly and trailing 12 months"
            needs="Clients lost and revenue retained, including expansion."
            target="Under 3% per month and at least 80% per year"
          />
          <NotConnected
            testId="ceo-tile-cac-payback"
            label="CAC payback"
            source="Billing dates + acquisition cost"
            periodLabel="Per client cohort, all time"
            needs="The date each client's collected gross profit covers what it cost to acquire them."
            target="30 days or less; over 60 days red"
          />
          <NotConnected
            testId="ceo-tile-cost-per-held-appointment"
            label="Cost per held appointment"
            source="Meta spend + GHL appointments"
            periodLabel={range.label}
            needs="Ad spend and setter cost joined to appointments actually held."
            target="Under job value × close rate × margin ÷ 3"
          />
          <NotConnected
            testId="ceo-tile-show-rate"
            label="Show rate"
            source="GHL appointments"
            periodLabel={range.label}
            needs="Appointment status per client: booked versus held."
            target="70–80% healthy; below 60% red"
          />
          <NotConnected
            testId="ceo-tile-speed-to-lead"
            label="Speed to lead"
            source="GHL leads + WAVV calls"
            periodLabel={range.label}
            needs="Lead created timestamp joined to the first outbound call attempt."
            target="Under 60 seconds; over 5 minutes red"
          />
        </div>
      </section>

      <section aria-labelledby="ceo-guardrails">
        <SectionHeading
          id="ceo-guardrails"
          title="Guardrails"
          description="Alarm lights, not scorecard rows (spec §3). They stay visible whatever the period."
        />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Tile
            testId="ceo-guardrail-ai-cap"
            label="AI spend vs monthly cap"
            value={
              monthCostError
                ? "—"
                : !monthCostData
                  ? "…"
                  : cap.utilizationPercent === null
                    ? "No cap"
                    : `${formatNumber(cap.utilizationPercent, { maximumFractionDigits: 1 })}%`
            }
            periodLabel="Month to date"
            redLine="Alert at 80% of cap; hard stop at 100%"
            state={monthCostError || !monthCostData ? "unknown" : cap.state}
            source="Paperclip budgets"
            readAt={monthCostReadAt}
            note={
              monthCostError
                ? `Could not read the monthly cap: ${monthCostError}`
                : monthCostData
                  ? `${formatCents(monthCostData.spendCents)} of ${formatCents(monthCostData.budgetCents)}. ${cap.note}`
                  : "Reading the monthly cap."
            }
          />
          <NotConnected
            testId="ceo-guardrail-zero-lead-spend"
            label="Ad spend with zero leads"
            source="Meta spend + GHL leads"
            periodLabel="Last 7 days"
            needs="Client-days with more than $100 spend and no new lead recorded. Meta is read through the Meta CLI or Paperclip's Composio connection, never a browser."
            target="Any client-day with spend over $100 and zero leads"
          />
        </div>
      </section>
    </div>
  );
}
