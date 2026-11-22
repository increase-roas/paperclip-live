import { describe, expect, it } from "vitest";
import {
  findBotCoverageGaps,
  renderBotCoverageReport,
  toCoverageBot,
  type BotCoverageBot,
  type BotCoverageProposals,
} from "./bots-coverage.js";

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
    expect(report).toContain("| Kiwi (`kiwi`) | idle | purpose, gateway_policy, routines, activity | — |");
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

describe("drafted metadata writes", () => {
  const proposals: BotCoverageProposals = {
    kiwi: { purpose: "Drafted purpose from Alex." },
    "web-builder": { gateway: { policy: "website-builder" }, botTag: true },
  };

  it("moves a gap from missing to proposed", () => {
    const [kiwi] = findBotCoverageGaps([bot({ name: "Kiwi", slug: "kiwi" })], proposals);
    expect(kiwi).toMatchObject({
      gaps: ["gateway_policy", "routines", "activity"],
      proposed: ["purpose"],
    });
  });

  it("proposes a gateway policy and a bot tag together", () => {
    const [web] = findBotCoverageGaps(
      [bot({ name: "Web Builder", slug: "web-builder", taggedAsBot: false })],
      proposals,
    );
    expect(web?.proposed).toEqual(["bot_tag", "gateway_policy"]);
    expect(web?.gaps).toEqual(["purpose", "routines", "activity"]);
  });

  it("ignores a proposal for a gap the bot does not have", () => {
    const [web] = findBotCoverageGaps(
      [bot({ name: "Web Builder", slug: "web-builder", purpose: "Builds pages." })],
      proposals,
    );
    expect(web?.proposed).toEqual(["gateway_policy"]);
  });

  it("ignores blank drafted values", () => {
    const [kiwi] = findBotCoverageGaps([bot({ name: "Kiwi", slug: "kiwi" })], {
      kiwi: { purpose: "   ", gateway: { policy: "" } },
    });
    expect(kiwi?.proposed).toEqual([]);
    expect(kiwi?.gaps).toContain("purpose");
  });

  it("counts proposed gaps in the summary and shows them in their own column", () => {
    const findings = findBotCoverageGaps(
      [bot({ name: "Kiwi", slug: "kiwi" }), bot({ name: "Javar", slug: "javar" })],
      proposals,
    );
    const report = renderBotCoverageReport(findings, "Live bots");
    expect(report).toContain("2 without a purpose");
    expect(report).toContain("(1 with a drafted write)");
    expect(report).toContain("| Kiwi (`kiwi`) | idle | gateway_policy, routines, activity | purpose |");
  });

  it("keeps a bot with no drafted write fully missing", () => {
    const findings = findBotCoverageGaps([bot({ name: "Javar", slug: "javar" })], proposals);
    expect(findings[0]?.proposed).toEqual([]);
    expect(findings[0]?.gaps).toHaveLength(4);
  });
});
