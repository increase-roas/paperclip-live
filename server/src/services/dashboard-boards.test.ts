import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DASHBOARD_BOARD_IDS, type DashboardBoardId } from "@paperclipai/shared";
import { dashboardBoardService } from "./dashboard-boards.js";
import type { TeamRosterAdapter } from "./dashboard-team-roster.js";
import type { AgencyMarketingSummary } from "../ir/agency-marketing-client.js";
import type { AgencySalesSummary } from "../ir/agency-sales-client.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";
const pinnedNow = () => new Date("2026-11-23T12:00:00.000Z");

const ENV_KEYS = [
  "SALES_DASHBOARD_ADMIN_KEY",
  "GATEWAY_PAPERCLIP_KEY",
  "GATEWAY_WAVV_KEY",
  "GATEWAY_META_KEY",
  "GATEWAY_GHL_KEY",
  "GHL_ALEX_BLOOMFIELD_PIT_KEY",
  "GHL_ALEX_BLOOMFIELD_LOCATION_ID",
] as const;

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
    expect(tables).toEqual(["sales-by-business"]);
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

  it("keeps every agency v1 sales tile (client WAVV moved to Fulfillment) and labels it as v1", async () => {
    const payload = await board("sales");
    const byId = new Map(payload.tiles.map((tile) => [tile.id, tile]));
    for (const id of ["new-leads", "active-opportunities", "set-rate", "lead-to-customer"]) {
      expect(byId.get(id)?.target).toContain("v1 source");
    }
    expect(byId.has("dials")).toBe(false);
    expect(byId.has("conversations-over-60s")).toBe(false);
    expect(byId.has("talk-time")).toBe(false);
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
    // The adapter supplies the roster only: no aggregate tile is derived from
    // it, and because the roster source is connected none claims otherwise.
    expect(payload.sources.find((source) => source.id === "team_capital")?.status).toBe("connected");
    expect(payload.tiles.some((tile) => tile.value.kind === "live")).toBe(false);
    expect(payload.tiles.some((tile) => tile.value.kind === "not_connected")).toBe(false);
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

  it("keeps Marketing and Sales strictly scoped to Increase ROAS agency accounts and never mixes client portfolio metrics", async () => {
    const svc = dashboardBoardService(pinnedNow, {
      agencyMarketingReader: async () => ({
        period: "30d",
        since: "2026-10-24",
        until: "2026-11-23",
        observedAt: "2026-11-23T11:45:00.000Z",
        liveAccountCount: 2,
        totalAccountCount: 3,
        hasMeta: true,
        spend: 1200,
        impressions: 24000,
        clicks: 900,
        linkClicks: 600,
        leads: 24,
        ctr: 2.5,
        cpl: 50,
        zeroLeadDays: 0,
        accounts: [
          {
            id: "increase-roas-b2b",
            displayName: "Increase ROAS B2B",
            adAccountId: "act_1000000000000011",
            status: "needs_config",
            statusLabel: "Needs account ID / key",
            observedAt: null,
            spend: null,
            impressions: null,
            clicks: null,
            linkClicks: null,
            leads: null,
            ctr: null,
            cpl: null,
            zeroLeadDays: null,
          },
          {
            id: "alex-bloomfield-ssa",
            displayName: "Alex Bloomfield (Start Scale Automate)",
            adAccountId: "act_1000000000000012",
            status: "live",
            statusLabel: "Live",
            observedAt: "2026-11-23T11:45:00.000Z",
            spend: 1200,
            impressions: 24000,
            clicks: 900,
            linkClicks: 600,
            leads: 24,
            ctr: 2.5,
            cpl: 50,
            zeroLeadDays: 0,
          },
          {
            id: "hot-tub-launch",
            displayName: "Hot Tub Launch",
            adAccountId: "act_1000000000000013",
            status: "live",
            statusLabel: "Live · $0 spend",
            observedAt: "2026-11-23T11:45:00.000Z",
            spend: 0,
            impressions: 0,
            clicks: 0,
            linkClicks: 0,
            leads: 0,
            ctr: null,
            cpl: null,
            zeroLeadDays: 0,
          },
        ],
      }),
      agencySalesReader: async () => ({
        period: "30d",
        observedAt: "2026-11-23T11:45:00.000Z",
        liveAccountCount: 2,
        totalAccountCount: 3,
        hasGhl: true,
        newLeads: 33,
        activeOpportunities: 16,
        booked: 10,
        showed: 8,
        noShows: 2,
        pitched: 6,
        wonDeals: 2,
        lostDeals: 3,
        pipelineWonUsd: 12000,
        cashCollectedUsd: 6000,
        showRate: 80,
        offerRate: 75,
        closeRate: 40,
        setRate: 30.3,
        leadToCustomerRate: 6.1,
        accounts: [
          {
            id: "increase-roas-main",
            displayName: "Increase ROAS Main",
            locationId: "LocFakeClientA000001",
            authMode: "gateway",
            status: "live",
            statusLabel: "Live",
            observedAt: "2026-11-23T11:45:00.000Z",
            newLeads: 15,
            activeOpportunities: 4,
            booked: 6,
            showed: 5,
            noShows: 1,
            pitched: 4,
            wonDeals: 2,
            lostDeals: 2,
            pipelineWonUsd: 12000,
            cashCollectedUsd: 6000,
            showRate: 83.3,
            offerRate: 80,
            closeRate: 50,
          },
          {
            id: "hot-tub-launch-b2b",
            displayName: "Hot Tub Launch B2B",
            locationId: "LocFakeClientB000002",
            authMode: "gateway",
            status: "live",
            statusLabel: "Live",
            observedAt: "2026-11-23T11:45:00.000Z",
            newLeads: 18,
            activeOpportunities: 12,
            booked: 4,
            showed: 3,
            noShows: 1,
            pitched: 2,
            wonDeals: 0,
            lostDeals: 1,
            pipelineWonUsd: 0,
            cashCollectedUsd: 0,
            showRate: 75,
            offerRate: 66.7,
            closeRate: 0,
          },
          {
            id: "alex-bloomfield-ssa",
            displayName: "Alex Bloomfield (Start Scale Automate)",
            locationId: null,
            authMode: "pit",
            status: "needs_config",
            statusLabel: "Needs PIT key / location ID",
            observedAt: null,
            newLeads: null,
            activeOpportunities: null,
            booked: null,
            showed: null,
            noShows: null,
            pitched: null,
            wonDeals: null,
            lostDeals: null,
            pipelineWonUsd: null,
            cashCollectedUsd: null,
            showRate: null,
            offerRate: null,
            closeRate: null,
          },
        ],
      }),
    });

    const sales = await svc.board("sales", companyId, "30d");
    const salesById = new Map(sales.tiles.map((t) => [t.id, t.value]));
    expect(salesById.get("show-rate")).toMatchObject({ kind: "live", value: 80, unit: "percent" });
    expect(salesById.get("offer-rate")).toMatchObject({ kind: "live", value: 75, unit: "percent" });
    expect(salesById.get("close-rate")).toMatchObject({ kind: "live", value: 40, unit: "percent" });
    expect(salesById.get("cash-collected-up-front")).toMatchObject({ kind: "live", value: 50, unit: "percent" });
    expect(salesById.get("units-sold")).toMatchObject({ kind: "live", value: 2, unit: "count" });
    expect(salesById.get("new-leads")).toMatchObject({ kind: "live", value: 33, unit: "count" });
    expect(salesById.get("active-opportunities")).toMatchObject({ kind: "live", value: 16, unit: "count" });

    const salesTable = sales.tables.find((t) => t.id === "sales-by-business");
    expect(salesTable?.rows.map((r) => r.id)).toEqual([
      "increase-roas-main",
      "hot-tub-launch-b2b",
      "alex-bloomfield-ssa",
    ]);
    expect(salesTable?.rows.find((r) => r.id === "alex-bloomfield-ssa")?.cells.status).toBe(
      "Needs PIT key / location ID",
    );
    expect(JSON.stringify(sales)).not.toContain("Client A");

    const marketing = await svc.board("marketing", companyId, "30d");
    const mktById = new Map(marketing.tiles.map((t) => [t.id, t.value]));
    expect(mktById.get("ad-spend")).toMatchObject({ kind: "live", value: 1200, unit: "usd" });
    expect(mktById.get("new-leads")).toMatchObject({ kind: "live", value: 24, unit: "count" });
    expect(mktById.get("cost-per-lead")).toMatchObject({ kind: "live", value: 50, unit: "usd" });
    expect(mktById.get("ctr")).toMatchObject({ kind: "live", value: 2.5, unit: "percent" });
    expect(mktById.get("cac-per-client")).toMatchObject({ kind: "live", value: 600, unit: "usd" });
    expect(mktById.get("cost-per-held-appointment")).toMatchObject({ kind: "live", value: 150, unit: "usd" });

    const mktTable = marketing.tables.find((t) => t.id === "marketing-by-client");
    expect(mktTable?.rows.map((r) => r.id)).toEqual([
      "increase-roas-b2b",
      "alex-bloomfield-ssa",
      "hot-tub-launch",
    ]);
    expect(mktTable?.rows.find((r) => r.id === "increase-roas-b2b")?.cells.status).toBe(
      "Needs account ID / key",
    );
    expect(mktTable?.rows.find((r) => r.id === "alex-bloomfield-ssa")?.cells.spend).toBe("$1,200.00");
    expect(JSON.stringify(marketing)).not.toContain("Client A");
  });

  it("never mixes client sales into agency Marketing, Sales, or Human employees Revenue per FTE when only SALES_DASHBOARD_ADMIN_KEY is set", async () => {
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
                  slug: "client-a",
                  displayName: "Client A",
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
        return new Response(JSON.stringify({ ok: true, status: "NOT_CONFIGURED" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;

      const svc = dashboardBoardService(pinnedNow, {
        teamRoster: fakeRoster,
        fetchImpl,
      });

      // Marketing & Sales must NEVER pull client portfolio data from SALES_DASHBOARD_ADMIN_KEY
      const marketing = await svc.board("marketing", companyId, "30d");
      expect(marketing.tiles.every((t) => t.value.kind === "not_connected")).toBe(true);
      expect(marketing.tables.find((t) => t.id === "marketing-by-client")?.rows).toEqual([]);

      const sales = await svc.board("sales", companyId, "30d");
      expect(sales.tiles.every((t) => t.value.kind === "not_connected")).toBe(true);
      expect(sales.tables.find((t) => t.id === "sales-by-business")?.rows).toEqual([]);

      // Human employees must NOT use Client A's $250,000 client sales for agency Revenue per FTE
      const humans = await svc.board("human-employees", companyId, "30d");
      const humanById = new Map(humans.tiles.map((t) => [t.id, t.value]));
      expect(humanById.get("revenue-per-fte")).toMatchObject({ kind: "not_mapped" });
      expect(JSON.stringify(humans.tiles)).not.toContain("250000");
      expect(humans.meta?.cashOnHandUsd).toBe(50000);
    } finally {
      if (prevKey === undefined) delete process.env.SALES_DASHBOARD_ADMIN_KEY;
      else process.env.SALES_DASHBOARD_ADMIN_KEY = prevKey;
    }
  });

  it.each([
    { revenue: 75000, perFte: 25000 },
    { revenue: 0, perFte: 0 },
    { revenue: -300, perFte: -100 },
  ])("uses QuickBooks revenue $revenue for Revenue per FTE over legacy revenue", async ({ revenue, perFte }) => {
    process.env.SALES_DASHBOARD_ADMIN_KEY = "test-key";
    const fakeRoster = {
      sourceId: "team_capital" as const,
      read: async () => ({
        observedAt: "2026-11-25T18:00:00.000Z",
        members: [
          { id: "m1", name: "Alex", role: "CEO", status: "active", judgedOn: "Cash", rateType: "salary", rate: "$0", hours: 40, duties: "Strategy" },
          { id: "m2", name: "Maya", role: "CSM", status: "active", judgedOn: "Churn", rateType: "salary", rate: "$0", hours: 40, duties: "Retention" },
          { id: "m3", name: "Sam", role: "Setter", status: "active", judgedOn: "Show rate", rateType: "hourly", rate: "$25", hours: 40, duties: "Outbound" },
        ],
      }),
    };
    const svc = dashboardBoardService(pinnedNow, {
      teamRoster: fakeRoster,
      fetchImpl: async () => new Response(JSON.stringify({
        ok: true,
        view: "30d",
        generatedAt: "2026-11-23T11:00:00.000Z",
        owner: { marketing: { salesUsd: 90000 } },
      }), { status: 200 }),
      quickbooksReader: async () => ({
        period: "30d",
        startDate: "2026-10-26",
        endDate: "2026-11-25",
        observedAt: "2026-11-25T18:00:00.000Z",
        source: "quickbooks_gateway",
        cashCollectedUsd: 60000,
        accrualRevenueUsd: revenue,
        cogsUsd: 15000,
        grossProfitUsd: 60000,
        grossMarginPercent: 80,
        operatingExpensesUsd: 10000,
        totalExpensesUsd: 25000,
        netProfitUsd: 50000,
        advertisingSpendUsd: 5000,
        activeCustomerCount: 5,
      }),
    });
    const humans = await svc.board("human-employees", companyId, "30d");
    const byId = new Map(humans.tiles.map((t) => [t.id, t.value]));
    expect(byId.get("revenue-per-fte")).toEqual({
      kind: "live",
      value: perFte,
      unit: "usd",
      observedAt: "2026-11-25T18:00:00.000Z",
    });
  });

  it("returns not_connected on month-to-date agency sales and marketing boards when agency sources return null", async () => {
    const svc = dashboardBoardService(pinnedNow, {
      agencyMarketingReader: async () => null,
      agencySalesReader: async () => null,
    });

    const marketing = await svc.board("marketing", companyId, "month");
    expect(marketing.tiles.every((t) => t.value.kind === "not_connected")).toBe(true);
    expect(marketing.tables.find((t) => t.id === "marketing-by-client")?.rows).toEqual([]);

    const sales = await svc.board("sales", companyId, "month");
    expect(sales.tiles.every((t) => t.value.kind === "not_connected")).toBe(true);
    expect(sales.tables.find((t) => t.id === "sales-by-business")?.rows).toEqual([]);
  });

  it("renders cash-collected-up-front as no data (never 0%, never not connected) when agency transactions failed (cashCollectedUsd: null)", async () => {
    const svc = dashboardBoardService(pinnedNow, {
      agencySalesReader: async () => ({
        period: "30d",
        observedAt: "2026-11-26T05:00:00.000Z",
        liveAccountCount: 1,
        totalAccountCount: 3,
        hasGhl: true,
        newLeads: 15,
        activeOpportunities: 5,
        booked: 4,
        showed: 3,
        noShows: 1,
        pitched: 2,
        wonDeals: 1,
        lostDeals: 1,
        pipelineWonUsd: 10000,
        cashCollectedUsd: null,
        showRate: 75,
        offerRate: 66.7,
        closeRate: 50,
        setRate: 26.7,
        leadToCustomerRate: 6.7,
        accounts: [],
      }),
    });

    const sales = await svc.board("sales", companyId, "30d");
    const byId = new Map(sales.tiles.map((t) => [t.id, t.value]));
    expect(byId.get("cash-collected-up-front")).toEqual({
      kind: "no_data",
      reason: "At least one connected GHL sub-account returned a partial read, so the agency total is withheld.",
    });
    expect(byId.get("units-sold")).toMatchObject({ kind: "live", value: 1, unit: "count" });
  });

  describe("connected source with an empty series", () => {
    const emptySales = (): AgencySalesSummary => ({
      period: "30d",
      observedAt: "2026-11-26T05:00:00.000Z",
      liveAccountCount: 3,
      totalAccountCount: 3,
      hasGhl: true,
      newLeads: 0,
      activeOpportunities: 0,
      booked: 0,
      showed: 0,
      noShows: 0,
      pitched: 0,
      wonDeals: 0,
      lostDeals: 0,
      pipelineWonUsd: 0,
      cashCollectedUsd: 0,
      showRate: null,
      offerRate: null,
      closeRate: null,
      setRate: null,
      leadToCustomerRate: null,
      accounts: [],
    });
    const liveMarketing = (): AgencyMarketingSummary => ({
      period: "30d",
      since: "2026-10-27",
      until: "2026-11-26",
      observedAt: "2026-11-26T05:00:00.000Z",
      liveAccountCount: 3,
      totalAccountCount: 3,
      hasMeta: true,
      spend: 128.03,
      impressions: 0,
      clicks: 0,
      linkClicks: 0,
      leads: 7,
      ctr: null,
      cpl: 18.29,
      zeroLeadDays: 0,
      accounts: [],
    });

    it("never yields not_connected on Sales while GHL is connected", async () => {
      const sales = await dashboardBoardService(pinnedNow, { agencySalesReader: async () => emptySales() }).board(
        "sales",
        companyId,
      );
      expect(sales.sources.find((source) => source.id === "ghl")?.status).toBe("connected");
      const byId = new Map(sales.tiles.map((tile) => [tile.id, tile.value]));
      for (const tile of sales.tiles) expect(tile.value.kind, tile.id).not.toBe("not_connected");
      expect(byId.get("show-rate")).toEqual({
        kind: "no_data",
        reason: "Booked 0 · Showed 0 — no past-dated booked appointments in this period yet.",
      });
      expect(byId.get("close-rate")).toMatchObject({ kind: "no_data" });
      expect(byId.get("offer-rate")).toMatchObject({ kind: "no_data" });
      expect(byId.get("speed-to-lead")).toMatchObject({ kind: "not_mapped" });
      // A real zero count stays a live zero.
      expect(byId.get("new-leads")).toMatchObject({ kind: "live", value: 0 });
    });

    it("never yields not_connected on Marketing while Meta and GHL are connected", async () => {
      const marketing = await dashboardBoardService(pinnedNow, {
        agencyMarketingReader: async () => liveMarketing(),
        agencySalesReader: async () => emptySales(),
      }).board("marketing", companyId);
      const byId = new Map(marketing.tiles.map((tile) => [tile.id, tile.value]));
      for (const tile of marketing.tiles) expect(tile.value.kind, tile.id).not.toBe("not_connected");
      expect(byId.get("ad-spend")).toMatchObject({ kind: "live", value: 128.03, unit: "usd" });
      expect(byId.get("new-leads")).toMatchObject({ kind: "live", value: 7 });
      expect(byId.get("cac-per-client")).toEqual({
        kind: "no_data",
        reason: "Spend $128.03 · Clients won 0 — no new agency clients won in this period yet.",
      });
      expect(byId.get("cost-per-held-appointment")).toMatchObject({ kind: "no_data" });
      expect(byId.get("creative-budget-split")).toMatchObject({ kind: "not_mapped" });
      expect(byId.get("spend-pacing")).toMatchObject({ kind: "not_mapped" });
    });

    it("wires live rates once the connected series has data", async () => {
      const sales = await dashboardBoardService(pinnedNow, {
        agencySalesReader: async () => ({ ...emptySales(), booked: 20, showed: 6, wonDeals: 2, pitched: 4, showRate: 30, closeRate: 33.3, offerRate: 66.7 }),
        agencyMarketingReader: async () => liveMarketing(),
      }).board("marketing", companyId);
      const byId = new Map(sales.tiles.map((tile) => [tile.id, tile.value]));
      expect(byId.get("cac-per-client")).toMatchObject({ kind: "live", value: 64.02, unit: "usd" });
      expect(byId.get("cost-per-held-appointment")).toMatchObject({ kind: "live", value: 21.34, unit: "usd" });
    });

    it("still yields not_connected, with the needed key, when the source is disconnected", async () => {
      const marketing = await dashboardBoardService(pinnedNow, {
        agencyMarketingReader: async () => liveMarketing(),
        agencySalesReader: async () => null,
      }).board("marketing", companyId);
      const ghl = marketing.sources.find((source) => source.id === "ghl");
      expect(ghl?.status).toBe("not_connected");
      expect(ghl?.needed).toContain("GATEWAY_PAPERCLIP_KEY");
      const byId = new Map(marketing.tiles.map((tile) => [tile.id, tile.value]));
      expect(byId.get("cac-per-client")).toEqual({ kind: "not_connected" });
      expect(byId.get("cost-per-held-appointment")).toEqual({ kind: "not_connected" });
      expect(byId.get("ad-spend")).toMatchObject({ kind: "live" });

      const sales = await dashboardBoardService(pinnedNow, { agencySalesReader: async () => null }).board("sales", companyId);
      for (const tile of sales.tiles) expect(tile.value).toEqual({ kind: "not_connected" });
    });
  });
});
