import type {
  DashboardBoard,
  DashboardBoardId,
  DashboardBoardMeta,
  DashboardPeriod,
  DashboardSource,
  DashboardSourceId,
  DashboardTable,
  DashboardTableRow,
  DashboardTile,
  DashboardTileValue,
  DashboardUnit,
} from "@paperclipai/shared";
import {
  readAgencyMarketingSummary,
  type AgencyMarketingSummary,
} from "../ir/agency-marketing-client.js";
import {
  readAgencySalesSummary,
  type AgencySalesSummary,
} from "../ir/agency-sales-client.js";
import {
  fetchSalesCapital,
  type CapitalApiPayload,
} from "../ir/sales-dashboard-client.js";
import {
  readAgencyQuickBooksFinancials,
  type AgencyQuickBooksFinancials,
} from "../ir/quickbooks-client.js";
import {
  teamCapitalAdapter,
  teamRosterRows,
  type TeamRosterAdapter,
} from "./dashboard-team-roster.js";

/**
 * Agency operating boards: Sales, Marketing, and Human employees.
 *
 * Strict Agency vs. Client separation (brain/ops/agency-vs-client-accounts.md):
 * - Marketing tracks ONLY Increase ROAS's 3 B2B acquisition Meta ad accounts.
 * - Sales tracks ONLY Increase ROAS's 3 agency GHL sub-accounts.
 * - Client ad accounts, client GHL sub-accounts, and client WAVV delivery live
 *   exclusively on the Fulfillment dashboard (`/dashboards/fulfillment`).
 *
 * There is deliberately no fallback data here. A number without a source is
 * worse than a blank tile.
 */

const SOURCES: Record<DashboardSourceId, DashboardSource> = {
  ghl: {
    id: "ghl",
    name: "GoHighLevel (GHL)",
    status: "not_connected",
    detail:
      "Agency Sales reads Increase ROAS's 3 own GHL sub-accounts (Increase ROAS Main, Hot Tub Launch B2B via OAuth Gateway, plus Alex Bloomfield via optional GHL_ALEX_BLOOMFIELD_PIT_KEY + GHL_ALEX_BLOOMFIELD_LOCATION_ID).",
    needed:
      "GATEWAY_PAPERCLIP_KEY with read-only GHL access for primary agency locations, plus optional GHL_ALEX_BLOOMFIELD_PIT_KEY and GHL_ALEX_BLOOMFIELD_LOCATION_ID for Alex Bloomfield's separate GHL agency.",
    lastSuccessfulSync: null,
  },
  wavv: {
    id: "wavv",
    name: "WAVV",
    status: "not_connected",
    detail:
      "Client WAVV outbound setter calls live on the Fulfillment dashboard.",
    needed:
      "GATEWAY_PAPERCLIP_KEY or GATEWAY_WAVV_KEY with read-only WAVV access.",
    lastSuccessfulSync: null,
  },
  meta_ads: {
    id: "meta_ads",
    name: "Meta Marketing API",
    status: "not_connected",
    detail:
      "Agency Marketing reads Increase ROAS's 3 own B2B acquisition Meta ad accounts (Increase ROAS B2B, Alex Bloomfield / Start Scale Automate, Hot Tub Launch) via OAuth Gateway.",
    needed:
      "GATEWAY_PAPERCLIP_KEY with read-only `meta` provider access on OAuth Gateway and valid agency Meta ad account IDs.",
    lastSuccessfulSync: null,
  },
  team_capital: {
    id: "team_capital",
    name: "Team & capital API",
    status: "not_connected",
    detail:
      "The roster is table agency_team behind dashboard.increaseai.tech's admin API (/api/pilot/admin/team). Paperclip has no read-only connection to that host, and the endpoint is admin-authenticated.",
    needed:
      "A read-only service credential for dashboard.increaseai.tech that can GET /api/pilot/admin/team (or a read replica exposing agency_team), stored as a Paperclip secret and referenced by this adapter. Do not reuse a person's admin login.",
    lastSuccessfulSync: null,
  },
};

function notConnected(): DashboardTileValue {
  return { kind: "not_connected" };
}

function sourcesFor(ids: DashboardSourceId[]): DashboardSource[] {
  return ids.map((id) => ({ ...SOURCES[id] }));
}

function tile(input: Omit<DashboardTile, "value">): DashboardTile {
  return { ...input, value: notConnected() };
}

function table(input: Omit<DashboardTable, "rows">): DashboardTable {
  return { ...input, rows: [] };
}

const SALES_TILES: DashboardTile[] = [
  tile({
    id: "show-rate",
    label: "Show rate",
    definition: "Agency sales appointments held ÷ appointments booked across Increase ROAS GHL sub-accounts.",
    owner: "Setters",
    target: "≥ 70% (Hormozi benchmark); < 60% red",
    sourceIds: ["ghl"],
  }),
  tile({
    id: "speed-to-lead",
    label: "Speed to lead",
    definition:
      "Median seconds from a new agency B2B lead (GHL) to the first outbound call attempt.",
    owner: "Sales manager",
    target:
      "< 60 s (Hormozi's 60-second rule); > 5 min costs you 80% of closes",
    sourceIds: ["ghl"],
  }),
  tile({
    id: "offer-rate",
    label: "Offer rate",
    definition: "Agency B2B offers/proposals made ÷ appointments held.",
    owner: "Closers",
    target:
      "Track it; no fixed target. A low offer rate means the lead flow is wrong, not the rep",
    sourceIds: ["ghl"],
  }),
  tile({
    id: "close-rate",
    label: "Close rate",
    definition: "Agency deals won ÷ closed opportunities (or offers made / appointments held).",
    owner: "Closers",
    target: "40% (Hormozi); < 30% is a sales-motion problem",
    sourceIds: ["ghl"],
  }),
  tile({
    id: "cash-collected-up-front",
    label: "Cash collected up front",
    definition:
      "Agency cash received at close ÷ contract value via GHL payments.",
    owner: "Sales manager",
    target:
      "Rising; a high close rate with low cash up front means you are buying yeses",
    sourceIds: ["ghl"],
  }),
  tile({
    id: "units-sold",
    label: "Units sold",
    definition: "Booked × show × offer × close; new agency clients won in the period.",
    owner: "Sales manager",
    target: "The output; the only result here, not a lever",
    sourceIds: ["ghl"],
  }),
  tile({
    id: "new-leads",
    label: "Agency new leads",
    definition: "New B2B leads created across Increase ROAS Main, Hot Tub Launch B2B, and Alex Bloomfield GHL sub-accounts.",
    owner: "Sales manager",
    target: "v1 source, not Hormozi — agency acquisition leads only (client leads live on Fulfillment)",
    sourceIds: ["ghl"],
  }),
  tile({
    id: "active-opportunities",
    label: "Active opportunities",
    definition: "Agency B2B sales-pipeline opportunities created or updated in the period (recruiting pipelines excluded).",
    owner: "Sales manager",
    target: "v1 source, not Hormozi — healthy B2B deal flow across agency pipelines",
    sourceIds: ["ghl"],
  }),
  tile({
    id: "set-rate",
    label: "Set rate",
    definition: "Agency appointments booked ÷ agency new leads.",
    owner: "Setters",
    target: "v1 source, not Hormozi — 20–30% good, 35–40% elite; < 10% red",
    sourceIds: ["ghl"],
  }),
  tile({
    id: "lead-to-customer",
    label: "Lead → customer",
    definition: "New agency clients won ÷ agency B2B leads.",
    owner: "Sales manager",
    target:
      "v1 source, not Hormozi — agency B2B conversion rate across Increase ROAS sub-accounts",
    sourceIds: ["ghl"],
  }),
];

const SALES_TABLES: DashboardTable[] = [
  table({
    id: "sales-by-business",
    title: "Agency sales by GHL sub-account",
    description:
      "Increase ROAS's own 3 agency GHL sub-accounts only (Increase ROAS Main, Hot Tub Launch B2B, Alex Bloomfield). Client appointments and WAVV outbound delivery live on the Fulfillment dashboard.",
    scope: "client",
    sourceIds: ["ghl"],
    columns: [
      { key: "account", label: "Sub-account" },
      { key: "locationId", label: "Location ID" },
      { key: "status", label: "Status" },
      { key: "newLeads", label: "New leads" },
      { key: "opportunities", label: "Opportunities" },
      { key: "booked", label: "Booked" },
      { key: "held", label: "Held" },
      { key: "showRate", label: "Show rate" },
      { key: "jobsSold", label: "Deals won" },
      { key: "closeRate", label: "Close rate" },
    ],
  }),
];

const MARKETING_TILES: DashboardTile[] = [
  tile({
    id: "cac-per-client",
    label: "CAC per client",
    definition:
      "Agency acquisition cost to win one agency client: agency ad spend ÷ new agency clients won.",
    owner: "Media buyer",
    target: "Judge against LTGP, never against CPL",
    sourceIds: ["meta_ads", "ghl"],
  }),
  tile({
    id: "creative-budget-split",
    label: "Creative budget split",
    definition:
      "Share of agency ad budget split between the proven core ad, adjacent variations and new ideas.",
    owner: "Media buyer",
    target: "70 / 20 / 10 (core / adjacent / new)",
    sourceIds: ["meta_ads"],
  }),
  tile({
    id: "ad-spend",
    label: "Ad spend",
    definition: "Spend in the period across Increase ROAS's 3 agency acquisition Meta ad accounts only.",
    owner: "Media buyer",
    target: "v1 source, not Hormozi — 0.95–1.05 of planned pacing green; > 1.15 red",
    sourceIds: ["meta_ads"],
  }),
  tile({
    id: "new-leads",
    label: "New leads",
    definition: "B2B leads generated across Increase ROAS's 3 agency acquisition Meta ad accounts.",
    owner: "Media buyer",
    target:
      "v1 source, not Hormozi — measured against Increase ROAS's own 7- and 14-day baseline",
    sourceIds: ["meta_ads"],
  }),
  tile({
    id: "cost-per-held-appointment",
    label: "Cost per held appointment",
    definition: "Agency ad spend ÷ agency sales appointments held.",
    owner: "Media buyer",
    target:
      "v1 source, not Hormozi — under (agency deal value × close rate × margin) ÷ 3",
    sourceIds: ["meta_ads", "ghl"],
  }),
  tile({
    id: "ctr",
    label: "CTR",
    definition: "Link clicks ÷ impressions across Increase ROAS agency Meta ad accounts.",
    owner: "Media buyer",
    target:
      "1% → 4% is a 4× front-end gain; judge against Increase ROAS's own baseline",
    sourceIds: ["meta_ads"],
  }),
  tile({
    id: "cost-per-lead",
    label: "Cost per lead",
    definition: "Agency ad spend ÷ agency Meta leads.",
    owner: "Media buyer",
    target: "Reference only, never a target",
    sourceIds: ["meta_ads"],
  }),
  tile({
    id: "spend-with-zero-leads",
    label: "Spend with zero leads",
    definition:
      "Agency account-days in the last 7 with spend over $100 and no new lead. This is an alarm, not a scorecard row.",
    owner: "Media buyer",
    target: "v1 source, not Hormozi — zero account-days",
    sourceIds: ["meta_ads"],
  }),
  tile({
    id: "spend-pacing",
    label: "Spend pacing",
    definition: "Spend to date ÷ (daily budget × days elapsed).",
    owner: "Media buyer",
    target: "v1 source, not Hormozi — 0.95–1.05 green; > 1.15 red",
    sourceIds: ["meta_ads"],
  }),
];

const MARKETING_TABLES: DashboardTable[] = [
  table({
    id: "marketing-by-client",
    title: "Agency acquisition ad accounts",
    description:
      "Increase ROAS's own 3 B2B acquisition Meta ad accounts only (Increase ROAS B2B, Alex Bloomfield / Start Scale Automate, Hot Tub Launch). Client ad accounts live on Fulfillment. ROAS is the drill-down under CAC, never a headline tile.",
    scope: "client",
    sourceIds: ["meta_ads"],
    columns: [
      { key: "account", label: "Ad account" },
      { key: "accountId", label: "Meta account ID" },
      { key: "status", label: "Status" },
      { key: "spend", label: "Spend" },
      { key: "leads", label: "Leads" },
      { key: "impressions", label: "Impressions" },
      { key: "clicks", label: "Link clicks" },
      { key: "ctr", label: "CTR" },
      { key: "costPerLead", label: "Cost per lead" },
      { key: "cac", label: "CAC" },
      { key: "roas", label: "ROAS (drill-down)" },
      { key: "zeroLeadDays", label: "Zero-lead days" },
    ],
  }),
];

const HUMAN_EMPLOYEE_TILES: DashboardTile[] = [
  tile({
    id: "one-number-per-seat",
    label: "One number per seat",
    definition:
      "Each seat's single self-chosen number that predicts their result.",
    owner: "Alex",
    target: "Every seat has one, and the person can defend it",
    sourceIds: ["team_capital"],
  }),
  tile({
    id: "metrics-a-seat-can-name",
    label: "Metrics a seat can name",
    definition: "How many numbers that person can describe their own job with.",
    owner: "Alex",
    target: "More is better; one or two means they cannot drive the outcome",
    sourceIds: ["team_capital"],
  }),
  tile({
    id: "revenue-per-fte",
    label: "Revenue per FTE",
    definition: "Revenue ÷ full-time equivalents.",
    owner: "Alex",
    target: "Direction only, not a target",
    sourceIds: ["team_capital"],
  }),
  tile({
    id: "active-team-members",
    label: "Active team members",
    definition: "People with status active in the roster.",
    owner: "Alex",
    target:
      "v1 source, not Hormozi — every active seat has a rate and one judged-on number",
    sourceIds: ["team_capital"],
  }),
  tile({
    id: "utilization",
    label: "Utilization",
    definition: "Billable or delivery hours ÷ available hours, per delivery role.",
    owner: "Fulfillment lead",
    target:
      "v1 source, not Hormozi — 65–75%; red above 85% (burnout) or below 60%",
    sourceIds: ["team_capital"],
  }),
  tile({
    id: "regrettable-attrition",
    label: "Regrettable attrition",
    definition: "A-players lost ÷ A-players, trailing 12 months.",
    owner: "Alex",
    target: "v1 source, not Hormozi — zero; any loss needs a written cause",
    sourceIds: ["team_capital"],
  }),
  tile({
    id: "seats-without-judged-on-number",
    label: "Seats without a judged-on number",
    definition:
      "Active seats whose performance criterion is empty or reads NOT SET.",
    owner: "Alex",
    target: "v1 source, not Hormozi — zero",
    sourceIds: ["team_capital"],
  }),
];

const HUMAN_EMPLOYEE_TABLES: DashboardTable[] = [
  table({
    id: "team-roster",
    title: "Team roster",
    description:
      "One row per person, keyed by team-member id. Manny is an owner, not an employee, and is excluded from labour cost.",
    scope: "member",
    sourceIds: ["team_capital"],
    columns: [
      { key: "name", label: "Name" },
      { key: "role", label: "Role" },
      { key: "rateType", label: "Rate type" },
      { key: "rate", label: "Rate" },
      { key: "hours", label: "Hours" },
      { key: "duties", label: "Duties" },
      { key: "judgedOn", label: "Judged on" },
      { key: "status", label: "Status" },
    ],
  }),
];

const BOARD_DEFINITIONS: Record<
  DashboardBoardId,
  { tiles: DashboardTile[]; tables: DashboardTable[] }
> = {
  sales: { tiles: SALES_TILES, tables: SALES_TABLES },
  marketing: { tiles: MARKETING_TILES, tables: MARKETING_TABLES },
  "human-employees": {
    tiles: HUMAN_EMPLOYEE_TILES,
    tables: HUMAN_EMPLOYEE_TABLES,
  },
};

function liveVal(
  value: number | null | undefined,
  unit: DashboardUnit,
  observedAt: string,
): DashboardTileValue {
  if (typeof value !== "number" || !Number.isFinite(value)) return notConnected();
  return { kind: "live", value, unit, observedAt };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatUsdCell(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatIntCell(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round(value).toLocaleString("en-US");
}

function isMissingJudgedOn(value: string | null | undefined): boolean {
  if (!value) return true;
  const trimmed = value.trim();
  if (!trimmed) return true;
  return /^NOT SET\b/i.test(trimmed);
}

function extractRevenueUsd(
  capital: CapitalApiPayload | null,
  period: DashboardPeriod,
): number | null {
  if (!capital || (capital.view && capital.view !== period)) return null;
  // Agency revenue per FTE must come strictly from agency owner financials (never client sales).
  const marketingWindow =
    typeof capital.owner?.marketing?.window === "string" ? capital.owner.marketing.window.trim() : "";
  const marketingMatches = !marketingWindow || marketingWindow === period;
  const candidates = [
    ...(marketingMatches ? [capital.owner?.marketing?.salesUsd] : []),
    ...(period === "month" ? [capital.owner?.financialMonth?.salesUsd] : []),
    ...(marketingMatches ? [capital.owner?.marketing?.cashCollectedUsd] : []),
    ...(period === "month" ? [capital.owner?.financialMonth?.cashCollectedUsd] : []),
  ];
  for (const val of candidates) {
    if (typeof val === "number" && Number.isFinite(val) && val > 0) return val;
  }
  return null;
}

function agencySalesAccountRows(sales: AgencySalesSummary | null): DashboardTableRow[] {
  if (!sales) return [];
  return sales.accounts.map((acct) => ({
    id: acct.id,
    cells: {
      account: acct.displayName,
      locationId: acct.locationId ?? "Not set",
      status: acct.statusLabel,
      newLeads: acct.newLeads,
      opportunities: acct.activeOpportunities,
      booked: acct.booked,
      held: acct.showed,
      showRate: acct.showRate !== null ? `${acct.showRate}%` : null,
      jobsSold: acct.wonDeals,
      closeRate: acct.closeRate !== null ? `${acct.closeRate}%` : null,
    },
  }));
}

function agencyMarketingAccountRows(marketing: AgencyMarketingSummary | null): DashboardTableRow[] {
  if (!marketing) return [];
  return marketing.accounts.map((acct) => ({
    id: acct.id,
    cells: {
      account: acct.displayName,
      accountId: acct.adAccountId ?? "Not set",
      status: acct.statusLabel,
      spend: formatUsdCell(acct.spend),
      leads: acct.leads,
      impressions: formatIntCell(acct.impressions),
      clicks: formatIntCell(acct.linkClicks),
      ctr: acct.ctr !== null ? `${acct.ctr}%` : null,
      costPerLead: formatUsdCell(acct.cpl),
      cac: null,
      roas: null,
      zeroLeadDays: acct.zeroLeadDays,
    },
  }));
}

function resolveHumanEmployeesTile(
  tileId: string,
  period: DashboardPeriod,
  roster: NonNullable<Awaited<ReturnType<TeamRosterAdapter["read"]>>>,
  capital: CapitalApiPayload | null,
  qbo: AgencyQuickBooksFinancials | null,
): DashboardTileValue | null {
  const active = roster.members.filter((m) => m.status.toLowerCase() === "active");
  const missing = active.filter((m) => isMissingJudgedOn(m.judgedOn)).length;
  if (tileId === "active-team-members") {
    return liveVal(active.length, "count", roster.observedAt);
  }
  if (tileId === "seats-without-judged-on-number") {
    return liveVal(missing, "count", roster.observedAt);
  }
  if (tileId === "one-number-per-seat") {
    return liveVal(active.length - missing, "count", roster.observedAt);
  }
  if (tileId === "revenue-per-fte") {
    const qboRevenue = qbo?.accrualRevenueUsd ?? qbo?.cashCollectedUsd ?? null;
    const salesUsd =
      qboRevenue !== null && qboRevenue > 0 ? qboRevenue : extractRevenueUsd(capital, period);
    const observedAt =
      qboRevenue !== null && qboRevenue > 0 && qbo
        ? qbo.observedAt
        : capital?.generatedAt ?? roster.observedAt;
    if (salesUsd !== null && active.length > 0) {
      return liveVal(round2(salesUsd / active.length), "usd", observedAt);
    }
    return notConnected();
  }
  return null;
}

function resolveAgencySalesTile(tileId: string, sales: AgencySalesSummary | null): DashboardTileValue {
  if (!sales || !sales.hasGhl) return notConnected();
  const ts = sales.observedAt;
  switch (tileId) {
    case "show-rate":
      return liveVal(sales.showRate, "percent", ts);
    case "offer-rate":
      return liveVal(sales.offerRate, "percent", ts);
    case "close-rate":
      return liveVal(sales.closeRate, "percent", ts);
    case "cash-collected-up-front":
      if (sales.pipelineWonUsd !== null && sales.pipelineWonUsd > 0 && sales.cashCollectedUsd !== null) {
        return liveVal(round1((sales.cashCollectedUsd / sales.pipelineWonUsd) * 100), "percent", ts);
      }
      return notConnected();
    case "units-sold":
      return liveVal(sales.wonDeals, "count", ts);
    case "new-leads":
      return liveVal(sales.newLeads, "count", ts);
    case "active-opportunities":
      return liveVal(sales.activeOpportunities, "count", ts);
    case "set-rate":
      return liveVal(sales.setRate, "percent", ts);
    case "lead-to-customer":
      return liveVal(sales.leadToCustomerRate, "percent", ts);
    default:
      return notConnected();
  }
}

function resolveAgencyMarketingTile(
  tileId: string,
  marketing: AgencyMarketingSummary | null,
  sales: AgencySalesSummary | null,
): DashboardTileValue {
  if (!marketing || !marketing.hasMeta) return notConnected();
  const ts = marketing.observedAt;
  switch (tileId) {
    case "cac-per-client":
      if (marketing.spend !== null && sales?.hasGhl && sales.wonDeals !== null && sales.wonDeals > 0) {
        return liveVal(round2(marketing.spend / sales.wonDeals), "usd", ts);
      }
      return notConnected();
    case "ad-spend":
      return liveVal(marketing.spend, "usd", ts);
    case "new-leads":
      return liveVal(marketing.leads, "count", ts);
    case "cost-per-held-appointment":
      if (marketing.spend !== null && sales?.hasGhl && sales.showed !== null && sales.showed > 0) {
        return liveVal(round2(marketing.spend / sales.showed), "usd", ts);
      }
      return notConnected();
    case "ctr":
      return liveVal(marketing.ctr, "percent", ts);
    case "cost-per-lead":
      return liveVal(marketing.cpl, "usd", ts);
    case "spend-with-zero-leads":
      return liveVal(marketing.zeroLeadDays, "count", ts);
    default:
      return notConnected();
  }
}

function buildHumanEmployeesMeta(
  roster: Awaited<ReturnType<TeamRosterAdapter["read"]>>,
  capital: CapitalApiPayload | null,
): DashboardBoardMeta | undefined {
  if (!capital && !(roster && (process.env.SALES_DASHBOARD_ADMIN_KEY ?? "").trim())) {
    return undefined;
  }
  const activeFromRoster = roster
    ? roster.members.filter((m) => m.status.toLowerCase() === "active").length
    : undefined;
  const totalFromRoster = roster ? roster.members.length : undefined;
  const activeFromCapital =
    capital && capital.members.length > 0
      ? capital.members.filter((m) => (m.status ?? "").toLowerCase() === "active").length
      : undefined;
  const totalFromCapital =
    capital && capital.members.length > 0 ? capital.members.length : undefined;

  const cashOnHandUsd =
    typeof capital?.operating?.cashOnHandUsd === "number" &&
    Number.isFinite(capital.operating.cashOnHandUsd)
      ? capital.operating.cashOnHandUsd
      : typeof capital?.settings?.cashOnHandUsd === "number" &&
          Number.isFinite(capital.settings.cashOnHandUsd)
        ? capital.settings.cashOnHandUsd
        : undefined;

  return {
    ...(capital?.operating
      ? {
          monthlyLaborUsd: capital.operating.monthlyLaborUsd,
          monthlyOverheadUsd: capital.operating.monthlyOverheadUsd,
          monthlyBurnUsd: capital.operating.monthlyBurnUsd,
          runwayMonths: capital.operating.runwayMonths,
        }
      : {}),
    ...(cashOnHandUsd !== undefined ? { cashOnHandUsd } : {}),
    ...(activeFromRoster !== undefined || activeFromCapital !== undefined
      ? { activeHeadcount: activeFromRoster ?? activeFromCapital }
      : {}),
    ...(totalFromRoster !== undefined || totalFromCapital !== undefined
      ? { totalHeadcount: totalFromRoster ?? totalFromCapital }
      : {}),
  };
}

function formatGhlSourceDetail(sales: AgencySalesSummary): string {
  const alex = sales.accounts.find((a) => a.id === "alex-bloomfield-ssa");
  const base = `Connected to ${sales.liveAccountCount}/${sales.totalAccountCount} Increase ROAS agency GHL sub-accounts.`;
  if (alex && alex.status !== "live") {
    return `${base} Alex Bloomfield awaits GHL_ALEX_BLOOMFIELD_PIT_KEY + GHL_ALEX_BLOOMFIELD_LOCATION_ID.`;
  }
  return base;
}

function formatMetaSourceDetail(marketing: AgencyMarketingSummary): string {
  return `Connected to ${marketing.liveAccountCount}/${marketing.totalAccountCount} Increase ROAS agency Meta acquisition ad accounts via OAuth Gateway.`;
}

export function dashboardBoardService(
  now: () => Date = () => new Date(),
  adapters: {
    teamRoster?: TeamRosterAdapter;
    fetchImpl?: typeof fetch;
    agencyMarketingReader?: (period: DashboardPeriod) => Promise<AgencyMarketingSummary | null>;
    agencySalesReader?: (period: DashboardPeriod) => Promise<AgencySalesSummary | null>;
    quickbooksReader?: (period: DashboardPeriod) => Promise<AgencyQuickBooksFinancials | null>;
  } = {},
) {
  const teamRoster = adapters.teamRoster ?? teamCapitalAdapter(adapters.fetchImpl);

  return {
    async board(
      board: DashboardBoardId,
      companyId: string,
      period: DashboardPeriod = "30d",
      boardOptions: { boardViewer?: boolean } = {},
    ): Promise<DashboardBoard> {
      const definition = BOARD_DEFINITIONS[board];
      if (!definition) throw new Error(`Unknown dashboard board: ${board}`);
      const allowInstanceData = boardOptions.boardViewer ?? true;

      const [roster, capital, agencyMarketing, agencySales, qbo] = allowInstanceData
        ? await Promise.all([
            board === "human-employees" ? teamRoster.read(companyId) : Promise.resolve(null),
            board === "human-employees"
              ? fetchSalesCapital(period, { fetchImpl: adapters.fetchImpl })
              : Promise.resolve(null),
            board === "marketing"
              ? (adapters.agencyMarketingReader
                  ? adapters.agencyMarketingReader(period)
                  : readAgencyMarketingSummary(period, { fetchImpl: adapters.fetchImpl, now }))
              : Promise.resolve(null),
            board === "sales" || board === "marketing"
              ? (adapters.agencySalesReader
                  ? adapters.agencySalesReader(period)
                  : readAgencySalesSummary(period, { fetchImpl: adapters.fetchImpl, now }))
              : Promise.resolve(null),
            board === "human-employees"
              ? (adapters.quickbooksReader
                  ? adapters.quickbooksReader(period)
                  : readAgencyQuickBooksFinancials(period, { fetchImpl: adapters.fetchImpl, now }))
              : Promise.resolve(null),
          ])
        : [null, null, null, null, null];

      const sourceIds = new Set<DashboardSourceId>();
      for (const item of [...definition.tiles, ...definition.tables]) {
        for (const id of item.sourceIds) sourceIds.add(id);
      }

      const sources = sourcesFor([...sourceIds]).map((src) => {
        if (src.id === "team_capital" && (roster || capital)) {
          return {
            ...src,
            status: "connected" as const,
            detail: "Connected to live Team & capital roster.",
            lastSuccessfulSync: roster?.observedAt ?? capital?.generatedAt ?? null,
          };
        }
        if (src.id === "ghl" && agencySales?.hasGhl) {
          return {
            ...src,
            status: "connected" as const,
            detail: formatGhlSourceDetail(agencySales),
            lastSuccessfulSync: agencySales.observedAt,
          };
        }
        if (src.id === "meta_ads" && agencyMarketing?.hasMeta) {
          return {
            ...src,
            status: "connected" as const,
            detail: formatMetaSourceDetail(agencyMarketing),
            lastSuccessfulSync: agencyMarketing.observedAt,
          };
        }
        return src;
      });

      const meta = board === "human-employees" ? buildHumanEmployeesMeta(roster, capital) : undefined;
      const hasSalesDashKey = Boolean((process.env.SALES_DASHBOARD_ADMIN_KEY ?? "").trim());

      const resolveTile = (tileId: string): DashboardTileValue => {
        if (board === "human-employees") {
          if (roster && (hasSalesDashKey || capital || qbo)) {
            return resolveHumanEmployeesTile(tileId, period, roster, capital, qbo) ?? notConnected();
          }
          return notConnected();
        }
        if (board === "sales") return resolveAgencySalesTile(tileId, agencySales);
        return resolveAgencyMarketingTile(tileId, agencyMarketing, agencySales);
      };

      const resolveTableRows = (tableId: string): DashboardTableRow[] => {
        if (tableId === "team-roster" && roster) return teamRosterRows(roster.members);
        if (tableId === "sales-by-business") return agencySalesAccountRows(agencySales);
        if (tableId === "marketing-by-client") return agencyMarketingAccountRows(agencyMarketing);
        return [];
      };

      return {
        board,
        companyId,
        generatedAt: now().toISOString(),
        sources,
        tiles: definition.tiles.map((item) => ({
          ...item,
          sourceIds: [...item.sourceIds],
          value: resolveTile(item.id),
        })),
        tables: definition.tables.map((item) => ({
          ...item,
          sourceIds: [...item.sourceIds],
          columns: item.columns.map((column) => ({ ...column })),
          rows: resolveTableRows(item.id),
        })),
        ...(meta ? { meta } : {}),
      };
    },
  };
}
