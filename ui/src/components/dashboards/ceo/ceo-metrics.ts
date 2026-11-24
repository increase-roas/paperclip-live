import type { TileState } from "../Tile";

/**
 * Pure CEO-board arithmetic. Kept out of the component so every threshold is
 * testable without a browser and so the board cannot quietly invent a value.
 */

/** Statuses that count as work still on the board. `blocked` is also open. */
const OPEN_STATUSES = new Set(["backlog", "todo", "in_progress", "in_review", "blocked"]);

export interface TaskCounts {
  open: number;
  blocked: number;
  inProgress: number;
}

export function countTaskStates(issues: ReadonlyArray<{ status: string }>): TaskCounts {
  let open = 0;
  let blocked = 0;
  let inProgress = 0;

  for (const issue of issues) {
    if (issue.status === "blocked") {
      blocked += 1;
      open += 1;
    } else if (OPEN_STATUSES.has(issue.status)) {
      open += 1;
    }
    if (issue.status === "in_progress") inProgress += 1;
  }

  return { open, blocked, inProgress };
}

/**
 * Age of the longest-waiting pending approval, in hours. `null` when nothing
 * is waiting: an empty queue has no age, and rendering 0h would read as a
 * number that was just at its limit.
 */
export function oldestPendingAgeHours(
  approvals: ReadonlyArray<{ createdAt: string | Date }>,
  now: Date = new Date(),
): number | null {
  let oldest: number | null = null;

  for (const approval of approvals) {
    const createdAt = new Date(approval.createdAt).getTime();
    if (Number.isNaN(createdAt)) continue;
    const hours = Math.max(0, (now.getTime() - createdAt) / (60 * 60 * 1000));
    if (oldest === null || hours > oldest) oldest = hours;
  }

  return oldest;
}

export function formatAgeHours(hours: number | null): string {
  if (hours === null) return "nothing waiting";
  if (hours < 1) return "<1h";
  if (hours < 24) return `${Math.floor(hours)}h`;
  const days = Math.floor(hours / 24);
  const remaining = Math.floor(hours % 24);
  return remaining === 0 ? `${days}d` : `${days}d ${remaining}h`;
}

export interface CapGuardrail {
  state: TileState;
  /** Null when no monthly cap is set — the honest "unbounded" answer. */
  utilizationPercent: number | null;
  note: string;
}

/**
 * AI spend against the monthly cap (DASHBOARD-SPEC.md §3 guardrails, §7 #1):
 * alert at 80%, hard stop at 100%, no amber band.
 */
export function capGuardrail(spendCents: number, budgetCents: number): CapGuardrail {
  if (!Number.isFinite(budgetCents) || budgetCents <= 0) {
    return {
      state: "unknown",
      utilizationPercent: null,
      note: "No monthly AI cap is set — spend is unbounded.",
    };
  }

  const percent = (spendCents / budgetCents) * 100;
  // The displayed value and the colour must agree: judge the rounded number,
  // or 79.99% would render "80%" in green.
  const utilizationPercent = Math.round(percent * 10) / 10;

  if (utilizationPercent >= 100) {
    return { state: "red", utilizationPercent, note: "Cap reached — agents hard-stop." };
  }
  if (utilizationPercent >= 80) {
    return { state: "red", utilizationPercent, note: "Alert threshold (80%) reached." };
  }
  return { state: "ok", utilizationPercent, note: "Below the 80% alert threshold." };
}

/** Approval latency red line: 4h in business hours, red past 24h. */
export function approvalGuardrail(oldestAgeHours: number | null): TileState {
  if (oldestAgeHours === null) return "ok";
  return oldestAgeHours > 24 ? "red" : "ok";
}

/** A blocked task is a red line at one; zero is the only clean state. */
export function blockedGuardrail(blocked: number): TileState {
  return blocked > 0 ? "red" : "ok";
}
