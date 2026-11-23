// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DashboardTileValue } from "@paperclipai/shared";
import { formatTileValue } from "./formatTileValue";

type LiveReading = Extract<DashboardTileValue, { kind: "live" }>;

function reading(value: number, unit: LiveReading["unit"]): LiveReading {
  return { kind: "live", value, unit, observedAt: "2026-11-23T12:00:00.000Z" };
}

describe("formatTileValue", () => {
  it.each([
    [1250, "usd", "$1,250"],
    [72.5, "percent", "72.5%"],
    [1.02, "ratio", "1.02×"],
    [42, "seconds", "42 s"],
    [35, "minutes", "35 min"],
    [6.5, "hours", "6.5 h"],
    [3, "days", "3 days"],
    [12, "count", "12"],
  ] as const)("formats %s as %s", (value, unit, expected) => {
    expect(formatTileValue(reading(value, unit))).toBe(expected);
  });

  it("renders as text, never as a blank tile", () => {
    const html = renderToStaticMarkup(
      <p>{formatTileValue(reading(0.98, "ratio"))}</p>,
    );
    expect(html).toBe("<p>0.98×</p>");
  });
});
