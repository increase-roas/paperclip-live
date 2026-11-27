import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issueLabels,
  issues,
  labels,
} from "@paperclipai/db";
import type { ProofCheckResult } from "@paperclipai/shared/ir-system-map";
import { setProofSnapshotReaderForTests, type ProofSnapshotReader } from "../proof-gate.js";
import { actorMiddleware } from "../../middleware/auth.js";
import { errorHandler } from "../../middleware/error-handler.js";
import { issueRoutes } from "../../routes/issues.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

const STALE_AGE_SECONDS = 7200;

function snapshot(checks: ProofCheckResult[], options: { stale?: boolean } = {}): ProofSnapshotReader {
  return async () => ({
    checks,
    freshness: {
      observedAt: new Date().toISOString(),
      ageSeconds: options.stale ? STALE_AGE_SECONDS : 30,
      stale: options.stale ?? false,
      thresholdSeconds: 900,
    },
  });
}

function check(key: string, status: ProofCheckResult["status"], observedAt = new Date()): ProofCheckResult {
  return { key, status, detail: status === "pass" ? null : `${key}_probe:${status}`, observedAt: observedAt.toISOString() };
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * End-to-end proof gate through the real HTTP stack: the agent authenticates
 * with a hashed `agent_api_keys` bearer token, the actor middleware resolves it,
 * and `PATCH /api/issues/:id` runs the full issue route against Postgres.
 */
describePostgres("proof-gated closure through the agent issue route", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let restoreReader: (() => void) | null = null;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-ir-proof-gate-agent-routes-");
    db = createDb(database.connectionString);
  }, 30_000);

  afterEach(() => {
    restoreReader?.();
    restoreReader = null;
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await database?.cleanup();
  });

  function useSnapshot(reader: ProofSnapshotReader) {
    restoreReader?.();
    restoreReader = setProofSnapshotReaderForTests(reader);
  }

  function authenticatedApp(deploymentMode: "authenticated" | "local_trusted" = "authenticated") {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode }));
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    return app;
  }

  async function seedCompanyWithAgentKey(name: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const userId = `user-${randomUUID()}`;
    const token = `pcp_test_${randomUUID()}`;
    const prefix = `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name, issuePrefix: prefix, requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values({ id: userId, name: "Responsible", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Javar", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "admin" },
      { companyId, principalType: "agent", principalId: agentId, status: "active", membershipRole: "member" },
    ]);
    const [key] = await db.insert(agentApiKeys).values({
      companyId, agentId, name: "Javar key", responsibleUserId: userId, keyHash: hashToken(token),
    }).returning({ id: agentApiKeys.id });
    return { companyId, agentId, userId, token, keyId: key!.id, prefix };
  }

  let issueNumber = 0;
  const runIdByIssue = new Map<string, string>();
  async function seedIssue(company: { companyId: string; agentId: string; prefix: string }, labelNames: string[]) {
    const issueId = randomUUID();
    const runId = randomUUID();
    issueNumber += 1;
    const updatedAt = new Date(Date.now() - 60_000);
    await db.insert(heartbeatRuns).values({
      id: runId, companyId: company.companyId, agentId: company.agentId, status: "running",
      invocationSource: "assignment", startedAt: new Date(), contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId, companyId: company.companyId, title: "Fix gateway health", status: "in_progress", priority: "high",
      assigneeAgentId: company.agentId, identifier: `${company.prefix}-${issueNumber}`, issueNumber, updatedAt,
      checkoutRunId: runId, executionRunId: runId, executionAgentNameKey: "javar", executionLockedAt: updatedAt,
    });
    runIdByIssue.set(issueId, runId);
    for (const labelName of labelNames) {
      const labelId = randomUUID();
      await db.insert(labels).values({ id: labelId, companyId: company.companyId, name: labelName, color: "#888888" });
      await db.insert(issueLabels).values({ issueId, labelId, companyId: company.companyId });
    }
    return issueId;
  }

  async function issueState(issueId: string) {
    const [row] = await db.select({
      status: issues.status,
      completedAt: issues.completedAt,
      updatedAt: issues.updatedAt,
      statusVersion: issues.statusVersion,
      checkoutRunId: issues.checkoutRunId,
      executionRunId: issues.executionRunId,
      assigneeAgentId: issues.assigneeAgentId,
    }).from(issues).where(eq(issues.id, issueId));
    const labelRows = await db.select({ labelId: issueLabels.labelId }).from(issueLabels).where(eq(issueLabels.issueId, issueId));
    const activity = await db.select({ id: activityLog.id }).from(activityLog).where(eq(activityLog.entityId, issueId));
    const comments = await db.select({ id: issueComments.id }).from(issueComments).where(eq(issueComments.issueId, issueId));
    const [run] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runIdByIssue.get(issueId)!));
    return {
      row, runStatus: run?.status, labelIds: labelRows.map((r) => r.labelId).sort(),
      activityCount: activity.length, commentCount: comments.length,
    };
  }

  async function closeAsAgent(token: string, issueId: string, body: Record<string, unknown> = {}, runId = runIdByIssue.get(issueId)!) {
    return request(authenticatedApp())
      .patch(`/api/issues/${issueId}`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ status: "done", ...body });
  }

  it("refuses an agent close with 422 and no partial write when the proof check is missing", async () => {
    const company = await seedCompanyWithAgentKey("Proof agent missing");
    const issueId = await seedIssue(company, ["proof:gateway"]);
    const before = await issueState(issueId);

    for (const reader of [snapshot([]), snapshot([check("db_feeds", "pass")]), async () => null]) {
      useSnapshot(reader);
      const res = await closeAsAgent(company.token, issueId, { comment: "Gateway fixed, closing." });
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.details).toMatchObject({
        code: "ir_proof_check_not_passing", requiredProofCheck: "gateway", proofStatus: "missing",
      });
      expect(await issueState(issueId)).toEqual(before);
    }
  }, 60_000);

  it.each([
    ["failing", snapshot([check("gateway", "fail")]), "fail"],
    ["warning", snapshot([check("gateway", "warn")]), "warn"],
    ["stale snapshot", snapshot([check("gateway", "pass")], { stale: true }), "stale"],
    ["stale check", snapshot([check("gateway", "pass", new Date(Date.now() - STALE_AGE_SECONDS * 1000))]), "stale"],
  ] as const)("refuses an agent close with 422 and full rollback when the check is %s", async (_name, reader, proofStatus) => {
    const company = await seedCompanyWithAgentKey("Proof agent failing");
    const issueId = await seedIssue(company, ["proof:gateway"]);
    const before = await issueState(issueId);
    useSnapshot(reader);

    const res = await closeAsAgent(company.token, issueId, { comment: "Done." });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.details).toMatchObject({ code: "ir_proof_check_not_passing", requiredProofCheck: "gateway", proofStatus });
    expect(await issueState(issueId)).toEqual(before);
  }, 60_000);

  it("rolls back label changes sent with a refused close", async () => {
    const company = await seedCompanyWithAgentKey("Proof agent labels");
    const issueId = await seedIssue(company, []);
    const labelId = randomUUID();
    await db.insert(labels).values({ id: labelId, companyId: company.companyId, name: "proof:db_feeds", color: "#888888" });
    const before = await issueState(issueId);
    useSnapshot(snapshot([check("db_feeds", "fail")]));

    const res = await closeAsAgent(company.token, issueId, { labelIds: [labelId], title: "Renamed while closing" });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.details).toMatchObject({ requiredProofCheck: "db_feeds", proofStatus: "fail" });
    expect(await issueState(issueId)).toEqual(before);
    const [row] = await db.select({ title: issues.title }).from(issues).where(eq(issues.id, issueId));
    expect(row?.title).toBe("Fix gateway health");
  }, 60_000);

  it("closes the issue and logs the agent's activity once every proof check passes fresh", async () => {
    const company = await seedCompanyWithAgentKey("Proof agent pass");
    const issueId = await seedIssue(company, ["proof:gateway", "proof:db_feeds"]);
    useSnapshot(snapshot([check("gateway", "pass"), check("db_feeds", "pass")]));

    const res = await closeAsAgent(company.token, issueId, { comment: "Gateway fixed and verified." });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("done");
    const after = await issueState(issueId);
    expect(after.row).toMatchObject({ status: "done" });
    expect(after.row?.completedAt).toBeInstanceOf(Date);
    expect(after.commentCount).toBe(1);
    const updates = await db.select().from(activityLog).where(and(
      eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.updated"),
    ));
    expect(updates).toContainEqual(expect.objectContaining({
      companyId: company.companyId, actorType: "agent", actorId: company.agentId, agentId: company.agentId,
    }));
    const statusChange = updates.find((event) => (event.details as Record<string, unknown> | null)?.status === "done");
    expect(statusChange, JSON.stringify(updates.map((event) => event.details))).toBeDefined();
  }, 60_000);

  it("does not let another company's agent key close or probe a gated issue", async () => {
    const owner = await seedCompanyWithAgentKey("Proof owner");
    const intruder = await seedCompanyWithAgentKey("Proof intruder");
    const issueId = await seedIssue(owner, ["proof:gateway"]);
    const before = await issueState(issueId);

    const intruderRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: intruderRunId, companyId: intruder.companyId, agentId: intruder.agentId, status: "running",
      invocationSource: "assignment", startedAt: new Date(), contextSnapshot: { issueId },
    });
    for (const reader of [snapshot([check("gateway", "fail")]), snapshot([check("gateway", "pass")])]) {
      useSnapshot(reader);
      const close = await closeAsAgent(intruder.token, issueId, {}, intruderRunId);
      expect([403, 404], JSON.stringify(close.body)).toContain(close.status);
      // The refusal must not reveal the gate or the check's state.
      expect(JSON.stringify(close.body)).not.toMatch(/proof|gateway/i);
      expect(await issueState(issueId)).toEqual(before);
    }

    const read = await request(authenticatedApp())
      .get(`/api/issues/${issueId}`)
      .set("Authorization", `Bearer ${intruder.token}`)
      .set("X-Paperclip-Run-Id", intruderRunId);
    expect([403, 404]).toContain(read.status);
    expect(JSON.stringify(read.body)).not.toMatch(/proof:gateway/);
  }, 60_000);

  it("does not cancel the active run before a refused board close with an interrupt comment", async () => {
    const company = await seedCompanyWithAgentKey("Proof board interrupt");
    const issueId = await seedIssue(company, ["proof:gateway"]);
    const runId = runIdByIssue.get(issueId)!;
    const before = await issueState(issueId);
    useSnapshot(snapshot([check("gateway", "fail")]));

    const res = await request(authenticatedApp("local_trusted"))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", comment: "Closing this now.", interrupt: true });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.details).toMatchObject({ code: "ir_proof_check_not_passing" });
    const [run] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run?.status).toBe("running");
    expect(await issueState(issueId)).toEqual(before);
  }, 60_000);
});
