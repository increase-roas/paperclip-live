import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, routineTriggers, routines } from "@paperclipai/db";
import {
  botSlug,
  findKnownGatewayBot,
  isBotAgentMetadata,
  KNOWN_GATEWAY_BOTS,
  readBotMetadata,
  type BotActivityEntry,
  type BotRoutine,
  type BotRoutineTrigger,
  type CompanyBotDetail,
  type CompanyBotSummary,
} from "@paperclipai/shared";

const RECENT_ACTIVITY_LIMIT = 20;
const CATALOG_PREFIX = "catalog:";

type AgentRow = typeof agents.$inferSelect;

/**
 * Read-only view of the bots a company runs.
 *
 * Bots are agents tagged through metadata (`grokBotTwin` or `agentKind: "bot"`),
 * plus the known gateway-only bots that have no agent row yet. Gateway key ids
 * and policies come from metadata; secret values are never read.
 */
export function botsService(db: Db) {
  function toSummary(agent: AgentRow): CompanyBotSummary {
    const bot = readBotMetadata(agent.metadata);
    return {
      id: agent.id,
      slug: botSlug(agent.name),
      name: agent.name,
      purpose: bot.purpose,
      kind: "agent",
      registered: true,
      agentId: agent.id,
      role: agent.role,
      title: agent.title,
      status: agent.status,
      adapterType: agent.adapterType,
      grokBotTwin: isBotAgentMetadata(agent.metadata) && agent.metadata?.grokBotTwin === true,
      gateway: bot.gateway,
      note: null,
      updatedAt: agent.updatedAt ? agent.updatedAt.toISOString() : null,
    };
  }

  function catalogSummary(known: (typeof KNOWN_GATEWAY_BOTS)[number]): CompanyBotSummary {
    return {
      id: `${CATALOG_PREFIX}${known.slug}`,
      slug: known.slug,
      name: known.name,
      purpose: null,
      kind: "gateway",
      registered: false,
      agentId: null,
      role: null,
      title: null,
      status: "unregistered",
      adapterType: null,
      grokBotTwin: false,
      gateway: null,
      note: known.note,
      updatedAt: null,
    };
  }

  async function listBotAgents(companyId: string): Promise<AgentRow[]> {
    const rows = await db.select().from(agents).where(eq(agents.companyId, companyId));
    return rows.filter((agent) => isBotAgentMetadata(agent.metadata));
  }

  async function list(companyId: string): Promise<CompanyBotSummary[]> {
    const agentsForCompany = await listBotAgents(companyId);
    const bots = agentsForCompany.map(toSummary);
    const registeredSlugs = new Set(bots.flatMap((bot) => [bot.slug, botSlug(bot.name)]));
    const registeredNames = new Set(bots.map((bot) => bot.name.toLowerCase()));
    for (const known of KNOWN_GATEWAY_BOTS) {
      if (registeredSlugs.has(known.slug) || registeredNames.has(known.name.toLowerCase())) continue;
      bots.push(catalogSummary(known));
    }
    return bots.sort((a, b) => a.name.localeCompare(b.name));
  }

  async function routinesForAgent(companyId: string, agentId: string): Promise<BotRoutine[]> {
    const rows = await db
      .select({
        id: routines.id,
        title: routines.title,
        status: routines.status,
      })
      .from(routines)
      .where(and(eq(routines.companyId, companyId), eq(routines.assigneeAgentId, agentId)));
    if (rows.length === 0) return [];
    const triggers = await db
      .select({
        routineId: routineTriggers.routineId,
        kind: routineTriggers.kind,
        cronExpression: routineTriggers.cronExpression,
        timezone: routineTriggers.timezone,
        enabled: routineTriggers.enabled,
        nextRunAt: routineTriggers.nextRunAt,
        lastFiredAt: routineTriggers.lastFiredAt,
        archived: routineTriggers.archived,
      })
      .from(routineTriggers)
      .where(
        and(
          eq(routineTriggers.companyId, companyId),
          inArray(
            routineTriggers.routineId,
            rows.map((row) => row.id),
          ),
        ),
      );
    const byRoutine = new Map<string, BotRoutineTrigger[]>();
    for (const trigger of triggers) {
      if (trigger.archived) continue;
      const list = byRoutine.get(trigger.routineId) ?? [];
      list.push({
        kind: trigger.kind,
        cronExpression: trigger.cronExpression,
        timezone: trigger.timezone,
        enabled: trigger.enabled,
        nextRunAt: trigger.nextRunAt ? trigger.nextRunAt.toISOString() : null,
        lastFiredAt: trigger.lastFiredAt ? trigger.lastFiredAt.toISOString() : null,
      });
      byRoutine.set(trigger.routineId, list);
    }
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      triggers: byRoutine.get(row.id) ?? [],
    }));
  }

  async function recentActivity(companyId: string, agentId: string): Promise<BotActivityEntry[]> {
    const rows = await db
      .select({
        id: activityLog.id,
        action: activityLog.action,
        entityType: activityLog.entityType,
        entityId: activityLog.entityId,
        createdAt: activityLog.createdAt,
      })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.agentId, agentId)))
      .orderBy(desc(activityLog.createdAt))
      .limit(RECENT_ACTIVITY_LIMIT);
    // Details are deliberately omitted: activity rows can carry arbitrary payloads.
    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async function get(companyId: string, botIdOrSlug: string): Promise<CompanyBotDetail | null> {
    const all = await list(companyId);
    const target = all.find((bot) => bot.id === botIdOrSlug || bot.slug === botIdOrSlug);
    if (!target) return null;
    if (!target.agentId) {
      return { ...target, routines: [], recentActivity: [] };
    }
    const [routineRows, activityRows] = await Promise.all([
      routinesForAgent(companyId, target.agentId),
      recentActivity(companyId, target.agentId),
    ]);
    return { ...target, routines: routineRows, recentActivity: activityRows };
  }

  return {
    list,
    get,
    findKnownGatewayBot,
  };
}

export type BotsService = ReturnType<typeof botsService>;
