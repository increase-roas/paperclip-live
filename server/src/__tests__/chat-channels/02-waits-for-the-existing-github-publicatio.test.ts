import {
  chatHistoryActionBlocks,
} from ".././helpers/chat-history-proof.js";
import {
  settleUnrecoverableExecutions,
} from "../../services/execution-recovery-resolution.js";
import {
  recordRunPresentationDecision,
} from "../../services/heartbeat/run-completion.js";
import {
  issueTreeControlService,
} from "../../services/issue-tree-control.js";
import {
  idleWorkSnapshot,
} from "../../services/task-admission.js";
import {
  createDeliveryWorkCoordinator,
} from "../../services/delivery-work-coordinator.js";
import {
  notifyChatPublicationWork,
} from "../../services/chat-work-notifications.js";
import {
  aiConnectionService,
} from "../../services/ai-connections.js";
import {
  fastResponseService,
} from "../../services/fast-responses.js";
import {
  fastResponseReceipt,
} from "../../services/fast-response-provider.js";
import {
  agentWakeupRequests,
  agents,
  chatActions,
  chatDeliveries,
  chatEndpointLeases,
  chatEndpointResources,
  chatEndpoints,
  chatGitHubRegistrations,
  chatGitHubReviews,
  chatIdentityLinks,
  chatMessageLinks,
  chatPublications,
  companies,
  companyFastResponses,
  fastResponseRequests,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
  toolCatalogEntries,
  toolConnections,
} from "@paperclipai/db";
import {
  withGitHubPublicationLease,
} from "../../services/chat-github-publication-lease.js";
import {
  githubChatWizardService,
} from "../../services/chat-github-wizard.js";
import {
  githubChatReviewService,
} from "../../services/chat-github-reviews.js";
import {
  githubResponseCommentService,
} from "../../services/chat-github-response-comments.js";
import {
  githubAutomaticReviewEvent,
} from "../../services/chat-github-events.js";
import {
  githubBotToolsForSession,
} from "../../services/chat-github-tools.js";
import {
  initializeRunIdentity,
} from "../../services/run-identity.js";
import {
  createHash,
  randomUUID,
} from "node:crypto";
import {
  and,
  eq,
  inArray,
  sql,
} from "drizzle-orm";
import {
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import {
  defaultGitHubReviewPolicy,
} from "@paperclipai/shared";
import {
  issueService,
} from "../../services/issues.js";
import {
  instanceSettingsService,
} from "../../services/instance-settings.js";
import {
  enqueueChatRunMilestones,
  githubRunReplyState,
  resolveChatRunPresentationAuthorizationReason,
} from "../../services/chat-run-publications.js";
import {
  heartbeatService,
} from "../../services/heartbeat.js";
import {
  FakeChatSdkRuntime,
  makeMessage,
  makeThread,
  wizardStoreApp,
} from ".././helpers/chat-channels-fixture.js";
import {
  chatWakeContext,
  createService,
  db,
  deliverMessage,
  describeChatChannelsSuite,
  readChatActionsById,
  readChatGitHubRegistrationsByEndpointId,
  readChatGitHubReviewsByEndpointId,
  readChatPublicationsByEndpointId,
  readChatPublicationsById,
  readHeartbeatRunsById,
  readIssuesById,
  readToolConnectionsById,
  recordGitHubWebhookVerification,
  seedCompany,
  configuredGitHubEndpoint,
} from "../helpers/chat-channels-harness.js";
import {
  addPeerGitHubBot,
  reviewBotFixture,
  toolReplyFixture,
} from "../helpers/chat-channels-provider-fixtures.js";
import type { Db } from "@paperclipai/db";
import type { PaperclipCloudConnector } from "../../services/paperclip-cloud-connector.js";
import type { InternalSetupState } from "../../services/chat-channels/runtime-types.js";

describeChatChannelsSuite("chat channels 02-waits-for-the-existing-github-publicatio", () => {
    it("waits for the existing GitHub publication lease before a terminal response", async () => {
      const f = await toolReplyFixture();
      const [resource] = await db.select().from(chatEndpointResources).where(eq(chatEndpointResources.endpointId, f.endpoint.id));
      const errors: unknown[] = [];
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
      let release!: () => void, entered!: () => void;
      const hold = new Promise<void>(resolve => { release = resolve; });
      const ready = new Promise<void>(resolve => { entered = resolve; });
      let lease: Promise<unknown> | undefined;
      try {
        await githubResponseCommentService(db, f.providerFetch).registerTerminalResponseWork(coordinator, () => true).ready;
        lease = withGitHubPublicationLease(db, { companyId: f.companyId, endpointId: f.endpoint.id,
          repositoryId: String(resource.metadata.providerRepositoryId), number: 418 }, f.providerFetch, async () => { entered(); await hold; });
        await ready;
        const baseline = f.responseWrites.length;
        await db.update(heartbeatRuns).set({ status: "failed", updatedAt: new Date() }).where(eq(heartbeatRuns.id, f.run.id));
        await issueService(db).update(f.conversation.issueId!, { status: "blocked" });
        await expect.poll(() => coordinator.nextWakeAt(), { timeout: 5000 }).not.toBeNull();
        expect(f.responseWrites).toHaveLength(baseline);
        release(); await lease;
        await expect.poll(() => [...f.responseComments.values()][0]?.body, { timeout: 5000 }).toContain("stopped before completing");
        await expect.poll(() => coordinator.nextWakeAt(), { timeout: 5000 }).toBeNull();
        expect(errors).toEqual([]);
      } finally { release(); await lease; await coordinator.stop(); }
    });

    it("finds owed terminal GitHub work beyond a full page of unrelated request history", async () => {
      const f = await toolReplyFixture("github:paperclipai/paperclip:418");
      const [original] = await db.select().from(chatActions).where(and(eq(chatActions.endpointId, f.endpoint.id), eq(chatActions.kind, "github_response_comment")));
      const [delivery] = await db.select().from(chatDeliveries).where(eq(chatDeliveries.id, original.deliveryId!));
      await db.update(heartbeatRuns).set({ status: "failed", updatedAt: new Date() }).where(eq(heartbeatRuns.id, f.run.id));
      const history = Array.from({ length: 101 }, (_, index) => ({
        actionId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        deliveryId: randomUUID(), commentId: randomUUID(), providerId: `retained-request-${index}`,
      }));
      await db.insert(issueComments).values(history.map(row => ({ id: row.commentId, companyId: f.companyId,
        issueId: f.conversation.issueId!, authorUserId: "owner-user", body: "A separate retained request" })));
      await db.insert(chatDeliveries).values(history.map(row => ({ ...delivery, id: row.deliveryId,
        providerEventId: row.providerId, deduplicationKey: row.providerId, state: "processed" as const })));
      await db.insert(chatMessageLinks).values(history.map(row => ({ companyId: f.companyId, endpointId: f.endpoint.id,
        conversationId: f.conversation.id, deliveryId: row.deliveryId, commentId: row.commentId,
        providerMessageId: row.providerId, direction: "inbound" })));
      await db.insert(chatActions).values(history.map(row => ({ ...original, id: row.actionId, deliveryId: row.deliveryId,
        providerActionId: `github_response:${row.deliveryId}`, result: { code: "fast_response_superseded" } })));
      const errors: unknown[] = [];
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
      try {
        const baseline = f.responseWrites.length;
        await githubResponseCommentService(db, f.providerFetch).registerTerminalResponseWork(coordinator, () => true).ready;
        await expect.poll(() => [...f.responseComments.values()][0]?.body, { timeout: 5000 }).toContain("stopped before completing");
        await expect.poll(() => coordinator.nextWakeAt(), { timeout: 5000 }).toBeNull();
        expect(f.responseWrites).toHaveLength(baseline + 1);
        expect(await db.select().from(chatActions).where(inArray(chatActions.id, history.map(row => row.actionId))))
          .toEqual(expect.arrayContaining(history.map(row => expect.objectContaining({ id: row.actionId,
            status: "processed", result: { code: "fast_response_superseded" } }))));
        expect(errors).toEqual([]);
      } finally {
        await coordinator.stop();
        await db.delete(chatActions).where(inArray(chatActions.id, history.map(row => row.actionId)));
      }
    });

    it.each([false, true])("parks terminal GitHub responses behind the publication owner (uncertain: %s)", async uncertain => {
      const f = await toolReplyFixture();
      const errors: unknown[] = [];
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
      let release!: () => void, entered!: () => void;
      const hold = new Promise<void>(resolve => { release = resolve; });
      const ready = new Promise<void>(resolve => { entered = resolve; });
      let intercepted = false;
      let sending: Promise<unknown> | undefined;
      const action = async () => (await db.select().from(chatActions).where(and(eq(chatActions.endpointId, f.endpoint.id), eq(chatActions.kind, "github_review_publication"))))[0];
      try {
        await githubResponseCommentService(db, f.providerFetch).registerTerminalResponseWork(coordinator, () => true).ready;
        f.setSupplementalProviderFetch(async input => {
          if (intercepted || !String(input).endsWith("/access_tokens")) return undefined;
          const publication = await action();
          if (!publication) return undefined;
          intercepted = true;
          if (uncertain) await db.update(chatActions).set({ result: { replyWriteStarted: true } }).where(eq(chatActions.id, publication.id));
          await db.update(heartbeatRuns).set({ status: "failed", updatedAt: new Date() }).where(eq(heartbeatRuns.id, f.run.id));
          await issueService(db).update(f.conversation.issueId!, { status: "blocked" });
          entered(); await hold;
          return undefined;
        });
        const baseline = f.responseWrites.length;
        sending = githubChatReviewService(db, f.providerFetch).execute(f.session, "comment", { body: "Authored final response", idempotencyKey: "terminal-owner-race" });
        await ready;
        await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }),
          { timeout: 5000 }).toEqual({ active: 0, next: null });
        expect(f.responseWrites).toHaveLength(baseline);
        release(); await sending;
        expect((await action()).status).toBe("cancelled");
        if (!uncertain) await expect.poll(() => [...f.responseComments.values()][0]?.body, { timeout: 5000 }).toContain("stopped before completing");
        await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }),
          { timeout: 5000 }).toEqual({ active: 0, next: null });
        if (uncertain) expect(f.responseWrites).toHaveLength(baseline);
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
        const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction");
        onTestFinished(() => { reads.mockRestore(); writes.mockRestore(); });
        await vi.advanceTimersByTimeAsync(120_000);
        expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
        reads.mockRestore(); writes.mockRestore(); expect(errors).toEqual([]);
      } finally { release(); await sending; await coordinator.stop(); vi.useRealTimers(); }
    });

    it.each(["tree restore", "workspace admission", "exhausted recovery"] as const)("wakes a paused GitHub response from %s", async producer => {
      const f = await toolReplyFixture("github:paperclipai/paperclip:418");
      const issueId = f.conversation.issueId!;
      await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, f.run.id));
      await db.update(chatActions).set({ result: sql`coalesce(${chatActions.result}, '{}'::jsonb) || '{"final":true}'::jsonb` })
        .where(and(eq(chatActions.endpointId, f.endpoint.id), eq(chatActions.kind, "github_response_comment")));
      const thread = makeThread({ channelId: "paperclipai/paperclip", id: f.conversation.externalThreadId }).thread;
      await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
        trigger: "mention", message: makeMessage({ id: "41802", text: "New request", userId: "42", userName: "octocat", mentioned: true }) });
      const [link] = await db.select().from(chatMessageLinks).where(and(eq(chatMessageLinks.endpointId, f.endpoint.id), eq(chatMessageLinks.providerMessageId, "41802")));
      const action = async () => (await db.select().from(chatActions).where(and(eq(chatActions.deliveryId, link.deliveryId!), eq(chatActions.kind, "github_response_comment"))))[0];
      let mutate: () => Promise<unknown>;
      if (producer === "tree restore") {
        await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, issueId));
        const tree = issueTreeControlService(db);
        const actor = { actorType: "user" as const, actorId: "owner-user", userId: "owner-user" };
        const cancelled = await tree.createHold(f.companyId, issueId, { mode: "cancel", actor });
        await tree.cancelIssueStatusesForHold(f.companyId, issueId, cancelled.hold.id);
        const restore = await tree.createHold(f.companyId, issueId, { mode: "restore", actor });
        mutate = () => tree.restoreIssueStatusesForHold(f.companyId, issueId, restore.hold.id, { actor });
      } else if (producer === "workspace admission") {
        const settings = instanceSettingsService(db);
        const previous = await settings.getExperimental();
        await settings.updateExperimental({ enableIsolatedWorkspaces: true });
        onTestFinished(async () => { await settings.updateExperimental({ enableIsolatedWorkspaces: previous.enableIsolatedWorkspaces }); });
        const heartbeat = heartbeatService(db);
        onTestFinished(() => heartbeat.drainActiveRunExecutions());
        await db.update(issues).set({ status: "todo", workMode: "standard", responsibleUserId: "owner-user",
          projectId: null, projectWorkspaceId: null, executionWorkspaceId: null, executionRunId: null, checkoutRunId: null,
          executionWorkspaceSettings: { mode: "isolated_workspace", workspaceStrategy: { type: "git_worktree" } },
        }).where(eq(issues.id, issueId));
        await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: true } } }).where(eq(agents.id, f.assignedAgentId));
        mutate = () => heartbeat.wakeup(f.assignedAgentId, { source: "assignment", triggerDetail: "system",
          reason: "issue_assigned", payload: { issueId }, contextSnapshot: { issueId, wakeReason: "issue_assigned" } });
      } else {
        await db.update(issues).set({ status: "in_progress", executionRunId: null, checkoutRunId: null }).where(eq(issues.id, issueId));
        await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: issueId,
          kind: "active_run_watchdog", ownerType: "board", returnOwnerAgentId: f.assignedAgentId,
          cause: "uncertain_external_action", status: "active", evidence: { runId: f.run.id }, fingerprint: randomUUID(),
          nextAction: "Preserve the recorded outcome without replay.",
        });
        mutate = () => settleUnrecoverableExecutions(db);
      }
      const errors: unknown[] = [];
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
      try {
        await githubResponseCommentService(db, f.providerFetch).registerTerminalResponseWork(coordinator, () => true).ready;
        await expect.poll(() => coordinator.nextWakeAt(), { timeout: 5000 }).toBeNull();
        expect((await action()).result?.pausedVersion).toBeUndefined();
        await mutate();
        expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].status).toBe("blocked");
        await expect.poll(async () => (await action()).result?.pausedVersion, { timeout: 5000 }).toEqual(expect.any(String));
        expect([...f.responseComments.values()][0].body).toContain("paused");
        await expect.poll(() => coordinator.nextWakeAt(), { timeout: 5000 }).toBeNull();
        expect(errors).toEqual([]);
      } finally { await coordinator.stop(); }
    });

    it.each(["release", "restart", "drain", "standby"] as const)("wakes GitHub acknowledgements from a real publication lease %s", async mode => {
      const f = await reviewBotFixture();
      const [resource] = await db.select().from(chatEndpointResources).where(eq(chatEndpointResources.endpointId, f.endpoint.id));
      const errors: unknown[] = [];
      let canRun = true;
      let coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => canRun,
        canReconcile: () => mode !== "standby" || canRun, onError: error => errors.push(error) });
      const register = () => f.service.registerGitHubAcknowledgementWork(coordinator, () => canRun);
      let worker = register();
      let release!: () => void, entered!: () => void;
      const hold = new Promise<void>(resolve => { release = resolve; });
      const claimed = new Promise<void>(resolve => { entered = resolve; });
      let lease: Promise<unknown> | undefined;
      try {
        await worker.ready;
        expect(errors).toEqual([]);
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
        expect(coordinator.nextWakeAt()).toBeNull();
        const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction");
        await vi.advanceTimersByTimeAsync(120_000);
        expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
        reads.mockRestore(); writes.mockRestore();
        vi.setSystemTime(Date.now() - 120_000);
        lease = withGitHubPublicationLease(db, { companyId: f.companyId, endpointId: f.endpoint.id,
          repositoryId: String(resource.metadata.providerRepositoryId), number: 418 }, f.providerFetch, async () => { entered(); await hold; });
        await claimed;
        if (mode === "restart") await coordinator.stop();
        if (mode === "drain" || mode === "standby") canRun = false;
        const thread = makeThread({ channelId: "paperclipai/paperclip", id: "github:paperclipai/paperclip:issue:418" }).thread;
        await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
          trigger: "mention", message: makeMessage({ id: "41801", text: "Fix this", userId: "42", userName: "octocat", mentioned: true }) });
        const [action] = await db.select().from(chatActions).where(and(eq(chatActions.endpointId, f.endpoint.id), eq(chatActions.kind, "github_response_comment")));
        expect(action.status).toBe("received"); expect(f.responseWrites).toEqual([]);
        release(); await lease;
        if (mode === "drain" || mode === "standby") {
          await vi.advanceTimersByTimeAsync(1000);
          expect(f.responseWrites).toEqual([]);
          canRun = true; worker.wake();
        }
        if (mode === "restart") {
          coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
          worker = register(); await worker.ready;
        }
        await vi.waitFor(async () => {
          await vi.advanceTimersByTimeAsync(10);
          expect((await db.select().from(chatActions).where(eq(chatActions.id, action.id)))[0].status).toBe("processed");
          expect(idleWorkSnapshot().active).toBe(0); expect(coordinator.nextWakeAt()).toBeNull();
        }, { timeout: 10_000 });
        expect(f.responseWrites).toHaveLength(1);
        expect(f.responseWrites[0].body).toContain("Working on this");
        const settledReads = vi.spyOn(db, "select"), settledWrites = vi.spyOn(db, "transaction");
        await vi.advanceTimersByTimeAsync(120_000);
        expect(settledReads).not.toHaveBeenCalled(); expect(settledWrites).not.toHaveBeenCalled();
        settledReads.mockRestore(); settledWrites.mockRestore();
        expect(errors).toEqual([]);
      } finally {
        release(); await lease; await coordinator.stop(); vi.useRealTimers();
      }
    });

    it.each(["failure", "expiry", "published", "delivery_unknown", "streaming quarantine"] as const)("releases a GitHub acknowledgement after fast response %s without maintenance polling", async outcome => {
      await instanceSettingsService(db).updateExperimental({ enableFastResponses: true });
      const f = await reviewBotFixture();
      const binding = await aiConnectionService(db).save(f.companyId, "owner-user", { provider: "openrouter", method: "api_key", name: "Fast GitHub", ownership: "shared", apiKey: "fixture-key", agentIds: [], allAgents: true }, "fixture-key");
      const fast = fastResponseService(db, { authorizeExternal: f.service.authorizeFastResponse,
        provider: async () => ({ ...(outcome === "failure" ? { errorCode: "invalid_output", noProviderWork: true } : { text: "I’ll check it." }), receipt: fastResponseReceipt({ usage: { inputTokens: 80, outputTokens: 8 } }) }) });
      await fast.configure(f.companyId, "owner-user", { enabled: true, ...binding, model: "openai/gpt-oss-120b", allowSponsored: true });
      const errors: unknown[] = [];
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      try {
        await f.service.registerGitHubAcknowledgementWork(coordinator, () => true).ready;
        const thread = makeThread({ channelId: "paperclipai/paperclip", id: "github:paperclipai/paperclip:issue:418" }).thread;
        await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
          trigger: "mention", message: makeMessage({ id: "41801", text: "Fix this", userId: "42", userName: "octocat", mentioned: true }) });
        const [job] = await db.select().from(fastResponseRequests).where(eq(fastResponseRequests.companyId, f.companyId));
        await vi.waitFor(async () => {
          await vi.advanceTimersByTimeAsync(10);
          expect(coordinator.nextWakeAt()).toBe(job.expiresAt.getTime());
        }, { timeout: 5000 });
        expect(f.responseWrites).toEqual([]);
        if (outcome === "expiry") await vi.advanceTimersByTimeAsync(job.expiresAt.getTime() - Date.now());
        else {
          await fast.process(job);
          if (outcome === "streaming quarantine") {
            await db.update(chatPublications).set({ state: "streaming", updatedAt: new Date(0) })
              .where(eq(chatPublications.idempotencyKey, `fast-response:${job.id}`));
            await vi.advanceTimersByTimeAsync(Math.max(0, job.expiresAt.getTime() - Date.now()));
            await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(10); expect(coordinator.nextWakeAt()).toBeNull(); expect(idleWorkSnapshot().active).toBe(0); });
            expect(f.responseWrites).toEqual([]);
            const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction");
            await vi.advanceTimersByTimeAsync(120_000);
            expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
            reads.mockRestore(); writes.mockRestore();
            await f.service.processPendingPublications();
          } else if (outcome === "delivery_unknown") {
            await db.transaction(async tx => {
              await notifyChatPublicationWork(tx, { companyId: job.companyId, issueId: job.issueId });
              await tx.update(chatPublications).set({ state: "delivery_unknown" }).where(eq(chatPublications.idempotencyKey, `fast-response:${job.id}`));
            });
          } else if (outcome === "published") await f.service.processPendingPublications();
        }
        let processedAt: number | undefined;
        await vi.waitFor(async () => {
          await vi.advanceTimersByTimeAsync(10);
          const [action] = await db.select().from(chatActions).where(and(eq(chatActions.endpointId, f.endpoint.id), eq(chatActions.kind, "github_response_comment")));
          expect(action.status).toBe("processed");
          processedAt ??= Date.now();
          expect(idleWorkSnapshot().active).toBe(0); expect(coordinator.nextWakeAt()).toBeNull();
        }, { timeout: 10_000 });
        if (outcome !== "expiry" && outcome !== "streaming quarantine") expect(processedAt).toBeLessThan(job.expiresAt.getTime());
        expect(f.responseWrites).toHaveLength(["failure", "expiry"].includes(outcome) ? 1 : 0);
        const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction");
        await vi.advanceTimersByTimeAsync(120_000);
        expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
        reads.mockRestore(); writes.mockRestore();
        expect(errors).toEqual([]);
      } finally { await coordinator.stop(); vi.useRealTimers(); }
    });

    it("wakes a GitHub acknowledgement only after the outer fast-response transaction commits", async () => {
      await instanceSettingsService(db).updateExperimental({ enableFastResponses: true });
      const f = await reviewBotFixture();
      const binding = await aiConnectionService(db).save(f.companyId, "owner-user", { provider: "openrouter", method: "api_key", name: "Fast GitHub", ownership: "shared", apiKey: "fixture-key", agentIds: [], allAgents: true }, "fixture-key");
      const fast = fastResponseService(db, { authorizeExternal: f.service.authorizeFastResponse });
      await fast.configure(f.companyId, "owner-user", { enabled: true, ...binding, model: "openai/gpt-oss-120b", allowSponsored: true });
      const thread = makeThread({ channelId: "paperclipai/paperclip", id: "github:paperclipai/paperclip:issue:418" }).thread;
      await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
        trigger: "mention", message: makeMessage({ id: "41801", text: "Fix this", userId: "42", userName: "octocat", mentioned: true }) });
      const [job] = await db.update(fastResponseRequests).set({ expiresAt: new Date(Date.now() + 60_000) })
        .where(eq(fastResponseRequests.companyId, f.companyId)).returning();
      const errors: unknown[] = [];
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      try {
        await f.service.registerGitHubAcknowledgementWork(coordinator, () => true).ready;
        expect(coordinator.nextWakeAt()).toBe(job.expiresAt.getTime());
        const skip = async (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => {
          await tx.update(companyFastResponses).set({ enabled: false }).where(eq(companyFastResponses.companyId, f.companyId));
          expect(await fastResponseService(tx as unknown as Db).process(job)).toMatchObject({ status: "unavailable" });
          await vi.advanceTimersByTimeAsync(100);
          expect(f.responseWrites).toEqual([]);
          expect((await db.select().from(fastResponseRequests).where(eq(fastResponseRequests.id, job.id)))[0].status).toBe("pending");
        };
        await expect(db.transaction(async tx => { await skip(tx); throw new Error("rollback fast response skip"); })).rejects.toThrow("rollback fast response skip");
        await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(10); expect(idleWorkSnapshot().active).toBe(0); });
        expect(f.responseWrites).toEqual([]);
        expect(coordinator.nextWakeAt()).toBe(job.expiresAt.getTime());
        await db.transaction(skip);
        await vi.waitFor(async () => {
          await vi.advanceTimersByTimeAsync(10);
          expect(f.responseWrites).toHaveLength(1);
          expect(coordinator.nextWakeAt()).toBeNull(); expect(idleWorkSnapshot().active).toBe(0);
        }, { timeout: 10_000 });
        expect(Date.now()).toBeLessThan(job.expiresAt.getTime());
        expect(errors).toEqual([]);
      } finally { await coordinator.stop(); vi.useRealTimers(); }
    });

    it.each(["drain", "standby", "shutdown"] as const)("stops GitHub acknowledgement sends at %s between provider requests", async mode => {
      const f = await reviewBotFixture();
      f.setSupplementalProviderFetch(async (input, init) => String(input).includes("/issues/418/comments") && init?.method === "POST" ? new Response("unavailable", { status: 503 }) : undefined);
      const thread = makeThread({ channelId: "paperclipai/paperclip", id: "github:paperclipai/paperclip:issue:418" }).thread;
      await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
        trigger: "mention", message: makeMessage({ id: "41801", text: "Fix this", userId: "42", userName: "octocat", mentioned: true }) });
      const [action] = await db.select().from(chatActions).where(and(eq(chatActions.endpointId, f.endpoint.id), eq(chatActions.kind, "github_response_comment")));
      expect(action.status).toBe("failed"); expect(action.result?.attempts).toBe(1);
      await db.update(chatActions).set({ result: { ...action.result, retryAt: new Date(0).toISOString() } }).where(eq(chatActions.id, action.id));
      let release!: () => void, entered!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { entered = resolve; });
      f.setSupplementalProviderFetch(async input => {
        if (String(input).includes("/issues/418/comments?")) { entered(); await held; }
        return undefined;
      });
      let canRun = true;
      const errors: unknown[] = [];
      let coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => canRun,
        canReconcile: () => mode !== "standby" || canRun, onError: error => errors.push(error) });
      let worker = f.service.registerGitHubAcknowledgementWork(coordinator, () => canRun);
      let stopping: Promise<void> | undefined;
      try {
        await started;
        if (mode === "shutdown") stopping = coordinator.stop(); else canRun = false;
        release(); await worker.ready; await stopping;
        expect(f.responseWrites).toEqual([]);
        expect((await db.select().from(chatActions).where(eq(chatActions.id, action.id)))[0].result?.attempts).toBe(1);
        canRun = true;
        if (mode === "shutdown") {
          coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
          worker = f.service.registerGitHubAcknowledgementWork(coordinator, () => true); await worker.ready;
        } else worker.wake();
        await vi.waitFor(() => { expect(f.responseWrites).toHaveLength(1); expect(coordinator.nextWakeAt()).toBeNull(); }, { timeout: 10_000 });
        expect(errors).toEqual([]);
      } finally { release(); await stopping; await coordinator.stop(); }
    });

    it("retries a failed GitHub acknowledgement at its saved deadline", async () => {
      const f = await reviewBotFixture();
      let unavailable = true, attempts = 0;
      f.setSupplementalProviderFetch(async (input, init) => {
        if (String(input).includes("/issues/418/comments") && init?.method === "POST") { attempts++; if (unavailable) return new Response("unavailable", { status: 503 }); }
        return undefined;
      });
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      try {
        await f.service.registerGitHubAcknowledgementWork(coordinator, () => true).ready;
        const thread = makeThread({ channelId: "paperclipai/paperclip", id: "github:paperclipai/paperclip:issue:418" }).thread;
        await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
          trigger: "mention", message: makeMessage({ id: "41801", text: "Fix this", userId: "42", userName: "octocat", mentioned: true }) });
        const [action] = await db.select().from(chatActions).where(and(eq(chatActions.endpointId, f.endpoint.id), eq(chatActions.kind, "github_response_comment")));
        expect(action.status).toBe("failed"); expect(attempts).toBe(1);
        await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(10); expect(coordinator.nextWakeAt()).toBe(Date.parse(String(action.result?.retryAt))); });
        unavailable = false;
        await vi.advanceTimersByTimeAsync(Math.max(0, coordinator.nextWakeAt()! - Date.now()));
        await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(10); expect(f.responseWrites).toHaveLength(1); expect(coordinator.nextWakeAt()).toBeNull(); }, { timeout: 10_000 });
        expect(attempts).toBe(2);
      } finally { await coordinator.stop(); vi.useRealTimers(); }
    });

    it.each(["received", "failed", "cancelled"] as const)("preserves the %s GitHub receipt lifecycle during acknowledgement recovery", async status => {
      const f = await toolReplyFixture();
      const [action] = await db.select().from(chatActions).where(and(eq(chatActions.endpointId, f.endpoint.id), eq(chatActions.kind, "github_response_comment")));
      expect(action.result?.id).toBeTruthy();
      await db.update(chatActions).set({ status }).where(eq(chatActions.id, action.id));
      const writes = f.responseWrites.length;
      await githubResponseCommentService(db, f.providerFetch).tryAcknowledge(action.deliveryId!);
      const [settled] = await db.select().from(chatActions).where(eq(chatActions.id, action.id));
      expect(settled.status).toBe(status === "cancelled" ? "cancelled" : "processed");
      expect(settled.result).toEqual(action.result);
      expect(f.responseWrites).toHaveLength(writes);
    });

    it("does not post a GitHub working comment when the scheduler declines the request", async () => {
      const f = await reviewBotFixture();
      f.wakeup.mockImplementation(async (agentId, opts) => {
        const request = opts.durableChatRequest!;
        await db.transaction(async tx => {
          await request.authorize(tx as unknown as Parameters<typeof request.authorize>[0]);
          await tx.insert(agentWakeupRequests).values({
            id: request.id, companyId: request.companyId, agentId,
            source: opts.source ?? "assignment", triggerDetail: opts.triggerDetail,
            reason: "daily_limit", payload: opts.payload,
            requestedByActorType: opts.requestedByActorType,
            requestedByActorId: opts.requestedByActorId,
            idempotencyKey: request.idempotencyKey, requestedAt: request.requestedAt,
            status: "skipped",
          });
        });
        return null;
      });
      const thread = makeThread({ channelId: "paperclipai/paperclip", id: "github:paperclipai/paperclip:issue:418" }).thread;
      await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
        trigger: "mention", message: makeMessage({ id: "41801", text: "Are you there?", userId: "42", userName: "octocat", mentioned: true }) });
      const [action] = await db.select().from(chatActions).where(and(eq(chatActions.endpointId, f.endpoint.id), eq(chatActions.kind, "inbound_wakeup")));
      expect(action).toMatchObject({ status: "failed", result: { code: "inbound_wakeup_skipped" } });
      await githubResponseCommentService(db, f.providerFetch).processPending();
      expect(f.responseWrites).toEqual([]);
      expect(f.responseComments.size).toBe(0);
    });

    it.each(["published", "failed", "delivery_unknown"] as const)("coordinates GitHub working feedback with a %s fast response", async outcome => {
      await instanceSettingsService(db).updateExperimental({ enableFastResponses: true });
      const f = await reviewBotFixture();
      const binding = await aiConnectionService(db).save(f.companyId, "owner-user", { provider: "openrouter", method: "api_key", name: "Fast GitHub", ownership: "shared", apiKey: "fixture-key", agentIds: [], allAgents: true }, "fixture-key");
      const fast = fastResponseService(db, { authorizeExternal: f.service.authorizeFastResponse,
        provider: async () => ({ ...(outcome === "failed" ? { errorCode: "invalid_output", noProviderWork: true } : { text: "I’ll check the border styling." }), receipt: fastResponseReceipt({ usage: { inputTokens: 80, outputTokens: 8 } }) }) });
      await fast.configure(f.companyId, "owner-user", { enabled: true, ...binding, model: "openai/gpt-oss-120b", allowSponsored: true });
      const now = vi.spyOn(Date, "now").mockReturnValue(Date.now()); onTestFinished(() => now.mockRestore());
      const thread = makeThread({ channelId: "paperclipai/paperclip", id: "github:paperclipai/paperclip:issue:418" }).thread;
      await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
        trigger: "mention", message: makeMessage({ id: "41801", text: "Fix the border styling", userId: "42", userName: "octocat", mentioned: true }) });
      const [job] = await db.select().from(fastResponseRequests).where(eq(fastResponseRequests.companyId, f.companyId));
      expect(job).toBeDefined();
      expect(f.responseWrites).toEqual([]);
      await fast.process(job);
      if (outcome === "delivery_unknown") {
        await db.update(chatPublications).set({ state: "delivery_unknown" }).where(eq(chatPublications.idempotencyKey, `fast-response:${job.id}`));
      } else await f.service.processPendingPublications();
      await githubResponseCommentService(db, f.providerFetch).processPending();
      if (outcome === "failed") expect(f.responseWrites).toEqual([expect.objectContaining({ body: expect.stringContaining("Working on this") })]);
      else expect(f.responseWrites).toEqual([]);
      if (outcome === "published") {
        expect(f.runtime.endpoints.get(f.endpoint.id)!.posts).toContainEqual({ threadId: thread.id, text: "I’ll check the border styling." });
        const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.assignedAgentId,
          status: "running", runtimeMode: "native", contextSnapshot: await chatWakeContext({
            endpointId: f.endpoint.id, issueId: job.issueId!, provider: "github", providerMessageId: "41801",
          }) }).returning();
        await githubChatReviewService(db, f.providerFetch).execute({ companyId: f.companyId, agentId: f.assignedAgentId,
          issueId: job.issueId!, runId: run.id }, "comment", { body: "The border styling is fixed.", idempotencyKey: "fast-response-final" });
        expect(f.responseWrites).toEqual([expect.objectContaining({ body: expect.stringContaining("The border styling is fixed.") })]);
        expect((await readHeartbeatRunsById(run.id))[0].status).toBe("running");
      }
      expect((await readIssuesById(job.issueId!))[0].status).not.toBe("done");
    });

    it("acknowledges a GitHub request after a durable scheduler retry succeeds", async () => {
      const f = await reviewBotFixture();
      f.wakeup.mockRejectedValueOnce(new Error("Temporary scheduler outage"));
      const thread = makeThread({ channelId: "paperclipai/paperclip", id: "github:paperclipai/paperclip:issue:418" }).thread;
      await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
        trigger: "mention", message: makeMessage({ id: "41801", text: "Are you there?", userId: "42", userName: "octocat", mentioned: true }) });
      const [action] = await db.select().from(chatActions).where(and(eq(chatActions.endpointId, f.endpoint.id), eq(chatActions.kind, "inbound_wakeup")));
      expect(action.status).toBe("issued");
      expect(f.responseWrites).toEqual([]);
      await db.update(chatActions).set({ result: { ...action.result, retryAt: new Date(0).toISOString() } }).where(eq(chatActions.id, action.id));
      await f.service.processPendingDeliveries(1, action.deliveryId!);
      const [accepted] = await readChatActionsById(action.id);
      expect(accepted.status).toBe("processed");
      expect(f.responseWrites.map(write => write.method)).toEqual(["POST"]);
      expect([...f.responseComments.values()][0].body).toContain("Working on this");
    });

    it("finalizes every working comment in a coalesced GitHub run", async () => {
      const f = await toolReplyFixture();
      const thread = makeThread({ channelId: "paperclipai/paperclip", id: f.conversation.externalThreadId }).thread;
      await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
        trigger: "mention", message: makeMessage({ id: "41802", text: "And this too", userId: "42", userName: "octocat", mentioned: true }) });
      // Acknowledgements use a best-effort publication lane. Establish both
      // working comments before testing their coalesced completion cleanup.
      await expect.poll(async () => {
        await githubResponseCommentService(db, f.providerFetch).processPending();
        return f.responseComments.size;
      }, { timeout: 10_000 }).toBe(2);
      const links = await db.select().from(chatMessageLinks).where(and(eq(chatMessageLinks.endpointId, f.endpoint.id), eq(chatMessageLinks.direction, "inbound")));
      const latest = await chatWakeContext({ endpointId: f.endpoint.id, issueId: f.conversation.issueId, provider: "github", providerMessageId: "41802" });
      await db.update(heartbeatRuns).set({ contextSnapshot: { ...latest, wakeCommentIds: links.map(link => link.commentId) } }).where(eq(heartbeatRuns.id, f.run.id));
      await githubChatReviewService(db, f.providerFetch).execute(f.session, "comment", { body: "Both requests answered", idempotencyKey: "final-coalesced" });
      expect(f.responseComments.size).toBe(2);
      expect([...f.responseComments.values()].every(comment => comment.body.includes("paperclip-response-state:final"))).toBe(true);
      expect([...f.responseComments.values()].some(comment => comment.body.includes("response to this request"))).toBe(true);
    });

    it("settles a deleted coalesced working comment without blocking the current GitHub response", async () => {
      const f = await toolReplyFixture();
      const thread = makeThread({ channelId: "paperclipai/paperclip", id: f.conversation.externalThreadId }).thread;
      await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
        trigger: "mention", message: makeMessage({ id: "41802", text: "And this too", userId: "42", userName: "octocat", mentioned: true }) });
      await expect.poll(async () => { await githubResponseCommentService(db, f.providerFetch).processPending(); return f.responseComments.size; }, { timeout: 10_000 }).toBe(2);
      const firstId = [...f.responseComments.keys()][0];
      f.responseComments.delete(firstId);
      const links = await db.select().from(chatMessageLinks).where(and(eq(chatMessageLinks.endpointId, f.endpoint.id), eq(chatMessageLinks.direction, "inbound")));
      const latest = await chatWakeContext({ endpointId: f.endpoint.id, issueId: f.conversation.issueId, provider: "github", providerMessageId: "41802" });
      await db.update(heartbeatRuns).set({ contextSnapshot: { ...latest, wakeCommentIds: links.map(link => link.commentId) } }).where(eq(heartbeatRuns.id, f.run.id));
      const result = await githubChatReviewService(db, f.providerFetch).execute(f.session, "comment", { body: "Both requests answered", idempotencyKey: "final-deleted-coalesced" });
      expect(result.status).toBe("processed");
      expect(f.responseComments.size).toBe(1);
      expect([...f.responseComments.values()][0].body).toContain("Both requests answered");
      expect(f.responseWrites.filter(write => write.method === "POST")).toHaveLength(2);
      const [deleted] = await db.select().from(chatActions).where(and(eq(chatActions.endpointId, f.endpoint.id), eq(chatActions.kind, "github_response_comment"), sql`${chatActions.result}->>'id' = ${String(firstId)}`));
      expect(deleted).toMatchObject({ status: "cancelled", result: { final: true, code: "response_deleted" } });
      expect(await chatHistoryActionBlocks(db, deleted.id)).toBe(false);
      await githubResponseCommentService(db, f.providerFetch).processPending();
      expect(f.responseComments.size).toBe(1);
      await expect(githubRunReplyState(db, { ...f.session, endpointId: f.endpoint.id })).resolves.toBe("confirmed");
    });

    it("recovers a delayed GitHub acknowledgement after a successful run without leaving it working", async () => {
      const f = await toolReplyFixture();
      const [response] = await db.select().from(chatActions).where(and(eq(chatActions.endpointId, f.endpoint.id), eq(chatActions.kind, "github_response_comment")));
      await db.update(chatActions).set({ status: "received", result: null }).where(eq(chatActions.id, response.id));
      await db.update(heartbeatRuns).set({ status: "succeeded", nativePhase: "committed", resultJson: { presentationDecision: {
        schema: "paperclip.run_presentation_decision.v1", commentAction: "none", chosenSource: "none",
        reasonCodes: ["no_final_response"],
      } } }).where(eq(heartbeatRuns.id, f.run.id));
      await githubResponseCommentService(db, f.providerFetch).processPending();
      expect(f.responseComments.size).toBe(1);
      expect([...f.responseComments.values()][0].body).toContain("without publishing a final response");
      expect([...f.responseComments.values()][0].body).toContain("paperclip-response-state:final");
      expect(f.responseWrites.map(write => write.method)).toEqual(["POST", "PATCH"]);
    });

    it("parks a GitHub acknowledgement until native presentation commits", async () => {
      const f = await toolReplyFixture();
      const [action] = await db.select().from(chatActions).where(and(
        eq(chatActions.endpointId, f.endpoint.id), eq(chatActions.kind, "github_response_comment")));
      await db.update(chatActions).set({ status: "received", result: null }).where(eq(chatActions.id, action.id));
      await db.update(heartbeatRuns).set({ status: "succeeded", nativePhase: "committed", resultJson: {} })
        .where(eq(heartbeatRuns.id, f.run.id));
      const errors: unknown[] = [];
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true,
        onError: error => errors.push(error) });
      const decision = { schema: "paperclip.run_presentation_decision.v1" as const, resolverVersion: "2",
        sourceEventId: null, commentId: null, activityDisposition: "collapse" as const,
        commentAction: "none" as const, chosenSource: "none" as const, reasonCodes: ["no_final_response"] };
      const commit = (database: typeof db) => recordRunPresentationDecision(database, {
        companyId: f.companyId, runId: f.run.id, issueId: f.conversation.issueId!, decision,
      });
      try {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
        await f.service.registerGitHubAcknowledgementWork(coordinator, () => true).ready;
        const quiet = async () => {
          await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(10);
            expect(coordinator.nextWakeAt()).toBeNull(); expect(idleWorkSnapshot().active).toBe(0); });
          const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction");
          try {
            await vi.advanceTimersByTimeAsync(120_000);
            expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
          } finally { reads.mockRestore(); writes.mockRestore(); }
        };
        await quiet();
        expect(f.responseWrites).toHaveLength(1);
        await expect(db.transaction(async tx => {
          await commit(tx as unknown as typeof db);
          expect((await readHeartbeatRunsById(f.run.id))[0].resultJson?.presentationDecision).toBeUndefined();
          throw new Error("rollback presentation");
        })).rejects.toThrow("rollback presentation");
        await quiet();
        expect(f.responseWrites).toHaveLength(1);
        await commit(db);
        await vi.waitFor(async () => {
          await vi.advanceTimersByTimeAsync(10);
          expect((await db.select().from(chatActions).where(eq(chatActions.id, action.id)))[0])
            .toMatchObject({ status: "processed", result: { final: true } });
        }, { timeout: 10_000 });
        expect(f.responseWrites.map(write => write.method)).toEqual(["POST", "PATCH"]);
        expect(f.responseWrites[1].body).toContain("without publishing a final response");
        await quiet();
        expect(errors).toEqual([]);
      } finally { await coordinator.stop(); vi.useRealTimers(); }
    });

    it("does not let an unsettled GitHub fallback block a later board message", async () => {
      const f = await toolReplyFixture();
      await db.insert(chatActions).values({ companyId: f.companyId, endpointId: f.endpoint.id, conversationId: f.conversation.id,
        kind: "github_review_publication", providerActionId: `github_publication:${randomUUID()}`, status: "failed",
        payload: { operation: "comment", session: f.session }, result: { code: "publication_failed", retryable: false, attempts: 8 } });
      await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, f.run.id));
      await enqueueChatRunMilestones(db); await f.service.processPendingPublications();
      await f.service.publishBoardMessage(f.endpoint.id, f.conversation.id, "Operator follow-up", randomUUID(), "owner-user");
      await f.service.processPendingPublications();
      expect(f.runtime.endpoints.get(f.endpoint.id)?.posts.some(post => JSON.stringify(post).includes("Operator follow-up"))).toBe(true);
      await expect(githubRunReplyState(db, { ...f.session, endpointId: f.endpoint.id })).resolves.toBe("unsettled");
    });

    it("loads an old GitHub review directly without crossing endpoint or company boundaries", async () => {
      const f = await toolReplyFixture("github:paperclipai/paperclip:418");
      const event = githubAutomaticReviewEvent({ action: "opened", repository: { id: 97531, full_name: "paperclipai/paperclip" }, sender: { id: 42, login: "octocat" },
        pull_request: { number: 418, title: "Review", body: "", draft: false, base: { sha: "a".repeat(40), ref: "master" }, head: { sha: "b".repeat(40) }, user: { id: 42, login: "octocat" }, labels: [] } }, randomUUID())!;
      const records = await db.insert(chatGitHubReviews).values(Array.from({ length: 101 }, (_, index) => ({ companyId: f.companyId, endpointId: f.endpoint.id,
        issueId: f.conversation.issueId!, repositoryId: "97531", repository: event.repository, pullNumber: 418, headSha: event.headSha,
        deliveryId: randomUUID(), configurationRevision: 1, policySnapshot: defaultGitHubReviewPolicy(), event, createdAt: new Date(Date.now() + index * 1000) }))).returning();
      expect(await f.management.reviews(f.endpoint.id)).toHaveLength(100);
      expect((await f.management.review(f.endpoint.id, records[0].id)).id).toBe(records[0].id);
      const peer = await addPeerGitHubBot(f);
      await expect(f.management.review(peer.id, records[0].id)).rejects.toMatchObject({ status: 404 });
      const other = await reviewBotFixture();
      await expect(other.management.review(other.endpoint.id, records[0].id)).rejects.toMatchObject({ status: 404 });
    });

    it.each(["github:paperclipai/paperclip:issue:418", "github:paperclipai/paperclip:418", "github:paperclipai/paperclip:418:rc:41799"])(
      "updates one GitHub acknowledgement through progress and final answer in %s", async threadId => {
      const f = await toolReplyFixture(threadId);
      const service = githubChatReviewService(db, f.providerFetch);
      expect(f.responseWrites).toHaveLength(1);
      expect(f.responseWrites[0]).toMatchObject({ method: "POST", body: expect.stringContaining(
        threadId === "github:paperclipai/paperclip:418" ? "Review queued" : "Working on this") });
      expect(f.runtime.endpoints.get(f.endpoint.id)?.reactions).toEqual([]);
      const progress = await service.execute(f.session, "update_comment", { body: "Checking the request", idempotencyKey: "progress-1" });
      expect(progress.status).toBe("processed");
      await expect(githubRunReplyState(db, { ...f.session, endpointId: f.endpoint.id })).resolves.toBe("none");
      await service.execute(f.session, "update_comment", { body: "Checking the request", idempotencyKey: "progress-1" });
      await service.execute(f.session, "update_comment", { body: "Ready to answer", idempotencyKey: "progress-2" });
      const final = await service.execute(f.session, "comment", { body: "Yes, I am here. /\\_/\\", idempotencyKey: "final" });
      expect(final.status).toBe("processed");
      await service.execute(f.session, "comment", { body: "Yes, I am here. /\\_/\\", idempotencyKey: "final" });
      expect(f.responseWrites.map(write => write.method)).toEqual(["POST", "PATCH", "PATCH", "PATCH"]);
      expect(new Set(f.responseWrites.map(write => write.id)).size).toBe(1);
      expect(f.responseComments.size).toBe(1);
      await expect(githubRunReplyState(db, { ...f.session, endpointId: f.endpoint.id })).resolves.toBe("confirmed");
      expect((await readHeartbeatRunsById(f.run.id))[0].status).toBe("running");
      const authorizationReason = await resolveChatRunPresentationAuthorizationReason(db, f.session);
      expect(authorizationReason).toBe("internal_agent_write");
      await db.update(heartbeatRuns).set({ status: "succeeded", resultJson: { presentationDecision: { authorizationReason } } }).where(eq(heartbeatRuns.id, f.run.id));
      await enqueueChatRunMilestones(db); await f.service.processPendingPublications();
      expect(f.responseComments.size).toBe(1);
      expect(f.runtime.endpoints.get(f.endpoint.id)?.posts).toEqual([]);
    });

    it.each([false, true])("finishes the same GitHub working comment after an authorized same-App reconnect (legacy: %s)", async legacy => {
      const f = await toolReplyFixture();
      const originalId = f.responseWrites[0].id;
      if (legacy) await db.update(chatActions).set({ payload: { runtimeGeneration: (f.endpoint.setup as InternalSetupState).runtimeGeneration ?? 0, agentId: f.assignedAgentId } })
        .where(and(eq(chatActions.endpointId, f.endpoint.id), eq(chatActions.kind, "github_response_comment")));
      await f.service.configure(f.endpoint.id, { action: "reconnect" }, "owner-user");
      const result = await githubChatReviewService(db, f.providerFetch).execute(f.session, "comment", {
        body: "Review complete after reconnect", idempotencyKey: "reconnected-final",
      });
      expect(result.status).toBe("processed");
      expect(f.responseWrites.map(write => write.method)).toEqual(["POST", "PATCH"]);
      expect(f.responseWrites.every(write => write.id === originalId)).toBe(true);
      expect([...f.responseComments.values()][0].body).toContain("Review complete after reconnect");
    });

    it("still fences a GitHub publication when reconnect races the provider read", async () => {
      const f = await toolReplyFixture();
      let reconnected = false;
      f.setSupplementalProviderFetch(async (input, init) => {
        if (!reconnected && String(input).includes("/issues/comments/") && (!init?.method || init.method === "GET")) {
          reconnected = true;
          await f.service.configure(f.endpoint.id, { action: "reconnect" }, "owner-user");
        }
        return undefined;
      });
      const result = await githubChatReviewService(db, f.providerFetch).execute(f.session, "comment", {
        body: "Stale attempt", idempotencyKey: "reconnect-race",
      });
      expect(result.status).toBe("cancelled");
      expect(f.responseWrites).toHaveLength(1);
    });

    it("adds the progress tool to an existing enabled bot without restoring disabled tools", async () => {
      const f = await toolReplyFixture();
      await db.delete(toolCatalogEntries).where(and(eq(toolCatalogEntries.connectionId, f.endpoint.connectionId), eq(toolCatalogEntries.name, "github_bot:update_comment")));
      expect(await githubBotToolsForSession(db, f.session)).toEqual(expect.arrayContaining([
        expect.objectContaining({ upstreamToolName: "update_comment" }),
      ]));
      await db.update(toolCatalogEntries).set({ status: "removed" }).where(and(eq(toolCatalogEntries.connectionId, f.endpoint.connectionId), eq(toolCatalogEntries.name, "github_bot:update_comment")));
      expect((await githubBotToolsForSession(db, f.session)).some(tool => tool.upstreamToolName === "update_comment")).toBe(false);
    });

    it("recovers an acknowledgement whose local receipt was lost without posting another comment", async () => {
      const f = await toolReplyFixture();
      const originalId = f.responseWrites[0].id;
      await db.update(chatActions).set({ result: {}, status: "received" }).where(and(
        eq(chatActions.endpointId, f.endpoint.id), eq(chatActions.kind, "github_response_comment"),
      ));
      await githubResponseCommentService(db, f.providerFetch).processPending();
      const result = await githubChatReviewService(db, f.providerFetch).execute(f.session, "update_comment", {
        body: "Recovered and checking", idempotencyKey: "recovered-progress",
      });
      expect(result.status).toBe("processed");
      expect(f.responseWrites.map(write => write.method)).toEqual(["POST", "PATCH"]);
      expect(f.responseWrites.every(write => write.id === originalId)).toBe(true);
      expect(f.responseComments.size).toBe(1);
    });

    it("rejects arbitrary comment IDs and edits after the initiating person is revoked", async () => {
      const f = await toolReplyFixture();
      const service = githubChatReviewService(db, f.providerFetch);
      await expect(service.execute(f.session, "update_comment", { body: "Checking", idempotencyKey: "progress", commentId: "123" })).rejects.toThrow();
      await db.update(chatIdentityLinks).set({ status: "revoked" }).where(eq(chatIdentityLinks.endpointId, f.endpoint.id));
      await expect(service.execute(f.session, "update_comment", { body: "Checking", idempotencyKey: "progress" })).rejects.toThrow();
      expect(f.responseWrites).toHaveLength(1);
    });

    it("retries an ambiguous GitHub edit without creating another comment", async () => {
      const f = await toolReplyFixture();
      let unavailable = true;
      f.setSupplementalProviderFetch(async (input, init) => {
        if (String(input).includes("/issues/comments/") && init?.method === "PATCH" && unavailable) throw new Error("Response lost");
        return undefined;
      });
      const service = githubChatReviewService(db, f.providerFetch);
      const result = await service.execute(f.session, "comment", { body: "Here is your answer", idempotencyKey: "retry-reply" });
      expect(result.status).toBe("failed");
      await expect(githubRunReplyState(db, { ...f.session, endpointId: f.endpoint.id })).resolves.toBe("unsettled");
      unavailable = false;
      const [action] = await db.select().from(chatActions).where(and(eq(chatActions.endpointId, f.endpoint.id), eq(chatActions.kind, "github_review_publication")));
      await db.update(chatActions).set({ result: { ...action.result, retryAt: new Date(0).toISOString() } }).where(eq(chatActions.id, action.id));
      await service.processPending();
      expect(f.responseWrites.map(write => write.method)).toEqual(["POST", "PATCH"]);
      expect(f.responseComments.size).toBe(1);
      await expect(githubRunReplyState(db, { ...f.session, endpointId: f.endpoint.id })).resolves.toBe("confirmed");
    });

    it.each(["human", "missing_marker"])("does not edit a %s replacement of the bound GitHub comment", async kind => {
      const f = await toolReplyFixture();
      const comment = [...f.responseComments.values()][0];
      if (kind === "human") comment.user.login = "octocat";
      else comment.body = "unrelated comment";
      const result = await githubChatReviewService(db, f.providerFetch).execute(f.session, "update_comment", { body: "Checking", idempotencyKey: "progress" });
      expect(result.status).toBe("cancelled");
      expect(f.responseWrites).toHaveLength(1);
    });

    it("does not let a progress edit overwrite a final GitHub answer", async () => {
      const f = await toolReplyFixture();
      const service = githubChatReviewService(db, f.providerFetch);
      await service.execute(f.session, "comment", { body: "Done", idempotencyKey: "answer" });
      await service.execute(f.session, "update_comment", { body: "Still working", idempotencyKey: "late-progress" });
      expect(f.responseWrites).toHaveLength(2);
      expect([...f.responseComments.values()][0].body).toContain("Done");
    });

    it.each([false, true])("closes an inline-only GitHub review when an earlier working comment was deleted: %s", async deletedSibling => {
      const f = await toolReplyFixture("github:paperclipai/paperclip:418");
      if (deletedSibling) {
        const thread = makeThread({ channelId: "paperclipai/paperclip", id: f.conversation.externalThreadId }).thread;
        await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
          trigger: "mention", message: makeMessage({ id: "41802", text: "Review this too", userId: "42", userName: "octocat", mentioned: true }) });
        await expect.poll(async () => { await githubResponseCommentService(db, f.providerFetch).processPending(); return f.responseWrites.length; }, { timeout: 10_000 }).toBe(2);
        f.responseComments.delete([...f.responseComments.keys()][0]);
        const links = await db.select().from(chatMessageLinks).where(and(eq(chatMessageLinks.endpointId, f.endpoint.id), eq(chatMessageLinks.direction, "inbound")));
        const latest = await chatWakeContext({ endpointId: f.endpoint.id, issueId: f.conversation.issueId, provider: "github", providerMessageId: "41802" });
        await db.update(heartbeatRuns).set({ contextSnapshot: { ...latest, wakeCommentIds: links.map(link => link.commentId) } }).where(eq(heartbeatRuns.id, f.run.id));
      }
      const config = await f.management.configuration(f.endpoint.id, "owner-user");
      await f.management.saveConfiguration(f.endpoint.id, { expectedRevision: config.revision,
        configuration: { ...config.configuration, defaults: { ...config.configuration.defaults, publishSummary: false, publishInline: true } },
      }, "owner-user");
      const head = "b".repeat(40);
      const inlineWrites: unknown[] = [];
      f.setSupplementalProviderFetch(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/pulls/418")) return Response.json({ number: 418, state: "open", draft: false,
          head: { sha: head }, base: { sha: "a".repeat(40), ref: "master" }, user: { id: 42, login: "octocat", type: "User" }, labels: [] });
        if (url.includes("/files?")) return Response.json([{ filename: "src/math.ts", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new" }]);
        if (url.includes("/check-runs?")) return Response.json({ check_runs: [] });
        if (url.includes("/check-runs") && init?.method) return Response.json({ id: 419, html_url: "https://github.com/checks/419" });
        if (url.includes("/pulls/418/comments?")) return Response.json([]);
        if (url.endsWith("/pulls/418/comments") && init?.method === "POST") {
          inlineWrites.push(JSON.parse(String(init.body)));
          return Response.json({ id: 420, html_url: "https://github.com/paperclipai/paperclip/pull/418#discussion_r420" });
        }
        return undefined;
      });
      const service = githubChatReviewService(db, f.providerFetch);
      await service.execute(f.session, "begin_review", { reviewedCommit: head });
      await service.execute(f.session, "submit_review", { reviewedCommit: head, score: 5, complete: true,
        summary: "Disabled summary must not be published", rationale: "Looks good",
        coverage: { reviewedPaths: ["src/math.ts"], omittedPaths: [], limitations: [] },
        findings: [{ key: "note", path: "src/math.ts", line: 1, side: "RIGHT", severity: "error", category: "correctness", body: "Example finding" }],
      }, "inline-only");
      expect(inlineWrites).toHaveLength(1);
      expect(f.responseWrites.map(write => write.method)).toEqual(["POST", "PATCH"]);
      expect(f.responseComments.size).toBe(deletedSibling ? 0 : 1);
      const comment = [...f.responseComments.values()][0];
      if (!deletedSibling) {
        expect(comment.body).toContain("Review complete.");
        expect(comment.body).toContain("https://github.com/paperclipai/paperclip/pull/418");
        expect(comment.body).not.toContain("Disabled summary");
        expect(comment.body).toContain("paperclip-response-state:final");
      }
      await expect(githubRunReplyState(db, { ...f.session, endpointId: f.endpoint.id })).resolves.toBe("confirmed");
    });

    it.each(["during_summary", "after_summary"] as const)("keeps partial review delivery authoritative when the head changes %s", async phase => {
      const f = await toolReplyFixture("github:paperclipai/paperclip:418");
      const original = "b".repeat(40);
      let head = original;
      let summaryDelivered = false;
      f.setSupplementalProviderFetch(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/pulls/418")) return Response.json({ number: 418, state: "open", draft: false,
          head: { sha: head }, base: { sha: "a".repeat(40), ref: "master" }, user: { id: 42, login: "octocat", type: "User" }, labels: [] });
        if (url.includes("/files?")) return Response.json([{ filename: "src/math.ts", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new" }]);
        if (url.includes("/check-runs?")) return Response.json({ check_runs: [] });
        if (url.includes("/check-runs") && init?.method) return Response.json({ id: 419, html_url: "https://github.com/checks/419" });
        if (url.includes("/issues/comments/") && init?.method === "PATCH") {
          const comment = f.responseComments.get(Number(url.split("/").at(-1)))!;
          comment.body = JSON.parse(String(init.body)).body;
          summaryDelivered = true;
          if (phase === "during_summary") head = "c".repeat(40);
          return Response.json(comment);
        }
        if (summaryDelivered && phase === "after_summary" && url.includes("/pulls/418/comments?")) {
          head = "c".repeat(40);
          return Response.json([]);
        }
        return undefined;
      });
      const service = githubChatReviewService(db, f.providerFetch);
      await service.execute(f.session, "begin_review", { reviewedCommit: original });
      await service.execute(f.session, "submit_review", { reviewedCommit: original, score: 5, complete: true,
        summary: "Reviewed", rationale: "Looks good", coverage: { reviewedPaths: ["src/math.ts"], omittedPaths: [], limitations: [] },
        findings: phase === "after_summary" ? [{ key: "note", path: "src/math.ts", line: 1, side: "RIGHT", severity: "error", category: "correctness", body: "Example finding" }] : [],
      }, `head-change-${phase}`);
      expect(summaryDelivered).toBe(true);
      const [publication] = await db.select().from(chatActions).where(and(eq(chatActions.endpointId, f.endpoint.id), eq(chatActions.kind, "github_review_publication")));
      expect(publication.status).toBe("cancelled");
      expect(publication.result?.replyWriteStarted).toBe(true);
      await expect(githubRunReplyState(db, { ...f.session, endpointId: f.endpoint.id })).resolves.toBe(phase === "after_summary" ? "confirmed" : "unsettled");
      if (phase === "after_summary") {
        const [review] = await readChatGitHubReviewsByEndpointId(f.endpoint.id);
        expect(review.publicationReceipts.summary).toMatchObject({ id: String([...f.responseComments.keys()][0]) });
        const writes = f.responseWrites.length;
        const { buildExecutionContinuation } = await import("../../services/execution-continuation.js");
        const continuation = await buildExecutionContinuation({ db, companyId: f.companyId, issueId: f.session.issueId,
          agentId: f.assignedAgentId, context: { previousRunId: f.run.id }, summary: null, exposeLowTrustRaw: false });
        expect(continuation.completedActions).toContainEqual(expect.objectContaining({
          runId: f.run.id, operationId: "github_review_publication", result: expect.objectContaining({
            repository: review.repository, pullNumber: review.pullNumber, headSha: review.headSha,
            part: "summary", publicationId: review.publicationReceipts.summary.id, url: review.publicationReceipts.summary.url,
          }),
        }));
        const { githubRecoveryReceipts } = await import("../../services/chat-channels/github/recovery-receipts.js");
        expect(await githubRecoveryReceipts(db, randomUUID(), f.session.issueId)).toEqual([]);
        expect(await githubRecoveryReceipts(db, f.companyId, randomUUID())).toEqual([]);
        expect(f.responseWrites).toHaveLength(writes);
      }
    });

    it("does not invent a GitHub completion response when the agent sends no tool reply", async () => {
      const f = await toolReplyFixture();
      await db.update(heartbeatRuns).set({ status: "succeeded", nativePhase: "committed", resultJson: { presentationDecision: {
        schema: "paperclip.run_presentation_decision.v1", commentAction: "none", chosenSource: "none",
        reasonCodes: ["no_final_response"], authorizationReason: "internal_agent_write",
      } } }).where(eq(heartbeatRuns.id, f.run.id));
      await expect(resolveChatRunPresentationAuthorizationReason(db, f.session)).resolves.toBe("internal_agent_write");
      await enqueueChatRunMilestones(db); await f.service.processPendingPublications();
      expect(f.runtime.endpoints.get(f.endpoint.id)?.posts).toEqual([]);
      expect(f.responseWrites).toHaveLength(2);
      expect(f.responseWrites[1]).toMatchObject({ method: "PATCH", body: expect.stringContaining("without publishing a final response") });
    });

    it.each(["none", "confirmed", "unsettled", "check_only", "different_run", "different_company", "wrong_agent", "denied", "ambiguous_exhausted", "cancelled_after_ambiguous", "missing_receipt"] as const)(
      "GitHub failure fallback respects exact tool delivery state: %s", async scenario => {
        const f = await toolReplyFixture();
        if (scenario !== "none") {
          await db.insert(chatActions).values({ companyId: f.companyId, endpointId: f.endpoint.id, conversationId: f.conversation.id,
            kind: "github_review_publication", providerActionId: `github_publication:${randomUUID()}`,
            payload: { operation: scenario === "check_only" ? "assessment" : "comment", session: { ...f.session,
              ...(scenario === "different_run" ? { runId: randomUUID() } : {}),
              ...(scenario === "different_company" ? { companyId: randomUUID() } : {}),
              ...(scenario === "wrong_agent" ? { agentId: f.replacementAgentId } : {}),
            } },
            status: scenario === "unsettled" ? "processing" : scenario === "denied" || scenario === "cancelled_after_ambiguous" ? "cancelled" : scenario === "ambiguous_exhausted" ? "failed" : "processed",
            result: scenario === "check_only" || scenario === "missing_receipt" ? {} : scenario === "denied" ? { code: "authorization_changed", attempts: 1 } : scenario === "cancelled_after_ambiguous" ? { code: "authorization_changed", attempts: 2 }
              : scenario === "ambiguous_exhausted" ? { code: "publication_failed", retryable: false, attempts: 8 }
              : { id: "41802", url: "https://github.com/paperclipai/paperclip/issues/418#issuecomment-41802" },
          });
        }
        const unresolved = ["unsettled", "ambiguous_exhausted", "cancelled_after_ambiguous", "missing_receipt"].includes(scenario);
        const expected = scenario === "confirmed" ? "confirmed" : unresolved ? "unsettled" : "none";
        await expect(githubRunReplyState(db, { ...f.session, endpointId: f.endpoint.id })).resolves.toBe(expected);
        await db.update(heartbeatRuns).set({ status: "failed", errorCode: "test_runtime_failed" }).where(eq(heartbeatRuns.id, f.run.id));
        await enqueueChatRunMilestones(db); await f.service.processPendingPublications();
        await enqueueChatRunMilestones(db); await f.service.processPendingPublications();
        const posts = f.runtime.endpoints.get(f.endpoint.id)?.posts ?? [];
        expect(posts).toHaveLength(0);
        expect(f.responseWrites).toHaveLength(expected === "none" ? 2 : 1);
        if (expected === "none") expect(f.responseWrites[1]).toMatchObject({ method: "PATCH", body: expect.stringContaining("stopped before completing this turn") });
        const [fallback] = await db.select().from(chatPublications).where(and(eq(chatPublications.endpointId, f.endpoint.id),
          eq(chatPublications.idempotencyKey, `run:${f.run.id}:failed:${f.endpoint.id}`)));
        expect(fallback.state).toBe(expected === "none" ? "published" : "cancelled");
      },
    );

    it("preserves an earlier final GitHub answer when a later continuation fails", async () => {
      const f = await toolReplyFixture();
      const identity = await initializeRunIdentity(db, { companyId: f.companyId, runId: f.run.id, issueId: f.conversation.issueId!, responsibleUserId: "owner-user", messageIds: [String(f.run.contextSnapshot?.wakeCommentId)], cause: "instruction" });
      await githubChatReviewService(db, f.providerFetch).execute(f.session, "comment", { body: "Earlier final answer", idempotencyKey: randomUUID() });
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.run.id));
      const [later] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.assignedAgentId, status: "failed", nativeIssueId: f.conversation.issueId, contextSnapshot: {} }).returning();
      await initializeRunIdentity(db, { companyId: f.companyId, runId: later.id, issueId: f.conversation.issueId!, responsibleUserId: "owner-user", parentContextId: identity.id, cause: "monitor" });
      const writes = f.responseWrites.length;
      await expect(githubResponseCommentService(db, f.providerFetch).failRun({ companyId: f.companyId, endpointId: f.endpoint.id, issueId: f.conversation.issueId!, runId: later.id, body: "Later run failed" })).rejects.toMatchObject({ status: 403 });
      expect(f.responseWrites).toHaveLength(writes);
      expect([...f.responseComments.values()][0].body).toContain("Earlier final answer");
    });

    it("rechecks a GitHub fallback after waiting for the credential lane", async () => {
      const f = await toolReplyFixture();
      await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, f.run.id));
      await enqueueChatRunMilestones(db);
      const [lease] = await db.insert(chatEndpointLeases).values({ companyId: f.companyId, endpointId: f.endpoint.id,
        leaseKey: "credentials", token: randomUUID(), expiresAt: new Date(Date.now() + 60_000) }).returning();
      const processing = f.service.processPendingPublications();
      await expect.poll(async () => (await readChatPublicationsByEndpointId(f.endpoint.id))[0]?.state).toBe("streaming");
      const [action] = await db.insert(chatActions).values({ companyId: f.companyId, endpointId: f.endpoint.id, conversationId: f.conversation.id,
        kind: "github_review_publication", providerActionId: `github_publication:${randomUUID()}`,
        payload: { operation: "comment", session: f.session }, status: "processing" }).returning();
      await db.delete(chatEndpointLeases).where(eq(chatEndpointLeases.id, lease.id));
      await processing;
      expect(f.runtime.endpoints.get(f.endpoint.id)?.posts).toEqual([]);
      const [fallback] = await readChatPublicationsByEndpointId(f.endpoint.id);
      expect(fallback).toMatchObject({ state: "cancelled", attempts: 1 });
      await db.update(chatActions).set({ status: "processed", result: { id: "41802", url: "https://github.com/test/41802" } }).where(eq(chatActions.id, action.id));
      await db.update(chatPublications).set({ nextAttemptAt: null }).where(eq(chatPublications.id, fallback.id));
      await f.service.processPendingPublications();
      expect(f.runtime.endpoints.get(f.endpoint.id)?.posts).toEqual([]);
      expect((await readChatPublicationsById(fallback.id))[0].state).toBe("cancelled");
    });

    it.each(["personal", "organization"] as const)(
      "wizard persists a %s owner and resumes the same bound registration after a lost Cloud response and enrolled origin change",
      async (ownerType) => {
        const f = await seedCompany();
        const { service } = createService();
        const bot = await service.create(
          f.companyId,
          { provider: "github", assignedAgentId: f.assignedAgentId },
          "owner-user",
        );
        let cloudRecord: Record<string, unknown> | undefined,
          loseResponse = true;
        let browserOrigin = "http://127.0.0.1:3104";
        const githubApp = vi.fn(
          async ({ binding }: { binding: Record<string, unknown> }) => {
            if (!cloudRecord) cloudRecord = binding;
            expect({ ...binding, returnUri: cloudRecord.returnUri }).toEqual(cloudRecord);
            if (loseResponse) {
              loseResponse = false;
              throw new Error("Response lost");
            }
            return {
              id: binding.id,
              returnOrigin: browserOrigin,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              webhookUrl: "https://gateway.example.test/webhook",
              callbackUrls: {
                manifest: "https://gateway.example.test/manifest",
                install: "https://gateway.example.test/install",
                oauth: "https://gateway.example.test/oauth",
              },
            };
          },
        );
        const wizard = githubChatWizardService(db, {
          origin: () => browserOrigin,
          connector: () =>
            ({
              githubAppsAvailable: async () => true,
              githubApp,
            }) as unknown as PaperclipCloudConnector,
          startDirect: service.startGitHubRegistration,
          storeApp: wizardStoreApp(service),
          storeCredentials: async () => {},
          refreshRepositories: service.refreshGitHubRepositories,
          resources: service.listResources,
          replaceResources: service.replaceResources,
          configure: async () => {},
          finish: async () => {},
        });
        const input = {
          name: "My Reviewer",
          ownerType,
          ...(ownerType === "organization" ? { ownerLogin: "acme" } : {}),
        };
        await expect(wizard.start(bot.id, "owner-user", input)).rejects.toThrow(
          "Response lost",
        );
        browserOrigin = "http://localhost:3104";
        const resumed = await wizard.start(bot.id, "owner-user", input);
        expect(resumed.state).toBe("create");
        const sessions = await readChatGitHubRegistrationsByEndpointId(bot.id);
        expect(sessions).toHaveLength(1);
        expect(sessions[0].ownerType).toBe(ownerType);
        expect(cloudRecord).toMatchObject({
          returnUri: "http://127.0.0.1:3104/api/chat-github/cloud/callback",
        });
        expect(githubApp).toHaveBeenLastCalledWith(expect.objectContaining({
          binding: expect.objectContaining({
            id: cloudRecord!.id,
            returnState: cloudRecord!.returnState,
            returnUri: "http://localhost:3104/api/chat-github/cloud/callback",
          }),
        }));
        expect(cloudRecord).not.toHaveProperty("ownerType");
        expect(cloudRecord).not.toHaveProperty("agentId");
        expect(resumed.registration?.manifest).toMatchObject({
          name: "My Reviewer",
          public: false,
        });
        expect(resumed.registration?.registrationUrl).toContain(
          ownerType === "organization"
            ? "/organizations/acme/settings/apps/new"
            : "/settings/apps/new",
        );
        await expect(
          wizard.saveDraft(bot.id, "owner-user", {
            ...input,
            name: "Different App",
          }),
        ).rejects.toThrow("existing App");
        await expect(wizard.advance(bot.id, "unrelated-user")).rejects.toThrow(
          "active company manager",
        );
        const current = await service.get(bot.id);
        expect(current.id).toBe(bot.id);
        expect(current.assignedAgentId).toBe(f.assignedAgentId);
      },
    );

    it.each(["expired", "live", "claimed", "consumed", "exchanging", "failed", "wrong-manager", "wrong-registration"] as const)(
      "wizard restarts only an expired unconsumed registration: %s", async (scenario) => {
        const f = await seedCompany(), { service } = createService();
        const bot = await service.create(f.companyId, { provider: "github", assignedAgentId: f.assignedAgentId }, "owner-user");
        const [prior] = await db.insert(chatGitHubRegistrations).values({
          companyId: f.companyId, endpointId: bot.id,
          userId: scenario === "wrong-manager" ? "another-manager" : "owner-user",
          stateHash: createHash("sha256").update(randomUUID()).digest("hex"), trustedOrigin: "http://127.0.0.1:3104",
          ownerType: "organization", ownerLogin: "acme", appName: "My Reviewer",
          status: scenario === "exchanging" || scenario === "failed" ? scenario : "pending",
          expiresAt: new Date(Date.now() + (scenario === "live" ? 60000 : -60000)),
          consumedAt: scenario === "consumed" ? new Date() : undefined,
          handoff: { cloudId: "expired-route", returnState: "expired-state", redemptionId: "old-receipt",
            ...(scenario === "claimed" ? { manifestClaimId: "received-claim" } : {}) },
        }).returning();
        const githubApp = vi.fn(async ({ binding }: { binding: { id: string } }) => ({
          id: binding.id, returnOrigin: "http://127.0.0.1:3104", expiresAt: new Date(Date.now() + 60000).toISOString(),
          webhookUrl: "https://gateway.example.test/webhook",
          callbackUrls: { manifest: "https://gateway.example.test/manifest", install: "https://gateway.example.test/install", oauth: "https://gateway.example.test/oauth" },
        }));
        const wizard = githubChatWizardService(db, {
          origin: () => "http://127.0.0.1:3104", connector: () => ({ githubApp }) as unknown as PaperclipCloudConnector,
          startDirect: service.startGitHubRegistration, storeApp: wizardStoreApp(service), storeCredentials: async () => {},
          refreshRepositories: service.refreshGitHubRepositories, resources: service.listResources, replaceResources: service.replaceResources,
          configure: async () => {}, finish: async () => {},
        });
        if (scenario !== "expired") {
          await expect(wizard.restartRegistration(bot.id, "owner-user", scenario === "wrong-registration" ? randomUUID() : prior.id))
            .rejects.toThrow("cannot be restarted");
          expect(githubApp).not.toHaveBeenCalled();
          expect(await readChatGitHubRegistrationsByEndpointId(bot.id)).toHaveLength(1);
          return;
        }
        expect(await wizard.advance(bot.id, "owner-user")).toMatchObject({ state: "recovery", restartableRegistrationId: prior.id });
        githubApp.mockRejectedValueOnce(new Error("Temporary Cloud outage"));
        await expect(wizard.restartRegistration(bot.id, "owner-user", prior.id)).rejects.toThrow("Temporary Cloud outage");
        const result = await wizard.restartRegistration(bot.id, "owner-user", prior.id);
        expect(result).toMatchObject({ endpointId: bot.id, state: "create", registration: { manifest: { name: "My Reviewer", public: false } } });
        expect(result.registration!.registrationUrl).toContain("/organizations/acme/settings/apps/new");
        const sessions = await readChatGitHubRegistrationsByEndpointId(bot.id);
        expect(sessions).toHaveLength(2);
        expect(sessions.find(s => s.id === prior.id)).toMatchObject({ status: "failed", consumedAt: expect.any(Date) });
        const next = sessions.find(s => s.id !== prior.id)!;
        expect(next).toMatchObject({ status: "pending", ownerType: "organization", ownerLogin: "acme", appName: "My Reviewer" });
        expect(next.stateHash).not.toBe(prior.stateHash);
        expect(next.handoff!.cloudId).not.toBe(prior.handoff!.cloudId);
        const unchanged = await service.get(bot.id);
        expect(unchanged.connectionId).toBe(bot.connectionId);
        expect(unchanged.assignedAgentId).toBe(bot.assignedAgentId);
        expect((await wizard.restartRegistration(bot.id, "owner-user", prior.id)).registration).toEqual(result.registration);
        expect(await readChatGitHubRegistrationsByEndpointId(bot.id)).toHaveLength(2);
      },
    );

    it("stack exchanges a callback code only once when vault storage is interrupted", async () => {
      const f = await seedCompany(),
        { service } = createService();
      const bot = await service.create(
        f.companyId,
        { provider: "github", assignedAgentId: f.assignedAgentId },
        "owner-user",
      );
      await db
        .insert(chatGitHubRegistrations)
        .values({
          companyId: f.companyId,
          endpointId: bot.id,
          userId: "owner-user",
          stateHash: createHash("sha256").update("bound").digest("hex"),
          trustedOrigin: "http://127.0.0.1:3104",
          ownerType: "personal",
          status: "pending",
          expiresAt: new Date(Date.now() + 60000),
          handoff: {
            cloudId: "claim-recovery",
            returnState: "bound",
            redemptionId: "same-receipt",
            manifestClaimId: "same-claim",
          },
        });
      const claimGitHubApp = vi.fn(async () => ({
        kind: "gateway_callback",
        callbackKind: "manifest",
        state: "bound",
        code: "code",
        registrationId: "claim-recovery",
      }));
      const exchange = vi.fn(async (url: string | URL | Request) => {
        expect(String(url)).toBe(
          "https://api.github.com/app-manifests/code/conversions",
        );
        return Response.json({
          id: 1234,
          pem: "test-key",
          webhook_secret: "test-webhook-secret",
          client_id: "test-client",
          client_secret: "test-client-secret",
          slug: "my-agent",
          owner: { type: "User", login: "octocat" },
        });
      });
      const storeApp = vi.fn(async () => {
        await db
          .update(chatEndpoints)
          .set({ botExternalId: "1234" })
          .where(eq(chatEndpoints.id, bot.id));
        throw new Error("Vault storage interrupted");
      });
      const createWizard = () =>
        githubChatWizardService(db, {
          origin: () => "http://127.0.0.1:3104",
          fetch: exchange as typeof fetch,
          connector: () =>
            ({
              githubApp: async () => ({ id: "claim-recovery" }),
              claimGitHubApp,
            }) as unknown as PaperclipCloudConnector,
          startDirect: service.startGitHubRegistration,
          storeApp,
          storeCredentials: async () => {},
          refreshRepositories: service.refreshGitHubRepositories,
          resources: service.listResources,
          replaceResources: service.replaceResources,
          configure: async () => {},
          finish: async () => {},
        });
      await expect(
        createWizard().advance(bot.id, "owner-user"),
      ).rejects.toThrow("Vault storage interrupted");
      expect(await createWizard().advance(bot.id, "owner-user")).toMatchObject({
        state: "recovery",
      });
      expect(exchange).toHaveBeenCalledTimes(1);
      expect(storeApp).toHaveBeenCalledTimes(1);
      expect(claimGitHubApp).toHaveBeenCalledTimes(1);
      const [session] = await readChatGitHubRegistrationsByEndpointId(bot.id);
      expect(session.status).toBe("failed");
    });

    it("wizard retains partial manifest recovery until explicit existing-App recovery succeeds", async () => {
      const f = await reviewBotFixture();
      const returnState = randomUUID();
      const [connection] = await readToolConnectionsById(f.endpoint.connectionId);
      expect(connection.credentialSecretRefs.map((ref) => ref.configPath)).toEqual(
        expect.arrayContaining([
          "credentials.appId",
          "credentials.privateKey",
          "credentials.webhookSecret",
        ]),
      );
      await db
        .update(toolConnections)
        .set({
          credentialSecretRefs: connection.credentialSecretRefs.filter(
            (ref) => ref.configPath !== "credentials.clientSecret",
          ),
        })
        .where(eq(toolConnections.id, connection.id));
      await db
        .update(chatEndpoints)
        .set({ status: "attention" })
        .where(eq(chatEndpoints.id, f.endpoint.id));
      await db
        .insert(chatGitHubRegistrations)
        .values({
          companyId: f.companyId,
          endpointId: f.endpoint.id,
          userId: "owner-user",
          stateHash: createHash("sha256").update(returnState).digest("hex"),
          trustedOrigin: "http://127.0.0.1:3104",
          status: "failed",
          expiresAt: new Date(Date.now() + 60000),
          handoff: {
            cloudId: "partial-oauth",
            returnState,
            redemptionId: "receipt",
            manifestClaimId: "claim",
          },
        });
      const claimGitHubApp = vi.fn();
      const finish = vi.fn();
      const wizard = githubChatWizardService(db, {
        origin: () => "http://127.0.0.1:3104",
        fetch: f.providerFetch,
        connector: () =>
          ({
            githubApp: async () => ({
              id: "partial-oauth",
              webhookUrl: "https://gateway.example.test/github-apps/partial-oauth/webhook",
            }),
            claimGitHubApp,
          }) as unknown as PaperclipCloudConnector,
        startDirect: f.service.startGitHubRegistration,
        storeApp: wizardStoreApp(f.service),
        storeCredentials: async () => {},
        refreshRepositories: f.service.refreshGitHubRepositories,
        resources: f.service.listResources,
        replaceResources: f.service.replaceResources,
        configure: async () => {},
        finish,
      });
      expect(await wizard.advance(f.endpoint.id, "owner-user")).toMatchObject({
        state: "recovery",
      });
      expect(claimGitHubApp).not.toHaveBeenCalled();
      expect(finish).not.toHaveBeenCalled();
      const [session] = await readChatGitHubRegistrationsByEndpointId(f.endpoint.id);
      expect(session.status).toBe("failed");
      const resourcesBefore = await f.service.listResources(f.endpoint.id);
      await f.service.storeGitHubApp(f.endpoint.id, "owner-user", {
        appId: f.endpoint.botExternalId!,
        privateKey: f.privateKey,
        webhookSecret: f.webhookSecret,
      });
      const [recovered] = await db.select().from(chatGitHubRegistrations)
        .where(eq(chatGitHubRegistrations.id, session.id));
      expect(recovered.handoff).toMatchObject({ cloudId: "partial-oauth", returnState });
      expect(recovered.handoff?.manifestClaimId).toBeUndefined();
      expect(recovered.status).toBe("failed");
      expect(await wizard.advance(f.endpoint.id, "owner-user")).toMatchObject({ state: "verify" });
      expect(claimGitHubApp).not.toHaveBeenCalled();
      expect(f.webhookSyncRequests).toEqual([
        expect.objectContaining({
          url: "https://gateway.example.test/github-apps/partial-oauth/webhook",
          secret: f.webhookSecret,
        }),
      ]);
      expect((await f.service.listResources(f.endpoint.id)).map(({ id, enabled }) => ({ id, enabled })))
        .toEqual(resourcesBefore.map(({ id, enabled }) => ({ id, enabled })));
      expect((await f.service.get(f.endpoint.id)).botExternalId).toBe(f.endpoint.botExternalId);
      expect(finish).not.toHaveBeenCalled();
    });

    it("wizard recovers a renamed enrolled origin only after checking bound state and Cloud authority", async () => {
      const f = await seedCompany();
      const { service } = createService();
      const bot = await service.create(
        f.companyId,
        { provider: "github", assignedAgentId: f.assignedAgentId },
        "owner-user",
      );
      await db.insert(chatGitHubRegistrations).values({
        companyId: f.companyId,
        endpointId: bot.id,
        userId: "owner-user",
        stateHash: createHash("sha256").update("bound-state").digest("hex"),
        trustedOrigin: "https://old.example.test",
        status: "pending",
        expiresAt: new Date(Date.now() + 60_000),
        handoff: {
          cloudId: "origin-recovery",
          returnState: "bound-state",
          redemptionId: "same-receipt",
        },
      });
      let enrolledOrigin = "https://wrong.example.test";
      const githubApp = vi.fn(async () => ({
        id: "origin-recovery",
        returnOrigin: enrolledOrigin,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        webhookUrl: "https://gateway.example.test/webhook",
        callbackUrls: {
          manifest: "https://gateway.example.test/manifest",
          install: "https://gateway.example.test/install",
          oauth: "https://gateway.example.test/oauth",
        },
      }));
      const claimGitHubApp = vi.fn(async () => ({
        kind: "gateway_callback",
        registrationId: "origin-recovery",
        callbackKind: "manifest",
        state: "bound-state",
      }));
      const wizard = githubChatWizardService(db, {
        origin: () => "https://new.example.test",
        connector: () =>
          ({ githubApp, claimGitHubApp }) as unknown as PaperclipCloudConnector,
        startDirect: service.startGitHubRegistration,
        storeApp: wizardStoreApp(service),
        storeCredentials: async () => {},
        refreshRepositories: service.refreshGitHubRepositories,
        resources: service.listResources,
        replaceResources: service.replaceResources,
        configure: async () => {},
        finish: async () => {},
      });
      await expect(
        wizard.cloudCallback("unbound-state", "origin-recovery", "claim"),
      ).rejects.toThrow("did not match");
      expect(githubApp).not.toHaveBeenCalled();
      await expect(
        wizard.cloudCallback("bound-state", "origin-recovery", "claim"),
      ).rejects.toThrow("did not match");
      enrolledOrigin = "https://new.example.test";
      claimGitHubApp.mockImplementation(async () => ({
        kind: "gateway_callback",
        registrationId: "origin-recovery",
        callbackKind: "install",
        state: "bound-state",
      }));
      expect(
        await wizard.cloudCallback("bound-state", "origin-recovery", "claim"),
      ).toContain("https://new.example.test/");
      const [session] = await readChatGitHubRegistrationsByEndpointId(bot.id);
      expect(session!.trustedOrigin).toBe(enrolledOrigin);
      expect(session!.handoff?.cloudId).toBe("origin-recovery");
    });

    it("wizard keeps localhost draft choices while waiting for Cloud enrollment", async () => {
      const f = await seedCompany();
      const { service } = createService();
      const bot = await service.create(
        f.companyId,
        { provider: "github", assignedAgentId: f.assignedAgentId },
        "owner-user",
      );
      const wizard = githubChatWizardService(db, {
        origin: () => "http://127.0.0.1:3104",
        connector: () => null,
        startDirect: service.startGitHubRegistration,
        storeApp: wizardStoreApp(service),
        storeCredentials: async () => {},
        refreshRepositories: service.refreshGitHubRepositories,
        resources: service.listResources,
        replaceResources: service.replaceResources,
        configure: async () => {},
        finish: async () => {},
      });
      expect(
        (
          await wizard.start(bot.id, "owner-user", {
            name: "My Reviewer",
            ownerType: "organization",
            ownerLogin: "acme",
          })
        ).state,
      ).toBe("enrollment");
      expect((await service.get(bot.id)).setup.github).toMatchObject({
        ownerType: "organization",
        ownerLogin: "acme",
        appName: "My Reviewer",
      });
      expect(
        await readChatGitHubRegistrationsByEndpointId(bot.id),
      ).toHaveLength(0);
    });

    it("wizard repairs Cloud after manual credential recovery and secret rotation without changing App identity", async () => {
      const f = await seedCompany();
      const context = await configuredGitHubEndpoint(f, {}, true);
      const bot = await context.service.get(context.endpoint.id),
        cloudId = "registration-repair";
      await db.insert(chatGitHubRegistrations).values({
        companyId: f.companyId,
        endpointId: bot.id,
        userId: "owner-user",
        stateHash: randomUUID(),
        trustedOrigin: "https://reviews.example.test",
        ownerType: "organization",
        ownerLogin: "paperclipai",
        appName: "Reviewer",
        status: "failed",
        expiresAt: new Date(),
        handoff: { cloudId, returnState: "bound", redemptionId: "receipt" },
      });
      const webhookUrl = `https://cloud.example.test/v1/connector/webhooks/github/apps/${cloudId}`;
      let repaired = false;
      const githubApp = vi.fn(
        async ({ binding }: { binding: Record<string, unknown> }) => {
          if (binding.action === "repair") {
            expect(binding.appToken).toBeTypeOf("string");
            expect(binding.webhookSecret).toBeTypeOf("string");
            repaired = true;
          }
          return {
            id: cloudId,
            status: repaired ? "credentials" : "failed",
            expiresAt: new Date().toISOString(),
            appId: bot.botExternalId,
            webhookUrl,
          };
        },
      );
      const providerFetch = vi.fn(
        async (
          input: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1],
        ) => {
          if (
            String(input) === "https://api.github.com/app/hook/config" &&
            init?.method === "PATCH"
          ) {
            const body = JSON.parse(String(init.body));
            expect(body.url).toBe(webhookUrl);
            return Response.json({
              url: webhookUrl,
              content_type: "json",
              insecure_ssl: "0",
            });
          }
          return context.providerFetch(input, init);
        },
      );
      const wizard = githubChatWizardService(db, {
        origin: () => "https://reviews.example.test",
        fetch: providerFetch,
        connector: () => ({ githubApp }) as unknown as PaperclipCloudConnector,
        startDirect: context.service.startGitHubRegistration,
        storeApp: wizardStoreApp(context.service),
        storeCredentials: async () => {},
        refreshRepositories: context.service.refreshGitHubRepositories,
        resources: context.service.listResources,
        replaceResources: context.service.replaceResources,
        configure: async () => {},
        finish: async () => {},
      });
      await expect(
        wizard.repairCloud(bot.id, "unrelated-user"),
      ).rejects.toThrow("active company manager");
      const before = await context.service.listResources(bot.id);
      await wizard.repairCloud(bot.id, "owner-user");
      const current = await context.service.get(bot.id);
      expect(current.botExternalId).toBe(bot.botExternalId);
      expect(current.assignedAgentId).toBe(bot.assignedAgentId);
      expect(current.setup.github?.cloudRegistrationId).toBe(cloudId);
      expect(current.setup.webhookVerifiedAt).toBeNull();
      expect(await context.service.listResources(bot.id)).toEqual(before);
      const [session] = await readChatGitHubRegistrationsByEndpointId(bot.id);
      expect(session.status).toBe("completed");
      expect(session.handoff?.webhookSecretHash).toMatch(/^[a-f0-9]{64}$/);
      await context.service.generateSetupSecret(bot.id, "owner-user");
      await wizard.repairCloud(bot.id, "owner-user");
      expect(githubApp).toHaveBeenCalledTimes(2);
      for (const [request] of githubApp.mock.calls) {
        expect(request.binding).not.toHaveProperty("webhookSecret");
        expect(request.binding).not.toHaveProperty("appToken");
      }
      const repairs = providerFetch.mock.calls.filter(
        ([url, init]) =>
          String(url) === "https://api.github.com/app/hook/config" &&
          init?.method === "PATCH",
      );
      expect(repairs).toHaveLength(2);
      expect(JSON.parse(String(repairs[0][1]?.body)).secret).not.toBe(
        JSON.parse(String(repairs[1][1]?.body)).secret,
      );
      expect((await context.service.get(bot.id)).status).toBe("attention");
    });

    it("wizard preserves explicit review behavior and repository restrictions on existing drafts", async () => {
      const f = await reviewBotFixture();
      f.setSupplementalProviderFetch(async (input) =>
        String(input) === "https://api.github.com/app/installations/2468"
          ? Response.json({
              id: 2468,
              app_id: Number(f.endpoint.botExternalId),
              account: { login: "paperclipai" },
              permissions: {
                contents: "read",
                issues: "write",
                metadata: "read",
                pull_requests: "write",
                checks: "write",
              },
            })
          : undefined,
      );
      const before = await f.management.configuration(f.endpoint.id, "owner-user");
      const resources = await f.service.listResources(f.endpoint.id);
      await db
        .update(chatEndpoints)
        .set({
          setup: {
            ...f.endpoint.setup,
            github: { stage: "repositories" },
            webhookVerifiedAt: new Date().toISOString(),
          },
        })
        .where(eq(chatEndpoints.id, f.endpoint.id));
      const progress = await f.service.githubWizard.advance(
        f.endpoint.id,
        "owner-user",
      );
      expect(progress.identityLinked).toBe(true);
      expect(await f.management.configuration(f.endpoint.id, "owner-user")).toEqual(
        before,
      );
      expect(await f.service.listResources(f.endpoint.id)).toEqual(resources);
    });

    it.each(["draft", "verifying"] as const)(
      "wizard resumes a %s installation callback after its signed ping",
      async (status) => {
        const f = await reviewBotFixture();
        const permissions = {
          contents: "read",
          issues: "write",
          metadata: "read",
          pull_requests: "write",
          checks: "write",
        };
        f.setAppAccess({
          permissions,
          events: ["pull_request", "issue_comment", "pull_request_review_comment"],
        });
        f.setInstallationAccess(permissions);
        f.setSupplementalProviderFetch(async (input) =>
          String(input) === "https://api.github.com/app/installations/2468"
            ? Response.json({
                id: 2468,
                app_id: Number(f.endpoint.botExternalId),
                account: { login: "paperclipai" },
                permissions,
              })
            : undefined,
        );
        const returnState = randomUUID();
        const cloudId = `late-ping-${randomUUID()}`;
        await db
          .update(chatEndpoints)
          .set({
            status,
            setup: {
              ...f.endpoint.setup,
              step: "provider_setup",
              webhookVerifiedAt: null,
              github: {
                ...f.endpoint.setup.github,
                stage: "repositories",
                initialRepositoriesImported: true,
              },
            },
          })
          .where(eq(chatEndpoints.id, f.endpoint.id));
        await db.insert(chatGitHubRegistrations).values({
          companyId: f.companyId,
          endpointId: f.endpoint.id,
          userId: "owner-user",
          stateHash: createHash("sha256").update(returnState).digest("hex"),
          trustedOrigin: "http://localhost:3104",
          status: "completed",
          expiresAt: new Date(Date.now() + 60_000),
          handoff: {
            cloudId: cloudId,
            returnState,
            redemptionId: "receipt",
            webhookSecretHash: createHash("sha256")
              .update(f.webhookSecret)
              .digest("hex"),
          },
        });
        const configure = vi.fn((id: string, userId: string) =>
          f.service.configure(id, { action: "configure" }, userId),
        );
        const finish = vi.fn((id: string, userId: string) =>
          f.service.test(id, { optionalSlackTestForUser: userId }),
        );
        const wizard = githubChatWizardService(db, {
          origin: () => "http://localhost:3104",
          fetch: f.providerFetch,
          connector: () =>
            ({
              githubApp: async () => ({ id: cloudId }),
              claimGitHubApp: async () => ({
                kind: "gateway_callback",
                callbackKind: "install",
                registrationId: cloudId,
              }),
            }) as unknown as PaperclipCloudConnector,
          startDirect: f.service.startGitHubRegistration,
          storeApp: wizardStoreApp(f.service),
          storeCredentials: async () => {},
          refreshRepositories: f.service.refreshGitHubRepositories,
          resources: f.service.listResources,
          replaceResources: f.service.replaceResources,
          configure,
          finish,
        });
        const before = await f.management.configuration(
          f.endpoint.id,
          "owner-user",
        );
        expect(await wizard.cloudCallback("", cloudId, "installation-claim")).toBe(
          `http://localhost:3104/${(await db.select().from(companies).where(eq(companies.id, f.companyId)))[0].issuePrefix}/apps/chat/connect?provider=github&purpose=chat&resume=${f.endpoint.id}`,
        );
        expect(await wizard.advance(f.endpoint.id, "owner-user")).toMatchObject({
          state: "verify",
          verification: { ready: false, checks: [{ key: "webhook", ok: false }] },
        });
        expect(configure).not.toHaveBeenCalled();
        expect(finish).not.toHaveBeenCalled();
        expect(
          await f.management.configuration(f.endpoint.id, "owner-user"),
        ).toEqual(before);
        expect((await f.service.get(f.endpoint.id)).botExternalId).toBe(
          f.endpoint.botExternalId,
        );
        const unsigned = await f.service.handleWebhook(
          f.endpoint.publicId,
          "github",
          new Request("https://gateway.example.test/webhook", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-github-event": "ping",
            },
            body: "{}",
          }),
        );
        expect(unsigned.status).toBe(401);
        expect((await wizard.advance(f.endpoint.id, "owner-user")).state).toBe(
          "verify",
        );
        expect(configure).not.toHaveBeenCalled();
        await recordGitHubWebhookVerification(
          f.service,
          f.endpoint.publicId,
          f.webhookSecret,
        );
        expect((await wizard.advance(f.endpoint.id, "owner-user")).state).toBe(
          "connected",
        );
        expect(configure).toHaveBeenCalledExactlyOnceWith(
          f.endpoint.id,
          "owner-user",
        );
        expect(finish).toHaveBeenCalledExactlyOnceWith(f.endpoint.id, "owner-user");
        expect((await f.service.get(f.endpoint.id)).status).toBe("active");
        expect((await f.service.get(f.endpoint.id)).botExternalId).toBe(
          f.endpoint.botExternalId,
        );
        expect(
          (await f.service.get(f.endpoint.id)).setup.webhookVerifiedAt,
        ).toEqual(expect.any(String));
        expect(f.wakeup).not.toHaveBeenCalled();
      },
    );

    it("wizard completes a verified connection automatically without claiming runtime execution", async () => {
      const f = await reviewBotFixture();
      const permissions = {
        contents: "read",
        issues: "write",
        metadata: "read",
        pull_requests: "write",
        checks: "write",
      };
      f.setAppAccess({
        permissions,
        events: ["pull_request", "issue_comment", "pull_request_review_comment"],
      });
      f.setInstallationAccess(permissions);
      f.setSupplementalProviderFetch(async (input) =>
        String(input) === "https://api.github.com/app/installations/2468"
          ? Response.json({
              id: 2468,
              app_id: Number(f.endpoint.botExternalId),
              account: { login: "paperclipai" },
              permissions,
            })
          : undefined,
      );
      await db
        .update(agents)
        .set({ adapterType: "process" })
        .where(eq(agents.id, f.assignedAgentId));
      const progress = await f.service.githubWizard.advance(
        f.endpoint.id,
        "owner-user",
      );
      expect(progress.state).toBe("connected");
      expect(progress.verification?.ready).toBe(true);
      expect(
        progress.runtimeChecks?.find((check) => check.key === "runtime")?.ok,
      ).toBe(false);
      expect((await f.service.get(f.endpoint.id)).status).toBe("active");
      expect(f.wakeup).not.toHaveBeenCalled();
      expect(
        (await f.service.githubWizard.advance(f.endpoint.id, "owner-user")).state,
      ).toBe("connected");
    });

    it("wizard preserves an explicit empty repository selection at revision zero", async () => {
      const f = await seedCompany();
      const context = await configuredGitHubEndpoint(f, {}, true);
      const resources = await context.service.listResources(context.endpoint.id);
      await context.service.replaceResources(
        context.endpoint.id,
        resources.map((resource) => ({ id: resource.id, enabled: false })),
        "owner-user",
      );
      await db
        .insert(chatGitHubRegistrations)
        .values({
          companyId: f.companyId,
          endpointId: context.endpoint.id,
          userId: "owner-user",
          stateHash: randomUUID(),
          trustedOrigin: "https://reviews.example.test",
          ownerType: "organization",
          ownerLogin: "paperclipai",
          status: "completed",
          expiresAt: new Date(Date.now() + 60_000),
        });
      await context.service.githubWizard.advance(context.endpoint.id, "owner-user");
      expect(
        (await context.service.listResources(context.endpoint.id)).map(
          (resource) => resource.enabled,
        ),
      ).toEqual([false]);
      // The import fence also protects a stale caller that already planned an import.
      await context.service.replaceResources(
        context.endpoint.id,
        resources.map((resource) => ({ id: resource.id, enabled: true })),
        "owner-user",
        { initialGitHubImport: true },
      );
      expect(
        (await context.service.listResources(context.endpoint.id)).map(
          (resource) => resource.enabled,
        ),
      ).toEqual([false]);
    });

    it("wizard configures Cloud webhook delivery without a public instance URL", async () => {
      const f = await seedCompany();
      const context = await configuredGitHubEndpoint(f, {}, true);
      const current = await context.service.get(context.endpoint.id);
      await db
        .update(chatEndpoints)
        .set({
          status: "draft",
          setup: {
            ...current.setup,
            github: {
              ...current.setup.github!,
              cloudRegistrationId: "cloud-localhost",
            },
          },
        })
        .where(eq(chatEndpoints.id, current.id));
      const local = createService(new FakeChatSdkRuntime(), context.providerFetch, {
        publicBaseUrl: null,
        webhookPublicBaseUrl: null,
      });
      expect(
        (
          await local.service.configure(
            current.id,
            { action: "configure" },
            "owner-user",
          )
        ).status,
      ).not.toBe("error");
      const direct = await local.service.create(
        f.companyId,
        { provider: "github", assignedAgentId: f.assignedAgentId },
        "owner-user",
      );
      await expect(
        local.service.configure(direct.id, { action: "configure" }, "owner-user"),
      ).rejects.toThrow("public");
    });
});
