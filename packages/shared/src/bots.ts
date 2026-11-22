/**
 * Bots are the long-running personas an operator runs outside the org chart:
 * Hermes twins hired from the grok-bot-twin plugin, and gateway-only bots that
 * answer through the OAuth gateway instead of a Paperclip agent.
 *
 * Paperclip stores the identity of an agent-backed bot in agent metadata:
 *
 * ```json
 * {
 *   "grokBotTwin": true,
 *   "bot": {
 *     "purpose": "Builds funnels and landing pages.",
 *     "transport": "hermes_gateway",
 *     "gateway": { "keyId": "gk_...", "policy": "website-builder" }
 *   }
 * }
 * ```
 *
 * `gateway.keyId` is an identifier, never the key itself. Secret values stay in
 * the company secret store or the gateway; nothing here reads or returns them.
 */

export const BOT_METADATA_KEY = "bot";

/**
 * Gateway-only bots Alex runs that have no Paperclip agent row yet. Each entry
 * names the company it belongs to, so the roster never suggests a bot in a
 * company that does not run it.
 */
export const KNOWN_GATEWAY_BOTS = [
  {
    company: "Increase Roas",
    slug: "funnel-builder",
    name: "Funnel Builder",
    note: "Runs on the gateway website-builder policy with the full GHL scope set.",
  },
  {
    company: "Increase Roas",
    slug: "kiwi",
    name: "Kiwi",
    note: "No agent, gateway key id or policy recorded in Paperclip yet.",
  },
  {
    company: "Increase Roas",
    slug: "dr-eggbot",
    name: "dr eggbot",
    note: "No agent, gateway key id or policy recorded in Paperclip yet.",
  },
  {
    company: "Increase Roas",
    slug: "workflow-builder",
    name: "Workflow Builder",
    note: "Builds and maintains workflows and routines; no agent or gateway key recorded yet.",
  },
  {
    company: "Increase Roas",
    slug: "drive-organizer",
    name: "Drive Organizer",
    note: "Keeps the Increase ROAS — Company OS shared drive organized; no agent or gateway key recorded yet.",
  },
  {
    company: "Increase Roas",
    slug: "hermes-specialist",
    name: "Hermes Specialist",
    note: "Hermes profile specialist; no agent or gateway key recorded yet.",
  },
] as const;

export type KnownGatewayBot = (typeof KNOWN_GATEWAY_BOTS)[number];

export type BotKind = "agent" | "gateway";

export interface BotGatewayLink {
  /** Non-secret gateway key identifier, for example `gk_live_ab12`. */
  keyId: string;
  /** Policy name the gateway enforces for that key. */
  policy: string;
  /** Gateway or provider that issued the key. */
  provider: string | null;
}

export interface CompanyBotSummary {
  /** Agent id, or `catalog:<slug>` for a known bot with no agent row. */
  id: string;
  slug: string;
  name: string;
  purpose: string | null;
  kind: BotKind;
  registered: boolean;
  agentId: string | null;
  role: string | null;
  title: string | null;
  status: string;
  adapterType: string | null;
  grokBotTwin: boolean;
  gateway: BotGatewayLink | null;
  note: string | null;
  updatedAt: string | null;
  /** Routines assigned to the bot's agent, including paused and archived ones. */
  routineCount: number;
  /** Latest activity-log entry or heartbeat run, so the roster can show recency. */
  lastActivityAt: string | null;
}

export interface BotRoutineTrigger {
  kind: string;
  cronExpression: string | null;
  timezone: string | null;
  enabled: boolean;
  nextRunAt: string | null;
  lastFiredAt: string | null;
}

export interface BotRoutine {
  id: string;
  title: string;
  status: string;
  triggers: BotRoutineTrigger[];
}

export interface BotActivityEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  createdAt: string;
  /** Where the row came from: the activity log or a heartbeat run. */
  source: "activity" | "run";
}

/**
 * An agent that looks like a bot (Hermes gateway transport) but is not tagged
 * as one, so the roster can point at it instead of hiding it.
 */
export interface SuggestedAgentBot {
  agentId: string;
  name: string;
  status: string;
  adapterType: string;
  reason: string;
}

export interface CompanyBotsResponse {
  bots: CompanyBotSummary[];
  suggestedAgents: SuggestedAgentBot[];
}

export interface CompanyBotDetail extends CompanyBotSummary {
  routines: BotRoutine[];
  recentActivity: BotActivityEntry[];
}

const MAX_NAME = 120;
const MAX_TEXT = 300;
const MAX_ID = 200;

function cleanString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

export function botSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "bot";
}

export function isBotAgentMetadata(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const record = metadata as Record<string, unknown>;
  if (record.grokBotTwin === true) return true;
  return record.agentKind === "bot";
}

/**
 * Reads the non-secret bot block from agent metadata. Any field that is absent
 * or malformed is reported as null instead of being guessed.
 */
export function readBotMetadata(metadata: unknown): {
  purpose: string | null;
  transport: string | null;
  gateway: BotGatewayLink | null;
} {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return { purpose: null, transport: null, gateway: null };
  }
  const record = metadata as Record<string, unknown>;
  const raw = record[BOT_METADATA_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { purpose: null, transport: null, gateway: null };
  }
  const block = raw as Record<string, unknown>;
  const gatewayBlock =
    block.gateway && typeof block.gateway === "object" && !Array.isArray(block.gateway)
      ? (block.gateway as Record<string, unknown>)
      : null;
  const keyId = cleanString(gatewayBlock?.keyId, MAX_ID);
  const policy = cleanString(gatewayBlock?.policy, MAX_ID);
  const gateway: BotGatewayLink | null =
    keyId && policy
      ? { keyId, policy, provider: cleanString(gatewayBlock?.provider, MAX_NAME) }
      : null;
  return {
    purpose: cleanString(block.purpose, MAX_TEXT),
    transport: cleanString(block.transport, MAX_NAME),
    gateway,
  };
}

export function knownGatewayBotsForCompany(companyName: string): KnownGatewayBot[] {
  const needle = companyName.trim().toLowerCase();
  return KNOWN_GATEWAY_BOTS.filter((bot) => bot.company.toLowerCase() === needle);
}

export function findKnownGatewayBot(slugOrName: string): KnownGatewayBot | null {
  const needle = slugOrName.trim().toLowerCase();
  return (
    KNOWN_GATEWAY_BOTS.find(
      (bot) => bot.slug === needle || bot.name.toLowerCase() === needle,
    ) ?? null
  );
}
