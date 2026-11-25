import type {
  DashboardBoard,
  DashboardBoardId,
  DashboardSource,
  DashboardSourceId,
  DashboardTable,
  DashboardTile,
  DashboardTileValue,
} from "@paperclipai/shared";
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
 * `adapters` lets a test supply a roster reader without a network.
 */
interface SalesSnapshotPayload {
  observedAt: string;
  ghl?: {
    newLeads?: number;
    appointmentsBooked?: number;
    showedAppointments?: number;
    wonDeals?: number;
    closeRate?: number | null;
    showRate?: number | null;
  };
  meta?: {
    spend?: number;
    impressions?: number;
    clicks?: number;
  };
  calls?: {
    outboundCalls?: number;
  };
  cash?: {
    cashCollectedUsd?: number;
  };
}

async function readSalesSnapshot(fetchImpl: typeof fetch = fetch): Promise<SalesSnapshotPayload | null> {
  if (!(process.env.SALES_DASHBOARD_ADMIN_KEY ?? "").trim()) return null;
  const base = (process.env.SALES_DASHBOARD_BASE_URL ?? "https://dashboard.increaseai.tech").trim().replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetchImpl(`${base}/api/pilot/dashboard?view=30d`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      lastSuccessfulSyncAt?: string;
      generatedAt?: string;
      summary?: {
        ghl?: { status?: string; data?: SalesSnapshotPayload["ghl"] };
        meta?: { status?: string; data?: SalesSnapshotPayload["meta"] };
        calls?: { status?: string; data?: SalesSnapshotPayload["calls"] };
        cash?: { status?: string; data?: SalesSnapshotPayload["cash"] };
      };
    };
    const s = body?.summary;
    if (!s) return null;
    return {
      observedAt: body.lastSuccessfulSyncAt ?? body.generatedAt ?? new Date().toISOString(),
      ghl: s.ghl?.status === "LIVE" ? s.ghl.data : undefined,
      meta: s.meta?.status === "LIVE" ? s.meta.data : undefined,
      calls: s.calls?.status === "LIVE" ? s.calls.data : undefined,
      cash: s.cash?.status === "LIVE" ? s.cash.data : undefined,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function liveVal(value: number | null | undefined, unit: DashboardTileValue extends { kind: "live"; unit: infer U } ? U : never, observedAt: string): DashboardTileValue {
  if (typeof value !== "number" || !Number.isFinite(value)) return notConnected();
  return { kind: "live", value, unit, observedAt };
}

function resolveTileValue(
  tileId: string,
  snap: SalesSnapshotPayload | null,
  roster: Awaited<ReturnType<TeamRosterAdapter["read"]>>,
): DashboardTileValue {
  if (roster && (process.env.SALES_DASHBOARD_ADMIN_KEY ?? "").trim()) {
    const active = roster.members.filter((m) => m.status.toLowerCase() === "active");
    if (tileId === "active-team-members") return liveVal(active.length, "count", roster.observedAt);
    if (tileId === "seats-without-judged-on-number") {
      const missing = active.filter((m) => !m.judgedOn || m.judgedOn.trim().toUpperCase() === "NOT SET").length;
      return liveVal(missing, "count", roster.observedAt);
    }
  }
  if (!snap) return notConnected();
  const ts = snap.observedAt;
  const ghl = snap.ghl;
  const meta = snap.meta;
  switch (tileId) {
    case "show-rate":
      return liveVal(ghl?.showRate, "percent", ts);
    case "close-rate":
      return liveVal(ghl?.closeRate, "percent", ts);
    case "units-sold":
      return liveVal(ghl?.wonDeals, "count", ts);
    case "set-rate":
      return ghl?.newLeads && ghl.newLeads > 0 && typeof ghl.appointmentsBooked === "number"
        ? liveVal(Math.round((ghl.appointmentsBooked / ghl.newLeads) * 1000) / 10, "percent", ts)
        : notConnected();
    case "lead-to-customer":
      return ghl?.newLeads && ghl.newLeads > 0 && typeof ghl.wonDeals === "number"
        ? liveVal(Math.round((ghl.wonDeals / ghl.newLeads) * 1000) / 10, "percent", ts)
        : notConnected();
    case "dials":
      return liveVal(snap.calls?.outboundCalls, "count", ts);
    case "ad-spend":
      return liveVal(meta?.spend, "usd", ts);
    case "new-leads":
      return liveVal(ghl?.newLeads, "count", ts);
    case "ctr":
      return meta?.impressions && meta.impressions > 0 && typeof meta.clicks === "number"
        ? liveVal(Math.round((meta.clicks / meta.impressions) * 10000) / 100, "percent", ts)
        : notConnected();
    case "cost-per-lead":
      return ghl?.newLeads && ghl.newLeads > 0 && typeof meta?.spend === "number"
        ? liveVal(Math.round((meta.spend / ghl.newLeads) * 100) / 100, "usd", ts)
        : notConnected();
    case "cost-per-held-appointment":
      return ghl?.showedAppointments && ghl.showedAppointments > 0 && typeof meta?.spend === "number"
        ? liveVal(Math.round((meta.spend / ghl.showedAppointments) * 100) / 100, "usd", ts)
        : notConnected();
    default:
      return notConnected();
  }
}

export function dashboardBoardService(
  now: () => Date = () => new Date(),
  adapters: { teamRoster?: TeamRosterAdapter; fetchImpl?: typeof fetch } = {},
) {
  const teamRoster = adapters.teamRoster ?? teamCapitalAdapter(adapters.fetchImpl);

  return {
    async board(board: DashboardBoardId, companyId: string): Promise<DashboardBoard> {
      const definition = BOARD_DEFINITIONS[board];
      if (!definition) throw new Error(`Unknown dashboard board: ${board}`);

      const roster = board === "human-employees" ? await teamRoster.read(companyId) : null;
      const snap = board === "sales" || board === "marketing" ? await readSalesSnapshot(adapters.fetchImpl) : null;

      const sourceIds = new Set<DashboardSourceId>();
      for (const item of [...definition.tiles, ...definition.tables]) {
        for (const id of item.sourceIds) sourceIds.add(id);
      }

      const sources = sourcesFor([...sourceIds]).map((src) => {
        if (src.id === "team_capital" && roster) {
          return { ...src, status: "connected" as const, detail: "Connected to live Team & capital roster.", lastSuccessfulSync: roster.observedAt };
        }
        if (src.id === "ghl" && snap?.ghl) {
          return { ...src, status: "connected" as const, detail: "Connected to live Sales Dashboard GHL snapshot.", lastSuccessfulSync: snap.observedAt };
        }
        if (src.id === "meta_ads" && snap?.meta) {
          return { ...src, status: "connected" as const, detail: "Connected to live Sales Dashboard Meta snapshot.", lastSuccessfulSync: snap.observedAt };
        }
        return src;
      });

      return {
        board,
        companyId,
        generatedAt: now().toISOString(),
        sources,
        tiles: definition.tiles.map((item) => ({
          ...item,
          sourceIds: [...item.sourceIds],
          value: resolveTileValue(item.id, snap, roster),
        })),
        tables: definition.tables.map((item) => ({
          ...item,
          sourceIds: [...item.sourceIds],
          columns: item.columns.map((column) => ({ ...column })),
          rows: roster && item.id === "team-roster" ? teamRosterRows(roster.members) : [],
        })),
      };
    },
  };
}
