import { and, asc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, heartbeatRuns, issues, projects, routineRuns, routines } from "@paperclipai/db";
import type {
  DashboardAutomationApproval,
  DashboardAutomationBlockedTask,
  DashboardAutomationHealthBoard,
  DashboardAutomationRoutine,
  DashboardAutomationSeat,
} from "@paperclipai/shared";
import { serverVersion } from "../version.js";
import { getServerInfoSnapshot } from "../server-info.js";
import {
  inspectDatabaseBackupHealth,
  type InspectDatabaseBackupHealthOptions,
} from "./database-backup-health.js";
import { executionIssueCondition } from "./issue-visibility.js";
import { retryIdempotentDatabaseOperation } from "../database-retry.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const BLOCKED_ALERT_HOURS = 24;
const ITEM_LIMIT = 10;

export function ageHours(from: Date | null | undefined, now: Date): number | null {
  if (!from) return null;
  return Math.max(0, Number(((now.getTime() - from.getTime()) / HOUR_MS).toFixed(2)));
}

export function percentage(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Number(((part / whole) * 100).toFixed(2));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBooleanLike(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return null;
}

function parseNumberLike(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Same reader as the instance scheduler heartbeat list: an absent heartbeat
 * block means off, and a zero interval means there is no schedule.
 */
export function readSchedulerHeartbeatPolicy(runtimeConfig: unknown): { enabled: boolean; intervalSec: number } {
  const heartbeat = isRecord(runtimeConfig) && isRecord(runtimeConfig.heartbeat) ? runtimeConfig.heartbeat : {};
  return {
    enabled: parseBooleanLike(heartbeat.enabled) ?? false,
    intervalSec: Math.max(0, parseNumberLike(heartbeat.intervalSec) ?? 0),
  };
}

type LastRunRow = {
  agent_id: string;
  status: string;
  created_at: Date | string;
  error: string | null;
};

type LastRoutineRunRow = {
  routine_id: string;
  status: string;
  created_at: Date | string;
  failure_reason: string | null;
};

export function dashboardAutomationHealthService(
  db: Db,
  options: { databaseBackupHealth?: InspectDatabaseBackupHealthOptions } = {},
) {
  return {
    async board(companyId: string, now = new Date()): Promise<DashboardAutomationHealthBoard> {
      const twentyFourHoursAgo = new Date(now.getTime() - DAY_MS);
      const sevenDaysAgo = new Date(now.getTime() - 7 * DAY_MS);

      const agentRows = await retryIdempotentDatabaseOperation(() =>
        db
          .select({
            id: agents.id,
            name: agents.name,
            status: agents.status,
            errorReason: agents.errorReason,
            runtimeConfig: agents.runtimeConfig,
            lastHeartbeatAt: agents.lastHeartbeatAt,
          })
          .from(agents)
          .where(eq(agents.companyId, companyId))
          .orderBy(agents.name),
      );

      const lastRunRows = (await retryIdempotentDatabaseOperation(() =>
        db.execute(sql`
          SELECT DISTINCT ON (agent_id)
            agent_id, status, created_at,
            coalesce(error, error_code) AS error
          FROM ${heartbeatRuns}
          WHERE company_id = ${companyId}
          ORDER BY agent_id, created_at DESC
        `),
      )) as unknown as LastRunRow[];

      const lastRunByAgent = new Map<string, { status: string; createdAt: Date; error: string | null }>();
      for (const row of lastRunRows) {
        const createdAt = row.created_at instanceof Date ? row.created_at : new Date(row.created_at);
        if (Number.isNaN(createdAt.getTime())) continue;
        lastRunByAgent.set(row.agent_id, {
          status: row.status,
          createdAt,
          error: row.error,
        });
      }

      const runCountRows = await retryIdempotentDatabaseOperation(() =>
        db
          .select({
            agentId: heartbeatRuns.agentId,
            failed: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'failed')::int`,
            timedOut: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'timed_out')::int`,
          })
          .from(heartbeatRuns)
          .where(and(eq(heartbeatRuns.companyId, companyId), gte(heartbeatRuns.createdAt, twentyFourHoursAgo)))
          .groupBy(heartbeatRuns.agentId),
      );

      const runCountsByAgent = new Map<string, { failed: number; timedOut: number }>();
      for (const row of runCountRows) {
        runCountsByAgent.set(row.agentId, {
          failed: Number(row.failed),
          timedOut: Number(row.timedOut),
        });
      }

      const seats: DashboardAutomationSeat[] = agentRows.map((agent) => {
        const policy = readSchedulerHeartbeatPolicy(agent.runtimeConfig);
        const lastRun = lastRunByAgent.get(agent.id) ?? null;
        const counts = runCountsByAgent.get(agent.id) ?? { failed: 0, timedOut: 0 };
        return {
          agentId: agent.id,
          name: agent.name,
          status: agent.status,
          errorReason: agent.errorReason,
          heartbeatEnabled: policy.enabled,
          heartbeatIntervalSec: policy.intervalSec,
          lastHeartbeatAt: agent.lastHeartbeatAt?.toISOString() ?? null,
          lastRunAt: lastRun?.createdAt.toISOString() ?? null,
          lastRunStatus: lastRun?.status ?? null,
          lastRunError: lastRun?.error ?? null,
          failedRuns24h: counts.failed,
          timedOutRuns24h: counts.timedOut,
        };
      });

      const routineRows = await retryIdempotentDatabaseOperation(() =>
        db
          .select({
            id: routines.id,
            title: routines.title,
            status: routines.status,
            assigneeAgentId: routines.assigneeAgentId,
            assigneeName: agents.name,
          })
          .from(routines)
          .leftJoin(agents, eq(routines.assigneeAgentId, agents.id))
          .where(eq(routines.companyId, companyId))
          .orderBy(routines.title),
      );

      const lastRoutineRunRows = (await retryIdempotentDatabaseOperation(() =>
        db.execute(sql`
          SELECT DISTINCT ON (routine_id)
            routine_id, status, created_at, failure_reason
          FROM ${routineRuns}
          WHERE company_id = ${companyId}
          ORDER BY routine_id, created_at DESC
        `),
      )) as unknown as LastRoutineRunRow[];

      const lastRoutineRun = new Map<string, { status: string; createdAt: Date; failureReason: string | null }>();
      for (const row of lastRoutineRunRows) {
        const createdAt = row.created_at instanceof Date ? row.created_at : new Date(row.created_at);
        if (Number.isNaN(createdAt.getTime())) continue;
        lastRoutineRun.set(row.routine_id, {
          status: row.status,
          createdAt,
          failureReason: row.failure_reason,
        });
      }

      const routineRunCountRows = await retryIdempotentDatabaseOperation(() =>
        db
          .select({
            routineId: routineRuns.routineId,
            total: sql<number>`count(*)::int`,
            completed: sql<number>`count(*) filter (where ${routineRuns.status} = 'completed')::int`,
            failed: sql<number>`count(*) filter (where ${routineRuns.status} = 'failed')::int`,
          })
          .from(routineRuns)
          .where(and(eq(routineRuns.companyId, companyId), gte(routineRuns.createdAt, sevenDaysAgo)))
          .groupBy(routineRuns.routineId),
      );

      const routineCounts = new Map<string, { total: number; completed: number; failed: number }>();
      for (const row of routineRunCountRows) {
        routineCounts.set(row.routineId, {
          total: Number(row.total),
          completed: Number(row.completed),
          failed: Number(row.failed),
        });
      }

      const routineItems: DashboardAutomationRoutine[] = routineRows.map((routine) => {
        const counts = routineCounts.get(routine.id) ?? { total: 0, completed: 0, failed: 0 };
        const lastRun = lastRoutineRun.get(routine.id) ?? null;
        return {
          routineId: routine.id,
          title: routine.title,
          status: routine.status,
          assigneeAgentId: routine.assigneeAgentId,
          assigneeName: routine.assigneeName,
          lastRunAt: lastRun?.createdAt.toISOString() ?? null,
          lastRunStatus: lastRun?.status ?? null,
          lastRunResult: lastRun?.failureReason ?? lastRun?.status ?? null,
          runs7d: counts.total,
          completed7d: counts.completed,
          failed7d: counts.failed,
          successRate7d: percentage(counts.completed, counts.total),
        };
      });

      const allRoutineRuns7d = routineItems.reduce((sum, routine) => sum + routine.runs7d, 0);
      const allRoutineCompleted7d = routineItems.reduce((sum, routine) => sum + routine.completed7d, 0);
      const allRoutineFailed7d = routineItems.reduce((sum, routine) => sum + routine.failed7d, 0);

      const blockedRows = await retryIdempotentDatabaseOperation(() =>
        db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            projectName: projects.name,
            blockedAt: issues.blockedTransitionAt,
            updatedAt: issues.updatedAt,
          })
          .from(issues)
          .leftJoin(projects, eq(issues.projectId, projects.id))
          .where(and(eq(issues.companyId, companyId), eq(issues.status, "blocked"), executionIssueCondition()))
          .orderBy(asc(issues.blockedTransitionAt)),
      );

      const blockedTasks: DashboardAutomationBlockedTask[] = blockedRows
        .map((row) => {
          const since = row.blockedAt ?? row.updatedAt;
          return {
            id: row.id,
            identifier: row.identifier,
            title: row.title,
            projectName: row.projectName,
            blockedAt: row.blockedAt?.toISOString() ?? null,
            ageHours: ageHours(since, now) ?? 0,
          };
        })
        .filter((task) => task.ageHours > BLOCKED_ALERT_HOURS)
        .sort((left, right) => right.ageHours - left.ageHours);

      const pendingApprovalRows = await retryIdempotentDatabaseOperation(() =>
        db
          .select({
            id: approvals.id,
            type: approvals.type,
            createdAt: approvals.createdAt,
          })
          .from(approvals)
          .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")))
          .orderBy(asc(approvals.createdAt)),
      );

      const approvalItems: DashboardAutomationApproval[] = pendingApprovalRows
        .slice(0, ITEM_LIMIT)
        .map((row) => ({
          id: row.id,
          type: row.type,
          createdAt: row.createdAt.toISOString(),
          ageHours: ageHours(row.createdAt, now) ?? 0,
        }));

      let databaseProbe: "ok" | "failed" = "ok";
      try {
        await retryIdempotentDatabaseOperation(() => db.execute(sql`select 1`));
      } catch {
        databaseProbe = "failed";
      }

      const serverInfo = getServerInfoSnapshot();
      const backup = options.databaseBackupHealth
        ? inspectDatabaseBackupHealth({ ...options.databaseBackupHealth, now })
        : null;

      return {
        companyId,
        generatedAt: now.toISOString(),
        seats,
        seatSummary: {
          total: seats.length,
          running: seats.filter((seat) => seat.status === "running").length,
          idle: seats.filter((seat) => seat.status === "idle").length,
          error: seats.filter((seat) => seat.status === "error").length,
          paused: seats.filter((seat) => seat.status === "paused").length,
        },
        routines: {
          total: routineItems.length,
          active: routineItems.filter((routine) => routine.status === "active").length,
          runs7d: allRoutineRuns7d,
          completed7d: allRoutineCompleted7d,
          failed7d: allRoutineFailed7d,
          successRate7d: percentage(allRoutineCompleted7d, allRoutineRuns7d),
          items: routineItems,
        },
        blockedTasks: {
          count: blockedTasks.length,
          oldestAgeHours: blockedTasks[0]?.ageHours ?? null,
          items: blockedTasks.slice(0, ITEM_LIMIT),
        },
        approvals: {
          pendingCount: pendingApprovalRows.length,
          oldestAgeHours: approvalItems[0]?.ageHours ?? null,
          items: approvalItems,
        },
        server: {
          status: databaseProbe === "ok" ? "ok" : "degraded",
          version: serverVersion,
          commit: serverInfo.git.available ? serverInfo.git.fullSha : null,
          databaseProbe,
          backup: backup
            ? {
              enabled: backup.enabled,
              status: backup.status,
              latestBackupAt: backup.latestBackup?.mtime ?? null,
              ageHours: backup.latestBackup?.ageHours ?? null,
              maxAgeHours: backup.maxAgeHours,
              warnings: backup.warnings.map((warning) => warning.message),
            }
            : null,
        },
        notConnected: [],
      };
    },
  };
}
