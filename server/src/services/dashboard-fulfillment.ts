import { closeRate, costPerLead, ctrPercent, showRate } from "@paperclipai/shared/ir-metrics";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueLabels, issues, labels, projects } from "@paperclipai/db";
import type {
  DashboardFulfillmentBoard,
  DashboardFulfillmentClient,
  DashboardFulfillmentClientDelivery,
  DashboardFulfillmentClientDeliveryRow,
  DashboardFulfillmentRetention,
  DashboardFulfillmentTask,
  DashboardFulfillmentWavvDelivery,
  DashboardNotConnectedTile,
  DashboardPeriod,
} from "@paperclipai/shared";
import { executionIssueCondition } from "./issue-visibility.js";
import { retryIdempotentDatabaseOperation } from "../database-retry.js";
import {
  filterClientOnlyPortfolio,
  readPortfolioSnapshotBundle,
  type MergedClientMetrics,
  type PortfolioSnapshotBundle,
} from "../ir/sales-dashboard-client.js";
import { readWavvSummary, type WavvSummary } from "../ir/wavv-client.js";

const HOUR_MS = 60 * 60 * 1000;
const ITEM_LIMIT = 10;

const ONBOARDING_LABEL = /onboard/i;
const SUPPORT_LABEL = /support|customer.?service|client.?request|^cs$/i;

export interface DashboardFulfillmentDeps {
  fetchImpl?: typeof fetch;
  portfolioReader?: (period: DashboardPeriod) => Promise<PortfolioSnapshotBundle>;
  wavvReader?: (period: DashboardPeriod) => Promise<WavvSummary | null>;
}


function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function taskAgeHours(createdAt: Date, now: Date): number {
  return Math.max(0, Number(((now.getTime() - createdAt.getTime()) / HOUR_MS).toFixed(2)));
}

/**
 * Hormozi's four retention questions from spec v2 §6. Each one needs client
 * subscription, cancellation or review data. Paperclip's own tables do not
 * carry any of it and GHL / Authorize.net are not connected, so every value
 * stays null and the tile names the missing source. Never replace these with
 * a proxy such as project counts.
 */
function retentionWithoutSources(): DashboardFulfillmentRetention {
  return {
    churnMonthly: {
      value: null,
      unit: "percent",
      target: "< 3% per month",
      cite: "U_s0ek [00:15:51]",
      notConnected: {
        tile: "churn-monthly",
        source: "GHL subscription state + Authorize.net",
        reason:
          "Paperclip has no client subscription state, and neither GHL nor Authorize.net is connected, so it cannot see clients lost or clients at the start of the month.",
        needed: "A read-only GHL subscription connection plus Authorize.net payments.",
      },
    },
    saleToOnboarding: {
      value: null,
      unit: "days",
      target: "Short; first live date minus close date",
      cite: "KhFlD [00:19:32]",
      notConnected: {
        tile: "sale-to-onboarding",
        source: "GHL close date + Paperclip first live date",
        reason:
          "Paperclip projects have neither a close date nor a first-live date, and GHL is not connected, so there is no pair of dates to subtract.",
        needed: "A close date from GHL and a first-live date recorded on the client project.",
      },
    },
    earlyBackout: {
      windows: [
        { hours: 24, valuePercent: null },
        { hours: 48, valuePercent: null },
        { hours: 72, valuePercent: null },
      ],
      target: "Falling across 24 / 48 / 72 h",
      cite: "KhFlD [00:19:36]",
      notConnected: {
        tile: "early-backout",
        source: "GHL subscription state",
        reason:
          "Paperclip has no subscription or cancellation state, and GHL is not connected, so no client can be placed in a 24, 48 or 72 hour cancellation window.",
        needed: "A read-only GHL subscription and cancellation feed.",
      },
    },
    reviewByDay30: {
      value: null,
      unit: "percent",
      target: "Rising",
      cite: "KhFlD [00:19:40]",
      notConnected: {
        tile: "review-by-day-30",
        source: "GHL + Google Business Profile reviews",
        reason:
          "Paperclip records no client reviews, and neither GHL nor Google Business Profile is connected, so there are no reviews to divide by onboarded clients.",
        needed: "Read-only review data from GHL contacts or Google Business Profile.",
      },
    },
  };
}

function buildClientDeliveryRow(client: MergedClientMetrics): DashboardFulfillmentClientDeliveryRow {
  const ctr = ctrPercent(client);
  return {
    slug: client.slug,
    displayName: client.displayName,
    spend: client.spend,
    newLeads: client.newLeads,
    cpl: client.cpl,
    ctr,
    booked: client.booked,
    showed: client.showed,
    showRate: client.showRate,
    wonDeals: client.wonDeals,
    closeRate: client.closeRate,
    costPerHeldAppointment: client.costPerHeldAppointment,
    zeroLeadDays: client.zeroLeadDays,
  };
}

function buildClientDelivery(
  period: DashboardPeriod,
  bundle: PortfolioSnapshotBundle | null,
): DashboardFulfillmentClientDelivery {
  const clientOnly = bundle ? filterClientOnlyPortfolio(bundle.clients) : [];
  if (!bundle || clientOnly.length === 0 || !bundle.observedAt) {
    return {
      period,
      observedAt: null,
      adSpendUsd: null,
      newLeads: null,
      costPerLeadUsd: null,
      ctrPercent: null,
      appointmentsBooked: null,
      appointmentsShowed: null,
      showRatePercent: null,
      wonDeals: null,
      closeRatePercent: null,
      zeroLeadDays: null,
      accounts: [],
      notConnected: {
        tile: "client-portfolio-delivery",
        source: "Client Meta & GHL portfolio (Sales Dashboard)",
        reason:
          "No live client portfolio snapshot is available for this period (or viewer lacks instance-admin access).",
        needed: "SALES_DASHBOARD_ADMIN_KEY configured on the server for live client Meta + GHL delivery reads.",
      },
    };
  }

  let spend = 0;
  let hasCompleteSpend = true;
  let newLeads = 0;
  let hasCompleteLeads = true;
  let impressions = 0;
  let hasCompleteImpressions = true;
  let clicks = 0;
  let hasCompleteClicks = true;
  let booked = 0;
  let hasCompleteBooked = true;
  let showed = 0;
  let hasCompleteShowed = true;
  let wonDeals = 0;
  let hasCompleteWon = true;
  let zeroLeadDays = 0;
  let hasCompleteZeroLeadDays = true;
  let fallbackShowRate: number | null = null;
  let fallbackCloseRate: number | null = null;

  for (const c of clientOnly) {
    if (c.spend !== null) {
      spend += c.spend;
    } else {
      hasCompleteSpend = false;
    }
    if (c.newLeads !== null) {
      newLeads += c.newLeads;
    } else {
      hasCompleteLeads = false;
    }
    if (c.impressions !== null) {
      impressions += c.impressions;
    } else {
      hasCompleteImpressions = false;
    }
    if (c.clicks !== null) {
      clicks += c.clicks;
    } else {
      hasCompleteClicks = false;
    }
    if (c.booked !== null) {
      booked += c.booked;
    } else {
      hasCompleteBooked = false;
    }
    if (c.showed !== null) {
      showed += c.showed;
    } else {
      hasCompleteShowed = false;
    }
    if (c.wonDeals !== null) {
      wonDeals += c.wonDeals;
    } else {
      hasCompleteWon = false;
    }
    if (c.zeroLeadDays !== null) {
      zeroLeadDays += c.zeroLeadDays;
    } else {
      hasCompleteZeroLeadDays = false;
    }
    if (fallbackShowRate === null && c.showRate !== null) fallbackShowRate = c.showRate;
    if (fallbackCloseRate === null && c.closeRate !== null) fallbackCloseRate = c.closeRate;
  }

  const roundedSpend = hasCompleteSpend ? round2(spend) : null;
  const costPerLeadUsd = hasCompleteSpend && hasCompleteLeads ? costPerLead({ spend, leads: newLeads }) : null;
  const portfolioCtrPercent = hasCompleteImpressions && hasCompleteClicks ? ctrPercent({ clicks, impressions }) : null;
  const isSingleClient = clientOnly.length === 1;
  const portfolioShowRate = hasCompleteBooked && hasCompleteShowed ? showRate({ pastDatedBooked: booked, showed }) : null;
  const showRatePercent =
    portfolioShowRate !== null
      ? portfolioShowRate
      : isSingleClient
        ? fallbackShowRate
        : null;
  const portfolioCloseRate = hasCompleteWon && hasCompleteShowed ? closeRate({ wonDeals, showed }) : null;
  const closeRatePercent = portfolioCloseRate !== null ? portfolioCloseRate : isSingleClient ? fallbackCloseRate : null;

  return {
    period,
    observedAt: bundle.observedAt,
    adSpendUsd: roundedSpend,
    newLeads: hasCompleteLeads ? newLeads : null,
    costPerLeadUsd,
    ctrPercent: portfolioCtrPercent,
    appointmentsBooked: hasCompleteBooked ? booked : null,
    appointmentsShowed: hasCompleteShowed ? showed : null,
    showRatePercent,
    wonDeals: hasCompleteWon ? wonDeals : null,
    closeRatePercent,
    zeroLeadDays: hasCompleteZeroLeadDays ? zeroLeadDays : null,
    accounts: clientOnly.map(buildClientDeliveryRow),
    notConnected: null,
  };
}

function buildWavvDelivery(
  period: DashboardPeriod,
  wavv: WavvSummary | null,
): DashboardFulfillmentWavvDelivery {
  if (!wavv) {
    return {
      period,
      observedAt: null,
      dials: null,
      conversationsOver60s: null,
      talkTimeMinutes: null,
      bySetter: [],
      notConnected: {
        tile: "client-wavv",
        source: "WAVV outbound dialer (via OAuth Gateway)",
        reason: "No live WAVV outbound call activity is available for this period.",
        needed: "GATEWAY_PAPERCLIP_KEY (or GATEWAY_WAVV_KEY) with read-only WAVV scope.",
      },
    };
  }
  return {
    period,
    observedAt: wavv.observedAt,
    dials: wavv.dials,
    conversationsOver60s: wavv.conversationsOver60s,
    talkTimeMinutes: wavv.talkTimeMinutes,
    bySetter: wavv.bySetter,
    notConnected: null,
  };
}

export function dashboardFulfillmentService(db: Db, deps: DashboardFulfillmentDeps = {}) {
  return {
    async board(
      companyId: string,
      now = new Date(),
      options: { period?: DashboardPeriod; boardViewer?: boolean } = {},
    ): Promise<DashboardFulfillmentBoard> {
      const period: DashboardPeriod = options.period ?? "30d";
      const allowInstanceData = options.boardViewer ?? false;

      const [companyLabels, openIssueRows, portfolioBundle, wavvSummary] = await Promise.all([
        retryIdempotentDatabaseOperation(() =>
          db
            .select({ id: labels.id, name: labels.name })
            .from(labels)
            .where(eq(labels.companyId, companyId))
            .orderBy(labels.name),
        ),
        retryIdempotentDatabaseOperation(() =>
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
        ),
        allowInstanceData
          ? (deps.portfolioReader
              ? deps.portfolioReader(period)
              : readPortfolioSnapshotBundle(period, { fetchImpl: deps.fetchImpl }))
          : Promise.resolve(null),
        allowInstanceData
          ? (deps.wavvReader
              ? deps.wavvReader(period)
              : readWavvSummary(period, { fetchImpl: deps.fetchImpl, now: () => now }))
          : Promise.resolve(null),
      ]);

      const onboardingLabelIds = companyLabels.filter((label) => ONBOARDING_LABEL.test(label.name)).map((label) => label.id);
      const supportLabels = companyLabels.filter((label) => SUPPORT_LABEL.test(label.name));

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
        period,
        clientDelivery: buildClientDelivery(period, portfolioBundle),
        wavvDelivery: buildWavvDelivery(period, wavvSummary),
        retention: retentionWithoutSources(),
        clientsWithOpenWork: clientById.size,
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
