import type { HeartbeatRun } from "@paperclipai/shared";

export type AgentRunCostKind = "reported" | "included" | "unpriced" | "unreported";

export type AgentRunUsageRow = {
  id: string;
  status: HeartbeatRun["status"];
  createdAt: Date;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costCents: number | null;
  costKind: AgentRunCostKind;
  hasUsage: boolean;
};

export type AgentRunUsageWindow = {
  rows: AgentRunUsageRow[];
  runCount: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reportedCostCents: number;
  reportedCostRuns: number;
};

function asNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

function asUsageRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** One run's recorded usage, read from the fields the server already persists. */
export function agentRunUsageRow(run: HeartbeatRun): AgentRunUsageRow {
  const usage = asUsageRecord(run.usageJson);
  const inputTokens = asNumber(usage.inputTokens) ?? 0;
  const cachedInputTokens = asNumber(usage.cachedInputTokens) ?? 0;
  const outputTokens = asNumber(usage.outputTokens) ?? 0;
  const totalTokens = asNumber(usage.totalTokens) ?? inputTokens + cachedInputTokens + outputTokens;
  const billingType = typeof usage.billingType === "string" ? usage.billingType : "";
  const costUsd = asNumber(run.costUsd)
    ?? asNumber(usage.costUsd)
    ?? asNumber(usage.costUsdExact);
  const costCents = costUsd === null ? null : Math.max(0, Math.round(costUsd * 100));
  const costKind: AgentRunCostKind = costCents === null
    ? usage.costStatus === "unpriced" ? "unpriced" : "unreported"
    : billingType.startsWith("subscription") && costCents === 0 ? "included" : "reported";
  return {
    id: run.id,
    status: run.status,
    createdAt: new Date(run.createdAt),
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens,
    costCents,
    costKind,
    hasUsage: ["inputTokens", "cachedInputTokens", "outputTokens", "totalTokens"].some(key => Object.hasOwn(usage, key)),
  };
}

export function recentAgentRunUsage(
  runs: readonly HeartbeatRun[] | undefined,
  nowMs = Date.now(),
  windowDays = 7,
  limit = 20,
): AgentRunUsageWindow {
  const cutoff = nowMs - windowDays * 24 * 60 * 60 * 1_000;
  const inWindow = (runs ?? [])
    .filter(run => new Date(run.createdAt).getTime() >= cutoff)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const allRows = inWindow.map(agentRunUsageRow);
  const reported = allRows.filter(row => row.costKind === "reported" && row.costCents !== null);
  return {
    rows: allRows.slice(0, limit),
    runCount: allRows.length,
    inputTokens: allRows.reduce((sum, row) => sum + row.inputTokens, 0),
    cachedInputTokens: allRows.reduce((sum, row) => sum + row.cachedInputTokens, 0),
    outputTokens: allRows.reduce((sum, row) => sum + row.outputTokens, 0),
    totalTokens: allRows.reduce((sum, row) => sum + row.totalTokens, 0),
    reportedCostCents: reported.reduce((sum, row) => sum + (row.costCents ?? 0), 0),
    reportedCostRuns: reported.length,
  };
}
