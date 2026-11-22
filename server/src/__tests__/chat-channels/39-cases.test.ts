import {
  CONTROL_PLANE_CONFORMANCE_RESULT,
  CONTROL_PLANE_CONFORMANCE_TERMINAL,
} from "../../vendor/paperclip-runner/testing.js";
import {
  nativeChatProgressWork,
} from "../../services/chat-native-progress-work.js";
import {
  authorizeFailedChatRunRetryWake,
} from "../../services/durable-chat-wakeup.js";
import {

} from "../../adapters/index.js";
import {
  idleWorkSnapshot,
} from "../../services/task-admission.js";
import {
  requestTaskRetry,
} from "../../services/task-retry.js";
import {
  createDeliveryWorkCoordinator,
} from "../../services/delivery-work-coordinator.js";
import {

} from "../../services/run-identity.js";
import {
  randomUUID,
} from "node:crypto";
import {
  mkdtempSync,
  rmSync,
} from "node:fs";
import {
  and,
  eq,
  inArray,
  isNull,
  like,
  or,
  sql,
} from "drizzle-orm";
import {
  expect,
  it,
  vi,
} from "vitest";
import {
  agents,
  chatEndpointResources,
  chatEndpoints,
  chatMessageLinks,
  chatPublications,
  companyMemberships,
  completionContracts,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueThreadInteractions,
  issueWorkProducts,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
} from "@paperclipai/db";
import {
  errorHandler,
} from "../../middleware/index.js";
import {
  type ChatChannelService,
} from "../../services/chat-channels.js";
import {
  issueService,
} from "../../services/issues.js";
import {
  instanceSettingsService,
} from "../../services/instance-settings.js";
import {
  issueThreadInteractionService,
} from "../../services/issue-thread-interactions.js";
import {
  enqueueChatRunLifecycleMilestones,
  enqueueChatRunMilestones,
  enqueueSafeNativeChatProgress,
} from "../../services/chat-run-publications.js";
import {
  heartbeatService,
} from "../../services/heartbeat.js";
import {
  FakeChatSdkRuntime,
  TestDb,
  boardActor,
  fakeTelegramFetch,
  makeMessage,
  makeThread,
} from ".././helpers/chat-channels-fixture.js";
import {
  addSelectedChatFinal,
  chatWakeContext,
  configuredTelegramEndpoint,
  createService,
  createStorageService,
  currentGitHubTaskRetryFixture,
  db,
  deliverMessage,
  describeChatChannelsSuite,
  qualifySetupRoundTrip,
  readAgentWakeupRequestsById,
  readChatConversationsByEndpointId,
  readChatPublicationsByCommentId,
  readChatPublicationsByEndpointId,
  readChatPublicationsByIdempotencyKey,
  readHeartbeatRunsByCompanyId,
  readHeartbeatRunsById,
  readIssuesById,
  retirePublicationFixture,
  seedCompany,
  safeNativeProgressFixture,
  failedChatRetryFixture,
} from "../helpers/chat-channels-harness.js";
import type { NativeExecutionInput, NativeSession, NativeSessionBackend, PrpEvent } from "../../vendor/paperclip-runner/index.js";
import * as durableChatWakeup from "../../services/durable-chat-wakeup.js";
import * as adapterModule from "../../adapters/index.js";
import * as runIdentityModule from "../../services/run-identity.js";
import os, {  } from "node:os";
import path, {  } from "node:path";
import express, {  } from "express";
import request, {  } from "supertest";

describeChatChannelsSuite("chat channels 39-cases", () => {
  it.each(["accepted_result", "unknown_delivery", "selected_answer"] as const)(
    "does not repeat a failed chat run with %s",
    async (kind) => {
      const context = await failedChatRetryFixture("telegram");
      try {
        if (kind === "accepted_result") {
          const contractId = randomUUID();
          await db.insert(completionContracts).values({
            id: contractId,
            companyId: context.fixture.companyId,
            issueId: context.issue.id,
            revision: 1,
            schemaVersion: "1",
            policyVersion: "1",
            risk: "low",
            completionAuthority: "agent",
            incompleteCriteriaPolicy: "block",
            contractJson: {},
            canonicalSha256: "a".repeat(64),
            createdByActorType: "system",
            createdByActorId: "test",
          });
          await db
            .update(heartbeatRuns)
            .set({
              nativeIssueId: context.issue.id,
              completionContractId: contractId,
            })
            .where(eq(heartbeatRuns.id, context.runId));
          await db.insert(nativeRunResults).values({
            companyId: context.fixture.companyId,
            issueId: context.issue.id,
            runId: context.runId,
            completionContractId: contractId,
            serverFingerprint: "test-accepted",
            schemaStatus: "accepted",
            resultJson: {},
            canonicalSha256: "b".repeat(64),
          });
        } else {
          const commentId = kind === "selected_answer" ? randomUUID() : null;
          if (commentId)
            await db.insert(issueComments).values({
              id: commentId,
              companyId: context.fixture.companyId,
              issueId: context.issue.id,
              authorType: "agent",
              authorAgentId: context.fixture.assignedAgentId,
              createdByRunId: context.runId,
              body: "Already selected answer",
            });
          await db.insert(chatPublications).values({
            companyId: context.fixture.companyId,
            endpointId: context.endpoint.id,
            conversationId: context.conversation.id,
            issueId: context.issue.id,
            commentId,
            idempotencyKey: `run:${context.runId}:working:${context.endpoint.id}`,
            payload: { text: "Prior output" },
            state:
              kind === "unknown_delivery" ? "delivery_unknown" : "published",
          });
        }
        await expect(
          db.transaction((tx) =>
            context.service.prepareFailedChatRunRetry(tx, {
              companyId: context.fixture.companyId,
              issueId: context.issue.id,
              agentId: context.fixture.assignedAgentId,
              failedRunId: context.runId,
              initiatedByUserId: "owner-user",
            }),
          ),
        ).rejects.toMatchObject({
          details: { code: "chat_failed_run_retry_not_authorized" },
        });
      } finally {
        await context.service.shutdown();
      }
    },
  );

  it.each(["issue", "identity", "late_identity", "late_success", "stop", "pause", "revoked", "late_stop", "late_pause", "late_revoked", "late_new_owner"] as const)("retries failed chat execution authorization after actual %s lock contention", async lockKind => {
    const f = await currentGitHubTaskRetryFixture();
    const companyId = f.fixture.companyId;
    const late = lockKind.startsWith("late_");
    const transition = lockKind.replace(/^late_/, "");
    const success = lockKind === "late_success";
    const answer = "The saved request completed once after authorization became available.";
    const settings = instanceSettingsService(db);
    const previousSettings = await settings.getExperimental();
    let providerTurns = 0;
    const backend = vi.fn((execution: NativeExecutionInput): NativeSessionBackend => {
      if (!success) throw new Error("The authorization probe must not create a provider backend");
      const turnId = randomUUID();
      const identity = { companyId, agentId: execution.binding.agentId, issueId: f.issue.id,
        runId: execution.binding.runId, sessionId: execution.session.normalizedSessionId! };
      const evidenceId = randomUUID(), evidenceRef = `work_product:${evidenceId}`;
      const result = structuredClone(CONTROL_PLANE_CONFORMANCE_RESULT);
      result.summary = answer;
      result.completionClaim.contractRevision = execution.completionContract.contract.revision;
      result.completionClaim.criteria = execution.completionContract.contract.criteria.map(criterion => ({
        criterionId: criterion.id, status: "satisfied", evidenceRefs: [evidenceRef],
      }));
      result.evidence = [{ kind: "work_product", ref: evidenceRef }];
      result.verification[0]!.artifactRef = evidenceRef;
      let started = () => {};
      const turnStarted = new Promise<void>(resolve => { started = resolve; });
      const capabilities = { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
      const session: NativeSession = {
        identity: () => identity,
        async capabilities() { return capabilities; },
        async *events() {
          await turnStarted;
          const [run] = await readHeartbeatRunsById(identity.runId);
          yield { schema: "paperclip.prp.event.v1", sourceEventId: `${identity.runId}:terminal`, sourceSeq: 1,
            sourceInstanceId: run.runnerInstanceId!, sourceKind: "runner", runId: identity.runId,
            normalizedSessionId: identity.sessionId, turnId, eventType: "turn.completed", schemaVersion: 1,
            priority: 0, emittedAt: new Date().toISOString(), payload: {} } satisfies PrpEvent;
        },
        async startTurn() { providerTurns += 1; started(); return { turnId }; },
        async result() { await turnStarted; return { result, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL, turnId }; },
        async snapshot() { return { backendKind: "mock", sessionId: "chat-contention-fixture", identity,
          providerSessionId: `provider-${identity.runId}`, activeTurnId: null, pendingRuntimeRequests: [], lineage: [], cursor: "1" }; },
        async close() {},
      };
      return {
        async descriptor() { return { kind: "mock", name: "chat-execution-contention", version: "1", capabilities,
          runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } }; },
        async openSession() {
          await db.insert(issueWorkProducts).values({ id: evidenceId, companyId, issueId: f.issue.id,
            type: "artifact", provider: "paperclip", title: "Saved request result", status: "ready_for_review", reviewState: "approved" });
          return session;
        },
        async recoverSession() { throw new Error("The fresh authorized run must not recover another provider session"); },
      };
    });
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: backend });
    const workingDirectory = late ? mkdtempSync(path.join(os.tmpdir(), "chat-execution-authorization-")) : null;
    let release = () => {};
    let holding: Promise<unknown> | undefined;
    let authorization: { mockRestore(): void } | undefined;
    let identity: { mockRestore(): void } | undefined;
    try {
      if (late) {
        await settings.updateExperimental({ enableNativeRunner: true, enableIsolatedWorkspaces: true });
        await db.update(agents).set({ adapterConfig: { provider: "opencode",
          model: "openrouter/deepseek/deepseek-v4.1-flash-1017", cwd: workingDirectory,
          workspaceStrategy: { type: "project_primary" } } }).where(eq(agents.id, f.fixture.assignedAgentId));
      }
      const requestInput = { db, companyId, issueId: f.issue.id,
        actorId: "owner-user", actorSource: "cloud_tenant" as const, observedRunId: f.runId,
        idempotencyKey: randomUUID(), prepareChatRetry: f.service.prepareFailedChatRunRetry };
      const receipt = success ? await (async () => {
        const { issueRoutes } = await import("../../routes/issues.js");
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => { req.actor = boardActor(companyId); next(); });
        app.use("/api", issueRoutes(db, createStorageService().storage, { chatRunRetries: f.service }));
        app.use(errorHandler);
        const response = await request(app).post(`/api/issues/${f.issue.id}/retry`)
          .send({ observedRunId: f.runId, idempotencyKey: requestInput.idempotencyKey });
        expect(response.status).toBe(202);
        return response.body as Awaited<ReturnType<typeof requestTaskRetry>>;
      })() : await requestTaskRetry(requestInput);
      await f.service.processFailedChatRunRetry(receipt.chatActionId!);
      const [wake] = await readAgentWakeupRequestsById(receipt.chatActionId!);
      expect(wake).toMatchObject({ status: "queued", runId: expect.any(String) });
      const runId = wake.runId!;
      const realAuthorize = durableChatWakeup.authorizeFailedChatRunRetryWake;
      const realInitialize = runIdentityModule.initializeRunIdentity;
      let attempts = 0;
      let contention: unknown;
      let changed: Promise<unknown> | undefined;
      const denied = ["stop", "pause", "revoked", "new_owner"].includes(transition);
      let newOwnerId: string | undefined;
      let frozenInput: unknown;
      const initialized: string[] = [];
      let lateAuthorizationCompleted = false;
      authorization = vi.spyOn(durableChatWakeup, "authorizeFailedChatRunRetryWake").mockImplementation(async (...args) => {
        const input = args[2];
        if (input.phase !== "execution" || input.runId !== runId) return realAuthorize(...args);
        attempts += 1;
        if (attempts > 1) await changed;
        if (attempts === (late ? 2 : 1)) {
          if (late) {
            const [prepared] = await readHeartbeatRunsById(runId);
            expect(prepared).toMatchObject({ runtimeMode: "native", runnerProfileJson: { nativeExecutionInput: {
              provider: { kind: "opencode", model: "openrouter/deepseek/deepseek-v4.1-flash-1017" },
              binding: { runId },
            } } });
            frozenInput = structuredClone(prepared.runnerProfileJson!.nativeExecutionInput);
          }
          let acquired = () => {};
          const locked = new Promise<void>(resolve => { acquired = resolve; });
          const held = new Promise<void>(resolve => { release = resolve; });
          holding = db.transaction(async tx => {
            if (lockKind === "issue") await tx.select({ id: issues.id }).from(issues)
              .where(and(eq(issues.companyId, companyId), eq(issues.id, f.issue.id))).for("update");
            else await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`chat-identity:${companyId}:${f.action.principalId}`}, 0))`);
            acquired();
            await held;
          });
          await locked;
        }
        try {
          const authorized = await realAuthorize(...args);
          if (late && attempts > 2 && !denied) {
            lateAuthorizationCompleted = true;
            expect((await readHeartbeatRunsById(runId))[0].runnerProfileJson!.nativeExecutionInput).toEqual(frozenInput);
            if (!success) throw new Error("execution_authorization_probe_complete");
          }
          return authorized;
        }
        catch (error) {
          if (!contention) {
            contention = error;
            changed = holding!.then(async () => {
              if (transition === "stop") return heartbeat.cancelRun(runId, "Stopped by board during authorization");
              if (transition === "pause") return db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.fixture.assignedAgentId));
              if (transition === "revoked") return db.update(companyMemberships).set({ status: "suspended" }).where(and(
                eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, "owner-user")));
              if (transition === "new_owner") {
                const [owner] = await db.insert(heartbeatRuns).values({ companyId, agentId: f.fixture.assignedAgentId,
                  status: "running", contextSnapshot: { issueId: f.issue.id } }).returning();
                newOwnerId = owner.id;
                return db.update(issues).set({ executionRunId: owner.id }).where(eq(issues.id, f.issue.id));
              }
            });
          }
          release();
          throw error;
        }
      });
      identity = vi.spyOn(runIdentityModule, "initializeRunIdentity").mockImplementation(async (database, input) => {
        const value = await realInitialize(database, input);
        if (input.runId === runId && !late && !denied) {
          initialized.push(input.runId);
          throw new Error("execution_authorization_probe_complete");
        }
        return value;
      });
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(and(
        eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "running"), isNull(heartbeatRuns.wakeupRequestId)));
      await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.fixture.assignedAgentId));
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      await holding;
      await changed;
      expect(contention).toBeTruthy();
      expect(late ? lateAuthorizationCompleted : initialized).toEqual(late ? !denied : denied ? [] : [runId]);
      if (denied) expect(attempts).toBeLessThanOrEqual(late ? 3 : 2);
      else expect(attempts).toBe(late ? 3 : 2);
      expect(backend).toHaveBeenCalledTimes(success ? 1 : 0);
      expect(providerTurns).toBe(success ? 1 : 0);
      const [run] = await readHeartbeatRunsById(runId);
      expect(run.retryOfRunId).toBe(f.runId);
      if (!denied && !success) expect(run.error).toBe("execution_authorization_probe_complete");
      if (late) expect(run.runnerProfileJson!.nativeExecutionInput).toEqual(frozenInput);
      if (newOwnerId) expect((await readIssuesById(f.issue.id))[0].executionRunId).toBe(newOwnerId);
      expect((await readHeartbeatRunsByCompanyId(companyId)).filter(value => value.retryOfRunId === f.runId)).toHaveLength(1);
      expect((await readHeartbeatRunsById(f.runId))[0]).toMatchObject({ status: "failed" });
      expect(await db.select({ id: nativeRunResults.id }).from(nativeRunResults).where(eq(nativeRunResults.runId, runId))).toHaveLength(success ? 1 : 0);
      if (success) {
        expect(run.status).toBe("succeeded");
        expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId)))[0].phase).toBe("committed");
        await f.service.processPendingPublications();
        await f.service.processPendingPublications();
        const replies = (await readChatPublicationsByEndpointId(f.endpoint.id)).filter(publication =>
          typeof publication.payload.text === "string" && publication.payload.text.includes(answer));
        expect(replies).toHaveLength(1);
        expect(replies[0]).toMatchObject({ state: "published", providerMessageId: expect.any(String) });
        await f.service.processFailedChatRunRetry(receipt.chatActionId!);
        await heartbeat.resumeTaskRetry(companyId, receipt.requestId!);
        await heartbeat.drainActiveRunExecutions();
        expect(providerTurns).toBe(1);
      }
    } finally {
      release();
      await holding;
      authorization?.mockRestore();
      identity?.mockRestore();
      await heartbeat.drainActiveRunExecutions();
      await f.service.shutdown();
      if (late) await settings.updateExperimental(previousSettings);
      if (workingDirectory) rmSync(workingDirectory, { recursive: true, force: true });
    }
  });

  it("preserves ordinary legacy task Retry success without replaying its canonical request", async () => {
    const fixture = await seedCompany();
    const companyId = fixture.companyId, agentId = fixture.assignedAgentId;
    const directory = mkdtempSync(path.join(os.tmpdir(), "legacy-task-retry-control-"));
    const answer = "The ordinary legacy continuation completed once.";
    const execute = vi.fn(async (input: Parameters<ReturnType<typeof adapterModule.getServerAdapter>["execute"]>[0]) => {
      await issueService(db).update(String(input.context.issueId), { status: "done",
        actorAgentId: agentId, actorRunId: input.runId, companyGuard: companyId });
      return { exitCode: 0, signal: null, timedOut: false, summary: answer,
        resultJson: { summary: answer }, provider: "test", model: "openrouter/synthetic" };
    });
    const originalAdapter = adapterModule.getServerAdapter;
    const adapter = vi.spyOn(adapterModule, "getServerAdapter").mockImplementation(type =>
      type === "opencode_local" ? { ...originalAdapter(type), execute } : originalAdapter(type));
    const heartbeat = heartbeatService(db);
    try {
      await db.update(agents).set({ adapterType: "opencode_local", adapterConfig: { cwd: directory,
        model: "openrouter/synthetic", workspaceStrategy: { type: "project_primary" } },
        runtimeConfig: { heartbeat: { wakeOnDemand: true } } }).where(eq(agents.id, agentId));
      const [issue] = await db.insert(issues).values({ companyId, title: "Continue a legacy conversation",
        status: "todo", assigneeAgentId: agentId, workMode: "quick" }).returning();
      const [source] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: issue.id,
        status: "failed", errorCode: "adapter_failed", finishedAt: new Date(), responsibleUserId: "owner-user",
        runnerProfileJson: { adapterDispatch: { adapterType: "opencode_local" } },
        contextSnapshot: { issueId: issue.id, taskId: issue.id, taskKey: issue.id },
        resultJson: { conversationContinuation: "continue_conversation_v1" } }).returning();
      const { issueRoutes } = await import("../../routes/issues.js");
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.actor = boardActor(companyId); next(); });
      app.use("/api", issueRoutes(db, createStorageService().storage));
      app.use(errorHandler);
      const response = await request(app).post(`/api/issues/${issue.id}/retry`)
        .send({ observedRunId: source.id, idempotencyKey: randomUUID() });
      expect(response.status).toBe(202);
      await heartbeat.resumeTaskRetry(companyId, response.body.requestId);
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      const [receipt] = await readAgentWakeupRequestsById(response.body.requestId);
      const [run] = await readHeartbeatRunsById(receipt.runId!);
      expect(receipt.payload).toMatchObject({ issueId: issue.id, taskRetry: { sourceRunId: source.id } });
      expect(run).toMatchObject({ runtimeMode: "legacy", status: "succeeded",
        contextSnapshot: { issueId: issue.id, taskRetryRequestId: response.body.requestId }, resultJson: { summary: answer } });
      expect(execute, JSON.stringify((await readHeartbeatRunsByCompanyId(companyId)).map(value => ({
        id: value.id, status: value.status, source: value.contextSnapshot?.source,
        requestId: value.contextSnapshot?.taskRetryRequestId, retryOfRunId: value.retryOfRunId,
      })))).toHaveBeenCalledOnce();
      await heartbeat.resumeTaskRetry(companyId, response.body.requestId);
      await heartbeat.drainActiveRunExecutions();
      expect(execute).toHaveBeenCalledOnce();
      expect((await readHeartbeatRunsById(source.id))[0]).toEqual(source);
      expect((await readHeartbeatRunsByCompanyId(companyId)).filter(value =>
        value.contextSnapshot?.taskRetryRequestId === response.body.requestId)).toHaveLength(1);
      expect((await readIssuesById(issue.id))[0].executionRunId).toBeNull();
      expect((await readIssuesById(issue.id))[0].status).toBe("done");
    } finally {
      adapter.mockRestore();
      await heartbeat.drainActiveRunExecutions();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rehydrates exact chat retry authority and verifies its persisted projection after service restart", async () => {
    const context = await failedChatRetryFixture("telegram");
    let restarted: ChatChannelService | undefined;
    try {
      const staged = await db.transaction((tx) =>
        context.service.prepareFailedChatRunRetry(tx, {
          companyId: context.fixture.companyId,
          issueId: context.issue.id,
          agentId: context.fixture.assignedAgentId,
          failedRunId: context.runId,
          initiatedByUserId: "owner-user",
        }),
      );
      await context.service.shutdown();
      restarted = createService(context.runtime).service;
      await restarted.processFailedChatRunRetry(staged.actionId);
      const [receipt] = await readAgentWakeupRequestsById(staged.actionId);
      const authorize = (contextSnapshot: Record<string, unknown>) =>
        db.transaction((tx) =>
          authorizeFailedChatRunRetryWake(db, tx as unknown as TestDb, {
            phase: "promotion",
            companyId: context.fixture.companyId,
            agentId: context.fixture.assignedAgentId,
            issueId: context.issue.id,
            wakeupRequestId: staged.actionId,
            contextSnapshot,
          }),
        );
      await expect(authorize(receipt.payload!)).resolves.toBe(true);
      await expect(
        authorize({ ...receipt.payload, wakeCommentIds: [randomUUID()] }),
      ).rejects.toMatchObject({
        details: { code: "chat_failed_run_retry_not_authorized" },
      });
      await expect(
        authorize({ ...receipt.payload, externalAttachmentOmissions: [] }),
      ).rejects.toMatchObject({
        details: { code: "chat_failed_run_retry_not_authorized" },
      });
      await expect(
        authorize({ ...receipt.payload, forceFreshSession: true }),
      ).rejects.toMatchObject({
        details: { code: "chat_failed_run_retry_not_authorized" },
      });
    } finally {
      await restarted?.shutdown();
      await context.service.shutdown();
    }
  });

  it.each(["replay", "operator retry"] as const)(
    "wakes saved native progress when %s restores eligibility", async owner => {
      const context = await safeNativeProgressFixture("telegram", `12${["replay", "operator retry"].indexOf(owner)}`, "channel", "42", true);
      const onError = vi.fn();
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError });
      const progress = () => db.select().from(chatPublications).where(and(
        eq(chatPublications.issueId, context.conversation.issueId),
        like(chatPublications.idempotencyKey, "%:native:%"),
      ));
      const settled = () => vi.waitFor(() => {
        expect(coordinator.nextWakeAt()).toBeNull();
        expect(idleWorkSnapshot().active).toBe(0);
      }, { timeout: 5000 });
      try {
        const run = await context.createRun("saved progress awaiting eligibility");
        await context.addEvent(run);
        const [base] = await db.update(chatPublications).set({
          state: owner === "replay" ? "failed" : "delivery_unknown",
        }).where(eq(chatPublications.idempotencyKey, `run:${run.runId}:working:${context.endpoint.id}`)).returning();
        const restore = () => owner === "replay"
          ? context.service.replayPublication(context.endpoint.id, base.id)
          : context.service.resolvePublication(context.endpoint.id, base.id, "retry_anyway", "owner-user");
        await nativeChatProgressWork(db).register(coordinator, () => true).ready;
        await settled(); expect(await progress()).toEqual([]);
        await restore();
        await expect.poll(progress, { timeout: 5000 }).toEqual([
          expect.objectContaining({ idempotencyKey: `run:${run.runId}:working:${context.endpoint.id}:native:making_progress:1` }),
        ]);
        await settled();
        const select = vi.spyOn(db, "select"), transaction = vi.spyOn(db, "transaction");
        try {
          await new Promise(resolve => setTimeout(resolve, 1200));
          expect(select).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled();
        } finally { select.mockRestore(); transaction.mockRestore(); }
        expect(onError).not.toHaveBeenCalled();
      } finally { await coordinator.stop(); await retirePublicationFixture(context.service, context.endpoint.id); }
    },
  );

  it("advances native progress past suppressed candidates with microsecond timestamps", async () => {
    const context = await safeNativeProgressFixture("telegram", "119");
    try {
      const valid = await context.createRun("eligible after rejected page");
      const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, valid.runId));
      const rejectedIds = Array.from({ length: 30 }, () => randomUUID());
      await db.insert(heartbeatRuns).values(rejectedIds.map(id => ({
        id, companyId: source.companyId, agentId: source.agentId,
        runtimeMode: "native", status: "running",
        contextSnapshot: { ...source.contextSnapshot, endpointId: randomUUID() },
      })));
      await db.insert(chatPublications).values(rejectedIds.map(id => ({
        companyId: context.fixture.companyId, endpointId: context.endpoint.id,
        conversationId: context.conversation.id, issueId: context.conversation.issueId,
        idempotencyKey: `run:${id}:working:${context.endpoint.id}`,
        payload: { text: "Maya is working…", progressState: "working" as const },
        state: "published" as const, createdAt: valid.baseCreatedAt,
      })));
      const eventAt = new Date(valid.baseCreatedAt.getTime() + 30_000);
      await db.insert(heartbeatRunEvents).values(rejectedIds.map(runId => ({
        companyId: source.companyId, runId, agentId: source.agentId,
        seq: 1, eventType: "item.completed",
        createdAt: sql`${eventAt.toISOString()}::timestamptz + interval '0.000123 seconds'`,
      })));
      await context.addEvent(valid, "item.completed", 1, new Date(eventAt.getTime() + 1));
      const select = db.select.bind(db);
      let pages = 0;
      const guard = vi.spyOn(db, "select").mockImplementation((...args) => {
        if (args[0] && "eventCreatedAt" in args[0] && ++pages > 10) {
          throw new Error("Native progress pagination did not advance past suppressed candidates");
        }
        return select(...args);
      });
      try {
        await expect(enqueueSafeNativeChatProgress(db, { since: eventAt, limit: 1 })).resolves.toBe(1);
      } finally { guard.mockRestore(); }
      const progress = await db.select().from(chatPublications).where(and(
        eq(chatPublications.conversationId, context.conversation.id),
        like(chatPublications.idempotencyKey, "%:native:%"),
      ));
      expect(progress).toEqual([expect.objectContaining({
        idempotencyKey: `run:${valid.runId}:working:${context.endpoint.id}:native:making_progress:1`,
      })]);
    } finally { await retirePublicationFixture(context.service, context.endpoint.id); }
  });

  it.each(["separate owners", "combined budget"] as const)(
    "keeps lifecycle and native progress projection independent with %s",
    async (mode) => {
      await enqueueChatRunMilestones(db, { since: new Date(0) });
      const context = await safeNativeProgressFixture("telegram", mode === "separate owners" ? "111" : "112");
      try {
        const progressRun = await context.createRun("ongoing work");
        await context.addEvent(progressRun);
        const failedRun = await context.createRun("failed work");
        await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, failedRun.runId));
        const input = { since: new Date(0), limit: 1 };
        await expect((mode === "separate owners" ? enqueueChatRunLifecycleMilestones : enqueueChatRunMilestones)(db, input)).resolves.toBe(1);
        const rows = () => db.select({ key: chatPublications.idempotencyKey }).from(chatPublications)
          .where(eq(chatPublications.conversationId, context.conversation.id));
        expect((await rows()).map(row => row.key)).toContain(`run:${failedRun.runId}:failed:${context.endpoint.id}`);
        expect((await rows()).some(row => row.key.includes(":native:"))).toBe(false);
        if (mode === "separate owners") {
          await expect(enqueueChatRunLifecycleMilestones(db, input)).resolves.toBe(0);
        }
        await expect((mode === "separate owners" ? enqueueSafeNativeChatProgress : enqueueChatRunMilestones)(db, input)).resolves.toBe(1);
        expect((await rows()).filter(row => row.key.includes(":native:"))).toEqual([
          { key: `run:${progressRun.runId}:working:${context.endpoint.id}:native:making_progress:1` },
        ]);
        await expect(enqueueChatRunMilestones(db, input)).resolves.toBe(0);
      } finally {
        await retirePublicationFixture(context.service, context.endpoint.id);
      }
    },
  );

  it.each(["issue", "run"] as const)(
    "skips a locked native progress %s while unrelated final and question publications deliver",
    async (lockTarget) => {
      const blocked = await safeNativeProgressFixture("telegram", "71");
      const final = await safeNativeProgressFixture("telegram", "72");
      const question = await safeNativeProgressFixture("telegram", "73");
      const blockedRun = await blocked.createRun("contended progress");
      const finalRun = await final.createRun("ready final");
      const questionRun = await question.createRun("ready question");
      await blocked.addEvent(blockedRun);
      const finalComment = await addSelectedChatFinal({
        agentId: final.fixture.assignedAgentId,
        body: "The unrelated final is ready",
        companyId: final.fixture.companyId,
        issueId: final.conversation.issueId,
        runId: finalRun.runId,
      });
      const interaction = await issueThreadInteractionService(db).create(
        {
          id: question.conversation.issueId,
          companyId: question.fixture.companyId,
        },
        {
          kind: "ask_user_questions",
          continuationPolicy: "wake_assignee",
          sourceRunId: questionRun.runId,
          payload: {
            version: 1,
            questions: [
              {
                id: "color",
                prompt: "Choose a color",
                selectionMode: "single",
                required: true,
                options: [
                  { id: "amber", label: "Amber" },
                  { id: "cobalt", label: "Cobalt" },
                ],
              },
            ],
          },
        },
        { agentId: question.fixture.assignedAgentId },
      );
      let release!: () => void;
      let entered!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const acquired = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const holder = db.transaction(async (tx) => {
        if (lockTarget === "issue") {
          await tx
            .select({ id: issues.id })
            .from(issues)
            .where(eq(issues.id, blocked.conversation.issueId))
            .for("update");
        } else {
          await tx
            .select({ id: heartbeatRuns.id })
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, blockedRun.runId))
            .for("update");
        }
        entered();
        await held;
      });
      let flush: Promise<void> | undefined;
      let flushError: unknown;
      try {
        try {
          await acquired;
          flush = (async () => {
            await enqueueChatRunMilestones(db, { since: new Date(0) });
            await blocked.service.processPendingPublications(100);
          })().catch((error) => {
            flushError = error;
          });
          await vi.waitFor(
            async () => {
              if (flushError) throw flushError;
              const ready = await db
                .select()
                .from(chatPublications)
                .where(
                  or(
                    eq(chatPublications.commentId, finalComment.id),
                    eq(
                      chatPublications.idempotencyKey,
                      `interaction:${interaction.id}:${question.endpoint.id}`,
                    ),
                  ),
                );
              expect(ready).toHaveLength(2);
              expect(
                ready.every((publication) => publication.state === "published"),
              ).toBe(true);
            },
            {
              // Keep the lock held until these exact receipts arrive. The
              // global sweep may still be settling unrelated fixture work;
              // its completion is not the nonblocking-delivery assertion.
              timeout: 5_000,
            },
          );
          expect(
            blocked.runtime.endpoints.get(final.endpoint.id)?.edits.at(-1)
              ?.text,
          ).toBe("The unrelated final is ready");
          expect(
            blocked.runtime.endpoints.get(question.endpoint.id)?.edits.at(-1)
              ?.text,
          ).toContain("Choose a color");
          expect(blocked.providerRuntime.edits).toEqual([]);
        } finally {
          release();
          await Promise.allSettled([holder, flush]);
        }
        if (flushError) throw flushError;
        await expect(
          enqueueChatRunMilestones(db, { since: new Date(0) }),
        ).resolves.toBe(1);
        await blocked.service.processPendingPublications(100);
        expect(blocked.providerRuntime.edits).toEqual([
          expect.objectContaining({
            messageId: "outbound-1",
            text: "Maya is making progress…",
          }),
        ]);
        await expect(
          enqueueChatRunMilestones(db, { since: new Date(0) }),
        ).resolves.toBe(0);
      } finally {
        await Promise.allSettled([
          blocked.service.shutdown(),
          final.service.shutdown(),
          question.service.shutdown(),
        ]);
      }
    },
  );

  it.each(["question", "final", "revoked"] as const)(
    "reauthorizes skipped native progress after %s wins before retry",
    async (winner) => {
      const context = await safeNativeProgressFixture("telegram", "74");
      const run = await context.createRun("progress that must remain current");
      await context.addEvent(run);
      let release!: () => void;
      let entered!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const acquired = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const holder = db.transaction(async (tx) => {
        await tx
          .select({ id: issues.id })
          .from(issues)
          .where(eq(issues.id, context.conversation.issueId))
          .for("update");
        entered();
        await held;
      });
      try {
        try {
          await acquired;
          await expect(
            enqueueChatRunMilestones(db, { since: new Date(0) }),
          ).resolves.toBe(0);
        } finally {
          release();
          await holder;
        }
        if (winner === "question") {
          await issueThreadInteractionService(db).create(
            {
              id: context.conversation.issueId,
              companyId: context.fixture.companyId,
            },
            {
              kind: "ask_user_questions",
              continuationPolicy: "wake_assignee",
              sourceRunId: run.runId,
              payload: {
                version: 1,
                questions: [
                  {
                    id: "color",
                    prompt: "Choose a color",
                    selectionMode: "single",
                    required: true,
                    options: [
                      { id: "amber", label: "Amber" },
                      { id: "cobalt", label: "Cobalt" },
                    ],
                  },
                ],
              },
            },
            { agentId: context.fixture.assignedAgentId },
          );
        } else if (winner === "final") {
          await addSelectedChatFinal({
            agentId: context.fixture.assignedAgentId,
            body: "Current selected final",
            companyId: context.fixture.companyId,
            issueId: context.conversation.issueId,
            runId: run.runId,
          });
          await db
            .update(heartbeatRuns)
            .set({
              status: "succeeded",
              resultJson: {
                presentationDecision: {
                  chosenSource: "existing_issue_comment",
                  commentAction: "none",
                },
              },
            })
            .where(eq(heartbeatRuns.id, run.runId));
        } else {
          await db
            .update(chatEndpoints)
            .set({ allowDirectMessages: false, updatedAt: new Date() })
            .where(eq(chatEndpoints.id, context.endpoint.id));
        }
        await enqueueChatRunMilestones(db, { since: new Date(0) });
        await context.service.processPendingPublications(100);
        expect(
          context.providerRuntime.edits.map((edit) => edit.text),
        ).not.toContain("Maya is making progress…");
        const progress = await db
          .select()
          .from(chatPublications)
          .where(
            like(
              chatPublications.idempotencyKey,
              `run:${run.runId}:working:${context.endpoint.id}:native:%`,
            ),
          );
        expect(
          progress.every((publication) => publication.state === "cancelled"),
        ).toBe(true);
        if (winner === "final")
          expect(context.providerRuntime.edits.at(-1)?.text).toBe(
            "Current selected final",
          );
        if (winner === "question")
          expect(context.providerRuntime.edits.at(-1)?.text).toContain(
            "Choose a color",
          );
        if (winner === "revoked")
          expect(context.providerRuntime.edits).toEqual([]);
      } finally {
        release();
        await Promise.allSettled([holder, context.service.shutdown()]);
      }
    },
  );

  it("settles an interrupted native run once without overwriting its successor", async () => {
    const context = await safeNativeProgressFixture("telegram", "61");
    try {
      const interrupted = await context.createRun("the original request");
      const [originalWorking] = await readChatPublicationsByIdempotencyKey(`run:${interrupted.runId}:working:${context.endpoint.id}`);
      expect(originalWorking?.providerMessageId).toBeTruthy();
      await db
        .update(heartbeatRuns)
        .set({
          status: "interrupted",
          finishedAt: new Date(),
          errorCode: "server_shutdown_interrupted",
          error:
            "PRIVATE stdout tool arguments token=PRIVATE-INTERRUPTION-TOKEN",
          resultJson: { summary: "PRIVATE internal interruption summary" },
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, interrupted.runId));

      // Model delayed milestone reconciliation after a successor has already
      // published its own working placeholder in the same conversation.
      const successor = await context.createRun("the successor request");
      const [successorWorking] = await readChatPublicationsByIdempotencyKey(`run:${successor.runId}:working:${context.endpoint.id}`);
      expect(successorWorking?.providerMessageId).toBeTruthy();
      expect(successorWorking?.providerMessageId).not.toBe(
        originalWorking?.providerMessageId,
      );

      await expect(enqueueChatRunMilestones(db)).resolves.toBe(1);
      await context.service.processPendingPublications(100);
      await expect(enqueueChatRunMilestones(db)).resolves.toBe(0);
      await expect(
        context.service.processPendingPublications(100),
      ).resolves.toBe(0);
      expect(context.providerRuntime.posts).toHaveLength(2);
      expect(context.providerRuntime.edits).toEqual([
        {
          threadId: context.thread.thread.id,
          messageId: originalWorking!.providerMessageId,
          text: "Maya stopped before completing this turn. Open the task in Paperclip for details.",
        },
      ]);

      await addSelectedChatFinal({
        agentId: context.fixture.assignedAgentId,
        body: "The successor's authoritative answer",
        companyId: context.fixture.companyId,
        issueId: context.conversation.issueId,
        runId: successor.runId,
      });
      await db
        .update(heartbeatRuns)
        .set({
          status: "succeeded",
          resultJson: {
            presentationDecision: {
              chosenSource: "existing_issue_comment",
              commentAction: "none",
            },
          },
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, successor.runId));
      await context.service.processPendingPublications(100);
      await expect(enqueueChatRunMilestones(db)).resolves.toBe(0);
      expect(context.providerRuntime.edits).toHaveLength(2);
      expect(context.providerRuntime.edits[1]).toEqual({
        threadId: context.thread.thread.id,
        messageId: successorWorking!.providerMessageId,
        text: "The successor's authoritative answer",
      });
      expect(
        JSON.stringify({
          posts: context.providerRuntime.posts,
          edits: context.providerRuntime.edits,
        }),
      ).not.toMatch(
        /PRIVATE|stdout|tool arguments|server_shutdown_interrupted/,
      );
      await expect(
        readChatPublicationsByIdempotencyKey(`run:${interrupted.runId}:failed:${context.endpoint.id}`),
      ).resolves.toEqual([
        expect.objectContaining({
          state: "published",
          providerMessageId: originalWorking!.providerMessageId,
          payload: {
            progressState: "failed",
            text: "Maya stopped before completing this turn. Open the task in Paperclip for details.",
          },
        }),
      ]);
      await expect(
        db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, interrupted.runId)),
      ).resolves.toEqual([{ status: "interrupted" }]);
    } finally {
      await context.service.shutdown();
    }
  });

  it.each(["pending", "published"] as const)(
    "preserves an interrupted run's selected final when its publication is %s",
    async (publicationState) => {
      const context = await safeNativeProgressFixture(
        "telegram",
        publicationState === "pending" ? "62" : "63",
      );
      try {
        const run = await context.createRun("an already answered request");
        const final = await addSelectedChatFinal({
          agentId: context.fixture.assignedAgentId,
          body: "The selected final remains authoritative",
          companyId: context.fixture.companyId,
          issueId: context.conversation.issueId,
          runId: run.runId,
        });
        if (publicationState === "published")
          await context.service.processPendingPublications(100);
        await db
          .update(heartbeatRuns)
          .set({
            status: "interrupted",
            errorCode: "lease_released_before_terminal",
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(heartbeatRuns.id, run.runId));
        await expect(enqueueChatRunMilestones(db, { limit: 1 })).resolves.toBe(
          0,
        );
        await context.service.processPendingPublications(100);
        await expect(enqueueChatRunMilestones(db)).resolves.toBe(0);
        expect(context.providerRuntime.posts).toHaveLength(1);
        expect(context.providerRuntime.edits).toEqual([
          expect.objectContaining({
            text: "The selected final remains authoritative",
          }),
        ]);
        await expect(
          db
            .select({ state: chatPublications.state })
            .from(chatPublications)
            .where(eq(chatPublications.commentId, final.id)),
        ).resolves.toEqual([{ state: "published" }]);
      } finally {
        await context.service.shutdown();
      }
    },
  );

  it.each(
    (["slack", "telegram"] as const).flatMap((provider) =>
      (["failed", "cancelled", "timed_out"] as const).flatMap((status) =>
        (["published_final", "pending_final", "failure_first"] as const).map(
          (order) => ({ provider, status, order }),
        ),
      ),
    ),
  )(
    "preserves selected answer and failure lanes on $provider after $status ($order)",
    async ({ provider, status, order }) => {
      const context = await safeNativeProgressFixture(provider, "81");
      try {
        const original = await context.createRun("the original request");
        const successor = await context.createRun("the successor request");
        const [originalWorking] = await readChatPublicationsByIdempotencyKey(`run:${original.runId}:working:${context.endpoint.id}`);
        const [successorWorking] = await readChatPublicationsByIdempotencyKey(`run:${successor.runId}:working:${context.endpoint.id}`);
        const addFinal = () =>
          addSelectedChatFinal({
            agentId: context.fixture.assignedAgentId,
            body: "The original selected answer remains available",
            companyId: context.fixture.companyId,
            issueId: context.conversation.issueId,
            runId: original.runId,
          });
        let final = order === "failure_first" ? null : await addFinal();
        if (order === "published_final")
          await context.service.processPendingPublications(100);
        await db
          .update(heartbeatRuns)
          .set({
            status,
            errorCode: "adapter_failed",
            error: "PRIVATE internal error token=do-not-publish",
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(heartbeatRuns.id, original.runId));
        await enqueueChatRunMilestones(db);
        if (order === "failure_first") {
          await context.service.processPendingPublications(100);
          final = await addFinal();
        }
        await context.service.processPendingPublications(100);
        const [answerPublication] = await readChatPublicationsByCommentId(final!.id);
        const [failurePublication] = await readChatPublicationsByIdempotencyKey(`run:${original.runId}:failed:${context.endpoint.id}`);
        expect(answerPublication?.state).toBe("published");
        expect(failurePublication?.state).toBe("published");
        expect(answerPublication?.providerMessageId).not.toBe(
          failurePublication?.providerMessageId,
        );
        expect(
          order === "failure_first"
            ? failurePublication?.providerMessageId
            : answerPublication?.providerMessageId,
        ).toBe(originalWorking!.providerMessageId);
        expect(context.providerRuntime.posts).toHaveLength(3);
        expect(context.providerRuntime.edits).toHaveLength(1);
        expect(context.providerRuntime.edits[0]?.messageId).toBe(
          originalWorking!.providerMessageId,
        );
        expect(context.providerRuntime.edits[0]?.messageId).not.toBe(
          successorWorking!.providerMessageId,
        );
        const links = await db
          .select({
            providerMessageId: chatMessageLinks.providerMessageId,
            publicationId: chatMessageLinks.publicationId,
            commentId: chatMessageLinks.commentId,
          })
          .from(chatMessageLinks)
          .where(
            and(
              eq(chatMessageLinks.conversationId, context.conversation.id),
              eq(chatMessageLinks.direction, "outbound"),
            ),
          );
        expect(links).toHaveLength(3);
        expect(links).toEqual(
          expect.arrayContaining([
            {
              providerMessageId: answerPublication!.providerMessageId,
              publicationId: answerPublication!.id,
              commentId: final!.id,
            },
            {
              providerMessageId: failurePublication!.providerMessageId,
              publicationId: failurePublication!.id,
              commentId: null,
            },
            {
              providerMessageId: successorWorking!.providerMessageId,
              publicationId: successorWorking!.id,
              commentId: null,
            },
          ]),
        );
        expect(JSON.stringify(context.providerRuntime.posts)).not.toMatch(
          /PRIVATE|adapter_failed|do-not-publish/,
        );
        await enqueueChatRunMilestones(db);
        await context.service.processPendingPublications(100);
        expect(context.providerRuntime.posts).toHaveLength(3);
        expect(context.providerRuntime.edits).toHaveLength(1);
        await expect(
          db
            .select({ status: heartbeatRuns.status })
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, original.runId)),
        ).resolves.toEqual([{ status }]);
      } finally {
        await context.service.shutdown();
      }
    },
  );

  it.each([
    ["slack", "1", "channel"],
    ["github", "2", "channel"],
    ["discord", "3", "channel"],
    ["telegram", "4", "personal"],
    ["microsoft-teams", "5", "channel"],
    ["microsoft-teams", "6", "personal"],
  ] as const)(
    "coalesces closed native progress on %s fixture %s (%s) without projecting event content",
    async (provider, suffix, surface) => {
      // The collector is global. A provider-filtered run may leave a failed
      // run's milestone from an earlier fixture that the full suite already
      // drained. Settle that work before asserting this fixture's exact count.
      await enqueueChatRunMilestones(db, { since: new Date(0) });
      const context = await safeNativeProgressFixture(
        provider,
        suffix,
        surface,
      );
      try {
        const run = await context.createRun(`${provider} work`);
        await context.addEvent(run);
        // A future event name that merely shares an allowlisted prefix must not
        // become provider authority or replace the latest exact event.
        await context.addEvent(run, "item.completed.private-extension", 2);

        await expect(
          enqueueChatRunMilestones(db, { since: new Date(0) }),
        ).resolves.toBe(provider === "github" ? 0 : 1);
        await context.service.processPendingPublications(100);

        expect(context.providerRuntime.posts).toEqual(provider === "github" ? [] : [
          {
            threadId: context.thread.thread.id,
            text: `Maya is working on ${provider} work…`,
          },
        ]);
        expect(context.providerRuntime.edits).toEqual(provider === "github" ? [] : [
          {
            threadId: context.thread.thread.id,
            messageId: "outbound-1",
            text: "Maya is making progress…",
          },
        ]);
        expect(
          JSON.stringify({
            edits: context.providerRuntime.edits,
            posts: context.providerRuntime.posts,
          }),
        ).not.toMatch(/PRIVATE|secret_internal_tool/);
        const progressRows = await db
          .select()
          .from(chatPublications)
          .where(
            like(
              chatPublications.idempotencyKey,
              `run:${run.runId}:working:${context.endpoint.id}:native:%`,
            ),
          );
        expect(progressRows).toEqual(provider === "github" ? [] : [
          expect.objectContaining({
            idempotencyKey: `run:${run.runId}:working:${context.endpoint.id}:native:making_progress:1`,
            payload: {
              text: "Maya is making progress…",
              progressState: "working",
            },
            providerMessageId: "outbound-1",
            state: "published",
          }),
        ]);
        await expect(
          enqueueChatRunMilestones(db, { since: new Date(0) }),
        ).resolves.toBe(0);
        await expect(
          context.service.processPendingPublications(100),
        ).resolves.toBe(0);
        expect(context.providerRuntime.posts).toHaveLength(provider === "github" ? 0 : 1);
        expect(context.providerRuntime.edits).toHaveLength(provider === "github" ? 0 : 1);
      } finally {
        await retirePublicationFixture(context.service, context.endpoint.id);
      }
    },
  );

  it.each([
    ["slack", "91", "channel"],
    ["github", "92", "channel"],
    ["discord", "93", "channel"],
    ["telegram", "94", "personal"],
    ["microsoft-teams", "95", "channel"],
    ["microsoft-teams", "96", "personal"],
  ] as const)(
    "keeps provider startup diagnostics private on %s fixture %s (%s)",
    async (provider, suffix, surface) => {
      const context = await safeNativeProgressFixture(
        provider,
        suffix,
        surface,
      );
      try {
        const run = await context.createRun("startup recovery");
        // This is a publication-boundary fixture, not proof that a provider
        // startup receipt is authentic or that any process has retired.
        const phases = ["intent", "spawned", "initialization_failed"];
        await db.insert(heartbeatRunEvents).values(
          phases.map((phase, index) => ({
            companyId: context.fixture.companyId,
            agentId: context.fixture.assignedAgentId,
            runId: run.runId,
            seq: index + 1,
            eventType: "harness.diagnostic",
            message: "PRIVATE provider startup evidence",
            payload: {
              code: "provider_startup_ownership",
              startup: {
                schema: "paperclip.provider_startup.v1",
                phase,
                launchId: "PRIVATE-STARTUP-LAUNCH",
                requestedThreadId: "PRIVATE-REQUESTED-THREAD",
                authenticatedThreadId: null,
                directChildExitObserved: phase === "initialization_failed",
              },
            },
            createdAt: new Date(run.baseCreatedAt.getTime() + 30_000 + index),
          })),
        );
        await expect(
          enqueueChatRunMilestones(db, { since: new Date(0) }),
        ).resolves.toBe(0);
        await expect(
          context.service.processPendingPublications(100),
        ).resolves.toBe(0);
        expect(context.providerRuntime.posts).toHaveLength(provider === "github" ? 0 : 1);
        expect(context.providerRuntime.edits).toHaveLength(0);

        // Private diagnostics must neither generate progress nor suppress a
        // later real, allowlisted progress event in the same run.
        await context.addEvent(run, "item.completed", 4);
        await expect(
          enqueueChatRunMilestones(db, { since: new Date(0) }),
        ).resolves.toBe(provider === "github" ? 0 : 1);
        await context.service.processPendingPublications(100);
        expect(context.providerRuntime.posts).toHaveLength(provider === "github" ? 0 : 1);
        expect(context.providerRuntime.edits).toEqual(provider === "github" ? [] : [
          {
            threadId: context.thread.thread.id,
            messageId: "outbound-1",
            text: "Maya is making progress…",
          },
        ]);
        const publications = await db
          .select({ payload: chatPublications.payload })
          .from(chatPublications)
          .where(eq(chatPublications.conversationId, context.conversation.id));
        expect(JSON.stringify(publications)).not.toMatch(
          /PRIVATE|provider_startup|harness\.diagnostic|launchId|requestedThreadId|directChildExitObserved/,
        );
      } finally {
        await context.service.shutdown();
      }
    },
  );

  it.each([true, false])(
    "publishes native progress with a typed issue binding present: %s",
    async (typedBinding) => {
      const context = await safeNativeProgressFixture("telegram", typedBinding ? "107" : "108");
      try {
        const run = await context.createRun("issue binding");
        if (typedBinding) {
          await db.update(heartbeatRuns).set({
            scopeKind: "issue",
            issueId: context.conversation.issueId,
            contextSnapshot: sql`${heartbeatRuns.contextSnapshot} - 'issueId'`,
          }).where(and(
            eq(heartbeatRuns.companyId, context.fixture.companyId),
            eq(heartbeatRuns.id, run.runId),
          ));
        }
        await context.addEvent(run, "tool.execution.started", 1);
        await expect(enqueueChatRunMilestones(db, { since: new Date(0) })).resolves.toBe(1);
        await expect(db.select({ issueId: chatPublications.issueId }).from(chatPublications).where(and(
          eq(chatPublications.companyId, context.fixture.companyId),
          eq(chatPublications.conversationId, context.conversation.id),
          like(chatPublications.idempotencyKey, `run:${run.runId}:working:${context.endpoint.id}:native:%`),
        ))).resolves.toEqual([{ issueId: context.conversation.issueId }]);
        await context.service.processPendingPublications(100);
        expect(context.providerRuntime.edits).toHaveLength(1);
      } finally {
        await context.service.shutdown();
      }
    },
  );

  it("enforces the native progress cadence boundary and one publication per phase", async () => {
    const context = await safeNativeProgressFixture("telegram", "8");
    const run = await context.createRun("cadence boundaries");
    const at = (offsetMs: number) =>
      new Date(run.baseCreatedAt.getTime() + offsetMs);

    await context.addEvent(run, "research.progressed", 1, at(19_999));
    await expect(
      enqueueChatRunMilestones(db, { since: new Date(0) }),
    ).resolves.toBe(0);

    await context.addEvent(run, "research.completed", 2, at(20_000));
    await expect(
      enqueueChatRunMilestones(db, { since: new Date(0) }),
    ).resolves.toBe(1);
    const [researchPublication] = await db
      .select({ id: chatPublications.id })
      .from(chatPublications)
      .where(
        eq(
          chatPublications.idempotencyKey,
          `run:${run.runId}:working:${context.endpoint.id}:native:researching:2`,
        ),
      );
    if (!researchPublication) {
      throw new Error("Expected research progress publication");
    }
    // Model a prior sweep at the event boundary so the next phase can exercise
    // the same exact cadence without waiting on wall-clock time.
    await db
      .update(chatPublications)
      .set({ createdAt: at(20_000), updatedAt: at(20_000) })
      .where(eq(chatPublications.id, researchPublication.id));

    await context.addEvent(run, "tool.execution.started", 3, at(39_999));
    await expect(
      enqueueChatRunMilestones(db, { since: new Date(0) }),
    ).resolves.toBe(0);
    await context.addEvent(run, "tool.execution.completed", 4, at(40_000));
    await expect(
      enqueueChatRunMilestones(db, { since: new Date(0) }),
    ).resolves.toBe(1);

    await context.addEvent(run, "tool.execution.progressed", 5, at(60_000));
    await expect(
      enqueueChatRunMilestones(db, { since: new Date(0) }),
    ).resolves.toBe(0);
    await expect(
      db
        .select({ id: chatPublications.id })
        .from(chatPublications)
        .where(
          like(
            chatPublications.idempotencyKey,
            `run:${run.runId}:working:${context.endpoint.id}:native:%`,
          ),
        ),
    ).resolves.toHaveLength(2);
    await context.service.shutdown();
  });

  it("does not replay stale native progress after a paused endpoint restarts behind an exact final", async () => {
    const context = await safeNativeProgressFixture("telegram", "7");
    await qualifySetupRoundTrip(
      context.service,
      context.endpoint.id,
      context.thread.thread.channelId,
    );
    await context.service.test(context.endpoint.id);
    const run = await context.createRun("paused restart");
    const workingProviderMessageId = await db
      .select({ providerMessageId: chatPublications.providerMessageId })
      .from(chatPublications)
      .where(
        eq(
          chatPublications.idempotencyKey,
          `run:${run.runId}:working:${context.endpoint.id}`,
        ),
      )
      .then((rows) => rows[0]?.providerMessageId ?? null);
    if (!workingProviderMessageId) {
      throw new Error("Expected persisted working publication identity");
    }
    await context.addEvent(run, "tool.execution.completed");
    await expect(
      enqueueChatRunMilestones(db, { since: new Date(0) }),
    ).resolves.toBe(1);

    await context.service.configure(
      context.endpoint.id,
      { action: "pause" },
      "owner-user",
    );
    const finalComment = await addSelectedChatFinal({
      agentId: context.fixture.assignedAgentId,
      body: "Authoritative final after restart",
      companyId: context.fixture.companyId,
      issueId: context.conversation.issueId,
      runId: run.runId,
    });
    await db
      .update(heartbeatRuns)
      .set({
        status: "succeeded",
        resultJson: {
          presentationDecision: {
            chosenSource: "existing_issue_comment",
            commentAction: "none",
          },
        },
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, run.runId));
    const telegramBotId = await db
      .select({ botExternalId: chatEndpoints.botExternalId })
      .from(chatEndpoints)
      .where(eq(chatEndpoints.id, context.endpoint.id))
      .then((rows) => rows[0]?.botExternalId ?? null);
    if (!telegramBotId) throw new Error("Expected persisted Telegram bot id");
    await context.service.shutdown();

    const restartedRuntime = new FakeChatSdkRuntime();
    const restarted = createService(
      restartedRuntime,
      fakeTelegramFetch(Number(telegramBotId)),
    );
    await restarted.service.configure(
      context.endpoint.id,
      { action: "resume" },
      "owner-user",
    );
    await expect(
      restarted.service.processPendingPublications(100),
    ).resolves.toBe(2);

    const endpointRuntime = restartedRuntime.endpoints.get(context.endpoint.id);
    expect(endpointRuntime?.posts).toEqual([]);
    expect(endpointRuntime?.edits).toEqual([
      {
        threadId: context.thread.thread.id,
        messageId: workingProviderMessageId,
        text: "Authoritative final after restart",
      },
    ]);
    const runPublications = await db
      .select({
        idempotencyKey: chatPublications.idempotencyKey,
        redactedError: chatPublications.redactedError,
        state: chatPublications.state,
      })
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.endpointId, context.endpoint.id),
          like(chatPublications.idempotencyKey, `run:${run.runId}:%`),
        ),
      );
    expect(runPublications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          idempotencyKey: `run:${run.runId}:working:${context.endpoint.id}:native:using_tools:1`,
          redactedError:
            "Run reached a terminal state before progress delivery",
          state: "cancelled",
        }),
      ]),
    );
    await expect(
      db
        .select({
          providerMessageId: chatPublications.providerMessageId,
          state: chatPublications.state,
        })
        .from(chatPublications)
        .where(eq(chatPublications.commentId, finalComment.id)),
    ).resolves.toEqual([
      { providerMessageId: workingProviderMessageId, state: "published" },
    ]);
    await restarted.service.shutdown();
  });

  it("suppresses queued and working placeholders that terminalize while paused", async () => {
    const context = await safeNativeProgressFixture("telegram", "6");
    await qualifySetupRoundTrip(
      context.service,
      context.endpoint.id,
      context.thread.thread.channelId,
    );
    await context.service.test(context.endpoint.id);
    const runs = await Promise.all(
      (["queued", "working"] as const).map(async (progressState, index) => {
        const runId = randomUUID();
        await db.insert(heartbeatRuns).values({
          id: runId,
          companyId: context.fixture.companyId,
          agentId: context.fixture.assignedAgentId,
          runtimeMode: "native",
          status: "running",
          contextSnapshot: await chatWakeContext({
            endpointId: context.endpoint.id,
            issueId: context.conversation.issueId,
            provider: "telegram",
            providerMessageId: context.messageId,
          }),
        });
        await db.insert(chatPublications).values({
          companyId: context.fixture.companyId,
          endpointId: context.endpoint.id,
          conversationId: context.conversation.id,
          issueId: context.conversation.issueId,
          idempotencyKey: `run:${runId}:${progressState}:${context.endpoint.id}`,
          payload: {
            text: `Maya is ${progressState}…`,
            progressState,
          },
          state: "pending",
          createdAt: new Date(Date.now() - 60_000 + index),
        });
        return { progressState, runId };
      }),
    );

    await context.service.configure(
      context.endpoint.id,
      { action: "pause" },
      "owner-user",
    );
    const finalCommentIds: string[] = [];
    for (const [index, run] of runs.entries()) {
      const finalComment = await addSelectedChatFinal({
        agentId: context.fixture.assignedAgentId,
        body: `Final response ${index + 1}`,
        companyId: context.fixture.companyId,
        issueId: context.conversation.issueId,
        runId: run.runId,
      });
      finalCommentIds.push(finalComment.id);
      await db
        .update(heartbeatRuns)
        .set({
          status: "succeeded",
          resultJson: {
            presentationDecision: {
              chosenSource: "existing_issue_comment",
              commentAction: "none",
            },
          },
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, run.runId));
    }
    const telegramBotId = await db
      .select({ botExternalId: chatEndpoints.botExternalId })
      .from(chatEndpoints)
      .where(eq(chatEndpoints.id, context.endpoint.id))
      .then((rows) => rows[0]?.botExternalId ?? null);
    if (!telegramBotId) throw new Error("Expected persisted Telegram bot id");
    await context.service.shutdown();

    const restartedRuntime = new FakeChatSdkRuntime();
    const restarted = createService(
      restartedRuntime,
      fakeTelegramFetch(Number(telegramBotId)),
    );
    await restarted.service.configure(
      context.endpoint.id,
      { action: "resume" },
      "owner-user",
    );
    await expect(
      restarted.service.processPendingPublications(100),
    ).resolves.toBe(4);

    const endpointRuntime = restartedRuntime.endpoints.get(context.endpoint.id);
    expect(endpointRuntime?.posts.map((post) => post.text)).toEqual([
      "Final response 1",
      "Final response 2",
    ]);
    expect(endpointRuntime?.edits).toEqual([]);
    const cancelledProgress = await db
      .select({
        idempotencyKey: chatPublications.idempotencyKey,
        redactedError: chatPublications.redactedError,
        state: chatPublications.state,
      })
      .from(chatPublications)
      .where(
        inArray(
          chatPublications.idempotencyKey,
          runs.map(
            (run) =>
              `run:${run.runId}:${run.progressState}:${context.endpoint.id}`,
          ),
        ),
      );
    expect(cancelledProgress).toHaveLength(runs.length);
    expect(cancelledProgress).toEqual(
      expect.arrayContaining(
        runs.map((run) => ({
          idempotencyKey: `run:${run.runId}:${run.progressState}:${context.endpoint.id}`,
          redactedError:
            "Run reached a terminal state before progress delivery",
          state: "cancelled",
        })),
      ),
    );
    await expect(
      db
        .select({ state: chatPublications.state })
        .from(chatPublications)
        .where(inArray(chatPublications.commentId, finalCommentIds)),
    ).resolves.toEqual([{ state: "published" }, { state: "published" }]);
    await restarted.service.shutdown();
  });

  it.each([
    ["telegram", "9", "personal"],
    ["microsoft-teams", "10", "personal"],
    ["microsoft-teams", "11", "channel"],
  ] as const)(
    "keeps native progress behind question, final, and current reach authority on %s fixture %s (%s)",
    async (provider, suffix, surface) => {
      const context = await safeNativeProgressFixture(
        provider,
        suffix,
        surface,
      );
      const setReachEnabled = async (enabled: boolean) => {
        if (context.conversation.isDirectMessage) {
          await db
            .update(chatEndpoints)
            .set({ allowDirectMessages: enabled, updatedAt: new Date() })
            .where(eq(chatEndpoints.id, context.endpoint.id));
        } else {
          expect(context.conversation.resourceId).toBeTruthy();
          await db
            .update(chatEndpointResources)
            .set({ enabled, updatedAt: new Date() })
            .where(
              and(
                eq(chatEndpointResources.endpointId, context.endpoint.id),
                eq(chatEndpointResources.id, context.conversation.resourceId!),
              ),
            );
        }
      };

      const questionRun = await context.createRun("a question");
      await context.addEvent(questionRun);
      await db.insert(issueThreadInteractions).values({
        companyId: context.fixture.companyId,
        issueId: context.conversation.issueId,
        kind: "ask_user_questions",
        continuationPolicy: "wake_assignee",
        createdByAgentId: context.fixture.assignedAgentId,
        sourceRunId: questionRun.runId,
        status: "pending",
        payload: {
          version: 1,
          questions: [
            {
              id: "choice",
              prompt: "Choose one",
              selectionMode: "single",
              options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
              ],
            },
          ],
        },
      });
      await expect(
        enqueueChatRunMilestones(db, { since: new Date(0) }),
      ).resolves.toBe(0);

      const revokedRun = await context.createRun("revoked reach");
      await context.addEvent(revokedRun);
      await expect(
        enqueueChatRunMilestones(db, { since: new Date(0) }),
      ).resolves.toBe(1);
      await setReachEnabled(false);
      const postsBeforeRevocation = context.providerRuntime.posts.length;
      const editsBeforeRevocation = context.providerRuntime.edits.length;
      await context.service.processPendingPublications(100);
      expect(context.providerRuntime.posts).toHaveLength(postsBeforeRevocation);
      expect(context.providerRuntime.edits).toHaveLength(editsBeforeRevocation);
      const [revokedProgress] = await db
        .select()
        .from(chatPublications)
        .where(
          like(
            chatPublications.idempotencyKey,
            `run:${revokedRun.runId}:working:${context.endpoint.id}:native:%`,
          ),
        );
      expect(revokedProgress).toMatchObject({
        state: "cancelled",
        attempts: 1,
      });
      await setReachEnabled(true);

      const finalRun = await context.createRun("a final answer");
      await context.addEvent(finalRun);
      await expect(
        enqueueChatRunMilestones(db, { since: new Date(0) }),
      ).resolves.toBe(1);
      const finalComment = await addSelectedChatFinal({
        agentId: context.fixture.assignedAgentId,
        body: "Authoritative final answer",
        companyId: context.fixture.companyId,
        issueId: context.conversation.issueId,
        runId: finalRun.runId,
      });
      await db
        .update(heartbeatRuns)
        .set({
          status: "succeeded",
          resultJson: {
            presentationDecision: {
              chosenSource: "existing_issue_comment",
              commentAction: "none",
            },
          },
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, finalRun.runId));
      await context.service.processPendingPublications(100);

      expect(context.providerRuntime.edits.at(-1)).toEqual({
        threadId: context.thread.thread.id,
        messageId: expect.any(String),
        text: "Authoritative final answer",
      });
      expect(JSON.stringify(context.providerRuntime.edits)).not.toContain(
        "PRIVATE native event prose",
      );
      const finalPublications = await db
        .select({
          idempotencyKey: chatPublications.idempotencyKey,
          state: chatPublications.state,
        })
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.endpointId, context.endpoint.id),
            like(chatPublications.idempotencyKey, `run:${finalRun.runId}:%`),
          ),
        );
      expect(finalPublications).toContainEqual(
        expect.objectContaining({
          idempotencyKey: expect.stringMatching(
            new RegExp(
              `^run:${finalRun.runId}:working:${context.endpoint.id}:native:`,
            ),
          ),
          state: "cancelled",
        }),
      );
      await expect(
        db
          .select({ state: chatPublications.state })
          .from(chatPublications)
          .where(eq(chatPublications.commentId, finalComment.id)),
      ).resolves.toEqual([{ state: "published" }]);
      await context.service.shutdown();
    },
  );

  it("coalesces one Telegram run into one provider message", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredTelegramEndpoint(fixture);
    const chatId = "77112236";
    const dm = makeThread({
      channelId: `telegram:${chatId}`,
      id: `telegram:${chatId}`,
      isDM: true,
      name: "Telegram direct message",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: dm.thread,
      message: makeMessage({
        id: `${chatId}:71`,
        text: "Produce one quiet Telegram response",
        userId: chatId,
      }),
      trigger: "direct_message",
    });
    await qualifySetupRoundTrip(service, endpoint.id, chatId);
    await service.test(endpoint.id);
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    if (!conversation) throw new Error("Expected Telegram conversation");
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: fixture.companyId,
      agentId: fixture.assignedAgentId,
      status: "running",
      contextSnapshot: await chatWakeContext({
        endpointId: endpoint.id,
        issueId: conversation.issueId,
        provider: "telegram",
        providerMessageId: `${chatId}:71`,
      }),
    });
    for (const progressState of ["queued", "working"] as const) {
      await db.insert(chatPublications).values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: conversation.id,
        issueId: conversation.issueId,
        idempotencyKey: `run:${runId}:${progressState}:${endpoint.id}`,
        payload: {
          text:
            progressState === "queued" ? "Maya is queued." : "Maya is working…",
          progressState,
        },
        state: "pending",
      });
      await service.processPendingPublications();
    }
    await addSelectedChatFinal({
      agentId: fixture.assignedAgentId,
      body: "Final Telegram result",
      companyId: fixture.companyId,
      issueId: conversation.issueId,
      runId,
    });
    await service.processPendingPublications();

    const providerRuntime = runtime.endpoints.get(endpoint.id);
    expect(providerRuntime?.posts).toEqual([
      { threadId: dm.thread.id, text: "Maya is queued." },
    ]);
    expect(providerRuntime?.edits).toEqual([
      {
        threadId: dm.thread.id,
        messageId: "outbound-2",
        text: "Maya is working…",
      },
      {
        threadId: dm.thread.id,
        messageId: "outbound-2",
        text: "Final Telegram result",
      },
    ]);
  });
});
