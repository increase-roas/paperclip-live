import { describe, expect, it } from "vitest";
import { DASHBOARD_BOARD_IDS } from "@paperclipai/shared";
import {
  DASHBOARD_BOARD_ORDER,
  DEFAULT_DASHBOARD_BOARD_ID,
  dashboardBoardMeta,
  dashboards,
  registeredDashboard,
  unregisteredBoardIds,
} from "./registry";

describe("dashboard registry", () => {
  it("keeps the eight boards in the mission's order", () => {
    expect(DASHBOARD_BOARD_ORDER.map((board) => board.id)).toEqual([
      "ceo",
      "sales",
      "marketing",
      "fulfillment",
      "ai-cost",
      "automation-health",
      "tools-connectors",
      "human-employees",
    ]);
    expect(DASHBOARD_BOARD_ORDER.map((board) => board.title)).toEqual([
      "CEO",
      "Sales",
      "Marketing",
      "Fulfillment",
      "AI cost",
      "Automation health",
      "Tools/connectors",
      "Human employees",
    ]);
  });

  it("uses unique ids and defaults to the CEO board", () => {
    const ids = DASHBOARD_BOARD_ORDER.map((board) => board.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(DEFAULT_DASHBOARD_BOARD_ID).toBe("ceo");
    expect(dashboardBoardMeta(DEFAULT_DASHBOARD_BOARD_ID)?.title).toBe("CEO");
  });

  it("registers the CEO and lane 2 boards and leaves lane 3 to its lane", () => {
    expect(registeredDashboard("ceo")).toBeDefined();
    for (const id of DASHBOARD_BOARD_IDS) {
      expect(registeredDashboard(id)).toBeDefined();
    }
    expect(registeredDashboard("fulfillment")).toBeUndefined();
    expect(registeredDashboard("nope")).toBeUndefined();
    expect(unregisteredBoardIds()).toEqual([
      "fulfillment",
      "ai-cost",
      "automation-health",
      "tools-connectors",
    ]);
  });

  it("only registers boards that exist in the tab order", () => {
    for (const board of dashboards) {
      expect(dashboardBoardMeta(board.id)).not.toBeNull();
      expect(board.title).toBe(dashboardBoardMeta(board.id)?.title);
      expect(board.component).toBeTypeOf("function");
    }
  });

  it("returns null meta for an unknown url segment", () => {
    expect(dashboardBoardMeta("not-a-board")).toBeNull();
  });
});
