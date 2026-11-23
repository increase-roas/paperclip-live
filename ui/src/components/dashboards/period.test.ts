import { describe, expect, it } from "vitest";
import {
  DASHBOARD_PERIODS,
  DEFAULT_DASHBOARD_PERIOD,
  dashboardPeriodLabel,
  dashboardPeriodRange,
  isDashboardPeriod,
  parseDashboardPeriod,
} from "./period";

describe("dashboard periods", () => {
  it("offers exactly the three views the sales dashboard already supports", () => {
    expect(DASHBOARD_PERIODS.map((period) => period.id)).toEqual(["7d", "30d", "month"]);
  });

  it("falls back to 30 days for an absent or unknown value", () => {
    expect(DEFAULT_DASHBOARD_PERIOD).toBe("30d");
    expect(parseDashboardPeriod(null)).toBe("30d");
    expect(parseDashboardPeriod(undefined)).toBe("30d");
    expect(parseDashboardPeriod("")).toBe("30d");
    expect(parseDashboardPeriod("90d")).toBe("30d");
    expect(parseDashboardPeriod("7d")).toBe("7d");
    expect(isDashboardPeriod("month")).toBe(true);
    expect(isDashboardPeriod("month ")).toBe(false);
  });

  it("covers exactly seven days for 7d", () => {
    const now = new Date("2026-11-23T12:00:00.000Z");
    const range = dashboardPeriodRange("7d", now);
    expect(range.to.getTime() - range.from.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
    expect(range.fromIso).toBe("2026-11-16T12:00:00.000Z");
    expect(range.toIso).toBe("2026-11-23T12:00:00.000Z");
    expect(range.label).toBe("Last 7 days");
  });

  it("covers exactly thirty days for 30d", () => {
    const now = new Date("2026-11-23T12:00:00.000Z");
    const range = dashboardPeriodRange("30d", now);
    expect(range.to.getTime() - range.from.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
    expect(range.label).toBe("Last 30 days");
  });

  it("starts the month view at local midnight on the first of the month", () => {
    const now = new Date(2026, 10, 23, 15, 30, 0);
    const range = dashboardPeriodRange("month", now);
    expect(range.from.getFullYear()).toBe(2026);
    expect(range.from.getMonth()).toBe(10);
    expect(range.from.getDate()).toBe(1);
    expect(range.from.getHours()).toBe(0);
    expect(range.from.getMinutes()).toBe(0);
    expect(range.to.getTime()).toBe(now.getTime());
    expect(range.label).toBe("Month to date");
  });

  it("labels every period for a tile footer", () => {
    expect(dashboardPeriodLabel("7d")).toBe("Last 7 days");
    expect(dashboardPeriodLabel("30d")).toBe("Last 30 days");
    expect(dashboardPeriodLabel("month")).toBe("Month to date");
  });
});
