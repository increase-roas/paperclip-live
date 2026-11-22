import { idleWorkSnapshot } from "../../services/task-admission.js";
import { dueChatAction, registerChatActionWork } from "../../services/chat-action-work.js";
import { chatRunMilestoneWork } from "../../services/chat-run-milestone-work.js";
import { createDeliveryWorkCoordinator } from "../../services/delivery-work-coordinator.js";
import { registerChatDeliveryWork } from "../../services/chat-delivery-work.js";
import { CHAT_ACTION_QUEUES, notifyChatActionWork, notifyChatPublicationWork } from "../../services/chat-work-notifications.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "../../services/delivery-work-notifications.js";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, like, sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agentWakeupRequests, chatActions, chatConversations, chatDeliveries, chatEndpointLeases, chatEndpointResources, chatEndpoints, chatMessageLinks, chatPublications, heartbeatRuns, issueComments, issueThreadInteractions } from "@paperclipai/db";
import { issueService } from "../../services/issues.js";
import { issueThreadInteractionService } from "../../services/issue-thread-interactions.js";
import { enqueueChatRunLifecycleMilestones, enqueueChatRunMilestones } from "../../services/chat-run-publications.js";
import { FakeChatSdkRuntime, fakeSlackFetch, makeMessage, makeThread } from ".././helpers/chat-channels-fixture.js";
import {
configuredSlackEndpoint,
configuredTelegramEndpoint,
createService,
db,
deliverMessage,
describeChatChannelsSuite,
qualifySetupRoundTrip,
readChatActionsById,
readChatConversationsByEndpointId,
readChatPublicationsById,
seedCompany
} from "../helpers/chat-channels-harness.js";
import {
publicationLaneFixture
} from "../helpers/chat-channels-endpoint-fixtures.js";







describeChatChannelsSuite("chat channels 20-edits-a-slack-working-reply-into-one-ter", () => {
  it("edits a Slack working reply into one terminal failure reply", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture);
    const thread = makeThread({
      channelId: "C-FAILED-RUN",
      id: "slack:C-FAILED-RUN:4060.1",
      name: "failed-run",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: thread.thread,
      message: makeMessage({
        id: "4060.1",
        text: "@maya exercise a failed turn",
        mentioned: true,
      }),
      trigger: "mention",
    });
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: fixture.companyId,
      agentId: fixture.assignedAgentId,
      status: "running",
      contextSnapshot: { issueId: conversation.issueId },
    });
    for (const milestone of ["working", "failed"] as const) {
      if (milestone === "failed") {
        await db
          .update(heartbeatRuns)
          .set({ status: "failed", updatedAt: new Date() })
          .where(eq(heartbeatRuns.id, runId));
      }
      await db.insert(chatPublications).values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: conversation.id,
        issueId: conversation.issueId,
        idempotencyKey: `run:${runId}:${milestone}:${endpoint.id}`,
        payload: {
          text:
            milestone === "working"
              ? "Maya is working…"
              : "Maya stopped before completing this turn.",
          progressState: milestone,
        },
        state: "pending",
      });
      await service.processPendingPublications();
    }

    const providerRuntime = runtime.endpoints.get(endpoint.id);
    expect(providerRuntime?.posts).toEqual([
      { threadId: thread.thread.id, text: "Maya is working…" },
    ]);
    expect(providerRuntime?.edits).toEqual([
      {
        threadId: thread.thread.id,
        messageId: "outbound-1",
        text: "Maya stopped before completing this turn.",
      },
    ]);
  });

  it("publishes a Telegram failure for an exact confirmation continuation that stops before commenting", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredTelegramEndpoint(fixture);
    const chatId = "77112235";
    const dm = makeThread({
      channelId: `telegram:${chatId}`,
      id: `telegram:${chatId}`,
      isDM: true,
      name: "Telegram failed continuation",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: dm.thread,
      message: makeMessage({
        id: `${chatId}:61`,
        text: "Ask before the risky operation",
        userId: chatId,
      }),
      trigger: "direct_message",
    });
    await qualifySetupRoundTrip(service, endpoint.id, chatId);
    await service.test(endpoint.id);
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    if (!conversation)
      throw new Error("Expected Telegram continuation conversation");
    const [inboundLink] = await db
      .select({ commentId: chatMessageLinks.commentId })
      .from(chatMessageLinks)
      .where(
        and(
          eq(chatMessageLinks.endpointId, endpoint.id),
          eq(chatMessageLinks.conversationId, conversation.id),
          eq(chatMessageLinks.providerMessageId, `${chatId}:61`),
          eq(chatMessageLinks.direction, "inbound"),
        ),
      );
    if (!inboundLink?.commentId)
      throw new Error("Expected Telegram inbound comment binding");

    const [sourceRun] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        status: "succeeded",
        contextSnapshot: {
          issueId: conversation.issueId,
          source: "chat:telegram",
          wakeCommentId: inboundLink.commentId,
          wakeCommentIds: [inboundLink.commentId],
        },
      })
      .returning();
    if (!sourceRun) throw new Error("Expected Telegram source run");
    const interaction = await issueThreadInteractionService(db).create(
      { id: conversation.issueId, companyId: fixture.companyId },
      {
        kind: "request_confirmation",
        continuationPolicy: "wake_assignee",
        sourceRunId: sourceRun.id,
        payload: {
          version: 1,
          prompt: "Proceed with the risky operation?",
        },
      },
      { agentId: fixture.assignedAgentId, runId: sourceRun.id },
    );
    await service.processPendingPublications();
    await db
      .update(issueThreadInteractions)
      .set({
        status: "accepted",
        resolvedAt: new Date(),
        resolvedByUserId: "owner-user",
        result: { version: 1, outcome: "accepted" },
      })
      .where(eq(issueThreadInteractions.id, interaction.id));

    const [wakeRequest] = await db
      .insert(agentWakeupRequests)
      .values({
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        status: "failed",
        idempotencyKey: `interaction:${interaction.id}:accepted`,
      })
      .returning();
    if (!wakeRequest) throw new Error("Expected Telegram continuation wake");
    const [continuationRun] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        status: "failed",
        wakeupRequestId: wakeRequest.id,
        errorCode: "adapter_failed",
        contextSnapshot: {
          issueId: conversation.issueId,
          taskId: conversation.issueId,
          interactionId: interaction.id,
          interactionKind: interaction.kind,
          interactionStatus: "accepted",
          sourceRunId: sourceRun.id,
          source: "external_chat.interaction.resolve",
        },
      })
      .returning();
    if (!continuationRun)
      throw new Error("Expected failed Telegram continuation run");
    await db
      .update(agentWakeupRequests)
      .set({ runId: continuationRun.id })
      .where(eq(agentWakeupRequests.id, wakeRequest.id));

    // The milestone sweep is global; assert this continuation's exact receipt
    // below rather than counting work staged for other fixture companies.
    await enqueueChatRunMilestones(db);
    await service.processPendingPublications();

    await expect(
      db
        .select({
          conversationId: chatPublications.conversationId,
          endpointId: chatPublications.endpointId,
          payload: chatPublications.payload,
          state: chatPublications.state,
        })
        .from(chatPublications)
        .where(
          eq(
            chatPublications.idempotencyKey,
            `run:${continuationRun.id}:failed:${endpoint.id}`,
          ),
        ),
    ).resolves.toEqual([
      {
        conversationId: conversation.id,
        endpointId: endpoint.id,
        payload: expect.objectContaining({
          progressState: "failed",
          text: expect.stringContaining(
            "Maya stopped before completing this turn.",
          ),
        }),
        state: "published",
      },
    ]);
    expect(runtime.endpoints.get(endpoint.id)?.posts).toEqual(
      expect.arrayContaining([
        {
          threadId: dm.thread.id,
          text: expect.stringContaining(
            "Maya stopped before completing this turn.",
          ),
        },
      ]),
    );

    const forgedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: forgedRunId,
      companyId: fixture.companyId,
      agentId: fixture.assignedAgentId,
      status: "failed",
      contextSnapshot: {
        issueId: conversation.issueId,
        interactionId: interaction.id,
        interactionStatus: "accepted",
        sourceRunId: sourceRun.id,
        source: "external_chat.interaction.resolve",
      },
      updatedAt: new Date(Date.now() + 1_000),
    });
    await db.insert(agentWakeupRequests).values({
      companyId: fixture.companyId,
      agentId: fixture.replacementAgentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      status: "failed",
      idempotencyKey: `interaction:${interaction.id}:accepted`,
      runId: forgedRunId,
    });
    await expect(enqueueChatRunMilestones(db)).resolves.toBe(0);
    await expect(
      db
        .select({ id: chatPublications.id })
        .from(chatPublications)
        .where(like(chatPublications.idempotencyKey, `run:${forgedRunId}:%`)),
    ).resolves.toHaveLength(0);

    const cancelledQuestion = await issueThreadInteractionService(db).create(
      { id: conversation.issueId, companyId: fixture.companyId },
      {
        kind: "ask_user_questions",
        continuationPolicy: "wake_assignee",
        sourceRunId: sourceRun.id,
        title: "Cancellation path",
        payload: {
          version: 1,
          questions: [
            {
              id: "continue",
              prompt: "Should this work continue?",
              selectionMode: "single",
              required: true,
              allowOther: false,
              options: [
                { id: "yes", label: "Yes" },
                { id: "no", label: "No" },
              ],
            },
          ],
        },
      },
      { agentId: fixture.assignedAgentId, runId: sourceRun.id },
    );
    await service.processPendingPublications();
    await db
      .update(issueThreadInteractions)
      .set({
        status: "cancelled",
        resolvedAt: new Date(),
        resolvedByUserId: "owner-user",
        result: {
          version: 1,
          outcome: "skipped",
          reason: "The external requester cancelled the question.",
          answers: [],
          cancelled: true,
          cancellationReason: "The external requester cancelled the question.",
        },
      })
      .where(eq(issueThreadInteractions.id, cancelledQuestion.id));

    const [cancelledWake] = await db
      .insert(agentWakeupRequests)
      .values({
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        status: "failed",
        idempotencyKey: `interaction:${cancelledQuestion.id}:cancelled`,
      })
      .returning();
    if (!cancelledWake)
      throw new Error("Expected cancelled-question continuation wake");
    const [cancelledRun] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        status: "failed",
        wakeupRequestId: cancelledWake.id,
        errorCode: "adapter_failed",
        contextSnapshot: {
          issueId: conversation.issueId,
          taskId: conversation.issueId,
          interactionId: cancelledQuestion.id,
          interactionKind: cancelledQuestion.kind,
          interactionStatus: "cancelled",
          sourceRunId: sourceRun.id,
          source: "issue.interaction.cancel",
        },
      })
      .returning();
    if (!cancelledRun)
      throw new Error("Expected cancelled-question continuation run");
    await db
      .update(agentWakeupRequests)
      .set({ runId: cancelledRun.id })
      .where(eq(agentWakeupRequests.id, cancelledWake.id));

    await expect(enqueueChatRunMilestones(db)).resolves.toBe(1);
    await service.processPendingPublications();
    await expect(
      db
        .select({
          conversationId: chatPublications.conversationId,
          endpointId: chatPublications.endpointId,
          payload: chatPublications.payload,
          state: chatPublications.state,
        })
        .from(chatPublications)
        .where(
          eq(
            chatPublications.idempotencyKey,
            `run:${cancelledRun.id}:failed:${endpoint.id}`,
          ),
        ),
    ).resolves.toEqual([
      {
        conversationId: conversation.id,
        endpointId: endpoint.id,
        payload: expect.objectContaining({
          progressState: "failed",
          text: expect.stringContaining(
            "Maya stopped before completing this turn.",
          ),
        }),
        state: "published",
      },
    ]);
  });

  it("wakes an existing chat milestone when ordinary ingress reactivates its conversation", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, wakeup } = await configuredSlackEndpoint(fixture);
    const thread = makeThread({ channelId: "C-REOPEN-MILESTONE", id: "slack:C-REOPEN-MILESTONE:4100.1", name: "reopen-milestone" });
    const send = (id: string) => deliverMessage({ callbacks, endpointId: endpoint.id, thread: thread.thread,
      message: makeMessage({ id, text: "@maya continue this conversation", mentioned: true }), trigger: "mention" });
    await send("4100.1");
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    const [link] = await db.select().from(chatMessageLinks).where(and(
      eq(chatMessageLinks.conversationId, conversation.id), eq(chatMessageLinks.providerMessageId, "4100.1")));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: fixture.companyId, agentId: fixture.assignedAgentId,
      status: "failed", errorCode: "low_trust_isolation_unavailable", updatedAt: new Date(),
      contextSnapshot: { issueId: conversation.issueId, source: "chat:slack", endpointId: endpoint.id, wakeCommentId: link.commentId },
    });
    await db.update(chatConversations).set({ state: "unavailable" }).where(eq(chatConversations.id, conversation.id));
    const onError = vi.fn();
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError });
    const notice = () => db.select().from(chatPublications).where(and(eq(chatPublications.issueId, conversation.issueId),
      eq(chatPublications.idempotencyKey, `run:${runId}:failed:${endpoint.id}`)));
    try {
      await chatRunMilestoneWork(db).register(coordinator, () => true).ready;
      await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBeNull());
      expect(await notice()).toEqual([]);
      const wakesBefore = wakeup.mock.calls.length;
      await send("4100.2");
      expect(wakeup.mock.calls.length).toBe(wakesBefore + 1);
      // The harness accepts the new wake without creating a run. Existing
      // projection debt must wake from ingress, not a later run transition.
      await expect.poll(notice, { timeout: 5000 }).toEqual([
        expect.objectContaining({ idempotencyKey: `run:${runId}:failed:${endpoint.id}` }),
      ]);
      await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBeNull());
      expect(onError).not.toHaveBeenCalled();
    } finally { await coordinator.stop(); }
  });

  it.each(["milliseconds", "microseconds"])("drains bounded Slack chat-origin milestones without admitting an internal issue run (%s)", async (precision) => {
    const fixture = await seedCompany();
    const { callbacks, endpoint } = await configuredSlackEndpoint(fixture);
    const thread = makeThread({
      channelId: "C-MILESTONE-DRAIN",
      id: "slack:C-MILESTONE-DRAIN:4065.1",
      name: "milestone-drain",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: thread.thread,
      message: makeMessage({
        id: "4065.1",
        text: "@maya exercise bounded milestone draining",
        mentioned: true,
      }),
      trigger: "mention",
    });
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    const [inboundLink] = await db
      .select({ commentId: chatMessageLinks.commentId })
      .from(chatMessageLinks)
      .where(
        and(
          eq(chatMessageLinks.endpointId, endpoint.id),
          eq(chatMessageLinks.providerMessageId, "4065.1"),
          eq(chatMessageLinks.direction, "inbound"),
        ),
      );
    if (!inboundLink?.commentId) {
      throw new Error("Expected the inbound Slack comment link");
    }
    const runCases = [
      { id: randomUUID(), status: "queued", milestone: "queued" },
      { id: randomUUID(), status: "running", milestone: "working" },
      {
        id: randomUUID(),
        status: "failed",
        milestone: "failed",
        errorCode: "low_trust_isolation_unavailable",
      },
    ] as const;
    const resolverRejectedRuns = Array.from({ length: 30 }, (_, index) => ({
      id: randomUUID(),
      companyId: fixture.companyId,
      agentId: fixture.assignedAgentId,
      status: "running" as const,
      contextSnapshot: {
        issueId: conversation.issueId,
        source: "chat:slack",
        // The broad SQL candidate fence sees the verified inbound comment,
        // while the authoritative lineage resolver correctly rejects this
        // mismatched endpoint. More than one page proves rejected rows cannot
        // permanently starve the valid milestone that follows them.
        endpointId: randomUUID(),
        wakeCommentId: inboundLink.commentId,
        wakeCommentIds: [inboundLink.commentId],
      },
      updatedAt: new Date(
        new Date("2026-09-05T14:59:00.000Z").getTime() + index,
      ),
    }));
    const internalRunId = randomUUID();
    await db.insert(heartbeatRuns).values([
      ...resolverRejectedRuns,
      {
        id: internalRunId,
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        status: "running",
        contextSnapshot: {
          issueId: conversation.issueId,
          source: "issue.comment",
          wakeCommentId: inboundLink.commentId,
          wakeCommentIds: [inboundLink.commentId],
        },
        updatedAt: new Date("2026-09-05T14:59:59.000Z"),
      },
      ...runCases.map(({ id, status, ...runCase }, index) => ({
        id,
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        status,
        errorCode: "errorCode" in runCase ? runCase.errorCode : null,
        contextSnapshot: {
          issueId: conversation.issueId,
          source: "chat:slack",
          wakeCommentId: inboundLink.commentId,
          wakeCommentIds: [inboundLink.commentId],
        },
        updatedAt: new Date(`2026-09-05T15:00:0${index}.000Z`),
      })),
    ]);

    if (precision === "microseconds") {
      await db.update(heartbeatRuns).set({
        updatedAt: sql`'2026-09-05T14:59:00.000123Z'::timestamptz`,
      }).where(inArray(heartbeatRuns.id, resolverRejectedRuns.map(run => run.id)));
    }
    // Fail a non-advancing pagination loop explicitly instead of leaving a
    // background query chain running after the test timeout.
    const select = db.select.bind(db);
    let reads = 0;
    const readGuard = vi.spyOn(db, "select").mockImplementation((...args) => {
      if (args[0] && "runUpdatedAt" in args[0] && ++reads > 100) {
        throw new Error("Milestone projection did not advance past rejected candidates");
      }
      return select(...args);
    });
    const inserted: number[] = [];
    try {
      for (let index = 0; index < 4; index += 1) {
        inserted.push(
          await enqueueChatRunLifecycleMilestones(db, {
            since: new Date("2026-09-05T14:00:00.000Z"),
            limit: 1,
          }),
        );
      }
    } finally { readGuard.mockRestore(); }
    expect(inserted).toEqual([1, 1, 1, 0]);
    const publications = await db
      .select()
      .from(chatPublications)
      .where(eq(chatPublications.conversationId, conversation.id));
    expect(publications).toHaveLength(3);
    expect(
      new Set(publications.map((publication) => publication.idempotencyKey)),
    ).toEqual(
      new Set(
        runCases.map(
          ({ id, milestone }) => `run:${id}:${milestone}:${endpoint.id}`,
        ),
      ),
    );
    expect(
      publications.find((publication) =>
        publication.idempotencyKey.startsWith(`run:${internalRunId}:`),
      ),
    ).toBeUndefined();
    expect(
      publications.find((publication) =>
        publication.idempotencyKey.includes(":failed:"),
      )?.payload,
    ).toMatchObject({
      progressState: "failed",
      text: expect.stringContaining(
        "Ask a Paperclip admin to create a private identity link for this account or enable isolated guest execution, then start a new task.",
      ),
    });
  });

  it("wakes Slack session sync from publication commit and leaves settled action queues quiet", async () => {
    const f = await publicationLaneFixture(1);
    const lane = f.lanes[0]!;
    const onError = vi.fn();
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError });
    try {
      await registerChatActionWork(coordinator, f.service, () => true).ready;
      await f.enqueue(0, "A completed answer");
      await f.service.processPendingPublications();
      await expect.poll(async () => db.select({ status: chatActions.status }).from(chatActions)
        .where(and(eq(chatActions.endpointId, lane.endpoint.id), eq(chatActions.kind, "slack_session_sync"))),
        { timeout: 10_000 }).toEqual([{ status: "processed" }]);
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
    } finally { await coordinator.stop(); await f.cleanup(); }
  });

  it("recovers stale provider sends on startup without replaying uncertain effects", async () => {
    const f = await publicationLaneFixture(1);
    const lane = f.lanes[0]!;
    const [action] = await db.insert(chatActions).values({ companyId: f.companyId, endpointId: lane.endpoint.id,
      kind: "provider_effect", providerActionId: randomUUID(), status: "processing", result: { attempts: 1 },
      updatedAt: new Date(Date.now() - 120_000), payload: {} }).returning();
    const before = lane.providerRuntime.posts.length;
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: () => undefined });
    try {
      await registerChatActionWork(coordinator, f.service, () => true).ready;
      await expect.poll(async () => db.select({ status: chatActions.status }).from(chatActions)
        .where(eq(chatActions.id, action!.id)), { timeout: 10_000 }).toEqual([{ status: "delivery_unknown" }]);
      expect(await f.service.nextChatActionAt("provider_effect")).toBeNull();
      expect(lane.providerRuntime.posts).toHaveLength(before);
    } finally { await coordinator.stop(); await f.cleanup(); }
  });

  it("restores action retry and stale-claim deadlines and parks paused or uncertain work", async () => {
    const f = await publicationLaneFixture(1);
    const lane = f.lanes[0]!;
    const at = new Date();
    const later = new Date(at.getTime() + 120_000);
    try {
      for (const kind of Object.keys(CHAT_ACTION_QUEUES) as (keyof typeof CHAT_ACTION_QUEUES)[]) {
        const [action] = await db.insert(chatActions).values({ companyId: f.companyId, endpointId: lane.endpoint.id,
          kind, providerActionId: randomUUID(), status: "received", updatedAt: at,
          ...(kind === "telegram_maintenance" ? { payload: { operation: "register_commands" } } : {}) }).returning();
        const set = (status: string, result: Record<string, unknown> = {}) => db.update(chatActions)
          .set({ status, result, updatedAt: at }).where(eq(chatActions.id, action!.id));
        const due = async () => db.select({ id: chatActions.id }).from(chatActions)
          .leftJoin(chatEndpoints, eq(chatEndpoints.id, chatActions.endpointId))
          .where(and(eq(chatActions.id, action!.id), dueChatAction(kind))).then(rows => rows.length > 0);
        if (kind === "slack_board_message") {
          expect(await due()).toBe(true);
          await db.update(chatEndpoints).set({ status: "paused" }).where(eq(chatEndpoints.id, lane.endpoint.id));
          expect(await f.service.nextChatActionAt(kind)).toBeNull();
          expect(await due()).toBe(false);
          await db.update(chatEndpoints).set({ status: "active" }).where(eq(chatEndpoints.id, lane.endpoint.id));
        } else if (kind === "slash_task_start") {
          for (const [status, delay] of [["validating", 60_000], ["resolving", 300_000], ["admitting", 60_000]] as const) {
            await set(status);
            expect(await f.service.nextChatActionAt(kind)).toBe(at.getTime() + delay);
            expect(await due()).toBe(false);
          }
          for (const status of ["queued", "provider_confirmed"]) {
            await set(status, { retryAt: later.toISOString() });
            expect(await f.service.nextChatActionAt(kind)).toBe(later.getTime());
            expect(await due()).toBe(false);
            await db.update(chatEndpoints).set({ status: "attention" }).where(eq(chatEndpoints.id, lane.endpoint.id));
            expect(await f.service.nextChatActionAt(kind)).toBeNull();
            await db.update(chatEndpoints).set({ status: "active" }).where(eq(chatEndpoints.id, lane.endpoint.id));
          }
          await set("delivery_unknown");
          expect(await f.service.nextChatActionAt(kind)).toBeNull();
          expect(await due()).toBe(false);
        } else if (kind === "failed_run_retry") {
          expect(await due()).toBe(false);
          await set("issued");
          expect(await due()).toBe(true);
          await set("issued", { retryAt: later.toISOString() });
          expect(await f.service.nextChatActionAt(kind)).toBe(later.getTime());
          expect(await due()).toBe(false);
          await set("processing");
          expect(await f.service.nextChatActionAt(kind)).toBe(at.getTime() + 60_000);
          expect(await due()).toBe(false);
          // Both the claim lease and retry time must expire before replay.
          await set("processing", { retryAt: later.toISOString() });
          expect(await f.service.nextChatActionAt(kind)).toBe(later.getTime());
          await set("processing", { retryAt: at.toISOString() });
          expect(await f.service.nextChatActionAt(kind)).toBe(at.getTime() + 60_000);
          for (const status of ["failed", "cancelled", "processed"]) {
            await set(status, { retryable: true, retryAt: at.toISOString() });
            expect(await f.service.nextChatActionAt(kind)).toBeNull();
            expect(await due()).toBe(false);
          }
        } else if (kind === "slack_session_sync") {
          expect(await due()).toBe(true);
          await set("received", { retryAt: later.toISOString() });
          expect(await f.service.nextChatActionAt(kind)).toBe(later.getTime());
          expect(await due()).toBe(false);
          await set("processing");
          expect(await f.service.nextChatActionAt(kind)).toBe(at.getTime() + 60_000);
          for (const status of ["paused", "attention"] as const) {
            await db.update(chatEndpoints).set({ status }).where(eq(chatEndpoints.id, lane.endpoint.id));
            expect(await f.service.nextChatActionAt(kind)).toBeNull();
            expect(await due()).toBe(false);
          }
          await db.update(chatEndpoints).set({ status: "active" }).where(eq(chatEndpoints.id, lane.endpoint.id));
          await set("failed", { retryable: true });
          expect(await f.service.nextChatActionAt(kind)).toBeNull();
        } else {
          expect(await due()).toBe(true);
          await set("processing");
          expect(await f.service.nextChatActionAt(kind)).toBe(at.getTime() + 60_000);
          expect(await due()).toBe(false);
          await set("failed", { retryable: true, retryAt: later.toISOString() });
          expect(await f.service.nextChatActionAt(kind)).toBe(later.getTime());
          expect(await due()).toBe(false);
          await set("failed", { retryable: false });
          expect(await f.service.nextChatActionAt(kind)).toBeNull();
        }
        await set("processed");
        expect(await f.service.nextChatActionAt(kind)).toBeNull();
      }
    } finally { await f.cleanup(); }
  });

  it("recovers action rows on startup, wakes after outer commit, and leaves empty queues quiet", async () => {
    const f = await publicationLaneFixture(1);
    const lane = f.lanes[0]!;
    const onError = vi.fn();
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError });
    const action = (kind: "receipt_reaction" | "slack_session_stop") => ({ companyId: f.companyId,
      endpointId: lane.endpoint.id, kind, providerActionId: randomUUID(), status: "processing",
      updatedAt: new Date(Date.now() - 120_000), payload: {} });
    try {
      const [stale] = await db.insert(chatActions).values(action("receipt_reaction")).returning();
      await registerChatActionWork(coordinator, f.service, () => true).ready;
      await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBeNull(), { timeout: 10_000 });
      expect((await readChatActionsById(stale!.id))[0]?.status).toBe("failed");
      const scans = vi.spyOn(db, "select");
      try {
        await new Promise(resolve => setTimeout(resolve, 1200));
        expect(scans).not.toHaveBeenCalled();
      } finally { scans.mockRestore(); }
      let release!: () => void, inserted!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const staged = new Promise<void>(resolve => { inserted = resolve; });
      const writing = db.transaction(async tx => {
        await tx.transaction(async nested => {
          await notifyChatActionWork(nested, "slack_session_stop");
          await nested.insert(chatActions).values(action("slack_session_stop"));
        });
        inserted(); await gate;
      });
      await staged;
      expect(coordinator.nextWakeAt()).not.toBeNull();
      release(); await writing;
      await vi.waitFor(async () => {
        const rows = await db.select().from(chatActions).where(and(eq(chatActions.companyId, f.companyId), eq(chatActions.kind, "slack_session_stop")));
        expect(rows[0]?.status).toBe("failed");
        expect(coordinator.nextWakeAt()).toBeNull();
      }, { timeout: 10_000 });
      expect(lane.providerRuntime.posts).toHaveLength(0);
      expect(onError).not.toHaveBeenCalled();
    } finally { await coordinator.stop(); await f.cleanup(); }
  });

  it("restores chat queue deadlines without polling blocked followers or receipt owners", async () => {
    const f = await publicationLaneFixture(1);
    const { service, lanes, enqueue } = f;
    const lane = lanes[0]!;
    try {
      const head = await enqueue(0, "Head");
      const tail = await enqueue(0, "Follower", 1);
      const retryAt = new Date(Date.now() + 120_000);
      await db.update(chatPublications).set({ state: "retry", nextAttemptAt: retryAt }).where(eq(chatPublications.id, head.id));
      expect(await service.nextPublicationAt()).toBe(retryAt.getTime());
      await db.update(chatPublications).set({ state: "delivery_unknown", nextAttemptAt: null }).where(eq(chatPublications.id, head.id));
      expect(await service.nextPublicationAt()).toBeNull();
      const leaseUntil = new Date(Date.now() + 180_000);
      await db.update(chatPublications).set({ state: "streaming", updatedAt: new Date() }).where(eq(chatPublications.id, head.id));
      await db.insert(chatEndpointLeases).values({ companyId: f.companyId, endpointId: lane.endpoint.id,
        leaseKey: `publication:${head.id}:0`, token: randomUUID(), expiresAt: leaseUntil });
      expect(await service.nextPublicationAt()).toBe(leaseUntil.getTime());
      await db.insert(chatActions).values({ companyId: f.companyId, endpointId: lane.endpoint.id,
        kind: "slack_file_upload_receipt", providerActionId: randomUUID(), status: "received",
        payload: { publicationId: head.id, publicationAttempt: 0 } });
      expect(await service.nextSlackReceiptAt()).toBeNull();
      await db.delete(chatEndpointLeases).where(eq(chatEndpointLeases.endpointId, lane.endpoint.id));
      await db.update(chatPublications).set({ updatedAt: new Date(Date.now() - 70_000) }).where(eq(chatPublications.id, head.id));
      const wake = vi.fn();
      const unsubscribe = subscribeDeliveryWork(db, DELIVERY_QUEUES.chatReceipts, wake);
      try {
        await service.scheduleQueuedPublications();
        expect(wake).toHaveBeenCalled();
        expect(await service.nextSlackReceiptAt()).toBeLessThanOrEqual(Date.now());
        await service.processPendingSlackFileUploadReceipts(); // Invalid retained payload is closed, not retried.
        expect(await service.nextSlackReceiptAt()).toBeNull();
      } finally { unsubscribe(); }
      await db.update(chatPublications).set({ state: "cancelled" }).where(eq(chatPublications.id, tail.id));
      expect(await service.nextPublicationAt()).toBeNull();
    } finally { await f.cleanup(); }
  });

  it("restores inbound retry and abandoned wake deadlines and excludes paused queues", async () => {
    const f = await publicationLaneFixture(1);
    const { service, lanes } = f;
    const lane = lanes[0]!;
    try {
      const retryAt = new Date(Date.now() + 120_000);
      const [delivery] = await db.insert(chatDeliveries).values({ companyId: f.companyId, endpointId: lane.endpoint.id,
        conversationId: lane.conversation.id, providerEventId: randomUUID(), deduplicationKey: randomUUID(),
        eventKind: "message", normalizedEvent: { conversation: { externalThreadId: lane.conversation.externalThreadId } },
        receivedAt: new Date(Date.now() - 1000), state: "retry", nextAttemptAt: retryAt }).returning();
      const [follower] = await db.insert(chatDeliveries).values({ companyId: f.companyId, endpointId: lane.endpoint.id,
        conversationId: lane.conversation.id, providerEventId: randomUUID(), deduplicationKey: randomUUID(),
        eventKind: "message", normalizedEvent: delivery!.normalizedEvent, state: "received" }).returning();
      expect(await service.nextInboundDeliveryAt()).toBe(retryAt.getTime());
      const [edit] = await db.insert(chatDeliveries).values({ companyId: f.companyId, endpointId: lane.endpoint.id,
        providerEventId: randomUUID(), deduplicationKey: randomUUID(), eventKind: "message_updated", state: "received",
        receivedAt: new Date(Date.now() - 2000), normalizedEvent: { ...delivery!.normalizedEvent,
          message: { targetProviderEventId: delivery!.providerEventId } } }).returning();
      expect(await service.nextInboundDeliveryAt()).toBe(retryAt.getTime());
      await db.update(chatDeliveries).set({ state: "filtered" }).where(eq(chatDeliveries.id, edit!.id));
      expect(await service.nextInboundDeliveryAt()).toBe(retryAt.getTime());
      await db.update(chatDeliveries).set({ state: "processed" }).where(eq(chatDeliveries.id, delivery!.id));
      const [action] = await db.insert(chatActions).values({ companyId: f.companyId, endpointId: lane.endpoint.id,
        deliveryId: delivery!.id, kind: "inbound_wakeup", providerActionId: randomUUID(), status: "issued",
        result: { retryAt: retryAt.toISOString() } }).returning();
      expect(await service.nextInboundDeliveryAt()).toBe(retryAt.getTime());
      const claimedAt = new Date();
      await db.update(chatActions).set({ status: "processing", updatedAt: claimedAt }).where(eq(chatActions.id, action!.id));
      expect(await service.nextInboundDeliveryAt()).toBe(claimedAt.getTime() + 60_000);
      await db.update(chatEndpoints).set({ status: "paused" }).where(eq(chatEndpoints.id, lane.endpoint.id));
      expect(await service.nextInboundDeliveryAt()).toBeNull();
      await db.update(chatActions).set({ status: "processed" }).where(eq(chatActions.id, action!.id));
      await db.update(chatDeliveries).set({ state: "filtered" }).where(eq(chatDeliveries.id, follower!.id));
      await db.update(chatEndpoints).set({ status: "active" }).where(eq(chatEndpoints.id, lane.endpoint.id));
      expect(await service.nextInboundDeliveryAt()).toBeNull();
      await db.update(chatEndpoints).set({ status: "attention" }).where(eq(chatEndpoints.id, lane.endpoint.id));
      await db.insert(chatDeliveries).values({ companyId: f.companyId, endpointId: lane.endpoint.id,
        providerEventId: randomUUID(), deduplicationKey: randomUUID(), eventKind: "installation", state: "retry",
        nextAttemptAt: retryAt, normalizedEvent: { lifecycle: { kind: "endpoint", provider: "slack",
          providerEventId: randomUUID(), availability: "available", reason: "Recovered" } } });
      expect(await service.nextInboundDeliveryAt()).toBe(retryAt.getTime());
    } finally { await f.cleanup(); }
  });

  it("sleeps behind an unresolved Slack tool send and wakes when its receipt settles", async () => {
    const f = await publicationLaneFixture(1);
    const lane = f.lanes[0]!;
    const onError = vi.fn();
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError });
    try {
      const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.assignedAgentId, status: "succeeded" }).returning();
      const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: lane.conversation.issueId,
        authorAgentId: f.assignedAgentId, createdByRunId: run!.id, body: "Already sent" }).returning();
      const publication = await f.enqueue(0, "Already sent");
      await db.update(chatPublications).set({ commentId: comment!.id }).where(eq(chatPublications.id, publication.id));
      const [send] = await db.insert(chatActions).values({ companyId: f.companyId, endpointId: lane.endpoint.id,
        conversationId: lane.conversation.id, kind: "slack_tool_write", providerActionId: randomUUID(), status: "processing",
        payload: { name: "slack_post_message", binding: { runId: run!.id }, args: {
          channel: lane.conversation.externalConversationId.replace(/^slack:/, ""),
          thread_ts: lane.conversation.externalThreadId.split(":").at(-1), text: "  Already sent\n" } } }).returning();
      await registerChatDeliveryWork(coordinator, f.service, () => true).ready;
      await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBeNull(), { timeout: 10_000 });
      expect(await f.service.nextPublicationAt()).toBeNull();
      for (const status of ["uncertain", "processed"]) {
        await db.transaction(async tx => {
          await notifyChatPublicationWork(tx);
          await tx.update(chatActions).set({ status }).where(eq(chatActions.id, send!.id));
        });
        await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBeNull(), { timeout: 10_000 });
      }
      await vi.waitFor(async () => {
        const [row] = await readChatPublicationsById(publication.id);
        expect(row!.state).toBe("cancelled");
        expect(coordinator.nextWakeAt()).toBeNull();
      }, { timeout: 10_000 });
      expect(lane.providerRuntime.posts).toHaveLength(0);
      expect(onError).not.toHaveBeenCalled();
    } finally { await coordinator.stop(); await f.cleanup(); }
  });

  it("wakes chat dispatch after commit and refills free endpoint slots without the maintenance loop", async () => {
    const f = await publicationLaneFixture(6);
    const onError = vi.fn();
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.lanes[0]!.providerRuntime.postHook = () => gate;
    try {
      await registerChatDeliveryWork(coordinator, f.service, () => true).ready;
      await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBeNull(), { timeout: 10_000 });
      let settle!: () => void;
      const commitGate = new Promise<void>(resolve => { settle = resolve; });
      let staged!: () => void;
      const stagedGate = new Promise<void>(resolve => { staged = resolve; });
      const writing = db.transaction(async tx => {
        await notifyChatPublicationWork(tx);
        await tx.insert(chatPublications).values(f.lanes.map((lane, index) => ({ companyId: f.companyId,
          endpointId: lane.endpoint.id, conversationId: lane.conversation.id, issueId: lane.conversation.issueId,
          idempotencyKey: `work-test:${randomUUID()}`, payload: { text: `Queued ${index}` }, state: "pending" as const })));
        staged(); await commitGate;
      });
      await stagedGate;
      expect(f.lanes.every(lane => lane.providerRuntime.posts.length === 0)).toBe(true);
      settle(); await writing;
      await vi.waitFor(() => expect(f.lanes.slice(1).every(lane => lane.providerRuntime.posts.length === 1)).toBe(true), { timeout: 10_000 });
      release();
      await vi.waitFor(async () => {
        const rows = await db.select().from(chatPublications).where(eq(chatPublications.companyId, f.companyId));
        expect(rows.every(row => row.state === "published")).toBe(true);
        expect(coordinator.nextWakeAt()).toBeNull();
      }, { timeout: 10_000 });
      expect(onError).not.toHaveBeenCalled();
    } finally { release(); await coordinator.stop(); await f.cleanup(); }
  });

  it("refills four tracked publication endpoint lanes after a scheduled budget and joins shutdown", async () => {
    const fixture = await publicationLaneFixture(6);
    const { service, lanes, enqueue, storage } = fixture;
    const releases: Array<() => void> = [];
    const entered = new Set<number>();
    let active = 0;
    let maximumActive = 0;
    const gates = lanes.map((lane, index) => {
      const gate = new Promise<void>((resolve) => {
        releases[index] = resolve;
      });
      lane.providerRuntime.postHook = async () => {
        entered.add(index);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          await gate;
        } finally {
          active -= 1;
        }
      };
      return gate;
    });
    let shutdown: Promise<void> | undefined;
    try {
      const comment = await issueService(db).addComment(
        lanes[0]!.conversation.issueId,
        "Slow upload",
        { userId: "owner-user" },
      );
      const stored = await storage.storage.putFile({
        companyId: fixture.companyId,
        namespace: `issues/${lanes[0]!.conversation.issueId}`,
        originalFilename: "slow.txt",
        contentType: "text/plain",
        body: Buffer.from("held file"),
      });
      const attachment = await issueService(db).createAttachment({
        issueId: lanes[0]!.conversation.issueId,
        issueCommentId: comment.id,
        ...stored,
        createdByUserId: "owner-user",
      });
      const first = await enqueue(0, "", 0, {
        text: "",
        attachmentIds: [attachment.id],
      });
      await db
        .update(chatPublications)
        .set({ commentId: comment.id })
        .where(eq(chatPublications.id, first.id));
      const tail = await enqueue(0, "Same conversation must wait", 100);
      const initial = [first];
      for (let index = 1; index < lanes.length; index += 1)
        initial.push(await enqueue(index, `Final ${index}`));
      let scheduledReturned = false;
      const scheduled = service.schedulePendingPublications(4).then(() => {
        scheduledReturned = true;
      });
      await vi.waitFor(() => {
        expect(scheduledReturned).toBe(true);
        expect(entered).toEqual(new Set([0, 1, 2, 3]));
      });
      await scheduled;
      expect(maximumActive).toBe(4);
      await service.schedulePendingPublications(4);
      expect(entered.size).toBe(4);
      expect(
        await db
          .select({
            state: chatPublications.state,
            attempts: chatPublications.attempts,
          })
          .from(chatPublications)
          .where(eq(chatPublications.id, tail.id)),
      ).toEqual([{ state: "pending", attempts: 0 }]);

      releases[1]!();
      await vi.waitFor(async () => {
        expect(
          await db
            .select({ state: chatPublications.state })
            .from(chatPublications)
            .where(eq(chatPublications.id, initial[1]!.id)),
        ).toEqual([{ state: "published" }]);
      });
      const sourceRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: sourceRunId,
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        status: "succeeded",
        contextSnapshot: {
          issueId: lanes[1]!.conversation.issueId,
          source: "automation",
        },
      });
      const interaction = await issueThreadInteractionService(db).create(
        { id: lanes[1]!.conversation.issueId, companyId: fixture.companyId },
        {
          kind: "ask_user_questions",
          continuationPolicy: "wake_assignee",
          sourceRunId,
          title: "Late question",
          payload: {
            version: 1,
            title: "Late question",
            questions: [
              {
                id: "priority",
                prompt: "Which priority?",
                selectionMode: "single",
                required: true,
                options: [
                  { id: "high", label: "High" },
                  { id: "normal", label: "Normal" },
                ],
              },
            ],
          },
        },
        { agentId: fixture.assignedAgentId, runId: sourceRunId },
      );
      releases[4]!();
      releases[5]!();
      await vi.waitFor(
        async () => {
          await service.schedulePendingPublications(4);
          expect(
            await db
              .select({ state: chatPublications.state })
              .from(chatPublications)
              .where(
                eq(
                  chatPublications.idempotencyKey,
                  `interaction:${interaction.id}:${lanes[1]!.endpoint.id}`,
                ),
              ),
          ).toEqual([{ state: "published" }]);
        },
        { timeout: 5_000 },
      );
      expect(entered).toEqual(new Set([0, 1, 2, 3, 4, 5]));
      expect(maximumActive).toBe(4);
      expect(lanes[0]!.providerRuntime.posts).toHaveLength(0);
      expect(lanes[1]!.providerRuntime.posts).toHaveLength(2);
      expect(lanes[1]!.providerRuntime.posts[1]!.text).toContain(
        "Late question",
      );
      let shutdownDone = false;
      shutdown = service.shutdown().then(() => {
        shutdownDone = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(shutdownDone).toBe(false);
      expect(lanes[0]!.providerRuntime.shutdown).not.toHaveBeenCalled();
      expect(await service.schedulePendingPublications()).toBe(0);
      releases.forEach((release) => release());
      await shutdown;
      expect(lanes[0]!.providerRuntime.posts).toHaveLength(1);
      expect(lanes[0]!.providerRuntime.posts[0]!.files).toHaveLength(1);
      expect(
        await db
          .select({ state: chatPublications.state })
          .from(chatPublications)
          .where(eq(chatPublications.id, tail.id)),
      ).toEqual([{ state: "pending" }]);
      expect(
        await db
          .select()
          .from(chatEndpointLeases)
          .where(
            and(
              eq(chatEndpointLeases.companyId, fixture.companyId),
              like(chatEndpointLeases.leaseKey, "publication:%"),
            ),
          ),
      ).toHaveLength(0);
    } finally {
      releases.forEach((release) => release());
      await Promise.all(gates);
      await shutdown;
      await fixture.cleanup();
    }
  });

  it("does not hide another endpoint behind a page of busy-bot conversation heads", async () => {
    const fixture = await publicationLaneFixture(2);
    const { service, lanes, enqueue } = fixture;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    lanes[0]!.providerRuntime.postHook = async () => {
      entered = true;
      await held;
    };
    let drain: Promise<number> | undefined;
    try {
      const first = await enqueue(0, "First in conversation");
      const tail = await enqueue(0, "Second in conversation", 100);
      for (let index = 0; index < 26; index += 1) {
        const original = lanes[0]!.conversation;
        const [conversation] = await db
          .insert(chatConversations)
          .values({
            companyId: fixture.companyId,
            endpointId: original.endpointId,
            resourceId: original.resourceId,
            issueId: original.issueId,
            externalConversationId: original.externalConversationId,
            externalThreadId: `slack:${original.externalConversationId}:${6000 + index}.1`,
            externalLabel: `Backlog ${index}`,
          })
          .returning();
        await db.insert(chatPublications).values({
          companyId: fixture.companyId,
          endpointId: original.endpointId,
          conversationId: conversation!.id,
          issueId: original.issueId,
          idempotencyKey: `lane-backlog:${randomUUID()}`,
          payload: { text: `Backlog ${index}` },
          createdAt: new Date(Date.UTC(2000, 0, 1) + index + 1),
        });
      }
      const ready = await enqueue(1, "Unrelated final", 200);
      await service.schedulePendingPublications(25);
      await vi.waitFor(async () => {
        expect(entered).toBe(true);
        expect(
          await db
            .select({ state: chatPublications.state })
            .from(chatPublications)
            .where(eq(chatPublications.id, ready.id)),
        ).toEqual([{ state: "published" }]);
      });
      expect(
        await db
          .select({
            state: chatPublications.state,
            attempts: chatPublications.attempts,
          })
          .from(chatPublications)
          .where(eq(chatPublications.id, tail.id)),
      ).toEqual([{ state: "pending", attempts: 0 }]);
      release();
      drain = service.processPendingPublications(50);
      await drain;
      const sameConversationPosts = lanes[0]!.providerRuntime.posts.filter(
        (post) => post.threadId === lanes[0]!.conversation.externalThreadId,
      );
      expect(sameConversationPosts.map((post) => post.text)).toEqual([
        "First in conversation",
        "Second in conversation",
      ]);
      expect(
        await db
          .select({
            state: chatPublications.state,
            attempts: chatPublications.attempts,
          })
          .from(chatPublications)
          .where(inArray(chatPublications.id, [first.id, tail.id])),
      ).toEqual([
        { state: "published", attempts: 1 },
        { state: "published", attempts: 1 },
      ]);
    } finally {
      release();
      await drain;
      await fixture.cleanup();
    }
  });

  it("keeps an aged live publication owned across standby sweeps but quarantines only exact-lease orphans", async () => {
    const fixture = await publicationLaneFixture(2);
    const { service, lanes, enqueue } = fixture;
    const standby = createService();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    lanes[0]!.providerRuntime.postHook = async () => {
      entered = true;
      await held;
    };
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    try {
      const live = await enqueue(0, "Long running provider send");
      await service.schedulePendingPublications(1);
      await vi.waitFor(() => expect(entered).toBe(true));
      const staleAt = new Date(Date.now() - 61_000);
      await db
        .update(chatPublications)
        .set({ updatedAt: staleAt })
        .where(eq(chatPublications.id, live.id));
      const [lease] = await db
        .select()
        .from(chatEndpointLeases)
        .where(eq(chatEndpointLeases.leaseKey, `publication:${live.id}:1`));
      expect(lease).toMatchObject({
        companyId: fixture.companyId,
        endpointId: live.endpointId,
      });
      expect(lease!.expiresAt.getTime()).toBeGreaterThan(Date.now());
      // Advance the renewal clock, not wall time. Both the first claim and
      // its stale updatedAt now exceed 60s, while exact ownership renews.
      await vi.advanceTimersByTimeAsync(31_000);
      await vi.waitFor(async () => {
        const [renewed] = await db
          .select()
          .from(chatEndpointLeases)
          .where(eq(chatEndpointLeases.id, lease!.id));
        expect(renewed!.expiresAt.getTime()).toBeGreaterThan(
          lease!.expiresAt.getTime(),
        );
      });
      await vi.advanceTimersByTimeAsync(31_000);
      await vi.waitFor(async () => {
        const [renewed] = await db
          .select()
          .from(chatEndpointLeases)
          .where(eq(chatEndpointLeases.id, lease!.id));
        expect(renewed!.expiresAt.getTime()).toBeGreaterThan(
          Date.now() + 60_000,
        );
      });
      const orphans = [];
      for (const kind of [
        "expired",
        "wrong-attempt",
        "wrong-endpoint",
      ] as const) {
        const orphan = await enqueue(1, kind);
        await db
          .update(chatPublications)
          .set({ state: "streaming", attempts: 7, updatedAt: staleAt })
          .where(eq(chatPublications.id, orphan.id));
        await db.insert(chatEndpointLeases).values({
          companyId: fixture.companyId,
          endpointId:
            kind === "wrong-endpoint"
              ? lanes[0]!.endpoint.id
              : orphan.endpointId,
          leaseKey: `publication:${orphan.id}:${kind === "wrong-attempt" ? 6 : 7}`,
          token: randomUUID(),
          expiresAt: new Date(
            Date.now() + (kind === "expired" ? -1_000 : 90_000),
          ),
        });
        orphans.push(orphan);
      }
      await standby.service.schedulePendingPublications(0);
      expect(
        await db
          .select({
            state: chatPublications.state,
            attempts: chatPublications.attempts,
          })
          .from(chatPublications)
          .where(eq(chatPublications.id, live.id)),
      ).toEqual([{ state: "streaming", attempts: 1 }]);
      expect(
        await db
          .select({
            state: chatPublications.state,
            attempts: chatPublications.attempts,
          })
          .from(chatPublications)
          .where(
            inArray(
              chatPublications.id,
              orphans.map((row) => row.id),
            ),
          ),
      ).toEqual(
        orphans.map(() => ({ state: "delivery_unknown", attempts: 7 })),
      );
      release();
      await service.shutdown();
      expect(
        await db
          .select({
            state: chatPublications.state,
            attempts: chatPublications.attempts,
          })
          .from(chatPublications)
          .where(eq(chatPublications.id, live.id)),
      ).toEqual([{ state: "published", attempts: 1 }]);
      expect(lanes[0]!.providerRuntime.posts).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      release();
      await standby.service.shutdown();
      await fixture.cleanup();
      vi.useRealTimers();
    }
  });

  it("does not retry a provider-accepted publication after its exact attempt lease is lost", async () => {
    const fixture = await publicationLaneFixture(1);
    const { service, lanes, enqueue } = fixture;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    lanes[0]!.providerRuntime.postHook = async () => {
      entered = true;
      await held;
    };
    try {
      const publication = await enqueue(0, "Accepted without lease authority");
      await service.schedulePendingPublications(1);
      await vi.waitFor(() => expect(entered).toBe(true));
      await db
        .update(chatEndpointLeases)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(
          eq(chatEndpointLeases.leaseKey, `publication:${publication.id}:1`),
        );
      release();
      await service.processPendingPublications();
      expect(lanes[0]!.providerRuntime.posts).toHaveLength(1);
      expect(
        await db
          .select({
            state: chatPublications.state,
            attempts: chatPublications.attempts,
            providerMessageId: chatPublications.providerMessageId,
          })
          .from(chatPublications)
          .where(eq(chatPublications.id, publication.id)),
      ).toEqual([{ state: "streaming", attempts: 1, providerMessageId: null }]);
      await db
        .update(chatPublications)
        .set({ updatedAt: new Date(Date.now() - 61_000) })
        .where(eq(chatPublications.id, publication.id));
      await service.processPendingPublications();
      await service.processPendingPublications();
      expect(lanes[0]!.providerRuntime.posts).toHaveLength(1);
      expect(
        await db
          .select({
            state: chatPublications.state,
            attempts: chatPublications.attempts,
          })
          .from(chatPublications)
          .where(eq(chatPublications.id, publication.id)),
      ).toEqual([{ state: "delivery_unknown", attempts: 1 }]);
      expect(
        await db
          .select()
          .from(chatMessageLinks)
          .where(eq(chatMessageLinks.publicationId, publication.id)),
      ).toHaveLength(0);
    } finally {
      release();
      await fixture.cleanup();
    }
  });

  it("does not resurrect publication ownership after waiting beyond expiry on a real lease row lock", async () => {
    const fixture = await publicationLaneFixture(1);
    const { service, lanes, enqueue } = fixture;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    lanes[0]!.providerRuntime.postHook = async () => {
      entered = true;
      await held;
    };
    let drain: Promise<number> | undefined;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const baseTime = Date.now();
      const publication = await enqueue(
        0,
        "Accepted while receipt ownership waits",
      );
      await service.schedulePendingPublications(1);
      await vi.waitFor(() => expect(entered).toBe(true));
      const leaseKey = `publication:${publication.id}:1`;
      await db
        .update(chatEndpointLeases)
        .set({ expiresAt: new Date(baseTime + 10_000) })
        .where(eq(chatEndpointLeases.leaseKey, leaseKey));
      await db.transaction(async (tx) => {
        await tx
          .select()
          .from(chatEndpointLeases)
          .where(eq(chatEndpointLeases.leaseKey, leaseKey))
          .for("update");
        const [backend] = (await tx.execute(
          sql`select pg_backend_pid() as pid`,
        )) as unknown as Array<{ pid: number }>;
        release();
        drain = service.processPendingPublications();
        // Observe the real blocker; advancing a clock before the ownership
        // query starts would not distinguish a stale pre-lock decision clock.
        await vi.waitFor(async () => {
          const [state] = (await db.execute(sql`select exists (
            select 1 from pg_stat_activity where ${backend!.pid} = any(pg_blocking_pids(pid))
          ) as waiting`)) as unknown as Array<{ waiting: boolean }>;
          expect(state!.waiting).toBe(true);
        });
        expect(lanes[0]!.providerRuntime.posts).toHaveLength(1);
        vi.setSystemTime(new Date(baseTime + 20_000));
      });
      await drain;
      expect(
        await db
          .select({
            state: chatPublications.state,
            providerMessageId: chatPublications.providerMessageId,
          })
          .from(chatPublications)
          .where(eq(chatPublications.id, publication.id)),
      ).toEqual([{ state: "streaming", providerMessageId: null }]);
      expect(
        await db
          .select()
          .from(chatMessageLinks)
          .where(eq(chatMessageLinks.publicationId, publication.id)),
      ).toHaveLength(0);
      await db
        .update(chatPublications)
        .set({ updatedAt: new Date(Date.now() - 61_000) })
        .where(eq(chatPublications.id, publication.id));
      await service.processPendingPublications();
      expect(
        await db
          .select({
            state: chatPublications.state,
            attempts: chatPublications.attempts,
          })
          .from(chatPublications)
          .where(eq(chatPublications.id, publication.id)),
      ).toEqual([{ state: "delivery_unknown", attempts: 1 }]);
      expect(lanes[0]!.providerRuntime.posts).toHaveLength(1);
    } finally {
      release();
      await drain;
      await fixture.cleanup();
      vi.useRealTimers();
    }
  });

  it("publishes equal-time Slack outbox rows once in stable order across concurrent drains", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture);
    const thread = makeThread({
      channelId: "C-STABLE-OUTBOX",
      id: "slack:C-STABLE-OUTBOX:4075.1",
      name: "stable-outbox",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: thread.thread,
      message: makeMessage({
        id: "4075.1",
        text: "@maya preserve publication order",
        mentioned: true,
      }),
      trigger: "mention",
    });
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    const createdAt = new Date("2026-09-05T15:00:00.000Z");
    const firstId = "00000000-0000-4000-8000-000000000001";
    const secondId = "00000000-0000-4000-8000-000000000002";
    await db.insert(chatPublications).values([
      {
        id: secondId,
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: conversation.id,
        issueId: conversation.issueId,
        idempotencyKey: `ordering:second:${endpoint.id}`,
        payload: { text: "Second publication" },
        state: "pending",
        createdAt,
      },
      {
        id: firstId,
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: conversation.id,
        issueId: conversation.issueId,
        idempotencyKey: `ordering:first:${endpoint.id}`,
        payload: { text: "First publication" },
        state: "pending",
        createdAt,
      },
    ]);

    await Promise.all([
      service.processPendingPublications(),
      service.processPendingPublications(),
    ]);

    expect(runtime.endpoints.get(endpoint.id)?.posts).toEqual([
      { threadId: thread.thread.id, text: "First publication" },
      { threadId: thread.thread.id, text: "Second publication" },
    ]);
    expect(
      await db
        .select({ id: chatPublications.id, state: chatPublications.state })
        .from(chatPublications)
        .where(inArray(chatPublications.id, [firstId, secondId]))
        .orderBy(asc(chatPublications.id)),
    ).toEqual([
      { id: firstId, state: "published" },
      { id: secondId, state: "published" },
    ]);
  });

  it("does not let one blocked Slack conversation starve another outbox head", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture);
    const blockedThread = makeThread({
      channelId: "C-OUTBOX-FAIRNESS",
      id: "slack:C-OUTBOX-FAIRNESS:4080.1",
      name: "outbox-fairness",
    });
    const readyThread = makeThread({
      channelId: "C-OUTBOX-FAIRNESS",
      id: "slack:C-OUTBOX-FAIRNESS:4080.2",
      name: "outbox-fairness",
    });
    for (const [thread, id, text] of [
      [blockedThread, "4080.1", "@maya create the blocked task"],
      [readyThread, "4080.2", "@maya create the ready task"],
    ] as const) {
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        thread: thread.thread,
        message: makeMessage({ id, text, mentioned: true }),
        trigger: "mention",
      });
    }
    const conversations = await readChatConversationsByEndpointId(endpoint.id);
    const blockedConversation = conversations.find(
      (conversation) =>
        conversation.externalThreadId === blockedThread.thread.id,
    );
    const readyConversation = conversations.find(
      (conversation) => conversation.externalThreadId === readyThread.thread.id,
    );
    if (!blockedConversation || !readyConversation) {
      throw new Error("Expected both Slack task conversations");
    }

    const baseTime = new Date("2026-09-05T15:10:00.000Z");
    await db.insert(chatPublications).values([
      {
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: blockedConversation.id,
        issueId: blockedConversation.issueId,
        idempotencyKey: `fairness:unknown:${endpoint.id}`,
        payload: { text: "Ambiguous predecessor" },
        state: "delivery_unknown",
        createdAt: baseTime,
      },
      ...Array.from({ length: 30 }, (_, index) => ({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: blockedConversation.id,
        issueId: blockedConversation.issueId,
        idempotencyKey: `fairness:blocked:${index}:${endpoint.id}`,
        payload: { text: `Blocked publication ${index}` },
        state: "pending" as const,
        createdAt: new Date(baseTime.getTime() + index + 1),
      })),
      {
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: readyConversation.id,
        issueId: readyConversation.issueId,
        idempotencyKey: `fairness:ready:${endpoint.id}`,
        payload: { text: "Ready publication" },
        state: "pending",
        createdAt: new Date(baseTime.getTime() + 60_000),
      },
    ]);

    await service.processPendingPublications(25);

    expect(runtime.endpoints.get(endpoint.id)?.posts).toEqual([
      { threadId: readyThread.thread.id, text: "Ready publication" },
    ]);
    await expect(
      db
        .select({ state: chatPublications.state })
        .from(chatPublications)
        .where(
          eq(chatPublications.idempotencyKey, `fairness:ready:${endpoint.id}`),
        ),
    ).resolves.toEqual([{ state: "published" }]);
    expect(
      await db
        .select({ state: chatPublications.state })
        .from(chatPublications)
        .where(eq(chatPublications.conversationId, blockedConversation.id)),
    ).toEqual(
      expect.arrayContaining([
        { state: "delivery_unknown" },
        ...Array.from({ length: 30 }, () => ({ state: "pending" })),
      ]),
    );
  });

  it("skips paused outbox heads and resumes promptly without bypassing provider backoff", async () => {
    const fixture = await seedCompany();
    const blockedFetch = fakeSlackFetch("U-BLOCKED-OUTBOX");
    const readyFetch = fakeSlackFetch("U-READY-OUTBOX");
    let includeResumeChannel = false;
    const providerFetch = (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const authorization = new Headers(init?.headers).get("authorization");
      if (
        includeResumeChannel &&
        String(input).startsWith("https://slack.com/api/conversations.list") &&
        authorization === "Bearer xoxb-blocked-outbox"
      ) {
        return Promise.resolve(
          Response.json({
            ok: true,
            channels: [
              {
                id: "C-PAUSED-ENDPOINT",
                name: "paused-endpoint",
                is_member: true,
                is_archived: false,
              },
            ],
            response_metadata: { next_cursor: "" },
          }),
        );
      }
      return authorization === "Bearer xoxb-blocked-outbox"
        ? blockedFetch(input, init)
        : readyFetch(input, init);
    };
    const runtime = new FakeChatSdkRuntime();
    const { service } = createService(
      runtime,
      providerFetch as typeof globalThis.fetch,
    );
    const blockedEndpoint = await service.create(
      fixture.companyId,
      { provider: "slack", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    const readyEndpoint = await service.create(
      fixture.companyId,
      { provider: "slack", assignedAgentId: fixture.replacementAgentId },
      "owner-user",
    );
    for (const [endpoint, botToken] of [
      [blockedEndpoint, "xoxb-blocked-outbox"],
      [readyEndpoint, "xoxb-ready-outbox"],
    ] as const) {
      await service.update(endpoint.id, { allowUnlinkedPeople: true }, "owner-user");
      await service.configure(
        endpoint.id,
        {
          action: "configure",
          credentials: {
            botToken,
            signingSecret: `signing-${botToken}`,
          },
        },
        "owner-user",
      );
      await db
        .update(chatEndpoints)
        .set({ status: "active" })
        .where(eq(chatEndpoints.id, endpoint.id));
    }
    const blockedCallbacks = runtime.configurations.get(
      blockedEndpoint.id,
    )?.callbacks;
    const readyCallbacks = runtime.configurations.get(
      readyEndpoint.id,
    )?.callbacks;
    if (!blockedCallbacks || !readyCallbacks) {
      throw new Error("Expected both Slack runtimes");
    }
    await db.insert(chatEndpointResources).values([
      {
        companyId: fixture.companyId,
        endpointId: blockedEndpoint.id,
        type: "channel",
        providerResourceId: "C-PAUSED-ENDPOINT",
        label: "paused-endpoint",
        availability: "available",
        enabled: true,
      },
      {
        companyId: fixture.companyId,
        endpointId: readyEndpoint.id,
        type: "channel",
        providerResourceId: "C-READY-ENDPOINT",
        label: "ready-endpoint",
        availability: "available",
        enabled: true,
      },
    ]);
    const blockedThread = makeThread({
      channelId: "C-PAUSED-ENDPOINT",
      id: "slack:C-PAUSED-ENDPOINT:4081.1",
      name: "paused-endpoint",
    });
    const readyThread = makeThread({
      channelId: "C-READY-ENDPOINT",
      id: "slack:C-READY-ENDPOINT:4081.2",
      name: "ready-endpoint",
    });
    await deliverMessage({
      callbacks: blockedCallbacks,
      endpointId: blockedEndpoint.id,
      message: makeMessage({
        id: "4081.1",
        mentioned: true,
        text: "@maya blocked endpoint",
      }),
      thread: blockedThread.thread,
      trigger: "mention",
    });
    await deliverMessage({
      callbacks: readyCallbacks,
      endpointId: readyEndpoint.id,
      message: makeMessage({
        id: "4081.2",
        mentioned: true,
        text: "@linus healthy endpoint",
      }),
      thread: readyThread.thread,
      trigger: "mention",
    });
    const conversations = await db
      .select()
      .from(chatConversations)
      .where(
        inArray(chatConversations.endpointId, [
          blockedEndpoint.id,
          readyEndpoint.id,
        ]),
      );
    const blockedConversation = conversations.find(
      (conversation) => conversation.endpointId === blockedEndpoint.id,
    );
    const readyConversation = conversations.find(
      (conversation) => conversation.endpointId === readyEndpoint.id,
    );
    if (!blockedConversation || !readyConversation) {
      throw new Error("Expected both endpoint conversations");
    }
    const [blockedSetup] = await db
      .select({ setup: chatEndpoints.setup })
      .from(chatEndpoints)
      .where(eq(chatEndpoints.id, blockedEndpoint.id));
    await db
      .update(chatEndpoints)
      .set({ setup: { ...blockedSetup.setup, step: "complete" } })
      .where(eq(chatEndpoints.id, blockedEndpoint.id));
    await service.configure(
      blockedEndpoint.id,
      { action: "pause" },
      "owner-user",
    );
    const createdAt = new Date("2026-09-05T15:11:00.000Z");
    const providerRetryAt = new Date(Date.now() + 60_000);
    await db.insert(chatPublications).values([
      {
        companyId: fixture.companyId,
        endpointId: blockedEndpoint.id,
        conversationId: blockedConversation.id,
        issueId: blockedConversation.issueId,
        idempotencyKey: `paused-endpoint:${blockedEndpoint.id}`,
        payload: { text: "Blocked by paused endpoint" },
        state: "pending",
        createdAt,
      },
      {
        companyId: fixture.companyId,
        endpointId: readyEndpoint.id,
        conversationId: readyConversation.id,
        issueId: readyConversation.issueId,
        idempotencyKey: `ready-endpoint:${readyEndpoint.id}`,
        payload: { text: "Healthy endpoint publication" },
        state: "pending",
        createdAt: new Date(createdAt.getTime() + 1),
      },
      {
        companyId: fixture.companyId,
        endpointId: blockedEndpoint.id,
        conversationId: blockedConversation.id,
        issueId: blockedConversation.issueId,
        idempotencyKey: `provider-backoff:${blockedEndpoint.id}`,
        payload: { text: "Provider rate limit still applies" },
        state: "retry",
        attempts: 2,
        nextAttemptAt: providerRetryAt,
        createdAt: new Date(createdAt.getTime() + 2),
      },
    ]);

    // Even the smallest global page must skip paused work without consuming
    // its attempt budget or imposing an artificial resume deadline.
    try {
      await service.processPendingPublications(1);

      await expect(
        db
          .select({
            idempotencyKey: chatPublications.idempotencyKey,
            nextAttemptAt: chatPublications.nextAttemptAt,
            state: chatPublications.state,
          })
          .from(chatPublications)
          .where(
            inArray(chatPublications.idempotencyKey, [
              `paused-endpoint:${blockedEndpoint.id}`,
              `ready-endpoint:${readyEndpoint.id}`,
            ]),
          )
          .orderBy(asc(chatPublications.createdAt)),
      ).resolves.toEqual([
        {
          idempotencyKey: `paused-endpoint:${blockedEndpoint.id}`,
          nextAttemptAt: null,
          state: "pending",
        },
        {
          idempotencyKey: `ready-endpoint:${readyEndpoint.id}`,
          nextAttemptAt: null,
          state: "published",
        },
      ]);
      expect(runtime.endpoints.get(readyEndpoint.id)?.posts).toEqual([
        {
          text: "Healthy endpoint publication",
          threadId: readyThread.thread.id,
        },
      ]);
      includeResumeChannel = true;
      await service.configure(
        blockedEndpoint.id,
        { action: "resume" },
        "owner-user",
      );
      await service.processPendingPublications(1);
      expect(runtime.endpoints.get(blockedEndpoint.id)?.posts).toEqual([
        {
          text: "Blocked by paused endpoint",
          threadId: blockedThread.thread.id,
        },
      ]);
      await expect(
        db
          .select({
            state: chatPublications.state,
            attempts: chatPublications.attempts,
            nextAttemptAt: chatPublications.nextAttemptAt,
          })
          .from(chatPublications)
          .where(
            eq(
              chatPublications.idempotencyKey,
              `provider-backoff:${blockedEndpoint.id}`,
            ),
          ),
      ).resolves.toEqual([
        { state: "retry", attempts: 2, nextAttemptAt: providerRetryAt },
      ]);
    } finally {
      // Deliberate pending fixtures must not leak into later shared-DB tests,
      // even when a fairness or resume assertion fails.
      await db
        .update(chatPublications)
        .set({ state: "cancelled", nextAttemptAt: null })
        .where(
          and(
            inArray(chatPublications.idempotencyKey, [
              `paused-endpoint:${blockedEndpoint.id}`,
              `ready-endpoint:${readyEndpoint.id}`,
              `provider-backoff:${blockedEndpoint.id}`,
            ]),
            inArray(chatPublications.state, ["pending", "retry"]),
          ),
        );
      await service.shutdown();
    }
  });
});
