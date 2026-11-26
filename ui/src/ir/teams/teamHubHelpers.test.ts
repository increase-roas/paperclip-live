import { describe, expect, it } from "vitest";
import type {
  Agent,
  DashboardBoard,
  DashboardFulfillmentBoard,
  DashboardSummary,
  Issue,
  Project,
} from "@paperclipai/shared";
import type { DashboardBoardWithMeta } from "@/api/dashboardBoards";
import {
  buildAgentCurrentTaskMap,
  extractHumanMembersForTeam,
  filterAgentsForTeam,
  filterTeamActiveTasks,
  findMatchingTeamProject,
  formatTeamAgentSubtitle,
  getTeamHubConfig,
  isMissingJudgedOn,
  isTeamCapitalDisconnected,
  isTeamHubActive,
  matchAgentTeams,
  normalizeTeamAlias,
  selectFulfillmentKpis,
  selectMarketingKpis,
  selectOperationsKpis,
  selectSalesKpis,
  teamHubHref,
} from "./teamHubHelpers";

function makeAgent(overrides: Partial<Agent> & { id: string; name: string; urlKey: string }): Agent {
  return {
    companyId: "c1",
    role: "general",
    title: overrides.name,
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-11-01T00:00:00Z"),
    updatedAt: new Date("2026-11-01T00:00:00Z"),
    ...overrides,
  } as Agent;
}

function makeIssue(overrides: Partial<Issue> & { id: string; title: string }): Issue {
  return {
    companyId: "c1",
    identifier: overrides.id.toUpperCase(),
    status: "todo",
    priority: "medium",
    projectId: null,
    assigneeAgentId: null,
    labels: [],
    createdAt: new Date("2026-11-20T00:00:00Z"),
    updatedAt: new Date("2026-11-25T12:00:00Z"),
    ...overrides,
  } as Issue;
}

function makeProject(overrides: Partial<Project> & { id: string; name: string }): Project {
  return {
    companyId: "c1",
    urlKey: overrides.name.toLowerCase().replace(/\s+/g, "-"),
    status: "in_progress",
    archivedAt: null,
    ...overrides,
  } as Project;
}

describe("teamHubHelpers", () => {
  it("resolves canonical configs, hrefs, aliases (including spaces after prefixes), and exact active route matching", () => {
    expect(getTeamHubConfig("marketing")?.dashboardHref).toBe("/dashboard/marketing");
    expect(getTeamHubConfig("SALES")?.dashboardHref).toBe("/dashboard/sales");
    expect(getTeamHubConfig("fulfillment")?.dashboardHref).toBe("/dashboard/fulfillment");
    expect(getTeamHubConfig("operations")?.dashboardHref).toBe("/dashboard/operations");
    expect(getTeamHubConfig("unknown")).toBeNull();

    expect(normalizeTeamAlias("team: marketing")).toBe("marketing");
    expect(normalizeTeamAlias("dept: sales")).toBe("sales");
    expect(normalizeTeamAlias("department: fulfillment")).toBe("fulfillment");
    expect(normalizeTeamAlias("team:ops")).toBe("operations");

    expect(teamHubHref("INC", "sales")).toBe("/INC/teams/sales");
    expect(teamHubHref(null, "sales")).toBe("/teams/sales");

    expect(isTeamHubActive("/INC/teams/marketing", "marketing")).toBe(true);
    expect(isTeamHubActive("/INC/teams/marketing/", "marketing")).toBe(true);
    expect(isTeamHubActive("/INC/teams/marketing", "sales")).toBe(false);
    expect(isTeamHubActive("/INC/projects", "marketing")).toBe(false);
    expect(isTeamHubActive("/teams/operations", "operations")).toBe(true);
  });

  it("partitions the live 10-agent roster and future scaled/hyphenated agents cleanly across all 4 departments", () => {
    const liveAgents: Agent[] = [
      makeAgent({ id: "1", name: "Ads Auditor", urlKey: "ads-auditor", title: "Ads Auditor" }),
      makeAgent({ id: "2", name: "Ads checker", urlKey: "ads-checker", title: "Ads checker" }),
      makeAgent({ id: "3", name: "Video Editor", urlKey: "video-editor", title: "Video Editor" }),
      makeAgent({ id: "4", name: "Research Analyst", urlKey: "research-analyst", role: "researcher", title: "Research Analyst" }),
      makeAgent({ id: "5", name: "IR Sales Desk", urlKey: "ir-sales-desk", title: "Sales Operations Desk" }),
      makeAgent({ id: "6", name: "IR Client Support Desk", urlKey: "ir-client-support-desk", title: "Client Success & Support Desk" }),
      makeAgent({ id: "7", name: "Web Builder", urlKey: "web-builder", role: "engineer", title: "Web Builder" }),
      makeAgent({ id: "8", name: "Javar", urlKey: "javar", role: "ceo", title: "CEO" }),
      makeAgent({ id: "9", name: "Repo Engineer", urlKey: "repo-engineer", role: "engineer", title: "Cloud Repo Engineer" }),
      makeAgent({ id: "10", name: "Reviewer", urlKey: "reviewer", role: "qa", title: "Independent Reviewer" }),
      makeAgent({ id: "11", name: "Old Bot", urlKey: "old-bot", status: "terminated", title: "Sales Bot" }),
    ];

    expect(filterAgentsForTeam(liveAgents, "marketing").map((a) => a.name)).toEqual([
      "Ads Auditor",
      "Ads checker",
      "Research Analyst",
      "Video Editor",
    ]);
    expect(filterAgentsForTeam(liveAgents, "sales").map((a) => a.name)).toEqual(["IR Sales Desk"]);
    expect(filterAgentsForTeam(liveAgents, "fulfillment").map((a) => a.name)).toEqual([
      "IR Client Support Desk",
      "Web Builder",
    ]);
    expect(filterAgentsForTeam(liveAgents, "operations").map((a) => a.name)).toEqual([
      "Javar",
      "Repo Engineer",
      "Reviewer",
    ]);

    // Scaling future roles, hyphenated urlKeys, and explicit metadata
    expect(matchAgentTeams(makeAgent({ id: "s1", name: "Ad Ops", urlKey: "ad-ops", title: "Ad Ops" }))).toEqual(["marketing"]);
    expect(matchAgentTeams(makeAgent({ id: "s2", name: "Paid Media", urlKey: "media-buyer", title: "Meta Ads Manager" }))).toEqual(["marketing"]);
    expect(matchAgentTeams(makeAgent({ id: "s3", name: "Client Support", urlKey: "client-support", title: "Client Support" }))).toEqual(["fulfillment"]);
    expect(
      matchAgentTeams(
        makeAgent({
          id: "12",
          name: "Growth Closer",
          urlKey: "growth-closer",
          metadata: { teams: ["sales", "department: marketing"] },
        }),
      ),
    ).toEqual(["sales", "marketing"]);
  });

  it("deduplicates identical role and title subtitles", () => {
    expect(formatTeamAgentSubtitle("ceo", "CEO")).toBe("CEO");
    expect(formatTeamAgentSubtitle("engineer", "Cloud Repo Engineer")).toBe("Engineer · Cloud Repo Engineer");
  });

  it("routes active tasks accurately (including multi-team agents, prefixed projects, and marketing audits) and indexes current tasks in one pass", () => {
    const javar = makeAgent({ id: "javar", name: "Javar", urlKey: "javar", role: "ceo", title: "CEO" });
    const ads = makeAgent({ id: "ads", name: "Ads Auditor", urlKey: "ads-auditor", title: "Ads Auditor" });
    const shared = makeAgent({
      id: "shared",
      name: "Growth Closer",
      urlKey: "growth-closer",
      metadata: { teams: ["sales", "marketing"] },
    });
    const onboarding = makeProject({ id: "p-onb", name: "Client Onboarding — Acme" });
    const marketingProject = makeProject({ id: "p-mkt", name: "Marketing" });

    const issues: Issue[] = [
      makeIssue({
        id: "inc-110",
        identifier: "INC-110",
        title: "Setter tracking: daily grades from GHL + WAVV, EOD survey truth check",
        status: "in_review",
        assigneeAgentId: "javar",
      }),
      makeIssue({
        id: "inc-111",
        identifier: "INC-111",
        title: "[dept: marketing] Refresh hot tub video hooks",
        status: "in_progress",
        assigneeAgentId: "ads",
      }),
      makeIssue({
        id: "inc-112",
        identifier: "INC-112",
        title: "Client kickoff checklist",
        status: "todo",
        projectId: "p-onb",
      }),
      makeIssue({
        id: "inc-113",
        identifier: "INC-113",
        title: "Done sales task",
        status: "done",
      }),
      makeIssue({
        id: "inc-114",
        identifier: "INC-114",
        title: "Weekly leadership sync",
        status: "todo",
        assigneeAgentId: "javar",
      }),
      makeIssue({
        id: "inc-115",
        identifier: "INC-115",
        title: "Client ad account audit and Meta pixel check",
        status: "todo",
        assigneeAgentId: "shared",
      }),
    ];

    expect(filterTeamActiveTasks(issues, "sales", [onboarding], [javar, ads, shared]).map((i) => i.identifier)).toEqual([
      "INC-110",
    ]);
    expect(filterTeamActiveTasks(issues, "marketing", [onboarding], [javar, ads, shared]).map((i) => i.identifier)).toEqual([
      "INC-111",
      "INC-115",
    ]);
    expect(filterTeamActiveTasks(issues, "fulfillment", [onboarding], [javar, ads, shared]).map((i) => i.identifier)).toEqual([
      "INC-112",
    ]);
    expect(filterTeamActiveTasks(issues, "operations", [onboarding], [javar, ads, shared]).map((i) => i.identifier)).toEqual([
      "INC-114",
    ]);

    const taskMap = buildAgentCurrentTaskMap(issues);
    expect(taskMap.get("ads")?.identifier).toBe("INC-111");
    expect(taskMap.get("javar")?.identifier).toBe("INC-110");
    expect(taskMap.get("shared")?.identifier).toBe("INC-115");
    expect(findMatchingTeamProject([onboarding, marketingProject], "marketing")?.id).toBe("p-mkt");
    expect(findMatchingTeamProject([onboarding], "sales")).toBeNull();
  });

  it("maps the full human roster cleanly (including edge-case roles) and detects missing KPIs & disconnected source", () => {
    const board = {
      board: "human-employees",
      companyId: "c1",
      generatedAt: "2026-11-25T20:00:00Z",
      sources: [{ id: "team_capital", status: "connected" }],
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
            { id: "h1", cells: { name: "Anthony", role: "Media buyer", duties: "Meta media buying", judgedOn: "NOT SET - Alex to choose one number.", status: "active" } },
            { id: "h2", cells: { name: "Harold", role: "Video editor", duties: "Ad videos", judgedOn: "10 winning ads / mo", status: "active" } },
            { id: "h3", cells: { name: "Marvin", role: "Appointment setter", duties: "WAVV", judgedOn: "NOT SET", status: "active" } },
            { id: "h4", cells: { name: "Kat", role: "Fulfillment lead", duties: "Run fulfillment", judgedOn: "NOT SET", status: "active" } },
            { id: "h5", cells: { name: "Liri", role: "CSM - customer success", duties: "Client calls", judgedOn: "Churn < 3%", status: "active" } },
            { id: "h6", cells: { name: "Manny", role: "Owner - 50/50 partner (not an employee)", duties: "Operations", judgedOn: "Not tracked (owner).", status: "inactive" } },
            { id: "h7", cells: { name: "Sam", role: "Client Ads Support", duties: "Client support", judgedOn: "CSAT >= 95%", status: "active" } },
            { id: "h8", cells: { name: "Alex B", role: "Bookkeeper", duties: "Books", judgedOn: "Books closed by 5th", status: "active" } },
          ],
        },
      ],
    } as unknown as DashboardBoardWithMeta;

    expect(isMissingJudgedOn("NOT SET - Alex to choose one number.")).toBe(true);
    expect(isMissingJudgedOn("Churn < 3%")).toBe(false);
    expect(isTeamCapitalDisconnected(board)).toBe(false);
    expect(
      isTeamCapitalDisconnected({
        ...board,
        sources: [{ id: "team_capital", name: "Team & capital", status: "not_connected", detail: "", needed: "", lastSuccessfulSync: null }],
      }),
    ).toBe(true);

    const marketing = extractHumanMembersForTeam(board, "marketing");
    expect(marketing.map((m) => [m.name, m.judgedOnMissing])).toEqual([
      ["Anthony", true],
      ["Harold", false],
    ]);
    expect(extractHumanMembersForTeam(board, "sales").map((m) => m.name)).toEqual(["Marvin"]);
    expect(extractHumanMembersForTeam(board, "fulfillment").map((m) => m.name)).toEqual(["Kat", "Liri", "Sam"]);
    expect(extractHumanMembersForTeam(board, "operations").map((m) => [m.name, m.isOwner])).toEqual([
      ["Alex B", false],
      ["Manny", true],
    ]);
  });

  it("uses the fulfillment aggregate rather than the capped client table, including zero and older responses", () => {
    const board = {
      clients: Array.from({ length: 10 }, (_, index) => ({ clientKey: `client-${index}` })),
      openClientTasks: { total: 11, unassigned: 0 },
      onboarding: { openSteps: 0 },
      retention: { churnMonthly: { value: null, target: "< 3%" } },
      clientsWithOpenWork: 11,
    } as unknown as DashboardFulfillmentBoard;
    const clientKpi = (value: DashboardFulfillmentBoard) =>
      selectFulfillmentKpis(value).find((kpi) => kpi.id === "clients-with-open-work");

    expect(clientKpi(board)?.value).toBe("11");
    expect(clientKpi({ ...board, clientsWithOpenWork: 0 })?.value).toBe("0");
    const { clientsWithOpenWork: _count, ...olderBoard } = board;
    expect(clientKpi(olderBoard)).toMatchObject({ value: "—", tone: "muted", detail: "Awaiting total count" });
  });

  it("counts a pending budget override once while retaining its budget subtotal", () => {
    const summary = {
      agents: { active: 0, running: 0, paused: 1, error: 0 },
      tasks: { inProgress: 0, open: 0, blocked: 0 },
      costs: { monthSpendCents: 0, monthBudgetCents: 0, monthUtilizationPercent: 0 },
      pendingApprovals: 1,
      budgets: { pendingApprovals: 1 },
    } as DashboardSummary;
    const pendingKpi = (value: DashboardSummary) =>
      selectOperationsKpis(value).find((kpi) => kpi.id === "pending-approvals");

    expect(pendingKpi(summary)).toMatchObject({
      value: "1", detail: "1 budget overrides awaiting review", tone: "warning",
    });
    expect(pendingKpi({ ...summary, pendingApprovals: 2 })?.value).toBe("2");
    expect(pendingKpi({ ...summary, pendingApprovals: 0, budgets: { ...summary.budgets, pendingApprovals: 0 } }))
      .toMatchObject({ value: "0", tone: "default" });
  });

  it("extracts compact 4-card headline KPIs from existing live dashboard payloads without recomputing", () => {
    const marketingBoard = {
      tiles: [
        { id: "ad-spend", label: "Ad spend", value: { kind: "live", value: 37081.02, unit: "usd", observedAt: "2026-11-25T20:00:00Z" } },
        { id: "new-leads", label: "New leads", value: { kind: "live", value: 727, unit: "count", observedAt: "2026-11-25T20:00:00Z" } },
        { id: "cost-per-lead", label: "Cost per lead", value: { kind: "live", value: 51.01, unit: "usd", observedAt: "2026-11-25T20:00:00Z" } },
        { id: "ctr", label: "CTR", value: { kind: "live", value: 1.47, unit: "percent", observedAt: "2026-11-25T20:00:00Z" } },
      ],
    } as unknown as DashboardBoard;
    expect(selectMarketingKpis(marketingBoard).map((k) => [k.label, k.value])).toEqual([
      ["Ad spend", "$37,081.02"],
      ["New leads", "727"],
      ["Cost per lead", "$51.01"],
      ["CTR", "1.47%"],
    ]);

    const salesBoard = {
      tiles: [
        { id: "dials", label: "Dials", value: { kind: "live", value: 982, unit: "count", observedAt: "2026-11-25T20:00:00Z" } },
        { id: "conversations-over-60s", label: "Conversations over 60 s", value: { kind: "live", value: 10, unit: "count", observedAt: "2026-11-25T20:00:00Z" } },
        { id: "talk-time", label: "Talk time", value: { kind: "live", value: 67, unit: "minutes", observedAt: "2026-11-25T20:00:00Z" } },
        { id: "units-sold", label: "Units sold", value: { kind: "not_connected" } },
      ],
    } as unknown as DashboardBoard;
    expect(selectSalesKpis(salesBoard).map((k) => [k.id, k.value, k.tone])).toEqual([
      ["dials", "982", "default"],
      ["conversations-over-60s", "10", "default"],
      ["talk-time", "67 min", "default"],
      ["units-sold", "—", "muted"],
    ]);

    const fulfillmentBoard = {
      openClientTasks: { total: 4, unassigned: 1 },
      clientsWithOpenWork: 2,
      clients: [{ clientKey: "c1" }, { clientKey: "c2" }],
      onboarding: { openSteps: 2 },
      retention: { churnMonthly: { value: null, target: "< 3%" } },
    } as unknown as DashboardFulfillmentBoard;
    expect(selectFulfillmentKpis(fulfillmentBoard).map((k) => [k.label, k.value])).toEqual([
      ["Open client tasks", "4"],
      ["Clients with open work", "2"],
      ["Open onboarding steps", "2"],
      ["Unassigned open tasks", "1"],
    ]);

    const opsSummary = {
      agents: { active: 10, running: 0, paused: 0, error: 0 },
      tasks: { open: 1, inProgress: 0, blocked: 0, done: 41 },
      costs: { monthSpendCents: 10975, monthBudgetCents: 20000, monthUtilizationPercent: 54.87 },
      pendingApprovals: 1,
      budgets: { activeIncidents: 0, pendingApprovals: 0, pausedAgents: 0, pausedProjects: 0 },
    } as unknown as DashboardSummary;
    expect(selectOperationsKpis(opsSummary).map((k) => [k.label, k.value])).toEqual([
      ["Agents enabled", "10"],
      ["Tasks in progress", "0"],
      ["Month AI spend", "$109.75"],
      ["Pending approvals", "1"],
    ]);
  });
});
