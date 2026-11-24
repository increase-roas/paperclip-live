import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies, costEvents, issues, routines } from "@paperclipai/db";
import type {
  DashboardAiCostBoard,
  DashboardAiCostDriver,
  DashboardAiCostSeat,
  DashboardAiCostWorkflowSeat,
  DashboardNotConnectedTile,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { getUtcMonthStart } from "./dashboard.js";
import { executionIssueCondition } from "./issue-visibility.js";
import { retryIdempotentDatabaseOperation } from "../database-retry.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DRIVER_LIMIT = 5;

export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Whole percent, rounded to two decimals; null when the cap is zero. */
export function utilizationPercent(spendCents: number, capCents: number): number | null {
  if (capCents <= 0) return null;
  return Number(((spendCents / capCents) * 100).toFixed(2));
}

/** Month-to-date spend extrapolated across the calendar month. */
export function forecastMonthEndCents(spendMonthToDateCents: number, now: Date): number {
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const elapsedDays = now.getUTCDate();
  if (elapsedDays <= 0) return Math.round(spendMonthToDateCents);
  return Math.round((spendMonthToDateCents / elapsedDays) * daysInMonth);
}

export function costPerCompletedTaskCents(spendCents: number, completedTasks: number): number | null {
  if (completedTasks <= 0) return null;
  return Math.round(spendCents / completedTasks);
}

export function dashboardAiCostService(db: Db) {
  return {
    async board(companyId: string, now = new Date()): Promise<DashboardAiCostBoard> {
      const company = await retryIdempotentDatabaseOperation(() =>
        db.select().from(companies).where(eq(companies.id, companyId)).then((rows) => rows[0] ?? null),
      );
      if (!company) throw notFound("Company not found");

      const monthStart = getUtcMonthStart(now);
      const todayStart = utcDayStart(now);
      const sevenDaysAgo = new Date(now.getTime() - 7 * DAY_MS);
      const windowStart = new Date(Math.min(monthStart.getTime(), sevenDaysAgo.getTime()));

      const spendCondition = and(
        eq(costEvents.companyId, companyId),
        gte(costEvents.occurredAt, windowStart),
        lte(costEvents.occurredAt, now),
      );

      // One scan for the three windows. Conditional sums keep "today" and "7d"
      // honest even when the month began less than seven days ago.
      const seatSpendRows = await retryIdempotentDatabaseOperation(() =>
        db
          .select({
            agentId: costEvents.agentId,
            todayCents: sql<number>`coalesce(sum(case when ${costEvents.occurredAt} >= ${todayStart.toISOString()}::timestamptz then ${costEvents.costCents} else 0 end), 0)::double precision`,
            sevenDayCents: sql<number>`coalesce(sum(case when ${costEvents.occurredAt} >= ${sevenDaysAgo.toISOString()}::timestamptz then ${costEvents.costCents} else 0 end), 0)::double precision`,
            monthCents: sql<number>`coalesce(sum(case when ${costEvents.occurredAt} >= ${monthStart.toISOString()}::timestamptz then ${costEvents.costCents} else 0 end), 0)::double precision`,
          })
          .from(costEvents)
          .where(spendCondition)
          .groupBy(costEvents.agentId),
      );

      const spendByAgent = new Map<
        string,
        { todayCents: number; sevenDayCents: number; monthCents: number }
      >();
      let companyTodayCents = 0;
      let companySevenDayCents = 0;
      let companyMonthCents = 0;
      for (const row of seatSpendRows) {
        const todayCents = Number(row.todayCents);
        const sevenDayCents = Number(row.sevenDayCents);
        const monthCents = Number(row.monthCents);
        companyTodayCents += todayCents;
        companySevenDayCents += sevenDayCents;
        companyMonthCents += monthCents;
        if (row.agentId) {
          spendByAgent.set(row.agentId, { todayCents, sevenDayCents, monthCents });
        }
      }

      const completedRows = await retryIdempotentDatabaseOperation(() =>
        db
          .select({
            agentId: issues.assigneeAgentId,
            completed: sql<number>`count(*)::int`,
          })
          .from(issues)
          .where(
            and(
              eq(issues.companyId, companyId),
              eq(issues.status, "done"),
              gte(issues.completedAt, monthStart),
              lte(issues.completedAt, now),
              executionIssueCondition(),
            ),
          )
          .groupBy(issues.assigneeAgentId),
      );

      const completedByAgent = new Map<string, number>();
      let companyCompletedTasks = 0;
      for (const row of completedRows) {
        const completed = Number(row.completed);
        companyCompletedTasks += completed;
        if (row.agentId) completedByAgent.set(row.agentId, completed);
      }

      // Cost per finished task uses spend that is actually attributable to the
      // closed task, not company-wide overhead. A task with no cost events
      // contributes zero, which keeps the ratio honest.
      const attributableRows = await retryIdempotentDatabaseOperation(() =>
        db
          .select({
            agentId: issues.assigneeAgentId,
            cents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
          })
          .from(costEvents)
          .innerJoin(issues, eq(costEvents.issueId, issues.id))
          .where(
            and(
              eq(costEvents.companyId, companyId),
              eq(issues.status, "done"),
              gte(issues.completedAt, monthStart),
              lte(issues.completedAt, now),
              gte(costEvents.occurredAt, monthStart),
              lte(costEvents.occurredAt, now),
              executionIssueCondition(),
            ),
          )
          .groupBy(issues.assigneeAgentId),
      );

      const attributableByAgent = new Map<string, number>();
      let companyAttributableCents = 0;
      for (const row of attributableRows) {
        const cents = Number(row.cents);
        companyAttributableCents += cents;
        if (row.agentId) attributableByAgent.set(row.agentId, cents);
      }

      const driverRows = await retryIdempotentDatabaseOperation(() =>
        db
          .select({
            provider: costEvents.provider,
            model: costEvents.model,
            cents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
          })
          .from(costEvents)
          .where(
            and(
              eq(costEvents.companyId, companyId),
              gte(costEvents.occurredAt, monthStart),
              lte(costEvents.occurredAt, now),
            ),
          )
          .groupBy(costEvents.provider, costEvents.model)
          .orderBy(sql`coalesce(sum(${costEvents.costCents}), 0) desc`)
          .limit(DRIVER_LIMIT),
      );

      const agentRows = await retryIdempotentDatabaseOperation(() =>
        db
          .select({
            id: agents.id,
            name: agents.name,
            status: agents.status,
            budgetMonthlyCents: agents.budgetMonthlyCents,
          })
          .from(agents)
          .where(eq(agents.companyId, companyId))
          .orderBy(agents.name),
      );

      // The v2 workflow number needs two counts. The automated count is real:
      // active routines owned by the seat. Paperclip has no record of the full
      // task list a seat performs, so the denominator stays null.
      const routineRows = await retryIdempotentDatabaseOperation(() =>
        db
          .select({
            agentId: routines.assigneeAgentId,
            automated: sql<number>`count(*)::int`,
          })
          .from(routines)
          .where(and(eq(routines.companyId, companyId), eq(routines.status, "active")))
          .groupBy(routines.assigneeAgentId),
      );
      const automatedByAgent = new Map<string, number>();
      for (const row of routineRows) {
        if (row.agentId) automatedByAgent.set(row.agentId, Number(row.automated));
      }

      const workflowSeats: DashboardAiCostWorkflowSeat[] = agentRows.map((agent) => ({
        agentId: agent.id,
        name: agent.name,
        automatedTasks: automatedByAgent.get(agent.id) ?? 0,
        listedTasks: null,
        automatedPercent: null,
      }));
      const totalAutomated = workflowSeats.reduce((sum, seat) => sum + seat.automatedTasks, 0);

      const outputUnitNotConnected: DashboardNotConnectedTile = {
        tile: "client-output",
        source: "Client output count (reports, audits, creative sets)",
        reason:
          "Paperclip stores artifacts and documents per task, but it has no field that marks one as a client-facing report, audit or creative set. Counting every work product would answer a different question than the spec asks.",
        needed:
          "A deliverable type on work products (report / audit / creative set), or a read-only connection to the production tracker that records them.",
      };

      const workflowNotConnected: DashboardNotConnectedTile = {
        tile: "seat-task-inventory",
        source: "Seat task inventory (4-6 hand-and-eye tasks per seat)",
        reason:
          "Paperclip records which tasks run as active routines, so the automated count is real. It has no record of the full list of tasks each seat performs, so the denominator would be a guess.",
        needed: "Record each seat's 4-6 tasks and mark each one automated or manual.",
      };

      const seats: DashboardAiCostSeat[] = agentRows.map((agent) => {
        const spend = spendByAgent.get(agent.id) ?? { todayCents: 0, sevenDayCents: 0, monthCents: 0 };
        const completedTasksMonth = completedByAgent.get(agent.id) ?? 0;
        const attributableCents = attributableByAgent.get(agent.id) ?? 0;
        const utilization = utilizationPercent(spend.monthCents, agent.budgetMonthlyCents);
        return {
          agentId: agent.id,
          name: agent.name,
          status: agent.status,
          budgetMonthlyCents: agent.budgetMonthlyCents,
          spendTodayCents: spend.todayCents,
          spend7dCents: spend.sevenDayCents,
          spendMonthToDateCents: spend.monthCents,
          utilizationPercent: utilization,
          overEightyPercent: utilization !== null && utilization >= 80,
          completedTasksMonth,
          costPerCompletedTaskCents: costPerCompletedTaskCents(attributableCents, completedTasksMonth),
        };
      });

      const topCostDrivers: DashboardAiCostDriver[] = driverRows.map((row) => {
        const cents = Number(row.cents);
        return {
          provider: row.provider,
          model: row.model,
          spendMonthToDateCents: cents,
          sharePercent: companyMonthCents > 0 ? Number(((cents / companyMonthCents) * 100).toFixed(2)) : 0,
        };
      });

      const monthProgressPercent = Number(
        ((now.getUTCDate() / new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate()) * 100).toFixed(2),
      );

      return {
        companyId,
        generatedAt: now.toISOString(),
        monthStart: monthStart.toISOString(),
        company: {
          budgetMonthlyCents: company.budgetMonthlyCents,
          spendTodayCents: companyTodayCents,
          spend7dCents: companySevenDayCents,
          spendMonthToDateCents: companyMonthCents,
          utilizationPercent: utilizationPercent(companyMonthCents, company.budgetMonthlyCents),
          forecastMonthEndCents: forecastMonthEndCents(companyMonthCents, now),
          monthProgressPercent,
        },
        seats,
        seatsOverEightyPercent: seats.filter((seat) => seat.overEightyPercent).length,
        seatsWithoutCap: seats.filter((seat) => seat.budgetMonthlyCents <= 0).length,
        completedTasksMonth: companyCompletedTasks,
        costPerCompletedTaskCents: costPerCompletedTaskCents(companyAttributableCents, companyCompletedTasks),
        topCostDrivers,
        outputUnit: {
          spendMonthToDateCents: companyMonthCents,
          outputUnitsMonth: null,
          costPerOutputUnitCents: null,
          target: "Must fall as volume rises",
          cite: "9q5oj [11:05]",
          notConnected: outputUnitNotConnected,
        },
        workflowCoverage: {
          seats: workflowSeats,
          totalAutomated,
          listedTasksTotal: null,
          automatedPercent: null,
          target: "Every task should be a workflow, not a headcount",
          cite: "9q5oj [04:42]",
          notConnected: workflowNotConnected,
        },
        notConnected: [outputUnitNotConnected, workflowNotConnected],
      };
    },
  };
}
