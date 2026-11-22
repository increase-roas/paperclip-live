import { createHash, randomUUID } from "node:crypto";
import { crc32 } from "node:zlib";
import sharp, {  } from "sharp";
import { and, asc, eq, inArray, like } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { assets, chatDeliveries, chatEndpointResources, chatMessageLinks, chatPublications, heartbeatRuns, issueAttachments, issueComments, issueWorkProducts } from "@paperclipai/db";
import { createChatSdkEndpointRuntime } from "../../services/chat-sdk-runtime.js";
import { issueService } from "../../services/issues.js";
import { resolveChatRunPresentationAuthorizationReason } from "../../services/chat-run-publications.js";
import { TestDb, makeMessage, makeThread } from ".././helpers/chat-channels-fixture.js";
import { chatWakeContext, configuredDiscordEndpoint, configuredSlackEndpoint, configuredTelegramEndpoint, createStorageService, db, deliverMessage, describeChatChannelsSuite, qualifySetupRoundTrip, readChatConversationsByEndpointId, readChatPublicationsByCommentId, readChatPublicationsByEndpointId, retirePublicationFixture, seedCompany } from "../helpers/chat-channels-harness.js";








describeChatChannelsSuite("chat channels 29-retries-pre-transport-attachment-integri", () => {
  it("retries pre-transport attachment integrity failures without blocking another conversation", async () => {
    const fixture = await seedCompany();
    const storage = createStorageService();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture, {
        linkedBoardUser: true,
        storage: storage.storage,
      });
    try {
      const damagedChannel = makeThread({
        channelId: "C-BOARD-DAMAGED-FILE",
        id: "slack:C-BOARD-DAMAGED-FILE:4400.2",
        name: "board-damaged-file",
      });
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        thread: damagedChannel.thread,
        message: makeMessage({
          id: "4400.2",
          text: "@maya start the damaged-file task",
          mentioned: true,
        }),
        trigger: "mention",
      });
      await qualifySetupRoundTrip(service, endpoint.id);
      await service.test(endpoint.id);
      await db.insert(chatEndpointResources).values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        type: "channel",
        providerResourceId: "C-BOARD-HEALTHY-FILE",
        label: "board-healthy-file",
        availability: "available",
        enabled: true,
      });
      const healthyChannel = makeThread({
        channelId: "C-BOARD-HEALTHY-FILE",
        id: "slack:C-BOARD-HEALTHY-FILE:4400.3",
        name: "board-healthy-file",
      });
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        thread: healthyChannel.thread,
        message: makeMessage({
          id: "4400.3",
          text: "@maya start the healthy-file task",
          mentioned: true,
        }),
        trigger: "mention",
      });

      const conversations = await service.listConversations(endpoint.id);
      const damagedConversation = conversations.find(
        (conversation) =>
          conversation.externalThreadId === damagedChannel.thread.id,
      );
      const healthyConversation = conversations.find(
        (conversation) =>
          conversation.externalThreadId === healthyChannel.thread.id,
      );
      if (!damagedConversation || !healthyConversation) {
        throw new Error("Expected both board attachment conversations");
      }
      const damagedBody = Buffer.from("registered outbound evidence", "utf8");
      const healthyBody = Buffer.from("healthy outbound evidence", "utf8");
      const damagedStored = await storage.storage.putFile({
        companyId: fixture.companyId,
        namespace: `issues/${damagedConversation.issueId}`,
        originalFilename: "damaged.txt",
        contentType: "text/plain",
        body: damagedBody,
      });
      const healthyStored = await storage.storage.putFile({
        companyId: fixture.companyId,
        namespace: `issues/${healthyConversation.issueId}`,
        originalFilename: "healthy.txt",
        contentType: "text/plain",
        body: healthyBody,
      });
      const damagedAttachment = await issueService(db).createAttachment({
        issueId: damagedConversation.issueId,
        provider: damagedStored.provider,
        objectKey: damagedStored.objectKey,
        contentType: damagedStored.contentType,
        byteSize: damagedStored.byteSize,
        sha256: damagedStored.sha256,
        originalFilename: damagedStored.originalFilename,
        createdByUserId: "owner-user",
      });
      const healthyAttachment = await issueService(db).createAttachment({
        issueId: healthyConversation.issueId,
        provider: healthyStored.provider,
        objectKey: healthyStored.objectKey,
        contentType: healthyStored.contentType,
        byteSize: healthyStored.byteSize,
        sha256: healthyStored.sha256,
        originalFilename: healthyStored.originalFilename,
        createdByUserId: "owner-user",
      });
      const damagedReplacement = Buffer.from(damagedBody);
      damagedReplacement[0] ^= 0xff;
      storage.objects.set(damagedStored.objectKey, damagedReplacement);
      const providerRuntime = runtime.endpoints.get(endpoint.id);
      if (!providerRuntime) throw new Error("Expected Slack provider runtime");
      providerRuntime.posts.length = 0;

      const damagedPublication = await service.publishBoardMessage(
        endpoint.id,
        damagedConversation.id,
        "Damaged attachment send",
        "board-damaged-file-send",
        "owner-user",
        [damagedAttachment.id],
      );

      expect(damagedPublication).toMatchObject({
        attempts: 1,
        state: "retry",
        nextAttemptAt: expect.any(Date),
        redactedError:
          "Chat publication attachment integrity changed after registration",
      });
      expect(providerRuntime.posts).toEqual([
        {
          threadId: damagedChannel.thread.id,
          text: "**Owner User (via Paperclip)**\n\nDamaged attachment send",
        },
      ]);

      const healthyPublication = await service.publishBoardMessage(
        endpoint.id,
        healthyConversation.id,
        "Healthy attachment send",
        "board-healthy-file-send",
        "owner-user",
        [healthyAttachment.id],
      );
      expect(healthyPublication).toMatchObject({
        attempts: 1,
        state: "published",
      });
      expect(providerRuntime.posts).toEqual([
        {
          threadId: damagedChannel.thread.id,
          text: "**Owner User (via Paperclip)**\n\nDamaged attachment send",
        },
        {
          threadId: healthyChannel.thread.id,
          text: "**Owner User (via Paperclip)**\n\nHealthy attachment send",
        },
        {
          threadId: healthyChannel.thread.id,
          text: "",
          files: [
            expect.objectContaining({
              data: healthyBody,
              filename: "healthy.txt",
              mimeType: "text/plain",
            }),
          ],
        },
      ]);

      storage.objects.set(damagedStored.objectKey, damagedBody);
      await db
        .update(chatPublications)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(chatPublications.id, damagedPublication.id));
      await service.processPendingPublications();
      await service.processPendingPublications();

      await expect(
        db
          .select({
            attempts: chatPublications.attempts,
            state: chatPublications.state,
          })
          .from(chatPublications)
          .where(eq(chatPublications.id, damagedPublication.id)),
      ).resolves.toEqual([{ attempts: 2, state: "published" }]);
      expect(
        providerRuntime.posts.filter(
          (post) =>
            post.files?.[0] && post.threadId === damagedChannel.thread.id,
        ),
      ).toEqual([
        {
          threadId: damagedChannel.thread.id,
          text: "",
          files: [
            expect.objectContaining({
              data: damagedBody,
              filename: "damaged.txt",
              mimeType: "text/plain",
            }),
          ],
        },
      ]);
    } finally {
      await service.shutdown();
    }
  });

  it("keeps missing attachment storage retryable but fails invalid metadata before provider transport", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture, { linkedBoardUser: true });
    try {
      const channel = makeThread({
        channelId: "C-BOARD-MISSING-STORAGE",
        id: "slack:C-BOARD-MISSING-STORAGE:4400.4",
        name: "board-missing-storage",
      });
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        thread: channel.thread,
        message: makeMessage({
          id: "4400.4",
          text: "@maya start the missing-storage task",
          mentioned: true,
        }),
        trigger: "mention",
      });
      await qualifySetupRoundTrip(service, endpoint.id);
      await service.test(endpoint.id);
      const [conversation] = await service.listConversations(endpoint.id);
      if (!conversation)
        throw new Error("Expected board attachment conversation");
      const body = Buffer.from("missing storage evidence", "utf8");
      const attachment = await issueService(db).createAttachment({
        issueId: conversation.issueId,
        provider: "local_disk",
        objectKey: "issues/missing-storage-evidence.txt",
        contentType: "text/plain",
        byteSize: body.byteLength,
        sha256: createHash("sha256").update(body).digest("hex"),
        originalFilename: "missing-storage-evidence.txt",
        createdByUserId: "owner-user",
      });
      const providerRuntime = runtime.endpoints.get(endpoint.id);
      if (!providerRuntime) throw new Error("Expected Slack provider runtime");
      providerRuntime.posts.length = 0;

      const retrying = await service.publishBoardMessage(
        endpoint.id,
        conversation.id,
        "Missing storage attachment send",
        "board-missing-storage-send",
        "owner-user",
        [attachment.id],
      );

      expect(retrying).toMatchObject({
        attempts: 1,
        state: "retry",
        nextAttemptAt: expect.any(Date),
        redactedError: "Attachment storage is unavailable for chat publication",
      });
      expect(providerRuntime.posts).toEqual([
        {
          threadId: channel.thread.id,
          text: "**Owner User (via Paperclip)**\n\nMissing storage attachment send",
        },
      ]);

      const [attachmentRow] = await db
        .select({ assetId: issueAttachments.assetId })
        .from(issueAttachments)
        .where(eq(issueAttachments.id, attachment.id));
      if (!attachmentRow) throw new Error("Expected attachment metadata");
      await db
        .update(assets)
        .set({ contentType: "application/x-executable" })
        .where(eq(assets.id, attachmentRow.assetId));
      await db
        .update(chatPublications)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(chatPublications.id, retrying.id));
      await service.processPendingPublications();

      await expect(
        db
          .select({
            attempts: chatPublications.attempts,
            redactedError: chatPublications.redactedError,
            state: chatPublications.state,
          })
          .from(chatPublications)
          .where(eq(chatPublications.id, retrying.id)),
      ).resolves.toEqual([
        {
          attempts: 2,
          redactedError:
            "Chat publication attachment is invalid or outside its authorized task comment",
          state: "failed",
        },
      ]);
      expect(providerRuntime.posts.every((post) => !post.files?.length)).toBe(
        true,
      );
    } finally {
      await service.shutdown();
    }
  });

  it("scopes board-send idempotency to one external conversation", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service } =
      await configuredSlackEndpoint(fixture, { linkedBoardUser: true });
    const firstChannel = makeThread({
      channelId: "C-BOARD-IDEMPOTENCY-ONE",
      id: "slack:C-BOARD-IDEMPOTENCY-ONE:4401.1",
      name: "board-idempotency-one",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: firstChannel.thread,
      message: makeMessage({
        id: "4401.1",
        text: "@maya start the first board-send task",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id);
    await db.insert(chatEndpointResources).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      type: "channel",
      providerResourceId: "C-BOARD-IDEMPOTENCY-TWO",
      label: "board-idempotency-two",
      availability: "available",
      enabled: true,
    });

    const secondChannel = makeThread({
      channelId: "C-BOARD-IDEMPOTENCY-TWO",
      id: "slack:C-BOARD-IDEMPOTENCY-TWO:4402.1",
      name: "board-idempotency-two",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: secondChannel.thread,
      message: makeMessage({
        id: "4402.1",
        text: "@maya start the second board-send task",
        mentioned: true,
      }),
      trigger: "mention",
    });

    const conversations = await readChatConversationsByEndpointId(endpoint.id);
    expect(conversations).toHaveLength(2);
    const firstConversation = conversations.find(
      (conversation) =>
        conversation.externalThreadId === firstChannel.thread.id,
    );
    const secondConversation = conversations.find(
      (conversation) =>
        conversation.externalThreadId === secondChannel.thread.id,
    );
    if (!firstConversation || !secondConversation) {
      throw new Error("Expected both Slack board-send conversations");
    }

    const first = await service.publishBoardMessage(
      endpoint.id,
      firstConversation.id,
      "First task update",
      "same-tab-request-1234",
      "owner-user",
    );
    const second = await service.publishBoardMessage(
      endpoint.id,
      secondConversation.id,
      "Second task update",
      "same-tab-request-1234",
      "owner-user",
    );

    expect(second.id).not.toBe(first.id);
    expect(second.conversationId).toBe(secondConversation.id);
    await expect(
      db
        .select({ body: issueComments.body, issueId: issueComments.issueId })
        .from(issueComments)
        .where(inArray(issueComments.id, [first.commentId!, second.commentId!]))
        .orderBy(asc(issueComments.body)),
    ).resolves.toEqual([
      { body: "First task update", issueId: firstConversation.issueId },
      { body: "Second task update", issueId: secondConversation.issueId },
    ]);
  });

  it("publishes an explicitly selected board attachment through Telegram's native file lane", async () => {
    const fixture = await seedCompany();
    const storage = createStorageService();
    const { callbacks, endpoint, runtime, service } =
      await configuredTelegramEndpoint(fixture, {
        storage: storage.storage,
      });
    const chatId = "77119911";
    const dm = makeThread({
      channelId: `telegram:${chatId}`,
      id: `telegram:${chatId}`,
      isDM: true,
      name: "Telegram board file",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: dm.thread,
      message: makeMessage({
        id: `${chatId}:1`,
        text: "Send the selected result here",
        userId: chatId,
      }),
      trigger: "direct_message",
    });
    await qualifySetupRoundTrip(service, endpoint.id, chatId);
    await service.test(endpoint.id);
    const [conversation] = await service.listConversations(endpoint.id);
    if (!conversation) throw new Error("Expected Telegram file conversation");
    const body = Buffer.from("telegram selected result", "utf8");
    const stored = await storage.storage.putFile({
      companyId: fixture.companyId,
      namespace: `issues/${conversation.issueId}`,
      originalFilename: "telegram-result.txt",
      contentType: "text/plain",
      body,
    });
    const attachment = await issueService(db).createAttachment({
      issueId: conversation.issueId,
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByUserId: "owner-user",
    });

    await service.publishBoardMessage(
      endpoint.id,
      conversation.id,
      "Telegram file delivery",
      "telegram-file-delivery-1",
      "owner-user",
      [attachment.id],
    );

    expect(runtime.endpoints.get(endpoint.id)?.posts).toEqual([
      { threadId: dm.thread.id, text: "Telegram file delivery" },
      {
        threadId: dm.thread.id,
        text: "Shared telegram-result.txt.",
        attachments: [
          expect.objectContaining({
            name: "telegram-result.txt",
            mimeType: "text/plain",
            data: body,
            type: "file",
          }),
        ],
      },
    ]);
    await expect(
      db
        .select({
          attempts: chatPublications.attempts,
          state: chatPublications.state,
        })
        .from(chatPublications)
        .where(
          like(
            chatPublications.idempotencyKey,
            `explicit-board:${endpoint.id}:${conversation.id}:telegram-file-delivery-1%`,
          ),
        )
        .orderBy(asc(chatPublications.createdAt), asc(chatPublications.id)),
    ).resolves.toEqual([
      { attempts: 1, state: "published" },
      { attempts: 1, state: "published" },
    ]);
  });

  it.each([
    "ratio_20",
    "ratio_21",
    "portrait_21",
    "dimensions_10000",
    "dimensions_10001",
    "jpeg",
    "gif",
    "webp",
    "malformed",
    "photo_size_limit",
    "photo_size_over",
    "ambiguous",
  ] as const)(
    "selects the Telegram photo boundary before provider I/O (%s)",
    async (mode) => {
      const fixture = await seedCompany();
      const storage = createStorageService();
      const { callbacks, endpoint, runtime, service } =
        await configuredTelegramEndpoint(fixture, { storage: storage.storage });
      let pinned: ReturnType<typeof createChatSdkEndpointRuntime> | undefined;
      let threadSpy: ReturnType<typeof vi.spyOn> | undefined;
      try {
        const chatId = "77119914";
        const dm = makeThread({
          channelId: `telegram:${chatId}`,
          id: `telegram:${chatId}`,
          isDM: true,
          name: "Telegram photo boundaries",
        });
        await deliverMessage({
          callbacks,
          endpointId: endpoint.id,
          provider: "telegram",
          thread: dm.thread,
          message: makeMessage({
            id: `${chatId}:1`,
            text: "Return this exact image",
            userId: chatId,
          }),
          trigger: "direct_message",
        });
        await qualifySetupRoundTrip(service, endpoint.id, chatId);
        await service.test(endpoint.id);
        const [conversation] = await service.listConversations(endpoint.id);
        if (!conversation) throw new Error("Expected photo test conversation");

        const [width, height] =
          mode === "ratio_20"
            ? [200, 10]
            : mode === "ratio_21"
              ? [210, 10]
              : mode === "portrait_21"
                ? [10, 210]
                : mode === "dimensions_10000"
                  ? [9500, 500]
                  : mode === "dimensions_10001"
                    ? [9501, 500]
                    : [16, 16];
        const format =
          mode === "jpeg" || mode === "gif" || mode === "webp" ? mode : "png";
        let bytes = await sharp({
          create: { width, height, channels: 3, background: "#e08040" },
        })
          .toFormat(format)
          .toBuffer();
        if (mode === "malformed") bytes = bytes.subarray(0, 20);
        if (mode === "photo_size_limit" || mode === "photo_size_over") {
          // A genuine PNG with a legal uncompressed ancillary text chunk;
          // exercise upload bytes without allocating/decompressing huge pixels.
          const target = 10_000_000 + Number(mode === "photo_size_over");
          const payload = Buffer.alloc(target - bytes.length - 12, 0x78);
          payload.write("padding\0", 0, "ascii");
          const chunk = Buffer.alloc(payload.length + 12);
          chunk.writeUInt32BE(payload.length);
          chunk.write("tEXt", 4, "ascii");
          payload.copy(chunk, 8);
          chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
          bytes = Buffer.concat([
            bytes.subarray(0, -12),
            chunk,
            bytes.subarray(-12),
          ]);
          expect(bytes.length).toBe(target);
        }
        if (mode !== "malformed") {
          await expect(sharp(bytes).metadata()).resolves.toMatchObject({
            width,
            height,
            format,
          });
        }
        const filename = `original-${mode}.${format}`;
        const mimeType = `image/${format}`;
        const stored = await storage.storage.putFile({
          companyId: fixture.companyId,
          namespace: `issues/${conversation.issueId}`,
          originalFilename: filename,
          contentType: mimeType,
          body: bytes,
        });
        const attachment = await issueService(db).createAttachment({
          issueId: conversation.issueId,
          provider: stored.provider,
          objectKey: stored.objectKey,
          contentType: stored.contentType,
          byteSize: stored.byteSize,
          sha256: stored.sha256,
          originalFilename: stored.originalFilename,
          createdByUserId: "owner-user",
        });
        const expectedMethod = [
          "ratio_21",
          "portrait_21",
          "dimensions_10001",
          "gif",
          "webp",
          "malformed",
          "photo_size_over",
        ].includes(mode)
          ? "sendDocument"
          : "sendPhoto";
        const methods: string[] = [];
        const uploadedBytes: Buffer[] = [];
        vi.stubGlobal(
          "fetch",
          vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = new URL(String(input));
            expect(url.hostname).toBe("api.telegram.org");
            const method = url.pathname.split("/").at(-1)!;
            methods.push(method);
            if (method === "sendPhoto" || method === "sendDocument") {
              expect(init?.body).toBeInstanceOf(FormData);
              const file = (init!.body as FormData).get(
                method === "sendPhoto" ? "photo" : "document",
              ) as File;
              expect(file.name).toBe(filename);
              expect(file.type).toBe(mimeType);
              uploadedBytes.push(Buffer.from(await file.arrayBuffer()));
              if (mode === "ambiguous")
                throw new TypeError("fetch failed", {
                  cause: Object.assign(new Error("synthetic connection loss"), {
                    code: "UND_ERR_SOCKET",
                  }),
                });
              if (expectedMethod === "sendDocument" && method === "sendPhoto") {
                return Response.json(
                  {
                    ok: false,
                    error_code: 400,
                    description: "Bad Request: PHOTO_INVALID_DIMENSIONS",
                  },
                  { status: 400 },
                );
              }
            } else expect(method).toBe("sendRichMessage");
            return Response.json({
              ok: true,
              result: {
                message_id: 100 + methods.length,
                date: 1_788_700_002,
                chat: { id: Number(chatId), type: "private" },
              },
            });
          }),
        );
        pinned = createChatSdkEndpointRuntime({
          companyId: fixture.companyId,
          endpointId: endpoint.id,
          callbacks: { onMessage() {} },
          logger: "silent",
          persistence: {
            async compareAndSet() {
              return true;
            },
            async deleteIfVersion() {
              return true;
            },
            async read() {
              return null;
            },
          },
          providerConfig: {
            provider: "telegram",
            userName: "photo_fixture_bot",
            credentials: {
              botToken: "123:synthetic-photo-fixture",
              secretToken: "synthetic",
            },
          },
        });
        const adapter = pinned.getProviderAdapter();
        const endpointRuntime = runtime.endpoints.get(endpoint.id)!;
        const originalThread = endpointRuntime.thread.bind(endpointRuntime);
        threadSpy = vi
          .spyOn(endpointRuntime, "thread")
          .mockImplementation((threadId) => ({
            ...originalThread(threadId),
            post: async (message: unknown) => {
              const posted = await adapter.postMessage(
                threadId,
                message as Parameters<typeof adapter.postMessage>[1],
              );
              return { id: posted.id, threadId };
            },
          }));
        const result = await service.publishBoardMessage(
          endpoint.id,
          conversation.id,
          "Original image attached",
          `photo-boundary-${mode}`,
          "owner-user",
          [attachment.id],
        );
        expect(methods).toEqual(["sendRichMessage", expectedMethod]);
        expect(uploadedBytes).toHaveLength(1);
        // Buffer.equals still compares every byte, without Vitest expanding
        // a ten-megabyte boundary fixture into a recursive object comparison.
        expect(uploadedBytes[0]!.equals(bytes)).toBe(true);
        expect(result.state).toBe(
          mode === "ambiguous" ? "delivery_unknown" : "published",
        );
        const publications = await db
          .select()
          .from(chatPublications)
          .where(
            and(
              eq(chatPublications.endpointId, endpoint.id),
              eq(chatPublications.commentId, result.commentId!),
            ),
          )
          .orderBy(asc(chatPublications.createdAt));
        expect(
          publications.map((row) => ({
            state: row.state,
            attempts: row.attempts,
          })),
        ).toEqual([
          { state: "published", attempts: 1 },
          {
            state: mode === "ambiguous" ? "delivery_unknown" : "published",
            attempts: 1,
          },
        ]);
        await service.processPendingPublications();
        expect(methods).toEqual(["sendRichMessage", expectedMethod]);
      } finally {
        threadSpy?.mockRestore();
        await pinned?.shutdown();
        vi.unstubAllGlobals();
        await retirePublicationFixture(service, endpoint.id);
      }
    },
  );

  it("maps Telegram image, audio, and video output onto native media lanes", async () => {
    const fixture = await seedCompany();
    const storage = createStorageService();
    const { callbacks, endpoint, runtime, service } =
      await configuredTelegramEndpoint(fixture, {
        storage: storage.storage,
      });
    const chatId = "77119912";
    const dm = makeThread({
      channelId: `telegram:${chatId}`,
      id: `telegram:${chatId}`,
      isDM: true,
      name: "Telegram native media",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: dm.thread,
      message: makeMessage({
        id: `${chatId}:1`,
        text: "Send native media",
        userId: chatId,
      }),
      trigger: "direct_message",
    });
    await qualifySetupRoundTrip(service, endpoint.id, chatId);
    await service.test(endpoint.id);
    const [conversation] = await service.listConversations(endpoint.id);
    if (!conversation) throw new Error("Expected Telegram media conversation");
    const media = [
      {
        contentType: "image/png",
        filename: "result.png",
        type: "image",
      },
      {
        contentType: "audio/mpeg",
        filename: "result.mp3",
        type: "audio",
      },
      {
        contentType: "audio/mp4",
        filename: "result.m4a",
        type: "audio",
      },
      {
        contentType: "video/mp4",
        filename: "result.mp4",
        type: "video",
      },
    ] as const;
    const attachmentIds: string[] = [];
    for (const item of media) {
      const body =
        item.type === "image"
          ? await sharp({
              create: {
                width: 16,
                height: 16,
                channels: 3,
                background: "#e08040",
              },
            })
              .png()
              .toBuffer()
          : Buffer.from(`native-${item.type}`, "utf8");
      const stored = await storage.storage.putFile({
        companyId: fixture.companyId,
        namespace: `issues/${conversation.issueId}`,
        originalFilename: item.filename,
        contentType: item.contentType,
        body,
      });
      const attachment = await issueService(db).createAttachment({
        issueId: conversation.issueId,
        provider: stored.provider,
        objectKey: stored.objectKey,
        contentType: stored.contentType,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        originalFilename: stored.originalFilename,
        createdByUserId: "owner-user",
      });
      attachmentIds.push(attachment.id);
    }

    await service.publishBoardMessage(
      endpoint.id,
      conversation.id,
      "Telegram native media delivery",
      "telegram-native-media-delivery-1",
      "owner-user",
      attachmentIds,
    );

    const posts = runtime.endpoints.get(endpoint.id)?.posts ?? [];
    expect(posts[0]).toEqual({
      threadId: dm.thread.id,
      text: "Telegram native media delivery",
    });
    expect(posts.slice(1)).toEqual(
      media.map((item) => ({
        threadId: dm.thread.id,
        text: `Shared ${item.filename}.`,
        attachments: [
          expect.objectContaining({
            mimeType: item.contentType,
            name: item.filename,
            type: item.type,
          }),
        ],
      })),
    );
    expect(posts.slice(1).every((post) => post.files === undefined)).toBe(true);
  });

  it("sends Telegram audio and video outside native format contracts as exact original documents", async () => {
    const fixture = await seedCompany();
    const storage = createStorageService();
    const { callbacks, endpoint, runtime, service } =
      await configuredTelegramEndpoint(fixture, { storage: storage.storage });
    try {
      const chatId = "77119913";
      const dm = makeThread({
        channelId: `telegram:${chatId}`,
        id: `telegram:${chatId}`,
        isDM: true,
        name: "Telegram exact media files",
      });
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider: "telegram",
        thread: dm.thread,
        message: makeMessage({
          id: `${chatId}:1`,
          text: "Return the original files",
          userId: chatId,
        }),
        trigger: "direct_message",
      });
      await qualifySetupRoundTrip(service, endpoint.id, chatId);
      await service.test(endpoint.id);
      const [conversation] = await service.listConversations(endpoint.id);
      const media = [
        { mimeType: "audio/ogg", filename: "voice.ogg" },
        { mimeType: "audio/wav", filename: "recording.wav" },
        { mimeType: "audio/webm", filename: "recording.webm" },
        { mimeType: "video/webm", filename: "clip.webm" },
        { mimeType: "video/quicktime", filename: "clip.mov" },
        { mimeType: "video/x-m4v", filename: "clip.m4v" },
      ].map((item) => ({
        ...item,
        body: Buffer.from(`original:${item.mimeType}:\u0000exact bytes\n`),
      }));
      const attachmentIds: string[] = [];
      for (const item of media) {
        const stored = await storage.storage.putFile({
          companyId: fixture.companyId,
          namespace: `issues/${conversation!.issueId}`,
          originalFilename: item.filename,
          contentType: item.mimeType,
          body: item.body,
        });
        const attachment = await issueService(db).createAttachment({
          issueId: conversation!.issueId,
          provider: stored.provider,
          objectKey: stored.objectKey,
          contentType: stored.contentType,
          byteSize: stored.byteSize,
          sha256: stored.sha256,
          originalFilename: stored.originalFilename,
          createdByUserId: "owner-user",
        });
        attachmentIds.push(attachment.id);
      }
      const key = "telegram-nonnative-media-exact-originals";
      await service.publishBoardMessage(
        endpoint.id,
        conversation!.id,
        "Original media files",
        key,
        "owner-user",
        attachmentIds,
      );
      const posts = runtime.endpoints.get(endpoint.id)!.posts;
      const filePosts = posts.filter((post) => post.attachments?.length);
      expect(filePosts).toHaveLength(media.length);
      expect(filePosts).toEqual(
        media.map((item) => ({
          threadId: dm.thread.id,
          text: `Shared ${item.filename}.`,
          attachments: [
            expect.objectContaining({
              type: "file",
              data: item.body,
              mimeType: item.mimeType,
              name: item.filename,
              size: item.body.length,
            }),
          ],
        })),
      );
      const publications = await readChatPublicationsByEndpointId(endpoint.id);
      const filePublications = publications.filter(
        (row) => (row.payload.attachmentIds as unknown[] | undefined)?.length,
      );
      expect(filePublications).toHaveLength(media.length);
      expect(
        filePublications.every(
          (row) => row.state === "published" && row.attempts === 1,
        ),
      ).toBe(true);
      const postCount = posts.length;
      await service.publishBoardMessage(
        endpoint.id,
        conversation!.id,
        "Original media files",
        key,
        "owner-user",
        attachmentIds,
      );
      await service.processPendingPublications();
      expect(posts).toHaveLength(postCount);
    } finally {
      await retirePublicationFixture(service, endpoint.id);
    }
  });

  it("publishes an agent's explicitly selected same-run Slack attachment after its response", async () => {
    const fixture = await seedCompany();
    const storage = createStorageService();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture, {
        storage: storage.storage,
      });
    const channel = makeThread({
      channelId: "C-AGENT-FILE",
      id: "slack:C-AGENT-FILE:4410.1",
      name: "agent-file",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: channel.thread,
      message: makeMessage({
        id: "4410.1",
        text: "@maya create and share a result",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id);
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: fixture.companyId,
      agentId: fixture.assignedAgentId,
      status: "succeeded",
      contextSnapshot: await chatWakeContext({
        endpointId: endpoint.id,
        issueId: conversation.issueId,
        provider: "slack",
        providerMessageId: "4410.1",
      }),
    });
    const stored = await storage.storage.putFile({
      companyId: fixture.companyId,
      namespace: `issues/${conversation.issueId}`,
      originalFilename: "agent-result.txt",
      contentType: "text/plain",
      body: Buffer.from("agent result", "utf8"),
    });
    const attachment = await issueService(db).createAttachment({
      issueId: conversation.issueId,
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByAgentId: fixture.assignedAgentId,
      createdByRunId: runId,
    });
    const authorizationReason =
      await resolveChatRunPresentationAuthorizationReason(db, {
        companyId: fixture.companyId,
        issueId: conversation.issueId,
        runId,
      });
    expect(authorizationReason).toBe("allow_chat_run_presentation");
    const response = await db.transaction((tx) =>
      issueService(tx as unknown as TestDb).addComment(
        conversation.issueId,
        "The requested result is attached.",
        { agentId: fixture.assignedAgentId, runId },
        {
          attachmentIds: [attachment.id],
          authorType: "agent",
          authorizationReason,
        },
      ),
    );

    const endpointRuntime = runtime.endpoints.get(endpoint.id);
    if (!endpointRuntime) throw new Error("Expected Slack endpoint runtime");
    endpointRuntime.postResultIds.push("1788.301", "1788.302");
    await service.processPendingPublications();
    const publications = await readChatPublicationsByCommentId(response.id)
      .orderBy(asc(chatPublications.createdAt));
    expect(publications).toEqual([
      expect.objectContaining({
        state: "published",
        payload: { text: "The requested result is attached." },
      }),
      expect.objectContaining({
        state: "published",
        providerMessageId: "1788.302",
        payload: expect.objectContaining({ attachmentIds: [attachment.id] }),
      }),
    ]);
    expect(runtime.endpoints.get(endpoint.id)?.posts).toEqual([
      {
        threadId: channel.thread.id,
        text: "The requested result is attached.",
      },
      {
        threadId: channel.thread.id,
        text: "",
        files: [
          expect.objectContaining({
            filename: "agent-result.txt",
            data: Buffer.from("agent result", "utf8"),
          }),
        ],
      },
    ]);

    const [fileMessageLink] = await db
      .select()
      .from(chatMessageLinks)
      .where(
        and(
          eq(chatMessageLinks.endpointId, endpoint.id),
          eq(chatMessageLinks.conversationId, conversation.id),
          eq(chatMessageLinks.direction, "outbound"),
          eq(chatMessageLinks.providerMessageId, "1788.302"),
        ),
      );
    expect(fileMessageLink).toMatchObject({
      commentId: response.id,
      providerMessageId: "1788.302",
    });
    if (!callbacks.onReaction)
      throw new Error("Slack reaction callback was not registered");
    const fileMessage = makeMessage({
      id: "1788.302",
      text: "",
      mentioned: false,
    });
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
        message: fileMessage,
        messageId: fileMessage.id,
        raw: { event_ts: "1788.400" },
        rawEmoji: "+1",
        thread: channel.thread,
        threadId: channel.thread.id,
        user: fileMessage.author,
      },
    });
    const [reactionDelivery] = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.conversationId, conversation.id),
          eq(chatDeliveries.eventKind, "reaction_added"),
        ),
      );
    expect(reactionDelivery).toMatchObject({
      state: "processed",
      normalizedEvent: expect.objectContaining({
        message: { providerMessageId: "1788.302" },
        reaction: expect.objectContaining({ emoji: "thumbs_up" }),
      }),
    });
  });

  it("hands an explicitly bound same-run image to Discord's final native file response", async () => {
    const fixture = await seedCompany();
    const storage = createStorageService();
    const { callbacks, endpoint, runtime, service } =
      await configuredDiscordEndpoint(fixture, {
        storage: storage.storage,
      });
    const rootMessageId = "555555555555555710";
    const channel = makeThread({
      channelId: "333333333333333710",
      id: `discord:1457808928258658549:333333333333333710:${rootMessageId}`,
      name: "agent-image",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "discord",
      thread: channel.thread,
      message: makeMessage({
        id: rootMessageId,
        text: "@maya create and show an image",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id);
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    if (!conversation) throw new Error("Expected Discord conversation");

    const insertRun = async (agentId: string, status = "succeeded") => {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: fixture.companyId,
        agentId,
        status,
        contextSnapshot: await chatWakeContext({
          endpointId: endpoint.id,
          issueId: conversation.issueId,
          provider: "discord",
          providerMessageId: rootMessageId,
        }),
      });
      return runId;
    };
    const createAgentAttachment = async (
      runId: string,
      agentId: string,
      filename: string,
      body: Buffer,
      contentType = "image/png",
    ) => {
      const stored = await storage.storage.putFile({
        companyId: fixture.companyId,
        namespace: `issues/${conversation.issueId}`,
        originalFilename: filename,
        contentType,
        body,
      });
      return issueService(db).createAttachment({
        issueId: conversation.issueId,
        provider: stored.provider,
        objectKey: stored.objectKey,
        contentType: stored.contentType,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        originalFilename: stored.originalFilename,
        createdByAgentId: agentId,
        createdByRunId: runId,
      });
    };
    const bindAgentAttachment = (
      runId: string,
      agentId: string,
      body: string,
      attachmentId: string,
      authorizationReason = "allow_self",
    ) =>
      db.transaction((tx) =>
        issueService(tx as unknown as TestDb).addComment(
          conversation.issueId,
          body,
          { agentId, runId },
          {
            attachmentIds: [attachmentId],
            authorType: "agent",
            authorizationReason,
          },
        ),
      );

    const runId = await insertRun(fixture.assignedAgentId, "running");
    const imageBody = Buffer.from("generated cat image", "utf8");
    const selected = await createAgentAttachment(
      runId,
      fixture.assignedAgentId,
      "orange-tabby.png",
      imageBody,
    );
    expect(selected.originatingRunId).toBe(runId);
    const documentBody = Buffer.from("%PDF-1.7 generated report", "utf8");
    const selectedDocument = await createAgentAttachment(
      runId,
      fixture.assignedAgentId,
      "cat-notes.pdf",
      documentBody,
      "application/pdf",
    );
    const unbound = await createAgentAttachment(
      runId,
      fixture.assignedAgentId,
      "private-draft.png",
      Buffer.from("private unbound draft", "utf8"),
    );
    const directBody = Buffer.from("directly selected image", "utf8");
    const directSelectionComment = await issueService(db).addComment(
      conversation.issueId,
      "Recorded a direct upload before final presentation.",
      { agentId: fixture.assignedAgentId, runId },
      { authorType: "agent", authorizationReason: "paperclip_runner_protocol" },
    );
    const storedDirect = await storage.storage.putFile({
      companyId: fixture.companyId,
      namespace: `issues/${conversation.issueId}`,
      originalFilename: "direct-selection.png",
      contentType: "image/png",
      body: directBody,
    });
    const directSelection = await issueService(db).createAttachment({
      issueId: conversation.issueId,
      issueCommentId: directSelectionComment.id,
      provider: storedDirect.provider,
      objectKey: storedDirect.objectKey,
      contentType: storedDirect.contentType,
      byteSize: storedDirect.byteSize,
      sha256: storedDirect.sha256,
      originalFilename: storedDirect.originalFilename,
      createdByAgentId: fixture.assignedAgentId,
      createdByRunId: runId,
    });
    expect(directSelection.originatingRunId).toBe(runId);
    await expect(
      db
        .select({ id: chatPublications.id })
        .from(chatPublications)
        .where(
          eq(
            chatPublications.idempotencyKey,
            `attachment:${directSelection.id}:${endpoint.id}`,
          ),
        ),
    ).resolves.toHaveLength(0);
    const deletedSelectionComment = await issueService(db).addComment(
      conversation.issueId,
      "This selection was withdrawn before upload.",
      { agentId: fixture.assignedAgentId, runId },
      { authorType: "agent", authorizationReason: "allow_self" },
    );
    await db
      .update(issueComments)
      .set({ deletedAt: new Date() })
      .where(eq(issueComments.id, deletedSelectionComment.id));
    await expect(
      issueService(db).createAttachment({
        issueId: conversation.issueId,
        issueCommentId: deletedSelectionComment.id,
        provider: "local_disk",
        objectKey: "issues/deleted-parent.png",
        contentType: "image/png",
        byteSize: 14,
        sha256: "7".repeat(64),
        originalFilename: "deleted-parent.png",
        createdByAgentId: fixture.assignedAgentId,
        createdByRunId: runId,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      db
        .select({ id: assets.id })
        .from(assets)
        .where(eq(assets.objectKey, "issues/deleted-parent.png")),
    ).resolves.toHaveLength(0);
    const provisionalSelection = await issueService(db).addComment(
      conversation.issueId,
      "Selected the requested cat image for chat delivery.",
      { agentId: fixture.assignedAgentId, runId },
      { authorType: "agent", authorizationReason: "internal_agent_write" },
    );
    const selectionComment = await bindAgentAttachment(
      runId,
      fixture.assignedAgentId,
      "Selected the requested cat image for chat delivery.",
      selected.id,
    );
    expect(selectionComment.id).toBe(provisionalSelection.id);
    // A lost HTTP response may make the helper retry the same binding. The
    // retry must reuse the comment and must not fail or duplicate the file.
    const selectionRetry = await bindAgentAttachment(
      runId,
      fixture.assignedAgentId,
      "Selected the requested cat image for chat delivery.",
      selected.id,
    );
    expect(selectionRetry.id).toBe(selectionComment.id);
    const documentSelectionComment = await bindAgentAttachment(
      runId,
      fixture.assignedAgentId,
      "Selected the requested notes for chat delivery.",
      selectedDocument.id,
    );

    const otherRunId = await insertRun(fixture.assignedAgentId);
    const otherRunAttachment = await createAgentAttachment(
      otherRunId,
      fixture.assignedAgentId,
      "other-run.png",
      Buffer.from("other run", "utf8"),
    );
    const otherRunComment = await bindAgentAttachment(
      otherRunId,
      fixture.assignedAgentId,
      "This belongs to another run.",
      otherRunAttachment.id,
    );
    await expect(
      issueService(db).createAttachment({
        issueId: conversation.issueId,
        issueCommentId: otherRunComment.id,
        provider: "local_disk",
        objectKey: "issues/wrong-run-parent.png",
        contentType: "image/png",
        byteSize: 16,
        sha256: "9".repeat(64),
        originalFilename: "wrong-run-parent.png",
        createdByAgentId: fixture.assignedAgentId,
        createdByRunId: runId,
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: "issue_attachment_parent_run_mismatch" },
    });

    const remintedAttachment = await createAgentAttachment(
      otherRunId,
      fixture.assignedAgentId,
      "reminted-old-run.png",
      Buffer.from("old run provenance", "utf8"),
    );
    if (!remintedAttachment.artifactWorkProductId) {
      throw new Error("Expected upload to create an artifact work product");
    }
    await db
      .update(issueWorkProducts)
      .set({ createdByRunId: runId })
      .where(
        eq(issueWorkProducts.id, remintedAttachment.artifactWorkProductId),
      );
    await expect(
      bindAgentAttachment(
        runId,
        fixture.assignedAgentId,
        "A mutable work-product update cannot change upload provenance.",
        remintedAttachment.id,
      ),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: "issue_attachment_run_origin_mismatch" },
    });
    const [mutableWorkProduct] = await db
      .select()
      .from(issueWorkProducts)
      .where(
        eq(issueWorkProducts.id, remintedAttachment.artifactWorkProductId),
      );
    if (!mutableWorkProduct) {
      throw new Error("Expected reminted attachment work product");
    }
    await db
      .delete(issueWorkProducts)
      .where(
        eq(issueWorkProducts.id, remintedAttachment.artifactWorkProductId),
      );
    await db.insert(issueWorkProducts).values({
      ...mutableWorkProduct,
      id: randomUUID(),
      createdByRunId: runId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await expect(
      bindAgentAttachment(
        runId,
        fixture.assignedAgentId,
        "Deleting and recreating metadata cannot change upload provenance.",
        remintedAttachment.id,
      ),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: "issue_attachment_run_origin_mismatch" },
    });

    const legacyAttachment = await createAgentAttachment(
      runId,
      fixture.assignedAgentId,
      "legacy-without-origin.png",
      Buffer.from("legacy provenance unavailable", "utf8"),
    );
    await db
      .update(issueAttachments)
      .set({ originatingRunId: null })
      .where(eq(issueAttachments.id, legacyAttachment.id));
    await expect(
      bindAgentAttachment(
        runId,
        fixture.assignedAgentId,
        "Legacy attachment provenance fails closed.",
        legacyAttachment.id,
      ),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: "issue_attachment_run_origin_mismatch" },
    });

    const otherAgentRunId = await insertRun(fixture.replacementAgentId);
    const otherAgentAttachment = await createAgentAttachment(
      otherAgentRunId,
      fixture.replacementAgentId,
      "other-agent.png",
      Buffer.from("other agent", "utf8"),
    );
    await bindAgentAttachment(
      otherAgentRunId,
      fixture.replacementAgentId,
      "This belongs to another agent.",
      otherAgentAttachment.id,
    );

    const authorizationReason =
      await resolveChatRunPresentationAuthorizationReason(db, {
        companyId: fixture.companyId,
        issueId: conversation.issueId,
        runId,
      });
    expect(authorizationReason).toBe("allow_chat_run_presentation");
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId));
    const response = await issueService(db).addComment(
      conversation.issueId,
      "Here is the requested cat image.",
      { agentId: fixture.assignedAgentId, runId },
      { authorType: "agent", authorizationReason },
    );

    await service.processPendingPublications();
    const publications = await db
      .select()
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.conversationId, conversation.id),
          inArray(chatPublications.commentId, [
            response.id,
            selectionComment.id,
            documentSelectionComment.id,
            directSelectionComment.id,
          ]),
        ),
      )
      .orderBy(asc(chatPublications.createdAt));
    expect(publications).toEqual([
      expect.objectContaining({
        commentId: response.id,
        state: "published",
        payload: { text: "Here is the requested cat image." },
      }),
      expect.objectContaining({
        commentId: directSelectionComment.id,
        state: "published",
        payload: expect.objectContaining({
          attachmentIds: [directSelection.id],
        }),
      }),
      expect.objectContaining({
        commentId: selectionComment.id,
        state: "published",
        payload: expect.objectContaining({ attachmentIds: [selected.id] }),
      }),
      expect.objectContaining({
        commentId: documentSelectionComment.id,
        state: "published",
        payload: expect.objectContaining({
          attachmentIds: [selectedDocument.id],
        }),
      }),
    ]);
    expect(JSON.stringify(publications)).not.toContain(unbound.id);
    expect(JSON.stringify(publications)).not.toContain(otherRunAttachment.id);
    expect(JSON.stringify(publications)).not.toContain(remintedAttachment.id);
    expect(JSON.stringify(publications)).not.toContain(legacyAttachment.id);
    expect(JSON.stringify(publications)).not.toContain(otherAgentAttachment.id);
    expect(runtime.endpoints.get(endpoint.id)?.posts).toEqual([
      {
        threadId: channel.thread.id,
        text: "Here is the requested cat image.",
      },
      {
        threadId: channel.thread.id,
        text: "Shared direct-selection.png.",
        files: [
          expect.objectContaining({
            filename: "direct-selection.png",
            mimeType: "image/png",
            data: directBody,
          }),
        ],
      },
      {
        threadId: channel.thread.id,
        text: "Shared orange-tabby.png.",
        files: [
          expect.objectContaining({
            filename: "orange-tabby.png",
            mimeType: "image/png",
            data: imageBody,
          }),
        ],
      },
      {
        threadId: channel.thread.id,
        text: "Shared cat-notes.pdf.",
        files: [
          expect.objectContaining({
            filename: "cat-notes.pdf",
            mimeType: "application/pdf",
            data: documentBody,
          }),
        ],
      },
    ]);
    await expect(
      db
        .select({ issueCommentId: issueAttachments.issueCommentId })
        .from(issueAttachments)
        .where(eq(issueAttachments.id, unbound.id)),
    ).resolves.toEqual([{ issueCommentId: null }]);
  });
});
