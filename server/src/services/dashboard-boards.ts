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
    id: "speed-to-lead",
    label: "Speed to lead",
    definition:
      "Median seconds from a new lead (GHL) to the first outbound call attempt (WAVV).",
    owner: "Sales manager",
    target: "< 60 seconds green; > 5 minutes red",
    sourceIds: ["ghl", "wavv"],
  }),
  tile({
    id: "set-rate",
    label: "Set rate",
    definition: "Appointments booked ÷ new leads.",
    owner: "Setters",
    target: "20–30% good, 35–40% elite; < 10% red",
    sourceIds: ["ghl"],
  }),
  tile({
    id: "show-rate",
    label: "Show rate",
    definition: "Appointments held ÷ appointments booked.",
    owner: "Setters",
    target: "70–80% healthy; < 60% red",
    sourceIds: ["ghl"],
  }),
  tile({
    id: "close-rate",
    label: "Close rate (held → sold)",
    definition: "Jobs sold ÷ appointments held.",
    owner: "Closers",
    target: "35% target; < 30% is a sales-motion problem",
    sourceIds: ["ghl"],
  }),
  tile({
    id: "lead-to-customer",
    label: "Lead → customer",
    definition: "Customers ÷ raw leads.",
    owner: "Sales manager",
    target: "About 10% for Meta leads into an in-person service business",
    sourceIds: ["ghl"],
  }),
  tile({
    id: "appointments-per-setter-day",
    label: "Appointments per setter per day",
    definition: "Held appointments ÷ setter-days.",
    owner: "Sales manager",
    target: "Top-quartile per seat; no industry average",
    sourceIds: ["ghl", "wavv"],
  }),
  tile({
    id: "dials",
    label: "Dials",
    definition: "Outbound call attempts in the period.",
    owner: "Setters",
    target: "Red when conversations per day fall 20% week over week",
    sourceIds: ["wavv"],
  }),
  tile({
    id: "conversations-over-60s",
    label: "Conversations over 60 s",
    definition: "Connected calls longer than 60 seconds.",
    owner: "Setters",
    target: "Red when conversations per day fall 20% week over week",
    sourceIds: ["wavv"],
  }),
  tile({
    id: "talk-time",
    label: "Talk time",
    definition: "Total connected talk time per setter.",
    owner: "Setters",
    target: "Trend, not an absolute",
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
    id: "ad-spend",
    label: "Ad spend",
    definition: "Spend in the period, per client.",
    owner: "Media buyer",
    target: "0.95–1.05 of planned pacing green; > 1.15 red",
    sourceIds: ["meta_ads"],
  }),
  tile({
    id: "new-leads",
    label: "New leads",
    definition: "Leads created in the period.",
    owner: "Media buyer",
    target: "Measured against the client's own 7- and 14-day baseline",
    sourceIds: ["ghl"],
  }),
  tile({
    id: "cost-per-lead",
    label: "Cost per lead",
    definition: "Spend ÷ new leads.",
    owner: "Media buyer",
    target:
      "$42.95 is the US home-improvement Meta average, a reference only; red at 2× the client's 90-day median",
    sourceIds: ["meta_ads", "ghl"],
  }),
  tile({
    id: "cost-per-held-appointment",
    label: "Cost per held appointment",
    definition: "Spend ÷ appointments held.",
    owner: "Media buyer",
    target: "Under (job value × close rate × margin) ÷ 3",
    sourceIds: ["meta_ads", "ghl"],
  }),
  tile({
    id: "spend-with-zero-leads",
    label: "Spend with zero leads",
    definition:
      "Client-days in the last 7 with spend over $100 and no new lead. This is an alarm, not a scorecard row.",
    owner: "Media buyer",
    target: "Zero client-days",
    sourceIds: ["meta_ads", "ghl"],
  }),
  tile({
    id: "click-to-lead",
    label: "Click → lead",
    definition: "Leads ÷ link clicks.",
    owner: "Media buyer",
    target: "5.32% home-improvement average; < 3% means a landing-page or form problem",
    sourceIds: ["meta_ads", "ghl"],
  }),
  tile({
    id: "spend-pacing",
    label: "Spend pacing",
    definition: "Spend to date ÷ (daily budget × days elapsed).",
    owner: "Media buyer",
    target: "0.95–1.05 green; > 1.15 red",
    sourceIds: ["meta_ads"],
  }),
];

const MARKETING_TABLES: DashboardTable[] = [
  table({
    id: "marketing-by-client",
    title: "Marketing per client",
    description:
      "One row per client, keyed by client id. Spend and leads share the same window for every row.",
    scope: "client",
    sourceIds: ["meta_ads", "ghl"],
    columns: [
      { key: "client", label: "Client" },
      { key: "spend", label: "Spend" },
      { key: "leads", label: "Leads" },
      { key: "costPerLead", label: "Cost per lead" },
      { key: "appointmentsHeld", label: "Appointments held" },
      { key: "costPerHeldAppointment", label: "Cost per held appointment" },
      { key: "zeroLeadDays", label: "Zero-lead days" },
    ],
  }),
];

const HUMAN_EMPLOYEE_TILES: DashboardTile[] = [
  tile({
    id: "active-team-members",
    label: "Active team members",
    definition: "People with status active in the roster.",
    owner: "Alex",
    target: "Every active seat has a rate and one judged-on number",
    sourceIds: ["team_capital"],
  }),
  tile({
    id: "revenue-per-fte",
    label: "Revenue per FTE",
    definition: "Trailing-12-month revenue ÷ full-time equivalents.",
    owner: "Alex",
    target: "$150–200K; red below $120K",
    sourceIds: ["team_capital"],
  }),
  tile({
    id: "utilization",
    label: "Utilization",
    definition: "Billable or delivery hours ÷ available hours, per delivery role.",
    owner: "Fulfillment lead",
    target: "65–75%; red above 85% (burnout) or below 60%",
    sourceIds: ["team_capital"],
  }),
  tile({
    id: "regrettable-attrition",
    label: "Regrettable attrition",
    definition: "A-players lost ÷ A-players, trailing 12 months.",
    owner: "Alex",
    target: "Zero; any loss needs a written cause",
    sourceIds: ["team_capital"],
  }),
  tile({
    id: "seats-without-judged-on-number",
    label: "Seats without a judged-on number",
    definition:
      "Active seats whose performance criterion is empty or reads NOT SET.",
    owner: "Alex",
    target: "Zero",
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
export function dashboardBoardService(
  now: () => Date = () => new Date(),
  adapters: { teamRoster?: TeamRosterAdapter } = {},
) {
  const teamRoster = adapters.teamRoster ?? teamCapitalAdapter();

  return {
    async board(board: DashboardBoardId, companyId: string): Promise<DashboardBoard> {
      const definition = BOARD_DEFINITIONS[board];
      if (!definition) throw new Error(`Unknown dashboard board: ${board}`);

      const roster = board === "human-employees" ? await teamRoster.read(companyId) : null;

      const sourceIds = new Set<DashboardSourceId>();
      for (const item of [...definition.tiles, ...definition.tables]) {
        for (const id of item.sourceIds) sourceIds.add(id);
      }

      return {
        board,
        companyId,
        generatedAt: now().toISOString(),
        sources: sourcesFor([...sourceIds]),
        tiles: definition.tiles.map((item) => ({
          ...item,
          sourceIds: [...item.sourceIds],
          value: notConnected(),
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
