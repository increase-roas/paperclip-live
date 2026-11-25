import { describe, expect, it } from "vitest";
import {
  buildAgentWikiSopTemplate,
  buildWorkflowPath,
  findDuplicateWorkflow,
} from "./WorkflowsPage";

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

describe("SOP filename collision helpers", () => {
  it("derives slugified paths and refuses empty punctuation-only names", () => {
    expect(buildWorkflowPath("ads-checker", "Audit Meta Spend")).toBe(
      "ads-checker/audit-meta-spend.md",
    );
    expect(buildWorkflowPath("general", "!!!   ---")).toBeNull();
  });

  it("detects duplicate workflow paths case-insensitively", () => {
    const existing = [
      { path: "ads-checker/audit-meta-spend.md" },
      { path: "general/daily-brief.md" },
    ];
    expect(findDuplicateWorkflow(existing, "ads-checker/audit-meta-spend.md")).toEqual({
      path: "ads-checker/audit-meta-spend.md",
    });
    expect(findDuplicateWorkflow(existing, "ADS-CHECKER/Audit-Meta-Spend.md")).toEqual({
      path: "ads-checker/audit-meta-spend.md",
    });
    expect(findDuplicateWorkflow(existing, "general/audit-meta-spend.md")).toBeNull();
  });
});
