import { describe, expect, it } from "vitest";
import { DASHBOARD_BOARD_IDS, type DashboardBoardId } from "@paperclipai/shared";
import { dashboardBoardService } from "./dashboard-boards.js";
import type { TeamRosterAdapter } from "./dashboard-team-roster.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";
const pinnedNow = () => new Date("2026-11-23T12:00:00.000Z");

function board(id: DashboardBoardId, forCompany = companyId) {
  return dashboardBoardService(pinnedNow).board(id, forCompany);
}

describe("dashboardBoardService", () => {
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
});
