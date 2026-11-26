import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agents,
  approvals,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
  issueLabels,
  issues,
  labels,
  plugins,
  projects,
  routineRuns,
  routines,
  toolApplications,
  toolConnections,
  toolInvocations,
} from "@paperclipai/db";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
type Db = ReturnType<typeof createDb>;
let dashboardBoardRoutes: typeof import("../routes/dashboard-boards.js").dashboardBoardRoutes;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

async function createApp(
  db: Db,
  actor: Express.Request["actor"] = { type: "board", userId: "user-1", source: "local_implicit" } as Express.Request["actor"],
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", dashboardBoardRoutes(db));
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status ?? 500).json({ error: error.message ?? "Internal server error" });
  });
  return app;
}

describePostgres("lane 3 dashboard board routes", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;
  let companyId!: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ["SALES_DASHBOARD_ADMIN_KEY", "GATEWAY_ADMIN_KEY", "GATEWAY_PAPERCLIP_KEY", "GATEWAY_WAVV_KEY"] as const) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  beforeAll(async () => {
    ({ dashboardBoardRoutes } = await import("../routes/dashboard-boards.js"));
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-lane3-dashboards-");
    db = createDb(tempDb.connectionString);
    app = await createApp(db);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterEach(async () => {
    for (const key of ["SALES_DASHBOARD_ADMIN_KEY", "GATEWAY_ADMIN_KEY", "GATEWAY_PAPERCLIP_KEY", "GATEWAY_WAVV_KEY"] as const) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await db.delete(costEvents);
    await db.delete(toolInvocations);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(plugins);
    await db.delete(routineRuns);
    await db.delete(routines);
    await db.delete(issueLabels);
    await db.delete(labels);
    await db.delete(approvals);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => tempDb?.cleanup());

  async function seed() {
    const now = new Date();
    const company = await db.insert(companies).values({
      name: "Lane 3 Co",
      issuePrefix: `L3${randomUUID().slice(0, 6).toUpperCase()}`,
      budgetMonthlyCents: 20_000,
    }).returning().then((rows) => rows[0]!);
    companyId = company.id;

    const [seatA, seatB] = await db.insert(agents).values([
      {
        companyId: company.id,
        name: "Atlas",
        role: "engineer",
        status: "running",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { enabled: true, intervalSec: 900 } },
        budgetMonthlyCents: 2_000,
        lastHeartbeatAt: new Date(now.getTime() - 2 * 60 * 1000),
      },
      {
        companyId: company.id,
        name: "Bolt",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        budgetMonthlyCents: 0,
      },
    ]).returning();

    const project = await db.insert(projects).values({
      companyId: company.id,
      name: "Acme",
      status: "in_progress",
    }).returning().then((rows) => rows[0]!);

    const [doneIssue, , , onboardingIssue, supportIssue] = await db.insert(issues).values([
      {
        companyId: company.id,
        identifier: `${company.issuePrefix}-1`,
        title: "Done task",
        status: "done",
        projectId: project.id,
        assigneeAgentId: seatA.id,
        completedAt: new Date(now.getTime() - HOUR_MS),
      },
      {
        companyId: company.id,
        identifier: `${company.issuePrefix}-2`,
        title: "Blocked task",
        status: "blocked",
        projectId: project.id,
        assigneeAgentId: seatA.id,
        blockedTransitionAt: new Date(now.getTime() - 30 * HOUR_MS),
        createdAt: new Date(now.getTime() - 40 * HOUR_MS),
      },
      {
        companyId: company.id,
        identifier: `${company.issuePrefix}-3`,
        title: "Open task",
        status: "todo",
        projectId: project.id,
        assigneeAgentId: seatB.id,
        createdAt: new Date(now.getTime() - 5 * HOUR_MS),
      },
      {
        companyId: company.id,
        identifier: `${company.issuePrefix}-4`,
        title: "Onboarding: send agreement",
        status: "todo",
        createdAt: new Date(now.getTime() - 8 * HOUR_MS),
      },
      {
        companyId: company.id,
        identifier: `${company.issuePrefix}-5`,
        title: "Client wants a report change",
        status: "todo",
        createdAt: new Date(now.getTime() - 50 * HOUR_MS),
      },
    ]).returning();

    const [onboardingLabel, supportLabel] = await db.insert(labels).values([
      { companyId: company.id, name: "Onboarding", color: "blue" },
      { companyId: company.id, name: "Support", color: "red" },
    ]).returning();
    await db.insert(issueLabels).values([
      { companyId: company.id, issueId: onboardingIssue.id, labelId: onboardingLabel.id },
      { companyId: company.id, issueId: supportIssue.id, labelId: supportLabel.id },
    ]);

    await db.insert(costEvents).values([
      {
        companyId: company.id,
        agentId: seatA.id,
        issueId: doneIssue.id,
        provider: "anthropic",
        biller: "anthropic",
        model: "claude-test",
        costCents: 500,
        occurredAt: new Date(now.getTime() - 60_000),
      },
      {
        companyId: company.id,
        agentId: seatA.id,
        provider: "anthropic",
        biller: "anthropic",
        model: "claude-test",
        costCents: 300,
        occurredAt: new Date(now.getTime() - 120_000),
      },
      {
        companyId: company.id,
        agentId: seatA.id,
        provider: "anthropic",
        biller: "anthropic",
        model: "claude-test",
        costCents: 200,
        occurredAt: new Date(now.getTime() - 180_000),
      },
      {
        companyId: company.id,
        agentId: seatB.id,
        provider: "openrouter",
        biller: "openrouter",
        model: "test-model",
        costCents: 100,
        occurredAt: new Date(now.getTime() - 240_000),
      },
    ]);

    await db.insert(heartbeatRuns).values([
      {
        companyId: company.id,
        agentId: seatA.id,
        status: "failed",
        error: "provider quota",
        createdAt: new Date(now.getTime() - HOUR_MS),
      },
      {
        companyId: company.id,
        agentId: seatA.id,
        status: "timed_out",
        errorCode: "timeout",
        createdAt: new Date(now.getTime() - 2 * HOUR_MS),
      },
    ]);

    const routine = await db.insert(routines).values({
      companyId: company.id,
      title: "Daily ad check",
      status: "active",
      assigneeAgentId: seatA.id,
    }).returning().then((rows) => rows[0]!);
    await db.insert(routineRuns).values([
      {
        companyId: company.id,
        routineId: routine.id,
        source: "schedule",
        status: "completed",
        createdAt: new Date(now.getTime() - 2 * DAY_MS),
        completedAt: new Date(now.getTime() - 2 * DAY_MS + HOUR_MS),
      },
      {
        companyId: company.id,
        routineId: routine.id,
        source: "schedule",
        status: "failed",
        failureReason: "gateway timeout",
        createdAt: new Date(now.getTime() - DAY_MS),
      },
    ]);

    await db.insert(approvals).values({
      companyId: company.id,
      type: "budget_increase",
      status: "pending",
      payload: {},
      createdAt: new Date(now.getTime() - 30 * HOUR_MS),
    });

    await db.insert(plugins).values({
      pluginKey: "test-plugin",
      packageName: "@paperclipai/test-plugin",
      version: "1.2.3",
      status: "ready",
      manifestJson: {} as never,
    });

    const application = await db.insert(toolApplications).values({
      companyId: company.id,
      name: "Meta Ads",
      type: "mcp_http",
      status: "active",
    }).returning().then((rows) => rows[0]!);
    const connection = await db.insert(toolConnections).values({
      companyId: company.id,
      applicationId: application.id,
      name: "Meta Ads MCP",
      uid: "meta-ads",
      transport: "mcp_remote",
      authKind: "oauth",
      status: "active",
      healthStatus: "degraded",
      healthMessage: "token expires soon",
      healthCheckedAt: new Date(now.getTime() - HOUR_MS),
      config: { expiresAt: new Date(now.getTime() + 10 * DAY_MS).toISOString() },
    }).returning().then((rows) => rows[0]!);
    await db.insert(toolInvocations).values({
      companyId: company.id,
      connectionId: connection.id,
      toolName: "list_campaigns",
      status: "succeeded",
      completedAt: new Date(now.getTime() - 20 * 60 * 1000),
    });
  }

  it("returns AI cost by seat from real cost events and caps", async () => {
    await seed();
    const response = await request(app).get(`/api/companies/${companyId}/dashboards/ai-cost`).expect(200);
    expect(response.body.company.spendMonthToDateCents).toBe(1100);
    expect(response.body.company.spendTodayCents).toBe(1100);
    expect(response.body.company.utilizationPercent).toBe(5.5);

    const atlas = response.body.seats.find((seat: { name: string }) => seat.name === "Atlas");
    expect(atlas.spendTodayCents).toBe(1000);
    expect(atlas.spend7dCents).toBe(1000);
    expect(atlas.spendMonthToDateCents).toBe(1000);
    expect(atlas.utilizationPercent).toBe(50);
    expect(atlas.overEightyPercent).toBe(false);
    expect(atlas.completedTasksMonth).toBe(1);
    expect(atlas.costPerCompletedTaskCents).toBe(500);

    const bolt = response.body.seats.find((seat: { name: string }) => seat.name === "Bolt");
    expect(bolt.budgetMonthlyCents).toBe(0);
    expect(bolt.utilizationPercent).toBeNull();
    expect(response.body.seatsWithoutCap).toBe(1);
    expect(response.body.completedTasksMonth).toBe(1);
    expect(response.body.costPerCompletedTaskCents).toBe(500);
    expect(response.body.topCostDrivers[0]).toMatchObject({
      provider: "anthropic",
      model: "claude-test",
      spendMonthToDateCents: 1000,
    });
  });

  it("adds the v2 output-unit and workflow numbers without inventing a denominator", async () => {
    await seed();
    const response = await request(app).get(`/api/companies/${companyId}/dashboards/ai-cost`).expect(200);

    expect(response.body.outputUnit.spendMonthToDateCents).toBe(1100);
    expect(response.body.outputUnit.outputUnitsMonth).toBeNull();
    expect(response.body.outputUnit.costPerOutputUnitCents).toBeNull();
    expect(response.body.outputUnit.target).toContain("fall as volume rises");
    expect(response.body.outputUnit.notConnected.source).toContain("Client output count");

    expect(response.body.workflowCoverage.totalAutomated).toBe(1);
    expect(response.body.workflowCoverage.listedTasksTotal).toBeNull();
    expect(response.body.workflowCoverage.automatedPercent).toBeNull();
    expect(response.body.workflowCoverage.notConnected.source).toContain("task inventory");

    const atlas = response.body.workflowCoverage.seats.find((seat: { name: string }) => seat.name === "Atlas");
    expect(atlas.automatedTasks).toBe(1);
    expect(atlas.listedTasks).toBeNull();
    expect(atlas.automatedPercent).toBeNull();

    const bolt = response.body.workflowCoverage.seats.find((seat: { name: string }) => seat.name === "Bolt");
    expect(bolt.automatedTasks).toBe(0);
  });

  it("returns automation health from seats, runs, routines, blocked tasks and approvals", async () => {
    await seed();
    const response = await request(app)
      .get(`/api/companies/${companyId}/dashboards/automation-health`)
      .expect(200);

    const atlas = response.body.seats.find((seat: { name: string }) => seat.name === "Atlas");
    expect(atlas.status).toBe("running");
    expect(atlas.heartbeatEnabled).toBe(true);
    expect(atlas.heartbeatIntervalSec).toBe(900);
    expect(atlas.lastRunStatus).toBe("failed");
    expect(atlas.failedRuns24h).toBe(1);
    expect(atlas.timedOutRuns24h).toBe(1);

    const bolt = response.body.seats.find((seat: { name: string }) => seat.name === "Bolt");
    expect(bolt.heartbeatEnabled).toBe(false);

    expect(response.body.blockedTasks.count).toBe(1);
    expect(response.body.blockedTasks.oldestAgeHours).toBeGreaterThanOrEqual(29);
    expect(response.body.approvals.pendingCount).toBe(1);
    expect(response.body.approvals.oldestAgeHours).toBeGreaterThanOrEqual(29);

    expect(response.body.routines.total).toBe(1);
    expect(response.body.routines.runs7d).toBe(2);
    expect(response.body.routines.completed7d).toBe(1);
    expect(response.body.routines.failed7d).toBe(1);
    expect(response.body.routines.successRate7d).toBe(50);
    expect(response.body.routines.items[0].lastRunStatus).toBe("failed");
    expect(response.body.routines.items[0].lastRunResult).toBe("gateway timeout");

    expect(response.body.server.databaseProbe).toBe("ok");
    expect(response.body.server.status).toBe("ok");
  });

  it("returns every connector with health, last use and explicit expiry state", async () => {
    await seed();
    const response = await request(app)
      .get(`/api/companies/${companyId}/dashboards/tools-connectors`)
      .expect(200);

    expect(response.body.summary.total).toBeGreaterThanOrEqual(3);
    expect(response.body.summary.needsAttention).toBe(1);
    expect(response.body.summary.expiringWithin14Days).toBe(1);
    expect(response.body.summary.expiryUnknown).toBeGreaterThanOrEqual(1);

    const connection = response.body.items.find((item: { id: string }) => item.id.startsWith("connection:"));
    expect(connection).toMatchObject({
      name: "Meta Ads MCP",
      kind: "tool_connection",
      health: "degraded",
      status: "active",
    });
    expect(connection.lastSuccessfulUseAt).not.toBeNull();
    expect(connection.expiryDaysRemaining).toBeGreaterThan(9);
    expect(connection.expiryDaysRemaining).toBeLessThan(11);

    const plugin = response.body.items.find((item: { kind: string }) => item.kind === "plugin");
    expect(plugin.name).toBe("test-plugin");
    expect(plugin.expiresAt).toBeNull();
  });

  it("scopes fulfillment work by project and states what has no source", async () => {
    await seed();
    const response = await request(app)
      .get(`/api/companies/${companyId}/dashboards/fulfillment`)
      .expect(200);

    expect(response.body.clients).toHaveLength(1);
    expect(response.body.clients[0]).toMatchObject({
      clientName: "Acme",
      openTasks: 2,
      blockedTasks: 1,
    });
    expect(response.body.openClientTasks.total).toBe(2);
    expect(response.body.openClientTasks.unassigned).toBe(2);

    expect(response.body.onboarding.openSteps).toBe(1);
    expect(response.body.onboarding.overdue.source).toContain("onboarding due dates");
    expect(response.body.onboarding.items[0].title).toContain("Onboarding");

    expect(response.body.support.waiting).toBe(1);
    expect(response.body.support.matchedLabels).toContain("Support");
    expect(response.body.support.items[0].ageHours).toBeGreaterThanOrEqual(49);
    expect(response.body.notConnected.some((tile: { tile: string }) => tile.tile === "ghl-conversations")).toBe(true);
  });

  it("puts Hormozi's four retention numbers first and states the missing source instead of guessing", async () => {
    await seed();
    const response = await request(app)
      .get(`/api/companies/${companyId}/dashboards/fulfillment`)
      .expect(200);

    expect(response.body.retention.churnMonthly.value).toBeNull();
    expect(response.body.retention.churnMonthly.unit).toBe("percent");
    expect(response.body.retention.churnMonthly.target).toContain("< 3%");
    expect(response.body.retention.churnMonthly.cite).toContain("U_s0ek");
    expect(response.body.retention.churnMonthly.notConnected.source).toContain("GHL");

    expect(response.body.retention.saleToOnboarding.value).toBeNull();
    expect(response.body.retention.saleToOnboarding.unit).toBe("days");
    expect(response.body.retention.saleToOnboarding.notConnected.source).toContain("close date");

    expect(response.body.retention.earlyBackout.windows.map((window: { hours: number }) => window.hours))
      .toEqual([24, 48, 72]);
    expect(response.body.retention.earlyBackout.windows.every(
      (window: { valuePercent: number | null }) => window.valuePercent === null,
    )).toBe(true);
    expect(response.body.retention.earlyBackout.notConnected.source).toContain("GHL");

    expect(response.body.retention.reviewByDay30.value).toBeNull();
    expect(response.body.retention.reviewByDay30.notConnected.source).toContain("Google Business Profile");
  });

  it("keeps two clients with the same name separate", async () => {
    const company = await db.insert(companies).values({
      name: "Duplicate names",
      issuePrefix: `D${randomUUID().slice(0, 6).toUpperCase()}`,
    }).returning().then((rows) => rows[0]!);
    companyId = company.id;
    const [first, second] = await db.insert(projects).values([
      { companyId: company.id, name: "Acme", status: "in_progress" },
      { companyId: company.id, name: "Acme", status: "in_progress" },
    ]).returning();
    await db.insert(issues).values([
      { companyId: company.id, title: "First client task", status: "todo", projectId: first.id },
      { companyId: company.id, title: "Second client task", status: "todo", projectId: second.id },
      { companyId: company.id, title: "Second client task 2", status: "todo", projectId: second.id },
    ]);

    const response = await request(app)
      .get(`/api/companies/${companyId}/dashboards/fulfillment`)
      .expect(200);

    expect(response.body.clients).toHaveLength(2);
    expect(response.body.clients.map((client: { clientKey: string }) => client.clientKey).sort())
      .toEqual([first.id, second.id].sort());
    expect(response.body.clients.map((client: { openTasks: number }) => client.openTasks).sort())
      .toEqual([1, 2]);
  });

  it("rejects cross-company agent keys with 403 on all four lane 3 endpoints", async () => {
    await seed();
    const otherCompanyAgentApp = await createApp(db, {
      type: "agent",
      agentId: randomUUID(),
      companyId: randomUUID(),
      source: "agent_key",
    } as Express.Request["actor"]);

    for (const board of ["ai-cost", "automation-health", "tools-connectors", "fulfillment"]) {
      const res = await request(otherCompanyAgentApp).get(`/api/companies/${companyId}/dashboards/${board}`);
      expect(res.status).toBe(403);
    }
  });

  it("redacts raw run errors and hides instance-wide plugins from same-company agent keys", async () => {
    await seed();
    const sameCompanyAgentApp = await createApp(db, {
      type: "agent",
      agentId: randomUUID(),
      companyId,
      source: "agent_key",
    } as Express.Request["actor"]);

    const healthRes = await request(sameCompanyAgentApp).get(`/api/companies/${companyId}/dashboards/automation-health`);
    expect(healthRes.status).toBe(200);
    for (const seat of healthRes.body.seats) {
      expect(seat.errorReason).toBeNull();
      expect(seat.lastRunError).toBeNull();
    }
    for (const routine of healthRes.body.routines.items) {
      expect(routine.lastRunResult === null || ["completed", "failed", "running", "queued"].includes(routine.lastRunResult)).toBe(true);
    }

    const toolsRes = await request(sameCompanyAgentApp).get(`/api/companies/${companyId}/dashboards/tools-connectors`);
    expect(toolsRes.status).toBe(200);
    expect(toolsRes.body.items.filter((item: { kind: string }) => item.kind === "plugin")).toEqual([]);
    for (const conn of toolsRes.body.items.filter((item: { kind: string }) => item.kind === "tool_connection")) {
      expect(conn.healthMessage).toBeNull();
    }
  });

  it("surfaces Meta system user token Dec 13 expiry alarm for board viewers when SALES_DASHBOARD_ADMIN_KEY is set", async () => {
    await seed();
    process.env.SALES_DASHBOARD_ADMIN_KEY = "test-dash-key";
    const res = await request(app).get(`/api/companies/${companyId}/dashboards/tools-connectors`).expect(200);
    const metaRow = res.body.items.find((item: { id: string }) => item.id === "ir:meta-marketing-system-user");
    expect(metaRow).toMatchObject({
      name: "Meta Marketing API (System User Token)",
      kind: "tool_connection",
      expiresAt: "2026-12-13T00:00:00.000Z",
    });
    expect(typeof metaRow.expiryDaysRemaining).toBe("number");
  });

  it("surfaces client portfolio ad metrics & WAVV delivery on Fulfillment for board admins (excluding __owner__) and gates them away from agent keys", async () => {
    await seed();
    const fulfillmentDeps = {
      portfolioReader: async () => ({
        capital: null,
        snapshots: null,
        neonAccounts: null,
        neonPipeline: null,
        observedAt: "2026-11-26T05:00:00.000Z",
        clients: [
          {
            slug: "__owner__",
            displayName: "HTL",
            observedAt: "2026-11-26T05:00:00.000Z",
            newLeads: 18,
            booked: 0,
            showed: 0,
            pitched: 0,
            wonDeals: 0,
            showRate: null,
            closeRate: null,
            pipelineRevenueUsd: null,
            cashCollectedUsd: 0,
            speedToLeadSeconds: null,
            spend: 999,
            impressions: 1000,
            clicks: 50,
            cpl: 55.5,
            cac: null,
            roas: null,
            costPerHeldAppointment: null,
            zeroLeadDays: 0,
          },
          {
            slug: "paradise-spas",
            displayName: "Paradise Spas",
            observedAt: "2026-11-26T05:00:00.000Z",
            newLeads: 50,
            booked: 12,
            showed: 9,
            pitched: 8,
            wonDeals: 3,
            showRate: 75,
            closeRate: 37.5,
            pipelineRevenueUsd: 30000,
            cashCollectedUsd: 15000,
            speedToLeadSeconds: 40,
            spend: 6650,
            impressions: 200000,
            clicks: 3000,
            cpl: 133,
            cac: 2216.67,
            roas: 4.51,
            costPerHeldAppointment: 738.89,
            zeroLeadDays: 0,
          },
        ],
      }),
      wavvReader: async () => ({
        observedAt: "2026-11-26T05:00:00.000Z",
        dials: 420,
        conversationsOver60s: 19,
        talkTimeMinutes: 94.5,
        bySetter: [{ id: "u1", setter: "Marvin", dials: 420, talkTimeMinutes: 94.5, conversationsOver60s: 19 }],
      }),
    };

    const adminApp = express();
    adminApp.use(express.json());
    adminApp.use((req, _res, next) => {
      req.actor = { type: "board", userId: "admin-1", source: "session", isInstanceAdmin: true, companyIds: [companyId] } as Express.Request["actor"];
      next();
    });
    adminApp.use("/api", dashboardBoardRoutes(db, { fulfillmentDeps }));

    const adminRes = await request(adminApp).get(`/api/companies/${companyId}/dashboards/fulfillment?period=30d`).expect(200);
    // __owner__ ($999 spend, 18 leads) MUST be excluded; only Paradise Spas is summed!
    expect(adminRes.body.clientDelivery.adSpendUsd).toBe(6650);
    expect(adminRes.body.clientDelivery.newLeads).toBe(50);
    expect(adminRes.body.clientDelivery.costPerLeadUsd).toBe(133);
    expect(adminRes.body.clientDelivery.ctrPercent).toBe(1.5);
    expect(adminRes.body.clientDelivery.accounts.map((a: { slug: string }) => a.slug)).toEqual(["paradise-spas"]);
    expect(adminRes.body.wavvDelivery.dials).toBe(420);
    expect(adminRes.body.wavvDelivery.conversationsOver60s).toBe(19);
    expect(adminRes.body.wavvDelivery.talkTimeMinutes).toBe(94.5);

    const agentApp = express();
    agentApp.use(express.json());
    agentApp.use((req, _res, next) => {
      req.actor = { type: "agent", agentId: randomUUID(), companyId, source: "agent_key" } as Express.Request["actor"];
      next();
    });
    agentApp.use("/api", dashboardBoardRoutes(db, { fulfillmentDeps }));

    const agentRes = await request(agentApp).get(`/api/companies/${companyId}/dashboards/fulfillment?period=30d`).expect(200);
    expect(agentRes.body.clientDelivery.adSpendUsd).toBeNull();
    expect(agentRes.body.clientDelivery.accounts).toEqual([]);
    expect(agentRes.body.wavvDelivery.dials).toBeNull();
  });
});
