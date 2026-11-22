import {
  createHash,
  randomUUID,
} from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
} from "drizzle-orm";
import {
  expect,
  it,
  vi,
} from "vitest";
import {
  agentWakeupRequests,
  assets,
  chatActions,
  chatConversations,
  chatDeliveries,
  chatEndpointResources,
  chatEndpoints,
  chatExternalPrincipals,
  chatMessageLinks,
  heartbeatRuns,
  issueAttachments,
  issueComments,
  projects,
} from "@paperclipai/db";
import {
  createChatSdkEndpointRuntime,
} from "../../services/chat-sdk-runtime.js";
import {
  MAX_ATTACHMENT_BYTES,
  formatAttachmentSize,
} from "../../attachment-types.js";
import {
  TELEGRAM_VIDEO_NOTE_MP4,
} from ".././fixtures/telegram-video-note.js";
import {
  FakeChatSdkRuntime,
  fakeTelegramFetch,
  makeMessage,
  makeThread,
} from ".././helpers/chat-channels-fixture.js";
import {
  chatWakeContext,
  configuredTelegramEndpoint,
  createService,
  createStorageService,
  db,
  deliverMessage,
  describeChatChannelsSuite,
  qualifySetupRoundTrip,
  readChatConversationsByEndpointId,
  readChatDeliveriesByEndpointId,
  readIssueCommentsByIssueId,
  readIssuesById,
  retirePublicationFixture,
  seedCompany,
  signedGitHubWebhookRequest,
  configuredGitHubEndpoint,
} from "../helpers/chat-channels-harness.js";
import type { Attachment, Message } from "chat";

describeChatChannelsSuite("chat channels 41-cases", () => {
  it.each([
    "author_bot",
    "sender_bot",
    "outbound_link",
    "outbound_review_link",
    "wrong_thread_link",
    "human_orphan",
    "body_claims_bot",
  ] as const)(
    "settles GitHub self-update receipts without orphan retries for %s",
    async (mode) => {
      const fixture = await seedCompany();
      const { callbacks, endpoint, service, wakeup, webhookSecret } =
        await configuredGitHubEndpoint(fixture);
      // Recover only this fixture's ingress and delivery. A global sweep can
      // drain unrelated fixtures' retries and exceed the test's time budget.
      const processFixtureDelivery = async () => {
        const [ingress] = await db
          .select({ id: chatActions.id })
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, endpoint.id),
              eq(chatActions.kind, "github_webhook_ingress"),
              eq(
                chatActions.providerActionId,
                "github_webhook_ingress:bot-update-exact",
              ),
            ),
          );
        expect(ingress).toBeDefined();
        await service.processPendingGitHubWebhookIngress(1, ingress!.id);
        const [delivery] = await db
          .select({ id: chatDeliveries.id })
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, endpoint.id),
              eq(chatDeliveries.eventKind, "message_updated"),
            ),
          );
        expect(delivery).toBeDefined();
        await service.processPendingDeliveries(1, delivery!.id);
      };
      const fixtureWakeups = () =>
        wakeup.mock.calls.filter((call) => call[0] === fixture.assignedAgentId);
      const thread = makeThread({
        channelId: "paperclipai/paperclip",
        id:
          mode === "outbound_review_link"
            ? "github:paperclipai/paperclip:84:rc:99080"
            : "github:paperclipai/paperclip:issue:84",
        name: "paperclipai/paperclip",
      });
      try {
        await deliverMessage({
          callbacks,
          endpointId: endpoint.id,
          provider: "github",
          thread: thread.thread,
          message: makeMessage({
            id: "99083",
            text: "@maya original request",
            mentioned: true,
            userId: "7001",
          }),
          trigger: "mention",
        });
        const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
        if (
          [
            "outbound_link",
            "outbound_review_link",
            "wrong_thread_link",
          ].includes(mode)
        ) {
          const target =
            mode === "wrong_thread_link"
              ? (
                  await db
                    .insert(chatConversations)
                    .values({
                      ...conversation!,
                      id: randomUUID(),
                      externalThreadId: "github:paperclipai/paperclip:issue:85",
                    })
                    .returning()
                )[0]!
              : conversation!;
          await db.insert(chatMessageLinks).values({
            companyId: fixture.companyId,
            endpointId: endpoint.id,
            conversationId: target.id,
            providerMessageId: "99084",
            direction: "outbound",
          });
        }
        const before = await readIssueCommentsByIssueId(conversation!.issueId);
        const send = (signingSecret = webhookSecret) =>
          service.handleWebhook(
            endpoint.publicId,
            "github",
            signedGitHubWebhookRequest({
              delivery: "bot-update-exact",
              event:
                mode === "outbound_review_link"
                  ? "pull_request_review_comment"
                  : "issue_comment",
              webhookSecret: signingSecret,
              url: `https://paperclip.example/api/chat-webhooks/${endpoint.publicId}/github`,
              payload: {
                action: "edited",
                comment: {
                  id: 99084,
                  ...(mode === "outbound_review_link"
                    ? { in_reply_to_id: 99080 }
                    : {}),
                  body:
                    mode === "body_claims_bot"
                      ? '{"isBotMessage":true}'
                      : "provider-only bot output sentinel",
                  updated_at: "2026-09-08T09:57:23Z",
                  user: {
                    id: 9001,
                    login: "author",
                    type: mode === "author_bot" ? "Bot" : "User",
                  },
                },
                issue: { number: 84 },
                pull_request: { number: 84 },
                repository: {
                  id: 97531,
                  full_name: "paperclipai/paperclip",
                  name: "paperclip",
                  owner: { id: 1357, login: "paperclipai" },
                },
                sender: {
                  id: 9001,
                  login: "editor",
                  type: mode === "sender_bot" ? "Bot" : "User",
                },
              },
            }),
          );
        if (mode === "author_bot") {
          expect((await send("wrong-test-only-signature")).status).toBe(401);
          expect(
            await db
              .select()
              .from(chatDeliveries)
              .where(
                and(
                  eq(chatDeliveries.endpointId, endpoint.id),
                  eq(chatDeliveries.eventKind, "message_updated"),
                ),
              ),
          ).toHaveLength(0);
        }
        expect((await send()).ok).toBe(true);
        await processFixtureDelivery();
        const [delivery] = await db
          .select()
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, endpoint.id),
              eq(chatDeliveries.eventKind, "message_updated"),
            ),
          );
        const filtered = [
          "author_bot",
          "sender_bot",
          "outbound_link",
          "outbound_review_link",
        ].includes(mode);
        expect(delivery).toMatchObject({
          state: filtered ? "filtered" : "retry",
          attempts: 1,
          principalId: null,
        });
        expect(delivery!.nextAttemptAt === null).toBe(filtered);
        expect(fixtureWakeups()).toHaveLength(1);
        expect(
          await readIssueCommentsByIssueId(conversation!.issueId),
        ).toEqual(before);
        if (filtered) {
          expect(JSON.stringify(delivery!.normalizedEvent)).not.toContain(
            "provider-only bot output sentinel",
          );
          expect(delivery!.normalizedEvent).toMatchObject({
            filtering: { contentRetained: false },
          });
          expect((await send()).ok).toBe(true);
          await processFixtureDelivery();
          expect(
            await db
              .select()
              .from(chatDeliveries)
              .where(
                and(
                  eq(chatDeliveries.endpointId, endpoint.id),
                  eq(chatDeliveries.eventKind, "message_updated"),
                ),
              ),
          ).toEqual([delivery]);
          expect(fixtureWakeups()).toHaveLength(1);
          await deliverMessage({
            callbacks,
            endpointId: endpoint.id,
            provider: "github",
            thread: thread.thread,
            message: makeMessage({
              id: "99085",
              text: "Follow-up after bot edit",
              userId: "7001",
            }),
            trigger: "subscribed_message",
          });
          expect(fixtureWakeups()).toHaveLength(2);
        }
      } finally {
        await service.shutdown();
      }
    },
  );

  it.each([false, true])("orders reversed GitHub edit and delete callbacks behind their durable root (root processed before replay: %s)", async (rootProcessedFirst) => {
    const fixture = await seedCompany();
    const deferred: Array<() => void | Promise<void>> = [];
    const { callbacks, endpoint, service, wakeup, webhookSecret } =
      await configuredGitHubEndpoint(fixture, {
        deferWebhookProcessing: true,
        scheduleDeferredWork: (task) => deferred.push(task),
      });
    const drainDeferred = async () => {
      let processed = 0;
      while (deferred.length > 0) {
        if (processed++ >= 20)
          throw new Error("GitHub deferred test work did not quiesce");
        await deferred.shift()?.();
      }
    };
    const thread = makeThread({
      channelId: "paperclipai/chat-lifecycle-order",
      id: "github:paperclipai/chat-lifecycle-order:issue:84",
      name: "paperclipai/chat-lifecycle-order",
    });
    await db.insert(chatEndpointResources).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      type: "repository",
      providerResourceId: "paperclipai/chat-lifecycle-order",
      label: "paperclipai/chat-lifecycle-order",
      availability: "available",
      enabled: true,
    });
    const original = {
      ...makeMessage({
        id: "99084",
        text: "@maya original ordered GitHub request",
        mentioned: true,
        userId: "7001",
      }),
      metadata: {
        dateSent: new Date("2026-09-05T11:59:59Z"),
        edited: false,
      },
    } as Message;
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "github",
      thread: thread.thread,
      message: original,
      trigger: "mention",
    });

    const sendLifecycle = (
      action: "edited" | "deleted",
      body: string,
      deliverySuffix: string = action,
      updatedAt = "2026-09-05T12:00:00Z",
    ) =>
      service.handleWebhook(
        endpoint.publicId,
        "github",
        signedGitHubWebhookRequest({
          delivery: `delivery-84-${deliverySuffix}`,
          event: "issue_comment",
          payload: {
            action,
            comment: {
              id: 99084,
              body,
              updated_at: updatedAt,
            },
            issue: { number: 84 },
            repository: {
              id: 98400,
              full_name: "paperclipai/chat-lifecycle-order",
              name: "chat-lifecycle-order",
              owner: { id: 1357, login: "paperclipai" },
            },
            sender: { id: 7001, login: "alex-e2e" },
          },
          webhookSecret,
          url: `https://paperclip.example/api/chat-webhooks/${endpoint.publicId}/github`,
        }),
      );

    // GitHub may deliver these as independent requests in the opposite order.
    await expect(
      sendLifecycle("deleted", "deleted payload"),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      sendLifecycle("edited", "@maya corrected ordered GitHub request"),
    ).resolves.toMatchObject({
      ok: true,
    });
    // An exact GitHub redelivery id must remain a single durable transition.
    await expect(
      sendLifecycle("edited", "@maya corrected ordered GitHub request"),
    ).resolves.toMatchObject({
      ok: true,
    });

    // One root-conversation drain plus one durable-ingress callback per HTTP
    // request is queued. The duplicate delivery callback becomes a no-op.
    expect(deferred).toHaveLength(4);
    if (rootProcessedFirst) {
      await deferred.shift()?.();
      await vi.waitFor(async () => {
        const [root] = await db
          .select({ state: chatDeliveries.state })
          .from(chatDeliveries)
          .where(eq(chatDeliveries.endpointId, endpoint.id));
        expect(root.state).toBe("processed");
      });
    }
    await drainDeferred();
    // The scheduler callbacks start background promises. Wait for durable
    // replay admission before draining the conversation work it schedules.
    await vi.waitFor(async () => {
      const deliveries = await db
        .select({ id: chatDeliveries.id })
        .from(chatDeliveries)
        .where(eq(chatDeliveries.endpointId, endpoint.id));
      expect(deliveries).toHaveLength(3);
    });
    await vi.waitFor(async () => {
      await drainDeferred();
      const deliveries = await db
        .select({
          eventKind: chatDeliveries.eventKind,
          state: chatDeliveries.state,
        })
        .from(chatDeliveries)
        .where(eq(chatDeliveries.endpointId, endpoint.id));
      expect(deliveries).toHaveLength(3);
      expect(
        deliveries.every((delivery) => delivery.state === "processed"),
      ).toBe(true);
    });

    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, conversation.issueId))
      .orderBy(asc(issueComments.createdAt), asc(issueComments.id));
    expect(comments.map((comment) => comment.body)).toEqual([
      "@maya original ordered GitHub request",
      "An external message was edited:\n\n@maya corrected ordered GitHub request",
      "An external message in this conversation was deleted.",
    ]);
    expect(wakeup).toHaveBeenCalledTimes(1);

    await expect(
      sendLifecycle(
        "edited",
        "@maya a delayed edit must not resurrect this message",
        "edited-after-delete",
        "2026-09-05T12:01:00Z",
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(deferred).toHaveLength(1);
    await drainDeferred();
    // Awaiting each callback also drains the lifecycle work it queues.
    expect(deferred).toHaveLength(0);
    await vi.waitFor(async () => {
      await expect(
        db
          .select({
            eventKind: chatDeliveries.eventKind,
            redactedError: chatDeliveries.redactedError,
            state: chatDeliveries.state,
          })
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, endpoint.id),
              eq(chatDeliveries.eventKind, "message_updated"),
              eq(chatDeliveries.state, "filtered"),
            ),
          ),
      ).resolves.toEqual([
        {
          eventKind: "message_updated",
          redactedError:
            "Message edit arrived after the provider message was deleted",
          state: "filtered",
        },
      ]);
    });
    await expect(
      db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, conversation.issueId)),
    ).resolves.toHaveLength(3);
    expect(wakeup).toHaveBeenCalledTimes(1);
    await service.shutdown();
  });

  it("supplements Chat SDK with verified GitHub comment edit and delete lifecycle events", async () => {
    const fixture = await seedCompany();
    const { service, wakeup, endpoint, webhookSecret, callbacks } =
      await configuredGitHubEndpoint(fixture);
    const thread = makeThread({
      channelId: "paperclipai/paperclip",
      id: "github:paperclipai/paperclip:issue:42",
      name: "paperclipai/paperclip",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "github",
      thread: thread.thread,
      message: makeMessage({
        id: "77001",
        text: "@maya original GitHub request",
        mentioned: true,
        userId: "7001",
      }),
      trigger: "mention",
    });
    for (const item of [
      {
        id: "github:paperclipai/paperclip:43",
        messageId: "77002",
      },
      {
        id: "github:paperclipai/paperclip:43:rc:88001",
        messageId: "88001",
      },
    ]) {
      const nativeThread = makeThread({
        channelId: "paperclipai/paperclip",
        id: item.id,
        name: "paperclipai/paperclip",
      });
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider: "github",
        thread: nativeThread.thread,
        message: makeMessage({
          id: item.messageId,
          text: "@maya original GitHub PR request",
          mentioned: true,
          userId: "7001",
        }),
        trigger: "mention",
      });
    }

    await qualifySetupRoundTrip(service, endpoint.id, "7001");
    await service.test(endpoint.id);

    const sendLifecycle = async (input: {
      action: "edited" | "deleted";
      event: "issue_comment" | "pull_request_review_comment";
      messageId: number;
      number: number;
      updatedAt: string;
      body?: string;
      inReplyToId?: number;
      issueIsPullRequest?: boolean;
    }) => {
      const response = await service.handleWebhook(
        endpoint.publicId,
        "github",
        signedGitHubWebhookRequest({
          delivery: `github-comment-${input.event}-${input.messageId}-${input.action}-${input.updatedAt}-${createHash(
            "sha256",
          )
            .update(input.body ?? "@maya corrected GitHub request")
            .digest("hex")
            .slice(0, 12)}`,
          event: input.event,
          payload: {
            action: input.action,
            comment: {
              id: input.messageId,
              in_reply_to_id: input.inReplyToId,
              body: input.body ?? "@maya corrected GitHub request",
              updated_at: input.updatedAt,
            },
            issue: {
              number: input.number,
              pull_request: input.issueIsPullRequest ? {} : undefined,
            },
            pull_request: { number: input.number },
            repository: {
              id: 97531,
              full_name: "paperclipai/paperclip",
              name: "paperclip",
              owner: { id: 1357, login: "paperclipai" },
            },
            sender: { id: 7001, login: "alex-e2e" },
          },
          webhookSecret,
          url: `https://paperclip.example/api/chat-webhooks/${endpoint.publicId}/github`,
        }),
      );
      expect(response.status).toBeLessThan(300);
    };

    for (const input of [
      {
        event: "issue_comment" as const,
        messageId: 77001,
        number: 42,
      },
      {
        event: "issue_comment" as const,
        issueIsPullRequest: true,
        messageId: 77002,
        number: 43,
      },
      {
        event: "pull_request_review_comment" as const,
        inReplyToId: 88001,
        messageId: 88001,
        number: 43,
      },
    ].entries()) {
      const [index, event] = input;
      await sendLifecycle({
        ...event,
        action: "edited",
        updatedAt: `2026-09-05T12:0${index}:00Z`,
      });
      await sendLifecycle({
        ...event,
        action: "deleted",
        updatedAt: `2026-09-05T12:1${index}:00Z`,
      });
    }
    const sameSecondEdit = {
      action: "edited" as const,
      body: "@maya corrected GitHub request again in the same second",
      event: "issue_comment" as const,
      messageId: 77001,
      number: 42,
      updatedAt: "2026-09-05T12:00:00Z",
    };
    await sendLifecycle(sameSecondEdit);
    await sendLifecycle(sameSecondEdit);
    await vi.waitFor(async () => {
      const lifecycle = await readChatDeliveriesByEndpointId(endpoint.id);
      expect(
        lifecycle.filter((row) =>
          ["message_updated", "message_deleted"].includes(row.eventKind),
        ),
      ).toHaveLength(7);
      expect(
        lifecycle.filter(
          (row) =>
            row.eventKind === "message_updated" &&
            row.providerEventId.includes("-77001-"),
        ),
      ).toHaveLength(2);
    });
    expect(wakeup).toHaveBeenCalledTimes(4);
    await service.shutdown();
  });

  it("retains content-free GitHub source invalidation after actor revocation and denies stale retry after regrant", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, webhookSecret, wakeup, runtime } =
      await configuredGitHubEndpoint(fixture);
    try {
      const thread = makeThread({
        channelId: "paperclipai/paperclip",
        id: "github:paperclipai/paperclip:issue:91",
        name: "paperclipai/paperclip",
      });
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider: "github",
        thread: thread.thread,
        message: makeMessage({
          id: "99101",
          text: "@maya establish a GitHub task before access changes",
          mentioned: true,
          userId: "7001",
        }),
        trigger: "mention",
      });
      await qualifySetupRoundTrip(service, endpoint.id, "7001");
      await service.test(endpoint.id);
      // The retry source must be the newest admitted request, not the older
      // root preceding the setup qualification's follow-up.
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider: "github",
        thread: thread.thread,
        message: makeMessage({
          id: "99102",
          text: "The exact request that fails before actor access changes",
          userId: "7001",
        }),
        trigger: "subscribed_message",
      });
      const [originalAction] = await db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(chatActions.kind, "inbound_wakeup"),
          ),
        )
        .orderBy(desc(chatActions.createdAt))
        .limit(1);
      expect(originalAction).toBeDefined();
      const [conversation] = await service.listConversations(endpoint.id);
      if (!conversation) throw new Error("Expected GitHub conversation");
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        status: "failed",
        errorCode: "adapter_failed",
        finishedAt: new Date(),
        wakeupRequestId: originalAction!.id,
        contextSnapshot: {
          ...(await chatWakeContext({
            endpointId: endpoint.id,
            issueId: conversation.issueId,
            provider: "github",
            providerMessageId: "99102",
          })),
          taskKey: conversation.issueId,
        },
      });
      await db
        .update(agentWakeupRequests)
        .set({ status: "failed", runId })
        .where(eq(agentWakeupRequests.id, originalAction!.id));
      const retryInput = {
        companyId: fixture.companyId,
        issueId: conversation.issueId,
        agentId: fixture.assignedAgentId,
        failedRunId: runId,
        initiatedByUserId: "owner-user",
      };
      const rollbackProbe = new Error("rollback authorized GitHub retry probe");
      await expect(
        db.transaction(async (tx) => {
          await expect(
            service.prepareFailedChatRunRetry(tx, retryInput),
          ).resolves.toMatchObject({ issueId: conversation.issueId });
          throw rollbackProbe;
        }),
      ).rejects.toBe(rollbackProbe);
      const commentCount = await db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(eq(issueComments.issueId, conversation.issueId))
        .then((rows) => rows.length);
      await service.update(
        endpoint.id,
        { allowUnlinkedPeople: false },
        "owner-user",
      );
      const wakeCount = wakeup.mock.calls.length;
      const providerRuntime = runtime.endpoints.get(endpoint.id)!;
      const postCount = providerRuntime.posts.length;
      const reactionCount = providerRuntime.reactions.length;

      const revokedEdit = "@maya do not retain this revoked GitHub edit";
      const response = await service.handleWebhook(
        endpoint.publicId,
        "github",
        signedGitHubWebhookRequest({
          delivery: "github-revoked-edit-99102",
          event: "issue_comment",
          payload: {
            action: "edited",
            comment: {
              id: 99102,
              body: revokedEdit,
              updated_at: "2026-09-05T12:20:00Z",
            },
            issue: { number: 91 },
            repository: {
              id: 97531,
              full_name: "paperclipai/paperclip",
              name: "paperclip",
              owner: { id: 1357, login: "paperclipai" },
            },
            sender: { id: 7001, login: "alex-e2e" },
          },
          webhookSecret,
        }),
      );
      expect(response.ok).toBe(true);

      await expect(
        db
          .select({ id: issueComments.id })
          .from(issueComments)
          .where(eq(issueComments.issueId, conversation.issueId)),
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
        conversationId: conversation.id,
        redactedError:
          "Provider edit invalidation retained without admitting content from an unauthorized actor",
        normalizedEvent: {
          runtimeContext: {
            generation: expect.any(Number),
            credentialFingerprint: expect.any(String),
          },
          filtering: { contentRetained: false },
          message: {
            providerMessageId: "99102",
            targetProviderEventId: `${thread.thread.id}:99102`,
            providerSentAt: "2026-09-05T12:20:00.000Z",
          },
        },
      });
      expect(JSON.stringify(lifecycle?.normalizedEvent)).not.toContain(
        revokedEdit,
      );
      expect(lifecycle!.normalizedEvent.message).not.toHaveProperty("text");
      await service.update(
        endpoint.id,
        { allowUnlinkedPeople: true },
        "owner-user",
      );
      await expect(
        db.transaction((tx) =>
          service.prepareFailedChatRunRetry(tx, retryInput),
        ),
      ).rejects.toMatchObject({
        details: { code: "chat_failed_run_retry_not_authorized" },
      });
      await expect(
        db
          .select({ id: chatActions.id })
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, endpoint.id),
              eq(chatActions.kind, "failed_run_retry"),
            ),
          ),
      ).resolves.toEqual([]);
      expect(wakeup.mock.calls.length).toBe(wakeCount);
      expect(providerRuntime.posts.length).toBe(postCount);
      expect(providerRuntime.reactions.length).toBe(reactionCount);
    } finally {
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
    }
  });

  it.each([
    ...["unset", "inherit", "clear", "configured"].flatMap((defaultsMode) =>
      [false, true].map((existingDestination) => ({ defaultsMode, existingDestination }))),
  ])("migrates Telegram basic-group reach, topic tasks and $defaultsMode defaults (existing destination: $existingDestination)", async ({ defaultsMode, existingDestination }) => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } =
      await configuredTelegramEndpoint(fixture);
    await db
      .update(chatEndpoints)
      .set({ status: "active" })
      .where(eq(chatEndpoints.id, endpoint.id));
    const [defaultProject, selectedProject] = await db.insert(projects).values([
      { companyId: fixture.companyId, name: "Endpoint default project" },
      { companyId: fixture.companyId, name: "Migrated resource project" },
    ]).returning();
    await service.update(endpoint.id, { executionDefaults: {
      projectId: defaultProject.id, workspace: { kind: "task_directory" },
    } }, "owner-user");
    const executionDefaults = defaultsMode === "unset" ? null
      : defaultsMode === "inherit" ? {}
      : defaultsMode === "clear" ? { projectId: null, workspace: null }
      : { projectId: selectedProject.id, workspace: { kind: "task_directory" as const } };
    const previousChatId = "-5546433913";
    const migratedChatId = "-1004415501660";
    const topicId = 77;
    const [previousResource] = await db
      .insert(chatEndpointResources)
      .values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        type: "chat",
        providerResourceId: previousChatId,
        label: "Telegram migration group",
        availability: "available",
        enabled: true,
        executionDefaults,
      })
      .returning();
    if (existingDestination) await db.insert(chatEndpointResources).values({
      companyId: fixture.companyId, endpointId: endpoint.id, type: "chat",
      providerResourceId: migratedChatId, label: "Existing destination", availability: "available",
      executionDefaults: { projectId: selectedProject.id, workspace: null },
    });
    const previousTopic = makeThread({
      channelId: `telegram:${previousChatId}`,
      id: `telegram:${previousChatId}:${topicId}`,
      name: "Telegram migration group",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: previousTopic.thread,
      message: makeMessage({
        id: `${previousChatId}:40`,
        raw: { message_id: 40, message_thread_id: topicId },
        text: "Start before the group migration",
        mentioned: true,
        userId: "telegram-migration-user",
      }),
      trigger: "mention",
    });
    const [beforeMigration] = await service.listConversations(endpoint.id);
    if (!beforeMigration)
      throw new Error("Expected pre-migration Telegram topic task");

    const response = await service.handleWebhook(
      endpoint.publicId,
      "telegram",
      new Request("https://paperclip.example/telegram", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          update_id: 46,
          message: {
            message_id: 41,
            date: 1_788_700_041,
            chat: {
              id: Number(previousChatId),
              type: "group",
              title: "Telegram migration group",
            },
            migrate_to_chat_id: Number(migratedChatId),
          },
        }),
      }),
    );
    expect(response.status).toBe(202);

    const resources = await service.listResources(endpoint.id);
    expect(resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: previousResource!.id,
          providerResourceId: previousChatId,
          availability: "unavailable",
          enabled: false,
          metadata: expect.objectContaining({ migratedTo: migratedChatId }),
        }),
        expect.objectContaining({
          providerResourceId: migratedChatId,
          executionDefaults,
          label: "Telegram migration group",
          availability: "available",
          enabled: true,
          metadata: expect.objectContaining({ migratedFrom: previousChatId }),
        }),
      ]),
    );
    const [migratedConversation] = await service.listConversations(endpoint.id);
    expect(migratedConversation).toMatchObject({
      id: beforeMigration.id,
      issueId: beforeMigration.issueId,
      externalConversationId: `telegram:${migratedChatId}`,
      externalThreadId: `telegram:${migratedChatId}:${topicId}`,
      externalLabel: "Telegram migration group",
      state: "active",
    });

    const migratedTopic = makeThread({
      channelId: `telegram:${migratedChatId}`,
      id: `telegram:${migratedChatId}:${topicId}`,
      name: `telegram:${migratedChatId}`,
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: migratedTopic.thread,
      message: makeMessage({
        id: `${migratedChatId}:42`,
        raw: { message_id: 42, message_thread_id: topicId },
        text: "Continue by replying after the group migration",
        mentioned: true,
        userId: "telegram-migration-user",
      }),
      trigger: "subscribed_message",
    });
    await expect(service.listConversations(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        id: beforeMigration.id,
        issueId: beforeMigration.issueId,
        externalThreadId: `telegram:${migratedChatId}:${topicId}`,
      }),
    ]);
    await expect(
      db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, beforeMigration.issueId))
        .orderBy(asc(issueComments.createdAt), asc(issueComments.id)),
    ).resolves.toEqual([
      { body: "Start before the group migration" },
      { body: "Continue by replying after the group migration" },
    ]);
    expect(wakeup).toHaveBeenCalledTimes(2);

    const newTopic = makeThread({ channelId: `telegram:${migratedChatId}`,
      id: `telegram:${migratedChatId}:${topicId + 1}`, name: "New migrated topic" });
    await deliverMessage({ callbacks, endpointId: endpoint.id, provider: "telegram", thread: newTopic.thread,
      message: makeMessage({ id: `${migratedChatId}:43`, raw: { message_id: 43, message_thread_id: topicId + 1 },
        text: "Start a new topic after migration", mentioned: true, userId: "telegram-migration-user" }), trigger: "mention" });
    const newConversation = (await service.listConversations(endpoint.id)).find(row => row.id !== beforeMigration.id);
    expect(newConversation).toBeDefined();
    const [newTask] = await readIssuesById(newConversation!.issueId);
    expect(newTask.projectId).toBe(defaultsMode === "clear" ? null
      : defaultsMode === "configured" ? selectedProject.id : defaultProject.id);
    expect(newTask.workspaceSelection).toEqual(defaultsMode === "clear" ? null
      : { version: 1, selection: { kind: "task_directory" }, source: "channel" });
    expect(wakeup).toHaveBeenCalledTimes(3);
  });

  it("enforces Telegram group reach and privacy-mode addressing before retaining message content", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service, wakeup } =
      await configuredTelegramEndpoint(fixture);
    await db
      .update(chatEndpoints)
      .set({ status: "active" })
      .where(eq(chatEndpoints.id, endpoint.id));

    const chatId = "-10077114455";
    const [resource] = await db
      .insert(chatEndpointResources)
      .values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        type: "chat",
        providerResourceId: chatId,
        label: "Telegram production group",
        availability: "available",
        enabled: false,
      })
      .returning();
    const group = makeThread({
      channelId: chatId,
      id: `telegram:${chatId}`,
      name: "Telegram production group",
    });
    if (!callbacks.onSlashCommand)
      throw new Error("Expected Telegram slash-command callbacks");
    const invokeTaskCommand = async (input: {
      document?: {
        fileId: string;
        fileName: string;
        fileSize: number;
        mimeType: string;
      };
      messageId: number;
      prompt: string;
      threadId?: string;
      topicId?: number;
    }) => {
      await callbacks.onSlashCommand!({
        endpointId: endpoint.id,
        provider: "telegram",
        event: {
          channel: {
            id: input.threadId ?? group.thread.id,
            name: "Telegram production group",
            isDM: false,
          } as never,
          command: "/task@paperclip_test_bot",
          text: input.prompt,
          user: {
            userId: "telegram-group-user",
            userName: "telegram-group-user",
            fullName: "Telegram Group User",
            isBot: false,
            isMe: false,
            isSystem: false,
          },
          raw: {
            message_id: input.messageId,
            ...(input.topicId === undefined
              ? {}
              : { message_thread_id: input.topicId }),
            date: 1_788_700_000 + input.messageId,
            chat: {
              id: Number(chatId),
              type: "supergroup",
              title: "Telegram production group",
            },
            from: { id: 77112233, is_bot: false },
            text: `/task@paperclip_test_bot${input.prompt ? ` ${input.prompt}` : ""}`,
            entities: [
              {
                offset: 0,
                length: "/task@paperclip_test_bot".length,
                type: "bot_command",
              },
            ],
            ...(input.document
              ? {
                  document: {
                    file_id: input.document.fileId,
                    file_unique_id: `${input.document.fileId}-unique`,
                    file_name: input.document.fileName,
                    file_size: input.document.fileSize,
                    mime_type: input.document.mimeType,
                  },
                }
              : {}),
          },
          adapter: {} as never,
          openModal: async () => undefined,
        },
      });
    };

    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: group.thread,
      message: makeMessage({
        id: `${chatId}:10`,
        text: "@maya disabled-group-private-marker",
        mentioned: true,
        userId: "telegram-disabled-user",
      }),
      trigger: "mention",
    });

    const [disabledDelivery] = await readChatDeliveriesByEndpointId(endpoint.id);
    expect(disabledDelivery).toMatchObject({
      state: "filtered",
      attempts: 0,
      principalId: null,
      redactedError: "Destination is not enabled in Paperclip",
      normalizedEvent: {
        filtering: { contentRetained: false },
        message: { providerMessageId: `${chatId}:10` },
      },
    });
    expect(JSON.stringify(disabledDelivery.normalizedEvent)).not.toContain(
      "disabled-group-private-marker",
    );
    expect(JSON.stringify(disabledDelivery.normalizedEvent)).not.toContain(
      "telegram-disabled-user",
    );
    expect(await service.listConversations(endpoint.id)).toEqual([]);
    expect(wakeup).not.toHaveBeenCalled();
    await expect(
      db
        .select({ id: chatExternalPrincipals.id })
        .from(chatExternalPrincipals)
        .where(
          and(
            eq(chatExternalPrincipals.companyId, fixture.companyId),
            eq(chatExternalPrincipals.provider, "telegram"),
          ),
        ),
    ).resolves.toHaveLength(0);

    await service.replaceResources(endpoint.id, [
      { id: resource!.id, enabled: true },
    ]);
    await invokeTaskCommand({ messageId: 11, prompt: "" });
    expect(await service.listConversations(endpoint.id)).toEqual([]);
    expect(wakeup).not.toHaveBeenCalled();
    expect(
      runtime.endpoints.get(endpoint.id)?.posts.map((post) => post.text),
    ).toEqual([
      expect.stringMatching(
        /^Please include a request after \/task@paperclip_\d+_bot\.$/,
      ),
    ]);
    runtime.endpoints.get(endpoint.id)!.posts.length = 0;

    await invokeTaskCommand({
      messageId: 12,
      prompt: "create the enabled group task",
      document: {
        fileId: "telegram-captioned-command-file",
        fileName: "captioned-command.txt",
        fileSize: 41,
        mimeType: "text/plain",
      },
    });
    // Exact provider redelivery of the same command remains one task turn.
    await invokeTaskCommand({
      messageId: 12,
      prompt: "create the enabled group task",
      document: {
        fileId: "telegram-captioned-command-file",
        fileName: "captioned-command.txt",
        fileSize: 41,
        mimeType: "text/plain",
      },
    });
    const [groupConversation] = await service.listConversations(endpoint.id);
    if (!groupConversation)
      throw new Error("Expected enabled Telegram group conversation");
    expect(wakeup).toHaveBeenCalledTimes(1);
    const captionedDelivery = await db
      .select()
      .from(chatDeliveries)
      .where(
        eq(chatDeliveries.providerEventId, `${group.thread.id}:${chatId}:12`),
      )
      .then((rows) => rows[0]);
    expect(captionedDelivery?.normalizedEvent).toMatchObject({
      message: {
        attachments: [
          {
            name: "captioned-command.txt",
            mimeType: "text/plain",
            size: 41,
            recovery: {
              locator: {
                kind: "test_attachment",
                recoveryKey: "telegram-captioned-command-file",
              },
            },
          },
        ],
      },
    });

    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: group.thread,
      message: makeMessage({
        id: `${chatId}:13`,
        text: "unrelated-subscribed-private-marker",
        userId: "telegram-bystander",
      }),
      trigger: "subscribed_message",
    });
    const unaddressedDelivery = await db
      .select()
      .from(chatDeliveries)
      .where(
        eq(chatDeliveries.providerEventId, `${group.thread.id}:${chatId}:13`),
      )
      .then((rows) => rows[0]);
    expect(unaddressedDelivery).toMatchObject({
      state: "filtered",
      attempts: 0,
      principalId: null,
      redactedError: "Message did not address the agent",
      normalizedEvent: { filtering: { contentRetained: false } },
    });
    expect(JSON.stringify(unaddressedDelivery.normalizedEvent)).not.toContain(
      "unrelated-subscribed-private-marker",
    );
    expect(JSON.stringify(unaddressedDelivery.normalizedEvent)).not.toContain(
      "telegram-bystander",
    );
    expect(wakeup).toHaveBeenCalledTimes(1);

    // The pinned Telegram adapter marks a direct reply to the bot as a
    // mention. Simulate that normalized contract on the subscribed path.
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: group.thread,
      message: makeMessage({
        id: `${chatId}:14`,
        text: "continue by replying directly to Maya",
        mentioned: true,
        userId: "telegram-group-user",
      }),
      trigger: "subscribed_message",
    });
    expect(wakeup).toHaveBeenCalledTimes(2);

    const topicId = 91;
    const topic = makeThread({
      channelId: chatId,
      id: `telegram:${chatId}:${topicId}`,
      name: "Telegram production group",
    });
    await invokeTaskCommand({
      messageId: 20,
      prompt: "create a topic-bound task",
      threadId: topic.thread.id,
      topicId,
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: topic.thread,
      message: makeMessage({
        id: `${chatId}:21`,
        raw: { message_id: 21, message_thread_id: topicId },
        text: "unrelated-topic-private-marker",
        userId: "telegram-topic-bystander",
      }),
      trigger: "subscribed_message",
    });

    const conversations = await service.listConversations(endpoint.id);
    expect(conversations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: groupConversation.id,
          issueId: groupConversation.issueId,
        }),
        expect.objectContaining({
          externalThreadId: topic.thread.id,
          sessionGeneration: 1,
        }),
      ]),
    );
    expect(conversations).toHaveLength(2);
    expect(wakeup).toHaveBeenCalledTimes(3);
    await expect(
      db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, groupConversation.issueId))
        .orderBy(asc(issueComments.createdAt), asc(issueComments.id)),
    ).resolves.toEqual([
      { body: "create the enabled group task" },
      { body: "continue by replying directly to Maya" },
    ]);
    const topicConversation = conversations.find(
      (candidate) => candidate.externalThreadId === topic.thread.id,
    )!;
    await expect(
      db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, topicConversation.issueId)),
    ).resolves.toEqual([{ body: "create a topic-bound task" }]);
    await expect(
      db
        .select({ id: chatExternalPrincipals.id })
        .from(chatExternalPrincipals)
        .where(
          and(
            eq(chatExternalPrincipals.companyId, fixture.companyId),
            eq(chatExternalPrincipals.provider, "telegram"),
            inArray(chatExternalPrincipals.externalId, [
              "telegram-bystander",
              "telegram-topic-bystander",
            ]),
          ),
        ),
    ).resolves.toHaveLength(0);
  });

  it.each([
    "current",
    "restart",
    "unknown_document",
    "malformed_note",
    "oversize",
    "revoked_after_receipt",
  ] as const)(
    "ingests a pinned Telegram video-note without optional MIME metadata (%s)",
    async (mode) => {
      const fixture = await seedCompany();
      const storage = createStorageService();
      const deferred = mode === "restart" || mode === "revoked_after_receipt";
      const { callbacks, endpoint, runtime, service, wakeup } =
        await configuredTelegramEndpoint(fixture, {
          storage: storage.storage,
          deferWebhookProcessing: deferred,
          scheduleDeferredWork: () => undefined,
        });
      const configuration = runtime.configurations.get(endpoint.id)!;
      const pinned = createChatSdkEndpointRuntime({
        ...configuration,
        logger: "silent",
      });
      const providerRequests: string[] = [];
      let restarted: ReturnType<typeof createService> | undefined;
      let recoveredParser:
        ReturnType<typeof createChatSdkEndpointRuntime> | undefined;
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (input, init) => {
          const url = new URL(
            input instanceof Request ? input.url : String(input),
          );
          if (url.hostname !== "api.telegram.org")
            throw new Error("Unexpected fixture host");
          if (url.pathname.endsWith("/getFile")) {
            expect(JSON.parse(String(init?.body))).toEqual({
              file_id: "telegram-video-note-fixture",
            });
            providerRequests.push("getFile");
            return Response.json({
              ok: true,
              result: { file_path: "video-notes/fixture.mp4" },
            });
          }
          if (url.pathname.endsWith("/video-notes/fixture.mp4")) {
            providerRequests.push("download");
            return new Response(TELEGRAM_VIDEO_NOTE_MP4, {
              headers: { "content-type": "video/mp4" },
            });
          }
          throw new Error("Unexpected fixture provider method");
        });
      try {
        // Only provider I/O and scheduling are simulated. Parse with the real
        // pinned adapter, then use real durable descriptors and service policy.
        Object.assign(runtime.endpoints.get(endpoint.id)!, {
          attachmentRecoveryDescriptor:
            pinned.attachmentRecoveryDescriptor.bind(pinned),
          rehydrateAttachment: pinned.rehydrateAttachment.bind(pinned),
        });
        const raw = {
          message_id: 41,
          date: Math.floor(Date.now() / 1_000),
          chat: { id: 77115569, type: "private" },
          from: { id: 77115569, is_bot: false, first_name: "Video fixture" },
          video_note: {
            file_id: "telegram-video-note-fixture",
            file_unique_id: "telegram-video-note-unique",
            length: 16,
            duration: 1,
            file_size: TELEGRAM_VIDEO_NOTE_MP4.length,
          },
        };
        if (mode === "malformed_note") raw.video_note.duration = -1;
        if (mode === "oversize")
          raw.video_note.file_size = MAX_ATTACHMENT_BYTES + 1;
        const { video_note: _note, ...withoutNote } = raw;
        const message = pinned.parseTelegramCommandMessage(
          mode === "unknown_document"
            ? {
                ...withoutNote,
                document: {
                  file_id: "unknown-document",
                  file_unique_id: "unknown-document-unique",
                  file_name: "unknown.bin",
                  file_size: TELEGRAM_VIDEO_NOTE_MP4.length,
                },
              }
            : raw,
        )!;
        const dm = makeThread({
          channelId: "77115569",
          id: "telegram:77115569",
          isDM: true,
        });
        await deliverMessage({
          callbacks,
          endpointId: endpoint.id,
          provider: "telegram",
          thread: dm.thread,
          message,
          trigger: "direct_message",
        });
        if (deferred) {
          const [received] = await readChatDeliveriesByEndpointId(endpoint.id);
          expect(received).toMatchObject({ state: "received", attempts: 0 });
          expect(providerRequests).toEqual([]);
          expect(storage.putFile).not.toHaveBeenCalled();
          expect(wakeup).not.toHaveBeenCalled();
          // Stop the original service and throw away all live fetch closures.
          // The replacement parser must reconstruct the exact durable file ID.
          message.attachments[0]!.fetchData = vi.fn(async () => {
            throw new Error("Original live closure must not run after restart");
          });
          await service.shutdown();
          recoveredParser = createChatSdkEndpointRuntime({
            ...configuration,
            logger: "silent",
          });
          const nextRuntime = new FakeChatSdkRuntime();
          const replace = nextRuntime.replaceEndpoint.bind(nextRuntime);
          vi.spyOn(nextRuntime, "replaceEndpoint").mockImplementation(
            async (options) => {
              const next = await replace(options);
              Object.assign(next, {
                attachmentRecoveryDescriptor:
                  recoveredParser!.attachmentRecoveryDescriptor.bind(
                    recoveredParser,
                  ),
                rehydrateAttachment:
                  recoveredParser!.rehydrateAttachment.bind(recoveredParser),
              });
              const thread = next.thread.bind(next);
              vi.spyOn(next, "thread").mockImplementation((threadId) => ({
                ...thread(threadId),
                isDM: recoveredParser!.getProviderAdapter().isDM!(threadId),
              }));
              return next;
            },
          );
          if (mode === "revoked_after_receipt") {
            await db
              .update(chatEndpoints)
              .set({ allowDirectMessages: false, updatedAt: new Date() })
              .where(eq(chatEndpoints.id, endpoint.id));
          }
          await db
            .update(chatDeliveries)
            .set({ nextAttemptAt: new Date(0) })
            .where(eq(chatDeliveries.id, received.id));
          restarted = createService(
            nextRuntime,
            fakeTelegramFetch() as typeof globalThis.fetch,
            { storage: storage.storage, scheduleDeferredWork: () => undefined },
          );
          await restarted.service.processPendingDeliveries(25, received.id);
          expect(message.attachments[0]!.fetchData).not.toHaveBeenCalled();
        }
        if (!["current", "restart"].includes(mode)) {
          expect(storage.putFile).not.toHaveBeenCalled();
          expect(providerRequests).toEqual([]);
          expect(wakeup).not.toHaveBeenCalled();
          expect(restarted?.wakeup.mock.calls.length ?? 0).toBe(0);
          const [denied] = await readChatDeliveriesByEndpointId(endpoint.id);
          if (mode === "revoked_after_receipt")
            expect(denied.state).toBe("filtered");
          else
            expect(denied.redactedError).toContain(
              mode === "oversize" ? "declared too large" : "unsupported type",
            );
          await expect(
            db
              .select({ id: issueAttachments.id })
              .from(issueAttachments)
              .where(eq(issueAttachments.companyId, fixture.companyId)),
          ).resolves.toEqual([]);
          return;
        }
        expect(storage.putFile).toHaveBeenCalledOnce();
        expect(storage.putFile.mock.calls[0]![0]).toMatchObject({
          body: TELEGRAM_VIDEO_NOTE_MP4,
          contentType: "video/mp4",
        });
        expect(providerRequests).toEqual(["getFile", "download"]);
        expect(restarted?.wakeup ?? wakeup).toHaveBeenCalledOnce();
        const [conversation] = await (
          restarted?.service ?? service
        ).listConversations(endpoint.id);
        const [delivery] = await readChatDeliveriesByEndpointId(endpoint.id);
        expect(delivery).toMatchObject({
          state: "processed",
          redactedError: null,
          conversationId: conversation.id,
        });
        expect(delivery.normalizedEvent).toMatchObject({
          message: {
            providerMessageId: "77115569:41",
            attachments: [
              {
                mimeType: "video/mp4",
                recovery: {
                  version: 1,
                  provider: "telegram",
                  attachment: { type: "video", mimeType: "video/mp4" },
                  locator: {
                    kind: "telegram_file_id",
                    fileId: raw.video_note.file_id,
                    fileUniqueId: raw.video_note.file_unique_id,
                  },
                },
              },
            ],
          },
        });
        await expect(
          db
            .select({
              sha256: assets.sha256,
              byteSize: assets.byteSize,
              contentType: assets.contentType,
            })
            .from(issueAttachments)
            .innerJoin(assets, eq(assets.id, issueAttachments.assetId))
            .where(eq(issueAttachments.issueId, conversation.issueId)),
        ).resolves.toEqual([
          {
            sha256: createHash("sha256")
              .update(TELEGRAM_VIDEO_NOTE_MP4)
              .digest("hex"),
            byteSize: TELEGRAM_VIDEO_NOTE_MP4.length,
            contentType: "video/mp4",
          },
        ]);
      } finally {
        try {
          await pinned.shutdown();
        } finally {
          try {
            await recoveredParser?.shutdown();
          } finally {
            try {
              await retirePublicationFixture(service, endpoint.id);
            } finally {
              try {
                await restarted?.service.shutdown();
              } finally {
                fetchSpy.mockRestore();
              }
            }
          }
        }
      }
    },
  );

  it("ingests bounded Telegram photo, audio, video, and document attachments without stranding text", async () => {
    const fixture = await seedCompany();
    const storage = createStorageService();
    const runtime = new FakeChatSdkRuntime();
    const { service, wakeup } = createService(
      runtime,
      fakeTelegramFetch() as typeof globalThis.fetch,
      {
        storage: storage.storage,
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
        credentials: { botToken: "123456:telegram-media-test" },
      },
      "owner-user",
    );
    const callbacks = runtime.configurations.get(endpoint.id)?.callbacks;
    if (!callbacks) throw new Error("Expected Telegram media callbacks");

    const accepted = [
      {
        type: "image",
        name: "photo.jpg",
        mimeType: "image/jpeg",
        body: Buffer.from("photo"),
      },
      {
        type: "audio",
        name: "voice.ogg",
        mimeType: "audio/ogg",
        body: Buffer.from("voice"),
      },
      {
        type: "video",
        name: "clip.mp4",
        mimeType: "video/mp4",
        body: Buffer.from("video"),
      },
      {
        type: "file",
        name: "notes.txt",
        mimeType: "text/plain",
        body: Buffer.from("notes"),
      },
    ] as const;
    const acceptedFetches = accepted.map(({ body }) => vi.fn(async () => body));
    const oversizedDeclaredFetch = vi.fn(async () =>
      Buffer.from("must-not-download"),
    );
    const rejectedTypeFetch = vi.fn(async () =>
      Buffer.from("must-not-download"),
    );
    const oversizedDownloadedFetch = vi.fn(async () =>
      Buffer.alloc(MAX_ATTACHMENT_BYTES + 1),
    );
    const emptyFetch = vi.fn(async () => Buffer.alloc(0));
    const failedDownload = vi.fn(async () => {
      throw new Error("injected Telegram download failure");
    });
    const attachments: Attachment[] = [
      ...accepted.map(
        (item, index) =>
          ({
            type: item.type,
            name: item.name,
            mimeType: item.mimeType,
            size: item.body.length,
            fetchData: acceptedFetches[index],
            fetchMetadata: { testRecoveryKey: `telegram-media-${index}` },
          }) as Attachment,
      ),
      {
        type: "file",
        name: "declared-too-large.txt",
        mimeType: "text/plain",
        size: MAX_ATTACHMENT_BYTES + 1,
        fetchData: oversizedDeclaredFetch,
      },
      {
        type: "file",
        name: "payload.exe",
        mimeType: "application/x-msdownload",
        size: 4,
        fetchData: rejectedTypeFetch,
      },
      {
        type: "file",
        name: "downloaded-too-large.txt",
        mimeType: "text/plain",
        fetchData: oversizedDownloadedFetch,
      },
      {
        type: "file",
        name: "empty.txt",
        mimeType: "text/plain",
        fetchData: emptyFetch,
      },
      {
        type: "file",
        name: "unavailable.txt",
        mimeType: "text/plain",
        fetchData: failedDownload,
      },
    ];
    const dm = makeThread({
      channelId: "77115566",
      id: "telegram:77115566",
      isDM: true,
      name: "Telegram media DM",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: dm.thread,
      message: makeMessage({
        attachments,
        id: "77115566:40",
        text: "",
        userId: "77115566",
      }),
      trigger: "direct_message",
    });

    expect(
      acceptedFetches.every((fetchData) => fetchData.mock.calls.length === 1),
    ).toBe(true);
    expect(oversizedDeclaredFetch).not.toHaveBeenCalled();
    expect(rejectedTypeFetch).not.toHaveBeenCalled();
    expect(oversizedDownloadedFetch).toHaveBeenCalledTimes(1);
    expect(emptyFetch).toHaveBeenCalledTimes(1);
    expect(failedDownload).toHaveBeenCalledTimes(1);
    expect(storage.putFile).toHaveBeenCalledTimes(4);
    const [delivery] = await readChatDeliveriesByEndpointId(endpoint.id);
    expect(delivery).toMatchObject({
      state: "processed",
      attempts: 1,
      redactedError: expect.stringContaining(
        "5 external attachments were omitted",
      ),
    });
    expect(delivery.redactedError).toContain("declared too large: 1");
    expect(delivery.redactedError).toContain("unsupported type: 1");
    expect(delivery.redactedError).toContain("downloaded too large: 1");
    expect(delivery.redactedError).toContain("empty download: 1");
    expect(delivery.redactedError).toContain("processing failed: 1");
    expect(delivery.redactedError).not.toContain("unavailable.txt");
    await expect(service.listActivity(endpoint.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: delivery.id,
          status: "processed",
          detail: expect.stringContaining(
            "5 external attachments were omitted",
          ),
        }),
      ]),
    );
    const [conversation] = await service.listConversations(endpoint.id);
    if (!conversation) throw new Error("Expected Telegram media conversation");
    await expect(
      db
        .select({
          contentType: assets.contentType,
          originalFilename: assets.originalFilename,
        })
        .from(issueAttachments)
        .innerJoin(assets, eq(assets.id, issueAttachments.assetId))
        .where(eq(issueAttachments.issueId, conversation.issueId)),
    ).resolves.toEqual(
      expect.arrayContaining(
        accepted.map((item) => ({
          contentType: item.mimeType,
          originalFilename: item.name,
        })),
      ),
    );
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it("surfaces an attachment-only Telegram ingestion failure without waking the agent", async () => {
    const fixture = await seedCompany();
    const storage = createStorageService();
    const { callbacks, endpoint, service, wakeup } =
      await configuredTelegramEndpoint(fixture, { storage: storage.storage });
    const dm = makeThread({
      channelId: "77115567",
      id: "telegram:77115567",
      isDM: true,
      name: "Telegram failed media DM",
    });
    const failedDownload = vi.fn(async () => {
      throw new Error("injected Telegram attachment outage");
    });
    try {
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider: "telegram",
        thread: dm.thread,
        message: makeMessage({
          attachments: [
            {
              type: "file",
              name: "request.txt",
              mimeType: "text/plain",
              size: 42,
              fetchData: failedDownload,
              fetchMetadata: { testRecoveryKey: "telegram-failed-media" },
            } as Attachment,
          ],
          id: "77115567:41",
          text: "",
          userId: "77115567",
        }),
        trigger: "direct_message",
      });

      expect(failedDownload).toHaveBeenCalledTimes(1);
      expect(storage.putFile).not.toHaveBeenCalled();
      expect(wakeup).not.toHaveBeenCalled();
      const [conversation] = await service.listConversations(endpoint.id);
      if (!conversation)
        throw new Error("Expected Telegram attachment failure conversation");
      const visibleFailure = `Paperclip could not safely import the attached Telegram file. Please resend it as a supported file under ${formatAttachmentSize(MAX_ATTACHMENT_BYTES)} or include text describing the request.`;
      await expect(
        db
          .select({ body: issueComments.body })
          .from(issueComments)
          .where(eq(issueComments.issueId, conversation.issueId)),
      ).resolves.toEqual([{ body: visibleFailure }]);
      const [delivery] = await readChatDeliveriesByEndpointId(endpoint.id);
      expect(delivery).toMatchObject({
        state: "processed",
        redactedError: expect.stringContaining(
          "1 external attachment was omitted",
        ),
      });
      await vi.waitFor(() =>
        expect(dm.post).toHaveBeenCalledWith(visibleFailure),
      );
      await vi.waitFor(async () => {
        await expect(
          db
            .select({ kind: chatActions.kind, status: chatActions.status })
            .from(chatActions)
            .where(eq(chatActions.deliveryId, delivery.id)),
        ).resolves.toEqual(
          expect.arrayContaining([
            { kind: "inbound_wakeup", status: "failed" },
            { kind: "provider_effect", status: "processed" },
          ]),
        );
      });
    } finally {
      await retirePublicationFixture(service, endpoint.id);
    }
  });
});
