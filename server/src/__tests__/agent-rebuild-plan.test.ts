import { describe, expect, it } from "vitest";
import { buildAgentRebuildReport, renderAgentRebuildReport, type AgentRebuildAgentRow } from "../services/agent-rebuild-plan.js";
import { KNOWN_GATEWAY_BOTS, type KnownGatewayBot } from "@paperclipai/shared";

const catalog: KnownGatewayBot[] = KNOWN_GATEWAY_BOTS.filter((bot) => bot.company === "Increase Roas");

const agent = (overrides: Partial<AgentRebuildAgentRow> = {}): AgentRebuildAgentRow => ({
  id: "agent-1",
  name: "Research Analyst",
  status: "idle",
  adapterType: "hermes_gateway",
  metadata: null,
  ...overrides,
});

describe("buildAgentRebuildReport", () => {
  it("lists every catalog bot that has no agent row, and no others", () => {
    const report = buildAgentRebuildReport({ agents: [], catalogBots: catalog });
    expect(report.counts.catalogBotsUnregistered).toBe(catalog.length);
    expect(report.findings.map((finding) => finding.id)).toEqual(catalog.map((bot) => `catalog:${bot.slug}`));
    expect(report.findings.every((finding) => finding.needsOperator)).toBe(true);
    const kiwi = report.findings.find((finding) => finding.id === "catalog:kiwi");
    expect(kiwi?.recommendedAction).toContain("purpose is unknown");
  });

  it("treats an agent whose name slugs to a catalog bot as registered", () => {
    const report = buildAgentRebuildReport({
      agents: [agent({ name: "Funnel Builder", metadata: { agentKind: "bot", bot: { purpose: "Builds funnels.", gateway: { keyId: "gk_1", policy: "website-builder" } } } })],
      catalogBots: catalog,
    });
    expect(report.findings.map((finding) => finding.id)).not.toContain("catalog:funnel-builder");
    expect(report.findings.some((finding) => finding.name === "Funnel Builder")).toBe(false);
  });

  it("reports a tagged bot that has no purpose and no gateway link", () => {
    const report = buildAgentRebuildReport({
      agents: [agent({ metadata: { agentKind: "bot", bot: { purpose: null } } })],
      catalogBots: [],
    });
    expect(report.findings[0]).toMatchObject({
      id: "agent-1",
      kind: "agent",
      reasons: ["missing_purpose", "missing_gateway_link"],
      needsOperator: true,
    });
  });

  it("reports a Hermes agent that carries no bot metadata", () => {
    const report = buildAgentRebuildReport({ agents: [agent()], catalogBots: [] });
    expect(report.findings[0]).toMatchObject({ reasons: ["hermes_agent_untagged"] });
    expect(report.findings[0]?.recommendedAction).toContain("grokBotTwin");
  });

  it("adds an inactive reason for a terminated bot without dropping the others", () => {
    const report = buildAgentRebuildReport({
      agents: [agent({ status: "terminated", metadata: { grokBotTwin: true, bot: { purpose: "Researches." } } })],
      catalogBots: [],
    });
    expect(report.findings[0]?.reasons).toEqual(["missing_gateway_link", "inactive_status"]);
    expect(report.counts.inactive).toBe(1);
    expect(report.counts.missingGatewayLink).toBe(1);
  });

  it("returns no findings for a registered, described and linked bot", () => {
    const report = buildAgentRebuildReport({
      agents: [agent({
        name: "Ads Auditor",
        metadata: {
          grokBotTwin: true,
          bot: { purpose: "Audits ad spend.", gateway: { keyId: "gk_ads", policy: "ads-checker", provider: "gateway" } },
        },
      })],
      catalogBots: [],
    });
    expect(report.findings).toEqual([]);
    expect(report.counts.total).toBe(0);
  });
});

describe("renderAgentRebuildReport", () => {
  it("summarises the reasons and renders one row per finding", () => {
    const report = buildAgentRebuildReport({ agents: [agent()], catalogBots: catalog.slice(0, 1) });
    const markdown = renderAgentRebuildReport(report, "Rebuild report");
    expect(markdown).toContain("# Rebuild report");
    expect(markdown).toContain("1 unregistered catalog bot(s)");
    expect(markdown).toContain("1 untagged Hermes agent(s)");
    expect(markdown).toContain("| Research Analyst | agent | hermes_agent_untagged |");
    expect(markdown).toContain("| Funnel Builder | catalog-bot | catalog_bot_unregistered |");
  });

  it("says so plainly when nothing needs attention", () => {
    const markdown = renderAgentRebuildReport(
      buildAgentRebuildReport({ agents: [], catalogBots: [] }),
      "Rebuild report",
    );
    expect(markdown).toContain("Every agent and catalog bot is registered, described and linked.");
    expect(markdown).not.toContain("| Bot | Kind |");
  });
});
