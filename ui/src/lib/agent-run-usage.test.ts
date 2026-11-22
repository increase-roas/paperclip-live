import { describe, expect, it } from "vitest";
import type { HeartbeatRun } from "@paperclipai/shared";
import { agentRunUsageRow, recentAgentRunUsage } from "./agent-run-usage";

const now = Date.parse("2026-11-21T12:00:00.000Z");

function run(overrides: Partial<HeartbeatRun>): HeartbeatRun {
  return {
    id: "run-1",
    companyId: "company-1",
    agentId: "agent-1",
    status: "succeeded",
    createdAt: new Date("2026-11-21T10:00:00.000Z"),
    usageJson: null,
    resultJson: null,
    ...overrides,
  } as HeartbeatRun;
}

describe("agent run usage", () => {
  it("reads recorded tokens and a reported cost", () => {
    expect(agentRunUsageRow(run({
      costUsd: 0.0123,
      usageJson: { inputTokens: 120, cachedInputTokens: 30, outputTokens: 45, totalTokens: 195, billingType: "api" },
    }))).toMatchObject({
      inputTokens: 120,
      cachedInputTokens: 30,
      outputTokens: 45,
      totalTokens: 195,
      costCents: 1,
      costKind: "reported",
      hasUsage: true,
    });
  });

  it("marks a zero-cost subscription run as included instead of free", () => {
    expect(agentRunUsageRow(run({
      costUsd: 0,
      usageJson: { inputTokens: 10, outputTokens: 5, billingType: "subscription", costStatus: "reported" },
    }))).toMatchObject({ costCents: 0, costKind: "included" });
  });

  it("keeps missing usage and unpriced cost visible", () => {
    expect(agentRunUsageRow(run({ usageJson: { costStatus: "unpriced" } }))).toMatchObject({
      hasUsage: false, costCents: null, costKind: "unpriced",
    });
    expect(agentRunUsageRow(run({ usageJson: {} }))).toMatchObject({ hasUsage: false, costKind: "unreported" });
  });

  it("keeps the last seven days, newest first, and totals only recorded usage", () => {
    const usage = recentAgentRunUsage([
      run({ id: "old", createdAt: new Date("2026-11-13T10:00:00.000Z"), usageJson: { inputTokens: 999 } }),
      run({ id: "newer", createdAt: new Date("2026-11-21T11:00:00.000Z"), costUsd: 0.02,
        usageJson: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }),
      run({ id: "older", createdAt: new Date("2026-11-20T11:00:00.000Z"), costUsd: 0.01,
        usageJson: { inputTokens: 4, cachedInputTokens: 1, outputTokens: 1, totalTokens: 6 } }),
      run({ id: "unpriced", createdAt: new Date("2026-11-19T11:00:00.000Z"), usageJson: { costStatus: "unpriced" } }),
    ], now, 7, 20);
    expect(usage.rows.map(row => row.id)).toEqual(["newer", "older", "unpriced"]);
    expect(usage).toMatchObject({
      runCount: 3,
      inputTokens: 14,
      cachedInputTokens: 1,
      outputTokens: 3,
      totalTokens: 18,
      reportedCostCents: 3,
      reportedCostRuns: 2,
    });
  });

  it("caps displayed rows without dropping the window totals", () => {
    const runs = Array.from({ length: 25 }, (_, index) => run({
      id: `run-${index}`,
      createdAt: new Date(now - index * 60_000),
      usageJson: { inputTokens: 1 },
    }));
    const usage = recentAgentRunUsage(runs, now, 7, 20);
    expect(usage.rows).toHaveLength(20);
    expect(usage.runCount).toBe(25);
    expect(usage.inputTokens).toBe(25);
  });
});
