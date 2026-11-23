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

  it("covers the sales numbers the spec names", async () => {
    const payload = await board("sales");
    const ids = payload.tiles.map((tile) => tile.id);
    expect(ids).toEqual(expect.arrayContaining([
      "speed-to-lead",
      "set-rate",
      "show-rate",
      "close-rate",
      "dials",
      "talk-time",
      "appointments-per-setter-day",
    ]));
    const tables = payload.tables.map((table) => table.id);
    expect(tables).toEqual(expect.arrayContaining(["sales-by-business", "setter-scoreboard"]));
    expect(payload.tables.find((table) => table.id === "sales-by-business")?.scope).toBe("client");
  });

  it("covers marketing spend, leads, cost per lead, cost per held appointment and the zero-lead alarm", async () => {
    const payload = await board("marketing");
    const ids = payload.tiles.map((tile) => tile.id);
    expect(ids).toEqual(expect.arrayContaining([
      "ad-spend",
      "new-leads",
      "cost-per-lead",
      "cost-per-held-appointment",
      "spend-with-zero-leads",
    ]));
    expect(payload.tables[0]?.scope).toBe("client");
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
