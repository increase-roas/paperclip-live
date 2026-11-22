import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, like } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { authUsers, chatDeliveries, chatEndpointLeases, chatEndpoints, chatExternalPrincipals, chatIdentityLinks, chatPublications, companyMemberships, heartbeatRuns, issueComments } from "@paperclipai/db";
import type { Message } from "chat";
import { issueService } from "../../services/issues.js";
import { enqueueChatRunMilestones, resolveChatRunPresentationAuthorizationReason } from "../../services/chat-run-publications.js";
import { FakeChatSdkRuntime, fakeSlackFetch, fakeTelegramFetch, makeMessage, makeThread } from ".././helpers/chat-channels-fixture.js";
import { chatWakeContext, configuredSlackEndpoint, configuredTelegramEndpoint, createService, db, deliverMessage, describeChatChannelsSuite, qualifySetupRoundTrip, readChatConversationsByEndpointId, readChatDeliveriesByEndpointId, readChatPublicationsByCommentId, readChatPublicationsById, readChatPublicationsByIdempotencyKey, readHeartbeatRunsById, readIssueCommentsByIssueId, seedCompany } from "../helpers/chat-channels-harness.js";








describeChatChannelsSuite("chat channels 35-retries-lifecycle-mutation-atomically-an", () => {
  it("retries lifecycle mutation atomically and reclaims it after restart", async () => {
    const fixture = await seedCompany();
    const deferred: Array<() => void | Promise<void>> = [];
    const first = await configuredSlackEndpoint(fixture, {
      deferWebhookProcessing: true,
      scheduleDeferredWork: (task) => deferred.push(task),
    });
    const thread = makeThread({
      channelId: "C-LIFECYCLE-RESTART",
      id: "slack:C-LIFECYCLE-RESTART:7050.1",
      name: "lifecycle-restart",
    });
    const original = makeMessage({
      id: "7050.1",
      text: "@maya preserve lifecycle recovery",
      mentioned: true,
    });
    await deliverMessage({
      callbacks: first.callbacks,
      endpointId: first.endpoint.id,
      thread: thread.thread,
      message: original,
      trigger: "mention",
    });
    expect(deferred).toHaveLength(1);
    await deferred.shift()?.();
    await vi.waitFor(async () => {
      await expect(
        db
          .select({ state: chatDeliveries.state })
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, first.endpoint.id),
              eq(
                chatDeliveries.providerEventId,
                `${thread.thread.id}:${original.id}`,
              ),
            ),
          ),
      ).resolves.toEqual([{ state: "processed" }]);
    }, { timeout: 5_000 });
    // The row becomes processed inside the mutation transaction, just before
    // the conversation drain releases its endpoint/thread lease. Synchronize
    // on that lease boundary before injecting the exact lifecycle commit fault.
    await vi.waitFor(async () => {
      await expect(
        db
          .select({ id: chatEndpointLeases.id })
          .from(chatEndpointLeases)
          .where(
            and(
              eq(chatEndpointLeases.endpointId, first.endpoint.id),
              like(chatEndpointLeases.leaseKey, "inbound:%"),
            ),
          ),
      ).resolves.toEqual([]);
    }, { timeout: 5_000 });
    if (!first.callbacks.onMessageUpdated)
      throw new Error("Slack lifecycle callback was not registered");
    await first.callbacks.onMessageUpdated({
      endpointId: first.endpoint.id,
      provider: "slack",
      thread: thread.thread,
      message: {
        ...original,
        text: "@maya corrected after restart",
        metadata: {
          dateSent: new Date("2026-09-05T15:00:00Z"),
          edited: true,
          editedAt: new Date("2026-09-05T15:01:00Z"),
        },
      } as Message,
      previousMessage: original,
    });
    const [lifecycle] = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, first.endpoint.id),
          eq(chatDeliveries.eventKind, "message_updated"),
        ),
      );
    expect(lifecycle).toMatchObject({ state: "received", attempts: 0 });

    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(chatDeliveries.id, lifecycle.id));
    const originalTransaction = db.transaction.bind(db);
    let injectedLifecycleFailure = false;
    const transaction = vi.spyOn(db, "transaction").mockImplementation((async (
      ...args: Parameters<typeof originalTransaction>
    ) => {
      const [callback, config] = args;
      return originalTransaction(async (tx) => {
        const result = await callback(tx);
        if (!injectedLifecycleFailure) {
          const [committedLifecycle] = await tx
            .select({ id: chatDeliveries.id })
            .from(chatDeliveries)
            .where(
              and(
                eq(chatDeliveries.id, lifecycle.id),
                eq(chatDeliveries.endpointId, first.endpoint.id),
                eq(chatDeliveries.state, "processed"),
                eq(chatDeliveries.attempts, 1),
              ),
            );
          if (committedLifecycle) {
            // Only this transaction can see its uncommitted terminal row.
            // Roll back both its comment and terminal update; unrelated
            // Gateway renewals must never consume the injected failure.
            injectedLifecycleFailure = true;
            throw new Error("injected lifecycle comment failure");
          }
        }
        return result;
      }, config);
    }) as typeof db.transaction);
    try {
      await first.service.processPendingDeliveries(25, lifecycle.id);
    } finally {
      transaction.mockRestore();
    }
    expect(injectedLifecycleFailure).toBe(true);
    await expect(
      db
        .select({
          attempts: chatDeliveries.attempts,
          state: chatDeliveries.state,
        })
        .from(chatDeliveries)
        .where(eq(chatDeliveries.id, lifecycle.id)),
    ).resolves.toEqual([{ attempts: 1, state: "retry" }]);
    const [conversation] = await readChatConversationsByEndpointId(first.endpoint.id);
    await expect(
      db
        .select()
        .from(issueComments)
        .where(
          and(
            eq(issueComments.issueId, conversation.issueId),
            eq(
              issueComments.body,
              "An external message was edited:\n\n@maya corrected after restart",
            ),
          ),
        ),
    ).resolves.toHaveLength(0);

    // Simulate a process dying after the durable claim but before its mutation
    // transaction. A new service instance must reclaim the stale claim and
    // commit the comment and terminal state together exactly once.
    await db
      .update(chatDeliveries)
      .set({
        state: "processing",
        nextAttemptAt: null,
        updatedAt: new Date(Date.now() - 120_000),
      })
      .where(eq(chatDeliveries.id, lifecycle.id));
    await first.service.shutdown();
    const restarted = createService(
      new FakeChatSdkRuntime(),
      fakeSlackFetch() as typeof globalThis.fetch,
    );
    await restarted.service.processPendingDeliveries(25, lifecycle.id);
    await restarted.service.processPendingDeliveries(25, lifecycle.id);

    await expect(
      db
        .select({
          attempts: chatDeliveries.attempts,
          state: chatDeliveries.state,
        })
        .from(chatDeliveries)
        .where(eq(chatDeliveries.id, lifecycle.id)),
    ).resolves.toEqual([{ attempts: 2, state: "processed" }]);
    await expect(
      db
        .select()
        .from(issueComments)
        .where(
          and(
            eq(issueComments.issueId, conversation.issueId),
            eq(
              issueComments.body,
              "An external message was edited:\n\n@maya corrected after restart",
            ),
          ),
        ),
    ).resolves.toHaveLength(1);
    await restarted.service.shutdown();
  });

  it("filters a claimed message lifecycle delivery after pause and reconnect supersede its runtime", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service } =
      await configuredSlackEndpoint(fixture);
    const channel = makeThread({
      channelId: "C-LIFECYCLE-FENCE",
      id: "slack:C-LIFECYCLE-FENCE:7060.1",
      name: "lifecycle-fence",
    });
    const original = makeMessage({
      id: "7060.1",
      text: "@maya establish lifecycle fencing",
      mentioned: true,
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: channel.thread,
      message: original,
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id);
    if (!callbacks.onMessageUpdated)
      throw new Error("Slack lifecycle callback was not registered");
    const correction =
      "An external message was edited:\n\n@maya stale correction";
    await callbacks.onMessageUpdated({
      endpointId: endpoint.id,
      provider: "slack",
      thread: channel.thread,
      message: {
        ...original,
        text: "@maya stale correction",
        metadata: {
          dateSent: new Date("2026-09-05T16:00:00Z"),
          edited: true,
          editedAt: new Date("2026-09-05T16:01:00Z"),
        },
      } as Message,
      previousMessage: original,
    });
    const [lifecycle] = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(chatDeliveries.eventKind, "message_updated"),
        ),
      );
    expect(lifecycle.normalizedEvent).toMatchObject({
      runtimeContext: {
        credentialFingerprint: expect.any(String),
        generation: expect.any(Number),
      },
    });
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    await db
      .delete(issueComments)
      .where(
        and(
          eq(issueComments.issueId, conversation.issueId),
          eq(issueComments.body, correction),
        ),
      );
    await db
      .update(chatDeliveries)
      .set({
        state: "processing",
        processedAt: null,
        updatedAt: new Date(Date.now() - 120_000),
      })
      .where(eq(chatDeliveries.id, lifecycle.id));

    await service.configure(endpoint.id, { action: "pause" }, "owner-user");
    await service.configure(endpoint.id, { action: "resume" }, "owner-user");
    await service.processPendingDeliveries(25, lifecycle.id);

    await expect(
      db
        .select({
          state: chatDeliveries.state,
          redactedError: chatDeliveries.redactedError,
        })
        .from(chatDeliveries)
        .where(eq(chatDeliveries.id, lifecycle.id)),
    ).resolves.toEqual([
      {
        state: "filtered",
        redactedError:
          "Message lifecycle callback belonged to a superseded runtime",
      },
    ]);
    await expect(
      db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.issueId, conversation.issueId),
            eq(issueComments.body, correction),
          ),
        ),
    ).resolves.toHaveLength(0);
    await service.shutdown();
  });

  it("acknowledges Telegram edits while verifying and when processing is suspended", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } =
      await configuredTelegramEndpoint(fixture);
    const chatId = "77112234";
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
        id: `${chatId}:51`,
        text: "Original setup request",
        userId: chatId,
      }),
      trigger: "direct_message",
    });

    const sendEdit = (editDate: number, text: string) =>
      service.handleWebhook(
        endpoint.publicId,
        "telegram",
        new Request("https://paperclip.example/telegram", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            update_id: editDate,
            edited_message: {
              message_id: 51,
              edit_date: editDate,
              chat: { id: Number(chatId), type: "private" },
              from: { id: Number(chatId), first_name: "Telegram User" },
              text,
            },
          }),
        }),
      );

    const transaction = vi.spyOn(db, "transaction");
    transaction.mockRejectedValueOnce(
      new Error("injected lifecycle transaction failure"),
    );
    await expect(
      sendEdit(1_788_620_100, "Edited during setup"),
    ).rejects.toThrow("injected lifecycle transaction failure");
    transaction.mockRestore();
    await expect(
      db
        .select()
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(chatDeliveries.eventKind, "message_updated"),
          ),
        ),
    ).resolves.toEqual([]);

    await expect(
      sendEdit(1_788_620_100, "Edited during setup"),
    ).resolves.toMatchObject({ ok: true });
    expect(wakeup).toHaveBeenCalledTimes(1);

    for (const status of ["paused", "attention"] as const) {
      await db
        .update(chatEndpoints)
        .set({ status, updatedAt: new Date() })
        .where(eq(chatEndpoints.id, endpoint.id));
      await expect(
        sendEdit(
          status === "paused" ? 1_788_620_101 : 1_788_620_102,
          `Edited while ${status}`,
        ),
      ).resolves.toMatchObject({ ok: true });
    }

    const lifecycle = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(chatDeliveries.eventKind, "message_updated"),
        ),
      );
    expect(lifecycle).toEqual([
      expect.objectContaining({
        providerEventId: "telegram:update:1788620100",
        state: "processed",
      }),
    ]);
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it("durably admits a Telegram edit that races deferred original-message processing", async () => {
    const fixture = await seedCompany();
    const deferred: Array<() => void | Promise<void>> = [];
    const runtime = new FakeChatSdkRuntime();
    const { service, wakeup } = createService(
      runtime,
      fakeTelegramFetch() as typeof globalThis.fetch,
      {
        deferWebhookProcessing: true,
        scheduleDeferredWork: (task) => deferred.push(task),
      },
    );
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "telegram", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: { botToken: "123456:telegram-ordering-test" },
      },
      "owner-user",
    );
    const callbacks = runtime.configurations.get(endpoint.id)?.callbacks;
    if (!callbacks) throw new Error("Expected Telegram callbacks");
    const chatId = "77112235";
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
        id: `${chatId}:61`,
        text: "Original deferred request",
        userId: chatId,
      }),
      trigger: "direct_message",
    });
    const [originalDelivery] = await readChatDeliveriesByEndpointId(endpoint.id);
    expect(originalDelivery).toMatchObject({ state: "received" });

    const sendEdit = (updateId: number, text: string) =>
      service.handleWebhook(
        endpoint.publicId,
        "telegram",
        new Request("https://paperclip.example/telegram", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            update_id: updateId,
            edited_message: {
              message_id: 61,
              edit_date: 1_788_620_200,
              chat: { id: Number(chatId), type: "private" },
              from: { id: Number(chatId), first_name: "Telegram User" },
              text,
            },
          }),
        }),
      );

    await expect(
      sendEdit(7_004, "Second edit whose callback arrived first"),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      sendEdit(7_003, "First edit whose callback arrived second"),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      sendEdit(7_003, "First edit whose callback arrived second"),
    ).resolves.toMatchObject({ ok: true });
    // The authenticated provider callback can be acknowledged as soon as both
    // events are durable. The shared per-conversation drain owns ordering and
    // no longer depends on Telegram redelivering the edit.
    await service.processPendingDeliveries(25, originalDelivery.id);
    const admitted = await db
      .select({
        eventKind: chatDeliveries.eventKind,
        state: chatDeliveries.state,
      })
      .from(chatDeliveries)
      .where(eq(chatDeliveries.endpointId, endpoint.id));
    expect(admitted).toHaveLength(3);
    expect(admitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventKind: "direct_message",
          state: "received",
        }),
        expect.objectContaining({
          eventKind: "message_updated",
          state: "received",
        }),
        expect.objectContaining({
          eventKind: "message_updated",
          state: "received",
        }),
      ]),
    );

    expect(deferred).toHaveLength(1);
    deferred.shift()?.();
    await vi.waitFor(
      async () => {
        const states = await db
          .select({ state: chatDeliveries.state })
          .from(chatDeliveries)
          .where(eq(chatDeliveries.endpointId, endpoint.id));
        expect(states).toHaveLength(3);
        expect(states.every((row) => row.state === "processed")).toBe(true);
      },
      { timeout: 3_000 },
    );
    const lifecycle = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(chatDeliveries.eventKind, "message_updated"),
        ),
      );
    expect(lifecycle).toHaveLength(2);
    expect(lifecycle).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerEventId: "telegram:update:7003",
          state: "processed",
          attempts: 1,
          normalizedEvent: expect.objectContaining({
            message: expect.objectContaining({ providerUpdateId: 7003 }),
          }),
        }),
        expect.objectContaining({
          providerEventId: "telegram:update:7004",
          state: "processed",
          attempts: 1,
          normalizedEvent: expect.objectContaining({
            message: expect.objectContaining({ providerUpdateId: 7004 }),
          }),
        }),
      ]),
    );
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    await expect(
      db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, conversation.issueId))
        .orderBy(asc(issueComments.createdAt), asc(issueComments.id)),
    ).resolves.toEqual([
      { body: "Original deferred request" },
      {
        body: "An external message was edited:\n\nFirst edit whose callback arrived second",
      },
      {
        body: "An external message was edited:\n\nSecond edit whose callback arrived first",
      },
    ]);
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it("filters a durable orphan Telegram edit after the bounded reorder window", async () => {
    const fixture = await seedCompany();
    const { endpoint, service, wakeup } =
      await configuredTelegramEndpoint(fixture);
    const chatId = "77112239";
    await expect(
      service.handleWebhook(
        endpoint.publicId,
        "telegram",
        new Request("https://paperclip.example/telegram", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            update_id: 7_039,
            edited_message: {
              message_id: 91,
              edit_date: 1_788_620_390,
              chat: { id: Number(chatId), type: "private" },
              from: { id: Number(chatId), first_name: "Telegram User" },
              text: "Edit whose original never reached Paperclip",
            },
          }),
        }),
      ),
    ).resolves.toMatchObject({ ok: true });

    const [admitted] = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(chatDeliveries.providerEventId, "telegram:update:7039"),
        ),
      );
    expect(admitted).toMatchObject({ state: "retry", attempts: 1 });
    expect(admitted.redactedError).toContain("Waiting briefly");

    for (let expectedAttempt = 2; expectedAttempt <= 13; expectedAttempt += 1) {
      await db
        .update(chatDeliveries)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(chatDeliveries.id, admitted.id));
      await service.processPendingDeliveries(25, admitted.id);

      await expect(
        db
          .select({
            attempts: chatDeliveries.attempts,
            redactedError: chatDeliveries.redactedError,
            state: chatDeliveries.state,
          })
          .from(chatDeliveries)
          .where(eq(chatDeliveries.id, admitted.id)),
      ).resolves.toEqual([
        {
          attempts: expectedAttempt,
          redactedError:
            expectedAttempt === 13
              ? "Original message was not admitted to this conversation"
              : "Waiting briefly for the original message",
          state: expectedAttempt === 13 ? "filtered" : "retry",
        },
      ]);
    }
    await expect(
      readChatConversationsByEndpointId(endpoint.id),
    ).resolves.toHaveLength(0);
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("supplements verified Teams edit, soft-delete, and restore activities against the existing task", async () => {
    const fixture = await seedCompany();
    const runtime = new FakeChatSdkRuntime();
    const { service } = createService(
      runtime,
      (async () =>
        new Response(JSON.stringify({ access_token: "teams-edit-access" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof globalThis.fetch,
    );
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "microsoft-teams", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    const clientId = randomUUID();
    const tenantId = randomUUID();
    await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          clientId,
          tenantId,
          clientSecret: "teams-edit-secret",
        },
      },
      "owner-user",
    );
    const callbacks = runtime.configurations.get(endpoint.id)?.callbacks;
    if (!callbacks) throw new Error("Expected Teams callbacks");
    const conversationId = "19:teams-edit@thread.tacv2;messageid=teams-root-1";
    const serviceUrl = "https://smba.trafficmanager.net/amer/";
    const threadId = `teams:${Buffer.from(conversationId).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`;
    const channel = makeThread({
      channelId: threadId,
      id: threadId,
      name: "Teams edit channel",
    });
    const aadObjectId = "00000000-0000-4000-8000-000000000433";
    const providerUserId = "29:teams-edit-user";
    const messageId = "teams-message-1";
    const originalRaw = {
      id: messageId,
      type: "message",
      text: "<at>Maya</at> original Teams request",
      serviceUrl,
      from: {
        id: providerUserId,
        aadObjectId,
        name: "Teams Edit User",
      },
      conversation: {
        id: conversationId,
        conversationType: "channel",
        tenantId,
      },
      channelData: { tenant: { id: tenantId } },
    };
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: channel.thread,
      message: makeMessage({
        id: messageId,
        raw: originalRaw,
        text: "@maya original Teams request",
        mentioned: true,
        userId: providerUserId,
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id, providerUserId);
    await service.test(endpoint.id);

    const endpointRuntime = runtime.endpoints.get(endpoint.id);
    if (!endpointRuntime) throw new Error("Expected Teams endpoint runtime");
    const initialRouteCount =
      endpointRuntime.recordedMicrosoftTeamsRoutes.length;
    const sendLifecycle = (payload: Record<string, unknown>) =>
      service.handleWebhook(
        endpoint.publicId,
        "microsoft-teams",
        new Request("https://paperclip.example/microsoft-teams", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }),
      );
    const foreignTenantId = randomUUID();
    const rejectedLifecyclePayloads = [
      {
        ...originalRaw,
        type: "messageUpdate",
        text: "FOREIGN_TENANT_EDIT_MUST_NOT_BE_RETAINED",
        timestamp: "2026-09-06T13:58:00.000Z",
        conversation: {
          ...originalRaw.conversation,
          tenantId: foreignTenantId,
        },
        channelData: {
          eventType: "editMessage",
          tenant: { id: foreignTenantId },
        },
      },
      {
        ...originalRaw,
        type: "messageDelete",
        text: undefined,
        timestamp: "2026-09-06T13:59:00.000Z",
        conversation: {
          id: conversationId,
          conversationType: "channel",
        },
        channelData: { eventType: "softDeleteMessage" },
      },
      {
        ...originalRaw,
        type: "messageUpdate",
        text: "CONFLICTING_TENANT_RESTORE_MUST_NOT_BE_RETAINED",
        timestamp: "2026-09-06T14:00:00.000Z",
        channelData: {
          eventType: "undeleteMessage",
          tenant: { id: foreignTenantId },
        },
      },
      {
        ...originalRaw,
        type: "messageUpdate",
        text: "TARGETED_EDIT_MUST_NOT_BE_RETAINED",
        timestamp: "2026-09-06T14:00:30.000Z",
        recipient: { id: clientId, isTargeted: true },
        channelData: {
          eventType: "editMessage",
          tenant: { id: tenantId },
        },
      },
    ];
    for (const payload of rejectedLifecyclePayloads) {
      await expect(sendLifecycle(payload)).resolves.toMatchObject({ ok: true });
    }
    expect(endpointRuntime.recordedMicrosoftTeamsRoutes).toHaveLength(
      initialRouteCount,
    );
    await expect(
      db
        .select({ id: chatDeliveries.id })
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            inArray(chatDeliveries.eventKind, [
              "message_updated",
              "message_deleted",
              "message_restored",
            ]),
          ),
        ),
    ).resolves.toEqual([]);

    const editPayload = {
      ...originalRaw,
      type: "messageUpdate",
      text: "Corrected Teams request",
      timestamp: "2026-09-06T14:01:00.000Z",
      channelData: { eventType: "editMessage", tenant: { id: tenantId } },
    };
    const sendEdit = (payload = editPayload) => sendLifecycle(payload);
    const duplicateResponses = await Promise.all(
      Array.from({ length: 12 }, () => sendEdit()),
    );
    expect(duplicateResponses).toHaveLength(12);
    expect(duplicateResponses.every((response) => response.ok)).toBe(true);
    const sameTimestampRevision = {
      ...editPayload,
      text: "Corrected Teams request again in the same millisecond",
    };
    const revisedResponses = await Promise.all(
      Array.from({ length: 8 }, () => sendEdit(sameTimestampRevision)),
    );
    expect(revisedResponses).toHaveLength(8);
    expect(revisedResponses.every((response) => response.ok)).toBe(true);

    const deletePayload = {
      ...originalRaw,
      type: "messageDelete",
      text: undefined,
      timestamp: "2026-09-06T14:02:00.000Z",
      channelData: {
        eventType: "softDeleteMessage",
        tenant: { id: tenantId },
      },
    };
    const deleteResponses = await Promise.all(
      Array.from({ length: 12 }, () => sendLifecycle(deletePayload)),
    );
    expect(deleteResponses.every((response) => response.ok)).toBe(true);

    await expect(
      sendEdit({
        ...editPayload,
        text: "An edit must not resurrect a soft-deleted Teams message",
        timestamp: "2026-09-06T14:03:00.000Z",
      }),
    ).resolves.toMatchObject({ ok: true });

    const restorePayload = {
      ...originalRaw,
      type: "messageUpdate",
      text: "Restored Teams request",
      timestamp: "2026-09-06T14:04:00.000Z",
      channelData: {
        eventType: "undeleteMessage",
        tenant: { id: tenantId },
      },
    };
    const restoreResponses = await Promise.all(
      Array.from({ length: 8 }, () => sendLifecycle(restorePayload)),
    );
    expect(restoreResponses.every((response) => response.ok)).toBe(true);
    await expect(
      sendEdit({
        ...editPayload,
        text: "Edited after Teams restored the message",
        timestamp: "2026-09-06T14:05:00.000Z",
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      sendLifecycle({
        ...deletePayload,
        timestamp: "2026-09-06T14:02:30.000Z",
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      sendLifecycle({
        ...restorePayload,
        text: "STALE_TEAMS_RESTORE_CONTENT_MUST_BE_REDACTED",
        timestamp: "2026-09-06T14:03:30.000Z",
      }),
    ).resolves.toMatchObject({ ok: true });

    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    const editComments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, conversation.issueId))
      .then((rows) =>
        rows.filter((comment) =>
          comment.body.startsWith("An external message was edited:"),
        ),
      );
    expect(editComments).toHaveLength(3);
    expect(editComments).toEqual(
      expect.arrayContaining([
        { body: "An external message was edited:\n\nCorrected Teams request" },
        {
          body: "An external message was edited:\n\nCorrected Teams request again in the same millisecond",
        },
        {
          body: "An external message was edited:\n\nEdited after Teams restored the message",
        },
      ]),
    );
    await expect(
      db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, conversation.issueId))
        .then((rows) =>
          rows.filter(
            (comment) =>
              comment.body ===
                "An external message in this conversation was deleted." ||
              comment.body ===
                "An external message was restored:\n\nRestored Teams request",
          ),
        ),
    ).resolves.toEqual(
      expect.arrayContaining([
        { body: "An external message in this conversation was deleted." },
        {
          body: "An external message was restored:\n\nRestored Teams request",
        },
      ]),
    );
    await expect(
      db
        .select({
          principalId: chatDeliveries.principalId,
          state: chatDeliveries.state,
        })
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(chatDeliveries.eventKind, "message_updated"),
          ),
        ),
    ).resolves.toEqual(
      expect.arrayContaining([
        { principalId: expect.any(String), state: "processed" },
        { principalId: expect.any(String), state: "processed" },
        {
          principalId: null,
          state: "filtered",
        },
        { principalId: expect.any(String), state: "processed" },
      ]),
    );
    await expect(
      db
        .select({
          eventKind: chatDeliveries.eventKind,
          principalId: chatDeliveries.principalId,
          state: chatDeliveries.state,
        })
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            inArray(chatDeliveries.eventKind, [
              "message_deleted",
              "message_restored",
            ]),
          ),
        ),
    ).resolves.toEqual(
      expect.arrayContaining([
        {
          eventKind: "message_deleted",
          principalId: null,
          state: "processed",
        },
        {
          eventKind: "message_restored",
          principalId: expect.any(String),
          state: "processed",
        },
        {
          eventKind: "message_deleted",
          principalId: null,
          state: "filtered",
        },
        {
          eventKind: "message_restored",
          principalId: null,
          state: "filtered",
        },
      ]),
    );
    const filteredLifecyclePayloads = await db
      .select({ normalizedEvent: chatDeliveries.normalizedEvent })
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(chatDeliveries.state, "filtered"),
          inArray(chatDeliveries.eventKind, [
            "message_updated",
            "message_deleted",
            "message_restored",
          ]),
        ),
      );
    expect(filteredLifecyclePayloads).toHaveLength(3);
    expect(JSON.stringify(filteredLifecyclePayloads)).not.toContain(
      "An edit must not resurrect a soft-deleted Teams message",
    );
    expect(JSON.stringify(filteredLifecyclePayloads)).not.toContain(
      "STALE_TEAMS_RESTORE_CONTENT_MUST_BE_REDACTED",
    );
    expect(filteredLifecyclePayloads).toEqual(
      expect.arrayContaining([
        {
          normalizedEvent: expect.objectContaining({
            filtering: { contentRetained: false },
          }),
        },
      ]),
    );
    // The shared deletion-only tombstone path must not authorize a restore or
    // let an older delete override the current provider revision while disabled.
    const commentsBeforeDisabledLifecycle = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.issueId, conversation.issueId))
      .orderBy(issueComments.id);
    const priorLifecycleIds = new Set(
      (
        await db
          .select({ id: chatDeliveries.id })
          .from(chatDeliveries)
          .where(eq(chatDeliveries.endpointId, endpoint.id))
      ).map((row) => row.id),
    );
    await service.replaceResources(endpoint.id, [
      { id: conversation.resourceId!, enabled: false },
    ]);
    await sendLifecycle({
      ...restorePayload,
      timestamp: "2026-09-06T14:06:00.000Z",
      text: "DISABLED_RESTORE_MUST_NOT_PERSIST",
    });
    await sendLifecycle({
      ...deletePayload,
      timestamp: "2026-09-06T14:02:45.000Z",
    });
    const latestLifecycle = (
      await readChatDeliveriesByEndpointId(endpoint.id)
    ).filter((row) => !priorLifecycleIds.has(row.id));
    expect(latestLifecycle).toHaveLength(2);
    expect(latestLifecycle.every((row) => row.state === "filtered")).toBe(true);
    expect(JSON.stringify(latestLifecycle)).not.toContain(
      "DISABLED_RESTORE_MUST_NOT_PERSIST",
    );
    await sendLifecycle({
      ...deletePayload,
      timestamp: "2026-09-06T14:07:00.000Z",
    });
    await service.replaceResources(endpoint.id, [
      { id: conversation.resourceId!, enabled: true },
    ]);
    await sendLifecycle({
      ...restorePayload,
      timestamp: "2026-09-06T14:06:30.000Z",
      text: "OLDER_RESTORE_MUST_NOT_PERSIST",
    });
    const afterDisabledDelete = (
      await readChatDeliveriesByEndpointId(endpoint.id)
    ).filter((row) => !priorLifecycleIds.has(row.id));
    expect(
      afterDisabledDelete.filter((row) => row.state === "processed"),
    ).toEqual([
      expect.objectContaining({
        eventKind: "message_deleted",
        conversationId: conversation.id,
        normalizedEvent: {
          providerEventId: expect.any(String),
          kind: "message_deleted",
          runtimeContext: expect.objectContaining({
            generation: expect.any(Number),
            credentialFingerprint: expect.any(String),
          }),
          conversation: {
            externalThreadId: `teams:${Buffer.from(conversationId).toString("base64url")}`,
          },
          message: {
            providerMessageId: messageId,
            targetProviderEventId: expect.any(String),
            providerSentAt: "2026-09-06T14:07:00.000Z",
          },
          filtering: { contentRetained: false },
        },
      }),
    ]);
    expect(afterDisabledDelete).toHaveLength(4);
    expect(
      afterDisabledDelete.filter((row) => row.state === "filtered"),
    ).toHaveLength(3);
    expect(JSON.stringify(afterDisabledDelete)).not.toContain(
      "OLDER_RESTORE_MUST_NOT_PERSIST",
    );
    await expect(
      db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(eq(issueComments.issueId, conversation.issueId))
        .orderBy(issueComments.id),
    ).resolves.toEqual(commentsBeforeDisabledLifecycle);
    await service.shutdown();
  });

  it("records verified Telegram edited_message updates against the existing DM task", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } =
      await configuredTelegramEndpoint(fixture);
    const chatId = "77112233";
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
        id: `${chatId}:41`,
        text: "Original Telegram request",
        userId: chatId,
      }),
      trigger: "direct_message",
    });
    await qualifySetupRoundTrip(service, endpoint.id, chatId);
    await service.test(endpoint.id);

    const editPayload = {
      update_id: 7001,
      edited_message: {
        message_id: 41,
        edit_date: 1_788_620_000,
        chat: { id: Number(chatId), type: "private" },
        from: { id: Number(chatId), first_name: "Telegram User" },
        text: "Corrected Telegram request",
      },
    };
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: dm.thread,
      message: {
        ...makeMessage({
          id: `${chatId}:41`,
          text: "Corrected Telegram request",
          userId: chatId,
        }),
        raw: editPayload.edited_message,
      } as Message,
      trigger: "direct_message",
    });
    const sendEdit = () =>
      service.handleWebhook(
        endpoint.publicId,
        "telegram",
        new Request("https://paperclip.example/telegram", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(editPayload),
        }),
      );
    await Promise.all(Array.from({ length: 12 }, sendEdit));
    await service.handleWebhook(
      endpoint.publicId,
      "telegram",
      new Request("https://paperclip.example/telegram", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...editPayload,
          update_id: 7002,
          edited_message: {
            ...editPayload.edited_message,
            text: "Corrected Telegram request again in the same second",
          },
        }),
      }),
    );

    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    const comments = await readIssueCommentsByIssueId(conversation.issueId);
    expect(
      comments
        .filter((comment) =>
          comment.body.startsWith("An external message was edited:"),
        )
        .map((comment) => comment.body),
    ).toEqual(
      expect.arrayContaining([
        "An external message was edited:\n\nCorrected Telegram request",
        "An external message was edited:\n\nCorrected Telegram request again in the same second",
      ]),
    );
    const updateDeliveries = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(chatDeliveries.eventKind, "message_updated"),
        ),
      );
    expect(updateDeliveries).toHaveLength(2);
    expect(updateDeliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerEventId: "telegram:update:7001",
          state: "processed",
          normalizedEvent: expect.objectContaining({
            message: expect.objectContaining({ providerUpdateId: 7001 }),
          }),
        }),
        expect.objectContaining({
          providerEventId: "telegram:update:7002",
          state: "processed",
          normalizedEvent: expect.objectContaining({
            message: expect.objectContaining({ providerUpdateId: 7002 }),
          }),
        }),
      ]),
    );
    const [originalDelivery] = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(chatDeliveries.providerEventId, `telegram:${chatId}:${chatId}:41`),
        ),
      );
    expect(originalDelivery.normalizedEvent.deduplication).toBeUndefined();
    expect(wakeup).toHaveBeenCalledTimes(2);
  });

  it("retains only a source invalidation for a Telegram edit when the original actor's link is revoked", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service } =
      await configuredTelegramEndpoint(fixture);
    const chatId = "77112239";
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
        id: `${chatId}:91`,
        text: "Original authorized Telegram request",
        userId: chatId,
      }),
      trigger: "direct_message",
    });
    await qualifySetupRoundTrip(service, endpoint.id, chatId);
    await service.test(endpoint.id);

    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    const principal = await db
      .select()
      .from(chatExternalPrincipals)
      .where(
        and(
          eq(chatExternalPrincipals.companyId, fixture.companyId),
          eq(chatExternalPrincipals.provider, "telegram"),
          eq(chatExternalPrincipals.externalId, chatId),
        ),
      )
      .then((rows) => rows[0]);
    if (!conversation || !principal)
      throw new Error("Expected Telegram conversation and principal");
    const linkedUserId = `telegram-edit-user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({
      id: linkedUserId,
      name: "Telegram Edit User",
      email: `${linkedUserId}@example.com`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId: fixture.companyId,
      principalType: "user",
      principalId: linkedUserId,
      status: "active",
      membershipRole: "operator",
    });
    await db.insert(chatIdentityLinks).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      principalId: principal.id,
      paperclipUserId: linkedUserId,
      status: "linked",
      confirmedAt: now,
    });
    await service.update(
      endpoint.id,
      { allowUnlinkedPeople: false },
      "owner-user",
    );
    await db
      .update(chatIdentityLinks)
      .set({
        paperclipUserId: null,
        status: "revoked",
        revokedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(chatIdentityLinks.principalId, principal.id));

    const commentCount = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.issueId, conversation.issueId))
      .then((rows) => rows.length);
    const secretEdit = "Revoked Telegram edit must not enter Paperclip";
    await expect(
      service.handleWebhook(
        endpoint.publicId,
        "telegram",
        new Request("https://paperclip.example/telegram", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            update_id: 7_009,
            edited_message: {
              message_id: 91,
              edit_date: 1_788_620_900,
              chat: { id: Number(chatId), type: "private" },
              from: { id: Number(chatId), first_name: "Telegram User" },
              text: secretEdit,
            },
          }),
        }),
      ),
    ).resolves.toMatchObject({ ok: true });

    await expect(
      db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(eq(issueComments.issueId, conversation.issueId)),
    ).resolves.toHaveLength(commentCount);
    const [editDelivery] = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(chatDeliveries.providerEventId, "telegram:update:7009"),
        ),
      );
    expect(editDelivery).toMatchObject({
      principalId: principal.id,
      conversationId: conversation.id,
      state: "processed",
      redactedError:
        "Provider edit invalidation retained without admitting content from an unauthorized actor",
      normalizedEvent: { filtering: { contentRetained: false } },
    });
    expect(JSON.stringify(editDelivery.normalizedEvent)).not.toContain(
      secretEdit,
    );
  });

  it("replaces working with one safe ownership-attention message without terminalizing the run", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredTelegramEndpoint(fixture);
    const chatId = "77112249";
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
        id: `${chatId}:101`,
        text: "Recover this turn safely",
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
        providerMessageId: `${chatId}:101`,
      }),
    });
    await expect(enqueueChatRunMilestones(db)).resolves.toBe(1);
    await service.processPendingPublications();
    await db
      .update(heartbeatRuns)
      .set({
        errorCode: "native_execution_ownership_unverified",
        error: "Private runner PID and executable authentication diagnostic",
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, runId));
    await expect(enqueueChatRunMilestones(db)).resolves.toBe(1);
    await service.processPendingPublications();
    await expect(enqueueChatRunMilestones(db)).resolves.toBe(0);
    await service.processPendingPublications();
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    expect(providerRuntime?.posts).toEqual([
      { threadId: dm.thread.id, text: "Maya is working…" },
    ]);
    expect(providerRuntime?.edits).toEqual([
      {
        threadId: dm.thread.id,
        messageId: "outbound-2",
        text: "Maya needs a Paperclip admin to safely recover this turn before more work can start. Open the task in Paperclip for details.",
      },
    ]);
    expect(JSON.stringify(providerRuntime?.edits)).not.toContain(
      "Private runner",
    );
    const [retainedRun] = await readHeartbeatRunsById(runId);
    expect(retainedRun).toMatchObject({ status: "running", finishedAt: null });
  });

  it.each(["queued", "working", "waiting_for_input"] as const)(
    "does not let a late %s milestone replace authoritative ownership attention or final status",
    async (lateMilestone) => {
      const fixture = await seedCompany();
      const { callbacks, endpoint, runtime, service } =
        await configuredTelegramEndpoint(fixture);
      const chatId = "77112250";
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
          id: `${chatId}:101`,
          text: "Recover safely",
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
        status: lateMilestone === "queued" ? "running" : "queued",
        contextSnapshot: await chatWakeContext({
          endpointId: endpoint.id,
          issueId: conversation.issueId,
          provider: "telegram",
          providerMessageId: `${chatId}:101`,
        }),
      });
      await expect(enqueueChatRunMilestones(db)).resolves.toBe(1);
      await service.processPendingPublications();
      const terminal = lateMilestone === "waiting_for_input";
      await db
        .update(heartbeatRuns)
        .set({
          status: terminal ? "failed" : "running",
          errorCode: terminal
            ? "adapter_failed"
            : "native_execution_ownership_unverified",
          error: "Private diagnostic must not leave Paperclip",
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, runId));
      await expect(enqueueChatRunMilestones(db)).resolves.toBe(1);
      await service.processPendingPublications();
      const providerRuntime = runtime.endpoints.get(endpoint.id);
      if (!providerRuntime) throw new Error("Expected Telegram runtime");
      const settledEdits = [...providerRuntime.edits];
      expect(settledEdits).toHaveLength(1);
      // Model a sweep that sampled an earlier run state, then finished its
      // binding lookup after a newer milestone had already reached the provider.
      const [stale] = await db
        .insert(chatPublications)
        .values({
          companyId: fixture.companyId,
          endpointId: endpoint.id,
          conversationId: conversation.id,
          issueId: conversation.issueId,
          idempotencyKey: `run:${runId}:${lateMilestone}:${endpoint.id}`,
          payload: {
            text: "Stale status must not replace the authoritative message",
            progressState: lateMilestone,
          },
          state: "pending",
        })
        .returning();
      await service.processPendingPublications();
      expect(providerRuntime.posts).toHaveLength(1);
      expect(providerRuntime.edits).toEqual(settledEdits);
      expect(JSON.stringify(providerRuntime.edits)).not.toContain(
        "Private diagnostic",
      );
      const [retained] = await readChatPublicationsById(stale!.id);
      expect(retained).toMatchObject({ state: "cancelled", attempts: 0 });
    },
  );

  it("keeps an internal Telegram run summary private and completes its progress message", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredTelegramEndpoint(fixture);
    const chatId = "77112240";
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
        id: `${chatId}:101`,
        text: "Finish without an externally authored reply",
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
        providerMessageId: `${chatId}:101`,
      }),
    });
    await expect(enqueueChatRunMilestones(db)).resolves.toBe(1);
    await service.processPendingPublications();

    // Heartbeat persists success before its presentation resolver runs. A
    // reconciliation sweep in this window must not race ahead with a generic
    // completion that could hide a later explicit response.
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId));
    await expect(enqueueChatRunMilestones(db)).resolves.toBe(0);

    const internalSummary = await issueService(db).addComment(
      conversation.issueId,
      "Internal presentation summary that must never reach Telegram",
      { agentId: fixture.assignedAgentId, runId },
      { authorType: "agent", authorizationReason: "internal_agent_write" },
    );
    await expect(
      readChatPublicationsByCommentId(internalSummary.id),
    ).resolves.toHaveLength(0);
    const internalAttachmentBody = Buffer.from("internal attachment");
    await issueService(db).createAttachment({
      issueId: conversation.issueId,
      issueCommentId: internalSummary.id,
      provider: "local_disk",
      objectKey: `chat-tests/${randomUUID()}`,
      contentType: "text/plain",
      byteSize: internalAttachmentBody.byteLength,
      sha256: createHash("sha256").update(internalAttachmentBody).digest("hex"),
      originalFilename: "internal.txt",
      createdByAgentId: fixture.assignedAgentId,
      createdByRunId: runId,
    });
    await expect(
      readChatPublicationsByCommentId(internalSummary.id),
    ).resolves.toHaveLength(0);

    await db
      .update(heartbeatRuns)
      .set({
        resultJson: {
          presentationDecision: {
            chosenSource: "final_agent_message",
            commentAction: "create",
          },
        },
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, runId));
    await expect(enqueueChatRunMilestones(db)).resolves.toBe(1);
    await service.processPendingPublications();

    const providerRuntime = runtime.endpoints.get(endpoint.id);
    expect(providerRuntime?.posts).toEqual([
      { threadId: dm.thread.id, text: "Maya is working…" },
    ]);
    expect(providerRuntime?.edits).toEqual([
      {
        threadId: dm.thread.id,
        messageId: "outbound-2",
        text: "Maya has no final response to show yet. Open the task in Paperclip for details.",
      },
    ]);
    expect(
      JSON.stringify({
        posts: providerRuntime?.posts,
        edits: providerRuntime?.edits,
      }),
    ).not.toContain("Internal presentation summary");
  });

  it.each([
    {
      authorizationReason: "paperclip_runner_protocol",
      chatId: "77112241",
      publishesComment: false,
    },
    {
      authorizationReason: "allow_visible_issue_write",
      chatId: "77112242",
      publishesComment: false,
    },
    {
      authorizationReason: "allow_chat_run_presentation",
      chatId: "77112243",
      publishesComment: true,
    },
  ] as const)(
    "publishes only a resolver-selected Telegram reply for $authorizationReason",
    async ({ authorizationReason, chatId, publishesComment }) => {
      const fixture = await seedCompany();
      const { callbacks, endpoint, runtime, service } =
        await configuredTelegramEndpoint(fixture);
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
          id: `${chatId}:102`,
          text: "Return an explicit reply",
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
          providerMessageId: `${chatId}:102`,
        }),
      });
      await expect(enqueueChatRunMilestones(db)).resolves.toBe(1);
      await service.processPendingPublications();
      const resolvedAuthorizationReason =
        authorizationReason === "allow_chat_run_presentation"
          ? await resolveChatRunPresentationAuthorizationReason(db, {
              companyId: fixture.companyId,
              issueId: conversation.issueId,
              runId,
            })
          : authorizationReason;
      expect(resolvedAuthorizationReason).toBe(authorizationReason);
      const comment = await issueService(db).addComment(
        conversation.issueId,
        `Explicit Telegram reply via ${authorizationReason}`,
        { agentId: fixture.assignedAgentId, runId },
        {
          authorType: "agent",
          authorizationReason: resolvedAuthorizationReason,
        },
      );
      await service.processPendingPublications();
      await expect(
        readChatPublicationsByCommentId(comment.id),
      ).resolves.toHaveLength(publishesComment ? 1 : 0);

      await db
        .update(heartbeatRuns)
        .set({
          status: "succeeded",
          resultJson: {
            presentationDecision: {
              chosenSource: publishesComment
                ? "existing_issue_comment"
                : "none",
              commentAction: "none",
            },
          },
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, runId));
      const laterQueuedRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: laterQueuedRunId,
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        status: "queued",
        contextSnapshot: await chatWakeContext({
          endpointId: endpoint.id,
          issueId: conversation.issueId,
          provider: "telegram",
          providerMessageId: `${chatId}:102`,
        }),
        updatedAt: new Date(Date.now() + 1_000),
      });
      // The settled successful run must be filtered before LIMIT. Otherwise a
      // page of explicit replies can starve later run milestones forever.
      await expect(enqueueChatRunMilestones(db, { limit: 1 })).resolves.toBe(1);
      if (!publishesComment) {
        await service.processPendingPublications();
        await expect(enqueueChatRunMilestones(db, { limit: 1 })).resolves.toBe(
          1,
        );
      }

      const providerRuntime = runtime.endpoints.get(endpoint.id);
      expect(providerRuntime?.posts).toEqual([
        { threadId: dm.thread.id, text: "Maya is working…" },
      ]);
      expect(providerRuntime?.edits).toEqual([
        {
          threadId: dm.thread.id,
          messageId: "outbound-2",
          text: publishesComment
            ? `Explicit Telegram reply via ${authorizationReason}`
            : "Maya has no final response to show yet. Open the task in Paperclip for details.",
        },
      ]);
      await expect(
        db
          .select()
          .from(chatPublications)
          .where(
            like(chatPublications.idempotencyKey, `run:${runId}:completed:%`),
          ),
      ).resolves.toHaveLength(publishesComment ? 0 : 1);
      await expect(
        readChatPublicationsByIdempotencyKey(`run:${laterQueuedRunId}:queued:${endpoint.id}`),
      ).resolves.toHaveLength(1);
    },
  );
});
