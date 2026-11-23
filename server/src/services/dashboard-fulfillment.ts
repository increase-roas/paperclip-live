import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueLabels, issues, labels, projects } from "@paperclipai/db";
import type {
  DashboardFulfillmentBoard,
  DashboardFulfillmentClient,
  DashboardFulfillmentTask,
  DashboardNotConnectedTile,
} from "@paperclipai/shared";
import { executionIssueCondition } from "./issue-visibility.js";
import { retryIdempotentDatabaseOperation } from "../database-retry.js";

const HOUR_MS = 60 * 60 * 1000;
const ITEM_LIMIT = 10;

const ONBOARDING_LABEL = /onboard/i;
const SUPPORT_LABEL = /support|customer.?service|client.?request|^cs$/i;

function taskAgeHours(createdAt: Date, now: Date): number {
  return Math.max(0, Number(((now.getTime() - createdAt.getTime()) / HOUR_MS).toFixed(2)));
}

export function dashboardFulfillmentService(db: Db) {
  return {
    async board(companyId: string, now = new Date()): Promise<DashboardFulfillmentBoard> {
      const companyLabels = await retryIdempotentDatabaseOperation(() =>
        db
          .select({ id: labels.id, name: labels.name })
          .from(labels)
          .where(eq(labels.companyId, companyId))
          .orderBy(labels.name),
      );
      const onboardingLabelIds = companyLabels.filter((label) => ONBOARDING_LABEL.test(label.name)).map((label) => label.id);
      const supportLabels = companyLabels.filter((label) => SUPPORT_LABEL.test(label.name));

      const openIssueRows = await retryIdempotentDatabaseOperation(() =>
        db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            status: issues.status,
            projectId: issues.projectId,
            projectName: projects.name,
            createdAt: issues.createdAt,
          })
          .from(issues)
          .leftJoin(projects, eq(issues.projectId, projects.id))
          .where(
            and(
              eq(issues.companyId, companyId),
              notInArray(issues.status, ["done", "cancelled"]),
              executionIssueCondition(),
            ),
          )
          .orderBy(sql`${issues.createdAt} asc`),
      );

      const issueIds = openIssueRows.map((row) => row.id);
      const labelRows = issueIds.length > 0
        ? await retryIdempotentDatabaseOperation(() =>
          db
            .select({
              issueId: issueLabels.issueId,
              labelId: issueLabels.labelId,
            })
            .from(issueLabels)
            .where(and(eq(issueLabels.companyId, companyId), inArray(issueLabels.issueId, issueIds))),
        )
        : [];
      const labelsByIssue = new Map<string, string[]>();
      for (const row of labelRows) {
        const existing = labelsByIssue.get(row.issueId) ?? [];
        existing.push(row.labelId);
        labelsByIssue.set(row.issueId, existing);
      }
      const onboardingLabelIdSet = new Set(onboardingLabelIds);
      const supportLabelIdSet = new Set(supportLabels.map((label) => label.id));

      const toTask = (row: typeof openIssueRows[number], ageHours: number): DashboardFulfillmentTask => ({
        id: row.id,
        identifier: row.identifier,
        title: row.title,
        clientName: row.projectName,
        status: row.status,
        ageHours,
      });

      const clients: DashboardFulfillmentClient[] = [];
      let unassigned = 0;
      const clientById = new Map<string, { name: string; open: number; blocked: number; oldest: number }>();
      for (const row of openIssueRows) {
        if (!row.projectId) {
          unassigned += 1;
          continue;
        }
        // Key by project id: project names are not unique, and per-client
        // totals must never merge two clients that share a name.
        const existing = clientById.get(row.projectId) ?? {
          name: row.projectName ?? row.projectId,
          open: 0,
          blocked: 0,
          oldest: 0,
        };
        existing.open += 1;
        if (row.status === "blocked") existing.blocked += 1;
        existing.oldest = Math.max(existing.oldest, taskAgeHours(row.createdAt, now));
        clientById.set(row.projectId, existing);
      }
      for (const [clientKey, counts] of clientById) {
        clients.push({
          clientKey,
          clientName: counts.name,
          openTasks: counts.open,
          blockedTasks: counts.blocked,
          oldestOpenAgeHours: counts.oldest,
        });
      }
      clients.sort((left, right) => right.openTasks - left.openTasks);

      const onboardingTasks = openIssueRows
        .filter((row) => {
          const issueLabelIds = labelsByIssue.get(row.id) ?? [];
          return (
            issueLabelIds.some((labelId) => onboardingLabelIdSet.has(labelId)) ||
            ONBOARDING_LABEL.test(row.projectName ?? "")
          );
        })
        .map((row) => toTask(row, taskAgeHours(row.createdAt, now)));

      const onboardingOverdue: DashboardNotConnectedTile = {
        tile: "onboarding-overdue",
        source: "Client onboarding due dates",
        reason:
          "Paperclip tasks have no due-date field, so no onboarding step can be called overdue without inventing a threshold.",
        needed:
          "Add due dates to onboarding tasks, or connect the client onboarding checklist (for example the GHL/Asana onboarding board) to Paperclip.",
      };

      const supportTasks = supportLabelIdSet.size > 0
        ? openIssueRows
          .filter((row) => (labelsByIssue.get(row.id) ?? []).some((labelId) => supportLabelIdSet.has(labelId)))
          .map((row) => toTask(row, taskAgeHours(row.createdAt, now)))
        : [];

      const supportUnavailable: DashboardNotConnectedTile | null = supportLabelIdSet.size > 0
        ? null
        : {
          tile: "support-requests",
          source: "Support request queue",
          reason:
            "No Paperclip label matches support, customer service, client request or CS, so there is no queue to count.",
          needed:
            "Label support work with a support/customer-service label, or connect the GHL conversations inbox read-only.",
        };

      const notConnected: DashboardNotConnectedTile[] = [onboardingOverdue];
      if (supportUnavailable) notConnected.push(supportUnavailable);
      notConnected.push({
        tile: "ghl-conversations",
        source: "GHL conversations",
        reason: "GHL is not connected to this Paperclip instance and the repo has no read-only GHL conversation source.",
        needed: "A read-only GHL conversations connection (API key or MCP) available to the server.",
      });

      return {
        companyId,
        generatedAt: now.toISOString(),
        clients: clients.slice(0, ITEM_LIMIT),
        openClientTasks: {
          total: openIssueRows.length - unassigned,
          unassigned,
        },
        onboarding: {
          openSteps: onboardingTasks.length,
          items: onboardingTasks.slice(0, ITEM_LIMIT),
          overdue: onboardingOverdue,
        },
        support: {
          waiting: supportTasks.length,
          oldestAgeHours: supportTasks[0]?.ageHours ?? null,
          items: supportTasks.slice(0, ITEM_LIMIT),
          matchedLabels: supportLabels.map((label) => label.name),
          unavailable: supportUnavailable,
        },
        notConnected,
      };
    },
  };
}
