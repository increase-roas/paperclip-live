import { Router, type Request, type Response } from "express";
import {
  isDashboardPeriod,
  type CeoMoneyTile,
  type DashboardCeoBoard,
  type DashboardPeriod,
  type DashboardReadingOrderPayload,
  type DashboardTileValue,
  type ReadingOrderState,
  type ReadingOrderStepId,
} from "@paperclipai/shared";
import { assertCompanyAccess } from "../routes/authz.js";
import {
  readPortfolioSnapshotBundle,
  type CapitalMetricsPayload,
  type PortfolioSnapshotBundle,
  type SalesDashboardClientOptions,
} from "./sales-dashboard-client.js";

const PERIOD_LABELS: Record<DashboardPeriod, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  month: "Month to date",
};

function parsePeriodQuery(raw: unknown): DashboardPeriod {
  return isDashboardPeriod(raw) ? raw : "30d";
}

function notConnected(): DashboardTileValue {
  return { kind: "not_connected" };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizePercent(raw: number | null): number | null {
  if (raw === null) return null;
  // capital.ts computes ratios in 0..1 (e.g. 0.62 -> 62.0%)
  if (raw > -1 && raw <= 1 && raw !== 0) return round1(raw * 100);
  return round1(raw);
}

function formatUsd(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function pickPrimaryFinancials(bundle: PortfolioSnapshotBundle): CapitalMetricsPayload | null {
  const owner = bundle.capital?.owner;
  if (owner) {
    if (owner.marketing?.evidence?.financial) return owner.marketing;
    if (owner.financialMonth?.evidence?.financial) return owner.financialMonth;
    if ((owner.marketing?.cashCollectedUsd ?? 0) > 0) return owner.marketing;
    if ((owner.financialMonth?.cashCollectedUsd ?? 0) > 0) return owner.financialMonth;
  }
  for (const client of bundle.capital?.clients ?? []) {
    if (client.marketing?.evidence?.financial) return client.marketing;
    if (client.financialMonth?.evidence?.financial) return client.financialMonth;
  }
  return owner?.marketing ?? null;
}

export function buildCeoAndReadingOrder(
  companyId: string,
  period: DashboardPeriod,
  bundle: PortfolioSnapshotBundle,
  now: Date,
): { ceo: DashboardCeoBoard; readingOrder: DashboardReadingOrderPayload } {
  const generatedAt = now.toISOString();
  const periodLabel = PERIOD_LABELS[period];
  const observedAt = bundle.observedAt ?? bundle.capital?.generatedAt ?? null;
  const fin = pickPrimaryFinancials(bundle);

  // Aggregate portfolio totals across clients
  let totalCashCollected = 0;
  let hasCashCollected = false;
  let totalAdSpend = 0;
  let hasAdSpend = false;
  let totalBooked = 0;
  let totalShowed = 0;
  let hasBooked = false;
  let hasShowed = false;
  let totalWon = 0;
  let hasWon = false;
  let speedToLeadSum = 0;
  let speedToLeadCount = 0;

  for (const client of bundle.clients) {
    if (client.cashCollectedUsd !== null && client.cashCollectedUsd > 0) {
      totalCashCollected += client.cashCollectedUsd;
      hasCashCollected = true;
    }
    if (client.spend !== null) {
      totalAdSpend += client.spend;
      hasAdSpend = true;
    }
    if (client.booked !== null) {
      totalBooked += client.booked;
      hasBooked = true;
    }
    if (client.showed !== null) {
      totalShowed += client.showed;
      hasShowed = true;
    }
    if (client.wonDeals !== null) {
      totalWon += client.wonDeals;
      hasWon = true;
    }
    if (client.speedToLeadSeconds !== null && client.speedToLeadSeconds >= 0) {
      speedToLeadSum += client.speedToLeadSeconds;
      speedToLeadCount += 1;
    }
  }

  // Prefer explicit agency/owner financial cash when positive; else portfolio cash if positive
  const finCash = finite(fin?.cashCollectedUsd);
  const cashCollectedUsd =
    finCash !== null && finCash > 0
      ? finCash
      : hasCashCollected && totalCashCollected > 0
        ? round2(totalCashCollected)
        : null;

  const expensesUsd = finite(fin?.expensesUsd);
  const grossMarginRaw = finite(fin?.grossMarginPercent);
  const grossMarginPct =
    fin?.evidence?.financial && grossMarginRaw !== null
      ? normalizePercent(grossMarginRaw)
      : null;

  const cacUsd =
    hasAdSpend && hasWon && totalWon > 0
      ? round2(totalAdSpend / totalWon)
      : finite(fin?.cacUsd);
  const grossProfitPerWon = finite(fin?.grossProfitPerWonDealUsd);
  const cacPaybackDeals = finite(fin?.cacPaybackDeals);

  // 1. Cash collected
  const cashValue: DashboardTileValue =
    cashCollectedUsd !== null && observedAt
      ? { kind: "live", value: cashCollectedUsd, unit: "usd", observedAt }
      : notConnected();
  const cashState: ReadingOrderState =
    cashCollectedUsd === null
      ? "unknown"
      : expensesUsd !== null && cashCollectedUsd < expensesUsd
        ? "red"
        : "ok";

  // 2. 30-day cash multiple = cash / (COGS + CAC)
  const operatingBurn = finite(bundle.capital?.operating?.monthlyBurnUsd);
  const cashMultipleDenominator =
    expensesUsd !== null && expensesUsd > 0
      ? expensesUsd + (hasAdSpend ? totalAdSpend : 0)
      : fin?.evidence?.financial && operatingBurn !== null && operatingBurn > 0
        ? operatingBurn + (hasAdSpend ? totalAdSpend : 0)
        : null;
  const cashMultiple =
    cashCollectedUsd !== null &&
    cashMultipleDenominator !== null &&
    cashMultipleDenominator > 0
      ? round2(cashCollectedUsd / cashMultipleDenominator)
      : null;
  const cashMultipleValue: DashboardTileValue =
    cashMultiple !== null && observedAt
      ? { kind: "live", value: cashMultiple, unit: "ratio", observedAt }
      : notConnected();
  const cashMultipleState: ReadingOrderState =
    cashMultiple === null ? "unknown" : cashMultiple >= 2 ? "ok" : "red";

  // 3. LTGP : CAC
  const ltgpToCac =
    grossProfitPerWon !== null && grossProfitPerWon > 0 && cacUsd !== null && cacUsd > 0
      ? round2(grossProfitPerWon / cacUsd)
      : null;
  const ltgpCacValue: DashboardTileValue =
    ltgpToCac !== null && observedAt
      ? { kind: "live", value: ltgpToCac, unit: "ratio", observedAt }
      : notConnected();
  const ltgpCacState: ReadingOrderState =
    ltgpToCac === null ? "unknown" : ltgpToCac >= 3 ? "ok" : "red";

  // 4. Gross margin
  const grossMarginValue: DashboardTileValue =
    grossMarginPct !== null && observedAt
      ? { kind: "live", value: grossMarginPct, unit: "percent", observedAt }
      : notConnected();
  const grossMarginState: ReadingOrderState =
    grossMarginPct === null ? "unknown" : grossMarginPct >= 50 ? "ok" : "red";

  // 5. Churn (requires subscription retention ledger — honestly not_connected today)
  const churnValue: DashboardTileValue = notConnected();
  const churnState: ReadingOrderState = "unknown";

  // 6. CAC payback
  const cacPaybackValue: DashboardTileValue =
    cacPaybackDeals !== null && observedAt
      ? { kind: "live", value: cacPaybackDeals, unit: "ratio", observedAt }
      : notConnected();
  const cacPaybackState: ReadingOrderState =
    cacPaybackDeals === null ? "unknown" : cacPaybackDeals <= 1 ? "ok" : "red";

  // 7. Show rate (for reading order)
  const fallbackShowRate = bundle.clients.find((c) => c.showRate !== null)?.showRate ?? null;
  const showRatePct =
    hasBooked && totalBooked > 0 && hasShowed
      ? round1((totalShowed / totalBooked) * 100)
      : fallbackShowRate;
  const showRateState: ReadingOrderState =
    showRatePct === null
      ? "unknown"
      : showRatePct >= 70
        ? "ok"
        : showRatePct < 60
          ? "red"
          : "ok";

  // 8. Speed to lead (for reading order)
  const speedToLeadSec =
    speedToLeadCount > 0 ? Math.round(speedToLeadSum / speedToLeadCount) : null;
  const speedToLeadState: ReadingOrderState =
    speedToLeadSec === null
      ? "unknown"
      : speedToLeadSec < 60
        ? "ok"
        : speedToLeadSec > 300
          ? "red"
          : "ok";

  // 9. CAC (for reading order)
  const cacStepState: ReadingOrderState =
    cacUsd !== null && totalWon > 0 ? "ok" : "unknown";

  const moneyTiles: CeoMoneyTile[] = [
    {
      id: "cash-collected",
      label: "Cash collected",
      periodLabel,
      source: "QuickBooks / GHL payments / Authorize.net",
      target: "Exceeds COGS + CAC for the same period",
      needs: "Read-only QuickBooks, GHL payments, or Authorize.net settlement access.",
      href: "/dashboards/sales",
      state: cashState,
      value: cashValue,
      ...(cashCollectedUsd !== null && expensesUsd !== null
        ? { note: `Expenses ${formatUsd(expensesUsd)} in the same window.` }
        : {}),
    },
    {
      id: "30-day-cash-multiple",
      label: "30-day cash multiple",
      periodLabel,
      source: "GHL payments + QuickBooks + Meta spend",
      target: "At least 2.0 — $2 of cash inside 30 days for every $1 spent to acquire and deliver",
      needs: "30-day cash collected ÷ (CAC + COGS).",
      state: cashMultipleState,
      value: cashMultipleValue,
    },
    {
      id: "ltgp-cac",
      label: "LTGP : CAC, portfolio",
      periodLabel: "Portfolio, all time",
      source: "Client revenue history + ad and sales cost",
      target:
        "12:1 target with people at lead gen, sales and delivery — 3:1 all automated, 6:1 one manual, 9:1 two manual",
      needs: "Lifetime gross profit per client joined to the cost of acquiring that client.",
      state: ltgpCacState,
      value: ltgpCacValue,
    },
    {
      id: "gross-margin",
      label: "Gross margin, agency blended",
      periodLabel,
      source: "QuickBooks / GHL payments + payroll and contractor ledger",
      target: "At least 50% (Hormozi: below 50% gross margin there is no room for any other cost)",
      needs: "Revenue per client plus direct delivery cost: setters, media buyer, CSM, editors, contractors.",
      state: grossMarginState,
      value: grossMarginValue,
    },
    {
      id: "churn",
      label: "Client churn / net revenue retention",
      periodLabel: "Monthly and trailing 12 months",
      source: "GHL subscription state + Authorize.net",
      target: "Under 3% per month and at least 80% per year",
      needs: "Clients lost and revenue retained, including expansion.",
      href: "/dashboards/fulfillment",
      state: churnState,
      value: churnValue,
    },
    {
      id: "cac-payback",
      label: "CAC payback",
      periodLabel: "Per client cohort, all time",
      source: "Billing dates + acquisition cost",
      target: "30 days or less; over 60 days red",
      needs: "The date each client's collected gross profit covers what it cost to acquire them.",
      href: "/dashboards/marketing",
      state: cacPaybackState,
      value: cacPaybackValue,
      ...(cacPaybackDeals !== null
        ? { note: `${cacPaybackDeals}x deals to recover CAC.` }
        : {}),
    },
  ];

  const statuses: Partial<Record<ReadingOrderStepId, ReadingOrderState>> = {
    cash: cashState,
    "cash-multiple": cashMultipleState,
    "ltgp-cac": ltgpCacState,
    "gross-margin": grossMarginState,
    churn: churnState,
    "show-rate": showRateState,
    "speed-to-lead": speedToLeadState,
    cac: cacStepState,
  };

  const metrics: Partial<
    Record<ReadingOrderStepId, { displayValue: string; observedAt: string | null }>
  > = {
    cash: {
      displayValue: cashCollectedUsd !== null ? formatUsd(cashCollectedUsd) : "Not connected",
      observedAt: cashCollectedUsd !== null ? observedAt : null,
    },
    "cash-multiple": {
      displayValue: cashMultiple !== null ? `${cashMultiple}x` : "Not connected",
      observedAt: cashMultiple !== null ? observedAt : null,
    },
    "ltgp-cac": {
      displayValue: ltgpToCac !== null ? `${ltgpToCac}:1` : "Not connected",
      observedAt: ltgpToCac !== null ? observedAt : null,
    },
    "gross-margin": {
      displayValue: grossMarginPct !== null ? `${grossMarginPct}%` : "Not connected",
      observedAt: grossMarginPct !== null ? observedAt : null,
    },
    churn: {
      displayValue: "Not connected",
      observedAt: null,
    },
    "show-rate": {
      displayValue: showRatePct !== null ? `${showRatePct}%` : "Not connected",
      observedAt: showRatePct !== null ? observedAt : null,
    },
    "speed-to-lead": {
      displayValue: speedToLeadSec !== null ? `${speedToLeadSec}s` : "Not connected",
      observedAt: speedToLeadSec !== null ? observedAt : null,
    },
    cac: {
      displayValue: cacUsd !== null && totalWon > 0 ? formatUsd(cacUsd) : "Not connected",
      observedAt: cacUsd !== null && totalWon > 0 ? observedAt : null,
    },
  };

  return {
    ceo: {
      companyId,
      period,
      generatedAt,
      moneyTiles,
      readingOrder: statuses,
      readingOrderMetrics: metrics,
    },
    readingOrder: {
      companyId,
      period,
      generatedAt,
      statuses,
      metrics,
    },
  };
}

export function ceoBoardService(
  now: () => Date = () => new Date(),
  clientOpts?: SalesDashboardClientOptions,
) {
  return {
    async ceoBoard(companyId: string, period: DashboardPeriod = "30d"): Promise<DashboardCeoBoard> {
      const bundle = await readPortfolioSnapshotBundle(period, clientOpts);
      return buildCeoAndReadingOrder(companyId, period, bundle, now()).ceo;
    },
    async readingOrder(
      companyId: string,
      period: DashboardPeriod = "30d",
    ): Promise<DashboardReadingOrderPayload> {
      const bundle = await readPortfolioSnapshotBundle(period, clientOpts);
      return buildCeoAndReadingOrder(companyId, period, bundle, now()).readingOrder;
    },
  };
}

export function ceoBoardRoutes(
  service: ReturnType<typeof ceoBoardService> = ceoBoardService(),
) {
  const router = Router();

  router.get("/companies/:companyId/dashboards/ceo", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const period = parsePeriodQuery(req.query.period);
    res.json(await service.ceoBoard(companyId, period));
  });

  router.get("/companies/:companyId/dashboards/reading-order", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const period = parsePeriodQuery(req.query.period);
    res.json(await service.readingOrder(companyId, period));
  });

  return router;
}
