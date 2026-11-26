// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DashboardAiCostBoard,
  DashboardAutomationHealthBoard,
  DashboardFulfillmentBoard,
  DashboardToolsConnectorsBoard,
} from "@paperclipai/shared";

const apiMocks = vi.hoisted(() => ({
  aiCost: vi.fn(),
  automationHealth: vi.fn(),
  toolsConnectors: vi.fn(),
  fulfillment: vi.fn(),
}));

const dashboardApiMocks = vi.hoisted(() => ({
  summary: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode } & Record<string, unknown>) => (
    <a href={to} {...props}>{children}</a>
  ),
}));
vi.mock("@/api/dashboardBoards", () => ({ dashboardBoardsApi: apiMocks }));
vi.mock("@/api/dashboard", () => ({ dashboardApi: dashboardApiMocks }));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

import { AiCostBoard } from "./ai-cost/AiCostBoard";
import { AutomationHealthBoard } from "./automation-health/AutomationHealthBoard";
import { ToolsConnectorsBoard } from "./tools-connectors/ToolsConnectorsBoard";
import { FulfillmentBoard } from "./fulfillment/FulfillmentBoard";
import { dashboards } from "./registry";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = "2026-11-23T12:00:00.000Z";

const aiCostFixture: DashboardAiCostBoard = {
  companyId: "company-1",
  generatedAt: NOW,
  monthStart: "2026-11-01T00:00:00.000Z",
  company: {
    budgetMonthlyCents: 20_000,
    spendTodayCents: 1_000,
    spend7dCents: 1_000,
    spendMonthToDateCents: 1_100,
    utilizationPercent: 5.5,
    forecastMonthEndCents: 1_435,
    monthProgressPercent: 76.67,
  },
  seats: [
    {
      agentId: "a1",
      name: "Atlas",
      status: "running",
      budgetMonthlyCents: 2_000,
      spendTodayCents: 1_000,
      spend7dCents: 1_000,
      spendMonthToDateCents: 1_000,
      utilizationPercent: 50,
      overEightyPercent: false,
      completedTasksMonth: 1,
      costPerCompletedTaskCents: 500,
    },
    {
      agentId: "a2",
      name: "Risky",
      status: "idle",
      budgetMonthlyCents: 100,
      spendTodayCents: 0,
      spend7dCents: 0,
      spendMonthToDateCents: 90,
      utilizationPercent: 90,
      overEightyPercent: true,
      completedTasksMonth: 0,
      costPerCompletedTaskCents: null,
    },
  ],
  seatsOverEightyPercent: 1,
  seatsWithoutCap: 0,
  completedTasksMonth: 1,
  costPerCompletedTaskCents: 500,
  topCostDrivers: [
    { provider: "anthropic", model: "claude-test", spendMonthToDateCents: 1_000, sharePercent: 90.91 },
  ],
  outputUnit: {
    spendMonthToDateCents: 1_100,
    outputUnitsMonth: null,
    costPerOutputUnitCents: null,
    target: "Must fall as volume rises",
    cite: "9q5oj [11:05]",
    notConnected: {
      tile: "client-output",
      source: "Client output count (reports, audits, creative sets)",
      reason: "Paperclip has no field that marks a work product as a client report, audit or creative set.",
      needed: "A deliverable type on work products.",
    },
  },
  workflowCoverage: {
    seats: [
      { agentId: "a1", name: "Atlas", automatedTasks: 1, listedTasks: null, automatedPercent: null },
      { agentId: "a2", name: "Risky", automatedTasks: 0, listedTasks: null, automatedPercent: null },
    ],
    totalAutomated: 1,
    listedTasksTotal: null,
    automatedPercent: null,
    target: "Every task should be a workflow, not a headcount",
    cite: "9q5oj [04:42]",
    notConnected: {
      tile: "seat-task-inventory",
      source: "Seat task inventory (4–6 hand-and-eye tasks per seat)",
      reason: "Paperclip records routines, but not the full list of tasks each seat performs.",
      needed: "A per-seat task inventory.",
    },
  },
  notConnected: [],
};

const automationFixture: DashboardAutomationHealthBoard = {
  companyId: "company-1",
  generatedAt: NOW,
  seats: [
    {
      agentId: "a1",
      name: "Atlas",
      status: "error",
      errorReason: "provider quota",
      heartbeatEnabled: false,
      heartbeatIntervalSec: 0,
      lastHeartbeatAt: "2026-11-23T11:00:00.000Z",
      lastRunAt: "2026-11-23T11:30:00.000Z",
      lastRunStatus: "failed",
      lastRunError: "quota",
      failedRuns24h: 2,
      timedOutRuns24h: 1,
    },
  ],
  seatSummary: { total: 1, running: 0, idle: 0, error: 1, paused: 0 },
  routines: {
    total: 1,
    active: 1,
    runs7d: 2,
    completed7d: 1,
    failed7d: 1,
    successRate7d: 50,
    items: [
      {
        routineId: "r1",
        title: "Daily ad check",
        status: "active",
        assigneeAgentId: "a1",
        assigneeName: "Atlas",
        lastRunAt: "2026-11-23T10:00:00.000Z",
        lastRunStatus: "failed",
        lastRunResult: "gateway timeout",
        runs7d: 2,
        completed7d: 1,
        failed7d: 1,
        successRate7d: 50,
      },
    ],
  },
  blockedTasks: {
    count: 1,
    oldestAgeHours: 30,
    items: [
      {
        id: "i1",
        identifier: "L3-2",
        title: "Blocked task",
        projectName: "Acme",
        blockedAt: "2026-11-22T06:00:00.000Z",
        ageHours: 30,
      },
    ],
  },
  approvals: {
    pendingCount: 1,
    oldestAgeHours: 30,
    items: [
      { id: "ap1", type: "budget_increase", createdAt: "2026-11-22T06:00:00.000Z", ageHours: 30 },
    ],
  },
  server: {
    status: "ok",
    version: "0.3.1",
    commit: "abcdef0123456789",
    databaseProbe: "ok",
    backup: null,
  },
  notConnected: [],
};

const toolsFixture: DashboardToolsConnectorsBoard = {
  companyId: "company-1",
  generatedAt: NOW,
  items: [
    {
      id: "connection:1",
      name: "Meta Ads MCP",
      kind: "tool_connection",
      detail: "Meta Ads · mcp_remote · oauth",
      status: "active",
      health: "degraded",
      healthMessage: "token expires soon",
      lastCheckAt: "2026-11-23T11:00:00.000Z",
      lastSuccessfulUseAt: "2026-11-23T11:40:00.000Z",
      expiresAt: "2026-12-03T12:00:00.000Z",
      expiryDaysRemaining: 10,
    },
    {
      id: "plugin:1",
      name: "test-plugin",
      kind: "plugin",
      detail: "Plugin 1.2.3",
      status: "ready",
      health: null,
      healthMessage: null,
      lastCheckAt: "2026-11-21T12:00:00.000Z",
      lastSuccessfulUseAt: null,
      expiresAt: null,
      expiryDaysRemaining: null,
    },
  ],
  summary: {
    total: 2,
    healthy: 0,
    needsAttention: 1,
    unchecked: 1,
    expiringWithin14Days: 1,
    expiryUnknown: 1,
  },
  notConnected: [],
};

const fulfillmentFixture: DashboardFulfillmentBoard = {
  companyId: "company-1",
  generatedAt: NOW,
  clients: [
    { clientKey: "p1", clientName: "Acme", openTasks: 2, blockedTasks: 1, oldestOpenAgeHours: 40 },
  ],
  openClientTasks: { total: 2, unassigned: 2 },
  onboarding: {
    openSteps: 1,
    items: [
      {
        id: "i4",
        identifier: "L3-4",
        title: "Onboarding: send agreement",
        clientName: null,
        status: "todo",
        ageHours: 8,
      },
    ],
    overdue: {
      tile: "onboarding-overdue",
      source: "Client onboarding due dates",
      reason: "Paperclip tasks have no due-date field.",
      needed: "Add due dates to onboarding tasks.",
    },
  },
  support: {
    waiting: 1,
    oldestAgeHours: 50,
    items: [
      {
        id: "i5",
        identifier: "L3-5",
        title: "Client wants a report change",
        clientName: null,
        status: "todo",
        ageHours: 50,
      },
    ],
    matchedLabels: ["Support"],
    unavailable: null,
  },
  notConnected: [
    {
      tile: "onboarding-overdue",
      source: "Client onboarding due dates",
      reason: "Paperclip tasks have no due-date field.",
      needed: "Add due dates to onboarding tasks.",
    },
    {
      tile: "ghl-conversations",
      source: "GHL conversations",
      reason: "GHL is not connected.",
      needed: "A read-only GHL conversations connection.",
    },
  ],
  retention: {
    churnMonthly: {
      value: null,
      unit: "percent",
      target: "< 3% per month",
      cite: "U_s0ek [00:15:51]",
      notConnected: {
        tile: "churn-monthly",
        source: "GHL subscription state + Authorize.net",
        reason: "No GHL or Authorize.net connection is available.",
        needed: "A read-only GHL subscription and Authorize.net connection.",
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
        reason: "Paperclip has no close date or first-live date, and GHL is not connected.",
        needed: "A close date from GHL and a first-live date on the client project.",
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
        reason: "Paperclip has no subscription or cancellation state.",
        needed: "A read-only GHL cancellation feed.",
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
        reason: "Paperclip has no review records.",
        needed: "Read-only review data from GHL or Google Business Profile.",
      },
    },
  },
};

describe("lane 3 dashboard boards", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    apiMocks.aiCost.mockResolvedValue(aiCostFixture);
    apiMocks.automationHealth.mockResolvedValue(automationFixture);
    apiMocks.toolsConnectors.mockResolvedValue(toolsFixture);
    apiMocks.fulfillment.mockResolvedValue(fulfillmentFixture);
    dashboardApiMocks.summary.mockResolvedValue({
      companyId: "company-1",
      agents: { active: 1, running: 0, paused: 0, error: 1 },
      tasks: { open: 1, inProgress: 0, blocked: 1, done: 0 },
      costs: { monthSpendCents: 1100, monthBudgetCents: 20000, monthUtilizationPercent: 5.5 },
      pendingApprovals: 1,
      budgets: { activeIncidents: 0, pendingApprovals: 0, pausedAgents: 0, pausedProjects: 0 },
      runActivity: [
        { date: "2026-11-23", succeeded: 4, failed: 1, recovered: 0, other: 0, total: 5, failedByErrorCode: {} },
      ],
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function render(node: ReactNode) {
    await act(async () => {
      root.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
    });
  }

  it("registers all four boards under stable ids", () => {
    expect(dashboards.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([
        "ai-cost",
        "automation-health",
        "tools-connectors",
        "fulfillment",
      ]),
    );
  });

  it("AI cost shows spend against cap and highlights seats over 80%", async () => {
    await render(<AiCostBoard />);
    await vi.waitFor(() => expect(container.textContent).toContain("Atlas"));
    expect(container.querySelector('[data-testid="ai-cost-month"]')?.textContent).toContain("$11.00");
    expect(container.querySelector('[data-testid="ai-cost-over-cap"]')?.textContent).toContain("1");
    expect(container.textContent).toContain("90.0%");
    expect(container.textContent).toContain("$5.00");
    expect(container.textContent).toContain("anthropic");
  });

  it("AI cost adds the two v2 numbers and states the missing output count", async () => {
    await render(<AiCostBoard />);
    await vi.waitFor(() => expect(container.textContent).toContain("Atlas"));
    expect(container.querySelector('[data-testid="ai-cost-output-unit"]')?.textContent).toContain(
      "Not connected: Client output count",
    );
    expect(container.querySelector('[data-testid="ai-cost-workflow"]')?.textContent).toContain(
      "Not connected: Seat task inventory",
    );
    expect(container.textContent).toContain("Automated routines per seat");
    expect(container.textContent).toContain("9q5oj");
    expect(container.textContent).toContain("v1 source, not Hormozi");
  });

  it("AI cost hides terminated $0 seats behind a toggle by default", async () => {
    apiMocks.aiCost.mockResolvedValue({
      ...aiCostFixture,
      seats: [
        ...aiCostFixture.seats,
        {
          agentId: "a-term",
          name: "Legacy Retired Seat",
          status: "terminated",
          budgetMonthlyCents: 0,
          spendTodayCents: 0,
          spend7dCents: 0,
          spendMonthToDateCents: 0,
          utilizationPercent: null,
          overEightyPercent: false,
          completedTasksMonth: 0,
          costPerCompletedTaskCents: null,
        },
      ],
    });
    await render(<AiCostBoard />);
    await vi.waitFor(() => expect(container.textContent).toContain("Atlas"));
    expect(container.textContent).not.toContain("Legacy Retired Seat");

    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="ai-cost-toggle-terminated"]');
    expect(toggle?.textContent).toContain("Show terminated seats (1)");
    await act(async () => {
      toggle?.click();
    });
    expect(container.textContent).toContain("Legacy Retired Seat");
  });

  it("Automation health shows seat errors, 14-day charts, routine rate, blocked work, and filters terminated seats", async () => {
    apiMocks.automationHealth.mockResolvedValue({
      ...automationFixture,
      seats: [
        ...automationFixture.seats,
        {
          agentId: "a-term",
          name: "Old Terminated Bot",
          status: "terminated",
          errorReason: null,
          heartbeatEnabled: false,
          heartbeatIntervalSec: 0,
          lastHeartbeatAt: null,
          lastRunAt: null,
          lastRunStatus: null,
          lastRunError: null,
          failedRuns24h: 0,
          timedOutRuns24h: 0,
        },
      ],
      seatSummary: { total: 2, running: 0, idle: 0, error: 1, paused: 0 },
    });

    await render(<AutomationHealthBoard />);
    await vi.waitFor(() => expect(container.textContent).toContain("provider quota"));
    expect(container.querySelector('[data-testid="automation-seats"]')?.textContent).toContain("0 / 1");
    expect(container.querySelector('[data-testid="automation-failures"]')?.textContent).toContain("3");
    expect(container.querySelector('[data-testid="automation-routines"]')?.textContent).toContain("50.0%");
    expect(container.textContent).toContain("gateway timeout");
    expect(container.textContent).toContain("L3-2");
    expect(container.textContent).toContain("Any task blocked over 24 hours escalates to Javar.");
    expect(container.querySelector('[data-testid="automation-backup"]')?.textContent).toContain(
      "Not connected: Database backup",
    );
    // Duplicate Approvals tile & table removed; replaced by a clean link to /decisions.
    expect(container.querySelector('[data-testid="automation-approvals"]')).toBeNull();
    expect(container.textContent).not.toContain("budget_increase");
    expect(
      container.querySelector('[data-testid="automation-approvals-link"]')?.getAttribute("href"),
    ).toBe("/decisions");
    // 14-day run charts are folded into Automation health.
    expect(container.querySelector('[data-testid="automation-run-charts"]')).not.toBeNull();
    // Terminated seat hidden by default, revealed via toggle.
    expect(container.textContent).not.toContain("Old Terminated Bot");
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="automation-toggle-terminated"]');
    expect(toggle?.textContent).toContain("Show terminated (1)");
    await act(async () => {
      toggle?.click();
    });
    expect(container.textContent).toContain("Old Terminated Bot");
    expect(container.textContent).toContain("v1 spec, not Hormozi");
  });

  it("Tools shows health, destructive expiry warning banner, last successful use and an explicit expiry-unknown state", async () => {
    await render(<ToolsConnectorsBoard />);
    await vi.waitFor(() => expect(container.textContent).toContain("Meta Ads MCP"));
    expect(container.querySelector('[data-testid="tools-expiry-warning"]')?.textContent).toContain(
      "Meta Ads MCP",
    );
    expect(container.querySelector('[data-testid="tools-attention"]')?.textContent).toContain("1");
    expect(container.textContent).toContain("token expires soon");
    expect(container.textContent).toContain("Expiry unknown");
    expect(container.querySelector('[data-testid="tools-expiring"]')?.textContent).toContain("1");
    expect(container.querySelector('[data-testid="tools-expiry-unknown"]')?.textContent).toContain("1");
    expect(container.textContent).toContain("v1 spec, not Hormozi");
  });

  it("Fulfillment groups by client and states the missing sources", async () => {
    await render(<FulfillmentBoard />);
    await vi.waitFor(() => expect(container.textContent).toContain("Acme"));
    expect(container.querySelector('[data-testid="fulfillment-open-tasks"]')?.textContent).toContain("2");
    expect(container.querySelector('[data-testid="fulfillment-unassigned"]')?.textContent).toContain("2");
    expect(container.textContent).toContain("Not connected: Client onboarding due dates");
    expect(container.textContent).toContain("Not connected: GHL conversations");
    expect(container.textContent).toContain("Support");
  });

  it("Fulfillment puts Hormozi's four retention numbers first and never guesses a value", async () => {
    await render(<FulfillmentBoard />);
    await vi.waitFor(() => expect(container.textContent).toContain("Acme"));
    expect(container.querySelector('[data-testid="fulfillment-churn"]')?.textContent).toContain(
      "Not connected: GHL subscription state + Authorize.net",
    );
    expect(container.querySelector('[data-testid="fulfillment-sale-onboarding"]')?.textContent).toContain(
      "Not connected: GHL close date + Paperclip first live date",
    );
    expect(container.querySelector('[data-testid="fulfillment-early-backout"]')?.textContent).toContain(
      "Not connected: GHL subscription state",
    );
    expect(container.querySelector('[data-testid="fulfillment-review-30"]')?.textContent).toContain(
      "Not connected: GHL + Google Business Profile reviews",
    );
    expect(container.textContent).toContain("Hormozi");
    expect(container.textContent).toContain("v1 source, not Hormozi");
  });

  it("Fulfillment renders live client portfolio ad metrics and WAVV delivery when present", async () => {
    apiMocks.fulfillment.mockResolvedValue({
      ...fulfillmentFixture,
      period: "30d",
      clientDelivery: {
        period: "30d",
        observedAt: NOW,
        adSpendUsd: 6650.77,
        newLeads: 55,
        costPerLeadUsd: 120.92,
        ctrPercent: 1.59,
        appointmentsBooked: 12,
        appointmentsShowed: 9,
        showRatePercent: 75,
        wonDeals: 3,
        closeRatePercent: 33.3,
        zeroLeadDays: 0,
        accounts: [
          {
            slug: "client-a",
            displayName: "Client A",
            spend: 6650.77,
            newLeads: 55,
            cpl: 120.92,
            ctr: 1.59,
            booked: 12,
            showed: 9,
            showRate: 75,
            wonDeals: 3,
            closeRate: 33.3,
            costPerHeldAppointment: 738.97,
            zeroLeadDays: 0,
          },
        ],
        notConnected: null,
      },
      wavvDelivery: {
        period: "30d",
        observedAt: NOW,
        dials: 420,
        conversationsOver60s: 19,
        talkTimeMinutes: 94.5,
        bySetter: [
          { id: "s1", setter: "Marvin", dials: 420, talkTimeMinutes: 94.5, conversationsOver60s: 19 },
        ],
        notConnected: null,
      },
    });
    await render(<FulfillmentBoard period="30d" />);
    await vi.waitFor(() => expect(container.textContent).toContain("Client A"));
    expect(container.querySelector('[data-testid="fulfillment-client-ad-spend"]')?.textContent).toContain("$6,650.77");
    expect(container.querySelector('[data-testid="fulfillment-client-new-leads"]')?.textContent).toContain("55");
    expect(container.querySelector('[data-testid="fulfillment-client-cpl"]')?.textContent).toContain("$120.92");
    expect(container.querySelector('[data-testid="fulfillment-client-ctr"]')?.textContent).toContain("1.6%");
    expect(container.querySelector('[data-testid="fulfillment-wavv-dials"]')?.textContent).toContain("420");
    expect(container.querySelector('[data-testid="fulfillment-wavv-scoreboard"]')?.textContent).toContain("Marvin");
  });
});
