import {
  githubChatManagementService,
} from "../../services/chat-github-management.js";
import {
  activityLog,
  agentWakeupRequests,
  chatActions,
  chatConversations,
  chatEndpoints,
  chatExternalPrincipals,
  chatGitHubConfigurations,
  chatMessageLinks,
  chatPublications,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  randomUUID,
} from "node:crypto";
import {
  and,
  asc,
  eq,
  inArray,
  like,
  sql,
} from "drizzle-orm";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  issueService,
} from "../../services/issues.js";
import {
  issueThreadInteractionService,
} from "../../services/issue-thread-interactions.js";
import {
  fakeSlackFetch,
  makeMessage,
  makeThread,
} from ".././helpers/chat-channels-fixture.js";
import {
  addSelectedChatFinal,
  chatWakeContext,
  configuredSlackEndpoint,
  configuredTeamsEndpoint,
  configuredTelegramEndpoint,
  createService,
  db,
  deliverMessage,
  describeChatChannelsSuite,
  qualifySetupRoundTrip,
  readChatConversationsByEndpointId,
  readChatPublicationsByCommentId,
  readChatPublicationsById,
  readChatPublicationsByIdempotencyKey,
  readHeartbeatRunsById,
  retirePublicationFixture,
  seedCompany,
  waitForProcessedReceiptRemoval,
  configuredGitHubEndpoint,
} from "../helpers/chat-channels-harness.js";

describeChatChannelsSuite("chat channels 19-telegram-close-owned-progress-retirement", () => {
  it("keeps task-bound /close active after an ambiguous publication commit until explicit confirmation", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredTelegramEndpoint(fixture);
    if (!callbacks.onSlashCommand) {
      throw new Error("Telegram slash command callback was not registered");
    }
    const chatId = "77118897";
    const thread = makeThread({
      channelId: chatId,
      id: `telegram:${chatId}`,
      isDM: true,
      name: "Telegram close commit crash",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: thread.thread,
      message: makeMessage({
        id: `${chatId}:920`,
        raw: { message_id: 920 },
        text: "Keep this task active until close is visible",
        userId: chatId,
      }),
      trigger: "direct_message",
    });
    await qualifySetupRoundTrip(service, endpoint.id, chatId);
    await service.test(endpoint.id);
    const [conversation] = await service.listConversations(endpoint.id);
    await callbacks.onSlashCommand({
      endpointId: endpoint.id,
      provider: "telegram",
      event: {
        channel: {
          id: thread.thread.id,
          name: "Telegram close commit crash",
          isDM: true,
        } as never,
        command: "/close",
        text: "",
        user: {
          userId: chatId,
          userName: "telegram-close-user",
          fullName: "Telegram Close User",
          isBot: false,
          isMe: false,
          isSystem: false,
        },
        raw: {
          message_id: 921,
          date: 1_788_622_921,
          chat: { id: Number(chatId), type: "private" },
          from: { id: Number(chatId), is_bot: false },
          text: "/close",
          entities: [{ offset: 0, length: 6, type: "bot_command" }],
        },
        adapter: {} as never,
        openModal: async () => undefined,
      },
    });
    const closePublication = await db
      .select()
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.endpointId, endpoint.id),
          like(chatPublications.idempotencyKey, "control:close:%"),
        ),
      )
      .then((rows) => rows[0]);
    expect(closePublication).toMatchObject({ state: "pending" });
    await expect(service.listConversations(endpoint.id)).resolves.toEqual([
      expect.objectContaining({ id: conversation.id, state: "active" }),
    ]);

    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected Telegram runtime");
    const originalTransaction = db.transaction.bind(db);
    let injectedCrash = false;
    const transactionSpy = vi
      .spyOn(db, "transaction")
      .mockImplementation((async (
        ...args: Parameters<typeof originalTransaction>
      ) => {
        if (!injectedCrash && providerRuntime.posts.length === 1) {
          injectedCrash = true;
          throw new Error("injected task-control publication commit crash");
        }
        return originalTransaction(...args);
      }) as typeof db.transaction);
    try {
      await expect(service.processPendingPublications()).resolves.toBe(1);
    } finally {
      transactionSpy.mockRestore();
    }

    expect(injectedCrash).toBe(true);
    expect(providerRuntime.posts.map((post) => post.text)).toEqual([
      "This chat conversation is closed. Send another message to start a new task.",
    ]);
    await expect(service.listConversations(endpoint.id)).resolves.toEqual([
      expect.objectContaining({ id: conversation.id, state: "active" }),
    ]);
    await expect(
      db
        .select({ state: chatPublications.state })
        .from(chatPublications)
        .where(eq(chatPublications.id, closePublication!.id)),
    ).resolves.toEqual([{ state: "delivery_unknown" }]);

    await service.processPendingPublications();
    expect(providerRuntime.posts).toHaveLength(1);
    await service.resolvePublication(
      endpoint.id,
      closePublication!.id,
      "mark_delivered",
      "owner-user",
    );
    await expect(service.listConversations(endpoint.id)).resolves.toEqual([
      expect.objectContaining({ id: conversation.id, state: "completed" }),
    ]);
    expect(providerRuntime.posts).toHaveLength(1);
  });

  describe("Telegram close-owned progress retirement", () => {
    async function closeProgressFixture(
      provider: "telegram" | "slack" | "microsoft-teams" = "telegram",
    ) {
      const fixture = await seedCompany();
      const context =
        provider === "telegram"
          ? await configuredTelegramEndpoint(fixture)
          : provider === "slack"
            ? await configuredSlackEndpoint(fixture)
            : await configuredTeamsEndpoint(fixture);
      const { callbacks, endpoint, runtime, service } = context;
      const chatId =
        provider === "telegram"
          ? "77118896"
          : provider === "slack"
            ? "D09CLOSEPROGRESS"
            : `teams:${Buffer.from("a:close-progress-personal").toString("base64url")}`;
      const userId = provider === "telegram" ? chatId : "U-CLOSE-PROGRESS";
      const sourceMessageId =
        provider === "telegram" ? `${chatId}:930` : "1788969999.000930";
      const thread = makeThread({
        channelId: chatId,
        id:
          provider === "telegram"
            ? `telegram:${chatId}`
            : provider === "slack"
              ? `slack:${chatId}:`
              : chatId,
        isDM: true,
      });
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider,
        thread: thread.thread,
        message: makeMessage({
          id: sourceMessageId,
          raw:
            provider === "telegram"
              ? { message_id: 930 }
              : { ts: sourceMessageId },
          text: "Work until I close this conversation",
          userId,
        }),
        trigger: "direct_message",
      });
      const setupMessageId = await qualifySetupRoundTrip(service, endpoint.id, userId);
      await service.test(endpoint.id);
      if (provider === "telegram") {
        // Setup dispatches receipt cleanup asynchronously. Finish it before
        // measuring reaction removals owned by this fixture's working run.
        await service.processPendingReceiptReactions();
        await waitForProcessedReceiptRemoval(endpoint.id, {
          threadId: thread.thread.id,
          messageId: setupMessageId,
          emoji: "eyes",
        });
      }
      const [conversation] = await service.listConversations(endpoint.id);
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        status: "running",
        contextSnapshot: await chatWakeContext({
          endpointId: endpoint.id,
          issueId: conversation.issueId,
          provider,
          providerMessageId: sourceMessageId,
        }),
      });
      const [progress] = await db
        .insert(chatPublications)
        .values({
          companyId: fixture.companyId,
          endpointId: endpoint.id,
          conversationId: conversation.id,
          issueId: conversation.issueId,
          idempotencyKey: `run:${runId}:working:${endpoint.id}`,
          payload: { text: "Maya is working…", progressState: "working" },
          state: "pending",
        })
        .returning();
      await service.processPendingPublications();
      const providerRuntime = runtime.endpoints.get(endpoint.id)!;
      const closeEvent = {
        endpointId: endpoint.id,
        provider: "telegram" as const,
        event: {
          channel: {
            id: thread.thread.id,
            name: "Telegram close retirement",
            isDM: true,
          } as never,
          command: "/close",
          text: "",
          user: {
            userId: chatId,
            userName: "close-user",
            fullName: "Close User",
            isBot: false,
            isMe: false,
            isSystem: false,
          },
          raw: {
            message_id: 931,
            date: Math.floor(Date.now() / 1000),
            chat: { id: Number(chatId), type: "private" },
            from: { id: Number(chatId), is_bot: false },
            text: "/close",
            entities: [{ offset: 0, length: 6, type: "bot_command" }],
          },
          adapter: {} as never,
          openModal: async () => undefined,
        },
      };
      const stageClose = async () => {
        if (provider === "microsoft-teams")
          await deliverMessage({
            callbacks,
            endpointId: endpoint.id,
            provider,
            thread: thread.thread,
            message: makeMessage({
              id: "teams-close-progress-control",
              text: "/close",
              userId,
            }),
            trigger: "direct_message",
          });
        else
          await callbacks.onSlashCommand!(
            provider === "telegram"
              ? closeEvent
              : {
                  endpointId: endpoint.id,
                  provider: "slack",
                  event: {
                    channel: {
                      id: `slack:${chatId}`,
                      name: "Close progress DM",
                      isDM: true,
                    } as never,
                    command: endpoint.setup.command!,
                    text: "close",
                    triggerId: `close-progress-${randomUUID()}`,
                    user: { ...closeEvent.event.user, userId },
                    raw: { command: endpoint.setup.command!, text: "close" },
                    adapter: {} as never,
                    openModal: async () => undefined,
                  },
                },
          );
        return db
          .select()
          .from(chatPublications)
          .where(
            and(
              eq(chatPublications.endpointId, endpoint.id),
              like(chatPublications.idempotencyKey, "control:close:%"),
            ),
          )
          .then((rows) => rows[0]!);
      };
      const progressMessageId = await db
        .select({ id: chatPublications.providerMessageId })
        .from(chatPublications)
        .where(eq(chatPublications.id, progress!.id))
        .then((rows) => rows[0]!.id!);
      return {
        ...context,
        ...fixture,
        conversation,
        runId,
        progress: progress!,
        progressMessageId,
        providerRuntime,
        stageClose,
        closeEvent,
        sourceMessageId,
      };
    }

    it("retires one working lane on close without cancelling the run or publishing its late final", async () => {
      const f = await closeProgressFixture();
      let releaseRemoval!: () => void;
      let removalStarted = false;
      const removalRelease = new Promise<void>((resolve) => {
        releaseRemoval = resolve;
      });
      const originalThread = f.providerRuntime.thread.bind(f.providerRuntime);
      const threadSpy = vi
        .spyOn(f.providerRuntime, "thread")
        .mockImplementation((threadId) => {
          const thread = originalThread(threadId);
          const removeReaction = thread.adapter.removeReaction;
          thread.adapter.removeReaction = async (
            reactionThreadId,
            messageId,
            emoji,
          ) => {
            if (
              reactionThreadId === "telegram:77118896" &&
              messageId === f.sourceMessageId &&
              emoji === "eyes"
            ) {
              removalStarted = true;
              await removalRelease;
            }
            await removeReaction(reactionThreadId, messageId, emoji);
          };
          return thread;
        });
      try {
        const close = await f.stageClose();
        await f.service.processPendingPublications();
        await vi.waitFor(() => expect(removalStarted).toBe(true));
        const removals = await db
          .select({ id: chatActions.id, status: chatActions.status })
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, f.endpoint.id),
              eq(chatActions.kind, "receipt_reaction"),
              sql`${chatActions.payload}->>'operation' = 'remove'`,
              sql`${chatActions.payload}->>'messageId' = ${f.sourceMessageId}`,
            ),
          );
        expect(removals).toEqual([
          { id: expect.any(String), status: "processing" },
        ]);
        await expect(
          db
            .select({ state: chatPublications.state })
            .from(chatPublications)
            .where(eq(chatPublications.id, close.id)),
        ).resolves.toEqual([{ state: "published" }]);
        await expect(
          f.service.processPendingReceiptReactions(25, removals[0]!.id),
        ).resolves.toBe(0);
        expect(f.providerRuntime.removedReactions).not.toContainEqual({
          threadId: "telegram:77118896",
          messageId: f.sourceMessageId,
          emoji: "eyes",
        });
        releaseRemoval();
        expect(
          await waitForProcessedReceiptRemoval(f.endpoint.id, {
            threadId: "telegram:77118896",
            messageId: f.sourceMessageId,
            emoji: "eyes",
          }),
        ).toBe(removals[0]!.id);
        expect(f.providerRuntime.posts.map((post) => post.text)).toEqual([
          "Maya is working…",
        ]);
        expect(f.providerRuntime.edits).toEqual([
          {
            threadId: `telegram:77118896`,
            messageId: f.progressMessageId,
            text: "This chat conversation is closed. Send another message to start a new task.",
          },
        ]);
        expect(f.providerRuntime.removedReactions).toContainEqual({
          threadId: "telegram:77118896",
          messageId: "77118896:930",
          emoji: "eyes",
        });
        await expect(
          db
            .select({ status: heartbeatRuns.status })
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, f.runId)),
        ).resolves.toEqual([{ status: "running" }]);
        await expect(
          db
            .select({ state: chatConversations.state })
            .from(chatConversations)
            .where(eq(chatConversations.id, f.conversation.id)),
        ).resolves.toEqual([{ state: "completed" }]);
        await db
          .update(heartbeatRuns)
          .set({ status: "succeeded", finishedAt: new Date() })
          .where(eq(heartbeatRuns.id, f.runId));
        const late = await issueService(db).addComment(
          f.conversation.issueId,
          "Late output remains on the task",
          { agentId: f.assignedAgentId, runId: f.runId },
          {
            authorType: "agent",
            authorizationReason: "paperclip_runner_protocol",
          },
        );
        await expect(
          db
            .select({ id: chatPublications.id })
            .from(chatPublications)
            .where(eq(chatPublications.commentId, late.id)),
        ).resolves.toEqual([]);
        await f.service.processPendingPublications();
        await f.callbacks.onSlashCommand!(f.closeEvent);
        await f.service.processPendingPublications();
        expect(f.providerRuntime.posts).toHaveLength(1);
        expect(f.providerRuntime.edits).toHaveLength(1);
        await expect(
          db
            .select({
              state: chatPublications.state,
              attempts: chatPublications.attempts,
              providerMessageId: chatPublications.providerMessageId,
            })
            .from(chatPublications)
            .where(eq(chatPublications.id, close.id)),
        ).resolves.toEqual([
          {
            state: "published",
            attempts: 1,
            providerMessageId: f.progressMessageId,
          },
        ]);
      } finally {
        releaseRemoval();
        threadSpy.mockRestore();
        await retirePublicationFixture(f.service, f.endpoint.id);
      }
    });

    it.each([
      "missing_link",
      "different_run_owner",
      "multiple_lanes",
      "pending_final",
      "unknown_final",
      "consumed_link",
    ] as const)("does not guess a close edit for %s", async (mode) => {
      const f = await closeProgressFixture();
      try {
        if (mode === "missing_link")
          await db
            .delete(chatMessageLinks)
            .where(
              and(
                eq(chatMessageLinks.endpointId, f.endpoint.id),
                eq(chatMessageLinks.direction, "outbound"),
                eq(chatMessageLinks.providerMessageId, f.progressMessageId),
              ),
            );
        if (mode === "different_run_owner")
          await db
            .update(heartbeatRuns)
            .set({ agentId: f.replacementAgentId })
            .where(eq(heartbeatRuns.id, f.runId));
        if (mode === "multiple_lanes") {
          const anotherRun = randomUUID();
          await db
            .insert(heartbeatRuns)
            .values({
              id: anotherRun,
              companyId: f.companyId,
              agentId: f.assignedAgentId,
              status: "running",
              contextSnapshot: await chatWakeContext({
                endpointId: f.endpoint.id,
                issueId: f.conversation.issueId,
                provider: "telegram",
                providerMessageId: "77118896:930",
              }),
            });
          await db
            .insert(chatPublications)
            .values({
              companyId: f.companyId,
              endpointId: f.endpoint.id,
              conversationId: f.conversation.id,
              issueId: f.conversation.issueId,
              idempotencyKey: `run:${anotherRun}:working:${f.endpoint.id}`,
              payload: {
                text: "Another owned run is working…",
                progressState: "working",
              },
              state: "pending",
            });
          await f.service.processPendingPublications();
          expect(f.providerRuntime.posts).toHaveLength(2);
        }
        const close = await f.stageClose();
        if (
          mode === "pending_final" ||
          mode === "unknown_final" ||
          mode === "consumed_link"
        ) {
          const final = await addSelectedChatFinal({
            agentId: f.assignedAgentId,
            body: "An authored answer must never be overwritten",
            companyId: f.companyId,
            issueId: f.conversation.issueId,
            runId: f.runId,
          });
          const [publication] = await readChatPublicationsByCommentId(final.id);
          // A later final can be unconfirmed while the earlier close is the
          // FIFO head. The old progress link is not proof of remote absence.
          await db
            .update(chatPublications)
            .set({
              state:
                mode === "pending_final"
                  ? "pending"
                  : mode === "unknown_final"
                    ? "delivery_unknown"
                    : "published",
              createdAt: new Date(close.createdAt.getTime() + 1000),
              ...(mode === "consumed_link"
                ? {
                    providerMessageId: f.progressMessageId,
                    publishedAt: new Date(),
                  }
                : {}),
            })
            .where(eq(chatPublications.id, publication.id));
          if (mode === "consumed_link")
            await db
              .update(chatMessageLinks)
              .set({ publicationId: publication.id, commentId: final.id })
              .where(
                and(
                  eq(chatMessageLinks.endpointId, f.endpoint.id),
                  eq(chatMessageLinks.direction, "outbound"),
                  eq(chatMessageLinks.providerMessageId, f.progressMessageId),
                ),
              );
        }
        const before = f.providerRuntime.posts.length;
        await f.service.processPendingPublications();
        expect(f.providerRuntime.edits).toEqual([]);
        expect(f.providerRuntime.posts).toHaveLength(before + 1);
        expect(f.providerRuntime.posts.at(-1)?.text).toBe(
          "This chat conversation is closed. Send another message to start a new task.",
        );
        await expect(
          db
            .select({ state: chatPublications.state })
            .from(chatPublications)
            .where(eq(chatPublications.id, close.id)),
        ).resolves.toEqual([{ state: "published" }]);
      } finally {
        await retirePublicationFixture(f.service, f.endpoint.id);
      }
    });

    it.each(
      (["ask_user_questions", "request_confirmation"] as const).flatMap((kind) =>
        (["pending", "delivery_unknown"] as const).map((state) => ({
          kind,
          state,
        })),
      ),
    )(
      "does not reclaim a progress lane consumed by a $state $kind prompt",
      async ({ kind, state }) => {
        const f = await closeProgressFixture();
        try {
          const close = await f.stageClose();
          const interaction = await issueThreadInteractionService(db).create(
            { id: f.conversation.issueId, companyId: f.companyId },
                kind === "request_confirmation"
                  ? { kind, continuationPolicy: "wake_assignee", sourceRunId: f.runId, payload: { version: 1, prompt: "Proceed with the operation?" } }
                  : { kind, continuationPolicy: "wake_assignee", sourceRunId: f.runId, payload: {
                      version: 1,
                      questions: [
                        {
                          id: "choice",
                          prompt: "Which option?",
                          selectionMode: "single",
                          required: true,
                          allowOther: false,
                          options: [
                            { id: "yes", label: "Yes" },
                            { id: "no", label: "No" },
                          ],
                        },
                      ],
                    } },
            { agentId: f.assignedAgentId, runId: f.runId },
          );
          const [prompt] = await readChatPublicationsByIdempotencyKey(`interaction:${interaction.id}:${f.endpoint.id}`);
          expect(prompt).toMatchObject({
            commentId: null,
            payload: { interactionId: interaction.id },
          });
          // Retained ordering fixture, like the unknown-final control above:
          // a close with an earlier transaction timestamp does not prove a later
          // prompt's remote edit was absent. This is not a live HTTP/crash proof.
          await db
            .update(chatPublications)
            .set({ state, createdAt: new Date(close.createdAt.getTime() + 1000) })
            .where(eq(chatPublications.id, prompt.id));
          const beforePosts = f.providerRuntime.posts.length;
          const beforeRemovals = f.providerRuntime.removedReactions.length;
          await f.service.processPendingPublications();
          await f.service.processPendingReceiptReactions();
          expect(f.providerRuntime.edits).toEqual([]);
          expect(f.providerRuntime.posts).toHaveLength(beforePosts + 1);
          expect(f.providerRuntime.posts.at(-1)?.text).toBe(close.payload.text);
          expect(f.providerRuntime.removedReactions).toHaveLength(beforeRemovals);
          expect(
            (
              await readChatPublicationsById(close.id)
            )[0],
          ).toMatchObject({ state: "published" });
          expect(
            (
              await readChatPublicationsById(prompt.id)
            )[0]?.state,
          ).toBe(state === "delivery_unknown" ? "delivery_unknown" : "cancelled");
          expect(
            (
              await readHeartbeatRunsById(f.runId)
            )[0]?.status,
          ).toBe("running");
        } finally {
          await retirePublicationFixture(f.service, f.endpoint.id);
        }
      },
    );

    it("does not borrow an unrelated run's interaction as progress-consumer evidence", async () => {
      const f = await closeProgressFixture();
      try {
        const close = await f.stageClose();
        const otherRunId = randomUUID();
        await db
          .insert(heartbeatRuns)
          .values({
            id: otherRunId,
            companyId: f.companyId,
            agentId: f.assignedAgentId,
            status: "running",
            contextSnapshot: { issueId: f.conversation.issueId },
          });
        const interaction = await issueThreadInteractionService(db).create(
          { id: f.conversation.issueId, companyId: f.companyId },
          {
            kind: "request_confirmation",
            continuationPolicy: "wake_assignee",
            sourceRunId: otherRunId,
            payload: { version: 1, prompt: "Another run's confirmation" },
          },
          { agentId: f.assignedAgentId, runId: otherRunId },
        );
        const [prompt] = await readChatPublicationsByIdempotencyKey(`interaction:${interaction.id}:${f.endpoint.id}`);
        expect(prompt).toBeDefined();
        await db
          .update(chatPublications)
          .set({
            state: "delivery_unknown",
            createdAt: new Date(close.createdAt.getTime() + 1000),
          })
          .where(eq(chatPublications.id, prompt.id));
        await f.service.processPendingPublications();
        expect(f.providerRuntime.edits).toEqual([
          {
            threadId: "telegram:77118896",
            messageId: f.progressMessageId,
            text: close.payload.text,
          },
        ]);
        expect(
          (
            await readChatPublicationsById(prompt.id)
          )[0]?.state,
        ).toBe("delivery_unknown");
      } finally {
        await retirePublicationFixture(f.service, f.endpoint.id);
      }
    });

    it.each(["final", "confirmation"] as const)(
      "preserves an attempted unknown %s after public operator cancellation",
      async (kind) => {
        const f = await closeProgressFixture();
        let lostReceipt = false;
        const originalThread = f.providerRuntime.thread.bind(f.providerRuntime);
        const threadSpy = vi
          .spyOn(f.providerRuntime, "thread")
          .mockImplementation((threadId) => {
            const thread = originalThread(threadId);
            const edit = thread.adapter.editMessage.bind(thread.adapter);
            thread.adapter.editMessage = async (...args) => {
              const receipt = await edit(...args);
              if (!lostReceipt) {
                lostReceipt = true;
                throw Object.assign(new Error("Consumer edit receipt lost"), {
                  name: "NetworkError",
                  code: "NETWORK_ERROR",
                });
              }
              return receipt;
            };
            return thread;
          });
        try {
          let consumerId: string;
          if (kind === "final") {
            const comment = await addSelectedChatFinal({
              agentId: f.assignedAgentId,
              body: "Preserve this possibly delivered final",
              companyId: f.companyId,
              issueId: f.conversation.issueId,
              runId: f.runId,
            });
            consumerId = await db
              .select({ id: chatPublications.id })
              .from(chatPublications)
              .where(eq(chatPublications.commentId, comment.id))
              .then((rows) => rows[0]!.id);
          } else {
            const interaction = await issueThreadInteractionService(db).create(
              { id: f.conversation.issueId, companyId: f.companyId },
              {
                kind: "request_confirmation",
                continuationPolicy: "wake_assignee",
                sourceRunId: f.runId,
                payload: { version: 1, prompt: "Preserve this confirmation?" },
              },
              { agentId: f.assignedAgentId, runId: f.runId },
            );
            consumerId = await db
              .select({ id: chatPublications.id })
              .from(chatPublications)
              .where(
                eq(
                  chatPublications.idempotencyKey,
                  `interaction:${interaction.id}:${f.endpoint.id}`,
                ),
              )
              .then((rows) => rows[0]!.id);
          }
          await f.service.processPendingPublications();
          threadSpy.mockRestore();
          expect(lostReceipt).toBe(true);
          expect(f.providerRuntime.edits).toHaveLength(1);
          expect(f.providerRuntime.edits[0]?.messageId).toBe(f.progressMessageId);
          expect(
            await readChatPublicationsById(consumerId),
          ).toEqual([
            expect.objectContaining({ state: "delivery_unknown", attempts: 1 }),
          ]);
          const close = await f.stageClose();
          const beforePosts = f.providerRuntime.posts.length;
          // This public resolution stops retries, then drains the pending close.
          // The mocked provider edit above happened; its receipt was unconfirmed.
          await f.service.resolvePublication(
            f.endpoint.id,
            consumerId,
            "cancel",
            "owner-user",
          );
          expect(
            await readChatPublicationsById(consumerId),
          ).toEqual([
            expect.objectContaining({
              state: "cancelled",
              attempts: 1,
              redactedError:
                "Cancelled by an operator after an unconfirmed provider delivery",
            }),
          ]);
          expect(
            await db
              .select()
              .from(activityLog)
              .where(
                and(
                  eq(activityLog.entityId, consumerId),
                  eq(activityLog.action, "chat.publication_cancel"),
                ),
              ),
          ).toEqual([
            expect.objectContaining({
              details: expect.objectContaining({
                previousState: "delivery_unknown",
              }),
            }),
          ]);
          expect(f.providerRuntime.edits).toHaveLength(1);
          expect(f.providerRuntime.posts).toHaveLength(beforePosts + 1);
          expect(f.providerRuntime.posts.at(-1)?.text).toBe(close.payload.text);
          expect(
            await readChatPublicationsById(close.id),
          ).toEqual([expect.objectContaining({ state: "published" })]);
          expect(
            await readHeartbeatRunsById(f.runId),
          ).toEqual([expect.objectContaining({ status: "running" })]);
        } finally {
          threadSpy.mockRestore();
          await retirePublicationFixture(f.service, f.endpoint.id);
        }
      },
    );

    it.each([
      { state: "cancelled" as const, attempts: 0, mayEdit: true },
      { state: "failed" as const, attempts: 1, mayEdit: false },
    ])(
      "treats a $state consumer with $attempts attempts conservatively",
      async ({ state, attempts, mayEdit }) => {
        const f = await closeProgressFixture();
        try {
          const comment = await addSelectedChatFinal({
            agentId: f.assignedAgentId,
            body: "Retained terminal consumer",
            companyId: f.companyId,
            issueId: f.conversation.issueId,
            runId: f.runId,
          });
          // Retained terminal-state controls: no provider-call claim for this fixture.
          await db
            .update(chatPublications)
            .set({ state, attempts })
            .where(eq(chatPublications.commentId, comment.id));
          const close = await f.stageClose();
          const beforePosts = f.providerRuntime.posts.length;
          await f.service.processPendingPublications();
          expect(f.providerRuntime.edits).toHaveLength(mayEdit ? 1 : 0);
          expect(f.providerRuntime.posts).toHaveLength(
            beforePosts + (mayEdit ? 0 : 1),
          );
          expect(
            await readChatPublicationsById(close.id),
          ).toEqual([expect.objectContaining({ state: "published" })]);
        } finally {
          await retirePublicationFixture(f.service, f.endpoint.id);
        }
      },
    );

    it("preserves an authored final that wins while close is admitted", async () => {
      const f = await closeProgressFixture();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const entering = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const originalThread = f.providerRuntime.thread.bind(f.providerRuntime);
      const threadSpy = vi
        .spyOn(f.providerRuntime, "thread")
        .mockImplementation((threadId) => {
          const thread = originalThread(threadId);
          const edit = thread.adapter.editMessage.bind(thread.adapter);
          thread.adapter.editMessage = async (...args) => {
            if ((args[2] as { markdown?: string }).markdown === "The final won") {
              entered();
              await held;
            }
            return edit(...args);
          };
          return thread;
        });
      let drain: Promise<number> | undefined;
      try {
        await addSelectedChatFinal({
          agentId: f.assignedAgentId,
          body: "The final won",
          companyId: f.companyId,
          issueId: f.conversation.issueId,
          runId: f.runId,
        });
        drain = f.service.processPendingPublications();
        await entering;
        await f.stageClose();
        expect(f.providerRuntime.edits).toEqual([]);
        release();
        await drain;
        await f.service.processPendingPublications();
        expect(f.providerRuntime.edits).toEqual([
          {
            threadId: "telegram:77118896",
            messageId: f.progressMessageId,
            text: "The final won",
          },
        ]);
        expect(f.providerRuntime.posts.map((post) => post.text)).toEqual([
          "Maya is working…",
          "This chat conversation is closed. Send another message to start a new task.",
        ]);
      } finally {
        release();
        await drain;
        threadSpy.mockRestore();
        await retirePublicationFixture(f.service, f.endpoint.id);
      }
    });

    it("retires a status-interleaved working lane", async () => {
      const f = await closeProgressFixture();
      try {
        const event = f.closeEvent;
        await f.callbacks.onSlashCommand!({
          ...event,
          event: {
            ...event.event,
            command: "/status",
            raw: {
              ...event.event.raw,
              message_id: 932,
              text: "/status",
              entities: [{ offset: 0, length: 7, type: "bot_command" }],
            },
          },
        });
        await f.service.processPendingPublications();
        expect(f.providerRuntime.edits).toHaveLength(1);
        await f.stageClose();
        await f.service.processPendingPublications();
        expect(f.providerRuntime.posts).toHaveLength(1);
        expect(f.providerRuntime.edits.at(-1)).toMatchObject({
          messageId: f.progressMessageId,
          text: "This chat conversation is closed. Send another message to start a new task.",
        });
      } finally {
        await retirePublicationFixture(f.service, f.endpoint.id);
      }
    });

    it.each(["rejected", "unknown_commit"] as const)(
      "keeps close uncommitted after %s of its retirement edit",
      async (mode) => {
        const f = await closeProgressFixture();
        let transactionSpy: ReturnType<typeof vi.spyOn> | undefined;
        try {
          const close = await f.stageClose();
          if (mode === "rejected")
            f.providerRuntime.editError = Object.assign(
              new Error("Rejected close edit"),
              { name: "ValidationError", code: "VALIDATION_ERROR" },
            );
          else {
            const originalTransaction = db.transaction.bind(db);
            let injected = false;
            transactionSpy = vi
              .spyOn(db, "transaction")
              .mockImplementation((async (
                ...args: Parameters<typeof originalTransaction>
              ) => {
                if (!injected && f.providerRuntime.edits.length === 1) {
                  injected = true;
                  throw new Error(
                    "Close edit committed remotely without durable receipt",
                  );
                }
                return originalTransaction(...args);
              }) as typeof db.transaction);
          }
          await f.service.processPendingPublications();
          transactionSpy?.mockRestore();
          transactionSpy = undefined;
          await expect(
            db
              .select({ state: chatPublications.state })
              .from(chatPublications)
              .where(eq(chatPublications.id, close.id)),
          ).resolves.toEqual([
            { state: mode === "rejected" ? "failed" : "delivery_unknown" },
          ]);
          await expect(
            db
              .select({ state: chatConversations.state })
              .from(chatConversations)
              .where(eq(chatConversations.id, f.conversation.id)),
          ).resolves.toEqual([{ state: "active" }]);
          await f.service.processPendingPublications();
          expect(f.providerRuntime.posts).toHaveLength(1);
          expect(f.providerRuntime.editAttempts).toHaveLength(1);
          await expect(
            db
              .select({ status: heartbeatRuns.status })
              .from(heartbeatRuns)
              .where(eq(heartbeatRuns.id, f.runId)),
          ).resolves.toEqual([{ status: "running" }]);
        } finally {
          transactionSpy?.mockRestore();
          await retirePublicationFixture(f.service, f.endpoint.id);
        }
      },
    );

    it.each(
      (["slack", "microsoft-teams"] as const).flatMap((provider) =>
        (["working", "final", "unknown_final", "card"] as const).map((mode) => ({
          provider,
          mode,
        })),
      ),
    )(
      "qualifies $provider close-owned progress retirement ($mode)",
      async ({ provider, mode }) => {
        const f = await closeProgressFixture(provider);
        try {
          if (mode === "final") {
            await addSelectedChatFinal({
              agentId: f.assignedAgentId,
              body: "The Slack final must remain",
              companyId: f.companyId,
              issueId: f.conversation.issueId,
              runId: f.runId,
            });
            await f.service.processPendingPublications();
          }
          if (mode === "card")
            await db
              .update(chatPublications)
              .set({
                payload: {
                  ...f.progress.payload,
                  card: { schema: "paperclip.chat.card.v1", kind: "status", title: "Not a plain progress lane" },
                },
              })
              .where(eq(chatPublications.id, f.progress.id));
          const close = await f.stageClose();
          if (mode === "unknown_final") {
            const final = await addSelectedChatFinal({
              agentId: f.assignedAgentId,
              body: "Possibly delivered Slack final",
              companyId: f.companyId,
              issueId: f.conversation.issueId,
              runId: f.runId,
            });
            await db
              .update(chatPublications)
              .set({
                state: "delivery_unknown",
                createdAt: new Date(close.createdAt.getTime() + 1000),
              })
              .where(eq(chatPublications.commentId, final.id));
          }
          const editCount = f.providerRuntime.edits.length,
            postCount = f.providerRuntime.posts.length;
          await f.service.processPendingPublications();
          await f.service.processPendingReceiptReactions();
          expect(f.providerRuntime.edits).toHaveLength(
            editCount + (mode === "working" ? 1 : 0),
          );
          expect(f.providerRuntime.posts).toHaveLength(
            postCount + (mode === "working" ? 0 : 1),
          );
          if (mode === "working") {
            expect(f.providerRuntime.edits.at(-1)).toMatchObject({
              messageId: f.progressMessageId,
              text: close.payload.text,
            });
            if (provider === "slack") {
              await waitForProcessedReceiptRemoval(f.endpoint.id, {
                threadId: f.conversation.externalThreadId,
                messageId: f.sourceMessageId,
                emoji: "eyes",
              });
              expect(f.providerRuntime.removedReactions).toContainEqual({
                threadId: f.conversation.externalThreadId,
                messageId: f.sourceMessageId,
                emoji: "eyes",
              });
            }
          }
          await expect(
            db
              .select({ status: heartbeatRuns.status })
              .from(heartbeatRuns)
              .where(eq(heartbeatRuns.id, f.runId)),
          ).resolves.toEqual([{ status: "running" }]);
          await f.service.processPendingPublications();
          expect(f.providerRuntime.edits).toHaveLength(
            editCount + (mode === "working" ? 1 : 0),
          );
        } finally {
          await retirePublicationFixture(f.service, f.endpoint.id);
        }
      },
    );
  });

  it.each(["slack", "github"] as const)(
    "keeps intermediate %s agent comments internal and publishes only the selected final",
    async (provider) => {
      const fixture = await seedCompany();
      const configured =
        provider === "slack"
          ? await configuredSlackEndpoint(fixture)
          : await configuredGitHubEndpoint(fixture);
      const { callbacks, endpoint, runtime, service } = configured;
      const thread = makeThread({
        channelId:
          provider === "slack"
            ? "C-MULTI-FINAL"
            : "github:paperclipai/paperclip",
        id:
          provider === "slack"
            ? "slack:C-MULTI-FINAL:4045.1"
            : "github:paperclipai/paperclip:issue:418",
        name: provider === "slack" ? "multi-final" : "paperclipai/paperclip",
      });
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider,
        thread: thread.thread,
        message: makeMessage({
          id: provider === "slack" ? "4045.1" : "41801",
          text: "@maya return one final answer after internal checkpoints",
          mentioned: true,
        }),
        trigger: "mention",
      });
      const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
      if (provider === "github") {
        // This case exercises tool-owned replies; legacy coverage below keeps
        // the generic final publication behavior without a saved configuration.
        const config = await githubChatManagementService(db).configuration(endpoint.id, "owner-user");
        await db.insert(chatGitHubConfigurations).values({
          companyId: fixture.companyId,
          endpointId: endpoint.id,
          configuration: config.configuration,
          updatedByUserId: "owner-user",
        });
      }
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        status: "running",
        contextSnapshot: await chatWakeContext({
          endpointId: endpoint.id,
          issueId: conversation.issueId,
          provider,
          providerMessageId: provider === "slack" ? "4045.1" : "41801",
        }),
      });
      await db.insert(chatPublications).values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: conversation.id,
        issueId: conversation.issueId,
        idempotencyKey: `run:${runId}:working:${endpoint.id}`,
        payload: { text: "Maya is working…", progressState: "working" },
        state: "pending",
      });
      await service.processPendingPublications();

      const comments = [];
      for (const body of ["checkpoint-one", "checkpoint-two"]) {
        comments.push(
          await issueService(db).addComment(
            conversation.issueId,
            body,
            { agentId: fixture.assignedAgentId, runId },
            {
              authorType: "agent",
              authorizationReason: "paperclip_runner_protocol",
            },
          ),
        );
      }
      comments.push(
        await addSelectedChatFinal({
          agentId: fixture.assignedAgentId,
          body: "answer-final",
          companyId: fixture.companyId,
          issueId: conversation.issueId,
          runId,
        }),
      );
      await Promise.all([
        service.processPendingPublications(),
        service.processPendingPublications(),
        service.processPendingPublications(),
      ]);

      const providerRuntime = runtime.endpoints.get(endpoint.id);
      expect(providerRuntime?.posts.map((post) => post.text)).toEqual(provider === "github" ? [] : [
        "Maya is working…",
      ]);
      expect(providerRuntime?.edits).toEqual(provider === "github" ? [] : [
        {
          threadId: thread.thread.id,
          messageId: "outbound-1",
          text: "answer-final",
        },
      ]);
      const commentPublications = await db
        .select()
        .from(chatPublications)
        .where(
          inArray(
            chatPublications.commentId,
            comments.map((comment) => comment.id),
          ),
        )
        .orderBy(asc(chatPublications.createdAt), asc(chatPublications.id));
      expect(commentPublications).toEqual(provider === "github" ? [] : [
        expect.objectContaining({
          commentId: comments[2].id,
          state: "published",
          providerMessageId: "outbound-1",
        }),
      ]);
      expect(
        await db
          .select({ body: issueComments.body })
          .from(issueComments)
          .where(
            inArray(
              issueComments.id,
              comments.map((comment) => comment.id),
            ),
          ),
      ).toHaveLength(3);
      expect(
        await db
          .select()
          .from(chatMessageLinks)
          .where(
            and(
              eq(chatMessageLinks.conversationId, conversation.id),
              eq(chatMessageLinks.direction, "outbound"),
            ),
          ),
      ).toHaveLength(provider === "github" ? 0 : 1);
      await service.shutdown();
    },
  );

  it("does not hold another endpoint's final publication behind Slack session status transport", async () => {
    const firstFixture = await seedCompany();
    let blockSessionStatus = false;
    let blockedSessionStatusCalls = 0;
    let releaseSessionStatus!: () => void;
    let sessionStatusStarted!: () => void;
    let anotherSessionStatusStarted!: () => void;
    const sessionStatusStartedPromise = new Promise<void>((resolve) => {
      sessionStatusStarted = resolve;
    });
    const anotherSessionStatusStartedPromise = new Promise<void>((resolve) => {
      anotherSessionStatusStarted = resolve;
    });
    const sessionStatusReleased = new Promise<void>((resolve) => {
      releaseSessionStatus = resolve;
    });
    const blockingFetch =
      (
        ordinaryFetch: ReturnType<typeof fakeSlackFetch>,
      ): typeof globalThis.fetch =>
      async (input) => {
        if (
          String(input) === "https://slack.com/api/agents.sessions.setStatus" &&
          blockSessionStatus
        ) {
          blockedSessionStatusCalls += 1;
          if (blockedSessionStatusCalls === 1) sessionStatusStarted();
          else anotherSessionStatusStarted();
          await sessionStatusReleased;
          return Response.json({ ok: true });
        }
        return ordinaryFetch(input);
      };
    const firstFetch = blockingFetch(fakeSlackFetch());
    const first = await configuredSlackEndpoint(firstFixture, {
      fetch: firstFetch,
    });
    let second: Awaited<ReturnType<typeof configuredSlackEndpoint>> | null =
      null;
    let secondSessionActionId: string | null = null;
    let blockedStatusSweep: Promise<number> | null = null;
    let secondPublicationSweep: Promise<number> | null = null;
    try {
      const firstThread = makeThread({
        channelId: "CSESSIONBLOCKER",
        id: "slack:CSESSIONBLOCKER:1710004051.000001",
        name: "session-blocker",
      });
      await deliverMessage({
        callbacks: first.callbacks,
        endpointId: first.endpoint.id,
        thread: firstThread.thread,
        message: makeMessage({
          id: "1710004051.000001",
          text: "@maya start the status blocker",
          mentioned: true,
        }),
        trigger: "mention",
      });
      const firstConversation = await readChatConversationsByEndpointId(first.endpoint.id)
        .then((rows) => rows[0]!);
      await db.insert(chatPublications).values({
        companyId: firstFixture.companyId,
        endpointId: first.endpoint.id,
        conversationId: firstConversation.id,
        issueId: firstConversation.issueId,
        idempotencyKey: `session-blocker:${randomUUID()}`,
        payload: { text: "Maya is working…", progressState: "working" },
        state: "pending",
      });
      await first.service.processPendingPublications();
      const firstSessionAction = await db
        .select({ id: chatActions.id })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, first.endpoint.id),
            eq(chatActions.kind, "slack_session_sync"),
          ),
        )
        .then((rows) => rows[0]!);

      blockSessionStatus = true;
      blockedStatusSweep = first.service.processPendingSlackSessionSyncs(
        25,
        firstSessionAction.id,
      );
      await sessionStatusStartedPromise;

      const secondFixture = await seedCompany();
      const secondFetch = blockingFetch(fakeSlackFetch());
      second = await configuredSlackEndpoint(secondFixture, {
        fetch: secondFetch,
      });
      const secondThread = makeThread({
        channelId: "CSESSIONINDEPENDENT",
        id: "slack:CSESSIONINDEPENDENT:1710004051.000002",
        name: "session-independent",
      });
      await deliverMessage({
        callbacks: second.callbacks,
        endpointId: second.endpoint.id,
        thread: secondThread.thread,
        message: makeMessage({
          id: "1710004051.000002",
          text: "@maya publish independently",
          mentioned: true,
        }),
        trigger: "mention",
      });
      const secondConversation = await readChatConversationsByEndpointId(second.endpoint.id)
        .then((rows) => rows[0]!);
      await db.insert(chatPublications).values({
        companyId: secondFixture.companyId,
        endpointId: second.endpoint.id,
        conversationId: secondConversation.id,
        issueId: secondConversation.issueId,
        idempotencyKey: `session-independent:${randomUUID()}`,
        payload: { text: "SLACK-SESSION-INDEPENDENT" },
        state: "pending",
      });

      secondPublicationSweep = second.service.processPendingPublications();
      const publicationOutcome = await Promise.race([
        secondPublicationSweep.then(() => "published" as const),
        anotherSessionStatusStartedPromise.then(
          () => "blocked_by_session_status" as const,
        ),
      ]);
      expect(publicationOutcome).toBe("published");
      expect(
        second.runtime.endpoints.get(second.endpoint.id)?.posts,
      ).toContainEqual({
        threadId: secondThread.thread.id,
        text: "SLACK-SESSION-INDEPENDENT",
      });
      secondSessionActionId = await db
        .select({ id: chatActions.id })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, second.endpoint.id),
            eq(chatActions.kind, "slack_session_sync"),
          ),
        )
        .then((rows) => rows[0]?.id ?? null);
    } finally {
      releaseSessionStatus();
      await blockedStatusSweep;
      await secondPublicationSweep;
      blockSessionStatus = false;
      if (second && secondSessionActionId) {
        await second.service.processPendingSlackSessionSyncs(
          25,
          secondSessionActionId,
        );
      }
      await first.service.shutdown();
      await second?.service.shutdown();
    }
  });

  it("reconciles Slack session status without replaying messages after rate limits or restart", async () => {
    const fixture = await seedCompany();
    const ordinaryFetch = fakeSlackFetch();
    const statusCalls: string[] = [];
    let failStatus = true;
    let permanentStatusError: string | null = null;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      if (String(input) !== "https://slack.com/api/agents.sessions.setStatus")
        return ordinaryFetch(input);
      statusCalls.push(
        (JSON.parse(String(init?.body)) as { status: string }).status,
      );
      return failStatus
        ? Response.json(
            { ok: false, error: "ratelimited" },
            { status: 429, headers: { "retry-after": "1800" } },
          )
        : Response.json(
            permanentStatusError
              ? { ok: false, error: permanentStatusError }
              : { ok: true },
          );
    };
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture, { fetch });
    const thread = makeThread({
      channelId: "CSESSION",
      id: "slack:CSESSION:4052.1",
      name: "session-status",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: thread.thread,
      message: makeMessage({
        id: "4052.1",
        text: "@maya test session status",
        mentioned: true,
      }),
      trigger: "mention",
    });
    const conversation = await readChatConversationsByEndpointId(endpoint.id)
      .then((rows) => rows[0]!);
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: fixture.companyId,
      agentId: fixture.assignedAgentId,
      status: "running",
      contextSnapshot: await chatWakeContext({
        endpointId: endpoint.id,
        issueId: conversation.issueId,
        provider: "slack",
        providerMessageId: "4052.1",
      }),
    });
    const [working] = await db
      .insert(chatPublications)
      .values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: conversation.id,
        issueId: conversation.issueId,
        idempotencyKey: `run:${runId}:working:${endpoint.id}`,
        payload: { text: "Maya is working…", progressState: "working" },
        state: "pending",
      })
      .returning();
    const rateLimitedAt = Date.now();
    await service.processPendingPublications();
    expect(statusCalls).toEqual([]);
    expect(
      await db
        .select({ state: chatPublications.state })
        .from(chatPublications)
        .where(eq(chatPublications.id, working.id))
        .then((rows) => rows[0]?.state),
    ).toBe("published");
    const action = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.kind, "slack_session_sync"),
        ),
      )
      .then((rows) => rows[0]!);
    expect(action.status).toBe("received");
    await service.processPendingSlackSessionSyncs(25, action.id);
    expect(statusCalls).toEqual(["processing"]);
    const deferredAction = await db
      .select({ result: chatActions.result })
      .from(chatActions)
      .where(eq(chatActions.id, action.id))
      .then((rows) => rows[0]!);
    expect(
      Date.parse(String(deferredAction.result?.retryAt)),
    ).toBeGreaterThanOrEqual(rateLimitedAt + 1_800_000);
    await service.processPendingSlackSessionSyncs(25, action.id);
    expect(statusCalls).toHaveLength(1);
    const firstProviderRuntime = runtime.endpoints.get(endpoint.id)!;
    const providerPosts = firstProviderRuntime.posts.length;
    await service.shutdown();

    // A successor reclaims a crashed status attempt. The source run is now
    // cancelled; its old working receipt must not revive processing.
    await db
      .update(heartbeatRuns)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId));
    await db
      .update(chatActions)
      .set({
        status: "processing",
        result: { attempts: 1 },
        updatedAt: new Date(Date.now() - 61_000),
      })
      .where(eq(chatActions.id, action.id));
    failStatus = false;
    const resumed = createService(runtime, fetch);
    await resumed.service.processPendingSlackSessionSyncs(25, action.id);
    expect(statusCalls).toEqual(["processing", "active"]);
    expect(firstProviderRuntime.posts.length).toBe(providerPosts);
    expect(runtime.endpoints.get(endpoint.id)?.posts.length ?? 0).toBe(0);
    expect(
      await db
        .select({ status: chatActions.status, result: chatActions.result })
        .from(chatActions)
        .where(eq(chatActions.id, action.id))
        .then((rows) => rows[0]),
    ).toMatchObject({
      status: "processed",
      result: { sessionStatus: "active" },
    });

    // A final response produces one edit, then a fresh revision of the status
    // lane. Neither a retry nor restart posts another copy of that response.
    await addSelectedChatFinal({
      agentId: fixture.assignedAgentId,
      body: "SLACK-SESSION-DONE",
      companyId: fixture.companyId,
      issueId: conversation.issueId,
      runId,
    });
    await resumed.service.processPendingPublications();
    await resumed.service.processPendingPublications();
    await resumed.service.processPendingSlackSessionSyncs(25, action.id);
    expect(statusCalls).toEqual(["processing", "active", "active"]);
    expect(firstProviderRuntime.posts.length).toBe(providerPosts);
    expect(runtime.endpoints.get(endpoint.id)?.posts.length ?? 0).toBe(0);
    expect(
      runtime.endpoints
        .get(endpoint.id)
        ?.edits.filter((edit) => edit.text === "SLACK-SESSION-DONE"),
    ).toHaveLength(1);

    // A worker can select a due status row, then lose to another worker before
    // observing an endpoint pause. Its stale snapshot must not resurrect the
    // already completed status action or dispatch another provider request.
    await db
      .update(chatActions)
      .set({
        status: "received",
        result: null,
        updatedAt: new Date(),
      })
      .where(eq(chatActions.id, action.id));
    let selected!: () => void;
    let releaseSelection!: () => void;
    const selectedPromise = new Promise<void>((resolve) => {
      selected = resolve;
    });
    const selectionReleased = new Promise<void>((resolve) => {
      releaseSelection = resolve;
    });
    const competing = createService(runtime, fetch, {
      slackSessionSyncSelectionBarrier: async () => {
        selected();
        await selectionReleased;
      },
    });
    const staleAttempt = competing.service.processPendingSlackSessionSyncs(
      25,
      action.id,
    );
    try {
      await selectedPromise;
      await resumed.service.processPendingSlackSessionSyncs(25, action.id);
      await db
        .update(chatEndpoints)
        .set({ status: "paused", updatedAt: new Date() })
        .where(eq(chatEndpoints.id, endpoint.id));
    } finally {
      releaseSelection();
      await staleAttempt;
    }
    expect(statusCalls).toEqual(["processing", "active", "active", "active"]);
    expect(
      await db
        .select({ status: chatActions.status })
        .from(chatActions)
        .where(eq(chatActions.id, action.id))
        .then((rows) => rows[0]?.status),
    ).toBe("processed");
    expect(await resumed.service.listActivity(endpoint.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "action",
          actionType: "slack_session_sync",
          status: "processed",
          replayable: false,
        }),
      ]),
    );
    await db
      .update(chatEndpoints)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(chatEndpoints.id, endpoint.id));
    for (const [providerError, terminalStatus] of [
      ["feature_disabled", "processed"],
      ["missing_scope", "failed"],
    ] as const) {
      permanentStatusError = providerError;
      await db
        .update(chatActions)
        .set({ status: "received", result: null, updatedAt: new Date() })
        .where(eq(chatActions.id, action.id));
      const previousCalls = statusCalls.length;
      await resumed.service.processPendingSlackSessionSyncs(25, action.id);
      await resumed.service.processPendingSlackSessionSyncs(25, action.id);
      expect(statusCalls).toHaveLength(previousCalls + 1);
      const settled = await db
        .select({ status: chatActions.status, result: chatActions.result })
        .from(chatActions)
        .where(eq(chatActions.id, action.id))
        .then((rows) => rows[0]!);
      expect(settled.status).toBe(terminalStatus);
      expect(settled.result?.retryAt).toBeUndefined();
    }
    await competing.service.shutdown();
    await resumed.service.shutdown();
  });

  it.each([false, true])("returns two answered Slack turns to Idle in the same thread (DM=%s)", async (isDM) => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service } = await configuredSlackEndpoint(fixture);
    const channelId = isDM ? "D-IDLE" : "C-IDLE";
    const thread = makeThread({ channelId, id: `slack:${channelId}:4049.1`, name: "idle", isDM });
    let issueId: string | undefined;
    let conversationId: string | undefined;
    for (const [index, text] of ["@maya are you there?", "what is your name?"].entries()) {
      const providerMessageId = `4049.${index + 1}`;
      await deliverMessage({ callbacks, endpointId: endpoint.id, thread: thread.thread,
        message: makeMessage({ id: providerMessageId, text, mentioned: index === 0 }),
        trigger: index === 0 ? "mention" : "subscribed_message" });
      const conversations = await readChatConversationsByEndpointId(endpoint.id);
      expect(conversations).toHaveLength(1);
      const conversation = conversations[0]!;
      expect(conversation.state).toBe("active");
      expect((await issueService(db).getById(conversation.issueId))?.status).toBe("todo");
      if (issueId) expect(conversation.issueId).toBe(issueId);
      if (conversationId) expect(conversation.id).toBe(conversationId);
      issueId = conversation.issueId;
      conversationId = conversation.id;
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId: fixture.companyId,
        agentId: fixture.assignedAgentId, status: "succeeded", runtimeMode: "legacy", finishedAt: new Date(),
        contextSnapshot: await chatWakeContext({ endpointId: endpoint.id, issueId, provider: "slack", providerMessageId }) });
      // Model execution consuming the admitted wake and committing its checkout.
      await db.update(agentWakeupRequests).set({ status: "completed", runId })
        .where(and(eq(agentWakeupRequests.companyId, fixture.companyId), eq(agentWakeupRequests.status, "queued")));
      await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, issueId));
      await addSelectedChatFinal({ companyId: fixture.companyId, agentId: fixture.assignedAgentId,
        issueId, runId, body: index === 0 ? "Yes, I'm here." : "I'm Maya." });
      await service.processPendingPublications();
      await vi.waitFor(async () => {
        const issue = await issueService(db).getById(issueId!);
        expect(issue?.status).toBe("in_review");
        expect(issue?.externalConversationState).toBe("waiting");
        expect(issue?.conversationAgentId).toBeNull();
        expect(issue?.conversationUserId).toBeNull();
      });
      // A provider replay must not wake or reactivate the completed turn.
      await deliverMessage({ callbacks, endpointId: endpoint.id, thread: thread.thread,
        message: makeMessage({ id: providerMessageId, text, mentioned: index === 0 }),
        trigger: index === 0 ? "mention" : "subscribed_message" });
      expect((await issueService(db).getById(issueId))?.externalConversationState).toBe("waiting");
    }
  });

  it("coalesces one Slack run's lifecycle and final response despite an interleaved task control", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture);
    const thread = makeThread({
      channelId: "C-QUIET-RUN",
      id: "slack:C-QUIET-RUN:4050.1",
      name: "quiet-run",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: thread.thread,
      message: makeMessage({
        id: "4050.1",
        text: "@maya produce one quiet Slack response",
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
      contextSnapshot: await chatWakeContext({
        endpointId: endpoint.id,
        issueId: conversation.issueId,
        provider: "slack",
        providerMessageId: "4050.1",
      }),
    });
    for (const milestone of ["queued", "working"] as const) {
      await db.insert(chatPublications).values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: conversation.id,
        issueId: conversation.issueId,
        idempotencyKey: `run:${runId}:${milestone}:${endpoint.id}`,
        payload: {
          text: milestone === "queued" ? "Maya is queued." : "Maya is working…",
          progressState: milestone,
        },
        state: "pending",
      });
      await service.processPendingPublications();
    }
    const principal = await db
      .select({ id: chatExternalPrincipals.id })
      .from(chatExternalPrincipals)
      .where(eq(chatExternalPrincipals.companyId, fixture.companyId))
      .then((rows) => rows[0]);
    if (!principal) throw new Error("Slack principal was not created");
    const stageControlPublication = async (text: string) => {
      const [publication] = await db
        .insert(chatPublications)
        .values({
          companyId: fixture.companyId,
          endpointId: endpoint.id,
          conversationId: conversation.id,
          issueId: conversation.issueId,
          idempotencyKey: `control:status:${randomUUID()}`,
          payload: {
            text,
          },
          state: "pending",
        })
        .returning({ id: chatPublications.id });
      await db.insert(chatActions).values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: conversation.id,
        principalId: principal.id,
        kind: "task_control_authorization",
        providerActionId: `task-control-authorization:${publication.id}`,
        payload: { publicationId: publication.id },
        status: "issued",
      });
    };
    await stageControlPublication("Status sampled while the run is active");
    await service.processPendingPublications();
    const finalText =
      `Final Slack result ${"with enough safe detail. ".repeat(20)}`.trim();
    const finalComment = await addSelectedChatFinal({
      agentId: fixture.assignedAgentId,
      body: finalText,
      companyId: fixture.companyId,
      issueId: conversation.issueId,
      runId,
    });
    await service.processPendingPublications();

    const providerRuntime = runtime.endpoints.get(endpoint.id);
    expect(providerRuntime?.posts).toEqual([
      { threadId: thread.thread.id, text: "Maya is queued." },
    ]);
    expect(providerRuntime?.edits).toEqual([
      {
        threadId: thread.thread.id,
        messageId: "outbound-1",
        text: "Maya is working…",
      },
      {
        threadId: thread.thread.id,
        messageId: "outbound-1",
        text: expect.stringMatching(/ — /),
      },
      {
        threadId: thread.thread.id,
        messageId: "outbound-1",
        text: finalText,
      },
    ]);
    const renderedSlackMessages = new Map(
      providerRuntime!.posts.map((post, index) => [
        `outbound-${index + 1}`,
        post.text,
      ]),
    );
    for (const edit of providerRuntime!.edits)
      renderedSlackMessages.set(edit.messageId, edit.text);
    expect([...renderedSlackMessages.values()]).toEqual([finalText]);
    const publications = await db
      .select()
      .from(chatPublications)
      .where(eq(chatPublications.conversationId, conversation.id));
    expect(publications).toHaveLength(4);
    expect(
      publications
        .filter((publication) =>
          publication.idempotencyKey.startsWith(`run:${runId}:`),
        )
        .every(
          (publication) =>
            publication.state === "published" &&
            publication.providerMessageId === "outbound-1",
        ),
    ).toBe(true);
    expect(
      await db
        .select()
        .from(chatMessageLinks)
        .where(
          and(
            eq(chatMessageLinks.conversationId, conversation.id),
            eq(chatMessageLinks.direction, "outbound"),
          ),
        ),
    ).toEqual([
      expect.objectContaining({
        providerMessageId: "outbound-1",
        commentId: finalComment.id,
      }),
    ]);

    // Once the run lane is terminal, /status has no replaceable placeholder
    // and falls back to a distinct provider post.
    await stageControlPublication("Status sampled after the run finished");
    await service.processPendingPublications();
    expect(providerRuntime?.posts).toEqual([
      { threadId: thread.thread.id, text: "Maya is queued." },
      { threadId: thread.thread.id, text: expect.stringMatching(/ — /) },
    ]);
  });
});
