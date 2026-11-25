import { describe, expect, it } from "vitest";
import { buildAgentWikiSopTemplate } from "./WorkflowsPage";

describe("buildAgentWikiSopTemplate", () => {
  it("formats a neutral AgentWiki SOP without personal Telegram chat IDs", () => {
    const md = buildAgentWikiSopTemplate({
      name: "Audit Meta Spend",
      profile: "ads-checker",
      trigger: "Weekly review",
      inputs: "Client slug\nMeta ad account ID",
      steps: "Pull 30d spend\nCheck CPL against target",
      approvals: "Pause before changing budgets",
    });

    expect(md).toContain("# Audit Meta Spend");
    expect(md).toContain("**Owner Profile:** `ads-checker`");
    expect(md).toContain("1. Pull 30d spend");
    expect(md).toContain("2. Check CPL against target");
    expect(md).not.toContain("5565447574");
  });
});
