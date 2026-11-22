import {
  randomUUID,
} from "node:crypto";
import {
  mkdtempSync,
  rmSync,
} from "node:fs";
import {
  and,
  asc,
  eq,
  inArray,
  sql,
} from "drizzle-orm";
import {
  expect,
  it,
  vi,
} from "vitest";
import {
  chatActions,
  chatConversations,
  chatDeliveries,
  chatEndpointResources,
  chatEndpoints,
  chatIdentityLinks,
  chatPublications,
  heartbeatRuns,
  issueAttachments,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  createDiscordAdapter,
} from "@chat-adapter/discord";
import {
  issueService,
} from "../../services/issues.js";
import {
  PaperclipRunnerToolAuthority,
} from "../../services/native-runtime/paperclip-runner-tool-authority.js";
import {
  NativeChatAttachmentReadScope,
} from "../../services/native-runtime/chat-attachment-read.js";
import {
  resolveChatRunPresentationAuthorizationReason,
} from "../../services/chat-run-publications.js";
import {
  makeMessage,
  makeThread,
} from ".././helpers/chat-channels-fixture.js";
import {
  addSelectedChatFinal,
  chatWakeContext,
  configuredDiscordEndpoint,
  configuredSlackEndpoint,
  configuredTelegramEndpoint,
  createStorageService,
  db,
  deliverMessage,
  describeChatChannelsSuite,
  linkLifecycleFixtureActor,
  qualifySetupRoundTrip,
  readChatConversationsByEndpointId,
  readChatDeliveriesByEndpointId,
  readIssueCommentsByIssueId,
  readIssuesByCompanyId,
  retirePublicationFixture,
  seedCompany,
  signedGitHubWebhookRequest,
  safeNativeProgressFixture,
  failedChatRetryFixture,
} from "../helpers/chat-channels-harness.js";
import os, {  } from "node:os";
import path, {  } from "node:path";
import type { Attachment, Message, Thread } from "chat";

describeChatChannelsSuite("chat channels 34-keeps-successive-telegram-dm-messages-on", () => {
  it("keeps successive Telegram DM messages on one active Paperclip task", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } =
      await configuredTelegramEndpoint(fixture);
    const dm = makeThread({
      channelId: "77112233",
      id: "telegram:77112233",
      isDM: true,
      name: "Telegram direct message",
    });

    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: dm.thread,
      message: makeMessage({
        id: "77112233:11",
        text: "Start one DM task",
        userId: "77112233",
      }),
      trigger: "direct_message",
    });
    expect(wakeup).toHaveBeenCalledTimes(1);
    await qualifySetupRoundTrip(service, endpoint.id, "77112233");
    await service.test(endpoint.id);
    wakeup.mockClear();
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: dm.thread,
      message: makeMessage({
        id: "77112233:12",
        text: "Continue that same DM task",
        userId: "77112233",
      }),
      trigger: "direct_message",
    });

    const conversations = await service.listConversations(endpoint.id);
    expect(conversations).toEqual([
      expect.objectContaining({ state: "active", sessionGeneration: 1 }),
    ]);
    expect(
      await readIssuesByCompanyId(fixture.companyId),
    ).toHaveLength(1);
    expect(
      (
        await readIssueCommentsByIssueId(conversations[0]!.issueId)
      ).map((comment) => comment.body),
    ).toEqual(
      expect.arrayContaining([
        "Start one DM task",
        "Continue that same DM task",
      ]),
    );
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it("fails closed for unbound rich callbacks and unknown slash commands", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service } =
      await configuredSlackEndpoint(fixture);
    const command = endpoint.setup.command;
    if (!command) throw new Error("Slack endpoint did not expose its command");
    expect(callbacks.onAction).toBeTypeOf("function");
    expect(callbacks.onModalSubmit).toBeTypeOf("function");
    expect(callbacks.onModalClose).toBeUndefined();
    expect(callbacks.onOptionsLoad).toBeUndefined();
    expect(callbacks.onReaction).toBeTypeOf("function");
    if (!callbacks.onSlashCommand)
      throw new Error("Slack slash command callback was not registered");
    await db.insert(chatEndpointResources).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      type: "channel",
      providerResourceId: "C-COMMAND-DENY",
      label: "denied commands",
      availability: "available",
      enabled: true,
    });
    const post = vi.fn(async () => ({
      id: "unexpected-post",
      threadId: "slack:C-COMMAND-DENY:6100.1",
    }));
    const postEphemeral = vi.fn(async () => ({
      id: "ephemeral-deny",
      threadId: "slack:C-COMMAND-DENY:6100.1",
    }));
    await callbacks.onSlashCommand({
      endpointId: endpoint.id,
      provider: "slack",
      event: {
        channel: {
          id: "C-COMMAND-DENY",
          name: "denied commands",
          isDM: false,
          post,
          postEphemeral,
        } as never,
        command: "/anything-else",
        text: "should not start work",
        triggerId: "trigger-deny",
        user: {
          userId: "U-COMMANDER",
          userName: "commander",
          fullName: "Command User",
          isBot: false,
          isMe: false,
          isSystem: false,
        },
        raw: { trigger_id: "trigger-deny" },
        adapter: {} as never,
        openModal: async () => undefined,
      },
    });
    expect(post).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(postEphemeral).toHaveBeenCalledWith(
        "U-COMMANDER",
        `This connection only accepts ${command}.`,
        {
          fallbackToDM: false,
        },
      ),
    );
    expect(await service.listConversations(endpoint.id)).toEqual([]);
  });

  it("applies the direct-message toggle to Slack slash commands", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service } =
      await configuredSlackEndpoint(fixture);
    const command = endpoint.setup.command;
    if (!command) throw new Error("Slack endpoint did not expose its command");
    if (!callbacks.onSlashCommand)
      throw new Error("Slack slash command callback was not registered");
    await service.update(
      endpoint.id,
      { allowDirectMessages: false },
      "owner-user",
    );
    const post = vi.fn(async () => ({
      id: "unexpected-dm-post",
      threadId: "slack:D-COMMANDS:6200.1",
    }));
    const postEphemeral = vi.fn(async () => ({
      id: "ephemeral-dm-deny",
      threadId: "slack:D-COMMANDS:6200.1",
    }));
    await callbacks.onSlashCommand({
      endpointId: endpoint.id,
      provider: "slack",
      event: {
        channel: {
          id: "D-COMMANDS",
          name: "direct message",
          isDM: true,
          post,
          postEphemeral,
        } as never,
        command,
        text: "should not start work",
        triggerId: "trigger-dm-deny",
        user: {
          userId: "U-COMMANDER",
          userName: "commander",
          fullName: "Command User",
          isBot: false,
          isMe: false,
          isSystem: false,
        },
        raw: { trigger_id: "trigger-dm-deny" },
        adapter: {} as never,
        openModal: async () => undefined,
      },
    });
    expect(post).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(postEphemeral).toHaveBeenCalledWith(
        "U-COMMANDER",
        "This channel or account is not allowed to start Paperclip work.",
        { fallbackToDM: false },
      ),
    );
  });

  it.each(["metadata_only", "file_revisions"] as const)(
    "preserves exact Discord source authority through registered Gateway %s updates",
    async (mode) => {
      const fixture = await seedCompany();
      const storage = createStorageService();
      const { callbacks, endpoint, runtime, service, wakeup, cancelRun } =
        await configuredDiscordEndpoint(fixture, {
          storage: storage.storage,
          // This fixture explicitly replays the staged root below. Do not
          // race an automatic root drain against its setup endpoint mutation;
          // an unadmitted root correctly holds every later lifecycle receipt.
          scheduleDeferredWork: () => undefined,
        });
      const guildId = "1457808928258658549";
      const channelId = "333333333333333333";
      const messageId = "555555555555555688";
      const userId = "444444444444444444";
      const threadId = `discord:${guildId}:${channelId}:${messageId}`;
      const handlers = new Map<
        string,
        (...args: unknown[]) => Promise<void> | void
      >();
      const logger = {
        child: () => logger,
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      const adapter = createDiscordAdapter({
        applicationId: "123456789012345678",
        botToken: "discord-fixture-token",
        webhookVerifier: async () => false,
        logger,
      });
      const providerRuntime = runtime.endpoints.get(endpoint.id)!;
      const processMessageUpdated = vi.fn(
        async (event: {
          message: Message;
          previousMessage?: Message;
          threadId: string;
        }) => {
          await callbacks.onMessageUpdated!({
            endpointId: endpoint.id,
            provider: "discord",
            thread: providerRuntime.thread(event.threadId) as unknown as Thread,
            message: event.message,
            previousMessage: event.previousMessage,
          });
        },
      );
      const processMessageDeleted = vi.fn(
        async (event: Record<string, unknown>) => {
          await callbacks.onMessageDeleted!({
            endpointId: endpoint.id,
            provider: "discord",
            event: event as never,
          });
        },
      );
      await adapter.initialize({
        processMessageUpdated,
        processMessageDeleted,
      } as never);
      const gateway = adapter as unknown as {
        setupLegacyGatewayHandlers(
          client: unknown,
          closing: () => boolean,
        ): void;
        gatewayChatMessage(
          message: unknown,
          threadId: string,
          mentioned?: boolean,
        ): Message;
      };
      gateway.setupLegacyGatewayHandlers(
        {
          user: { id: "123456789012345678" },
          ws: { handlePacket: () => false },
          on(
            event: string,
            handler: (...args: unknown[]) => Promise<void> | void,
          ) {
            handlers.set(event, handler);
            return this;
          },
        },
        () => false,
      );
      const fileBody = Buffer.from("The exact original Discord source.\n");
      const sourceFile = {
        id: "original-file",
        name: "original.txt",
        contentType: "text/plain",
        size: fileBody.length,
        url: "https://cdn.discordapp.com/attachments/333333333333333333/555555555555555689/original.txt?ex=ORIGINAL_PRIVATE",
      };
      const original = {
        id: messageId,
        channelId,
        guildId,
        partial: false,
        content: "@maya keep this exact original request authoritative",
        attachments: new Map<string, Record<string, unknown>>([
          [sourceFile.id, sourceFile],
        ]),
        messageSnapshots: new Map(),
        channel: { isThread: () => false, parentId: null },
        author: { id: userId, username: "ada", displayName: "Ada", bot: false },
        createdAt: new Date(),
        editedAt: null,
      };
      let runId: string | undefined;
      const workspaceRoot = mkdtempSync(
        path.join(os.tmpdir(), "discord-source-update-"),
      );
      let reader: NativeChatAttachmentReadScope | undefined;
      try {
        const message = gateway.gatewayChatMessage(original, threadId, true);
        // Substitute only transport bytes, not normalization or admission.
        message.attachments[0]!.fetchData = vi.fn(async () => fileBody);
        await expect(
          callbacks.onDiscordRootMentionAdmission!({
            endpointId: endpoint.id,
            guildId,
            channelId,
            messageId,
            message,
            threadId,
            userId,
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
        expect(delivery).toBeDefined();
        await service.processPendingDeliveries(25, delivery.id);
        await expect(
          db
            .select({ status: chatActions.status })
            .from(chatActions)
            .where(
              and(
                eq(chatActions.endpointId, endpoint.id),
                eq(chatActions.deliveryId, delivery.id),
                eq(chatActions.kind, "inbound_wakeup"),
              ),
            ),
        ).resolves.toEqual([{ status: "processed" }]);
        await qualifySetupRoundTrip(service, endpoint.id, userId);
        await service.test(endpoint.id);
        const [conversation] = await service.listConversations(endpoint.id);
        const contextSnapshot = await chatWakeContext({
          endpointId: endpoint.id,
          issueId: conversation.issueId,
          provider: "discord",
          providerMessageId: messageId,
        });
        runId = randomUUID();
        const binding = {
          companyId: fixture.companyId,
          agentId: fixture.assignedAgentId,
          issueId: conversation.issueId,
          runId,
        };
        await db.insert(heartbeatRuns).values({
          id: runId,
          companyId: fixture.companyId,
          agentId: fixture.assignedAgentId,
          status: "running",
          runtimeMode: "native",
          nativeIssueId: conversation.issueId,
          contextSnapshot: {
            ...contextSnapshot,
            paperclipHarnessCheckedOut: true,
            paperclipWake: {
              checkedOutByHarness: true,
              externalChatProvider: "discord",
              issue: { id: conversation.issueId, workMode: "standard" },
              commentIds: contextSnapshot.wakeCommentIds,
            },
          },
        });
        await db
          .update(issues)
          .set({ executionRunId: runId, status: "in_progress" })
          .where(eq(issues.id, conversation.issueId));
        const authority = () =>
          resolveChatRunPresentationAuthorizationReason(db, {
            companyId: fixture.companyId,
            issueId: conversation.issueId,
            runId: runId!,
          });
        await expect(authority()).resolves.toBe("allow_chat_run_presentation");
        const [attachment] = await issueService(db).listAttachments(
          conversation.issueId,
        );
        expect(attachment).toBeDefined();
        const selection = {
          sourceCommentId: attachment.issueCommentId!,
          attachmentId: attachment.id,
        };
        reader = new NativeChatAttachmentReadScope({
          db,
          binding,
          workspaceRoot,
          executionTargetKind: "local",
          storage: storage.storage,
        });
        const tools = new PaperclipRunnerToolAuthority(db, {
          ...binding,
          workspaceRoot,
          storage: storage.storage,
          chatAttachmentReadScope: reader,
        });
        await expect(
          tools.execute({
            tool: "list_chat_attachments",
            callId: "before-update",
            arguments: { sourceCommentId: selection.sourceCommentId },
          }),
        ).resolves.toMatchObject({
          attachments: [expect.objectContaining(selection)],
        });
        const commentsBefore = await db
          .select({ id: issueComments.id })
          .from(issueComments)
          .where(eq(issueComments.issueId, conversation.issueId))
          .orderBy(asc(issueComments.id));
        const wakesBefore = wakeup.mock.calls.length;
        const reactionsBefore = providerRuntime.reactions.length;
        const postsBefore = providerRuntime.posts.length;
        if (mode === "metadata_only") {
          const threadCreated = {
            ...original,
            flags: 32,
            thread: { id: messageId },
            pinned: true,
            embeds: [{ title: "Link preview" }],
          };
          await handlers.get("messageUpdate")!(original, threadCreated);
          await handlers.get("messageUpdate")!(original, threadCreated);
          expect(processMessageUpdated).not.toHaveBeenCalled();
          expect(
            await db
              .select({ id: chatDeliveries.id })
              .from(chatDeliveries)
              .where(
                and(
                  eq(chatDeliveries.endpointId, endpoint.id),
                  eq(chatDeliveries.eventKind, "message_updated"),
                ),
              ),
          ).toEqual([]);
          expect(
            await db
              .select({ id: issueComments.id })
              .from(issueComments)
              .where(eq(issueComments.issueId, conversation.issueId))
              .orderBy(asc(issueComments.id)),
          ).toEqual(commentsBefore);
          expect(wakeup).toHaveBeenCalledTimes(wakesBefore);
          expect(cancelRun).not.toHaveBeenCalled();
          expect(providerRuntime.reactions).toHaveLength(reactionsBefore);
          expect(providerRuntime.posts).toHaveLength(postsBefore);
          await expect(
            tools.execute({
              tool: "list_chat_attachments",
              callId: "after-metadata",
              arguments: { sourceCommentId: selection.sourceCommentId },
            }),
          ).resolves.toMatchObject({
            attachments: [expect.objectContaining(selection)],
          });
          await expect(authority()).resolves.toBe(
            "allow_chat_run_presentation",
          );
          await db
            .update(heartbeatRuns)
            .set({ status: "succeeded", finishedAt: new Date() })
            .where(eq(heartbeatRuns.id, runId));
          const comment = await addSelectedChatFinal({
            agentId: fixture.assignedAgentId,
            body: "Exact source answer remains deliverable.",
            companyId: fixture.companyId,
            issueId: conversation.issueId,
            runId,
          });
          await service.processPendingPublications();
          await service.processPendingPublications();
          expect(
            providerRuntime.posts.filter(
              (post) =>
                post.text === "Exact source answer remains deliverable.",
            ),
          ).toHaveLength(1);
          expect(
            await db
              .select({
                state: chatPublications.state,
                attempts: chatPublications.attempts,
              })
              .from(chatPublications)
              .where(eq(chatPublications.commentId, comment.id)),
          ).toEqual([{ state: "published", attempts: 1 }]);
        } else {
          const firstFile = {
            id: "attachment-1",
            name: "source.txt",
            contentType: "text/plain",
            size: 123,
            url: "https://cdn.discordapp.com/attachments/channel/file/source.txt?ex=NEVER_PERSIST",
          };
          const secondFile = { ...firstFile, id: "attachment-2" };
          const snapshots = [
            original,
            { ...original, attachments: new Map([[firstFile.id, firstFile]]) },
            {
              ...original,
              attachments: new Map([[secondFile.id, secondFile]]),
            },
            { ...original, attachments: new Map() },
          ];
          for (let index = 1; index < snapshots.length; index += 1) {
            await handlers.get("messageUpdate")!(
              snapshots[index - 1],
              snapshots[index],
            );
            await handlers.get("messageUpdate")!(
              snapshots[index - 1],
              snapshots[index],
            );
          }
          expect(processMessageUpdated).toHaveBeenCalledTimes(6);
          const lifecycle = await db
            .select()
            .from(chatDeliveries)
            .where(
              and(
                eq(chatDeliveries.endpointId, endpoint.id),
                eq(chatDeliveries.eventKind, "message_updated"),
              ),
            );
          expect(lifecycle).toHaveLength(3);
          expect(lifecycle.every((row) => row.state === "processed")).toBe(
            true,
          );
          expect(
            new Set(lifecycle.map((row) => row.providerEventId)).size,
          ).toBe(3);
          expect(JSON.stringify(lifecycle)).not.toContain("NEVER_PERSIST");
          expect(JSON.stringify(lifecycle)).not.toContain("cdn.discordapp.com");
          await expect(
            tools.execute({
              tool: "read_chat_attachment",
              callId: "edited-source-read",
              arguments: selection,
            }),
          ).rejects.toThrow("paperclip_runner_chat_attachment_source_denied");
          await expect(
            tools.execute({
              tool: "reuse_chat_attachment",
              callId: "edited-source-reuse",
              arguments: {
                ...selection,
                title: "Do not reuse",
                idempotencyKey: "edited-source-reuse",
              },
            }),
          ).rejects.toThrow("paperclip_runner_chat_attachment_source_denied");
          expect(storage.putFile).toHaveBeenCalledTimes(1);
          const textEdit = {
            ...original,
            content: "actual changed request",
            editedAt: new Date(),
          };
          await handlers.get("messageUpdate")!(original, textEdit);
          await handlers.get("messageDelete")!(textEdit);
          expect(processMessageDeleted).toHaveBeenCalledTimes(1);
          const allLifecycle = await db
            .select({
              eventKind: chatDeliveries.eventKind,
              state: chatDeliveries.state,
            })
            .from(chatDeliveries)
            .where(
              and(
                eq(chatDeliveries.endpointId, endpoint.id),
                inArray(chatDeliveries.eventKind, [
                  "message_updated",
                  "message_deleted",
                ]),
              ),
            );
          expect(allLifecycle).toHaveLength(5);
          expect(allLifecycle.every((row) => row.state === "processed")).toBe(
            true,
          );
        }
      } finally {
        await reader?.close();
        if (runId) {
          await db
            .update(heartbeatRuns)
            .set({ status: "succeeded", finishedAt: new Date() })
            .where(eq(heartbeatRuns.id, runId));
          await db
            .update(issues)
            .set({ executionRunId: null })
            .where(eq(issues.executionRunId, runId));
        }
        await retirePublicationFixture(service, endpoint.id);
        rmSync(workspaceRoot, { recursive: true, force: true });
      }
    },
  );

  it("records message edits and deletes durably and deduplicates lifecycle callbacks", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } =
      await configuredSlackEndpoint(fixture);
    const channel = makeThread({
      channelId: "C-LIFECYCLE",
      id: "slack:C-LIFECYCLE:7000.1",
      name: "lifecycle",
    });
    const original = makeMessage({
      id: "7000.1",
      text: "@maya original request",
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
    if (!callbacks.onMessageUpdated || !callbacks.onMessageDeleted) {
      throw new Error("Slack lifecycle callbacks were not registered");
    }
    const edited = {
      ...makeMessage({ id: "7000.1", text: "@maya corrected request" }),
      metadata: {
        dateSent: new Date("2026-09-04T10:00:00.000Z"),
        edited: true,
        editedAt: new Date("2026-09-04T10:01:00.000Z"),
      },
    } as Message;
    const updateEvent = {
      endpointId: endpoint.id,
      provider: "slack" as const,
      thread: channel.thread,
      message: edited,
      previousMessage: original,
    };
    await callbacks.onMessageUpdated(updateEvent);
    await callbacks.onMessageUpdated(updateEvent);
    const sameTimestampUpdate = {
      ...updateEvent,
      message: {
        ...edited,
        text: "@maya second correction in the same millisecond",
      } as Message,
    };
    await callbacks.onMessageUpdated(sameTimestampUpdate);
    await callbacks.onMessageUpdated(sameTimestampUpdate);
    const deleteEvent = {
      endpointId: endpoint.id,
      provider: "slack" as const,
      event: {
        adapter: {} as never,
        channelId: "C-LIFECYCLE",
        deletedAt: new Date("2026-09-04T10:02:00.000Z"),
        messageId: "7000.1",
        platform: "slack",
        raw: {},
        threadId: channel.thread.id,
      },
    };
    await callbacks.onMessageDeleted(deleteEvent);
    await callbacks.onMessageDeleted(deleteEvent);
    await callbacks.onMessageUpdated({
      ...updateEvent,
      message: {
        ...edited,
        text: "@maya stale edit delivered after deletion",
        metadata: {
          ...edited.metadata,
          editedAt: new Date("2026-09-04T10:03:00.000Z"),
        },
      } as Message,
    });

    const deliveries = await readChatDeliveriesByEndpointId(endpoint.id);
    expect(deliveries.map((delivery) => delivery.eventKind).sort()).toEqual([
      "mention",
      "message",
      "message_deleted",
      "message_updated",
      "message_updated",
      "message_updated",
    ]);
    expect(
      deliveries.find(
        (delivery) =>
          delivery.eventKind === "message_updated" &&
          delivery.state === "filtered",
      ),
    ).toMatchObject({
      redactedError:
        "Message edit arrived after the provider message was deleted",
    });
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    const comments = await readIssueCommentsByIssueId(conversation.issueId);
    expect(
      comments
        .filter(
          (comment) =>
            comment.body !== "Setup round trip complete" &&
            comment.body !== "Setup follow-up",
        )
        .map((comment) => comment.body)
        .sort(),
    ).toEqual(
      [
        "@maya original request",
        "An external message was edited:\n\n@maya corrected request",
        "An external message was edited:\n\n@maya second correction in the same millisecond",
        "An external message in this conversation was deleted.",
      ].sort(),
    );
    expect(wakeup).toHaveBeenCalledTimes(2);
  });

  it("redacts lifecycle edits and ignores reactions after channel reach is revoked", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service } =
      await configuredSlackEndpoint(fixture);
    const channel = makeThread({
      channelId: "C-LIFECYCLE-REVOKED",
      id: "slack:C-LIFECYCLE-REVOKED:7040.1",
      name: "lifecycle-revoked",
    });
    const original = makeMessage({
      id: "7040.1",
      text: "@maya establish a task before reach changes",
      mentioned: true,
      userId: "U-LIFECYCLE-REVOKED",
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
    if (!callbacks.onMessageUpdated || !callbacks.onReaction) {
      throw new Error("Slack lifecycle callbacks were not registered");
    }
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    const commentCount = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.issueId, conversation!.issueId))
      .then((rows) => rows.length);
    await service.replaceResources(endpoint.id, [
      { id: conversation!.resourceId!, enabled: false },
    ]);
    const secretEdit = "@maya do not retain this revoked edit";
    await callbacks.onMessageUpdated({
      endpointId: endpoint.id,
      provider: "slack",
      thread: channel.thread,
      message: {
        ...original,
        text: secretEdit,
        metadata: {
          dateSent: new Date("2026-09-05T15:10:00Z"),
          edited: true,
          editedAt: new Date("2026-09-05T15:11:00Z"),
        },
      } as Message,
      previousMessage: original,
    });
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
        raw: { event_ts: "7041.1" },
        rawEmoji: "+1",
        thread: channel.thread,
        threadId: channel.thread.id,
        user: original.author,
      },
    });

    await expect(
      db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(eq(issueComments.issueId, conversation!.issueId)),
    ).resolves.toHaveLength(commentCount);
    const lifecycle = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(chatDeliveries.eventKind, "message_updated"),
        ),
      )
      .then((rows) => rows[0]);
    expect(lifecycle).toMatchObject({
      state: "processed",
      conversationId: conversation!.id,
      principalId: expect.any(String),
      redactedError:
        "Provider edit invalidation retained without task content while destination access is disabled",
      normalizedEvent: {
        filtering: { contentRetained: false },
        message: { providerSentAt: "2026-09-05T15:11:00.000Z" },
      },
    });
    expect(lifecycle.normalizedEvent.message).not.toHaveProperty("text");
    expect(JSON.stringify(lifecycle?.normalizedEvent)).not.toContain(
      secretEdit,
    );
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
    ).resolves.toEqual([]);
  });

  it.each(
    (
      [
        "deletion",
        "edit",
        "file_removal",
        "revoked_edit",
        "revoked_file_removal",
      ] as const
    ).flatMap((kind) =>
      (["image/png", "text/plain"] as const).map((contentType) => ({
        kind,
        contentType,
      })),
    ),
  )(
    "keeps a verified Slack $kind authoritative for $contentType read and reuse after reach or identity returns",
    async ({ kind, contentType }) => {
      const relinkActor = kind.startsWith("revoked_");
      const mutation = kind.replace("revoked_", "");
      const fixture = await seedCompany();
      const storage = createStorageService();
      const { callbacks, endpoint, runtime, service, wakeup } =
        await configuredSlackEndpoint(fixture, { storage: storage.storage });
      const workspaceRoot = mkdtempSync(
        path.join(os.tmpdir(), "slack-deleted-source-"),
      );
      let reader: NativeChatAttachmentReadScope | undefined;
      try {
        const channel = makeThread({
          channelId: "C-DELETED-FILE",
          id: "slack:C-DELETED-FILE:7060.1",
          name: "deleted-file",
        });
        const body =
          contentType === "image/png"
            ? Buffer.from(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3XcAAAAASUVORK5CYII=",
                "base64",
              )
            : Buffer.from(
                "A deleted source must not become reusable when access returns.\n",
              );
        const original = makeMessage({
          id: "7060.1",
          text: "@maya retain this exact file",
          mentioned: true,
          raw: {
            files: [
              {
                id: "F-ORIGINAL",
                name: "source",
                mimetype: contentType,
                size: body.length,
              },
            ],
          },
          attachments: [
            {
              type: contentType === "image/png" ? "image" : "file",
              name: contentType === "image/png" ? "source.png" : "source.txt",
              mimeType: contentType,
              size: body.length,
              fetchData: async () => body,
              fetchMetadata: { testRecoveryKey: "slack-deleted-file" },
            } as Attachment,
          ],
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
        const [conversation] = await service.listConversations(endpoint.id);
        const linkedPrincipalId = relinkActor
          ? await linkLifecycleFixtureActor({
              companyId: fixture.companyId,
              endpointId: endpoint.id,
              externalId: original.author.userId,
            })
          : null;
        const [attachment] = await db
          .select()
          .from(issueAttachments)
          .where(eq(issueAttachments.issueId, conversation.issueId));
        expect(attachment?.issueCommentId).toBeTruthy();
        const runId = randomUUID();
        const binding = {
          companyId: fixture.companyId,
          agentId: fixture.assignedAgentId,
          issueId: conversation.issueId,
          runId,
        };
        const context = {
          ...(await chatWakeContext({
            endpointId: endpoint.id,
            issueId: conversation.issueId,
            provider: "slack",
            providerMessageId: original.id,
          })),
          paperclipHarnessCheckedOut: true,
          paperclipWake: {
            reason: "External chat message received",
            externalChatProvider: "slack",
            checkedOutByHarness: true,
            issue: { id: conversation.issueId, workMode: "standard" },
            commentIds: [attachment.issueCommentId!],
          },
        };
        await db.insert(heartbeatRuns).values({
          ...binding,
          nativeIssueId: conversation.issueId,
          id: runId,
          runtimeMode: "native",
          status: "running",
          contextSnapshot: context,
        });
        await db
          .update(issues)
          .set({ executionRunId: runId, status: "in_progress" })
          .where(eq(issues.id, conversation.issueId));
        reader = new NativeChatAttachmentReadScope({
          db,
          binding,
          workspaceRoot,
          executionTargetKind: "local",
          storage: storage.storage,
        });
        const authority = new PaperclipRunnerToolAuthority(db, {
          ...binding,
          workspaceRoot,
          storage: storage.storage,
          chatAttachmentReadScope: reader,
        });
        const selection = {
          sourceCommentId: attachment.issueCommentId!,
          attachmentId: attachment.id,
        };
        await expect(
          authority.execute({
            tool: "list_chat_attachments",
            callId: "before-deletion",
            arguments: { sourceCommentId: selection.sourceCommentId },
          }),
        ).resolves.toMatchObject({
          attachments: [expect.objectContaining(selection)],
        });
        const beforeComments = await db
          .select({ id: issueComments.id })
          .from(issueComments)
          .where(eq(issueComments.issueId, conversation.issueId))
          .orderBy(issueComments.id);
        const beforeWakes = wakeup.mock.calls.length;
        const providerRuntime = runtime.endpoints.get(endpoint.id)!;
        const beforeProvider = {
          posts: providerRuntime.posts.length,
          reactions: providerRuntime.reactions.length,
        };
        if (linkedPrincipalId) {
          await db
            .update(chatIdentityLinks)
            .set({
              status: "revoked",
              paperclipUserId: null,
              revokedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(chatIdentityLinks.endpointId, endpoint.id),
                eq(chatIdentityLinks.principalId, linkedPrincipalId),
              ),
            );
        } else {
          await service.replaceResources(endpoint.id, [
            { id: conversation.resourceId!, enabled: false },
          ]);
        }
        const providerSentAt = new Date();
        const replacementFetch = vi.fn(async () => body);
        if (mutation === "deletion") {
          await callbacks.onMessageDeleted!({
            endpointId: endpoint.id,
            provider: "slack",
            event: {
              adapter: {} as never,
              channelId: channel.thread.channelId,
              deletedAt: providerSentAt,
              messageId: original.id,
              platform: "slack",
              raw: {},
              threadId: channel.thread.id,
            },
          });
        } else {
          await callbacks.onMessageUpdated!({
            endpointId: endpoint.id,
            provider: "slack",
            thread: channel.thread,
            previousMessage: original,
            message: {
              ...original,
              text:
                mutation === "edit"
                  ? "PRIVATE_DISABLED_EDIT_MUST_NOT_PERSIST"
                  : original.text,
              metadata: {
                ...original.metadata,
                edited: true,
                editedAt: providerSentAt,
              },
              attachments:
                mutation === "edit"
                  ? [
                      {
                        ...original.attachments[0],
                        fetchData: replacementFetch,
                      },
                    ]
                  : [],
              raw: {
                files:
                  mutation === "edit"
                    ? [
                        {
                          id: "F-REPLACEMENT",
                          name: "replacement",
                          mimetype: contentType,
                          size: body.length,
                          url_private:
                            "https://files.slack.com/PRIVATE_DISABLED_ATTACHMENT_URL",
                        },
                      ]
                    : [],
              },
            } as unknown as Message,
          });
        }
        if (linkedPrincipalId) {
          await expect(
            authority.execute({
              tool: "read_chat_attachment",
              callId: "before-relink",
              arguments: selection,
            }),
          ).rejects.toThrow(
            "paperclip_runner_chat_attachment_read_not_authorized",
          );
          await db
            .update(chatIdentityLinks)
            .set({
              status: "linked",
              paperclipUserId: "owner-user",
              revokedAt: null,
              confirmedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(chatIdentityLinks.endpointId, endpoint.id),
                eq(chatIdentityLinks.principalId, linkedPrincipalId),
              ),
            );
        } else {
          await service.replaceResources(endpoint.id, [
            { id: conversation.resourceId!, enabled: true },
          ]);
        }
        const readsBefore = vi.mocked(storage.storage.getObject).mock.calls
          .length;
        await expect(
          authority.execute({
            tool: "reuse_chat_attachment",
            callId: "deleted-source-reuse",
            arguments: {
              ...selection,
              idempotencyKey: "deleted-source-reuse",
              title: "Must remain unavailable",
            },
          }),
        ).rejects.toThrow("paperclip_runner_chat_attachment_source_denied");
        await expect(
          authority.execute({
            tool: "read_chat_attachment",
            callId: "deleted-source-read",
            arguments: selection,
          }),
        ).rejects.toThrow("paperclip_runner_chat_attachment_source_denied");
        await expect(
          authority.execute({
            tool: "list_chat_attachments",
            callId: "after-deletion",
            arguments: { sourceCommentId: selection.sourceCommentId },
          }),
        ).resolves.toEqual({
          attachments: [],
          nextCursor: null,
          complete: true,
        });
        expect(vi.mocked(storage.storage.getObject).mock.calls.length).toBe(
          readsBefore,
        );
        expect(storage.putFile).toHaveBeenCalledTimes(1);
        expect(replacementFetch).not.toHaveBeenCalled();
        await expect(
          db
            .select({ id: issueComments.id })
            .from(issueComments)
            .where(eq(issueComments.issueId, conversation.issueId))
            .orderBy(issueComments.id),
        ).resolves.toEqual(beforeComments);
        expect(wakeup.mock.calls.length).toBe(beforeWakes);
        expect({
          posts: providerRuntime.posts.length,
          reactions: providerRuntime.reactions.length,
        }).toEqual(beforeProvider);
        const [tombstone] = await db
          .select()
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, endpoint.id),
              eq(
                chatDeliveries.eventKind,
                mutation === "deletion" ? "message_deleted" : "message_updated",
              ),
            ),
          );
        expect(tombstone).toMatchObject({
          state: "processed",
          conversationId: conversation.id,
          principalId: mutation === "deletion" ? null : expect.any(String),
          normalizedEvent: {
            filtering: { contentRetained: false },
            message: { providerSentAt: providerSentAt.toISOString() },
          },
        });
        expect(tombstone.normalizedEvent.message).not.toHaveProperty("text");
        expect(JSON.stringify(tombstone.normalizedEvent)).not.toContain(
          "PRIVATE_DISABLED_",
        );
      } finally {
        await reader?.close();
        // Global milestone scans include paused endpoints. Retire this exact
        // fixture's conversation without rewriting its asserted run/audit rows.
        await db
          .update(chatConversations)
          .set({ state: "completed" })
          .where(
            and(
              eq(chatConversations.companyId, fixture.companyId),
              eq(chatConversations.endpointId, endpoint.id),
            ),
          );
        await retirePublicationFixture(service, endpoint.id);
        rmSync(workspaceRoot, { recursive: true, force: true });
      }
    },
  );

  it.each(["deletion", "edit", "revoked_edit"] as const)(
    "refuses an otherwise eligible exact Slack retry after %s without admitting source changes",
    async (kind) => {
      const context = await failedChatRetryFixture(
        "slack",
        "U-SAFE-PROGRESS",
        kind === "revoked_edit",
      );
      try {
        const linkedPrincipalId =
          kind === "revoked_edit"
            ? (
                await db
                  .select()
                  .from(chatIdentityLinks)
                  .where(eq(chatIdentityLinks.endpointId, context.endpoint.id))
              )[0]!.principalId
            : null;
        const input = {
          companyId: context.fixture.companyId,
          issueId: context.issue.id,
          agentId: context.fixture.assignedAgentId,
          failedRunId: context.runId,
          initiatedByUserId: "owner-user",
        };
        const rollbackProbe = new Error(
          "rollback authorized pre-deletion retry probe",
        );
        await expect(
          db.transaction(async (tx) => {
            await expect(
              context.service.prepareFailedChatRunRetry(tx, input),
            ).resolves.toMatchObject({ issueId: context.issue.id });
            throw rollbackProbe;
          }),
        ).rejects.toBe(rollbackProbe);
        const before = await db
          .select({ id: chatActions.id })
          .from(chatActions)
          .where(eq(chatActions.endpointId, context.endpoint.id))
          .orderBy(chatActions.id);
        if (linkedPrincipalId) {
          await db
            .update(chatIdentityLinks)
            .set({
              status: "revoked",
              paperclipUserId: null,
              revokedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(chatIdentityLinks.endpointId, context.endpoint.id),
                eq(chatIdentityLinks.principalId, linkedPrincipalId),
              ),
            );
        } else {
          await context.service.replaceResources(context.endpoint.id, [
            { id: context.conversation.resourceId!, enabled: false },
          ]);
        }
        const callbacks = context.runtime.configurations.get(
          context.endpoint.id,
        )!.callbacks;
        if (kind === "deletion") {
          await callbacks.onMessageDeleted!({
            endpointId: context.endpoint.id,
            provider: "slack",
            event: {
              adapter: {} as never,
              channelId: context.thread.thread.channelId,
              deletedAt: new Date(),
              messageId: context.messageId,
              platform: "slack",
              raw: {},
              threadId: context.thread.thread.id,
            },
          });
        } else {
          await callbacks.onMessageUpdated!({
            endpointId: context.endpoint.id,
            provider: "slack",
            thread: context.thread.thread,
            message: makeMessage({
              id: context.messageId,
              text: "PRIVATE_DISABLED_RETRY_EDIT",
              userId: "U-SAFE-PROGRESS",
            }),
          });
        }
        if (linkedPrincipalId) {
          await db
            .update(chatIdentityLinks)
            .set({
              status: "linked",
              paperclipUserId: "owner-user",
              revokedAt: null,
              confirmedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(chatIdentityLinks.endpointId, context.endpoint.id),
                eq(chatIdentityLinks.principalId, linkedPrincipalId),
              ),
            );
        } else {
          await context.service.replaceResources(context.endpoint.id, [
            { id: context.conversation.resourceId!, enabled: true },
          ]);
        }
        await expect(
          db.transaction((tx) =>
            context.service.prepareFailedChatRunRetry(tx, input),
          ),
        ).rejects.toMatchObject({
          details: { code: "chat_failed_run_retry_not_authorized" },
        });
        await expect(
          db
            .select({ id: chatActions.id })
            .from(chatActions)
            .where(eq(chatActions.endpointId, context.endpoint.id))
            .orderBy(chatActions.id),
        ).resolves.toEqual(before);
      } finally {
        await db
          .update(chatConversations)
          .set({ state: "completed" })
          .where(
            and(
              eq(chatConversations.companyId, context.fixture.companyId),
              eq(chatConversations.id, context.conversation.id),
            ),
          );
        await retirePublicationFixture(context.service, context.endpoint.id);
      }
    },
  );

  it.each([
    "unknown_target",
    "stale_runtime",
    "unauthorized_edit",
    "unknown_edit",
    "stale_edit",
  ] as const)(
    "keeps disabled-channel Slack %s scoped to its exact source without admitting content",
    async (mutation) => {
      const context = await safeNativeProgressFixture("slack", "97");
      try {
        const callbacks = context.runtime.configurations.get(
          context.endpoint.id,
        )!.callbacks;
        const before = await db
          .select({ id: issueComments.id })
          .from(issueComments)
          .where(eq(issueComments.issueId, context.conversation.issueId));
        const wakeCount = context.wakeup.mock.calls.length;
        await context.service.replaceResources(context.endpoint.id, [
          { id: context.conversation.resourceId!, enabled: false },
        ]);
        if (mutation === "stale_runtime" || mutation === "stale_edit")
          await db
            .update(chatEndpoints)
            .set({
              setup: sql`jsonb_set(${chatEndpoints.setup}, '{runtimeGeneration}', to_jsonb(coalesce((${chatEndpoints.setup}->>'runtimeGeneration')::int, 0) + 1))`,
            })
            .where(eq(chatEndpoints.id, context.endpoint.id));
        if (mutation === "unauthorized_edit")
          await db
            .update(chatEndpoints)
            .set({ allowUnlinkedPeople: false })
            .where(eq(chatEndpoints.id, context.endpoint.id));
        if (mutation.endsWith("edit")) {
          const original = makeMessage({
            id:
              mutation === "unknown_edit"
                ? "unknown-message"
                : context.messageId,
            text: "@maya original",
            userId: "U-SAFE-PROGRESS",
          });
          await callbacks.onMessageUpdated!({
            endpointId: context.endpoint.id,
            provider: "slack",
            thread: context.thread.thread,
            message: {
              ...original,
              text: "PRIVATE_DISABLED_EDIT_MUST_NOT_PERSIST",
            } as Message,
            previousMessage: original,
          });
        } else {
          await callbacks.onMessageDeleted!({
            endpointId: context.endpoint.id,
            provider: "slack",
            event: {
              adapter: {} as never,
              channelId: context.thread.thread.channelId,
              deletedAt: new Date(),
              messageId:
                mutation === "unknown_target"
                  ? "unknown-message"
                  : context.messageId,
              platform: "slack",
              raw: {},
              threadId: context.thread.thread.id,
            },
          });
        }
        const lifecycle = await db
          .select()
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, context.endpoint.id),
              inArray(chatDeliveries.eventKind, [
                "message_updated",
                "message_deleted",
              ]),
            ),
          );
        expect(lifecycle).toHaveLength(
          mutation === "stale_runtime" || mutation === "stale_edit" ? 0 : 1,
        );
        if (mutation === "unauthorized_edit") {
          // Revoking the exact old source is not permission to admit the edit.
          expect(lifecycle[0]).toMatchObject({
            state: "processed",
            conversationId: context.conversation.id,
            normalizedEvent: { filtering: { contentRetained: false } },
          });
        } else {
          expect(lifecycle.some((row) => row.state === "processed")).toBe(
            false,
          );
          expect(lifecycle.every((row) => row.conversationId === null)).toBe(
            true,
          );
        }
        if (mutation === "unknown_edit") {
          // An unresolved source retains the existing bounded orphan-grace
          // receipt, but never becomes an authorized invalidation or task input.
          expect(lifecycle[0]).toMatchObject({
            state: "retry",
            redactedError: "Waiting briefly for the original message",
          });
        } else {
          expect(JSON.stringify(lifecycle)).not.toContain(
            "PRIVATE_DISABLED_EDIT_MUST_NOT_PERSIST",
          );
        }
        await expect(
          db
            .select({ id: issueComments.id })
            .from(issueComments)
            .where(eq(issueComments.issueId, context.conversation.issueId)),
        ).resolves.toEqual(before);
        expect(context.wakeup.mock.calls.length).toBe(wakeCount);
      } finally {
        await db
          .update(chatConversations)
          .set({ state: "completed" })
          .where(
            and(
              eq(chatConversations.companyId, context.fixture.companyId),
              eq(chatConversations.id, context.conversation.id),
            ),
          );
        await retirePublicationFixture(context.service, context.endpoint.id);
      }
    },
  );

  it.each([
    "different_user",
    "bot_editor",
    "invalid_signature",
    "wrong_thread",
    "unknown_message",
  ] as const)(
    "invalidates only an exact provider-verified GitHub source edit independently of editor admission: %s",
    async (mode) => {
      const context = await failedChatRetryFixture("github", "42");
      try {
        const configuration = context.runtime.configurations.get(
          context.endpoint.id,
        )!;
        if (configuration.providerConfig.provider !== "github")
          throw new Error("Expected GitHub configuration");
        const webhookSecret =
          configuration.providerConfig.credentials.webhookSecret;
        const input = {
          companyId: context.fixture.companyId,
          issueId: context.issue.id,
          agentId: context.fixture.assignedAgentId,
          failedRunId: context.runId,
          initiatedByUserId: "owner-user",
        };
        const rollbackProbe = new Error(
          "rollback unchanged-source retry probe",
        );
        const expectRetryEligible = async () => {
          await expect(
            db.transaction(async (tx) => {
              await expect(
                context.service.prepareFailedChatRunRetry(tx, input),
              ).resolves.toMatchObject({ issueId: context.issue.id });
              throw rollbackProbe;
            }),
          ).rejects.toBe(rollbackProbe);
        };
        await expectRetryEligible();
        const beforeComments = await db
          .select({ id: issueComments.id })
          .from(issueComments)
          .where(eq(issueComments.issueId, context.issue.id));
        const beforeWakes = context.wakeup.mock.calls.length;
        const beforePosts = context.providerRuntime.posts.length;
        const providerSentAt = new Date().toISOString();
        const deliveryId = `lifecycle-editor-${mode}-${randomUUID()}`;
        const signed = signedGitHubWebhookRequest({
          delivery: deliveryId,
          event: "issue_comment",
          webhookSecret,
          payload: {
            action: "edited",
            installation: { id: 2468 },
            repository: {
              id: 97531,
              full_name: "paperclipai/paperclip",
              name: "paperclip",
              owner: { id: 1357, login: "paperclipai" },
            },
            issue: { number: mode === "wrong_thread" ? 792 : 791 },
            comment: {
              id: mode === "unknown_message" ? "990099" : context.messageId,
              body: "PRIVATE_UNADMITTED_EDITOR_CONTENT",
              updated_at: providerSentAt,
              user: { id: 42, login: "original-author", type: "User" },
            },
            sender: {
              id: 77,
              login: "different-editor",
              type: mode === "bot_editor" ? "Bot" : "User",
            },
          },
        });
        if (mode === "invalid_signature")
          signed.headers.set("x-hub-signature-256", "sha256=invalid");
        const response = await context.service.handleWebhook(
          context.endpoint.publicId,
          "github",
          signed,
        );
        expect(response.status).toBe(mode === "invalid_signature" ? 401 : 202);
        if (response.ok) {
          const [ingress] = await db
            .select({ id: chatActions.id })
            .from(chatActions)
            .where(
              and(
                eq(chatActions.endpointId, context.endpoint.id),
                eq(chatActions.kind, "github_webhook_ingress"),
                eq(
                  chatActions.providerActionId,
                  `github_webhook_ingress:${deliveryId}`,
                ),
              ),
            );
          expect(ingress).toBeDefined();
          // Exercise this verified ingress only. A global delivery sweep can
          // legitimately wake an unrelated earlier fixture's deferred task.
          await context.service.processPendingGitHubWebhookIngress(
            1,
            ingress!.id,
          );
        }
        const verifiedSourceChange =
          mode === "different_user" || mode === "bot_editor";
        if (verifiedSourceChange) {
          await expect(
            db.transaction((tx) =>
              context.service.prepareFailedChatRunRetry(tx, input),
            ),
          ).rejects.toMatchObject({
            details: { code: "chat_failed_run_retry_not_authorized" },
          });
        } else {
          await expectRetryEligible();
        }
        const deliveries = await db
          .select()
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, context.endpoint.id),
              eq(chatDeliveries.eventKind, "message_updated"),
            ),
          );
        expect(deliveries).toHaveLength(mode === "invalid_signature" ? 0 : 1);
        if (verifiedSourceChange) {
          expect(deliveries[0]).toMatchObject({
            state: "processed",
            conversationId: context.conversation.id,
            principalId: null,
            normalizedEvent: {
              filtering: { contentRetained: false },
              message: { providerSentAt },
            },
          });
          expect(JSON.stringify(deliveries[0].normalizedEvent)).not.toContain(
            "PRIVATE_UNADMITTED_EDITOR_CONTENT",
          );
          expect(deliveries[0].normalizedEvent.message).not.toHaveProperty(
            "text",
          );
        } else {
          expect(
            deliveries.every(
              (row) => row.state !== "processed" && row.conversationId === null,
            ),
          ).toBe(true);
        }
        await expect(
          db
            .select({ id: issueComments.id })
            .from(issueComments)
            .where(eq(issueComments.issueId, context.issue.id)),
        ).resolves.toEqual(beforeComments);
        expect(context.wakeup.mock.calls.length).toBe(beforeWakes);
        expect(context.providerRuntime.posts.length).toBe(beforePosts);
      } finally {
        await db
          .update(chatConversations)
          .set({ state: "completed" })
          .where(
            and(
              eq(chatConversations.companyId, context.fixture.companyId),
              eq(chatConversations.id, context.conversation.id),
            ),
          );
        await retirePublicationFixture(context.service, context.endpoint.id);
      }
    },
  );

  it("deduplicates Slack file-only revisions by consumed metadata without retaining private locators", async () => {
    const context = await safeNativeProgressFixture("slack", "98");
    try {
      const callbacks = context.runtime.configurations.get(
        context.endpoint.id,
      )!.callbacks;
      await context.service.replaceResources(context.endpoint.id, [
        { id: context.conversation.resourceId!, enabled: false },
      ]);
      const providerSentAt = new Date();
      const original = makeMessage({
        id: context.messageId,
        text: "Unchanged caption",
        userId: "U-SAFE-PROGRESS",
      });
      const file = (id: string) => ({
        id,
        name: "source.png",
        mimetype: "image/png",
        size: 10,
        original_w: 1,
        original_h: 1,
        url_private: "https://files.slack.com/PRIVATE_LOCATOR_ONE",
      });
      const revisions = [
        [file("F-FIRST")],
        [file("F-SECOND")],
        [
          {
            ...file("F-SECOND"),
            url_private: "https://files.slack.com/PRIVATE_LOCATOR_TWO",
            title: "unused title",
          },
        ],
        [],
        [],
      ];
      const beforeComments = await db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(eq(issueComments.issueId, context.conversation.issueId));
      const beforeWakes = context.wakeup.mock.calls.length;
      for (const files of revisions) {
        await callbacks.onMessageUpdated!({
          endpointId: context.endpoint.id,
          provider: "slack",
          thread: context.thread.thread,
          previousMessage: original,
          message: {
            ...original,
            metadata: {
              ...original.metadata,
              edited: true,
              editedAt: providerSentAt,
            },
            raw: { files },
          } as Message,
        });
      }
      const deliveries = await db
        .select()
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, context.endpoint.id),
            eq(chatDeliveries.eventKind, "message_updated"),
          ),
        );
      expect(deliveries).toHaveLength(3);
      expect(new Set(deliveries.map((row) => row.providerEventId)).size).toBe(
        3,
      );
      expect(
        deliveries.every(
          (row) =>
            row.state === "processed" &&
            row.conversationId === context.conversation.id,
        ),
      ).toBe(true);
      expect(
        JSON.stringify(deliveries.map((row) => row.normalizedEvent)),
      ).not.toContain("PRIVATE_LOCATOR");
      expect(
        deliveries.every(
          (row) => !Object.hasOwn(row.normalizedEvent.message!, "text"),
        ),
      ).toBe(true);
      await expect(
        db
          .select({ id: issueComments.id })
          .from(issueComments)
          .where(eq(issueComments.issueId, context.conversation.issueId)),
      ).resolves.toEqual(beforeComments);
      expect(context.wakeup.mock.calls.length).toBe(beforeWakes);
    } finally {
      await db
        .update(chatConversations)
        .set({ state: "completed" })
        .where(
          and(
            eq(chatConversations.companyId, context.fixture.companyId),
            eq(chatConversations.id, context.conversation.id),
          ),
        );
      await retirePublicationFixture(context.service, context.endpoint.id);
    }
  });
});
