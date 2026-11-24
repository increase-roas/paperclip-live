import { describe, expect, it } from "vitest";
import { READING_ORDER_STEPS, firstAttentionStepId, stepStatus } from "./reading-order";

/**
 * Spec v2 §1, verbatim. If this list changes, the spec changed first.
 */
const QUESTIONS = [
  "Are we going out of business?",
  "Does a customer pay for themselves inside 30 days?",
  "Is the unit economics arbitrage real?",
  "What is left after delivery?",
  "Are we keeping them?",
  "Is the appointment engine working?",
  "Are we reaching them in time?",
  "Is the spend buying customers or just leads?",
];

describe("dashboard reading order", () => {
  it("keeps the eight questions from spec v2 §1 in their exact order", () => {
    expect(READING_ORDER_STEPS.map((step) => step.question)).toEqual(QUESTIONS);
  });

  it("names the first number that answers each question and the board it lives on", () => {
    expect(READING_ORDER_STEPS.map((step) => step.number)).toEqual([
      "Cash collected, trailing 30 days",
      "30-day cash multiple",
      "LTGP : CAC",
      "Gross margin",
      "Churn / NRR",
      "Show rate",
      "Speed to lead",
      "CAC",
    ]);
    expect(READING_ORDER_STEPS.map((step) => step.board)).toEqual([
      "CEO",
      "CEO",
      "CEO",
      "CEO",
      "CEO → Fulfillment",
      "Sales",
      "Sales",
      "Marketing",
    ]);
  });

  it("treats a step with no status as unknown, never green", () => {
    for (const step of READING_ORDER_STEPS) {
      expect(stepStatus({}, step.id)).toBe("unknown");
    }
    expect(stepStatus({ cash: "ok" }, "cash")).toBe("ok");
    expect(stepStatus({ cash: "red" }, "cash")).toBe("red");
  });

  it("sends the reader to the first number that is not green", () => {
    expect(firstAttentionStepId({})).toBe(READING_ORDER_STEPS[0].id);

    const allGreen = Object.fromEntries(READING_ORDER_STEPS.map((step) => [step.id, "ok" as const]));
    expect(firstAttentionStepId(allGreen)).toBeNull();

    // An earlier grey outranks a later red: you cannot read past a number you
    // do not have.
    const mixed = {
      ...allGreen,
      [READING_ORDER_STEPS[2].id]: "unknown" as const,
      [READING_ORDER_STEPS[5].id]: "red" as const,
    };
    expect(firstAttentionStepId(mixed)).toBe(READING_ORDER_STEPS[2].id);

    const firstRed = { ...allGreen, [READING_ORDER_STEPS[3].id]: "red" as const };
    expect(firstAttentionStepId(firstRed)).toBe(READING_ORDER_STEPS[3].id);
  });
});
