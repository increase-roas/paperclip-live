// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Agent,
  DashboardFulfillmentBoard,
  DashboardSummary,
  Issue,
  Project,
} from "@paperclipai/shared";
import type { DashboardBoardWithMeta } from "@/api/dashboardBoards";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";
import { OPEN_TASK_STATUS_FILTER } from "./teamHubHelpers";
import { TeamHubPage } from "./TeamHubPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = vi.hoisted(() => ({
  teamKey: "marketing" as string | undefined,
  companyId: "company-1" as string | null,
  setBreadcrumbs: vi.fn(),
  openNewIssue: vi.fn(),
  issuesListSpy: vi.fn(),
  failAgents: false,
  failIssues: false,
  failKpis: false,
  failHumans: false,
  agents: [] as Agent[],
  issues: [] as Issue[],
  projects: [] as Project[],
  marketingBoard: null as DashboardBoardWithMeta | null,
  salesBoard: null as DashboardBoardWithMeta | null,
  humansBoard: null as DashboardBoardWithMeta | null,
  fulfillmentBoard: null as DashboardFulfillmentBoard | null,
  opsSummary: null as DashboardSummary | null,
}));

vi.mock("@/lib/router", () => ({
  useParams: () => ({ teamKey: fixture.teamKey }),
  useActiveCompanyPrefix: () => "INC",
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  Navigate: ({ to }: { to: string }) => <div data-testid="navigate-redirect" data-to={to} />,
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: fixture.companyId,
    selectedCompany: fixture.companyId
      ? { id: fixture.companyId, issuePrefix: "INC", name: "Increase Roas" }
      : null,
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: fixture.setBreadcrumbs }),
}));

vi.mock("@/context/DialogContext", () => ({
  useDialogActions: () => ({ openNewIssue: fixture.openNewIssue }),
}));

vi.mock("@/api/agents", () => ({
  agentsApi: {
    list: async () => {
      if (fixture.failAgents) throw new Error("agents 500");
      return fixture.agents;
    },
    update: vi.fn(async (_id: string, data: Record<string, unknown>) => ({ ...fixture.agents[0], ...data })),
    getConfiguration: vi.fn(async (id: string) => ({
      ...fixture.agents.find((agent) => agent.id === id),
      configurationRevision: "a".repeat(64),
    })),
  },
}));

vi.mock("@/api/issues", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/issues")>();
  vi.spyOn(actual.issuesApi, "list").mockImplementation(async (companyId, filters) => {
    fixture.issuesListSpy(companyId, filters);
    if (fixture.failIssues) throw new Error("issues 500");
    const start = filters?.afterId
      ? fixture.issues.findIndex((issue) => issue.id === filters.afterId) + 1
      : 0;
    return fixture.issues.slice(start, start + (filters?.limit ?? 500));
  });
  return actual;
});

vi.mock("@/api/projects", () => ({
  projectsApi: { list: async () => fixture.projects },
}));

vi.mock("@/api/dashboard", () => ({
  dashboardApi: {
    summary: async () => {
      if (fixture.failKpis) throw new Error("ops 500");
      return fixture.opsSummary;
    },
  },
}));

vi.mock("@/api/dashboardBoards", () => ({
  dashboardBoardsApi: {
    lane2: async (_companyId: string, board: string) => {
      if (board === "human-employees") {
        if (fixture.failHumans) throw new Error("humans 500");
        return fixture.humansBoard;
      }
      if (fixture.failKpis) throw new Error("kpi 500");
      if (board === "marketing") return fixture.marketingBoard;
      return fixture.salesBoard;
    },
    fulfillment: async () => {
      if (fixture.failKpis) throw new Error("fulfillment 500");
      return fixture.fulfillmentBoard;
    },
  },
}));

vi.mock("@/components/AgentAvatar", () => ({
  AgentAvatar: ({ agent }: { agent?: { name?: string } }) => (
    <span data-testid={`avatar-${agent?.name ?? "unknown"}`} />
  ),
}));

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

beforeEach(() => {
  vi.clearAllMocks();
  fixture.teamKey = "marketing";
  fixture.companyId = "company-1";
  fixture.failAgents = false;
  fixture.failIssues = false;
  fixture.failKpis = false;
  fixture.failHumans = false;
  fixture.agents = [
    {
      id: "a-ads",
      companyId: "company-1",
      name: "Ads Auditor",
      urlKey: "ads-auditor",
      role: "general",
      title: "Ads Auditor",
      status: "idle",
      metadata: null,
    } as Agent,
    {
      id: "a-sales",
      companyId: "company-1",
      name: "IR Sales Desk",
      urlKey: "ir-sales-desk",
      role: "general",
      title: "Sales Operations Desk",
      status: "running",
      metadata: null,
    } as Agent,
  ];
  fixture.projects = [
    { id: "p-onb", companyId: "company-1", name: "Onboarding", urlKey: "onboarding", status: "in_progress", archivedAt: null } as Project,
  ];
  fixture.issues = [
    {
      id: "i-1",
      companyId: "company-1",
      identifier: "INC-110",
      title: "Setter tracking: daily grades from GHL + WAVV",
      status: "in_review",
      priority: "high",
      projectId: null,
      assigneeAgentId: "a-sales",
      labels: [],
      createdAt: new Date("2026-11-24T00:00:00Z"),
      updatedAt: new Date("2026-11-25T12:00:00Z"),
    } as unknown as Issue,
    {
      id: "i-2",
      companyId: "company-1",
      identifier: "INC-111",
      title: "[Marketing] Audit Meta ad pacing",
      status: "in_progress",
      priority: "medium",
      projectId: null,
      assigneeAgentId: "a-ads",
      labels: [],
      createdAt: new Date("2026-11-24T00:00:00Z"),
      updatedAt: new Date("2026-11-25T13:00:00Z"),
    } as unknown as Issue,
  ];
  fixture.marketingBoard = {
    board: "marketing",
    companyId: "company-1",
    generatedAt: "2026-11-25T20:00:00Z",
    sources: [],
    tables: [],
    tiles: [
      { id: "ad-spend", label: "Ad spend", definition: "", owner: "", target: "", sourceIds: ["meta_ads"], value: { kind: "live", value: 37081.02, unit: "usd", observedAt: "2026-11-25T20:00:00Z" } },
      { id: "new-leads", label: "New leads", definition: "", owner: "", target: "", sourceIds: ["ghl"], value: { kind: "live", value: 727, unit: "count", observedAt: "2026-11-25T20:00:00Z" } },
      { id: "cost-per-lead", label: "Cost per lead", definition: "", owner: "", target: "", sourceIds: ["meta_ads"], value: { kind: "live", value: 51.01, unit: "usd", observedAt: "2026-11-25T20:00:00Z" } },
      { id: "ctr", label: "CTR", definition: "", owner: "", target: "", sourceIds: ["meta_ads"], value: { kind: "live", value: 1.47, unit: "percent", observedAt: "2026-11-25T20:00:00Z" } },
    ],
  } as DashboardBoardWithMeta;
  fixture.salesBoard = {
    board: "sales",
    companyId: "company-1",
    generatedAt: "2026-11-25T20:00:00Z",
    sources: [],
    tables: [],
    tiles: [
      { id: "new-leads", label: "Agency new leads", definition: "", owner: "", target: "", sourceIds: ["ghl"], value: { kind: "live", value: 33, unit: "count", observedAt: "2026-11-25T20:00:00Z" } },
      { id: "active-opportunities", label: "Active opportunities", definition: "", owner: "", target: "", sourceIds: ["ghl"], value: { kind: "live", value: 16, unit: "count", observedAt: "2026-11-25T20:00:00Z" } },
      { id: "show-rate", label: "Show rate", definition: "", owner: "", target: "", sourceIds: ["ghl"], value: { kind: "live", value: 75, unit: "percent", observedAt: "2026-11-25T20:00:00Z" } },
      { id: "units-sold", label: "Units sold", definition: "", owner: "", target: "", sourceIds: ["ghl"], value: { kind: "live", value: 3, unit: "count", observedAt: "2026-11-25T20:00:00Z" } },
    ],
  } as DashboardBoardWithMeta;
  fixture.fulfillmentBoard = {
    generatedAt: "2026-11-25T20:00:00Z",
    period: "30d",
    clientDelivery: {
      period: "30d",
      observedAt: "2026-11-25T20:00:00Z",
      adSpendUsd: 6807,
      newLeads: 55,
      costPerLeadUsd: 123.76,
      ctrPercent: 1.59,
      appointmentsBooked: 10,
      appointmentsShowed: 7,
      showRatePercent: 70,
      wonDeals: 2,
      closeRatePercent: 28.6,
      zeroLeadDays: 0,
      accounts: [{ slug: "client-a", displayName: "Client A" }],
      notConnected: null,
    },
    wavvDelivery: {
      period: "30d",
      observedAt: "2026-11-25T20:00:00Z",
      dials: 982,
      conversationsOver60s: 10,
      talkTimeMinutes: 67,
      bySetter: [],
      notConnected: null,
    },
    openClientTasks: { total: 2, unassigned: 1 },
    clients: [{ clientKey: "p1", clientName: "Sun Pool", openTasks: 2, blockedTasks: 0, oldestOpenAgeHours: 4 }],
    onboarding: { openSteps: 1, items: [], overdue: null },
    support: { waiting: 0, oldestAgeHours: null, matchedLabels: [], items: [], unavailable: null },
    retention: {
      churnMonthly: { value: null, unit: "percent", target: "< 3%", cite: "c", notConnected: null },
      saleToOnboarding: { value: null, unit: "days", target: "Short", cite: "c", notConnected: null },
      earlyBackout: { windows: [], target: "Falling", cite: "c", notConnected: null },
      reviewByDay30: { value: null, unit: "percent", target: "Rising", cite: "c", notConnected: null },
    },
    notConnected: [],
  } as unknown as DashboardFulfillmentBoard;
  fixture.opsSummary = {
    agents: { active: 10, running: 0, paused: 0, error: 0 },
    tasks: { open: 2, inProgress: 1, blocked: 0, done: 41 },
    costs: { monthSpendCents: 10975, monthBudgetCents: 20000, monthUtilizationPercent: 54.87 },
    pendingApprovals: 1,
    budgets: { activeIncidents: 0, pendingApprovals: 0, pausedAgents: 0, pausedProjects: 0 },
  } as unknown as DashboardSummary;
  fixture.humansBoard = {
    board: "human-employees",
    companyId: "company-1",
    generatedAt: "2026-11-25T20:00:00Z",
    sources: [{ id: "team_capital", name: "Team & capital", status: "connected", detail: "", needed: "", lastSuccessfulSync: null }],
    tiles: [],
    tables: [
      {
        id: "team-roster",
        title: "Team roster",
        description: "",
        scope: "member",
        sourceIds: ["team_capital"],
        columns: [],
        rows: [
          { id: "h-ant", cells: { name: "Anthony", role: "Media buyer", duties: "Meta ads", judgedOn: "NOT SET - Alex to choose one number.", status: "active" } },
          { id: "h-marv", cells: { name: "Marvin", role: "Appointment setter", duties: "WAVV", judgedOn: "12 sets / wk", status: "active" } },
          { id: "h-kat", cells: { name: "Kat", role: "Fulfillment lead", duties: "Run fulfillment", judgedOn: "NOT SET", status: "active" } },
          { id: "h-manny", cells: { name: "Manny", role: "Owner - 50/50 partner (not an employee)", duties: "Operations", judgedOn: "Not tracked (owner).", status: "inactive" } },
        ],
      },
    ],
  } as unknown as DashboardBoardWithMeta;

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
});

async function renderPage() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <TeamHubPage />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("TeamHubPage", () => {
  it("renders Marketing Team Hub with headline KPIs, shared dashboard cache keys, open-task filter, AI agents, and human members", async () => {
    await renderPage();

    expect(container.querySelector("h1")?.textContent).toBe("Marketing");
    const dashboardLink = container.querySelector<HTMLAnchorElement>('[data-testid="team-hub-open-dashboard"]');
    expect(dashboardLink?.getAttribute("href")).toBe("/dashboard/marketing");
    expect(dashboardLink?.textContent).toContain("Open full Marketing Dashboard");

    // Verifies cache key parity with useDashboardBoard and open-only issue query
    expect(client.getQueryData([...queryKeys.dashboardBoard("company-1", "marketing"), "30d"])).toBeDefined();
    expect(client.getQueryData([...queryKeys.dashboardBoard("company-1", "human-employees"), "30d"])).toBeDefined();
    expect(fixture.issuesListSpy).toHaveBeenCalledWith("company-1", expect.objectContaining({ status: OPEN_TASK_STATUS_FILTER }));

    const kpiText = container.querySelector('[data-testid="team-hub-kpi-strip"]')?.textContent ?? "";
    expect(kpiText).toContain("$37,081.02");
    expect(kpiText).toContain("727");
    expect(kpiText).toContain("$51.01");
    expect(kpiText).toContain("1.47%");

    const agentRow = container.querySelector('[data-testid="team-agent-row-ads-auditor"]');
    expect(agentRow?.textContent).toContain("Ads Auditor");
    expect(agentRow?.textContent).toContain("Also in Fulfillment");
    expect(agentRow?.textContent).toContain("INC-111");
    expect(agentRow?.querySelector('a[href="/chats/ads-auditor"]')?.getAttribute("aria-label")).toBe("Chat with Ads Auditor");
    expect(agentRow?.querySelector('a[href="/agents/ads-auditor"][aria-label="Inspect Ads Auditor"]')).not.toBeNull();

    const humansSection = container.querySelector('[data-testid="team-hub-humans"]');
    expect(humansSection?.textContent).toContain("Anthony");
    expect(humansSection?.textContent).toContain("KPI not set");
    expect([...(humansSection?.querySelectorAll("th") ?? [])].every((th) => th.getAttribute("scope") === "col")).toBe(true);
    expect(container.querySelector('a[data-testid="manage-team-capital-link"]')?.getAttribute("href")).toBe(
      "/dashboard/human-employees",
    );

    const newTaskBtn = container.querySelector<HTMLButtonElement>('[data-testid="team-hub-new-task"]');
    await act(async () => newTaskBtn!.click());
    expect(fixture.openNewIssue).toHaveBeenCalledWith({ title: "[Marketing] " });
  });

  it("loads tasks beyond the first API page and preserves department filtering and agent assignments", async () => {
    const task = fixture.issues[0]!;
    fixture.issues = Array.from({ length: 501 }, (_, index) => ({
      ...task,
      id: `task-${String(index).padStart(4, "0")}`,
      identifier: `INC-${1000 + index}`,
      title: index === 500 ? "[Marketing] Second-page campaign" : `[Sales] Task ${index}`,
      projectId: null,
      labels: [],
      assigneeAgentId: index === 500 ? "a-ads" : "a-sales",
    }));

    await renderPage();

    const tasks = container.querySelector('[data-testid="team-hub-tasks"]');
    expect(tasks?.querySelector('[data-testid="team-task-row-INC-1500"]')).not.toBeNull();
    expect(tasks?.textContent).toContain("Ads Auditor");
    expect(tasks?.textContent).not.toContain("[Sales]");
    expect(container.querySelector('[data-testid="team-agent-row-ads-auditor"]')?.textContent)
      .toContain("Second-page campaign");
    expect(fixture.issuesListSpy).toHaveBeenCalledTimes(2);
    expect(fixture.issuesListSpy).toHaveBeenLastCalledWith("company-1", expect.objectContaining({
      status: OPEN_TASK_STATUS_FILTER,
      afterId: "task-0499",
    }));
  });

  it("renders Sales Team Hub with agency GHL KPIs, Sales agent, Sales tasks, and setters", async () => {
    fixture.teamKey = "sales";
    await renderPage();

    expect(container.querySelector("h1")?.textContent).toBe("Sales");
    expect(container.querySelector('[data-testid="team-hub-open-dashboard"]')?.getAttribute("href")).toBe(
      "/dashboard/sales",
    );
    expect(container.querySelector('[data-testid="team-hub-kpi-strip"]')?.textContent).toContain("33");
    expect(container.querySelector('[data-testid="team-hub-kpi-strip"]')?.textContent).toContain("16");
    expect(container.querySelector('[data-testid="team-agent-row-ir-sales-desk"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="team-task-row-INC-110"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="team-hub-humans"]')?.textContent).toContain("12 sets / wk");
  });

  it("renders Fulfillment Team Hub with client ad & WAVV KPIs, shared multi-team agents, and empty-agent CTA when none match", async () => {
    fixture.teamKey = "fulfillment";
    await renderPage();

    expect(container.querySelector("h1")?.textContent).toBe("Fulfillment");
    expect(container.querySelector('[data-testid="team-hub-open-dashboard"]')?.getAttribute("href")).toBe(
      "/dashboard/fulfillment",
    );
    const kpiText = container.querySelector('[data-testid="team-hub-kpi-strip"]')?.textContent ?? "";
    expect(kpiText).toContain("$6,807.00");
    expect(kpiText).toContain("982");
    expect(container.querySelector('[data-testid="team-agent-row-ads-auditor"]')?.textContent).toContain(
      "Also in Marketing",
    );
    expect(container.querySelector('[data-testid="team-hub-humans"]')?.textContent).toContain("Kat");

    // Empty-agent CTA still renders cleanly when no agents belong to Fulfillment
    fixture.agents = [fixture.agents[1]!];
    client.clear();
    await renderPage();
    const agentsSection = container.querySelector('[data-testid="team-hub-agents"]');
    expect(agentsSection?.textContent).toContain("No AI agents assigned to Fulfillment yet");
    expect(agentsSection?.querySelector('a[href="/agents/new"]')).not.toBeNull();
  });

  it("renders Operations Team Hub with summary KPIs and redirects unknown team keys", async () => {
    fixture.teamKey = "operations";
    await renderPage();

    expect(container.querySelector("h1")?.textContent).toBe("Operations");
    expect(container.querySelector('[data-testid="team-hub-open-dashboard"]')?.getAttribute("href")).toBe(
      "/dashboard/operations",
    );
    expect(container.querySelector('[data-testid="team-hub-kpi-strip"]')?.textContent).toContain("$109.75");
    expect(container.querySelector('[data-testid="team-hub-humans"]')?.textContent).toContain("Manny");

    fixture.teamKey = "nonexistent";
    await renderPage();
    expect(container.querySelector('[data-testid="navigate-redirect"]')?.getAttribute("data-to")).toBe(
      "/INC/teams/marketing",
    );
  });

  it("surfaces accessible error alerts with Retry across KPIs, Agents, Tasks, and Humans instead of false empty states", async () => {
    fixture.failAgents = true;
    fixture.failIssues = true;
    fixture.failKpis = true;
    fixture.failHumans = true;
    await renderPage();

    expect(container.querySelector('[data-testid="team-hub-kpi-error"]')?.getAttribute("role")).toBe("alert");
    expect(container.querySelector('[data-testid="team-hub-agents-error"]')?.getAttribute("role")).toBe("alert");
    expect(container.querySelector('[data-testid="team-hub-tasks-error"]')?.getAttribute("role")).toBe("alert");
    expect(container.querySelector('[data-testid="team-hub-humans-error"]')?.getAttribute("role")).toBe("alert");
    expect(container.textContent).not.toContain("No AI agents assigned");
    expect(container.textContent).not.toContain("No open marketing tasks");
  });

  it("distinguishes a disconnected team_capital source from an empty department roster and shows truncation when >12 tasks exist", async () => {
    fixture.humansBoard = {
      ...fixture.humansBoard!,
      sources: [{ id: "team_capital", name: "Team & capital", status: "not_connected", detail: "", needed: "", lastSuccessfulSync: null }],
      tables: [{ id: "team-roster", title: "Team roster", description: "", scope: "member", sourceIds: ["team_capital"], columns: [], rows: [] }],
    } as DashboardBoardWithMeta;
    fixture.issues = Array.from({ length: 14 }, (_, idx) => ({
      id: `m-${idx}`,
      companyId: "company-1",
      identifier: `INC-${200 + idx}`,
      title: `[Marketing] Task ${idx + 1}`,
      status: "todo",
      priority: "medium",
      projectId: null,
      assigneeAgentId: "a-ads",
      labels: [],
      createdAt: new Date("2026-11-24T00:00:00Z"),
      updatedAt: new Date("2026-11-25T12:00:00Z"),
    }) as unknown as Issue);

    await renderPage();

    expect(container.querySelector('[data-testid="team-hub-humans-disconnected"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="team-hub-tasks-truncated"]')?.textContent).toContain(
      "Showing 12 of 14 open tasks",
    );
  });

  it("interactively manages multi-team department membership via AgentDepartmentsPopover (aria-pressed, metadata preservation, last-department guard, error alert & clear on reopen)", async () => {
    fixture.teamKey = "marketing";
    fixture.agents = [
      {
        id: "a-ads",
        companyId: "company-1",
        name: "Ads Auditor",
        urlKey: "ads-auditor",
        role: "general",
        title: "Ads Auditor",
        status: "idle",
        metadata: {
          bot: { transport: "hermes_gateway" },
          departments: ["marketing", "fulfillment"],
          tags: ["marketing", "priority:high"],
        },
      } as unknown as Agent,
      {
        id: "a-single",
        companyId: "company-1",
        name: "Brand Copywriter",
        urlKey: "brand-copywriter",
        role: "cmo",
        title: "Brand Copywriter",
        status: "idle",
        metadata: { departments: ["marketing"] },
      } as unknown as Agent,
    ];

    const updateSpy = vi.mocked(agentsApi.update);
    updateSpy.mockImplementation(async (id: string, data: Record<string, unknown>) => {
      const idx = fixture.agents.findIndex((a) => a.id === id);
      const updated = { ...fixture.agents[idx]!, ...data } as Agent;
      fixture.agents[idx] = updated;
      return updated as unknown as Awaited<ReturnType<typeof agentsApi.update>>;
    });

    await renderPage();

    // 1. Open popover for Brand Copywriter (single team) and verify last-department button is disabled + aria-pressed
    const singleTrigger = container.querySelector('[data-testid="team-agent-departments-btn-brand-copywriter"]') as HTMLButtonElement;
    expect(singleTrigger).not.toBeNull();
    await act(async () => {
      singleTrigger.click();
    });
    const singleMktOpt = document.body.querySelector('[data-testid="team-agent-dept-option-brand-copywriter-marketing"]') as HTMLButtonElement;
    const singleSalesOpt = document.body.querySelector('[data-testid="team-agent-dept-option-brand-copywriter-sales"]') as HTMLButtonElement;
    expect(singleMktOpt?.getAttribute("aria-pressed")).toBe("true");
    expect(singleMktOpt?.disabled).toBe(true);
    expect(singleSalesOpt?.getAttribute("aria-pressed")).toBe("false");
    expect(singleSalesOpt?.disabled).toBe(false);

    // Close single popover, then let Radix's deferred focus-return run so it
    // cannot dismiss the next popover we open.
    await act(async () => {
      singleTrigger.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // A configuration change after the list loaded must survive the team edit.
    vi.mocked(agentsApi.getConfiguration).mockResolvedValueOnce({
      ...fixture.agents[0],
      metadata: {
        ...fixture.agents[0]!.metadata,
        apiKey: "***REDACTED***",
        serverOnly: "new-value",
        teams: ["operations"],
      },
      configurationRevision: "b".repeat(64),
    } as Awaited<ReturnType<typeof agentsApi.getConfiguration>>);

    // 2. Add Sales using the current configuration and its redaction-safe revision.
    const adsTrigger = container.querySelector('[data-testid="team-agent-departments-btn-ads-auditor"]') as HTMLButtonElement;
    await act(async () => {
      adsTrigger.click();
    });
    const adsSalesOpt = document.body.querySelector('[data-testid="team-agent-dept-option-ads-auditor-sales"]') as HTMLButtonElement;
    expect(adsSalesOpt).not.toBeNull();
    await act(async () => {
      adsSalesOpt.click();
    });
    expect(updateSpy).toHaveBeenCalledWith(
      "a-ads",
      {
        metadata: {
          bot: { transport: "hermes_gateway" },
          apiKey: "***REDACTED***",
          serverOnly: "new-value",
          tags: ["priority:high"],
          departments: ["marketing", "sales", "fulfillment", "operations"],
        },
        expectedConfigurationRevision: "b".repeat(64),
      },
      "company-1",
    );
    expect(agentsApi.getConfiguration).toHaveBeenCalledWith("a-ads", "company-1");

    // 3. Failure renders role="alert" and clears when closing and reopening popover
    updateSpy.mockRejectedValueOnce(new Error("PATCH failed: 500"));
    const adsOpsOpt = document.body.querySelector('[data-testid="team-agent-dept-option-ads-auditor-operations"]') as HTMLButtonElement;
    await act(async () => {
      adsOpsOpt.click();
    });
    const alertEl = document.body.querySelector('[role="alert"]');
    expect(alertEl?.textContent).toContain("PATCH failed: 500");

    // Close and reopen -> stale error clears
    await act(async () => {
      adsTrigger.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      adsTrigger.click();
    });
    expect(adsTrigger.getAttribute("data-state")).toBe("open");
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
  });
});
