import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { expect, it } from "vitest";
import { activityLog, assets, chatConversations, chatDeliveries, chatMessageLinks, chatPublications, heartbeatRuns, issueAttachments, issueComments, issues } from "@paperclipai/db";
import { issueService } from "../../services/issues.js";
import { resolveChatRunPresentationAuthorizationReason } from "../../services/chat-run-publications.js";
import { makeMessage, makeThread } from ".././helpers/chat-channels-fixture.js";
import { addSelectedChatFinal, chatWakeContext, configuredDiscordEndpoint, configuredSlackEndpoint, configuredTelegramEndpoint, createStorageService, db, deliverMessage, describeChatChannelsSuite, qualifySetupRoundTrip, readChatConversationsByEndpointId, readChatDeliveriesByEndpointId, readChatDeliveriesById, readChatPublicationsByCommentId, readChatPublicationsById, readChatPublicationsByIdempotencyKey, seedCompany } from "../helpers/chat-channels-harness.js";







describeChatChannelsSuite("chat channels 30-serializes-and-caps-an-agent-run", () => {
  it("serializes and caps an agent run's selected Discord files before final handoff", async () => {
    const fixture = await seedCompany();
    const storage = createStorageService();
    const { callbacks, endpoint, service } = await configuredDiscordEndpoint(
      fixture,
      { storage: storage.storage },
    );
    const rootMessageId = "555555555555555711";
    const channel = makeThread({
      channelId: "333333333333333711",
      id: `discord:1457808928258658549:333333333333333711:${rootMessageId}`,
      name: "agent-file-cap",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "discord",
      thread: channel.thread,
      message: makeMessage({
        id: rootMessageId,
        text: "@maya prepare the complete file set",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id);
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    if (!conversation) throw new Error("Expected Discord conversation");

    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: fixture.companyId,
      agentId: fixture.assignedAgentId,
      status: "succeeded",
      contextSnapshot: await chatWakeContext({
        endpointId: endpoint.id,
        issueId: conversation.issueId,
        provider: "discord",
        providerMessageId: rootMessageId,
      }),
    });
    const attachments: Array<{ id: string }> = [];
    for (let index = 0; index < 21; index += 1) {
      const body = Buffer.from(`selected file ${index + 1}`, "utf8");
      const stored = await storage.storage.putFile({
        companyId: fixture.companyId,
        namespace: `issues/${conversation.issueId}`,
        originalFilename: `selected-${String(index + 1).padStart(2, "0")}.txt`,
        contentType: "text/plain",
        body,
      });
      attachments.push(
        await issueService(db).createAttachment({
          issueId: conversation.issueId,
          provider: stored.provider,
          objectKey: stored.objectKey,
          contentType: stored.contentType,
          byteSize: stored.byteSize,
          sha256: stored.sha256,
          originalFilename: stored.originalFilename,
          createdByAgentId: fixture.assignedAgentId,
          createdByRunId: runId,
        }),
      );
    }

    const issuesSvc = issueService(db);
    const initialSelection = await db.transaction((tx) =>
      issuesSvc.addComment(
        conversation.issueId,
        "Prepared the selected file batch.",
        { agentId: fixture.assignedAgentId, runId },
        {
          attachmentIds: attachments.slice(0, 19).map((item) => item.id),
          authorType: "agent",
          authorizationReason: "allow_self",
        },
        tx,
      ),
    );
    const contenderBodies = [
      "Prepared candidate file twenty.",
      "Prepared candidate file twenty-one.",
    ];
    const contenderResults = await Promise.allSettled(
      attachments.slice(19).map((attachment, index) =>
        db.transaction((tx) =>
          issuesSvc.addComment(
            conversation.issueId,
            contenderBodies[index]!,
            { agentId: fixture.assignedAgentId, runId },
            {
              attachmentIds: [attachment.id],
              authorType: "agent",
              authorizationReason: "allow_self",
            },
            tx,
          ),
        ),
      ),
    );
    const winnerIndex = contenderResults.findIndex(
      (result) => result.status === "fulfilled",
    );
    const loserIndex = contenderResults.findIndex(
      (result) => result.status === "rejected",
    );
    expect(winnerIndex).toBeGreaterThanOrEqual(0);
    expect(loserIndex).toBeGreaterThanOrEqual(0);
    if (winnerIndex < 0 || loserIndex < 0) {
      throw new Error("Expected exactly one capped attachment contender");
    }
    const rejected = contenderResults[loserIndex];
    if (rejected?.status !== "rejected") {
      throw new Error("Expected the twenty-first attachment to be rejected");
    }
    expect(rejected.reason).toMatchObject({
      status: 422,
      details: {
        code: "chat_attachment_selection_limit_exceeded",
        limit: 20,
        selectedCount: 21,
      },
    });
    const winningAttachment = attachments[19 + winnerIndex]!;
    const rejectedAttachment = attachments[19 + loserIndex]!;
    await expect(
      db
        .select({
          id: issueAttachments.id,
          issueCommentId: issueAttachments.issueCommentId,
        })
        .from(issueAttachments)
        .where(
          inArray(
            issueAttachments.id,
            attachments.map((item) => item.id),
          ),
        )
        .then((rows) => ({
          bound: rows.filter((row) => row.issueCommentId !== null).length,
          rejected: rows.find((row) => row.id === rejectedAttachment.id),
        })),
    ).resolves.toEqual({
      bound: 20,
      rejected: {
        id: rejectedAttachment.id,
        issueCommentId: null,
      },
    });
    await expect(
      db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(eq(issueComments.body, contenderBodies[loserIndex]!)),
    ).resolves.toHaveLength(0);
    await expect(
      issuesSvc.createAttachment({
        issueId: conversation.issueId,
        issueCommentId: initialSelection.id,
        provider: "local_disk",
        objectKey: "issues/direct-selection-overflow.txt",
        contentType: "text/plain",
        byteSize: 25,
        sha256: "8".repeat(64),
        originalFilename: "direct-selection-overflow.txt",
        createdByAgentId: fixture.assignedAgentId,
        createdByRunId: runId,
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: {
        code: "chat_attachment_selection_limit_exceeded",
        limit: 20,
        selectedCount: 21,
      },
    });
    await expect(
      db
        .select({ id: assets.id })
        .from(assets)
        .where(eq(assets.objectKey, "issues/direct-selection-overflow.txt")),
    ).resolves.toHaveLength(0);

    const authorizationReason =
      await resolveChatRunPresentationAuthorizationReason(db, {
        companyId: fixture.companyId,
        issueId: conversation.issueId,
        runId,
      });
    expect(authorizationReason).toBe("allow_chat_run_presentation");
    // Reusing the first selected attachment on the final comment makes that
    // file appear in both the direct and carried sets. Dedupe must happen
    // before the provider cap is applied, or the later winning file is lost.
    const response = await db.transaction((tx) =>
      issuesSvc.addComment(
        conversation.issueId,
        "Prepared the selected file batch.",
        { agentId: fixture.assignedAgentId, runId },
        {
          attachmentIds: [attachments[0]!.id],
          authorType: "agent",
          authorizationReason,
        },
        tx,
      ),
    );
    expect(response.id).toBe(initialSelection.id);

    await service.processPendingPublications(1_000);
    const publications = await db
      .select({
        payload: chatPublications.payload,
        state: chatPublications.state,
      })
      .from(chatPublications)
      .where(eq(chatPublications.conversationId, conversation.id));
    const publishedAttachmentIds = publications.flatMap((publication) => {
      const attachmentIds =
        publication.payload &&
        typeof publication.payload === "object" &&
        "attachmentIds" in publication.payload &&
        Array.isArray(publication.payload.attachmentIds)
          ? publication.payload.attachmentIds
          : [];
      return attachmentIds.filter(
        (attachmentId): attachmentId is string =>
          typeof attachmentId === "string",
      );
    });
    expect(
      publications.every((publication) => publication.state === "published"),
    ).toBe(true);
    expect(publishedAttachmentIds).toHaveLength(20);
    expect(new Set(publishedAttachmentIds).size).toBe(20);
    expect(publishedAttachmentIds).toEqual(
      expect.arrayContaining([
        ...attachments.slice(0, 19).map((item) => item.id),
        winningAttachment.id,
      ]),
    );
    expect(publishedAttachmentIds).not.toContain(rejectedAttachment.id);

    const nonChatRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: nonChatRunId,
      companyId: fixture.companyId,
      agentId: fixture.assignedAgentId,
      status: "succeeded",
      contextSnapshot: {
        issueId: conversation.issueId,
        source: "issue.comment",
      },
    });
    const nonChatAttachments: Array<{ id: string }> = [];
    for (let index = 0; index < 21; index += 1) {
      nonChatAttachments.push(
        await issuesSvc.createAttachment({
          issueId: conversation.issueId,
          provider: "local_disk",
          objectKey: `issues/non-chat-${index + 1}.txt`,
          contentType: "text/plain",
          byteSize: 1,
          sha256: String(index).padStart(64, "0"),
          originalFilename: `non-chat-${index + 1}.txt`,
          createdByAgentId: fixture.assignedAgentId,
          createdByRunId: nonChatRunId,
        }),
      );
    }
    const firstInternalBatch = await db.transaction((tx) =>
      issuesSvc.addComment(
        conversation.issueId,
        "Internal task files one through twenty.",
        { agentId: fixture.assignedAgentId, runId: nonChatRunId },
        {
          attachmentIds: nonChatAttachments.slice(0, 20).map((item) => item.id),
          authorType: "agent",
          authorizationReason: "allow_self",
        },
        tx,
      ),
    );
    const secondInternalBatch = await db.transaction((tx) =>
      issuesSvc.addComment(
        conversation.issueId,
        "Internal task file twenty-one.",
        { agentId: fixture.assignedAgentId, runId: nonChatRunId },
        {
          attachmentIds: [nonChatAttachments[20]!.id],
          authorType: "agent",
          authorizationReason: "allow_self",
        },
        tx,
      ),
    );
    expect(firstInternalBatch.id).not.toBe(secondInternalBatch.id);
    await expect(
      db
        .select({ issueCommentId: issueAttachments.issueCommentId })
        .from(issueAttachments)
        .where(
          inArray(
            issueAttachments.id,
            nonChatAttachments.map((item) => item.id),
          ),
        )
        .then((rows) =>
          rows.filter((attachment) => attachment.issueCommentId !== null),
        ),
    ).resolves.toHaveLength(21);
  });

  it("publishes a serialized Telegram run response after the preceding run completes the conversation", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredTelegramEndpoint(fixture);
    const dm = makeThread({
      channelId: "77119922",
      id: "telegram:77119922",
      isDM: true,
      name: "Telegram completion race",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: dm.thread,
      message: makeMessage({
        id: "77119922:1",
        text: "Start the setup conversation",
        userId: "77119922",
      }),
      trigger: "direct_message",
    });
    await qualifySetupRoundTrip(service, endpoint.id, "77119922");
    await service.test(endpoint.id);

    for (const [id, text] of [
      ["77119922:2", "First queued question"],
      ["77119922:3", "Second queued question"],
    ] as const) {
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider: "telegram",
        thread: dm.thread,
        message: makeMessage({ id, text, userId: "77119922" }),
        trigger: "direct_message",
      });
    }

    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    const inboundLinks = await db
      .select()
      .from(chatMessageLinks)
      .where(
        and(
          eq(chatMessageLinks.endpointId, endpoint.id),
          eq(chatMessageLinks.direction, "inbound"),
          inArray(chatMessageLinks.providerMessageId, [
            "77119922:2",
            "77119922:3",
          ]),
        ),
      );
    const firstWakeCommentId = inboundLinks.find(
      (link) => link.providerMessageId === "77119922:2",
    )?.commentId;
    const secondWakeCommentId = inboundLinks.find(
      (link) => link.providerMessageId === "77119922:3",
    )?.commentId;
    if (!firstWakeCommentId || !secondWakeCommentId) {
      throw new Error("Expected both inbound Telegram comments to be linked");
    }

    const firstRunId = randomUUID();
    const secondRunId = randomUUID();
    const internalRecoveryRunId = randomUUID();
    await db.insert(heartbeatRuns).values([
      {
        id: firstRunId,
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        status: "succeeded",
        contextSnapshot: {
          issueId: conversation.issueId,
          source: "chat:telegram",
          wakeCommentId: firstWakeCommentId,
          wakeCommentIds: [firstWakeCommentId],
        },
      },
      {
        id: secondRunId,
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        status: "succeeded",
        contextSnapshot: {
          issueId: conversation.issueId,
          source: "chat:telegram",
          wakeCommentId: secondWakeCommentId,
          wakeCommentIds: [secondWakeCommentId],
        },
      },
      {
        id: internalRecoveryRunId,
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        status: "succeeded",
        contextSnapshot: {
          issueId: conversation.issueId,
          source: "issue.comment",
          wakeReason: "finish_successful_run_handoff",
          wakeSource: "automation",
        },
      },
    ]);

    const firstResponse = await addSelectedChatFinal({
      agentId: fixture.assignedAgentId,
      body: "First queued answer",
      companyId: fixture.companyId,
      issueId: conversation.issueId,
      runId: firstRunId,
    });
    await service.processPendingPublications();
    const activeInternalComment = await issueService(db).addComment(
      conversation.issueId,
      "Active recovery note that must stay internal",
      {
        agentId: fixture.assignedAgentId,
        runId: internalRecoveryRunId,
      },
      { authorType: "agent" },
    );
    const internalAttachment = await issueService(db).createAttachment({
      issueId: conversation.issueId,
      issueCommentId: activeInternalComment.id,
      provider: "local_disk",
      objectKey: "issues/internal-recovery.txt",
      contentType: "text/plain",
      byteSize: 18,
      sha256: "a".repeat(64),
      originalFilename: "internal-recovery.txt",
      createdByAgentId: fixture.assignedAgentId,
      createdByRunId: internalRecoveryRunId,
    });
    await db
      .update(issues)
      .set({ status: "done" })
      .where(eq(issues.id, conversation.issueId));
    await db
      .update(chatConversations)
      .set({ state: "completed" })
      .where(eq(chatConversations.id, conversation.id));

    const secondResponse = await addSelectedChatFinal({
      agentId: fixture.assignedAgentId,
      body: "Second queued answer",
      companyId: fixture.companyId,
      issueId: conversation.issueId,
      runId: secondRunId,
    });
    const lateInternalComment = await issueService(db).addComment(
      conversation.issueId,
      "Later internal-only note",
      { agentId: fixture.assignedAgentId },
      { authorType: "agent" },
    );

    const responsePublications = await db
      .select()
      .from(chatPublications)
      .where(
        inArray(chatPublications.commentId, [
          firstResponse.id,
          secondResponse.id,
          activeInternalComment.id,
          lateInternalComment.id,
        ]),
      );
    expect(responsePublications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          commentId: firstResponse.id,
          conversationId: conversation.id,
          state: "published",
        }),
        expect.objectContaining({
          commentId: secondResponse.id,
          conversationId: conversation.id,
          state: "pending",
        }),
      ]),
    );
    for (const internalCommentId of [
      activeInternalComment.id,
      lateInternalComment.id,
    ]) {
      expect(
        responsePublications.find(
          (publication) => publication.commentId === internalCommentId,
        ),
      ).toBeUndefined();
    }
    expect(
      await readChatPublicationsByIdempotencyKey(`attachment:${internalAttachment.id}:${endpoint.id}`),
    ).toHaveLength(0);

    await service.processPendingPublications(1_000);
    expect(
      runtime.endpoints.get(endpoint.id)?.posts.map((post) => post.text),
    ).toEqual(["First queued answer", "Second queued answer"]);

    const chatAttachment = await issueService(db).createAttachment({
      issueId: conversation.issueId,
      issueCommentId: secondResponse.id,
      provider: "local_disk",
      objectKey: "issues/chat-result.txt",
      contentType: "text/plain",
      byteSize: 11,
      sha256: "b".repeat(64),
      originalFilename: "chat-result.txt",
      createdByAgentId: fixture.assignedAgentId,
      createdByRunId: secondRunId,
    });
    await expect(
      readChatPublicationsByIdempotencyKey(`attachment:${chatAttachment.id}:${endpoint.id}`),
    ).resolves.toEqual([
      expect.objectContaining({
        commentId: secondResponse.id,
        conversationId: conversation.id,
        state: "pending",
      }),
    ]);
    // This projection-only fixture intentionally has no object-store bytes.
    // Retire its staged work so another test's global worker cannot retry it.
    await db
      .update(chatPublications)
      .set({ state: "cancelled", nextAttemptAt: null })
      .where(
        and(
          eq(chatPublications.endpointId, endpoint.id),
          eq(
            chatPublications.idempotencyKey,
            `attachment:${chatAttachment.id}:${endpoint.id}`,
          ),
        ),
      );
    await service.shutdown();
  });

  it("holds ambiguous provider sends for an audited duplicate-risk resolution without reordering", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture);
    const channel = makeThread({
      channelId: "C-UNKNOWN",
      id: "slack:C-UNKNOWN:4500.1",
      name: "unknown-delivery",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: channel.thread,
      message: makeMessage({
        id: "4500.1",
        text: "@maya test an ambiguous response",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id);
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    const firstComment = await issueService(db).addComment(
      conversation.issueId,
      "First safe response",
      { userId: "owner-user" },
      { authorType: "user" },
    );
    const secondComment = await issueService(db).addComment(
      conversation.issueId,
      "Second safe response",
      { userId: "owner-user" },
      { authorType: "user" },
    );
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected provider runtime");
    providerRuntime.postError = new Error("socket reset after write");

    await service.publishComment(endpoint.id, conversation.id, firstComment.id);
    const firstPublication = await readChatPublicationsByCommentId(firstComment.id)
      .then((rows) => rows[0]);
    expect(firstPublication).toMatchObject({
      state: "delivery_unknown",
      attempts: 1,
      providerMessageId: null,
    });

    await service.publishComment(
      endpoint.id,
      conversation.id,
      secondComment.id,
    );
    const secondPublication = await readChatPublicationsByCommentId(secondComment.id)
      .then((rows) => rows[0]);
    expect(secondPublication.state).toBe("pending");
    const activity = await service.listActivity(endpoint.id);
    expect(
      activity.find((item) => item.id === firstPublication.id),
    ).toMatchObject({
      kind: "publication",
      status: "delivery_unknown",
      replayable: false,
      resolutionActions: ["mark_delivered", "retry_anyway", "cancel"],
    });
    await expect(
      service.replayPublication(endpoint.id, firstPublication.id),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: "chat_publication_resolution_required" },
    });

    providerRuntime.postError = null;
    await service.resolvePublication(
      endpoint.id,
      firstPublication.id,
      "retry_anyway",
      "owner-user",
    );
    await service.processPendingPublications();
    const replayed = await readChatPublicationsById(firstPublication.id)
      .then((rows) => rows[0]);
    const releasedSecond = await readChatPublicationsById(secondPublication.id)
      .then((rows) => rows[0]);
    expect(replayed.state).toBe("published");
    expect(releasedSecond.state).toBe("published");
    expect(providerRuntime.posts.map((post) => post.text)).toEqual([
      "First safe response",
      "Second safe response",
    ]);
    const [resolutionActivity] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, firstPublication.id));
    expect(resolutionActivity).toMatchObject({
      actorType: "user",
      actorId: "owner-user",
      action: "chat.publication_retry_anyway",
    });
  });

  it("does not wake twice when an operator replays an already admitted failed delivery", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } =
      await configuredSlackEndpoint(fixture);
    const channel = makeThread({
      channelId: "C-REPLAY",
      id: "slack:C-REPLAY:5000.1",
      name: "replay",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: channel.thread,
      message: makeMessage({
        id: "5000.1",
        text: "@maya retry this",
        mentioned: true,
      }),
      trigger: "mention",
    });
    const [delivery] = await readChatDeliveriesByEndpointId(endpoint.id);
    await db
      .update(chatDeliveries)
      .set({ state: "failed", redactedError: "temporary failure" })
      .where(eq(chatDeliveries.id, delivery.id));

    await service.replayDelivery(endpoint.id, delivery.id);

    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup.mock.calls[0]?.[1]).toMatchObject({
      reason: "External chat message received",
      payload: {
        mutation: "chat_message_received",
        wakeCommentId: expect.any(String),
      },
    });
    const [replayed] = await readChatDeliveriesById(delivery.id);
    expect(replayed).toMatchObject({
      state: "processed",
      attempts: 2,
      redactedError: null,
    });
  });
});
