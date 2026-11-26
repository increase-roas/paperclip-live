import { costPerAcquisition, showRate } from "@paperclipai/shared/ir-metrics";
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
import {
  readAgencyQuickBooksFinancials,
  type AgencyQuickBooksFinancials,
  type QuickBooksClientOptions,
} from "./quickbooks-client.js";

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

function pickPrimaryFinancials(
  bundle: PortfolioSnapshotBundle,
  period: DashboardPeriod,
): CapitalMetricsPayload | null {
  // Never mix client P&L into agency P&L, and never mix mismatched period financials.
  const capital = bundle.capital;
  const owner = capital?.owner;
  if (!owner) return null;
  if (capital.view && capital.view !== period) return null;
  const marketingWindow = typeof owner.marketing?.window === "string" ? owner.marketing.window.trim() : "";
  const marketingMatches = !marketingWindow || marketingWindow === period;
  if (marketingMatches && owner.marketing?.evidence?.financial) return owner.marketing;
  if (period === "month" && owner.financialMonth?.evidence?.financial) return owner.financialMonth;
  if (marketingMatches && (owner.marketing?.cashCollectedUsd ?? 0) > 0) return owner.marketing;
  if (period === "month" && (owner.financialMonth?.cashCollectedUsd ?? 0) > 0) return owner.financialMonth;
  return marketingMatches ? (owner.marketing ?? null) : null;
}

interface ClientPortfolioTotals {
  totalAdSpend: number;
  hasAdSpend: boolean;
  totalBooked: number;
  totalShowed: number;
  hasBooked: boolean;
  hasShowed: boolean;
  totalWon: number;
  hasWon: boolean;
  speedToLeadSec: number | null;
}

function aggregateClientPortfolio(bundle: PortfolioSnapshotBundle): ClientPortfolioTotals {
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

  return {
    totalAdSpend,
    hasAdSpend,
    totalBooked,
    totalShowed,
    hasBooked,
    hasShowed,
    totalWon,
    hasWon,
    speedToLeadSec: speedToLeadCount > 0 ? Math.round(speedToLeadSum / speedToLeadCount) : null,
  };
}

interface AgencyMoneySummary {
  cashCollectedUsd: number | null;
  cashFromQbo: boolean;
  expensesUsd: number | null;
  qboCogs: number | null;
  grossMarginPct: number | null;
  grossMarginFromQbo: boolean;
  cashMultiple: number | null;
  cashMultipleFromQbo: boolean;
  ltgpToCac: number | null;
  cacPaybackDeals: number | null;
  ownerCacUsd: number | null;
}

function resolveAgencyMoneySummary(
  bundle: PortfolioSnapshotBundle,
  fin: CapitalMetricsPayload | null,
  qbo: AgencyQuickBooksFinancials | null,
): AgencyMoneySummary {
  // Agency cash collected comes strictly from agency QuickBooks or agency owner financials
  // (never mixed with client billing).
  const finCash = finite(fin?.cashCollectedUsd);
  const qboCash = finite(qbo?.cashCollectedUsd);
  const cashFromQbo = qboCash !== null;
  const cashCollectedUsd = cashFromQbo
    ? qboCash
    : finCash !== null && (fin?.evidence?.financial ? finCash >= 0 : finCash > 0)
      ? finCash
      : null;

  const qboTotalExpenses = finite(qbo?.totalExpensesUsd);
  const qboCogs = finite(qbo?.cogsUsd);
  const expensesUsd = qboTotalExpenses ?? finite(fin?.expensesUsd);
  const qboGrossMargin = finite(qbo?.grossMarginPercent);
  const grossMarginRaw = finite(fin?.grossMarginPercent);
  const grossMarginFromQbo = qboGrossMargin !== null;
  const grossMarginPct = grossMarginFromQbo
    ? round1(qboGrossMargin)
    : fin?.evidence?.financial && grossMarginRaw !== null
      ? normalizePercent(grossMarginRaw)
      : null;

  // All-time LTGP:CAC and cohort CAC payback require verified owner cohort metrics —
  // never fabricated from single-period P&L divided by recurring active customers.
  const ownerAdSpendUsd = finite(fin?.adSpendUsd) ?? finite(qbo?.advertisingSpendUsd);
  const hasVerifiedFin = Boolean(fin?.evidence?.financial);
  const ownerCacUsd = hasVerifiedFin ? finite(fin?.cacUsd) : null;
  const grossProfitPerWon = hasVerifiedFin ? finite(fin?.grossProfitPerWonDealUsd) : null;
  const cacPaybackDeals = hasVerifiedFin ? finite(fin?.cacPaybackDeals) : null;

  const operatingBurn = finite(bundle.capital?.operating?.monthlyBurnUsd);
  const validAgencyAdSpend = ownerAdSpendUsd !== null && ownerAdSpendUsd > 0 ? ownerAdSpendUsd : null;
  // Never divide cash by COGS alone while silently pretending agency CAC is $0:
  // use COGS + verified ad spend when both exist; otherwise require full total expenses or operating burn.
  let cashMultipleDenominator: number | null = null;
  let cashMultipleFromQbo = false;
  if (qboCogs !== null && qboCogs > 0 && validAgencyAdSpend !== null) {
    cashMultipleDenominator = qboCogs + validAgencyAdSpend;
    cashMultipleFromQbo = cashFromQbo;
  } else if (qboTotalExpenses !== null && qboTotalExpenses > 0) {
    cashMultipleDenominator = qboTotalExpenses;
    cashMultipleFromQbo = cashFromQbo;
  } else if (expensesUsd !== null && expensesUsd > 0) {
    cashMultipleDenominator = expensesUsd + (validAgencyAdSpend ?? 0);
  } else if ((Boolean(qbo) || hasVerifiedFin) && operatingBurn !== null && operatingBurn > 0) {
    cashMultipleDenominator = operatingBurn + (validAgencyAdSpend ?? 0);
    cashMultipleFromQbo = cashFromQbo && !hasVerifiedFin;
  }
  const cashMultiple =
    cashCollectedUsd !== null && cashMultipleDenominator !== null && cashMultipleDenominator > 0
      ? round2(cashCollectedUsd / cashMultipleDenominator)
      : null;

  const ltgpToCac =
    grossProfitPerWon !== null && grossProfitPerWon > 0 && ownerCacUsd !== null && ownerCacUsd > 0
      ? round2(grossProfitPerWon / ownerCacUsd)
      : null;

  return {
    cashCollectedUsd,
    cashFromQbo,
    expensesUsd,
    qboCogs,
    grossMarginPct,
    grossMarginFromQbo,
    cashMultiple,
    cashMultipleFromQbo,
    ltgpToCac,
    cacPaybackDeals,
    ownerCacUsd,
  };
}

function buildReadingOrderMetrics(input: {
  cashObservedAt: string | null;
  cashMultipleObservedAt: string | null;
  ltgpObservedAt: string | null;
  grossMarginObservedAt: string | null;
  portfolioObservedAt: string | null;
  cashCollectedUsd: number | null;
  cashMultiple: number | null;
  ltgpToCac: number | null;
  grossMarginPct: number | null;
  showRatePct: number | null;
  speedToLeadSec: number | null;
  readingOrderCacUsd: number | null;
}): Partial<Record<ReadingOrderStepId, { displayValue: string; observedAt: string | null }>> {
  const metrics: Partial<
    Record<ReadingOrderStepId, { displayValue: string; observedAt: string | null }>
  > = {};
  if (input.cashCollectedUsd !== null) {
    metrics.cash = { displayValue: formatUsd(input.cashCollectedUsd), observedAt: input.cashObservedAt };
  }
  if (input.cashMultiple !== null) {
    metrics["cash-multiple"] = { displayValue: `${input.cashMultiple}x`, observedAt: input.cashMultipleObservedAt };
  }
  if (input.ltgpToCac !== null) {
    metrics["ltgp-cac"] = { displayValue: `${input.ltgpToCac}:1`, observedAt: input.ltgpObservedAt };
  }
  if (input.grossMarginPct !== null) {
    metrics["gross-margin"] = { displayValue: `${input.grossMarginPct}%`, observedAt: input.grossMarginObservedAt };
  }
  if (input.showRatePct !== null) {
    metrics["show-rate"] = { displayValue: `${input.showRatePct}%`, observedAt: input.portfolioObservedAt };
  }
  if (input.speedToLeadSec !== null) {
    metrics["speed-to-lead"] = { displayValue: `${input.speedToLeadSec}s`, observedAt: input.portfolioObservedAt };
  }
  if (input.readingOrderCacUsd !== null) {
    metrics.cac = { displayValue: formatUsd(input.readingOrderCacUsd), observedAt: input.portfolioObservedAt };
  }
  return metrics;
}

export function buildCeoAndReadingOrder(
  companyId: string,
  period: DashboardPeriod,
  bundle: PortfolioSnapshotBundle,
  now: Date,
  qbo: AgencyQuickBooksFinancials | null = null,
): { ceo: DashboardCeoBoard; readingOrder: DashboardReadingOrderPayload } {
  const generatedAt = now.toISOString();
  const periodLabel = PERIOD_LABELS[period];
  const bundleObservedAt =
    bundle.observedAt ??
    (bundle.capital && (!bundle.capital.view || bundle.capital.view === period)
      ? bundle.capital.generatedAt
      : null);
  const qboObservedAt = qbo?.observedAt ?? null;
  const fin = pickPrimaryFinancials(bundle, period);
  const qboSourceLabel =
    qbo?.source === "quickbooks_gateway"
      ? "QuickBooks Online (Gateway)"
      : qbo?.source === "quickbooks_composio"
        ? "QuickBooks Online (Composio bridge)"
        : null;

  const portfolio = aggregateClientPortfolio(bundle);
  const money = resolveAgencyMoneySummary(bundle, fin, qbo);
  const {
    cashCollectedUsd,
    cashFromQbo,
    expensesUsd,
    qboCogs,
    grossMarginPct,
    grossMarginFromQbo,
    cashMultiple,
    cashMultipleFromQbo,
    ltgpToCac,
    cacPaybackDeals,
    ownerCacUsd,
  } = money;

  const cashObservedAt = cashFromQbo ? qboObservedAt : bundleObservedAt;
  const cashMultipleObservedAt = cashMultipleFromQbo ? qboObservedAt : bundleObservedAt;
  const grossMarginObservedAt = grossMarginFromQbo ? qboObservedAt : bundleObservedAt;
  const finObservedAt = bundleObservedAt;

  // Client portfolio CPA is strictly for Marketing / Reading Order step #8 (never mixed into agency LTGP:CAC).
  const portfolioCacUsd =
    portfolio.hasAdSpend && portfolio.hasWon
      ? costPerAcquisition({ spend: portfolio.totalAdSpend, acquisitions: portfolio.totalWon })
      : null;

  // 1. Cash collected
  const cashValue: DashboardTileValue =
    cashCollectedUsd !== null && cashObservedAt
      ? { kind: "live", value: cashCollectedUsd, unit: "usd", observedAt: cashObservedAt }
      : notConnected();
  const cashState: ReadingOrderState =
    cashCollectedUsd === null
      ? "unknown"
      : expensesUsd !== null && cashCollectedUsd < expensesUsd
        ? "red"
        : "ok";

  // 2. 30-day cash multiple
  const cashMultipleValue: DashboardTileValue =
    cashMultiple !== null && cashMultipleObservedAt
      ? { kind: "live", value: cashMultiple, unit: "ratio", observedAt: cashMultipleObservedAt }
      : notConnected();
  const cashMultipleState: ReadingOrderState =
    cashMultiple === null ? "unknown" : cashMultiple >= 2 ? "ok" : "red";

  // 3. LTGP : CAC
  const ltgpCacValue: DashboardTileValue =
    ltgpToCac !== null && finObservedAt
      ? { kind: "live", value: ltgpToCac, unit: "ratio", observedAt: finObservedAt }
      : notConnected();
  const ltgpCacState: ReadingOrderState =
    ltgpToCac === null ? "unknown" : ltgpToCac >= 3 ? "ok" : "red";

  // 4. Gross margin
  const grossMarginValue: DashboardTileValue =
    grossMarginPct !== null && grossMarginObservedAt
      ? { kind: "live", value: grossMarginPct, unit: "percent", observedAt: grossMarginObservedAt }
      : notConnected();
  const grossMarginState: ReadingOrderState =
    grossMarginPct === null ? "unknown" : grossMarginPct >= 50 ? "ok" : "red";

  // 5. Churn (requires subscription retention ledger — honestly not_connected today)
  const churnValue: DashboardTileValue = notConnected();
  const churnState: ReadingOrderState = "unknown";

  // 6. CAC payback
  const cacPaybackValue: DashboardTileValue =
    cacPaybackDeals !== null && finObservedAt
      ? { kind: "live", value: cacPaybackDeals, unit: "ratio", observedAt: finObservedAt }
      : notConnected();
  const cacPaybackState: ReadingOrderState =
    cacPaybackDeals === null ? "unknown" : cacPaybackDeals <= 1 ? "ok" : "red";

  // 7. Show rate (for reading order)
  const fallbackShowRate = bundle.clients.find((c) => c.showRate !== null)?.showRate ?? null;
  const portfolioShowRate =
    portfolio.hasBooked && portfolio.hasShowed
      ? showRate({ booked: portfolio.totalBooked, showed: portfolio.totalShowed })
      : null;
  const showRatePct = portfolioShowRate ?? fallbackShowRate;
  const showRateState: ReadingOrderState =
    showRatePct === null ? "unknown" : showRatePct >= 70 ? "ok" : showRatePct < 60 ? "red" : "ok";

  // 8. Speed to lead (for reading order)
  const speedToLeadSec = portfolio.speedToLeadSec;
  const speedToLeadState: ReadingOrderState =
    speedToLeadSec === null ? "unknown" : speedToLeadSec < 60 ? "ok" : speedToLeadSec > 300 ? "red" : "ok";

  // 9. CAC (for reading order -> Marketing)
  const readingOrderCacUsd = portfolioCacUsd ?? ownerCacUsd;
  const cacStepState: ReadingOrderState = readingOrderCacUsd !== null ? "ok" : "unknown";

  const moneyTiles: CeoMoneyTile[] = [
    {
      id: "cash-collected",
      label: "Cash collected",
      periodLabel,
      source: cashFromQbo && qboSourceLabel
        ? qboSourceLabel
        : "QuickBooks Online (Settings → Gateway Access)",
      target: "Exceeds COGS + CAC for the same period",
      needs: "Click Connect on QuickBooks Online in Settings → Gateway Access to stream agency P&L and payments directly.",
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
      source: cashMultipleFromQbo && qboSourceLabel
        ? qboSourceLabel
        : "QuickBooks Online + agency CAC & COGS",
      target: "At least 2.0 — $2 of cash inside 30 days for every $1 spent to acquire and deliver",
      needs: "Agency 30-day cash collected ÷ (agency CAC + COGS). Connect QuickBooks Online in Settings → Gateway Access.",
      state: cashMultipleState,
      value: cashMultipleValue,
    },
    {
      id: "ltgp-cac",
      label: "LTGP : CAC, portfolio",
      periodLabel: "Portfolio, all time",
      source: "QuickBooks Online + agency acquisition cohort ledger",
      target:
        "12:1 target with people at lead gen, sales and delivery — 3:1 all automated, 6:1 one manual, 9:1 two manual",
      needs: "Verified agency cohort lifetime gross profit and new-client CAC.",
      state: ltgpCacState,
      value: ltgpCacValue,
    },
    {
      id: "gross-margin",
      label: "Gross margin, agency blended",
      periodLabel,
      source: grossMarginFromQbo && qboSourceLabel
        ? qboSourceLabel
        : "QuickBooks Online + payroll and contractor ledger",
      target: "At least 50% (Hormozi: below 50% gross margin there is no room for any other cost)",
      needs: "Connect QuickBooks Online in Settings → Gateway Access to pull agency revenue minus direct delivery COGS.",
      state: grossMarginState,
      value: grossMarginValue,
      ...(grossMarginFromQbo && qbo && qboCogs !== null && qbo.grossProfitUsd !== null
        ? { note: `Gross profit ${formatUsd(qbo.grossProfitUsd)} after ${formatUsd(qboCogs)} COGS.` }
        : {}),
    },
    {
      id: "churn",
      label: "Client churn / net revenue retention",
      periodLabel: "Monthly and trailing 12 months",
      source: "GHL subscription state + Authorize.net / QBO recurring",
      target: "Under 3% per month and at least 80% per year",
      needs: "Clients lost and revenue retained, including expansion.",
      href: "/dashboard/fulfillment",
      state: churnState,
      value: churnValue,
    },
    {
      id: "cac-payback",
      label: "CAC payback",
      periodLabel: "Per client cohort, all time",
      source: "QuickBooks billing dates + agency acquisition cohort ledger",
      target: "30 days or less; over 60 days red",
      needs: "Verified agency new-client cohort CAC joined to first-month gross profit.",
      href: "/dashboard/marketing",
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

  // Only include metrics for steps with a live reading so ReadingOrderStrip
  // does not render bold "Not connected" next to the Grey badge.
  const metrics = buildReadingOrderMetrics({
    cashObservedAt,
    cashMultipleObservedAt,
    ltgpObservedAt: finObservedAt,
    grossMarginObservedAt,
    portfolioObservedAt: bundleObservedAt,
    cashCollectedUsd,
    cashMultiple,
    ltgpToCac,
    grossMarginPct,
    showRatePct,
    speedToLeadSec,
    readingOrderCacUsd,
  });

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

const EMPTY_BUNDLE: PortfolioSnapshotBundle = {
  capital: null,
  snapshots: null,
  neonAccounts: null,
  neonPipeline: null,
  clients: [],
  observedAt: null,
};

function canReadInstanceDashboards(req: Request): boolean {
  return (
    req.actor.type === "board" &&
    (req.actor.source === "local_implicit" || Boolean(req.actor.isInstanceAdmin))
  );
}

export function ceoBoardService(
  now: () => Date = () => new Date(),
  clientOpts?: SalesDashboardClientOptions,
  qboOpts?: QuickBooksClientOptions,
) {
  return {
    async ceoBoard(
      companyId: string,
      period: DashboardPeriod = "30d",
      options: { boardViewer?: boolean } = {},
    ): Promise<DashboardCeoBoard> {
      const boardViewer = options.boardViewer ?? true;
      const [bundle, qbo] = boardViewer
        ? await Promise.all([
            readPortfolioSnapshotBundle(period, clientOpts),
            readAgencyQuickBooksFinancials(period, { now, ...qboOpts }),
          ])
        : [EMPTY_BUNDLE, null];
      return buildCeoAndReadingOrder(companyId, period, bundle, now(), qbo).ceo;
    },
    async readingOrder(
      companyId: string,
      period: DashboardPeriod = "30d",
      options: { boardViewer?: boolean } = {},
    ): Promise<DashboardReadingOrderPayload> {
      const boardViewer = options.boardViewer ?? true;
      const [bundle, qbo] = boardViewer
        ? await Promise.all([
            readPortfolioSnapshotBundle(period, clientOpts),
            readAgencyQuickBooksFinancials(period, { now, ...qboOpts }),
          ])
        : [EMPTY_BUNDLE, null];
      return buildCeoAndReadingOrder(companyId, period, bundle, now(), qbo).readingOrder;
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
    res.json(
      await service.ceoBoard(companyId, period, {
        boardViewer: canReadInstanceDashboards(req),
      }),
    );
  });

  router.get("/companies/:companyId/dashboards/reading-order", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const period = parsePeriodQuery(req.query.period);
    res.json(
      await service.readingOrder(companyId, period, {
        boardViewer: canReadInstanceDashboards(req),
      }),
    );
  });

  return router;
}
