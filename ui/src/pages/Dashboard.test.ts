import type { Agent } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { countEnabledAgents, derivePausedAgentBanner } from "./Dashboard";

function agent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-1",
    name: "Agent",
    status: "idle",
    pauseReason: null,
    ...overrides,
  } as unknown as Agent;
}

describe("derivePausedAgentBanner", () => {
  it("returns null with no agents loaded or an empty company", () => {
    expect(derivePausedAgentBanner(undefined)).toBeNull();
    expect(derivePausedAgentBanner([])).toBeNull();
  });

  it("prefers the imported banner and lists only import-paused agents", () => {
    const banner = derivePausedAgentBanner([
      agent({ id: "a", status: "paused", pauseReason: "import" }),
      agent({ id: "b", status: "paused", pauseReason: "manual" }),
      agent({ id: "c", status: "idle" }),
    ]);
    expect(banner).toEqual({ kind: "imported", pausedImportedAgentIds: ["a"] });
  });

  it("falls back to the all-paused banner when no import pauses exist", () => {
    const banner = derivePausedAgentBanner([
      agent({ id: "a", status: "paused", pauseReason: "manual" }),
      agent({ id: "b", status: "paused", pauseReason: "system" }),
    ]);
    expect(banner).toEqual({ kind: "all-paused" });
  });

  it("shows nothing while at least one agent can run and none are import-paused", () => {
    const banner = derivePausedAgentBanner([
      agent({ id: "a", status: "paused", pauseReason: "manual" }),
      agent({ id: "b", status: "idle" }),
    ]);
    expect(banner).toBeNull();
  });
});

describe("countEnabledAgents", () => {
  it("reports zero beside the all-paused banner", () => {
    expect(countEnabledAgents({ active: 0, running: 0, paused: 3, error: 0 })).toBe(0);
  });

  it("counts active, running and errored agents but excludes paused agents", () => {
    expect(countEnabledAgents({ active: 2, running: 1, paused: 4, error: 1 })).toBe(4);
  });

  it("matches the sum of every non-paused bucket", () => {
    const buckets = { active: 5, running: 2, paused: 9, error: 3 };
    expect(countEnabledAgents(buckets)).toBe(buckets.active + buckets.running + buckets.error);
  });
});
