import { nativeResponsePresentationWork } from "../../services/native-runtime/native-response-presentation-work.js";
import { notifyChatRunMilestones } from "../../services/chat-run-milestone-notifications.js";
import { issueTreeControlService } from "../../services/issue-tree-control.js";
import { chatInboundWakeNoticeWork } from "../../services/chat-inbound-wake-notice-work.js";
import { agentWakeupRequests, agents, chatActions, chatConversations, chatEndpointResources, chatEndpoints, chatMessageLinks, chatPublications, companyMemberships, createDb, heartbeatRunEvents, heartbeatRuns, issueComments, issueThreadInteractions, issues, nativeRunFinalizations, projects, signalDatabaseWork, statusDecisionEffects, subscribeDatabaseWork } from "@paperclipai/db";
import { claimTaskRetryInput, releaseUnadmittedTaskRetryInput } from "../../services/chat-channels/task-retry-input.js";
import { restoreNativeChatReviewPresentationInTransaction } from "../../services/native-runtime/native-chat-review-presentation.js";
import { configureAgentLifecycle, createAgentLifecycle, processAgentLifecycle } from "../../services/agent-lifecycle.js";
import { idleWorkSnapshot } from "../../services/task-admission.js";
import type { Db } from "@paperclipai/db";
import { createFullDatabaseResponseCapture, installDatabaseResponseCapture } from ".././helpers/full-database-response-capture.js";
import { createDeliveryWorkCoordinator } from "../../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../../services/delivery-work-notifications.js";
import { randomUUID } from "node:crypto";
import express, {  } from "express";
import request, {  } from "supertest";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { issueRoutes } from "../../routes/issues.js";
import { type ChatChannelService } from "../../services/chat-channels.js";
import { issueService } from "../../services/issues.js";
import { companyService } from "../../services/companies.js";
import { ensureProjectAccessMember } from "../../services/projects.js";
import { createPostgresWakeQueueAdapter } from "../../modules/wake-queue/adapters/postgres.js";
import { enqueueChatRunMilestones } from "../../services/chat-run-publications.js";
import { heartbeatService } from "../../services/heartbeat.js";
import { recoverCommittedNativeChatResponse } from "../../services/native-runtime/native-run-finalizer.js";
import { NativeRunCoordinatorStore } from "../../services/native-runtime/native-run-coordinator-store.js";
import { PaperclipControlPlanePort } from "../../services/native-runtime/paperclip-control-plane-port.js";
import { boardActor, externalTestDatabaseUrl } from ".././helpers/chat-channels-fixture.js";
import {
addSelectedChatFinal,
committedChatResponseRecoveryFixture,
createService,
createStorageService,
db,
describeChatChannelsSuite,
qualifySetupRoundTrip,
readAgentWakeupRequestsById,
readChatPublicationsByCommentId,
readChatPublicationsByEndpointId,
readChatPublicationsByIdempotencyKey,
readHeartbeatRunsByCompanyId,
readHeartbeatRunsById,
signedSlackWebhookRequest,
tempDb
} from "../helpers/chat-channels-harness.js";
import {
committedNativeReviewPublicationFixture,
deferredChatQueueFixture
} from "../helpers/chat-channels-endpoint-fixtures.js";












describeChatChannelsSuite("chat channels 43-retains-the-first-accepted-response-wake", () => {
  it("retains the first accepted-response wake through idle drain without passive SQL", async () => {
    const context = await committedChatResponseRecoveryFixture("telegram");
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, context.runId));
    let canRun = true;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => canRun, canReconcile: () => true, onError: error => errors.push(error) });
    const worker = nativeResponsePresentationWork(db).register(coordinator, () => canRun);
    try {
      await worker.ready;
      await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }),
        { timeout: 10_000 }).toEqual({ active: 0, next: null });
      canRun = false;
      await db.transaction(async tx => {
        await notifyChatRunMilestones(tx, { companyId: context.fixture.companyId, issueId: context.issue.id });
        await tx.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, context.runId));
      });
      await expect.poll(() => idleWorkSnapshot().active, { timeout: 5000 }).toBe(0);
      expect(coordinator.nextWakeAt()).not.toBeNull();
      const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction");
      try {
        await vi.advanceTimersByTimeAsync(120_000);
        expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
      } finally { reads.mockRestore(); writes.mockRestore(); }
      canRun = true; worker.wake();
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(1000);
        expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(1);
        expect(coordinator.nextWakeAt()).toBeNull();
      }, { timeout: 5000 });
      expect(errors).toEqual([]);
    } finally { worker.stop(); await coordinator.stop(); vi.useRealTimers(); await context.service.shutdown(); }
  });

  it("retains a failed accepted-response attempt across drain and retries after resume", async () => {
    const context = await committedChatResponseRecoveryFixture("telegram");
    let release!: () => void, observed!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { observed = resolve; });
    const holder = db.transaction(async tx => {
      await tx.select().from(chatActions).where(eq(chatActions.id, context.action.id)).for("update");
      observed();
      await hold;
    });
    await locked;
    let canRun = true;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => canRun, canReconcile: () => true, onError: error => errors.push(error) });
    const worker = nativeResponsePresentationWork(db).register(coordinator, () => canRun);
    try {
      await worker.ready;
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(1000);
        expect(errors).toHaveLength(1);
        expect(idleWorkSnapshot().active).toBe(0);
      }, { timeout: 5000 });
      expect(coordinator.nextWakeAt()).toBeGreaterThan(Date.now());
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(0);
      canRun = false;
      const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction");
      try {
        await vi.advanceTimersByTimeAsync(120_000);
        expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
      } finally { reads.mockRestore(); writes.mockRestore(); }
      release(); await holder;
      canRun = true; worker.wake();
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(1000);
        expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(1);
        expect(idleWorkSnapshot().active).toBe(0);
        expect(coordinator.nextWakeAt()).toBeNull();
      }, { timeout: 5000 });
      expect(errors).toHaveLength(1);
    } finally { release(); await holder; worker.stop(); await coordinator.stop(); vi.useRealTimers(); await context.service.shutdown(); }
  });

  it("reconstructs a future accepted-response deadline without early publication", async () => {
    const context = await committedChatResponseRecoveryFixture("telegram");
    const at = new Date(Date.now() + 60_000);
    await db.update(nativeRunFinalizations).set({ nextAttemptAt: at }).where(eq(nativeRunFinalizations.runId, context.runId));
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const worker = nativeResponsePresentationWork(db).register(coordinator, () => true);
    try {
      await worker.ready;
      await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }),
        { timeout: 10_000 }).toEqual({ active: 0, next: at.getTime() });
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(Math.max(0, at.getTime() - Date.now()));
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(1000);
        expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(1);
        expect(coordinator.nextWakeAt()).toBeNull();
      }, { timeout: 5000 });
      expect(errors).toEqual([]);
    } finally { worker.stop(); await coordinator.stop(); vi.useRealTimers(); await context.service.shutdown(); }
  });

  it("retains an accepted-response deadline that elapses during the locked recovery check", async () => {
    const context = await committedChatResponseRecoveryFixture("telegram");
    const work = nativeResponsePresentationWork(db);
    const [entry] = await work.load({ companyId: context.fixture.companyId });
    expect(entry?.id).toBe(context.runId);
    vi.useFakeTimers({ toFake: ["Date"] });
    const due = new Date(Date.now() + 1000);
    const transaction = db.transaction.bind(db);
    const intercept = vi.spyOn(db, "transaction").mockImplementationOnce((async (callback, options) => {
      await transaction(async tx => {
        await tx.update(nativeRunFinalizations).set({ nextAttemptAt: due }).where(eq(nativeRunFinalizations.runId, context.runId));
      });
      const result = await transaction(callback, options);
      vi.setSystemTime(due.getTime() + 1);
      return result;
    }) as Db["transaction"]);
    try {
      const deferred = await work.check(entry);
      intercept.mockRestore();
      expect(deferred).toEqual({ ...entry, dueAt: due.getTime() });
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(0);
      await expect(work.check(deferred!)).resolves.toBeNull();
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(1);
    } finally { intercept.mockRestore(); vi.useRealTimers(); await context.service.shutdown(); }
  });

  it("wakes dormant accepted-response recovery after agent resume", async () => {
    const context = await committedChatResponseRecoveryFixture("telegram");
    await db.update(agents).set({ status: "paused", lifecycleState: "paused", lifecycleHolds: ["manual"], lifecycleOperation: null })
      .where(eq(agents.id, context.binding.agentId));
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const work = nativeResponsePresentationWork(db);
    const worker = work.register(coordinator, () => true);
    const lifecycle = configureAgentLifecycle(db, {
      requiredPluginIds: async () => [], runHost: async () => "complete", runPlugin: async () => "complete",
    });
    try {
      await worker.ready;
      await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }),
        { timeout: 10_000 }).toEqual({ active: 0, next: null });
      expect(await work.load({ companyId: context.fixture.companyId, agentId: randomUUID() })).toEqual([]);
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(0);
      await createAgentLifecycle(db).resumeAgent(context.binding.agentId);
      await processAgentLifecycle(db, context.binding.agentId);
      await expect.poll(async () => (await db.select().from(agents).where(eq(agents.id, context.binding.agentId)))[0].status).toBe("idle");
      await expect.poll(async () => (await readChatPublicationsByEndpointId(context.endpoint.id)).length, { timeout: 5000 }).toBe(1);
      await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }),
        { timeout: 10_000 }).toEqual({ active: 0, next: null });
      expect(errors).toEqual([]);
    } finally { await lifecycle.stop(); worker.stop(); await coordinator.stop(); await context.service.shutdown(); }
  });

  it("wakes accepted-response recovery from the real coordinator retry release", async () => {
    const context = await committedChatResponseRecoveryFixture("telegram");
    const store = new NativeRunCoordinatorStore(db, context.binding);
    await store.claimFinalization({ leaseOwner: "response-recovery-fixture", leaseTtlMs: 1000 });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const worker = nativeResponsePresentationWork(db).register(coordinator, () => true);
    try {
      await worker.ready;
      await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }),
        { timeout: 10_000 }).toEqual({ active: 0, next: null });
      await vi.advanceTimersByTimeAsync(2000);
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(0);
      expect(coordinator.nextWakeAt()).toBeNull();
      await store.markFinalizationRetry({ leaseOwner: "response-recovery-fixture", failureCode: "response_fixture_retry", retryAfterMs: 1000 });
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(1000);
        expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(1);
        expect(idleWorkSnapshot().active).toBe(0);
        expect(coordinator.nextWakeAt()).toBeNull();
      }, { timeout: 5000 });
      expect(errors).toEqual([]);
    } finally { worker.stop(); await coordinator.stop(); vi.useRealTimers(); await context.service.shutdown(); }
  });

  it("wakes accepted-response recovery when its authenticated accepted-result journal arrives late", async () => {
    const context = await committedChatResponseRecoveryFixture("telegram", "port");
    await db.delete(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, context.runId), eq(heartbeatRunEvents.eventType, "run.result.accepted")));
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const worker = nativeResponsePresentationWork(db).register(coordinator, () => true);
    try {
      await worker.ready;
      await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }),
        { timeout: 10_000 }).toEqual({ active: 0, next: null });
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(0);
      const port = new PaperclipControlPlanePort(db, {
        companyId: context.binding.companyId, issueId: context.binding.issueId,
        runId: context.runId, agentId: context.binding.agentId, sessionId: context.binding.normalizedSessionId,
        completionContractId: context.binding.completionContractId,
        completionContractSha256: context.binding.completionContractSha256,
        sourceInstanceId: context.binding.runnerSourceInstanceId, controlPlaneSourceInstanceId: `control-${context.runId}`,
      });
      await port.appendEvent({
        schema: "paperclip.prp.event.v1", sourceEventId: `accepted-${context.runId}`, sourceSeq: 1,
        sourceInstanceId: `control-${context.runId}`, sourceKind: "control_plane",
        runId: context.runId, normalizedSessionId: context.binding.normalizedSessionId,
        turnId: `turn-${context.runId}`, eventType: "run.result.accepted", schemaVersion: 1,
        priority: 0, emittedAt: new Date().toISOString(), payload: { result: context.result },
      });
      await expect.poll(async () => ({
        publications: (await readChatPublicationsByEndpointId(context.endpoint.id)).length,
        active: idleWorkSnapshot().active, next: coordinator.nextWakeAt(),
      }), { timeout: 5000 }).toEqual({ publications: 1, active: 0, next: null });
      expect(errors).toEqual([]);
    } finally { worker.stop(); await coordinator.stop(); await context.service.shutdown(); }
  });

  it("defers scheduled accepted-response recovery until the persisted retry is due", async () => {
    const context = await committedChatResponseRecoveryFixture("telegram");
    const input = { companyId: context.fixture.companyId, issueId: context.issue.id, runId: context.runId, onlyWhenDue: true };
    try {
      await db.update(nativeRunFinalizations).set({ nextAttemptAt: new Date(Date.now() + 60_000) })
        .where(eq(nativeRunFinalizations.runId, context.runId));
      await expect(recoverCommittedNativeChatResponse(db, input)).resolves.toBe(false);
      expect(await db.select().from(issueComments).where(eq(issueComments.createdByRunId, context.runId))).toHaveLength(0);
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(0);
      await db.update(nativeRunFinalizations).set({ nextAttemptAt: new Date(0) })
        .where(eq(nativeRunFinalizations.runId, context.runId));
      await expect(recoverCommittedNativeChatResponse(db, input)).resolves.toBe(true);
      expect(await db.select().from(issueComments).where(eq(issueComments.createdByRunId, context.runId))).toHaveLength(1);
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(1);
    } finally { await context.service.shutdown(); }
  });

  it.each(["pending", "failed"])("defers scheduled accepted-response recovery behind %s status effects", async deliveryState => {
    const context = await committedChatResponseRecoveryFixture("telegram");
    const input = { companyId: context.fixture.companyId, issueId: context.issue.id, runId: context.runId, onlyWhenDue: true };
    try {
      const [effect] = await db.select().from(statusDecisionEffects).where(eq(statusDecisionEffects.decisionId, context.coordinator.decisionId!));
      expect(effect).toBeDefined();
      await db.update(statusDecisionEffects).set({ deliveryState }).where(eq(statusDecisionEffects.id, effect.id));
      await expect(recoverCommittedNativeChatResponse(db, input)).resolves.toBe(false);
      expect(await db.select().from(issueComments).where(eq(issueComments.createdByRunId, context.runId))).toHaveLength(0);
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(0);
      await db.update(statusDecisionEffects).set({ deliveryState: "delivered" }).where(eq(statusDecisionEffects.id, effect.id));
      await expect(recoverCommittedNativeChatResponse(db, input)).resolves.toBe(true);
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(1);
    } finally { await context.service.shutdown(); }
  });

  it.each(["action", "endpoint"] as const)("leaves a contended accepted response retryable without reclassifying or partially publishing it (%s)", async target => {
    const context = await committedChatResponseRecoveryFixture("telegram");
    let release!: () => void;
    let observed!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const holder = db.transaction(async (tx) => {
      if (target === "endpoint") {
        await tx.select().from(chatEndpoints).where(eq(chatEndpoints.id, context.endpoint.id)).for("no key update");
      } else {
        await tx.select().from(chatActions).where(eq(chatActions.id, context.action.id)).for("update");
      }
      observed();
      await hold;
    });
    try {
      await locked;
      await expect(context.repair()).resolves.toBe(false);
      await expect(recoverCommittedNativeChatResponse(db, {
        companyId: context.fixture.companyId, issueId: context.issue.id, runId: context.runId,
      })).rejects.toThrow();
      await expect(
        db
          .select()
          .from(issueComments)
          .where(eq(issueComments.createdByRunId, context.runId)),
      ).resolves.toHaveLength(0);
      await expect(
        readChatPublicationsByEndpointId(context.endpoint.id),
      ).resolves.toHaveLength(0);
      await expect(
        db
          .select({ phase: nativeRunFinalizations.phase })
          .from(nativeRunFinalizations)
          .where(eq(nativeRunFinalizations.runId, context.runId)),
      ).resolves.toEqual([{ phase: "committed" }]);
      release();
      await holder;
      await expect(context.repair()).resolves.toBe(true);
    } finally {
      release();
      await holder;
      await context.service.shutdown();
    }
  });

  it("restores changed native review metadata once and signals only its committed change", async () => {
    const context = await committedNativeReviewPublicationFixture("milestone-repair");
    // Earlier failure cases can leave intent awaiting XID reconciliation on the
    // suite's shared owner. Subscribing to that owner immediately replays intent.
    await expect(db.transaction(async tx => {
      await signalDatabaseWork(tx, "chat-run-milestones");
      throw new Error("unrelated rolled-back producer");
    })).rejects.toThrow("unrelated rolled-back producer");
    const repairDb = createDb(externalTestDatabaseUrl ?? tempDb!.connectionString);
    const events: string[] = [];
    const unsubscribe = subscribeDatabaseWork(repairDb, "chat-run-milestones", event => events.push(event));
    try {
      const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, context.runId));
      const input = { companyId: context.fixture.companyId, issueId: coordinator.issueId, runId: context.runId,
        decisionId: coordinator.decisionId!, resultId: coordinator.resultId!, assessmentId: coordinator.assessmentId! };
      const savedAt = new Date(Date.now() - 60_000);
      await db.update(heartbeatRuns).set({ updatedAt: savedAt }).where(eq(heartbeatRuns.id, context.runId));
      // Already-restored metadata still authorizes materialization by the caller,
      // but must neither rewrite the run nor wake projection again.
      await expect(repairDb.transaction(tx => restoreNativeChatReviewPresentationInTransaction(tx as unknown as typeof db, input))).resolves.toBe(true);
      expect((await readHeartbeatRunsById(context.runId))[0].updatedAt).toEqual(savedAt);
      expect(events).toEqual([]);
      await db.update(heartbeatRuns).set({ resultJson: sql`${heartbeatRuns.resultJson} - 'externalChatReviewPresentation'` })
        .where(eq(heartbeatRuns.id, context.runId));
      await repairDb.transaction(async tx => {
        expect(await restoreNativeChatReviewPresentationInTransaction(tx as unknown as typeof db, input)).toBe(true);
        expect(events).toEqual(["intent"]);
      });
      expect(events).toEqual(["intent", "settled"]);
      expect((await readHeartbeatRunsById(context.runId))[0].resultJson).toMatchObject({
        externalChatReviewPresentation: { decisionId: coordinator.decisionId, runId: context.runId },
      });
      events.length = 0;
      await repairDb.transaction(tx => restoreNativeChatReviewPresentationInTransaction(tx as unknown as typeof db, input));
      expect(events).toEqual([]);
    } finally {
      unsubscribe();
      await repairDb.$client.end({ timeout: 1 });
      await context.service.shutdown();
    }
  });

  it.each(["principal_revoked", "gate_changed"] as const)(
    "blocks a committed native review response and selected files at transport after %s",
    async (kind) => {
      const committed = await committedNativeReviewPublicationFixture(kind);
      if (kind === "principal_revoked") {
        await db
          .update(companyMemberships)
          .set({ status: "suspended", updatedAt: new Date() })
          .where(
            and(
              eq(companyMemberships.companyId, committed.fixture.companyId),
              eq(companyMemberships.principalId, "owner-user"),
            ),
          );
      } else {
        await db
          .update(issueThreadInteractions)
          .set({ effectiveResolverPolicy: "anyone", updatedAt: new Date() })
          .where(eq(issueThreadInteractions.id, committed.gate.id));
      }

      await expect(
        committed.service.processPendingPublications(100),
      ).resolves.toBe(3);
      expect(committed.providerRuntime.posts).toEqual([]);
      expect(committed.providerRuntime.edits).toEqual([]);
      expect(committed.providerRuntime.slackFilePublicationAttempts).toBe(0);
      expect(committed.providerRuntime.slackFileReceiptLookups).toEqual([]);
      const publicationIds = committed.publications.map(({ id }) => id);
      await expect(
        db
          .select({
            attempts: chatPublications.attempts,
            providerMessageId: chatPublications.providerMessageId,
            redactedError: chatPublications.redactedError,
            state: chatPublications.state,
          })
          .from(chatPublications)
          .where(inArray(chatPublications.id, publicationIds)),
      ).resolves.toEqual(
        expect.arrayContaining(
          publicationIds.map(() => ({
            attempts: 1,
            providerMessageId: null,
            redactedError:
              "Task control requester or destination is no longer authorized",
            state: "cancelled",
          })),
        ),
      );
      await expect(
        db
          .select({ id: chatMessageLinks.id })
          .from(chatMessageLinks)
          .where(inArray(chatMessageLinks.publicationId, publicationIds)),
      ).resolves.toEqual([]);
      await expect(
        db
          .select({ status: issues.status })
          .from(issues)
          .where(eq(issues.id, committed.conversation.issueId)),
      ).resolves.toEqual([{ status: "in_review" }]);
      await expect(
        db
          .select({ status: issueThreadInteractions.status })
          .from(issueThreadInteractions)
          .where(eq(issueThreadInteractions.id, committed.gate.id)),
      ).resolves.toEqual([{ status: "pending" }]);
    },
  );

  it("retries a contended committed review response before transport, then publishes it and its files once", async () => {
    const committed = await committedNativeReviewPublicationFixture("busy");
    let releaseGate!: () => void;
    let gateLocked!: () => void;
    const gateRelease = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const gateLockObserved = new Promise<void>((resolve) => {
      gateLocked = resolve;
    });
    const holder = db.transaction(async (tx) => {
      await tx
        .select({ id: issueThreadInteractions.id })
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, committed.gate.id))
        .for("update");
      gateLocked();
      await gateRelease;
    });
    await gateLockObserved;
    try {
      await expect(
        committed.service.processPendingPublications(100),
      ).resolves.toBe(1);
    } finally {
      releaseGate();
      await holder;
    }
    expect(committed.providerRuntime.posts).toEqual([]);
    expect(committed.providerRuntime.edits).toEqual([]);
    expect(committed.providerRuntime.slackFilePublicationAttempts).toBe(0);
    expect(committed.providerRuntime.slackFileReceiptLookups).toEqual([]);
    const [retrying] = await db
      .select()
      .from(chatPublications)
      .where(
        and(
          inArray(
            chatPublications.id,
            committed.publications.map(({ id }) => id),
          ),
          eq(chatPublications.state, "retry"),
        ),
      );
    expect(retrying).toMatchObject({
      attempts: 1,
      providerMessageId: null,
      nextAttemptAt: expect.any(Date),
      redactedError:
        "Chat response authorization is temporarily busy; no provider delivery was attempted",
    });
    await db
      .update(chatPublications)
      .set({ nextAttemptAt: new Date(0), updatedAt: new Date() })
      .where(eq(chatPublications.id, retrying!.id));

    await expect(
      committed.service.processPendingPublications(100),
    ).resolves.toBe(3);
    expect(committed.providerRuntime.posts).toHaveLength(3);
    expect(committed.providerRuntime.edits).toEqual([]);
    expect(committed.providerRuntime.slackFilePublicationAttempts).toBe(2);
    expect(committed.providerRuntime.slackFileReceiptLookups).toEqual([]);
    const publicationIds = committed.publications.map(({ id }) => id);
    await expect(
      db
        .select({
          attempts: chatPublications.attempts,
          providerMessageId: chatPublications.providerMessageId,
          state: chatPublications.state,
        })
        .from(chatPublications)
        .where(inArray(chatPublications.id, publicationIds)),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attempts: 2,
          providerMessageId: expect.any(String),
          state: "published",
        }),
        expect.objectContaining({
          attempts: 1,
          providerMessageId: expect.any(String),
          state: "published",
        }),
        expect.objectContaining({
          attempts: 1,
          providerMessageId: expect.any(String),
          state: "published",
        }),
      ]),
    );
    await expect(
      db
        .select({ id: chatMessageLinks.id })
        .from(chatMessageLinks)
        .where(inArray(chatMessageLinks.publicationId, publicationIds)),
    ).resolves.toHaveLength(3);
    await expect(
      committed.service.processPendingPublications(100),
    ).resolves.toBe(0);
    expect(committed.providerRuntime.posts).toHaveLength(3);
    expect(committed.providerRuntime.slackFilePublicationAttempts).toBe(2);
  });

  it("wakes pre-run FIFO notices from real admission after quiet and becomes quiet again", async () => {
    let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
    let service: ChatChannelService | undefined;
    const errors: unknown[] = [];
    const settle = async () => vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect(idleWorkSnapshot().active).toBe(0);
      expect(coordinator!.nextWakeAt()).toBeNull();
    }, { timeout: 10_000 });
    const quiet = async () => {
      const select = vi.spyOn(db, "select"), transaction = vi.spyOn(db, "transaction");
      try {
        await vi.advanceTimersByTimeAsync(120_000);
        expect(select).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled();
      } finally { select.mockRestore(); transaction.mockRestore(); }
    };
    try {
      const context = await deferredChatQueueFixture(false, async channel => {
        service = channel;
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
        coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError: error => errors.push(error) });
        await chatInboundWakeNoticeWork(channel).register(coordinator, () => true).ready;
        await settle(); await quiet();
      });
      await settle();
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toEqual([expect.objectContaining({
        commentId: context.action.payload.commentId,
        payload: { text: "Your follow-up is queued.", progressState: "queued" },
      })]);
      await quiet();
      await coordinator!.stop();
      coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError: error => errors.push(error) });
      await chatInboundWakeNoticeWork(context.service).register(coordinator, () => true).ready;
      await settle(); await quiet();
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(1);
      expect(errors).toEqual([]);
    } finally {
      await coordinator?.stop(); vi.useRealTimers(); await service?.shutdown();
    }
  });

  it("reconstructs inbound admission committed after the notice worker stops", async () => {
    let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
    let service: ChatChannelService | undefined;
    const errors: unknown[] = [];
    try {
      const context = await deferredChatQueueFixture(false, async channel => {
        service = channel;
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
        coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true,
          canReconcile: () => true, onError: error => errors.push(error) });
        await chatInboundWakeNoticeWork(channel).register(coordinator, () => true).ready;
        await coordinator.stop();
      });
      const select = vi.spyOn(db, "select"), transaction = vi.spyOn(db, "transaction");
      try {
        await vi.advanceTimersByTimeAsync(120_000);
        expect(select).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled();
      } finally { select.mockRestore(); transaction.mockRestore(); }
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(0);
      coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true,
        canReconcile: () => true, onError: error => errors.push(error) });
      await chatInboundWakeNoticeWork(context.service).register(coordinator, () => true).ready;
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(1000);
        expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(1);
        expect(idleWorkSnapshot().active).toBe(0); expect(coordinator!.nextWakeAt()).toBeNull();
      }, { timeout: 10_000 });
      expect(errors).toEqual([]);
    } finally { await coordinator?.stop(); vi.useRealTimers(); await service?.shutdown(); }
  });

  it.each(["task visibility", "project membership", "task grant"] as const)("wakes a saved inbound notice when %s restores privacy access", async kind => {
    const context = await deferredChatQueueFixture(false, undefined, true);
    await db.update(issues).set({ visibility: "private", privacyRootIssueId: context.conversation.issueId,
      createdByUserId: null, responsibleUserId: null, assigneeUserId: null,
    }).where(eq(issues.id, context.conversation.issueId));
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true,
      canReconcile: () => true, onError: error => errors.push(error) });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const settle = async () => vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect(idleWorkSnapshot().active).toBe(0); expect(coordinator.nextWakeAt()).toBeNull();
    }, { timeout: 10_000 });
    try {
      await chatInboundWakeNoticeWork(context.service).register(coordinator, () => true).ready;
      await settle();
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(0);
      if (kind === "task visibility") {
        await issueService(db).update(context.conversation.issueId, { visibility: "open" });
      } else if (kind === "project membership") {
        const [project] = await db.insert(projects).values({ companyId: context.fixture.companyId,
          name: "Private notice project", visibility: "private",
        }).returning();
        await db.update(issues).set({ projectId: project.id }).where(eq(issues.id, context.conversation.issueId));
        await ensureProjectAccessMember(db, { companyId: context.fixture.companyId, projectId: project.id,
          subjectType: "user", subjectId: String(context.action.payload.requestedByActorId),
        });
      } else {
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => { req.actor = { ...boardActor(context.fixture.companyId), isInstanceAdmin: true }; next(); });
        app.use("/api", issueRoutes(db, createStorageService().storage)); app.use(errorHandler);
        await request(app).post(`/api/issues/${context.conversation.issueId}/access-grants`).send({
          subjectType: "user", subjectId: String(context.action.payload.requestedByActorId),
        }).expect(201);
      }
      await settle();
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toEqual([expect.objectContaining({
        payload: { text: "Your follow-up is queued.", progressState: "queued" },
      })]);
      expect(errors).toEqual([]);
    } finally { await coordinator.stop(); vi.useRealTimers(); await context.service.shutdown(); }
  });

  it.each(["startup", "first admission", "failed selection"] as const)("retains inbound notices through %s during drain without passive SQL", async kind => {
    let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
    let service: ChatChannelService | undefined;
    let canRun = kind !== "startup";
    const errors: unknown[] = [];
    try {
      const context = await deferredChatQueueFixture(false, async channel => {
        service = channel;
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
        coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => canRun,
          canReconcile: () => true, onError: error => errors.push(error) });
        const selection = kind === "failed selection"
          ? vi.spyOn(channel, "loadInboundWakeNoticeScopes").mockRejectedValueOnce(new Error("temporary notice selection outage"))
          : undefined;
        try { await chatInboundWakeNoticeWork(channel).register(coordinator, () => canRun).ready; }
        finally { selection?.mockRestore(); }
        canRun = false;
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0));
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(0);
      const select = vi.spyOn(db, "select"), transaction = vi.spyOn(db, "transaction");
      try {
        await vi.advanceTimersByTimeAsync(120_000);
        expect(select).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled();
      } finally { select.mockRestore(); transaction.mockRestore(); }
      canRun = true;
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
        expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(1);
        expect(idleWorkSnapshot().active).toBe(0); expect(coordinator!.nextWakeAt()).toBeNull();
      }, { timeout: 10_000 });
      expect(errors).toHaveLength(kind === "failed selection" ? 1 : 0);
    } finally { await coordinator?.stop(); vi.useRealTimers(); await service?.shutdown(); }
  });

  it("retains admission committed while an empty inbound-notice selection is returning", async () => {
    let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
    let service: ChatChannelService | undefined;
    let selection: ReturnType<typeof vi.spyOn> | undefined;
    let ready: Promise<unknown> | undefined;
    let held = false, release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const errors: unknown[] = [];
    try {
      const context = await deferredChatQueueFixture(false, async channel => {
        service = channel;
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
        const load = channel.loadInboundWakeNoticeScopes.bind(channel);
        selection = vi.spyOn(channel, "loadInboundWakeNoticeScopes").mockImplementationOnce(async (...args) => {
          const rows = await load(...args); held = true; await pending; return rows;
        });
        coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true,
          canReconcile: () => true, onError: error => errors.push(error) });
        ready = chatInboundWakeNoticeWork(channel).register(coordinator, () => true).ready;
        await vi.waitFor(() => expect(held).toBe(true));
      });
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(0);
      release(); await ready;
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(1000);
        expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(1);
        expect(idleWorkSnapshot().active).toBe(0); expect(coordinator!.nextWakeAt()).toBeNull();
      }, { timeout: 10_000 });
      expect(errors).toEqual([]);
    } finally { release(); await ready; selection?.mockRestore(); await coordinator?.stop(); vi.useRealTimers(); await service?.shutdown(); }
  });

  it.each(["tree cancellation", "source removal", "agent cancellation", "budget cancellation", "company archive", "queue rejection", "queue failure"] as const)("wakes a visible pre-run FIFO retirement only after %s commits", async change => {
    const context = await deferredChatQueueFixture();
    const releaseRunId = randomUUID();
    if (change === "queue rejection" || change === "queue failure") {
      await db.insert(heartbeatRuns).values({ id: releaseRunId, companyId: context.fixture.companyId,
        agentId: context.fixture.assignedAgentId, status: "succeeded", finishedAt: new Date(),
        contextSnapshot: { issueId: context.conversation.issueId },
      });
    }
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true,
      canReconcile: () => true, onError: error => errors.push(error) });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const settle = async () => vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect(idleWorkSnapshot().active).toBe(0); expect(coordinator.nextWakeAt()).toBeNull();
    }, { timeout: 10_000 });
    const notices = () => readChatPublicationsByEndpointId(context.endpoint.id);
    const expectedText = change === "source removal" ? "This queued message was removed."
      : "This follow-up was not started. Open the task in Paperclip for details.";
    const retire = async (database: typeof db) => {
      if (change === "source removal") return issueService(database).tombstoneComment(String(context.action.payload.commentId), {
        actorType: "user", userId: String(context.action.payload.requestedByActorId),
      });
      if (change === "agent cancellation") return heartbeatService(database).cancelInvocationsForAgents(
        [context.fixture.assignedAgentId], "PRIVATE cancellation",
      );
      if (change === "budget cancellation") return heartbeatService(database).cancelBudgetScopeWork({
        companyId: context.fixture.companyId, scopeType: "company", scopeId: context.fixture.companyId,
      });
      if (change === "company archive") return companyService(database).update(context.fixture.companyId, { status: "archived" });
      if (change === "queue rejection" || change === "queue failure") {
        const adapter = createPostgresWakeQueueAdapter(database, {
          resolveResponsibleUserId: async () => "owner-user",
          getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
          resolveSessionBeforeForWakeup: async () => null,
        });
        return adapter.withIssueExecutionLock({ companyId: context.fixture.companyId, runId: releaseRunId, now: new Date() }, async (_locked, ports) => {
          const target = { companyId: context.fixture.companyId, wakeId: context.action.id, agentId: context.fixture.assignedAgentId, now: new Date() };
          if (change === "queue rejection") await ports.transaction.cancelDeferredWake({ ...target, reason: "PRIVATE rejection" });
          else await ports.transaction.failDeferredWake(target);
          return { outcome: { kind: "released" }, postCommitEffects: [] };
        });
      }
      return issueTreeControlService(database).cancelUnclaimedWakeupsForTree(
        context.fixture.companyId, context.conversation.issueId, "PRIVATE cancellation",
      );
    };
    try {
      await chatInboundWakeNoticeWork(context.service).register(coordinator, () => true).ready;
      await settle();
      await context.service.processPendingPublications(100, { maintenance: false });
      await settle();
      expect(await notices()).toEqual([expect.objectContaining({ state: "published" })]);
      // Company lifecycle owns its root transaction and intentionally rejects
      // caller transactions. The other service producers support nesting.
      if (change !== "company archive") {
        await expect(db.transaction(async tx => {
          await retire(tx as unknown as typeof db);
          await vi.advanceTimersByTimeAsync(1000);
          expect(await notices()).toHaveLength(1);
          throw new Error("outer cancellation rollback");
        })).rejects.toThrow("outer cancellation rollback");
        await settle(); expect(await notices()).toHaveLength(1);
      }
      await retire(db);
      await settle();
      expect(await notices()).toEqual(expect.arrayContaining([expect.objectContaining({
        payload: { text: expectedText, progressState: "failed" },
      })]));
      expect(await notices()).toHaveLength(2);
      await context.service.processPendingPublications(100, { maintenance: false });
      await settle();
      expect(context.runtime.endpoints.get(context.endpoint.id)!.edits).toEqual([expect.objectContaining({
        text: expectedText,
      })]);
      const select = vi.spyOn(db, "select"), transaction = vi.spyOn(db, "transaction");
      try {
        await vi.advanceTimersByTimeAsync(120_000);
        expect(select).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled();
      } finally { select.mockRestore(); transaction.mockRestore(); }
      expect(errors).toEqual([]);
    } finally { await coordinator.stop(); vi.useRealTimers(); await context.service.shutdown(); }
  });

  it("rechecks source retirement after a queued notice's late provider receipt commits", async () => {
    const context = await deferredChatQueueFixture();
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true,
      canReconcile: () => true, onError: error => errors.push(error) });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    let held = false, release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let publishing: Promise<number> | undefined;
    const provider = context.runtime.endpoints.get(context.endpoint.id)!;
    const settle = async () => vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect(idleWorkSnapshot().active).toBe(0); expect(coordinator.nextWakeAt()).toBeNull();
    }, { timeout: 10_000 });
    try {
      await chatInboundWakeNoticeWork(context.service).register(coordinator, () => true).ready;
      await settle();
      provider.postHook = async () => { held = true; await pending; };
      publishing = context.service.processPendingPublications(100, { maintenance: false });
      await vi.waitFor(() => expect(held).toBe(true));
      await issueService(db).tombstoneComment(String(context.action.payload.commentId), {
        actorType: "user", userId: "owner-user",
      });
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(1000);
        expect(coordinator.nextWakeAt()).toBeNull();
      });
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(1);
      release(); await publishing; provider.postHook = undefined;
      await settle();
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toEqual(expect.arrayContaining([expect.objectContaining({
        payload: { text: "This queued message was removed.", progressState: "failed" },
      })]));
      await context.service.processPendingPublications(100, { maintenance: false });
      await settle();
      expect(provider.edits).toEqual([expect.objectContaining({ text: "This queued message was removed." })]);
      expect(errors).toEqual([]);
    } finally { release(); await publishing; provider.postHook = undefined; await coordinator.stop(); vi.useRealTimers(); await context.service.shutdown(); }
  });

  it("wakes inbound notice retirement from a signed Slack Stop without a maintenance scan", async () => {
    const context = await deferredChatQueueFixture(false, undefined, true);
    await qualifySetupRoundTrip(context.service, context.endpoint.id, "UBOARD");
    await context.service.test(context.endpoint.id);
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true,
      canReconcile: () => true, onError: error => errors.push(error) });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const settle = async () => vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect(idleWorkSnapshot().active).toBe(0); expect(coordinator.nextWakeAt()).toBeNull();
    }, { timeout: 10_000 });
    try {
      await chatInboundWakeNoticeWork(context.service).register(coordinator, () => true).ready;
      await settle(); await context.service.processPendingPublications(100, { maintenance: false }); await settle();
      const body = JSON.stringify({ type: "event_callback", team_id: "T-PAPERCLIP", event_id: "EvSleepQueueStop",
        event: { type: "agent_session_stopped", channel: "CDEFERREDNOTICE", thread_ts: "1999000.1",
          event_ts: `${Math.floor(Date.now() / 1000)}.999999`, streaming_message_ts: [], user: "UBOARD" },
      });
      const response = await context.service.handleWebhook(context.endpoint.publicId, "slack", signedSlackWebhookRequest({
        body, contentType: "application/json", url: `https://paperclip.example/api/chat-webhooks/${context.endpoint.publicId}/slack`,
      }));
      expect(response.status).toBe(202);
      await settle();
      expect(await db.select({ status: chatActions.status, result: chatActions.result }).from(chatActions)
        .where(and(eq(chatActions.endpointId, context.endpoint.id), eq(chatActions.kind, "slack_session_stop"))))
        .toEqual([expect.objectContaining({ status: "processed", result: expect.objectContaining({ code: "slack_session_stop_cancelled" }) })]);
      expect(await readAgentWakeupRequestsById(context.action.id)).toEqual([expect.objectContaining({ status: "cancelled" })]);
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toEqual(expect.arrayContaining([expect.objectContaining({
        payload: { text: "This follow-up was not started. Open the task in Paperclip for details.", progressState: "failed" },
      })]));
      expect(errors).toEqual([]);
    } finally { await coordinator.stop(); vi.useRealTimers(); await context.service.shutdown(); }
  });

  it.each(["manual", "scoped"] as const)("advances pre-run FIFO selection past a suppressed page with microsecond timestamps (%s)", async mode => {
    const context = await deferredChatQueueFixture();
    const rejectedIds = Array.from({ length: 50 }, () => randomUUID());
    try {
      const [receipt] = await readAgentWakeupRequestsById(context.action.id);
      const before = new Date(context.action.createdAt.getTime() - 1000).toISOString();
      await db.insert(chatActions).values(rejectedIds.map(id => ({
        ...context.action, id, providerActionId: `inbound_wakeup:${id}`,
        payload: { ...context.action.payload, commentId: randomUUID() },
        createdAt: sql`${before}::timestamptz + interval '0.000123 seconds'`,
      })));
      await db.insert(agentWakeupRequests).values(rejectedIds.map(id => ({
        ...receipt, id, idempotencyKey: `chat-cursor-fixture:${id}`,
      })));
      // Rejected current authority must not keep the same full page at the
      // head of every bounded pass and starve the later admitted message.
      if (mode === "manual") {
        const first = await context.service.enqueueInboundWakeupPublications(50);
        const second = await context.service.enqueueInboundWakeupPublications(50);
        expect(first + second).toBe(1);
      } else {
        const scope = { companyId: context.fixture.companyId, issueId: context.conversation.issueId };
        const transaction = vi.spyOn(db, "transaction");
        try {
          const first = await context.service.reconcileInboundWakeNotices({ scope, limit: 50 });
          expect(transaction).toHaveBeenCalledTimes(50);
          expect(first).toMatchObject({ inserted: 0, contended: false, nextCursor: expect.any(Object) });
          transaction.mockClear();
          expect(await context.service.reconcileInboundWakeNotices({ scope, limit: 50, cursor: first.nextCursor }))
            .toEqual({ inserted: 1, contended: false, nextCursor: null });
          expect(transaction).toHaveBeenCalledTimes(1);
        } finally { transaction.mockRestore(); }
      }
      const rows = await readChatPublicationsByEndpointId(context.endpoint.id);
      expect(rows).toEqual([expect.objectContaining({
        commentId: context.action.payload.commentId,
        payload: { text: "Your follow-up is queued.", progressState: "queued" },
      })]);
    } finally {
      await context.service.shutdown();
      await db.delete(chatActions).where(inArray(chatActions.id, [...rejectedIds, context.action.id]));
      await db.delete(agentWakeupRequests).where(inArray(agentWakeupRequests.id, [...rejectedIds, context.action.id]));
    }
  });

  it.each(["denied", "contended"] as const)("yields a %s inbound notice backlog between bounded passes without losing work", async mode => {
    const context = await deferredChatQueueFixture();
    const other = await deferredChatQueueFixture();
    const rejectedIds = Array.from({ length: 150 }, () => randomUUID());
    let release = () => {};
    let holder: Promise<unknown> | undefined;
    try {
      const [receipt] = await readAgentWakeupRequestsById(context.action.id);
      const at = new Date(context.action.createdAt.getTime() + (mode === "denied" ? -1000 : 1000)).toISOString();
      await db.insert(chatActions).values(rejectedIds.map(id => ({
        ...context.action, id, providerActionId: `inbound_wakeup:${id}`,
        payload: { ...context.action.payload, commentId: randomUUID() },
        createdAt: sql`${at}::timestamptz + interval '0.000123 seconds'`,
      })));
      await db.insert(agentWakeupRequests).values(rejectedIds.map(id => ({
        ...receipt, id, idempotencyKey: `chat-fairness-fixture:${id}`,
      })));
      if (mode === "contended") {
        let locked!: () => void;
        const ready = new Promise<void>(resolve => { locked = resolve; });
        const hold = new Promise<void>(resolve => { release = resolve; });
        holder = db.transaction(async tx => {
          await tx.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, context.action.id)).for("update");
          locked(); await hold;
        });
        await ready;
      }
      const worker = chatInboundWakeNoticeWork(context.service);
      const [entry] = await worker.load({ companyId: context.fixture.companyId, issueId: context.conversation.issueId });
      const [otherEntry] = await worker.load({ companyId: other.fixture.companyId, issueId: other.conversation.issueId });
      const transaction = vi.spyOn(db, "transaction");
      try {
        let remaining = await worker.check(entry!);
        expect(transaction).toHaveBeenCalledTimes(100);
        expect(remaining).toMatchObject({ cursor: expect.any(Object), contended: mode === "contended" });
        expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toEqual([]);
        // Another scope can finish while the first still has a saved cursor.
        expect(await worker.check(otherEntry!)).toBeNull();
        expect(await readChatPublicationsByEndpointId(other.endpoint.id)).toHaveLength(1);
        transaction.mockClear();
        remaining = await worker.check(remaining!);
        expect(transaction).toHaveBeenCalledTimes(51);
        if (mode === "contended") {
          expect(remaining).toMatchObject({ cursor: null });
          expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toEqual([]);
          release(); await holder;
          remaining = await worker.check(remaining!);
          expect(remaining).not.toBeNull();
          remaining = await worker.check(remaining!);
        }
        expect(remaining).toBeNull();
        expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toEqual([expect.objectContaining({
          commentId: context.action.payload.commentId,
          payload: { text: "Your follow-up is queued.", progressState: "queued" },
        })]);
      } finally { transaction.mockRestore(); }
    } finally {
      release(); await holder;
      await context.service.shutdown(); await other.service.shutdown();
      await db.delete(chatActions).where(inArray(chatActions.id, [...rejectedIds, context.action.id]));
      await db.delete(agentWakeupRequests).where(inArray(agentWakeupRequests.id, [...rejectedIds, context.action.id]));
    }
  });

  it("restarts an inbound notice cursor when privacy is restored during a bounded pass", async () => {
    const context = await deferredChatQueueFixture(false, undefined, true);
    const rejectedIds = Array.from({ length: 100 }, () => randomUUID());
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true,
      canReconcile: () => true, onError: error => errors.push(error) });
    let held = false, release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let ready: Promise<unknown> | undefined;
    const reconcile = context.service.reconcileInboundWakeNotices.bind(context.service);
    const pass = vi.spyOn(context.service, "reconcileInboundWakeNotices").mockImplementationOnce(async input => {
      const result = await reconcile(input);
      expect(result).toMatchObject({ inserted: 0, nextCursor: expect.any(Object) });
      held = true; await pending; return result;
    });
    try {
      await db.update(issues).set({ visibility: "private", privacyRootIssueId: context.conversation.issueId,
        createdByUserId: null, responsibleUserId: null, assigneeUserId: null,
      }).where(eq(issues.id, context.conversation.issueId));
      const [receipt] = await readAgentWakeupRequestsById(context.action.id);
      const at = new Date(context.action.createdAt.getTime() + 1000).toISOString();
      await db.insert(chatActions).values(rejectedIds.map(id => ({
        ...context.action, id, providerActionId: `inbound_wakeup:${id}`,
        payload: { ...context.action.payload, commentId: randomUUID() }, createdAt: new Date(at),
      })));
      await db.insert(agentWakeupRequests).values(rejectedIds.map(id => ({
        ...receipt, id, idempotencyKey: `chat-cursor-reset:${id}`,
      })));
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      ready = chatInboundWakeNoticeWork(context.service).register(coordinator, () => true).ready;
      await vi.waitFor(() => expect(held).toBe(true), { timeout: 10_000 });
      await issueService(db).update(context.conversation.issueId, { visibility: "open" });
      release(); await ready;
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(1000);
        expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(1);
        expect(coordinator.nextWakeAt()).toBeNull(); expect(idleWorkSnapshot().active).toBe(0);
      }, { timeout: 10_000 });
      const select = vi.spyOn(db, "select"), transaction = vi.spyOn(db, "transaction");
      try {
        await vi.advanceTimersByTimeAsync(120_000);
        expect(select).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled();
      } finally { select.mockRestore(); transaction.mockRestore(); }
      expect(errors).toEqual([]);
    } finally {
      release(); await ready; await coordinator.stop(); pass.mockRestore(); vi.useRealTimers();
      await context.service.shutdown();
      await db.delete(chatActions).where(inArray(chatActions.id, [...rejectedIds, context.action.id]));
      await db.delete(agentWakeupRequests).where(inArray(agentWakeupRequests.id, [...rejectedIds, context.action.id]));
    }
  });

  it.each(["task", "company", "startup"] as const)("bounds inbound notice scope discovery with denied history (%s)", async mode => {
    const context = await deferredChatQueueFixture();
    const other = await deferredChatQueueFixture();
    const rejectedIds = Array.from({ length: 250 }, () => randomUUID());
    try {
      const [receipt] = await readAgentWakeupRequestsById(context.action.id);
      await db.insert(chatActions).values(rejectedIds.map(id => ({
        ...context.action, id, providerActionId: `inbound_wakeup:${id}`,
        payload: { ...context.action.payload, commentId: randomUUID() },
      })));
      await db.insert(agentWakeupRequests).values(rejectedIds.map(id => ({
        ...receipt, id, idempotencyKey: `chat-discovery-budget:${id}`,
      })));
      const scope = { companyId: context.fixture.companyId, issueId: context.conversation.issueId };
      const events: Array<Record<string, unknown>> = [], now = Date.now();
      const capture = createFullDatabaseResponseCapture({ start: now - 1, end: now + 59_000 }, event => events.push(event));
      installDatabaseResponseCapture(db, { chatActions, agentWakeupRequests }, capture);
      let scopes: Array<{ companyId: string; issueId: string }>;
      try {
        scopes = await context.service.loadInboundWakeNoticeScopes(
          mode === "task" ? scope : mode === "company" ? { companyId: scope.companyId } : undefined,
        );
      } finally { capture.flush(); }
      if (mode === "startup") {
        expect(scopes).toEqual(expect.arrayContaining([scope, {
          companyId: other.fixture.companyId, issueId: other.conversation.issueId,
        }]));
      } else {
        expect(scopes).toEqual([scope]);
      }
      expect(events.at(-1)).toMatchObject({ startedQueries: mode === "task" ? 0 : 1,
        completedQueries: mode === "task" ? 0 : 1, inFlightAtEnd: 0 });
      expect(events.filter(event => event.event === "paperclip.test_db_response_capture.entry.v1")
        .reduce((count, event) => count + Number(event.rows), 0)).toBe(mode === "task" ? 0 : scopes.length);
    } finally {
      await context.service.shutdown(); await other.service.shutdown();
      await db.delete(chatActions).where(inArray(chatActions.id, [...rejectedIds, context.action.id]));
      await db.delete(agentWakeupRequests).where(inArray(agentWakeupRequests.id, [...rejectedIds, context.action.id]));
    }
  });

  it("reactivates restored ordinary input after an earlier Retry notice wake is consumed", async () => {
    const context = await deferredChatQueueFixture();
    const retryId = randomUUID(), intentId = randomUUID();
    const scope = { companyId: context.fixture.companyId, issueId: context.conversation.issueId };
    const errors: unknown[] = [], events: string[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true,
      canReconcile: () => true, onError: error => errors.push(error) });
    let unsubscribe = () => {};
    try {
      const [receipt] = await readAgentWakeupRequestsById(context.action.id);
      await db.insert(chatActions).values({ ...context.action, id: retryId,
        kind: "failed_run_retry", status: "failed", providerActionId: `task-retry-restore:${retryId}`,
        payload: { issueId: scope.issueId, taskRetryIntentId: intentId },
      });
      await db.insert(agentWakeupRequests).values({ ...receipt, id: retryId, status: "failed",
        idempotencyKey: `task-retry-restore:${retryId}`,
      });
      await db.transaction(tx => claimTaskRetryInput(tx, { companyId: scope.companyId,
        retryActionId: retryId, sourceActionIds: [context.action.id] }));
      expect((await readAgentWakeupRequestsById(context.action.id))[0]).toMatchObject({
        status: "coalesced", runId: null, payload: { coalescedIntoWakeupRequestId: retryId },
      });
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      const settle = async () => vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(1000);
        expect(idleWorkSnapshot().active).toBe(0); expect(coordinator.nextWakeAt()).toBeNull();
      }, { timeout: 10_000 });
      await chatInboundWakeNoticeWork(context.service).register(coordinator, () => true).ready;
      await db.transaction(tx => signalDatabaseWork(tx, DELIVERY_QUEUES.chatInboundWakeNotices, JSON.stringify(scope)));
      await settle();
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toEqual([]);
      const select = vi.spyOn(db, "select"), transaction = vi.spyOn(db, "transaction");
      try {
        await vi.advanceTimersByTimeAsync(120_000);
        expect(select).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled();
      } finally { select.mockRestore(); transaction.mockRestore(); }
      unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.chatInboundWakeNotices, (event, scopes) => {
        if ([...scopes ?? []].some(value => value !== "*" && JSON.parse(value).companyId === scope.companyId)) events.push(event);
      });
      await releaseUnadmittedTaskRetryInput(db, { companyId: scope.companyId, retryActionId: retryId });
      expect((await readAgentWakeupRequestsById(context.action.id))[0]).toMatchObject({ status: "deferred_issue_execution", runId: null });
      expect(events).toContain("intent"); expect(events).toContain("settled");
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(1000);
        expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toEqual([expect.objectContaining({
          commentId: context.action.payload.commentId, payload: { text: "Your follow-up is queued.", progressState: "queued" },
        })]);
        expect(coordinator.nextWakeAt()).toBeNull(); expect(idleWorkSnapshot().active).toBe(0);
      }, { timeout: 10_000 });
      expect(errors).toEqual([]);
    } finally {
      unsubscribe(); await coordinator.stop(); vi.useRealTimers(); await context.service.shutdown();
      await db.delete(chatActions).where(eq(chatActions.id, retryId));
      await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.id, retryId));
    }
  });

  it("isolates pre-run FIFO reconciliation scopes and exhausts published history", async () => {
    const first = await deferredChatQueueFixture();
    const second = await deferredChatQueueFixture();
    try {
      const scope = { companyId: first.fixture.companyId, issueId: first.conversation.issueId };
      expect(await first.service.loadInboundWakeNoticeScopes({ companyId: scope.companyId })).toEqual([scope]);
      expect(await first.service.reconcileInboundWakeNotices({ scope })).toEqual({ inserted: 1, contended: false, nextCursor: null });
      expect(await readChatPublicationsByEndpointId(second.endpoint.id)).toEqual([]);
      expect(await first.service.loadInboundWakeNoticeScopes({ companyId: scope.companyId })).toEqual([]);
      expect(await first.service.reconcileInboundWakeNotices({ scope })).toEqual({ inserted: 0, contended: false, nextCursor: null });
      expect(await second.service.reconcileInboundWakeNotices({
        scope: { companyId: second.fixture.companyId, issueId: second.conversation.issueId },
      })).toEqual({ inserted: 1, contended: false, nextCursor: null });
    } finally {
      await first.service.shutdown(); await second.service.shutdown();
    }
  });

  it("retains a contended pre-run FIFO projection and settles cancelled input without a visible notice", async () => {
    const context = await deferredChatQueueFixture();
    let release!: () => void;
    let locked!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const holder = db.transaction(async tx => {
      await tx.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, context.action.id)).for("update");
      locked(); await hold;
      await tx.update(agentWakeupRequests).set({ status: "cancelled" }).where(eq(agentWakeupRequests.id, context.action.id));
    });
    try {
      await ready;
      const scope = { companyId: context.fixture.companyId, issueId: context.conversation.issueId };
      expect(await context.service.reconcileInboundWakeNotices({ scope })).toEqual({ inserted: 0, contended: true, nextCursor: null });
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toEqual([]);
      release(); await holder;
      expect(await context.service.reconcileInboundWakeNotices({ scope })).toEqual({ inserted: 0, contended: false, nextCursor: null });
      expect(await context.service.loadInboundWakeNoticeScopes({ companyId: scope.companyId })).toEqual([]);
    } finally {
      release(); await holder; await context.service.shutdown();
    }
  });

  it("keeps one durable pre-run FIFO notice across coalescing and restart, then reuses only its successor lane", async () => {
    const context = await deferredChatQueueFixture();
    let restarted: ChatChannelService | null = null;
    try {
      const { service, endpoint, conversation, fixture, action } = context;
      await expect(
        readHeartbeatRunsByCompanyId(fixture.companyId),
      ).resolves.toEqual([]);
      await expect(service.enqueueInboundWakeupPublications()).resolves.toBe(1);
      await service.processPendingPublications();
      const [queued] = await readChatPublicationsByEndpointId(endpoint.id);
      expect(queued).toMatchObject({
        commentId: action.payload.commentId,
        state: "published",
        payload: { text: "Your follow-up is queued.", progressState: "queued" },
      });
      await expect(
        db
          .select({ commentId: chatMessageLinks.commentId })
          .from(chatMessageLinks)
          .where(eq(chatMessageLinks.publicationId, queued.id)),
      ).resolves.toEqual([{ commentId: null }]);
      await expect(
        db
          .select()
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, endpoint.id),
              eq(chatActions.kind, "slack_session_sync"),
            ),
          ),
      ).resolves.toEqual([]);
      await context.send("1999000.2");
      await expect(service.enqueueInboundWakeupPublications()).resolves.toBe(0);
      await service.processPendingPublications();
      expect(context.runtime.endpoints.get(endpoint.id)?.posts).toHaveLength(1);
      await service.shutdown();
      const fresh = createService();
      restarted = fresh.service;
      await expect(restarted.enqueueInboundWakeupPublications()).resolves.toBe(
        0,
      );
      fresh.runtime.initializeHook = async () => {
        fresh.runtime.endpoints
          .get(endpoint.id)!
          .postResultIds.push(
            "predecessor-provider-message",
            "second-answer-provider-message",
          );
      };
      const runId = await context.promote();
      // A predecessor's own lane cannot claim the deferred successor's notice.
      const predecessor = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: predecessor,
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        status: "running",
        contextSnapshot: { issueId: conversation.issueId },
      });
      await db.insert(chatPublications).values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: conversation.id,
        issueId: conversation.issueId,
        idempotencyKey: `run:${predecessor}:working:${endpoint.id}`,
        payload: {
          text: "Predecessor still working",
          progressState: "working",
        },
      });
      await restarted.processPendingPublications();
      const runtime = fresh.runtime.endpoints.get(endpoint.id)!;
      expect(runtime.posts).toHaveLength(1);
      expect(runtime.edits).toEqual([]);
      await db.insert(chatPublications).values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: conversation.id,
        issueId: conversation.issueId,
        idempotencyKey: `run:${runId}:working:${endpoint.id}`,
        payload: { text: "Successor working", progressState: "working" },
      });
      await restarted.processPendingPublications();
      expect(runtime.edits).toEqual([
        {
          threadId: context.thread.thread.id,
          messageId: queued.providerMessageId,
          text: "Successor working",
        },
      ]);
      await addSelectedChatFinal({
        agentId: fixture.assignedAgentId,
        body: "The exact successor answer",
        companyId: fixture.companyId,
        issueId: conversation.issueId,
        runId,
      });
      await restarted.processPendingPublications();
      expect(runtime.edits.at(-1)).toMatchObject({
        messageId: queued.providerMessageId,
        text: "The exact successor answer",
      });
      await addSelectedChatFinal({
        agentId: fixture.assignedAgentId,
        body: "A separate second answer",
        companyId: fixture.companyId,
        issueId: conversation.issueId,
        runId,
      });
      await restarted.processPendingPublications();
      expect(runtime.posts.at(-1)?.text).toBe("A separate second answer");
      expect(runtime.edits).toHaveLength(2);
      await expect(restarted.processPendingPublications()).resolves.toBe(0);
    } finally {
      await restarted?.shutdown();
      await context.service.shutdown();
    }
  });

  it.each(["answer_first", "failure_first"] as const)(
    "preserves selected answer and failure lanes after deferred admission (%s)",
    async (order) => {
      const context = await deferredChatQueueFixture();
      try {
        await context.service.processPendingPublications();
        const [queued] = await db
          .select()
          .from(chatPublications)
          .where(
            and(
              eq(chatPublications.endpointId, context.endpoint.id),
              like(chatPublications.idempotencyKey, "wake:%:queued:%"),
            ),
          );
        expect(queued?.providerMessageId).toBeTruthy();
        const runId = await context.promote();
        const addFinal = () =>
          addSelectedChatFinal({
            agentId: context.fixture.assignedAgentId,
            body: "The deferred selected answer remains available",
            companyId: context.fixture.companyId,
            issueId: context.conversation.issueId,
            runId,
          });
        let final = order === "answer_first" ? await addFinal() : null;
        if (order === "answer_first")
          await context.service.processPendingPublications();
        await db
          .update(heartbeatRuns)
          .set({
            status: "failed",
            errorCode: "adapter_failed",
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(heartbeatRuns.id, runId));
        await enqueueChatRunMilestones(db);
        await context.service.processPendingPublications();
        if (order === "failure_first") {
          final = await addFinal();
          await context.service.processPendingPublications();
        }
        const [answer] = await readChatPublicationsByCommentId(final!.id);
        const [failure] = await readChatPublicationsByIdempotencyKey(`run:${runId}:failed:${context.endpoint.id}`);
        expect(answer?.state).toBe("published");
        expect(failure?.state).toBe("published");
        expect(answer?.providerMessageId).not.toBe(failure?.providerMessageId);
        expect(
          order === "answer_first"
            ? answer?.providerMessageId
            : failure?.providerMessageId,
        ).toBe(queued!.providerMessageId);
        const runtime = context.runtime.endpoints.get(context.endpoint.id)!;
        expect(runtime.posts).toHaveLength(2);
        expect(runtime.edits).toHaveLength(1);
        expect(runtime.edits[0]?.messageId).toBe(queued!.providerMessageId);
        const links = await db
          .select({ publicationId: chatMessageLinks.publicationId })
          .from(chatMessageLinks)
          .where(
            and(
              eq(chatMessageLinks.conversationId, context.conversation.id),
              eq(chatMessageLinks.direction, "outbound"),
            ),
          );
        expect(links).toHaveLength(2);
        expect(links).toEqual(
          expect.arrayContaining([
            { publicationId: answer!.id },
            { publicationId: failure!.id },
          ]),
        );
        await enqueueChatRunMilestones(db);
        await context.service.processPendingPublications();
        expect(runtime.posts).toHaveLength(2);
        expect(runtime.edits).toHaveLength(1);
      } finally {
        await context.service.shutdown();
      }
    },
  );

  it("reuses a pre-run FIFO notice when the successor asks before its working milestone", async () => {
    const context = await deferredChatQueueFixture();
    try {
      await context.service.processPendingPublications();
      const [queued] = await readChatPublicationsByEndpointId(context.endpoint.id);
      const runId = await context.promote();
      const interactionId = randomUUID();
      await db.insert(issueThreadInteractions).values({
        id: interactionId,
        companyId: context.fixture.companyId,
        issueId: context.conversation.issueId,
        kind: "ask_user_questions",
        status: "pending",
        sourceRunId: runId,
        title: "Pick one",
        payload: {
          version: 1,
          questions: [
            {
              id: "color",
              prompt: "Pick one",
              selectionMode: "single",
              options: [{ id: "amber", label: "Amber" }],
            },
          ],
        },
      });
      await db.insert(chatPublications).values({
        companyId: context.fixture.companyId,
        endpointId: context.endpoint.id,
        conversationId: context.conversation.id,
        issueId: context.conversation.issueId,
        idempotencyKey: `interaction:${interactionId}:${context.endpoint.id}`,
        payload: { text: "Pick one: Amber", interactionId },
      });
      await context.service.processPendingPublications();
      const runtime = context.runtime.endpoints.get(context.endpoint.id)!;
      expect(runtime.posts).toHaveLength(1);
      expect(runtime.edits).toEqual([
        {
          threadId: context.thread.thread.id,
          messageId: queued.providerMessageId,
          text: "Pick one: Amber",
        },
      ]);
    } finally {
      await context.service.shutdown();
    }
  });

  it.each(["failed", "cancelled"] as const)(
    "retires a pre-run FIFO notice with the exact promoted %s run even before a working update",
    async (status) => {
      const context = await deferredChatQueueFixture();
      try {
        await context.service.processPendingPublications();
        const [queued] = await readChatPublicationsByEndpointId(context.endpoint.id);
        const runId = await context.promote();
        await db.transaction(async (tx) => {
          await tx
            .update(agentWakeupRequests)
            .set({ status })
            .where(eq(agentWakeupRequests.id, context.action.id));
          await tx
            .update(heartbeatRuns)
            .set({ status, finishedAt: new Date(), updatedAt: new Date() })
            .where(eq(heartbeatRuns.id, runId));
        });
        await db.insert(chatPublications).values({
          companyId: context.fixture.companyId,
          endpointId: context.endpoint.id,
          conversationId: context.conversation.id,
          issueId: context.conversation.issueId,
          idempotencyKey: `run:${runId}:failed:${context.endpoint.id}`,
          payload: {
            text: "Maya stopped before completing this turn. Open the task in Paperclip for details.",
            progressState: "failed",
          },
        });
        await context.service.processPendingPublications();
        await expect(
          context.service.processPendingPublications(),
        ).resolves.toBe(0);
        const runtime = context.runtime.endpoints.get(context.endpoint.id)!;
        expect(runtime.posts).toHaveLength(1);
        expect(runtime.edits).toEqual([
          {
            threadId: context.thread.thread.id,
            messageId: queued.providerMessageId,
            text: "Maya stopped before completing this turn. Open the task in Paperclip for details.",
          },
        ]);
        expect(JSON.stringify(runtime.edits)).not.toContain("was not started");
      } finally {
        await context.service.shutdown();
      }
    },
  );

  it.each([
    "promotion",
    "cancelled",
    "reach",
    "source_deleted",
    "actor",
    "generation",
    "guest_access",
  ] as const)(
    "suppresses a pending pre-run FIFO notice after %s wins",
    async (change) => {
      const context = await deferredChatQueueFixture();
      try {
        await expect(
          context.service.enqueueInboundWakeupPublications(),
        ).resolves.toBe(1);
        if (change === "promotion") await context.promote();
        if (change === "cancelled")
          await db
            .update(agentWakeupRequests)
            .set({ status: "cancelled" })
            .where(eq(agentWakeupRequests.id, context.action.id));
        if (change === "reach")
          await db
            .update(chatEndpointResources)
            .set({ enabled: false })
            .where(eq(chatEndpointResources.endpointId, context.endpoint.id));
        if (change === "source_deleted")
          await db
            .update(issueComments)
            .set({ deletedAt: new Date() })
            .where(
              eq(issueComments.id, String(context.action.payload.commentId)),
            );
        if (change === "actor")
          await db
            .update(agentWakeupRequests)
            .set({ requestedByActorId: "forged-actor" })
            .where(eq(agentWakeupRequests.id, context.action.id));
        if (change === "generation")
          await db
            .update(chatConversations)
            .set({
              sessionGeneration: context.conversation.sessionGeneration + 1,
            })
            .where(eq(chatConversations.id, context.conversation.id));
        if (change === "guest_access")
          await db
            .update(chatEndpoints)
            .set({ allowUnlinkedPeople: false })
            .where(eq(chatEndpoints.id, context.endpoint.id));
        await context.service.processPendingPublications();
        expect(
          context.runtime.endpoints.get(context.endpoint.id)?.posts ?? [],
        ).toEqual([]);
        const publications = await readChatPublicationsByEndpointId(context.endpoint.id);
        expect(publications).toHaveLength(1);
        expect(publications[0]?.state).toBe("cancelled");
      } finally {
        await context.service.shutdown();
      }
    },
  );

  it("retires an already-visible pre-run FIFO notice once without publishing scheduler failures", async () => {
    const context = await deferredChatQueueFixture();
    try {
      await context.service.processPendingPublications();
      const [queued] = await readChatPublicationsByEndpointId(context.endpoint.id);
      await db
        .update(agentWakeupRequests)
        .set({
          status: "failed",
          error: "PRIVATE token=secret scheduler detail",
        })
        .where(eq(agentWakeupRequests.id, context.action.id));
      await context.service.processPendingPublications();
      await expect(context.service.processPendingPublications()).resolves.toBe(
        0,
      );
      const runtime = context.runtime.endpoints.get(context.endpoint.id)!;
      expect(runtime.posts).toHaveLength(1);
      expect(runtime.edits).toEqual([
        {
          threadId: context.thread.thread.id,
          messageId: queued.providerMessageId,
          text: "This follow-up was not started. Open the task in Paperclip for details.",
        },
      ]);
      expect(JSON.stringify(runtime.edits)).not.toMatch(
        /PRIVATE|token=|scheduler/,
      );
    } finally {
      await context.service.shutdown();
    }
  });

  it.each(["not-a-uuid", "", "uppercase"])("skips a pre-run FIFO candidate with a noncanonical coalesced owner id (%s)", async (ownerId) => {
    const context = await deferredChatQueueFixture();
    try {
      const [receipt] = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, context.action.id));
      await db
        .update(agentWakeupRequests)
        .set({
          payload: {
            ...receipt.payload,
            coalescedIntoWakeupRequestId: ownerId === "uppercase" ? context.action.id.toUpperCase() : ownerId,
          },
        })
        .where(eq(agentWakeupRequests.id, context.action.id));
      await expect(
        context.service.enqueueInboundWakeupPublications(),
      ).resolves.toBe(0);
      await expect(
        db
          .select()
          .from(chatPublications)
          .where(eq(chatPublications.endpointId, context.endpoint.id)),
      ).resolves.toEqual([]);
    } finally {
      await context.service.shutdown();
    }
  });

  it("keeps the pre-run FIFO sweep running when a valid owner's action has comment ids that are not uuids", async () => {
    const context = await deferredChatQueueFixture();
    try {
      // Publish the queued notice first. The removed-comment and queued-notice
      // checks then have real rows to compare the malformed ids against.
      await context.service.processPendingPublications();
      await expect(
        db
          .select({ state: chatPublications.state })
          .from(chatPublications)
          .where(eq(chatPublications.endpointId, context.endpoint.id)),
      ).resolves.toEqual([{ state: "published" }]);
      await db
        .update(chatActions)
        .set({
          payload: {
            ...context.action.payload,
            issueId: "not-a-uuid",
            commentId: "not-a-uuid",
          },
        })
        .where(eq(chatActions.id, context.action.id));
      await expect(
        context.service.enqueueInboundWakeupPublications(),
      ).resolves.toBe(0);
      await expect(
        db
          .select({ state: chatPublications.state })
          .from(chatPublications)
          .where(eq(chatPublications.endpointId, context.endpoint.id)),
      ).resolves.toEqual([{ state: "published" }]);
    } finally {
      await context.service.shutdown();
    }
  });

  it("never promises a queued follow-up before durable admission succeeds", async () => {
    const context = await deferredChatQueueFixture(true);
    try {
      await context.service.processPendingPublications();
      expect(context.action.status).toBe("issued");
      expect(
        context.runtime.endpoints.get(context.endpoint.id)?.posts ?? [],
      ).toEqual([]);
      await expect(
        readChatPublicationsByEndpointId(context.endpoint.id),
      ).resolves.toEqual([]);
      await expect(
        readHeartbeatRunsByCompanyId(context.fixture.companyId),
      ).resolves.toEqual([]);
    } finally {
      await context.service.shutdown();
    }
  });

  it("retires only the removed source's pre-run FIFO notice after its surviving batch promotes", async () => {
    const context = await deferredChatQueueFixture();
    try {
      await context.service.processPendingPublications();
      const [queued] = await readChatPublicationsByEndpointId(context.endpoint.id);
      await context.send("1999000.2");
      const [second] = await db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, context.endpoint.id),
            eq(chatActions.kind, "inbound_wakeup"),
            sql`${chatActions.id} <> ${context.action.id}`,
          ),
        );
      const [owner] = await readAgentWakeupRequestsById(context.action.id);
      const remainingContext = {
        ...(owner.payload!._paperclipWakeContext as Record<string, unknown>),
        wakeCommentId: second.payload.commentId,
        commentId: second.payload.commentId,
        wakeCommentIds: [second.payload.commentId],
      };
      await db.transaction(async (tx) => {
        await tx
          .update(issueComments)
          .set({ deletedAt: new Date() })
          .where(
            eq(issueComments.id, String(context.action.payload.commentId)),
          );
        await tx
          .update(agentWakeupRequests)
          .set({
            payload: {
              ...owner.payload,
              wakeCommentId: second.payload.commentId,
              commentId: second.payload.commentId,
              _paperclipWakeContext: remainingContext,
            },
          })
          .where(eq(agentWakeupRequests.id, owner.id));
      });
      const runId = await context.promote();
      await addSelectedChatFinal({
        agentId: context.fixture.assignedAgentId,
        body: "Answer to the surviving second message",
        companyId: context.fixture.companyId,
        issueId: context.conversation.issueId,
        runId,
      });
      await context.service.processPendingPublications();
      await expect(context.service.processPendingPublications()).resolves.toBe(
        0,
      );
      const runtime = context.runtime.endpoints.get(context.endpoint.id)!;
      expect(runtime.posts.map((post) => post.text)).toEqual([
        "Your follow-up is queued.",
        "Answer to the surviving second message",
      ]);
      expect(runtime.edits).toEqual([
        {
          threadId: context.thread.thread.id,
          messageId: queued.providerMessageId,
          text: "This queued message was removed.",
        },
      ]);
      expect(JSON.stringify(runtime.edits)).not.toContain("not started");
    } finally {
      await context.service.shutdown();
    }
  });

  it("does not let removed-input cleanup overwrite a pre-run FIFO lane already replaced by its answer", async () => {
    const context = await deferredChatQueueFixture();
    try {
      await context.service.processPendingPublications();
      const runId = await context.promote();
      await addSelectedChatFinal({
        agentId: context.fixture.assignedAgentId,
        body: "Already answered",
        companyId: context.fixture.companyId,
        issueId: context.conversation.issueId,
        runId,
      });
      await db
        .update(issueComments)
        .set({ deletedAt: new Date() })
        .where(eq(issueComments.id, String(context.action.payload.commentId)));
      // Final is already ordered before the cleanup, but neither was sent
      // when cleanup was selected. Its transport claim must re-read the link.
      await expect(
        context.service.enqueueInboundWakeupPublications(),
      ).resolves.toBe(1);
      await context.service.processPendingPublications();
      await expect(context.service.processPendingPublications()).resolves.toBe(
        0,
      );
      const runtime = context.runtime.endpoints.get(context.endpoint.id)!;
      expect(runtime.posts).toHaveLength(1);
      expect(runtime.edits).toHaveLength(1);
      expect(runtime.edits[0]?.text).toBe("Already answered");
      await expect(
        db
          .select({ state: chatPublications.state })
          .from(chatPublications)
          .where(
            and(
              eq(chatPublications.endpointId, context.endpoint.id),
              like(chatPublications.idempotencyKey, "wake:%:removed:%"),
            ),
          ),
      ).resolves.toEqual([{ state: "cancelled" }]);
    } finally {
      await context.service.shutdown();
    }
  });

  it("retries a contended pre-run FIFO receipt before I/O and observes cancellation after the lock releases", async () => {
    const context = await deferredChatQueueFixture();
    let release!: () => void;
    let locked!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const observed = new Promise<void>((resolve) => {
      locked = resolve;
    });
    let holder: Promise<unknown> | null = null;
    try {
      await context.service.enqueueInboundWakeupPublications();
      holder = db.transaction(async (tx) => {
        await tx
          .select()
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.id, context.action.id))
          .for("update");
        locked();
        await held;
        await tx
          .update(agentWakeupRequests)
          .set({ status: "cancelled" })
          .where(eq(agentWakeupRequests.id, context.action.id));
      });
      await observed;
      await context.service.processPendingPublications();
      const [queued] = await readChatPublicationsByEndpointId(context.endpoint.id);
      expect(queued).toMatchObject({ state: "retry", providerMessageId: null });
      expect(
        context.runtime.endpoints.get(context.endpoint.id)?.posts ?? [],
      ).toEqual([]);
      release();
      await holder;
      await db
        .update(chatPublications)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(chatPublications.id, queued.id));
      await context.service.processPendingPublications();
      await expect(
        db
          .select({ state: chatPublications.state })
          .from(chatPublications)
          .where(eq(chatPublications.id, queued.id)),
      ).resolves.toEqual([{ state: "cancelled" }]);
      expect(
        context.runtime.endpoints.get(context.endpoint.id)?.posts ?? [],
      ).toEqual([]);
    } finally {
      release?.();
      await holder;
      await context.service.shutdown();
    }
  });
});
