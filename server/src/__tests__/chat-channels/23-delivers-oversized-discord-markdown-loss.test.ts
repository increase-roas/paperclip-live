import { chatHistoryActionBlocks } from ".././helpers/chat-history-proof.js";
import { idleWorkSnapshot } from "../../services/task-admission.js";
import type { Db } from "@paperclipai/db";
import { createDeliveryWorkCoordinator } from "../../services/delivery-work-coordinator.js";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, like, sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { chatActions, chatConversations, chatDeliveries, chatEndpointLeases, chatEndpointResources, chatPublications, heartbeatRuns, issueComments, issueThreadInteractions, toolConnections } from "@paperclipai/db";
import type { Message } from "chat";
import { issueService } from "../../services/issues.js";
import { issueThreadInteractionService } from "../../services/issue-thread-interactions.js";
import { projectSafeChatPublicationText } from "../../services/chat-publication-projection.js";
import { makeMessage, makeThread } from ".././helpers/chat-channels-fixture.js";
import { configuredDiscordEndpoint, configuredSlackEndpoint, configuredTelegramEndpoint, db, deliverMessage, describeChatChannelsSuite, qualifySetupRoundTrip, readChatConversationsByEndpointId, readChatConversationsById, readChatPublicationsByCommentId, readChatPublicationsById, readIssuesById, readToolConnectionsById, retirePublicationFixture, seedCompany } from "../helpers/chat-channels-harness.js";







describeChatChannelsSuite("chat channels 23-delivers-oversized-discord-markdown-loss", () => {
  it("delivers oversized Discord Markdown losslessly as one retryable attachment", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredDiscordEndpoint(fixture);
    const guildId = "1457808928258658549";
    const channelId = "333333333333333333";
    const messageId = "555555555555555599";
    const threadId = `discord:${guildId}:${channelId}:${messageId}`;
    const message = {
      ...makeMessage({
        id: messageId,
        text: "@maya send the complete long result",
        mentioned: true,
        userId: "444444444444444444",
      }),
      threadId,
    } as Message;
    const admitRootMention = callbacks.onDiscordRootMentionAdmission;
    if (!admitRootMention)
      throw new Error("Expected Discord root-mention admission callback");

    await expect(
      admitRootMention({
        endpointId: endpoint.id,
        guildId,
        channelId,
        messageId,
        message,
        threadId,
        userId: "444444444444444444",
      }),
    ).resolves.toBe(false);
    const [delivery] = await db
      .select({ id: chatDeliveries.id })
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(chatDeliveries.providerEventId, `${threadId}:${messageId}`),
        ),
      );
    if (!delivery) throw new Error("Expected Discord root delivery");
    await service.processPendingDeliveries(25, delivery.id);
    await qualifySetupRoundTrip(service, endpoint.id, "444444444444444444");
    await service.test(endpoint.id);
    const [conversation] = await service.listConversations(endpoint.id);
    if (!conversation) throw new Error("Expected Discord conversation");

    const source = [
      "## Complete result 🙂",
      "[Open the evidence](https://example.test/evidence?case=discord)",
      `\`\`\`ts\n${"const value = 1;\n".repeat(80)}\`\`\``,
      "@alice ".repeat(180).trim(),
    ].join("\n\n");
    const providerSafeSource = projectSafeChatPublicationText(source);
    const comment = await issueService(db).addComment(
      conversation.issueId,
      source,
      { userId: "owner-user" },
      { authorType: "user" },
    );
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected Discord provider runtime");
    providerRuntime.posts.length = 0;
    let transportAttempt = 0;
    providerRuntime.postHook = async () => {
      transportAttempt += 1;
      if (transportAttempt === 1) {
        throw Object.assign(new Error("Discord attachment rate limited"), {
          adapter: "discord",
          status: 429,
          retryAfterMs: 1_000,
        });
      }
    };

    const blocked = await service.publishComment(
      endpoint.id,
      conversation.id,
      comment.id,
    );
    expect(blocked).toMatchObject({ state: "retry" });
    const [afterFailure] = await readChatPublicationsByCommentId(comment.id);
    expect(afterFailure).toMatchObject({
      state: "retry",
      attempts: 1,
      payload: {
        text: providerSafeSource,
        transportPart: {
          count: 1,
          index: 0,
          mode: "discord_markdown_attachment",
        },
      },
    });
    expect(providerRuntime.posts).toHaveLength(0);

    providerRuntime.postHook = undefined;
    await db
      .update(chatPublications)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(chatPublications.id, afterFailure.id));
    await service.processPendingPublications();

    const [completed] = await readChatPublicationsById(afterFailure.id);
    expect(completed).toMatchObject({ state: "published", attempts: 2 });
    expect(providerRuntime.posts).toHaveLength(1);
    const delivered = providerRuntime.posts[0]!;
    expect(delivered.text).toBe(
      "Paperclip attached the complete response because it exceeds Discord’s message limit.",
    );
    expect(delivered.text).not.toContain("...");
    expect(delivered.files).toHaveLength(1);
    const uploaded = delivered.files?.[0] as {
      data: Buffer;
      filename: string;
      mimeType: string;
    };
    expect(uploaded.filename).toBe("paperclip-response.md");
    expect(uploaded.mimeType).toBe("text/markdown; charset=utf-8");
    expect(Buffer.isBuffer(uploaded.data)).toBe(true);
    // The attachment is lossless after Paperclip's mandatory provider-safety
    // projection (which strips URL query strings before any transport work).
    expect(uploaded.data.toString("utf8")).toBe(providerSafeSource);
    expect(uploaded.data.toString("utf8")).not.toContain("?case=discord");

    providerRuntime.posts.length = 0;
    providerRuntime.edits.length = 0;
    providerRuntime.editAttempts.length = 0;
    const discordLongRunId = randomUUID();
    const replacementCreatedAt = new Date();
    await db.insert(chatPublications).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      conversationId: conversation.id,
      issueId: conversation.issueId,
      idempotencyKey: `run:${discordLongRunId}:working:${endpoint.id}`,
      payload: { text: "Working…", progressState: "working" },
      state: "published",
      providerMessageId: "working-message-1",
      createdAt: replacementCreatedAt,
      updatedAt: replacementCreatedAt,
    });
    const [replacementPublication] = await db
      .insert(chatPublications)
      .values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: conversation.id,
        issueId: conversation.issueId,
        idempotencyKey: `run:${discordLongRunId}:completed:${endpoint.id}`,
        payload: { text: providerSafeSource, progressState: "completed" },
        state: "pending",
        createdAt: new Date(replacementCreatedAt.getTime() + 1),
        updatedAt: new Date(replacementCreatedAt.getTime() + 1),
      })
      .returning();
    await service.processPendingPublications();

    const replacementBatch = await db
      .select()
      .from(chatPublications)
      .where(
        sql`${chatPublications.payload}->'transportPart'->>'batchId' = ${replacementPublication.id}`,
      )
      .orderBy(
        sql`(${chatPublications.payload}->'transportPart'->>'index')::int`,
      );
    expect(replacementBatch).toHaveLength(2);
    expect(replacementBatch.map((row) => row.state)).toEqual([
      "published",
      "published",
    ]);
    expect(
      replacementBatch.map((row) => row.payload.transportPart?.mode),
    ).toEqual(["inline", "discord_markdown_attachment"]);
    expect(providerRuntime.editAttempts).toEqual([
      {
        threadId,
        messageId: "working-message-1",
      },
    ]);
    expect(providerRuntime.edits[0]?.text).toBe(
      "This response needs a separate attachment because it exceeds the message limit.",
    );
    expect(providerRuntime.posts).toHaveLength(1);
    expect(providerRuntime.posts[0]?.text).toBe("Complete response attached.");
    const replacementUpload = providerRuntime.posts[0]?.files?.[0] as {
      data: Buffer;
    };
    expect(replacementUpload.data.toString("utf8")).toBe(providerSafeSource);

    providerRuntime.posts.length = 0;
    providerRuntime.edits.length = 0;
    providerRuntime.editAttempts.length = 0;
    const rejectedRunId = randomUUID();
    const rejectedCreatedAt = new Date();
    await db.insert(chatPublications).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      conversationId: conversation.id,
      issueId: conversation.issueId,
      idempotencyKey: `run:${rejectedRunId}:working:${endpoint.id}`,
      payload: { text: "Working on the attachment…", progressState: "working" },
      state: "published",
      providerMessageId: "working-message-rejected-attachment",
      createdAt: rejectedCreatedAt,
      updatedAt: rejectedCreatedAt,
    });
    const [rejectedPublication] = await db
      .insert(chatPublications)
      .values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: conversation.id,
        issueId: conversation.issueId,
        idempotencyKey: `run:${rejectedRunId}:completed:${endpoint.id}`,
        payload: { text: providerSafeSource, progressState: "completed" },
        state: "pending",
        createdAt: new Date(rejectedCreatedAt.getTime() + 1),
        updatedAt: new Date(rejectedCreatedAt.getTime() + 1),
      })
      .returning();
    let rejectAttachmentOnce = true;
    providerRuntime.postHook = async () => {
      if (!rejectAttachmentOnce) return;
      rejectAttachmentOnce = false;
      throw Object.assign(new Error("Discord rejected the attachment"), {
        adapter: "discord",
        response: { status: 400 },
        status: 400,
      });
    };
    await service.processPendingPublications();
    providerRuntime.postHook = undefined;

    const rejectedBatch = await db
      .select()
      .from(chatPublications)
      .where(
        sql`${chatPublications.payload}->'transportPart'->>'batchId' = ${rejectedPublication.id}`,
      )
      .orderBy(
        sql`(${chatPublications.payload}->'transportPart'->>'index')::int`,
      );
    expect(rejectedBatch.map((row) => row.state)).toEqual([
      "published",
      "failed",
    ]);
    const definiteFailureNotices = await db
      .select()
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.companyId, fixture.companyId),
          like(
            chatPublications.idempotencyKey,
            `attachment-failure-notice:${rejectedBatch[1]!.id}:%`,
          ),
        ),
      );
    expect(definiteFailureNotices).toHaveLength(1);
    const rejectedAttachmentNotice =
      "Paperclip could not send the response attachment. The complete response remains on its Paperclip task for an operator to retry." +
      ` Open task: https://paperclip.example/issues/${conversation.issueId}`;
    expect(definiteFailureNotices[0]).toMatchObject({
      commentId: null,
      state: "published",
      payload: {
        text: rejectedAttachmentNotice,
      },
    });
    expect(providerRuntime.editAttempts).toEqual([
      {
        threadId,
        messageId: "working-message-rejected-attachment",
      },
    ]);
    expect(providerRuntime.edits[0]?.text).toBe(
      "This response needs a separate attachment because it exceeds the message limit.",
    );
    expect(providerRuntime.posts).toEqual([
      {
        threadId,
        text: rejectedAttachmentNotice,
      },
    ]);
    await service.processPendingPublications();
    expect(providerRuntime.posts).toHaveLength(1);

    const staleNoticeId = randomUUID();
    await db.insert(chatPublications).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      conversationId: conversation.id,
      issueId: conversation.issueId,
      idempotencyKey: `attachment-failure-notice:${staleNoticeId}:999:${"a".repeat(64)}`,
      payload: { text: "stale attachment failure notice" },
      state: "pending",
    });
    await service.processPendingPublications();
    await expect(
      db
        .select({ state: chatPublications.state })
        .from(chatPublications)
        .where(
          eq(
            chatPublications.idempotencyKey,
            `attachment-failure-notice:${staleNoticeId}:999:${"a".repeat(64)}`,
          ),
        ),
    ).resolves.toEqual([{ state: "cancelled" }]);
    expect(providerRuntime.posts).toHaveLength(1);

    const cardKey = `discord-card-not-split:${endpoint.id}`;
    await db.insert(chatPublications).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      conversationId: conversation.id,
      issueId: conversation.issueId,
      idempotencyKey: cardKey,
      payload: {
        text: source,
        card: {
          schema: "paperclip.chat.card.v1",
          kind: "status",
          title: "Long structured card",
        },
      },
      state: "pending",
    });
    await service.processPendingPublications();
    await expect(
      db
        .select({ payload: chatPublications.payload })
        .from(chatPublications)
        .where(like(chatPublications.idempotencyKey, `${cardKey}%`)),
    ).resolves.toEqual([
      {
        payload: expect.not.objectContaining({
          transportPart: expect.anything(),
        }),
      },
    ]);
    expect(providerRuntime.posts.at(-1)?.files).toBeUndefined();

    const ambiguousRunId = randomUUID();
    const ambiguousCreatedAt = new Date();
    await db.insert(chatPublications).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      conversationId: conversation.id,
      issueId: conversation.issueId,
      idempotencyKey: `run:${ambiguousRunId}:working:${endpoint.id}`,
      payload: {
        text: "Working on another attachment…",
        progressState: "working",
      },
      state: "published",
      providerMessageId: "working-message-ambiguous-attachment",
      createdAt: ambiguousCreatedAt,
      updatedAt: ambiguousCreatedAt,
    });
    const [ambiguousPublication] = await db
      .insert(chatPublications)
      .values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: conversation.id,
        issueId: conversation.issueId,
        idempotencyKey: `run:${ambiguousRunId}:completed:${endpoint.id}`,
        payload: { text: providerSafeSource, progressState: "completed" },
        state: "pending",
        createdAt: new Date(ambiguousCreatedAt.getTime() + 1),
        updatedAt: new Date(ambiguousCreatedAt.getTime() + 1),
      })
      .returning();
    providerRuntime.postHook = async () => {
      throw Object.assign(new Error("Discord attachment response was lost"), {
        adapter: "discord",
        name: "NetworkError",
      });
    };
    await service.processPendingPublications();
    providerRuntime.postHook = undefined;
    await expect(
      db
        .select({ state: chatPublications.state })
        .from(chatPublications)
        .where(
          sql`${chatPublications.payload}->'transportPart'->>'batchId' = ${ambiguousPublication.id}`,
        )
        .orderBy(
          sql`(${chatPublications.payload}->'transportPart'->>'index')::int`,
        ),
    ).resolves.toEqual([{ state: "published" }, { state: "delivery_unknown" }]);
    await expect(
      db
        .select({ id: chatPublications.id })
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.companyId, fixture.companyId),
            eq(chatPublications.state, "published"),
            like(
              chatPublications.idempotencyKey,
              "attachment-failure-notice:%",
            ),
          ),
        ),
    ).resolves.toHaveLength(1);
    await service.shutdown();
  });

  it("isolates malformed publication preparation so later messages still deliver", async () => {
    const fixture = await seedCompany();
    let transientPublicationId: string | null = null;
    let failTransientPreparation = true;
    const { callbacks, endpoint, runtime, service } =
      await configuredDiscordEndpoint(fixture, {
        publicationTransportPreparationBarrier: async ({ publicationId }) => {
          if (
            publicationId === transientPublicationId &&
            failTransientPreparation
          ) {
            failTransientPreparation = false;
            throw Object.assign(new Error("temporary preparation outage"), {
              name: "NetworkError",
            });
          }
        },
      });
    const guildId = "1457808928258658549";
    // Match the text channel returned by fakeDiscordFetch; an unknown channel
    // is correctly filtered before setup can activate its first destination.
    const channelId = "333333333333333333";
    const messageId = "555555555555555600";
    const threadId = `discord:${guildId}:${channelId}:${messageId}`;
    const admitRootMention = callbacks.onDiscordRootMentionAdmission;
    if (!admitRootMention)
      throw new Error("Expected Discord root-mention admission callback");
    await expect(
      admitRootMention({
        endpointId: endpoint.id,
        guildId,
        channelId,
        messageId,
        message: {
          ...makeMessage({
            id: messageId,
            text: "@maya verify publication queue isolation",
            mentioned: true,
            userId: "444444444444444444",
          }),
          threadId,
        } as Message,
        threadId,
        userId: "444444444444444444",
      }),
    ).resolves.toBe(false);
    const [delivery] = await db
      .select({ id: chatDeliveries.id })
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(chatDeliveries.providerEventId, `${threadId}:${messageId}`),
        ),
      );
    if (!delivery) throw new Error("Expected Discord root delivery");
    await service.processPendingDeliveries(25, delivery.id);
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id);
    const [conversation] = await service.listConversations(endpoint.id);
    if (!conversation) throw new Error("Expected Discord conversation");
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected Discord provider runtime");
    providerRuntime.posts.length = 0;

    const createdAt = new Date();
    const [malformed, healthy] = await db
      .insert(chatPublications)
      .values([
        {
          companyId: fixture.companyId,
          endpointId: endpoint.id,
          conversationId: conversation.id,
          issueId: conversation.issueId,
          idempotencyKey: `malformed-publication:${randomUUID()}`,
          payload: {} as never,
          state: "pending" as const,
          createdAt,
          updatedAt: createdAt,
        },
        {
          companyId: fixture.companyId,
          endpointId: endpoint.id,
          conversationId: conversation.id,
          issueId: conversation.issueId,
          idempotencyKey: `healthy-after-malformed:${randomUUID()}`,
          payload: { text: "Healthy publication after malformed durable row" },
          state: "pending" as const,
          createdAt: new Date(createdAt.getTime() + 1),
          updatedAt: new Date(createdAt.getTime() + 1),
        },
      ])
      .returning();

    await expect(service.processPendingPublications()).resolves.toBe(2);
    await expect(
      db
        .select({
          id: chatPublications.id,
          redactedError: chatPublications.redactedError,
          state: chatPublications.state,
        })
        .from(chatPublications)
        .where(inArray(chatPublications.id, [malformed.id, healthy.id]))
        .orderBy(asc(chatPublications.createdAt)),
    ).resolves.toEqual([
      {
        id: malformed.id,
        redactedError:
          "Publication payload could not be prepared for provider delivery",
        state: "failed",
      },
      { id: healthy.id, redactedError: null, state: "published" },
    ]);
    expect(providerRuntime.posts).toHaveLength(1);
    expect(providerRuntime.posts[0]?.text).toBe(
      "Healthy publication after malformed durable row",
    );

    const [transient] = await db
      .insert(chatPublications)
      .values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: conversation.id,
        issueId: conversation.issueId,
        idempotencyKey: `transient-publication:${randomUUID()}`,
        payload: { text: "Healthy publication after a transient outage" },
        state: "pending",
      })
      .returning();
    transientPublicationId = transient.id;
    await expect(service.processPendingPublications()).resolves.toBe(1);
    await expect(
      db
        .select({
          attempts: chatPublications.attempts,
          state: chatPublications.state,
        })
        .from(chatPublications)
        .where(eq(chatPublications.id, transient.id)),
    ).resolves.toEqual([{ attempts: 1, state: "retry" }]);
    expect(providerRuntime.posts).toHaveLength(1);

    await db
      .update(chatPublications)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(chatPublications.id, transient.id));
    await expect(service.processPendingPublications()).resolves.toBe(1);
    await expect(
      db
        .select({
          attempts: chatPublications.attempts,
          state: chatPublications.state,
        })
        .from(chatPublications)
        .where(eq(chatPublications.id, transient.id)),
    ).resolves.toEqual([{ attempts: 2, state: "published" }]);
    expect(providerRuntime.posts.at(-1)?.text).toBe(
      "Healthy publication after a transient outage",
    );
    await service.shutdown();
  });

  it.each([
    {
      label: "prose",
      source: `${"The cat rests beside the window in warm light. ".repeat(55)}Done.`,
    },
    {
      label: "formatted code",
      source: `\`\`\`ts\n${"const ready = true;\n".repeat(110)}\`\`\``,
    },
  ])(
    "keeps medium Telegram $label in one native publication",
    async ({ source }) => {
      const fixture = await seedCompany();
      const { callbacks, endpoint, runtime, service } =
        await configuredTelegramEndpoint(fixture);
      const chatId = "77118846";
      const dm = makeThread({
        channelId: chatId,
        id: `telegram:${chatId}`,
        isDM: true,
        name: "Telegram intact output",
      });
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider: "telegram",
        thread: dm.thread,
        message: makeMessage({
          id: `${chatId}:1`,
          text: "Send the complete result",
          userId: chatId,
        }),
        trigger: "direct_message",
      });
      await qualifySetupRoundTrip(service, endpoint.id, chatId);
      await service.test(endpoint.id);
      const [conversation] = await service.listConversations(endpoint.id);
      if (!conversation)
        throw new Error("Expected Telegram intact conversation");
      const comment = await issueService(db).addComment(
        conversation.issueId,
        source,
        { userId: "owner-user" },
        { authorType: "user" },
      );
      const providerRuntime = runtime.endpoints.get(endpoint.id);
      if (!providerRuntime)
        throw new Error("Expected Telegram provider runtime");
      providerRuntime.posts.length = 0;
      const publication = await service.publishComment(
        endpoint.id,
        conversation.id,
        comment.id,
      );
      expect(publication).toMatchObject({ state: "published", attempts: 1 });
      const rows = await readChatPublicationsByCommentId(comment.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload.transportPart).toBeUndefined();
      expect(providerRuntime.posts).toHaveLength(1);
      expect(providerRuntime.posts[0]?.text).toBe(source);
      expect(providerRuntime.posts[0]?.attachments ?? []).toHaveLength(0);
      await service.processPendingPublications();
      expect(providerRuntime.posts).toHaveLength(1);
    },
  );

  it("segments long Telegram output into durable FIFO publications and resumes at the failed part", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredTelegramEndpoint(fixture);
    const chatId = "77118844";
    const dm = makeThread({
      channelId: chatId,
      id: `telegram:${chatId}`,
      isDM: true,
      name: "Telegram segmented output",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: dm.thread,
      message: makeMessage({
        id: `${chatId}:1`,
        text: "Send the complete long result",
        userId: chatId,
      }),
      trigger: "direct_message",
    });
    await qualifySetupRoundTrip(service, endpoint.id, chatId);
    await service.test(endpoint.id);
    const [conversation] = await service.listConversations(endpoint.id);
    if (!conversation)
      throw new Error("Expected Telegram segmented conversation");
    const source = Array.from({ length: 5_003 }, (_value, index) =>
      String(index % 10),
    ).join("");
    const comment = await issueService(db).addComment(
      conversation.issueId,
      source,
      { userId: "owner-user" },
      { authorType: "user" },
    );
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected Telegram provider runtime");
    providerRuntime.posts.length = 0;
    let transportAttempt = 0;
    providerRuntime.postHook = async () => {
      transportAttempt += 1;
      if (transportAttempt === 2) {
        throw Object.assign(new Error("Telegram part rate limited"), {
          status: 429,
          retryAfterMs: 1_000,
        });
      }
    };

    const blocked = await service.publishComment(
      endpoint.id,
      conversation.id,
      comment.id,
    );
    expect(blocked).toMatchObject({ state: "retry" });
    const afterFailure = await readChatPublicationsByCommentId(comment.id)
      .orderBy(
        sql`(${chatPublications.payload}->'transportPart'->>'index')::int`,
      );
    expect(afterFailure.map((row) => row.payload.transportPart?.index)).toEqual(
      [0, 1, 2, 3],
    );
    expect(afterFailure.map((row) => row.state)).toEqual([
      "published",
      "retry",
      "pending",
      "pending",
    ]);
    expect(providerRuntime.posts.map((post) => post.text).join("")).toBe(
      source.slice(0, 1_600),
    );

    providerRuntime.postHook = undefined;
    await db
      .update(chatPublications)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(chatPublications.id, blocked.id));
    await service.processPendingPublications();

    const completed = await readChatPublicationsByCommentId(comment.id)
      .orderBy(
        sql`(${chatPublications.payload}->'transportPart'->>'index')::int`,
      );
    expect(completed.map((row) => row.state)).toEqual([
      "published",
      "published",
      "published",
      "published",
    ]);
    expect(completed.map((row) => row.attempts)).toEqual([1, 2, 1, 1]);
    expect(providerRuntime.posts.map((post) => post.text).join("")).toBe(
      source,
    );
    expect(
      providerRuntime.posts.every(
        (post) => Array.from(post.text).length <= 1_600,
      ),
    ).toBe(true);
  });

  it("publishes long structured Telegram Markdown as one durable lossless document", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredTelegramEndpoint(fixture);
    const chatId = "77118845";
    const dm = makeThread({
      channelId: chatId,
      id: `telegram:${chatId}`,
      isDM: true,
      name: "Telegram structured output",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: dm.thread,
      message: makeMessage({
        id: `${chatId}:1`,
        text: "Send the complete formatted result",
        userId: chatId,
      }),
      trigger: "direct_message",
    });
    await qualifySetupRoundTrip(service, endpoint.id, chatId);
    await service.test(endpoint.id);
    const [conversation] = await service.listConversations(endpoint.id);
    if (!conversation)
      throw new Error("Expected Telegram structured conversation");
    const source = [
      "## Complete result",
      "[Open the evidence](https://example.test/evidence?case=telegram)",
      `\`\`\`ts\n${"const value = 1;\n".repeat(250)}\`\`\``,
      Array.from({ length: 100 }, (_value, index) => `- Finding ${index}`).join(
        "\n",
      ),
    ].join("\n\n");
    const providerSafeSource = projectSafeChatPublicationText(source);
    const comment = await issueService(db).addComment(
      conversation.issueId,
      source,
      { userId: "owner-user" },
      { authorType: "user" },
    );
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected Telegram provider runtime");
    providerRuntime.posts.length = 0;
    let transportAttempt = 0;
    providerRuntime.postHook = async () => {
      transportAttempt += 1;
      if (transportAttempt === 1) {
        throw Object.assign(new Error("Telegram document rate limited"), {
          adapter: "telegram",
          status: 429,
          retryAfterMs: 1_000,
        });
      }
    };

    const blocked = await service.publishComment(
      endpoint.id,
      conversation.id,
      comment.id,
    );
    expect(blocked).toMatchObject({ state: "retry" });
    const [afterFailure] = await readChatPublicationsByCommentId(comment.id);
    expect(afterFailure).toMatchObject({
      state: "retry",
      attempts: 1,
      payload: {
        text: providerSafeSource,
        transportPart: {
          count: 1,
          index: 0,
          mode: "telegram_markdown_attachment",
        },
      },
    });
    expect(providerRuntime.posts).toHaveLength(0);

    providerRuntime.postHook = undefined;
    await db
      .update(chatPublications)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(chatPublications.id, afterFailure.id));
    await service.processPendingPublications();

    const [completed] = await readChatPublicationsById(afterFailure.id);
    expect(completed).toMatchObject({ state: "published", attempts: 2 });
    expect(providerRuntime.posts).toHaveLength(1);
    expect(providerRuntime.posts[0]?.text).toBe(
      "Paperclip attached the complete response to preserve its Markdown formatting.",
    );
    const attachment = providerRuntime.posts[0]?.attachments?.[0] as {
      data: Buffer;
      mimeType: string;
      name: string;
      size: number;
      type: string;
    };
    expect(attachment).toMatchObject({
      mimeType: "text/markdown; charset=utf-8",
      name: "paperclip-response.md",
      size: Buffer.byteLength(providerSafeSource),
      type: "file",
    });
    expect(Buffer.isBuffer(attachment.data)).toBe(true);
    expect(attachment.data.toString("utf8")).toBe(providerSafeSource);
    expect(attachment.data.toString("utf8")).not.toContain("?case=telegram");

    providerRuntime.posts.length = 0;
    providerRuntime.edits.length = 0;
    providerRuntime.editAttempts.length = 0;
    const runId = randomUUID();
    const workingCreatedAt = new Date();
    await db.insert(chatPublications).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      conversationId: conversation.id,
      issueId: conversation.issueId,
      idempotencyKey: `run:${runId}:working:${endpoint.id}`,
      payload: { text: "Maya is working…", progressState: "working" },
      state: "published",
      providerMessageId: "telegram-working-message-1",
      createdAt: workingCreatedAt,
      updatedAt: workingCreatedAt,
    });
    const [finalPublication] = await db
      .insert(chatPublications)
      .values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: conversation.id,
        issueId: conversation.issueId,
        idempotencyKey: `run:${runId}:completed:${endpoint.id}`,
        payload: { text: providerSafeSource, progressState: "completed" },
        state: "pending",
        createdAt: new Date(workingCreatedAt.getTime() + 1),
        updatedAt: new Date(workingCreatedAt.getTime() + 1),
      })
      .returning();
    await service.processPendingPublications();

    const replacementBatch = await db
      .select()
      .from(chatPublications)
      .where(
        sql`${chatPublications.payload}->'transportPart'->>'batchId' = ${finalPublication.id}`,
      )
      .orderBy(
        sql`(${chatPublications.payload}->'transportPart'->>'index')::int`,
      );
    expect(replacementBatch).toHaveLength(2);
    expect(replacementBatch.map((row) => row.state)).toEqual([
      "published",
      "published",
    ]);
    expect(
      replacementBatch.map((row) => row.payload.transportPart?.mode),
    ).toEqual(["inline", "telegram_markdown_attachment"]);
    expect(providerRuntime.editAttempts).toEqual([
      {
        threadId: dm.thread.id,
        messageId: "telegram-working-message-1",
      },
    ]);
    expect(providerRuntime.edits[0]?.text).toBe(
      "This response needs a separate attachment because it exceeds the message limit.",
    );
    expect(providerRuntime.posts).toHaveLength(1);
    expect(providerRuntime.posts[0]?.text).toBe("Complete response attached.");
    const replacementAttachment = providerRuntime.posts[0]
      ?.attachments?.[0] as { data: Buffer };
    expect(replacementAttachment.data.toString("utf8")).toBe(
      providerSafeSource,
    );
  });

  it.each([
    {
      label: "rate limits as an automatic retry",
      error: Object.assign(new Error("provider rate limit"), {
        status: 429,
        retryAfterMs: 5_000,
      }),
      expectedPublicationState: "retry",
      expectedEndpointStatus: "active",
      expectedConversationState: "active",
      expectedResourceAvailability: "available",
    },
    {
      provider: "slack",
      label: "authentication failures as endpoint attention",
      error: Object.assign(new Error("provider token expired"), {
        status: 401,
      }),
      expectedPublicationState: "failed",
      expectedEndpointStatus: "attention",
      expectedConversationState: "active",
      expectedResourceAvailability: "available",
    },
    {
      provider: "discord",
      label: "Discord authentication failures as endpoint attention",
      error: Object.assign(new Error("provider token expired"), { status: 401 }),
      expectedPublicationState: "failed",
      expectedEndpointStatus: "attention",
      expectedConversationState: "active",
      expectedResourceAvailability: "available",
    },
    {
      label: "missing destinations as resource unavailable",
      error: Object.assign(new Error("provider destination missing"), {
        status: 404,
      }),
      expectedPublicationState: "cancelled",
      expectedEndpointStatus: "active",
      expectedConversationState: "unavailable",
      expectedResourceAvailability: "unavailable",
    },
    {
      label: "Discord missing channel permissions as resource unavailable",
      error: Object.assign(new Error("Discord API error: 403"), {
        name: "NetworkError",
        adapter: "discord",
        code: "NETWORK_ERROR",
        status: 403,
        response: { status: 403, headers: {} },
        originalError: {
          name: "DiscordApiError",
          code: 50013,
          status: 403,
        },
      }),
      expectedPublicationState: "cancelled",
      expectedEndpointStatus: "active",
      expectedConversationState: "unavailable",
      expectedResourceAvailability: "unavailable",
    },
    {
      label: "pre-transport validation as a definite failure",
      error: Object.assign(new Error("untrusted Teams service URL"), {
        name: "TeamsServiceUrlValidationError",
        code: "CHAT_PROVIDER_PRETRANSPORT_REJECTED",
      }),
      expectedPublicationState: "failed",
      expectedEndpointStatus: "active",
      expectedConversationState: "active",
      expectedResourceAvailability: "available",
    },
    {
      label: "wrapped Slack platform rejection as a definite failure",
      error: Object.assign(new Error("Slack block fallback failed"), {
        cause: Object.assign(new Error("Slack invalid_blocks"), {
          code: "slack_webapi_platform_error",
          data: { error: "invalid_blocks" },
        }),
      }),
      expectedPublicationState: "failed",
      expectedEndpointStatus: "active",
      expectedConversationState: "active",
      expectedResourceAvailability: "available",
    },
  ])(
    "classifies publication $label",
    async ({
      provider = "slack",
      error,
      expectedConversationState,
      expectedEndpointStatus,
      expectedPublicationState,
      expectedResourceAvailability,
    }) => {
      const fixture = await seedCompany();
      const { callbacks, endpoint, runtime, service } =
        await (provider === "discord" ? configuredDiscordEndpoint(fixture) : configuredSlackEndpoint(fixture));
      try {
        const channelId = provider === "discord" ? "333333333333333329" : `C-PUBLICATION-ERROR-${randomUUID().slice(0, 8)}`;
        const channel = makeThread({
          channelId,
          id: provider === "discord" ? `discord:1457808928258658549:${channelId}:555555555555555596` : `slack:${channelId}:4200.1`,
          name: "publication-errors",
        });
        await deliverMessage({
          callbacks,
          endpointId: endpoint.id,
          provider: provider as "slack" | "discord",
          thread: channel.thread,
          message: makeMessage({
            id: provider === "discord" ? "555555555555555596" : "4200.1",
            text: "@maya exercise provider failure handling",
            mentioned: true,
          }),
          trigger: "mention",
        });
        await qualifySetupRoundTrip(service, endpoint.id);
        await service.test(endpoint.id);
        const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
        const comment = await issueService(db).addComment(
          conversation.issueId,
          "Safe provider response",
          { userId: "owner-user" },
          { authorType: "user" },
        );
        const providerRuntime = runtime.endpoints.get(endpoint.id);
        if (!providerRuntime) throw new Error("Expected provider runtime");
        providerRuntime.postError = error;
        const beforeAttempt = Date.now();
        await service.publishComment(endpoint.id, conversation.id, comment.id);

        const [publication] = await readChatPublicationsByCommentId(comment.id);
        expect(publication).toMatchObject({
          state: expectedPublicationState,
          attempts: 1,
          redactedError: error.message,
        });
        if (expectedPublicationState === "retry") {
          expect(publication.nextAttemptAt?.getTime()).toBeGreaterThanOrEqual(
            beforeAttempt + 4_500,
          );
        } else {
          expect(publication.nextAttemptAt).toBeNull();
        }
        await expect(service.get(endpoint.id)).resolves.toMatchObject({
          status: expectedEndpointStatus,
        });
        const [storedConversation] = await readChatConversationsById(conversation.id);
        expect(storedConversation.state).toBe(expectedConversationState);
        const [resource] = await db
          .select()
          .from(chatEndpointResources)
          .where(eq(chatEndpointResources.id, conversation.resourceId!));
        expect(resource.availability).toBe(expectedResourceAvailability);
        if (expectedEndpointStatus === "attention") {
          expect(runtime.endpoints.has(endpoint.id)).toBe(false);
          const [connection] = await readToolConnectionsById(endpoint.connectionId);
          expect(connection).toMatchObject({
            status: "active",
            enabled: true,
            healthStatus: "failed",
          });
          await service.reconcileProviderRuntimes();
          expect(runtime.endpoints.has(endpoint.id)).toBe(false);
          expect((await service.get(endpoint.id)).status).toBe("attention");
        }
      } finally {
        await retirePublicationFixture(service, endpoint.id);
      }
    },
  );

  it.each([
    {
      label: "a blocked destination",
      error: Object.assign(
        new Error("Permission denied: cannot sendMessage in telegram"),
        {
          name: "PermissionError",
          adapter: "telegram",
          code: "PERMISSION_DENIED",
          action: "sendMessage",
        },
      ),
      expectedPublicationState: "cancelled",
      expectedEndpointStatus: "active",
      expectedConversationState: "unavailable",
      expectedConnection: {
        status: "active",
        enabled: true,
        healthStatus: "healthy",
      },
      expectedResourceAvailability: "unavailable",
      runtimeRetained: true,
    },
    {
      label: "an invalid bot token",
      error: Object.assign(new Error("Unauthorized"), {
        name: "AuthenticationError",
        adapter: "telegram",
        code: "AUTH_FAILED",
      }),
      expectedPublicationState: "failed",
      expectedEndpointStatus: "attention",
      expectedConversationState: "active",
      expectedConnection: {
        status: "active",
        enabled: true,
        healthStatus: "failed",
      },
      expectedResourceAvailability: "available",
      runtimeRetained: false,
    },
  ])(
    "scopes Telegram publication failure from $label correctly",
    async ({
      error,
      expectedConnection,
      expectedConversationState,
      expectedEndpointStatus,
      expectedPublicationState,
      expectedResourceAvailability,
      runtimeRetained,
    }) => {
      const fixture = await seedCompany();
      const { callbacks, endpoint, runtime, service } =
        await configuredTelegramEndpoint(fixture);
      const chatId = `-10077${randomUUID().replaceAll("-", "").slice(0, 8)}`;
      const [resource] = await db
        .insert(chatEndpointResources)
        .values({
          companyId: fixture.companyId,
          endpointId: endpoint.id,
          type: "chat",
          providerResourceId: chatId,
          label: "Telegram publication errors",
          availability: "available",
          enabled: true,
        })
        .returning();
      const groupThread = makeThread({
        channelId: chatId,
        id: `telegram:${chatId}`,
        name: "Telegram publication errors",
      });
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider: "telegram",
        thread: groupThread.thread,
        message: makeMessage({
          id: `${chatId}:1`,
          raw: { message_id: 1 },
          text: "@paperclip create a Telegram publication failure fixture",
          userId: chatId,
          mentioned: true,
        }),
        trigger: "mention",
      });
      await qualifySetupRoundTrip(service, endpoint.id, chatId);
      await service.test(endpoint.id);
      await expect(service.get(endpoint.id)).resolves.toMatchObject({
        status: "active",
      });

      const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
      const comment = await issueService(db).addComment(
        conversation.issueId,
        "Safe Telegram provider response",
        { userId: "owner-user" },
        { authorType: "user" },
      );
      const providerRuntime = runtime.endpoints.get(endpoint.id);
      if (!providerRuntime) throw new Error("Expected Telegram runtime");
      providerRuntime.postError = error;
      await service.publishComment(endpoint.id, conversation.id, comment.id);

      const [publication] = await readChatPublicationsByCommentId(comment.id);
      expect(publication).toMatchObject({
        state: expectedPublicationState,
        attempts: 1,
        redactedError: error.message,
        nextAttemptAt: null,
      });
      await expect(service.get(endpoint.id)).resolves.toMatchObject({
        status: expectedEndpointStatus,
      });
      await expect(
        db
          .select({ state: chatConversations.state })
          .from(chatConversations)
          .where(eq(chatConversations.id, conversation.id)),
      ).resolves.toEqual([{ state: expectedConversationState }]);
      await expect(
        db
          .select({ availability: chatEndpointResources.availability })
          .from(chatEndpointResources)
          .where(eq(chatEndpointResources.id, resource.id)),
      ).resolves.toEqual([{ availability: expectedResourceAvailability }]);
      await expect(
        db
          .select({
            status: toolConnections.status,
            enabled: toolConnections.enabled,
            healthStatus: toolConnections.healthStatus,
          })
          .from(toolConnections)
          .where(eq(toolConnections.id, endpoint.connectionId)),
      ).resolves.toEqual([expectedConnection]);
      expect(runtime.endpoints.has(endpoint.id)).toBe(runtimeRetained);
      await service.shutdown();
    },
  );

  it("orders a Telegram destination failure before concurrent membership recovery", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredTelegramEndpoint(fixture);
    const chatId = "-10091234567";
    const [resource] = await db
      .insert(chatEndpointResources)
      .values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        type: "chat",
        providerResourceId: chatId,
        label: "Telegram recovery race",
        availability: "available",
        enabled: true,
      })
      .returning();
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: makeThread({
        channelId: chatId,
        id: `telegram:${chatId}`,
        name: "Telegram recovery race",
      }).thread,
      message: makeMessage({
        id: `${chatId}:1`,
        raw: { message_id: 1 },
        text: "@paperclip establish a recovery race fixture",
        userId: "91234567",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id, chatId);
    await service.test(endpoint.id);
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    const comment = await issueService(db).addComment(
      conversation.issueId,
      "Safe response during membership recovery",
      { userId: "owner-user" },
      { authorType: "user" },
    );
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected Telegram runtime");

    let markPostEntered!: () => void;
    let releasePost!: () => void;
    const postEntered = new Promise<void>((resolve) => {
      markPostEntered = resolve;
    });
    const postRelease = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    providerRuntime.postHook = async () => {
      markPostEntered();
      await postRelease;
    };
    providerRuntime.postError = Object.assign(
      new Error("Permission denied: cannot sendMessage in telegram"),
      {
        name: "PermissionError",
        adapter: "telegram",
        code: "PERMISSION_DENIED",
        action: "sendMessage",
      },
    );

    const publicationPromise = service.publishComment(
      endpoint.id,
      conversation.id,
      comment.id,
    );
    await postEntered;

    const originalTransaction = db.transaction.bind(db);
    // Assigned once before the async checks below; `let` with definite assignment is the TS idiom here.
    // oxlint-disable-next-line prefer-const
    let recoveryPromise!: Promise<Response>;
    let interceptedFailureTransaction = false;
    let failureFinalizedWhileLeaseHeld = false;
    const transactionSpy = vi
      .spyOn(db, "transaction")
      .mockImplementation((async (
        ...args: Parameters<typeof originalTransaction>
      ) => {
        if (!interceptedFailureTransaction) {
          interceptedFailureTransaction = true;
          const lease = await db
            .select({ id: chatEndpointLeases.id })
            .from(chatEndpointLeases)
            .where(
              and(
                eq(chatEndpointLeases.endpointId, endpoint.id),
                eq(chatEndpointLeases.leaseKey, "credentials"),
              ),
            );
          failureFinalizedWhileLeaseHeld = lease.length === 1;
          // This branch simulates the pre-fix ordering deterministically: if
          // failure finalization escaped the lease, allow the newer provider
          // recovery to commit first so the stale failure would overwrite it.
          if (!failureFinalizedWhileLeaseHeld) await recoveryPromise;
        }
        return originalTransaction(...args);
      }) as typeof db.transaction);
    recoveryPromise = service.handleWebhook(
      endpoint.publicId,
      "telegram",
      new Request("https://paperclip.example/telegram", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          update_id: 91234568,
          my_chat_member: {
            chat: {
              id: Number(chatId),
              type: "supergroup",
              title: "Telegram recovery race",
            },
            new_chat_member: { status: "member" },
          },
        }),
      }),
    );
    releasePost();
    try {
      const [, response] = await Promise.all([
        publicationPromise,
        recoveryPromise,
      ]);
      expect(response.status).toBe(202);
    } finally {
      transactionSpy.mockRestore();
    }

    expect(interceptedFailureTransaction).toBe(true);
    expect(failureFinalizedWhileLeaseHeld).toBe(true);
    await expect(
      db
        .select({ state: chatPublications.state })
        .from(chatPublications)
        .where(eq(chatPublications.commentId, comment.id)),
    ).resolves.toEqual([{ state: "cancelled" }]);
    await expect(
      db
        .select({ state: chatConversations.state })
        .from(chatConversations)
        .where(eq(chatConversations.id, conversation.id)),
    ).resolves.toEqual([{ state: "active" }]);
    await expect(
      db
        .select({ availability: chatEndpointResources.availability })
        .from(chatEndpointResources)
        .where(eq(chatEndpointResources.id, resource.id)),
    ).resolves.toEqual([{ availability: "available" }]);
    await service.shutdown();
  });

  it("orders a Telegram authentication failure before concurrent reconnect", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredTelegramEndpoint(fixture);
    const chatId = "-10092345678";
    await db.insert(chatEndpointResources).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      type: "chat",
      providerResourceId: chatId,
      label: "Telegram reconnect race",
      availability: "available",
      enabled: true,
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: makeThread({
        channelId: chatId,
        id: `telegram:${chatId}`,
        name: "Telegram reconnect race",
      }).thread,
      message: makeMessage({
        id: `${chatId}:1`,
        raw: { message_id: 1 },
        text: "@paperclip establish a reconnect race fixture",
        userId: "92345678",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id, chatId);
    await service.test(endpoint.id);
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    const comment = await issueService(db).addComment(
      conversation.issueId,
      "Safe response during credential reconnect",
      { userId: "owner-user" },
      { authorType: "user" },
    );
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected Telegram runtime");

    let markPostEntered!: () => void;
    let releasePost!: () => void;
    const postEntered = new Promise<void>((resolve) => {
      markPostEntered = resolve;
    });
    const postRelease = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    providerRuntime.postHook = async () => {
      markPostEntered();
      await postRelease;
    };
    providerRuntime.postError = Object.assign(new Error("Unauthorized"), {
      name: "AuthenticationError",
      adapter: "telegram",
      code: "AUTH_FAILED",
    });

    const publicationPromise = service.publishComment(
      endpoint.id,
      conversation.id,
      comment.id,
    );
    await postEntered;

    const originalTransaction = db.transaction.bind(db);
    // Assigned once before the async checks below; `let` with definite assignment is the TS idiom here.
    // oxlint-disable-next-line prefer-const
    let reconnectPromise!: ReturnType<typeof service.configure>;
    let interceptedFailureTransaction = false;
    let failureFinalizedWhileLeaseHeld = false;
    const transactionSpy = vi
      .spyOn(db, "transaction")
      .mockImplementation((async (
        ...args: Parameters<typeof originalTransaction>
      ) => {
        if (!interceptedFailureTransaction) {
          interceptedFailureTransaction = true;
          const lease = await db
            .select({ id: chatEndpointLeases.id })
            .from(chatEndpointLeases)
            .where(
              and(
                eq(chatEndpointLeases.endpointId, endpoint.id),
                eq(chatEndpointLeases.leaseKey, "credentials"),
              ),
            );
          failureFinalizedWhileLeaseHeld = lease.length === 1;
          if (!failureFinalizedWhileLeaseHeld) await reconnectPromise;
        }
        return originalTransaction(...args);
      }) as typeof db.transaction);
    reconnectPromise = service.configure(
      endpoint.id,
      { action: "reconnect" },
      "owner-user",
    );
    releasePost();
    try {
      await Promise.all([publicationPromise, reconnectPromise]);
    } finally {
      transactionSpy.mockRestore();
    }

    expect(interceptedFailureTransaction).toBe(true);
    expect(failureFinalizedWhileLeaseHeld).toBe(true);
    await expect(
      db
        .select({ state: chatPublications.state })
        .from(chatPublications)
        .where(eq(chatPublications.commentId, comment.id)),
    ).resolves.toEqual([{ state: "failed" }]);
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "verifying",
      healthMessage: "Waiting for a test conversation",
    });
    await expect(
      db
        .select({
          status: toolConnections.status,
          enabled: toolConnections.enabled,
          healthStatus: toolConnections.healthStatus,
        })
        .from(toolConnections)
        .where(eq(toolConnections.id, endpoint.connectionId)),
    ).resolves.toEqual([
      { status: "active", enabled: true, healthStatus: "healthy" },
    ]);
    expect(runtime.endpoints.has(endpoint.id)).toBe(true);
    await service.shutdown();
  });

  it.each([
    ["request_checkbox_confirmation", "accept"],
    ["request_checkbox_confirmation", "reject"],
    ["request_checkbox_confirmation", "withdraw"],
    ["request_checkbox_confirmation", "supersede"],
    ["suggest_tasks", "accept"],
    ["suggest_tasks", "reject"],
    ["connection_intent", "reject"],
    ["connection_intent", "reassign"],
  ] as const)("wakes parked Slack %s actions after board %s commits", async (kind, decision) => {
    const previousPublicUrl = process.env.PAPERCLIP_PUBLIC_URL;
    process.env.PAPERCLIP_PUBLIC_URL = "https://paperclip.example";
    const fixture = await seedCompany();
    const { callbacks, endpoint, service } = await configuredSlackEndpoint(fixture);
    let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
    try {
      const thread = makeThread({ channelId: "C-REVIEW", id: "slack:C-REVIEW:4500.1", name: "reviews" });
      await deliverMessage({ callbacks, endpointId: endpoint.id, thread: thread.thread, message: makeMessage({ id: "4500.1", text: "@maya review this change", mentioned: true, userId: `U-REVIEW-${randomUUID()}` }), trigger: "mention" });
      await qualifySetupRoundTrip(service, endpoint.id);
      await service.test(endpoint.id);
      const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
      const sourceRunId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId: fixture.companyId, agentId: fixture.assignedAgentId, status: "succeeded", responsibleUserId: "owner-user", contextSnapshot: { issueId: conversation.issueId, taskId: conversation.issueId, source: "automation" } });
      const interactions = issueThreadInteractionService(db);
      const [issue] = await readIssuesById(conversation.issueId);
      const interaction = kind === "connection_intent"
        ? await interactions.createConnectionIntent(issue, { sourceRunId, addresseeUserId: "owner-user", idempotencyKey: `slack-review:${sourceRunId}`, payload: { version: 1, serviceSlug: "notion", serviceName: "Notion", requestingAgentId: fixture.assignedAgentId, requestingAgentName: "Maya", phase: "requested" } })
        : await interactions.create(issue, { kind, sourceRunId, payload: kind === "suggest_tasks" ? { version: 1, tasks: [{ clientKey: "docs", title: "Review migration notes" }] } : { version: 1, prompt: "Review migration notes", ...(kind === "request_checkbox_confirmation" ? { options: [{ id: "docs", label: "Migration notes" }], supersedeOnUserComment: decision === "supersede" } : {}) } } as Parameters<typeof interactions.create>[1], { agentId: fixture.assignedAgentId });
      await service.processPendingPublications();
      const rows = () => db.select().from(chatPublications).where(and(eq(chatPublications.endpointId, endpoint.id), eq(sql<string>`${chatPublications.payload}->>'interactionId'`, interaction.id)));
      const [original] = await rows();
      expect(original?.state).toBe("published");
      expect(original?.payload.card?.actions).toEqual(expect.arrayContaining([expect.objectContaining({ type: "callback" })]));

      const [action] = await db.select().from(chatActions).where(and(
        eq(chatActions.endpointId, endpoint.id), eq(chatActions.kind, "confirmation_response"),
        eq(sql<string>`${chatActions.payload}->>'interactionId'`, interaction.id),
        eq(sql<string>`${chatActions.payload}->>'decision'`, decision === "accept" ? "accept" : "reject"),
      ));
      expect(action).toBeDefined();
      await db.update(chatActions).set({ status: "processing" }).where(eq(chatActions.id, action.id));
      const errors: unknown[] = [];
      coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true,
        canReconcile: () => true, onError: error => errors.push(error) });
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      const settle = async () => vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(10);
        expect(idleWorkSnapshot().active).toBe(0); expect(coordinator!.nextWakeAt()).toBeNull();
      }, { timeout: 10_000 });
      const quiet = async () => {
        const select = vi.spyOn(db, "select"), transaction = vi.spyOn(db, "transaction");
        try {
          await vi.advanceTimersByTimeAsync(120_000);
          expect(select).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled();
        } finally { select.mockRestore(); transaction.mockRestore(); }
      };
      await service.registerTerminalConfirmationWork(coordinator, () => true).ready;
      await settle(); await quiet();
      expect((await db.select().from(chatActions).where(eq(chatActions.id, action.id)))[0].status).toBe("processing");
      const resolve = async (tx: Db) => {
        const board = issueThreadInteractionService(tx);
        if (decision === "withdraw") await board.withdrawInteraction(issue, interaction.id, {}, { userId: "owner-user" });
        else if (decision === "reassign") await board.expireConnectionIntentsForOwnershipChange(issue);
        else if (decision === "supersede") {
          const [comment] = await tx.insert(issueComments).values({ companyId: issue.companyId, issueId: issue.id,
            authorUserId: "owner-user", body: "Use the revised migration plan", createdAt: new Date(Date.now() + 1000) }).returning();
          await board.expireRequestConfirmationsSupersededByComment(issue, comment, { userId: "owner-user" });
        }
        else if (kind === "connection_intent") await board.resolveConnectionIntent(issue, interaction.id,
          { version: 1, outcome: "declined" }, { userId: "owner-user" });
        else if (decision === "accept") await board.acceptInteraction(issue, interaction.id,
          { selectedOptionIds: ["docs"], selectedClientKeys: ["docs"] }, { userId: "owner-user" });
        else await board.rejectInteraction(issue, interaction.id, {}, { userId: "owner-user" });
        expect((await db.select().from(chatActions).where(eq(chatActions.id, action.id)))[0].status).toBe("processing");
        expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interaction.id)))[0].status).toBe("pending");
      };
      await expect(db.transaction(async tx => { await resolve(tx as unknown as Db); throw new Error("rollback board decision"); }))
        .rejects.toThrow("rollback board decision");
      await settle(); await quiet();
      await db.transaction(tx => resolve(tx as unknown as Db));
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(10);
        expect((await db.select().from(chatActions).where(eq(chatActions.id, action.id)))[0].status).toBe(["accept", "reject"].includes(decision) ? "processed" : "expired");
      }, { timeout: 5_000 });
      await settle(); await quiet();
      expect(errors).toEqual([]);
    } finally {
      await coordinator?.stop(); vi.useRealTimers(); await service.shutdown();
      if (previousPublicUrl === undefined) delete process.env.PAPERCLIP_PUBLIC_URL;
      else process.env.PAPERCLIP_PUBLIC_URL = previousPublicUrl;
    }
  });

  it.each(["request_confirmation", "request_checkbox_confirmation", "request_item_verdicts", "suggest_tasks", "connection_intent"] as const)("delivers and replaces a Slack %s card through the publication service", async kind => {
    const previousPublicUrl = process.env.PAPERCLIP_PUBLIC_URL;
    process.env.PAPERCLIP_PUBLIC_URL = "https://paperclip.example";
    const fixture = await seedCompany();
    const { callbacks, endpoint, service } = await configuredSlackEndpoint(fixture);
    try {
      const thread = makeThread({ channelId: "C-REVIEW", id: "slack:C-REVIEW:4500.1", name: "reviews" });
      await deliverMessage({ callbacks, endpointId: endpoint.id, thread: thread.thread, message: makeMessage({ id: "4500.1", text: "@maya review this change", mentioned: true, userId: `U-REVIEW-${randomUUID()}` }), trigger: "mention" });
      await qualifySetupRoundTrip(service, endpoint.id);
      await service.test(endpoint.id);
      const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
      const sourceRunId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId: fixture.companyId, agentId: fixture.assignedAgentId, status: "succeeded", responsibleUserId: "owner-user", contextSnapshot: { issueId: conversation.issueId, taskId: conversation.issueId, source: "automation" } });
      const interactions = issueThreadInteractionService(db);
      const issue = { id: conversation.issueId, companyId: fixture.companyId };
      const interaction = kind === "connection_intent"
        ? await interactions.createConnectionIntent(issue, { sourceRunId, addresseeUserId: "owner-user", idempotencyKey: `slack-review:${sourceRunId}`, payload: { version: 1, serviceSlug: "notion", serviceName: "Notion", requestingAgentId: fixture.assignedAgentId, requestingAgentName: "Maya", phase: "requested" } })
        : await interactions.create(issue, { kind, sourceRunId, payload: kind === "suggest_tasks" ? { version: 1, tasks: [{ clientKey: "docs", title: "Review migration notes" }] } : kind === "request_item_verdicts" ? { version: 1, prompt: "Review migration notes", items: [{ id: "docs", label: "Migration notes" }] } : { version: 1, prompt: "Review migration notes", ...(kind === "request_checkbox_confirmation" ? { options: [{ id: "docs", label: "Migration notes" }] } : {}) } } as Parameters<typeof interactions.create>[1], { agentId: fixture.assignedAgentId });
      await service.processPendingPublications();
      const rows = () => db.select().from(chatPublications).where(and(eq(chatPublications.endpointId, endpoint.id), eq(sql<string>`${chatPublications.payload}->>'interactionId'`, interaction.id)));
      const [original] = await rows();
      expect(original?.state).toBe("published");
      expect(original?.payload.card?.actions).toEqual(expect.arrayContaining([expect.objectContaining({ type: "callback" })]));
      if (kind === "connection_intent") expect(original?.payload.card?.actions).toContainEqual({ type: "link", label: "Review connection", url: expect.any(String) });
      const controls = (await db.select().from(chatActions).where(and(eq(chatActions.endpointId, endpoint.id),
        eq(sql<string>`${chatActions.payload}->>'interactionId'`, interaction.id))))
        .filter(row => ["confirmation_response", "question_form_open", "question_form_submit", "question_answer"].includes(row.kind));
      expect(controls.length).toBeGreaterThan(0);
      for (const control of controls) expect(await chatHistoryActionBlocks(db, control.id)).toBe(true);
      if (kind === "connection_intent") await interactions.resolveConnectionIntent(issue, interaction.id, { version: 1, outcome: "declined" }, { userId: "owner-user" });
      else if (kind === "request_item_verdicts") await interactions.submitItemVerdicts(issue, interaction.id, { verdicts: [{ id: "docs", verdict: "approve" }] }, { userId: "owner-user" });
      else await interactions.rejectInteraction(issue, interaction.id, {}, { userId: "owner-user" });
      await service.processPendingPublications();
      const publications = await rows();
      const terminal = publications.find(row => row.id !== original.id);
      expect(terminal?.state).toBe("published");
      expect(terminal?.providerMessageId).toBe(original.providerMessageId);
      expect(terminal?.payload.card?.actions).toBeUndefined();
      for (const control of controls) expect(await chatHistoryActionBlocks(db, control.id)).toBe(false);
      const control = controls[0]!;
      await db.update(chatActions).set({ payload: { ...control.payload, interactionId: randomUUID() } }).where(eq(chatActions.id, control.id));
      expect(await chatHistoryActionBlocks(db, control.id)).toBe(true);
      await db.update(chatActions).set({ payload: control.payload }).where(eq(chatActions.id, control.id));
    } finally {
      await service.shutdown();
      if (previousPublicUrl === undefined) delete process.env.PAPERCLIP_PUBLIC_URL;
      else process.env.PAPERCLIP_PUBLIC_URL = previousPublicUrl;
    }
  });
});
