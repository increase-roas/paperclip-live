import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentConfigRevisions,
  agentReadinessAttestations,
  agentReadinessReports,
  agents,
  companies,
  companySkills,
  createDb,
  heartbeatRuns,
  issueExecutionDecisions,
  issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createAgentReadinessCatalog } from "../services/agent-readiness/catalog.js";
import { agentReadinessService } from "../services/agent-readiness/service.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
type Db = ReturnType<typeof createDb>;

const boardActor = (companyId: string, options: { instanceAdmin?: boolean; source?: "local_implicit" | "session" } = {}): Express.Request["actor"] => ({
  type: "board",
  userId: "board-user",
  userName: "Board User",
  userEmail: null,
  isInstanceAdmin: options.instanceAdmin ?? true,
  source: options.source ?? "local_implicit",
  companyIds: [companyId],
});

const agentActor = (companyId: string, agentId: string): Express.Request["actor"] => ({
  type: "agent",
  companyId,
  agentId,
  runId: undefined,
  source: "agent_jwt",
});

async function createCompany(db: Db, label: string) {
  return db.insert(companies).values({
    name: `${label} ${randomUUID()}`,
    issuePrefix: `R${randomUUID().slice(0, 6).toUpperCase()}`,
  }).returning().then((rows) => rows[0]!);
}

async function createAgent(db: Db, companyId: string, overrides: Partial<typeof agents.$inferInsert> = {}) {
  return db.insert(agents).values({
    companyId,
    name: `Readiness Agent ${randomUUID().slice(0, 6)}`,
    role: "engineer",
    title: "Engineer",
    status: "idle",
    adapterType: "hermes_local",
    adapterConfig: { hermesCommand: "jarvis", toolsets: "mcp" },
    runtimeConfig: {},
    budgetMonthlyCents: 5000,
    ...overrides,
  }).returning().then((rows) => rows[0]!);
}

async function createRouteApp(db: Db, actor: Express.Request["actor"]) {
  const { agentReadinessRoutes } = await import("../routes/agent-readiness.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", agentReadinessRoutes(db, {
    liveProbe: async () => ({ status: "pass", message: "Stubbed live probe passed." }),
  }));
  app.use((error: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status ?? 500).json({ error: error.message });
  });
  return app;
}

describePostgres("agent readiness", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-readiness-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(agentReadinessAttestations);
    await db.delete(agentReadinessReports);
    await db.delete(activityLog);
    await db.delete(agentConfigRevisions);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(companySkills);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => tempDb?.cleanup());

  it("computes static agent checks and the 80% pass-rate rule", async () => {
    const company = await createCompany(db, "Static");
    await db.insert(companySkills).values({
      companyId: company.id,
      key: "deploy",
      slug: "deploy",
      name: "Deploy",
      markdown: "# Deploy",
    });
    const agent = await createAgent(db, company.id, {
      adapterConfig: {
        model: "gpt-5.6-sol",
        fallbackModel: "gpt-5.6-mini",
        hermesCommand: "jarvis",
        toolsets: "mcp",
        paperclipSkillSync: { desiredSkills: [{ key: "deploy", versionId: null }] },
      },
    });
    await db.insert(agentConfigRevisions).values({
      companyId: company.id,
      agentId: agent.id,
      source: "patch",
      changedKeys: [],
      beforeConfig: {},
      afterConfig: {},
    });
    const testIssue = await db.insert(issues).values({
      companyId: company.id,
      identifier: `${company.issuePrefix}-1`,
      title: "Readiness test",
      status: "todo",
      assigneeAgentId: agent.id,
    }).returning().then((rows) => rows[0]!);
    await db.update(agents).set({ metadata: { readinessTestIssueId: testIssue.id } }).where(eq(agents.id, agent.id));
    await db.insert(heartbeatRuns).values([1, 2].map(() => ({
      companyId: company.id,
      agentId: agent.id,
      issueId: testIssue.id,
      status: "succeeded",
      startedAt: new Date(),
    })));

    const catalog = createAgentReadinessCatalog(db);
    const collection = await catalog.collect(company.id, { includeLive: false, attestations: [] });
    const subject = collection.subjects.find((entry) => entry.subjectType === "agent" && entry.subjectId === agent.id);
    expect(subject).toBeDefined();
    const finding = (checkId: string) => collection.findings.find((entry) =>
      entry.subjectId === agent.id && entry.checkId === checkId);

    expect(finding("model.configured")?.status).toBe("pass");
    expect(finding("model.pinned")?.status).toBe("pass");
    expect(finding("model.backup")?.status).toBe("pass");
    expect(finding("runtime.config_revision")?.status).toBe("pass");
    expect(finding("tests.task_linked")?.status).toBe("pass");
    expect(finding("tests.pass_rate")?.status).toBe("pass");
    expect(finding("instructions.no_dead_skill_refs")?.status).toBe("pass");
    expect(finding("permissions.vault_secrets")?.status).toBe("pass");
    expect(finding("permissions.budget")?.status).toBe("pass");
    expect(finding("model.probe")?.status).toBe("not_checked");
    expect(finding("tests.no_real_clients")?.status).toBe("not_checked");
    expect(subject?.levels.find((level) => level.level === 3)?.notChecked).toBeGreaterThan(0);
  });

  it("treats an unattested manual must-pass as unverified", async () => {
    const company = await createCompany(db, "Manual");
    const agent = await createAgent(db, company.id);
    const catalog = createAgentReadinessCatalog(db);
    const collection = await catalog.collect(company.id, { includeLive: false, attestations: [] });
    const manual = collection.findings.find((entry) =>
      entry.subjectId === agent.id && entry.checkId === "tests.no_real_clients");
    expect(manual?.status).toBe("not_checked");
    const subject = collection.subjects.find((entry) => entry.subjectId === agent.id);
    expect(subject?.levels.find((level) => level.level === 3)?.mustPassFailed).toBe(false);
    const hindsight = collection.findings.find((entry) =>
      entry.subjectId === agent.id && entry.checkId === "memory.hindsight_removed");
    expect(hindsight?.status).toBe("pass");
  });

  it("scores Hermes twins as bots and skips native Dot, Muse and grok_bot agents", async () => {
    const company = await createCompany(db, "Bots");
    const twin = await createAgent(db, company.id, { metadata: { grokBotTwin: true } });
    const nativeGrok = await createAgent(db, company.id, {
      adapterType: "paperclip_runner",
      adapterConfig: { provider: "grok_bot" },
    });
    const dot = await createAgent(db, company.id, {
      adapterType: "paperclip_runner",
      adapterConfig: { provider: "openai_dot" },
    });
    const muse = await createAgent(db, company.id, {
      adapterType: "paperclip_runner",
      adapterConfig: { provider: "muse" },
    });
    const catalog = createAgentReadinessCatalog(db);
    const collection = await catalog.collect(company.id, { includeLive: false, attestations: [] });
    expect(collection.subjects.map((entry) => entry.subjectType).sort()).toEqual(["bot", "company"]);
    expect(collection.subjects.some((entry) => entry.subjectId === twin.id && entry.subjectType === "bot")).toBe(true);
    for (const skipped of [nativeGrok, dot, muse]) {
      expect(collection.subjects.some((entry) => entry.subjectId === skipped.id)).toBe(false);
      expect(collection.findings.some((entry) => entry.subjectId === skipped.id)).toBe(false);
    }
    const twinFinding = (checkId: string) => collection.findings.find((entry) =>
      entry.subjectId === twin.id && entry.checkId === checkId);
    expect(twinFinding("bot.hermes_twin")?.status).toBe("pass");
    expect(twinFinding("bot.twin_profile")?.status).toBe("pass");
    expect(twinFinding("bot.twin_verified")?.status).toBe("not_checked");
    expect(twinFinding("runtime.hermes_profile")?.status).toBe("pass");
    // The summary carries the tag so a client can group bots without re-reading
    // agent metadata.
    const twinSummary = collection.summary.subjects.find((entry) => entry.subjectId === twin.id);
    expect(twinSummary?.grokBotTwin).toBe(true);
    expect(collection.summary.subjects.find((entry) => entry.subjectType === "company")?.grokBotTwin).toBe(false);
  });

  it("applies only allowlisted fixes, logs activity and re-evaluates the check", async () => {
    const company = await createCompany(db, "Fixes");
    const agent = await createAgent(db, company.id);
    const service = agentReadinessService(db, {
      liveProbe: async () => ({ status: "pass", message: "Stubbed live probe passed." }),
    });
    const actor = { actorType: "user" as const, actorId: "board-user" };
    const result = await service.applyFix({
      companyId: company.id,
      subjectType: "agent",
      subjectId: agent.id,
      checkId: "runtime.config_revision",
      action: "snapshot_config",
      confirm: true,
      actor,
    });
    expect(result.applied).toBe(true);
    expect(result.finding?.checkId).toBe("runtime.config_revision");
    expect(result.finding?.status).toBe("pass");
    const revisions = await db.select().from(agentConfigRevisions).where(and(
      eq(agentConfigRevisions.companyId, company.id),
      eq(agentConfigRevisions.agentId, agent.id),
    ));
    expect(revisions).toHaveLength(1);
    const logged = await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, company.id),
      eq(activityLog.action, "agent_readiness.fix_applied"),
    ));
    expect(logged).toHaveLength(1);
    const second = await service.applyFix({
      companyId: company.id,
      subjectType: "agent",
      subjectId: agent.id,
      checkId: "runtime.config_revision",
      action: "snapshot_config",
      confirm: true,
      actor,
    });
    expect(second.message).toContain("already saved");
    const revisionsAfter = await db.select().from(agentConfigRevisions).where(and(
      eq(agentConfigRevisions.companyId, company.id),
      eq(agentConfigRevisions.agentId, agent.id),
    ));
    expect(revisionsAfter).toHaveLength(1);
    await expect(service.applyFix({
      companyId: company.id,
      subjectType: "agent",
      subjectId: agent.id,
      checkId: "permissions.budget",
      action: "snapshot_config",
      confirm: true,
      actor,
    })).rejects.toMatchObject({ status: 400 });
  });

  it("creates a linked test task through the safe fix", async () => {
    const company = await createCompany(db, "TestTask");
    const agent = await createAgent(db, company.id);
    const service = agentReadinessService(db);
    const result = await service.applyFix({
      companyId: company.id,
      subjectType: "agent",
      subjectId: agent.id,
      checkId: "tests.task_linked",
      action: "create_test_task",
      confirm: true,
      actor: { actorType: "user", actorId: "board-user" },
    });
    expect(result.finding?.status).toBe("pass");
    const [updated] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect(typeof updated?.metadata?.readinessTestIssueId).toBe("string");
    const [created] = await db.select().from(issues).where(eq(issues.companyId, company.id));
    expect(created?.title).toContain("Readiness test");
  });

  it("removes a missing desired skill through the safe fix", async () => {
    const company = await createCompany(db, "SkillFix");
    await db.insert(companySkills).values({
      companyId: company.id,
      key: "deploy",
      slug: "deploy",
      name: "Deploy",
      markdown: "# Deploy",
    });
    const agent = await createAgent(db, company.id, {
      adapterConfig: {
        model: "gpt-5.6-sol",
        fallbackModel: "gpt-5.6-mini",
        hermesCommand: "jarvis",
        toolsets: "mcp",
        paperclipSkillSync: {
          desiredSkills: [{ key: "deploy", versionId: null }, { key: "gone", versionId: null }],
        },
      },
    });
    const service = agentReadinessService(db);
    // The configuration write is a lifecycle command. Running it on the
    // transaction threw "Lifecycle commands require the root database
    // connection" before this fix.
    const result = await service.applyFix({
      companyId: company.id,
      subjectType: "agent",
      subjectId: agent.id,
      checkId: "instructions.no_dead_skill_refs",
      action: "sync_skills",
      confirm: true,
      actor: { actorType: "user", actorId: "board-user" },
    });
    expect(result.finding?.status).toBe("pass");
    const [updated] = await db.select().from(agents).where(eq(agents.id, agent.id));
    const sync = (updated?.adapterConfig as { paperclipSkillSync?: { desiredSkills?: { key: string }[] } })?.paperclipSkillSync;
    expect(sync?.desiredSkills?.map((entry) => entry.key)).toEqual(["deploy"]);
  });

  it("attests a manual check with a note and saves the report it returns", async () => {
    const company = await createCompany(db, "Attest");
    const agent = await createAgent(db, company.id);
    const service = agentReadinessService(db);
    const result = await service.attest({
      companyId: company.id,
      subjectType: "agent",
      subjectId: agent.id,
      checkId: "tests.no_real_clients",
      note: "Checked the fixture task; no live clients.",
      userId: "board-user",
    });
    expect(result.finding?.status).toBe("pass");
    expect(result.attestation.note).toContain("fixture");
    const rows = await db.select().from(agentReadinessAttestations).where(eq(agentReadinessAttestations.companyId, company.id));
    expect(rows).toHaveLength(1);
    // A later read must show the attestation, not the pre-attestation snapshot.
    const reloaded = await service.getOrBuild(company.id);
    expect(reloaded.id).toBeTruthy();
    expect(reloaded.findings.find((entry) =>
      entry.subjectId === agent.id && entry.checkId === "tests.no_real_clients")?.status).toBe("pass");
    await expect(service.attest({
      companyId: company.id,
      subjectType: "agent",
      subjectId: agent.id,
      checkId: "tests.no_real_clients",
      note: "   ",
      userId: "board-user",
    })).rejects.toMatchObject({ status: 400 });
  });

  it("runs the default live probe and records its result", async () => {
    const company = await createCompany(db, "LiveProbe");
    const agent = await createAgent(db, company.id, {
      adapterConfig: { model: "dev-model", fallbackModel: "dev-backup", hermesCommand: "jarvis", toolsets: "mcp" },
    });
    const service = agentReadinessService(db);
    const report = await service.runReport(company.id, {
      includeLive: true,
      requestedByUserId: "board-user",
    });
    expect(report.status).toBe("complete");
    const probe = report.findings.find((entry) =>
      entry.subjectId === agent.id && entry.checkId === "model.probe");
    expect(probe?.status === "pass" || probe?.status === "fail").toBe(true);
    // No browser, connector or service login probe exists yet, so the must-pass
    // stays unchecked even when the adapter probe passes.
    expect(report.findings.find((entry) =>
      entry.subjectId === agent.id && entry.checkId === "access.logins")?.status).toBe("not_checked");
  });

  it("rejects a second running report with a conflict", async () => {
    const company = await createCompany(db, "Conflict");
    await db.insert(agentReadinessReports).values({
      companyId: company.id,
      status: "running",
      includeLive: false,
    });
    const service = agentReadinessService(db);
    await expect(service.runReport(company.id, { includeLive: false, requestedByUserId: "board-user" }))
      .rejects.toMatchObject({ status: 409 });
  });

  it("expires an abandoned running report instead of blocking new runs", async () => {
    const company = await createCompany(db, "Stale");
    const startedAt = new Date(Date.now() - 60 * 60 * 1000);
    await db.insert(agentReadinessReports).values({
      companyId: company.id,
      status: "running",
      includeLive: false,
      startedAt,
    });
    const service = agentReadinessService(db);
    const report = await service.runReport(company.id, { includeLive: false, requestedByUserId: "board-user" });
    expect(report.status).toBe("complete");
    const rows = await db.select().from(agentReadinessReports).where(eq(agentReadinessReports.companyId, company.id));
    expect(rows.find((row) => row.startedAt.getTime() === startedAt.getTime())?.status).toBe("failed");
  });

  it("fails the role box for the default general role and passes a described role", async () => {
    const company = await createCompany(db, "Roles");
    const generic = await createAgent(db, company.id, { role: "general", title: null, capabilities: null });
    const described = await createAgent(db, company.id, { role: "general", title: null, capabilities: "Writes release notes" });
    const catalog = createAgentReadinessCatalog(db);
    const collection = await catalog.collect(company.id, { includeLive: false, attestations: [] });
    const role = (agentId: string) => collection.findings.find((entry) =>
      entry.subjectId === agentId && entry.checkId === "intake.description");
    expect(role(generic.id)?.status).toBe("fail");
    expect(role(described.id)?.status).toBe("pass");
  });

  it("fails the GBrain must-pass until a connector or profile entry exists", async () => {
    const company = await createCompany(db, "Memory");
    const bare = await createAgent(db, company.id);
    const marked = await createAgent(db, company.id, {
      metadata: {
        gbrain: {
          url: "https://srv2155332.tailde26a1.ts.net/mcp",
          attachedAt: new Date().toISOString(),
          mode: "marker",
          connectionId: null,
        },
      },
    });
    const catalog = createAgentReadinessCatalog(db);
    const collection = await catalog.collect(company.id, { includeLive: false, attestations: [] });
    const gbrain = (agentId: string) => collection.findings.find((entry) =>
      entry.subjectId === agentId && entry.checkId === "memory.gbrain_connected");
    expect(gbrain(bare.id)?.status).toBe("fail");
    expect(gbrain(marked.id)?.status).toBe("fail");
    expect(gbrain(marked.id)?.message).toContain("recorded at hire");
  });

  it("reports the embedded application database as a Neon failure and leaves ads access unchecked", async () => {
    const company = await createCompany(db, "Neon");
    const agent = await createAgent(db, company.id);
    const catalog = createAgentReadinessCatalog(db);
    const collection = await catalog.collect(company.id, { includeLive: false, attestations: [] });
    const neonDatabase = collection.findings.find((entry) =>
      entry.subjectType === "company" && entry.checkId === "company.neon_app_db");
    expect(neonDatabase).toBeDefined();
    if (neonDatabase?.evidence?.neonHost !== true) expect(neonDatabase?.status).toBe("fail");
    const ads = collection.findings.find((entry) =>
      entry.subjectId === agent.id && entry.checkId === "tools.neon_ads_readonly");
    expect(ads?.status).toBe("not_checked");
  });

  it("requires an approved review and a run comment before the test task counts as reviewed", async () => {
    const company = await createCompany(db, "Reviewed");
    const good = await createAgent(db, company.id);
    const bad = await createAgent(db, company.id);
    const goodIssue = await db.insert(issues).values({
      companyId: company.id,
      identifier: `${company.issuePrefix}-1`,
      title: "Readiness test",
      status: "in_review",
      assigneeAgentId: good.id,
      executionState: { lastDecisionOutcome: "approved" },
    }).returning().then((rows) => rows[0]!);
    const badIssue = await db.insert(issues).values({
      companyId: company.id,
      identifier: `${company.issuePrefix}-2`,
      title: "Readiness test",
      status: "done",
      assigneeAgentId: bad.id,
    }).returning().then((rows) => rows[0]!);
    await db.update(agents).set({ metadata: { readinessTestIssueId: goodIssue.id } }).where(eq(agents.id, good.id));
    await db.update(agents).set({ metadata: { readinessTestIssueId: badIssue.id } }).where(eq(agents.id, bad.id));
    await db.insert(issueExecutionDecisions).values({
      companyId: company.id,
      issueId: goodIssue.id,
      stageId: randomUUID(),
      stageType: "review",
      outcome: "approved",
      body: "Looks good.",
    });
    await db.insert(heartbeatRuns).values([
      {
        companyId: company.id,
        agentId: good.id,
        issueId: goodIssue.id,
        status: "succeeded",
        issueCommentStatus: "satisfied",
        resultJson: { result: { reportedWorkDisposition: "done" } },
        startedAt: new Date(),
      },
      {
        companyId: company.id,
        agentId: bad.id,
        issueId: badIssue.id,
        status: "succeeded",
        issueCommentStatus: "not_applicable",
        resultJson: { result: { reportedWorkDisposition: "done" } },
        startedAt: new Date(),
      },
    ]);
    const catalog = createAgentReadinessCatalog(db);
    const collection = await catalog.collect(company.id, { includeLive: false, attestations: [] });
    const reviewed = (agentId: string) => collection.findings.find((entry) =>
      entry.subjectId === agentId && entry.checkId === "tests.reviewed");
    expect(reviewed(good.id)?.status).toBe("pass");
    expect(reviewed(bad.id)?.status).toBe("fail");
    expect(reviewed(bad.id)?.message).toContain("without an approved review");
  });

  it("allows company members to read but only the board to mutate", async () => {
    const company = await createCompany(db, "Auth");
    const agent = await createAgent(db, company.id);
    const boardApp = await createRouteApp(db, boardActor(company.id));
    const agentApp = await createRouteApp(db, agentActor(company.id, agent.id));

    const read = await request(agentApp).get(`/api/companies/${company.id}/agent-readiness`);
    expect(read.status).toBe(200);
    expect(read.body.companyId).toBe(company.id);

    const forbidden = await request(agentApp).post(`/api/companies/${company.id}/agent-readiness/reports`).send({ includeLive: false });
    expect(forbidden.status).toBe(403);

    const boardRun = await request(boardApp).post(`/api/companies/${company.id}/agent-readiness/reports`).send({ includeLive: false });
    expect(boardRun.status).toBe(201);

    const attestation = await request(boardApp).post(`/api/companies/${company.id}/agent-readiness/attestations`).send({
      subjectType: "agent",
      subjectId: agent.id,
      checkId: "tests.no_real_clients",
      note: "Board attestation.",
    });
    expect(attestation.status).toBe(200);
    expect(attestation.body.finding.status).toBe("pass");

    const foreignCompany = await createCompany(db, "Foreign");
    const foreignApp = await createRouteApp(db, boardActor(foreignCompany.id, {
      instanceAdmin: false,
      source: "session",
    }));
    const denied = await request(foreignApp).get(`/api/companies/${company.id}/agent-readiness`);
    expect(denied.status).toBe(403);
  });
});
