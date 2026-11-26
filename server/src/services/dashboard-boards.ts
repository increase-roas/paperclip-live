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
  fetchSalesCapital,
  readPortfolioSnapshotBundle,
  type CapitalApiPayload,
  type MergedClientMetrics,
  type PortfolioSnapshotBundle,
} from "../ir/sales-dashboard-client.js";
import { readWavvSummary, type WavvSummary } from "../ir/wavv-client.js";
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
 * Sales, Marketing and Human employees boards.
 *
 * Every source on this page is read-only data the company already owns. None
 * of those reads exists inside Paperclip yet, so every tile is built with a
 * `not_connected` value and every table has no rows. When a read lands, only
 * the adapter below changes: the payload shape and the UI stay the same.
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
      "Paperclip has no GHL client. The agency's GHL tool connection lives outside this repo, and the last recorded read (INC-109, 22 Nov 2026) was rejected upstream because GHL_MCP_INTERNAL_API_KEY was missing.",
    needed:
      "A GHL private-integration token, location-scoped and read-only (contacts, calendars, opportunities, payments), stored as a Paperclip secret, plus each client's location id.",
    lastSuccessfulSync: null,
  },
  wavv: {
    id: "wavv",
    name: "WAVV",
    status: "not_connected",
    detail:
      "No WAVV ingestion exists in Paperclip. Dials, connected calls over 60 seconds, talk time and dispositions only exist in WAVV's Reports tab today.",
    needed:
      "A WAVV API key or a scheduled Reports export covering calls, conversations over 60 seconds, talk time and dispositions, with WAVV seat ids mapped to setters.",
    lastSuccessfulSync: null,
  },
  meta_ads: {
    id: "meta_ads",
    name: "Meta Marketing API",
    status: "not_connected",
    detail:
      "Paperclip has no server-side Meta Ads read connector, and Meta is never read through a browser. The agency's Meta system-user token expires 2026-12-13 and nothing in Paperclip watches it.",
    needed:
      "A Meta system-user token with ads_read on the agency ad account (read-only), stored as a Paperclip secret, plus the ad-account id for each client and an expiry reminder on the Tools board.",
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

function tile(
  input: Omit<DashboardTile, "value">,
): DashboardTile {
  return { ...input, value: notConnected() };
}

function table(input: Omit<DashboardTable, "rows">): DashboardTable {
  return { ...input, rows: [] };
}

const SALES_TILES: DashboardTile[] = [
  tile({
    id: "show-rate",
    label: "Show rate",
    definition: "Appointments held ÷ appointments booked.",
    owner: "Setters",
    target: "≥ 70% (Hormozi benchmark); < 60% red",
    sourceIds: ["ghl"],
  }),
  tile({
    id: "speed-to-lead",
    label: "Speed to lead",
    definition:
      "Median seconds from a new lead (GHL) to the first outbound call attempt (WAVV).",
    owner: "Sales manager",
    target:
      "< 60 s (Hormozi's 60-second rule); > 5 min costs you 80% of closes",
    sourceIds: ["ghl", "wavv"],
  }),
  tile({
    id: "offer-rate",
    label: "Offer rate",
    definition: "Offers made ÷ appointments held.",
    owner: "Closers",
    target:
      "Track it; no fixed target. A low offer rate means the lead flow is wrong, not the rep",
    sourceIds: ["ghl"],
  }),
  tile({
    id: "close-rate",
    label: "Close rate",
    definition: "Jobs sold ÷ offers made, and ÷ appointments held — track both.",
    owner: "Closers",
    target: "40% (Hormozi); < 30% is a sales-motion problem",
    sourceIds: ["ghl"],
  }),
  tile({
    id: "cash-collected-up-front",
    label: "Cash collected up front",
    definition:
      "Cash at close ÷ contract value. Cash means money received via GHL payments + Authorize.net.",
    owner: "Sales manager",
    target:
      "Rising; a high close rate with low cash up front means you are buying yeses",
    sourceIds: ["ghl"],
  }),
  tile({
    id: "units-sold",
    label: "Units sold",
    definition: "Booked × show × offer × close; the output of the four above.",
    owner: "Sales manager",
    target: "The output; the only result here, not a lever",
    sourceIds: ["ghl"],
  }),
  tile({
    id: "set-rate",
    label: "Set rate",
    definition: "Appointments booked ÷ new leads.",
    owner: "Setters",
    target: "v1 source, not Hormozi — 20–30% good, 35–40% elite; < 10% red",
    sourceIds: ["ghl"],
  }),
  tile({
    id: "lead-to-customer",
    label: "Lead → customer",
    definition: "Customers ÷ raw leads.",
    owner: "Sales manager",
    target:
      "v1 source, not Hormozi — about 10% for Meta leads into an in-person service business",
    sourceIds: ["ghl"],
  }),
  tile({
    id: "appointments-per-setter-day",
    label: "Appointments per setter per day",
    definition: "Held appointments ÷ setter-days.",
    owner: "Sales manager",
    target:
      "v1 source, not Hormozi — set from the top quartile per seat, not an industry average",
    sourceIds: ["ghl", "wavv"],
  }),
  tile({
    id: "dials",
    label: "Dials",
    definition: "Outbound call attempts in the period.",
    owner: "Setters",
    target:
      "v1 source, not Hormozi — red when conversations per day fall 20% week over week",
    sourceIds: ["wavv"],
  }),
  tile({
    id: "conversations-over-60s",
    label: "Conversations over 60 s",
    definition: "Connected calls longer than 60 seconds.",
    owner: "Setters",
    target:
      "v1 source, not Hormozi — red when conversations per day fall 20% week over week",
    sourceIds: ["wavv"],
  }),
  tile({
    id: "talk-time",
    label: "Talk time",
    definition: "Total connected talk time per setter.",
    owner: "Setters",
    target: "v1 source, not Hormozi — trend, not an absolute",
    sourceIds: ["wavv"],
  }),
];

const SALES_TABLES: DashboardTable[] = [
  table({
    id: "sales-by-business",
    title: "Appointments set per business",
    description:
      "One row per client. Every row is keyed by client id, so one client's numbers never mix with another's.",
    scope: "client",
    sourceIds: ["ghl"],
    columns: [
      { key: "client", label: "Client" },
      { key: "appointmentsSet", label: "Appointments set" },
      { key: "booked", label: "Booked" },
      { key: "held", label: "Held" },
      { key: "showRate", label: "Show rate" },
      { key: "jobsSold", label: "Jobs sold" },
      { key: "closeRate", label: "Close rate" },
    ],
  }),
  table({
    id: "setter-scoreboard",
    title: "Setter scoreboard",
    description: "One row per setter: activity in front of the result.",
    scope: "member",
    sourceIds: ["wavv", "ghl"],
    columns: [
      { key: "setter", label: "Setter" },
      { key: "dials", label: "Dials" },
      { key: "talkTimeMinutes", label: "Talk time (min)" },
      { key: "conversations", label: "Conversations > 60 s" },
      { key: "sets", label: "Sets" },
      { key: "showRate", label: "Show rate" },
    ],
  }),
];

const MARKETING_TILES: DashboardTile[] = [
  tile({
    id: "cac-per-client",
    label: "CAC per client",
    definition:
      "All-in cost to win one customer: (media + sales + software) ÷ new customers.",
    owner: "Media buyer",
    target: "Judge against LTGP, never against CPL",
    sourceIds: ["meta_ads", "ghl"],
  }),
  tile({
    id: "creative-budget-split",
    label: "Creative budget split",
    definition:
      "Share of ad budget split between the proven core ad, adjacent variations and new ideas.",
    owner: "Media buyer",
    target: "70 / 20 / 10 (core / adjacent / new)",
    sourceIds: ["meta_ads"],
  }),
  tile({
    id: "ad-spend",
    label: "Ad spend",
    definition: "Spend in the period, per client.",
    owner: "Media buyer",
    target: "v1 source, not Hormozi — 0.95–1.05 of planned pacing green; > 1.15 red",
    sourceIds: ["meta_ads"],
  }),
  tile({
    id: "new-leads",
    label: "New leads",
    definition: "Leads created in the period.",
    owner: "Media buyer",
    target:
      "v1 source, not Hormozi — measured against the client's own 7- and 14-day baseline",
    sourceIds: ["ghl"],
  }),
  tile({
    id: "cost-per-held-appointment",
    label: "Cost per held appointment",
    definition: "Spend ÷ appointments held.",
    owner: "Media buyer",
    target:
      "v1 source, not Hormozi — under (job value × close rate × margin) ÷ 3",
    sourceIds: ["meta_ads", "ghl"],
  }),
  tile({
    id: "ctr",
    label: "CTR",
    definition: "Link clicks ÷ impressions.",
    owner: "Media buyer",
    target:
      "1% → 4% is a 4× front-end gain; judge against the client's own baseline",
    sourceIds: ["meta_ads"],
  }),
  tile({
    id: "cost-per-lead",
    label: "Cost per lead",
    definition: "Spend ÷ new leads.",
    owner: "Media buyer",
    target: "Reference only, never a target",
    sourceIds: ["meta_ads", "ghl"],
  }),
  tile({
    id: "spend-with-zero-leads",
    label: "Spend with zero leads",
    definition:
      "Client-days in the last 7 with spend over $100 and no new lead. This is an alarm, not a scorecard row.",
    owner: "Media buyer",
    target: "v1 source, not Hormozi — zero client-days",
    sourceIds: ["meta_ads", "ghl"],
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
    title: "Marketing per client",
    description:
      "One row per client, keyed by client id. ROAS is the drill-down under CAC, never a headline tile.",
    scope: "client",
    sourceIds: ["meta_ads", "ghl"],
    columns: [
      { key: "client", label: "Client" },
      { key: "spend", label: "Spend" },
      { key: "leads", label: "Leads" },
      { key: "newCustomers", label: "New customers" },
      { key: "cac", label: "CAC" },
      { key: "roas", label: "ROAS (drill-down)" },
      { key: "costPerLead", label: "Cost per lead" },
      { key: "appointmentsHeld", label: "Appointments held" },
      { key: "costPerHeldAppointment", label: "Cost per held appointment" },
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

/**
 * Builds one board payload. `now` is injectable so tests can pin the
 * generated-at timestamp; nothing else about a payload depends on the clock.
 * `adapters` lets a test supply a roster reader, fetch implementation, or WAVV
 * reader without a network.
 */
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

function isMissingJudgedOn(value: string | null | undefined): boolean {
  if (!value) return true;
  const trimmed = value.trim();
  if (!trimmed) return true;
  return /^NOT SET\b/i.test(trimmed);
}

interface AggregatedPortfolio {
  observedAt: string;
  hasGhl: boolean;
  hasMeta: boolean;
  newLeads: number;
  hasNewLeads: boolean;
  booked: number;
  hasBooked: boolean;
  showed: number;
  hasShowed: boolean;
  pitched: number;
  hasPitched: boolean;
  wonDeals: number;
  hasWonDeals: boolean;
  cashCollectedUsd: number;
  hasCashCollected: boolean;
  pipelineRevenueUsd: number;
  hasPipelineRevenue: boolean;
  fallbackShowRate: number | null;
  fallbackCloseRate: number | null;
  speedToLeadSeconds: number | null;
  spend: number;
  hasSpend: boolean;
  impressions: number;
  hasImpressions: boolean;
  clicks: number;
  hasClicks: boolean;
  zeroLeadDays: number;
  hasZeroLeadDays: boolean;
}

function aggregatePortfolio(bundle: PortfolioSnapshotBundle): AggregatedPortfolio | null {
  if (bundle.clients.length === 0 || !bundle.observedAt) return null;

  let newLeads = 0;
  let hasNewLeads = false;
  let booked = 0;
  let hasBooked = false;
  let showed = 0;
  let hasShowed = false;
  let pitched = 0;
  let hasPitched = false;
  let wonDeals = 0;
  let hasWonDeals = false;
  let cashCollectedUsd = 0;
  let hasCashCollected = false;
  let pipelineRevenueUsd = 0;
  let hasPipelineRevenue = false;
  let fallbackShowRate: number | null = null;
  let fallbackCloseRate: number | null = null;
  let speedSum = 0;
  let speedCount = 0;
  let spend = 0;
  let hasSpend = false;
  let impressions = 0;
  let hasImpressions = false;
  let clicks = 0;
  let hasClicks = false;
  let zeroLeadDays = 0;
  let hasZeroLeadDays = false;

  for (const c of bundle.clients) {
    if (c.newLeads !== null) {
      newLeads += c.newLeads;
      hasNewLeads = true;
    }
    if (c.booked !== null) {
      booked += c.booked;
      hasBooked = true;
    }
    if (c.showed !== null) {
      showed += c.showed;
      hasShowed = true;
    }
    if (c.pitched !== null) {
      pitched += c.pitched;
      hasPitched = true;
    }
    if (c.wonDeals !== null) {
      wonDeals += c.wonDeals;
      hasWonDeals = true;
    }
    if (c.cashCollectedUsd !== null && c.cashCollectedUsd > 0) {
      cashCollectedUsd += c.cashCollectedUsd;
      hasCashCollected = true;
    }
    if (c.pipelineRevenueUsd !== null && c.pipelineRevenueUsd > 0) {
      pipelineRevenueUsd += c.pipelineRevenueUsd;
      hasPipelineRevenue = true;
    }
    if (fallbackShowRate === null && c.showRate !== null) {
      fallbackShowRate = c.showRate;
    }
    if (fallbackCloseRate === null && c.closeRate !== null) {
      fallbackCloseRate = c.closeRate;
    }
    if (c.speedToLeadSeconds !== null && c.speedToLeadSeconds >= 0) {
      speedSum += c.speedToLeadSeconds;
      speedCount += 1;
    }
    if (c.spend !== null) {
      spend += c.spend;
      hasSpend = true;
    }
    if (c.impressions !== null) {
      impressions += c.impressions;
      hasImpressions = true;
    }
    if (c.clicks !== null) {
      clicks += c.clicks;
      hasClicks = true;
    }
    if (c.zeroLeadDays !== null) {
      zeroLeadDays += c.zeroLeadDays;
      hasZeroLeadDays = true;
    }
  }

  return {
    observedAt: bundle.observedAt,
    hasGhl: hasNewLeads || hasBooked || hasShowed || hasWonDeals || fallbackShowRate !== null,
    hasMeta: hasSpend || hasImpressions || hasClicks,
    newLeads,
    hasNewLeads,
    booked,
    hasBooked,
    showed,
    hasShowed,
    pitched,
    hasPitched,
    wonDeals,
    hasWonDeals,
    cashCollectedUsd: round2(cashCollectedUsd),
    hasCashCollected,
    pipelineRevenueUsd: round2(pipelineRevenueUsd),
    hasPipelineRevenue,
    fallbackShowRate,
    fallbackCloseRate,
    speedToLeadSeconds: speedCount > 0 ? Math.round(speedSum / speedCount) : null,
    spend: round2(spend),
    hasSpend,
    impressions,
    hasImpressions,
    clicks,
    hasClicks,
    zeroLeadDays,
    hasZeroLeadDays,
  };
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

function salesByBusinessRows(clients: MergedClientMetrics[]): DashboardTableRow[] {
  return clients
    .filter(
      (c) =>
        c.booked !== null ||
        c.showed !== null ||
        c.wonDeals !== null ||
        c.newLeads !== null ||
        c.showRate !== null ||
        c.closeRate !== null,
    )
    .map((c) => ({
      id: c.slug,
      cells: {
        client: c.displayName,
        appointmentsSet: c.booked,
        booked: c.booked,
        held: c.showed,
        showRate: c.showRate !== null ? `${c.showRate}%` : null,
        jobsSold: c.wonDeals,
        closeRate: c.closeRate !== null ? `${c.closeRate}%` : null,
      },
    }));
}

function setterScoreboardRows(wavv: WavvSummary | null): DashboardTableRow[] {
  if (!wavv || wavv.bySetter.length === 0) return [];
  return wavv.bySetter.map((s) => ({
    id: s.id,
    cells: {
      setter: s.setter,
      dials: s.dials,
      talkTimeMinutes: s.talkTimeMinutes,
      conversations: s.conversationsOver60s,
      sets: null,
      showRate: null,
    },
  }));
}

function marketingByClientRows(clients: MergedClientMetrics[]): DashboardTableRow[] {
  return clients
    .filter(
      (c) =>
        c.spend !== null ||
        c.newLeads !== null ||
        c.wonDeals !== null ||
        c.showed !== null ||
        c.cpl !== null ||
        c.cac !== null,
    )
    .map((c) => ({
      id: c.slug,
      cells: {
        client: c.displayName,
        spend: c.spend,
        leads: c.newLeads,
        newCustomers: c.wonDeals,
        cac: c.cac,
        roas: c.roas,
        costPerLead: c.cpl,
        appointmentsHeld: c.showed,
        costPerHeldAppointment: c.costPerHeldAppointment,
        zeroLeadDays: c.zeroLeadDays,
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
    const salesUsd = qboRevenue ?? extractRevenueUsd(capital, period);
    const observedAt =
      qboRevenue !== null && qbo
        ? qbo.observedAt
        : capital?.generatedAt ?? roster.observedAt;
    if (salesUsd !== null && active.length > 0) {
      return liveVal(round2(salesUsd / active.length), "usd", observedAt);
    }
    return notConnected();
  }
  return null;
}

function resolveTileValue(
  tileId: string,
  period: DashboardPeriod,
  agg: AggregatedPortfolio | null,
  wavv: WavvSummary | null,
  roster: Awaited<ReturnType<TeamRosterAdapter["read"]>>,
  capital: CapitalApiPayload | null,
  qbo: AgencyQuickBooksFinancials | null = null,
): DashboardTileValue {
  const hasSalesDashKey = Boolean((process.env.SALES_DASHBOARD_ADMIN_KEY ?? "").trim());

  if (roster && (hasSalesDashKey || capital || qbo)) {
    const teamTile = resolveHumanEmployeesTile(tileId, period, roster, capital, qbo);
    if (teamTile) return teamTile;
  }

  // WAVV dialer tiles: NEVER invent Dials: 0 when WAVV is not connected
  if (tileId === "dials") {
    return wavv ? liveVal(wavv.dials, "count", wavv.observedAt) : notConnected();
  }
  if (tileId === "conversations-over-60s") {
    return wavv ? liveVal(wavv.conversationsOver60s, "count", wavv.observedAt) : notConnected();
  }
  if (tileId === "talk-time") {
    return wavv ? liveVal(wavv.talkTimeMinutes, "minutes", wavv.observedAt) : notConnected();
  }

  if (!agg) return notConnected();
  const ts = agg.observedAt;

  switch (tileId) {
    case "show-rate":
      if (agg.hasBooked && agg.booked > 0 && agg.hasShowed) {
        return liveVal(round1((agg.showed / agg.booked) * 100), "percent", ts);
      }
      return liveVal(agg.fallbackShowRate, "percent", ts);
    case "speed-to-lead":
      return liveVal(agg.speedToLeadSeconds, "seconds", ts);
    case "offer-rate":
      return agg.hasShowed && agg.showed > 0 && agg.hasPitched
        ? liveVal(round1((agg.pitched / agg.showed) * 100), "percent", ts)
        : notConnected();
    case "close-rate":
      if (agg.hasPitched && agg.pitched > 0 && agg.hasWonDeals) {
        return liveVal(round1((agg.wonDeals / agg.pitched) * 100), "percent", ts);
      }
      if (agg.hasShowed && agg.showed > 0 && agg.hasWonDeals) {
        return liveVal(round1((agg.wonDeals / agg.showed) * 100), "percent", ts);
      }
      return liveVal(agg.fallbackCloseRate, "percent", ts);
    case "cash-collected-up-front":
      return agg.hasPipelineRevenue && agg.pipelineRevenueUsd > 0 && agg.hasCashCollected
        ? liveVal(round1((agg.cashCollectedUsd / agg.pipelineRevenueUsd) * 100), "percent", ts)
        : notConnected();
    case "units-sold":
      return agg.hasWonDeals ? liveVal(agg.wonDeals, "count", ts) : notConnected();
    case "set-rate":
      return agg.hasNewLeads && agg.newLeads > 0 && agg.hasBooked
        ? liveVal(round1((agg.booked / agg.newLeads) * 100), "percent", ts)
        : notConnected();
    case "lead-to-customer":
      return agg.hasNewLeads && agg.newLeads > 0 && agg.hasWonDeals
        ? liveVal(round1((agg.wonDeals / agg.newLeads) * 100), "percent", ts)
        : notConnected();
    case "cac-per-client":
      return agg.hasSpend && agg.hasWonDeals && agg.wonDeals > 0
        ? liveVal(round2(agg.spend / agg.wonDeals), "usd", ts)
        : notConnected();
    case "ad-spend":
      return agg.hasSpend ? liveVal(agg.spend, "usd", ts) : notConnected();
    case "new-leads":
      return agg.hasNewLeads ? liveVal(agg.newLeads, "count", ts) : notConnected();
    case "ctr":
      return agg.hasImpressions && agg.impressions > 0 && agg.hasClicks
        ? liveVal(round2((agg.clicks / agg.impressions) * 100), "percent", ts)
        : notConnected();
    case "cost-per-lead":
      return agg.hasNewLeads && agg.newLeads > 0 && agg.hasSpend
        ? liveVal(round2(agg.spend / agg.newLeads), "usd", ts)
        : notConnected();
    case "cost-per-held-appointment":
      return agg.hasShowed && agg.showed > 0 && agg.hasSpend
        ? liveVal(round2(agg.spend / agg.showed), "usd", ts)
        : notConnected();
    case "spend-with-zero-leads":
      return agg.hasZeroLeadDays ? liveVal(agg.zeroLeadDays, "count", ts) : notConnected();
    default:
      return notConnected();
  }
}

export function dashboardBoardService(
  now: () => Date = () => new Date(),
  adapters: {
    teamRoster?: TeamRosterAdapter;
    fetchImpl?: typeof fetch;
    wavvReader?: (period: DashboardPeriod) => Promise<WavvSummary | null>;
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

      const [roster, capital, bundle, wavv, qbo] = allowInstanceData
        ? await Promise.all([
            board === "human-employees" ? teamRoster.read(companyId) : Promise.resolve(null),
            board === "human-employees"
              ? fetchSalesCapital(period, { fetchImpl: adapters.fetchImpl })
              : Promise.resolve(null),
            board === "sales" || board === "marketing"
              ? readPortfolioSnapshotBundle(period, { fetchImpl: adapters.fetchImpl })
              : Promise.resolve(null),
            board === "sales"
              ? (adapters.wavvReader
                  ? adapters.wavvReader(period)
                  : readWavvSummary(period, { fetchImpl: adapters.fetchImpl, now }))
              : Promise.resolve(null),
            board === "human-employees"
              ? (adapters.quickbooksReader
                  ? adapters.quickbooksReader(period)
                  : readAgencyQuickBooksFinancials(period, { fetchImpl: adapters.fetchImpl, now }))
              : Promise.resolve(null),
          ])
        : [null, null, null, null, null];

      const agg = bundle ? aggregatePortfolio(bundle) : null;

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
        if (src.id === "ghl" && agg?.hasGhl) {
          return {
            ...src,
            status: "connected" as const,
            detail: "Connected to live multi-client Sales Dashboard GHL snapshots.",
            lastSuccessfulSync: agg.observedAt,
          };
        }
        if (src.id === "meta_ads" && agg?.hasMeta) {
          return {
            ...src,
            status: "connected" as const,
            detail: "Connected to live multi-client Meta & Neon Ads portfolio data.",
            lastSuccessfulSync: agg.observedAt,
          };
        }
        if (src.id === "wavv" && wavv) {
          return {
            ...src,
            status: "connected" as const,
            detail: "Connected to live WAVV call feed via OAuth Gateway.",
            lastSuccessfulSync: wavv.observedAt,
          };
        }
        return src;
      });

      let meta: DashboardBoardMeta | undefined;
      if (board === "human-employees" && (capital || (roster && (process.env.SALES_DASHBOARD_ADMIN_KEY ?? "").trim()))) {
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

        meta = {
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

      const resolveTableRows = (tableId: string): DashboardTableRow[] => {
        if (tableId === "team-roster" && roster) return teamRosterRows(roster.members);
        if (tableId === "sales-by-business" && bundle) return salesByBusinessRows(bundle.clients);
        if (tableId === "setter-scoreboard") return setterScoreboardRows(wavv);
        if (tableId === "marketing-by-client" && bundle) {
          return marketingByClientRows(bundle.clients);
        }
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
          value: resolveTileValue(item.id, period, agg, wavv, roster, capital, qbo),
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
