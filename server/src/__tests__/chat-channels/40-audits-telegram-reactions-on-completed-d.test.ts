import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { chatActions, chatConversations, chatDeliveries, chatEndpointLeases, chatEndpointResources, chatEndpoints, chatMessageLinks, chatPublications, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import type { Message } from "chat";
import { makeMessage, makeThread } from ".././helpers/chat-channels-fixture.js";
import { configuredDiscordEndpoint, configuredSlackEndpoint, configuredTelegramEndpoint, createService, db, deliverMessage, describeChatChannelsSuite, qualifySetupRoundTrip, readChatConversationsByEndpointId, readChatDeliveriesById, readHeartbeatRunsByCompanyId, readIssueCommentsByCompanyId, readIssueCommentsByIssueId, seedCompany } from "../helpers/chat-channels-harness.js";







describeChatChannelsSuite("chat channels 40-audits-telegram-reactions-on-completed-d", () => {
  it("audits Telegram reactions on completed DM generations idempotently without comments or runs", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } =
      await configuredTelegramEndpoint(fixture);
    const chatId = "77112237";
    const dm = makeThread({
      channelId: `telegram:${chatId}`,
      id: `telegram:${chatId}`,
      isDM: true,
      name: "Telegram direct message",
    });
    const original = makeMessage({
      id: `${chatId}:81`,
      text: "Observe Telegram reactions",
      userId: chatId,
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: dm.thread,
      message: original,
      trigger: "direct_message",
    });
    await qualifySetupRoundTrip(service, endpoint.id, chatId);
    await service.test(endpoint.id);
    if (!callbacks.onReaction)
      throw new Error("Telegram reaction callback was not registered");
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    await db
      .update(issues)
      .set({ status: "done", completedAt: new Date(), updatedAt: new Date() })
      .where(eq(issues.id, conversation.issueId));
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: dm.thread,
      message: makeMessage({
        id: `${chatId}:82`,
        text: "Start the next Telegram DM task",
        userId: chatId,
      }),
      trigger: "direct_message",
    });
    const conversations = await service.listConversations(endpoint.id);
    expect(conversations).toHaveLength(2);
    expect(
      conversations.find((row) => row.id === conversation.id),
    ).toMatchObject({ state: "completed", sessionGeneration: 1 });
    const newerConversation = conversations.find(
      (row) => row.id !== conversation.id,
    )!;
    expect(newerConversation).toMatchObject({
      state: "active",
      sessionGeneration: 2,
    });
    const commentCount = await readIssueCommentsByCompanyId(fixture.companyId)
      .then((rows) => rows.length);
    const wakeupCount = wakeup.mock.calls.length;
    const runCount = await readHeartbeatRunsByCompanyId(fixture.companyId)
      .then((rows) => rows.length);
    const emoji = {
      name: "thumbs_up",
      toJSON: () => "👍",
      toString: () => "👍",
    };
    const reaction = (added: boolean, updateId: number) => ({
      endpointId: endpoint.id,
      provider: "telegram" as const,
      event: {
        adapter: {} as never,
        added,
        emoji,
        message: original,
        messageId: original.id,
        raw: { update_id: updateId },
        rawEmoji: "👍",
        thread: dm.thread,
        threadId: dm.thread.id,
        user: original.author,
      },
    });
    await callbacks.onReaction(reaction(true, 8_001));
    await callbacks.onReaction(reaction(true, 8_001));
    await callbacks.onReaction(reaction(false, 8_002));
    await callbacks.onReaction(reaction(true, 8_003));
    await callbacks.onReaction(reaction(false, 8_004));
    const foreignThreadReaction = reaction(true, 8_005);
    foreignThreadReaction.event.threadId = "telegram:77112238";
    await callbacks.onReaction(foreignThreadReaction);
    await service.update(
      endpoint.id,
      { allowDirectMessages: false },
      "owner-user",
    );
    await callbacks.onReaction(reaction(true, 8_006));

    const reactions = await db
      .select()
      .from(chatDeliveries)
      .where(eq(chatDeliveries.conversationId, conversation.id))
      .then((rows) =>
        rows.filter((row) => row.eventKind.startsWith("reaction_")),
      );
    expect(reactions).toHaveLength(4);
    expect(reactions.map((row) => row.eventKind).sort()).toEqual([
      "reaction_added",
      "reaction_added",
      "reaction_removed",
      "reaction_removed",
    ]);
    expect(reactions.every((row) => row.state === "processed")).toBe(true);
    await expect(
      db
        .select()
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.conversationId, newerConversation.id),
            inArray(chatDeliveries.eventKind, [
              "reaction_added",
              "reaction_removed",
            ]),
          ),
        ),
    ).resolves.toHaveLength(0);
    expect(
      await readIssueCommentsByCompanyId(fixture.companyId)
        .then((rows) => rows.length),
    ).toBe(commentCount);
    expect(wakeup).toHaveBeenCalledTimes(wakeupCount);
    expect(
      await readHeartbeatRunsByCompanyId(fixture.companyId)
        .then((rows) => rows.length),
    ).toBe(runCount);
  });

  it("audits reactions on linked messages without treating them as task instructions", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } =
      await configuredSlackEndpoint(fixture);
    const channel = makeThread({
      channelId: "C-REACTIONS",
      id: "slack:C-REACTIONS:7100.1",
      name: "reactions",
    });
    const original = makeMessage({
      id: "7100.1",
      text: "@maya observe reactions",
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
    if (!callbacks.onReaction)
      throw new Error("Slack reaction callback was not registered");

    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    const commentCountBefore = await readIssueCommentsByIssueId(conversation.issueId)
      .then((rows) => rows.length);
    const wakeupCountBefore = wakeup.mock.calls.length;
    const emoji = {
      name: "thumbs_up",
      toJSON: () => ":thumbs_up:",
      toString: () => ":thumbs_up:",
    };
    const reaction = (added: boolean, eventTs: string) => ({
      endpointId: endpoint.id,
      provider: "slack" as const,
      event: {
        adapter: {} as never,
        added,
        emoji,
        message: original,
        messageId: original.id,
        raw: { event_ts: eventTs },
        rawEmoji: "+1",
        thread: channel.thread,
        threadId: channel.thread.id,
        user: original.author,
      },
    });

    await callbacks.onReaction(reaction(true, "7101.1"));
    await callbacks.onReaction(reaction(true, "7101.1"));
    await callbacks.onReaction(reaction(false, "7102.1"));

    const reactions = await db
      .select()
      .from(chatDeliveries)
      .where(eq(chatDeliveries.conversationId, conversation.id))
      .then((rows) =>
        rows.filter((row) => row.eventKind.startsWith("reaction_")),
      );
    expect(reactions).toHaveLength(2);
    expect(reactions.map((row) => row.eventKind).sort()).toEqual([
      "reaction_added",
      "reaction_removed",
    ]);
    expect(reactions[0]?.normalizedEvent).toMatchObject({
      reaction: { emoji: "thumbs_up", rawEmoji: "+1" },
    });
    expect(
      await readIssueCommentsByIssueId(conversation.issueId)
        .then((rows) => rows.length),
    ).toBe(commentCountBefore);
    expect(wakeup.mock.calls).toHaveLength(wakeupCountBefore);
    expect(
      (await service.listActivity(endpoint.id)).filter((item) =>
        item.summary.startsWith("reaction "),
      ),
    ).toHaveLength(2);
  });

  it("rechecks the outbound link when publication commits between reaction preflight reads", async () => {
    const fixture = await seedCompany();
    let releasePreflight!: () => void;
    const preflightRelease = new Promise<void>((resolve) => {
      releasePreflight = resolve;
    });
    let reachedPreflight!: () => void;
    const preflightReached = new Promise<void>((resolve) => {
      reachedPreflight = resolve;
    });
    const { callbacks, endpoint, runtime, service, wakeup } =
      await configuredSlackEndpoint(fixture, {
        linkedBoardUser: true,
        reactionLinkPreflightBarrier: async () => {
          reachedPreflight();
          await preflightRelease;
        },
      });
    const channel = makeThread({
      channelId: "C-REACTION-PREFLIGHT",
      id: "slack:C-REACTION-PREFLIGHT:7125.1",
      name: "reaction-preflight",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: channel.thread,
      message: makeMessage({
        id: "7125.1",
        text: "@maya send a reply for the preflight race",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id);
    if (!callbacks.onReaction)
      throw new Error("Slack reaction callback was not registered");
    const [conversation] = await service.listConversations(endpoint.id);
    if (!conversation) throw new Error("Expected Slack conversation");
    const wakeupCount = wakeup.mock.calls.length;
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected Slack endpoint runtime");
    const targetMessageId = "7125.2";
    const targetMessage = makeMessage({ id: targetMessageId, text: "" });
    const reaction = {
      endpointId: endpoint.id,
      provider: "slack" as const,
      event: {
        adapter: {} as never,
        added: true,
        emoji: {
          name: "thumbs_up",
          toJSON: () => ":thumbs_up:",
          toString: () => ":thumbs_up:",
        },
        message: targetMessage,
        messageId: targetMessageId,
        raw: { event_ts: "7125.25" },
        rawEmoji: "+1",
        thread: channel.thread,
        threadId: channel.thread.id,
        user: targetMessage.author,
      },
    };
    let reactionPromise: Promise<void> | null = null;
    providerRuntime.postResultIds.push(targetMessageId);
    providerRuntime.postHook = async () => {
      if (reactionPromise) return;
      reactionPromise = Promise.resolve(callbacks.onReaction!(reaction));
      await preflightReached;
      // Return to the provider send while the callback is between its first
      // exact-link lookup and its streaming lookup.
    };
    await service.publishBoardMessage(
      endpoint.id,
      conversation.id,
      "The preflight race reply",
      "reaction-preflight-link-commit",
      "owner-user",
    );
    providerRuntime.postHook = undefined;
    releasePreflight();
    await reactionPromise;

    await expect(
      db
        .select()
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(chatDeliveries.eventKind, "reaction_added"),
          ),
        ),
    ).resolves.toEqual([
      expect.objectContaining({
        conversationId: conversation.id,
        state: "processed",
      }),
    ]);
    // Sending the Board message wakes the agent once; the reaction adds no wake.
    expect(wakeup).toHaveBeenCalledTimes(wakeupCount + 1);
    expect(wakeup.mock.calls.at(-1)?.[1]).toMatchObject({
      contextSnapshot: { source: "issue.comment" },
      requestedByActorId: "owner-user",
    });
  });

  it("durably replays a reaction that arrives before its outbound link without waking the task", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service, wakeup } =
      await configuredSlackEndpoint(fixture, { linkedBoardUser: true });
    const channel = makeThread({
      channelId: "C-EARLY-REACTION",
      id: "slack:C-EARLY-REACTION:7130.1",
      name: "early-reaction",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: channel.thread,
      message: makeMessage({
        id: "7130.1",
        text: "@maya prepare an outbound reply",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id);
    if (!callbacks.onReaction)
      throw new Error("Slack reaction callback was not registered");
    const [conversation] = await service.listConversations(endpoint.id);
    if (!conversation) throw new Error("Expected Slack conversation");
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected Slack endpoint runtime");
    const targetMessageId = "7130.2";
    const targetMessage = makeMessage({
      id: targetMessageId,
      text: "",
      mentioned: false,
    });
    const reaction = (messageId: string, eventTs: string) => ({
      endpointId: endpoint.id,
      provider: "slack" as const,
      event: {
        adapter: {} as never,
        added: true,
        emoji: {
          name: "thumbs_up",
          toJSON: () => ":thumbs_up:",
          toString: () => ":thumbs_up:",
        },
        message: { ...targetMessage, id: messageId } as Message,
        messageId,
        raw: { event_ts: eventTs },
        rawEmoji: "+1",
        thread: channel.thread,
        threadId: channel.thread.id,
        user: targetMessage.author,
      },
    });
    let stagedId: string | null = null;
    let intercepted = false;
    providerRuntime.postResultIds.push(targetMessageId);
    providerRuntime.postHook = async () => {
      if (intercepted) return;
      intercepted = true;
      const event = reaction(targetMessageId, "7130.25");
      await callbacks.onReaction!(event);
      await callbacks.onReaction!(event);
      const staged = await db
        .select()
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(chatDeliveries.eventKind, "reaction_added"),
          ),
        );
      expect(staged).toHaveLength(1);
      expect(staged[0]).toMatchObject({
        conversationId: null,
        state: "received",
        attempts: 0,
        normalizedEvent: expect.objectContaining({
          conversation: { externalThreadId: channel.thread.id },
          message: { providerMessageId: targetMessageId },
          runtimeContext: {
            generation: expect.any(Number),
            credentialFingerprint: expect.any(String),
          },
        }),
      });
      stagedId = staged[0]!.id;
    };
    await service.publishBoardMessage(
      endpoint.id,
      conversation.id,
      "A provider-visible reply",
      "early-reaction-before-link",
      "owner-user",
    );
    providerRuntime.postHook = undefined;
    if (!stagedId) throw new Error("Expected a staged reaction delivery");

    // An arbitrary message in the same thread is not plausible once no send
    // is in flight, so it does not even create a durable reaction row.
    await callbacks.onReaction(reaction("7130.unknown", "7130.3"));
    await expect(
      db
        .select({ id: chatDeliveries.id })
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(chatDeliveries.eventKind, "reaction_added"),
          ),
        ),
    ).resolves.toHaveLength(1);

    const commentCount = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.issueId, conversation.issueId))
      .then((rows) => rows.length);
    const issueCount = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.companyId, fixture.companyId))
      .then((rows) => rows.length);
    const runCount = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, fixture.companyId))
      .then((rows) => rows.length);
    const wakeupCount = wakeup.mock.calls.length;
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(chatDeliveries.id, stagedId));
    const restarted = createService();
    await restarted.service.processPendingDeliveries(1, stagedId);
    const [replayed] = await readChatDeliveriesById(stagedId);
    expect(replayed).toMatchObject({
      conversationId: conversation.id,
      state: "processed",
      attempts: 1,
      nextAttemptAt: null,
      redactedError: null,
    });

    // The provider's exact retry after the link commit is the same immutable
    // event and therefore neither duplicates nor replays task work.
    await callbacks.onReaction(reaction(targetMessageId, "7130.25"));
    await expect(
      db
        .select({ id: chatDeliveries.id })
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(chatDeliveries.eventKind, "reaction_added"),
          ),
        ),
    ).resolves.toHaveLength(1);
    await expect(
      db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(eq(issueComments.issueId, conversation.issueId))
        .then((rows) => rows.length),
    ).resolves.toBe(commentCount);
    await expect(
      db
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.companyId, fixture.companyId))
        .then((rows) => rows.length),
    ).resolves.toBe(issueCount);
    await expect(
      db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.companyId, fixture.companyId))
        .then((rows) => rows.length),
    ).resolves.toBe(runCount);
    expect(wakeup).toHaveBeenCalledTimes(wakeupCount);
    expect(restarted.wakeup).not.toHaveBeenCalled();
    await restarted.service.shutdown();
  });

  it("replays one pre-link Discord reaction after service reconstruction without waking the task", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service, wakeup } =
      await configuredDiscordEndpoint(fixture);
    const guildId = "1457808928258658549";
    const channelId = "333333333333333391";
    const rootMessageId = "555555555555555691";
    const channel = makeThread({
      channelId,
      id: `discord:${guildId}:${channelId}:${rootMessageId}`,
      name: "discord-reaction-restart",
    });
    const rootMessage = makeMessage({
      id: rootMessageId,
      mentioned: true,
      text: "@maya prepare a Discord reply before service reconstruction",
      userId: "444444444444444491",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "discord",
      thread: channel.thread,
      message: rootMessage,
      trigger: "mention",
    });
    await qualifySetupRoundTrip(
      service,
      endpoint.id,
      rootMessage.author.userId,
    );
    await service.test(endpoint.id);
    if (!callbacks.onReaction)
      throw new Error("Discord reaction callback was not registered");
    const [conversation] = await service.listConversations(endpoint.id);
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!conversation || !providerRuntime)
      throw new Error("Expected an active Discord conversation");

    const targetMessageId = "555555555555555692";
    const targetMessage = makeMessage({
      id: targetMessageId,
      text: "",
      userId: rootMessage.author.userId,
    });
    const reaction = {
      endpointId: endpoint.id,
      provider: "discord" as const,
      event: {
        adapter: {} as never,
        added: true,
        emoji: {
          name: "thumbsup",
          toJSON: () => "👍",
          toString: () => "👍",
        },
        message: targetMessage,
        messageId: targetMessageId,
        raw: {
          channel_id: channelId,
          emoji: { id: null, name: "👍" },
          gateway_dispatch: {
            eventType: "MESSAGE_REACTION_ADD",
            sequence: 891,
            sessionFingerprint: "f".repeat(24),
            shardId: 0,
          },
          guild_id: guildId,
          message_id: targetMessageId,
          user_id: targetMessage.author.userId,
        },
        rawEmoji: "👍",
        thread: channel.thread,
        threadId: channel.thread.id,
        user: targetMessage.author,
      },
    };
    let stagedId: string | null = null;
    providerRuntime.postResultIds.push(targetMessageId);
    providerRuntime.postHook = async () => {
      if (stagedId) return;
      await callbacks.onReaction!(reaction);
      await callbacks.onReaction!(reaction);
      const staged = await db
        .select()
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(chatDeliveries.eventKind, "reaction_added"),
          ),
        );
      expect(staged).toHaveLength(1);
      expect(staged[0]).toMatchObject({
        conversationId: null,
        state: "received",
        attempts: 0,
        normalizedEvent: expect.objectContaining({
          conversation: { externalThreadId: channel.thread.id },
          message: { providerMessageId: targetMessageId },
          runtimeContext: {
            generation: expect.any(Number),
            credentialFingerprint: expect.any(String),
          },
        }),
      });
      stagedId = staged[0]!.id;
    };
    await service.publishBoardMessage(
      endpoint.id,
      conversation.id,
      "A Discord reply whose reaction must survive reconstruction",
      "discord-reaction-before-restart",
      "owner-user",
    );
    providerRuntime.postHook = undefined;
    if (!stagedId) throw new Error("Expected a staged Discord reaction");

    const commentCount = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.issueId, conversation.issueId))
      .then((rows) => rows.length);
    const runCount = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, fixture.companyId))
      .then((rows) => rows.length);
    const wakeupCount = wakeup.mock.calls.length;
    await service.shutdown();
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(chatDeliveries.id, stagedId));

    const restarted = createService();
    try {
      await restarted.service.processPendingDeliveries(1, stagedId);
      await expect(
        readChatDeliveriesById(stagedId),
      ).resolves.toEqual([
        expect.objectContaining({
          conversationId: conversation.id,
          state: "processed",
          attempts: 1,
          nextAttemptAt: null,
          redactedError: null,
          normalizedEvent: expect.objectContaining({
            conversation: { externalThreadId: channel.thread.id },
            message: { providerMessageId: targetMessageId },
            reaction: {
              added: true,
              emoji: "thumbsup",
              rawEmoji: "👍",
            },
          }),
        }),
      ]);
      const reactionActivity = () =>
        restarted.service
          .listActivity(endpoint.id)
          .then((items) => items.filter((item) => item.id === stagedId));
      await expect(reactionActivity()).resolves.toEqual([
        expect.objectContaining({
          kind: "delivery",
          status: "processed",
          summary: "reaction added processed",
        }),
      ]);

      await restarted.service.processPendingDeliveries(1, stagedId);
      await expect(reactionActivity()).resolves.toHaveLength(1);
      await expect(
        db
          .select({ id: issueComments.id })
          .from(issueComments)
          .where(eq(issueComments.issueId, conversation.issueId))
          .then((rows) => rows.length),
      ).resolves.toBe(commentCount);
      await expect(
        db
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.companyId, fixture.companyId))
          .then((rows) => rows.length),
      ).resolves.toBe(runCount);
      expect(wakeup).toHaveBeenCalledTimes(wakeupCount);
      expect(restarted.wakeup).not.toHaveBeenCalled();
    } finally {
      await restarted.service.shutdown();
    }
  });

  it.each(["action_first", "reaction_first"] as const)(
    "joins in-flight recovery before rethrowing an ordinary drain failure (%s)",
    async (releaseOrder) => {
      const gate = () => {
        let release!: () => void;
        const promise = new Promise<void>((resolve) => {
          release = resolve;
        });
        return { promise, release };
      };
      const actionGate = gate();
      const reactionGate = gate();
      let recoveryArmed = false;
      let actionEntered = false;
      let reactionEntered = false;
      const fixture = await seedCompany();
      const { callbacks, endpoint, runtime, service, wakeup } =
        await configuredSlackEndpoint(fixture, {
        linkedBoardUser: true,
          reactionReplayEndpointLockBarrier: async () => {
            if (!recoveryArmed) return;
            reactionEntered = true;
            await reactionGate.promise;
          },
        });
      const restoreMocks: Array<() => void> = [];
      let ordinaryDeliveryId: string | null = null;
      let sweep: Promise<{ ok: true } | { ok: false; error: unknown }> | null =
        null;
      try {
        // Recovery scans the shared fixture database. Earlier tests can leave
        // authorized retry intents deliberately staged across service shutdown.
        // Settle those before this fixture arms its controlled work and records
        // the strict global no-new-wakeup/post/row baseline below.
        await service.processPendingDeliveries();
        const channel = makeThread({
          channelId: "C-RECOVERY-JOIN",
          id: "slack:C-RECOVERY-JOIN:7147.1",
          name: "recovery-join",
        });
        await deliverMessage({
          callbacks,
          endpointId: endpoint.id,
          thread: channel.thread,
          message: makeMessage({
            id: "7147.1",
            text: "@maya prepare the recovery join fixture",
            mentioned: true,
          }),
          trigger: "mention",
        });
        await qualifySetupRoundTrip(service, endpoint.id);
        await service.test(endpoint.id);
        const [conversation] = await service.listConversations(endpoint.id);
        const providerRuntime = runtime.endpoints.get(endpoint.id);
        if (!conversation || !providerRuntime || !callbacks.onReaction)
          throw new Error("Expected the active Slack reaction fixture");

        // Obtain a current-runtime inbound receipt and its real normalized
        // delivery, then retain only the durable retry state needed here.
        const inboundMessageId = "7147.3";
        await deliverMessage({
          callbacks,
          endpointId: endpoint.id,
          thread: channel.thread,
          message: makeMessage({
            id: inboundMessageId,
            text: "Ready to retry",
          }),
          trigger: "subscribed_message",
        });
        const [inbound] = await db
          .select()
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, endpoint.id),
              sql`${chatDeliveries.normalizedEvent}->'message'->>'providerMessageId' = ${inboundMessageId}`,
            ),
          );
        const [receipt] = inbound
          ? await db
              .select()
              .from(chatActions)
              .where(
                and(
                  eq(chatActions.deliveryId, inbound.id),
                  eq(chatActions.kind, "receipt_reaction"),
                  sql`${chatActions.payload}->>'operation' = 'add'`,
                ),
              )
          : [];
        if (!inbound || !receipt)
          throw new Error("Expected an inbound delivery and receipt action");

        const targetMessageId = "7147.4";
        providerRuntime.postResultIds.push(targetMessageId);
        await service.publishBoardMessage(
          endpoint.id,
          conversation.id,
          "The linked reaction target",
          `recovery-join-${releaseOrder}`,
          "owner-user",
        );
        const target = makeMessage({ id: targetMessageId, text: "" });
        await callbacks.onReaction({
          endpointId: endpoint.id,
          provider: "slack",
          event: {
            adapter: {} as never,
            added: true,
            emoji: {
              name: "thumbs_up",
              toJSON: () => ":thumbs_up:",
              toString: () => ":thumbs_up:",
            },
            message: target,
            messageId: targetMessageId,
            raw: { event_ts: "7147.45" },
            rawEmoji: "+1",
            thread: channel.thread,
            threadId: channel.thread.id,
            user: target.author,
          },
        });
        const [reaction] = await db
          .select()
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, endpoint.id),
              eq(chatDeliveries.eventKind, "reaction_added"),
            ),
          );
        if (!reaction) throw new Error("Expected the normalized reaction");
        await db
          .update(chatDeliveries)
          .set({
            conversationId: null,
            state: "received",
            attempts: 0,
            processedAt: null,
            nextAttemptAt: new Date(0),
          })
          .where(eq(chatDeliveries.id, reaction.id));
        await db
          .update(chatActions)
          .set({ status: "received", result: null, createdAt: new Date(0) })
          .where(eq(chatActions.id, receipt.id));
        ordinaryDeliveryId = randomUUID();
        const ordinaryEventId = `recovery-join-ordinary-${randomUUID()}`;
        await db.insert(chatDeliveries).values({
          ...inbound,
          id: ordinaryDeliveryId,
          providerEventId: ordinaryEventId,
          deduplicationKey: ordinaryEventId,
          normalizedEvent: {
            ...inbound.normalizedEvent,
            providerEventId: ordinaryEventId,
            message: {
              ...(inbound.normalizedEvent.message as Record<string, unknown>),
              providerMessageId: "7147.5",
            },
          },
          state: "received",
          attempts: 0,
          receivedAt: new Date(0),
          processedAt: null,
          nextAttemptAt: null,
        });

        const originalThread = providerRuntime.thread.bind(providerRuntime);
        const recoveredReceipt = vi.fn(async () => {
          actionEntered = true;
          await actionGate.promise;
        });
        const threadSpy = vi
          .spyOn(providerRuntime, "thread")
          .mockImplementation((threadId) => {
            const thread = originalThread(threadId);
            const originalAddReaction = thread.adapter.addReaction;
            thread.adapter.addReaction = async (...args) => {
              if (
                threadId === channel.thread.id &&
                args[1] === inboundMessageId
              )
                await recoveredReceipt();
              return originalAddReaction(...args);
            };
            return thread;
          });
        restoreMocks.push(() => threadSpy.mockRestore());

        // Fail only the ordinary drain's lease acquisition, outside its
        // per-message catch. Recovery's credential leases must keep working.
        const sentinel = new Error("injected ordinary drain lease failure");
        let ordinaryFailed = false;
        const originalInsert = db.insert.bind(db);
        const insertSpy = vi.spyOn(db, "insert").mockImplementation((table) => {
          const builder = originalInsert(table);
          if (table === chatEndpointLeases) {
            const originalValues = builder.values.bind(builder);
            builder.values = ((values: {
              endpointId?: string;
              leaseKey?: string;
            }) => {
              if (
                !ordinaryFailed &&
                values.endpointId === endpoint.id &&
                values.leaseKey?.startsWith("inbound:")
              ) {
                ordinaryFailed = true;
                throw sentinel;
              }
              return originalValues(values);
            }) as typeof builder.values;
          }
          return builder;
        });
        restoreMocks.push(() => insertSpy.mockRestore());
        const unchangedRows = async () =>
          Promise.all([
            db
              .select({ id: issueComments.id })
              .from(issueComments)
              .where(eq(issueComments.companyId, fixture.companyId))
              .orderBy(issueComments.id),
            db
              .select({ id: issues.id })
              .from(issues)
              .where(eq(issues.companyId, fixture.companyId))
              .orderBy(issues.id),
            db
              .select({ id: heartbeatRuns.id })
              .from(heartbeatRuns)
              .where(eq(heartbeatRuns.companyId, fixture.companyId))
              .orderBy(heartbeatRuns.id),
            db
              .select({ id: chatPublications.id })
              .from(chatPublications)
              .where(eq(chatPublications.endpointId, endpoint.id))
              .orderBy(chatPublications.id),
          ]);
        const baseline = await unchangedRows();
        const wakeupCount = wakeup.mock.calls.length;
        const postCount = providerRuntime.posts.length;
        let settled = false;
        recoveryArmed = true;
        sweep = service.processPendingDeliveries().then(
          () => {
            settled = true;
            return { ok: true as const };
          },
          (error: unknown) => {
            settled = true;
            return { ok: false as const, error };
          },
        );
        await expect
          .poll(() => ordinaryFailed && actionEntered && reactionEntered)
          .toBe(true);
        expect(settled).toBe(false);
        const actionState = () =>
          db
            .select({ state: chatActions.status })
            .from(chatActions)
            .where(eq(chatActions.id, receipt.id))
            .then((rows) => rows[0]?.state);
        const reactionState = () =>
          db
            .select({ state: chatDeliveries.state })
            .from(chatDeliveries)
            .where(eq(chatDeliveries.id, reaction.id))
            .then((rows) => rows[0]?.state);
        if (releaseOrder === "action_first") {
          actionGate.release();
          await expect.poll(actionState).toBe("processed");
        } else {
          reactionGate.release();
          await expect.poll(reactionState).toBe("processed");
        }
        expect(settled).toBe(false);
        actionGate.release();
        reactionGate.release();
        const outcome = await sweep;
        expect(outcome.ok).toBe(false);
        if (outcome.ok) throw new Error("Expected the ordinary drain failure");
        expect(outcome.error).toBe(sentinel);
        expect(await actionState()).toBe("processed");
        await expect(
          readChatDeliveriesById(reaction.id),
        ).resolves.toEqual([
          expect.objectContaining({
            conversationId: conversation.id,
            state: "processed",
            attempts: 1,
          }),
        ]);
        await expect(
          db
            .select({ state: chatDeliveries.state })
            .from(chatDeliveries)
            .where(eq(chatDeliveries.id, ordinaryDeliveryId)),
        ).resolves.toEqual([{ state: "received" }]);
        expect(recoveredReceipt).toHaveBeenCalledTimes(1);
        expect(wakeup).toHaveBeenCalledTimes(wakeupCount);
        expect(providerRuntime.posts).toHaveLength(postCount);
        expect(await unchangedRows()).toEqual(baseline);
        await expect(
          db
            .select({ id: chatEndpointLeases.id })
            .from(chatEndpointLeases)
            .where(eq(chatEndpointLeases.endpointId, endpoint.id)),
        ).resolves.toEqual([]);
      } finally {
        actionGate.release();
        reactionGate.release();
        await sweep;
        for (const restore of restoreMocks.reverse()) restore();
        if (ordinaryDeliveryId)
          await db
            .delete(chatDeliveries)
            .where(eq(chatDeliveries.id, ordinaryDeliveryId));
        await service.shutdown();
      }
    },
    20_000,
  );

  it("does not deadlock reaction replay against publication link settlement", async () => {
    const fixture = await seedCompany();
    let beginContention!: () => void;
    const contention = new Promise<void>((resolve) => {
      beginContention = resolve;
    });
    let endpointLocked!: () => void;
    const endpointLockReached = new Promise<void>((resolve) => {
      endpointLocked = resolve;
    });
    let conversationLocked!: () => void;
    const conversationLockReached = new Promise<void>((resolve) => {
      conversationLocked = resolve;
    });
    const { callbacks, endpoint, runtime, service, wakeup } =
      await configuredSlackEndpoint(fixture, {
        linkedBoardUser: true,
        reactionReplayEndpointLockBarrier: async () => {
          endpointLocked();
          await contention;
        },
        reactionReplayConversationLockBarrier: async () => {
          conversationLocked();
        },
      });
    const channel = makeThread({
      channelId: "C-REACTION-LINK-LOCK",
      id: "slack:C-REACTION-LINK-LOCK:7135.1",
      name: "reaction-link-lock",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: channel.thread,
      message: makeMessage({
        id: "7135.1",
        text: "@maya send a reply for the link lock race",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id);
    if (!callbacks.onReaction)
      throw new Error("Slack reaction callback was not registered");
    const [conversation] = await service.listConversations(endpoint.id);
    if (!conversation) throw new Error("Expected Slack conversation");
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected Slack endpoint runtime");
    const targetMessageId = "7135.2";
    providerRuntime.postResultIds.push(targetMessageId);
    const publication = await service.publishBoardMessage(
      endpoint.id,
      conversation.id,
      "The link-lock race reply",
      "reaction-link-lock-settlement",
      "owner-user",
    );
    const [link] = await db
      .select()
      .from(chatMessageLinks)
      .where(
        and(
          eq(chatMessageLinks.publicationId, publication.id),
          eq(chatMessageLinks.providerMessageId, targetMessageId),
        ),
      );
    if (!link) throw new Error("Expected the initial outbound link");
    await db.delete(chatMessageLinks).where(eq(chatMessageLinks.id, link.id));
    await db
      .update(chatPublications)
      .set({
        state: "streaming",
        providerMessageId: null,
        updatedAt: new Date(),
      })
      .where(eq(chatPublications.id, publication.id));
    const targetMessage = makeMessage({ id: targetMessageId, text: "" });
    await callbacks.onReaction({
      endpointId: endpoint.id,
      provider: "slack",
      event: {
        adapter: {} as never,
        added: true,
        emoji: {
          name: "thumbs_up",
          toJSON: () => ":thumbs_up:",
          toString: () => ":thumbs_up:",
        },
        message: targetMessage,
        messageId: targetMessageId,
        raw: { event_ts: "7135.25" },
        rawEmoji: "+1",
        thread: channel.thread,
        threadId: channel.thread.id,
        user: targetMessage.author,
      },
    });
    const [staged] = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(chatDeliveries.eventKind, "reaction_added"),
        ),
      );
    if (!staged) throw new Error("Expected a staged reaction delivery");
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(chatDeliveries.id, staged.id));
    let linkInserted!: () => void;
    const linkInsertReached = new Promise<void>((resolve) => {
      linkInserted = resolve;
    });
    const settlement = db.transaction(async (tx) => {
      await tx
        .update(chatPublications)
        .set({
          state: "published",
          providerMessageId: targetMessageId,
          publishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(chatPublications.id, publication.id));
      await tx.insert(chatMessageLinks).values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: conversation.id,
        publicationId: publication.id,
        commentId: publication.commentId,
        providerMessageId: targetMessageId,
        direction: "outbound",
      });
      linkInserted();
      await contention;
      await tx
        .update(chatEndpoints)
        .set({ updatedAt: new Date() })
        .where(eq(chatEndpoints.id, endpoint.id));
    });
    await linkInsertReached;
    const wakeupCount = wakeup.mock.calls.length;
    const replay = service.processPendingDeliveries(1, staged.id);
    await endpointLockReached;
    beginContention();
    await conversationLockReached;
    await Promise.all([settlement, replay]);

    const [waitingForLink] = await readChatDeliveriesById(staged.id);
    expect(waitingForLink).toMatchObject({
      conversationId: null,
      state: "retry",
      attempts: 1,
      redactedError: "Waiting for the sent message link",
    });
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(chatDeliveries.id, staged.id));
    await service.processPendingDeliveries(1, staged.id);
    const [processed] = await readChatDeliveriesById(staged.id);
    expect(processed).toMatchObject({
      conversationId: conversation.id,
      state: "processed",
      attempts: 2,
    });
    expect(wakeup).toHaveBeenCalledTimes(wakeupCount);
  });

  it("filters a late duplicate instead of bypassing the bounded reaction-link lifetime", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture, { linkedBoardUser: true });
    const channel = makeThread({
      channelId: "C-EXPIRED-REACTION",
      id: "slack:C-EXPIRED-REACTION:7140.1",
      name: "expired-reaction",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: channel.thread,
      message: makeMessage({
        id: "7140.1",
        text: "@maya prepare another reply",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id);
    if (!callbacks.onReaction)
      throw new Error("Slack reaction callback was not registered");
    const [conversation] = await service.listConversations(endpoint.id);
    if (!conversation) throw new Error("Expected Slack conversation");
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected Slack endpoint runtime");
    const targetMessageId = "7140.2";
    const targetMessage = makeMessage({ id: targetMessageId, text: "" });
    const reaction = {
      endpointId: endpoint.id,
      provider: "slack" as const,
      event: {
        adapter: {} as never,
        added: true,
        emoji: {
          name: "eyes",
          toJSON: () => ":eyes:",
          toString: () => ":eyes:",
        },
        message: targetMessage,
        messageId: targetMessageId,
        raw: { event_ts: "7140.25" },
        rawEmoji: "eyes",
        thread: channel.thread,
        threadId: channel.thread.id,
        user: targetMessage.author,
      },
    };
    let stagedId: string | null = null;
    providerRuntime.postResultIds.push(targetMessageId);
    providerRuntime.postHook = async () => {
      if (stagedId) return;
      await callbacks.onReaction!(reaction);
      stagedId = await db
        .select({ id: chatDeliveries.id })
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(chatDeliveries.eventKind, "reaction_added"),
          ),
        )
        .then((rows) => rows[0]?.id ?? null);
    };
    await service.publishBoardMessage(
      endpoint.id,
      conversation.id,
      "Another provider-visible reply",
      "expired-reaction-before-link",
      "owner-user",
    );
    providerRuntime.postHook = undefined;
    if (!stagedId) throw new Error("Expected a staged reaction delivery");
    await db
      .update(chatDeliveries)
      .set({
        receivedAt: new Date(Date.now() - 2 * 60_000 - 1),
        nextAttemptAt: new Date(0),
      })
      .where(eq(chatDeliveries.id, stagedId));

    await callbacks.onReaction(reaction);
    const [expired] = await readChatDeliveriesById(stagedId);
    expect(expired).toMatchObject({
      conversationId: null,
      state: "filtered",
      redactedError:
        "Reaction target did not become linked before replay expiry",
    });
  });

  it("resamples reaction expiry after replay waits on authorization locks", async () => {
    const fixture = await seedCompany();
    const baseTime = new Date("2026-09-07T20:30:00.000Z");
    let advanceReplayClock = false;
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture, {
        linkedBoardUser: true,
        reactionReplayEndpointLockBarrier: async () => {
          if (advanceReplayClock) {
            vi.setSystemTime(new Date(baseTime.getTime() + 2_000));
          }
        },
      });
    const channel = makeThread({
      channelId: "C-REACTION-EXPIRY-LOCK",
      id: "slack:C-REACTION-EXPIRY-LOCK:7142.1",
      name: "reaction-expiry-lock",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: channel.thread,
      message: makeMessage({
        id: "7142.1",
        text: "@maya prepare the expiry-lock reply",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id);
    if (!callbacks.onReaction)
      throw new Error("Slack reaction callback was not registered");
    const [conversation] = await service.listConversations(endpoint.id);
    if (!conversation) throw new Error("Expected Slack conversation");
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected Slack endpoint runtime");
    const targetMessageId = "7142.2";
    const targetMessage = makeMessage({ id: targetMessageId, text: "" });
    let stagedId: string | null = null;
    providerRuntime.postResultIds.push(targetMessageId);
    providerRuntime.postHook = async () => {
      if (stagedId) return;
      await callbacks.onReaction!({
        endpointId: endpoint.id,
        provider: "slack",
        event: {
          adapter: {} as never,
          added: true,
          emoji: {
            name: "eyes",
            toJSON: () => ":eyes:",
            toString: () => ":eyes:",
          },
          message: targetMessage,
          messageId: targetMessageId,
          raw: { event_ts: "7142.25" },
          rawEmoji: "eyes",
          thread: channel.thread,
          threadId: channel.thread.id,
          user: targetMessage.author,
        },
      });
      stagedId = await db
        .select({ id: chatDeliveries.id })
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(chatDeliveries.eventKind, "reaction_added"),
          ),
        )
        .then((rows) => rows[0]?.id ?? null);
    };
    await service.publishBoardMessage(
      endpoint.id,
      conversation.id,
      "The expiry-lock reply",
      "reaction-expiry-after-lock",
      "owner-user",
    );
    providerRuntime.postHook = undefined;
    if (!stagedId) throw new Error("Expected a staged reaction delivery");
    await db
      .update(chatDeliveries)
      .set({
        receivedAt: new Date(baseTime.getTime() - 2 * 60_000 + 1_000),
        nextAttemptAt: new Date(0),
      })
      .where(eq(chatDeliveries.id, stagedId));

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(baseTime);
      advanceReplayClock = true;
      await service.processPendingDeliveries(1, stagedId);
    } finally {
      vi.useRealTimers();
    }
    const [filtered] = await readChatDeliveriesById(stagedId);
    expect(filtered).toMatchObject({
      conversationId: null,
      state: "filtered",
      redactedError:
        "Reaction target did not become linked before replay expiry",
    });
  });

  it("filters a staged reaction when destination reach is revoked before replay", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service, wakeup } =
      await configuredSlackEndpoint(fixture, { linkedBoardUser: true });
    const channel = makeThread({
      channelId: "C-REVOKED-EARLY-REACTION",
      id: "slack:C-REVOKED-EARLY-REACTION:7145.1",
      name: "revoked-early-reaction",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: channel.thread,
      message: makeMessage({
        id: "7145.1",
        text: "@maya prepare a reply before reach changes",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id);
    if (!callbacks.onReaction)
      throw new Error("Slack reaction callback was not registered");
    const [conversation] = await service.listConversations(endpoint.id);
    if (!conversation?.resourceId)
      throw new Error("Expected a resource-backed Slack conversation");
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected Slack endpoint runtime");
    const targetMessageId = "7145.2";
    const targetMessage = makeMessage({ id: targetMessageId, text: "" });
    const reaction = {
      endpointId: endpoint.id,
      provider: "slack" as const,
      event: {
        adapter: {} as never,
        added: true,
        emoji: {
          name: "thumbs_up",
          toJSON: () => ":thumbs_up:",
          toString: () => ":thumbs_up:",
        },
        message: targetMessage,
        messageId: targetMessageId,
        raw: { event_ts: "7145.25" },
        rawEmoji: "+1",
        thread: channel.thread,
        threadId: channel.thread.id,
        user: targetMessage.author,
      },
    };
    let stagedId: string | null = null;
    providerRuntime.postResultIds.push(targetMessageId);
    providerRuntime.postHook = async () => {
      if (stagedId) return;
      await callbacks.onReaction!(reaction);
      stagedId = await db
        .select({ id: chatDeliveries.id })
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(chatDeliveries.eventKind, "reaction_added"),
          ),
        )
        .then((rows) => rows[0]?.id ?? null);
    };
    await service.publishBoardMessage(
      endpoint.id,
      conversation.id,
      "A reply whose reach will be revoked",
      "revoked-reaction-before-link",
      "owner-user",
    );
    providerRuntime.postHook = undefined;
    if (!stagedId) throw new Error("Expected a staged reaction delivery");
    const commentCount = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.issueId, conversation.issueId))
      .then((rows) => rows.length);
    const wakeupCount = wakeup.mock.calls.length;
    await db
      .update(chatEndpointResources)
      .set({ enabled: false, updatedAt: new Date() })
      .where(eq(chatEndpointResources.id, conversation.resourceId));
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(chatDeliveries.id, stagedId));
    await service.processPendingDeliveries(1, stagedId);

    const [filtered] = await readChatDeliveriesById(stagedId);
    expect(filtered).toMatchObject({
      conversationId: null,
      state: "filtered",
      redactedError:
        "Reaction destination or principal is no longer authorized",
    });
    await callbacks.onReaction(reaction);
    await expect(
      db
        .select({ id: chatDeliveries.id })
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(chatDeliveries.eventKind, "reaction_added"),
          ),
        ),
    ).resolves.toHaveLength(1);
    await expect(
      db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(eq(issueComments.issueId, conversation.issueId))
        .then((rows) => rows.length),
    ).resolves.toBe(commentCount);
    expect(wakeup).toHaveBeenCalledTimes(wakeupCount);
  });

  it("replays a pre-link reaction into the completed DM generation that sent the message", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service, wakeup } =
      await configuredSlackEndpoint(fixture, { linkedBoardUser: true });
    const channelId = "D-EARLY-REACTION";
    const dm = makeThread({
      channelId,
      id: `slack:${channelId}:`,
      isDM: true,
      name: "Slack early-reaction DM",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: dm.thread,
      message: makeMessage({
        id: "7150.1",
        text: "Prepare the first DM generation reply",
        userId: "U-EARLY-DM",
      }),
      trigger: "direct_message",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id);
    if (!callbacks.onReaction)
      throw new Error("Slack reaction callback was not registered");
    const [firstConversation] = await service.listConversations(endpoint.id);
    if (!firstConversation) throw new Error("Expected Slack DM conversation");
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected Slack endpoint runtime");
    const targetMessageId = "7150.2";
    const targetMessage = makeMessage({
      id: targetMessageId,
      text: "",
      userId: "U-EARLY-DM",
    });
    const reaction = {
      endpointId: endpoint.id,
      provider: "slack" as const,
      event: {
        adapter: {} as never,
        added: true,
        emoji: {
          name: "thumbs_up",
          toJSON: () => ":thumbs_up:",
          toString: () => ":thumbs_up:",
        },
        message: targetMessage,
        messageId: targetMessageId,
        raw: { event_ts: "7150.25" },
        rawEmoji: "+1",
        thread: dm.thread,
        threadId: dm.thread.id,
        user: targetMessage.author,
      },
    };
    let stagedId: string | null = null;
    providerRuntime.postResultIds.push(targetMessageId);
    providerRuntime.postHook = async () => {
      if (stagedId) return;
      const completedAt = new Date();
      await db
        .update(issues)
        .set({ status: "done", completedAt, updatedAt: completedAt })
        .where(eq(issues.id, firstConversation.issueId));
      await db
        .update(chatConversations)
        .set({ state: "completed", updatedAt: completedAt })
        .where(eq(chatConversations.id, firstConversation.id));
      await callbacks.onReaction!(reaction);
      stagedId = await db
        .select({ id: chatDeliveries.id })
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(chatDeliveries.eventKind, "reaction_added"),
          ),
        )
        .then((rows) => rows[0]?.id ?? null);
    };
    await service.publishBoardMessage(
      endpoint.id,
      firstConversation.id,
      "The first DM generation reply",
      "completed-dm-reaction-before-link",
      "owner-user",
    );
    providerRuntime.postHook = undefined;
    if (!stagedId) throw new Error("Expected a staged DM reaction");

    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: dm.thread,
      message: makeMessage({
        id: "7150.3",
        text: "Start the next DM generation",
        userId: "U-EARLY-DM",
      }),
      trigger: "direct_message",
    });
    const conversations = await service.listConversations(endpoint.id);
    expect(conversations).toHaveLength(2);
    const nextConversation = conversations.find(
      (candidate) => candidate.id !== firstConversation.id,
    );
    expect(nextConversation).toMatchObject({
      state: "active",
      sessionGeneration: 2,
    });
    const wakeupCount = wakeup.mock.calls.length;
    const runCount = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, fixture.companyId))
      .then((rows) => rows.length);
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(chatDeliveries.id, stagedId));
    await service.processPendingDeliveries(1, stagedId);
    const [replayed] = await readChatDeliveriesById(stagedId);
    expect(replayed).toMatchObject({
      conversationId: firstConversation.id,
      state: "processed",
    });
    expect(replayed.conversationId).not.toBe(nextConversation?.id);
    expect(wakeup).toHaveBeenCalledTimes(wakeupCount);
    await expect(
      db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.companyId, fixture.companyId))
        .then((rows) => rows.length),
    ).resolves.toBe(runCount);
  });

  it("maps a timestamp-bearing Slack DM reaction to the completed generation that owns its linked message", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } =
      await configuredSlackEndpoint(fixture);
    const channelId = "D-TOP-LEVEL-REACTION";
    const dm = makeThread({
      channelId,
      id: `slack:${channelId}:`,
      isDM: true,
      name: "Slack direct message",
    });
    const original = makeMessage({
      id: "7120.1",
      text: "Observe this top-level DM reaction",
      userId: "U-DM-REACTION",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: dm.thread,
      message: original,
      trigger: "direct_message",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id);
    if (!callbacks.onReaction)
      throw new Error("Slack reaction callback was not registered");

    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    expect(conversation).toMatchObject({
      externalThreadId: dm.thread.id,
      isDirectMessage: true,
    });
    await db
      .update(issues)
      .set({ status: "done", completedAt: new Date(), updatedAt: new Date() })
      .where(eq(issues.id, conversation!.issueId));
    const newerMessage = makeMessage({
      id: "7120.2",
      text: "Start the newer DM task generation",
      userId: original.author.userId,
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: dm.thread,
      message: newerMessage,
      trigger: "direct_message",
    });
    const conversations = await service.listConversations(endpoint.id);
    expect(conversations).toHaveLength(2);
    expect(
      conversations.find((candidate) => candidate.id === conversation!.id),
    ).toMatchObject({ state: "completed", sessionGeneration: 1 });
    expect(
      conversations.find((candidate) => candidate.id !== conversation!.id),
    ).toMatchObject({ state: "active", sessionGeneration: 2 });
    const commentCountBefore = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.issueId, conversation!.issueId))
      .then((rows) => rows.length);
    const wakeupCountBefore = wakeup.mock.calls.length;
    const runCountBefore = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, fixture.companyId))
      .then((rows) => rows.length);
    const issueCountBefore = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.companyId, fixture.companyId))
      .then((rows) => rows.length);
    const emoji = {
      name: "thumbs_up",
      toJSON: () => ":thumbs_up:",
      toString: () => ":thumbs_up:",
    };
    await callbacks.onReaction({
      endpointId: endpoint.id,
      provider: "slack",
      event: {
        adapter: {} as never,
        added: true,
        emoji,
        message: original,
        messageId: original.id,
        raw: { event_ts: "7121.1" },
        rawEmoji: "+1",
        thread: dm.thread,
        threadId: `slack:${channelId}:${original.id}`,
        user: original.author,
      },
    });

    await expect(
      db
        .select()
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.conversationId, conversation!.id),
            eq(chatDeliveries.eventKind, "reaction_added"),
          ),
        ),
    ).resolves.toEqual([
      expect.objectContaining({
        state: "processed",
        normalizedEvent: expect.objectContaining({
          conversation: {
            externalThreadId: `slack:${channelId}:${original.id}`,
          },
          message: { providerMessageId: original.id },
          reaction: { added: true, emoji: "thumbs_up", rawEmoji: "+1" },
        }),
      }),
    ]);
    await expect(
      db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(eq(issueComments.issueId, conversation!.issueId))
        .then((rows) => rows.length),
    ).resolves.toBe(commentCountBefore);
    expect(wakeup).toHaveBeenCalledTimes(wakeupCountBefore);
    await expect(
      db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.companyId, fixture.companyId))
        .then((rows) => rows.length),
    ).resolves.toBe(runCountBefore);
    await expect(
      db
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.companyId, fixture.companyId))
        .then((rows) => rows.length),
    ).resolves.toBe(issueCountBefore);
    await expect(service.listConversations(endpoint.id)).resolves.toHaveLength(
      2,
    );
  });
});
