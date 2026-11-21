import { describe, expect, it } from "vitest";
import {
  STARTER_INSTRUCTION_TEMPLATES,
  composeStarterInstructions,
  starterInstructionTemplate,
} from "./starter-agent-instructions";

describe("starter agent instructions", () => {
  it("offers a small template set with role, goals, and guardrails", () => {
    expect(STARTER_INSTRUCTION_TEMPLATES.length).toBeGreaterThanOrEqual(3);
    for (const template of STARTER_INSTRUCTION_TEMPLATES) {
      expect(template.role.trim()).not.toBe("");
      expect(template.goals.trim()).not.toBe("");
      expect(template.guardrails.trim()).not.toBe("");
    }
  });

  it("falls back to the general template for an unknown id", () => {
    expect(starterInstructionTemplate("missing").id).toBe("general");
  });

  it("composes only the sections that have content", () => {
    expect(composeStarterInstructions({ role: "  You are a tester.  ", goals: "", guardrails: "Stay in scope." }))
      .toBe("## Role\n\nYou are a tester.\n\n## Guardrails\n\nStay in scope.");
    expect(composeStarterInstructions({ role: "", goals: " ", guardrails: "" })).toBe("");
  });
});
