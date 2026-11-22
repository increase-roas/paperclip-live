import {
  environmentService,
} from "../../services/environments.js";
import {
  agentWakeupRequests,
  agents,
  chatActions,
  chatConversations,
  chatDeliveries,
  chatEndpointResources,
  chatEndpoints,
  chatGitHubConfigurations,
  chatIdentityLinks,
  chatMessageLinks,
  chatPublications,
  companyMemberships,
  companyObservability,
  completionContracts,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  reconcileDatabaseWork,
  subscribeDatabaseWork,
} from "@paperclipai/db";
import {
  adapterExecutionControls,
  createAdapterExecutionControl,
} from "../../services/adapter-execution-control.js";
import {
  reconcileTaskChatRetryReceipts,
  requestTaskRetry,
} from "../../services/task-retry.js";
import {
  taskInterruptionPresentation,
} from "../../services/task-interruption-presentation.js";
import {
  withQueuedCommentIdsInWakePayload,
} from "../../services/issue-queued-comment-queue.js";
import {
  createSystemRecovery,
} from "../../services/system-recovery-state.js";
import {
  remoteTerminationReceipt,
} from "../../services/remote-execution-termination.js";
import {
  createFullDatabaseResponseCapture,
  installDatabaseResponseCapture,
} from ".././helpers/full-database-response-capture.js";
import {
  createDeliveryWorkCoordinator,
} from "../../services/delivery-work-coordinator.js";
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
  initializeRunIdentity,
} from "../../services/run-identity.js";
import {
  prepareHeartbeatExecutionConfiguration,
} from "../../services/heartbeat/execution-configuration.js";
import {
  appendHeartbeatRunEvent,
} from "../../services/heartbeat-run-events.js";
import {
  companySkillService,
} from "../../services/company-skills.js";
import {
  randomUUID,
} from "node:crypto";
import {
  createServer,
} from "node:http";
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  sql,
} from "drizzle-orm";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  defaultGitHubReviewPolicy,
} from "@paperclipai/shared";
import {
  errorHandler,
} from "../../middleware/index.js";
import {
  issueRoutes,
} from "../../routes/issues.js";
import {
  deliverReconciledExecutions,
} from "../../services/execution-recovery-resolution.js";
import {
  createDurableChatWakeupRequest,
} from "../../services/durable-chat-wakeup.js";
import {
  instanceSettingsService,
} from "../../services/instance-settings.js";
import {
  heartbeatService,
} from "../../services/heartbeat.js";
import {
  registerServerAdapter,
  unregisterServerAdapter,
} from "../../adapters/index.js";
import {
  FakeChatSdkRuntime,
  boardActor,
} from ".././helpers/chat-channels-fixture.js";
import {
  busyChatRetryHttpFixture,
  createService,
  createStorageService,
  currentGitHubTaskRetryFixture,
  db,
  deferredFailedRetryNoticeFixture,
  describeChatChannelsSuite,
  readAgentWakeupRequestsById,
  readChatEndpointsById,
  readChatPublicationsByEndpointId,
  readHeartbeatRunsByCompanyId,
  readHeartbeatRunsById,
  readIssuesById,
  retirePublicationFixture,
  successfulGitHubQueuedInputFixture,
  failedChatRetryFixture,
} from "../helpers/chat-channels-harness.js";
import * as runIdentityModule from "../../services/run-identity.js";
import type { AddressInfo } from "node:net";
import express, {  } from "express";
import request, {  } from "supertest";

describeChatChannelsSuite("chat channels 36-reconciled-chat-retry-delivery-ownership", () => {
  describe("reconciled chat retry delivery ownership", () => {
    async function fixture(deferScheduling = false) {
      const context = await failedChatRetryFixture(
        "slack",
        "U-SAFE-PROGRESS",
        true,
      );
      const [action] = await db
        .insert(issueRecoveryActions)
        .values({
          companyId: context.fixture.companyId,
          sourceIssueId: context.issue.id,
          kind: "active_run_watchdog",
          status: "active",
          ownerType: "board",
          returnOwnerAgentId: context.fixture.assignedAgentId,
          cause: "uncertain_external_action",
          fingerprint: context.runId,
          nextAction: "Continue only the exact verified failed chat request.",
          evidence: { runId: context.runId },
        })
        .returning();
      const genericWake = vi.fn(async () => null);
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.actor = boardActor(context.fixture.companyId);
        next();
      });
      app.use(
        "/api",
        issueRoutes(db, createStorageService().storage, {
          chatRunRetries: {
            prepareFailedChatRunRetry:
              context.service.prepareFailedChatRunRetry,
            processFailedChatRunRetry: deferScheduling
              ? async () => {
                  throw new Error("fixture holds post-commit scheduling");
                }
              : context.service.processFailedChatRunRetry,
          },
          recoveryActionEnqueueWakeup: genericWake,
        }),
      );
      app.use(errorHandler);
      const server = createServer(app);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      const api = request(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      );
      const body = {
        actionId: action!.id,
        outcome: "restored",
        sourceIssueStatus: "todo",
        executionReconciliation: {
          runId: context.runId,
          providerStopped: true,
          actionOutcome: "not_performed",
          outcomeEvidence:
            "The stopped local fixture performed no provider action; the original source is still exact.",
        },
      };
      context.wakeup.mockClear();
      return {
        ...context,
        action: action!,
        genericWake,
        resolve: () =>
          api
            .post(`/api/issues/${context.issue.id}/recovery-actions/resolve`)
            .send(body),
        async cleanup() {
          try {
            await db
              .update(issueRecoveryActions)
              .set({ status: "cancelled", resolvedAt: new Date() })
              .where(eq(issueRecoveryActions.id, action!.id));
            await db
              .update(chatConversations)
              .set({ state: "completed" })
              .where(eq(chatConversations.id, context.conversation.id));
            await retirePublicationFixture(
              context.service,
              context.endpoint.id,
            );
          } finally {
            await new Promise<void>((resolve) => {
              server.close(() => resolve());
              server.closeAllConnections();
            });
          }
        },
      };
    }

    it.each(["concurrent", "lost_scheduler_receipt"] as const)(
      "keeps one exact chat delivery owner through %s reconciliation",
      async (mode) => {
        const context = await fixture();
        try {
          if (mode === "lost_scheduler_receipt") {
            // The scheduler is simulated, but its durable authorization and
            // receipt are the real service transaction. No model turn runs.
            context.wakeup.mockImplementationOnce(async (agentId, opts) => {
              const receipt = opts.durableChatRequest!;
              await db.transaction(async (tx) => {
                await receipt.authorize(tx as unknown as Parameters<typeof receipt.authorize>[0]);
                await tx.insert(agentWakeupRequests).values({
                  id: receipt.id,
                  companyId: receipt.companyId,
                  agentId,
                  source: opts.source!,
                  triggerDetail: opts.triggerDetail,
                  reason: opts.reason,
                  payload: opts.payload,
                  requestedByActorType: opts.requestedByActorType,
                  requestedByActorId: opts.requestedByActorId,
                  idempotencyKey: receipt.idempotencyKey,
                  requestedAt: receipt.requestedAt,
                  status: "queued",
                });
              });
              throw new Error(
                "fixture lost acknowledgement after durable chat receipt",
              );
            });
          }
          const responses = await Promise.all([
            context.resolve(),
            context.resolve(),
          ]);
          expect(responses.map((response) => response.status)).toEqual([
            200, 200,
          ]);
          const retries = await db
            .select()
            .from(chatActions)
            .where(
              and(
                eq(chatActions.endpointId, context.endpoint.id),
                eq(chatActions.kind, "failed_run_retry"),
              ),
            );
          expect(retries).toHaveLength(1);
          const retry = retries[0]!;
          const [resolved] = await db
            .select()
            .from(issueRecoveryActions)
            .where(eq(issueRecoveryActions.id, context.action.id));
          expect(resolved).toMatchObject({
            status: "resolved",
            evidence: {
              continuationDelivery: "delegated",
              continuationDeliveryOwner: {
                kind: "chat_failed_run_retry",
                actionId: retry.id,
              },
              executionReconciliation: { runId: context.runId },
            },
          });
          await Promise.all([
            context.service.processFailedChatRunRetry(retry.id),
            context.service.processFailedChatRunRetry(retry.id),
            deliverReconciledExecutions(db, context.genericWake),
            deliverReconciledExecutions(db, context.genericWake),
          ]);
          await context.resolve().expect(200);
          expect(context.genericWake).not.toHaveBeenCalled();
          expect(context.wakeup).toHaveBeenCalledTimes(1);
          const receipts = await readAgentWakeupRequestsById(retry.id);
          expect(receipts).toHaveLength(1);
          expect(receipts[0]).toMatchObject({
            status: "queued",
            payload: { retryOfRunId: context.runId, source: "chat:slack" },
          });
          expect(
            (
              await db
                .select()
                .from(issueRecoveryActions)
                .where(eq(issueRecoveryActions.id, context.action.id))
            )[0],
          ).toEqual(resolved);
        } finally {
          await context.cleanup();
        }
      },
    );

    it.each(["revoked_principal", "closed_conversation"] as const)(
      "retains the sole owner but refuses its deferred dispatch after %s",
      async (mode) => {
        const context = await fixture(true);
        try {
          await context.resolve().expect(200);
          const [retry] = await db
            .select()
            .from(chatActions)
            .where(
              and(
                eq(chatActions.endpointId, context.endpoint.id),
                eq(chatActions.kind, "failed_run_retry"),
              ),
            );
          expect(retry).toMatchObject({ status: "issued" });
          if (mode === "revoked_principal") {
            await db
              .update(chatIdentityLinks)
              .set({ status: "revoked", revokedAt: new Date() })
              .where(eq(chatIdentityLinks.endpointId, context.endpoint.id));
          } else {
            await db
              .update(chatConversations)
              .set({ state: "completed" })
              .where(eq(chatConversations.id, context.conversation.id));
          }
          await context.service.processFailedChatRunRetry(retry!.id);
          await deliverReconciledExecutions(db, context.genericWake);
          expect(context.wakeup).not.toHaveBeenCalled();
          expect(context.genericWake).not.toHaveBeenCalled();
          expect(
            await readAgentWakeupRequestsById(retry!.id),
          ).toEqual([]);
          expect(
            (
              await db
                .select()
                .from(issueRecoveryActions)
                .where(eq(issueRecoveryActions.id, context.action.id))
            )[0]?.evidence,
          ).toMatchObject({
            continuationDelivery: "delegated",
            continuationDeliveryOwner: {
              kind: "chat_failed_run_retry",
              actionId: retry!.id,
            },
          });
        } finally {
          await context.cleanup();
        }
      },
    );

    it.each([
      "revoked_principal",
      "closed_conversation",
      "missing_source",
    ] as const)(
      "does not resolve or mint a substitute owner for %s",
      async (mode) => {
        const context = await fixture();
        try {
          if (mode === "revoked_principal") {
            await db
              .update(chatIdentityLinks)
              .set({ status: "revoked", revokedAt: new Date() })
              .where(eq(chatIdentityLinks.endpointId, context.endpoint.id));
          } else if (mode === "closed_conversation") {
            await db
              .update(chatConversations)
              .set({ state: "completed" })
              .where(eq(chatConversations.id, context.conversation.id));
          } else {
            await db
              .update(heartbeatRuns)
              .set({
                contextSnapshot: {
                  issueId: context.issue.id,
                  source: "chat:slack",
                },
                wakeupRequestId: null,
              })
              .where(eq(heartbeatRuns.id, context.runId));
          }
          const response = await context.resolve();
          expect(response.status).toBe(409);
          expect(
            (
              await db
                .select()
                .from(issueRecoveryActions)
                .where(eq(issueRecoveryActions.id, context.action.id))
            )[0],
          ).toEqual(context.action);
          expect(
            (
              await readIssuesById(context.issue.id)
            )[0]?.status,
          ).toBe("blocked");
          expect(
            await db
              .select()
              .from(chatActions)
              .where(
                and(
                  eq(chatActions.endpointId, context.endpoint.id),
                  eq(chatActions.kind, "failed_run_retry"),
                ),
              ),
          ).toEqual([]);
          await deliverReconciledExecutions(db, context.genericWake);
          expect(context.genericWake).not.toHaveBeenCalled();
          expect(context.wakeup).not.toHaveBeenCalled();
        } finally {
          await context.cleanup();
        }
      },
    );
  });

  it("registers ordinary-notice work through the retry admission transaction", async () => {
    const context = await deferredFailedRetryNoticeFixture();
    const events: string[] = [];
    let eventsBeforeWrite: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.chatInboundWakeNotices, (event, scopes) => {
      if ([...scopes ?? []].some(scope => scope !== "*" && JSON.parse(scope).companyId === context.fixture.companyId)) events.push(event);
    });
    context.wakeup.mockImplementationOnce(async (_agentId, options) => {
      const request = options!.durableChatRequest!;
      await db.transaction(async tx => {
        events.length = 0;
        await request.authorize(tx as unknown as Parameters<typeof request.authorize>[0]);
        eventsBeforeWrite = [...events];
        await tx.insert(agentWakeupRequests).values({
          id: request.id, companyId: context.fixture.companyId, agentId: request.agentId,
          source: options!.source!, triggerDetail: options!.triggerDetail, reason: options!.reason,
          requestedByActorType: request.requestedByActorType, requestedByActorId: request.requestedByActorId,
          requestedAt: request.requestedAt, idempotencyKey: request.idempotencyKey,
          status: "deferred_issue_execution", payload: { ...options!.payload,
            taskRetryRequestId: context.retry.requestId, _paperclipWakeContext: options!.contextSnapshot },
        });
      });
      return null;
    });
    try {
      await expect(context.admit()).resolves.toMatchObject({ status: "deferred" });
      expect(eventsBeforeWrite).toContain("intent");
      expect(eventsBeforeWrite).not.toContain("settled");
      expect(events).toContain("settled");
      expect((await readAgentWakeupRequestsById(context.retry.chatActionId!))[0]).toMatchObject({ status: "deferred_issue_execution", runId: null });
    } finally { unsubscribe(); await context.service.shutdown(); }
  });

  it("registers ordinary-notice intent before a retry-owned receipt is retired", async () => {
    const context = await deferredFailedRetryNoticeFixture();
    let release = () => {};
    let holding: Promise<unknown> | undefined;
    let retiring: ReturnType<typeof context.admit> | undefined;
    let unsubscribe = () => {};
    const events: string[] = [];
    const signalledScopes: string[] = [];
    try {
      expect(await context.admit()).toMatchObject({ status: "deferred" });
      await reconcileTaskChatRetryReceipts(db);
      context.wakeup.mockClear();
      let locked!: () => void;
      const acquired = new Promise<void>(resolve => { locked = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      context.wakeup.mockImplementationOnce(async () => {
        holding = db.transaction(async tx => {
          await tx.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, context.retry.chatActionId!)).for("update");
          locked();
          await held;
        });
        await acquired;
        throw Object.assign(new Error("denied at resume"), {
          details: { code: "chat_failed_run_retry_not_authorized" },
        });
      });
      unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.chatInboundWakeNotices, (event, scopes) => {
        if ([...scopes ?? []].some(scope => scope !== "*" && JSON.parse(scope).companyId === context.fixture.companyId)) {
          events.push(event); signalledScopes.push(...scopes ?? []);
        }
      });
      retiring = context.admit();
      void retiring.catch(() => undefined);
      await vi.waitFor(() => expect(context.wakeup).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(events).toContain("intent"), { timeout: 2000 });
      expect(signalledScopes.map(scope => JSON.parse(scope))).toContainEqual({ companyId: context.fixture.companyId, issueId: context.issue.id });
      expect(events).not.toContain("settled");
      expect((await readAgentWakeupRequestsById(context.retry.chatActionId!))[0]).toMatchObject({ status: "deferred_issue_execution", runId: null });
      release(); await holding;
      await expect(retiring).resolves.toMatchObject({ status: "failed" });
      expect((await readAgentWakeupRequestsById(context.retry.chatActionId!))[0]).toMatchObject({ status: "failed", runId: null });
      expect(events).toContain("settled");
    } finally {
      release(); await holding; await retiring?.catch(() => undefined);
      unsubscribe(); await context.service.shutdown();
    }
  });

  it("retains one HTTP task Retry intent while saved chat identity authorization is busy", async () => {
    const f = await busyChatRetryHttpFixture();
    let restarted: ReturnType<typeof createService> | undefined;
    try {
      const { companyId, issueId, app } = f;
      const original = (await readHeartbeatRunsById(f.runId))[0];
      const originalInput = (await readAgentWakeupRequestsById(f.action.id))[0];
      const body = { observedRunId: f.runId, idempotencyKey: randomUUID() };
      const responses = await Promise.all([body, body, { ...body, idempotencyKey: randomUUID() }]
        .map(value => request(app).post(`/api/issues/${issueId}/retry`).send(value)));
      for (const response of responses) expect(response.status, JSON.stringify(response.body)).toBe(202);
      expect(responses[0].body.presentation).toMatchObject({ state: "retry_scheduled", canRetry: false });
      expect(new Set(responses.map(response => response.body.requestId)).size).toBe(1);
      expect(new Set(responses.map(response => response.body.chatActionId)).size).toBe(1);
      const response = responses[0];
      const [intent] = await readAgentWakeupRequestsById(response.body.requestId);
      expect(intent).toMatchObject({ reason: "task_retry", status: "deferred_issue_execution", runId: null });
      expect((await request(app).post(`/api/issues/${issueId}/retry`).send(body)).body.requestId).toBe(intent.id);
      const [action] = await db.select().from(chatActions).where(eq(chatActions.id, response.body.chatActionId));
      expect(action.payload).toMatchObject({ sourceAuthorizationPending: true, taskRetryIntentId: intent.id });
      expect(action.payload.sourceScopeSha256).toBeUndefined();
      await f.service.processFailedChatRunRetry(action.id);
      const [waiting] = await db.select().from(chatActions).where(eq(chatActions.id, action.id));
      expect(await taskInterruptionPresentation(db, (await readIssuesById(issueId))[0]))
        .toMatchObject({ state: "retry_scheduled", nextRetryAt: waiting.result!.retryAt, canRetry: false });
      expect((await readAgentWakeupRequestsById(f.action.id))[0]).toEqual(originalInput);
      await heartbeatService(db).resumeTaskRetry(companyId, intent.id);
      expect(f.wakeup).not.toHaveBeenCalled();
      expect(await readChatPublicationsByEndpointId(f.endpoint.id)).toEqual(f.originalPublications);
      expect((await readHeartbeatRunsByCompanyId(companyId)).filter(run => run.retryOfRunId === f.runId)).toHaveLength(0);
      expect((await db.select().from(chatActions).where(and(eq(chatActions.companyId, companyId),
        eq(chatActions.kind, "failed_run_retry"))))).toHaveLength(1);
      await f.service.shutdown();
      restarted = createService(new FakeChatSdkRuntime(), f.providerFetch, { wakeup: heartbeatService(db).wakeup });
      await f.releaseIdentity();
      await vi.waitFor(async () => {
        await restarted!.service.processFailedChatRunRetries();
        await reconcileTaskChatRetryReceipts(db, { companyId, requestId: intent.id });
        expect((await readAgentWakeupRequestsById(intent.id))[0]?.runId).toBeTruthy();
      }, { timeout: 5_000, interval: 50 });
      const [settled] = await readAgentWakeupRequestsById(intent.id);
      const [successor] = await readHeartbeatRunsById(settled.runId!);
      expect(successor).toMatchObject({ status: "queued", retryOfRunId: f.runId,
        contextSnapshot: { source: "chat:github", taskRetryRequestId: intent.id,
          wakeCommentIds: [f.action.payload.commentId] } });
      expect(restarted.wakeup).toHaveBeenCalledOnce();
      expect((await readHeartbeatRunsByCompanyId(companyId)).filter(run => run.retryOfRunId === f.runId)).toHaveLength(1);
      expect((await readHeartbeatRunsById(f.runId))[0]).toEqual(original);
      const [authorized] = await db.select().from(chatActions).where(eq(chatActions.id, action.id));
      expect(authorized.payload.sourceAuthorizationPending).toBeUndefined();
      expect(authorized.payload.sourceScopeSha256).toMatch(/^[a-f0-9]{64}$/);
      expect((await request(app).post(`/api/issues/${issueId}/retry`).send(body)).body.requestId).toBe(intent.id);
    } finally {
      await f.releaseIdentity();
      await restarted?.service.shutdown();
      await f.service.shutdown();
    }
  });

  it.each(["unchanged", "source_edited", "principal_revoked", "unknown_source", "actor_revoked_before"] as const)("retains HTTP Retry under the endpoint authorization row lock: %s", async mode => {
    const f = await busyChatRetryHttpFixture(true);
    let release = () => {};
    let holding: Promise<unknown> | undefined;
    try {
      await f.releaseIdentity();
      const sourceIds = [f.action.id, f.pending!.id];
      const originalInputs = await db.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, sourceIds))
        .orderBy(asc(agentWakeupRequests.id));
      if (mode === "unknown_source") {
        const [source] = await readHeartbeatRunsById(f.runId);
        await db.update(heartbeatRuns).set({ contextSnapshot: { ...source.contextSnapshot, source: "chat:unknown" } })
          .where(eq(heartbeatRuns.id, f.runId));
      }
      if (mode === "actor_revoked_before") await db.update(companyMemberships).set({ status: "suspended", updatedAt: new Date() })
        .where(and(eq(companyMemberships.companyId, f.companyId), eq(companyMemberships.principalId, "owner-user")));
      let acquired = () => {};
      const locked = new Promise<void>(resolve => { acquired = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      holding = db.transaction(async tx => {
        await tx.select({ id: chatEndpoints.id }).from(chatEndpoints).where(and(eq(chatEndpoints.companyId, f.companyId),
          eq(chatEndpoints.id, f.endpoint.id))).for("no key update");
        acquired(); await held;
      });
      await locked;
      const response = await request(f.app).post(`/api/issues/${f.issueId}/retry`)
        .send({ observedRunId: f.runId, idempotencyKey: randomUUID() });
      if (mode === "unknown_source" || mode === "actor_revoked_before") {
        expect(response.status, JSON.stringify(response.body)).toBe(mode === "unknown_source" ? 409 : 404);
        expect(await db.select().from(chatActions).where(and(eq(chatActions.companyId, f.companyId),
          eq(chatActions.kind, "failed_run_retry")))).toEqual([]);
        expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
          eq(agentWakeupRequests.reason, "task_retry")))).toEqual([]);
        expect(f.wakeup).not.toHaveBeenCalled();
        expect(await readChatPublicationsByEndpointId(f.endpoint.id)).toEqual(f.originalPublications);
        expect(await db.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, sourceIds))
          .orderBy(asc(agentWakeupRequests.id))).toEqual(originalInputs);
        expect((await readHeartbeatRunsByCompanyId(f.companyId)).filter(run => run.retryOfRunId === f.runId)).toHaveLength(0);
        return;
      }
      expect(response.status, JSON.stringify(response.body)).toBe(202);
      await f.service.processFailedChatRunRetry(response.body.chatActionId);
      expect((await db.select().from(chatActions).where(eq(chatActions.id, response.body.chatActionId)))[0])
        .toMatchObject({ status: "issued", payload: { sourceAuthorizationPending: true }, result: { attemptCount: 0 } });
      expect(f.wakeup).not.toHaveBeenCalled();
      expect(await db.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, sourceIds))
        .orderBy(asc(agentWakeupRequests.id))).toEqual(originalInputs);
      expect(await readChatPublicationsByEndpointId(f.endpoint.id)).toEqual(f.originalPublications);
      if (mode === "source_edited") await db.update(issueComments).set({ body: "Changed saved request",
        updatedAt: new Date(Date.now() + 1) }).where(eq(issueComments.id, String(f.pending!.payload.commentId)));
      if (mode === "principal_revoked") await db.update(companyMemberships).set({ status: "suspended", updatedAt: new Date() })
        .where(and(eq(companyMemberships.companyId, f.companyId), eq(companyMemberships.principalId, "owner-user")));
      release(); await holding;
      await vi.waitFor(async () => {
        await f.service.processFailedChatRunRetries();
        const [action] = await db.select().from(chatActions).where(eq(chatActions.id, response.body.chatActionId));
        expect(action.status).toBe(mode === "unchanged" ? "processed" : "failed");
      }, { timeout: 5_000, interval: 50 });
      if (mode === "unchanged") {
        await reconcileTaskChatRetryReceipts(db, { companyId: f.companyId, requestId: response.body.requestId });
        const [intent] = await readAgentWakeupRequestsById(response.body.requestId);
        expect((await readHeartbeatRunsById(intent.runId!))[0]).toMatchObject({ status: "queued", retryOfRunId: f.runId,
          contextSnapshot: { wakeCommentIds: [f.pending!.payload.commentId] } });
        expect(f.wakeup).toHaveBeenCalledOnce();
        expect((await readHeartbeatRunsByCompanyId(f.companyId)).filter(run => run.retryOfRunId === f.runId)).toHaveLength(1);
      } else {
        expect(f.wakeup).not.toHaveBeenCalled();
        expect((await readAgentWakeupRequestsById(response.body.requestId))[0]).toMatchObject({ status: "failed", runId: null });
        expect(await db.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, sourceIds))
          .orderBy(asc(agentWakeupRequests.id))).toEqual(originalInputs);
        expect(await readChatPublicationsByEndpointId(f.endpoint.id)).toEqual(f.originalPublications);
        expect((await readHeartbeatRunsByCompanyId(f.companyId)).filter(run => run.retryOfRunId === f.runId)).toHaveLength(0);
      }
    } finally { release(); await holding; await f.releaseIdentity(); await f.service.shutdown(); }
  });

  it("keeps a saved HTTP Retry alive through a healthy nine-second identity transaction", async () => {
    const f = await busyChatRetryHttpFixture();
    try {
      const original = (await readHeartbeatRunsById(f.runId))[0];
      const originalInput = (await readAgentWakeupRequestsById(f.action.id))[0];
      const response = await request(f.app).post(`/api/issues/${f.issueId}/retry`)
        .send({ observedRunId: f.runId, idempotencyKey: randomUUID() });
      expect(response.status, JSON.stringify(response.body)).toBe(202);
      const started = performance.now();
      await vi.waitFor(async () => {
        await f.service.processFailedChatRunRetries();
        expect(performance.now() - started).toBeGreaterThanOrEqual(9_000);
      }, { timeout: 12_000, interval: 50 });
      const [waiting] = await db.select().from(chatActions).where(eq(chatActions.id, response.body.chatActionId));
      expect(waiting.status).toBe("issued");
      expect(waiting.result?.attemptCount).toBe(0);
      expect(waiting.payload.sourceAuthorizationPending).toBe(true);
      expect(f.wakeup).not.toHaveBeenCalled();
      expect(await readChatPublicationsByEndpointId(f.endpoint.id)).toEqual(f.originalPublications);
      expect((await readAgentWakeupRequestsById(f.action.id))[0]).toEqual(originalInput);
      expect((await readHeartbeatRunsByCompanyId(f.companyId)).filter(run => run.retryOfRunId === f.runId)).toHaveLength(0);
      await f.releaseIdentity();
      await vi.waitFor(async () => {
        await f.service.processFailedChatRunRetries();
        await reconcileTaskChatRetryReceipts(db, { companyId: f.companyId, requestId: response.body.requestId });
        expect((await readAgentWakeupRequestsById(response.body.requestId))[0]?.runId).toBeTruthy();
      }, { timeout: 5_000, interval: 50 });
      expect(f.wakeup).toHaveBeenCalledOnce();
      expect((await readHeartbeatRunsByCompanyId(f.companyId)).filter(run => run.retryOfRunId === f.runId)).toHaveLength(1);
      expect((await readHeartbeatRunsById(f.runId))[0]).toEqual(original);
    } finally { await f.releaseIdentity(); await f.service.shutdown(); }
  }, 30_000);

  it("projects prepared but unsettled task Retry using its actual stale-claim deadline", async () => {
    const f = await busyChatRetryHttpFixture();
    let releaseWake = () => {};
    const heldWake = new Promise<void>(resolve => { releaseWake = resolve; });
    let processing: ReturnType<typeof f.service.processFailedChatRunRetry> | undefined;
    try {
      const response = await request(f.app).post(`/api/issues/${f.issueId}/retry`)
        .send({ observedRunId: f.runId, idempotencyKey: randomUUID() });
      expect(response.status, JSON.stringify(response.body)).toBe(202);
      await f.service.processFailedChatRunRetry(response.body.chatActionId);
      const [waiting] = await db.select().from(chatActions).where(eq(chatActions.id, response.body.chatActionId));
      await f.releaseIdentity();
      const wake = heartbeatService(db).wakeup;
      f.wakeup.mockImplementation(async (...args) => { await heldWake; return wake(...args); });
      await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(String(waiting.result?.retryAt)) - Date.now()) + 1));
      processing = f.service.processFailedChatRunRetry(response.body.chatActionId);
      await vi.waitFor(() => expect(f.wakeup).toHaveBeenCalledOnce());
      const [prepared] = await db.select().from(chatActions).where(eq(chatActions.id, response.body.chatActionId));
      expect(prepared.status).toBe("processing");
      expect(prepared.payload.sourceAuthorizationPending).toBeUndefined();
      expect((await readAgentWakeupRequestsById(response.body.requestId))[0]?.runId).toBeNull();
      const deadline = await f.service.nextChatActionAt("failed_run_retry");
      expect(deadline).not.toBeNull();
      expect(await taskInterruptionPresentation(db, (await readIssuesById(f.issueId))[0]))
        .toMatchObject({ state: "retry_scheduled", canRetry: false, nextRetryAt: new Date(deadline!).toISOString() });
      releaseWake();
      await processing;
      await reconcileTaskChatRetryReceipts(db, { companyId: f.companyId, requestId: response.body.requestId });
      expect((await readAgentWakeupRequestsById(response.body.requestId))[0]?.runId).toBeTruthy();
      expect(await taskInterruptionPresentation(db, (await readIssuesById(f.issueId))[0]))
        .toMatchObject({ state: "working", nextRetryAt: null });
    } finally { releaseWake(); await processing; await f.releaseIdentity(); await f.service.shutdown(); }
  });

  it.each(["source_edited", "principal_revoked", "stopped", "mixed_publications", "newer_queued_run"] as const)(
    "does not adopt input or deliver a pending identity-contended Retry after %s", async mode => {
      const f = await busyChatRetryHttpFixture();
      try {
        let expectedPublications = f.originalPublications;
        const originalInput = (await readAgentWakeupRequestsById(f.action.id))[0];
        const response = await request(f.app).post(`/api/issues/${f.issueId}/retry`)
          .send({ observedRunId: f.runId, idempotencyKey: randomUUID() });
        expect(response.status, JSON.stringify(response.body)).toBe(202);
        await f.service.processFailedChatRunRetry(response.body.chatActionId);
        if (mode === "source_edited") await db.update(issueComments).set({ body: "Changed saved request",
          updatedAt: new Date(Date.now() + 1) }).where(eq(issueComments.id, String(f.action.payload.commentId)));
        if (mode === "principal_revoked") await db.update(companyMemberships).set({ status: "suspended", updatedAt: new Date() })
          .where(and(eq(companyMemberships.companyId, f.companyId), eq(companyMemberships.principalId, "owner-user")));
        if (mode === "stopped") await heartbeatService(db).cancelInvocationsForAgents([f.fixture.assignedAgentId], "operator_stop");
        if (mode === "newer_queued_run") {
          const [source] = await readHeartbeatRunsById(f.runId);
          await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.fixture.assignedAgentId,
            issueId: f.issueId, nativeIssueId: f.issueId, runtimeMode: "native", status: "queued",
            createdAt: new Date(Math.max(Date.now(), source.createdAt.getTime() + 1)),
            contextSnapshot: { issueId: f.issueId } });
        }
        if (mode === "mixed_publications") {
          const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
            authorAgentId: f.fixture.assignedAgentId, createdByRunId: f.runId, body: "Saved failed result" }).returning();
          await db.insert(chatPublications).values((["failed", "delivery_unknown"] as const).map(state => ({
            companyId: f.companyId, endpointId: f.endpoint.id, conversationId: f.conversation.id,
            issueId: f.issueId, commentId: comment.id, idempotencyKey: `run:${f.runId}:${state}`,
            payload: { text: comment.body }, state,
          })));
          expectedPublications = await readChatPublicationsByEndpointId(f.endpoint.id);
        }
        const expectedRunIds = (await readHeartbeatRunsByCompanyId(f.companyId)).map(run => run.id).sort();
        await f.releaseIdentity();
        await vi.waitFor(async () => {
          await f.service.processFailedChatRunRetries();
          const [action] = await db.select().from(chatActions).where(eq(chatActions.id, response.body.chatActionId));
          expect(action.status).toBe("failed");
        }, { timeout: 5_000, interval: 50 });
        expect(f.wakeup).not.toHaveBeenCalled();
        expect(await readChatPublicationsByEndpointId(f.endpoint.id)).toEqual(expectedPublications);
        expect(await taskInterruptionPresentation(db, (await readIssuesById(f.issueId))[0]))
          .toMatchObject({ state: mode === "newer_queued_run" ? "working" : "failed", nextRetryAt: null });
        expect((await readAgentWakeupRequestsById(f.action.id))[0]).toEqual(originalInput);
        expect((await readAgentWakeupRequestsById(response.body.requestId))[0]?.runId).toBeNull();
        if (mode === "stopped") expect((await readAgentWakeupRequestsById(response.body.requestId))[0]?.status).toBe("cancelled");
        expect((await readHeartbeatRunsByCompanyId(f.companyId)).filter(run => run.retryOfRunId === f.runId)).toHaveLength(0);
        expect((await readHeartbeatRunsByCompanyId(f.companyId)).map(run => run.id).sort()).toEqual(expectedRunIds);
      } finally { await f.releaseIdentity(); await f.service.shutdown(); }
    });

  it.each([false, true])("expires the saved identity wait without renewal when the lock is released before expiry processing: %s", async released => {
    const f = await busyChatRetryHttpFixture();
    let restarted: ReturnType<typeof createService> | undefined;
    try {
      const originalInput = (await readAgentWakeupRequestsById(f.action.id))[0];
      const body = { observedRunId: f.runId, idempotencyKey: randomUUID() };
      const response = await request(f.app).post(`/api/issues/${f.issueId}/retry`).send(body);
      expect(response.status, JSON.stringify(response.body)).toBe(202);
      const [saved] = await db.select().from(chatActions).where(eq(chatActions.id, response.body.chatActionId));
      const deadline = String(saved.result?.identityContentionDeadlineAt);
      expect(Date.parse(deadline)).toBe(saved.createdAt.getTime() + 60_000);
      await f.service.processFailedChatRunRetry(saved.id);
      const [waiting] = await db.select().from(chatActions).where(eq(chatActions.id, saved.id));
      expect(waiting.result).toMatchObject({ attemptCount: 0, identityContentionCount: 1,
        identityContentionDeadlineAt: deadline });
      expect(Date.parse(String(waiting.result?.retryAt))).toBeLessThanOrEqual(Date.parse(deadline));
      for (const value of [body, { ...body, idempotencyKey: randomUUID() }]) {
        const duplicate = await request(f.app).post(`/api/issues/${f.issueId}/retry`).send(value);
        expect(duplicate.status, JSON.stringify(duplicate.body)).toBe(202);
        expect(duplicate.body.requestId).toBe(response.body.requestId);
      }
      expect((await db.select().from(chatActions).where(eq(chatActions.id, saved.id)))[0].result)
        .toEqual(waiting.result);
      await f.service.shutdown();
      restarted = createService(new FakeChatSdkRuntime(), f.providerFetch, { wakeup: heartbeatService(db).wakeup });
      const expiredDeadline = new Date(Date.now() - 1).toISOString();
      await db.update(chatActions).set({ result: { ...waiting.result,
        identityContentionDeadlineAt: expiredDeadline, retryAt: expiredDeadline } }).where(eq(chatActions.id, saved.id));
      if (released) await f.releaseIdentity();
      await restarted.service.processFailedChatRunRetries();
      const [failed] = await db.select().from(chatActions).where(eq(chatActions.id, saved.id));
      expect(failed).toMatchObject({ status: "failed", payload: { sourceAuthorizationPending: true },
        result: { code: "failed_chat_retry_contention_expired", attemptCount: 0,
          identityContentionDeadlineAt: expiredDeadline } });
      expect(failed.result?.retryAt).toBeUndefined();
      await f.releaseIdentity();
      await restarted.service.processFailedChatRunRetries();
      await restarted.service.processFailedChatRunRetry(saved.id);
      await heartbeatService(db).resumeTaskRetry(f.companyId, response.body.requestId);
      expect((await db.select().from(chatActions).where(eq(chatActions.id, saved.id)))[0]).toEqual(failed);
      expect((await readAgentWakeupRequestsById(response.body.requestId))[0]).toMatchObject({ status: "failed", runId: null });
      expect((await readAgentWakeupRequestsById(f.action.id))[0]).toEqual(originalInput);
      expect(restarted.wakeup).not.toHaveBeenCalled();
      expect(f.wakeup).not.toHaveBeenCalled();
      expect(await readChatPublicationsByEndpointId(f.endpoint.id)).toEqual(f.originalPublications);
      expect((await readHeartbeatRunsByCompanyId(f.companyId)).filter(run => run.retryOfRunId === f.runId)).toHaveLength(0);
    } finally { await f.releaseIdentity(); await restarted?.service.shutdown(); await f.service.shutdown(); }
  });

  it("persists the first identity wait deadline for an older pending action", async () => {
    const f = await busyChatRetryHttpFixture();
    let restarted: ReturnType<typeof createService> | undefined;
    try {
      const response = await request(f.app).post(`/api/issues/${f.issueId}/retry`)
        .send({ observedRunId: f.runId, idempotencyKey: randomUUID() });
      expect(response.status, JSON.stringify(response.body)).toBe(202);
      await f.service.processFailedChatRunRetry(response.body.chatActionId);
      await db.update(chatActions).set({ result: { code: "failed_chat_retry_contended", attemptCount: 0 } })
        .where(eq(chatActions.id, response.body.chatActionId));
      const startedAt = Date.now();
      await f.service.processFailedChatRunRetry(response.body.chatActionId);
      const [waiting] = await db.select().from(chatActions).where(eq(chatActions.id, response.body.chatActionId));
      const deadline = Date.parse(String(waiting.result?.identityContentionDeadlineAt));
      expect(deadline).toBeGreaterThanOrEqual(startedAt + 60_000);
      expect(deadline).toBeLessThanOrEqual(Date.now() + 60_000);
      await f.service.shutdown();
      restarted = createService(new FakeChatSdkRuntime(), f.providerFetch, { wakeup: heartbeatService(db).wakeup });
      await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(String(waiting.result?.retryAt)) - Date.now()) + 1));
      await restarted.service.processFailedChatRunRetries();
      const [again] = await db.select().from(chatActions).where(eq(chatActions.id, response.body.chatActionId));
      expect(again.result).toMatchObject({ attemptCount: 0, identityContentionCount: 2,
        identityContentionDeadlineAt: waiting.result?.identityContentionDeadlineAt });
      expect(restarted.wakeup).not.toHaveBeenCalled();
    } finally { await f.releaseIdentity(); await restarted?.service.shutdown(); await f.service.shutdown(); }
  });

  it.each(["early_release", "expired_release", "authorization_expired"] as const)("honors a prepared Retry identity wait after %s", async mode => {
    const f = await busyChatRetryHttpFixture();
    let release = () => {};
    let holding: Promise<unknown> | undefined;
    let releaseAuthorization = () => {};
    let authorizationHolding: Promise<unknown> | undefined;
    let processing: Promise<void> | undefined;
    try {
      const originalInput = (await readAgentWakeupRequestsById(f.action.id))[0];
      const response = await request(f.app).post(`/api/issues/${f.issueId}/retry`)
        .send({ observedRunId: f.runId, idempotencyKey: randomUUID() });
      expect(response.status, JSON.stringify(response.body)).toBe(202);
      await f.service.processFailedChatRunRetry(response.body.chatActionId);
      const processDue = async () => {
        const [current] = await db.select().from(chatActions).where(eq(chatActions.id, response.body.chatActionId));
        await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(String(current.result?.retryAt)) - Date.now()) + 1));
        await f.service.processFailedChatRunRetry(current.id);
      };
      await f.releaseIdentity();
      f.wakeup.mockRejectedValueOnce(new Error("temporary_wakeup_unavailable"));
      await processDue();
      const [prepared] = await db.select().from(chatActions).where(eq(chatActions.id, response.body.chatActionId));
      expect(prepared.status).toBe("issued");
      expect(prepared.payload.sourceAuthorizationPending).toBeUndefined();
      expect(prepared.result?.identityContentionPending).toBeUndefined();
      let acquired = () => {};
      const locked = new Promise<void>(resolve => { acquired = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      holding = db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`chat-identity:${f.companyId}:${f.action.principalId}`}, 0))`);
        acquired(); await held;
      });
      await locked;
      await processDue();
      const [waiting] = await db.select().from(chatActions).where(eq(chatActions.id, response.body.chatActionId));
      expect(waiting).toMatchObject({ status: "issued", result: { attemptCount: 1, identityContentionCount: 2,
        identityContentionDeadlineAt: prepared.result?.identityContentionDeadlineAt } });
      expect(f.wakeup).toHaveBeenCalledOnce();
      if (mode === "expired_release") {
        const expired = new Date(Date.now() - 1).toISOString();
        await db.update(chatActions).set({ result: { ...waiting.result,
          identityContentionDeadlineAt: expired, retryAt: expired } }).where(eq(chatActions.id, waiting.id));
      }
      let authorizationDeadline = 0, authorizationPid = 0;
      if (mode === "authorization_expired") {
        authorizationDeadline = Date.now() + 5_000;
        await db.update(chatActions).set({ result: { ...waiting.result,
          identityContentionDeadlineAt: new Date(authorizationDeadline).toISOString(), retryAt: new Date(0).toISOString() } })
          .where(eq(chatActions.id, waiting.id));
        let acquiredAuthorization = () => {};
        const authorizationLocked = new Promise<void>(resolve => { acquiredAuthorization = resolve; });
        const heldAuthorization = new Promise<void>(resolve => { releaseAuthorization = resolve; });
        authorizationHolding = db.transaction(async tx => {
          await tx.select({ id: chatConversations.id }).from(chatConversations).where(and(
            eq(chatConversations.companyId, f.companyId), eq(chatConversations.id, f.conversation.id))).for("update");
          const [{ pid }] = await tx.execute(sql`select pg_backend_pid() as pid`);
          authorizationPid = Number(pid);
          acquiredAuthorization(); await heldAuthorization;
        });
        await authorizationLocked;
      }
      release(); await holding;
      if (mode === "authorization_expired") {
        processing = processDue();
        await vi.waitFor(async () => {
          const [{ blocked }] = await db.execute(sql`select exists(select 1 from pg_stat_activity
            where ${authorizationPid} = any(pg_blocking_pids(pid))) as blocked`);
          expect(blocked).toBe(true);
        }, { timeout: 5_000, interval: 25 });
        await new Promise(resolve => setTimeout(resolve, Math.max(0, authorizationDeadline - Date.now()) + 1));
        releaseAuthorization(); await authorizationHolding;
        await processing;
      } else await processDue();
      const [settled] = await db.select().from(chatActions).where(eq(chatActions.id, waiting.id));
      expect(settled.status).toBe(mode === "early_release" ? "processed" : "failed");
      expect(settled.result?.identityContentionPending).toBeUndefined();
      if (mode !== "early_release") {
        expect(settled.result).toMatchObject({ code: "failed_chat_retry_contention_expired", attemptCount: 1 });
        expect(f.wakeup).toHaveBeenCalledOnce();
        expect((await readAgentWakeupRequestsById(response.body.requestId))[0]).toMatchObject({ status: "failed", runId: null });
        expect((await readAgentWakeupRequestsById(f.action.id))[0]).toEqual(originalInput);
        expect(await readChatPublicationsByEndpointId(f.endpoint.id)).toEqual(f.originalPublications);
        expect((await readHeartbeatRunsByCompanyId(f.companyId)).filter(run => run.retryOfRunId === f.runId)).toHaveLength(0);
      } else {
        await reconcileTaskChatRetryReceipts(db, { companyId: f.companyId, requestId: response.body.requestId });
        expect((await readAgentWakeupRequestsById(response.body.requestId))[0]?.runId).toBeTruthy();
        expect(f.wakeup).toHaveBeenCalledTimes(2);
        expect((await readHeartbeatRunsByCompanyId(f.companyId)).filter(run => run.retryOfRunId === f.runId)).toHaveLength(1);
      }
    } finally {
      releaseAuthorization(); release(); await authorizationHolding; await processing;
      await holding; await f.releaseIdentity(); await f.service.shutdown();
    }
  });

  it.each(["restart", "stopped", "ack_lost"] as const)("recovers the committed authorization phase after %s without renewing its deadline", async mode => {
    const f = await busyChatRetryHttpFixture();
    let restarted: ReturnType<typeof createService> | undefined;
    let releaseWake = () => {};
    const heldWake = new Promise<void>(resolve => { releaseWake = resolve; });
    let oldProcessing: ReturnType<typeof f.service.processFailedChatRunRetry> | undefined;
    let oldShutdown: Promise<void> | undefined;
    let restoreBegin = () => {};
    try {
      const original = (await readHeartbeatRunsById(f.runId))[0];
      const originalInput = (await readAgentWakeupRequestsById(f.action.id))[0];
      const response = await request(f.app).post(`/api/issues/${f.issueId}/retry`)
        .send({ observedRunId: f.runId, idempotencyKey: randomUUID() });
      expect(response.status, JSON.stringify(response.body)).toBe(202);
      await f.service.processFailedChatRunRetry(response.body.chatActionId);
      const [pending] = await db.select().from(chatActions).where(eq(chatActions.id, response.body.chatActionId));
      const deadline = new Date(Date.now() + 5_000).toISOString();
      await db.update(chatActions).set({ result: { ...pending.result,
        identityContentionDeadlineAt: deadline, retryAt: new Date(0).toISOString() } }).where(eq(chatActions.id, pending.id));
      let lostAck = false;
      if (mode === "ack_lost") {
        const begin = db.$client.begin.bind(db.$client);
        const fault = vi.spyOn(db.$client, "begin").mockImplementation((async (...args: unknown[]) => {
          const value = await Reflect.apply(begin, db.$client, args);
          if (!lostAck && value?.intent?.id === pending.id) {
            const [committed] = await db.select().from(chatActions).where(eq(chatActions.id, pending.id));
            expect(committed.result?.identityContentionPending).toBeUndefined();
            const expectedResult = { ...value.intent.result };
            delete expectedResult.identityContentionPending;
            expect(committed.result).toEqual(expectedResult);
            expect(committed.updatedAt).toEqual(value.intent.updatedAt);
            lostAck = true;
            throw new Error("authorization_commit_ack_lost");
          }
          return value;
        }) as typeof db.$client.begin);
        restoreBegin = () => fault.mockRestore();
      } else f.wakeup.mockImplementation(async () => { await heldWake; throw new Error("owner_lost_before_wakeup"); });
      await f.releaseIdentity();
      oldProcessing = f.service.processFailedChatRunRetry(pending.id);
      if (mode === "ack_lost") {
        await oldProcessing;
        restoreBegin();
        expect(lostAck).toBe(true);
        expect(f.wakeup).not.toHaveBeenCalled();
        await reconcileDatabaseWork(db, CHAT_ACTION_QUEUES.failed_run_retry);
      } else await vi.waitFor(() => expect(f.wakeup).toHaveBeenCalledOnce());
      const [authorized] = await db.select().from(chatActions).where(eq(chatActions.id, pending.id));
      if (mode !== "ack_lost") expect(authorized.status).toBe("processing");
      expect(authorized.payload.sourceAuthorizationPending).toBeUndefined();
      expect((await readAgentWakeupRequestsById(pending.id))[0]).toBeUndefined();
      oldShutdown = f.service.shutdown();
      await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(deadline) - Date.now()) + 1));
      await db.update(chatActions).set({ updatedAt: new Date(Date.now() - 60_001) }).where(eq(chatActions.id, pending.id));
      if (mode === "stopped") await heartbeatService(db).cancelInvocationsForAgents([f.fixture.assignedAgentId], "operator_stop");
      restarted = createService(new FakeChatSdkRuntime(), f.providerFetch, { wakeup: heartbeatService(db).wakeup });
      await restarted.service.processFailedChatRunRetry(pending.id);
      await reconcileTaskChatRetryReceipts(db, { companyId: f.companyId, requestId: response.body.requestId });
      const [settled] = await db.select().from(chatActions).where(eq(chatActions.id, pending.id));
      const [intent] = await readAgentWakeupRequestsById(response.body.requestId);
      if (mode !== "stopped") {
        expect(settled.status).toBe("processed");
        expect(intent.runId).toBeTruthy();
        expect(restarted.wakeup).toHaveBeenCalledOnce();
        expect((await readHeartbeatRunsByCompanyId(f.companyId)).filter(run => run.retryOfRunId === f.runId)
          .map(run => run.id)).toEqual([intent.runId]);
      } else {
        expect(["issued", "failed"]).toContain(settled.status);
        expect(intent).toMatchObject({ status: "cancelled", runId: null });
        expect(restarted.wakeup).toHaveBeenCalledOnce();
        await expect(restarted.wakeup.mock.results[0].value).resolves.toBeNull();
        expect((await readAgentWakeupRequestsById(pending.id))[0]).toBeUndefined();
        expect((await readHeartbeatRunsByCompanyId(f.companyId)).filter(run => run.retryOfRunId === f.runId)).toHaveLength(0);
      }
      expect(authorized.result?.identityContentionPending).toBeUndefined();
      expect(settled.result?.identityContentionDeadlineAt).toBe(deadline);
      expect(settled.result?.identityContentionCount).toBe(pending.result?.identityContentionCount);
      if (mode === "ack_lost") expect(settled.result?.attemptCount).toBe(2);
      expect(await readChatPublicationsByEndpointId(f.endpoint.id)).toEqual(f.originalPublications);
      expect((await readHeartbeatRunsById(f.runId))[0]).toEqual(original);
      expect((await readAgentWakeupRequestsById(f.action.id))[0]).toEqual(originalInput);
      releaseWake(); await oldProcessing; await oldShutdown;
      expect((await db.select().from(chatActions).where(eq(chatActions.id, pending.id)))[0]).toEqual(settled);
    } finally {
      restoreBegin();
      releaseWake(); await oldProcessing; await oldShutdown;
      await f.releaseIdentity(); await restarted?.service.shutdown(); await f.service.shutdown();
    }
  });

  it("exhausts the existing delivery Retry budget after identity authorization without background renewal", async () => {
    const f = await busyChatRetryHttpFixture();
    try {
      const originalInput = (await readAgentWakeupRequestsById(f.action.id))[0];
      const response = await request(f.app).post(`/api/issues/${f.issueId}/retry`)
        .send({ observedRunId: f.runId, idempotencyKey: randomUUID() });
      expect(response.status, JSON.stringify(response.body)).toBe(202);
      await f.service.processFailedChatRunRetry(response.body.chatActionId);
      const [contended] = await db.select().from(chatActions).where(eq(chatActions.id, response.body.chatActionId));
      await f.releaseIdentity();
      f.wakeup.mockRejectedValue(new Error("temporary_wakeup_unavailable"));
      for (let attempt = 0; attempt < 8; attempt++) {
        const [current] = await db.select().from(chatActions).where(eq(chatActions.id, response.body.chatActionId));
        if (current.status === "failed") break;
        const retryAt = Date.parse(String(current.result?.retryAt));
        expect(Number.isFinite(retryAt)).toBe(true);
        await new Promise(resolve => setTimeout(resolve, Math.max(0, retryAt - Date.now()) + 1));
        await f.service.processFailedChatRunRetries();
      }
      const [failed] = await db.select().from(chatActions).where(eq(chatActions.id, response.body.chatActionId));
      expect(failed).toMatchObject({ status: "failed", result: { attemptCount: 8, identityContentionCount: 1,
        identityContentionDeadlineAt: contended.result?.identityContentionDeadlineAt } });
      expect(failed.payload.sourceAuthorizationPending).toBeUndefined();
      expect(f.wakeup).toHaveBeenCalledTimes(8);
      await f.service.processFailedChatRunRetries();
      await f.service.processFailedChatRunRetry(failed.id);
      await heartbeatService(db).resumeTaskRetry(f.companyId, response.body.requestId);
      expect((await db.select().from(chatActions).where(eq(chatActions.id, failed.id)))[0]).toEqual(failed);
      expect((await readAgentWakeupRequestsById(response.body.requestId))[0]).toMatchObject({ status: "failed", runId: null });
      expect((await readAgentWakeupRequestsById(f.action.id))[0]).toEqual(originalInput);
      expect(f.wakeup).toHaveBeenCalledTimes(8);
      expect(await readChatPublicationsByEndpointId(f.endpoint.id)).toEqual(f.originalPublications);
    } finally { await f.releaseIdentity(); await f.service.shutdown(); }
  }, 20_000);

  it.each((["github", "telegram"] as const).flatMap(provider =>
    (["writer_setup", "other_setup", "late_event", "retained_native", "accepted_result", "source_changed", "untrusted_metadata", "live_controller", "process", "environment", "prior_writer"] as const).map(mode => ({ provider, mode }))))(
    "retries a fully recorded never-dispatched $provider setup through HTTP: $mode", async ({ provider, mode }) => {
      const f = provider === "github" ? await currentGitHubTaskRetryFixture() : await failedChatRetryFixture("telegram", undefined, true);
      const { issueRoutes } = await import("../../routes/issues.js");
      const companyId = f.fixture.companyId, issueId = f.issue.id;
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.actor = boardActor(companyId); next(); });
      app.use("/api", issueRoutes(db, createStorageService().storage, { chatRunRetries: f.service }));
      app.use(errorHandler);
      try {
        if (provider === "telegram") {
          await db.update(agents).set({ adapterType: "paperclip_runner", status: "running",
            runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } })
            .where(eq(agents.id, f.fixture.assignedAgentId));
          await db.insert(heartbeatRuns).values({ companyId, agentId: f.fixture.assignedAgentId,
            status: "running", startedAt: new Date() });
          f.wakeup.mockImplementation(heartbeatService(db).wakeup);
        }
        await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.runId));
        await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
        const diagnostic = mode === "other_setup" ? "A different preparation failure" : "The workspace still has an unfinished writer or save operation.";
        await db.update(heartbeatRuns).set({ runtimeMode: "legacy", nativeIssueId: null, nativePhase: null,
          errorCode: "setup_failed", error: diagnostic, sessionIdBefore: "inherited-display-hint",
          runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
          usageJson: { ledgerScope: { issueId, projectId: null, billingCode: null } },
          resultJson: { stopReason: "adapter_failed", executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
            timeoutFired: false, timeoutSource: "config", timeoutConfigured: false, effectiveTimeoutSec: 0,
            ...(mode === "untrusted_metadata" ? { providerOutput: "Untrusted adapter data" } : {}),
          },
          ...(mode === "live_controller" ? { controllerLeaseExpiresAt: new Date(Date.now() + 60_000) } : {}),
          ...(mode === "process" ? { processPid: 999999999, processGroupId: 999999999 } : {}),
        }).where(eq(heartbeatRuns.id, f.runId));
        await db.insert(heartbeatRunEvents).values([
          { companyId, agentId: f.fixture.assignedAgentId, runId: f.runId, seq: 1,
            eventType: "error", stream: "system", level: "error", message: diagnostic },
          { companyId, agentId: f.fixture.assignedAgentId, runId: f.runId, seq: 2,
            eventType: "lifecycle", stream: "system", message: "task.run.measured",
            payload: { phase: "task.run.measured", outcome: "failed", durableSettlement: true, durationMs: 5 } },
        ]);
        if (mode === "late_event") await db.insert(heartbeatRunEvents).values({ companyId,
          agentId: f.fixture.assignedAgentId, runId: f.runId, seq: 3, eventType: "session.started",
          sourceInstanceId: randomUUID(), payload: { prpEvent: { sourceKind: "runner" } } });
        if (mode === "retained_native") {
          await db.update(heartbeatRuns).set({ nativeIssueId: issueId }).where(eq(heartbeatRuns.id, f.runId));
          await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId: f.runId, phase: "terminal_failure" });
        }
        if (mode === "environment") await db.insert(environmentLeases).values({ companyId, issueId,
          heartbeatRunId: f.runId, provider: "daytona", providerLeaseId: randomUUID(), status: "active" });
        if (mode === "prior_writer") {
          const previousId = randomUUID();
          await db.insert(heartbeatRuns).values({ id: previousId, companyId, nativeIssueId: issueId,
            agentId: f.fixture.assignedAgentId, status: "failed", runtimeMode: "native", nativePhase: "terminal_failure",
            createdAt: new Date(Date.now() - 60_000), finishedAt: new Date(Date.now() - 30_000) });
          await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: previousId,
            provider: "daytona", providerLeaseId: randomUUID(), status: "pending_cleanup", cleanupStatus: "failed" });
          await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId,
            kind: "active_run_watchdog", status: "resolved", ownerType: "system", outcome: "blocked",
            cause: "native_continuation_requires_reconciliation", fingerprint: randomUUID(), nextAction: "Previous writer remains unknown",
            evidence: { runId: previousId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } } });
        }
        if (mode === "source_changed") await db.update(issueComments).set({ body: "Edited after admission", updatedAt: new Date() })
          .where(eq(issueComments.id, String(f.action.payload.commentId)));
        if (mode === "accepted_result") {
          const contractId = randomUUID(), resultId = randomUUID();
          await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
            schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard",
            completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: {},
            canonicalSha256: contractId, createdByActorType: "system", createdByActorId: "test" });
          await db.update(heartbeatRuns).set({ nativeIssueId: issueId, completionContractId: contractId })
            .where(eq(heartbeatRuns.id, f.runId));
          await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId, runId: f.runId,
            completionContractId: contractId, serverFingerprint: resultId, schemaStatus: "accepted", canonicalSha256: resultId,
            resultJson: { terminal: { runTerminalState: "succeeded" }, summary: "Existing output stays history" } });
        }
        const original = (await readHeartbeatRunsById(f.runId))[0];
        const response = await request(app).post(`/api/issues/${issueId}/retry`).send({ observedRunId: f.runId,
          idempotencyKey: randomUUID() });
        if (mode === "writer_setup" || mode === "other_setup") {
          expect(response.status, JSON.stringify(response.body)).toBe(202);
          await f.service.processFailedChatRunRetry(response.body.chatActionId);
          await expect.poll(async () => (await readAgentWakeupRequestsById(response.body.requestId))[0]?.runId).toBeTruthy();
          const [intent] = await readAgentWakeupRequestsById(response.body.requestId);
          const [successor] = await readHeartbeatRunsById(intent.runId!);
          expect(successor).toMatchObject({ status: "queued", retryOfRunId: f.runId,
            contextSnapshot: { taskRetryRequestId: intent.id, wakeCommentIds: [f.action.payload.commentId] } });
          expect((await readHeartbeatRunsByCompanyId(companyId)).filter(run => run.retryOfRunId === f.runId)).toHaveLength(1);
        } else {
          expect([202, 409], JSON.stringify(response.body)).toContain(response.status);
          if (response.status === 202) {
            const outcome = await f.service.processFailedChatRunRetry(response.body.chatActionId);
            expect(outcome.status).not.toBe("queued");
          }
          expect((await readHeartbeatRunsByCompanyId(companyId)).filter(run => run.retryOfRunId === f.runId)).toHaveLength(0);
        }
        expect((await readHeartbeatRunsById(f.runId))[0]).toEqual(original);
      } finally { await f.service.shutdown(); }
    },
  );

  it.each(["settled", "pending_at_intake", "source_edited", "operator_stopped", "unknown_stop", "live_owner", "absent_sandbox"] as const)(
    "keeps the admitted chat Retry queued until its source lease cleanup settles: %s", async mode => {
    const f = await currentGitHubTaskRetryFixture();
    const companyId = f.fixture.companyId, issueId = f.issue.id;
    const heartbeat = heartbeatService(db);
    const errors: unknown[] = [];
    let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
    let releaseWorkspaceOwner: () => void = () => undefined;
    let workspaceOwner: Promise<unknown> | undefined;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = boardActor(companyId); next(); });
    app.use("/api", issueRoutes(db, createStorageService().storage, { chatRunRetries: f.service }));
    app.use(errorHandler);
    const lease = { id: randomUUID(), companyId, issueId, heartbeatRunId: f.runId,
      provider: "daytona", providerLeaseId: randomUUID(), status: "released", cleanupStatus: "success",
      releasedAt: new Date(), leasePolicy: "retain_on_failure" };
    const termination = remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "stopped" })!;
    const metadata = { remoteExecutionTermination: termination, sandboxStopAndRetainReceipt: {
      schema: "paperclip.sandbox-stop-and-retain-receipt.v1", companyId, runId: f.runId,
      leaseId: lease.id, provider: lease.provider, providerLeaseId: lease.providerLeaseId,
      requestId: randomUUID(), confirmedAt: termination.confirmedAt, builtinProvider: "daytona", method: "builtin.stopLease",
    } };
    await db.insert(environmentLeases).values({ ...lease, metadata,
      ...(mode === "pending_at_intake" ? { status: "pending_cleanup", cleanupStatus: "failed" } : {}) });
    await db.update(nativeRunFinalizations).set({ failureCode: "native_session_interrupted",
      failureDetail: { recoveryMode: "ambiguous_state", providerSessionEstablished: false,
        providerEventsExist: false, checkpointExists: false } }).where(eq(nativeRunFinalizations.runId, f.runId));
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", status: "resolved", outcome: "blocked", ownerType: "system",
      cause: "native_continuation_requires_reconciliation", fingerprint: randomUUID(), nextAction: "Verify source cleanup",
      evidence: { runId: f.runId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" },
        systemRecovery: { ...createSystemRecovery(f.runId), state: mode === "pending_at_intake" ? "running" : "complete" } } });
    const adapterType = `retained-chat-retry-${randomUUID()}`;
    const execute = vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false, errorMessage: null,
      summary: "Completed the exact saved request after source cleanup", provider: "test", model: "test-model" }));
    registerServerAdapter({ type: adapterType, supportsLocalAgentJwt: false, execute,
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }) });
    try {
      const body = { observedRunId: f.runId, idempotencyKey: randomUUID() };
      const response = await request(app).post(`/api/issues/${issueId}/retry`).send(body);
      expect(response.status, JSON.stringify(response.body)).toBe(202);
      if (mode === "pending_at_intake") {
        await expect.poll(async () => (await readAgentWakeupRequestsById(response.body.chatActionId))[0]?.status)
          .toBe("deferred_issue_execution");
        expect((await readAgentWakeupRequestsById(response.body.requestId))[0]).toMatchObject({ runId: null });
        expect(execute).not.toHaveBeenCalled();
        await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success" })
          .where(eq(environmentLeases.id, lease.id));
        await reconcileTaskChatRetryReceipts(db, { companyId });
        await f.service.processFailedChatRunRetry(response.body.chatActionId);
      }
      await expect.poll(async () => (await readAgentWakeupRequestsById(response.body.requestId))[0]?.runId).toBeTruthy();
      const [intent] = await readAgentWakeupRequestsById(response.body.requestId);
      const [successor] = await readHeartbeatRunsById(intent.runId!);
      expect(successor).toMatchObject({ status: "queued", retryOfRunId: f.runId,
        contextSnapshot: { taskRetryRequestId: intent.id, explicitUserContinuation: {
          previousRunId: f.runId, readiness: { mode: "fresh_isolated_workspace" } } } });
      await db.update(environmentLeases).set({ status: "pending_cleanup", cleanupStatus: "failed",
        metadata: { ...metadata, pendingCleanupInFlight: true } }).where(eq(environmentLeases.id, lease.id));
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(and(
        eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "running"), isNull(heartbeatRuns.wakeupRequestId)));
      await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.fixture.assignedAgentId));
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      expect((await readHeartbeatRunsById(successor.id))[0]).toMatchObject({ status: "queued", startedAt: null });
      expect(execute).not.toHaveBeenCalled();
      expect((await readAgentWakeupRequestsById(response.body.requestId))[0]).toMatchObject({ runId: successor.id });
      if (mode === "operator_stopped") await heartbeat.cancelRun(successor.id);
      if (mode === "source_edited") await db.update(issueComments).set({ body: "Changed after admission" })
        .where(eq(issueComments.id, String(f.action.payload.commentId)));
      if (mode === "live_owner") await db.update(nativeRunFinalizations).set({ leaseOwner: "another-controller",
        leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(nativeRunFinalizations.runId, f.runId));
      await db.update(agents).set({ adapterType }).where(eq(agents.id, f.fixture.assignedAgentId));
      const { registerRunDispatchWork } = await import("../../services/heartbeat/dispatch-work.js");
      const { writeEnvironmentCleanup } = await import("../../services/environment-cleanup-notifications.js");
      let dispatchAttempts = 0;
      coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true,
        onError: error => errors.push(error) });
      await registerRunDispatchWork(coordinator, { promoteDueScheduledRetries: async () => undefined,
        nextScheduledRetryAt: async () => null, schedulingSuppressed: async () => false,
        resumeQueuedRunsAfterDrain: async () => { await heartbeat.resumeQueuedRunsAfterDrain({ companyId }); dispatchAttempts++; },
      }, () => true).ready;
      await expect.poll(() => dispatchAttempts).toBeGreaterThan(0);
      await expect.poll(() => coordinator!.nextWakeAt(), { timeout: 10_000 }).toBeNull();
      const beforeSettlement = dispatchAttempts;
      const settledMetadata = { ...metadata, pendingCleanupInFlight: false,
        remoteExecutionTermination: mode === "unknown_stop" ? { ...termination, providerLeaseId: randomUUID() } : termination };
      if (mode === "absent_sandbox") {
        const { withNativeWorkspaceFinalizationOwnership } = await import("../../services/native-runtime/native-workspace-finalization-ownership.js");
        const { settleAbsentSandbox } = await import("../../services/sandbox-stop-and-retain.js");
        let entered!: (token: string) => void;
        const ownerEntered = new Promise<string>(resolve => { entered = resolve; });
        const ownerMayFinish = new Promise<void>(resolve => { releaseWorkspaceOwner = resolve; });
        workspaceOwner = withNativeWorkspaceFinalizationOwnership({ db, companyId, runId: f.runId }, async ownership => {
          entered(ownership.token);
          await ownerMayFinish;
        });
        const ownerToken = await ownerEntered;
        const [currentLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id));
        expect(await settleAbsentSandbox(db, currentLease, { receipt: "verified-upstream", proof: {
          companyId, issueId, runId: f.runId, leaseId: lease.id, provider: "daytona", providerLeaseId: lease.providerLeaseId,
          ownerToken, v: 1, iss: "paperclip-cloud", aud: "paperclip-sandbox-absence/v1", sub: "fixture", absent: true,
          iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60,
        } })).toBe(true);
        expect((await readHeartbeatRunsById(successor.id))[0]).toMatchObject({ status: "queued", startedAt: null });
        expect(execute).not.toHaveBeenCalled();
        releaseWorkspaceOwner();
        await workspaceOwner;
      } else {
        await writeEnvironmentCleanup(db, tx => tx.update(environmentLeases).set({ status: "released", cleanupStatus: "success",
          metadata: settledMetadata }).where(eq(environmentLeases.id, lease.id)), { companyId, runId: f.runId, leaseId: lease.id });
      }
      await expect.poll(() => dispatchAttempts, { timeout: 10_000 }).toBeGreaterThan(beforeSettlement);
      if (mode === "source_edited") await expect.poll(async () =>
        (await readHeartbeatRunsById(successor.id))[0]?.status, { timeout: 10_000 }).toBe("failed");
      await heartbeat.drainActiveRunExecutions();
      expect((await readHeartbeatRunsByCompanyId(companyId)).filter(run => run.retryOfRunId === f.runId)).toHaveLength(1);
      expect((await readHeartbeatRunsById(f.runId))[0]).toMatchObject({ status: "failed" });
      expect((await request(app).post(`/api/issues/${issueId}/retry`).send(body)).body.requestId).toBe(intent.id);
      expect(errors).toEqual([]);
      if (mode === "operator_stopped") {
        expect(execute).not.toHaveBeenCalled();
        expect((await readHeartbeatRunsById(successor.id))[0]).toMatchObject({ status: "cancelled" });
        return;
      }
      if (mode === "source_edited" || mode === "unknown_stop") {
        expect(execute).not.toHaveBeenCalled();
        const [withheld] = await readHeartbeatRunsById(successor.id);
        if (mode === "unknown_stop") expect(["queued", "failed"]).toContain(withheld.status);
        if (withheld.status === "failed") expect(withheld.errorCode).toBe("chat_failed_run_retry_not_authorized");
        return;
      }
      if (mode === "live_owner") {
        await expect.poll(() => coordinator!.nextWakeAt(), { timeout: 10_000 }).toBeNull();
        expect(execute).not.toHaveBeenCalled();
        expect((await readHeartbeatRunsById(successor.id))[0]).toMatchObject({ status: "queued", startedAt: null });
        const { writeExecutionControl } = await import("../../services/execution-control-notifications.js");
        const { DELIVERY_QUEUES } = await import("../../services/delivery-work-notifications.js");
        await writeExecutionControl(db, DELIVERY_QUEUES.executionFinalization, tx => tx.update(nativeRunFinalizations)
          .set({ leaseOwner: null, leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, f.runId)), { companyId, runId: f.runId });
      }
      await expect.poll(() => execute.mock.calls.length, { timeout: 10_000 }).toBe(1);
      await heartbeat.drainActiveRunExecutions();
      expect(execute).toHaveBeenCalledTimes(1);
      expect((await readHeartbeatRunsById(successor.id))[0]).toMatchObject({ status: "succeeded" });
      expect((await readHeartbeatRunsByCompanyId(companyId)).filter(run => run.retryOfRunId === f.runId)).toHaveLength(1);
      expect((await readHeartbeatRunsById(f.runId))[0]).toMatchObject({ status: "failed" });
      expect((await request(app).post(`/api/issues/${issueId}/retry`).send(body)).body.requestId).toBe(intent.id);
      expect(execute).toHaveBeenCalledTimes(1);
      await expect.poll(() => coordinator!.nextWakeAt(), { timeout: 10_000 }).toBeNull();
      expect(errors).toEqual([]);
    } finally { releaseWorkspaceOwner(); await workspaceOwner?.catch(() => undefined); await coordinator?.stop();
      await heartbeat.drainActiveRunExecutions(); unregisterServerAdapter(adapterType); await f.service.shutdown(); }
  });

  it("retries saved GitHub input after a successful run without replaying that run", async () => {
    const f = await successfulGitHubQueuedInputFixture();
    try {
      const { input } = f;
      const companyId = f.fixture.companyId;
      const before = (await readHeartbeatRunsById(f.runId))[0];
      const [request, duplicate] = await Promise.all([requestTaskRetry(input),
        requestTaskRetry({ ...input, idempotencyKey: randomUUID() })]);
      expect(request.accepted).toBe(true);
      expect(duplicate.requestId).toBe(request.requestId);
      await reconcileTaskChatRetryReceipts(db, { companyId });
      const [source] = await readAgentWakeupRequestsById(f.pending!.id);
      expect(source.runId).toBeTruthy();
      const [successor] = await readHeartbeatRunsById(source.runId!);
      expect(successor).toMatchObject({ status: "queued", retryOfRunId: null,
        contextSnapshot: { wakeCommentIds: [f.pending!.payload.commentId] } });
      await reconcileTaskChatRetryReceipts(db, { companyId });
      expect((await readAgentWakeupRequestsById(request.requestId!))[0])
        .toMatchObject({ status: "coalesced", runId: successor.id });
      expect((await readHeartbeatRunsByCompanyId(companyId)).filter(run => run.wakeupRequestId === f.pending!.id)).toHaveLength(1);
      expect((await readHeartbeatRunsById(f.runId))[0]).toEqual(before);
      expect((await db.select().from(nativeRunResults).where(eq(nativeRunResults.id, f.result.id)))[0]).toEqual(f.result);
    } finally { await f.service.shutdown(); }
  });

  it.each(["connection_revoked", "source_rebound", "task_completed", "agent_paused", "cleanup_pending"] as const)(
    "keeps saved-input Retry behind current admission gates: %s", async gate => {
      const f = await successfulGitHubQueuedInputFixture();
      try {
        const companyId = f.fixture.companyId;
        const request = await requestTaskRetry(f.input);
        const before = (await readHeartbeatRunsById(f.runId))[0];
        if (gate === "connection_revoked") await db.update(chatEndpoints).set({ status: "paused" }).where(eq(chatEndpoints.id, f.endpoint.id));
        if (gate === "source_rebound") await db.update(chatActions).set({ payload: { ...f.pending!.payload, commentId: randomUUID() } })
          .where(eq(chatActions.id, f.pending!.id));
        if (gate === "task_completed") await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issue.id));
        if (gate === "agent_paused") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.fixture.assignedAgentId));
        const lease = { id: randomUUID(), companyId, issueId: f.issue.id, heartbeatRunId: f.runId,
          provider: "daytona", providerLeaseId: randomUUID(), leasePolicy: "ephemeral" };
        if (gate === "cleanup_pending") {
          await db.insert(environmentLeases).values({ ...lease, status: "pending_cleanup" });
          await db.update(issues).set({ executionRunId: f.runId }).where(eq(issues.id, f.issue.id));
        }
        await reconcileTaskChatRetryReceipts(db, { companyId });
        expect((await readAgentWakeupRequestsById(f.pending!.id))[0].runId).toBeNull();
        expect((await readHeartbeatRunsByCompanyId(companyId)).filter(run => run.wakeupRequestId === f.pending!.id)).toHaveLength(0);
        expect((await readHeartbeatRunsById(f.runId))[0]).toEqual(before);
        expect((await db.select().from(nativeRunResults).where(eq(nativeRunResults.id, f.result.id)))[0]).toEqual(f.result);
        if (gate === "cleanup_pending") {
          expect((await readAgentWakeupRequestsById(request.requestId!))[0].status).toBe("deferred_issue_execution");
          await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success", releasedAt: new Date(),
            metadata: { remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "destroyed" }) },
          }).where(eq(environmentLeases.id, lease.id));
          await reconcileTaskChatRetryReceipts(db, { companyId });
          expect((await readAgentWakeupRequestsById(f.pending!.id))[0].runId).toBeTruthy();
        }
      } finally { await f.service.shutdown(); }
    });

  it.each(["issue.comment.reopen", "boardMessageRetry"] as const)(
    "resumes saved GitHub input after a successful board turn: %s", async origin => {
      const f = await successfulGitHubQueuedInputFixture();
      try {
        const [previous] = await readHeartbeatRunsById(f.runId);
        await db.update(heartbeatRuns).set({ responsibleUserId: f.input.actorId, contextSnapshot: {
          ...previous.contextSnapshot, ...(origin === "boardMessageRetry" ? { boardMessageRetry: true } : { source: origin }),
        } }).where(eq(heartbeatRuns.id, f.runId));
        const before = (await readHeartbeatRunsById(f.runId))[0];
        const retry = await requestTaskRetry(f.input);
        await reconcileTaskChatRetryReceipts(db, { companyId: f.fixture.companyId, requestId: retry.requestId! });
        const [saved] = await readAgentWakeupRequestsById(f.pending!.id);
        expect(saved.runId).toBeTruthy();
        expect((await readHeartbeatRunsById(saved.runId!))[0]).toMatchObject({ retryOfRunId: null,
          contextSnapshot: { source: "chat:github", wakeCommentIds: [f.pending!.payload.commentId] } });
        expect((await readHeartbeatRunsById(f.runId))[0]).toEqual(before);
      } finally { await f.service.shutdown(); }
    });

  it("keeps a board message queued separately when saved GitHub Retry resumes after cleanup", async () => {
    const f = await successfulGitHubQueuedInputFixture();
    try {
      const companyId = f.fixture.companyId;
      const lease = { id: randomUUID(), companyId, issueId: f.issue.id, heartbeatRunId: f.runId,
        provider: "daytona", providerLeaseId: randomUUID(), leasePolicy: "ephemeral" };
      await db.insert(environmentLeases).values({ ...lease, status: "pending_cleanup" });
      await db.update(issues).set({ status: "in_review", executionRunId: f.runId }).where(eq(issues.id, f.issue.id));
      const retry = await requestTaskRetry(f.input);
      await reconcileTaskChatRetryReceipts(db, { companyId, requestId: retry.requestId! });
      expect((await readAgentWakeupRequestsById(f.pending!.id))[0].runId).toBeNull();
      const [comment] = await db.insert(issueComments).values({ companyId, issueId: f.issue.id,
        authorType: "user", authorUserId: f.input.actorId, body: "A separate board follow-up" }).returning();
      const [board] = await db.insert(agentWakeupRequests).values({ companyId, agentId: f.fixture.assignedAgentId,
        source: "automation", triggerDetail: "system", reason: "issue_commented", status: "deferred_issue_execution",
        requestedByActorType: "user", requestedByActorId: f.input.actorId,
        payload: withQueuedCommentIdsInWakePayload({ issueId: f.issue.id, commentId: comment.id,
          _paperclipWakeContext: { issueId: f.issue.id, source: "issue.comment.reopen", wakeReason: "issue_commented" },
        }, [comment.id]),
      }).returning();
      await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success", releasedAt: new Date(),
        metadata: { remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "destroyed" }) },
      }).where(eq(environmentLeases.id, lease.id));
      await reconcileTaskChatRetryReceipts(db, { companyId, requestId: retry.requestId! });
      const [saved] = await readAgentWakeupRequestsById(f.pending!.id);
      expect(saved.runId).toBeTruthy();
      expect((await readHeartbeatRunsById(saved.runId!))[0]).toMatchObject({ status: "queued",
        contextSnapshot: { wakeCommentIds: [f.pending!.payload.commentId] } });
      expect((await readAgentWakeupRequestsById(board.id))[0]).toEqual(board);
    } finally { await f.service.shutdown(); }
  });

  it("dispatches saved input through the task Retry HTTP endpoint and survives a repeated click", async () => {
    const f = await successfulGitHubQueuedInputFixture();
    const { issueRoutes } = await import("../../routes/issues.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = boardActor(f.fixture.companyId); next(); });
    app.use("/api", issueRoutes(db, createStorageService().storage, { chatRunRetries: f.service }));
    app.use(errorHandler);
    try {
      const body = { observedRunId: f.runId, idempotencyKey: randomUUID() };
      const first = await request(app).post(`/api/issues/${f.issue.id}/retry`).send(body);
      expect(first.status, JSON.stringify(first.body)).toBe(202);
      await expect.poll(async () => (await readAgentWakeupRequestsById(f.pending!.id))[0].runId).toBeTruthy();
      const second = await request(app).post(`/api/issues/${f.issue.id}/retry`).send(body);
      expect(second.status).toBe(202);
      expect(second.body.requestId).toBe(first.body.requestId);
      expect((await readHeartbeatRunsByCompanyId(f.fixture.companyId)).filter(run => run.wakeupRequestId === f.pending!.id)).toHaveLength(1);
      const detail = await request(app).get(`/api/issues/${f.issue.id}`);
      expect(detail.status).toBe(200);
      expect(detail.body.interruption).toMatchObject({ state: "working", canRetry: false });
      expect((await db.select().from(nativeRunResults).where(eq(nativeRunResults.id, f.result.id)))[0]).toEqual(f.result);
    } finally { await f.service.shutdown(); }
  });

  it("retries saved GitHub input after an endpoint admission lock collision", async () => {
    const f = await successfulGitHubQueuedInputFixture();
    const heartbeat = heartbeatService(db);
    const failures: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true,
      onError: error => failures.push(error) });
    let unlock!: () => void, locked!: () => void;
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const released = new Promise<void>(resolve => { unlock = resolve; });
    const competingAdmission = db.transaction(async tx => {
      await tx.select({ id: chatEndpoints.id }).from(chatEndpoints)
        .where(eq(chatEndpoints.id, f.endpoint.id)).for("no key update");
      locked();
      await released;
    });
    try {
      await acquired;
      await heartbeat.registerDeferredReceiptWork(coordinator, () => true).ready;
      const priorFailures = failures.length;
      const retry = await requestTaskRetry(f.input);
      await expect.poll(() => failures.length, { timeout: 5_000 }).toBeGreaterThan(priorFailures);
      expect((await readAgentWakeupRequestsById(f.pending!.id))[0].runId).toBeNull();
      unlock(); await competingAdmission;
      await expect.poll(async () => (await readAgentWakeupRequestsById(f.pending!.id))[0].runId,
        { timeout: 40_000 }).toBeTruthy();
      await expect.poll(async () => (await readAgentWakeupRequestsById(retry.requestId!))[0].status,
        { timeout: 40_000 }).toBe("coalesced");
      const [saved] = await readAgentWakeupRequestsById(f.pending!.id);
      expect((await readHeartbeatRunsByCompanyId(f.fixture.companyId))
        .filter(run => run.wakeupRequestId === f.pending!.id)).toHaveLength(1);
      expect((await readAgentWakeupRequestsById(retry.requestId!))[0].runId).toBe(saved.runId);
      expect((await readHeartbeatRunsById(f.runId))[0]).toMatchObject({ status: "succeeded" });
    } finally {
      unlock(); await competingAdmission;
      await coordinator.stop();
      await f.service.shutdown();
    }
  }, 90_000);

  it.each(["reconnected", "newer_input", "reconnected_newer_input", "snapshot_newer_input"] as const)(
    "admits current GitHub task Retry without replaying obsolete input: %s", async kind => {
      const f = await currentGitHubTaskRetryFixture(kind.includes("newer_input"));
      const { pending, originalDelivery } = f;
      try {
        const companyId = f.fixture.companyId, issueId = f.issue.id;
        if (kind.includes("reconnected")) await f.service.configure(f.endpoint.id, { action: "reconnect" }, "owner-user");
        let snapshotActionId: string | undefined;
        if (kind === "snapshot_newer_input") {
          const leaseId = randomUUID(), providerLeaseId = randomUUID();
          await db.update(heartbeatRuns).set({ errorCode: "execution_finalization_deadline_exceeded",
            resultJson: { workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: {
              schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [leaseId] } },
            runnerProfileJson: { nativeWorkspaceSync: { schema: "paperclip.native-workspace-sync/v3", state: "prepared",
              descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), finalHostSha256: null,
              workspaceId: randomUUID(), leaseId, providerLeaseId, remoteCwd: "/workspace", resourceDisposition: "destroy" } },
          }).where(eq(heartbeatRuns.id, f.runId));
          for (const current of [{ id: leaseId, providerLeaseId }, { id: randomUUID(), providerLeaseId: randomUUID() }]) {
            const lease = { ...current, companyId, issueId, heartbeatRunId: f.runId,
              provider: "daytona", status: "released", cleanupStatus: "success", releasedAt: new Date() };
            await db.insert(environmentLeases).values({ ...lease, metadata: { remoteExecutionTermination:
              remoteTerminationReceipt(lease, { providerLeaseId: current.providerLeaseId, state: "stopped" }) } });
          }
          for (const cause of ["native_continuation_requires_reconciliation", "execution_finalization_deadline_exceeded"]) {
            const id = randomUUID();
            if (cause === "native_continuation_requires_reconciliation") snapshotActionId = id;
            await db.insert(issueRecoveryActions).values({ id, companyId, sourceIssueId: issueId,
              kind: "active_run_watchdog", status: "resolved", ownerType: "system", outcome: "blocked", cause,
              fingerprint: randomUUID(), nextAction: "Preserved snapshot needs fresh continuation", evidence: {
                runId: f.runId, automaticRecovery: { replay: "blocked" },
                ...(cause === "native_continuation_requires_reconciliation" ? {
                  systemRecovery: { ...createSystemRecovery(f.runId), state: "complete", phase: "reconcile_effects" },
                } : {}),
              } });
          }
        }
        const input = { db, companyId, issueId, actorId: "owner-user", actorSource: "cloud_tenant",
          observedRunId: f.runId, idempotencyKey: randomUUID(), prepareChatRetry: f.service.prepareFailedChatRunRetry };
        const request = await requestTaskRetry(input);
        expect(request.accepted).toBe(true);
        if (snapshotActionId) {
          const [saved] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, snapshotActionId));
          await db.update(issueRecoveryActions).set({ evidence: { ...saved.evidence,
            systemRecovery: { ...saved.evidence.systemRecovery as Record<string, unknown>, intentId: request.requestId },
          } }).where(eq(issueRecoveryActions.id, snapshotActionId));
        }
        expect((await requestTaskRetry(input)).requestId).toBe(request.requestId);
        expect(await f.service.processFailedChatRunRetry(request.chatActionId!)).toMatchObject({ status: "queued" });
        const [wake] = await readAgentWakeupRequestsById(request.chatActionId!);
        expect(wake.runId).toBeTruthy();
        const expectedComment = pending?.payload.commentId ?? f.action.payload.commentId;
        const [run] = await readHeartbeatRunsById(wake.runId!);
        expect(run).toMatchObject({ status: "queued", retryOfRunId: f.runId,
          contextSnapshot: { wakeCommentIds: [expectedComment], taskRetryRequestId: request.requestId } });
        if (snapshotActionId) {
          const { readFreshWorkspaceReadiness } = await import("../../services/fresh-workspace-continuation.js");
          expect(await readFreshWorkspaceReadiness(db, run)).toMatchObject({
            mode: "fresh_isolated_workspace", sourceRunId: f.runId, retryIntentId: request.requestId,
          });
          expect((await readHeartbeatRunsById(f.runId))[0].runnerProfileJson?.nativeWorkspaceSync)
            .toMatchObject({ state: "prepared", finalHostSha256: null });
        }
        if (pending) expect((await readAgentWakeupRequestsById(pending.id))[0])
          .toMatchObject({ status: "coalesced", runId: wake.runId });
        await f.service.processFailedChatRunRetry(request.chatActionId!);
        await heartbeatService(db).resumeQueuedRuns();
        expect((await readHeartbeatRunsByCompanyId(companyId)).filter(r => r.contextSnapshot?.taskRetryRequestId === request.requestId))
          .toHaveLength(1);
        expect((await db.select().from(chatDeliveries).where(eq(chatDeliveries.id, originalDelivery.id)))[0].normalizedEvent)
          .toEqual(originalDelivery.normalizedEvent);
      } finally { await f.service.shutdown(); }
    },
  );

  it.each(["legacy_receipt", "concurrent_clicks", "lost_dispatch_reply", "restart", "retry_failed_successor", "http", "handoff_rollback", "board_permission_wait", "peer_conversation", "backlog_51", "consumed_backlog_52"] as const)(
    "preserves one current GitHub Retry across %s", async mode => {
      const f = await currentGitHubTaskRetryFixture(true, mode.includes("backlog") ? 51 : mode === "peer_conversation" ? 2 : 1);
      try {
        const companyId = f.fixture.companyId, issueId = f.issue.id;
        if (mode === "consumed_backlog_52") {
          const sources = await db.select().from(chatActions).where(and(eq(chatActions.conversationId, f.conversation.id),
            eq(chatActions.kind, "inbound_wakeup"))).orderBy(asc(chatActions.createdAt), asc(chatActions.id));
          expect(sources).toHaveLength(52);
          const commentIds = sources.map(source => source.payload.commentId);
          await db.update(heartbeatRuns).set({ finishedAt: new Date(), contextSnapshot: {
            ...(await readHeartbeatRunsById(f.runId))[0].contextSnapshot,
            wakeCommentIds: commentIds, wakeCommentId: commentIds.at(-1),
          } }).where(eq(heartbeatRuns.id, f.runId));
          await db.update(agentWakeupRequests).set({ runId: f.runId, status: "coalesced",
            payload: sql`${agentWakeupRequests.payload} || ${JSON.stringify({ coalescedIntoWakeupRequestId: f.action.id })}::jsonb`,
          }).where(and(inArray(agentWakeupRequests.id, sources.map(source => source.id)),
            sql`${agentWakeupRequests.id} <> ${f.action.id}::uuid`));
        }
        let peerInput: typeof chatActions.$inferSelect | undefined;
        if (mode === "peer_conversation") {
          const originId = randomUUID();
          await db.insert(chatConversations).values({ ...f.conversation, id: originId, sessionGeneration: 2 });
          await db.update(chatActions).set({ conversationId: originId,
            payload: sql`jsonb_set(${chatActions.payload}, '{sessionGeneration}', '2'::jsonb)`,
          }).where(inArray(chatActions.id, [f.action.id, f.pending!.id]));
          await db.update(chatDeliveries).set({ conversationId: originId })
            .where(inArray(chatDeliveries.id, [f.action.deliveryId!, f.pending!.deliveryId!]));
          await db.update(chatMessageLinks).set({ conversationId: originId })
            .where(inArray(chatMessageLinks.deliveryId, [f.action.deliveryId!, f.pending!.deliveryId!]));
          [peerInput] = await db.select().from(chatActions).where(and(eq(chatActions.conversationId, f.conversation.id),
            eq(chatActions.kind, "inbound_wakeup")));
          expect(peerInput).toBeDefined();
        }
        if (mode === "legacy_receipt") {
          const [originalEndpoint] = await readChatEndpointsById(f.endpoint.id);
          await db.insert(chatActions).values({ companyId, endpointId: f.endpoint.id,
            conversationId: f.conversation.id, deliveryId: f.pending!.deliveryId,
            kind: "github_response_comment", providerActionId: `github_response:${f.pending!.deliveryId}`,
            payload: { botExternalId: originalEndpoint.botExternalId, agentId: f.fixture.assignedAgentId },
            status: "processed" }).onConflictDoNothing();
          await db.update(chatDeliveries).set({
            normalizedEvent: sql`jsonb_set(${chatDeliveries.normalizedEvent}, '{githubAuthority}',
              (${chatDeliveries.normalizedEvent}->'githubAuthority') - 'botExternalId')`,
          }).where(eq(chatDeliveries.id, f.pending!.deliveryId!));
        }
        await f.service.configure(f.endpoint.id, { action: "reconnect" }, "owner-user");
        const input = { db, companyId, issueId, actorId: "owner-user", actorSource: "cloud_tenant",
          observedRunId: f.runId, idempotencyKey: randomUUID(), prepareChatRetry: f.service.prepareFailedChatRunRetry };
        if (mode === "board_permission_wait") {
          input.actorId = `retry-operator-${companyId}`;
          await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: input.actorId,
            status: "active", membershipRole: "operator" });
        }
        const queryEvents: Record<string, unknown>[] = [];
        const capture = mode === "backlog_51" ? createFullDatabaseResponseCapture({ start: Date.now() - 1,
          end: Date.now() + 59_000 }, event => queryEvents.push(event)) : undefined;
        if (capture) installDatabaseResponseCapture(db, { chatActions, chatDeliveries, chatMessageLinks, issueComments,
          agentWakeupRequests, chatEndpoints, chatConversations }, capture);
        let one: Awaited<ReturnType<typeof requestTaskRetry>>, two: typeof one;
        if (mode === "http") {
          const app = express();
          app.use(express.json());
          app.use((req, _res, next) => { req.actor = boardActor(companyId); next(); });
          app.use("/api", issueRoutes(db, createStorageService().storage, { chatRunRetries: f.service }));
          app.use(errorHandler);
          const send = () => request(app).post(`/api/issues/${issueId}/retry`).send({
            idempotencyKey: input.idempotencyKey, observedRunId: input.observedRunId,
          }).expect(202);
          const replies = await Promise.all([send(), send()]);
          [one, two] = replies.map(response => response.body);
        } else [one, two] = await Promise.all([requestTaskRetry(input), requestTaskRetry({ ...input,
          idempotencyKey: mode === "concurrent_clicks" ? randomUUID() : input.idempotencyKey })]);
        if (capture) {
          capture.flush();
          expect(Number(queryEvents.find(event => event.event === "paperclip.test_db_response_capture.summary.v1")?.startedQueries))
            .toBeLessThan(180);
        }
        expect(two.requestId).toBe(one.requestId);
        expect(one).toMatchObject({ accepted: true, chatActionId: expect.any(String) });
        let service = f.service;
        if (mode === "restart") {
          await service.shutdown();
          service = createService(f.runtime, f.providerFetch, { wakeup: heartbeatService(db).wakeup }).service;
        }
        if (mode === "lost_dispatch_reply") f.wakeup.mockImplementationOnce(async (...args) => {
          await heartbeatService(db).wakeup(...args);
          throw new Error("Simulated response loss after dispatch commit");
        });
        if (mode === "handoff_rollback") f.wakeup.mockImplementationOnce(async (agentId, options) => {
          const original = options!.durableChatRequest!;
          return heartbeatService(db).wakeup(agentId, { ...options, durableChatRequest: createDurableChatWakeupRequest({
            ...original, onAdmitted: async (tx, receipt) => {
              await original.onAdmitted!(tx, receipt);
              throw new Error("Simulated interruption before admission commit");
            },
          }) });
        });
        if (mode === "board_permission_wait") await db.update(companyMemberships).set({ membershipRole: "viewer" })
          .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, input.actorId)));
        await Promise.all([service.processFailedChatRunRetry(one.chatActionId!),
          service.processFailedChatRunRetry(one.chatActionId!)]);
        if (mode === "handoff_rollback" || mode === "board_permission_wait") {
          expect(await readAgentWakeupRequestsById(one.chatActionId!)).toHaveLength(0);
          expect((await readAgentWakeupRequestsById(f.pending!.id))[0])
            .toMatchObject({ status: "deferred_issue_execution", runId: null });
          expect((await readHeartbeatRunsByCompanyId(companyId))
            .filter(run => run.contextSnapshot?.taskRetryRequestId === one.requestId)).toHaveLength(0);
        }
        if (mode === "board_permission_wait") await db.update(companyMemberships).set({ membershipRole: "operator" })
          .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, input.actorId)));
        await vi.waitFor(async () => {
          await service.processFailedChatRunRetry(one.chatActionId!);
          expect((await readAgentWakeupRequestsById(one.chatActionId!))[0]?.runId,
            JSON.stringify((await db.select().from(chatActions).where(eq(chatActions.id, one.chatActionId!)))[0]?.result)).toBeTruthy();
        }, { timeout: 10_000, interval: 100 });
        const [parent] = await readAgentWakeupRequestsById(one.chatActionId!);
        expect(parent.runId).toBeTruthy();
        expect((await readAgentWakeupRequestsById(f.pending!.id))[0]).toMatchObject({
          status: "coalesced", runId: mode === "consumed_backlog_52" ? f.runId : parent.runId,
        });
        if (peerInput) expect((await readAgentWakeupRequestsById(peerInput.id))[0])
          .toMatchObject({ status: "deferred_issue_execution", runId: null });
        if (mode === "backlog_51") {
          const saved = await db.select({ id: chatActions.id, payload: chatActions.payload,
            status: agentWakeupRequests.status, runId: agentWakeupRequests.runId }).from(chatActions)
            .innerJoin(agentWakeupRequests, eq(agentWakeupRequests.id, chatActions.id)).where(and(
              eq(chatActions.conversationId, f.conversation.id), eq(chatActions.kind, "inbound_wakeup"),
              sql`${chatActions.id} <> ${f.action.id}::uuid`,
            )).orderBy(asc(chatActions.createdAt), asc(chatActions.id));
          expect(saved).toHaveLength(51);
          expect(saved.every(source => source.status === "coalesced" && source.runId === parent.runId)).toBe(true);
          expect((await readHeartbeatRunsById(parent.runId!))[0].contextSnapshot?.wakeCommentIds)
            .toEqual(saved.map(source => source.payload.commentId));
        }
        await service.processFailedChatRunRetry(one.chatActionId!);
        expect((await readHeartbeatRunsByCompanyId(companyId))
          .filter(run => run.contextSnapshot?.taskRetryRequestId === one.requestId)).toHaveLength(1);
        expect(await db.select().from(chatActions).where(and(eq(chatActions.companyId, companyId),
          eq(chatActions.kind, "failed_run_retry")))).toHaveLength(1);
        if (mode === "retry_failed_successor" || mode === "backlog_51") {
          await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(),
            errorCode: "adapter_failed", runtimeMode: "native", nativeIssueId: issueId, nativePhase: "terminal_failure",
          }).where(eq(heartbeatRuns.id, parent.runId!));
          await db.update(agentWakeupRequests).set({ status: "failed" }).where(eq(agentWakeupRequests.id, one.chatActionId!));
          await db.update(issues).set({ executionRunId: null, status: "blocked" }).where(eq(issues.id, issueId));
          await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId: parent.runId!, phase: "terminal_failure" });
          await db.insert(heartbeatRunEvents).values({ companyId, agentId: f.fixture.assignedAgentId, runId: parent.runId!,
            seq: 1, eventType: "native.local_process_stopped", payload: { processPid: 999999998, processGroupId: null } });
          await service.configure(f.endpoint.id, { action: "reconnect" }, "owner-user");
          const next = await requestTaskRetry({ ...input, observedRunId: parent.runId!, idempotencyKey: randomUUID(),
            prepareChatRetry: service.prepareFailedChatRunRetry });
          expect(next.requestId).not.toBe(one.requestId);
          expect(await service.processFailedChatRunRetry(next.chatActionId!)).toMatchObject({ status: "queued" });
          const [second] = await readAgentWakeupRequestsById(next.chatActionId!);
          expect((await readHeartbeatRunsById(second.runId!))[0]).toMatchObject({
            retryOfRunId: parent.runId, contextSnapshot: {
              wakeCommentIds: (await readHeartbeatRunsById(parent.runId!))[0].contextSnapshot!.wakeCommentIds,
            },
          });
        }
      } finally { await f.service.shutdown(); }
    }, 60_000,
  );

  it("leaves saved GitHub input pending when a persisted Retry wait loses board authority", async () => {
    const f = await currentGitHubTaskRetryFixture(true);
    try {
      const companyId = f.fixture.companyId, issueId = f.issue.id, actorId = `retry-operator-${companyId}`;
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: actorId,
        status: "active", membershipRole: "operator" });
      const intent = await requestTaskRetry({ db, companyId, issueId, actorId, actorSource: "cloud_tenant",
        observedRunId: f.runId, idempotencyKey: randomUUID(), prepareChatRetry: f.service.prepareFailedChatRunRetry });
      let savedOptions: Parameters<typeof f.wakeup>[1];
      f.wakeup.mockImplementationOnce(async (_agentId, options) => {
        savedOptions = options;
        const request = options!.durableChatRequest!;
        // Persist the pre-handoff wait as a server interrupted before queue adoption would.
        await db.insert(agentWakeupRequests).values({ id: request.id, companyId, agentId: request.agentId,
          source: options!.source!, triggerDetail: options!.triggerDetail, reason: options!.reason,
          requestedByActorType: request.requestedByActorType, requestedByActorId: request.requestedByActorId,
          requestedAt: request.requestedAt, idempotencyKey: request.idempotencyKey,
          status: "deferred_issue_execution", payload: { ...options!.payload,
            taskRetryRequestId: intent.requestId, _paperclipWakeContext: options!.contextSnapshot } });
        return null;
      });
      expect(await f.service.processFailedChatRunRetry(intent.chatActionId!)).toMatchObject({ status: "deferred" });
      await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(and(
        eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, actorId)));
      expect(await heartbeatService(db).wakeup(f.fixture.assignedAgentId, savedOptions!)).toBeNull();
      expect((await readAgentWakeupRequestsById(f.pending!.id))[0])
        .toMatchObject({ status: "deferred_issue_execution", runId: null });
      expect((await readHeartbeatRunsByCompanyId(companyId))
        .filter(run => run.contextSnapshot?.taskRetryRequestId === intent.requestId)).toHaveLength(0);
      await db.update(companyMemberships).set({ membershipRole: "operator" }).where(and(
        eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, actorId)));
      await heartbeatService(db).wakeup(f.fixture.assignedAgentId, savedOptions!);
      const [parent] = await readAgentWakeupRequestsById(intent.chatActionId!);
      expect(parent.runId).toBeTruthy();
      expect((await readAgentWakeupRequestsById(f.pending!.id))[0]).toMatchObject({ status: "coalesced", runId: parent.runId });
    } finally { await f.service.shutdown(); }
  });

  it.each(["changed_bot", "disabled_repository", "retargeted_repository", "revoked_sender", "paused_endpoint",
    "edited_source", "deleted_source", "reassigned_task", "second_reconnect", "later_message_wrong_bot", "later_message_deleted", "later_message_revoked_policy"] as const)(
    "keeps current GitHub task Retry authority gated: %s", async gate => {
      const f = await currentGitHubTaskRetryFixture(true, gate.startsWith("later_message") ? 2 : 1);
      try {
        const companyId = f.fixture.companyId, issueId = f.issue.id;
        await f.service.configure(f.endpoint.id, { action: "reconnect" }, "owner-user");
        const input = { db, companyId, issueId, actorId: "owner-user", actorSource: "cloud_tenant",
          observedRunId: f.runId, idempotencyKey: randomUUID(), prepareChatRetry: f.service.prepareFailedChatRunRetry };
        if (gate === "later_message_revoked_policy") {
          const [resource] = await db.select().from(chatEndpointResources).where(eq(chatEndpointResources.id, f.conversation.resourceId!));
          await db.update(chatEndpointResources).set({ availability: "available",
            metadata: { ...resource.metadata, providerRepositoryId: "418" },
          }).where(eq(chatEndpointResources.id, resource.id));
          await db.insert(chatGitHubConfigurations).values({ companyId, endpointId: f.endpoint.id,
            updatedByUserId: "owner-user", configuration: { version: 1, toolsEnabled: true, responsibleUserId: "owner-user",
              memberAccess: "all_linked", people: [], repositories: {},
              defaults: { ...defaultGitHubReviewPolicy(), invocation: "linked_authors", events: ["opened", "synchronize"] },
            } });
          const sources = await db.select().from(chatActions).where(and(eq(chatActions.conversationId, f.conversation.id),
            eq(chatActions.kind, "inbound_wakeup"), sql`${chatActions.id} <> ${f.action.id}::uuid`))
            .orderBy(asc(chatActions.createdAt), asc(chatActions.id));
          for (const [index, source] of sources.entries()) {
            const context = { event: index === 0 ? "opened" : "synchronize", deliveryId: source.deliveryId,
              repositoryId: "418", repository: resource.providerResourceId,
              pullNumber: 7, title: "Saved review request", body: "", baseSha: "a".repeat(40), headSha: "b".repeat(40),
              baseBranch: "master", author: { id: "42", login: "octocat", isBot: false },
              sender: { id: "42", login: "octocat" }, draft: false, labels: [] };
            await db.update(chatDeliveries).set({
              normalizedEvent: sql`${chatDeliveries.normalizedEvent} || ${JSON.stringify({ githubAutomatic: { context } })}::jsonb`,
            }).where(eq(chatDeliveries.id, source.deliveryId!));
          }
        }
        const accepted = await requestTaskRetry(input);
        if (gate.startsWith("later_message")) {
          const [later] = await db.select().from(chatActions).where(and(eq(chatActions.conversationId, f.conversation.id),
            eq(chatActions.kind, "inbound_wakeup"), sql`${chatActions.id} not in (${f.action.id}::uuid, ${f.pending!.id}::uuid)`));
          if (gate === "later_message_wrong_bot") await db.update(chatDeliveries).set({
            normalizedEvent: sql`jsonb_set(${chatDeliveries.normalizedEvent}, '{githubAuthority,botExternalId}', ${JSON.stringify(randomUUID())}::jsonb)`,
          }).where(eq(chatDeliveries.id, later.deliveryId!));
          else if (gate === "later_message_deleted") await db.update(issueComments).set({ deletedAt: new Date() })
            .where(eq(issueComments.id, String(later.payload.commentId)));
          else await db.update(chatGitHubConfigurations).set({ revision: sql`${chatGitHubConfigurations.revision} + 1`,
            configuration: sql`jsonb_set(${chatGitHubConfigurations.configuration}, '{defaults,events}', '["opened"]'::jsonb)`,
          }).where(eq(chatGitHubConfigurations.endpointId, f.endpoint.id));
        }
        if (gate === "changed_bot") await db.update(chatEndpoints).set({ botExternalId: randomUUID() })
          .where(eq(chatEndpoints.id, f.endpoint.id));
        if (gate === "disabled_repository") await db.update(chatEndpointResources).set({ enabled: false })
          .where(eq(chatEndpointResources.id, f.conversation.resourceId!));
        if (gate === "retargeted_repository") await db.update(chatEndpointResources).set({ providerResourceId: "another/repository" })
          .where(eq(chatEndpointResources.id, f.conversation.resourceId!));
        if (gate === "revoked_sender") await db.update(chatIdentityLinks).set({ status: "revoked" })
          .where(and(eq(chatIdentityLinks.endpointId, f.endpoint.id), eq(chatIdentityLinks.principalId, f.pending!.principalId!)));
        if (gate === "paused_endpoint") await db.update(chatEndpoints).set({ status: "paused" })
          .where(eq(chatEndpoints.id, f.endpoint.id));
        if (gate === "edited_source") await db.update(issueComments).set({ body: "Changed after Retry", updatedAt: new Date() })
          .where(eq(issueComments.id, String(f.pending!.payload.commentId)));
        if (gate === "deleted_source") await db.update(issueComments).set({ deletedAt: new Date() })
          .where(eq(issueComments.id, String(f.pending!.payload.commentId)));
        if (gate === "reassigned_task") await db.update(issues).set({ assigneeAgentId: f.fixture.replacementAgentId })
          .where(eq(issues.id, issueId));
        if (gate === "second_reconnect") await f.service.configure(f.endpoint.id, { action: "reconnect" }, "owner-user");
        expect(await f.service.processFailedChatRunRetry(accepted.chatActionId!)).toMatchObject({ status: "failed" });
        expect((await readAgentWakeupRequestsById(f.pending!.id))[0]).toMatchObject({ status: "deferred_issue_execution", runId: null });
        expect((await readHeartbeatRunsByCompanyId(companyId))
          .filter(run => run.contextSnapshot?.taskRetryRequestId === accepted.requestId)).toHaveLength(0);
        const [settled] = await db.select().from(chatActions).where(eq(chatActions.id, accepted.chatActionId!));
        expect(settled.result?.taskRetryInputReconciled).toBe(true);
        const [intentReceipt] = await readAgentWakeupRequestsById(accepted.requestId!);
        await f.service.processFailedChatRunRetry(accepted.chatActionId!);
        expect((await readAgentWakeupRequestsById(accepted.requestId!))[0].updatedAt).toEqual(intentReceipt.updatedAt);
        if (gate === "second_reconnect") {
          const next = await requestTaskRetry({ ...input, idempotencyKey: randomUUID() });
          expect(next.requestId).not.toBe(accepted.requestId);
          expect(await f.service.processFailedChatRunRetry(next.chatActionId!)).toMatchObject({ status: "queued" });
        }
      } finally { await f.service.shutdown(); }
    },
  );

  it.each(["contained", "prior_denied_intent", "observability_opencode", "observability_warning", "observability_reason", "observability_revision", "observability_provenance", "observability_extra", "other_reason", "wrong_issue", "provider_started", "result_extra", "profile", "usage", "output",
    "process", "controller", "active_control", "lease", "accepted_result", "event_source", "extra_event", "source_edited", "principal_revoked"] as const)(
    "retries an authenticated GitHub request after isolated-directory validation failed before allocation: %s", async mode => {
    const f = await failedChatRetryFixture("github", "42", true, false, true);
    const companyId = f.fixture.companyId, agentId = f.fixture.assignedAgentId, issueId = f.issue.id;
    const diagnostic = "The existing execution workspace is not this task's isolated directory.";
    try {
      await initializeRunIdentity(db, { companyId, runId: f.runId, issueId, responsibleUserId: "owner-user",
        messageIds: [String(f.action.payload.commentId)], cause: "chat_message" });
      await db.update(heartbeatRuns).set({ errorCode: "workspace_validation_failed", error: diagnostic,
        runtimeMode: "legacy", sessionIdBefore: "prior-provider-display-hint",
        usageJson: { ledgerScope: { issueId, projectId: null, billingCode: null } },
        runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false }, stopReason: "adapter_failed",
          workspaceValidation: { reason: "isolated_task_directory_binding_mismatch", issueId } } })
        .where(eq(heartbeatRuns.id, f.runId));
      if (mode.startsWith("observability_")) {
        await db.insert(companyObservability).values({ companyId, revision: randomUUID(), enabled: true,
          destination: { provider: "otlp", endpointBaseUrl: "https://collector.example/otel" },
          capture: { userPrompts: false, assistantResponses: false, toolDetails: false, toolContent: false } });
        const [agent] = await db.update(agents).set({ adapterConfig: mode === "observability_opencode"
          ? { provider: "opencode", model: "openrouter/synthetic", homeMode: "preconfigured" }
          : { provider: "acpx", acpxAgent: "pi", model: "synthetic", homeMode: "preconfigured" } })
          .where(eq(agents.id, agentId)).returning();
        const [run] = await readHeartbeatRunsById(f.runId);
        const prepared = await prepareHeartbeatExecutionConfiguration(db, { run, agent,
          task: { issueId, context: { ...run.contextSnapshot }, responsibleUserId: "owner-user",
            acceptedPlanContinuationWake: false, acceptedPlanWakeRoutingDecision: null, taskProjectContext: null,
            routineEnvContext: { routineId: null, env: null, responsibleUserId: null } },
          config: { sourceWorkspaceConfig: agent.adapterConfig, aiBinding: undefined },
          policy: { trustPreset: { kind: "standard", preset: "standard", boundary: null, sourcePresets: {} },
            useIsolatedTaskDirectory: false, explicitTaskDirectory: false, requestedExecutionWorkspaceMode: "shared_workspace" },
          environment: { selectedEnvironmentId: (await environmentService(db).ensureLocalEnvironment(agent.companyId)).id, selectedEnvironmentForConfig: null,
            resolvedInstanceSettings: await instanceSettingsService(db).get(), persistedNativeExecutionInput: null },
          services: { secretsSvc: secretService(db), companySkills: companySkillService(db),
            appendRunEvent: async (source, event) => { await appendHeartbeatRunEvent(db, { companyId: source.companyId,
              agentId: source.agentId, runId: source.id, ...event }); }, finalizeAiConnectionBusyDeferral: vi.fn() },
          onFailureSecretsResolved: () => {}, onManagedAiRuntimeAcquired: () => {}, onIdentityRedactorPrepared: () => {},
        });
        expect(prepared.prepared).toBe(true);
        const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.runId));
        if (mode === "observability_opencode") {
          if (!prepared.prepared) throw new Error("Configuration preparation did not finish");
          expect(prepared.observability?.kind).toBe("opencode");
          expect(prepared.observability?.environment).toMatchObject({ PAPERCLIP_OBSERVABILITY_OPENCODE: "1",
            OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://collector.example/otel/v1/traces" });
          expect(events.filter(event => event.eventType === "agent_observability.unavailable")).toHaveLength(0);
          expect(JSON.stringify(prepared.runtimeConfig)).not.toContain("collector.example");
        } else {
          expect(events).toMatchObject([{ eventType: "agent_observability.unavailable", payload: { reason: "unsupported_harness" } }]);
        }
      }
      await appendHeartbeatRunEvent(db, { companyId, agentId, runId: f.runId,
        eventType: "error", stream: "system", level: "error", message: diagnostic });
      await appendHeartbeatRunEvent(db, { companyId, agentId, runId: f.runId, eventType: "lifecycle", stream: "system", level: "info",
        message: "task.run.measured", payload: { durableSettlement: true, durationMs: 2505, outcome: "failed", phase: "task.run.measured" } });
      await db.update(agents).set({ status: "running", runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } })
        .where(eq(agents.id, agentId));
      const [capacity] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running" }).returning();
      const heartbeat = heartbeatService(db);
      f.wakeup.mockImplementation(heartbeat.wakeup);
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.actor = boardActor(companyId); next(); });
      app.use("/api", issueRoutes(db, createStorageService().storage, { chatRunRetries: f.service }));
      app.use(errorHandler);
      const [failed] = await readHeartbeatRunsById(f.runId);
      if (mode === "observability_reason" || mode === "observability_revision" || mode === "observability_extra") {
        const [warning] = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, f.runId), eq(heartbeatRunEvents.seq, 1)));
        await db.update(heartbeatRunEvents).set({ payload: { ...warning.payload,
          ...(mode === "observability_reason" ? { reason: "unknown_preparation" } : mode === "observability_revision" ? { revision: null } : { providerWork: true }) } })
          .where(eq(heartbeatRunEvents.id, warning.id));
      }
      if (mode === "observability_provenance") await db.update(heartbeatRunEvents).set({ sourceEventId: "untrusted-provider-warning" })
        .where(and(eq(heartbeatRunEvents.runId, f.runId), eq(heartbeatRunEvents.seq, 1)));
      const validation = failed.resultJson!.workspaceValidation as object;
      if (mode === "other_reason" || mode === "wrong_issue") await db.update(heartbeatRuns).set({ resultJson: { ...failed.resultJson,
        workspaceValidation: { ...validation, ...(mode === "other_reason" ? { reason: "plugin_workspace_strategy_unsupported" } : { issueId: randomUUID() }) } } })
        .where(eq(heartbeatRuns.id, f.runId));
      if (mode === "provider_started" || mode === "result_extra") await db.update(heartbeatRuns).set({ resultJson: { ...failed.resultJson,
        ...(mode === "provider_started" ? { executionRecovery: { kind: "bootstrap", providerWorkStarted: true } } : { unknownExecution: true }) } })
        .where(eq(heartbeatRuns.id, f.runId));
      if (mode === "profile") await db.update(heartbeatRuns).set({ runnerProfileJson: { ...failed.runnerProfileJson, nativeExecutionInput: {} } }).where(eq(heartbeatRuns.id, f.runId));
      if (mode === "usage") await db.update(heartbeatRuns).set({ usageJson: { ...failed.usageJson, tokens: 1 } }).where(eq(heartbeatRuns.id, f.runId));
      if (mode === "output") await db.update(heartbeatRuns).set({ stdoutExcerpt: "provider output" }).where(eq(heartbeatRuns.id, f.runId));
      if (mode === "process") await db.update(heartbeatRuns).set({ processPid: 999999 }).where(eq(heartbeatRuns.id, f.runId));
      if (mode === "controller") await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 60000) }).where(eq(heartbeatRuns.id, f.runId));
      if (mode === "active_control") adapterExecutionControls.set(f.runId, createAdapterExecutionControl());
      if (mode === "lease") await db.insert(environmentLeases).values({ companyId, heartbeatRunId: f.runId, issueId,
        provider: "daytona", providerLeaseId: "contradictory-preparation-allocation", status: "active", leasePolicy: "ephemeral" });
      if (mode === "accepted_result") {
        const contractId = randomUUID(), resultId = randomUUID();
        await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
          schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard",
          completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: {},
          canonicalSha256: contractId, createdByActorType: "system", createdByActorId: "test" });
        await db.update(heartbeatRuns).set({ nativeIssueId: issueId, completionContractId: contractId }).where(eq(heartbeatRuns.id, f.runId));
        await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId, runId: f.runId, completionContractId: contractId,
          schemaStatus: "accepted", serverFingerprint: resultId, canonicalSha256: resultId,
          resultJson: { terminal: { runTerminalState: "succeeded" } } });
      }
      if (mode === "event_source") await db.update(heartbeatRunEvents).set({ sourceEventId: "provider-event" }).where(and(eq(heartbeatRunEvents.runId, f.runId), eq(heartbeatRunEvents.seq, 1)));
      if (mode === "extra_event") await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: f.runId,
        seq: 3, eventType: "lifecycle", stream: "system", level: "info", message: "unexpected provider preparation" });
      if (mode === "principal_revoked") await db.update(chatIdentityLinks).set({ status: "revoked", revokedAt: new Date() }).where(eq(chatIdentityLinks.endpointId, f.endpoint.id));
      if (mode === "contained") await expect(db.transaction(tx => f.service.prepareFailedChatRunRetry(tx, {
        companyId, issueId, agentId, failedRunId: f.runId, initiatedByUserId: "owner-user",
      }))).rejects.toMatchObject({ details: { code: "chat_failed_run_retry_not_authorized" } });
      const send = () => request(app).post(`/api/issues/${issueId}/retry`).send({ idempotencyKey: randomUUID(), observedRunId: f.runId });
      if (mode === "prior_denied_intent") {
        const prior = await send().expect(202);
        // Reproduce a terminal unadmitted authorization refusal, retaining the
        // real HTTP intent/action receipts; the next normal click sees them.
        await db.update(heartbeatRuns).set({ logBytes: 1 }).where(eq(heartbeatRuns.id, f.runId));
        await f.service.processFailedChatRunRetry(prior.body.chatActionId);
        await db.update(heartbeatRuns).set({ logBytes: null }).where(eq(heartbeatRuns.id, f.runId));
        await reconcileTaskChatRetryReceipts(db);
        expect((await readAgentWakeupRequestsById(prior.body.requestId))[0]).toMatchObject({ status: "failed", runId: null });
        expect((await db.select().from(chatActions).where(eq(chatActions.id, prior.body.chatActionId)))[0]).toMatchObject({ status: "failed" });
      }
      const response = await send();
      if (["principal_revoked", "accepted_result"].includes(mode)) {
        expect(response.status).toBe(409);
      } else {
        expect(response.status).toBe(202);
        if (mode === "source_edited") await db.update(issueComments).set({ body: "Changed after Retry acceptance" }).where(eq(issueComments.id, String(f.action.payload.commentId)));
        await f.service.processFailedChatRunRetry(response.body.chatActionId);
      }
      if (!["contained", "prior_denied_intent", "observability_opencode", "observability_warning"].includes(mode)) {
        expect((await readHeartbeatRunsByCompanyId(companyId)).filter(run => run.retryOfRunId === f.runId)).toHaveLength(0);
        return;
      }
      const [wake] = await readAgentWakeupRequestsById(response.body.chatActionId);
      expect(wake).toMatchObject({ status: "queued", runId: expect.any(String) });
      const [successor] = await readHeartbeatRunsById(wake.runId!);
      expect(successor).toMatchObject({ retryOfRunId: f.runId, contextSnapshot: {
        source: "chat:github", wakeCommentId: f.action.payload.commentId, taskRetryRequestId: response.body.requestId } });
      const realInitialize = runIdentityModule.initializeRunIdentity;
      const initialized: string[] = [];
      const probe = vi.spyOn(runIdentityModule, "initializeRunIdentity").mockImplementation(async (database, input) => {
        const identity = await realInitialize(database, input);
        if (input.companyId !== companyId) return identity;
        expect(identity.messageId).toBe(f.action.payload.commentId);
        initialized.push(input.runId);
        throw new Error("workspace_retry_identity_probe_complete");
      });
      try {
        await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, capacity.id));
        await db.update(agents).set({ status: "idle" }).where(eq(agents.id, agentId));
        await heartbeat.resumeQueuedRuns();
        await heartbeat.drainActiveRunExecutions();
        expect(initialized).toEqual([successor.id]);
        expect((await readHeartbeatRunsById(successor.id))[0]).toMatchObject({ error: "workspace_retry_identity_probe_complete" });
        expect((await readHeartbeatRunsByCompanyId(companyId)).filter(run => run.retryOfRunId === f.runId)).toHaveLength(1);
      } finally { probe.mockRestore(); await heartbeat.drainActiveRunExecutions(); }
    } finally {
      adapterExecutionControls.get(f.runId)?.finish(); adapterExecutionControls.delete(f.runId);
      await db.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: new Date() }).where(and(
        eq(agentWakeupRequests.companyId, companyId), inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"])));
      await f.service.shutdown();
    }
  });
});
