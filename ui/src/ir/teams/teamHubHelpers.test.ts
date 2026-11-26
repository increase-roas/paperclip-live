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
  buildNextAgentDepartmentsMetadata,
  extractHumanMembersForTeam,
  filterAgentsForTeam,
  filterTeamActiveTasks,
  findMatchingTeamProject,
  formatTeamAgentSubtitle,
  getSharedAgentDepartments,
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

  it("supports multi-team agent membership (departments: string[]) across Marketing and Fulfillment without duplicating records", () => {
    const liveAgents: Agent[] = [
      makeAgent({ id: "1", name: "Ads Auditor", urlKey: "ads-auditor", title: "Ads Auditor", metadata: { departments: ["marketing", "fulfillment"] } }),
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
    // Ads Auditor, Ads checker, Research Analyst, Video Editor support BOTH marketing & fulfillment
    expect(filterAgentsForTeam(liveAgents, "fulfillment").map((a) => a.name)).toEqual([
      "Ads Auditor",
      "Ads checker",
      "IR Client Support Desk",
      "Research Analyst",
      "Video Editor",
      "Web Builder",
    ]);
    expect(filterAgentsForTeam(liveAgents, "operations").map((a) => a.name)).toEqual([
      "Javar",
      "Repo Engineer",
      "Reviewer",
    ]);

    expect(getSharedAgentDepartments(liveAgents[0]!, "marketing")).toEqual(["fulfillment"]);
    expect(getSharedAgentDepartments(liveAgents[0]!, "fulfillment")).toEqual(["marketing"]);
    expect(getSharedAgentDepartments(liveAgents[4]!, "sales")).toEqual([]);

    // Explicit metadata preserves unrelated keys and normalizes departments canonically
    const nextMeta = buildNextAgentDepartmentsMetadata(
      makeAgent({
        id: "m1",
        name: "Ads Auditor",
        urlKey: "ads-auditor",
        metadata: { bot: { transport: "hermes_gateway" }, department: "marketing" },
      }),
      ["fulfillment", "marketing"],
    );
    expect(nextMeta).toEqual({
      bot: { transport: "hermes_gateway" },
      departments: ["marketing", "fulfillment"],
    });

    // Scaling future roles, hyphenated urlKeys, and explicit metadata
    expect(matchAgentTeams(makeAgent({ id: "s1", name: "Ad Ops", urlKey: "ad-ops", title: "Ad Ops" }))).toEqual([
      "marketing",
      "fulfillment",
    ]);
    expect(matchAgentTeams(makeAgent({ id: "s2", name: "Paid Media", urlKey: "media-buyer", title: "Meta Ads Manager" }))).toEqual([
      "marketing",
      "fulfillment",
    ]);
    expect(matchAgentTeams(makeAgent({ id: "s3", name: "Client Support", urlKey: "client-support", title: "Client Support" }))).toEqual(["fulfillment"]);
    expect(
      matchAgentTeams(
        makeAgent({
          id: "12",
          name: "Growth Closer",
          urlKey: "growth-closer",
          metadata: { departments: ["sales", "department: marketing"] },
        }),
      ),
    ).toEqual(["marketing", "sales"]);
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
        { id: "new-leads", label: "Agency new leads", value: { kind: "live", value: 33, unit: "count", observedAt: "2026-11-25T20:00:00Z" } },
        { id: "active-opportunities", label: "Active opportunities", value: { kind: "live", value: 16, unit: "count", observedAt: "2026-11-25T20:00:00Z" } },
        { id: "show-rate", label: "Show rate", value: { kind: "not_connected" } },
        { id: "units-sold", label: "Units sold", value: { kind: "live", value: 2, unit: "count", observedAt: "2026-11-25T20:00:00Z" } },
      ],
    } as unknown as DashboardBoard;
    expect(selectSalesKpis(salesBoard).map((k) => [k.id, k.value, k.tone])).toEqual([
      ["new-leads", "33", "default"],
      ["active-opportunities", "16", "default"],
      ["show-rate", "—", "muted"],
      ["units-sold", "2", "default"],
    ]);

    const fulfillmentBoard = {
      openClientTasks: { total: 4, unassigned: 1 },
      clients: [{ clientKey: "c1" }, { clientKey: "c2" }],
      onboarding: { openSteps: 2 },
      retention: { churnMonthly: { value: null, target: "< 3%" } },
      clientDelivery: {
        period: "30d",
        observedAt: "2026-11-26T05:00:00Z",
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
        accounts: [{ slug: "paradise-spas" }, { slug: "sun-pool" }],
        notConnected: null,
      },
      wavvDelivery: {
        period: "30d",
        observedAt: "2026-11-26T05:00:00Z",
        dials: 982,
        conversationsOver60s: 10,
        talkTimeMinutes: 67,
        bySetter: [],
        notConnected: null,
      },
    } as unknown as DashboardFulfillmentBoard;
    expect(selectFulfillmentKpis(fulfillmentBoard).map((k) => [k.id, k.value])).toEqual([
      ["client-ad-spend", "$6,807.00"],
      ["client-new-leads", "55"],
      ["client-cost-per-lead", "$123.76"],
      ["client-ctr", "1.59%"],
      ["wavv-dials", "982"],
      ["wavv-conversations", "10"],
      ["wavv-talk-time", "67 min"],
      ["open-client-tasks", "4"],
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
