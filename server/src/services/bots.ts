import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, companies, heartbeatRuns, routineTriggers, routines } from "@paperclipai/db";
import {
  botSlug,
  findKnownGatewayBot,
  isBotAgentMetadata,
  knownGatewayBotsForCompany,
  KNOWN_GATEWAY_BOTS,
  readBotMetadata,
  type BotActivityEntry,
  type BotRoutine,
  type BotRoutineTrigger,
  type CompanyBotDetail,
  type CompanyBotSummary,
  type SuggestedAgentBot,
} from "@paperclipai/shared";

const RECENT_ACTIVITY_LIMIT = 20;
const RECENT_RUN_LIMIT = 10;
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
  interface BotTotals {
    routineCount: number;
    lastActivityAt: string | null;
  }

  function toSummary(agent: AgentRow, totals: BotTotals | undefined): CompanyBotSummary {
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
      routineCount: totals?.routineCount ?? 0,
      lastActivityAt: totals?.lastActivityAt ?? null,
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
      routineCount: 0,
      lastActivityAt: null,
    };
  }

  async function listBotAgents(companyId: string): Promise<AgentRow[]> {
    const rows = await db.select().from(agents).where(eq(agents.companyId, companyId));
    return rows.filter((agent) => isBotAgentMetadata(agent.metadata));
  }

  /**
   * Routine counts and the latest activity timestamp for every bot agent in
   * one pass, so the roster does not run a query per row.
   */
  async function totalsForAgents(companyId: string, agentIds: string[]): Promise<Map<string, BotTotals>> {
    const totals = new Map<string, BotTotals>();
    if (agentIds.length === 0) return totals;

    const [routineRows, activityRows, runRows] = await Promise.all([
      db
        .select({ agentId: routines.assigneeAgentId, count: sql<number>`count(*)::int` })
        .from(routines)
        .where(and(eq(routines.companyId, companyId), inArray(routines.assigneeAgentId, agentIds)))
        .groupBy(routines.assigneeAgentId),
      db
        .select({ agentId: activityLog.agentId, latestAt: sql<Date | string | null>`max(${activityLog.createdAt})` })
        .from(activityLog)
        .where(and(eq(activityLog.companyId, companyId), inArray(activityLog.agentId, agentIds)))
        .groupBy(activityLog.agentId),
      db
        .select({
          agentId: heartbeatRuns.agentId,
          latestAt: sql<Date | string | null>`max(coalesce(${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}))`,
        })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.agentId, agentIds)))
        .groupBy(heartbeatRuns.agentId),
    ]);

    // `max()` has an unknown result type, so the driver returns a string
    // instead of the Date it returns for a plain timestamp column.
    const toDate = (value: Date | string | null): Date | null => {
      if (value === null) return null;
      const parsed = value instanceof Date ? value : new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    };
    const latest = new Map<string, Date>();
    for (const row of [...activityRows, ...runRows]) {
      if (!row.agentId) continue;
      const value = toDate(row.latestAt);
      if (!value) continue;
      const current = latest.get(row.agentId);
      if (!current || value.getTime() > current.getTime()) latest.set(row.agentId, value);
    }

    for (const agentId of agentIds) {
      totals.set(agentId, {
        routineCount: 0,
        lastActivityAt: latest.get(agentId)?.toISOString() ?? null,
      });
    }
    for (const row of routineRows) {
      if (!row.agentId) continue;
      const entry = totals.get(row.agentId);
      if (entry) entry.routineCount = row.count;
    }
    return totals;
  }

  async function list(companyId: string): Promise<CompanyBotSummary[]> {
    const [company] = await db
      .select({ name: companies.name })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    const agentsForCompany = await listBotAgents(companyId);
    const totals = await totalsForAgents(companyId, agentsForCompany.map((agent) => agent.id));
    const bots = agentsForCompany.map((agent) => toSummary(agent, totals.get(agent.id)));
    const registeredSlugs = new Set(bots.flatMap((bot) => [bot.slug, botSlug(bot.name)]));
    const registeredNames = new Set(bots.map((bot) => bot.name.toLowerCase()));
    for (const known of company ? knownGatewayBotsForCompany(company.name) : []) {
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
    const [activityRows, runRows] = await Promise.all([
      db
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
        .limit(RECENT_ACTIVITY_LIMIT),
      db
        .select({
          id: heartbeatRuns.id,
          status: heartbeatRuns.status,
          startedAt: heartbeatRuns.startedAt,
          createdAt: heartbeatRuns.createdAt,
        })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)))
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(RECENT_RUN_LIMIT),
    ]);
    // Details are deliberately omitted: activity rows can carry arbitrary payloads.
    const entries: BotActivityEntry[] = [
      ...activityRows.map((row) => ({
        id: row.id,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        createdAt: row.createdAt.toISOString(),
        source: "activity" as const,
      })),
      ...runRows.map((row) => ({
        id: row.id,
        action: `run.${row.status}`,
        entityType: "heartbeat_run",
        entityId: row.id,
        createdAt: (row.startedAt ?? row.createdAt).toISOString(),
        source: "run" as const,
      })),
    ];
    return entries
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, RECENT_ACTIVITY_LIMIT);
  }

  /**
   * Agents that behave like bots — a Hermes gateway transport — but are not
   * tagged as one. They are suggestions, never auto-registered.
   */
  async function suggestedAgents(companyId: string): Promise<SuggestedAgentBot[]> {
    const rows = await db.select().from(agents).where(eq(agents.companyId, companyId));
    return rows
      .filter((agent) => !isBotAgentMetadata(agent.metadata) && agent.adapterType === "hermes_gateway")
      .map((agent) => ({
        agentId: agent.id,
        name: agent.name,
        status: agent.status,
        adapterType: agent.adapterType,
        reason: "Hermes gateway agent without grokBotTwin or agentKind bot metadata.",
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
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
    suggestedAgents,
    findKnownGatewayBot,
  };
}

export type BotsService = ReturnType<typeof botsService>;
