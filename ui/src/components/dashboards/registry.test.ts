// @vitest-environment node

import { describe, expect, it } from "vitest";
import { DASHBOARD_BOARD_IDS } from "@paperclipai/shared";
import { dashboards } from "./registry";

describe("dashboardBoards registry", () => {
  it("registers exactly the three lane 2 boards", () => {
    expect(dashboards.map((entry) => entry.id)).toEqual([
      "sales",
      "marketing",
      "human-employees",
    ]);
    expect(new Set(dashboards.map((entry) => entry.id))).toEqual(
      new Set(DASHBOARD_BOARD_IDS),
    );
  });

  it("gives every board a title and a renderable component", () => {
    for (const entry of dashboards) {
      expect(entry.title.length).toBeGreaterThan(0);
      expect(typeof entry.component).toBe("function");
    }
  });
});
