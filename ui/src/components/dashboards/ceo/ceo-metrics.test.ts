import { describe, expect, it } from "vitest";
import {
  approvalGuardrail,
  blockedGuardrail,
  capGuardrail,
  countTaskStates,
  formatAgeHours,
  oldestPendingAgeHours,
} from "./ceo-metrics";

describe("countTaskStates", () => {
  it("counts open work and flags blocked, with blocked also open", () => {
    expect(countTaskStates([
      { status: "backlog" },
      { status: "todo" },
      { status: "in_progress" },
      { status: "in_review" },
      { status: "blocked" },
      { status: "done" },
      { status: "cancelled" },
    ])).toEqual({ open: 5, blocked: 1, inProgress: 1 });
  });

  it("reports zero for an empty board", () => {
    expect(countTaskStates([])).toEqual({ open: 0, blocked: 0, inProgress: 0 });
  });
});

describe("oldestPendingAgeHours", () => {
  const now = new Date("2026-11-23T12:00:00.000Z");

  it("returns null when nothing is waiting", () => {
    expect(oldestPendingAgeHours([], now)).toBeNull();
  });

  it("returns the age of the longest-waiting approval", () => {
    expect(oldestPendingAgeHours([
      { createdAt: "2026-11-23T10:00:00.000Z" },
      { createdAt: "2026-11-22T09:00:00.000Z" },
      { createdAt: "2026-11-23T11:30:00.000Z" },
    ], now)).toBe(27);
  });

  it("ignores unparseable timestamps instead of reporting a stale age", () => {
    expect(oldestPendingAgeHours([{ createdAt: "not-a-date" }], now)).toBeNull();
  });

  it("clamps a future timestamp to zero", () => {
    expect(oldestPendingAgeHours([{ createdAt: "2026-11-24T00:00:00.000Z" }], now)).toBe(0);
  });
});

describe("formatAgeHours", () => {
  it("formats hours and days without a fake zero", () => {
    expect(formatAgeHours(null)).toBe("nothing waiting");
    expect(formatAgeHours(0.4)).toBe("<1h");
    expect(formatAgeHours(3.9)).toBe("3h");
    expect(formatAgeHours(24)).toBe("1d");
    expect(formatAgeHours(28.5)).toBe("1d 4h");
  });
});

describe("capGuardrail", () => {
  it("says a company without a cap is unbounded", () => {
    expect(capGuardrail(5000, 0)).toEqual({
      state: "unknown",
      utilizationPercent: null,
      note: "No monthly AI cap is set — spend is unbounded.",
    });
  });

  it("is green below the 80% alert line and never shows green at 80%", () => {
    expect(capGuardrail(7900, 10000).state).toBe("ok");
    expect(capGuardrail(5000, 10000).state).toBe("ok");
    expect(capGuardrail(5000, 10000).utilizationPercent).toBe(50);
    // The rounded value is what the tile shows, so 79.99% is judged as 80%.
    expect(capGuardrail(7999, 10000).state).toBe("red");
  });

  it("is red at the alert line and stays red at the cap", () => {
    expect(capGuardrail(8000, 10000).state).toBe("red");
    expect(capGuardrail(8000, 10000).note).toBe("Alert threshold (80%) reached.");
    expect(capGuardrail(10000, 10000).state).toBe("red");
    expect(capGuardrail(12000, 10000).note).toBe("Cap reached — agents hard-stop.");
  });

  it("rounds the displayed percentage to one decimal", () => {
    expect(capGuardrail(3333, 10000).utilizationPercent).toBe(33.3);
  });
});

describe("red-line states", () => {
  it("treats a 24-hour wait as still inside the line and 24h+1m as red", () => {
    expect(approvalGuardrail(null)).toBe("ok");
    expect(approvalGuardrail(4)).toBe("ok");
    expect(approvalGuardrail(24)).toBe("ok");
    expect(approvalGuardrail(24.01)).toBe("red");
  });

  it("treats any blocked task as red", () => {
    expect(blockedGuardrail(0)).toBe("ok");
    expect(blockedGuardrail(1)).toBe("red");
  });
});
