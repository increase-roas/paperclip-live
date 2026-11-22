import {
  activityLog,
  agentWakeupRequests,
  agents,
  budgetPolicies,
  chatActions,
  chatDeliveries,
  chatEndpoints,
  chatGitHubConfigurations,
  chatMessageLinks,
  chatPublications,
  companyMemberships,
  companySkills,
  completionContracts,
  costEvents,
  databaseWorkPending,
  environmentLeases,
  environments,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  reconcileDatabaseWork,
  subscribeDatabaseWork,
  toolConnections,
} from "@paperclipai/db";
import {
  configureAgentLifecycle,
} from "../../services/agent-lifecycle.js";
import {
  adapterExecutionControls,
  createAdapterExecutionControl,
} from "../../services/adapter-execution-control.js";
import {
  chatRunSourceMessageId,
} from "../../services/chat-channels/run-origin.js";
import {
  authorizeFailedChatRunRetryWake,
  unadmittedChatWakeupCondition,
} from "../../services/durable-chat-wakeup.js";
import {
  conflict,
} from "../../errors.js";
import {

} from "../../services/chat-channels/github/task-preparation.js";
import {
  budgetService,
} from "../../services/budgets.js";
import {
  readFreshWorkspaceReadiness,
} from "../../services/fresh-workspace-continuation.js";
import {
  reconcileTaskChatRetryReceipts,
  requestTaskRetry,
} from "../../services/task-retry.js";
import {
  createSystemRecovery,
} from "../../services/system-recovery-state.js";
import {
  remoteTerminationReceipt,
} from "../../services/remote-execution-termination.js";
import {
  dueChatAction,
} from "../../services/chat-action-work.js";
import {
  CHAT_ACTION_QUEUES,
} from "../../services/chat-work-notifications.js";
import {
  DELIVERY_QUEUES,
} from "../../services/delivery-work-notifications.js";
import {
  secretService,
} from "../../services/secrets.js";
import {
  githubChatManagementService,
} from "../../services/chat-github-management.js";
import {
  githubResponseCommentService,
} from "../../services/chat-github-response-comments.js";
import {
  initializeRunIdentity,
} from "../../services/run-identity.js";
import {
  createHash,
  randomUUID,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  sql,
} from "drizzle-orm";
import {
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import {
  errorHandler,
} from "../../middleware/index.js";
import {
  issueRoutes,
} from "../../routes/issues.js";
import {
  heartbeatService,
} from "../../services/heartbeat.js";
import {
  resolveRunScopedMentionedSkillKeys,
} from "../../services/heartbeat/run-preparation.js";
import {
  boardActor,
  makeMessage,
} from ".././helpers/chat-channels-fixture.js";
import {
  attachFakeGitHubIssueCommentWebhook,
  committedChatResponseRecoveryFixture,
  createStorageService,
  db,
  deliverMessage,
  describeChatChannelsSuite,
  readAgentWakeupRequestsById,
  readChatPublicationsByEndpointId,
  readHeartbeatRunsByCompanyId,
  readHeartbeatRunsById,
  signedGitHubWebhookRequest,
  failedChatRetryFixture,
} from "../helpers/chat-channels-harness.js";
import * as durableChatWakeup from "../../services/durable-chat-wakeup.js";
import * as githubTaskPreparation from "../../services/chat-channels/github/task-preparation.js";
import * as taskRetryModule from "../../services/task-retry.js";
import type { Db } from "@paperclipai/db";
import * as runIdentityModule from "../../services/run-identity.js";
import os, {  } from "node:os";
import path, {  } from "node:path";
import express, {  } from "express";
import request, {  } from "supertest";

describeChatChannelsSuite("chat channels 37-retries-the-saved-board-message-turn-in", () => {
  it("retries the saved board-message turn in a connected task after environment qualification failed before provider startup", async () => {
    const f = await failedChatRetryFixture("github", "42", true, false, true);
    try {
      const companyId = f.fixture.companyId, agentId = f.fixture.assignedAgentId, issueId = f.issue.id;
      await initializeRunIdentity(db, { companyId, runId: f.runId, issueId, responsibleUserId: "owner-user",
        messageIds: [String(f.action.payload.commentId)], cause: "chat_message" });
      const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user",
        authorUserId: "owner-user", body: "Continue from saved work and review the current head." }).returning();
      await db.update(agents).set({ status: "running", runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } })
        .where(eq(agents.id, agentId));
      const [capacity] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running" }).returning();
      const heartbeat = heartbeatService(db);
      const current = await heartbeat.wakeup(agentId, { source: "automation", triggerDetail: "system",
        reason: "issue_reopened_via_comment", requestedByActorType: "user", requestedByActorId: "owner-user",
        payload: { issueId, commentId: comment.id }, contextSnapshot: { issueId, taskKey: issueId,
          source: "issue.comment.reopen", wakeCommentId: comment.id, wakeCommentIds: [comment.id] } });
      expect(current).toMatchObject({ status: "queued" });
      await initializeRunIdentity(db, { companyId, runId: current!.id, issueId, responsibleUserId: "owner-user",
        parentRunId: f.runId, messageIds: [comment.id], cause: "issue_reopened_via_comment" });
      const diagnostic = 'Failed to acquire lease for environment "Managed computer" (sandbox): sandbox_snapshot_qualification_required: The snapshot qualification is missing or stale. Test this environment again before running Paperclip Runner.';
      await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(), runtimeMode: "legacy",
        errorCode: "setup_failed", error: diagnostic, sessionIdBefore: "prior-provider-session-hint",
        runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
        usageJson: { ledgerScope: { issueId, projectId: null } },
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false }, stopReason: "adapter_failed" } })
        .where(eq(heartbeatRuns.id, current!.id));
      await db.update(agentWakeupRequests).set({ status: "failed", finishedAt: new Date() }).where(eq(agentWakeupRequests.id, current!.wakeupRequestId!));
      await db.insert(heartbeatRunEvents).values([
        { companyId, agentId, runId: current!.id, seq: 1, eventType: "agent_observability.unavailable", stream: "system", level: "warn",
          message: "Company observability was not applied: this harness is not supported.", payload: { reason: "unsupported_harness", revision: randomUUID() } },
        { companyId, agentId, runId: current!.id, seq: 2, eventType: "error", stream: "system", level: "error", message: diagnostic },
        { companyId, agentId, runId: current!.id, seq: 3, eventType: "lifecycle", stream: "system", level: "info",
          message: "task.run.measured", payload: { durableSettlement: true, durationMs: 18000, outcome: "failed", phase: "task.run.measured" } },
      ]);
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, capacity.id));
      await db.update(issues).set({ status: "blocked", executionRunId: null }).where(eq(issues.id, issueId));
      await db.update(agents).set({ status: "idle" }).where(eq(agents.id, agentId));
      const [failed] = await readHeartbeatRunsById(current!.id);
      await expect(chatRunSourceMessageId(db, failed, { provider: "github" })).resolves.toBe(f.action.payload.commentId);
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.actor = boardActor(companyId); next(); });
      app.use("/api", issueRoutes(db, createStorageService().storage, { chatRunRetries: f.service }));
      app.use(errorHandler);
      const denySource = async (apply: () => Promise<unknown>, restore: () => Promise<unknown>, stale = false) => {
        try {
          await apply();
          const denied = await request(app).post(`/api/issues/${issueId}/retry`).send({ idempotencyKey: randomUUID(), observedRunId: current!.id }).expect(stale ? 200 : 409);
          if (stale) expect(denied.body).toMatchObject({ accepted: false, stale: true });
          expect(await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
            eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "task_retry")))).toHaveLength(0);
        } finally { await restore(); }
      };
      await denySource(() => db.update(issueComments).set({ body: "Edited after acceptance", updatedAt: new Date() }).where(eq(issueComments.id, comment.id)),
        () => db.update(issueComments).set({ body: comment.body, updatedAt: sql`${issueComments.createdAt}` }).where(eq(issueComments.id, comment.id)));
      await denySource(() => db.update(issueComments).set({ authorUserId: "another-user" }).where(eq(issueComments.id, comment.id)),
        () => db.update(issueComments).set({ authorUserId: comment.authorUserId, updatedAt: sql`${issueComments.createdAt}` }).where(eq(issueComments.id, comment.id)));
      await denySource(() => db.update(issueComments).set({ deletedAt: new Date() }).where(eq(issueComments.id, comment.id)),
        () => db.update(issueComments).set({ deletedAt: null, updatedAt: sql`${issueComments.createdAt}` }).where(eq(issueComments.id, comment.id)));
      const [sourceWake] = await readAgentWakeupRequestsById(current!.wakeupRequestId!);
      await denySource(() => db.update(agentWakeupRequests).set({ requestedByActorId: "another-user" }).where(eq(agentWakeupRequests.id, sourceWake.id)),
        () => db.update(agentWakeupRequests).set({ requestedByActorId: sourceWake.requestedByActorId }).where(eq(agentWakeupRequests.id, sourceWake.id)));
      for (const patch of [
        { responsibleUserId: "another-user" }, { agentId: f.fixture.replacementAgentId },
        { contextSnapshot: { ...failed.contextSnapshot, issueId: randomUUID() } },
        { activeIdentityContextId: null }, { sessionIdAfter: "provider-started" }, { processPid: 999999 },
        { controllerLeaseExpiresAt: new Date(Date.now() + 60000) }, { stdoutExcerpt: "provider output" },
        { resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: true } } },
        { runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" }, unexpectedExecution: true } },
      ]) {
        const restore = Object.fromEntries(Object.keys(patch).map(key => [key, failed[key as keyof typeof failed]]));
        await denySource(() => db.update(heartbeatRuns).set(patch).where(eq(heartbeatRuns.id, failed.id)),
          () => db.update(heartbeatRuns).set(restore).where(eq(heartbeatRuns.id, failed.id)), "agentId" in patch);
      }
      const contractId = randomUUID(), resultId = randomUUID();
      await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
        schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard",
        completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: {},
        canonicalSha256: contractId, createdByActorType: "system", createdByActorId: "test" });
      await denySource(async () => {
        await db.update(heartbeatRuns).set({ nativeIssueId: issueId, completionContractId: contractId }).where(eq(heartbeatRuns.id, failed.id));
        await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId, runId: failed.id,
          completionContractId: contractId, schemaStatus: "accepted", serverFingerprint: resultId, canonicalSha256: resultId,
          resultJson: { terminal: { runTerminalState: "succeeded" } } });
      }, async () => {
        await db.delete(nativeRunResults).where(eq(nativeRunResults.id, resultId));
        await db.update(heartbeatRuns).set({ nativeIssueId: null, completionContractId: null }).where(eq(heartbeatRuns.id, failed.id));
        await db.delete(completionContracts).where(eq(completionContracts.id, contractId));
      });
      const [liveLease] = await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: failed.id,
        provider: "daytona", providerLeaseId: "contradictory-board-startup", status: "active", leasePolicy: "ephemeral" }).returning();
      await denySource(async () => {}, () => db.delete(environmentLeases).where(eq(environmentLeases.id, liveLease.id)));
      adapterExecutionControls.set(failed.id, createAdapterExecutionControl());
      await denySource(async () => {}, async () => { adapterExecutionControls.get(failed.id)?.finish(); adapterExecutionControls.delete(failed.id); });
      const idempotencyKey = randomUUID();
      const response = await request(app).post(`/api/issues/${issueId}/retry`).send({ idempotencyKey, observedRunId: current!.id }).expect(202);
      expect(response.body).toMatchObject({ accepted: true, observedRunId: current!.id });
      expect(response.body.chatActionId).toBeUndefined();
      const [retry] = await readAgentWakeupRequestsById(response.body.requestId);
      expect(retry).toMatchObject({ reason: "task_retry", requestedByActorId: "owner-user",
        payload: { issueId, taskRetry: { sourceRunId: current!.id } } });
      expect(await db.select().from(chatActions).where(and(eq(chatActions.companyId, companyId), eq(chatActions.kind, "failed_run_retry")))).toHaveLength(0);
      await db.update(agents).set({ status: "running" }).where(eq(agents.id, agentId));
      const [dispatchCapacity] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running" }).returning();
      await db.update(issueComments).set({ body: "Changed after Retry acceptance", updatedAt: new Date() }).where(eq(issueComments.id, comment.id));
      await heartbeat.resumeExecutionWaitComments();
      expect((await readAgentWakeupRequestsById(retry.id))[0]).toMatchObject({ status: "deferred_issue_execution", runId: null });
      await db.update(issueComments).set({ body: comment.body, updatedAt: sql`${issueComments.createdAt}` }).where(eq(issueComments.id, comment.id));
      await heartbeat.resumeExecutionWaitComments();
      const [successor] = (await readHeartbeatRunsByCompanyId(companyId)).filter(run => run.contextSnapshot?.taskRetryRequestId === retry.id);
      expect(successor).toMatchObject({ status: "queued", responsibleUserId: "owner-user",
        contextSnapshot: { taskRetryRequestId: retry.id, previousRunId: current!.id } });
      expect((await readAgentWakeupRequestsById(retry.id))[0]).toMatchObject({ runId: successor.id });
      const realInitialize = runIdentityModule.initializeRunIdentity;
      const initialized: string[] = [];
      const probe = vi.spyOn(runIdentityModule, "initializeRunIdentity").mockImplementation(async (database, input) => {
        if (input.runId !== successor.id) return realInitialize(database, input);
        const [canonical] = await readAgentWakeupRequestsById(retry.id);
        const [dispatch] = await readAgentWakeupRequestsById(successor.wakeupRequestId!);
        const denyIdentity = async (apply: () => Promise<unknown>, restore: () => Promise<unknown>) => {
          try { await apply(); await expect(realInitialize(database, input)).rejects.toThrow("This saved message can no longer be retried safely"); }
          finally { await restore(); }
          expect((await readHeartbeatRunsById(input.runId))[0].activeIdentityContextId).toBeNull();
        };
        await denyIdentity(() => db.update(agentWakeupRequests).set({ payload: { ...canonical.payload,
          taskRetry: { ...(canonical.payload!.taskRetry as object), boardMessageOrigin: undefined } } }).where(eq(agentWakeupRequests.id, canonical.id)),
          () => db.update(agentWakeupRequests).set({ payload: canonical.payload }).where(eq(agentWakeupRequests.id, canonical.id)));
        await denyIdentity(() => db.update(agentWakeupRequests).set({ runId: failed.id }).where(eq(agentWakeupRequests.id, canonical.id)),
          () => db.update(agentWakeupRequests).set({ runId: canonical.runId }).where(eq(agentWakeupRequests.id, canonical.id)));
        await denyIdentity(() => db.update(agentWakeupRequests).set({ requestedByActorId: "another-user" }).where(eq(agentWakeupRequests.id, canonical.id)),
          () => db.update(agentWakeupRequests).set({ requestedByActorId: canonical.requestedByActorId }).where(eq(agentWakeupRequests.id, canonical.id)));
        await denyIdentity(() => db.update(agentWakeupRequests).set({ runId: failed.id }).where(eq(agentWakeupRequests.id, dispatch.id)),
          () => db.update(agentWakeupRequests).set({ runId: dispatch.runId }).where(eq(agentWakeupRequests.id, dispatch.id)));
        await denyIdentity(() => db.update(issueComments).set({ body: "Changed before provider dispatch", updatedAt: new Date() }).where(eq(issueComments.id, comment.id)),
          () => db.update(issueComments).set({ body: comment.body, updatedAt: sql`${issueComments.createdAt}` }).where(eq(issueComments.id, comment.id)));
        await denyIdentity(() => db.update(heartbeatRuns).set({ contextSnapshot: { ...successor.contextSnapshot, taskId: randomUUID() } }).where(eq(heartbeatRuns.id, successor.id)),
          () => db.update(heartbeatRuns).set({ contextSnapshot: successor.contextSnapshot }).where(eq(heartbeatRuns.id, successor.id)));
        await denyIdentity(() => db.update(issues).set({ executionRunId: failed.id }).where(eq(issues.id, issueId)),
          () => db.update(issues).set({ executionRunId: successor.id }).where(eq(issues.id, issueId)));
        const identity = await realInitialize(database, input);
        expect(identity).toMatchObject({ responsibleUserId: "owner-user", parentContextId: retry.payload!.taskRetry &&
          (retry.payload!.taskRetry as { boardMessageOrigin: { identityContextId: string } }).boardMessageOrigin.identityContextId });
        const [executing] = await readHeartbeatRunsById(input.runId);
        await expect(chatRunSourceMessageId(db, executing, { provider: "github" })).resolves.toBe(f.action.payload.commentId);
        initialized.push(input.runId);
        // This fixture tests the real dispatch and identity boundary, without
        // allocating a provider or pretending its task work has completed.
        throw new Error("board_retry_identity_probe_complete");
      });
      try {
        await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, dispatchCapacity.id));
        await db.update(agents).set({ status: "idle" }).where(eq(agents.id, agentId));
        await heartbeat.resumeQueuedRuns();
        await heartbeat.drainActiveRunExecutions();
        expect(initialized).toEqual([successor.id]);
        expect((await readHeartbeatRunsById(successor.id))[0]).toMatchObject({ status: "failed", error: "board_retry_identity_probe_complete" });
        expect((await readHeartbeatRunsByCompanyId(companyId)).filter(run => run.contextSnapshot?.taskRetryRequestId === retry.id)).toHaveLength(1);
        expect((await readHeartbeatRunsById(current!.id))[0]).toMatchObject({ status: "failed", activeIdentityContextId: failed.activeIdentityContextId });
      } finally { probe.mockRestore(); await heartbeat.drainActiveRunExecutions(); }
      const [firstRetry] = await readHeartbeatRunsById(successor.id);
      const nextRequest = () => request(app).post(`/api/issues/${issueId}/retry`).send({
        idempotencyKey: randomUUID(), observedRunId: firstRetry.id });
      await db.update(heartbeatRuns).set({ sessionIdAfter: "contradictory-provider-session" }).where(eq(heartbeatRuns.id, firstRetry.id));
      await nextRequest().expect(409);
      await db.update(heartbeatRuns).set({ sessionIdAfter: null }).where(eq(heartbeatRuns.id, firstRetry.id));
      await db.update(issueComments).set({ body: "Changed original accepted message", updatedAt: new Date() }).where(eq(issueComments.id, comment.id));
      await nextRequest().expect(409);
      await db.update(issueComments).set({ body: comment.body, updatedAt: sql`${issueComments.createdAt}` }).where(eq(issueComments.id, comment.id));
      const [firstIntent] = await readAgentWakeupRequestsById(retry.id);
      await db.update(agentWakeupRequests).set({ payload: { ...firstIntent.payload,
        taskRetry: { ...(firstIntent.payload!.taskRetry as object), sourceRunId: firstRetry.id } } }).where(eq(agentWakeupRequests.id, firstIntent.id));
      await db.update(heartbeatRuns).set({ contextSnapshot: { ...firstRetry.contextSnapshot, previousRunId: firstRetry.id } }).where(eq(heartbeatRuns.id, firstRetry.id));
      await nextRequest().expect(409);
      await db.update(agentWakeupRequests).set({ payload: firstIntent.payload }).where(eq(agentWakeupRequests.id, firstIntent.id));
      await db.update(heartbeatRuns).set({ contextSnapshot: firstRetry.contextSnapshot }).where(eq(heartbeatRuns.id, firstRetry.id));
      const second = await nextRequest().expect(202);
      expect(second.body).toMatchObject({ accepted: true, observedRunId: firstRetry.id });
      expect(second.body.chatActionId).toBeUndefined();
      const [secondIntent] = await readAgentWakeupRequestsById(second.body.requestId);
      expect(secondIntent.payload).toMatchObject({ taskRetry: { sourceRunId: firstRetry.id,
        boardMessageOrigin: { commentId: comment.id, identityContextId: firstRetry.activeIdentityContextId } } });
      const secondIdentities: string[] = [];
      const secondProbe = vi.spyOn(runIdentityModule, "initializeRunIdentity").mockImplementation(async (database, input) => {
        const identity = await realInitialize(database, input);
        if (input.companyId === companyId) {
          expect(identity).toMatchObject({ responsibleUserId: "owner-user", parentContextId: firstRetry.activeIdentityContextId });
          const [executing] = await readHeartbeatRunsById(input.runId);
          await expect(chatRunSourceMessageId(db, executing, { provider: "github" })).resolves.toBe(f.action.payload.commentId);
          secondIdentities.push(input.runId);
          throw new Error("board_retry_identity_probe_complete");
        }
        return identity;
      });
      try {
        await heartbeat.resumeExecutionWaitComments();
        await heartbeat.resumeQueuedRuns();
        await heartbeat.drainActiveRunExecutions();
        const [secondRun] = (await readHeartbeatRunsByCompanyId(companyId)).filter(run => run.contextSnapshot?.taskRetryRequestId === secondIntent.id);
        expect(secondRun).toMatchObject({ status: "failed", error: "board_retry_identity_probe_complete", responsibleUserId: "owner-user" });
        expect(secondIdentities).toEqual([secondRun.id]);
        expect((await readHeartbeatRunsByCompanyId(companyId)).filter(run => run.contextSnapshot?.taskRetryRequestId === secondIntent.id)).toHaveLength(1);
      } finally { secondProbe.mockRestore(); await heartbeat.drainActiveRunExecutions(); }

    } finally {
      await db.update(agentWakeupRequests).set({ status: "failed", finishedAt: new Date() }).where(and(
        eq(agentWakeupRequests.companyId, f.fixture.companyId), eq(agentWakeupRequests.reason, "task_retry"),
        eq(agentWakeupRequests.status, "deferred_issue_execution")));
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(and(
        eq(heartbeatRuns.companyId, f.fixture.companyId), eq(heartbeatRuns.status, "queued")));
      await f.service.shutdown();
    }
  });

  it("distinguishes an inherited GitHub requester from permission to replay a committed provider failure", async () => {
    const f = await failedChatRetryFixture("github", "42", true, false, true);
    try {
      const companyId = f.fixture.companyId, agentId = f.fixture.assignedAgentId, issueId = f.issue.id;
      await initializeRunIdentity(db, { companyId, runId: f.runId, issueId, responsibleUserId: "owner-user",
        messageIds: [String(f.action.payload.commentId)], cause: "chat_message" });
      await db.update(agents).set({ status: "running", runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } })
        .where(eq(agents.id, agentId));
      const [capacity] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running" }).returning();
      const heartbeat = heartbeatService(db);
      const resumed = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual",
        reason: "issue_tree_resumed", requestedByActorType: "user", requestedByActorId: "owner-user",
        payload: { issueId }, contextSnapshot: { issueId, taskKey: f.issue.identifier, source: "issue.tree_resume" } });
      expect(resumed).toMatchObject({ status: "queued" });
      await initializeRunIdentity(db, { companyId, runId: resumed!.id, issueId, responsibleUserId: "owner-user",
        parentRunId: f.runId, cause: "issue_tree_resumed" });
      const contractId = randomUUID(), resultId = randomUUID();
      await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
        schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard",
        completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: {},
        canonicalSha256: contractId, createdByActorType: "system", createdByActorId: "test" });
      await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(), runtimeMode: "native",
        nativeIssueId: issueId, nativePhase: "committed", errorCode: "adapter_failed", error: "Native session failed",
        completionContractId: contractId }).where(eq(heartbeatRuns.id, resumed!.id));
      await db.update(agentWakeupRequests).set({ status: "failed", finishedAt: new Date() }).where(eq(agentWakeupRequests.id, resumed!.wakeupRequestId!));
      await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId, runId: resumed!.id,
        completionContractId: contractId, schemaStatus: "accepted", serverFingerprint: resultId, canonicalSha256: resultId,
        resultJson: { result: { reportedWorkDisposition: "needs_review", completionClaim: { objectiveSatisfied: false } },
          terminal: { runTerminalState: "failed", turnTerminalState: "failed" } } });
      await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId: resumed!.id, phase: "committed", resultId });
      const lease = { id: randomUUID(), companyId, heartbeatRunId: resumed!.id, provider: "daytona", providerLeaseId: "contained-resume-provider" };
      await db.insert(environmentLeases).values({ ...lease, issueId, status: "expired", leasePolicy: "ephemeral",
        cleanupStatus: "success", releasedAt: new Date(), metadata: { remoteExecutionTermination:
          remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "destroyed" }) } });
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, capacity.id));
      await db.update(issues).set({ status: "blocked", executionRunId: null }).where(eq(issues.id, issueId));
      await db.update(agents).set({ status: "idle" }).where(eq(agents.id, agentId));
      const [failedResume] = await readHeartbeatRunsById(resumed!.id);
      expect(failedResume.contextSnapshot).toMatchObject({ source: "issue.tree_resume" });
      expect(failedResume.contextSnapshot).not.toHaveProperty("wakeCommentIds");
      await expect(chatRunSourceMessageId(db, failedResume, { provider: "github" }))
        .resolves.toBe(f.action.payload.commentId);
      const input = { db, companyId, issueId, actorId: "owner-user", actorSource: "cloud_tenant",
        observedRunId: resumed!.id, idempotencyKey: randomUUID(), prepareChatRetry: f.service.prepareFailedChatRunRetry };
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.actor = boardActor(companyId); next(); });
      app.use("/api", issueRoutes(db, createStorageService().storage, { chatRunRetries: f.service }));
      app.use(errorHandler);
      const denied = await request(app).post(`/api/issues/${issueId}/retry`).send({
        idempotencyKey: input.idempotencyKey, observedRunId: input.observedRunId,
      }).expect(409);
      expect(denied.body).toMatchObject({ error: "This attempt already recorded a result. Send a new message on the task to continue from the saved work.",
        details: { code: "chat_failed_run_retry_not_authorized", reason: "accepted_result_without_new_input" } });
      // Isolate the later accepted-result guard using only owned fixture data.
      // Resolving inherited provenance cannot by itself authorize replay.
      await db.update(heartbeatRuns).set({ contextSnapshot: { ...failedResume.contextSnapshot,
        source: "chat:github", wakeCommentId: f.action.payload.commentId, wakeCommentIds: [f.action.payload.commentId] } })
        .where(eq(heartbeatRuns.id, failedResume.id));
      try {
        await expect(requestTaskRetry({ ...input, idempotencyKey: randomUUID() })).rejects.toMatchObject({ details: {
          code: "chat_failed_run_retry_not_authorized", reason: "accepted_result_without_new_input" } });
      } finally { await db.update(heartbeatRuns).set({ contextSnapshot: failedResume.contextSnapshot }).where(eq(heartbeatRuns.id, failedResume.id)); }
      expect((await readHeartbeatRunsByCompanyId(companyId)).filter(run => run.retryOfRunId === resumed!.id)).toHaveLength(0);
    } finally { await f.service.shutdown(); }
  });

  it.each([
    ...(["real_budget_ingress", "legacy_budget_ingress", "legacy_prior_response", "legacy_execution", "legacy_execution_log", "legacy_execution_lease", "legacy_execution_profile", "legacy_execution_event", "legacy_execution_controller", "legacy_execution_intent", "legacy_no_prior", "legacy_prior_late", "legacy_prior_unprocessed", "legacy_prior_delivery_unprocessed", "legacy_prior_numeric_app", "legacy_response_conflict", "legacy_prior_wrong_app", "legacy_prior_wrong_agent", "legacy_prior_unlinked", "legacy_prior_retargeted", "legacy_explicit_null", "legacy_explicit_empty", "legacy_explicit_malformed", "legacy_explicit_mismatch", "legacy_current_app_changed", "source_app_changed", "source_destination_changed", "accepted", "multiple_saved", "real_queue", "committed_succeeded", "committed_consumed", "committed_failure", "committed_failed_publication", "committed_unknown_publication", "committed_pending_publication", "committed_mixed_publication", "committed_consumed_publication", "committed_succeeded_publication", "committed_delayed_cleanup", "committed_board", "committed_board_existing", "committed_board_existing_coalesced", "committed_board_existing_identity_contended", "committed_board_existing_identity_expired", "committed_board_existing_source_edited", "committed_board_existing_board_edited", "committed_board_existing_controller", "committed_board_existing_allocation", "committed_board_existing_receipt", "committed_board_existing_delivered", "committed_board_existing_source_owner", "committed_board_existing_source_delivered", "committed_unknown_cleanup", "committed_live_controller", "unreconciled", "source_edited", "source_claimed", "malformed_previous", "endpoint_paused", "principal_revoked", "still_budget_blocked"] as const)
      .map(mode => ({ provider: "github" as const, mode })),
  ])("retries the newer saved $provider request instead of the failed request after a budget hold: $mode", async ({ provider, mode }) => {
    const queuedBoard = mode === "committed_board" || mode.startsWith("committed_board_existing");
    const legacyIngress = mode.startsWith("legacy_");
    const realBudgetIngress = mode === "real_budget_ingress" || legacyIngress;
    const executionRevalidation = mode.startsWith("legacy_execution");
    if (legacyIngress) {
      // The legacy intake producer retained requester authority but no App ID.
      // A budget refusal never reaches the acknowledgement which could bind it.
      const historical = vi.spyOn(githubTaskPreparation, "retainGitHubDeliveryAuthority").mockImplementation(
        async (tx, endpoint, deliveryId, linkedUserId, taskUserId) => {
          const guest = !linkedUserId;
          await tx.update(chatDeliveries).set({ normalizedEvent: sql`${chatDeliveries.normalizedEvent} || ${JSON.stringify({
            githubAuthority: { guest, responsibleUserId: taskUserId, sponsorUserId: guest ? endpoint.sponsorUserId : null },
          })}::jsonb` }).where(eq(chatDeliveries.id, deliveryId));
        });
      onTestFinished(() => historical.mockRestore());
    }
    const context = await failedChatRetryFixture(provider, realBudgetIngress ? "42" : undefined, true, false, realBudgetIngress);
    try {
      const companyId = context.fixture.companyId;
      const [skill] = await db.insert(companySkills).values({ companyId, key: `company/${companyId}/saved-review`,
        slug: "saved-review", name: "Saved review", markdown: "# Saved review" }).returning();
      if (provider === "github") {
        const configured = await githubChatManagementService(db).configuration(context.endpoint.id, "owner-user");
        const configuration = { ...configured.configuration, defaults: { ...configured.configuration.defaults,
          instructions: `Use [/saved-review](skill://${skill.id}).` } };
        if (realBudgetIngress) await githubChatManagementService(db).saveConfiguration(context.endpoint.id,
          { expectedRevision: configured.revision, configuration }, "owner-user");
        else await db.insert(chatGitHubConfigurations).values({ companyId, endpointId: context.endpoint.id,
          configuration, updatedByUserId: "owner-user", revision: 2 });
      }
      if (legacyIngress) {
        await githubResponseCommentService(db, context.providerFetch).tryAcknowledge(context.action.deliveryId!);
        const [prior] = await db.select().from(chatActions).where(and(
          eq(chatActions.deliveryId, context.action.deliveryId!), eq(chatActions.kind, "github_response_comment")));
        expect(prior).toMatchObject({ status: "processed", payload: {
          botExternalId: (await context.service.get(context.endpoint.id)).botExternalId, agentId: context.fixture.assignedAgentId,
        } });
      }
      if (mode === "legacy_no_prior") await db.delete(chatActions).where(and(
        eq(chatActions.deliveryId, context.action.deliveryId!), eq(chatActions.kind, "github_response_comment")));
      if (realBudgetIngress) {
        // A reached hard stop the board later lifts. Pending accounting is no
        // longer a budget hold (invariant 3).
        await db.insert(budgetPolicies).values({ companyId, scopeType: "agent", scopeId: context.fixture.assignedAgentId,
          metric: "billed_cents", windowKind: "lifetime", amount: 100, notifyEnabled: false });
        await db.insert(costEvents).values({ companyId, agentId: context.fixture.assignedAgentId, provider: "openai", model: "gpt",
          costCents: 100, occurredAt: new Date() });
        context.wakeup.mockImplementation(heartbeatService(db).wakeup);
      } else context.wakeup.mockImplementation(async (agentId, opts) => {
        const request = opts.durableChatRequest!;
        await db.transaction(async tx => {
          await request.authorize(tx as unknown as Parameters<typeof request.authorize>[0]);
          await tx.insert(agentWakeupRequests).values({ id: request.id, companyId,
            agentId, source: opts.source!, triggerDetail: opts.triggerDetail, reason: "budget.blocked",
            requestedByActorType: request.requestedByActorType, requestedByActorId: request.requestedByActorId,
            requestedAt: request.requestedAt, idempotencyKey: request.idempotencyKey,
            payload: { ...opts.payload, executionWait: { scopeType: "agent", scopeId: agentId } },
            status: "skipped", finishedAt: new Date() });
        });
        return null;
      });
      if (realBudgetIngress) {
        const endpoint = await context.service.get(context.endpoint.id);
        attachFakeGitHubIssueCommentWebhook({ botUsername: endpoint.botUsername!, callbacks: context.runtime.configurations.get(endpoint.id)!.callbacks,
          endpointId: endpoint.id, runtime: context.runtime.endpoints.get(endpoint.id)! });
        const ref = (await db.select().from(toolConnections).where(eq(toolConnections.id, endpoint.connectionId)))[0]!
          .credentialSecretRefs.find(ref => ref.configPath === "credentials.webhookSecret")!;
        const secret = await secretService(db).resolveSecretValue(companyId, ref.secretId, ref.versionSelector ?? "latest");
        const response = await context.service.handleWebhook(endpoint.publicId, "github", signedGitHubWebhookRequest({
          delivery: randomUUID(), event: "issue_comment", webhookSecret: secret,
          payload: { action: "created", installation: { id: 2468 },
            repository: { id: 97531, full_name: "paperclipai/paperclip", owner: { id: 1357, login: "paperclipai" } },
            issue: { number: 791, pull_request: { url: "https://api.github.com/repos/paperclipai/paperclip/pulls/791" } },
            sender: { id: 42, login: "octocat", type: "User" },
            comment: { id: 990092, body: `@${endpoint.botUsername} review using the selected instructions`,
              user: { id: 42, login: "octocat", type: "User" }, created_at: new Date().toISOString() } },
        }));
        expect(response.status).toBeLessThan(300);
      } else await deliverMessage({ callbacks: context.runtime.configurations.get(context.endpoint.id)!.callbacks,
        endpointId: context.endpoint.id, provider, thread: context.thread.thread,
        message: makeMessage({ id: "saved-after-budget-hold", text: "@maya review using the selected instructions",
          userId: "U-SAFE-PROGRESS", mentioned: true }),
        trigger: context.thread.thread.isDM ? "direct_message" : "mention" });
      if (mode === "multiple_saved") await deliverMessage({
        callbacks: context.runtime.configurations.get(context.endpoint.id)!.callbacks,
        endpointId: context.endpoint.id, provider, thread: context.thread.thread,
        message: makeMessage({ id: "second-saved-after-budget-hold", text: "@maya include the follow-up",
          userId: "U-SAFE-PROGRESS", mentioned: true }), trigger: "mention" });
      if (queuedBoard) for (let index = 1; index < 10; index++) await deliverMessage({
        callbacks: context.runtime.configurations.get(context.endpoint.id)!.callbacks,
        endpointId: context.endpoint.id, provider, thread: context.thread.thread,
        message: makeMessage({ id: `saved-followup-${index}`, text: `@maya review follow-up ${index}`,
          userId: "U-SAFE-PROGRESS", mentioned: true }), trigger: "mention" });
      const savedInputs = await db.select().from(chatActions).where(and(
        eq(chatActions.companyId, companyId), eq(chatActions.conversationId, context.conversation.id),
        eq(chatActions.kind, "inbound_wakeup"), sql`${chatActions.id} <> ${context.action.id}`))
        .orderBy(asc(chatActions.createdAt), asc(chatActions.id));
      const saved = savedInputs.at(-1)!;
      const expectedComments = savedInputs.map(action => action.payload.commentId as string);
      expect(saved, JSON.stringify((await db.select({ state: chatDeliveries.state, error: chatDeliveries.redactedError, event: chatDeliveries.eventKind }).from(chatDeliveries).where(eq(chatDeliveries.endpointId, context.endpoint.id))))).toMatchObject({ status: "failed", result: { receiptStatus: "skipped" } });
      expect(saved.payload.commentId).not.toBe(context.action.payload.commentId);
      if (realBudgetIngress) {
        expect((await readAgentWakeupRequestsById(saved.id))[0]).toMatchObject({ status: "skipped", reason: "budget.blocked",
          runId: null, requestedByActorType: "user", requestedByActorId: "owner-user" });
        await db.update(budgetPolicies).set({ isActive: false }).where(eq(budgetPolicies.companyId, companyId));
        await budgetService(db).getInvocationBlock(companyId, context.fixture.assignedAgentId);
        const lifecycle = configureAgentLifecycle(db, { requiredPluginIds: async () => [],
          runPlugin: async () => "complete", runHost: async () => "complete" });
        try { await lifecycle.process(context.fixture.assignedAgentId); } finally { await lifecycle.stop(); }
        expect((await db.select().from(agents).where(eq(agents.id, context.fixture.assignedAgentId)))[0].lifecycleHolds).not.toContain("budget");
        expect((await db.select().from(agents).where(eq(agents.id, context.fixture.assignedAgentId)))[0]).toMatchObject({status: "idle"});
        expect((await readHeartbeatRunsById(context.runId))[0]).toMatchObject({status: "failed"});
      }
      const unadmitted = () => db.select({ id: issues.id }).from(issues).where(and(eq(issues.id, context.issue.id),
        unadmittedChatWakeupCondition(issues.id, issues.companyId)));
      expect(await unadmitted()).toHaveLength(1);
      // The budget was cleared. Retry must reconsider this independent saved
      // request through chat admission, not replay the older failed turn.
      const held = mode === "unreconciled" || mode === "committed_delayed_cleanup" || queuedBoard || mode === "committed_unknown_cleanup" || mode === "committed_live_controller";
      if (mode === "unreconciled" || mode.startsWith("committed_") || executionRevalidation) {
        await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: context.issue.id,
          nativePhase: "terminal_failure", runnerProfileJson: {} }).where(eq(heartbeatRuns.id, context.runId));
        await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: context.issue.id,
          kind: "active_run_watchdog", cause: "native_continuation_requires_reconciliation", status: "active",
          ownerType: "board", fingerprint: randomUUID(), nextAction: "Reconcile the previous executor.",
          evidence: { runId: context.runId, automaticRecovery: { replay: "blocked" } } });
        if (mode.startsWith("committed_") || executionRevalidation) {
          const contractId = randomUUID(), resultId = randomUUID();
          await db.insert(completionContracts).values({ id: contractId, companyId, issueId: context.issue.id,
            revision: 1, schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard",
            completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: {},
            canonicalSha256: contractId, createdByActorType: "system", createdByActorId: "test" });
          await db.update(heartbeatRuns).set({ nativePhase: "committed", completionContractId: contractId })
            .where(eq(heartbeatRuns.id, context.runId));
          await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId: context.issue.id,
            runId: context.runId, completionContractId: contractId, serverFingerprint: resultId,
            schemaStatus: "accepted", canonicalSha256: resultId,
            resultJson: { terminal: { runTerminalState: mode.startsWith("committed_succeeded") ? "succeeded" : "failed" } } });
          await db.insert(nativeRunFinalizations).values({ companyId, issueId: context.issue.id,
            runId: context.runId, resultId, phase: "committed",
            leaseOwner: mode === "committed_live_controller" ? "active-controller" : null });
          const lease = { id: randomUUID(), companyId, heartbeatRunId: context.runId,
            provider: "daytona", providerLeaseId: "owned-saved-input-sandbox" };
          await db.insert(environmentLeases).values({ ...lease, issueId: context.issue.id,
            status: "expired", cleanupStatus: "success", releasedAt: new Date(), leasePolicy: "ephemeral",
            metadata: mode === "committed_unknown_cleanup" || mode === "committed_delayed_cleanup" || queuedBoard ? {} : {
              remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "destroyed" }) } });
        }
      }
      if (executionRevalidation || ["committed_failed_publication", "committed_unknown_publication", "committed_pending_publication", "committed_mixed_publication", "committed_consumed_publication", "committed_succeeded_publication"].includes(mode)) {
        // A failed native run materializes its summary before delivery. Keep
        // this historical output distinct from the newer user's request.
        const [resultComment] = await db.insert(issueComments).values({ companyId, issueId: context.issue.id,
          authorAgentId: context.fixture.assignedAgentId, createdByRunId: context.runId,
          body: "The OpenCode run failed before it completed." }).returning();
        await db.insert(chatPublications).values({ companyId, endpointId: context.endpoint.id,
          conversationId: context.conversation.id, issueId: context.issue.id, commentId: resultComment.id,
          idempotencyKey: `run:${context.runId}:failed-result`, payload: { text: resultComment.body },
          state: executionRevalidation || ["committed_failed_publication", "committed_mixed_publication", "committed_consumed_publication", "committed_succeeded_publication"].includes(mode) ? "failed"
            : mode === "committed_unknown_publication" ? "delivery_unknown" : "pending",
          redactedError: "GitHub failure has no request binding" });
        if (mode === "committed_mixed_publication") await db.insert(chatPublications).values({ companyId,
          endpointId: context.endpoint.id, conversationId: context.conversation.id, issueId: context.issue.id,
          commentId: resultComment.id, idempotencyKey: `run:${context.runId}:uncertain-result`,
          payload: { text: resultComment.body }, state: "delivery_unknown" });
      }
      if (mode.startsWith("committed_consumed")) await db.update(heartbeatRuns).set({ contextSnapshot: {
        ...((await readHeartbeatRunsById(context.runId))[0]).contextSnapshot,
        wakeCommentId: saved.payload.commentId, wakeCommentIds: [saved.payload.commentId],
      } }).where(eq(heartbeatRuns.id, context.runId));
      if (mode === "malformed_previous") await db.update(heartbeatRuns).set({ contextSnapshot: {
        ...((await readHeartbeatRunsById(context.runId))[0]).contextSnapshot, wakeCommentIds: ["unbound"],
      } }).where(eq(heartbeatRuns.id, context.runId));
      if (mode === "source_app_changed" || mode === "source_destination_changed") {
        const [delivery] = await db.select().from(chatDeliveries).where(eq(chatDeliveries.id, saved.deliveryId!));
        await db.update(chatDeliveries).set({ normalizedEvent: { ...delivery.normalizedEvent,
          ...(mode === "source_app_changed" ? { githubAuthority: { ...(delivery.normalizedEvent.githubAuthority as object), botExternalId: "different-app" } }
            : { resource: { ...(delivery.normalizedEvent.resource as object), providerResourceId: "another/repository" } }),
        } }).where(eq(chatDeliveries.id, delivery.id));
      }
      const previousPublications = await readChatPublicationsByEndpointId(context.endpoint.id);
      const request = { db, companyId, issueId: context.issue.id, actorId: "owner-user", actorSource: "cloud_tenant",
        observedRunId: context.runId, idempotencyKey: randomUUID(), prepareChatRetry: context.service.prepareFailedChatRunRetry };
      if (legacyIngress) {
        const [delivery] = await db.select().from(chatDeliveries).where(eq(chatDeliveries.id, saved.deliveryId!));
        expect(delivery.normalizedEvent.githubAuthority).not.toHaveProperty("botExternalId");
        expect(await db.select({ id: chatActions.id }).from(chatActions).where(and(
          eq(chatActions.deliveryId, saved.deliveryId!), eq(chatActions.kind, "github_response_comment")))).toHaveLength(0);
        const priorWhere = and(eq(chatActions.deliveryId, context.action.deliveryId!), eq(chatActions.kind, "github_response_comment"));
        if (mode === "legacy_prior_late") await db.update(chatActions).set({ createdAt: new Date(delivery.createdAt.getTime() + 1) }).where(priorWhere);
        if (mode === "legacy_prior_unprocessed") await db.update(chatActions).set({ status: "received" }).where(priorWhere);
        if (mode === "legacy_prior_delivery_unprocessed") await db.update(chatDeliveries).set({ state: "failed" })
          .where(eq(chatDeliveries.id, context.action.deliveryId!));
        if (mode === "legacy_prior_numeric_app") await db.update(chatActions).set({
          payload: sql`jsonb_set(${chatActions.payload}, '{botExternalId}', ${JSON.stringify(Number((await context.service.get(context.endpoint.id)).botExternalId))}::jsonb)`,
        }).where(priorWhere);
        if (mode === "legacy_response_conflict") await db.insert(chatActions).values({ companyId,
          endpointId: context.endpoint.id, conversationId: context.conversation.id, deliveryId: delivery.id,
          principalId: delivery.principalId, kind: "github_response_comment", providerActionId: `github_response:${delivery.id}`,
          status: "processed", payload: { botExternalId: "conflicting-app", agentId: context.fixture.assignedAgentId } });
        if (mode === "legacy_prior_wrong_app" || mode === "legacy_prior_wrong_agent") await db.update(chatActions).set({
          payload: sql`jsonb_set(${chatActions.payload}, ${mode === "legacy_prior_wrong_app" ? "{botExternalId}" : "{agentId}"}, '"another-identity"'::jsonb)`,
        }).where(priorWhere);
        if (mode === "legacy_prior_unlinked") await db.delete(chatMessageLinks).where(eq(chatMessageLinks.deliveryId, context.action.deliveryId!));
        if (mode === "legacy_prior_retargeted") await db.update(chatActions).set({ providerActionId: "github_response:unbound" }).where(priorWhere);
        if (mode.startsWith("legacy_explicit_")) await db.update(chatDeliveries).set({ normalizedEvent: {
          ...delivery.normalizedEvent, githubAuthority: { ...(delivery.normalizedEvent.githubAuthority as object),
            botExternalId: mode === "legacy_explicit_null" ? null : mode === "legacy_explicit_empty" ? ""
              : mode === "legacy_explicit_malformed" ? { appId: "untrusted" } : "another-app" },
        } }).where(eq(chatDeliveries.id, delivery.id));
        if (mode === "legacy_current_app_changed") await db.update(chatEndpoints).set({ botExternalId: randomUUID() })
          .where(eq(chatEndpoints.id, context.endpoint.id));
        if (mode !== "legacy_budget_ingress" && mode !== "legacy_prior_response" && !executionRevalidation) {
          await expect(requestTaskRetry(request)).rejects.toMatchObject({ details: {
            code: "chat_failed_run_retry_not_authorized", reason: "source_authorization", authorityReason: "app_binding",
          } });
          expect((await readAgentWakeupRequestsById(saved.id))[0]).toMatchObject({ status: "skipped", runId: null });
          expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toEqual(previousPublications);
          return;
        }
      }
      if (mode === "source_app_changed" || mode === "source_destination_changed") {
        await expect(requestTaskRetry(request)).rejects.toMatchObject({ details: {
          code: "chat_failed_run_retry_not_authorized", reason: "source_authorization",
          authorityReason: mode === "source_app_changed" ? "app_binding" : "destination_binding",
        } });
        expect((await readAgentWakeupRequestsById(saved.id))[0]).toMatchObject({ status: "skipped", runId: null });
        expect((await readHeartbeatRunsById(context.runId))[0]).toMatchObject({ status: "failed" });
        expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toEqual(previousPublications);
        return;
      }
      if (mode.startsWith("committed_succeeded") || mode.startsWith("committed_consumed") || mode === "malformed_previous" || mode === "committed_unknown_publication" || mode === "committed_pending_publication" || mode === "committed_mixed_publication") {
        await expect(requestTaskRetry(request)).rejects.toMatchObject({ details: {
          code: "chat_failed_run_retry_not_authorized",
          ...(mode.endsWith("publication") ? { reason: mode === "committed_consumed_publication" || mode === "committed_succeeded_publication"
            ? "accepted_result_without_new_input" : "prior_result_publication" } : {}),
        } });
        expect(await unadmitted()).toHaveLength(1);
        return;
      }
      const receipt = await requestTaskRetry(request);
      expect(receipt).toMatchObject({ accepted: true });
      const [retry] = await db.select().from(chatActions).where(eq(chatActions.id, receipt.chatActionId!));
      expect(retry.payload).toMatchObject({ commentIds: expectedComments });
      expect(await db.select({ id: chatActions.id }).from(chatActions).where(and(eq(chatActions.id, retry.id), dueChatAction("failed_run_retry")))).toHaveLength(1);
      expect((await readAgentWakeupRequestsById(saved.id))[0]).toMatchObject({ status: "skipped", runId: null });
      expect((await readHeartbeatRunsById(context.runId))[0]).toMatchObject({ status: "failed" });
      if (mode === "source_claimed") await db.update(agentWakeupRequests).set({ status: "queued", runId: context.runId })
        .where(eq(agentWakeupRequests.id, saved.id));
      if (mode === "source_edited") await db.update(issueComments).set({ body: "Edited after Retry" })
        .where(eq(issueComments.id, String(saved.payload.commentId)));
      if (mode === "endpoint_paused") await db.update(chatEndpoints).set({ status: "paused" })
        .where(eq(chatEndpoints.id, context.endpoint.id));
      if (mode === "principal_revoked") await db.update(companyMemberships).set({ status: "suspended" })
        .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, "owner-user")));
      if (realBudgetIngress || mode === "real_queue" || mode === "unreconciled" || mode.startsWith("committed_")) {
        // Capacity prevents a real provider start while exercising production
        // admission, persisted source identity, and queue ownership.
        await db.update(agents).set({ adapterType: "paperclip_runner", status: "running",
          runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } })
          .where(eq(agents.id, context.fixture.assignedAgentId));
        await db.insert(heartbeatRuns).values({ companyId, agentId: context.fixture.assignedAgentId,
          status: "running", startedAt: new Date() });
        context.wakeup.mockImplementation(heartbeatService(db).wakeup);
      } else if (mode !== "still_budget_blocked") context.wakeup.mockImplementation(async () => ({ accepted: true }));
      if (mode === "source_edited" || mode === "source_claimed" || mode === "endpoint_paused" || mode === "principal_revoked") {
        expect(await context.service.processFailedChatRunRetry(receipt.chatActionId!)).toMatchObject({ status: "failed" });
        expect(await readAgentWakeupRequestsById(receipt.chatActionId!)).toHaveLength(0);
      } else {
        await context.service.processFailedChatRunRetry(receipt.chatActionId!);
        const [admitted] = await readAgentWakeupRequestsById(receipt.chatActionId!);
        expect(admitted, JSON.stringify({ action: (await db.select().from(chatActions).where(eq(chatActions.id, receipt.chatActionId!)))[0], calls: context.wakeup.mock.calls.length })).toMatchObject({ requestedByActorId: "owner-user",
          payload: { wakeCommentId: saved.payload.commentId },
          status: mode === "still_budget_blocked" ? "skipped" : held ? "deferred_issue_execution" : "queued" });
        expect(context.wakeup.mock.calls.at(-1)![1].contextSnapshot).toMatchObject({
          source: `chat:${provider}`, wakeCommentId: saved.payload.commentId,
        });

        if (executionRevalidation) {
          const heartbeat = heartbeatService(db);
          const originalAuthorize = durableChatWakeup.authorizeFailedChatRunRetryWake;
          const verified: string[] = [];
          const identitySources: Array<{ runId: string; messageId: string | null }> = [];
          const realInitialize = runIdentityModule.initializeRunIdentity;
          const identityProof = vi.spyOn(runIdentityModule, "initializeRunIdentity").mockImplementation(async (database, input) => {
            const identity = await realInitialize(database, input);
            if (input.companyId === companyId && mode === "legacy_execution" && verified.length > 1) {
              identitySources.push({ runId: input.runId, messageId: identity.messageId });
              // Exercise the actual initializer after the real Retry execution
              // authority, without allocating a native provider for this probe.
              throw new Error("certified_retry_identity_probe_complete");
            }
            return identity;
          });
          const executionProof = vi.spyOn(durableChatWakeup, "authorizeFailedChatRunRetryWake").mockImplementation(async (...args) => {
            const input = args[2];
            const authorized = await originalAuthorize(...args);
            if (input.companyId === companyId && input.phase === "execution") {
              expect(authorized).toBe(true);
              if (!verified.length && mode === "legacy_execution") {
                // Exercise the actual dispatch authorization transaction after
                // real admission; restore each contradiction before the next.
                const tx = args[1];
                for (const changed of [{ runId: context.runId }, { companyId: randomUUID() },
                  { agentId: randomUUID() }, { issueId: randomUUID() }]) {
                  await expect(originalAuthorize(args[0], tx, { ...input, ...changed })).rejects.toThrow();
                }
                const [current] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId!));
                const [task] = await tx.select().from(issues).where(eq(issues.id, context.issue.id));
                const [wake] = await tx.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, input.wakeupRequestId!));
                const [coordinator] = await tx.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, context.runId));
                const [nativeResult] = await tx.select().from(nativeRunResults).where(eq(nativeRunResults.runId, context.runId));
                const [lease] = await tx.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, context.runId));
                const [sourceComment] = await tx.select().from(issueComments).where(eq(issueComments.id, saved.payload.commentId as string));
                const [endpoint] = await tx.select().from(chatEndpoints).where(eq(chatEndpoints.id, context.endpoint.id));
                const resolved = await tx.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, companyId),
                  eq(issueRecoveryActions.sourceIssueId, context.issue.id), eq(issueRecoveryActions.status, "resolved")));
                const deny = async (mutate: () => Promise<unknown>, restore: () => Promise<unknown>) => {
                  await mutate();
                  try { await expect(originalAuthorize(...args)).rejects.toThrow(); }
                  finally { await restore(); }
                };
                await deny(() => tx.update(heartbeatRuns).set({ contextSnapshot: { ...current.contextSnapshot, issueId: randomUUID() } }).where(eq(heartbeatRuns.id, current.id)),
                  () => tx.update(heartbeatRuns).set({ contextSnapshot: current.contextSnapshot }).where(eq(heartbeatRuns.id, current.id)));
                await deny(() => tx.update(heartbeatRuns).set({ contextSnapshot: { ...current.contextSnapshot, explicitUserContinuation: {
                  ...current.contextSnapshot!.explicitUserContinuation as object, commentId: randomUUID() } } }).where(eq(heartbeatRuns.id, current.id)),
                  () => tx.update(heartbeatRuns).set({ contextSnapshot: current.contextSnapshot }).where(eq(heartbeatRuns.id, current.id)));
                await deny(() => tx.update(agentWakeupRequests).set({ runId: context.runId }).where(eq(agentWakeupRequests.id, wake.id)),
                  () => tx.update(agentWakeupRequests).set({ runId: wake.runId }).where(eq(agentWakeupRequests.id, wake.id)));
                await deny(() => tx.update(issues).set({ executionRunId: context.runId }).where(eq(issues.id, task.id)),
                  () => tx.update(issues).set({ executionRunId: task.executionRunId }).where(eq(issues.id, task.id)));
                await deny(() => tx.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, task.id)),
                  () => tx.update(issues).set({ assigneeAgentId: task.assigneeAgentId }).where(eq(issues.id, task.id)));
                await deny(() => tx.update(issueComments).set({ body: "Changed authorized message" }).where(eq(issueComments.id, sourceComment.id)),
                  () => tx.update(issueComments).set({ body: sourceComment.body, updatedAt: sourceComment.updatedAt }).where(eq(issueComments.id, sourceComment.id)));
                await deny(() => tx.update(chatEndpoints).set({ status: "paused" }).where(eq(chatEndpoints.id, endpoint.id)),
                  () => tx.update(chatEndpoints).set({ status: endpoint.status }).where(eq(chatEndpoints.id, endpoint.id)));
                await deny(() => tx.update(agents).set({ status: "paused" }).where(eq(agents.id, input.agentId)),
                  () => tx.update(agents).set({ status: "running" }).where(eq(agents.id, input.agentId)));
                await deny(() => tx.update(nativeRunFinalizations).set({ leaseOwner: "still-running" }).where(eq(nativeRunFinalizations.runId, coordinator.runId)),
                  () => tx.update(nativeRunFinalizations).set({ leaseOwner: coordinator.leaseOwner }).where(eq(nativeRunFinalizations.runId, coordinator.runId)));
                await deny(async () => { adapterExecutionControls.set(context.runId, createAdapterExecutionControl()); },
                  async () => { adapterExecutionControls.get(context.runId)?.finish(); adapterExecutionControls.delete(context.runId); });
                await deny(() => tx.update(agentWakeupRequests).set({ status: "running" }).where(eq(agentWakeupRequests.id, wake.id)),
                  () => tx.update(agentWakeupRequests).set({ status: wake.status }).where(eq(agentWakeupRequests.id, wake.id)));
                await deny(() => tx.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 60000) }).where(eq(heartbeatRuns.id, context.runId)),
                  () => tx.update(heartbeatRuns).set({ controllerLeaseExpiresAt: null }).where(eq(heartbeatRuns.id, context.runId)));
                await deny(() => tx.update(environmentLeases).set({ metadata: {} }).where(eq(environmentLeases.id, lease.id)),
                  () => tx.update(environmentLeases).set({ metadata: lease.metadata }).where(eq(environmentLeases.id, lease.id)));
                await deny(() => tx.update(nativeRunResults).set({ resultJson: { terminal: { runTerminalState: "succeeded" } } }).where(eq(nativeRunResults.id, nativeResult.id)),
                  () => tx.update(nativeRunResults).set({ resultJson: nativeResult.resultJson }).where(eq(nativeRunResults.id, nativeResult.id)));
                for (const action of resolved) await deny(() => tx.update(issueRecoveryActions).set({ evidence: {} }).where(eq(issueRecoveryActions.id, action.id)),
                  () => tx.update(issueRecoveryActions).set({ evidence: action.evidence }).where(eq(issueRecoveryActions.id, action.id)));
              }
              verified.push(input.runId!);
              if (mode === "legacy_execution" && verified.length > 1) return authorized;
              // Stop after the real execution authority boundary. This produces
              // the exact never-started bootstrap shape without a provider call.
              throw conflict("The exact failed chat request can no longer be retried safely. Check its current connection, access, and recovery state.",
                { code: "chat_failed_run_retry_not_authorized" });
            }
            return authorized;
          });
          try {
            await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(and(
              eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "running"), isNull(heartbeatRuns.wakeupRequestId)));
            await db.update(agents).set({ status: "idle" }).where(eq(agents.id, context.fixture.assignedAgentId));
            await heartbeat.resumeQueuedRuns();
            await heartbeat.drainActiveRunExecutions();
            const [firstAttempt] = await readHeartbeatRunsById(admitted.runId!);
            expect(firstAttempt).toMatchObject({ status: "failed", errorCode: "chat_failed_run_retry_not_authorized",
              resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
            expect(verified).toEqual([firstAttempt.id]);
            if (mode === "legacy_execution_log") await db.update(heartbeatRuns).set({ logBytes: 1 }).where(eq(heartbeatRuns.id, firstAttempt.id));
            if (mode === "legacy_execution_profile") await db.update(heartbeatRuns).set({ runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" }, unexpectedExecution: true } }).where(eq(heartbeatRuns.id, firstAttempt.id));
            if (mode === "legacy_execution_controller") await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 60000) }).where(eq(heartbeatRuns.id, firstAttempt.id));
            if (mode === "legacy_execution_event") await db.update(heartbeatRunEvents).set({ message: "different diagnostic" }).where(and(eq(heartbeatRunEvents.runId, firstAttempt.id), eq(heartbeatRunEvents.seq, 1)));
            if (mode === "legacy_execution_intent") await db.update(agentWakeupRequests).set({ runId: context.runId }).where(eq(agentWakeupRequests.id, receipt.requestId!));
            if (mode === "legacy_execution_lease") await db.insert(environmentLeases).values({ companyId, heartbeatRunId: firstAttempt.id,
              issueId: context.issue.id, provider: "daytona", providerLeaseId: "unresolved-bootstrap-lease", status: "active", leasePolicy: "ephemeral" });
            const next = await requestTaskRetry({ ...request, observedRunId: firstAttempt.id, idempotencyKey: randomUUID() });
            expect(next).toMatchObject({ accepted: true });
            await context.service.processFailedChatRunRetry(next.chatActionId!);
            await heartbeat.resumeQueuedRuns();
            await heartbeat.drainActiveRunExecutions();
            const [nextWake] = await readAgentWakeupRequestsById(next.chatActionId!);
            if (mode !== "legacy_execution") {
              expect(nextWake).toBeUndefined();
              expect(verified).toEqual([firstAttempt.id]);
              expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toEqual(previousPublications);
              return;
            }
            expect(nextWake.runId).toBeTruthy();
            expect(nextWake.runId).not.toBe(firstAttempt.id);
            const [nextRun] = await readHeartbeatRunsById(nextWake.runId!);
            expect(nextRun).toMatchObject({ retryOfRunId: firstAttempt.id, wakeupRequestId: next.chatActionId,
              contextSnapshot: { source: "chat:github", wakeCommentId: saved.payload.commentId,
                wakeCommentIds: [saved.payload.commentId] } });
            expect(verified).toEqual([firstAttempt.id, nextRun.id]);
            expect(identitySources).toEqual([{ runId: nextRun.id, messageId: saved.payload.commentId }]);
            await expect(chatRunSourceMessageId(db, nextRun, { provider: "github" })).resolves.toBe(saved.payload.commentId);
            expect((await readHeartbeatRunsByCompanyId(companyId)).filter(run => run.contextSnapshot?.wakeCommentId === saved.payload.commentId))
              .toHaveLength(2);
            expect((await readHeartbeatRunsById(context.runId))[0]).toMatchObject({ status: "failed" });
            expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toEqual(previousPublications);
            return;
          } finally { executionProof.mockRestore(); identityProof.mockRestore(); await heartbeat.drainActiveRunExecutions(); }
        }
        await context.service.processFailedChatRunRetry(receipt.chatActionId!);
        expect(await unadmitted()).toHaveLength(mode === "still_budget_blocked" ? 1 : 0);
        if (held) {
          expect(admitted.runId).toBeNull();
          await reconcileTaskChatRetryReceipts(db);
          await context.service.processFailedChatRunRetry(receipt.chatActionId!);
          expect((await readAgentWakeupRequestsById(receipt.chatActionId!))[0]).toMatchObject({
            status: "deferred_issue_execution", runId: null });
          expect((await db.select().from(issueRecoveryActions).where(and(
            eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, context.issue.id)))))
            .toEqual(expect.arrayContaining([expect.objectContaining({ status: "active" })]));
          if (mode === "committed_delayed_cleanup" || queuedBoard) {
            const [boardComment] = queuedBoard ? await db.insert(issueComments).values({
              companyId, issueId: context.issue.id, authorType: "user", authorUserId: "owner-user",
              body: "Keep this independent continuation for its own authorized turn.",
            }).returning() : [];
            const [boardWake] = boardComment ? await db.insert(agentWakeupRequests).values({ companyId,
              agentId: context.fixture.assignedAgentId, source: "automation", triggerDetail: "system",
              reason: "issue_commented", status: "deferred_issue_execution",
              requestedByActorType: "user", requestedByActorId: "owner-user",
              payload: { issueId: context.issue.id, commentId: boardComment.id, wakeCommentIds: [boardComment.id],
                _paperclipWakeContext: { issueId: context.issue.id, taskKey: context.issue.id,
                  source: "issue.comment.reopen", wakeReason: "issue_commented",
                  wakeCommentId: boardComment.id, wakeCommentIds: [boardComment.id] } },
            }).returning() : [];
            const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, context.runId));
            await db.update(environmentLeases).set({ metadata: { ...lease.metadata,
              remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "destroyed" }) },
            }).where(eq(environmentLeases.id, lease.id));
            await reconcileTaskChatRetryReceipts(db);
            await context.service.processFailedChatRunRetry(receipt.chatActionId!);
            let [resumed] = await readAgentWakeupRequestsById(receipt.chatActionId!);
            expect(resumed).toMatchObject({ id: admitted.id, status: "queued" });
            expect(resumed.runId).toBeTruthy();
            expect((await readHeartbeatRunsById(resumed.runId!))[0]).toMatchObject({ status: "queued",
              contextSnapshot: { wakeCommentId: saved.payload.commentId } });
            if (boardWake) {
              const heartbeat = heartbeatService(db);
              if (mode.startsWith("committed_board_existing")) {
                // Persist the historical producer's merged batch, then let real
                // dispatch reject it before any identity or provider starts.
                const [queued] = await readHeartbeatRunsById(resumed.runId!);
                if (mode === "committed_board_existing_coalesced") {
                  await db.update(chatActions).set({ status: "processed" }).where(inArray(chatActions.id, savedInputs.map(source => source.id)));
                  await db.update(agentWakeupRequests).set({ status: "coalesced", runId: queued.id,
                    payload: sql`${agentWakeupRequests.payload} || ${JSON.stringify({ coalescedIntoWakeupRequestId: resumed.id })}::jsonb`,
                  }).where(inArray(agentWakeupRequests.id, savedInputs.map(source => source.id)));
                }
                const mixedIds = [boardComment!.id, ...expectedComments];
                // Replaying this test with the queue fix reverted uses the old
                // producer's actual persisted merge. With the fixed producer,
                // retain historical state using its shared serializers.
                if (!(queued.contextSnapshot?.wakeCommentIds as string[])?.includes(boardComment!.id)) {
                  const { withQueuedCommentIdsInRunContext, withQueuedCommentIdsInWakePayload } =
                    await import("../../services/issue-queued-comment-queue.js");
                  await db.update(heartbeatRuns).set({ contextSnapshot:
                    withQueuedCommentIdsInRunContext(queued.contextSnapshot, mixedIds, [boardWake.id]) })
                    .where(eq(heartbeatRuns.id, queued.id));
                  await db.update(agentWakeupRequests).set({ payload:
                    withQueuedCommentIdsInWakePayload(resumed.payload, mixedIds) })
                    .where(eq(agentWakeupRequests.id, resumed.id));
                  await db.update(agentWakeupRequests).set({ status: "coalesced", runId: queued.id,
                    finishedAt: new Date() }).where(eq(agentWakeupRequests.id, boardWake.id));
                }
                expect((await readHeartbeatRunsById(queued.id))[0].contextSnapshot).toMatchObject({
                  wakeCommentId: expectedComments.at(-1), wakeCommentIds: mixedIds,
                  queuedCommentSourceWakeIds: [boardWake.id],
                });
                expect((await readAgentWakeupRequestsById(boardWake.id))[0]).toMatchObject({
                  status: "coalesced", runId: queued.id, payload: { issueId: context.issue.id },
                });
                expect((await readAgentWakeupRequestsById(boardWake.id))[0].payload)
                  .not.toHaveProperty("coalescedIntoWakeupRequestId");
                await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(and(
                  eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "running"), isNull(heartbeatRuns.wakeupRequestId)));
                await db.update(agents).set({ status: "idle" }).where(eq(agents.id, context.fixture.assignedAgentId));
                await heartbeat.resumeQueuedRuns();
                await heartbeat.drainActiveRunExecutions();
                const [failed] = await readHeartbeatRunsById(queued.id);
                expect(failed).toMatchObject({ status: "failed", errorCode: "chat_failed_run_retry_not_authorized",
                  resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
                await db.insert(heartbeatRuns).values({ companyId, agentId: context.fixture.assignedAgentId,
                  status: "running", startedAt: new Date() });
                await db.update(agents).set({ status: "running" }).where(eq(agents.id, context.fixture.assignedAgentId));
                const nextInput = { ...request, observedRunId: failed.id, idempotencyKey: randomUUID() };
                if (mode.endsWith("source_edited")) await db.update(issueComments).set({ body: "Changed external source" })
                  .where(eq(issueComments.id, String(saved.payload.commentId)));
                if (mode.endsWith("board_edited")) await db.update(issueComments).set({ body: "Changed board source",
                  updatedAt: new Date(boardComment!.createdAt.getTime() + 1) })
                  .where(eq(issueComments.id, boardComment!.id));
                if (mode.endsWith("controller")) await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 60_000) })
                  .where(eq(heartbeatRuns.id, failed.id));
                if (mode.endsWith("allocation")) await db.insert(environmentLeases).values({ companyId,
                  heartbeatRunId: failed.id, issueId: context.issue.id, provider: "daytona", providerLeaseId: "unknown-executor",
                  status: "active", leasePolicy: "ephemeral" });
                if (mode.endsWith("receipt")) await db.update(agentWakeupRequests).set({ status: "claimed" })
                  .where(eq(agentWakeupRequests.id, boardWake.id));
                if (mode.endsWith("source_owner")) await db.update(agentWakeupRequests).set({
                  status: "coalesced", runId: context.runId,
                  payload: sql`${agentWakeupRequests.payload} || ${JSON.stringify({ coalescedIntoWakeupRequestId: resumed.id })}::jsonb`,
                }).where(eq(agentWakeupRequests.id, saved.id));
                if (mode.endsWith("delivered")) await db.insert(heartbeatRuns).values({ companyId,
                  agentId: context.fixture.assignedAgentId, status: "succeeded", finishedAt: new Date(),
                  createdAt: new Date(failed.createdAt.getTime() - 1),
                  contextSnapshot: { issueId: context.issue.id, wakeCommentIds:
                    [mode.endsWith("source_delivered") ? saved.payload.commentId : boardComment!.id] },
                });
                const inputIds = [boardWake.id, ...savedInputs.map(source => source.id)];
                const before = await db.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, inputIds)).orderBy(asc(agentWakeupRequests.id));
                if (mode === "committed_board_existing_identity_contended") {
                  const events: string[] = [];
                  const topics = [DELIVERY_QUEUES.deferredExecutionReceipts, CHAT_ACTION_QUEUES.failed_run_retry];
                  const unsubscribes = topics.map(topic => subscribeDatabaseWork(db, topic, event => events.push(event)));
                  const rollback = new Error("rollback restored Retry preparation");
                  let rolledBackActionId: string | undefined;
                  try {
                    await expect(db.transaction(async tx => {
                      events.length = 0;
                      const staged = await requestTaskRetry({ ...nextInput, db: tx as unknown as Db });
                      rolledBackActionId = staged.chatActionId ?? undefined;
                      expect(rolledBackActionId).toBeTruthy();
                      expect(events).toContain("intent");
                      expect(events).not.toContain("settled");
                      expect(await db.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, inputIds))
                        .orderBy(asc(agentWakeupRequests.id))).toEqual(before);
                      expect(await tx.select().from(activityLog).where(and(eq(activityLog.companyId, companyId),
                        eq(activityLog.runId, failed.id), eq(activityLog.action, "issue.retry_inputs_restored")))).toHaveLength(1);
                      throw rollback;
                    })).rejects.toBe(rollback);
                    for (const topic of topics) {
                      await reconcileDatabaseWork(db, topic);
                      expect(databaseWorkPending(db, topic)).toBe(false);
                    }
                    expect(await db.select().from(chatActions).where(eq(chatActions.id, rolledBackActionId!))).toEqual([]);
                    expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId),
                      eq(activityLog.runId, failed.id), eq(activityLog.action, "issue.retry_inputs_restored")))).toEqual([]);
                    expect(await db.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, inputIds))
                      .orderBy(asc(agentWakeupRequests.id))).toEqual(before);
                  } finally { unsubscribes.forEach(unsubscribe => unsubscribe()); }
                }
                if (mode !== "committed_board_existing" && mode !== "committed_board_existing_coalesced" && mode !== "committed_board_existing_identity_contended" && mode !== "committed_board_existing_identity_expired") {
                  await expect(requestTaskRetry(nextInput)).rejects.toMatchObject({
                    details: { code: "chat_failed_run_retry_not_authorized" },
                  });
                  expect(await db.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, inputIds)).orderBy(asc(agentWakeupRequests.id)))
                    .toEqual(before);
                  return;
                }
                const app = express();
                app.use(express.json());
                app.use((req, _res, next) => { req.actor = boardActor(companyId); next(); });
                app.use("/api", issueRoutes(db, createStorageService().storage, { chatRunRetries: context.service }));
                app.use(errorHandler);
                const httpRequest = (await import("supertest")).default;
                const retryHttp = () => httpRequest(app).post(`/api/issues/${context.issue.id}/retry`).send({
                  idempotencyKey: nextInput.idempotencyKey, observedRunId: nextInput.observedRunId,
                }).expect(202);
                const restoredRetryWake = vi.fn(heartbeat.wakeup);
                const retryWithIdentityContention = async () => {
                  if (mode !== "committed_board_existing_identity_contended" && mode !== "committed_board_existing_identity_expired") return retryHttp();
                  let release = () => {};
                  const held = new Promise<void>(resolve => { release = resolve; });
                  let acquired = () => {};
                  const locked = new Promise<void>(resolve => { acquired = resolve; });
                  const holding = db.transaction(async tx => {
                    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`chat-identity:${companyId}:${saved.principalId}`}, 0))`);
                    acquired(); await held;
                  });
                  try {
                    await locked;
                    const response = await retryHttp();
                    if (mode === "committed_board_existing_identity_expired" || mode === "committed_board_existing_identity_contended")
                      await context.service.processFailedChatRunRetry(response.body.chatActionId);
                    if (mode === "committed_board_existing_identity_contended") context.wakeup
                      .mockImplementation(restoredRetryWake).mockRejectedValueOnce(new Error("retry_admission_unavailable_before_receipt"));
                    expect(await db.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, inputIds))
                      .orderBy(asc(agentWakeupRequests.id))).toEqual(before);
                    return response;
                  } finally { release(); await holding; }
                };
                const next = (await retryWithIdentityContention()).body;
                expect(next).toMatchObject({ accepted: true });
                if (mode === "committed_board_existing_identity_expired") {
                  const [pending] = await db.select().from(chatActions).where(eq(chatActions.id, next.chatActionId!));
                  expect(pending.payload).toMatchObject({ sourceAuthorizationPending: true, restoreUnstartedInput: true });
                  const deadline = Date.now() + 5_000;
                  await db.update(chatActions).set({ result: { ...pending.result,
                    identityContentionDeadlineAt: new Date(deadline).toISOString(), retryAt: new Date(0).toISOString() } })
                    .where(eq(chatActions.id, pending.id));
                  const realPermission = taskRetryModule.taskRetryMutationAllowed;
                  const permission = vi.spyOn(taskRetryModule, "taskRetryMutationAllowed").mockImplementation(async (database, input) => {
                    const allowed = await realPermission(database, input);
                    if (input.companyId === companyId) {
                      expect(await database.select().from(activityLog).where(and(eq(activityLog.companyId, companyId),
                        eq(activityLog.runId, failed.id), eq(activityLog.action, "issue.retry_inputs_restored")))).toHaveLength(1);
                      await new Promise(resolve => setTimeout(resolve, Math.max(0, deadline - Date.now()) + 1));
                    }
                    return allowed;
                  });
                  const publications = await readChatPublicationsByEndpointId(context.endpoint.id);
                  const runIds = (await readHeartbeatRunsByCompanyId(companyId)).map(run => run.id).sort();
                  context.wakeup.mockClear();
                  try {
                    await context.service.processFailedChatRunRetry(pending.id);
                    expect(permission).toHaveBeenCalled();
                    expect((await db.select().from(chatActions).where(eq(chatActions.id, pending.id)))[0])
                      .toMatchObject({ status: "failed", payload: { sourceAuthorizationPending: true },
                        result: { code: "failed_chat_retry_contention_expired" } });
                    expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId),
                      eq(activityLog.runId, failed.id), eq(activityLog.action, "issue.retry_inputs_restored")))).toEqual([]);
                    expect(await db.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, inputIds))
                      .orderBy(asc(agentWakeupRequests.id))).toEqual(before);
                    expect(context.wakeup).not.toHaveBeenCalled();
                    expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toEqual(publications);
                    expect((await readAgentWakeupRequestsById(next.requestId!))[0]).toMatchObject({ status: "failed", runId: null });
                    expect((await readHeartbeatRunsByCompanyId(companyId)).map(run => run.id).sort()).toEqual(runIds);
                  } finally { permission.mockRestore(); }
                  return;
                }
                expect((await retryHttp()).body.requestId).toBe(next.requestId);
                if (mode === "committed_board_existing_identity_contended") await vi.waitFor(async () => {
                  await context.service.processFailedChatRunRetries();
                  expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId),
                    eq(activityLog.runId, failed.id), eq(activityLog.action, "issue.retry_inputs_restored")))).toHaveLength(1);
                }, { timeout: 5_000, interval: 50 });
                expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId),
                  eq(activityLog.runId, failed.id), eq(activityLog.action, "issue.retry_inputs_restored")))).toHaveLength(1);
                await vi.waitFor(async () => {
                  expect(await context.service.processFailedChatRunRetry(next.chatActionId!)).toMatchObject({ status: "queued" });
                  [resumed] = await readAgentWakeupRequestsById(next.chatActionId!);
                  expect(resumed).toMatchObject({ companyId, agentId: context.fixture.assignedAgentId,
                    requestedByActorType: "user", requestedByActorId: "owner-user",
                    payload: { taskRetryRequestId: next.requestId, retryOfRunId: failed.id } });
                  expect(resumed.runId).toBeTruthy();
                  await reconcileTaskChatRetryReceipts(db, { companyId, requestId: next.requestId! });
                  expect((await readAgentWakeupRequestsById(next.requestId!))[0]?.runId).toBe(resumed.runId);
                }, { timeout: 5_000, interval: 50 });
                if (mode === "committed_board_existing_identity_contended") {
                  expect(restoredRetryWake).toHaveBeenCalledOnce();
                  expect(restoredRetryWake).toHaveBeenCalledWith(context.fixture.assignedAgentId, expect.objectContaining({
                    taskRetryRequestId: next.requestId, requestedByActorType: "user", requestedByActorId: "owner-user",
                    contextSnapshot: expect.objectContaining({ taskRetryRequestId: next.requestId,
                      chatFailedRunRetry: { version: 1, actionId: next.chatActionId, failedRunId: failed.id } }),
                  }));
                  expect((await readHeartbeatRunsByCompanyId(companyId)).filter(run =>
                    run.contextSnapshot?.taskRetryRequestId === next.requestId).map(run => run.id)).toEqual([resumed.runId]);
                  expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId),
                    eq(activityLog.runId, failed.id), eq(activityLog.action, "issue.retry_inputs_restored")))).toHaveLength(1);
                }
                if (mode === "committed_board_existing_coalesced") {
                  const restored = await db.select().from(agentWakeupRequests)
                    .where(inArray(agentWakeupRequests.id, savedInputs.map(source => source.id)));
                  expect(restored).toHaveLength(10);
                  expect(restored.every(wake => wake.status === "coalesced" && wake.runId === resumed.runId)).toBe(true);
                }
                expect((await readHeartbeatRunsById(failed.id))[0].contextSnapshot).toEqual(failed.contextSnapshot);
              }
              const realInitialize = runIdentityModule.initializeRunIdentity;
              const initialized: Array<{ runId: string; messageId: string | null }> = [];
              expect((await readAgentWakeupRequestsById(boardWake.id))[0])
                .toMatchObject({ status: "deferred_issue_execution", runId: null });
              const probe = vi.spyOn(runIdentityModule, "initializeRunIdentity").mockImplementation(async (database, input) => {
                const identity = await realInitialize(database, input);
                if (input.companyId !== companyId) return identity;
                initialized.push({ runId: input.runId, messageId: identity.messageId });
                throw new Error("certified_batch_identity_probe_complete");
              });
              try {
                await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(and(
                  eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "running"), isNull(heartbeatRuns.wakeupRequestId)));
                await db.update(agents).set({ status: "idle" }).where(eq(agents.id, context.fixture.assignedAgentId));
                await heartbeat.resumeQueuedRuns();
                await heartbeat.drainActiveRunExecutions();
                const [successor] = await readHeartbeatRunsById(resumed.runId!);
                expect(successor).toMatchObject({ error: "certified_batch_identity_probe_complete",
                  contextSnapshot: { wakeCommentIds: expectedComments } });
                expect(successor.contextSnapshot?.queuedCommentSourceWakeIds).toBeUndefined();
                const [boardReceipt] = await readAgentWakeupRequestsById(boardWake.id);
                expect(boardReceipt.runId).toBeTruthy();
                expect(boardReceipt.runId).not.toBe(resumed.runId);
                expect(initialized).toEqual([
                  { runId: resumed.runId, messageId: saved.payload.commentId },
                  { runId: boardReceipt.runId, messageId: boardComment!.id },
                ]);
                expect((await readHeartbeatRunsById(boardReceipt.runId!))[0]).toMatchObject({
                  contextSnapshot: { wakeCommentIds: [boardComment!.id] },
                });
              } finally { probe.mockRestore(); await heartbeat.drainActiveRunExecutions(); }
            }
            await context.service.processFailedChatRunRetry(receipt.chatActionId!);
            await reconcileTaskChatRetryReceipts(db);
            expect((await readHeartbeatRunsByCompanyId(companyId)).filter(run =>
              run.contextSnapshot?.taskRetryRequestId === receipt.requestId)).toHaveLength(1);
            expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, context.runId)))[0])
              .toMatchObject({ phase: "committed" });
          }
        }
        if (mode === "real_queue" || mode === "committed_failure" || mode === "committed_failed_publication") {
          expect(admitted.runId).toBeTruthy();
          expect((await readHeartbeatRunsById(admitted.runId!))[0]).toMatchObject({ status: "queued",
            contextSnapshot: { source: `chat:${provider}`, wakeCommentId: saved.payload.commentId } });
          if (provider === "github") expect(await resolveRunScopedMentionedSkillKeys({ db, companyId,
            issueId: context.issue.id, commentIds: [String(saved.payload.commentId)] })).toEqual([skill.key]);
          await reconcileTaskChatRetryReceipts(db);
          expect((await readAgentWakeupRequestsById(receipt.requestId!))[0]).toMatchObject({
            status: "coalesced", runId: admitted.runId });
          const calls = context.wakeup.mock.calls.length;
          await db.update(chatActions).set({ status: "issued", result: null, updatedAt: new Date() })
            .where(eq(chatActions.id, receipt.chatActionId!));
          await context.service.processFailedChatRunRetry(receipt.chatActionId!);
          expect(context.wakeup.mock.calls).toHaveLength(calls);
          expect((await db.select().from(chatActions).where(eq(chatActions.id, receipt.chatActionId!)))[0])
            .toMatchObject({ status: "processed" });
          if (mode === "committed_failure") {
            expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, context.runId)))[0])
              .toMatchObject({ phase: "committed" });
            expect((await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, context.runId)))[0])
              .toMatchObject({ schemaStatus: "accepted", resultJson: { terminal: { runTerminalState: "failed" } } });
          }
        }
      }
      expect((await readAgentWakeupRequestsById(saved.id))[0]).toMatchObject(mode === "source_claimed"
        ? { status: "queued", runId: context.runId } : mode === "committed_board_existing_coalesced"
          ? { status: "coalesced", runId: expect.any(String) } : { status: "skipped", runId: null });
      expect((await readHeartbeatRunsById(context.runId))[0]).toMatchObject({ status: "failed" });
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toEqual(previousPublications);
    } finally { await context.service.shutdown(); }
  });

  it.each([
    "settled",
    "distinct_account",
    "null_account",
    "wrong_account",
    "missing_account",
    "malformed_account",
    "missing_thread",
    "older_warm_run",
    "committed_marker",
    "foreign_marker",
    "prepared_marker",
    "pending_lease_cleanup",
    "missing_receipt",
    "activation_prepared",
    "changed_checkpoint",
    "late_event",
    "leased",
    "wrong_thread",
    "source_edited",
    "different_error",
  ].flatMap((mode) => [
    "runner_state_identity_mismatch",
    "runner_state_identity_mismatch: prior_owner_active",
  ].map((errorMessage) => ({ mode, errorMessage }))))(
    "retries only the original pre-provider Telegram request after exact cleanup: $mode ($errorMessage)",
    async ({ mode, errorMessage }) => {
      const context = await committedChatResponseRecoveryFixture("telegram");
      const providerAccount =
        mode === "null_account"
          ? null
          : mode === "distinct_account"
            ? "retained-backend-account"
            : "same-retained-thread";
      const checkpointAccount =
        mode === "wrong_account"
          ? "another-account"
          : mode === "missing_account"
            ? undefined
            : mode === "malformed_account"
              ? 123
              : providerAccount;
      const previous = process.env.PAPERCLIP_RUNNER_STATE_DIR;
      const directory = mkdtempSync(
        path.join(os.tmpdir(), "paperclip-chat-cleanup-retry-"),
      );
      process.env.PAPERCLIP_RUNNER_STATE_DIR = directory;
      try {
        const runId = randomUUID();
        const nativeSessionId = context.binding.normalizedSessionId;
        const runnerInstanceId = context.binding.runnerSourceInstanceId;
        const inputFor = (id: string) => ({
          schema: "paperclip.native-execution-input.v1",
          provider: { kind: "codex", model: null },
          binding: {
            companyId: context.fixture.companyId,
            runId: id,
            issueId: context.issue.id,
            agentId: context.fixture.assignedAgentId,
            executionWorkspaceId: id,
          },
          task: {
            identifier: context.issue.identifier,
            title: "Exact queued request",
            description: null,
            prompt: "Exact queued request",
            workMode: "standard",
          },
          workspace: {
            cwd: "/tmp/paperclip-cleanup-retry",
            repoUrl: null,
            repoRef: null,
            branchName: null,
          },
          session: {
            normalizedSessionId: nativeSessionId,
            driverKind: "codex_app_server",
            protocolVersion: 1,
            lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
          },
          completionContract: {
            id: context.binding.completionContractId,
            sha256: context.binding.completionContractSha256,
            schemaVersion: "paperclip.completion-contract.v1",
            contract: {
              revision: "recovered-response-v1",
              objective: "Exact request",
              criteria: [
                { id: "response", requirement: "Return the requested answer" },
              ],
            },
          },
          interactionResponses: [],
          credentialBindings: [],
        });
        await db
          .update(heartbeatRuns)
          .set({
            status: "succeeded",
            processPid: 99_999_999,
            processGroupId: 99_999_999,
            runnerProfileJson: {
              nativeExecutionInput: inputFor(context.runId),
            },
          })
          .where(eq(heartbeatRuns.id, context.runId));
        if (mode === "older_warm_run") {
          const olderId = randomUUID();
          await db.insert(heartbeatRuns).values({
            id: olderId,
            companyId: context.fixture.companyId,
            agentId: context.fixture.assignedAgentId,
            status: "succeeded",
            finishedAt: new Date(Date.now() - 60_000),
            runtimeMode: "native",
            nativeIssueId: context.issue.id,
            nativeSessionId,
            runnerInstanceId,
            processPid: 99_999_999,
            processGroupId: 99_999_999,
            runnerProfileJson: { nativeExecutionInput: inputFor(olderId) },
          });
        }
        await deliverMessage({
          callbacks: context.runtime.configurations.get(context.endpoint.id)!
            .callbacks,
          endpointId: context.endpoint.id,
          provider: "telegram",
          thread: context.thread.thread,
          message: makeMessage({
            id: `${context.thread.thread.channelId}:102`,
            text: "The exact queued request B",
            userId: context.thread.thread.channelId,
          }),
          trigger: "direct_message",
        });
        const [action] = await db
          .select()
          .from(chatActions)
          .where(
            and(
              eq(chatActions.conversationId, context.conversation.id),
              eq(chatActions.kind, "inbound_wakeup"),
              sql`${chatActions.id} <> ${context.action.id}::uuid`,
            ),
          );
        expect(action).toBeDefined();
        await db.insert(heartbeatRuns).values({
          id: runId,
          companyId: context.fixture.companyId,
          agentId: context.fixture.assignedAgentId,
          status: "failed",
          errorCode: "adapter_failed",
          error: mode === "different_error"
            ? errorMessage.replace("runner_state_identity_mismatch", "runner_state_identity_mismatch_other")
            : errorMessage,
          finishedAt: new Date(),
          wakeupRequestId: action.id,
          runtimeMode: "native",
          nativeIssueId: context.issue.id,
          nativeSessionId,
          runnerInstanceId,
          nativePhase: "observed",
          processPid: 99_999_999,
          processGroupId: 99_999_999,
          contextSnapshot: {
            issueId: context.issue.id,
            taskKey: context.issue.identifier,
            source: "chat:telegram",
            wakeCommentId: action.payload.commentId,
            wakeCommentIds: [action.payload.commentId],
          },
          runnerProfileJson: {
            nativeExecutionInput: inputFor(runId),
            sessionCheckpoint: {
              sessionId:
                mode === "wrong_thread"
                  ? "another-thread"
                  : mode === "missing_thread"
                    ? undefined
                    : "same-retained-thread",
              providerSessionId: checkpointAccount,
              identity: {
                companyId: context.fixture.companyId,
                issueId: context.issue.id,
                agentId: context.fixture.assignedAgentId,
                runId,
                sessionId: nativeSessionId,
              },
            },
          },
        });
        await db
          .update(agentWakeupRequests)
          .set({ status: "failed", runId })
          .where(eq(agentWakeupRequests.id, action.id));
        await db.insert(nativeRunFinalizations).values({
          companyId: context.fixture.companyId,
          issueId: context.issue.id,
          runId,
          phase: "observed",
          attempt: 0,
          leaseOwner: mode === "leased" ? "other-owner" : null,
        });
        await db.insert(environmentLeases).values({
          companyId: context.fixture.companyId,
          issueId: context.issue.id,
          heartbeatRunId: runId,
          provider: "local",
          status: "failed",
          releasedAt: new Date(),
          cleanupStatus: mode === "pending_lease_cleanup" ? "pending" : null,
        });
        await db
          .update(issues)
          .set({ status: "in_review", executionRunId: null })
          .where(eq(issues.id, context.issue.id));
        const canonical = (value: unknown): string =>
          value && typeof value === "object" && !Array.isArray(value)
            ? `{${Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(
                  ([key, entry]) =>
                    `${JSON.stringify(key)}:${canonical(entry)}`,
                )
                .join(",")}}`
            : JSON.stringify(value);
        const key = createHash("sha256")
          .update(
            canonical({
              schema: "paperclip.native-session-scope.v2",
              companyId: context.fixture.companyId,
              agentId: context.fixture.assignedAgentId,
              workspace: { kind: "transient", ...inputFor(runId).workspace },
              provider: {
                driverKind: "codex_app_server",
                identity: { kind: "codex" },
              },
              normalizedSessionId: nativeSessionId,
            }),
          )
          .digest("hex");
        const root = path.join(directory, key);
        mkdirSync(path.join(root, "runner"), { recursive: true });
        mkdirSync(path.join(root, "control-plane"), { recursive: true });
        const identity = {
          runId: context.runId,
          runnerInstanceId,
          environmentLeaseId: context.runId,
          normalizedSessionId: nativeSessionId,
        };
        const files = [
          [
            "control-plane/control-plane-state.json",
            {
              schema: "paperclip.runner.durable.control-plane-state.v1",
              identity,
            },
          ],
          [
            "runner/runner-state.json",
            {
              schema: "paperclip.runner.durable.state.v1",
              ...identity,
              lifecycle: "suspended",
              outbox: [],
            },
          ],
          [
            "runner/codex-provider-state.json",
            {
              schema: "paperclip.runner.codex-provider-state.v1",
              lifecycle: "prepared",
              threadId: "same-retained-thread",
              providerSessionId: providerAccount,
              activeProviderTurnId: null,
              config: { provider: "codex", driver: "codex_app_server" },
              pendingEvents: [],
              queuedEvents: [],
              toolBridge: { pending: {} },
            },
          ],
        ] as const;
        const bytes = files.map(([file, data]) => {
          const text = JSON.stringify(data);
          writeFileSync(path.join(root, file), text);
          return text;
        });
        const fingerprint = createHash("sha256")
          .update(
            JSON.stringify(
              bytes.map((text) =>
                createHash("sha256").update(text).digest("hex"),
              ),
            ),
          )
          .digest("hex");
        await db
          .update(nativeRunFinalizations)
          .set({
            recoveryHistory:
              mode === "missing_receipt"
                ? []
                : [
                    {
                      kind: "native_cleanup_maintenance",
                      version: 1,
                      phase:
                        mode === "activation_prepared" ||
                        mode === "prepared_marker"
                          ? "activation_prepared"
                          : "settled",
                      requestId: "exact-cleanup-receipt",
                      nativeSessionId,
                      runnerInstanceId,
                      providerSessionId: "same-retained-thread",
                      sourceFingerprint: "a".repeat(64),
                      settledFingerprint: fingerprint,
                    },
                  ],
          })
          .where(eq(nativeRunFinalizations.runId, context.runId));
        if (
          ["committed_marker", "foreign_marker", "prepared_marker"].includes(
            mode,
          )
        ) {
          writeFileSync(
            path.join(root, "cleanup-activation.json"),
            JSON.stringify({
              schema: "paperclip.native_cleanup_activation.v1",
              companyId: context.fixture.companyId,
              issueId: context.issue.id,
              runId: context.runId,
              requestId:
                mode === "foreign_marker"
                  ? "another-receipt"
                  : "exact-cleanup-receipt",
              sourceFingerprint: "a".repeat(64),
              settledFingerprint: fingerprint,
            }),
          );
        }
        if (mode === "changed_checkpoint")
          writeFileSync(
            path.join(root, "runner/runner-state.json"),
            JSON.stringify({ ...files[1][1], lifecycle: "ready" }),
          );
        if (mode === "late_event")
          await db.insert(heartbeatRunEvents).values({
            companyId: context.fixture.companyId,
            agentId: context.fixture.assignedAgentId,
            runId,
            seq: 1,
            eventType: "session.started",
            sourceInstanceId: runnerInstanceId,
            payload: { prpEvent: { sourceKind: "runner" } },
          });
        if (mode === "source_edited")
          await db
            .update(issueComments)
            .set({ body: "Changed after admission", updatedAt: new Date() })
            .where(eq(issueComments.id, String(action.payload.commentId)));
        const stage = () =>
          db.transaction((tx) =>
            context.service.prepareFailedChatRunRetry(tx, {
              companyId: context.fixture.companyId,
              issueId: context.issue.id,
              agentId: context.fixture.assignedAgentId,
              failedRunId: runId,
              initiatedByUserId: "owner-user",
            }),
          );
        const [original] = await readHeartbeatRunsById(runId);
        if (
          mode === "settled" ||
          mode === "distinct_account" ||
          mode === "null_account" ||
          mode === "older_warm_run" ||
          mode === "committed_marker"
        ) {
          const intent = await stage();
          expect(await stage()).toEqual(intent);
          await expect(
            context.service.processFailedChatRunRetry(intent.actionId),
          ).resolves.toMatchObject({ status: "queued" });
          const [receipt] = await readAgentWakeupRequestsById(intent.actionId);
          expect(receipt.payload).toMatchObject({
            retryOfRunId: runId,
            wakeCommentIds: [action.payload.commentId],
          });
          expect(
            await readHeartbeatRunsById(runId),
          ).toEqual([original]);
          expect(
            (
              await db
                .select()
                .from(nativeRunFinalizations)
                .where(eq(nativeRunFinalizations.runId, runId))
            )[0],
          ).toMatchObject({ phase: "observed", attempt: 0 });
          if (mode === "committed_marker")
            expect(existsSync(path.join(root, "cleanup-activation.json"))).toBe(
              true,
            );
        } else
          await expect(stage()).rejects.toMatchObject({
            details: { code: "chat_failed_run_retry_not_authorized" },
          });
      } finally {
        await context.service.shutdown();
        if (previous === undefined)
          delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
        else process.env.PAPERCLIP_RUNNER_STATE_DIR = previous;
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.each((["github", "telegram"] as const).flatMap(provider =>
    (["unregistered", "pending", "historical_sibling", "foreign_source_hold", "automatic_scheduled", "automatic_running", "automatic_awaiting_evidence", "exhausted", "wrong_generation", "paused_endpoint", "paused_after_wait", "paused_agent_after_wait", "edited_after_wait", "superseded_after_wait"] as const).map(gate => ({ provider, gate }))))(
    "holds an ordinary $provider Retry behind its exact remote recovery: $gate", async ({ provider, gate }) => {
      const context = await failedChatRetryFixture(provider, undefined, true);
      try {
        const companyId = context.fixture.companyId, issueId = context.issue.id;
        const leaseId = randomUUID();
        await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issueId,
          nativePhase: "terminal_failure", runnerProfileJson: {},
          resultJson: { workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: {
            schema: "paperclip.workspace-restore-recovery.v1", runId: context.runId, leaseIds: [leaseId],
          } },
        }).where(eq(heartbeatRuns.id, context.runId));
        await db.insert(nativeRunFinalizations).values({ companyId, issueId,
          runId: context.runId, phase: "terminal_failure" });
        await db.insert(environmentLeases).values({ id: leaseId, companyId, issueId,
          heartbeatRunId: context.runId, provider: "daytona", providerLeaseId: randomUUID(),
          status: "pending_cleanup", cleanupStatus: "failed", leasePolicy: "retain_on_failure",
          metadata: { remoteCwd: "/home/daytona/paperclip-workspace", pendingCleanupInFlight: false },
        });
        const priorRecovery = { ...createSystemRecovery(context.runId),
          state: gate === "automatic_scheduled" ? "scheduled" as const
            : gate === "automatic_running" ? "running" as const
              : gate === "automatic_awaiting_evidence" ? "awaiting_evidence" as const : "exhausted" as const,
          attempts: 2, retriesUsed: 1, attemptId: randomUUID(),
          firstFailureAt: Date.now() - 1000, deadlineAt: Date.now() + 60_000,
          preservationOperationIds: [randomUUID()],
        };
        const canResume = gate === "unregistered" || gate === "pending" || gate === "historical_sibling" || gate.startsWith("automatic_");
        await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId,
          kind: "active_run_watchdog", status: "resolved", ownerType: "system",
          cause: "native_continuation_requires_reconciliation", fingerprint: randomUUID(),
          nextAction: "Verify and preserve the exact retained source before continuing.",
          evidence: { runId: context.runId, automaticRecovery: { replay: "blocked" },
            workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [leaseId] },
            historicalWorkspaceSource: { schema: "paperclip.historical-workspace-source.v1", runId: context.runId, leaseIds: [leaseId] },
            systemRecovery: priorRecovery,
          },
        });
        if (gate === "unregistered") {
          const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
          const [environment] = await db.insert(environments).values({ name: context.runId, driver: "sandbox" }).returning();
          await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
          await db.update(heartbeatRuns).set({ resultJson: null, errorCode: "execution_finalization_deadline_exceeded",
            runnerProfileJson: { nativeWorkspaceSync: { schema: "paperclip.native-workspace-sync/v3", state: "prepared",
              descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), finalHostSha256: null,
              workspaceId: issueId, leaseId, providerLeaseId: lease.providerLeaseId,
              remoteCwd: lease.metadata!.remoteCwd, resourceDisposition: "keep_running" } },
          }).where(eq(heartbeatRuns.id, context.runId));
          await db.update(environmentLeases).set({ environmentId: environment.id, status: "active", cleanupStatus: null, leasePolicy: "reuse_by_environment" })
            .where(eq(environmentLeases.id, leaseId));
        }
        const receipt = await requestTaskRetry({ db, companyId, issueId, actorId: "owner-user",
          actorSource: "cloud_tenant", observedRunId: context.runId, idempotencyKey: randomUUID(),
          prepareChatRetry: context.service.prepareFailedChatRunRetry });
        const [recoveryAction] = await db.select().from(issueRecoveryActions).where(and(
          eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issueId),
          sql`${issueRecoveryActions.evidence}->>'runId' = ${context.runId}`,
        ));
        if (gate === "historical_sibling") await db.insert(issueRecoveryActions).values({
          companyId, sourceIssueId: issueId, kind: "active_run_watchdog", status: "resolved", ownerType: "system",
          cause: "native_session_retry_exhausted", fingerprint: randomUUID(),
          nextAction: "Preserve the historical execution outcome.",
          evidence: { runId: context.runId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } },
        });
        if (gate.startsWith("automatic_")) expect(recoveryAction.evidence.systemRecovery).toMatchObject({
          generationId: priorRecovery.generationId, intentId: receipt.requestId,
          attempts: priorRecovery.attempts, retriesUsed: priorRecovery.retriesUsed,
          attemptId: priorRecovery.attemptId, deadlineAt: priorRecovery.deadlineAt,
          preservationOperationIds: priorRecovery.preservationOperationIds,
        });
        if (gate === "exhausted" || gate === "wrong_generation") await db.update(issueRecoveryActions).set({
          evidence: { ...recoveryAction.evidence, systemRecovery: {
            ...recoveryAction.evidence.systemRecovery as Record<string, unknown>,
            ...(gate === "exhausted" ? { state: "exhausted" } : { intentId: randomUUID() }),
          } },
        }).where(eq(issueRecoveryActions.id, recoveryAction.id));
        if (gate === "paused_endpoint") await db.update(chatEndpoints).set({ status: "paused" })
          .where(eq(chatEndpoints.id, context.endpoint.id));
        // Keep capacity occupied so a regression cannot start a real adapter.
        await db.update(agents).set({ adapterType: "paperclip_runner", status: "running",
          runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } })
          .where(eq(agents.id, context.fixture.assignedAgentId));
        await db.insert(heartbeatRuns).values({ companyId,
          agentId: context.fixture.assignedAgentId, status: "running", startedAt: new Date() });
        context.wakeup.mockImplementation(heartbeatService(db).wakeup);
        const outcome = await context.service.processFailedChatRunRetry(receipt.chatActionId!);
        if (["exhausted", "wrong_generation", "paused_endpoint"].includes(gate)) {
          expect(outcome).toMatchObject({ status: "failed" });
          expect(await readAgentWakeupRequestsById(receipt.chatActionId!)).toHaveLength(0);
          expect((await readHeartbeatRunsByCompanyId(companyId))
            .filter(run => run.contextSnapshot?.taskRetryRequestId === receipt.requestId)).toHaveLength(0);
          return;
        }
        expect(outcome).toMatchObject({ status: "deferred" });
        const [wake] = await readAgentWakeupRequestsById(receipt.chatActionId!);
        expect(wake).toMatchObject({ status: "deferred_issue_execution", runId: null,
          payload: { taskRetryRequestId: receipt.requestId, retryOfRunId: context.runId } });
        const [intent] = await readAgentWakeupRequestsById(receipt.requestId!);
        expect(intent).toMatchObject({ status: "deferred_issue_execution", runId: null });
        expect((await readHeartbeatRunsByCompanyId(companyId))
          .filter(run => run.contextSnapshot?.taskRetryRequestId === receipt.requestId)).toHaveLength(0);
        expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId)))[0])
          .toMatchObject({ status: "pending_cleanup", cleanupStatus: "failed", metadata: { pendingCleanupInFlight: false } });
        const retryContext = context.wakeup.mock.calls.at(-1)![1].contextSnapshot!;
        for (const phase of ["promotion", "execution"] as const) {
          await expect(authorizeFailedChatRunRetryWake(db, db, { phase,
            wakeupRequestId: receipt.chatActionId!, companyId, issueId,
            agentId: context.fixture.assignedAgentId, contextSnapshot: retryContext,
          })).rejects.toMatchObject({ details: { code: "chat_failed_run_retry_not_authorized" } });
        }
        const heartbeat = heartbeatService(db);
        await heartbeat.resumeQueuedRuns();
        await context.service.processFailedChatRunRetries();
        expect((await readAgentWakeupRequestsById(receipt.chatActionId!))[0])
          .toMatchObject({ status: "deferred_issue_execution", runId: null });
        // Model the recovery worker's validated absence receipt; this test
        // exercises queue continuation, not the provider's absence signature.
        const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
        await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success", releasedAt: new Date(),
          failureReason: "workspace_source_unavailable", metadata: { ...lease.metadata,
            remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "destroyed" }),
          } }).where(eq(environmentLeases.id, leaseId));
        await db.update(issueRecoveryActions).set({ evidence: { ...recoveryAction.evidence,
          systemRecovery: { ...recoveryAction.evidence.systemRecovery as Record<string, unknown>, state: "exhausted",
            failure: { code: "source_unavailable", retryClass: "service_required", evidenceFingerprint: "missing-source" } },
        } }).where(eq(issueRecoveryActions.id, recoveryAction.id));
        if (gate === "foreign_source_hold") {
          const foreignRunId = randomUUID();
          await db.insert(heartbeatRuns).values({ id: foreignRunId, companyId, issueId, nativeIssueId: issueId,
            agentId: context.fixture.assignedAgentId, runtimeMode: "native", nativePhase: "terminal_failure",
            status: "failed", createdAt: new Date(Date.now() - 120_000), finishedAt: new Date(Date.now() - 60_000),
            resultJson: { workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: {
              schema: "paperclip.workspace-restore-recovery.v1", runId: foreignRunId, leaseIds: [] } },
          });
          await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId,
            kind: "active_run_watchdog", status: "resolved", ownerType: "system",
            cause: "native_session_retry_exhausted", fingerprint: randomUUID(), nextAction: "An independent source still needs recovery.",
            evidence: { runId: foreignRunId, automaticRecovery: { replay: "blocked" } },
          });
        }
        if (gate === "paused_after_wait") await db.update(chatEndpoints).set({ status: "paused" })
          .where(eq(chatEndpoints.id, context.endpoint.id));
        if (gate === "paused_agent_after_wait") await db.update(agents).set({ status: "paused" })
          .where(eq(agents.id, context.fixture.assignedAgentId));
        if (gate === "edited_after_wait") await db.update(issueComments).set({ body: "Changed after waiting", updatedAt: new Date() })
          .where(eq(issueComments.id, String(context.action.payload.commentId)));
        if (gate === "superseded_after_wait") {
          const replacement = await requestTaskRetry({ db, companyId, issueId, actorId: "owner-user",
            actorSource: "cloud_tenant", observedRunId: context.runId, idempotencyKey: randomUUID(),
            prepareChatRetry: context.service.prepareFailedChatRunRetry });
          expect(replacement.requestId).not.toBe(receipt.requestId);
          // Reconsider only the old action, including a delayed worker after
          // supersession. The replacement remains owned by its own request.
          await context.service.processFailedChatRunRetry(receipt.chatActionId!);
        } else {
          await heartbeat.resumeQueuedRuns();
          await context.service.processFailedChatRunRetries();
        }
        if (!canResume) {
          if (gate === "foreign_source_hold") {
            expect((await readAgentWakeupRequestsById(receipt.chatActionId!))[0]).toMatchObject({
              status: "deferred_issue_execution", payload: { executionWait: { reason: "workspace_repair_required" } },
            });
          } else if (gate !== "superseded_after_wait") {
            await heartbeat.resumeQueuedRuns();
            expect((await db.select().from(chatActions).where(eq(chatActions.id, receipt.chatActionId!)))[0])
              .toMatchObject({ status: "failed" });
            expect((await readAgentWakeupRequestsById(receipt.requestId!))[0]).toMatchObject({ status: "failed" });
          }
          expect((await readAgentWakeupRequestsById(receipt.chatActionId!))[0]).toMatchObject({ runId: null });
          expect((await readHeartbeatRunsByCompanyId(companyId))
            .filter(run => run.contextSnapshot?.taskRetryRequestId === receipt.requestId)).toHaveLength(0);
          return;
        }
        const [admitted] = await readAgentWakeupRequestsById(receipt.chatActionId!);
        expect(admitted).toMatchObject({ status: "queued" });
        expect(admitted.runId).toBeTruthy();
        const [successor] = await readHeartbeatRunsById(admitted.runId!);
        expect(successor).toMatchObject({ status: "queued", retryOfRunId: context.runId,
          contextSnapshot: { wakeCommentIds: [context.action.payload.commentId], taskRetryRequestId: receipt.requestId } });
        expect(await readFreshWorkspaceReadiness(db, successor)).toMatchObject({
          mode: "fresh_isolated_workspace", retryIntentId: receipt.requestId, sourceRunId: context.runId,
          retainedSourceIds: [leaseId],
        });
        await heartbeat.resumeQueuedRuns();
        await context.service.processFailedChatRunRetries();
        expect((await readHeartbeatRunsByCompanyId(companyId))
          .filter(run => run.contextSnapshot?.taskRetryRequestId === receipt.requestId)).toHaveLength(1);

      } finally {
        await context.service.shutdown();
        // Remove this case's unadmitted synthetic Retry receipts. Global
        // notice scans must not consume another case's injected read failure.
        await db.delete(agentWakeupRequests).where(and(
          eq(agentWakeupRequests.companyId, context.fixture.companyId),
          inArray(agentWakeupRequests.reason, ["task_retry", "retry_failed_run"]),
          isNull(agentWakeupRequests.runId),
        ));
      }
    },
  );

  it.each(["stopped", "real_queue", "unknown_executor", "source_edited", "cancelled_stopped", "cancelled_unknown"] as const)(
    "admits ordinary chat task Retry with a missing checkpoint only after containment: %s", async kind => {
      const context = await failedChatRetryFixture("telegram", undefined, kind === "real_queue");
      try {
        await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: context.issue.id,
          nativePhase: "terminal_failure", errorCode: "runner_remote_process_identity_unavailable",
          runnerProfileJson: {},
          ...(kind.startsWith("cancelled_") ? { status: "cancelled" } : {}),
        }).where(eq(heartbeatRuns.id, context.runId));
        await db.insert(nativeRunFinalizations).values({ companyId: context.fixture.companyId,
          issueId: context.issue.id, runId: context.runId, phase: "terminal_failure" });
        const exact = { companyId: context.fixture.companyId, issueId: context.issue.id,
          agentId: context.fixture.assignedAgentId, failedRunId: context.runId, initiatedByUserId: "owner-user" };
        await expect(db.transaction(tx => context.service.prepareFailedChatRunRetry(tx, exact)))
          .rejects.toMatchObject({ details: { code: "chat_failed_run_retry_not_authorized" } });
        if (kind !== "unknown_executor" && kind !== "cancelled_unknown") await db.insert(heartbeatRunEvents).values({
          companyId: context.fixture.companyId, agentId: context.fixture.assignedAgentId, runId: context.runId,
          seq: 1, eventType: "native.local_process_stopped", payload: { processPid: 999999999, processGroupId: null },
        });
        const request = { db, companyId: context.fixture.companyId, issueId: context.issue.id,
          actorId: "owner-user", actorSource: "cloud_tenant", observedRunId: context.runId, idempotencyKey: randomUUID(),
          prepareChatRetry: context.service.prepareFailedChatRunRetry };
        const receipt = await requestTaskRetry(request);
        expect(receipt.chatActionId).toBeTruthy();
        expect((await requestTaskRetry(request)).requestId).toBe(receipt.requestId);
        if (kind === "source_edited") await db.update(issueComments).set({ body: "Changed source", updatedAt: new Date() })
          .where(eq(issueComments.id, String(context.action.payload.commentId)));
        if (kind === "real_queue") {
          // Exercise the real dispatch transaction while another live run
          // occupies capacity. This test makes no provider-execution claim.
          await db.update(agents).set({ adapterType: "paperclip_runner", status: "running",
            runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } })
            .where(eq(agents.id, context.fixture.assignedAgentId));
          await db.insert(heartbeatRuns).values({ companyId: context.fixture.companyId,
            agentId: context.fixture.assignedAgentId, status: "running", startedAt: new Date() });
          context.wakeup.mockImplementation(heartbeatService(db).wakeup);
        }
        const outcome = await context.service.processFailedChatRunRetry(receipt.chatActionId!);
        if (kind === "stopped" || kind === "real_queue" || kind === "cancelled_stopped") {
          expect(outcome).toMatchObject({ status: "queued" });
          const [wake] = await readAgentWakeupRequestsById(receipt.chatActionId!);
          expect(wake, JSON.stringify({
            action: (await db.select().from(chatActions).where(eq(chatActions.id, receipt.chatActionId!)))[0],
            wakeResult: await context.wakeup.mock.results.at(-1)?.value,
          })).toBeDefined();
          expect(wake).toMatchObject({ requestedByActorType: context.receipt.requestedByActorType,
            requestedByActorId: context.receipt.requestedByActorId,
            payload: { wakeCommentIds: [context.action.payload.commentId], retryOfRunId: context.runId } });
          if (kind === "real_queue") {
            const [intent] = await readAgentWakeupRequestsById(receipt.requestId!);
            expect(intent).toMatchObject({ status: "coalesced", runId: wake.runId });
            expect(wake.runId).toBeTruthy();
            const [successor] = await readHeartbeatRunsById(wake.runId!);
            expect(successor).toMatchObject({ status: "queued", contextSnapshot: {
              taskRetryRequestId: receipt.requestId, forceFreshSession: true,
              chatFailedRunRetry: { actionId: receipt.chatActionId },
            } });
            await context.service.processFailedChatRunRetry(receipt.chatActionId!);
            expect((await readHeartbeatRunsByCompanyId(context.fixture.companyId))
              .filter(run => run.contextSnapshot?.taskRetryRequestId === receipt.requestId)).toHaveLength(1);
          }
        } else {
          expect(outcome).toMatchObject({ status: "failed" });
          expect(await readAgentWakeupRequestsById(receipt.chatActionId!)).toHaveLength(0);
        }
      } finally { await context.service.shutdown(); }
    },
  );
});
