/**
 * Read-only rebuild / re-registration report for a company's bots and agents.
 *
 * The report answers one question: which agents and bots would a rebuild or a
 * registration touch, and why? It never writes: the caller supplies the rows it
 * already read, and the planner returns findings with a recommended action and
 * whether the action needs an operator decision (Alex) or is routine.
 *
 * Reasons come only from recorded facts — metadata, adapter type, status, and
 * whether an agent row exists. A missing purpose is reported as missing, never
 * filled with invented text.
 */

import {
  botSlug,
  isBotAgentMetadata,
  readBotMetadata,
  type KnownGatewayBot,
} from "@paperclipai/shared";

export type AgentRebuildReason =
  | "catalog_bot_unregistered"
  | "missing_purpose"
  | "missing_gateway_link"
  | "hermes_agent_untagged"
  | "inactive_status";

export interface AgentRebuildFinding {
  /** Agent id, or `catalog:<slug>` for a catalog bot with no agent row. */
  id: string;
  name: string;
  kind: "agent" | "catalog-bot";
  reasons: AgentRebuildReason[];
  /** What a person would do, in one line. */
  recommendedAction: string;
  /** True when the action changes live company data or needs an owner decision. */
  needsOperator: boolean;
}

export interface AgentRebuildReport {
  findings: AgentRebuildFinding[];
  counts: {
    total: number;
    catalogBotsUnregistered: number;
    missingPurpose: number;
    missingGatewayLink: number;
    untaggedHermes: number;
    inactive: number;
  };
}

export interface AgentRebuildAgentRow {
  id: string;
  name: string;
  status: string;
  adapterType: string;
  metadata: unknown;
}

const INACTIVE_STATUSES = new Set(["terminated", "error"]);

/**
 * Catalog entries gain a `purpose` field in the bots registration branch. Read it
 * defensively so this report works on either side of that merge and reports
 * "unknown" instead of inventing text.
 */
function catalogPurpose(known: KnownGatewayBot): string | null {
  const value = (known as { purpose?: string | null }).purpose;
  return typeof value === "string" && value.trim() ? value : null;
}

function reasonsForAgent(agent: AgentRebuildAgentRow): AgentRebuildReason[] {
  const reasons: AgentRebuildReason[] = [];
  const tagged = isBotAgentMetadata(agent.metadata);
  const bot = readBotMetadata(agent.metadata);
  if (tagged) {
    if (!bot.purpose) reasons.push("missing_purpose");
    if (!bot.gateway) reasons.push("missing_gateway_link");
  } else if (agent.adapterType === "hermes_gateway") {
    reasons.push("hermes_agent_untagged");
  }
  if (INACTIVE_STATUSES.has(agent.status)) reasons.push("inactive_status");
  return reasons;
}

function actionFor(reasons: AgentRebuildReason[]): { action: string; needsOperator: boolean } {
  if (reasons.includes("catalog_bot_unregistered")) {
    return {
      action: "Register the bot agent with `pnpm bots:register` after the dry run is approved.",
      needsOperator: true,
    };
  }
  if (reasons.includes("missing_purpose")) {
    return {
      action: "Add `bot.purpose` to the agent metadata; the bot page shows a placeholder until then.",
      needsOperator: true,
    };
  }
  if (reasons.includes("missing_gateway_link")) {
    return {
      action: "Record `bot.gateway.keyId` and `bot.gateway.policy` from the gateway key registry.",
      needsOperator: true,
    };
  }
  if (reasons.includes("hermes_agent_untagged")) {
    return {
      action: "Tag the agent with `grokBotTwin: true` or `agentKind: \"bot\"` to file it with the registered bots.",
      needsOperator: true,
    };
  }
  if (reasons.includes("inactive_status")) {
    return {
      action: "Decide whether the bot is retired; a rebuild only makes sense while it is expected to run.",
      needsOperator: true,
    };
  }
  return { action: "No action; the bot is registered, described and linked.", needsOperator: false };
}

/**
 * Build the report from a company's agents and that company's catalog bots.
 * Agents whose name slugs to a catalog bot count as registered for it.
 */
export function buildAgentRebuildReport(input: {
  agents: readonly AgentRebuildAgentRow[];
  catalogBots: readonly KnownGatewayBot[];
}): AgentRebuildReport {
  const findings: AgentRebuildFinding[] = [];
  const agentSlugs = new Set(input.agents.map((agent) => botSlug(agent.name)));

  for (const agent of input.agents) {
    const reasons = reasonsForAgent(agent);
    if (reasons.length === 0) continue;
    const { action, needsOperator } = actionFor(reasons);
    findings.push({
      id: agent.id,
      name: agent.name,
      kind: "agent",
      reasons,
      recommendedAction: action,
      needsOperator,
    });
  }

  for (const known of input.catalogBots) {
    if (agentSlugs.has(known.slug)) continue;
    const reasons: AgentRebuildReason[] = ["catalog_bot_unregistered"];
    const { action, needsOperator } = actionFor(reasons);
    findings.push({
      id: `catalog:${known.slug}`,
      name: known.name,
      kind: "catalog-bot",
      reasons,
      recommendedAction: catalogPurpose(known)
        ? action
        : `${action} Its purpose is unknown; the page asks for one after registration.`,
      needsOperator,
    });
  }

  const count = (reason: AgentRebuildReason) =>
    findings.filter((finding) => finding.reasons.includes(reason)).length;
  return {
    findings,
    counts: {
      total: findings.length,
      catalogBotsUnregistered: count("catalog_bot_unregistered"),
      missingPurpose: count("missing_purpose"),
      missingGatewayLink: count("missing_gateway_link"),
      untaggedHermes: count("hermes_agent_untagged"),
      inactive: count("inactive_status"),
    },
  };
}

/** Markdown rendering for the CLI and for review comments. */
export function renderAgentRebuildReport(report: AgentRebuildReport, title: string): string {
  const lines = [`# ${title}`, ""];
  lines.push(
    `${report.counts.total} bot(s) need attention: ` +
      `${report.counts.catalogBotsUnregistered} unregistered catalog bot(s), ` +
      `${report.counts.missingPurpose} missing a purpose, ` +
      `${report.counts.missingGatewayLink} missing a gateway link, ` +
      `${report.counts.untaggedHermes} untagged Hermes agent(s), ` +
      `${report.counts.inactive} inactive.`,
    "",
  );
  if (report.findings.length === 0) {
    lines.push("Every agent and catalog bot is registered, described and linked.");
    return `${lines.join("\n")}\n`;
  }
  lines.push("| Bot | Kind | Reasons | Recommended action | Owner decision |", "| --- | --- | --- | --- | --- |");
  for (const finding of report.findings) {
    lines.push(
      `| ${finding.name} | ${finding.kind} | ${finding.reasons.join(", ")} | ${finding.recommendedAction} | ${
        finding.needsOperator ? "yes" : "no"
      } |`,
    );
  }
  return `${lines.join("\n")}\n`;
}
