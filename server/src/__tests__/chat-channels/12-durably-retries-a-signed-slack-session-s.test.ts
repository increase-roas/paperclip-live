import { DELIVERY_QUEUES, subscribeDeliveryWork } from "../../services/delivery-work-notifications.js";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { expect, it, onTestFinished, vi } from "vitest";
import { activityLog, agentWakeupRequests, chatActions, chatDeliveries, chatEndpointLeases, chatExternalPrincipals, chatPublications, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { chatChannelService, type ChatChannelServiceOptions } from "../../services/chat-channels.js";
import type { ChatSdkRuntime } from "../../services/chat-sdk-runtime.js";
import { enqueueChatRunMilestones } from "../../services/chat-run-publications.js";
import { FakeChatSdkRuntime, fakeSlackFetch, makeMessage, makeThread } from ".././helpers/chat-channels-fixture.js";
import { chatWakeContext, configuredSlackEndpoint, createService, db, deliverMessage, describeChatChannelsSuite, qualifySetupRoundTrip, readChatConversationsByEndpointId, readChatDeliveriesByEndpointId, receiptBackedWakeup, recordSlackUrlVerification, seedCompany, signedSlackWebhookRequest } from "../helpers/chat-channels-harness.js";









describeChatChannelsSuite("chat channels 12-durably-retries-a-signed-slack-session-s", () => {
  it("durably retries a signed Slack session stop and cancels its exact linked run once", async () => {
    const fixture = await seedCompany();
    let cancellationAttempt = 0;
    const cancelRun = vi.fn(async (runId: string) => {
      cancellationAttempt += 1;
      if (cancellationAttempt === 1) {
        throw new Error("synthetic cancellation transport failure");
      }
      await db
        .update(heartbeatRuns)
        .set({
          status: "cancelled",
          errorCode: "slack_session_stopped",
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, runId));
      return { id: runId, status: "cancelled" };
    });
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture, { cancelRun });
    const workWake = vi.fn();
    const stopWorkObserver = subscribeDeliveryWork(db, DELIVERY_QUEUES.chatSessionStops, workWake);
    onTestFinished(() => { stopWorkObserver(); expect(workWake).toHaveBeenCalled(); });
    const externalUserId = "USTOPPER1";
    const channelId = "CSTOPSESSION1";
    const threadTs = `${Math.floor(Date.now() / 1_000) - 5}.100000`;
    const thread = makeThread({
      channelId,
      id: `slack:${channelId}:${threadTs}`,
      name: "slack-session-stop",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: thread.thread,
      message: makeMessage({
        id: threadTs,
        text: "@maya keep this run cancellable",
        mentioned: true,
        userId: externalUserId,
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id, externalUserId);
    await service.test(endpoint.id);
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    const providerAccountId = (await service.get(endpoint.id))
      .providerAccountId;
    const principal = await db
      .select()
      .from(chatExternalPrincipals)
      .where(
        and(
          eq(chatExternalPrincipals.companyId, fixture.companyId),
          eq(chatExternalPrincipals.provider, "slack"),
          eq(
            chatExternalPrincipals.providerAccountId,
            providerAccountId ?? "unknown",
          ),
          eq(chatExternalPrincipals.externalId, externalUserId),
        ),
      )
      .then((rows) => rows[0]);
    if (!conversation || !principal) {
      throw new Error("Expected Slack stop conversation and principal");
    }
    const intent = await service.createLinkIntent(
      endpoint.id,
      principal.id,
      1_800,
    );
    const token = new URL(intent.confirmationUrl).searchParams.get("token");
    if (!token) throw new Error("Expected Slack identity-link token");
    await service.confirmIdentityLink(token, "owner-user");

    const eventSecond = Math.floor(Date.now() / 1_000);
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: fixture.companyId,
      agentId: fixture.assignedAgentId,
      status: "running",
      createdAt: new Date((eventSecond - 2) * 1_000),
      startedAt: new Date((eventSecond - 1) * 1_000),
      contextSnapshot: await chatWakeContext({
        endpointId: endpoint.id,
        issueId: conversation.issueId,
        provider: "slack",
        providerMessageId: threadTs,
      }),
    });
    await db
      .update(issues)
      .set({
        executionRunId: runId,
        status: "in_progress",
        updatedAt: new Date(),
      })
      .where(eq(issues.id, conversation.issueId));
    await enqueueChatRunMilestones(db);
    await service.processPendingPublications(1_000);
    await expect(
      db
        .select({ state: chatPublications.state })
        .from(chatPublications)
        .where(
          eq(
            chatPublications.idempotencyKey,
            `run:${runId}:working:${endpoint.id}`,
          ),
        ),
    ).resolves.toEqual([{ state: "published" }]);
    const body = JSON.stringify({
      type: "event_callback",
      team_id: (await service.get(endpoint.id)).providerAccountId,
      event_id: "EvSlackSessionStopRetry1",
      event: {
        type: "agent_session_stopped",
        channel: channelId,
        thread_ts: threadTs,
        event_ts: `${eventSecond}.123456`,
        streaming_message_ts: [`${eventSecond - 1}.500000`],
        user: externalUserId,
      },
    });
    const webhookUrl = `https://paperclip.example/api/chat-webhooks/${endpoint.publicId}/slack`;
    workWake.mockClear();
    const first = await service.handleWebhook(
      endpoint.publicId,
      "slack",
      signedSlackWebhookRequest({
        body,
        contentType: "application/json",
        url: webhookUrl,
      }),
    );
    expect(first.status).toBe(202);
    expect(cancelRun).toHaveBeenCalledTimes(1);
    const stopAction = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.kind, "slack_session_stop"),
        ),
      )
      .then((rows) => rows[0]);
    expect(stopAction).toMatchObject({
      conversationId: conversation.id,
      principalId: principal.id,
      status: "failed",
      payload: {
        issueId: conversation.issueId,
        sessionGeneration: conversation.sessionGeneration,
        target: { id: runId, kind: "run" },
        threadId: thread.thread.id,
        userId: externalUserId,
      },
      result: {
        attempts: 1,
        code: "slack_session_stop_cancellation_failed",
        retryable: true,
      },
    });
    await expect(
      service.processPendingSlackSessionStops(25, stopAction!.id),
    ).resolves.toBe(0);
    expect(cancelRun).toHaveBeenCalledTimes(1);
    await db
      .update(chatActions)
      .set({
        result: {
          ...(stopAction?.result ?? {}),
          retryAt: new Date(Date.now() - 1_000).toISOString(),
        },
        updatedAt: new Date(),
      })
      .where(eq(chatActions.id, stopAction!.id));
    await expect(
      service.processPendingSlackSessionStops(25, stopAction!.id),
    ).resolves.toBe(1);
    expect(cancelRun).toHaveBeenCalledTimes(2);
    expect(cancelRun).toHaveBeenNthCalledWith(
      2,
      runId,
      "Stopped from the bound Slack agent session",
      expect.objectContaining({
        errorCode: "slack_session_stopped",
        resultJson: {
          cancelledByActorType: "user",
          cancelledByUserId: "owner-user",
        },
        eventPayload: expect.objectContaining({
          conversationId: conversation.id,
          endpointId: endpoint.id,
          provider: "slack",
        }),
      }),
    );
    await expect(
      db
        .select({ status: chatActions.status, result: chatActions.result })
        .from(chatActions)
        .where(eq(chatActions.id, stopAction!.id)),
    ).resolves.toEqual([
      {
        status: "processed",
        result: {
          attempts: 2,
          code: "slack_session_stop_cancelled",
          runId,
        },
      },
    ]);
    await expect(
      db
        .select({ action: activityLog.action, actorId: activityLog.actorId })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.entityType, "chat_action"),
            eq(activityLog.entityId, stopAction!.id),
          ),
        ),
    ).resolves.toEqual([
      { action: "chat.slack_session_stopped", actorId: "owner-user" },
    ]);
    await service.processPendingPublications(1_000);
    expect(
      runtime.endpoints
        .get(endpoint.id)
        ?.edits.some((edit) => edit.text === "Maya stopped at your request.") ??
        false,
    ).toBe(true);

    await service.handleWebhook(
      endpoint.publicId,
      "slack",
      signedSlackWebhookRequest({
        body,
        contentType: "application/json",
        url: webhookUrl,
      }),
    );
    expect(cancelRun).toHaveBeenCalledTimes(2);
    await expect(
      db
        .select({ id: chatActions.id })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(chatActions.kind, "slack_session_stop"),
          ),
        ),
    ).resolves.toHaveLength(1);
    await service.shutdown();
  });

  it("denies guest Slack stops, fences delayed events from newer runs, and cancels queued wakes", async () => {
    const fixture = await seedCompany();
    const cancelRun = vi.fn<NonNullable<ChatChannelServiceOptions["heartbeat"]["cancelRun"]>>(async () => ({ status: "cancelled" }));
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture, {
        allowUnlinkedPeople: true,
        cancelRun,
      });
    const externalUserId = "USTOPPER2";
    const channelId = "CSTOPSESSION2";
    const threadTs = `${Math.floor(Date.now() / 1_000) - 10}.200000`;
    const thread = makeThread({
      channelId,
      id: `slack:${channelId}:${threadTs}`,
      name: "slack-session-governance",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: thread.thread,
      message: makeMessage({
        id: threadTs,
        text: "@maya create a guest-started task",
        mentioned: true,
        userId: externalUserId,
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id, externalUserId);
    await service.test(endpoint.id);
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    const providerAccountId = (await service.get(endpoint.id))
      .providerAccountId;
    const principal = await db
      .select()
      .from(chatExternalPrincipals)
      .where(
        and(
          eq(chatExternalPrincipals.companyId, fixture.companyId),
          eq(chatExternalPrincipals.provider, "slack"),
          eq(
            chatExternalPrincipals.providerAccountId,
            providerAccountId ?? "unknown",
          ),
          eq(chatExternalPrincipals.externalId, externalUserId),
        ),
      )
      .then((rows) => rows[0]);
    if (!conversation || !principal) {
      throw new Error("Expected Slack governance conversation and principal");
    }
    const webhookUrl = `https://paperclip.example/api/chat-webhooks/${endpoint.publicId}/slack`;
    const workspaceId = (await service.get(endpoint.id)).providerAccountId;
    const sendStop = (input: { eventId: string; eventSecond: number }) => {
      const body = JSON.stringify({
        type: "event_callback",
        team_id: workspaceId,
        event_id: input.eventId,
        event: {
          type: "agent_session_stopped",
          channel: channelId,
          thread_ts: threadTs,
          event_ts: `${input.eventSecond}.234567`,
          streaming_message_ts: [],
          user: externalUserId,
        },
      });
      return service.handleWebhook(
        endpoint.publicId,
        "slack",
        signedSlackWebhookRequest({
          body,
          contentType: "application/json",
          url: webhookUrl,
        }),
      );
    };

    const guestEventSecond = Math.floor(Date.now() / 1_000);
    const guestRunId = randomUUID();
    // The stub scheduler's initial admission is now represented by the
    // running run seeded below, not an extra queued target for Slack Stop.
    await db
      .update(agentWakeupRequests)
      .set({ status: "claimed", runId: guestRunId })
      .where(eq(agentWakeupRequests.companyId, fixture.companyId));
    await db.insert(heartbeatRuns).values({
      id: guestRunId,
      companyId: fixture.companyId,
      agentId: fixture.assignedAgentId,
      status: "running",
      createdAt: new Date((guestEventSecond - 2) * 1_000),
      startedAt: new Date((guestEventSecond - 1) * 1_000),
      contextSnapshot: {
        issueId: conversation.issueId,
        source: "chat:slack",
      },
    });
    await db
      .update(issues)
      .set({ executionRunId: guestRunId, status: "in_progress" })
      .where(eq(issues.id, conversation.issueId));
    await expect(
      sendStop({
        eventId: "EvSlackGuestStopDenied1",
        eventSecond: guestEventSecond,
      }),
    ).resolves.toMatchObject({ status: 202 });
    expect(cancelRun).not.toHaveBeenCalled();
    await expect(
      db
        .select({ status: chatActions.status, result: chatActions.result })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(
              chatActions.providerActionId,
              "slack_session_stop:EvSlackGuestStopDenied1",
            ),
          ),
        ),
    ).resolves.toEqual([
      {
        status: "cancelled",
        result: {
          attempts: 1,
          code: "slack_session_stop_no_longer_authorized",
          retryable: false,
        },
      },
    ]);

    const intent = await service.createLinkIntent(
      endpoint.id,
      principal.id,
      1_800,
    );
    const token = new URL(intent.confirmationUrl).searchParams.get("token");
    if (!token) throw new Error("Expected Slack identity-link token");
    await service.confirmIdentityLink(token, "owner-user");
    await db
      .update(heartbeatRuns)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, guestRunId));

    const delayedEventSecond = Math.floor(Date.now() / 1_000) - 5;
    const newerRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: newerRunId,
      companyId: fixture.companyId,
      agentId: fixture.assignedAgentId,
      status: "running",
      // This run begins less than one second after Slack's fractional Stop
      // timestamp. It is already newer work and must not inherit that Stop.
      createdAt: new Date(delayedEventSecond * 1_000 + 500),
      startedAt: new Date(delayedEventSecond * 1_000 + 750),
      contextSnapshot: {
        issueId: conversation.issueId,
        source: "chat:slack",
      },
    });
    await db
      .update(issues)
      .set({ executionRunId: newerRunId, updatedAt: new Date() })
      .where(eq(issues.id, conversation.issueId));
    await expect(
      sendStop({
        eventId: "EvSlackDelayedStopBeforeNewRun1",
        eventSecond: delayedEventSecond,
      }),
    ).resolves.toMatchObject({ status: 202 });
    expect(cancelRun).not.toHaveBeenCalled();
    await expect(
      db
        .select({ status: chatActions.status, payload: chatActions.payload })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(
              chatActions.providerActionId,
              "slack_session_stop:EvSlackDelayedStopBeforeNewRun1",
            ),
          ),
        ),
    ).resolves.toEqual([
      expect.objectContaining({
        status: "cancelled",
        payload: expect.objectContaining({ target: null }),
      }),
    ]);

    await db
      .update(heartbeatRuns)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, newerRunId));
    await db
      .update(issues)
      .set({ executionRunId: null, updatedAt: new Date() })
      .where(eq(issues.id, conversation.issueId));
    const queuedAt = new Date(Date.now() - 1_000);
    const [queuedWake] = await db
      .insert(agentWakeupRequests)
      .values({
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        source: "assignment",
        status: "queued",
        payload: { issueId: conversation.issueId },
        requestedAt: queuedAt,
      })
      .returning();
    const queuedEventSecond = Math.floor(Date.now() / 1_000);
    await expect(
      sendStop({
        eventId: "EvSlackQueuedWakeStop1",
        eventSecond: queuedEventSecond,
      }),
    ).resolves.toMatchObject({ status: 202 });
    expect(cancelRun).not.toHaveBeenCalled();
    await expect(
      db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, queuedWake!.id)),
    ).resolves.toEqual([{ status: "cancelled" }]);
    await expect(
      db
        .select({ status: chatActions.status, result: chatActions.result })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(
              chatActions.providerActionId,
              "slack_session_stop:EvSlackQueuedWakeStop1",
            ),
          ),
        ),
    ).resolves.toEqual([
      {
        status: "processed",
        result: {
          attempts: 1,
          code: "slack_session_stop_cancelled",
          retryable: false,
        },
      },
    ]);
    await service.processPendingPublications(1_000);
    expect(
      runtime.endpoints
        .get(endpoint.id)
        ?.posts.some((post) => post.text === "Maya stopped at your request.") ??
        false,
    ).toBe(true);

    const finishedRaceEventSecond = Math.floor(Date.now() / 1_000);
    const finishedRaceRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: finishedRaceRunId,
      companyId: fixture.companyId,
      agentId: fixture.assignedAgentId,
      status: "running",
      createdAt: new Date((finishedRaceEventSecond - 2) * 1_000),
      startedAt: new Date((finishedRaceEventSecond - 1) * 1_000),
      contextSnapshot: {
        issueId: conversation.issueId,
        source: "chat:slack",
      },
    });
    await db
      .update(issues)
      .set({ executionRunId: finishedRaceRunId, updatedAt: new Date() })
      .where(eq(issues.id, conversation.issueId));
    cancelRun.mockImplementationOnce(async (runId) => {
      await db
        .update(heartbeatRuns)
        .set({
          status: "succeeded",
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, runId));
      return { id: runId, status: "succeeded" };
    });
    await expect(
      sendStop({
        eventId: "EvSlackStopLosesToFinishedRun1",
        eventSecond: finishedRaceEventSecond,
      }),
    ).resolves.toMatchObject({ status: 202 });
    expect(cancelRun).toHaveBeenCalledTimes(1);
    await expect(
      db
        .select({ status: chatActions.status, result: chatActions.result })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(
              chatActions.providerActionId,
              "slack_session_stop:EvSlackStopLosesToFinishedRun1",
            ),
          ),
        ),
    ).resolves.toEqual([
      {
        status: "cancelled",
        result: {
          attempts: 1,
          code: "slack_session_stop_target_superseded",
          runId: finishedRaceRunId,
        },
      },
    ]);
    await service.shutdown();

    const promotedWakeEventSecond = Math.floor(Date.now() / 1_000);
    await db
      .update(issues)
      .set({ executionRunId: null, updatedAt: new Date() })
      .where(eq(issues.id, conversation.issueId));
    const [promotedWake] = await db
      .insert(agentWakeupRequests)
      .values({
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        source: "assignment",
        status: "queued",
        payload: { issueId: conversation.issueId },
        requestedAt: new Date((promotedWakeEventSecond - 1) * 1_000),
      })
      .returning();
    if (!promotedWake) throw new Error("Expected queued wake to promote");
    const deferred: Array<() => void> = [];
    const promotedCancelRun = vi.fn(async (runId: string) =>
      db
        .update(heartbeatRuns)
        .set({
          status: "cancelled",
          errorCode: "slack_session_stopped",
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, runId))
        .returning()
        .then((rows) => rows[0] ?? null),
    );
    const recovery = createService(
      new FakeChatSdkRuntime(),
      fakeSlackFetch() as typeof globalThis.fetch,
      {
        cancelRun: promotedCancelRun,
        deferWebhookProcessing: true,
        scheduleDeferredWork: (task) => deferred.push(task),
      },
    );
    const promotedBody = JSON.stringify({
      type: "event_callback",
      team_id: providerAccountId,
      event_id: "EvSlackQueuedWakePromotedAfterStop1",
      event: {
        type: "agent_session_stopped",
        channel: channelId,
        thread_ts: threadTs,
        event_ts: `${promotedWakeEventSecond}.123456`,
        streaming_message_ts: [],
        user: externalUserId,
      },
    });
    await expect(
      recovery.service.handleWebhook(
        endpoint.publicId,
        "slack",
        signedSlackWebhookRequest({
          body: promotedBody,
          contentType: "application/json",
          url: webhookUrl,
        }),
      ),
    ).resolves.toMatchObject({ status: 202 });
    expect(deferred).toHaveLength(1);
    expect(promotedCancelRun).not.toHaveBeenCalled();
    const promotedAction = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpoint.id),
          eq(
            chatActions.providerActionId,
            "slack_session_stop:EvSlackQueuedWakePromotedAfterStop1",
          ),
        ),
      )
      .then((rows) => rows[0]);
    expect(promotedAction).toMatchObject({
      status: "received",
      payload: { target: { id: promotedWake.id, kind: "wakeup" } },
    });

    const promotedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: promotedRunId,
      companyId: fixture.companyId,
      agentId: fixture.assignedAgentId,
      status: "running",
      wakeupRequestId: promotedWake.id,
      // Promotion happens after Slack's Stop instant, but this run remains the
      // exact durable continuation of the wake snapshotted before that instant.
      createdAt: new Date(promotedWakeEventSecond * 1_000 + 500),
      startedAt: new Date(promotedWakeEventSecond * 1_000 + 750),
      contextSnapshot: { issueId: conversation.issueId },
    });
    await db
      .update(agentWakeupRequests)
      .set({
        status: "claimed",
        runId: promotedRunId,
        claimedAt: new Date(promotedWakeEventSecond * 1_000 + 500),
        updatedAt: new Date(),
      })
      .where(eq(agentWakeupRequests.id, promotedWake.id));
    await db
      .update(issues)
      .set({ executionRunId: promotedRunId, updatedAt: new Date() })
      .where(eq(issues.id, conversation.issueId));
    deferred.shift()?.();
    await vi.waitFor(async () => {
      const settled = await db
        .select({ status: chatActions.status, result: chatActions.result })
        .from(chatActions)
        .where(eq(chatActions.id, promotedAction!.id))
        .then((rows) => rows[0]);
      expect(settled).toEqual({
        status: "processed",
        result: {
          attempts: 1,
          code: "slack_session_stop_cancelled",
          runId: promotedRunId,
        },
      });
    });
    expect(promotedCancelRun).toHaveBeenCalledOnce();
    expect(promotedCancelRun).toHaveBeenCalledWith(
      promotedRunId,
      "Stopped from the bound Slack agent session",
      expect.objectContaining({ errorCode: "slack_session_stopped" }),
    );
    await recovery.service.shutdown();
  });

  it("reorders rapid Slack callbacks by provider time before one conversation drain", async () => {
    const fixture = await seedCompany();
    const runtime = new FakeChatSdkRuntime();
    const deferred: Array<() => void | Promise<void>> = [];
    let releaseFirstDelivery!: () => void;
    let signalFirstDelivery!: () => void;
    const firstDeliveryEntered = new Promise<void>((resolve) => { signalFirstDelivery = resolve; });
    const firstDeliveryReleased = new Promise<void>((resolve) => { releaseFirstDelivery = resolve; });
    let firstDelivery = true;
    const wakeup = vi.fn<ChatChannelServiceOptions["heartbeat"]["wakeup"]>(async () => ({ accepted: true }));
    const service = chatChannelService(db, {
      deferWebhookProcessing: true,
      fetch: fakeSlackFetch() as typeof globalThis.fetch,
      heartbeat: { wakeup: receiptBackedWakeup(wakeup) },
      publicBaseUrl: "https://paperclip.example",
      runtime: runtime as unknown as ChatSdkRuntime,
      scheduleDeferredWork: (task) => deferred.push(task),
      reachAuthorizationBarrier: async () => {
        if (!firstDelivery) return;
        firstDelivery = false;
        signalFirstDelivery();
        await firstDeliveryReleased;
      },
    });
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "slack", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await service.update(endpoint.id, { allowUnlinkedPeople: true, requireAtMention: false }, "owner-user");
    await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          botToken: "xoxb-async-ingress",
          signingSecret: "async-ingress-secret",
        },
      },
      "owner-user",
    );
    await recordSlackUrlVerification(service, endpoint.publicId, "async-ingress-secret");
    await service.configure(endpoint.id, { action: "verify" }, "owner-user");
    const callbacks = runtime.configurations.get(endpoint.id)?.callbacks;
    if (!callbacks) throw new Error("Expected endpoint callbacks");
    const slackTimestamp = (milliseconds: number) =>
      `${Math.floor(Date.parse("2026-09-05T17:50:03.000Z") / 1_000)}.${String(milliseconds * 1_000).padStart(6, "0")}`;
    const thread = makeThread({
      channelId: "C-ASYNC",
      id: `slack:C-ASYNC:${slackTimestamp(200)}`,
      name: "async-ingress",
    });

    const laterReply = makeMessage({
      id: slackTimestamp(517),
      raw: { ts: slackTimestamp(517) },
      text: "and include the rollback status",
    });
    laterReply.metadata.dateSent = new Date("2026-09-05T17:50:03.517Z");
    // Slack Events API callbacks use independent HTTP requests. Reproduce the
    // live failure by receiving the later provider message first.
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: thread.thread,
      message: laterReply,
      trigger: "subscribed_message",
    });
    const earlierMention = makeMessage({
      id: slackTimestamp(200),
      raw: { ts: slackTimestamp(200) },
      text: "@maya acknowledge quickly",
      mentioned: true,
    });
    earlierMention.metadata.dateSent = new Date("2026-09-05T17:50:03.200Z");
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: thread.thread,
      message: earlierMention,
      trigger: "mention",
    });
    for (let index = 3; index <= 8; index += 1) {
      const followUp = makeMessage({
        id: slackTimestamp(index * 100),
        raw: { ts: slackTimestamp(index * 100) },
        text: `follow-up ${index}`,
      });
      followUp.metadata.dateSent = new Date(`2026-09-05T17:50:03.${index}00Z`);
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        thread: thread.thread,
        message: followUp,
        trigger: "subscribed_message",
      });
    }

    const durable = await readChatDeliveriesByEndpointId(endpoint.id);
    expect(durable).toHaveLength(8);
    expect(durable.every((delivery) => delivery.nextAttemptAt !== null)).toBe(
      true,
    );
    // The first callback fixes one bounded batch deadline. Later arrivals do
    // not slide it forward and therefore cannot starve a busy conversation.
    expect(
      new Set(
        durable.map((delivery) => delivery.nextAttemptAt?.getTime() ?? null),
      ).size,
    ).toBe(1);
    expect(durable).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerEventId: `${thread.thread.id}:${earlierMention.id}`,
          state: "received",
          attempts: 0,
        }),
        expect.objectContaining({
          providerEventId: `${thread.thread.id}:${laterReply.id}`,
          state: "received",
          attempts: 0,
        }),
      ]),
    );
    expect(
      await readChatConversationsByEndpointId(endpoint.id),
    ).toHaveLength(0);
    expect(deferred).toHaveLength(1);

    const competingService = chatChannelService(db, {
      fetch: fakeSlackFetch() as typeof globalThis.fetch,
      heartbeat: { wakeup: receiptBackedWakeup(wakeup) },
      publicBaseUrl: "https://paperclip.example",
      runtime: new FakeChatSdkRuntime() as unknown as ChatSdkRuntime,
    });
    let drainSettled = false;
    const draining = Promise.resolve(deferred.shift()?.()).then(() => { drainSettled = true; });
    try {
      // Hold the deferred owner after it acquires the conversation lease. The
      // competing sweep must finish without overtaking that owner.
      await firstDeliveryEntered;
      await competingService.processPendingDeliveries();
      expect(drainSettled).toBe(false);
      expect(wakeup.mock.calls.filter((call) => call[0] === fixture.assignedAgentId)).toHaveLength(0);
      releaseFirstDelivery();
      await draining;
      expect(drainSettled).toBe(true);
      const conversations = await readChatConversationsByEndpointId(endpoint.id);
      expect(conversations).toHaveLength(1);
      const [conversation] = conversations;
      const comments = await db
        .select({ id: issueComments.id, body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, conversation.issueId))
        .orderBy(asc(issueComments.createdAt), asc(issueComments.id));
      expect(comments.map((comment) => comment.body)).toEqual([
        "@maya acknowledge quickly",
        "follow-up 3",
        "follow-up 4",
        "follow-up 5",
        "and include the rollback status",
        "follow-up 6",
        "follow-up 7",
        "follow-up 8",
      ]);
      // Joining the owner includes all comment admissions, durable wakeups and
      // lease release. These assertions do not race a one-second polling budget.
      expect(comments).toHaveLength(8);
      const calls = wakeup.mock.calls.filter((call) => call[0] === fixture.assignedAgentId);
      expect(calls).toHaveLength(8);
      expect(calls.map((call) => call[1]?.payload?.wakeCommentId)).toEqual(comments.map((comment) => comment.id));
      expect(
        await db.select().from(chatEndpointLeases).where(eq(chatEndpointLeases.endpointId, endpoint.id)),
      ).toHaveLength(0);
    } finally {
      releaseFirstDelivery();
      await draining;
      await competingService.shutdown();
      await service.shutdown();
    }
  });

  it("stops a conversation drain after its lease renewal fails", async () => {
    const fixture = await seedCompany();
    const deferred: Array<() => void> = [];
    let releaseFirstDelivery!: () => void;
    let signalFirstDelivery!: () => void;
    let signalRenewal!: () => void;
    const firstDeliveryEntered = new Promise<void>((resolve) => {
      signalFirstDelivery = resolve;
    });
    const firstDeliveryReleased = new Promise<void>((resolve) => {
      releaseFirstDelivery = resolve;
    });
    const renewalAttempted = new Promise<void>((resolve) => {
      signalRenewal = resolve;
    });
    let reachChecks = 0;
    const renewConversationDeliveryLease = vi.fn(async (): Promise<boolean> => {
      signalRenewal();
      throw new Error("simulated lease-renewal database outage");
    });
    const { callbacks, endpoint, service, wakeup } =
      await configuredSlackEndpoint(fixture, {
        conversationLeaseRenewalIntervalMs: 5,
        deferWebhookProcessing: true,
        reachAuthorizationBarrier: async () => {
          reachChecks += 1;
          if (reachChecks !== 1) return;
          signalFirstDelivery();
          await firstDeliveryReleased;
        },
        renewConversationDeliveryLease,
        scheduleDeferredWork: (task) => deferred.push(task),
      });
    const thread = makeThread({
      channelId: "C-LEASE-FAILURE",
      id: "slack:C-LEASE-FAILURE:9300.1",
      name: "lease-failure",
    });
    const first = makeMessage({
      id: "9300.1",
      mentioned: true,
      text: "@maya process only this turn under the current lease",
    });
    first.metadata.dateSent = new Date("2026-09-06T15:00:00.100Z");
    const second = makeMessage({
      id: "9300.2",
      text: "do not overtake a failed lease renewal",
    });
    second.metadata.dateSent = new Date("2026-09-06T15:00:00.200Z");
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: thread.thread,
      message: first,
      trigger: "mention",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: thread.thread,
      message: second,
      trigger: "subscribed_message",
    });
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: null })
      .where(eq(chatDeliveries.endpointId, endpoint.id));

    // This suite shares its database. Drain only this fixture's conversation;
    // a global recovery pass can renew unrelated retained deliveries with this
    // test's failure hook and make its ownership assertion depend on test order.
    const [firstDelivery] = await db
      .select({ id: chatDeliveries.id })
      .from(chatDeliveries)
      .where(and(
        eq(chatDeliveries.endpointId, endpoint.id),
        eq(chatDeliveries.providerEventId, `${thread.thread.id}:${first.id}`),
      ));
    if (!firstDelivery) throw new Error("Expected first delivery");
    const processing = service.processPendingDeliveries(25, firstDelivery.id);
    await firstDeliveryEntered;
    await renewalAttempted;
    releaseFirstDelivery();
    await processing;

    const states = await db
      .select({
        providerEventId: chatDeliveries.providerEventId,
        state: chatDeliveries.state,
      })
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          inArray(chatDeliveries.eventKind, ["mention", "message"]),
        ),
      )
      .orderBy(asc(chatDeliveries.receivedAt));
    expect(states).toEqual([
      {
        providerEventId: `${thread.thread.id}:9300.1`,
        state: "processed",
      },
      {
        providerEventId: `${thread.thread.id}:9300.2`,
        state: "received",
      },
    ]);
    expect(renewConversationDeliveryLease).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(deferred.length).toBeGreaterThan(0);

    // The failed renewal deliberately strands the second durable row. Settle
    // it through a fresh, explicitly targeted drain before this shared-database
    // test ends; otherwise a later global recovery pass correctly picks it up
    // with that later service's injected heartbeat client and pollutes its mock
    // call count. This also proves lease loss stops only the owning drain rather
    // than making the remaining delivery unrecoverable.
    const pendingDelivery = await db
      .select({ id: chatDeliveries.id })
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(
            chatDeliveries.providerEventId,
            `${thread.thread.id}:${second.id}`,
          ),
          eq(chatDeliveries.state, "received"),
        ),
      )
      .then((rows) => rows[0]);
    if (!pendingDelivery) throw new Error("Expected stranded second delivery");
    renewConversationDeliveryLease.mockResolvedValue(true);
    await service.processPendingDeliveries(25, pendingDelivery.id);
    await expect(
      db
        .select({ state: chatDeliveries.state })
        .from(chatDeliveries)
        .where(eq(chatDeliveries.id, pendingDelivery.id)),
    ).resolves.toEqual([{ state: "processed" }]);
    expect(wakeup).toHaveBeenCalledTimes(2);
    await service.shutdown();
  });
});
