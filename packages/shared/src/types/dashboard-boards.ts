/**
 * Contracts for the Lane 3 operating dashboards:
 * AI cost, Automation health, Tools/connectors and Fulfillment.
 *
 * Every field is computed from a Paperclip table. Nothing here is a fixture or
 * an estimate: a tile that has no source uses `DashboardNotConnectedTile`
 * instead of a number.
 */

/** A tile that has no real source yet. Never replace this with a zero. */
export interface DashboardNotConnectedTile {
  /** Stable tile key, e.g. "onboarding-overdue". */
  tile: string;
  /** Human-readable source name shown in the tile. */
  source: string;
  /** Why the number cannot be computed today. */
  reason: string;
  /** What has to exist before the tile can show a number. */
  needed: string;
}

/* ------------------------------------------------------------------ */
/* AI cost                                                            */
/* ------------------------------------------------------------------ */

export interface DashboardAiCostSeat {
  agentId: string;
  name: string;
  status: string;
  /** 0 means the seat has no monthly cap. */
  budgetMonthlyCents: number;
  spendTodayCents: number;
  spend7dCents: number;
  spendMonthToDateCents: number;
  /** null when the seat has no cap, so utilisation is undefined rather than 0%. */
  utilizationPercent: number | null;
  overEightyPercent: boolean;
  completedTasksMonth: number;
  costPerCompletedTaskCents: number | null;
}

export interface DashboardAiCostDriver {
  provider: string;
  model: string;
  spendMonthToDateCents: number;
  sharePercent: number;
}

/**
 * Spec v2 number 1: AI spend divided by client output (reports, audits and
 * creative sets). `costPerOutputUnitCents` stays null until a real output
 * count exists; `notConnected` says which source is missing.
 */
export interface DashboardAiCostOutputUnit {
  spendMonthToDateCents: number;
  outputUnitsMonth: number | null;
  costPerOutputUnitCents: number | null;
  target: string;
  cite: string;
  notConnected: DashboardNotConnectedTile | null;
}

export interface DashboardAiCostWorkflowSeat {
  agentId: string;
  name: string;
  /** Active scheduled routines owned by this seat. Real Paperclip data. */
  automatedTasks: number;
  /** The seat's full task list; null when Paperclip has no task inventory. */
  listedTasks: number | null;
  automatedPercent: number | null;
}

/**
 * Spec v2 number 7: automated tasks ÷ the tasks a seat is listed as doing.
 * The numerator is real (active routines); the denominator needs a seat task
 * inventory before a share can be shown.
 */
export interface DashboardAiCostWorkflowCoverage {
  seats: DashboardAiCostWorkflowSeat[];
  totalAutomated: number;
  listedTasksTotal: number | null;
  automatedPercent: number | null;
  target: string;
  cite: string;
  notConnected: DashboardNotConnectedTile | null;
}

export interface DashboardAiCostBoard {
  companyId: string;
  generatedAt: string;
  monthStart: string;
  company: {
    budgetMonthlyCents: number;
    spendTodayCents: number;
    spend7dCents: number;
    spendMonthToDateCents: number;
    utilizationPercent: number | null;
    forecastMonthEndCents: number;
    monthProgressPercent: number;
  };
  seats: DashboardAiCostSeat[];
  seatsOverEightyPercent: number;
  seatsWithoutCap: number;
  completedTasksMonth: number;
  costPerCompletedTaskCents: number | null;
  topCostDrivers: DashboardAiCostDriver[];
  outputUnit: DashboardAiCostOutputUnit;
  workflowCoverage: DashboardAiCostWorkflowCoverage;
  notConnected: DashboardNotConnectedTile[];
}

/* ------------------------------------------------------------------ */
/* Automation health                                                  */
/* ------------------------------------------------------------------ */

export interface DashboardAutomationSeat {
  agentId: string;
  name: string;
  status: string;
  errorReason: string | null;
  heartbeatEnabled: boolean;
  heartbeatIntervalSec: number | null;
  lastHeartbeatAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunError: string | null;
  failedRuns24h: number;
  timedOutRuns24h: number;
}

export interface DashboardAutomationRoutine {
  routineId: string;
  title: string;
  status: string;
  assigneeAgentId: string | null;
  assigneeName: string | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunResult: string | null;
  runs7d: number;
  completed7d: number;
  failed7d: number;
  successRate7d: number | null;
}

export interface DashboardAutomationBlockedTask {
  id: string;
  identifier: string | null;
  title: string;
  projectName: string | null;
  blockedAt: string | null;
  ageHours: number;
}

export interface DashboardAutomationApproval {
  id: string;
  type: string;
  createdAt: string;
  ageHours: number;
}

export interface DashboardAutomationServer {
  status: "ok" | "degraded";
  version: string | null;
  commit: string | null;
  databaseProbe: "ok" | "failed";
  backup: {
    enabled: boolean;
    status: "ok" | "warning";
    latestBackupAt: string | null;
    ageHours: number | null;
    maxAgeHours: number | null;
    warnings: string[];
  } | null;
}

export interface DashboardAutomationHealthBoard {
  companyId: string;
  generatedAt: string;
  seats: DashboardAutomationSeat[];
  seatSummary: {
    total: number;
    running: number;
    idle: number;
    error: number;
    paused: number;
  };
  routines: {
    total: number;
    active: number;
    runs7d: number;
    completed7d: number;
    failed7d: number;
    successRate7d: number | null;
    items: DashboardAutomationRoutine[];
  };
  blockedTasks: {
    count: number;
    oldestAgeHours: number | null;
    items: DashboardAutomationBlockedTask[];
  };
  approvals: {
    pendingCount: number;
    oldestAgeHours: number | null;
    items: DashboardAutomationApproval[];
  };
  server: DashboardAutomationServer;
  notConnected: DashboardNotConnectedTile[];
}

/* ------------------------------------------------------------------ */
/* Tools and connectors                                               */
/* ------------------------------------------------------------------ */

export type DashboardConnectorKind =
  | "plugin"
  | "tool_connection"
  | "github_app"
  | "adapter";

export interface DashboardConnectorRow {
  id: string;
  name: string;
  kind: DashboardConnectorKind;
  /** Transport, plugin version or adapter type; the short label under the name. */
  detail: string | null;
  status: string;
  health: string | null;
  healthMessage: string | null;
  lastCheckAt: string | null;
  lastSuccessfulUseAt: string | null;
  /** ISO timestamp when the source reports one; null means the source has no expiry field. */
  expiresAt: string | null;
  expiryDaysRemaining: number | null;
}

export interface DashboardToolsConnectorsBoard {
  companyId: string;
  generatedAt: string;
  items: DashboardConnectorRow[];
  summary: {
    total: number;
    healthy: number;
    needsAttention: number;
    unchecked: number;
    expiringWithin14Days: number;
    expiryUnknown: number;
  };
  notConnected: DashboardNotConnectedTile[];
}

/* ------------------------------------------------------------------ */
/* Fulfillment                                                        */
/* ------------------------------------------------------------------ */

export interface DashboardFulfillmentClient {
  /** Project id, or "unassigned" for open client tasks with no project. */
  clientKey: string;
  clientName: string;
  openTasks: number;
  blockedTasks: number;
  oldestOpenAgeHours: number | null;
}

export interface DashboardFulfillmentTask {
  id: string;
  identifier: string | null;
  title: string;
  clientName: string | null;
  status: string;
  ageHours: number;
}

/**
 * One of Hormozi's four retention numbers from spec v2. `value` is null when
 * no real source exists; `notConnected` then names the missing source.
 */
export interface DashboardFulfillmentRetentionNumber {
  value: number | null;
  unit: "percent" | "days";
  target: string;
  cite: string;
  notConnected: DashboardNotConnectedTile | null;
}

export interface DashboardFulfillmentRetentionWindow {
  hours: 24 | 48 | 72;
  valuePercent: number | null;
}

/** Spec v2 number 3: cancellations inside 24, 48 and 72 hours ÷ onboarded. */
export interface DashboardFulfillmentEarlyBackout {
  windows: DashboardFulfillmentRetentionWindow[];
  target: string;
  cite: string;
  notConnected: DashboardNotConnectedTile | null;
}

export interface DashboardFulfillmentRetention {
  churnMonthly: DashboardFulfillmentRetentionNumber;
  saleToOnboarding: DashboardFulfillmentRetentionNumber;
  earlyBackout: DashboardFulfillmentEarlyBackout;
  reviewByDay30: DashboardFulfillmentRetentionNumber;
}

export interface DashboardFulfillmentBoard {
  companyId: string;
  generatedAt: string;
  /** Hormozi's four retention questions, read first. */
  retention: DashboardFulfillmentRetention;
  clients: DashboardFulfillmentClient[];
  openClientTasks: {
    total: number;
    unassigned: number;
  };
  onboarding: {
    openSteps: number;
    items: DashboardFulfillmentTask[];
    overdue: DashboardNotConnectedTile | null;
  };
  support: {
    waiting: number;
    oldestAgeHours: number | null;
    items: DashboardFulfillmentTask[];
    matchedLabels: string[];
    unavailable: DashboardNotConnectedTile | null;
  };
  notConnected: DashboardNotConnectedTile[];
}
