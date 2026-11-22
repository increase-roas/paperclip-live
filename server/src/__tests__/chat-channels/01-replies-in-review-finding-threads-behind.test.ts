import { chatHistoryActionBlocks } from ".././helpers/chat-history-proof.js";
import { notifyChatRunMilestones } from "../../services/chat-run-milestone-notifications.js";
import { idleWorkSnapshot } from "../../services/task-admission.js";
import { createSystemRecovery } from "../../services/system-recovery-state.js";
import { remoteTerminationReceipt } from "../../services/remote-execution-termination.js";
import type { Db } from "@paperclipai/db";
import { createFullDatabaseResponseCapture, installDatabaseResponseCapture } from ".././helpers/full-database-response-capture.js";
import { githubResponseAuthorityFields } from "../../services/chat-channels/github/response-authority-read.js";
import { createDeliveryWorkCoordinator } from "../../services/delivery-work-coordinator.js";
import { agentWakeupRequests, agents, chatActions, chatConversations, chatDeliveries, chatEndpointLeases, chatEndpointResources, chatEndpoints, chatExternalPrincipals, chatGitHubConfigurations, chatIdentityLinks, chatMessageLinks, chatPublications, chatTeamsFileTransfers, companies, companyMemberships, companySkills, environmentLeases, heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations, toolActionRequests, toolInvocations, toolPolicies } from "@paperclipai/db";
import { GITHUB_INLINE_RETRY_WINDOW_MS } from "../../services/chat-channels/github/retry.js";
import { githubChatReviewService } from "../../services/chat-github-reviews.js";
import { githubResponseCommentService } from "../../services/chat-github-response-comments.js";
import { githubBotToolsForSession } from "../../services/chat-github-tools.js";
import { buildPaperclipRuntimeMcpServers, resolveRunScopedMentionedSkillKeys } from "../../services/heartbeat/run-preparation.js";
import { createAssignedMcpTools } from "../../services/native-runtime/assigned-mcp-tools.js";
import { createToolGatewayService } from "../../services/tool-gateway.js";
import { initializeRunIdentity } from "../../services/run-identity.js";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { Thread } from "chat";
import { issueService } from "../../services/issues.js";
import { githubRunReplyState } from "../../services/chat-run-publications.js";
import { extractWakeCommentIds, heartbeatService } from "../../services/heartbeat.js";
import { registerServerAdapter, runningProcesses, unregisterServerAdapter } from "../../adapters/index.js";
import { FakeChatSdkRuntime, makeMessage, makeThread } from ".././helpers/chat-channels-fixture.js";
import {
chatWakeContext, companyPrefixAttempts, configuredSlackEndpoint, createService, db, deliverMessage, describeChatChannelsSuite, freshCompanyPrefix, readChatActionsById, readChatConversationsByEndpointId, readChatConversationsById, readChatDeliveriesByEndpointId, readChatDeliveriesById, readChatGitHubReviewsByEndpointId, readChatPublicationsByCommentId, readHeartbeatRunsByCompanyId, readIssueCommentsByIssueId, readToolConnectionsById, retireFixtureState, retirePublicationFixture, seedCompany, signedGitHubWebhookRequest
} from "../helpers/chat-channels-harness.js";
import {
addPeerGitHubBot, publicationRetryFixture, reviewBotFixture, subscribedGitHubFixture, toolReplyFixture
} from "../helpers/chat-channels-provider-fixtures.js";
import {
teamsFileAuthorityFixture
} from "../helpers/chat-channels-endpoint-fixtures.js";













describeChatChannelsSuite("chat channels 01-replies-in-review-finding-threads-behind", () => {
  it("tracks the actual Board Teams claim and retires recovery when its receipt commits", async () => {
    const context = await teamsFileAuthorityFixture();
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    let release!: () => void, entered!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
    context.controls.beforeConsentReceipt = async () => { entered(); await hold; };
    let send: ReturnType<typeof context.service.publishBoardMessage> | undefined;
    try {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      await context.service.registerTeamsAttemptRecoveryWork(coordinator, () => true).ready;
      expect(coordinator.nextWakeAt()).toBeNull();
      const attachment = await context.createFile();
      send = context.service.publishBoardMessage(context.endpoint.id, context.conversation.id,
        "File with an active claim", `teams-attempt-${randomUUID()}`, "owner-user", [attachment.id]);
      await ready;
      const [claim] = await db.select().from(chatTeamsFileTransfers).where(eq(chatTeamsFileTransfers.endpointId, context.endpoint.id));
      expect(claim.phase).toBe("consent_sending"); expect(context.consentCards).toHaveLength(1);
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(1000); expect(coordinator.nextWakeAt()).toBe(claim.attemptExpiresAt!.getTime());
      }, { timeout: 5000 });
      release(); await send;
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(1000); expect(idleWorkSnapshot().active).toBe(0); expect(coordinator.nextWakeAt()).toBeNull();
      }, { timeout: 5000 });
      const [settled] = await db.select().from(chatTeamsFileTransfers).where(eq(chatTeamsFileTransfers.id, claim.id));
      expect(settled.phase).toBe("awaiting_consent"); expect(settled.attemptId).toBeNull();
      const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction");
      try { await vi.advanceTimersByTimeAsync(120_000); expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); }
      finally { reads.mockRestore(); writes.mockRestore(); }
      expect(context.consentCards).toHaveLength(1); expect(context.fileCards).toEqual([]);
      expect(context.uploadRequest).not.toHaveBeenCalled(); expect(errors).toEqual([]);
    } finally {
      release(); await send;
      await coordinator.stop(); vi.useRealTimers();
      await retirePublicationFixture(context.service, context.endpoint.id);
      // This test intentionally leaves unused consent; do not feed the next global expiry fixture.
      await db.delete(chatTeamsFileTransfers).where(eq(chatTeamsFileTransfers.endpointId, context.endpoint.id));
    }
  });

  it("expires Teams consent from the committed Board transfer without periodic maintenance", async () => {
    const context = await teamsFileAuthorityFixture();
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const settle = () => vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000); expect(idleWorkSnapshot().active).toBe(0);
    }, { timeout: 5000 });
    try {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      // Register before the ordinary Board producer, with no transfer rows yet.
      await context.service.registerTeamsConsentExpiryWork(coordinator, () => true).ready;
      expect(coordinator.nextWakeAt()).toBeNull();
      const attachment = await context.createFile();
      const publication = await context.service.publishBoardMessage(context.endpoint.id, context.conversation.id,
        "A file awaiting consent", `teams-expiry-${randomUUID()}`, "owner-user", [attachment.id]);
      const [transfer] = await db.select().from(chatTeamsFileTransfers).where(eq(chatTeamsFileTransfers.publicationId, publication.id));
      expect(transfer.phase).toBe("awaiting_consent"); expect(context.consentCards).toHaveLength(1);
      await settle(); expect(coordinator.nextWakeAt()).toBe(transfer.expiresAt.getTime());
      const reads = vi.spyOn(db, "select");
      try { await vi.advanceTimersByTimeAsync(10_000); expect(reads).not.toHaveBeenCalled(); }
      finally { reads.mockRestore(); }
      await vi.advanceTimersByTimeAsync(transfer.expiresAt.getTime() - Date.now() + 1000); await settle();
      const [expired] = await db.select().from(chatTeamsFileTransfers).where(eq(chatTeamsFileTransfers.id, transfer.id));
      const [projected] = await db.select().from(chatPublications).where(eq(chatPublications.id, publication.id));
      expect(expired.phase).toBe("expired"); expect(projected.state).toBe("cancelled");
      expect(coordinator.nextWakeAt()).toBeNull();
      expect(context.consentCards).toHaveLength(1); expect(context.fileCards).toEqual([]);
      expect(context.uploadRequest).not.toHaveBeenCalled(); expect(errors).toEqual([]);
    } finally {
      await coordinator.stop(); vi.useRealTimers();
      await retirePublicationFixture(context.service, context.endpoint.id);
    }
  });

  it("retries a colliding company fixture prefix and creates a distinct complete fixture", async () => {
    const existing = await seedCompany();
    const [original] = await db.select().from(companies).where(eq(companies.id, existing.companyId));
    const candidates: string[] = [];
    const nextPrefix = vi.fn(() => {
      const prefix = candidates.length === 0 ? original!.issuePrefix : freshCompanyPrefix();
      candidates.push(prefix);
      return prefix;
    });
    const fixture = await seedCompany(nextPrefix);
    const [allocated] = await db.select().from(companies).where(eq(companies.id, fixture.companyId));
    expect(nextPrefix.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(allocated!.issuePrefix).toBe(candidates.at(-1));
    expect(allocated!.issuePrefix).toMatch(/^C[A-F0-9]{7}$/);
    expect(allocated!.issuePrefix).not.toBe(original!.issuePrefix);
    expect(fixture.companyId).not.toBe(existing.companyId);
    expect(await db.select().from(companies).where(eq(companies.id, existing.companyId))).toEqual([original]);
    expect((await db.select().from(agents).where(eq(agents.companyId, fixture.companyId))).map(agent => agent.id).sort())
      .toEqual([fixture.assignedAgentId, fixture.replacementAgentId].sort());
    expect(await db.select().from(companyMemberships).where(eq(companyMemberships.companyId, fixture.companyId)))
      .toEqual([expect.objectContaining({ principalId: "owner-user", membershipRole: "operator" })]);
  });

  it("bounds company fixture prefix collision retries without creating a partial fixture", async () => {
    const fixture = await seedCompany();
    const [company] = await db.select().from(companies).where(eq(companies.id, fixture.companyId));
    const before = await db.select({ id: companies.id }).from(companies);
    const nextPrefix = vi.fn(() => company!.issuePrefix);
    await expect(seedCompany(nextPrefix)).rejects.toThrow(`after ${companyPrefixAttempts} attempts`);
    expect(nextPrefix).toHaveBeenCalledTimes(companyPrefixAttempts);
    expect((await db.select({ id: companies.id }).from(companies)).map(row => row.id).sort())
      .toEqual(before.map(row => row.id).sort());
  });

  it("does not retry unrelated company fixture database errors", async () => {
    const nextPrefix = vi.fn(() => "C\0INVALID");
    await expect(seedCompany(nextPrefix)).rejects.toMatchObject({ cause: { code: "22021" } });
    expect(nextPrefix).toHaveBeenCalledOnce();
  });

  it("retires a stale verifying receipt before another fixture runs recovery", async () => {
    const fixture = await seedCompany();
    const context = await configuredSlackEndpoint(fixture);
    const thread = makeThread({ channelId: "C-FIXTURE-RETIREMENT", id: "slack:C-FIXTURE-RETIREMENT:7001.1" });
    await deliverMessage({
      callbacks: context.callbacks,
      endpointId: context.endpoint.id,
      thread: thread.thread,
      message: makeMessage({ id: "7001.1", text: "@maya check fixture recovery", mentioned: true }),
      trigger: "mention",
    });
    await context.service.shutdown();
    const [receipt] = await db.select().from(chatActions).where(and(
      eq(chatActions.endpointId, context.endpoint.id),
      eq(chatActions.kind, "receipt_reaction"),
    ));
    expect(receipt).toBeDefined();
    await db.update(chatActions).set({ status: "processing", updatedAt: new Date(Date.now() - 61_000) })
      .where(eq(chatActions.id, receipt!.id));
    await db.insert(chatEndpointLeases).values({
      companyId: fixture.companyId,
      endpointId: context.endpoint.id,
      leaseKey: "credentials",
      token: "retired-fixture-owner",
      expiresAt: new Date(Date.now() + 90_000),
    });

    const other = await seedCompany();
    const next = createService();
    const otherEndpoint = await next.service.create(other.companyId, {
      provider: "slack", assignedAgentId: other.assignedAgentId,
    }, "owner-user");
    const [otherLease] = await db.insert(chatEndpointLeases).values({
      companyId: other.companyId,
      endpointId: otherEndpoint.id,
      leaseKey: "credentials",
      token: "other-fixture-owner",
      expiresAt: new Date(Date.now() + 90_000),
    }).returning();
    let recovery: Promise<number> | undefined;
    try {
      await retireFixtureState([fixture.companyId]);
      recovery = next.service.processPendingDeliveries();
      await expect.poll(async () => db.select({ status: chatActions.status }).from(chatActions)
        .where(eq(chatActions.id, receipt!.id)), { timeout: 5_000 })
        .toEqual([{ status: "cancelled" }]);
      await recovery;
      expect(next.runtime.endpoints.size).toBe(0);
      expect(await db.select().from(chatEndpointLeases).where(eq(chatEndpointLeases.id, otherLease!.id)))
        .toEqual([otherLease]);
    } finally {
      // Release synthetic owners even when a regression blocks recovery.
      await db.delete(chatEndpointLeases).where(inArray(chatEndpointLeases.companyId, [fixture.companyId, other.companyId]));
      await recovery;
      await next.service.shutdown();
    }
  });

    it.each(["snapshot_callback", "snapshot_restart", "snapshot_race", "snapshot_unknown_stop", "snapshot_wrong_allocation", "snapshot_revoked_principal", "snapshot_changed_generation", "snapshot_changed_source", "callback", "restart", "race", "unknown_stop", "wrong_allocation", "paused_endpoint", "revoked_principal", "deleted_comment", "changed_generation", "foreign_scope", "changed_source", "revoked_before_valid"])(
      "reconsiders the same GitHub reply after stopped native workspace cleanup (%s)", async scenario => {
        const snapshotScenario = scenario.startsWith("snapshot_");
        const safetyScenario = snapshotScenario ? scenario.slice("snapshot_".length) : scenario;
        const f = await subscribedGitHubFixture("github:paperclipai/paperclip:419");
        const issueId = f.conversation.issueId!;
        const heartbeat = heartbeatService(db);
        const sourceRunId = randomUUID(), leaseId = randomUUID(), providerLeaseId = randomUUID();
        const capacityRunId = randomUUID(), stoppedAt = new Date(Date.now() - 10_000);
        const initial = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.assignedAgentId)))[0];
        await db.update(agentWakeupRequests).set({ status: "completed", runId: sourceRunId, finishedAt: stoppedAt })
          .where(eq(agentWakeupRequests.id, initial.id));
        await db.update(companies).set({ defaultResponsibleUserId: "owner-user" }).where(eq(companies.id, f.companyId));
        await db.update(agents).set({ adapterType: "paperclip_runner", status: "running",
          runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } }).where(eq(agents.id, f.assignedAgentId));
        await db.insert(heartbeatRuns).values({ id: capacityRunId, companyId: f.companyId, agentId: f.assignedAgentId,
          status: "running", contextSnapshot: { issueId: randomUUID() } });
        runningProcesses.set(capacityRunId, { child: {} as never, graceSec: 0, processGroupId: null });
        onTestFinished(() => { runningProcesses.delete(capacityRunId); });
        await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId: f.companyId, agentId: f.assignedAgentId,
          status: "cancelled", startedAt: new Date(stoppedAt.getTime() - 1000), finishedAt: stoppedAt,
          runtimeMode: "native", nativeIssueId: issueId, nativePhase: "observed",
          contextSnapshot: { issueId, source: "chat:github", wakeCommentIds: [initial.payload?.commentId] },
          resultJson: { workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: { leaseIds: [leaseId] } },
        });
        await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId,
          runId: sourceRunId, phase: "terminal_failure" });
        await db.insert(environmentLeases).values({ id: leaseId, companyId: f.companyId, issueId,
          heartbeatRunId: sourceRunId, provider: "daytona", providerLeaseId,
          status: "pending_cleanup", cleanupStatus: "failed", leasePolicy: "ephemeral" });
        await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: issueId,
          kind: "active_run_watchdog", status: "resolved", ownerType: "system", outcome: "blocked",
          cause: "native_continuation_requires_reconciliation", fingerprint: randomUUID(), nextAction: "Retained workspace repair",
          evidence: { runId: sourceRunId, automaticRecovery: { replay: "blocked" },
            workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: { leaseIds: [leaseId] },
            workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId: sourceRunId,
              status: "recovered", stage: "saving_receipts", attempt: 1, attemptLimit: 6, retryable: true, requestIds: [] },
            systemRecovery: { ...createSystemRecovery(sourceRunId), state: "complete", phase: "reconcile_effects" },
          },
        });
        if (snapshotScenario) {
          const { workspaceOperations } = await import("@paperclipai/db");
          await db.update(heartbeatRuns).set({ status: "failed", errorCode: "execution_finalization_deadline_exceeded",
            runnerProfileJson: { nativeWorkspaceSync: { schema: "paperclip.native-workspace-sync/v3", state: "prepared",
              descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), finalHostSha256: null,
              workspaceId: randomUUID(), leaseId, providerLeaseId, remoteCwd: "/workspace", resourceDisposition: "destroy" } },
          }).where(eq(heartbeatRuns.id, sourceRunId));
          const [recovery] = await db.select().from(issueRecoveryActions).where(and(
            eq(issueRecoveryActions.companyId, f.companyId), eq(issueRecoveryActions.sourceIssueId, issueId),
            eq(issueRecoveryActions.cause, "native_continuation_requires_reconciliation"),
          ));
          const prefix = `${f.companyId}/workspace-recovery/${sourceRunId}/${leaseId}/`;
          const [snapshot] = await db.insert(workspaceOperations).values({ companyId: f.companyId, issueId, heartbeatRunId: sourceRunId,
            phase: "workspace_recovery_snapshot", status: "succeeded", finishedAt: new Date(), metadata: {
              schema: "paperclip.workspace-recovery-snapshot.v1", recoveryActionId: recovery.id, leaseId, providerLeaseId,
              archive: { objectKey: `${prefix}${"c".repeat(64)}.tar`, sha256: "c".repeat(64), byteSize: 1024 },
              manifest: { objectKey: `${prefix}${"d".repeat(64)}.jsonl`, sha256: "d".repeat(64), byteSize: 512 },
            } }).returning();
          await db.update(issueRecoveryActions).set({ evidence: { ...recovery.evidence, systemRecovery: {
            ...recovery.evidence.systemRecovery as Record<string, unknown>, preservationOperationIds: [snapshot.id],
          } } }).where(eq(issueRecoveryActions.id, recovery.id));
          await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: issueId,
            kind: "active_run_watchdog", status: "resolved", ownerType: "system", outcome: "blocked",
            cause: "execution_finalization_deadline_exceeded", fingerprint: randomUUID(), nextAction: "Inspect prior failure",
            evidence: { runId: sourceRunId, automaticRecovery: { replay: "blocked" } },
          });
          const previousLease = { id: randomUUID(), companyId: f.companyId, issueId, heartbeatRunId: sourceRunId,
            provider: "daytona", providerLeaseId: randomUUID(), status: "expired", cleanupStatus: "success",
            releasedAt: new Date(), leasePolicy: "ephemeral" };
          await db.insert(environmentLeases).values({ ...previousLease, metadata: { remoteExecutionTermination:
            remoteTerminationReceipt(previousLease, { providerLeaseId: previousLease.providerLeaseId, state: "destroyed" }) } });
        }
        f.wakeup.mockImplementation(heartbeat.wakeup);
        await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread: f.thread,
          trigger: "subscribed_message", message: makeMessage({ id: "41903", text: "A genuinely new author reply after Stop",
            userId: "42", userName: "octocat" }) });
        const comment = (await readIssueCommentsByIssueId(issueId)).find(row => row.body.includes("genuinely new author reply"))!;
        const [receipt] = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.assignedAgentId)))
          .filter(row => row.id !== initial.id);
        expect(receipt).toMatchObject({ status: "deferred_issue_execution", runId: null,
          payload: { executionWait: { reason: "remote_cleanup" } } });
        if (snapshotScenario) await db.update(heartbeatRuns).set({
          resultJson: { workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: {
            schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [leaseId] } },
        }).where(eq(heartbeatRuns.id, sourceRunId));
        let nextReceipt: typeof receipt | undefined;
        let nextCommentId: string | undefined;
        if (safetyScenario === "revoked_before_valid") {
          const thread = makeThread({ channelId: "paperclipai/paperclip", id: "github:paperclipai/paperclip:419:rc:4332012267" }).thread;
          const { id: _id, ...conversation } = f.conversation;
          await db.insert(chatConversations).values({ ...conversation, externalThreadId: thread.id });
          await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
            trigger: "subscribed_message", message: makeMessage({ id: "41904", text: "A live source behind the deleted source",
              userId: "42", userName: "octocat" }) });
          nextCommentId = (await readIssueCommentsByIssueId(issueId)).find(row => row.body.includes("live source behind"))!.id;
          nextReceipt = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.assignedAgentId)))
            .find(row => row.id !== initial.id && row.id !== receipt.id);
          expect(nextReceipt).toMatchObject({ status: "deferred_issue_execution", runId: null });
          await db.update(issueComments).set({ deletedAt: new Date() }).where(eq(issueComments.id, comment.id));
        }
        const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
        if (safetyScenario !== "unknown_stop") await db.update(environmentLeases).set({ status: "expired", cleanupStatus: "success",
          releasedAt: new Date(), metadata: { remoteExecutionTermination: remoteTerminationReceipt(lease,
            { providerLeaseId: safetyScenario === "wrong_allocation" ? randomUUID() : providerLeaseId, state: "destroyed" }) } })
          .where(eq(environmentLeases.id, leaseId));
        if (safetyScenario === "paused_endpoint") await db.update(chatEndpoints).set({ status: "paused" }).where(eq(chatEndpoints.id, f.endpoint.id));
        if (safetyScenario === "revoked_principal") await db.update(chatIdentityLinks).set({ status: "revoked", revokedAt: new Date() })
          .where(eq(chatIdentityLinks.principalId, f.principal.id));
        if (safetyScenario === "deleted_comment") await db.update(issueComments).set({ deletedAt: new Date() }).where(eq(issueComments.id, comment.id));
        if (safetyScenario === "changed_generation") await db.update(chatConversations).set({ sessionGeneration: 2 }).where(eq(chatConversations.id, f.conversation.id));
        if (safetyScenario === "changed_source") {
          const [action] = await db.select().from(chatActions).where(eq(chatActions.id, receipt.id));
          await db.update(chatActions).set({ payload: { ...action.payload, commentId: initial.payload?.commentId } })
            .where(eq(chatActions.id, action.id));
        }
        if (safetyScenario === "restart") {
          await f.service.shutdown();
          // Fresh application owner and scheduler must recover from saved data,
          // with no in-memory request object left in the retired chat service.
          createService(new FakeChatSdkRuntime(), f.providerFetch, { wakeup: heartbeatService(db).wakeup });
        }
        const source = (await readHeartbeatRunsByCompanyId(f.companyId)).find(row => row.id === sourceRunId)!;
        const { resumeDeferredChatWake } = await import("../../services/durable-chat-wakeup.js");
        if (safetyScenario === "foreign_scope") await resumeDeferredChatWake(db, { companyId: randomUUID(), agentId: f.assignedAgentId,
          issueId, requestId: receipt.id });
        else if (safetyScenario === "callback" || safetyScenario === "revoked_before_valid") await heartbeat.resumeRemoteStopComments(source);
        else if (safetyScenario === "race") await Promise.all([heartbeat.resumeRemoteStopComments(source), heartbeat.resumeQueuedRuns()]);
        else await heartbeatService(db).resumeQueuedRuns();
        const [settled] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.id));
        const successors = (await readHeartbeatRunsByCompanyId(f.companyId)).filter(row => row.wakeupRequestId === receipt.id);
        const admitted = ["callback", "restart", "race"].includes(safetyScenario);
        expect(successors).toHaveLength(admitted ? 1 : 0);
        expect(settled).toMatchObject({ id: receipt.id, idempotencyKey: receipt.idempotencyKey,
          requestedByActorId: receipt.requestedByActorId, requestedAt: receipt.requestedAt,
          status: admitted ? "queued" : "deferred_issue_execution" });
        if (admitted) {
          expect(extractWakeCommentIds(successors[0].contextSnapshot)).toEqual([comment.id]);
          expect(successors[0].contextSnapshot?.chatConversationId).toBe(f.conversation.id);
          expect(successors[0].retryOfRunId).toBeNull();
          if (snapshotScenario) expect(successors[0].contextSnapshot?.explicitUserContinuation).toMatchObject({
            previousRunId: sourceRunId, commentId: comment.id,
            readiness: { mode: "fresh_isolated_workspace", retryIntentId: receipt.id, sourceRunId },
          });
          await heartbeat.resumeRemoteStopComments(source);
          await heartbeat.resumeQueuedRuns();
          expect((await readHeartbeatRunsByCompanyId(f.companyId)).filter(row => row.wakeupRequestId === receipt.id)).toHaveLength(1);
        }
        if (nextReceipt) {
          const admittedBehindRevoked = (await readHeartbeatRunsByCompanyId(f.companyId)).filter(row => row.wakeupRequestId === nextReceipt.id);
          expect(admittedBehindRevoked).toHaveLength(1);
          expect(extractWakeCommentIds(admittedBehindRevoked[0].contextSnapshot)).toEqual([nextCommentId]);
        }
        expect((await readHeartbeatRunsByCompanyId(f.companyId)).find(row => row.id === sourceRunId))
          .toMatchObject({ status: snapshotScenario ? "failed" : "cancelled", resultJson: { workspaceRestoreFailure: "restore_failed" } });
      }, 40_000,
    );

    it("loads only the current configured instruction skills, never provider links or another company", async () => {
      const f = await reviewBotFixture();
      const other = await seedCompany();
      const skill = async (name: string, companyId = f.companyId) => db.insert(companySkills).values({
        companyId, key: `company/${companyId}/${name}`, slug: name, name, markdown: `# ${name}`,
      }).returning().then((rows) => rows[0]);
      const common = await skill("common");
      const mention = await skill("mention");
      const next = await skill("next");
      const injected = await skill("injected");
      const foreign = await skill("foreign", other.companyId);
      // Use the production link format, including the slash picker identity.
      const { buildSkillMentionHref } = await import("@paperclipai/shared");
      const ref = (s: typeof common) => `[/skill](${buildSkillMentionHref(s.id, s.slug)})`;
      const saved = await f.management.configuration(f.endpoint.id, "owner-user");
      await f.management.saveConfiguration(f.endpoint.id, { expectedRevision: saved.revision, configuration: {
        ...saved.configuration, defaults: { ...saved.configuration.defaults,
          instructions: `Use ${ref(common)}.`,
          prompts: { ...saved.configuration.defaults.prompts, mention: `Use ${ref(mention)}.`, opened: ref(injected) },
        },
      } }, "owner-user");
      const thread = makeThread({ channelId: "paperclipai/paperclip", id: "github:paperclipai/paperclip:issue:419" }).thread;
      await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
        trigger: "mention", message: makeMessage({ id: "41901", text: `@${f.endpoint.botUsername} ${ref(injected)}`, userId: "42", userName: "octocat", mentioned: true }) });
      const [conversation] = await readChatConversationsByEndpointId(f.endpoint.id);
      const [comment] = await readIssueCommentsByIssueId(conversation.issueId!);
      const args = { db, companyId: f.companyId, issueId: conversation.issueId!, commentIds: [comment.id] };
      expect(await resolveRunScopedMentionedSkillKeys(args)).toEqual([common.key, mention.key]);
      expect(comment.body).toContain(ref(common));
      expect(comment.body).toContain(ref(mention));
      expect(comment.body).toContain(ref(injected)); // Present as untrusted context, never assigned.
      expect(await resolveRunScopedMentionedSkillKeys({ ...args, companyId: other.companyId })).toEqual([]);
      const changed = await f.management.configuration(f.endpoint.id, "owner-user");
      await f.management.saveConfiguration(f.endpoint.id, { expectedRevision: changed.revision, configuration: {
        ...changed.configuration, defaults: { ...changed.configuration.defaults, instructions: ref(next),
          prompts: { ...changed.configuration.defaults.prompts, comment: "Answer briefly." },
        },
      } }, "owner-user");
      await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
        trigger: "subscribed_message", message: makeMessage({ id: "41902", text: ref(injected), userId: "42", userName: "octocat" }) });
      const all = await readIssueCommentsByIssueId(conversation.issueId!).orderBy(asc(issueComments.createdAt));
      expect(all).toHaveLength(2);
      expect(await resolveRunScopedMentionedSkillKeys({ ...args, commentIds: [all[1].id] })).toEqual([next.key]);
      // A later event must not change the snapshot for a queued older wake.
      expect(await resolveRunScopedMentionedSkillKeys(args)).toEqual([common.key, mention.key]);
      expect(await resolveRunScopedMentionedSkillKeys({ ...args, commentIds: all.map((c) => c.id) })).toEqual(expect.arrayContaining([common.key, mention.key, next.key]));
      expect(await resolveRunScopedMentionedSkillKeys({ ...args, commentIds: [] })).toEqual([next.key]);
      const invalid = await f.management.configuration(f.endpoint.id, "owner-user");
      await f.management.saveConfiguration(f.endpoint.id, { expectedRevision: invalid.revision, configuration: {
        ...invalid.configuration, defaults: { ...invalid.configuration.defaults, instructions: ref(foreign) },
      } }, "owner-user");
      // Instructions are captured on admission; changing configuration must
      // not change the already admitted wake above.
      await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
        trigger: "subscribed_message", message: makeMessage({ id: "41903", text: 'Check again', userId: "42", userName: "octocat" }) });
      await expect(resolveRunScopedMentionedSkillKeys({ ...args, commentIds: [] })).rejects.toThrow("referenced skill is unavailable");
    });

    it.each([
      "github:paperclipai/paperclip:issue:419",
      "github:paperclipai/paperclip:419",
      "github:paperclipai/paperclip:419:rc:41899",
    ])("suppresses subscribed GitHub comments for another connected bot in %s", async threadId => {
      const f = await subscribedGitHubFixture(threadId);
      await addPeerGitHubBot(f);
      const wakeCount = f.wakeup.mock.calls.length;
      const message = makeMessage({ id: "41902", text: "@GONZO[bot] tell me a joke", userId: "42", userName: "octocat" });
      const send = () => deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread: f.thread, trigger: "subscribed_message", message });
      await send(); await send();
      const rows = await db.select().from(chatDeliveries).where(and(eq(chatDeliveries.endpointId, f.endpoint.id), eq(chatDeliveries.providerEventId, `${threadId}:41902`)));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ state: "filtered", principalId: null, redactedError: "GitHub message explicitly addresses a different recipient" });
      expect(rows[0].normalizedEvent).toHaveProperty("filtering.contentRetained", false);
      expect(JSON.stringify(rows[0].normalizedEvent)).not.toContain("tell me a joke");
      expect(await readIssueCommentsByIssueId(f.conversation.issueId!)).toHaveLength(1);
      expect(f.wakeup).toHaveBeenCalledTimes(wakeCount);
      expect(f.runtime.endpoints.get(f.endpoint.id)?.reactions).toEqual([]);
      expect(f.responseWrites).toHaveLength(1);
      expect(await f.service.listActivity(f.endpoint.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: "filtered", detail: "GitHub message explicitly addresses a different recipient" }),
      ]));
    });

    it.each(["Thanks, continue", "Thanks @octocat", "Please ask @unknown-bot for context", "Check @gonzo-other's advice", "x@gonzo help"])(
      "retains subscribed GitHub follow-ups with incidental human or unknown mentions: %s", async text => {
        const f = await subscribedGitHubFixture();
        await addPeerGitHubBot(f);
        const wakeCount = f.wakeup.mock.calls.length;
        await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread: f.thread,
          trigger: "subscribed_message", message: makeMessage({ id: "41902", text, userId: "42", userName: "octocat" }) });
        expect(await readIssueCommentsByIssueId(f.conversation.issueId!)).toHaveLength(2);
        expect(f.wakeup).toHaveBeenCalledTimes(wakeCount + 1);
      },
    );

    it("admits a GitHub request explicitly addressed to both connected bots", async () => {
      const f = await subscribedGitHubFixture();
      await addPeerGitHubBot(f);
      const wakeCount = f.wakeup.mock.calls.length;
      await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread: f.thread,
        trigger: "mention", message: makeMessage({ id: "41902", text: `@gonzo @${f.endpoint.botUsername} both help`, userId: "42", userName: "octocat", mentioned: true }) });
      expect(await readIssueCommentsByIssueId(f.conversation.issueId!)).toHaveLength(2);
      expect(f.wakeup).toHaveBeenCalledTimes(wakeCount + 1);
    });

    it.each(["other_company", "other_provider", "archived"])("does not route GitHub mentions using %s identities", async kind => {
      const f = await subscribedGitHubFixture();
      const owner = kind === "other_company" ? await seedCompany() : f;
      const peer = await f.service.create(owner.companyId, { provider: kind === "other_provider" ? "slack" : "github", assignedAgentId: owner.assignedAgentId, name: "Gonzo" }, "owner-user");
      await db.update(chatEndpoints).set({ botUsername: "gonzo[bot]", status: kind === "archived" ? "archived" : "active" }).where(eq(chatEndpoints.id, peer.id));
      const wakeCount = f.wakeup.mock.calls.length;
      await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread: f.thread,
        trigger: "subscribed_message", message: makeMessage({ id: "41902", text: "Please consider @gonzo's advice", userId: "42", userName: "octocat" }) });
      expect(await readIssueCommentsByIssueId(f.conversation.issueId!)).toHaveLength(2);
      expect(f.wakeup).toHaveBeenCalledTimes(wakeCount + 1);
    });

    it("rechecks another GitHub bot's mention when recovering a durable subscribed delivery", async () => {
      const f = await subscribedGitHubFixture();
      await addPeerGitHubBot(f);
      const [root] = await readChatDeliveriesByEndpointId(f.endpoint.id);
      const providerEventId = `${f.thread.id}:41902`;
      const [pending] = await db.insert(chatDeliveries).values({
        companyId: f.companyId, endpointId: f.endpoint.id, providerEventId, deduplicationKey: randomUUID(), eventKind: "message", state: "received",
        normalizedEvent: { ...root.normalizedEvent, providerEventId, kind: "message", trigger: "subscribed_message",
          message: { ...(root.normalizedEvent.message as Record<string, unknown>), providerMessageId: "41902", text: "@gonzo this was queued before restart", mentionedBot: false },
          githubManual: { ...(root.normalizedEvent.githubManual as Record<string, unknown>), event: "comment" } },
      }).returning();
      const wakeCount = f.wakeup.mock.calls.length;
      await f.service.processPendingDeliveries(1, pending.id);
      const [recovered] = await readChatDeliveriesById(pending.id);
      expect(recovered.state).toBe("filtered");
      expect(recovered.normalizedEvent).toHaveProperty("filtering.contentRetained", false);
      expect(f.wakeup).toHaveBeenCalledTimes(wakeCount);
      expect(await readIssueCommentsByIssueId(f.conversation.issueId!)).toHaveLength(1);
    });

    it("keeps GitHub response ownership checks independent of large run payloads", async () => {
      const f = await toolReplyFixture();
      const responses = githubResponseCommentService(db, f.providerFetch);
      const input = { ...f.session, issueId: f.conversation.issueId!, endpointId: f.endpoint.id };
      expect(await responses.hasWorkingResponseForRun(input)).toBe(true);
      const unused = "unused-run-payload".repeat(32_768);
      await db.update(heartbeatRuns).set({
        contextSnapshot: { ...f.run.contextSnapshot, prompt: unused, nativeExecutionInput: { prompt: unused } },
        runnerProfileJson: { unused }, resultJson: { unused }, stdoutExcerpt: unused,
      }).where(eq(heartbeatRuns.id, f.run.id));
      expect(await responses.hasWorkingResponseForRun(input)).toBe(true);
      await expect(responses.hasWorkingResponseForRun({ ...input, companyId: randomUUID() }))
        .rejects.toMatchObject({ status: 403 });
      await expect(responses.hasWorkingResponseForRun({ ...input, issueId: randomUUID() }))
        .rejects.toMatchObject({ status: 403 });
    });

    it("bounds GitHub response authorization reads with large saved chat content", async () => {
      const f = await toolReplyFixture();
      const [delivery] = await db.select().from(chatDeliveries).where(eq(chatDeliveries.endpointId, f.endpoint.id));
      const [resource] = await db.select().from(chatEndpointResources).where(eq(chatEndpointResources.id, f.conversation.resourceId!));
      const [configuration] = await db.select().from(chatGitHubConfigurations).where(eq(chatGitHubConfigurations.endpointId, f.endpoint.id));
      const bulk = "unused-content-for-response-authorization".repeat(8_192);
      const setup = { ...f.endpoint.setup, unusedContent: bulk };
      await db.update(chatEndpoints).set({ communicationInstructions: bulk, setup }).where(eq(chatEndpoints.id, f.endpoint.id));
      await db.update(chatConversations).set({ communicationGuidance: bulk }).where(eq(chatConversations.id, f.conversation.id));
      await db.update(chatEndpointResources).set({ metadata: { ...resource.metadata, unusedContent: bulk } })
        .where(eq(chatEndpointResources.id, resource.id));
      await db.update(chatGitHubConfigurations).set({ configuration: { ...configuration.configuration,
        defaults: { ...configuration.configuration.defaults, instructions: bulk } } })
        .where(eq(chatGitHubConfigurations.endpointId, f.endpoint.id));
      const normalizedEvent = { ...delivery.normalizedEvent, unusedContent: bulk };
      await db.update(chatDeliveries).set({ normalizedEvent }).where(eq(chatDeliveries.id, delivery.id));
      const events: Array<Record<string, unknown>> = [], now = Date.now();
      const capture = createFullDatabaseResponseCapture({ start: now - 100, end: now + 59_000 }, event => events.push(event));
      installDatabaseResponseCapture(db, { chatMessageLinks, chatDeliveries, chatEndpoints, chatConversations,
        chatEndpointResources, chatGitHubConfigurations, chatExternalPrincipals, chatIdentityLinks,
        companyMemberships, chatActions, heartbeatRuns }, capture);
      try {
        const receipt = await githubResponseCommentService(db, f.providerFetch).tryAcknowledge(delivery.id);
        expect(receipt?.id).toBeTruthy();
      } finally { capture.flush(); }
      expect(Number(events.at(-1)?.responseValueBytes)).toBeLessThan(24_000);
      expect(events.filter(event => event.table === "chat_message_links").length).toBeGreaterThan(0);
      expect((await db.select({ normalizedEvent: chatDeliveries.normalizedEvent }).from(chatDeliveries)
        .where(eq(chatDeliveries.id, delivery.id)))[0].normalizedEvent).toEqual(normalizedEvent);
      expect((await db.select({ setup: chatEndpoints.setup }).from(chatEndpoints)
        .where(eq(chatEndpoints.id, f.endpoint.id)))[0].setup).toEqual(setup);
    });

    it.each(["githubAutomatic", "githubIssue"])("preserves %s policy context while omitting body content", async key => {
      const f = await toolReplyFixture();
      const [delivery] = await db.select().from(chatDeliveries).where(eq(chatDeliveries.endpointId, f.endpoint.id));
      const context = { event: key === "githubIssue" ? "issue_opened" : "opened", repositoryId: "418", repository: "acme/repo",
        author: { id: "42", login: "octocat", isBot: false }, sender: { id: "42", login: "octocat" },
        labels: ["review"], draft: false, baseBranch: "master", headSha: "a".repeat(40),
        body: "unused-body".repeat(32_768), title: "unused-title".repeat(8_192) };
      const normalizedEvent = { text: "unrelated message text", [key]: { context, revision: 42,
        policy: { instructions: "unused-policy-instructions".repeat(32_768),
          prompts: { opened: "unused-policy-prompt".repeat(32_768) } },
      } };
      await db.update(chatDeliveries).set({ normalizedEvent }).where(eq(chatDeliveries.id, delivery.id));
      const events: Array<Record<string, unknown>> = [], now = Date.now();
      const capture = createFullDatabaseResponseCapture({ start: now - 100, end: now + 59_000 }, event => events.push(event));
      installDatabaseResponseCapture(db, { chatDeliveries }, capture);
      let projected: { event: Record<string, unknown> };
      try {
        [projected] = await db.select({ event: githubResponseAuthorityFields.delivery.normalizedEvent })
          .from(chatDeliveries).where(eq(chatDeliveries.id, delivery.id));
      } finally { capture.flush(); }
      const { body: _body, title: _title, ...policy } = context;
      expect(Number(events.at(-1)?.responseValueBytes)).toBeLessThan(2_048);
      expect(projected.event).toEqual({ [key]: { context: policy } });
      expect((await db.select({ event: chatDeliveries.normalizedEvent }).from(chatDeliveries)
        .where(eq(chatDeliveries.id, delivery.id)))[0].event).toEqual(normalizedEvent);
    });

    it.each([null, false, 7, "invalid-event", []])("preserves malformed GitHub authority input %j", async value => {
      const f = await toolReplyFixture();
      const [delivery] = await db.select().from(chatDeliveries).where(eq(chatDeliveries.endpointId, f.endpoint.id));
      await db.update(chatDeliveries).set({ normalizedEvent: sql`${JSON.stringify(value)}::jsonb` })
        .where(eq(chatDeliveries.id, delivery.id));
      await db.update(chatEndpoints).set({ setup: sql`${JSON.stringify(value)}::jsonb` })
        .where(eq(chatEndpoints.id, f.endpoint.id));
      const [projected] = await db.select({ event: githubResponseAuthorityFields.delivery.normalizedEvent })
        .from(chatDeliveries).where(eq(chatDeliveries.id, delivery.id));
      const [endpoint] = await db.select({ setup: githubResponseAuthorityFields.endpoint.setup })
        .from(chatEndpoints).where(eq(chatEndpoints.id, f.endpoint.id));
      expect(projected.event).toEqual(value);
      expect(endpoint.setup).toEqual(value);
    });

    it("returns snapshot finding categories and publishes only accepted categories", async () => {
      const categories = ["custom-reliability"];
      const f = await publicationRetryFixture(categories);
      const begin = await f.service.execute(f.session, "begin_review", { reviewedCommit: f.head });
      expect(begin).toMatchObject({ findingCategories: categories });
      const config = await f.management.configuration(f.endpoint.id, "owner-user");
      await f.management.saveConfiguration(f.endpoint.id, { expectedRevision: config.revision,
        configuration: { ...config.configuration, defaults: { ...config.configuration.defaults, findingCategories: ["new-category"] } },
      }, "owner-user");
      expect(await f.service.execute(f.session, "begin_review", { reviewedCommit: f.head }))
        .toMatchObject({ findingCategories: categories });
      const finding = { key: "one", path: "src/math.ts", line: 1, side: "RIGHT", severity: "error", category: "invented", body: "Concrete issue" };
      await expect(f.service.execute(f.session, "submit_review", { ...f.assessment, findings: [finding] }, "bad-category"))
        .rejects.toThrow('Accepted finding categories: ["custom-reliability"]');
      expect(await f.action()).toBeUndefined();
      const result = await f.service.execute(f.session, "submit_review", { ...f.assessment,
        findings: [{ ...finding, category: categories[0] }],
      }, "accepted-category");
      expect(result).toMatchObject({ status: "processed" });
      const [review] = await readChatGitHubReviewsByEndpointId(f.endpoint.id);
      expect(review.assessment?.findings[0].category).toBe(categories[0]);
      expect((await f.action()).status).toBe("processed");
      expect(await chatHistoryActionBlocks(db, (await f.action()).id)).toBe(false);
      expect(f.responseComments.size).toBe(1);
    });

    it("publishes one score heading when a newly configured bot submits a formatted summary", async () => {
      const f = await publicationRetryFixture();
      await db.update(chatEndpoints).set({ botDisplayName: "Fresh Review Bot" }).where(eq(chatEndpoints.id, f.endpoint.id));
      const submit = (await githubBotToolsForSession(db, f.session)).find(tool => tool.upstreamToolName === "submit_review")!;
      expect(submit.parametersSchema).toMatchObject({ properties: {
        summary: { description: expect.stringContaining("Review body only") },
        rationale: { description: expect.stringContaining("Do not repeat the summary") },
      } });
      const assessment = { ...f.assessment, summary: "## Fresh Review Bot — 2/5\n\n## Fresh Review Bot — 3/5\n\nAdvisory review\n\n### Findings\n\nKeep this section." };
      const result = await f.service.execute(f.session, "submit_review", assessment, "formatted-summary");
      expect(result).toMatchObject({ status: "processed", score: 3 });
      const body = [...f.responseComments.values()][0].body;
      expect(body).toMatch(/^## Fresh Review Bot — 3\/5\n\nAdvisory review/);
      expect(body.match(/^## Fresh Review Bot — /gm)).toHaveLength(1);
      expect(body).toContain("### Findings\n\nKeep this section.");
      expect(body).toContain(f.assessment.rationale);
      expect(body).toContain(`Reviewed commit: \`${f.head}\``);
      expect(f.responseComments.size).toBe(1);
      const [review] = await readChatGitHubReviewsByEndpointId(f.endpoint.id);
      expect(review.assessment?.summary).toBe(assessment.summary);
    });

    it.each(["external_chat_response_waiting", "preserved_result_status_unproven"] as const)(
      "preserves the published GitHub assessment during passive-response maintenance: %s", async reason => {
      const f = await publicationRetryFixture();
      await f.service.execute(f.session, "submit_review", f.assessment, "published-before-passive-reply");
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.run.id));
      const reviewBefore = await readChatGitHubReviewsByEndpointId(f.endpoint.id);
      const originalId = [...f.responseComments.keys()][0];
      const originalBody = f.responseComments.get(originalId)!.body;
      const writesBefore = f.responseWrites.length;
      const responses = githubResponseCommentService(db, f.providerFetch);
      const thread = makeThread({ channelId: "paperclipai/paperclip", id: f.conversation.externalThreadId }).thread;
      await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
        trigger: "subscribed_message", message: makeMessage({ id: "41802", text: "No fix pushed; keep the existing review unchanged and wait for my reply.", userId: "42", userName: "octocat" }) });
      await responses.processPending();
      expect(f.responseComments.get(originalId)!.body).toBe(originalBody);
      expect(f.responseWrites).toHaveLength(writesBefore);
      const [next] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.assignedAgentId,
        status: "running", runtimeMode: "native", contextSnapshot: await chatWakeContext({
          endpointId: f.endpoint.id, issueId: f.conversation.issueId, provider: "github", providerMessageId: "41802",
        }), resultJson: { finalizationPhase: "committed", finalizationReasonCode: reason,
          nativeResult: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "yielded",
            continuation: { kind: "response_wake", idempotencyKey: "passive-author-reply" } },
          presentationDecision: { schema: "paperclip.run_presentation_decision.v1", resolverVersion: "2",
            activityDisposition: "collapse", chosenSource: "none", commentAction: "none", commentId: null,
            reasonCodes: ["yielded_control_plane_wait"] } } }).returning();
      const expectedStatus = reason === "preserved_result_status_unproven" ? "blocked" : "in_review";
      await db.update(issues).set({ status: expectedStatus }).where(eq(issues.id, f.conversation.issueId!));
      await responses.processPending();
      expect(f.responseComments.get(originalId)!.body).toBe(originalBody);
      expect(f.responseWrites).toHaveLength(writesBefore);
      await db.update(heartbeatRuns).set({ status: "succeeded", nativePhase: "committed" }).where(eq(heartbeatRuns.id, next.id));
      await responses.processPending();
      await responses.processPending();
      expect(f.responseComments.get(originalId)!.body).toBe(originalBody);
      expect(f.responseWrites).toHaveLength(writesBefore);
      expect((await db.select({ status: issues.status }).from(issues).where(eq(issues.id, f.conversation.issueId!)))[0].status)
        .toBe(expectedStatus);
      expect(await readChatGitHubReviewsByEndpointId(f.endpoint.id)).toEqual(reviewBefore);
      expect([...f.responseComments.keys()]).toEqual([originalId]);
      expect(await githubRunReplyState(db, { ...f.session, runId: next.id, endpointId: f.endpoint.id })).toBe("none");
      const [delivery] = await db.select().from(chatDeliveries).where(and(eq(chatDeliveries.endpointId, f.endpoint.id),
        eq(chatDeliveries.providerEventId, `${thread.id}:41802`)));
      const [response] = await db.select().from(chatActions).where(and(eq(chatActions.deliveryId, delivery.id),
        eq(chatActions.kind, "github_response_comment")));
      expect(response).toMatchObject({ status: "cancelled", result: { final: true, code: "passive_response_wait" } });
      expect(await chatHistoryActionBlocks(db, response.id)).toBe(false);
      const writes = f.responseWrites.length;
      const updatedAt = response.updatedAt;
      await responses.processPending();
      expect(f.responseWrites).toHaveLength(writes);
      expect((await readChatActionsById(response.id))[0].updatedAt).toEqual(updatedAt);
      await expect(responses.failRun({ ...f.session, runId: next.id, endpointId: f.endpoint.id,
        body: "This turn ended without publishing a final response." })).rejects.toMatchObject({ status: 403 });
      expect(f.responseWrites).toHaveLength(writes);
    });

    it.each((["completed", "failed", "missing_decision", "comment_requested", "missing_semantic", "legacy", "uncommitted_native", "pending_publication", "missing_decision_then_missing", "uncommitted_then_failed", "malformed_null", "malformed_scalar", "malformed_schema", "malformed_action"] as const)
      .flatMap(scenario => ["external_chat_response_waiting", "preserved_result_status_unproven"].map(reason => ({ scenario, reason }))))(
      "keeps GitHub response maintenance truthful for a new request: $scenario ($reason)", async ({ scenario, reason }) => {
      const pendingPresentation = scenario.startsWith("missing_decision") || scenario.startsWith("uncommitted") || scenario.startsWith("malformed");
      const f = await publicationRetryFixture();
      await f.service.execute(f.session, "submit_review", f.assessment, "review-before-new-request");
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.run.id));
      const originalId = [...f.responseComments.keys()][0];
      const originalBody = f.responseComments.get(originalId)!.body;
      const thread = makeThread({ channelId: "paperclipai/paperclip", id: f.conversation.externalThreadId }).thread;
      await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
        trigger: "subscribed_message", message: makeMessage({ id: "41802", text: "Please handle this new request", userId: "42", userName: "octocat" }) });
      const [next] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.assignedAgentId,
        status: scenario === "failed" ? "failed" : "succeeded", runtimeMode: scenario === "legacy" ? "legacy" : "native",
        nativePhase: scenario.startsWith("uncommitted") ? "observed" : "committed", contextSnapshot: await chatWakeContext({
          endpointId: f.endpoint.id, issueId: f.conversation.issueId, provider: "github", providerMessageId: "41802",
        }), resultJson: { finalizationPhase: "committed", finalizationReasonCode: reason,
          ...(scenario === "missing_semantic" ? {} : { nativeResult: { schema: "paperclip.run_result.v1",
            reportedWorkDisposition: scenario === "completed" ? "completed" : "yielded",
            continuation: { kind: "response_wake", idempotencyKey: "new-request-wait" } } }),
          ...(scenario.startsWith("missing_decision") ? {} : { presentationDecision: scenario === "malformed_null" ? null : scenario === "malformed_scalar" ? "pending" : {
            schema: scenario === "malformed_schema" ? "unknown" : "paperclip.run_presentation_decision.v1", chosenSource: "none",
            commentAction: scenario === "malformed_action" ? "unknown" : scenario === "comment_requested" ? "create" : "none", reasonCodes: ["yielded_control_plane_wait"] } }) } }).returning();
      if (scenario === "pending_publication") await db.insert(chatActions).values({ companyId: f.companyId,
        endpointId: f.endpoint.id, conversationId: f.conversation.id, kind: "github_review_publication",
        providerActionId: `github_publication:${randomUUID()}`, status: "processing",
        payload: { operation: "comment", session: { ...f.session, runId: next.id } } });
      const responses = githubResponseCommentService(db, f.providerFetch);
      await responses.processPending();
      const [delivery] = await db.select().from(chatDeliveries).where(and(eq(chatDeliveries.endpointId, f.endpoint.id),
        eq(chatDeliveries.providerEventId, `${thread.id}:41802`)));
      const [response] = await db.select().from(chatActions).where(and(eq(chatActions.deliveryId, delivery.id),
        eq(chatActions.kind, "github_response_comment")));
      if (scenario === "pending_publication") {
        expect(f.responseComments.get(originalId)!.body).toBe(originalBody);
        expect(response.result?.final).not.toBe(true);
        expect(response).toMatchObject({ status: "failed", result: { retryable: true, code: "acknowledgement_unconfirmed" } });
      } else if (pendingPresentation) {
        expect(f.responseComments.get(originalId)!.body).toBe(originalBody);
        expect(response.result?.final).not.toBe(true);
        const pendingWrites = f.responseWrites.length;
        await responses.processPending();
        await expect(responses.failRun({ ...f.session, runId: next.id, endpointId: f.endpoint.id,
          body: "This turn ended without publishing a final response." })).rejects.toMatchObject({ status: 409 });
        expect(f.responseWrites).toHaveLength(pendingWrites);
        const failed = scenario === "uncommitted_then_failed";
        const missing = scenario === "missing_decision_then_missing";
        await db.update(heartbeatRuns).set({ status: failed ? "failed" : "succeeded",
          nativePhase: failed ? "failed" : "committed", resultJson: {
            ...next.resultJson, finalizationPhase: failed ? "failed" : "committed",
            nativeResult: { schema: "paperclip.run_result.v1", reportedWorkDisposition: missing ? "completed" : "yielded",
              continuation: missing ? null : { kind: "response_wake", idempotencyKey: "settled-request-wait" } },
            presentationDecision: { schema: "paperclip.run_presentation_decision.v1", chosenSource: "none",
              commentAction: "none", reasonCodes: [missing ? "no_final_response" : "yielded_control_plane_wait"] },
          } }).where(eq(heartbeatRuns.id, next.id));
        await responses.processPending();
        if (failed || missing) expect(f.responseComments.get(originalId)!.body).toContain(failed
          ? "This turn stopped before completing" : "This turn ended without publishing a final response");
        else expect(f.responseComments.get(originalId)!.body).toBe(originalBody);
        expect((await readChatActionsById(response.id))[0]).toMatchObject({
          status: failed || missing ? "processed" : "cancelled", result: { final: true },
        });
      } else {
        expect(f.responseComments.get(originalId)!.body).toContain(scenario === "failed"
          ? "This turn stopped before completing" : "This turn ended without publishing a final response");
        expect(response).toMatchObject({ status: "processed", result: { final: true } });
      }
      const writes = f.responseWrites.length;
      await responses.processPending();
      expect(f.responseWrites).toHaveLength(writes);
    });

    it("keeps per-request fallback outside the main GitHub PR review wait", async () => {
      const f = await toolReplyFixture();
      await db.update(heartbeatRuns).set({ status: "succeeded", nativePhase: "committed", resultJson: {
        finalizationPhase: "committed", finalizationReasonCode: "external_chat_response_waiting",
        nativeResult: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "yielded",
          continuation: { kind: "response_wake", idempotencyKey: "not-a-main-pr-review" } },
        presentationDecision: { schema: "paperclip.run_presentation_decision.v1", chosenSource: "none",
          commentAction: "none", reasonCodes: ["yielded_control_plane_wait"] },
      } }).where(eq(heartbeatRuns.id, f.run.id));
      await githubResponseCommentService(db, f.providerFetch).processPending();
      expect([...f.responseComments.values()][0].body).toContain("without publishing a final response");
    });

    it.each(["same_head", "new_head"] as const)("reuses one main GitHub PR comment across review requests: %s", async headCase => {
      const f = await publicationRetryFixture();
      await f.service.execute(f.session, "submit_review", f.assessment, "first-review");
      const originalId = [...f.responseComments.keys()][0];
      // Restart after a provider write whose shared receipt was lost. The
      // App-owned marker, rather than process memory, must recover the target.
      await db.update(chatActions).set({ result: null }).where(and(eq(chatActions.endpointId, f.endpoint.id),
        eq(chatActions.kind, "github_pr_response_comment")));
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.run.id));
      const thread = makeThread({ channelId: "paperclipai/paperclip", id: f.conversation.externalThreadId }).thread;
      await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
        trigger: "mention", message: makeMessage({ id: "41802", text: "Review again", userId: "42", userName: "octocat", mentioned: true }) });
      await githubResponseCommentService(db, f.providerFetch).processPending();
      const [next] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.assignedAgentId,
        status: "running", runtimeMode: "native", contextSnapshot: await chatWakeContext({
          endpointId: f.endpoint.id, issueId: f.conversation.issueId, provider: "github", providerMessageId: "41802",
        }) }).returning();
      const session = { ...f.session, runId: next.id };
      const currentHead = headCase === "new_head" ? "c".repeat(40) : f.head;
      f.setSupplementalProviderFetch(async (input, init) => String(input).endsWith("/pulls/418")
        ? Response.json({ number: 418, state: "open", draft: false, head: { sha: currentHead },
          base: { sha: "a".repeat(40), ref: "master" }, user: { id: 42, login: "octocat", type: "User" }, labels: [] })
        : f.provider(input, init));
      await f.service.execute(session, "begin_review", { reviewedCommit: currentHead });
      await f.service.execute(session, "submit_review", { ...f.assessment, reviewedCommit: currentHead, summary: "Second assessment" }, "second-review");
      expect([...f.responseComments.keys()]).toEqual([originalId]);
      expect(f.responseComments.get(originalId)?.body).toContain("Second assessment");
      expect(f.responseWrites.filter(write => write.method === "POST")).toHaveLength(1);
    });

    it("ignores a review request addressed to an external GitHub bot", async () => {
      const f = await subscribedGitHubFixture("github:paperclipai/paperclip:419");
      const wakeCount = f.wakeup.mock.calls.length;
      await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread: f.thread,
        trigger: "subscribed_message", message: makeMessage({ id: "41902", text: "@greptile review", userId: "42", userName: "octocat" }) });
      const [delivery] = await db.select().from(chatDeliveries).where(and(eq(chatDeliveries.endpointId, f.endpoint.id),
        eq(chatDeliveries.providerEventId, `${f.thread.id}:41902`)));
      expect(delivery.state).toBe("filtered");
      expect(f.wakeup).toHaveBeenCalledTimes(wakeCount);
      expect(await readIssueCommentsByIssueId(f.conversation.issueId!)).toHaveLength(1);
      expect(f.responseWrites).toHaveLength(1);
    });

    it("retains a provider-verified GitHub mention when its plain text uses an alias", async () => {
      const f = await subscribedGitHubFixture("github:paperclipai/paperclip:419");
      const wakeCount = f.wakeup.mock.calls.length;
      await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread: f.thread,
        trigger: "mention", message: makeMessage({ id: "41902", text: "@rendered-alias review", userId: "42", userName: "octocat", mentioned: true }) });
      expect(f.wakeup).toHaveBeenCalledTimes(wakeCount + 1);
      expect(await readIssueCommentsByIssueId(f.conversation.issueId!)).toHaveLength(2);
    });

    it("reconciles a GitHub working comment when execution stops without a publication", async () => {
      const f = await toolReplyFixture("github:paperclipai/paperclip:418");
      await db.update(heartbeatRuns).set({ status: "failed", errorCode: "execution_finalization_deadline_exceeded" })
        .where(eq(heartbeatRuns.id, f.run.id));
      await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, f.conversation.issueId!));
      await githubResponseCommentService(db, f.providerFetch).processPending();
      expect(f.responseComments.size).toBe(1);
      expect([...f.responseComments.values()][0].body).toContain("stopped before completing");
      const thread = makeThread({ channelId: "paperclipai/paperclip", id: f.conversation.externalThreadId }).thread;
      await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
        trigger: "mention", message: makeMessage({ id: "41802", text: "Review again", userId: "42", userName: "octocat", mentioned: true }) });
      await githubResponseCommentService(db, f.providerFetch).processPending();
      expect(f.responseComments.size).toBe(1);
      expect([...f.responseComments.values()][0].body).toContain("paused");
    });

    it("preserves newer GitHub PR progress when an older run fails", async () => {
      const f = await toolReplyFixture("github:paperclipai/paperclip:418");
      await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, f.run.id));
      const thread = makeThread({ channelId: "paperclipai/paperclip", id: f.conversation.externalThreadId }).thread;
      await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
        trigger: "mention", message: makeMessage({ id: "41802", text: "Review again", userId: "42", userName: "octocat", mentioned: true }) });
      const [next] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.assignedAgentId,
        status: "running", runtimeMode: "native", contextSnapshot: await chatWakeContext({
          endpointId: f.endpoint.id, issueId: f.conversation.issueId, provider: "github", providerMessageId: "41802",
        }) }).returning();
      await githubChatReviewService(db, f.providerFetch).execute({ ...f.session, runId: next.id }, "update_comment",
        { body: "Reviewing the new request", idempotencyKey: "new-progress" });
      await expect(githubResponseCommentService(db, f.providerFetch).failRun({ ...f.session, endpointId: f.endpoint.id,
        body: "Old run failed" })).rejects.toMatchObject({ status: 403 });
      await githubResponseCommentService(db, f.providerFetch).processPending();
      expect(f.responseComments.size).toBe(1);
      expect([...f.responseComments.values()][0].body).toContain("Reviewing the new request");
    });

    it("adopts an existing GitHub PR placeholder and retires earlier duplicate placeholders", async () => {
      const f = await toolReplyFixture("github:paperclipai/paperclip:418");
      const original = [...f.responseComments.values()][0];
      original.body = original.body.replace(/<!-- paperclip-pr-response:[^>]+ -->\n/, "");
      await db.delete(chatActions).where(and(eq(chatActions.endpointId, f.endpoint.id), eq(chatActions.kind, "github_pr_response_comment")));
      // Reconcile a pre-upgrade acknowledgement before its run completes.
      const [first] = await db.select().from(chatActions).where(and(eq(chatActions.endpointId, f.endpoint.id), eq(chatActions.kind, "github_response_comment")));
      await db.update(chatActions).set({ status: "received" }).where(eq(chatActions.id, first.id));
      await githubResponseCommentService(db, f.providerFetch).processPending();
      expect(f.responseComments.size).toBe(1);
      expect(original.body).toContain("paperclip-pr-response:");
      const thread = makeThread({ channelId: "paperclipai/paperclip", id: f.conversation.externalThreadId }).thread;
      await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
        trigger: "mention", message: makeMessage({ id: "41802", text: "Review again", userId: "42", userName: "octocat", mentioned: true }) });
      const [second] = await db.select().from(chatActions).where(and(eq(chatActions.endpointId, f.endpoint.id),
        eq(chatActions.kind, "github_response_comment"), sql`${chatActions.id} <> ${first.id}`));
      // Simulate the second request's persisted pre-upgrade provider receipt.
      const duplicateId = 799999;
      f.responseComments.set(duplicateId, { ...original, id: duplicateId,
        body: original.body.replace(/<!-- paperclip-pr-response:[^>]+ -->\n/, ""),
        html_url: `${original.html_url}-legacy`,
      });
      await db.update(chatActions).set({ status: "received", result: { ...second.result, id: String(duplicateId) } }).where(eq(chatActions.id, second.id));
      await githubResponseCommentService(db, f.providerFetch).processPending();
      expect(f.responseComments.get(duplicateId)?.body).toContain("current review");
      expect(f.responseComments.get(duplicateId)?.body).not.toContain("queued");
      expect(f.responseWrites.filter(write => write.method === "POST")).toHaveLength(1);
      await githubChatReviewService(db, f.providerFetch).execute(f.session, "comment", { body: "Final result", idempotencyKey: "legacy-final" });
      expect(original.body).toContain("Final result");
    });

    it("keeps a newer GitHub request open when its acknowledgement follows older progress", async () => {
      const f = await toolReplyFixture("github:paperclipai/paperclip:418");
      const thread = makeThread({ channelId: "paperclipai/paperclip", id: f.conversation.externalThreadId }).thread;
      await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
        trigger: "mention", message: makeMessage({ id: "41802", text: "Review again", userId: "42", userName: "octocat", mentioned: true }) });
      const [link] = await db.select().from(chatMessageLinks).where(and(eq(chatMessageLinks.endpointId, f.endpoint.id), eq(chatMessageLinks.providerMessageId, "41802")));
      await db.update(chatActions).set({ status: "received", result: null }).where(and(eq(chatActions.deliveryId, link.deliveryId!), eq(chatActions.kind, "github_response_comment")));
      await githubChatReviewService(db, f.providerFetch).execute(f.session, "update_comment", { body: "Older run progress", idempotencyKey: "old-progress" });
      await githubResponseCommentService(db, f.providerFetch).tryAcknowledge(link.deliveryId!);
      const [response] = await db.select().from(chatActions).where(and(eq(chatActions.deliveryId, link.deliveryId!), eq(chatActions.kind, "github_response_comment")));
      expect(response.result?.final).toBe(false);
      const [next] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.assignedAgentId,
        status: "running", runtimeMode: "native", contextSnapshot: await chatWakeContext({
          endpointId: f.endpoint.id, issueId: f.conversation.issueId, provider: "github", providerMessageId: "41802",
        }) }).returning();
      const result = await githubChatReviewService(db, f.providerFetch).execute({ ...f.session, runId: next.id }, "update_comment",
        { body: "Newer request progress", idempotencyKey: "new-progress" });
      expect(result.status).toBe("processed");
      expect([...f.responseComments.values()][0].body).toContain("Newer request progress");
    });

    it.each([false, true])("closes a GitHub placeholder after a formal review (legacy receipt: %s)", async legacy => {
      const f = await publicationRetryFixture();
      const formal = { id: 991, html_url: "https://github.com/paperclipai/paperclip/pull/418#pullrequestreview-991" };
      if (legacy) {
        await db.insert(chatActions).values({ companyId: f.companyId, endpointId: f.endpoint.id, conversationId: f.conversation.id,
          kind: "github_review_publication", providerActionId: randomUUID(), status: "processed",
          payload: { operation: "formal_review", session: f.session }, result: { id: String(formal.id), url: formal.html_url } });
      } else {
        const config = await f.management.configuration(f.endpoint.id, "owner-user");
        await f.management.saveConfiguration(f.endpoint.id, { expectedRevision: config.revision,
          configuration: { ...config.configuration, defaults: { ...config.configuration.defaults,
            allowApprove: true, publishSummary: false, publishInline: false } } }, "owner-user");
        f.setSupplementalProviderFetch(async (input, init) => String(input).includes("/pulls/418/reviews")
          ? Response.json(init?.method === "POST" ? formal : []) : f.provider(input, init));
        await f.service.execute(f.session, "submit_review", f.assessment, "score-only");
        await f.service.execute(f.session, "formal_review", { event: "APPROVE", reviewedCommit: f.head, body: "Reviewed", idempotencyKey: "formal-only" });
      }
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.run.id));
      await githubResponseCommentService(db, f.providerFetch).processPending();
      const body = [...f.responseComments.values()][0].body;
      expect(body).not.toMatch(/Review queued|Working on this/);
      expect(body).toContain("paperclip-response-state:final");
      const responses = await db.select().from(chatActions).where(and(eq(chatActions.endpointId, f.endpoint.id), eq(chatActions.kind, "github_response_comment")));
      expect(responses.length).toBeGreaterThan(0);
      for (const receipt of responses) expect(await chatHistoryActionBlocks(db, receipt.id)).toBe(false);
    });

    it("retires a legacy coalesced GitHub placeholder before replacing its receipt", async () => {
      const f = await publicationRetryFixture();
      const original = { ...[...f.responseComments.values()][0] };
      const [first] = await db.select().from(chatActions).where(and(eq(chatActions.endpointId, f.endpoint.id), eq(chatActions.kind, "github_response_comment")));
      const thread = makeThread({ channelId: "paperclipai/paperclip", id: f.conversation.externalThreadId }).thread;
      await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
        trigger: "mention", message: makeMessage({ id: "41802", text: "Review again", userId: "42", userName: "octocat", mentioned: true }) });
      const duplicateId = 799999;
      f.responseComments.set(duplicateId, { ...original, id: duplicateId,
        body: original.body.replace(/<!-- paperclip-pr-response:[^>]+ -->\n/, ""),
        html_url: "https://github.com/paperclipai/paperclip/pull/418#issuecomment-799999" });
      await db.update(chatActions).set({ result: { ...first.result, id: String(duplicateId) } }).where(eq(chatActions.id, first.id));
      const links = await db.select().from(chatMessageLinks).where(and(eq(chatMessageLinks.endpointId, f.endpoint.id), eq(chatMessageLinks.direction, "inbound")));
      const latest = await chatWakeContext({ endpointId: f.endpoint.id, issueId: f.conversation.issueId, provider: "github", providerMessageId: "41802" });
      await db.update(heartbeatRuns).set({ contextSnapshot: { ...latest, wakeCommentIds: links.map(link => link.commentId) } }).where(eq(heartbeatRuns.id, f.run.id));
      await f.service.execute(f.session, "begin_review", { reviewedCommit: f.head });
      await f.service.execute(f.session, "submit_review", f.assessment, "coalesced-upgrade");
      expect(f.responseComments.get(duplicateId)?.body).toContain("current review");
      expect(f.responseComments.get(duplicateId)?.body).not.toMatch(/Review queued|Working on this/);
      expect([...f.responseComments.values()].some(comment => comment.body.includes("Advisory review"))).toBe(true);
    });

    it("does not handle a blocked new GitHub request with an older run's final reply", async () => {
      const f = await toolReplyFixture("github:paperclipai/paperclip:418");
      await githubChatReviewService(db, f.providerFetch).execute(f.session, "comment", { body: "Earlier result", idempotencyKey: "earlier-result" });
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.run.id));
      await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, f.conversation.issueId!));
      const thread = makeThread({ channelId: "paperclipai/paperclip", id: f.conversation.externalThreadId }).thread;
      await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
        trigger: "mention", message: makeMessage({ id: "41802", text: "New request", userId: "42", userName: "octocat", mentioned: true }) });
      await githubResponseCommentService(db, f.providerFetch).processPending();
      const body = [...f.responseComments.values()][0].body;
      expect(body).toContain("paused");
      expect(body).not.toContain("has been handled");
      expect(f.responseComments.size).toBe(1);
    });

    it.each([["failed", false], ["failed", true], ["queued", false], ["queued", true]] as const)(
      "resumes a paused GitHub request and reconciles stopped execution (prior run: %s, progress: %s)", async (status, progress) => {
        const f = await toolReplyFixture("github:paperclipai/paperclip:418");
        await db.update(heartbeatRuns).set({ status }).where(eq(heartbeatRuns.id, f.run.id));
        await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, f.conversation.issueId!));
        const thread = makeThread({ channelId: "paperclipai/paperclip", id: f.conversation.externalThreadId }).thread;
        await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
          trigger: "mention", message: makeMessage({ id: "41802", text: "New request", userId: "42", userName: "octocat", mentioned: true }) });
        const responses = githubResponseCommentService(db, f.providerFetch);
        await responses.processPending();
        expect([...f.responseComments.values()][0].body).toContain("paused");
        const pausedWrites = f.responseWrites.length;
        await responses.processPending();
        await responses.processPending();
        expect(f.responseWrites).toHaveLength(pausedWrites);
        await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, f.conversation.issueId!));
        const [next] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.assignedAgentId,
          status: "running", runtimeMode: "native", contextSnapshot: await chatWakeContext({
            endpointId: f.endpoint.id, issueId: f.conversation.issueId, provider: "github", providerMessageId: "41802",
          }) }).returning();
        const session = { ...f.session, runId: next.id };
        if (progress) {
          expect(await githubChatReviewService(db, f.providerFetch).execute(session, "update_comment",
            { body: "Resumed request progress", idempotencyKey: "resumed-progress" })).toMatchObject({ status: "processed" });
          expect([...f.responseComments.values()][0].body).toContain("Resumed request progress");
        }
        await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, next.id));
        await responses.failRun({ ...session, endpointId: f.endpoint.id, body: "Resumed work stopped" });
        expect(f.responseComments.size).toBe(1);
        expect([...f.responseComments.values()][0].body).toContain("Resumed work stopped");
      });

    it("preserves a final GitHub assessment while settling an incomplete request receipt", async () => {
      const f = await publicationRetryFixture();
      await f.service.execute(f.session, "submit_review", f.assessment, "published-assessment");
      const before = [...f.responseComments.values()][0].body;
      const [response] = await db.select().from(chatActions).where(and(eq(chatActions.endpointId, f.endpoint.id), eq(chatActions.kind, "github_response_comment")));
      await db.update(chatActions).set({ result: { ...response.result, final: false } }).where(eq(chatActions.id, response.id));
      await db.update(heartbeatRuns).set({ status: "succeeded", updatedAt: new Date() }).where(eq(heartbeatRuns.id, f.run.id));
      await githubResponseCommentService(db, f.providerFetch).processPending();
      expect([...f.responseComments.values()][0].body).toBe(before);
      const [settled] = await db.select().from(chatActions).where(eq(chatActions.id, response.id));
      expect(settled.result?.final).toBe(true);
    });

    it("reconciles stopped GitHub work from native identity without legacy wake fields", async () => {
      const f = await toolReplyFixture("github:paperclipai/paperclip:418");
      await initializeRunIdentity(db, { companyId: f.companyId, runId: f.run.id, issueId: f.conversation.issueId!,
        responsibleUserId: "owner-user", messageIds: [String(f.run.contextSnapshot?.wakeCommentId)], cause: "instruction" });
      await db.update(heartbeatRuns).set({ nativeIssueId: f.conversation.issueId, contextSnapshot: {}, status: "failed", updatedAt: new Date() })
        .where(eq(heartbeatRuns.id, f.run.id));
      await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, f.conversation.issueId!));
      await githubResponseCommentService(db, f.providerFetch).processPending();
      expect([...f.responseComments.values()][0].body).toContain("stopped before completing");
      expect(f.responseComments.size).toBe(1);
    });

    it("retires a legacy GitHub placeholder when its acknowledgement is superseded", async () => {
      const f = await toolReplyFixture("github:paperclipai/paperclip:418");
      const original = { ...[...f.responseComments.values()][0] };
      const [first] = await db.select().from(chatActions).where(and(eq(chatActions.endpointId, f.endpoint.id), eq(chatActions.kind, "github_response_comment")));
      const duplicateId = 799999;
      f.responseComments.set(duplicateId, { ...original, id: duplicateId,
        body: original.body.replace(/<!-- paperclip-pr-response:[^>]+ -->\n/, ""),
        html_url: "https://github.com/paperclipai/paperclip/pull/418#issuecomment-799999" });
      await db.update(chatActions).set({ status: "received", result: { ...first.result, id: String(duplicateId) } }).where(eq(chatActions.id, first.id));
      const thread = makeThread({ channelId: "paperclipai/paperclip", id: f.conversation.externalThreadId }).thread;
      await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
        trigger: "mention", message: makeMessage({ id: "41802", text: "Review again", userId: "42", userName: "octocat", mentioned: true }) });
      const links = await db.select().from(chatMessageLinks).where(and(eq(chatMessageLinks.endpointId, f.endpoint.id), eq(chatMessageLinks.direction, "inbound")));
      const latest = await chatWakeContext({ endpointId: f.endpoint.id, issueId: f.conversation.issueId, provider: "github", providerMessageId: "41802" });
      await db.update(heartbeatRuns).set({ contextSnapshot: { ...latest, wakeCommentIds: links.map(link => link.commentId) } }).where(eq(heartbeatRuns.id, f.run.id));
      await githubChatReviewService(db, f.providerFetch).execute(f.session, "update_comment", { body: "Newer progress", idempotencyKey: "latest-progress" });
      await githubResponseCommentService(db, f.providerFetch).tryAcknowledge(first.deliveryId!);
      expect(f.responseComments.get(duplicateId)?.body).toContain("current review");
      expect([...f.responseComments.values()].some(comment => comment.body.includes("Newer progress"))).toBe(true);
      const [settled] = await db.select().from(chatActions).where(eq(chatActions.id, first.id));
      expect(settled.result?.final).toBe(false);
      expect(await chatHistoryActionBlocks(db, settled.id)).toBe(true);
    });

    it.each([false, true])("recovers an approved queued GitHub review without another approval (revoked: %s)", async revoked => {
      const f = await publicationRetryFixture();
      let unavailable = true;
      let attempts = 0;
      f.setSupplementalProviderFetch(async (input, init) => {
        if (String(input).includes("/issues/comments/") && init?.method === "PATCH") {
          attempts++;
          if (unavailable) return new Response("Unavailable", { status: 503, headers: { "retry-after": "120" } });
        }
        return f.provider(input, init);
      });
      vi.stubGlobal("fetch", f.providerFetch);
      onTestFinished(() => { vi.unstubAllGlobals(); });
      await initializeRunIdentity(db, { companyId: f.companyId, runId: f.run.id, issueId: f.conversation.issueId!,
        responsibleUserId: null, cause: "company_default" });
      const { createToolGatewayService } = await import("../../services/tool-gateway.js");
      const gateway = createToolGatewayService(db, { toolActionSigningSecret: "github-approval-retry-test-secret" });
      const session = await gateway.createSession({ companyId: f.companyId, agentId: f.assignedAgentId, runId: f.run.id });
      const tool = (await githubBotToolsForSession(db, f.session)).find(tool => tool.upstreamToolName === "submit_review")!;
      await db.insert(toolPolicies).values({ companyId: f.companyId, name: "Review publication approval", policyType: "require_approval",
        priority: 0, selectors: { catalogEntryId: tool.catalogEntryId! } });
      await expect(gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: f.assessment }))
        .rejects.toMatchObject({ reasonCode: "approval_required" });
      const [approval] = await db.select().from(toolActionRequests).where(eq(toolActionRequests.companyId, f.companyId));
      expect(await gateway.approveActionRequest({ companyId: f.companyId, actionRequestId: approval.id, actor: { userId: "owner-user" } }))
        .toMatchObject({ status: "executed" });
      const action = await f.action();
      expect(action).toMatchObject({ status: "failed", result: { retryable: true } });
      unavailable = false;
      if (revoked) await db.insert(toolPolicies).values({ companyId: f.companyId, name: "Revoke approved publication", policyType: "block",
        priority: -1, selectors: { catalogEntryId: tool.catalogEntryId! } });
      await db.update(chatActions).set({ result: { ...action.result, retryAt: new Date(0).toISOString() } }).where(eq(chatActions.id, action.id));
      await f.service.processPending();
      expect((await f.action()).status).toBe(revoked ? "cancelled" : "processed");
      expect(await chatHistoryActionBlocks(db, (await f.action()).id)).toBe(false);
      if (revoked) await expect(gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: f.assessment })).rejects.toThrow();
      else expect(await gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: f.assessment }))
        .toMatchObject({ status: "replayed", result: { data: { status: "processed", score: 3 } } });
      expect(attempts).toBe(revoked ? 1 : 2);
      expect(await db.select().from(toolActionRequests).where(eq(toolActionRequests.companyId, f.companyId))).toHaveLength(1);
    }, 25_000);

    it("recovers lost inline and check responses without duplicate GitHub publications", async () => {
      const f = await publicationRetryFixture();
      const lost = new Set<string>();
      f.setSupplementalProviderFetch(async (input, init) => {
        const response = await f.provider(input, init);
        if (init?.method === "POST" && /\/(?:comments|check-runs)$/.test(String(input)) && !lost.has(String(input))) {
          lost.add(String(input));
          throw new Error("Provider accepted the write but the response was lost");
        }
        return response;
      });
      const result = await f.service.execute(f.session, "submit_review", { ...f.assessment,
        findings: [{ key: "note", path: "src/math.ts", line: 1, side: "RIGHT", severity: "error", category: "correctness", body: "Example finding" }],
      }, "lost-receipts");
      expect(result).toMatchObject({ status: "processed", score: 3, conclusion: "neutral" });
      expect(f.inline).toHaveLength(1);
      expect(f.checks).toHaveLength(1);
      expect(f.writes.filter(write => write.method === "POST")).toHaveLength(2);
      expect(f.responseComments.size).toBe(1);
      expect((await f.action()).status).toBe("processed");
    }, 25_000);

    it("resumes a delayed GitHub publication after coordinator restart without another inbound event", async () => {
      const f = await publicationRetryFixture();
      let unavailable = true;
      let attempts = 0;
      f.setSupplementalProviderFetch(async (input, init) => {
        if (String(input).includes("/issues/comments/") && init?.method === "PATCH") {
          attempts++;
          if (unavailable) return new Response("Unavailable", { status: 503, headers: { "retry-after": "120" } });
        }
        return f.provider(input, init);
      });
      const result = await f.service.execute(f.session, "submit_review", f.assessment, "scheduled-review");
      expect(result).toMatchObject({ status: "failed", receipt: { retryable: true, attempts: 1 } });
      const action = await f.action();
      expect(await f.service.nextPendingAt()).toBe(Date.parse(String(action.result?.retryAt)));
      expect(await f.service.processPending()).toBe(0);
      const due = new Date(Date.now() + 1500);
      await db.update(chatActions).set({ result: { ...action.result, retryAt: due.toISOString() } }).where(eq(chatActions.id, action.id));
      unavailable = false;
      const { createDeliveryWorkCoordinator } = await import("../../services/delivery-work-coordinator.js");
      const { registerChatQueueWork } = await import("../../services/chat-delivery-work.js");
      const { DELIVERY_QUEUES } = await import("../../services/delivery-work-notifications.js");
      const restarted = githubChatReviewService(db, f.providerFetch);
      const errors = vi.fn();
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: errors });
      try {
        await registerChatQueueWork(coordinator, { queue: DELIVERY_QUEUES.chatGitHubPublications,
          run: restarted.processPending, next: restarted.nextPendingAt }, () => true).ready;
        expect(coordinator.nextWakeAt()).toBe(due.getTime());
        expect(attempts).toBe(1);
        await expect.poll(async () => (await f.action()).status, { timeout: 10_000 }).toBe("processed");
        expect(attempts).toBe(2);
        expect(errors).not.toHaveBeenCalled();
        expect(await restarted.nextPendingAt()).toBeNull();
        expect(f.responseComments.size).toBe(1);
      } finally {
        await coordinator.stop();
      }
    }, 25_000);

    it.each([403, 422])("does not resubmit a permanent GitHub publication rejection (HTTP %s)", async status => {
      const f = await publicationRetryFixture();
      let attempts = 0;
      f.setSupplementalProviderFetch(async (input, init) => {
        if (String(input).includes("/issues/comments/") && init?.method === "PATCH") {
          attempts++;
          return new Response("Rejected", { status });
        }
        return f.provider(input, init);
      });
      const result = await f.service.execute(f.session, "submit_review", f.assessment, "permanent-failure");
      expect(result).toMatchObject({ status: "failed", receipt: { retryable: false, attempts: 1, providerStatus: status } });
      await f.service.execute(f.session, "submit_review", f.assessment, "permanent-failure");
      expect(await f.service.processPending()).toBe(0);
      expect(await f.service.nextPendingAt()).toBeNull();
      expect(attempts).toBe(1);
    });

    it.each(["revoked", "exhausted"] as const)("stops a queued GitHub publication after %s", async mode => {
      const f = await publicationRetryFixture();
      let attempts = 0;
      f.setSupplementalProviderFetch(async (input, init) => {
        if (String(input).includes("/issues/comments/") && init?.method === "PATCH") {
          attempts++;
          return new Response("Unavailable", { status: 503, headers: { "retry-after": "120" } });
        }
        return f.provider(input, init);
      });
      await f.service.execute(f.session, "submit_review", f.assessment, "bounded-retry");
      const action = await f.action();
      await db.update(chatActions).set({ result: { ...action.result, retryAt: new Date(0).toISOString() } }).where(eq(chatActions.id, action.id));
      if (mode === "revoked") await db.update(chatIdentityLinks).set({ status: "revoked" }).where(eq(chatIdentityLinks.endpointId, f.endpoint.id));
      for (let attempt = 1; attempt < (mode === "exhausted" ? 8 : 2); attempt++) {
        const current = await f.action();
        await db.update(chatActions).set({ result: { ...current.result, retryAt: new Date(0).toISOString() } }).where(eq(chatActions.id, current.id));
        await f.service.processPending();
      }
      await f.service.processPending();
      expect((await f.action()).result?.retryable).toBe(false);
      expect((await f.action()).status).toBe(mode === "revoked" ? "cancelled" : "failed");
      expect(await f.service.nextPendingAt()).toBeNull();
      expect(attempts).toBe(mode === "exhausted" ? 8 : 1);
    });

    it.each([503, 429])("automatically retries a transient GitHub review publication (HTTP %s)", async providerStatus => {
      const f = await toolReplyFixture("github:paperclipai/paperclip:418", true);
      const head = "b".repeat(40);
      let summaryAttempts = 0;
      const checks: Record<string, unknown>[] = [];
      f.setSupplementalProviderFetch(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/pulls/418")) return Response.json({ number: 418, state: "open", draft: false,
          head: { sha: head }, base: { sha: "a".repeat(40), ref: "master" }, user: { id: 42, login: "octocat", type: "User" }, labels: [] });
        if (url.includes("/files?")) return Response.json([{ filename: "src/math.ts", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new" }]);
        if (url.includes("/check-runs?")) return Response.json({ check_runs: [] });
        if (url.includes("/check-runs") && init?.method) {
          checks.push(JSON.parse(String(init.body)));
          return Response.json({ id: 419, html_url: "https://github.com/checks/419" });
        }
        if (url.includes("/issues/comments/") && init?.method === "PATCH" && ++summaryAttempts === 1)
          return new Response("Temporary provider failure", { status: providerStatus, headers: { "retry-after": "1" } });
        return undefined;
      });
      vi.stubGlobal("fetch", f.providerFetch);
      onTestFinished(() => { vi.unstubAllGlobals(); });
      const { createToolGatewayService } = await import("../../services/tool-gateway.js");
      const gateway = createToolGatewayService(db);
      const session = await gateway.createSession({ companyId: f.companyId, agentId: f.assignedAgentId, runId: f.run.id });
      const tool = (await githubBotToolsForSession(db, f.session)).find(tool => tool.upstreamToolName === "submit_review")!;
      await githubChatReviewService(db, f.providerFetch).execute(f.session, "begin_review", { reviewedCommit: head });
      const assessment = { reviewedCommit: head, score: 3, complete: true, summary: "Advisory review", rationale: "Reviewed the file",
        coverage: { reviewedPaths: ["src/math.ts"], omittedPaths: [], limitations: [] }, findings: [] };
      const idempotencyKey = randomUUID();
      const result = await gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: assessment, idempotencyKey });
      expect(result).toMatchObject({ status: "completed", result: { data: { status: "processed", score: 3, conclusion: "neutral" } } });
      expect(summaryAttempts).toBe(2);
      expect(f.responseComments.size).toBe(1);
      expect(checks).toEqual([expect.objectContaining({ conclusion: "neutral", status: "completed" })]);
      const replay = await gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: assessment, idempotencyKey });
      expect(replay).toMatchObject({ result: { data: { status: "processed", score: 3, conclusion: "neutral" } } });
      expect(summaryAttempts).toBe(2);
      const [action] = await db.select().from(chatActions).where(and(eq(chatActions.endpointId, f.endpoint.id), eq(chatActions.kind, "github_review_publication")));
      expect(action).toMatchObject({ status: "processed" });
      expect((await readChatGitHubReviewsByEndpointId(f.endpoint.id))).toHaveLength(1);
      await expect(gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: { ...assessment, score: 5 }, idempotencyKey }))
        .rejects.toMatchObject({ status: 409, reasonCode: "github_idempotency_conflict" });
      await db.insert(toolPolicies).values({ companyId: f.companyId, name: "Revoke review publication", policyType: "block", priority: 0,
        selectors: { catalogEntryId: tool.catalogEntryId! },
      });
      await expect(gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: assessment, idempotencyKey })).rejects.toThrow();
      expect(summaryAttempts).toBe(2);
    }, 25_000);

    it.each([
      { boardFollowUp: false, legacyOrigin: false },
      { boardFollowUp: true, legacyOrigin: false },
      { boardFollowUp: false, legacyOrigin: true },
      { boardFollowUp: true, legacyOrigin: true },
    ])("keeps GitHub review tools callable through a later native task gateway (board follow-up: $boardFollowUp, legacy origin: $legacyOrigin)", async ({ boardFollowUp, legacyOrigin }) => {
      vi.stubEnv("PAPERCLIP_API_URL", "https://paperclip.example.test");
      onTestFinished(() => { vi.unstubAllEnvs(); });
      const f = await publicationRetryFixture();
      const identity = await initializeRunIdentity(db, {
        companyId: f.companyId, runId: f.run.id, issueId: f.conversation.issueId!,
        responsibleUserId: "owner-user", messageIds: legacyOrigin ? [] : [String(f.run.contextSnapshot?.wakeCommentId)], cause: "instruction",
      });
      vi.stubGlobal("fetch", f.providerFetch);
      onTestFinished(() => { vi.unstubAllGlobals(); });
      const [agent] = await db.select().from(agents).where(eq(agents.id, f.assignedAgentId));
      const gateway = createToolGatewayService(db);
      const first = await buildPaperclipRuntimeMcpServers({ db, agent: agent!, runId: f.run.id });
      const firstTools = await createAssignedMcpTools({ gateway, gatewayPublicId: new URL(first[0].url).pathname.split("/").at(-1)!, bearerToken: first[0].token });
      expect(await firstTools.execute({ tool: "paperclip_search_assigned_tools", arguments: { query: "begin_review" } })).toMatchObject({ tools: expect.arrayContaining([expect.objectContaining({ name: expect.stringContaining("begin_review") })]) });
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.run.id));
      const [later] = await db.insert(heartbeatRuns).values({
        companyId: f.companyId, agentId: f.assignedAgentId, status: "running", runtimeMode: "native",
        nativeIssueId: f.conversation.issueId, contextSnapshot: { wakeReason: "issue_monitor_due" },
      }).returning();
      const [boardMessage] = boardFollowUp ? await db.insert(issueComments).values({
        companyId: f.companyId, issueId: f.conversation.issueId!, authorType: "user", authorUserId: "owner-user", body: "Finish the review",
      }).returning() : [];
      await initializeRunIdentity(db, {
        companyId: f.companyId, runId: later.id, issueId: f.conversation.issueId!,
        responsibleUserId: "owner-user", parentContextId: identity.id, messageIds: boardMessage ? [boardMessage.id] : [], cause: "monitor",
      });
      const servers = await buildPaperclipRuntimeMcpServers({ db, agent: agent!, runId: later.id });
      expect(servers).toHaveLength(1);
      await expect(gateway.createSession({ companyId: f.companyId, agentId: f.assignedAgentId, runId: later.id, issueId: randomUUID() }))
        .rejects.toMatchObject({ reasonCode: "run_context_mismatch" });
      const assigned = await createAssignedMcpTools({ gateway, gatewayPublicId: new URL(servers[0].url).pathname.split("/").at(-1)!, bearerToken: servers[0].token });
      expect(await assigned.execute({ tool: "paperclip_search_assigned_tools", arguments: { query: "begin_review" } })).toMatchObject({ tools: expect.arrayContaining([expect.objectContaining({ name: expect.stringContaining("begin_review") })]) });
      const read = assigned.definitions().find(tool => String(tool.name).includes("read_pull_request"))!;
      expect(await assigned.execute({ tool: String(read.name), arguments: { section: "metadata" } })).toMatchObject({ data: { pull: { number: 418 } } });
      const begin = assigned.definitions().find(tool => String(tool.name).includes("begin_review"))!;
      await assigned.execute({ tool: String(begin.name), arguments: { reviewedCommit: f.head } });
      const submit = assigned.definitions().find(tool => String(tool.name).includes("submit_review"))!;
      expect(await assigned.execute({ tool: String(submit.name), arguments: f.assessment })).toMatchObject({ data: { status: "processed", score: 3 } });
      expect(f.responseComments.size).toBe(1);
      expect([...f.responseComments.values()][0].body).toContain("Advisory review");
      await db.update(chatIdentityLinks).set({ status: "revoked" }).where(eq(chatIdentityLinks.endpointId, f.endpoint.id));
      await expect(assigned.execute({ tool: String(read.name), arguments: { section: "metadata" } })).rejects.toThrow();
    });

    it.each([403, 401])("preserves GitHub connection intent after publication HTTP %s", async status => {
      const f = await toolReplyFixture();
      const initialEndpoint = await f.service.get(f.endpoint.id);
      const toolsBefore = await githubBotToolsForSession(db, f.session);
      expect(toolsBefore).toHaveLength(7);
      const runtime = f.runtime.endpoints.get(f.endpoint.id)!;
      runtime.postError = Object.assign(new Error("Provider rejected publication"), { status });
      const comment = await issueService(db).addComment(f.conversation.issueId!, "Rejected response",
        { userId: "owner-user" }, { authorType: "user" });
      await f.service.publishComment(f.endpoint.id, f.conversation.id, comment.id);
      expect(await readChatPublicationsByCommentId(comment.id)).toEqual([
        expect.objectContaining({ state: "failed", attempts: 1, nextAttemptAt: null }),
      ]);
      expect((await readToolConnectionsById(f.endpoint.connectionId))[0]).toMatchObject({
        status: "active", enabled: true, healthStatus: status === 401 ? "failed" : "healthy",
      });
      expect(await f.service.get(f.endpoint.id)).toMatchObject({ status: status === 401 ? "attention" : initialEndpoint.status });
      expect(await githubBotToolsForSession(db, f.session)).toEqual(status === 401 ? [] : toolsBefore);
      runtime.postError = null;
      const next = await issueService(db).addComment(f.conversation.issueId!, "Independent response",
        { userId: "owner-user" }, { authorType: "user" });
      const writesBefore = runtime.posts.length;
      await f.service.publishComment(f.endpoint.id, f.conversation.id, next.id);
      if (status === 403) {
        expect((await readChatPublicationsByCommentId(next.id))[0]).toMatchObject({ state: "published" });
        expect(runtime.posts.length).toBe(writesBefore + 1);
      } else {
        expect(runtime.posts).toHaveLength(writesBefore);
        expect(f.runtime.endpoints.has(f.endpoint.id)).toBe(false);
        f.setInstallationAvailable(false);
        const deleted = await f.service.handleWebhook(f.endpoint.publicId, "github", signedGitHubWebhookRequest({
          event: "installation", delivery: randomUUID(), webhookSecret: f.webhookSecret,
          payload: { action: "deleted", installation: { id: 2468 } },
        }));
        expect(deleted.status).toBe(202);
        expect(await f.service.get(f.endpoint.id)).toMatchObject({ status: "revoked" });
        expect((await readToolConnectionsById(f.endpoint.connectionId))[0]).toMatchObject({ status: "disabled", enabled: false });
        expect(await f.service.listResources(f.endpoint.id)).toEqual(expect.arrayContaining([
          expect.objectContaining({ availability: "unavailable" }),
        ]));
        expect((await readChatConversationsById(f.conversation.id))[0]).toMatchObject({ state: "unavailable" });
      }
    });

    it("lists each GitHub bot tool once when an inline thread shares the task", async () => {
      const f = await toolReplyFixture("github:paperclipai/paperclip:418");
      const { id: _id, ...conversation } = f.conversation;
      await db.insert(chatConversations).values({
        ...conversation,
        externalThreadId: "github:paperclipai/paperclip:418:rc:41901",
        providerUrl: "https://github.com/paperclipai/paperclip/pull/418#discussion_r41901",
      });
      const tools = await githubBotToolsForSession(db, f.session);
      expect(tools).toHaveLength(7);
      expect(new Set(tools.map(tool => tool.name)).size).toBe(7);
      expect(await githubBotToolsForSession(db, { ...f.session, issueId: randomUUID() })).toEqual([]);
      expect(await readChatConversationsByEndpointId(f.endpoint.id)).toHaveLength(2);
    });

    describe("replies in review finding threads behind an active run", () => {
      const pr = "github:paperclipai/paperclip:17044";
      async function findingThreadFixture() {
        vi.stubEnv("PAPERCLIP_API_URL", "https://paperclip.example.test");
        onTestFinished(() => { vi.unstubAllEnvs(); });
        const f = await subscribedGitHubFixture(pr);
        const adapterType = `github-finding-thread-test-${randomUUID()}`;
        const execute = vi.fn(async (_input: { runId: string; context: Record<string, unknown> }) => ({
          exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Answered the finding thread",
        }));
        registerServerAdapter({ type: adapterType, supportsLocalAgentJwt: false, execute,
          testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }) });
        const heartbeat = heartbeatService(db);
        const activeRunId = randomUUID();
        onTestFinished(async () => {
          runningProcesses.delete(activeRunId);
          await heartbeat.drainActiveRunExecutions();
          unregisterServerAdapter(adapterType);
        });
        const issueId = f.conversation.issueId!;
        await db.update(companies).set({ defaultResponsibleUserId: "owner-user" }).where(eq(companies.id, f.companyId));
        await db.update(agents).set({ adapterType, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } })
          .where(eq(agents.id, f.assignedAgentId));
        // Published findings bind their inline threads to the PR review task.
        const { id: _id, ...base } = f.conversation;
        const threads = await Promise.all(["4332012267", "4332012626"].map(async (commentId) => {
          const thread = makeThread({ channelId: "paperclipai/paperclip", id: `${pr}:rc:${commentId}` }).thread;
          const [conversation] = await db.insert(chatConversations).values({ ...base, externalThreadId: thread.id,
            providerUrl: `https://github.com/paperclipai/paperclip/pull/17044#discussion_r${commentId}` }).returning();
          return { thread, conversation };
        }));
        // The review-request run still holds the task when the linked user replies.
        await db.insert(heartbeatRuns).values({ id: activeRunId, companyId: f.companyId, agentId: f.assignedAgentId,
          status: "running", startedAt: new Date(), contextSnapshot: { issueId, source: "chat:github" },
          resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
        runningProcesses.set(activeRunId, { child: {} as never, graceSec: 0, processGroupId: null });
        await db.update(issues).set({ status: "in_review", executionRunId: activeRunId,
          executionAgentNameKey: "maya", executionLockedAt: new Date() }).where(eq(issues.id, issueId));
        f.wakeup.mockImplementation(heartbeat.wakeup);
        let messageId = 41950;
        const reply = (thread: Thread, text: string) => deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id,
          provider: "github", thread, trigger: "subscribed_message",
          message: makeMessage({ id: String(messageId++), text, userId: "42", userName: "octocat" }) });
        const commentFor = async (text: string) => (await readIssueCommentsByIssueId(issueId)).find((c) => c.body.includes(text))!.id;
        const finishActiveRun = async () => {
          runningProcesses.delete(activeRunId);
          await heartbeat.cancelRun(activeRunId, "Review request finished", { suppressImmediateRecovery: true });
          await heartbeat.drainActiveRunExecutions();
        };
        const followUpRuns = async () => (await readHeartbeatRunsByCompanyId(f.companyId))
          .filter((run) => run.id !== activeRunId && run.wakeupRequestId)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        return { ...f, issueId, threads, execute, reply, commentFor, finishActiveRun, followUpRuns };
      }

      it("answers each finding thread in its own run instead of one unattestable batch", async () => {
        const f = await findingThreadFixture();
        await f.reply(f.threads[0].thread, "First finding is intentional");
        await f.reply(f.threads[1].thread, "Second finding is fixed in the next commit");
        const first = await f.commentFor("First finding"), second = await f.commentFor("Second finding");
        await f.finishActiveRun();
        const runs = await f.followUpRuns();
        expect(runs.map((run) => ({ status: run.status, errorCode: run.errorCode, error: run.error })))
          .toEqual([{ status: "succeeded", errorCode: null, error: null }, { status: "succeeded", errorCode: null, error: null }]);
        expect(runs.map((run) => extractWakeCommentIds(run.contextSnapshot))).toEqual([[first], [second]]);
        expect(runs.map((run) => run.contextSnapshot?.chatConversationId))
          .toEqual(f.threads.map(({ conversation }) => conversation.id));
        expect(f.execute.mock.calls.map(([input]) => [input.context.paperclipExternalChatExecutionBound,
          extractWakeCommentIds(input.context)])).toEqual([[true, [first]], [true, [second]]]);
      });

      it("still batches several replies in one finding thread into one attested run", async () => {
        const f = await findingThreadFixture();
        await f.reply(f.threads[0].thread, "First note on this finding");
        await f.reply(f.threads[0].thread, "Second note on this finding");
        const ids = [await f.commentFor("First note"), await f.commentFor("Second note")];
        await f.finishActiveRun();
        const runs = await f.followUpRuns();
        expect(runs).toHaveLength(1);
        expect(runs[0]).toMatchObject({ status: "succeeded", errorCode: null });
        expect(extractWakeCommentIds(runs[0].contextSnapshot)).toEqual(ids);
        expect(f.execute).toHaveBeenCalledTimes(1);
      });

      it("still denies each separated finding-thread run after the linked identity is revoked", async () => {
        const f = await findingThreadFixture();
        await f.reply(f.threads[0].thread, "First finding is intentional");
        await f.reply(f.threads[1].thread, "Second finding is fixed in the next commit");
        await db.update(chatIdentityLinks).set({ status: "revoked", revokedAt: new Date() })
          .where(eq(chatIdentityLinks.principalId, f.principal.id));
        await f.finishActiveRun();
        const runs = await f.followUpRuns();
        expect(runs.length).toBeGreaterThan(0);
        for (const run of runs) expect(run).toMatchObject({ status: "failed", errorCode: "setup_failed" });
        expect(f.execute).not.toHaveBeenCalled();
      });
    });

    it.each([
      { label: "returns the confirmed GitHub assessment when publication takes longer than ten seconds", delayMs: 11_000, timeoutMs: undefined },
      { label: "preserves an explicit shorter GitHub tool deadline and reconciles without duplicate publication", delayMs: 200, timeoutMs: 50 },
    ])("recovers a durable GitHub publication receipt ($label)", async ({ delayMs, timeoutMs }) => {
      const f = await toolReplyFixture("github:paperclipai/paperclip:418", true);
      const head = "b".repeat(40);
      const checks: Record<string, unknown>[] = [];
      f.setSupplementalProviderFetch(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/pulls/418")) return Response.json({ number: 418, state: "open", draft: false,
          head: { sha: head }, base: { sha: "a".repeat(40), ref: "master" }, user: { id: 42, login: "octocat", type: "User" }, labels: [] });
        if (url.includes("/files?")) return Response.json([{ filename: "src/math.ts", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new" }]);
        if (url.includes("/check-runs?")) return Response.json({ check_runs: [] });
        if (url.includes("/check-runs") && init?.method) {
          checks.push(JSON.parse(String(init.body)));
          return Response.json({ id: 419, html_url: "https://github.com/checks/419" });
        }
        if (url.includes("/issues/comments/") && init?.method === "PATCH") {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
        return undefined;
      });
      vi.stubGlobal("fetch", f.providerFetch);
      onTestFinished(() => { vi.unstubAllGlobals(); });
      const { createToolGatewayService } = await import("../../services/tool-gateway.js");
      const gateway = createToolGatewayService(db);
      const session = await gateway.createSession({ companyId: f.companyId, agentId: f.assignedAgentId, runId: f.run.id });
      const tools = await githubBotToolsForSession(db, f.session);
      const tool = tools.find(tool => tool.upstreamToolName === "submit_review")!;
      await githubChatReviewService(db, f.providerFetch).execute(f.session, "begin_review", { reviewedCommit: head });
      const assessment = { reviewedCommit: head, score: 5, complete: true,
        summary: "Reviewed the changed behavior and its callers. ".repeat(30),
        rationale: "Checked the mutation boundary and the client retry contract. ".repeat(30),
        coverage: { reviewedPaths: ["src/math.ts"], omittedPaths: [], limitations: [] }, findings: [] };
      const result = await gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: assessment, timeoutMs })
        .then(value => ({ value }), error => ({ error }));
      await expect.poll(async () => {
        const [action] = await db.select().from(chatActions).where(and(eq(chatActions.endpointId, f.endpoint.id), eq(chatActions.kind, "github_review_publication")));
        return action?.status;
      }, { timeout: 15_000 }).toBe("processed");
      expect(f.responseComments.size).toBe(1);
      expect(f.responseWrites.map(write => write.method)).toEqual(["POST", "PATCH"]);
      expect(checks).toContainEqual(expect.objectContaining({ conclusion: "neutral", status: "completed" }));
      if (timeoutMs === undefined) {
        expect(result).toMatchObject({ value: { status: "completed", result: { data: { status: "processed", score: 5, conclusion: "neutral" } } } });
      } else {
        expect(result).toMatchObject({ error: { status: 504, reasonCode: "tool_timeout" } });
      }
      const writes = f.responseWrites.length;
      const replay = await gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: assessment });
      expect(replay).toMatchObject({ result: { data: { status: "processed", score: 5, conclusion: "neutral" } } });
      const [invocation] = await db.select().from(toolInvocations).where(eq(toolInvocations.id, replay.invocationId));
      expect(invocation).toMatchObject({ status: "succeeded", errorCode: null, errorMessage: null });
      expect(f.responseWrites).toHaveLength(writes);
    }, 40_000);

    it.each(["submit_review", "comment", "update_comment"] as const)("recovers long %s requests without accepting changes hidden by the audit preview", async name => {
      const f = await publicationRetryFixture();
      vi.stubGlobal("fetch", f.providerFetch);
      onTestFinished(() => { vi.unstubAllGlobals(); });
      const gateway = createToolGatewayService(db);
      const session = await gateway.createSession({ companyId: f.companyId, agentId: f.assignedAgentId, runId: f.run.id });
      const tool = (await githubBotToolsForSession(db, f.session)).find(tool => tool.upstreamToolName === name)!;
      const text = "Checked the changed behavior, connected callers, and coverage. ".repeat(30);
      const parameters = name === "submit_review"
        ? { ...f.assessment, summary: text, rationale: text, coverage: { ...f.assessment.coverage,
          limitations: Array.from({ length: 51 }, (_, index) => `Coverage limitation ${index}`) } }
        : { body: text, idempotencyKey: "long-publication" };
      const first = await gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters });
      const writes = f.responseWrites.length;
      const replay = await gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters });
      expect(replay).toMatchObject({ invocationId: first.invocationId, result: { data: { status: "processed" } } });
      if (name === "submit_review") {
        vi.stubEnv("PAPERCLIP_API_URL", "https://paperclip.example.test");
        onTestFinished(() => { vi.unstubAllEnvs(); });
        await initializeRunIdentity(db, { companyId: f.companyId, runId: f.run.id, issueId: f.conversation.issueId!,
          responsibleUserId: "owner-user", messageIds: [String(f.run.contextSnapshot?.wakeCommentId)], cause: "instruction" });
        const servers = await buildPaperclipRuntimeMcpServers({ db,
          agent: (await db.select().from(agents).where(eq(agents.id, f.assignedAgentId)))[0], runId: f.run.id });
        const assigned = await createAssignedMcpTools({ gateway,
          gatewayPublicId: new URL(servers[0].url).pathname.split("/").at(-1)!, bearerToken: servers[0].token });
        const found = await assigned.execute({ tool: "paperclip_search_assigned_tools", arguments: { query: "Submit a review assessment" } }) as { tools: { name: string }[] };
        const submit = found.tools.filter(candidate => candidate.name.includes("__submit_review_"));
        expect(submit).toHaveLength(1);
        expect(await assigned.execute({ tool: "paperclip_call_assigned_tool", arguments: { name: submit[0].name, arguments: parameters } }))
          .toMatchObject({ data: { status: "processed" } });
      }
      expect(f.responseWrites).toHaveLength(writes);
      expect(f.responseComments.size).toBe(1);
      const changed = name === "submit_review" ? { ...parameters, summary: `${text} Changed conclusion.` }
        : { ...parameters, body: `${text} Changed conclusion.` };
      await expect(gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: changed }))
        .rejects.toMatchObject({ status: 409, reasonCode: "github_idempotency_conflict" });
      if (name === "submit_review" && "coverage" in parameters) {
        const changedCoverage = { ...parameters, coverage: { ...parameters.coverage!,
          limitations: [...parameters.coverage!.limitations.slice(0, 50), "Changed final limitation"] } };
        await expect(gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: changedCoverage }))
          .rejects.toMatchObject({ status: 409, reasonCode: "github_idempotency_conflict" });
        const invalidCoverage = await gateway.executeTool({ sessionToken: session.token, tool: tool.name,
          parameters: { ...parameters, coverage: { ...parameters.coverage!, reviewedPaths: ["outside-this-pr.ts"] } } })
          .then(() => null, error => error);
        expect(invalidCoverage).toMatchObject({ status: 409,
          message: "Assessment coverage and findings must refer to this PR's allowed changed files" });
        expect(invalidCoverage).not.toHaveProperty("reasonCode");
      }
      await db.insert(toolPolicies).values({ companyId: f.companyId, name: "Revoke publication", policyType: "block", priority: 0,
        selectors: { catalogEntryId: tool.catalogEntryId! } });
      await expect(gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters })).rejects.toThrow();
      expect(f.responseWrites).toHaveLength(writes);
    });

    it("classifies recovered GitHub receipts without republishing or overwriting historical success", async () => {
      const f = await publicationRetryFixture();
      vi.stubGlobal("fetch", f.providerFetch);
      onTestFinished(() => { vi.unstubAllGlobals(); });
      const { aiConnectionService } = await import("../../services/ai-connections.js");
      const { promptInjectionPreventionService } = await import("../../services/prompt-injection-prevention.js");
      const { promptInjectionInvocations } = await import("@paperclipai/db");
      const binding = await aiConnectionService(db).save(f.companyId, "owner-user", { provider: "openrouter", method: "api_key",
        name: "Classifier", ownership: "shared", apiKey: "fixture-key", allAgents: true, agentIds: [] }, "fixture-key");
      await promptInjectionPreventionService(db).configure(f.companyId, "owner-user", { ...binding, enabled: true, model: "openai/gpt-oss-safeguard-20b" });
      const provider = vi.fn().mockResolvedValue({ verdict: { violation: false, findings: [] }, receipt: {
        inputTokens: 100, outputTokens: 10, costCents: "0.001", costStatus: "reported", providerRequestId: "fixture",
        pricingProvenance: { source: "provider_reported" },
      } });
      await initializeRunIdentity(db, { companyId: f.companyId, runId: f.run.id, issueId: f.conversation.issueId!, responsibleUserId: null, cause: "company_default" });
      const gateway = createToolGatewayService(db, { toolActionSigningSecret: "classifier-replay-test", promptInjectionProvider: provider });
      const session = await gateway.createSession({ companyId: f.companyId, agentId: f.assignedAgentId, runId: f.run.id });
      const tool = (await githubBotToolsForSession(db, f.session)).find(t => t.upstreamToolName === "submit_review")!;
      await db.insert(toolPolicies).values({ companyId: f.companyId, name: "Approve publication", policyType: "require_approval", priority: 0, selectors: { catalogEntryId: tool.catalogEntryId! } });
      const input = { sessionToken: session.token, tool: tool.name, parameters: f.assessment };
      await expect(gateway.executeTool(input)).rejects.toMatchObject({ reasonCode: "approval_required" });
      const [approval] = await db.select().from(toolActionRequests).where(eq(toolActionRequests.companyId, f.companyId));
      await gateway.approveActionRequest({ companyId: f.companyId, actionRequestId: approval.id, actor: { userId: "owner-user" } });
      const writes = f.responseWrites.length;
      const [before] = await db.select().from(toolInvocations).where(eq(toolInvocations.id, approval.invocationId));
      expect(before.status).toBe("succeeded");
      provider.mockResolvedValue({ ...(await provider.mock.results[0].value),
        verdict: { violation: true, findings: ["instruction_hijack"] } });
      await expect(gateway.executeTool(input)).rejects.toMatchObject({ reasonCode: "prompt_injection_blocked" });
      expect(f.responseWrites).toHaveLength(writes); expect(f.responseComments.size).toBe(1);
      expect((await db.select().from(toolInvocations).where(eq(toolInvocations.id, approval.invocationId)))[0]).toMatchObject({ status: "succeeded", resultHash: before.resultHash });
      const classifications = await db.select().from(promptInjectionInvocations).where(eq(promptInjectionInvocations.companyId, f.companyId));
      expect(classifications).toHaveLength(2); expect(classifications.map(c => c.violation)).toEqual([false, true]);
      expect(classifications.every(c => c.toolInvocationId === approval.invocationId && c.costEventId)).toBe(true);
    });

    it.each(["begin_review", "submit_review"] as const)("recovers %s after a timeout before publication staging", async name => {
      const f = await publicationRetryFixture();
      let release!: () => void;
      const blocked = new Promise<void>(resolve => { release = resolve; });
      let metadataReads = 0;
      f.setSupplementalProviderFetch(async (input, init) => {
        if (String(input).endsWith("/pulls/418") && metadataReads++ === 0) {
          await blocked;
          throw new Error("Connection closed before PR metadata arrived");
        }
        return f.provider(input, init);
      });
      vi.stubGlobal("fetch", f.providerFetch);
      onTestFinished(() => { release(); vi.unstubAllGlobals(); });
      const gateway = createToolGatewayService(db);
      const session = await gateway.createSession({ companyId: f.companyId, agentId: f.assignedAgentId, runId: f.run.id });
      const tool = (await githubBotToolsForSession(db, f.session)).find(tool => tool.upstreamToolName === name)!;
      const parameters = name === "begin_review" ? { reviewedCommit: f.head } : f.assessment;
      const input = { sessionToken: session.token, tool: tool.name, parameters };
      await expect(gateway.executeTool({ ...input, timeoutMs: 50 })).rejects.toMatchObject({ reasonCode: "tool_timeout" });
      expect(await f.action()).toBeUndefined();
      release();
      const retry = await gateway.executeTool(input);
      expect(retry).toMatchObject({ result: { data: name === "begin_review"
        ? { reviewedCommit: f.head, state: "running" }
        : { status: "processed", score: 3, conclusion: "neutral" } } });
      const writes = f.responseWrites.length;
      expect(await gateway.executeTool(input)).toMatchObject({ invocationId: retry.invocationId,
        result: { data: name === "begin_review" ? { reviewedCommit: f.head } : { status: "processed" } } });
      expect(f.responseWrites).toHaveLength(writes);
      expect(f.responseComments.size).toBe(1);
    });

    it("stages one assessment when the timed-out metadata read completes alongside its retry", async () => {
      const f = await publicationRetryFixture();
      let release!: () => void;
      const blocked = new Promise<void>(resolve => { release = resolve; });
      let metadataReads = 0;
      f.setSupplementalProviderFetch(async (input, init) => {
        if (String(input).endsWith("/pulls/418") && metadataReads++ === 0) await blocked;
        return f.provider(input, init);
      });
      vi.stubGlobal("fetch", f.providerFetch);
      onTestFinished(() => { release(); vi.unstubAllGlobals(); });
      const gateway = createToolGatewayService(db);
      const session = await gateway.createSession({ companyId: f.companyId, agentId: f.assignedAgentId, runId: f.run.id });
      const tool = (await githubBotToolsForSession(db, f.session)).find(tool => tool.upstreamToolName === "submit_review")!;
      const input = { sessionToken: session.token, tool: tool.name, parameters: f.assessment };
      await expect(gateway.executeTool({ ...input, timeoutMs: 50 })).rejects.toMatchObject({ reasonCode: "tool_timeout" });
      const retry = gateway.executeTool(input);
      release();
      expect(await retry).toMatchObject({ result: { data: { actionId: expect.any(String) } } });
      // A replay may return the durable receipt while the timed-out request
      // still publishes. Observe the owner's bounded retry window, not the
      // assertion library's one-second default.
      await expect.poll(async () => (await f.action())?.status,
        { timeout: GITHUB_INLINE_RETRY_WINDOW_MS }).toBe("processed");
      expect(await gateway.executeTool(input)).toMatchObject({ result: { data: { status: "processed" } } });
      const actions = await db.select().from(chatActions).where(and(eq(chatActions.endpointId, f.endpoint.id),
        eq(chatActions.kind, "github_review_publication")));
      expect(actions).toHaveLength(1);
      expect(actions[0].status).toBe("processed");
      expect(f.responseComments.size).toBe(1);
      expect(f.responseWrites.map(write => write.method)).toEqual(["POST", "PATCH"]);
    }, 60_000);

    it("rejects changed requests and revoked access before repeating an unstaged review", async () => {
      const f = await publicationRetryFixture();
      let metadataReads = 0;
      let unavailable = true;
      f.setSupplementalProviderFetch(async (input, init) => {
        if (String(input).endsWith("/pulls/418")) {
          metadataReads++;
          if (unavailable) throw new Error("Connection closed before PR metadata arrived");
        }
        return f.provider(input, init);
      });
      vi.stubGlobal("fetch", f.providerFetch);
      onTestFinished(() => { vi.unstubAllGlobals(); });
      const gateway = createToolGatewayService(db);
      const session = await gateway.createSession({ companyId: f.companyId, agentId: f.assignedAgentId, runId: f.run.id });
      const tool = (await githubBotToolsForSession(db, f.session)).find(tool => tool.upstreamToolName === "submit_review")!;
      const input = { sessionToken: session.token, tool: tool.name, parameters: f.assessment, idempotencyKey: "preflight-request" };
      await expect(gateway.executeTool(input)).rejects.toThrow("GitHub is temporarily unavailable");
      unavailable = false;
      const failedReads = metadataReads;
      await expect(gateway.executeTool({ ...input, parameters: { ...f.assessment, summary: "Changed assessment" } }))
        .rejects.toMatchObject({ reasonCode: "github_publication_unavailable" });
      expect(await f.action()).toBeUndefined();
      expect(metadataReads).toBe(failedReads);
      await db.insert(toolPolicies).values({ companyId: f.companyId, name: "Revoke review", policyType: "block", priority: 0,
        selectors: { catalogEntryId: tool.catalogEntryId! } });
      await expect(gateway.executeTool(input)).rejects.toThrow();
      expect(await f.action()).toBeUndefined();
      expect(metadataReads).toBe(failedReads);
      expect(f.responseWrites.map(write => write.method)).toEqual(["POST"]);
    });

    it("reads pending GitHub receipts without dispatch and refuses a missing publication", async () => {
      const f = await publicationRetryFixture();
      let attempts = 0;
      let unavailable = true;
      f.setSupplementalProviderFetch(async (input, init) => {
        if (String(input).includes("/issues/comments/") && init?.method === "PATCH") {
          attempts++;
          if (unavailable) return new Response("Unavailable", { status: 503, headers: { "retry-after": "120" } });
        }
        return f.provider(input, init);
      });
      vi.stubGlobal("fetch", f.providerFetch);
      onTestFinished(() => { vi.unstubAllGlobals(); });
      const gateway = createToolGatewayService(db);
      const session = await gateway.createSession({ companyId: f.companyId, agentId: f.assignedAgentId, runId: f.run.id });
      const tool = (await githubBotToolsForSession(db, f.session)).find(tool => tool.upstreamToolName === "submit_review")!;
      const input = { sessionToken: session.token, tool: tool.name, parameters: { ...f.assessment, summary: "Review evidence. ".repeat(50) } };
      const first = await gateway.executeTool(input);
      expect(first).toMatchObject({ result: { data: { status: "failed", receipt: { retryable: true } } } });
      unavailable = false;
      expect(await gateway.executeTool(input)).toMatchObject({ invocationId: first.invocationId,
        result: { data: { status: "failed", receipt: { retryable: true } } } });
      expect(attempts).toBe(1);
      const action = await f.action();
      await db.update(chatActions).set({ result: { ...action.result, retryAt: new Date(0).toISOString() } }).where(eq(chatActions.id, action.id));
      await githubChatReviewService(db, f.providerFetch).processPending();
      expect(await gateway.executeTool(input)).toMatchObject({ invocationId: first.invocationId, result: { data: { status: "processed" } } });
      expect(attempts).toBe(2);
      expect(f.responseComments.size).toBe(1);
      const writes = f.responseWrites.length;
      await db.delete(chatActions).where(eq(chatActions.id, action.id));
      await expect(gateway.executeTool(input)).rejects.toMatchObject({ status: 409, reasonCode: "github_publication_unavailable" });
      expect(attempts).toBe(2);
      expect(f.responseWrites).toHaveLength(writes);
    });

    it("restores terminal GitHub responses and leaves finalized history quiet", async () => {
      const f = await toolReplyFixture();
      await db.update(heartbeatRuns).set({ status: "failed", updatedAt: new Date() }).where(eq(heartbeatRuns.id, f.run.id));
      const errors: unknown[] = [];
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
      const worker = githubResponseCommentService(db, f.providerFetch).registerTerminalResponseWork(coordinator, () => true);
      try {
        await worker.ready;
        await expect.poll(() => [...f.responseComments.values()][0]?.body, { timeout: 5000 }).toContain("stopped before completing");
        await expect.poll(() => ({ next: coordinator.nextWakeAt(), active: idleWorkSnapshot().active }),
          { timeout: 5000 }).toEqual({ next: null, active: 0 });
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
        const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction");
        try {
          const providerWrites = f.responseWrites.length;
          await vi.advanceTimersByTimeAsync(120_000);
          expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
          expect(f.responseWrites).toHaveLength(providerWrites);
        } finally { reads.mockRestore(); writes.mockRestore(); }
        expect(errors).toEqual([]);
      } finally { await coordinator.stop(); vi.useRealTimers(); }
    });

    it("settles a deleted Board-origin request without starving unrelated terminal GitHub replies", async () => {
      const invalid = await toolReplyFixture();
      const valid = await toolReplyFixture();
      const [message] = await db.insert(issueComments).values({ companyId: invalid.companyId,
        issueId: invalid.conversation.issueId!, authorType: "user", authorUserId: "owner-user", body: "Board follow-up",
      }).returning();
      await initializeRunIdentity(db, { companyId: invalid.companyId, runId: invalid.run.id,
        issueId: invalid.conversation.issueId!, responsibleUserId: "owner-user", messageIds: [message.id], cause: "instruction" });
      await db.update(issueComments).set({ deletedAt: new Date() }).where(eq(issueComments.id, message.id));
      await db.update(heartbeatRuns).set({ status: "failed", updatedAt: new Date() })
        .where(inArray(heartbeatRuns.id, [invalid.run.id, valid.run.id]));
      const invalidWrites = invalid.responseWrites.length;
      const errors: unknown[] = [];
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
      // The denied request must never reach transport; only the valid request
      // uses this provider, even though discovery covers both companies.
      const responses = githubResponseCommentService(db, valid.providerFetch);
      try {
        await responses.registerTerminalResponseWork(coordinator, () => true).ready;
        await expect.poll(() => [...valid.responseComments.values()][0]?.body, { timeout: 5000 })
          .toContain("stopped before completing");
        const [denied] = await db.select().from(chatActions).where(and(eq(chatActions.endpointId, invalid.endpoint.id),
          eq(chatActions.kind, "github_response_comment")));
        expect(denied).toMatchObject({ status: "cancelled", result: { retryable: false, code: "authorization_changed" } });
        expect(invalid.responseWrites).toHaveLength(invalidWrites);
        expect(valid.responseWrites.map(write => write.method)).toEqual(["POST", "PATCH"]);
        await expect.poll(() => ({ next: coordinator.nextWakeAt(), active: idleWorkSnapshot().active }),
          { timeout: 5000 }).toEqual({ next: null, active: 0 });
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
        const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction");
        try {
          await vi.advanceTimersByTimeAsync(120_000);
          expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
          expect(valid.responseWrites.map(write => write.method)).toEqual(["POST", "PATCH"]);
        } finally { reads.mockRestore(); writes.mockRestore(); }
        expect(errors).toEqual([]);
      } finally { await coordinator.stop(); vi.useRealTimers(); }
    });

    it.each(["passive", "missing"] as const)("keeps native presentation idle until its committed GitHub outcome: %s", async outcome => {
      const f = await toolReplyFixture("github:paperclipai/paperclip:418");
      await db.update(heartbeatRuns).set({ status: "succeeded", nativePhase: "observed", resultJson: null })
        .where(eq(heartbeatRuns.id, f.run.id));
      const [action] = await db.select().from(chatActions).where(and(eq(chatActions.endpointId, f.endpoint.id),
        eq(chatActions.kind, "github_response_comment")));
      expect(action.status).toBe("processed");
      const baseline = f.responseWrites.length, originalBody = [...f.responseComments.values()][0].body;
      const errors: unknown[] = [];
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
      try {
        await githubResponseCommentService(db, f.providerFetch).registerTerminalResponseWork(coordinator, () => true).ready;
        await expect.poll(() => ({ next: coordinator.nextWakeAt(), active: idleWorkSnapshot().active }), { timeout: 5000 })
          .toEqual({ next: null, active: 0 });
        expect(f.responseWrites).toHaveLength(baseline);
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
        const readStacks: string[] = [], select = db.select;
        const reads = vi.spyOn(db, "select").mockImplementation((...args) => {
          if (readStacks.length < 5) readStacks.push(new Error("Unexpected idle database read").stack ?? "Stack unavailable");
          return Reflect.apply(select, db, args);
        }), writes = vi.spyOn(db, "transaction");
        try {
          await vi.advanceTimersByTimeAsync(120_000);
          expect(reads, readStacks.join("\n\n")).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
          expect(f.responseWrites).toHaveLength(baseline);
        } finally { reads.mockRestore(); writes.mockRestore(); vi.useRealTimers(); }
        const settlePresentation = async (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => {
          await notifyChatRunMilestones(tx, { companyId: f.companyId, issueId: f.conversation.issueId! });
          await tx.update(heartbeatRuns).set({ nativePhase: "committed", updatedAt: new Date(), resultJson: {
            finalizationPhase: "committed", finalizationReasonCode: outcome === "passive" ? "external_chat_response_waiting" : "completed",
            nativeResult: { schema: "paperclip.run_result.v1", reportedWorkDisposition: outcome === "passive" ? "yielded" : "completed",
              continuation: outcome === "passive" ? { kind: "response_wake", idempotencyKey: "settled-presentation" } : null },
            presentationDecision: { schema: "paperclip.run_presentation_decision.v1", chosenSource: "none", commentAction: "none",
              reasonCodes: [outcome === "passive" ? "yielded_control_plane_wait" : "no_final_response"] },
          } }).where(eq(heartbeatRuns.id, f.run.id));
        };
        await expect(db.transaction(async tx => { await settlePresentation(tx); throw new Error("rollback presentation"); }))
          .rejects.toThrow("rollback presentation");
        expect(f.responseWrites).toHaveLength(baseline);
        expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0].nativePhase).toBe("observed");
        await db.transaction(settlePresentation);
        await expect.poll(async () => (await readChatActionsById(action.id))[0], { timeout: 5000 }).toMatchObject({
          status: outcome === "passive" ? "cancelled" : "processed", result: { final: true },
        });
        if (outcome === "passive") {
          expect(f.responseWrites).toHaveLength(baseline);
          expect([...f.responseComments.values()][0].body).toBe(originalBody);
        } else expect([...f.responseComments.values()][0].body).toContain("without publishing a final response");
        await expect.poll(() => ({ next: coordinator.nextWakeAt(), active: idleWorkSnapshot().active }), { timeout: 5000 })
          .toEqual({ next: null, active: 0 });
        expect(errors).toEqual([]);
      } finally { await coordinator.stop(); vi.useRealTimers(); }
    });

    it("wakes terminal GitHub responses after the outer issue transaction commits", async () => {
      const f = await toolReplyFixture();
      const errors: unknown[] = [];
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
      const worker = githubResponseCommentService(db, f.providerFetch).registerTerminalResponseWork(coordinator, () => true);
      try {
        await worker.ready;
        const baseline = f.responseWrites.length;
        const change = async (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => {
          await tx.update(heartbeatRuns).set({ status: "failed", updatedAt: new Date() }).where(eq(heartbeatRuns.id, f.run.id));
          await issueService(tx as unknown as Db).update(f.conversation.issueId!, { status: "blocked" });
        };
        await expect(db.transaction(async tx => { await change(tx); throw new Error("rollback terminal issue"); }))
          .rejects.toThrow("rollback terminal issue");
        expect(f.responseWrites).toHaveLength(baseline);
        let release!: () => void, entered!: () => void;
        const hold = new Promise<void>(resolve => { release = resolve; });
        const ready = new Promise<void>(resolve => { entered = resolve; });
        const pending = db.transaction(async tx => { await change(tx); entered(); await hold; });
        try { await ready; expect(f.responseWrites).toHaveLength(baseline); }
        finally { release(); await pending; }
        await expect.poll(() => [...f.responseComments.values()][0]?.body, { timeout: 5000 }).toContain("stopped before completing");
        await expect.poll(() => coordinator.nextWakeAt(), { timeout: 5000 }).toBeNull();
        expect(errors).toEqual([]);
      } finally { await coordinator.stop(); }
    });

    it("keeps an acknowledged paused GitHub request quiet until its new run finishes", async () => {
      const f = await toolReplyFixture("github:paperclipai/paperclip:418");
      await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, f.run.id));
      await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, f.conversation.issueId!));
      const thread = makeThread({ channelId: "paperclipai/paperclip", id: f.conversation.externalThreadId }).thread;
      await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
        trigger: "mention", message: makeMessage({ id: "41802", text: "New request", userId: "42", userName: "octocat", mentioned: true }) });
      const responses = githubResponseCommentService(db, f.providerFetch);
      await responses.processPending();
      expect([...f.responseComments.values()][0].body).toContain("paused");
      const errors: unknown[] = [];
      let coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
      try {
        await responses.registerTerminalResponseWork(coordinator, () => true).ready;
        await expect.poll(() => coordinator.nextWakeAt(), { timeout: 5000 }).toBeNull();
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
        const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction");
        const providerWrites = f.responseWrites.length;
        await vi.advanceTimersByTimeAsync(120_000);
        expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
        expect(f.responseWrites).toHaveLength(providerWrites);
        reads.mockRestore(); writes.mockRestore(); vi.useRealTimers();
        await coordinator.stop();
        await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, f.conversation.issueId!));
        await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.assignedAgentId,
          status: "failed", runtimeMode: "native", contextSnapshot: await chatWakeContext({
            endpointId: f.endpoint.id, issueId: f.conversation.issueId, provider: "github", providerMessageId: "41802",
          }) });
        coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
        await responses.registerTerminalResponseWork(coordinator, () => true).ready;
        await expect.poll(() => [...f.responseComments.values()][0]?.body, { timeout: 5000 }).toContain("stopped before completing");
        await expect.poll(() => coordinator.nextWakeAt(), { timeout: 5000 }).toBeNull(); expect(errors).toEqual([]);
      } finally { await coordinator.stop(); vi.useRealTimers(); }
    });

    it.each(["restart", "drain", "standby"] as const)("retains terminal GitHub response work across %s", async mode => {
      const f = await toolReplyFixture();
      let canRun = true;
      const errors: unknown[] = [];
      let coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => canRun,
        canReconcile: () => mode !== "standby" || canRun, onError: error => errors.push(error) });
      const responses = githubResponseCommentService(db, f.providerFetch);
      let worker = responses.registerTerminalResponseWork(coordinator, () => canRun);
      try {
        await worker.ready;
        const baseline = f.responseWrites.length;
        if (mode === "restart") await coordinator.stop(); else canRun = false;
        await db.update(heartbeatRuns).set({ status: "failed", updatedAt: new Date() }).where(eq(heartbeatRuns.id, f.run.id));
        await issueService(db).update(f.conversation.issueId!, { status: "blocked" });
        expect(f.responseWrites).toHaveLength(baseline);
        if (mode === "restart") {
          coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
          worker = responses.registerTerminalResponseWork(coordinator, () => true);
          await worker.ready;
        } else { canRun = true; worker.wake(); }
        await expect.poll(() => [...f.responseComments.values()][0]?.body, { timeout: 5000 }).toContain("stopped before completing");
        await expect.poll(() => coordinator.nextWakeAt(), { timeout: 5000 }).toBeNull();
        expect(errors).toEqual([]);
      } finally { await coordinator.stop(); }
    });

    it("reactivates terminal GitHub response recovery from committed native identity", async () => {
      const f = await toolReplyFixture();
      const messageId = String(f.run.contextSnapshot?.wakeCommentId);
      await db.update(heartbeatRuns).set({ status: "failed", nativeIssueId: f.conversation.issueId,
        contextSnapshot: {}, updatedAt: new Date() }).where(eq(heartbeatRuns.id, f.run.id));
      const errors: unknown[] = [];
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
      try {
        await githubResponseCommentService(db, f.providerFetch).registerTerminalResponseWork(coordinator, () => true).ready;
        await expect.poll(() => coordinator.nextWakeAt(), { timeout: 5000 }).toBeNull();
        const baseline = f.responseWrites.length;
        await expect(db.transaction(async tx => {
          await initializeRunIdentity(tx as unknown as Db, { companyId: f.companyId, runId: f.run.id, issueId: f.conversation.issueId!,
            responsibleUserId: "owner-user", messageIds: [messageId], cause: "instruction" });
          throw new Error("rollback identity");
        })).rejects.toThrow("rollback identity");
        expect(f.responseWrites).toHaveLength(baseline);
        await initializeRunIdentity(db, { companyId: f.companyId, runId: f.run.id, issueId: f.conversation.issueId!,
          responsibleUserId: "owner-user", messageIds: [messageId], cause: "instruction" });
        await expect.poll(() => [...f.responseComments.values()][0]?.body, { timeout: 5000 }).toContain("stopped before completing");
        await expect.poll(() => coordinator.nextWakeAt(), { timeout: 5000 }).toBeNull();
        expect(errors).toEqual([]);
      } finally { await coordinator.stop(); }
    });
});
