import { describe, expect, it } from "vitest";
import { botStatusLabel } from "./bot-status";

describe("botStatusLabel", () => {
  it("names known bot-only states for operators", () => {
    expect(botStatusLabel("unregistered")).toBe("Not registered");
  });

  it("sentence-cases agent states and delimiter-separated values", () => {
    expect(botStatusLabel("running")).toBe("Running");
    expect(botStatusLabel("in_review")).toBe("In review");
  });

  it("falls back to Unknown for missing copy", () => {
    expect(botStatusLabel("")).toBe("Unknown");
    expect(botStatusLabel("   ")).toBe("Unknown");
  });
});
