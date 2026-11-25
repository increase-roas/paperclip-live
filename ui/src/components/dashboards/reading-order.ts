import type { TileState } from "./Tile";

/**
 * Spec v2 §1: the order Hormozi says to read a business. It is a sequence of
 * questions, not a list of boards. Read top to bottom; stop at the first red.
 *
 * The questions are copied verbatim from `DASHBOARD-SPEC-v2-hormozi.md` §1.
 * `number` is the first number on that board; `board` is where it lives.
 */
export const READING_ORDER_STEPS = [
  {
    id: "cash",
    question: "Are we going out of business?",
    number: "Cash collected, trailing 30 days",
    board: "CEO",
    href: "/dashboard/ceo",
  },
  {
    id: "cash-multiple",
    question: "Does a customer pay for themselves inside 30 days?",
    number: "30-day cash multiple",
    board: "CEO",
    href: "/dashboard/ceo",
  },
  {
    id: "ltgp-cac",
    question: "Is the unit economics arbitrage real?",
    number: "LTGP : CAC",
    board: "CEO",
    href: "/dashboard/ceo",
  },
  {
    id: "gross-margin",
    question: "What is left after delivery?",
    number: "Gross margin",
    board: "CEO",
    href: "/dashboard/ceo",
  },
  {
    id: "churn",
    question: "Are we keeping them?",
    number: "Churn / NRR",
    board: "CEO → Fulfillment",
    href: "/dashboard/fulfillment",
  },
  {
    id: "show-rate",
    question: "Is the appointment engine working?",
    number: "Show rate",
    board: "Sales",
    href: "/dashboard/sales",
  },
  {
    id: "speed-to-lead",
    question: "Are we reaching them in time?",
    number: "Speed to lead",
    board: "Sales",
    href: "/dashboard/sales",
  },
  {
    id: "cac",
    question: "Is the spend buying customers or just leads?",
    number: "CAC",
    board: "Marketing",
    href: "/dashboard/marketing",
  },
] as const;

export type ReadingOrderStep = (typeof READING_ORDER_STEPS)[number];
export type ReadingOrderStepId = ReadingOrderStep["id"];

/** Live state per step. A missing step is `unknown` (grey), never green. */
export type ReadingOrderStatusMap = Partial<Record<ReadingOrderStepId, TileState>>;

export function stepStatus(statuses: ReadingOrderStatusMap, id: ReadingOrderStepId): TileState {
  return statuses[id] ?? "unknown";
}

/**
 * The step to stop at: the first in reading order that is not green.
 *
 * An earlier grey outranks a later red, because you cannot read past a number
 * you do not have. `null` means all eight are green, so the reader moves to the
 * business's constraint instead of this list (spec v2 §1).
 */
export function firstAttentionStepId(statuses: ReadingOrderStatusMap): ReadingOrderStepId | null {
  for (const step of READING_ORDER_STEPS) {
    if (stepStatus(statuses, step.id) !== "ok") return step.id;
  }
  return null;
}
