import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  routineTriggers,
  routines,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
type Db = ReturnType<typeof createDb>;

const boardActor = (
  companyId: string,
  options: { instanceAdmin?: boolean; source?: "local_implicit" | "session" } = {},
): Express.Request["actor"] => ({
  type: "board",
  userId: "board-user",
  userName: "Board User",
  userEmail: null,
  isInstanceAdmin: options.instanceAdmin ?? true,
  source: options.source ?? "local_implicit",
  companyIds: [companyId],
});

async function createCompany(db: Db, label: string) {
  return db
    .insert(companies)
    .values({ name: `${label} ${randomUUID()}`, issuePrefix: `B${randomUUID().slice(0, 6).toUpperCase()}` })
    .returning()
    .then((rows) => rows[0]!);
}

async function createCompanyNamed(db: Db, name: string) {
  return db
    .insert(companies)
    .values({ name, issuePrefix: `B${randomUUID().slice(0, 6).toUpperCase()}` })
    .returning()
    .then((rows) => rows[0]!);
}

async function createAgent(db: Db, companyId: string, overrides: Partial<typeof agents.$inferInsert> = {}) {
  return db
    .insert(agents)
    .values({
      companyId,
      name: `Bot ${randomUUID().slice(0, 6)}`,
      role: "general",
      title: "Bot",
      status: "idle",
      adapterType: "hermes_gateway",
      adapterConfig: { hermesProfile: "research" },
      runtimeConfig: {},
      budgetMonthlyCents: 5000,
      ...overrides,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createApp(db: Db, actor: Express.Request["actor"]) {
  const { botsRoutes } = await import("../routes/bots.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", botsRoutes(db));
  app.use((error: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status ?? 500).json({ error: error.message });
  });
  return app;
}

describePostgres("bots", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-bots-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(activityLog);
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => tempDb?.cleanup());

  it("lists agent bots with their gateway link and hides plain agents", async () => {
    const company = await createCompany(db, "Bots");
    await createAgent(db, company.id, {
      name: "Research Analyst",
      title: "Research Analyst",
      metadata: {
        grokBotTwin: true,
        bot: {
          purpose: "Researches accounts and markets with GBrain.",
          gateway: { keyId: "gk_live_research", policy: "researcher", provider: "increase-roas-oauth-gateway" },
        },
      },
    });
    await createAgent(db, company.id, { name: "Plain Agent", metadata: null });

    const app = await createApp(db, boardActor(company.id));
    const response = await request(app).get(`/api/companies/${company.id}/bots`).expect(200);

    const names = response.body.bots.map((bot: { name: string }) => bot.name);
    expect(names).toContain("Research Analyst");
    expect(names).not.toContain("Plain Agent");

    const research = response.body.bots.find((bot: { name: string }) => bot.name === "Research Analyst");
    expect(research).toMatchObject({
      kind: "agent",
      registered: true,
      grokBotTwin: true,
      purpose: "Researches accounts and markets with GBrain.",
      gateway: { keyId: "gk_live_research", policy: "researcher", provider: "increase-roas-oauth-gateway" },
    });
  });

  it("keeps known gateway bots visible until an agent registers them", async () => {
    const company = await createCompanyNamed(db, "Increase Roas");
    const app = await createApp(db, boardActor(company.id));

    const before = await request(app).get(`/api/companies/${company.id}/bots`).expect(200);
    expect(before.body.bots.map((bot: { slug: string }) => bot.slug)).toEqual(
      expect.arrayContaining([
        "funnel-builder",
        "kiwi",
        "dr-eggbot",
        "workflow-builder",
        "drive-organizer",
        "hermes-specialist",
      ]),
    );
    const funnel = before.body.bots.find((bot: { slug: string }) => bot.slug === "funnel-builder");
    expect(funnel).toMatchObject({ registered: false, kind: "gateway", status: "unregistered", gateway: null });
    const workflow = before.body.bots.find((bot: { slug: string }) => bot.slug === "workflow-builder");
    expect(workflow).toMatchObject({ name: "Workflow Builder", registered: false, gateway: null });
    expect(workflow.note).toContain("workflows and routines");

    const detail = await request(app).get(`/api/companies/${company.id}/bots/funnel-builder`).expect(200);
    expect(detail.body).toMatchObject({ slug: "funnel-builder", registered: false, routines: [], recentActivity: [] });

    await createAgent(db, company.id, {
      name: "Funnel Builder",
      metadata: { agentKind: "bot", bot: { purpose: "Builds funnels." } },
    });

    const after = await request(app).get(`/api/companies/${company.id}/bots`).expect(200);
    const funnelEntries = after.body.bots.filter((bot: { slug: string }) => bot.slug === "funnel-builder");
    expect(funnelEntries).toHaveLength(1);
    expect(funnelEntries[0]).toMatchObject({ registered: true, name: "Funnel Builder" });
  });

  it("returns routines, schedules and recent activity for a bot page", async () => {
    const company = await createCompany(db, "Detail");
    const bot = await createAgent(db, company.id, {
      name: "Ads Auditor",
      metadata: { grokBotTwin: true, bot: { purpose: "Checks ad spend." } },
    });
    const routine = await db
      .insert(routines)
      .values({
        companyId: company.id,
        title: "Daily ad check",
        assigneeAgentId: bot.id,
        status: "active",
      })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(routineTriggers).values({
      companyId: company.id,
      routineId: routine.id,
      kind: "schedule",
      cronExpression: "0 7 * * *",
      timezone: "America/New_York",
      enabled: true,
      nextRunAt: new Date("2026-11-22T12:00:00.000Z"),
    });
    await db.insert(activityLog).values({
      companyId: company.id,
      actorType: "agent",
      actorId: bot.id,
      action: "agent.heartbeat",
      entityType: "agent",
      entityId: bot.id,
      agentId: bot.id,
      details: { secret: "must-not-be-returned" },
    });
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: company.id,
      agentId: bot.id,
      status: "succeeded",
      startedAt: new Date("2026-11-21T11:00:00.000Z"),
    }).returning();

    const app = await createApp(db, boardActor(company.id));
    const response = await request(app).get(`/api/companies/${company.id}/bots/${bot.id}`).expect(200);

    expect(response.body).toMatchObject({ name: "Ads Auditor", purpose: "Checks ad spend." });
    expect(response.body.routines).toHaveLength(1);
    expect(response.body.routines[0]).toMatchObject({
      title: "Daily ad check",
      status: "active",
      triggers: [
        {
          kind: "schedule",
          cronExpression: "0 7 * * *",
          timezone: "America/New_York",
          enabled: true,
          nextRunAt: "2026-11-22T12:00:00.000Z",
        },
      ],
    });
    // Activity and heartbeat runs share one timeline so a bot with runs but a
    // quiet activity log still shows what it has been doing.
    expect(response.body.recentActivity).toHaveLength(2);
    expect(response.body.recentActivity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "agent.heartbeat", entityType: "agent", source: "activity" }),
        expect.objectContaining({ id: run!.id, action: "run.succeeded", entityType: "heartbeat_run", source: "run" }),
      ]),
    );
    expect(JSON.stringify(response.body)).not.toContain("must-not-be-returned");
  });

  it("drops a half-filled gateway link instead of guessing", async () => {
    const company = await createCompany(db, "Incomplete");
    await createAgent(db, company.id, {
      name: "Kiwi",
      metadata: { agentKind: "bot", bot: { gateway: { keyId: "gk_live_kiwi" } } },
    });

    const app = await createApp(db, boardActor(company.id));
    const response = await request(app).get(`/api/companies/${company.id}/bots`).expect(200);
    const kiwi = response.body.bots.find((bot: { name: string }) => bot.name === "Kiwi");
    expect(kiwi).toMatchObject({ registered: true, gateway: null });
  });

  it("only suggests known gateway bots inside the company that runs them", async () => {
    const company = await createCompany(db, "Elsewhere");
    const app = await createApp(db, boardActor(company.id));
    const response = await request(app).get(`/api/companies/${company.id}/bots`).expect(200);
    expect(response.body.bots).toEqual([]);
  });

  it("suggests Hermes gateway agents that are not tagged as bots", async () => {
    const company = await createCompany(db, "Suggestions");
    await createAgent(db, company.id, { name: "Hermes Untagged" });
    await createAgent(db, company.id, {
      name: "Hermes Tagged",
      metadata: { grokBotTwin: true },
    });
    await createAgent(db, company.id, { name: "Codex Agent", adapterType: "codex_local" });

    const app = await createApp(db, boardActor(company.id));
    const response = await request(app).get(`/api/companies/${company.id}/bots`).expect(200);

    expect(response.body.suggestedAgents.map((agent: { name: string }) => agent.name)).toEqual(["Hermes Untagged"]);
    expect(response.body.suggestedAgents[0]).toMatchObject({ status: "idle", adapterType: "hermes_gateway" });
  });

  it("does not expose another company's bot", async () => {
    const mine = await createCompany(db, "Mine");
    const other = await createCompany(db, "Other");
    const foreignBot = await createAgent(db, other.id, {
      name: "Foreign Bot",
      metadata: { grokBotTwin: true },
    });

    const memberApp = await createApp(db, boardActor(mine.id, { instanceAdmin: false, source: "session" }));
    await request(memberApp).get(`/api/companies/${mine.id}/bots/${foreignBot.id}`).expect(404);

    // A member of another company cannot read this roster, but its own reads.
    await request(memberApp).get(`/api/companies/${other.id}/bots`).expect(403);
    await request(memberApp).get(`/api/companies/${mine.id}/bots`).expect(200);
  });
});
