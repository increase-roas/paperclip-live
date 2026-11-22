import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";
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
import { KNOWN_GATEWAY_BOTS } from "@paperclipai/shared";

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

async function createApp(db: Db, actor: Express.Request["actor"], options: Record<string, unknown> = {}) {
  const { botsRoutes } = await import("../routes/bots.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", botsRoutes(db, options));
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
    expect(funnel).toMatchObject({
      registered: false,
      kind: "gateway",
      status: "unregistered",
      // The gateway ships a preset for each known bot, so the page can name the
      // policy. No key id exists to read, so it stays null and the page says so.
      gateway: { keyId: null, policy: "funnel-builder", provider: "gateway", source: "catalog_preset" },
    });
    const workflow = before.body.bots.find((bot: { slug: string }) => bot.slug === "workflow-builder");
    expect(workflow).toMatchObject({
      name: "Workflow Builder",
      registered: false,
      gateway: { keyId: null, policy: "workflow-builder", source: "catalog_preset" },
    });
    expect(workflow.note).toContain("workflows and routines");
    // Every known bot names the policy preset it ships with, and none claims a
    // key id, because the gateway keeps only a hash of the key.
    for (const slug of ["dr-eggbot", "kiwi", "drive-organizer", "hermes-specialist"]) {
      const bot = before.body.bots.find((entry: { slug: string }) => entry.slug === slug);
      expect(bot.gateway).toMatchObject({ keyId: null, policy: slug, source: "catalog_preset" });
    }

    // The dr eggbot purpose came from Alex; Kiwi still has no recorded source,
    // so it keeps an explicit unresolved-purpose note rather than an invented
    // sentence.
    const eggbot = before.body.bots.find((bot: { slug: string }) => bot.slug === "dr-eggbot");
    expect(eggbot).toMatchObject({
      registered: false,
      purpose: "Designs tight, single-job Grok Bots. Bring a job you want off your plate and it interviews you for the goal and process, then builds a bot that runs it on its own.",
    });
    const kiwi = before.body.bots.find((bot: { slug: string }) => bot.slug === "kiwi");
    expect(kiwi?.purpose ?? null).toBeNull();
    expect(kiwi?.note).toContain("no recorded purpose");

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

  it("serves a page for every known gateway bot", async () => {
    const company = await createCompanyNamed(db, "Increase Roas");
    const app = await createApp(db, boardActor(company.id));

    const listed = await request(app).get(`/api/companies/${company.id}/bots`).expect(200);
    for (const known of KNOWN_GATEWAY_BOTS) {
      const summary = listed.body.bots.find((bot: { slug: string }) => bot.slug === known.slug);
      expect(summary, `${known.name} should be listed`).toMatchObject({
        id: `catalog:${known.slug}`,
        name: known.name,
        kind: "gateway",
        registered: false,
        status: "unregistered",
        note: known.note,
      });

      const bySlug = await request(app)
        .get(`/api/companies/${company.id}/bots/${known.slug}`)
        .expect(200);
      expect(bySlug.body).toMatchObject({
        id: `catalog:${known.slug}`,
        slug: known.slug,
        name: known.name,
        routines: [],
        recentActivity: [],
      });

      const byId = await request(app)
        .get(`/api/companies/${company.id}/bots/catalog:${known.slug}`)
        .expect(200);
      expect(byId.body.slug).toBe(known.slug);
    }
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

  it("reads a gateway policy from the agent's own gateway URL when metadata has none", async () => {
    const company = await createCompany(db, "Gateway URLs");
    const live = await createAgent(db, company.id, {
      name: "Ads checker",
      adapterConfig: {
        apiBaseUrl: "https://srv2155332.tailde26a1.ts.net:8443/p/ads-checker",
        apiKey: { type: "secret_ref", secretId: "secret-id-should-not-leak" },
      },
    });
    // A registered bot gets the same derivation on the roster.
    await createAgent(db, company.id, {
      name: "Web Builder",
      metadata: { agentKind: "bot", bot: { purpose: "Builds pages.", transport: "hermes_gateway" } },
      adapterConfig: { apiBaseUrl: "https://srv2155332.tailde26a1.ts.net:8443/p/website-builder" },
    });
    // A tagged bot on another adapter keeps its null link: only the Hermes
    // gateway URL names a policy.
    await createAgent(db, company.id, {
      name: "Plain Codex",
      adapterType: "codex_local",
      metadata: { agentKind: "bot" },
      adapterConfig: { apiBaseUrl: "https://example.test/p/website-builder" },
    });

    const app = await createApp(db, boardActor(company.id));
    const detail = await request(app).get(`/api/companies/${company.id}/bots/${live.id}`).expect(200);
    expect(detail.body.gateway).toEqual({
      keyId: null,
      policy: "ads-checker",
      provider: "srv2155332.tailde26a1.ts.net:8443",
      source: "agent_config",
    });
    expect(JSON.stringify(detail.body)).not.toContain("secret-id-should-not-leak");

    const roster = await request(app).get(`/api/companies/${company.id}/bots`).expect(200);
    const entry = roster.body.bots.find((bot: { name: string }) => bot.name === "Web Builder");
    expect(entry.gateway).toMatchObject({ keyId: null, policy: "website-builder", source: "agent_config" });
    const codex = roster.body.bots.find((bot: { name: string }) => bot.name === "Plain Codex");
    expect(codex.gateway).toBeNull();
  });

  it("keeps a recorded metadata link ahead of the adapter URL", async () => {
    const company = await createCompany(db, "Recorded link");
    const bot = await createAgent(db, company.id, {
      name: "Research Analyst",
      metadata: {
        grokBotTwin: true,
        bot: {
          purpose: "Researches accounts and markets with GBrain.",
          gateway: { keyId: "gk_live_research", policy: "researcher", provider: "increase-roas-oauth-gateway" },
        },
      },
      adapterConfig: { apiBaseUrl: "https://srv2155332.tailde26a1.ts.net:8443/p/research" },
    });

    const app = await createApp(db, boardActor(company.id));
    const detail = await request(app).get(`/api/companies/${company.id}/bots/${bot.id}`).expect(200);
    expect(detail.body.gateway).toEqual({
      keyId: "gk_live_research",
      policy: "researcher",
      provider: "increase-roas-oauth-gateway",
      source: "metadata",
    });
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

  it("serves a page for a Hermes agent that is not tagged as a bot", async () => {
    const company = await createCompany(db, "Hermes");
    const agent = await createAgent(db, company.id, {
      name: "Research Analyst",
      metadata: null,
    });
    const routine = await db
      .insert(routines)
      .values({ companyId: company.id, title: "Morning research", assigneeAgentId: agent.id, status: "active" })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(routineTriggers).values({
      companyId: company.id,
      routineId: routine.id,
      kind: "schedule",
      cronExpression: "0 8 * * *",
      timezone: "America/New_York",
      enabled: true,
      nextRunAt: new Date("2026-11-23T13:00:00.000Z"),
    });
    await db.insert(activityLog).values({
      companyId: company.id,
      actorType: "agent",
      actorId: agent.id,
      action: "agent.heartbeat",
      entityType: "agent",
      entityId: agent.id,
      agentId: agent.id,
    });
    await db.insert(heartbeatRuns).values({
      companyId: company.id,
      agentId: agent.id,
      status: "succeeded",
      startedAt: new Date("2026-11-22T12:00:00.000Z"),
    });

    const app = await createApp(db, boardActor(company.id));

    // The roster keeps it out of the registered list...
    const roster = await request(app).get(`/api/companies/${company.id}/bots`).expect(200);
    expect(roster.body.bots).toEqual([]);
    expect(roster.body.suggestedAgents.map((suggested: { name: string }) => suggested.name)).toEqual([
      "Research Analyst",
    ]);

    // ...but its page exists, with the data the source already has.
    const byId = await request(app).get(`/api/companies/${company.id}/bots/${agent.id}`).expect(200);
    expect(byId.body).toMatchObject({
      id: agent.id,
      name: "Research Analyst",
      kind: "agent",
      registered: true,
      taggedAsBot: false,
      agentId: agent.id,
    });
    expect(byId.body.note).toContain("no bot metadata");
    expect(byId.body.routines).toHaveLength(1);
    expect(byId.body.routines[0]).toMatchObject({
      title: "Morning research",
      triggers: [expect.objectContaining({ cronExpression: "0 8 * * *", enabled: true })],
    });
    expect(byId.body.recentActivity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "agent.heartbeat", source: "activity" }),
        expect.objectContaining({ action: "run.succeeded", source: "run" }),
      ]),
    );

    const bySlug = await request(app).get(`/api/companies/${company.id}/bots/research-analyst`).expect(200);
    expect(bySlug.body.id).toBe(agent.id);
  });

  it("does not invent a bot page for a plain agent or another company's agent", async () => {
    const company = await createCompany(db, "Plain");
    const other = await createCompany(db, "Outside");
    const plain = await createAgent(db, company.id, { name: "Codex Helper", adapterType: "codex_local", metadata: null });
    const foreign = await createAgent(db, other.id, { name: "Foreign Hermes", metadata: null });

    const app = await createApp(db, boardActor(company.id));
    await request(app).get(`/api/companies/${company.id}/bots/${plain.id}`).expect(404);
    await request(app).get(`/api/companies/${company.id}/bots/${foreign.id}`).expect(404);

    // A tagged bot still comes from the roster, not the fallback path.
    const tagged = await createAgent(db, company.id, { name: "Tagged Hermes", metadata: { grokBotTwin: true } });
    const taggedPage = await request(app).get(`/api/companies/${company.id}/bots/${tagged.id}`).expect(200);
    expect(taggedPage.body).toMatchObject({ taggedAsBot: true });
  });

  it("plans catalog bot registration without writing agents", async () => {
    const company = await createCompanyNamed(db, "Increase Roas");
    const app = await createApp(db, boardActor(company.id));

    const response = await request(app).get(`/api/companies/${company.id}/bots/registration`).expect(200);
    expect(response.body).toMatchObject({ companyName: "Increase Roas", creates: 6, skips: 0 });
    expect(response.body.entries.map((entry: { slug: string }) => entry.slug)).toEqual(
      KNOWN_GATEWAY_BOTS.map((bot) => bot.slug),
    );
    const funnel = response.body.entries.find((entry: { slug: string }) => entry.slug === "funnel-builder");
    expect(funnel.agent).toMatchObject({
      adapterType: "hermes_gateway",
      status: "paused",
      metadata: { agentKind: "bot", bot: { transport: "hermes_gateway" } },
    });

    // Read-only: the roster is unchanged.
    expect(await db.select().from(agents)).toEqual([]);
  });

  it("does not offer registration in a company that runs no catalog bots", async () => {
    const company = await createCompany(db, "Elsewhere");
    const app = await createApp(db, boardActor(company.id));
    const response = await request(app).get(`/api/companies/${company.id}/bots/registration`).expect(200);
    expect(response.body).toMatchObject({ entries: [], creates: 0, skips: 0 });
  });

  describe("gateway data", () => {
    const gatewayBot = (agent: string) => ({
      agent,
      name: agent,
      preset: null,
      enabled: true,
      hasKey: true,
      key: {
        present: true,
        algorithm: "sha256",
        fingerprint: "sha256:4b1d9c2e7a01",
        createdAt: "2026-11-18T14:02:11.000Z",
        rotatedAt: null,
        updatedAt: "2026-11-18T14:02:11.000Z",
      },
      providers: {},
      grantedProviders: [],
      policy: {
        mode: null,
        allowDelete: false,
        allowOutbound: false,
        allowAgencyWrite: false,
        allowBulk: false,
        allowSpend: false,
        allowBuild: false,
        outboundChannels: null,
        locations: "*",
        secrets: [],
        admin: false,
        role: null,
      },
      usage: { last24h: { requests: 0, errors: 0 }, last7d: { requests: 0, errors: 0 }, lastUsedAt: null },
      audit: [],
      generatedAt: "2026-11-22T05:12:00.000Z",
    }) as never;

    it("keeps every other company's gateway bots out of the answer", async () => {
      const company = await createCompanyNamed(db, "Increase Roas");
      const list = vi.fn().mockResolvedValue({
        connected: true,
        generatedAt: "2026-11-22T05:12:00.000Z",
        count: 2,
        bots: [gatewayBot("funnel-builder"), gatewayBot("someone-elses-bot")],
      });
      const app = await createApp(db, boardActor(company.id), {
        gateway: { enabled: () => true, list, summary: vi.fn() },
      });

      const response = await request(app).get(`/api/companies/${company.id}/bots/gateway`).expect(200);
      expect(response.body).toMatchObject({ connected: true, count: 1 });
      expect(response.body.bots.map((bot: { agent: string }) => bot.agent)).toEqual(["funnel-builder"]);
      expect(list).toHaveBeenCalledTimes(1);
    });

    it("explains a disabled gateway instead of failing the page", async () => {
      const company = await createCompanyNamed(db, "Increase Roas");
      const app = await createApp(db, boardActor(company.id), {
        gateway: {
          enabled: () => false,
          list: vi.fn().mockResolvedValue({
            connected: false,
            state: "disabled",
            message: "Gateway bot pages are off.",
          }),
          summary: vi.fn(),
        },
      });

      const response = await request(app).get(`/api/companies/${company.id}/bots/gateway`).expect(200);
      expect(response.body).toEqual({
        connected: false,
        state: "disabled",
        message: "Gateway bot pages are off.",
        bots: [],
      });
    });

    it("asks the gateway for one bot by slug and 404s for unknown bots", async () => {
      const company = await createCompanyNamed(db, "Increase Roas");
      const summary = vi.fn().mockResolvedValue({ connected: true, summary: gatewayBot("funnel-builder") });
      const app = await createApp(db, boardActor(company.id), {
        gateway: { enabled: () => true, list: vi.fn(), summary },
      });

      const response = await request(app)
        .get(`/api/companies/${company.id}/bots/funnel-builder/gateway`)
        .expect(200);
      expect(response.body).toMatchObject({ connected: true });
      expect(summary).toHaveBeenCalledWith("funnel-builder");

      await request(app).get(`/api/companies/${company.id}/bots/no-such-bot/gateway`).expect(404);
      expect(summary).toHaveBeenCalledTimes(1);
    });
  });
});
