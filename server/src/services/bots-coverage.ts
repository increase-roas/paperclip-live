/** One thing an operator cannot see on a bot's page because nothing records it. */
export type BotCoverageGapKind = "bot_tag" | "purpose" | "gateway_policy" | "routines" | "activity";

/**
 * A bot exactly as the Bots API describes it.
 *
 * The API already derives everything a page can show: whether the agent is
 * tagged, its purpose, and its gateway policy (recorded metadata or the agent's
 * own gateway URL). This check therefore measures the pages, not the raw rows —
 * if the API cannot fill a field, the page cannot show it.
 */
export interface BotCoverageBot {
  id: string;
  slug: string;
  name: string;
  status: string;
  /** False only for a Hermes gateway agent with no bot metadata. */
  taggedAsBot: boolean;
  purpose: string | null;
  /** A recorded or derived gateway link, never a secret. */
  gateway: { policy: string } | null;
  routineCount: number;
  activityCount: number;
}

/**
 * Lists what each bot's page cannot show, using only what the API records.
 *
 * Missing routines, activity, purpose or a gateway policy is often the truth
 * rather than a defect: the finding says "the page cannot show this", never
 * "this bot is broken". Purpose and the bot tag are the two gaps an operator can
 * fix from metadata; routines follow from assigning work, activity from running
 * it.
 */
/**
 * A metadata write an operator could make, keyed by bot slug.
 *
 * This is a draft: nothing in Paperclip applies it. The coverage report marks a
 * gap as "proposed" when one of these would fill it, so a plan can be reviewed
 * without pretending the data exists yet.
 */
export interface BotCoverageProposal {
  purpose?: string;
  botTag?: boolean;
  gateway?: { policy: string; keyId?: string | null };
}

export type BotCoverageProposals = Record<string, BotCoverageProposal>;

export interface BotCoverageFinding {
  id: string;
  slug: string;
  name: string;
  status: string;
  /** Gaps nothing proposes to fill. */
  gaps: BotCoverageGapKind[];
  /** Gaps a drafted metadata write would fill. */
  proposed: BotCoverageGapKind[];
}

function gapKinds(bot: BotCoverageBot): BotCoverageGapKind[] {
  const gaps: BotCoverageGapKind[] = [];
  if (!bot.taggedAsBot) gaps.push("bot_tag");
  if (!bot.purpose) gaps.push("purpose");
  if (!bot.gateway) gaps.push("gateway_policy");
  if (bot.routineCount === 0) gaps.push("routines");
  if (bot.activityCount === 0) gaps.push("activity");
  return gaps;
}

function proposedKinds(gaps: BotCoverageGapKind[], proposal: BotCoverageProposal | undefined): BotCoverageGapKind[] {
  if (!proposal) return [];
  const proposed: BotCoverageGapKind[] = [];
  for (const gap of gaps) {
    if (gap === "bot_tag" && proposal.botTag) proposed.push(gap);
    if (gap === "purpose" && proposal.purpose?.trim()) proposed.push(gap);
    if (gap === "gateway_policy" && proposal.gateway?.policy?.trim()) proposed.push(gap);
  }
  return proposed;
}

export function findBotCoverageGaps(
  bots: BotCoverageBot[],
  proposals: BotCoverageProposals = {},
): BotCoverageFinding[] {
  const findings: BotCoverageFinding[] = [];
  for (const bot of bots) {
    const gaps = gapKinds(bot);
    if (gaps.length === 0) continue;
    const proposed = proposedKinds(gaps, proposals[bot.slug]);
    findings.push({
      id: bot.id,
      slug: bot.slug,
      name: bot.name,
      status: bot.status,
      gaps: gaps.filter((gap) => !proposed.includes(gap)),
      proposed,
    });
  }
  return findings.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Maps one Bots API summary and detail onto the coverage shape.
 *
 * The summary already carries the bot tag, purpose and derived gateway link;
 * the detail adds routines and activity. Anything the API omits counts as
 * missing, because the page would not show it either.
 */
export function toCoverageBot(summary: Record<string, unknown>, detail: Record<string, unknown>): BotCoverageBot {
  const gateway = summary.gateway as { policy?: unknown } | null | undefined;
  return {
    id: String(summary.id ?? summary.slug ?? ""),
    slug: String(summary.slug ?? summary.id ?? ""),
    name: String(summary.name ?? ""),
    status: String(summary.status ?? "unknown"),
    taggedAsBot: summary.taggedAsBot !== false,
    purpose: typeof summary.purpose === "string" && summary.purpose.trim() ? summary.purpose : null,
    gateway: gateway && typeof gateway.policy === "string" ? { policy: gateway.policy } : null,
    routineCount: Array.isArray(detail.routines) ? detail.routines.length : 0,
    activityCount: Array.isArray(detail.recentActivity) ? detail.recentActivity.length : 0,
  };
}

/** Human-readable report, one table row per bot with gaps. */
export function renderBotCoverageReport(findings: BotCoverageFinding[], title = "Bot page coverage"): string {
  const count = (kind: BotCoverageGapKind) => findings.filter((finding) => finding.gaps.includes(kind)).length;
  const proposedCount = (kind: BotCoverageGapKind) =>
    findings.filter((finding) => finding.proposed.includes(kind)).length;
  const total = (kind: BotCoverageGapKind) => count(kind) + proposedCount(kind);
  const lines = [
    `## ${title}`,
    "",
    `${findings.length} bot${findings.length === 1 ? "" : "s"} with a page gap: ` +
      `${total("bot_tag")} untagged, ${total("purpose")} without a purpose, ` +
      `${total("gateway_policy")} without a gateway policy, ${total("routines")} without routines, ` +
      `${total("activity")} without activity` +
      (findings.some((finding) => finding.proposed.length > 0)
        ? ` (${findings.filter((finding) => finding.proposed.length > 0).length} with a drafted write).`
        : "."),
    "",
  ];
  if (findings.length === 0) {
    lines.push("Every bot page has everything Paperclip records.");
    return lines.join("\n");
  }
  lines.push("| Bot | Status | Missing | Proposed |", "| --- | --- | --- | --- |");
  for (const finding of findings) {
    lines.push(
      `| ${finding.name} (\`${finding.slug}\`) | ${finding.status} | ${finding.gaps.join(", ") || "—"} | ` +
        `${finding.proposed.join(", ") || "—"} |`,
    );
  }
  return lines.join("\n");
}
