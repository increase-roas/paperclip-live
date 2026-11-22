import {
  environmentService,
} from "../../services/environments.js";
import {
  createAdmissionTransactionScope,
  createWakeAdmissionWriter,
} from "../../modules/wake-queue/adapters/postgres.js";
import {
  chatFailedRetryNoticeWork,
} from "../../services/chat-failed-retry-notice-work.js";
import {
  issueTreeControlService,
} from "../../services/issue-tree-control.js";
import {
  configureAgentLifecycle,
  createAgentLifecycle,
} from "../../services/agent-lifecycle.js";
import {
  idleWorkSnapshot,
} from "../../services/task-admission.js";
import {
  reconcileTaskChatRetryReceipts,
} from "../../services/task-retry.js";
import {
  createFullDatabaseResponseCapture,
  installDatabaseResponseCapture,
} from ".././helpers/full-database-response-capture.js";
import {
  registerChatActionWork,
} from "../../services/chat-action-work.js";
import {
  createDeliveryWorkCoordinator,
} from "../../services/delivery-work-coordinator.js";
import {
  DELIVERY_QUEUES,
} from "../../services/delivery-work-notifications.js";
import {
  createHash,
  randomUUID,
} from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  and,
  eq,
  inArray,
  isNull,
  sql,
} from "drizzle-orm";
import {
  expect,
  it,
  vi,
} from "vitest";
import {
  agentWakeupRequests,
  agents,
  chatActions,
  chatConversations,
  chatDeliveries,
  chatEndpointResources,
  chatEndpoints,
  chatIdentityLinks,
  chatPublications,
  environmentLeases,
  environments,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
} from "@paperclipai/db";
import {
  type ChatChannelService,
} from "../../services/chat-channels.js";
import {
  issueService,
} from "../../services/issues.js";
import {
  heartbeatService,
} from "../../services/heartbeat.js";
import {
  makeMessage,
} from ".././helpers/chat-channels-fixture.js";
import {
  addSelectedChatFinal,
  db,
  deferredFailedRetryNoticeFixture,
  deliverMessage,
  describeChatChannelsSuite,
  failedReviewedGitHubRetryFixture,
  readAgentWakeupRequestsById,
  readChatActionsById,
  readChatDeliveriesById,
  readChatPublicationsByCommentId,
  readChatPublicationsByEndpointId,
  readChatPublicationsById,
  readChatPublicationsByIdempotencyKey,
  readHeartbeatRunsById,
  failedChatRetryFixture,
} from "../helpers/chat-channels-harness.js";
import type { Db } from "@paperclipai/db";
import os, {  } from "node:os";
import path, {  } from "node:path";

describeChatChannelsSuite("chat channels 38-cases", () => {
  it.each([
    "bootstrap",
    "session_open",
    "checkpoint",
    "distinct_account",
    "null_account",
    "wrong_account",
    "missing_account",
    "malformed_account",
    "wrong_thread",
    "missing_thread",
    "missing_coordinator",
    "retryable",
    "leased",
    "next_attempt",
    "ambiguous",
    "integrity",
    "cleanup",
    "active_environment",
    "notice_cleanup",
    "notice_replacement",
    "live_pid",
    "missing_input",
    "late_provider_event",
  ] as const)(
    "requires terminal-safe native ownership for an exact chat retry: %s",
    async (kind) => {
      const context = await failedChatRetryFixture("telegram");
      const hasCheckpoint = [
        "checkpoint",
        "distinct_account",
        "null_account",
        "wrong_account",
        "missing_account",
        "malformed_account",
        "wrong_thread",
        "missing_thread",
      ].includes(kind);
      const providerAccount =
        kind === "null_account"
          ? null
          : kind === "distinct_account"
            ? "retry-backend-account"
            : "exact-retry-thread";
      const checkpointAccount =
        kind === "wrong_account"
          ? "another-account"
          : kind === "missing_account"
            ? undefined
            : kind === "malformed_account"
              ? 123
              : providerAccount;
      const previousStateDirectory = process.env.PAPERCLIP_RUNNER_STATE_DIR;
      let stateDirectory: string | null = null;
      let noticeCoordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
      let noticeActionId: string | undefined;
      let noticeEnvironmentId: string | undefined;
      try {
        const nativeSessionId = randomUUID();
        const runnerInstanceId = randomUUID();
        const nativeExecutionInput = {
          schema: "paperclip.native-execution-input.v1",
          provider: { kind: "codex", model: null },
          binding: {
            companyId: context.fixture.companyId,
            runId: context.runId,
            issueId: context.issue.id,
            agentId: context.fixture.assignedAgentId,
            executionWorkspaceId: context.runId,
          },
          task: {
            identifier: context.issue.identifier,
            title: "Exact failed chat",
            description: null,
            prompt: "Exact request",
            workMode: "standard",
          },
          workspace: {
            cwd: "/tmp/paperclip-exact-chat-retry",
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
            id: randomUUID(),
            sha256: "sha",
            schemaVersion: "paperclip.completion-contract.v1",
            contract: {
              revision: "1",
              objective: "Exact request",
              criteria: [
                {
                  id: "objective",
                  requirement: "Respond to the exact request",
                },
              ],
            },
          },
          interactionResponses: [],
          credentialBindings: [],
        };
        await db
          .update(heartbeatRuns)
          .set({
            runtimeMode: "native",
            nativeIssueId: context.issue.id,
            nativePhase:
              kind === "retryable" ? "retryable_failure" : "terminal_failure",
            nativeSessionId,
            runnerInstanceId,
            errorCode: kind === "session_open" ? "provider_session_open_rejected" : "provider_initialize_timeout",
            processPid: kind === "live_pid" ? process.pid : null,
            runnerProfileJson:
              kind === "missing_input"
                ? {}
                : {
                    nativeExecutionInput,
                    ...(hasCheckpoint
                      ? {
                          sessionCheckpoint: {
                            sessionId:
                              kind === "wrong_thread"
                                ? "another-thread"
                                : kind === "missing_thread"
                                  ? undefined
                                  : "exact-retry-thread",
                            providerSessionId: checkpointAccount,
                          },
                        }
                      : {}),
                  },
          })
          .where(eq(heartbeatRuns.id, context.runId));
        if (kind !== "missing_coordinator")
          await db.insert(nativeRunFinalizations).values({
            runId: context.runId,
            companyId: context.fixture.companyId,
            issueId: context.issue.id,
            attempt: 3,
            phase:
              kind === "retryable" ? "retryable_failure" : "terminal_failure",
            recoveryState: "blocked",
            failureCode: "native_session_retry_exhausted",
            leaseOwner: kind === "leased" ? "active-owner" : null,
            nextAttemptAt:
              kind === "next_attempt" ? new Date(Date.now() + 30000) : null,
            failureDetail: {
              originalFailureCode:
                kind === "integrity"
                  ? "native_event_replay_conflict"
                  : kind === "cleanup"
                    ? "native_session_cleanup_quarantined"
                    : kind === "session_open"
                      ? "provider_session_open_rejected"
                      : "provider_initialize_timeout",
              recoveryMode:
                kind === "ambiguous"
                  ? "ambiguous_state"
                  : hasCheckpoint
                    ? "exact_checkpoint_resume"
                    : "bootstrap_retry",
              checkpointExists: hasCheckpoint,
              providerEventsExist: false,
              providerSessionEstablished: hasCheckpoint,
            },
          });
        if (kind === "late_provider_event")
          await db.insert(heartbeatRunEvents).values({
            companyId: context.fixture.companyId,
            agentId: context.fixture.assignedAgentId,
            runId: context.runId,
            seq: 1,
            eventType: "session.started",
            payload: {},
          });
        if (hasCheckpoint) {
          stateDirectory = mkdtempSync(
            path.join(os.tmpdir(), "paperclip-chat-retry-checkpoint-"),
          );
          process.env.PAPERCLIP_RUNNER_STATE_DIR = stateDirectory;
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
          const scope = {
            schema: "paperclip.native-session-scope.v2",
            companyId: context.fixture.companyId,
            agentId: context.fixture.assignedAgentId,
            workspace: { kind: "transient", ...nativeExecutionInput.workspace },
            provider: {
              driverKind: "codex_app_server",
              identity: { kind: "codex" },
            },
            normalizedSessionId: nativeSessionId,
          };
          const root = path.join(
            stateDirectory,
            createHash("sha256").update(canonical(scope)).digest("hex"),
          );
          mkdirSync(path.join(root, "runner"), { recursive: true });
          mkdirSync(path.join(root, "control-plane"), { recursive: true });
          const identity = {
            runId: context.runId,
            runnerInstanceId,
            environmentLeaseId: context.runId,
            normalizedSessionId: nativeSessionId,
          };
          writeFileSync(
            path.join(root, "control-plane", "control-plane-state.json"),
            JSON.stringify({
              schema: "paperclip.runner.durable.control-plane-state.v1",
              identity,
            }),
          );
          writeFileSync(
            path.join(root, "runner", "runner-state.json"),
            JSON.stringify({
              schema: "paperclip.runner.durable.state.v1",
              ...identity,
              lifecycle: "suspended",
              outbox: [],
            }),
          );
          writeFileSync(
            path.join(root, "runner", "codex-provider-state.json"),
            JSON.stringify({
              schema: "paperclip.runner.codex-provider-state.v1",
              lifecycle: "prepared",
              threadId: "exact-retry-thread",
              providerSessionId: providerAccount,
              activeProviderTurnId: null,
              config: { provider: "codex", driver: "codex_app_server" },
              pendingEvents: [],
              queuedEvents: [],
              toolBridge: { pending: {} },
            }),
          );
        }
        if (kind === "active_environment")
          await db.insert(environmentLeases).values({
            companyId: context.fixture.companyId,
            heartbeatRunId: context.runId,
            status: "active",
          });
        const attempt = db.transaction((tx) =>
          context.service.prepareFailedChatRunRetry(tx, {
            companyId: context.fixture.companyId,
            issueId: context.issue.id,
            agentId: context.fixture.assignedAgentId,
            failedRunId: context.runId,
            initiatedByUserId: "owner-user",
          }),
        );
        // A null account without existing provider-session evidence remains
        // conservatively ineligible for the exhausted-run recovery lane.
        if (["bootstrap", "session_open", "checkpoint", "distinct_account", "notice_cleanup", "notice_replacement"].includes(kind)) {
          const staged = await attempt;
          await expect(
            context.service.processFailedChatRunRetry(staged.actionId),
          ).resolves.toMatchObject({ status: "queued" });
          const [receipt] = await readAgentWakeupRequestsById(staged.actionId);
          expect(receipt.payload).toMatchObject({
            retryOfRunId: context.runId,
            wakeCommentIds: [context.action.payload.commentId],
          });
          if (kind === "notice_cleanup" || kind === "notice_replacement") {
            noticeActionId = staged.actionId;
            await db.update(agentWakeupRequests).set({ status: "deferred_issue_execution" })
              .where(eq(agentWakeupRequests.id, staged.actionId));
            const cleanupAttemptId = randomUUID();
            if (kind === "notice_replacement") {
              const [environment] = await db.insert(environments).values({ name: randomUUID(), driver: "ssh" }).returning();
              noticeEnvironmentId = environment.id;
            }
            const [lease] = await db.insert(environmentLeases).values({
              companyId: context.fixture.companyId, issueId: context.issue.id,
              heartbeatRunId: context.runId, status: "pending_cleanup", cleanupStatus: "failed",
              metadata: { pendingCleanupAttemptId: cleanupAttemptId, agentId: context.fixture.assignedAgentId },
              ...(kind === "notice_replacement" ? { environmentId: noticeEnvironmentId,
                status: "retained", leasePolicy: "reuse_by_environment", providerLeaseId: randomUUID() } : {}),
            }).returning();
            const errors: unknown[] = [];
            noticeCoordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true,
              canReconcile: () => true, onError: error => errors.push(error) });
            vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
            await chatFailedRetryNoticeWork(context.service).register(noticeCoordinator, () => true).ready;
            await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000);
              expect(noticeCoordinator!.nextWakeAt()).toBeNull(); expect(idleWorkSnapshot().active).toBe(0); });
            expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(0);
            const replace = (owner: Db, replacesReusableLeaseId = lease.id) => environmentService(owner).acquireLease({
              companyId: context.fixture.companyId, environmentId: noticeEnvironmentId!, issueId: context.issue.id,
              leasePolicy: "reuse_by_environment", providerLeaseId: lease.providerLeaseId,
              metadata: { agentId: context.fixture.assignedAgentId }, replacesReusableLeaseId,
            });
            if (kind === "notice_replacement") {
              await expect(replace(db, randomUUID())).rejects.toThrow("ownership changed");
              const rollback = new Error("rollback reusable lease handoff");
              await expect(db.transaction(async tx => {
                await replace(tx as unknown as Db);
                throw rollback;
              })).rejects.toBe(rollback);
              await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000);
                expect(noticeCoordinator!.nextWakeAt()).toBeNull(); expect(idleWorkSnapshot().active).toBe(0); });
              expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(0);
              await db.transaction(tx => replace(tx as unknown as Db));
            } else {
              expect(await environmentService(db).releaseLease(lease.id, "released", {
                cleanupStatus: "success", expectedPendingCleanupAttemptId: randomUUID(),
              })).toBeNull();
              const rollback = new Error("rollback native lease settlement");
              await expect(db.transaction(async tx => {
                await environmentService(tx as unknown as Db).releaseLease(lease.id, "released", {
                  cleanupStatus: "success", expectedPendingCleanupAttemptId: cleanupAttemptId,
                });
                throw rollback;
              })).rejects.toBe(rollback);
              await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000);
                expect(noticeCoordinator!.nextWakeAt()).toBeNull(); expect(idleWorkSnapshot().active).toBe(0); });
              expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(0);
              await db.transaction(async tx => {
                await environmentService(tx as unknown as Db).releaseLease(lease.id, "released", {
                  cleanupStatus: "success", expectedPendingCleanupAttemptId: cleanupAttemptId,
                });
              });
            }
            await vi.waitFor(async () => {
              await vi.advanceTimersByTimeAsync(1000);
              expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(1);
              expect(noticeCoordinator!.nextWakeAt()).toBeNull(); expect(idleWorkSnapshot().active).toBe(0);
            }, { timeout: 5000 });
            const selection = vi.spyOn(context.service, "loadFailedRetryNoticeScopes");
            try {
              if (kind === "notice_replacement") await expect(replace(db)).rejects.toThrow("ownership changed");
              else await environmentService(db).releaseLease(lease.id, "released", { cleanupStatus: "success" });
              await vi.advanceTimersByTimeAsync(1000);
              expect(selection).not.toHaveBeenCalled();
            } finally { selection.mockRestore(); }
            const select = vi.spyOn(db, "select"), transaction = vi.spyOn(db, "transaction");
            try {
              await vi.advanceTimersByTimeAsync(120_000);
              expect(select).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled();
            } finally { select.mockRestore(); transaction.mockRestore(); }
            expect(errors).toEqual([]);
          }
        } else
          await expect(attempt).rejects.toMatchObject({
            details: { code: "chat_failed_run_retry_not_authorized" },
          });
      } finally {
        await noticeCoordinator?.stop();
        if (kind === "notice_cleanup" || kind === "notice_replacement") vi.useRealTimers();
        await context.service.shutdown();
        if (noticeEnvironmentId) {
          await db.delete(environmentLeases).where(eq(environmentLeases.environmentId, noticeEnvironmentId));
          await db.delete(environments).where(eq(environments.id, noticeEnvironmentId));
        }
        if (noticeActionId) {
          await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.id, noticeActionId));
          await db.delete(chatActions).where(eq(chatActions.id, noticeActionId));
        }
        if (stateDirectory) {
          if (previousStateDirectory === undefined)
            delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
          else process.env.PAPERCLIP_RUNNER_STATE_DIR = previousStateDirectory;
          rmSync(stateDirectory, { recursive: true, force: true });
        }
      }
    },
  );

  it.each(["commit", "retry", "startup", "stale_claim", "rollback"] as const)(
    "drains failed chat retries from durable work and becomes idle: %s",
    async (mode) => {
      const context = await failedChatRetryFixture("telegram");
      const onError = vi.fn();
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError });
      const input = { companyId: context.fixture.companyId, issueId: context.issue.id,
        agentId: context.fixture.assignedAgentId, failedRunId: context.runId, initiatedByUserId: "owner-user" };
      const stage = () => db.transaction(tx => context.service.prepareFailedChatRunRetry(tx, input));
      const observedResponseAdmissions: string[] = [];
      const responseHints: string[] = [];
      await coordinator.register(DELIVERY_QUEUES.nativeResponsePresentation, {
        retryMs: 30_000,
        onSettled: hints => { responseHints.push(...hints ?? []); },
        run: async () => {
          const admitted = await db.select({ id: chatActions.id }).from(chatActions).where(and(
            eq(chatActions.companyId, context.fixture.companyId), eq(chatActions.kind, "failed_run_retry"), eq(chatActions.status, "processed"),
          ));
          observedResponseAdmissions.push(...admitted.map(row => row.id));
        },
        hasPending: async () => false,
      }).ready;
      context.wakeup.mockClear();
      try {
        let actionId: string;
        if (mode === "startup" || mode === "stale_claim") {
          ({ actionId } = await stage());
          if (mode === "stale_claim") await db.update(chatActions).set({ status: "processing",
            updatedAt: new Date(Date.now() - 120_000) }).where(eq(chatActions.id, actionId));
          await registerChatActionWork(coordinator, context.service, () => true).ready;
        } else {
          await registerChatActionWork(coordinator, context.service, () => true).ready;
          if (mode === "rollback") {
            await expect(db.transaction(async tx => {
              await context.service.prepareFailedChatRunRetry(tx, input);
              throw new Error("rollback retry intent");
            })).rejects.toThrow("rollback retry intent");
            await vi.waitFor(() => {
              expect(coordinator.nextWakeAt()).toBeNull();
              expect(idleWorkSnapshot().active).toBe(0);
            }, { timeout: 10_000 });
            expect(context.wakeup).not.toHaveBeenCalled();
          }
          if (mode === "retry") {
            let failedAt = 0;
            context.wakeup.mockImplementationOnce(async () => {
              failedAt = Date.now();
              throw new Error("temporary admission outage");
            }).mockImplementationOnce(async () => {
              expect(Date.now() - failedAt).toBeGreaterThanOrEqual(250);
              return { accepted: true };
            });
          }
          ({ actionId } = await db.transaction(async tx => {
            const staged = await tx.transaction(nested => context.service.prepareFailedChatRunRetry(nested, input));
            // A nested savepoint must not wake the worker before the outer commit.
            await new Promise(resolve => setTimeout(resolve, 25));
            expect(context.wakeup).not.toHaveBeenCalled();
            return staged;
          }));
        }
        await vi.waitFor(async () => {
          const [action] = await db.select().from(chatActions).where(eq(chatActions.id, actionId));
          expect(action?.status).toBe("processed");
          expect(action?.result?.attemptCount).toBe(mode === "retry" ? 2 : 1);
          expect(coordinator.nextWakeAt()).toBeNull();
        }, { timeout: 10_000 });
        await vi.waitFor(() => expect(observedResponseAdmissions).toContain(actionId), { timeout: 5000 });
        expect(responseHints.map(hint => JSON.parse(hint))).toContainEqual({ companyId: context.fixture.companyId, issueId: context.issue.id });
        expect(context.wakeup).toHaveBeenCalledTimes(mode === "retry" ? 2 : 1);
        const receipts = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, actionId));
        expect(receipts).toHaveLength(1);
        expect(receipts[0]?.payload).toMatchObject({ retryOfRunId: context.runId,
          wakeCommentIds: [context.action.payload.commentId] });
        // A running worker has no scheduled deadline. Wait for its final scan
        // and any commit-driven follow-up before measuring the quiet period.
        await vi.waitFor(() => {
          expect(coordinator.nextWakeAt()).toBeNull();
          expect(idleWorkSnapshot().active).toBe(0);
        }, { timeout: 10_000 });
        const scans = vi.spyOn(db, "select");
        try {
          await new Promise(resolve => setTimeout(resolve, 1200));
          expect(scans).not.toHaveBeenCalled();
        } finally { scans.mockRestore(); }
        expect(onError).not.toHaveBeenCalled();
      } finally { await coordinator.stop(); await context.service.shutdown(); }
    },
  );

  it.each(["slack", "telegram"] as const)(
    "retries the exact failed %s chat input with a new idempotent admission",
    async (provider) => {
      const context = await failedChatRetryFixture(provider);
      try {
        const sourceBefore = await readChatActionsById(context.action.id);
        const stage = () =>
          db.transaction((tx) =>
            context.service.prepareFailedChatRunRetry(tx, {
              companyId: context.fixture.companyId,
              issueId: context.issue.id,
              agentId: context.fixture.assignedAgentId,
              failedRunId: context.runId,
              initiatedByUserId: "owner-user",
            }),
          );
        const [first, duplicate] = await Promise.all([stage(), stage()]);
        expect(first).toEqual(duplicate);
        expect(first.actionId).not.toBe(context.action.id);
        await context.service.processFailedChatRunRetry(first.actionId);
        await context.service.processFailedChatRunRetry(first.actionId);
        const [retry] = await readAgentWakeupRequestsById(first.actionId);
        expect(retry).toMatchObject({
          companyId: context.fixture.companyId,
          agentId: context.fixture.assignedAgentId,
          requestedByActorType: context.receipt.requestedByActorType,
          requestedByActorId: context.receipt.requestedByActorId,
          payload: {
            issueId: context.issue.id,
            taskKey: context.issue.identifier,
            wakeCommentIds: [context.action.payload.commentId],
            retryOfRunId: context.runId,
          },
        });
        expect(
          await readChatActionsById(context.action.id),
        ).toEqual(sourceBefore);
        expect(
          await db
            .select()
            .from(agentWakeupRequests)
            .where(
              and(
                eq(agentWakeupRequests.companyId, context.fixture.companyId),
                eq(agentWakeupRequests.id, first.actionId),
              ),
            ),
        ).toHaveLength(1);
      } finally {
        await context.service.shutdown();
      }
    },
  );

  it("denies a staged failed chat retry after its original lifecycle epoch changes", async () => {
    const context = await failedChatRetryFixture("telegram");
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
      await db
        .update(chatEndpoints)
        .set({
          setup: sql`jsonb_set(${chatEndpoints.setup}, '{runtimeGeneration}', to_jsonb(coalesce((${chatEndpoints.setup}->>'runtimeGeneration')::int, 0) + 1))`,
        })
        .where(eq(chatEndpoints.id, context.endpoint.id));
      await expect(
        context.service.processFailedChatRunRetry(staged.actionId),
      ).resolves.toMatchObject({ status: "failed", runId: null });
      expect(
        await readAgentWakeupRequestsById(staged.actionId),
      ).toHaveLength(0);
    } finally {
      await context.service.shutdown();
    }
  });

  it.each([
    "paused",
    "generation",
    "retired",
    "edited",
    "deleted",
    "relinked",
    "reassigned",
    "action_cancelled",
    "agent_paused",
  ] as const)(
    "reauthorizes a failed chat retry and denies %s before scheduling",
    async (change) => {
      const context = await failedChatRetryFixture("telegram");
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
        if (change === "paused")
          await db
            .update(chatEndpoints)
            .set({ status: "paused" })
            .where(eq(chatEndpoints.id, context.endpoint.id));
        if (change === "generation")
          await db
            .update(chatEndpoints)
            .set({
              setup: sql`jsonb_set(${chatEndpoints.setup}, '{runtimeGeneration}', to_jsonb(coalesce((${chatEndpoints.setup}->>'runtimeGeneration')::int, 0) + 1))`,
            })
            .where(eq(chatEndpoints.id, context.endpoint.id));
        if (change === "retired")
          await db
            .update(chatConversations)
            .set({ state: "completed" })
            .where(eq(chatConversations.id, context.conversation.id));
        if (change === "edited")
          await db
            .update(issueComments)
            .set({
              body: "Changed after failure",
              updatedAt: new Date(Date.now() + 1000),
            })
            .where(
              eq(issueComments.id, String(context.action.payload.commentId)),
            );
        if (change === "deleted") {
          const [original] = await readChatDeliveriesById(context.action.deliveryId!);
          await db.insert(chatDeliveries).values({
            companyId: context.fixture.companyId,
            endpointId: context.endpoint.id,
            conversationId: context.conversation.id,
            principalId: context.action.principalId,
            eventKind: "message_deleted",
            providerEventId: `deleted-${randomUUID()}`,
            deduplicationKey: randomUUID(),
            state: "processed",
            normalizedEvent: {
              runtimeContext: original.normalizedEvent.runtimeContext,
              message: { targetProviderEventId: original.providerEventId },
            },
          });
        }
        if (change === "relinked")
          await db
            .insert(chatIdentityLinks)
            .values({
              companyId: context.fixture.companyId,
              endpointId: context.endpoint.id,
              principalId: context.action.principalId!,
              status: "linked",
              paperclipUserId: "owner-user",
            })
            .onConflictDoUpdate({
              target: [
                chatIdentityLinks.endpointId,
                chatIdentityLinks.principalId,
              ],
              set: { status: "linked", paperclipUserId: "owner-user" },
            });
        if (change === "reassigned")
          await db
            .update(issues)
            .set({ assigneeAgentId: context.fixture.replacementAgentId })
            .where(eq(issues.id, context.issue.id));
        if (change === "action_cancelled")
          await db
            .update(chatActions)
            .set({ status: "cancelled" })
            .where(eq(chatActions.id, context.action.id));
        if (change === "agent_paused")
          await db
            .update(agents)
            .set({ status: "paused" })
            .where(eq(agents.id, context.fixture.assignedAgentId));
        await expect(
          context.service.processFailedChatRunRetry(staged.actionId),
        ).resolves.toMatchObject({ status: "failed", runId: null });
        expect(
          await readAgentWakeupRequestsById(staged.actionId),
        ).toEqual([]);
      } finally {
        await context.service.shutdown();
      }
    },
  );

  it.each([
    "received",
    "processing",
    "retry",
    "failed",
    "processed",
    "filtered",
    "stale",
    "different_target",
  ] as const)(
    "reauthorizes a failed chat retry against a %s provider correction before lifecycle projection",
    async (state) => {
      const context = await failedChatRetryFixture("telegram");
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
        const [original] = await readChatDeliveriesById(context.action.deliveryId!);
        const fence = original.normalizedEvent.runtimeContext as Record<
          string,
          unknown
        >;
        await db.insert(chatDeliveries).values({
          companyId: context.fixture.companyId,
          endpointId: context.endpoint.id,
          // This is the durable shape produced by recordLifecycleDelivery:
          // authenticated, but not yet assigned a conversation by its worker.
          conversationId: null,
          eventKind: "message_updated",
          providerEventId: `pending-edit-${randomUUID()}`,
          deduplicationKey: randomUUID(),
          state: state === "stale" || state === "different_target"
            ? "received"
            : state,
          normalizedEvent: {
            runtimeContext:
              state === "stale"
                ? { ...fence, generation: Number(fence.generation) - 1 }
                : fence,
            message: {
              targetProviderEventId:
                state === "different_target"
                  ? "unrelated-message"
                  : original.providerEventId,
            },
          },
        });
        const denied = !["filtered", "stale", "different_target"].includes(
          state,
        );
        await expect(
          context.service.processFailedChatRunRetry(staged.actionId),
        ).resolves.toMatchObject({
          status: denied ? "failed" : "queued",
          runId: null,
        });
        expect(
          await readAgentWakeupRequestsById(staged.actionId),
        ).toHaveLength(denied ? 0 : 1);
      } finally {
        await context.service.shutdown();
      }
    },
  );

  it("does not retry a chat comment edited on the Board during the failed execution", async () => {
    const context = await failedChatRetryFixture("telegram");
    try {
      const [comment] = await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.id, String(context.action.payload.commentId)));
      await db
        .update(issueComments)
        .set({
          body: "Edited while the provider was executing the original request",
          updatedAt: new Date(comment.createdAt.getTime() + 1000),
        })
        .where(eq(issueComments.id, comment.id));
      await db
        .update(heartbeatRuns)
        .set({ finishedAt: new Date(comment.createdAt.getTime() + 2000) })
        .where(eq(heartbeatRuns.id, context.runId));
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
  });

  it("preserves the complete failed coalesced chat batch and rejects a dropped sibling", async () => {
    const context = await failedChatRetryFixture("telegram");
    try {
      const callbacks = context.runtime.configurations.get(
        context.endpoint.id,
      )!.callbacks;
      const nextMessageId = `${context.thread.thread.channelId}:102`;
      await deliverMessage({
        callbacks,
        endpointId: context.endpoint.id,
        provider: "telegram",
        thread: context.thread.thread,
        message: makeMessage({
          id: nextMessageId,
          text: "SECOND exact failed request",
          userId: context.thread.thread.channelId,
        }),
        trigger: "direct_message",
      });
      const [second] = await db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.conversationId, context.conversation.id),
            eq(chatActions.kind, "inbound_wakeup"),
            sql`${chatActions.id} <> ${context.action.id}::uuid`,
          ),
        );
      await db
        .update(agentWakeupRequests)
        .set({
          status: "coalesced",
          runId: null,
          payload: {
            issueId: context.issue.id,
            wakeCommentId: second.payload.commentId,
            coalescedIntoWakeupRequestId: context.receipt.id,
          },
        })
        .where(eq(agentWakeupRequests.id, second.id));
      const commentIds = [
        String(context.action.payload.commentId),
        String(second.payload.commentId),
      ];
      const failedContext = {
        issueId: context.issue.id,
        taskKey: context.issue.identifier,
        source: "chat:telegram",
        wakeCommentId: commentIds[1],
        wakeCommentIds: commentIds,
      };
      await db
        .update(heartbeatRuns)
        .set({
          contextSnapshot: failedContext,
          finishedAt: new Date(Date.now() + 1),
        })
        .where(eq(heartbeatRuns.id, context.runId));
      const stage = () =>
        db.transaction((tx) =>
          context.service.prepareFailedChatRunRetry(tx, {
            companyId: context.fixture.companyId,
            issueId: context.issue.id,
            agentId: context.fixture.assignedAgentId,
            failedRunId: context.runId,
            initiatedByUserId: "owner-user",
          }),
        );
      await db
        .update(heartbeatRuns)
        .set({
          contextSnapshot: {
            ...failedContext,
            wakeCommentIds: [commentIds[1]],
          },
        })
        .where(eq(heartbeatRuns.id, context.runId));
      await expect(stage()).rejects.toMatchObject({
        details: { code: "chat_failed_run_retry_not_authorized" },
      });
      await db
        .update(heartbeatRuns)
        .set({ contextSnapshot: failedContext })
        .where(eq(heartbeatRuns.id, context.runId));
      const staged = await stage();
      await context.service.processFailedChatRunRetry(staged.actionId);
      const [receipt] = await readAgentWakeupRequestsById(staged.actionId);
      expect(receipt.payload).toMatchObject({
        wakeCommentIds: commentIds,
        wakeCommentId: commentIds[1],
      });
    } finally {
      await context.service.shutdown();
    }
  });

  it.each(["normal", "drain", "failed selection", "stopped", "disabled"] as const)("reactivates failed retry notices from real admission after idle through %s", async mode => {
    const context = await deferredFailedRetryNoticeFixture(mode !== "disabled");
    let canRun = true;
    const errors: unknown[] = [];
    let coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => canRun,
      canReconcile: () => true, onError: error => errors.push(error) });
    const selection = vi.spyOn(context.service, "loadFailedRetryNoticeScopes");
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const settle = async () => vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(10);
      expect(idleWorkSnapshot().active).toBe(0); expect(coordinator.nextWakeAt()).toBeNull();
    }, { timeout: 10_000 });
    const quiet = async () => {
      const select = vi.spyOn(db, "select"), transaction = vi.spyOn(db, "transaction");
      try {
        await vi.advanceTimersByTimeAsync(120_000);
        expect(select).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled();
      } finally { select.mockRestore(); transaction.mockRestore(); }
    };
    try {
      await chatFailedRetryNoticeWork(context.service).register(coordinator, () => canRun).ready;
      await settle(); await quiet();
      if (mode === "drain") canRun = false;
      if (mode === "stopped") await coordinator.stop();
      if (mode === "failed selection") selection.mockRejectedValueOnce(new Error("temporary retry selection failure"));
      expect(await context.admit()).toMatchObject({ status: mode === "disabled" ? "failed" : "deferred" });
      if (mode === "failed selection") {
        await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(10); expect(errors).toHaveLength(1); });
        canRun = false;
      }
      if (["drain", "failed selection", "stopped"].includes(mode)) {
        await vi.advanceTimersByTimeAsync(30_000);
        await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0));
        expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(0);
        await quiet(); canRun = true;
        if (coordinator.nextWakeAt() !== null) await vi.advanceTimersByTimeAsync(Math.max(0, coordinator.nextWakeAt()! - Date.now()));
        if (mode === "stopped") {
          await context.service.processPublicationMaintenance();
          expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(0);
          coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => canRun,
            canReconcile: () => true, onError: error => errors.push(error) });
          await chatFailedRetryNoticeWork(context.service).register(coordinator, () => canRun).ready;
        }
      }
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(10);
        expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toEqual([expect.objectContaining({
          payload: mode === "disabled"
            ? { text: "This retry was not started. Open the task in Paperclip for details.", progressState: "failed" }
            : { text: "Your retry is queued.", progressState: "queued" },
        })]);
        expect(coordinator.nextWakeAt()).toBeNull(); expect(idleWorkSnapshot().active).toBe(0);
      }, { timeout: 10_000 });
      await quiet();
      expect(errors).toEqual(mode === "failed selection" ? [expect.objectContaining({ errors: [expect.objectContaining({ message: "temporary retry selection failure" })] })] : []);
    } finally {
      await coordinator.stop(); selection.mockRestore(); vi.useRealTimers(); await context.service.shutdown();
      await db.delete(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, context.fixture.companyId),
        inArray(agentWakeupRequests.id, [context.retry.requestId!, context.retry.chatActionId!]), isNull(agentWakeupRequests.runId)));
    }
  });

  it.each(["idle", "bounded pass", "requester merge", "agent resume"] as const)("reactivates denied retry notices when authority is restored during %s", async mode => {
    const context = await deferredFailedRetryNoticeFixture();
    const rejectedIds = mode === "bounded pass" ? Array.from({ length: 100 }, () => randomUUID()) : [];
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true,
      canReconcile: () => true, onError: error => errors.push(error) });
    let held = false, release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let ready: Promise<unknown> | undefined;
    let lifecycle: ReturnType<typeof configureAgentLifecycle> | undefined;
    const reconcile = context.service.reconcileFailedRetryNotices.bind(context.service);
    const pass = vi.spyOn(context.service, "reconcileFailedRetryNotices");
    try {
      expect(await context.admit()).toMatchObject({ status: "deferred" });
      const [originalReceipt] = await readAgentWakeupRequestsById(context.retry.chatActionId!);
      if (mode === "agent resume") {
        lifecycle = configureAgentLifecycle(db, { requiredPluginIds: async () => [],
          runHost: async () => "complete", runPlugin: async () => "complete" });
        await createAgentLifecycle(db).pauseAgent(context.fixture.assignedAgentId);
        await lifecycle.process(context.fixture.assignedAgentId);
        expect((await db.select().from(agents).where(eq(agents.id, context.fixture.assignedAgentId)))[0])
          .toMatchObject({ status: "paused", lifecycleState: "paused" });
      } else if (mode === "requester merge") {
        expect(originalReceipt.requestedByActorType).toBe("user");
        await db.update(agentWakeupRequests).set({ requestedByActorId: "another-requester" })
          .where(eq(agentWakeupRequests.id, originalReceipt.id));
      } else {
        await db.update(issues).set({ visibility: "private", privacyRootIssueId: context.issue.id,
          createdByUserId: null, responsibleUserId: null, assigneeUserId: null,
        }).where(eq(issues.id, context.issue.id));
      }
      if (rejectedIds.length) {
        const [action] = await db.select().from(chatActions).where(eq(chatActions.id, context.retry.chatActionId!));
        const [receipt] = await readAgentWakeupRequestsById(action.id);
        await db.insert(chatActions).values(rejectedIds.map(id => ({ ...action, id,
          providerActionId: `retry-cursor:${id}`, createdAt: new Date(action.createdAt.getTime() + 1000),
          payload: { ...action.payload, sourceScopeSha256: "invalid-source" },
        })));
        await db.insert(agentWakeupRequests).values(rejectedIds.map(id => ({ ...receipt, id,
          idempotencyKey: `retry-cursor:${id}`,
        })));
        pass.mockImplementationOnce(async input => {
          const result = await reconcile(input);
          expect(result).toMatchObject({ inserted: 0, nextCursor: expect.any(Object) });
          held = true; await pending; return result;
        });
      }
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      ready = chatFailedRetryNoticeWork(context.service).register(coordinator, () => true).ready;
      if (mode === "bounded pass") await vi.waitFor(() => expect(held).toBe(true), { timeout: 30_000 });
      else {
        await ready;
        await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(10);
          expect(coordinator.nextWakeAt()).toBeNull(); expect(idleWorkSnapshot().active).toBe(0); });
        const select = vi.spyOn(db, "select"), transaction = vi.spyOn(db, "transaction");
        try {
          await vi.advanceTimersByTimeAsync(120_000);
          expect(select).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled();
        } finally { select.mockRestore(); transaction.mockRestore(); }
      }
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(0);
      if (mode === "agent resume") {
        await createAgentLifecycle(db).resumeAgent(context.fixture.assignedAgentId);
        await lifecycle!.process(context.fixture.assignedAgentId);
        expect((await db.select().from(agents).where(eq(agents.id, context.fixture.assignedAgentId)))[0])
          .toMatchObject({ status: "idle", lifecycleState: "ready" });
      } else if (mode === "requester merge") {
        await db.transaction(async tx => {
          await tx.execute(sql`select id from issues where id = ${context.issue.id} for update`);
          await createWakeAdmissionWriter().mergeIntoExistingDeferredWake(
            createAdmissionTransactionScope(context.fixture.companyId, tx as unknown as Db), {
              companyId: context.fixture.companyId, existingDeferredWakeId: originalReceipt.id,
              mergedPayload: originalReceipt.payload ?? {}, nextCoalescedCount: 1,
              manualUserWakeActorId: originalReceipt.requestedByActorId!,
            });
        });
      } else await issueService(db).update(context.issue.id, { visibility: "open" });
      release(); await ready;
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(10);
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
      release(); await ready; await lifecycle?.stop(); await coordinator.stop(); pass.mockRestore(); vi.useRealTimers();
      await context.service.shutdown();
      await db.delete(agentWakeupRequests).where(inArray(agentWakeupRequests.id,
        [...rejectedIds, context.retry.requestId!, context.retry.chatActionId!]));
      if (rejectedIds.length) await db.delete(chatActions).where(inArray(chatActions.id, rejectedIds));
    }
  }, 60_000);

  it("wakes a not-started retry notice after resumed admission is denied", async () => {
    const context = await deferredFailedRetryNoticeFixture();
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true,
      canReconcile: () => true, onError: error => errors.push(error) });
    try {
      expect(await context.admit()).toMatchObject({ status: "deferred" });
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      await chatFailedRetryNoticeWork(context.service).register(coordinator, () => true).ready;
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(1000);
        expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(1);
        expect(coordinator.nextWakeAt()).toBeNull(); expect(idleWorkSnapshot().active).toBe(0);
      });
      await reconcileTaskChatRetryReceipts(db);
      context.wakeup.mockRejectedValueOnce(Object.assign(new Error("denied at resume"), {
        details: { code: "chat_failed_run_retry_not_authorized" },
      }));
      expect(await context.admit()).toMatchObject({ status: "failed" });
      expect((await readAgentWakeupRequestsById(context.retry.chatActionId!))[0].status).toBe("failed");
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(1000);
        expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(2);
        expect(coordinator.nextWakeAt()).toBeNull(); expect(idleWorkSnapshot().active).toBe(0);
      }, { timeout: 5000 });
      const select = vi.spyOn(db, "select"), transaction = vi.spyOn(db, "transaction");
      try {
        await vi.advanceTimersByTimeAsync(120_000);
        expect(select).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled();
      } finally { select.mockRestore(); transaction.mockRestore(); }
      expect(errors).toEqual([]);
    } finally {
      await coordinator.stop(); vi.useRealTimers(); await context.service.shutdown();
      await db.delete(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, context.fixture.companyId),
        inArray(agentWakeupRequests.id, [context.retry.requestId!, context.retry.chatActionId!]), isNull(agentWakeupRequests.runId)));
    }
  });

  it.each(["agent", "tree"] as const)("wakes a failed retry notice only after %s cancellation commits", async kind => {
    const context = await failedChatRetryFixture("telegram");
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true,
      canReconcile: () => true, onError: error => errors.push(error) });
    let stagedActionId: string | undefined;
    const settle = async () => vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect(idleWorkSnapshot().active).toBe(0); expect(coordinator.nextWakeAt()).toBeNull();
    }, { timeout: 10_000 });
    const cancel = (database: typeof db) => kind === "agent"
      ? heartbeatService(database).cancelInvocationsForAgents([context.fixture.assignedAgentId], "Cancelled retry fixture")
      : issueTreeControlService(database).cancelUnclaimedWakeupsForTree(context.fixture.companyId, context.issue.id, "Cancelled retry fixture");
    try {
      const staged = await db.transaction(tx => context.service.prepareFailedChatRunRetry(tx, {
        companyId: context.fixture.companyId, issueId: context.issue.id,
        agentId: context.fixture.assignedAgentId, failedRunId: context.runId, initiatedByUserId: "owner-user",
      }));
      stagedActionId = staged.actionId;
      await context.service.processFailedChatRunRetry(staged.actionId);
      await db.update(agentWakeupRequests).set({ status: "deferred_issue_execution" })
        .where(eq(agentWakeupRequests.id, staged.actionId));
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      await chatFailedRetryNoticeWork(context.service).register(coordinator, () => true).ready;
      await settle();
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(1);
      const rollback = new Error("rollback retry cancellation");
      await expect(db.transaction(async tx => { await cancel(tx as unknown as typeof db); throw rollback; })).rejects.toBe(rollback);
      await settle();
      expect((await readAgentWakeupRequestsById(staged.actionId))[0].status).toBe("deferred_issue_execution");
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(1);
      await db.transaction(async tx => { await cancel(tx as unknown as typeof db); });
      await settle();
      expect((await readAgentWakeupRequestsById(staged.actionId))[0].status).toBe("cancelled");
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toEqual(expect.arrayContaining([expect.objectContaining({
        payload: { text: "This retry was not started. Open the task in Paperclip for details.", progressState: "failed" },
      })]));
      const select = vi.spyOn(db, "select"), transaction = vi.spyOn(db, "transaction");
      try {
        await vi.advanceTimersByTimeAsync(120_000);
        expect(select).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled();
      } finally { select.mockRestore(); transaction.mockRestore(); }
      expect(errors).toEqual([]);
    } finally {
      await coordinator.stop(); vi.useRealTimers(); await context.service.shutdown();
      if (stagedActionId) {
        await db.delete(chatActions).where(eq(chatActions.id, stagedActionId));
        await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.id, stagedActionId));
      }
    }
  });

  it.each(["manual", "scoped"] as const)("advances failed retry notices past denied history with microsecond timestamps (%s)", async mode => {
    const context = await failedChatRetryFixture("telegram");
    const rejectedIds = Array.from({ length: 50 }, () => randomUUID());
    let stagedActionId: string | undefined;
    try {
      const staged = await db.transaction(tx => context.service.prepareFailedChatRunRetry(tx, {
        companyId: context.fixture.companyId, issueId: context.issue.id,
        agentId: context.fixture.assignedAgentId, failedRunId: context.runId, initiatedByUserId: "owner-user",
      }));
      stagedActionId = staged.actionId;
      await context.service.processFailedChatRunRetry(staged.actionId);
      const [receipt] = await db.update(agentWakeupRequests).set({ status: "deferred_issue_execution" })
        .where(eq(agentWakeupRequests.id, staged.actionId)).returning();
      const [action] = await db.select().from(chatActions).where(eq(chatActions.id, staged.actionId));
      const before = new Date(action.createdAt.getTime() - 1000).toISOString();
      await db.insert(chatActions).values(rejectedIds.map(id => ({
        ...action, id, providerActionId: `failed-run-retry:${id}`,
        payload: { ...action.payload, failedRunId: randomUUID() },
        createdAt: sql`${before}::timestamptz + interval '0.000123 seconds'`,
      })));
      await db.insert(agentWakeupRequests).values(rejectedIds.map(id => ({
        ...receipt, id, idempotencyKey: `retry-notice-cursor:${id}`,
      })));
      if (mode === "manual") {
        expect(await context.service.enqueueInboundWakeupPublications(50)).toBe(0);
        expect(await context.service.enqueueInboundWakeupPublications(50)).toBe(1);
      } else {
        const scope = { companyId: context.fixture.companyId, issueId: context.issue.id };
        const transaction = vi.spyOn(db, "transaction");
        try {
          const first = await context.service.reconcileFailedRetryNotices({ scope, limit: 50 });
          expect(first).toMatchObject({ inserted: 0, contended: false, nextCursor: expect.any(Object) });
          expect(transaction).toHaveBeenCalledTimes(50); transaction.mockClear();
          expect(await context.service.reconcileFailedRetryNotices({ scope, limit: 50, cursor: first.nextCursor }))
            .toEqual({ inserted: 1, contended: false, nextCursor: null });
          expect(transaction).toHaveBeenCalledTimes(1);
        } finally { transaction.mockRestore(); }
      }
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toEqual([expect.objectContaining({
        idempotencyKey: `wake:${staged.actionId}:queued:${context.endpoint.id}:${context.conversation.id}`,
        payload: { text: "Your retry is queued.", progressState: "queued" },
      })]);
    } finally {
      await context.service.shutdown();
      const actionIds = stagedActionId ? [...rejectedIds, stagedActionId] : rejectedIds;
      await db.delete(chatActions).where(inArray(chatActions.id, actionIds));
      await db.delete(agentWakeupRequests).where(inArray(agentWakeupRequests.id, actionIds));
    }
  });

  it.each(["task", "company", "startup"] as const)("bounds failed retry notice scope discovery with retained candidates (%s)", async mode => {
    const context = await failedChatRetryFixture("telegram");
    const other = await failedChatRetryFixture("telegram");
    const copiedIds = Array.from({ length: 250 }, () => randomUUID());
    const stagedIds: string[] = [];
    try {
      for (const target of [context, other]) {
        const staged = await db.transaction(tx => target.service.prepareFailedChatRunRetry(tx, {
          companyId: target.fixture.companyId, issueId: target.issue.id,
          agentId: target.fixture.assignedAgentId, failedRunId: target.runId, initiatedByUserId: "owner-user",
        }));
        await target.service.processFailedChatRunRetry(staged.actionId);
        await db.update(agentWakeupRequests).set({ status: "deferred_issue_execution" })
          .where(eq(agentWakeupRequests.id, staged.actionId));
        stagedIds.push(staged.actionId);
      }
      const [action] = await db.select().from(chatActions).where(eq(chatActions.id, stagedIds[0]));
      const [receipt] = await readAgentWakeupRequestsById(stagedIds[0]);
      await db.insert(chatActions).values(copiedIds.map(id => ({
        ...action, id, providerActionId: `failed_run_retry:${id}`,
      })));
      await db.insert(agentWakeupRequests).values(copiedIds.map(id => ({
        ...receipt, id, idempotencyKey: `retry-discovery-budget:${id}`,
      })));
      const scope = { companyId: context.fixture.companyId, issueId: context.issue.id };
      const events: Array<Record<string, unknown>> = [], now = Date.now();
      const capture = createFullDatabaseResponseCapture({ start: now - 1, end: now + 59_000 }, event => events.push(event));
      installDatabaseResponseCapture(db, { chatActions, agentWakeupRequests }, capture);
      let scopes: Array<{ companyId: string; issueId: string }>;
      try {
        scopes = await context.service.loadFailedRetryNoticeScopes(
          mode === "task" ? scope : mode === "company" ? { companyId: scope.companyId } : undefined,
        );
      } finally { capture.flush(); }
      if (mode === "startup") {
        expect(scopes).toEqual(expect.arrayContaining([scope, {
          companyId: other.fixture.companyId, issueId: other.issue.id,
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
      await db.delete(chatActions).where(inArray(chatActions.id, copiedIds));
      await db.delete(agentWakeupRequests).where(inArray(agentWakeupRequests.id, copiedIds));
    }
  });

  it("scopes failed retry notices and retains receipt contention without retrying settled history", async () => {
    const context = await failedChatRetryFixture("telegram");
    const other = await failedChatRetryFixture("telegram");
    let release = () => {};
    let holder: Promise<unknown> | undefined;
    try {
      const staged: Array<Awaited<ReturnType<ChatChannelService["prepareFailedChatRunRetry"]>>> = [];
      for (const target of [context, other]) {
        const action = await db.transaction(tx => target.service.prepareFailedChatRunRetry(tx, {
          companyId: target.fixture.companyId, issueId: target.issue.id,
          agentId: target.fixture.assignedAgentId, failedRunId: target.runId, initiatedByUserId: "owner-user",
        }));
        await target.service.processFailedChatRunRetry(action.actionId);
        await db.update(agentWakeupRequests).set({ status: "deferred_issue_execution" })
          .where(eq(agentWakeupRequests.id, action.actionId));
        staged.push(action);
      }
      const scope = { companyId: context.fixture.companyId, issueId: context.issue.id };
      expect(await context.service.loadFailedRetryNoticeScopes({ companyId: scope.companyId })).toEqual([scope]);
      let locked!: () => void;
      const ready = new Promise<void>(resolve => { locked = resolve; });
      const hold = new Promise<void>(resolve => { release = resolve; });
      holder = db.transaction(async tx => {
        await tx.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, staged[0].actionId)).for("update");
        locked(); await hold;
      });
      await ready;
      expect(await context.service.reconcileFailedRetryNotices({ scope }))
        .toEqual({ inserted: 0, contended: true, nextCursor: null });
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toEqual([]);
      release(); await holder;
      expect(await context.service.reconcileFailedRetryNotices({ scope }))
        .toEqual({ inserted: 1, contended: false, nextCursor: null });
      expect(await context.service.loadFailedRetryNoticeScopes({ companyId: scope.companyId })).toEqual([]);
      expect(await readChatPublicationsByEndpointId(other.endpoint.id)).toEqual([]);
      await db.update(agentWakeupRequests).set({ status: "cancelled" })
        .where(eq(agentWakeupRequests.id, staged[0].actionId));
      expect(await context.service.reconcileFailedRetryNotices({ scope }))
        .toEqual({ inserted: 1, contended: false, nextCursor: null });
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toEqual(expect.arrayContaining([expect.objectContaining({
        payload: { text: "This retry was not started. Open the task in Paperclip for details.", progressState: "failed" },
      })]));
      expect(await context.service.reconcileFailedRetryNotices({ scope }))
        .toEqual({ inserted: 0, contended: false, nextCursor: null });
      expect(await context.service.loadFailedRetryNoticeScopes({ companyId: scope.companyId })).toEqual([]);
      await db.update(agentWakeupRequests).set({ runId: other.runId })
        .where(eq(agentWakeupRequests.id, staged[1].actionId));
      expect(await other.service.loadFailedRetryNoticeScopes({ companyId: other.fixture.companyId })).toEqual([]);
    } finally { release(); await holder; await context.service.shutdown(); await other.service.shutdown(); }
  });

  it.each(["slack", "telegram"] as const)(
    "keeps a %s retry's queue, working, and selected final on its own provider identity",
    async (provider) => {
      const context = await failedChatRetryFixture(provider);
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
        await context.service.processFailedChatRunRetry(staged.actionId);
        await db
          .update(agentWakeupRequests)
          .set({ status: "deferred_issue_execution" })
          .where(eq(agentWakeupRequests.id, staged.actionId));
        await context.service.enqueueInboundWakeupPublications(100);
        await context.service.processPendingPublications(100);
        const [queued] = await readChatPublicationsByIdempotencyKey(`wake:${staged.actionId}:queued:${context.endpoint.id}:${context.conversation.id}`);
        expect(queued).toMatchObject({ state: "published", attempts: 1 });
        const [receipt] = await readAgentWakeupRequestsById(staged.actionId);
        const retryRunId = randomUUID();
        await db.insert(heartbeatRuns).values({
          id: retryRunId,
          companyId: context.fixture.companyId,
          agentId: context.fixture.assignedAgentId,
          status: "running",
          wakeupRequestId: staged.actionId,
          retryOfRunId: context.runId,
          contextSnapshot: receipt.payload,
        });
        await db
          .update(agentWakeupRequests)
          .set({ runId: retryRunId, status: "claimed" })
          .where(eq(agentWakeupRequests.id, staged.actionId));
        await db
          .update(issues)
          .set({ status: "in_progress", executionRunId: retryRunId })
          .where(eq(issues.id, context.issue.id));
        await db.insert(chatPublications).values({
          companyId: context.fixture.companyId,
          endpointId: context.endpoint.id,
          conversationId: context.conversation.id,
          issueId: context.issue.id,
          idempotencyKey: `run:${retryRunId}:working:${context.endpoint.id}`,
          payload: {
            text: "Maya is retrying the requested work…",
            progressState: "working",
          },
          state: "pending",
        });
        await context.service.processPendingPublications(100);
        await db
          .update(heartbeatRuns)
          .set({ status: "succeeded", finishedAt: new Date() })
          .where(eq(heartbeatRuns.id, retryRunId));
        const final = await addSelectedChatFinal({
          companyId: context.fixture.companyId,
          issueId: context.issue.id,
          agentId: context.fixture.assignedAgentId,
          runId: retryRunId,
          body: "EXACT-RETRY-ANSWER",
        });
        await context.service.processPendingPublications(100);
        const [finalPublication] = await readChatPublicationsByCommentId(final.id);
        expect(finalPublication).toMatchObject({
          state: "published",
          attempts: 1,
          providerMessageId: queued.providerMessageId,
        });
        expect(context.providerRuntime.posts).toHaveLength(1);
        expect(context.providerRuntime.edits.at(-1)?.text).toContain(
          "EXACT-RETRY-ANSWER",
        );
      } finally {
        await context.service.shutdown();
      }
    },
  );

  it("retains an exact chat retry through a transient scheduling failure and a lost committed receipt acknowledgement", async () => {
    const context = await failedChatRetryFixture("telegram");
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
      context.wakeup.mockClear();
      context.wakeup.mockRejectedValueOnce(
        new Error("temporary scheduler failure"),
      );
      await expect(
        context.service.processFailedChatRunRetry(staged.actionId),
      ).resolves.toMatchObject({ status: "queued", runId: null });
      expect(
        await readAgentWakeupRequestsById(staged.actionId),
      ).toHaveLength(0);
      await db
        .update(chatActions)
        .set({ result: sql`${chatActions.result} - 'retryAt'` })
        .where(eq(chatActions.id, staged.actionId));
      context.wakeup.mockImplementationOnce(async (agentId, opts) => {
        const request = opts.durableChatRequest!;
        await db.transaction(async (tx) => {
          await request.authorize(tx as unknown as Parameters<typeof request.authorize>[0]);
          await tx.insert(agentWakeupRequests).values({
            id: request.id,
            companyId: request.companyId,
            agentId,
            source: opts.source!,
            triggerDetail: opts.triggerDetail,
            reason: opts.reason,
            payload: opts.payload,
            requestedByActorType: opts.requestedByActorType,
            requestedByActorId: opts.requestedByActorId,
            idempotencyKey: request.idempotencyKey,
            requestedAt: request.requestedAt,
            status: "queued",
          });
        });
        throw new Error("receipt acknowledgement lost after commit");
      });
      await expect(
        context.service.processFailedChatRunRetry(staged.actionId),
      ).resolves.toMatchObject({ status: "queued", runId: null });
      await context.service.processFailedChatRunRetry(staged.actionId);
      expect(context.wakeup).toHaveBeenCalledTimes(2);
      expect(
        await readAgentWakeupRequestsById(staged.actionId),
      ).toHaveLength(1);
      expect(
        await readChatActionsById(staged.actionId),
      ).toEqual([
        expect.objectContaining({
          status: "processed",
          result: expect.objectContaining({ attemptCount: 2 }),
        }),
      ]);
    } finally {
      await context.service.shutdown();
    }
  });

  it("retains a retry final when its source authorization read fails transiently", async () => {
    const context = await failedChatRetryFixture("telegram");
    let spy: { mockRestore(): void } | undefined;
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
      await context.service.processFailedChatRunRetry(staged.actionId);
      const [receipt] = await readAgentWakeupRequestsById(staged.actionId);
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: context.fixture.companyId,
        agentId: context.fixture.assignedAgentId,
        status: "succeeded",
        finishedAt: new Date(),
        wakeupRequestId: staged.actionId,
        retryOfRunId: context.runId,
        contextSnapshot: receipt.payload,
      });
      await db
        .update(agentWakeupRequests)
        .set({ runId, status: "completed" })
        .where(eq(agentWakeupRequests.id, staged.actionId));
      const final = await addSelectedChatFinal({
        companyId: context.fixture.companyId,
        issueId: context.issue.id,
        agentId: context.fixture.assignedAgentId,
        runId,
        body: "Retry answer survives temporary source read failure",
      });
      const transaction = db.transaction.bind(db);
      let injected = false;
      spy = vi.spyOn(db, "transaction").mockImplementation((callback, config) =>
        transaction(async (tx) => {
          const select = tx.select.bind(tx);
          vi.spyOn(tx, "select").mockImplementation(((
            fields?: Record<string, unknown>,
          ) => {
            if (!injected && fields?.status === agents.status) {
              const selection = select(fields as Parameters<typeof select>[0]);
              const from = selection.from.bind(selection);
              vi.spyOn(selection, "from").mockImplementation((table) => {
                const query = from(table);
                const where = query.where.bind(query);
                vi.spyOn(query, "where").mockImplementation((condition) => {
                  const scoped = where(condition);
                  const { params } = scoped.toSQL();
                  // Maintenance may inspect another task's queued notice first.
                  // Fail only this final's own source-authorization read.
                  if (!injected && params.includes(context.fixture.companyId) &&
                      params.includes(context.fixture.assignedAgentId)) {
                    injected = true;
                    throw new Error("temporary source read unavailable");
                  }
                  return scoped;
                });
                return query;
              });
              return selection;
            }
            return fields
              ? select(fields as Parameters<typeof select>[0])
              : select();
          }) as typeof tx.select);
          return callback(tx);
        }, config),
      );
      await context.service.processPendingPublications(100);
      spy.mockRestore();
      spy = undefined;
      expect(injected).toBe(true);
      const [pending] = await readChatPublicationsByCommentId(final.id);
      expect(pending.state).toBe("retry");
      expect(context.providerRuntime.posts).toHaveLength(0);
      await db
        .update(chatPublications)
        .set({ nextAttemptAt: null })
        .where(eq(chatPublications.id, pending.id));
      await context.service.processPendingPublications(100);
      expect(
        await readChatPublicationsById(pending.id),
      ).toEqual([expect.objectContaining({ state: "published" })]);
      expect(context.providerRuntime.posts).toHaveLength(1);
    } finally {
      spy?.mockRestore();
      await context.service.shutdown();
    }
  });

  it("allows a new exact failed chat retry after an ordinary retry fails, without rearming its ancestors", async () => {
    const context = await failedChatRetryFixture("telegram");
    try {
      const input = {
        companyId: context.fixture.companyId,
        issueId: context.issue.id,
        agentId: context.fixture.assignedAgentId,
        failedRunId: context.runId,
        initiatedByUserId: "owner-user",
      };
      const first = await db.transaction((tx) =>
        context.service.prepareFailedChatRunRetry(tx, input),
      );
      await context.service.processFailedChatRunRetry(first.actionId);
      const [receipt] = await readAgentWakeupRequestsById(first.actionId);
      const failedRetryRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: failedRetryRunId,
        companyId: context.fixture.companyId,
        agentId: context.fixture.assignedAgentId,
        status: "failed",
        errorCode: "adapter_failed",
        finishedAt: new Date(),
        wakeupRequestId: receipt.id,
        retryOfRunId: context.runId,
        contextSnapshot: receipt.payload,
      });
      await db
        .update(agentWakeupRequests)
        .set({ runId: failedRetryRunId, status: "failed" })
        .where(eq(agentWakeupRequests.id, receipt.id));
      const [ancestor] = await readChatActionsById(first.actionId);
      const cyclicContext = {
        ...receipt.payload,
        retryOfRunId: failedRetryRunId,
        chatFailedRunRetry: {
          version: 1,
          actionId: first.actionId,
          failedRunId: failedRetryRunId,
        },
      };
      await db
        .update(chatActions)
        .set({
          payload: { ...ancestor.payload, failedRunId: failedRetryRunId },
        })
        .where(eq(chatActions.id, ancestor.id));
      await db
        .update(heartbeatRuns)
        .set({ retryOfRunId: failedRetryRunId, contextSnapshot: cyclicContext })
        .where(eq(heartbeatRuns.id, failedRetryRunId));
      await expect(
        db.transaction((tx) =>
          context.service.prepareFailedChatRunRetry(tx, {
            ...input,
            failedRunId: failedRetryRunId,
          }),
        ),
      ).rejects.toMatchObject({
        details: { code: "chat_failed_run_retry_not_authorized" },
      });
      await db
        .update(chatActions)
        .set({ payload: ancestor.payload })
        .where(eq(chatActions.id, ancestor.id));
      await db
        .update(heartbeatRuns)
        .set({ retryOfRunId: context.runId, contextSnapshot: receipt.payload })
        .where(eq(heartbeatRuns.id, failedRetryRunId));
      const second = await db.transaction((tx) =>
        context.service.prepareFailedChatRunRetry(tx, {
          ...input,
          failedRunId: failedRetryRunId,
        }),
      );
      expect(second.actionId).not.toBe(first.actionId);
      await context.service.processFailedChatRunRetry(second.actionId);
      const [secondReceipt] = await readAgentWakeupRequestsById(second.actionId);
      expect(secondReceipt.payload).toMatchObject({
        retryOfRunId: failedRetryRunId,
        taskKey: context.issue.identifier,
        wakeCommentIds: [context.action.payload.commentId],
      });
      expect(
        await readChatActionsById(first.actionId),
      ).toEqual([ancestor]);
    } finally {
      await context.service.shutdown();
    }
  });

  it("retries an exact GitHub source denied by pre-provider reviewed attestation without rewriting its failure", async () => {
    const context = await failedReviewedGitHubRetryFixture();
    try {
      const [original] = await readHeartbeatRunsById(context.runId);
      const [originalSource] = await readChatActionsById(context.action.id);
      const stage = () =>
        db.transaction((tx) =>
          context.service.prepareFailedChatRunRetry(tx, {
            companyId: context.fixture.companyId,
            issueId: context.issue.id,
            agentId: context.fixture.assignedAgentId,
            failedRunId: context.runId,
            initiatedByUserId: "owner-user",
          }),
        );
      const first = await stage();
      expect(await stage()).toEqual(first);
      await expect(
        context.service.processFailedChatRunRetry(first.actionId),
      ).resolves.toMatchObject({ status: "queued" });
      await context.service.processFailedChatRunRetry(first.actionId);
      const receipts = await readAgentWakeupRequestsById(first.actionId);
      expect(receipts).toEqual([
        expect.objectContaining({
          companyId: context.fixture.companyId,
          agentId: context.fixture.assignedAgentId,
          requestedByActorType: context.receipt.requestedByActorType,
          requestedByActorId: context.receipt.requestedByActorId,
          payload: expect.objectContaining({
            issueId: context.issue.id,
            taskKey: context.issue.identifier,
            wakeCommentIds: [context.action.payload.commentId],
            retryOfRunId: context.runId,
          }),
        }),
      ]);
      expect(
        await readHeartbeatRunsById(context.runId),
      ).toEqual([original]);
      expect(
        await readChatActionsById(context.action.id),
      ).toEqual([originalSource]);
      expect(
        await db
          .select()
          .from(nativeRunFinalizations)
          .where(eq(nativeRunFinalizations.runId, context.runId)),
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(nativeRunResults)
          .where(eq(nativeRunResults.runId, context.runId)),
      ).toEqual([]);
    } finally {
      await context.service.shutdown();
    }
  });

  it("rechecks pre-provider retry evidence after staging and refuses a late execution event", async () => {
    const context = await failedReviewedGitHubRetryFixture();
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
      const wakeCount = context.wakeup.mock.calls.length;
      await db.insert(heartbeatRunEvents).values({
        companyId: context.fixture.companyId,
        agentId: context.fixture.assignedAgentId,
        runId: context.runId,
        seq: 2,
        eventType: "prp",
        sourceInstanceId: "late-provider",
        payload: { type: "turn.started" },
      });
      await expect(
        context.service.processFailedChatRunRetry(staged.actionId),
      ).resolves.toMatchObject({ status: "failed", runId: null });
      expect(context.wakeup.mock.calls.length).toBe(wakeCount);
      expect(
        await readAgentWakeupRequestsById(staged.actionId),
      ).toEqual([]);
    } finally {
      await context.service.shutdown();
    }
  });

  it.each([
    "other_setup_error",
    "missing_error_event",
    "provider_event",
    "native_profile",
    "native_identity",
    "process_identity",
    "provider_output",
    "environment_lease",
    "uncertain_publication",
    "selected_reply",
    "revoked_resource",
    "retired_conversation",
    "edited_source",
  ] as const)(
    "denies a pre-provider reviewed retry with %s",
    async (change) => {
      const context = await failedReviewedGitHubRetryFixture();
      try {
        if (change === "other_setup_error")
          await db
            .update(heartbeatRuns)
            .set({ error: "Some other setup failure" })
            .where(eq(heartbeatRuns.id, context.runId));
        if (change === "missing_error_event")
          await db
            .delete(heartbeatRunEvents)
            .where(eq(heartbeatRunEvents.runId, context.runId));
        if (change === "provider_event")
          await db.insert(heartbeatRunEvents).values({
            companyId: context.fixture.companyId,
            agentId: context.fixture.assignedAgentId,
            runId: context.runId,
            seq: 2,
            eventType: "prp",
            sourceInstanceId: "provider-source",
            payload: { type: "turn.started" },
          });
        if (change === "native_profile")
          await db
            .update(heartbeatRuns)
            .set({ runnerProfileJson: { nativeExecutionInput: {} } })
            .where(eq(heartbeatRuns.id, context.runId));
        if (change === "native_identity")
          await db
            .update(heartbeatRuns)
            .set({ nativeSessionId: randomUUID() })
            .where(eq(heartbeatRuns.id, context.runId));
        if (change === "process_identity")
          await db
            .update(heartbeatRuns)
            .set({ processPid: 987654 })
            .where(eq(heartbeatRuns.id, context.runId));
        if (change === "provider_output")
          await db
            .update(heartbeatRuns)
            .set({ lastOutputSeq: 1 })
            .where(eq(heartbeatRuns.id, context.runId));
        if (change === "environment_lease")
          await db.insert(environmentLeases).values({
            companyId: context.fixture.companyId,
            heartbeatRunId: context.runId,
            status: "released",
          });
        if (change === "uncertain_publication")
          await db.insert(chatPublications).values({
            companyId: context.fixture.companyId,
            endpointId: context.endpoint.id,
            conversationId: context.conversation.id,
            issueId: context.issue.id,
            state: "delivery_unknown",
            idempotencyKey: `run:${context.runId}:working:uncertain`,
            payload: { text: "Possibly sent" },
          });
        if (change === "selected_reply") {
          const [comment] = await db
            .insert(issueComments)
            .values({
              companyId: context.fixture.companyId,
              issueId: context.issue.id,
              authorAgentId: context.fixture.assignedAgentId,
              authorType: "agent",
              createdByRunId: context.runId,
              body: "Already selected response",
            })
            .returning();
          await db.insert(chatPublications).values({
            companyId: context.fixture.companyId,
            endpointId: context.endpoint.id,
            conversationId: context.conversation.id,
            issueId: context.issue.id,
            commentId: comment.id,
            state: "pending",
            idempotencyKey: `selected:${context.runId}`,
            payload: { text: comment.body },
          });
        }
        if (change === "revoked_resource")
          await db
            .update(chatEndpointResources)
            .set({ enabled: false })
            .where(
              eq(chatEndpointResources.id, context.conversation.resourceId!),
            );
        if (change === "retired_conversation")
          await db
            .update(chatConversations)
            .set({ state: "completed" })
            .where(eq(chatConversations.id, context.conversation.id));
        if (change === "edited_source")
          await db
            .update(issueComments)
            .set({ updatedAt: new Date(Date.now() + 1000) })
            .where(
              eq(issueComments.id, String(context.action.payload.commentId)),
            );
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
        expect(
          await db
            .select()
            .from(chatActions)
            .where(
              and(
                eq(chatActions.companyId, context.fixture.companyId),
                eq(chatActions.kind, "failed_run_retry"),
              ),
            ),
        ).toEqual([]);
      } finally {
        await context.service.shutdown();
      }
    },
  );

  it.each(["adapter_failed", "adapter_exit_code", "process_exit", "timeout"])(
    "admits the exact chat source for ordinary %s failure",
    async (errorCode) => {
      const context = await failedChatRetryFixture("telegram");
      try {
        await db
          .update(heartbeatRuns)
          .set({ errorCode })
          .where(eq(heartbeatRuns.id, context.runId));
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
        ).resolves.toMatchObject({ issueId: context.issue.id });
      } finally {
        await context.service.shutdown();
      }
    },
  );

  it.each([
    "native_event_replay_conflict",
    "native_session_cleanup_quarantined",
    "native_session_operator_recovery_required",
    "native_execution_ownership_unverified",
    "runner_state_identity_mismatch",
    "unknown",
  ])("does not bypass %s through an exact chat retry", async (errorCode) => {
    const context = await failedChatRetryFixture("telegram");
    try {
      await db
        .update(heartbeatRuns)
        .set({ errorCode })
        .where(eq(heartbeatRuns.id, context.runId));
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
      expect(
        await db
          .select()
          .from(chatActions)
          .where(
            and(
              eq(chatActions.companyId, context.fixture.companyId),
              eq(chatActions.kind, "failed_run_retry"),
            ),
          ),
      ).toEqual([]);
    } finally {
      await context.service.shutdown();
    }
  });
});
