import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DASHBOARD_BOARD_IDS, type DashboardBoardId } from "@paperclipai/shared";
import { dashboardBoardService } from "./dashboard-boards.js";
import type { TeamRosterAdapter } from "./dashboard-team-roster.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";
const pinnedNow = () => new Date("2026-11-23T12:00:00.000Z");

const ENV_KEYS = ["SALES_DASHBOARD_ADMIN_KEY", "GATEWAY_PAPERCLIP_KEY", "GATEWAY_WAVV_KEY"] as const;

function board(id: DashboardBoardId, forCompany = companyId) {
  return dashboardBoardService(pinnedNow).board(id, forCompany);
}

describe("dashboardBoardService", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });
  it.each(DASHBOARD_BOARD_IDS)("scopes the %s board to the requested company", async (id) => {
    const payload = await board(id);
    expect(payload.board).toBe(id);
    expect(payload.companyId).toBe(companyId);
    expect(payload.generatedAt).toBe("2026-11-23T12:00:00.000Z");
  });

  it.each(DASHBOARD_BOARD_IDS)("never invents a %s value while its sources are missing", async (id) => {
    const payload = await board(id);
    expect(payload.tiles.length).toBeGreaterThan(0);
    for (const tile of payload.tiles) {
      expect(tile.value.kind).toBe("not_connected");
      expect(tile.value).not.toHaveProperty("value");
      expect(tile.sourceIds.length).toBeGreaterThan(0);
      expect(tile.owner.length).toBeGreaterThan(0);
      expect(tile.target.length).toBeGreaterThan(0);
      expect(tile.definition.length).toBeGreaterThan(0);
    }
    // Nothing anywhere in the payload may claim a live reading.
    expect(JSON.stringify(payload)).not.toContain('"kind":"live"');
  });

  it.each(DASHBOARD_BOARD_IDS)("returns no %s rows without a source", async (id) => {
    for (const table of (await board(id)).tables) {
      expect(table.rows).toEqual([]);
      expect(table.columns.length).toBeGreaterThan(0);
      expect(table.sourceIds.length).toBeGreaterThan(0);
    }
  });

  it.each(DASHBOARD_BOARD_IDS)("names every %s source and what it needs", async (id) => {
    const payload = await board(id);
    expect(payload.sources.length).toBeGreaterThan(0);
    for (const source of payload.sources) {
      expect(source.status).toBe("not_connected");
      expect(source.detail.length).toBeGreaterThan(0);
      expect(source.needed.length).toBeGreaterThan(0);
      expect(source.lastSuccessfulSync).toBeNull();
    }
    // Every tile and table source appears in the source list.
    const listed = new Set(payload.sources.map((source) => source.id));
    for (const item of [...payload.tiles, ...payload.tables]) {
      for (const sourceId of item.sourceIds) expect(listed.has(sourceId)).toBe(true);
    }
  });

  it("orders sales around Hormozi's five numbers, with show rate first", async () => {
    const payload = await board("sales");
    const ids = payload.tiles.map((tile) => tile.id);
    const five = [
      "show-rate",
      "offer-rate",
      "close-rate",
      "cash-collected-up-front",
      "units-sold",
    ];
    const positions = five.map((id) => ids.indexOf(id));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(ids[0]).toBe("show-rate");
    expect(ids[1]).toBe("speed-to-lead");
    const tables = payload.tables.map((table) => table.id);
    expect(tables).toEqual(expect.arrayContaining(["sales-by-business", "setter-scoreboard"]));
    expect(payload.tables.find((table) => table.id === "sales-by-business")?.scope).toBe("client");
  });

  it("gives the five sales numbers their v2 targets", async () => {
    const payload = await board("sales");
    const byId = new Map(payload.tiles.map((tile) => [tile.id, tile]));
    expect(byId.get("show-rate")?.target).toContain("70%");
    expect(byId.get("close-rate")?.target).toContain("40%");
    expect(byId.get("offer-rate")?.target).toContain("Track it");
    expect(byId.get("cash-collected-up-front")?.target).toContain("buying yeses");
    expect(byId.get("units-sold")?.target).toContain("result");
    const speed = byId.get("speed-to-lead");
    expect(speed?.target).toContain("60");
    expect(speed?.target).toContain("80% of closes");
    expect(JSON.stringify(payload)).not.toContain("HBR");
  });

  it("keeps every other v1 sales tile and labels it as v1", async () => {
    const payload = await board("sales");
    const byId = new Map(payload.tiles.map((tile) => [tile.id, tile]));
    for (const id of [
      "set-rate",
      "lead-to-customer",
      "appointments-per-setter-day",
      "dials",
      "conversations-over-60s",
      "talk-time",
    ]) {
      expect(byId.get(id)?.target).toContain("v1 source");
    }
  });

  it("puts CAC first and keeps CPL as a reference number", async () => {
    const payload = await board("marketing");
    const ids = payload.tiles.map((tile) => tile.id);
    expect(ids[0]).toBe("cac-per-client");
    const byId = new Map(payload.tiles.map((tile) => [tile.id, tile]));
    expect(byId.get("cac-per-client")?.target).toContain("LTGP");
    expect(byId.get("cost-per-lead")?.target).toBe("Reference only, never a target");
    expect(JSON.stringify(payload)).not.toContain("42.95");
    expect(payload.tables[0]?.scope).toBe("client");
  });

  it("adds the 70/20/10 creative split and replaces click-to-lead with CTR", async () => {
    const payload = await board("marketing");
    const ids = payload.tiles.map((tile) => tile.id);
    expect(ids).toContain("creative-budget-split");
    expect(ids).not.toContain("click-to-lead");
    expect(ids).not.toContain("learning-limited-ad-sets");
    const byId = new Map(payload.tiles.map((tile) => [tile.id, tile]));
    expect(byId.get("creative-budget-split")?.target).toContain("70 / 20 / 10");
    expect(byId.get("ctr")?.definition).toContain("Link clicks ÷ impressions");
    expect(byId.get("ctr")?.target).toContain("4×");
  });

  it("demotes ROAS to a drill-down under CAC, not a headline tile", async () => {
    const payload = await board("marketing");
    expect(payload.tiles.some((tile) => tile.id.includes("roas"))).toBe(false);
    const table = payload.tables.find((item) => item.id === "marketing-by-client");
    expect(table?.columns.map((column) => column.key)).toEqual(expect.arrayContaining(["cac", "roas"]));
  });

  it("starts human employees with one number per seat and the metrics a seat can name", async () => {
    const payload = await board("human-employees");
    const ids = payload.tiles.map((tile) => tile.id);
    expect(ids[0]).toBe("one-number-per-seat");
    expect(ids[1]).toBe("metrics-a-seat-can-name");
    const revenue = payload.tiles.find((tile) => tile.id === "revenue-per-fte");
    expect(revenue?.target).toContain("Direction only");
  });

  it("removes the Leila-sourced human-employee numbers", async () => {
    const payload = await board("human-employees");
    expect(JSON.stringify(payload)).not.toMatch(/leila|day-90|day 90|underperformer/i);
  });

  it("gives the human-employees roster every field Alex asked for", async () => {
    const payload = await board("human-employees");
    const roster = payload.tables.find((table) => table.id === "team-roster");
    expect(roster?.scope).toBe("member");
    expect(roster?.sourceIds).toEqual(["team_capital"]);
    expect(roster?.rows).toEqual([]);
    expect(roster?.columns.map((column) => column.key)).toEqual([
      "name",
      "role",
      "rateType",
      "rate",
      "hours",
      "duties",
      "judgedOn",
      "status",
    ]);
    expect(payload.sources).toHaveLength(1);
    expect(payload.sources[0]?.name).toBe("Team & capital API");
  });

  it("maps roster rows through the typed adapter, keyed by member id", async () => {
    const fakeRoster: TeamRosterAdapter = {
      sourceId: "team_capital",
      read: async () => ({
        observedAt: "2026-11-23T11:00:00.000Z",
        members: [
          {
            id: "member-1",
            name: "Kat",
            role: "Fulfillment lead",
            rateType: "monthly",
            rate: "RATE NOT SET",
            hours: 40,
            duties: "Fulfillment",
            judgedOn: "NOT SET",
            status: "active",
          },
        ],
      }),
    };

    const payload = await dashboardBoardService(pinnedNow, { teamRoster: fakeRoster })
      .board("human-employees", companyId);
    const roster = payload.tables.find((table) => table.id === "team-roster");
    expect(roster?.rows).toHaveLength(1);
    expect(roster?.rows[0]?.id).toBe("member-1");
    expect(roster?.rows[0]?.cells.judgedOn).toBe("NOT SET");
    // The adapter supplies the roster only; every aggregate tile still has no
    // source of its own and must not be derived from a partial read.
    expect(payload.tiles.every((tile) => tile.value.kind === "not_connected")).toBe(true);
  });

  it("returns fresh copies so one request cannot mutate another", async () => {
    const first = await board("sales");
    first.tiles[0]!.label = "tampered";
    first.tables[0]!.columns[0]!.label = "tampered";
    first.sources.push({
      ...first.sources[0]!,
      id: "ghl",
      name: "tampered",
    });
    const second = await board("sales");
    expect(second.tiles[0]?.label).not.toBe("tampered");
    expect(second.tables[0]?.columns[0]?.label).not.toBe("tampered");
    expect(second.sources.find((source) => source.id === "ghl")?.name).not.toBe("tampered");
  });

  it("keeps the payload company-scoped rather than merging companies", async () => {
    expect((await board("sales", otherCompanyId)).companyId).toBe(otherCompanyId);
  });

  it("computes human-employees seats-without-judged-on-number regex, one-number-per-seat, revenue-per-fte and meta", async () => {
    const prevKey = process.env.SALES_DASHBOARD_ADMIN_KEY;
    process.env.SALES_DASHBOARD_ADMIN_KEY = "test-key";
    try {
      const fakeRoster: TeamRosterAdapter = {
        sourceId: "team_capital",
        read: async () => ({
          observedAt: "2026-11-23T11:00:00.000Z",
          members: [
            {
              id: "m1",
              name: "Kat",
              role: "Fulfillment lead",
              rateType: "monthly",
              rate: "$4,000",
              hours: 160,
              duties: "Fulfillment",
              judgedOn: "NOT SET — needs KPI",
              status: "active",
            },
            {
              id: "m2",
              name: "Sam",
              role: "Setter",
              rateType: "monthly",
              rate: "$2,000",
              hours: 160,
              duties: "Outbound",
              judgedOn: "not set",
              status: "active",
            },
            {
              id: "m3",
              name: "Alex",
              role: "Media buyer",
              rateType: "monthly",
              rate: "$5,000",
              hours: 160,
              duties: "Meta Ads",
              judgedOn: "CAC < $400",
              status: "active",
            },
            {
              id: "m4",
              name: "Former",
              role: "Editor",
              rateType: "hourly",
              rate: "$30",
              hours: 20,
              duties: "Edits",
              judgedOn: "NOT SET",
              status: "inactive",
            },
          ],
        }),
      };

      const fetchImpl = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/api/pilot/admin/capital")) {
          return new Response(
            JSON.stringify({
              ok: true,
              generatedAt: "2026-11-23T11:30:00.000Z",
              view: "30d",
              operating: {
                monthlyLaborUsd: 11000,
                monthlyOverheadUsd: 2500,
                monthlyBurnUsd: 13500,
                runwayMonths: 6.4,
              },
              owner: {
                slug: "__owner__",
                displayName: "IR / HTL owner",
                syncedAt: "2026-11-23T11:30:00.000Z",
                syncStatus: "success",
                marketing: { salesUsd: 30000 },
                financialMonth: null,
              },
              clients: [],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", { status: 404 });
      }) as typeof fetch;

      const payload = await dashboardBoardService(pinnedNow, {
        teamRoster: fakeRoster,
        fetchImpl,
      }).board("human-employees", companyId, "30d");

      const byId = new Map(payload.tiles.map((t) => [t.id, t.value]));
      expect(byId.get("active-team-members")).toMatchObject({ kind: "live", value: 3, unit: "count" });
      expect(byId.get("seats-without-judged-on-number")).toMatchObject({
        kind: "live",
        value: 2,
        unit: "count",
      });
      expect(byId.get("one-number-per-seat")).toMatchObject({ kind: "live", value: 1, unit: "count" });
      expect(byId.get("revenue-per-fte")).toMatchObject({ kind: "live", value: 10000, unit: "usd" });
      expect(payload.meta).toEqual({
        monthlyLaborUsd: 11000,
        monthlyOverheadUsd: 2500,
        monthlyBurnUsd: 13500,
        runwayMonths: 6.4,
        activeHeadcount: 3,
        totalHeadcount: 4,
      });
    } finally {
      if (prevKey === undefined) delete process.env.SALES_DASHBOARD_ADMIN_KEY;
      else process.env.SALES_DASHBOARD_ADMIN_KEY = prevKey;
    }
  });

  it("aggregates multi-client sales and marketing live data and never renders Dials: 0 without WAVV", async () => {
    const prevKey = process.env.SALES_DASHBOARD_ADMIN_KEY;
    process.env.SALES_DASHBOARD_ADMIN_KEY = "test-key";
    try {
      const fetchImpl = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/api/pilot/admin/capital")) {
          return new Response(
            JSON.stringify({
              ok: true,
              generatedAt: "2026-11-23T11:45:00.000Z",
              view: "30d",
              owner: null,
              clients: [
                {
                  slug: "paradise-spas",
                  displayName: "Paradise Spas",
                  syncedAt: "2026-11-23T11:40:00.000Z",
                  syncStatus: "success",
                  marketing: { adSpendUsd: 6450, newLeads: 120, wonDeals: 6, pipelineRevenueUsd: 48000 },
                  financialMonth: null,
                },
                {
                  slug: "the-hot-tub-store",
                  displayName: "The Hot Tub Store",
                  syncedAt: "2026-11-23T11:40:00.000Z",
                  syncStatus: "success",
                  marketing: { adSpendUsd: 78, newLeads: 4, wonDeals: 0 },
                  financialMonth: null,
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("/api/pilot/admin/snapshots")) {
          return new Response(
            JSON.stringify({
              ok: true,
              generatedAt: "2026-11-23T11:45:00.000Z",
              clients: [
                {
                  slug: "paradise-spas",
                  displayName: "Paradise Spas",
                  syncedAt: "2026-11-23T11:45:00.000Z",
                  summary: {
                    ghl: {
                      status: "LIVE",
                      data: {
                        newLeads: 120,
                        appointmentsBooked: 40,
                        showedAppointments: 30,
                        pitchedOpportunities: 24,
                        wonDeals: 6,
                      },
                    },
                    meta: {
                      status: "LIVE",
                      data: { spend: 6450, impressions: 100000, clicks: 2500, zeroLeadDays: 0 },
                    },
                    calls: { status: "LIVE", data: { outboundCalls: 0 } },
                  },
                },
                {
                  slug: "sun-pool",
                  displayName: "Sun Pool",
                  syncedAt: "2026-11-23T11:45:00.000Z",
                  summary: {
                    ghl: {
                      status: "LIVE",
                      data: {
                        newLeads: 30,
                        appointmentsBooked: 10,
                        showedAppointments: 10,
                        pitchedOpportunities: 6,
                        wonDeals: 2,
                      },
                    },
                  },
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("/api/pilot/neon-ads?view=accounts")) {
          return new Response(
            JSON.stringify({
              ok: true,
              status: "LIVE",
              generatedAt: "2026-11-23T11:50:00.000Z",
              clients: [
                {
                  clientId: "paradise-spas",
                  displayName: "Paradise Spas",
                  sevenDay: { spend: 1500, leads: 30, cpl: 50 },
                  thirtyDay: { spend: 6450, leads: 120, cpl: 53.75 },
                  lastDataDay: "2026-11-22",
                  stale: false,
                },
                {
                  clientId: "the-hot-tub-store",
                  displayName: "The Hot Tub Store",
                  sevenDay: { spend: 78, leads: 4, cpl: 19.5 },
                  thirtyDay: { spend: 78, leads: 4, cpl: 19.5 },
                  lastDataDay: "2026-11-22",
                  stale: false,
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("/api/pilot/neon-ads?view=pipeline")) {
          return new Response(
            JSON.stringify({ ok: true, status: "LIVE", generatedAt: "2026-11-23T11:50:00.000Z", clients: [] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", { status: 404 });
      }) as typeof fetch;

      const svc = dashboardBoardService(pinnedNow, {
        fetchImpl,
        wavvReader: async () => null,
      });

      const sales = await svc.board("sales", companyId, "30d");
      const salesById = new Map(sales.tiles.map((t) => [t.id, t.value]));
      expect(salesById.get("show-rate")).toMatchObject({ kind: "live", value: 80, unit: "percent" });
      expect(salesById.get("offer-rate")).toMatchObject({ kind: "live", value: 75, unit: "percent" });
      expect(salesById.get("units-sold")).toMatchObject({ kind: "live", value: 8, unit: "count" });
      // Never render Dials: 0 when WAVV is not connected
      expect(salesById.get("dials")).toEqual({ kind: "not_connected" });
      expect(sales.sources.find((s) => s.id === "wavv")?.status).toBe("not_connected");

      const salesTable = sales.tables.find((t) => t.id === "sales-by-business");
      expect(salesTable?.rows.map((r) => r.id)).toEqual(
        expect.arrayContaining(["paradise-spas", "sun-pool", "the-hot-tub-store"]),
      );

      const marketing = await svc.board("marketing", companyId, "30d");
      const mktById = new Map(marketing.tiles.map((t) => [t.id, t.value]));
      expect(mktById.get("ad-spend")).toMatchObject({ kind: "live", value: 6528, unit: "usd" });
      expect(mktById.get("new-leads")).toMatchObject({ kind: "live", value: 154, unit: "count" });
      expect(mktById.get("cac-per-client")).toMatchObject({ kind: "live", value: 816, unit: "usd" });
      expect(mktById.get("ctr")).toMatchObject({ kind: "live", value: 2.5, unit: "percent" });
      const mktTable = marketing.tables.find((t) => t.id === "marketing-by-client");
      expect(mktTable?.rows.find((r) => r.id === "paradise-spas")?.cells.spend).toBe(6450);
      expect(mktTable?.rows.find((r) => r.id === "the-hot-tub-store")?.cells.spend).toBe(78);
    } finally {
      if (prevKey === undefined) delete process.env.SALES_DASHBOARD_ADMIN_KEY;
      else process.env.SALES_DASHBOARD_ADMIN_KEY = prevKey;
    }
  });

  it("parses flat live /api/pilot/admin/snapshots sections and never mixes client sales into agency revenue-per-fte", async () => {
    const prevKey = process.env.SALES_DASHBOARD_ADMIN_KEY;
    process.env.SALES_DASHBOARD_ADMIN_KEY = "test-key";
    try {
      const fakeRoster: TeamRosterAdapter = {
        sourceId: "team_capital",
        read: async () => ({
          observedAt: "2026-11-23T11:00:00.000Z",
          members: [
            {
              id: "m1",
              name: "Kat",
              role: "Fulfillment lead",
              rateType: "monthly",
              rate: "$4,000",
              hours: 160,
              duties: "Fulfillment",
              judgedOn: "On-time launches",
              status: "active",
            },
          ],
        }),
      };

      const fetchImpl = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/api/pilot/admin/capital")) {
          return new Response(
            JSON.stringify({
              ok: true,
              generatedAt: "2026-11-23T11:45:00.000Z",
              view: "30d",
              operating: {
                monthlyLaborUsd: 4000,
                monthlyOverheadUsd: 1000,
                monthlyBurnUsd: 5000,
                runwayMonths: 10,
              },
              settings: { cashOnHandUsd: 50000, fixedMonthlyCostUsd: 1000 },
              owner: null,
              clients: [
                {
                  slug: "paradise-spas",
                  displayName: "Paradise Spas",
                  syncedAt: "2026-11-23T11:40:00.000Z",
                  syncStatus: "success",
                  marketing: { salesUsd: 250000, adSpendUsd: 6473.6 },
                  financialMonth: null,
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("/api/pilot/admin/snapshots")) {
          // Exact flat JSON shape returned live by dashboard.increaseai.tech/api/pilot/admin/snapshots
          return new Response(
            JSON.stringify({
              ok: true,
              view: "30d",
              generatedAt: "2026-11-23T11:55:00.000Z",
              clients: [
                {
                  slug: "paradise-spas",
                  displayName: "Paradise Spas",
                  lastSuccessfulSyncAt: "2026-11-23T11:50:00.000Z",
                  zeroLeadDays7d: 0,
                  ghl: {
                    status: "LIVE",
                    newLeads: 20,
                    appointmentsBooked: 10,
                    showedAppointments: 7,
                    wonDeals: 3,
                  },
                  meta: {
                    status: "LIVE",
                    spend: 6473.6,
                    impressions: 225000,
                    clicks: 3330,
                  },
                },
                {
                  slug: "the-hot-tub-store",
                  displayName: "The Hot Tub Store",
                  lastSuccessfulSyncAt: "2026-11-23T11:50:00.000Z",
                  zeroLeadDays7d: 1,
                  ghl: {
                    status: "LIVE",
                    newLeads: 3,
                    appointmentsBooked: 2,
                    showedAppointments: 1,
                    wonDeals: 0,
                  },
                  meta: {
                    status: "LIVE",
                    spend: 78,
                    impressions: 3649,
                    clicks: 57,
                  },
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ ok: true, status: "NOT_CONFIGURED" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;

      const svc = dashboardBoardService(pinnedNow, {
        teamRoster: fakeRoster,
        fetchImpl,
        wavvReader: async () => null,
      });

      const marketing = await svc.board("marketing", companyId, "30d");
      const mktById = new Map(marketing.tiles.map((t) => [t.id, t.value]));
      expect(mktById.get("ad-spend")).toMatchObject({ kind: "live", value: 6551.6, unit: "usd" });
      expect(mktById.get("new-leads")).toMatchObject({ kind: "live", value: 23, unit: "count" });
      expect(mktById.get("ctr")).toMatchObject({ kind: "live", value: 1.48, unit: "percent" });
      expect(mktById.get("spend-with-zero-leads")).toMatchObject({ kind: "live", value: 1, unit: "count" });

      // Human employees must NOT use Paradise Spas' $250,000 client sales for agency Revenue per FTE
      const humans = await svc.board("human-employees", companyId, "30d");
      const humanById = new Map(humans.tiles.map((t) => [t.id, t.value]));
      expect(humanById.get("revenue-per-fte")).toEqual({ kind: "not_connected" });
      expect(humans.meta?.cashOnHandUsd).toBe(50000);
    } finally {
      if (prevKey === undefined) delete process.env.SALES_DASHBOARD_ADMIN_KEY;
      else process.env.SALES_DASHBOARD_ADMIN_KEY = prevKey;
    }
  });

  it("shows not_connected on month-to-date sales and marketing boards when only 30d Neon accounts or unscoped pipeline exist", async () => {
    const prevKey = process.env.SALES_DASHBOARD_ADMIN_KEY;
    process.env.SALES_DASHBOARD_ADMIN_KEY = "test-key";
    try {
      const fetchImpl = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/api/pilot/admin/capital?view=month")) {
          return new Response(
            JSON.stringify({ ok: true, generatedAt: "2026-11-23T11:45:00.000Z", view: "month", owner: null, clients: [] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("/api/pilot/admin/snapshots?view=month")) {
          return new Response(
            JSON.stringify({ ok: true, view: "month", generatedAt: "2026-11-23T11:45:00.000Z", clients: [] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("/api/pilot/neon-ads?view=accounts")) {
          return new Response(
            JSON.stringify({
              ok: true,
              status: "LIVE",
              generatedAt: "2026-11-23T11:50:00.000Z",
              clients: [
                {
                  clientId: "paradise-spas",
                  displayName: "Paradise Spas",
                  sevenDay: { spend: 1500, leads: 30, cpl: 50 },
                  thirtyDay: { spend: 6450, leads: 120, cpl: 53.75 },
                  lastDataDay: "2026-11-22",
                  stale: false,
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("/api/pilot/neon-ads?view=pipeline")) {
          return new Response(
            JSON.stringify({
              ok: true,
              status: "LIVE",
              generatedAt: "2026-11-23T11:50:00.000Z",
              clients: [
                {
                  clientId: "paradise-spas",
                  displayName: "Paradise Spas",
                  spend: 6450,
                  crmLeads: 120,
                  qualified: 50,
                  booked: 40,
                  showed: 30,
                  sold: 6,
                  revenue: 48000,
                  costPerCrmLead: 53.75,
                  costPerBooked: 161.25,
                  costPerSold: 1075,
                  roas: 7.44,
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", { status: 404 });
      }) as typeof fetch;

      const svc = dashboardBoardService(pinnedNow, {
        fetchImpl,
        wavvReader: async () => null,
      });

      const marketing = await svc.board("marketing", companyId, "month");
      expect(marketing.tiles.every((t) => t.value.kind === "not_connected")).toBe(true);
      expect(marketing.tables.find((t) => t.id === "marketing-by-client")?.rows).toEqual([]);

      const sales = await svc.board("sales", companyId, "month");
      expect(sales.tiles.every((t) => t.value.kind === "not_connected")).toBe(true);
      expect(sales.tables.find((t) => t.id === "sales-by-business")?.rows).toEqual([]);
    } finally {
      if (prevKey === undefined) delete process.env.SALES_DASHBOARD_ADMIN_KEY;
      else process.env.SALES_DASHBOARD_ADMIN_KEY = prevKey;
    }
  });
});
