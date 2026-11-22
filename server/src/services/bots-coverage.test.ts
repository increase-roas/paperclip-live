import { describe, expect, it } from "vitest";
import { findBotCoverageGaps, renderBotCoverageReport, toCoverageBot, type BotCoverageBot } from "./bots-coverage.js";

function bot(overrides: Partial<BotCoverageBot> = {}): BotCoverageBot {
  return {
    id: overrides.id ?? "agent-1",
    slug: overrides.slug ?? "web-builder",
    name: overrides.name ?? "Web Builder",
    status: overrides.status ?? "idle",
    taggedAsBot: overrides.taggedAsBot ?? true,
    purpose: overrides.purpose ?? null,
    gateway: overrides.gateway ?? null,
    routineCount: overrides.routineCount ?? 0,
    activityCount: overrides.activityCount ?? 0,
  };
}

describe("bot page coverage", () => {
  it("reports every gap for a bot whose page has no recorded facts", () => {
    const [finding] = findBotCoverageGaps([bot()]);
    expect(finding).toMatchObject({
      slug: "web-builder",
      name: "Web Builder",
      status: "idle",
      gaps: ["purpose", "gateway_policy", "routines", "activity"],
    });
  });

  it("omits a bot whose page has everything", () => {
    expect(findBotCoverageGaps([
      bot({ purpose: "Builds pages.", gateway: { policy: "website-builder" }, routineCount: 2, activityCount: 4 }),
    ])).toEqual([]);
  });

  it("counts an untagged Hermes agent as a gap even when the rest is recorded", () => {
    const [finding] = findBotCoverageGaps([
      bot({ taggedAsBot: false, purpose: "Checks ad spend.", gateway: { policy: "ads-checker" }, routineCount: 1, activityCount: 3 }),
    ]);
    expect(finding?.gaps).toEqual(["bot_tag"]);
  });

  it("sorts findings by name so two runs diff cleanly", () => {
    const findings = findBotCoverageGaps([bot({ name: "Zeta" }), bot({ name: "Alpha" })]);
    expect(findings.map((finding) => finding.name)).toEqual(["Alpha", "Zeta"]);
  });

  it("renders a table that names each gap", () => {
    const findings = findBotCoverageGaps([bot({ name: "Kiwi", slug: "kiwi" })]);
    const report = renderBotCoverageReport(findings, "Live bots");
    expect(report).toContain("## Live bots");
    expect(report).toContain("1 bot with a page gap");
    expect(report).toContain("| Kiwi (`kiwi`) | idle | purpose, gateway_policy, routines, activity |");
  });

  it("says so when every page is complete", () => {
    const report = renderBotCoverageReport([], "Live bots");
    expect(report).toContain("0 bots with a page gap");
    expect(report).toContain("Every bot page has everything Paperclip records.");
  });
});

describe("mapping the Bots API onto coverage", () => {
  it("takes the derived policy and the recorded purpose from the summary", () => {
    const mapped = toCoverageBot(
      {
        id: "agent-1",
        slug: "web-builder",
        name: "Web Builder",
        status: "idle",
        purpose: "Builds pages.",
        gateway: { keyId: null, policy: "website-builder", provider: "srv:8443", source: "agent_config" },
      },
      { routines: [{ id: "r1" }], recentActivity: [{ id: "a1" }, { id: "a2" }] },
    );
    expect(mapped).toMatchObject({
      slug: "web-builder",
      taggedAsBot: true,
      purpose: "Builds pages.",
      gateway: { policy: "website-builder" },
      routineCount: 1,
      activityCount: 2,
    });
  });

  it("treats an untagged agent, an empty purpose and missing detail lists as gaps", () => {
    const mapped = toCoverageBot(
      { id: "agent-2", name: "Ads checker", status: "idle", purpose: "   ", gateway: null, taggedAsBot: false },
      {},
    );
    expect(mapped).toMatchObject({ taggedAsBot: false, purpose: null, gateway: null, routineCount: 0, activityCount: 0 });
    expect(findBotCoverageGaps([mapped])[0]?.gaps).toEqual([
      "bot_tag", "purpose", "gateway_policy", "routines", "activity",
    ]);
  });

  it("ignores a gateway link without a policy string", () => {
    const mapped = toCoverageBot({ id: "a", name: "B", status: "idle", gateway: { keyId: "gk_x" } }, {});
    expect(mapped.gateway).toBeNull();
  });
});
