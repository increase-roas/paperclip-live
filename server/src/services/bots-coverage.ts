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

export interface BotCoverageFinding {
  id: string;
  slug: string;
  name: string;
  status: string;
  /** Empty findings are omitted, so a finding means the page has a gap. */
  gaps: BotCoverageGapKind[];
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
export function findBotCoverageGaps(bots: BotCoverageBot[]): BotCoverageFinding[] {
  const findings: BotCoverageFinding[] = [];
  for (const bot of bots) {
    const gaps: BotCoverageGapKind[] = [];
    if (!bot.taggedAsBot) gaps.push("bot_tag");
    if (!bot.purpose) gaps.push("purpose");
    if (!bot.gateway) gaps.push("gateway_policy");
    if (bot.routineCount === 0) gaps.push("routines");
    if (bot.activityCount === 0) gaps.push("activity");
    if (gaps.length === 0) continue;
    findings.push({ id: bot.id, slug: bot.slug, name: bot.name, status: bot.status, gaps });
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
  const lines = [
    `## ${title}`,
    "",
    `${findings.length} bot${findings.length === 1 ? "" : "s"} with a page gap: ` +
      `${count("bot_tag")} untagged, ${count("purpose")} without a purpose, ` +
      `${count("gateway_policy")} without a gateway policy, ${count("routines")} without routines, ` +
      `${count("activity")} without activity.`,
    "",
  ];
  if (findings.length === 0) {
    lines.push("Every bot page has everything Paperclip records.");
    return lines.join("\n");
  }
  lines.push("| Bot | Status | Missing |", "| --- | --- | --- |");
  for (const finding of findings) {
    lines.push(`| ${finding.name} (\`${finding.slug}\`) | ${finding.status} | ${finding.gaps.join(", ")} |`);
  }
  return lines.join("\n");
}
