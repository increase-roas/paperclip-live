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

vi.mock("@/api/dashboardBoards", () => ({ dashboardBoardsApi: apiMocks }));
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
    expect(dashboards.map((entry) => entry.id)).toEqual([
      "ai-cost",
      "automation-health",
      "tools-connectors",
      "fulfillment",
    ]);
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

  it("Automation health shows seat errors, routine rate, blocked work and approvals", async () => {
    await render(<AutomationHealthBoard />);
    await vi.waitFor(() => expect(container.textContent).toContain("provider quota"));
    expect(container.querySelector('[data-testid="automation-failures"]')?.textContent).toContain("3");
    expect(container.querySelector('[data-testid="automation-routines"]')?.textContent).toContain("50.0%");
    expect(container.textContent).toContain("gateway timeout");
    expect(container.textContent).toContain("L3-2");
    expect(container.textContent).toContain("budget_increase");
    expect(container.querySelector('[data-testid="automation-backup"]')?.textContent).toContain(
      "Not connected: Database backup",
    );
  });

  it("Tools shows health, last successful use and an explicit expiry-unknown state", async () => {
    await render(<ToolsConnectorsBoard />);
    await vi.waitFor(() => expect(container.textContent).toContain("Meta Ads MCP"));
    expect(container.querySelector('[data-testid="tools-attention"]')?.textContent).toContain("1");
    expect(container.textContent).toContain("token expires soon");
    expect(container.textContent).toContain("Expiry unknown");
    expect(container.querySelector('[data-testid="tools-expiring"]')?.textContent).toContain("1");
    expect(container.querySelector('[data-testid="tools-expiry-unknown"]')?.textContent).toContain("1");
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
});
