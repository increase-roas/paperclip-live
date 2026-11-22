import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { authUsers, chatActions, chatDeliveries, chatEndpointResources, chatEndpoints, chatExternalPrincipals, chatPublications, chatSdkState, companyMemberships, heartbeatRuns, issueComments, issueQuestionResponseDeliveries, issueThreadInteractions, toolConnections } from "@paperclipai/db";
import type { Message } from "chat";
import type { InternalSetupState } from "../../services/chat-channels/runtime-types.js";
import { createChatSdkEndpointRuntime } from "../../services/chat-sdk-runtime.js";
import * as discordQuestionForms from "../../services/chat-discord-question-forms.js";
import {  } from "../../services/chat-discord-question-forms.js";
import { issueService } from "../../services/issues.js";
import { issueThreadInteractionService } from "../../services/issue-thread-interactions.js";
import { enqueueChatRunMilestones, resolveChatRunPresentationAuthorizationReason } from "../../services/chat-run-publications.js";
import { FakeChatSdkRuntime, fakeDiscordFetch, makeMessage, makeThread } from ".././helpers/chat-channels-fixture.js";
import { chatWakeContext, configuredDiscordEndpoint, createService, db, deliverMessage, describeChatChannelsSuite, qualifySetupRoundTrip, readChatActionsByProviderActionId, readChatEndpointsById, readChatPublicationsByCommentId, readChatPublicationsByIdempotencyKey, readHeartbeatRunsById, readToolConnectionsById, retirePublicationFixture, seedCompany } from "../helpers/chat-channels-harness.js";








describeChatChannelsSuite("chat channels 22-durably-audits-a-rejected-discord-gatewa", () => {
  it("durably audits a rejected Discord Gateway action before surfacing transport rejection", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service, wakeup } =
      await configuredDiscordEndpoint(fixture);
    let pinned: ReturnType<typeof createChatSdkEndpointRuntime> | undefined;
    try {
      await db
        .update(chatEndpoints)
        .set({ status: "active" })
        .where(eq(chatEndpoints.id, endpoint.id));
      if (!callbacks.onAction)
        throw new Error("Discord action callback was not registered");
      const configuration = runtime.configurations.get(endpoint.id)!;
      const observedErrors: string[] = [];
      const onAction = vi.fn(
        async (
          event: Parameters<NonNullable<typeof callbacks.onAction>>[0],
        ) => {
          try {
            await callbacks.onAction!(event);
          } catch (error) {
            observedErrors.push(String((error as { code?: unknown }).code));
            throw error;
          }
        },
      );
      pinned = createChatSdkEndpointRuntime({
        ...configuration,
        callbacks: { onMessage() {}, onAction },
        enableDiscordGateway: false,
        logger: "silent",
      });
      await pinned.initialize();
      const applicationId =
        configuration.providerConfig.provider === "discord"
          ? configuration.providerConfig.credentials.applicationId
          : undefined;
      const gatewayInteraction = {
        applicationId,
        channel: {
          id: "555555555555555598",
          parentId: "333333333333333333",
          type: 11,
        },
        channelId: "555555555555555598",
        componentType: 2,
        customId: "pcq:forged-discord-action\nforged-value",
        deferUpdate: vi.fn().mockResolvedValue(undefined),
        guildId: "1457808928258658549",
        id: "777777777777777710",
        isChatInputCommand: () => false,
        isMessageComponent: () => true,
        message: { id: "555555555555555597" },
        reply: vi.fn(async () => {
          const rows = await db
            .select()
            .from(chatDeliveries)
            .where(
              and(
                eq(chatDeliveries.endpointId, endpoint.id),
                eq(chatDeliveries.eventKind, "action"),
              ),
            );
          expect(rows).toHaveLength(1);
          expect(rows[0]?.state).toBe("filtered");
        }),
        token: "synthetic-interaction-token",
        type: 3,
        user: {
          id: "444444444444444444",
          username: "discord-user",
          globalName: "Discord User",
          bot: false,
        },
        version: 1,
      };
      const adapter = pinned.getProviderAdapter() as unknown as {
        handleGatewayInteraction(
          event: typeof gatewayInteraction,
        ): Promise<void>;
      };
      const priorWakeups = wakeup.mock.calls.length;
      // Repeat one synthetic Gateway delivery. These are response attempts,
      // not proof that Discord accepts two replies to one interaction token.
      await adapter.handleGatewayInteraction(gatewayInteraction);
      await adapter.handleGatewayInteraction(gatewayInteraction);
      expect(onAction).toHaveBeenCalledTimes(2);
      expect(onAction.mock.calls[0]![0].event.raw).not.toHaveProperty(
        "deferUpdate",
      );
      expect(wakeup.mock.calls).toHaveLength(priorWakeups);

      const denials = await db
        .select()
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(chatDeliveries.eventKind, "action"),
          ),
        );
      expect(denials).toEqual([
        expect.objectContaining({
          state: "filtered",
          attempts: 1,
          redactedError: "External action denied by Paperclip authorization",
          normalizedEvent: {
            providerEventId: expect.stringMatching(
              /^action-denied:[a-f0-9]{64}$/,
            ),
            kind: "action",
            authorization: { outcome: "denied" },
          },
        }),
      ]);
      expect(JSON.stringify(denials)).not.toContain(
        "pcq:forged-discord-action",
      );
      expect({
        errors: observedErrors,
        successAcknowledgements:
          gatewayInteraction.deferUpdate.mock.calls.length,
        rejectionReplies: gatewayInteraction.reply.mock.calls.length,
      }).toEqual({
        errors: [
          "chat_discord_gateway_action_rejected",
          "chat_discord_gateway_action_rejected",
        ],
        successAcknowledgements: 0,
        rejectionReplies: 2,
      });
      expect(gatewayInteraction.reply).toHaveBeenLastCalledWith({
        content:
          "This action is no longer available. Open the linked Paperclip task or ask an operator to link this account.",
        flags: 64,
      });
    } finally {
      await pinned?.shutdown();
      await service.shutdown();
    }
  });

  it("retires a Discord receipt after terminal failure without letting an add retry resurrect it", async () => {
    const fixture = await seedCompany();
    const deferred: Array<() => void> = [];
    const { callbacks, endpoint, runtime, service, wakeup } =
      await configuredDiscordEndpoint(fixture, {
        scheduleDeferredWork: (task) => deferred.push(task),
      });
    try {
      const guildId = "1457808928258658549";
      const channelId = "333333333333333333";
      const rootMessageId = "555555555555555609";
      const externalUserId = "444444444444444409";
      const threadId = `discord:${guildId}:${channelId}:${rootMessageId}`;
      const _thread = makeThread({
        channelId,
        id: threadId,
        name: "discord-terminal-receipt",
      });
      const admitRootMention = callbacks.onDiscordRootMentionAdmission;
      if (!admitRootMention) {
        throw new Error("Expected Discord root-mention admission callback");
      }
      const providerRuntime = runtime.endpoints.get(endpoint.id);
      if (!providerRuntime) throw new Error("Expected Discord runtime");
      providerRuntime.reactionErrors.push(
        Object.assign(new Error("Discord receipt rate limited"), {
          status: 429,
          retryAfterMs: 60_000,
        }),
      );

      await expect(
        admitRootMention({
          endpointId: endpoint.id,
          guildId,
          channelId,
          messageId: rootMessageId,
          message: {
            ...makeMessage({
              id: rootMessageId,
              text: "@maya demonstrate terminal receipt cleanup",
              mentioned: true,
              userId: externalUserId,
            }),
            threadId,
          } as Message,
          threadId,
          userId: externalUserId,
        }),
      ).resolves.toBe(false);
      const [delivery] = await db
        .select({ id: chatDeliveries.id })
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(chatDeliveries.providerEventId, `${threadId}:${rootMessageId}`),
          ),
        );
      if (!delivery) throw new Error("Expected Discord root delivery");
      await service.processPendingDeliveries(25, delivery.id);
      expect(providerRuntime.reactions).toHaveLength(0);
      const [addAction] = await readChatActionsByProviderActionId(`receipt_reaction:${delivery.id}`);
      expect(addAction).toMatchObject({
        status: "failed",
        result: {
          attempts: 1,
          code: "receipt_reaction_retry",
          retryable: true,
        },
      });
      deferred.length = 0;
      providerRuntime.removeReactionErrors.push(
        Object.assign(new Error("connection reset before response"), {
          code: "ECONNRESET",
          name: "NetworkError",
        }),
      );

      const [conversation] = await service.listConversations(endpoint.id);
      if (!conversation) throw new Error("Expected Discord conversation");
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        status: "failed",
        errorCode: "low_trust_isolation_unavailable",
        contextSnapshot: await chatWakeContext({
          endpointId: endpoint.id,
          issueId: conversation.issueId,
          provider: "discord",
          providerMessageId: rootMessageId,
        }),
      });
      await expect(
        enqueueChatRunMilestones(db, {
          publicBaseUrl: "https://paperclip.example",
        }),
      ).resolves.toBe(1);
      await service.processPendingPublications(1_000);

      const [failedPublication] = await readChatPublicationsByIdempotencyKey(`run:${runId}:failed:${endpoint.id}`);
      expect(failedPublication).toMatchObject({
        state: "published",
        payload: {
          progressState: "failed",
          text: expect.stringContaining("couldn't safely start this turn"),
        },
      });
      expect(
        providerRuntime.posts.filter((post) =>
          post.text.includes("couldn't safely start this turn"),
        ),
      ).toHaveLength(1);
      expect(wakeup).toHaveBeenCalledTimes(1);
      await expect(
        db
          .select({ status: chatActions.status, result: chatActions.result })
          .from(chatActions)
          .where(eq(chatActions.id, addAction.id)),
      ).resolves.toEqual([
        {
          status: "cancelled",
          result: {
            attempts: 1,
            code: "receipt_reaction_superseded_by_terminal_publication",
          },
        },
      ]);

      expect(deferred).toHaveLength(1);
      for (const task of deferred.splice(0)) task();
      let removal: typeof chatActions.$inferSelect | undefined;
      await vi.waitFor(async () => {
        removal = await readChatActionsByProviderActionId(`receipt_reaction_remove:${delivery.id}`)
          .then((rows) => rows[0]);
        expect(removal?.status).toBe("failed");
      });
      if (!removal) throw new Error("Expected Discord receipt removal");
      expect(removal).toMatchObject({
        payload: {
          operation: "remove",
          threadId,
          messageId: rootMessageId,
          reaction: "eyes",
        },
        result: {
          attempts: 1,
          code: "receipt_reaction_removal_delivery_unknown",
          retryable: true,
        },
      });

      // Even if a stale scheduler presents the old add as retryable after the
      // terminal marker commits, it must be cancelled before provider I/O.
      await db
        .update(chatActions)
        .set({
          status: "failed",
          result: {
            attempts: 1,
            retryable: true,
            retryAt: new Date(0).toISOString(),
          },
          updatedAt: new Date(),
        })
        .where(eq(chatActions.id, addAction.id));
      await service.processPendingReceiptReactions(1, addAction.id);
      expect(providerRuntime.reactions).toHaveLength(0);
      await expect(
        db
          .select({ status: chatActions.status, result: chatActions.result })
          .from(chatActions)
          .where(eq(chatActions.id, addAction.id)),
      ).resolves.toEqual([
        {
          status: "cancelled",
          result: {
            attempts: 1,
            code: "receipt_reaction_superseded_by_terminal_publication",
          },
        },
      ]);

      await db
        .update(chatActions)
        .set({
          result: {
            ...removal.result,
            retryAt: new Date(0).toISOString(),
          },
          updatedAt: new Date(),
        })
        .where(eq(chatActions.id, removal.id));
      await service.processPendingReceiptReactions(1, removal.id);
      await service.processPendingReceiptReactions(1, removal.id);
      expect(providerRuntime.removedReactions).toEqual([
        { threadId, messageId: rootMessageId, emoji: "eyes" },
      ]);
      await expect(
        db
          .select({ status: chatActions.status, result: chatActions.result })
          .from(chatActions)
          .where(eq(chatActions.id, removal.id)),
      ).resolves.toEqual([
        {
          status: "processed",
          result: { attempts: 2 },
        },
      ]);
    } finally {
      await service.shutdown();
    }
  });

  it("composes a parsed Discord question answer with one same-thread continuation publication", async () => {
    const fixture = await seedCompany();
    const continuationRunId = randomUUID();
    let continuationWakeCount = 0;
    const { callbacks, endpoint, runtime, service } =
      await configuredDiscordEndpoint(fixture, {
        wakeup: async (agentId, options) => {
          if (options.contextSnapshot?.source !== "issue.interaction.respond") {
            return { accepted: true };
          }
          continuationWakeCount += 1;
          // The runner is outside this provider/control-plane composition.
          // Seed only its synthetic result, never claim a real model turn.
          const [created] = await db
            .insert(heartbeatRuns)
            .values({
              id: continuationRunId,
              companyId: fixture.companyId,
              agentId,
              status: "succeeded",
              contextSnapshot: options.contextSnapshot,
            })
            .onConflictDoNothing()
            .returning();
          return (
            created ??
            readHeartbeatRunsById(continuationRunId)
              .then((rows) => rows[0])
          );
        },
      });
    let pinned: ReturnType<typeof createChatSdkEndpointRuntime> | undefined;
    let threadSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const guildId = "1457808928258658549";
      const channelId = "333333333333333333";
      const rootMessageId = "555555555555555610";
      const externalUserId = "444444444444444410";
      const threadId = `discord:${guildId}:${channelId}:${rootMessageId}`;
      const _channel = makeThread({
        channelId,
        id: threadId,
        name: "discord-native-question",
      });
      const admitRootMention = callbacks.onDiscordRootMentionAdmission;
      if (!admitRootMention || !callbacks.onAction) {
        throw new Error("Expected Discord root and action callbacks");
      }
      await expect(
        admitRootMention({
          endpointId: endpoint.id,
          guildId,
          channelId,
          messageId: rootMessageId,
          message: {
            ...makeMessage({
              id: rootMessageId,
              text: "@maya help me choose a priority",
              mentioned: true,
              userId: externalUserId,
            }),
            threadId,
          } as Message,
          threadId,
          userId: externalUserId,
        }),
      ).resolves.toBe(false);
      const [rootDelivery] = await db
        .select({ id: chatDeliveries.id })
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(chatDeliveries.providerEventId, `${threadId}:${rootMessageId}`),
          ),
        );
      if (!rootDelivery) throw new Error("Expected Discord root delivery");
      await service.processPendingDeliveries(25, rootDelivery.id);
      await qualifySetupRoundTrip(service, endpoint.id, externalUserId);
      await service.test(endpoint.id);
      const activeEndpoint = await service.get(endpoint.id);
      if (!activeEndpoint.providerAccountId) {
        throw new Error("Expected Discord provider account identity");
      }
      const [conversation] = await service.listConversations(endpoint.id);
      if (!conversation) throw new Error("Expected Discord conversation");

      const linkedUserId = `discord-question-user-${randomUUID()}`;
      const now = new Date();
      await db.insert(authUsers).values({
        id: linkedUserId,
        name: "Discord Question User",
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
      const principal = await db
        .select()
        .from(chatExternalPrincipals)
        .where(
          and(
            eq(chatExternalPrincipals.companyId, fixture.companyId),
            eq(chatExternalPrincipals.provider, "discord"),
            eq(
              chatExternalPrincipals.providerAccountId,
              activeEndpoint.providerAccountId,
            ),
            eq(chatExternalPrincipals.externalId, externalUserId),
          ),
        )
        .then((rows) => rows[0]);
      if (!principal) throw new Error("Expected Discord external principal");
      const intent = await service.createLinkIntent(
        endpoint.id,
        principal.id,
        1_800,
      );
      const linkToken = new URL(intent.confirmationUrl).searchParams.get(
        "token",
      );
      if (!linkToken) throw new Error("Discord identity token was absent");
      await service.confirmIdentityLink(linkToken, linkedUserId);

      const configuration = runtime.configurations.get(endpoint.id)!;
      const onAction = vi.fn(callbacks.onAction);
      pinned = createChatSdkEndpointRuntime({
        ...configuration,
        callbacks: { onMessage() {}, onAction },
        enableDiscordGateway: false,
        logger: "silent",
      });
      await pinned.initialize();
      const parsedAdapter = pinned.getProviderAdapter() as unknown as {
        buildMessagePayload(message: unknown): {
          payload: Record<string, unknown>;
        };
        handleGatewayInteraction(event: unknown): Promise<void>;
      };
      const providerRuntime = runtime.endpoints.get(endpoint.id)!;
      const renderedPayloads: Record<string, unknown>[] = [];
      const originalThread = providerRuntime.thread.bind(providerRuntime);
      threadSpy = vi
        .spyOn(providerRuntime, "thread")
        .mockImplementation((id) => {
          const original = originalThread(id);
          return {
            ...original,
            post: async (message: Parameters<typeof original.post>[0]) => {
              renderedPayloads.push(
                parsedAdapter.buildMessagePayload(message).payload,
              );
              return original.post(message);
            },
          };
        });

      const sourceRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: sourceRunId,
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        status: "succeeded",
        contextSnapshot: {
          issueId: conversation.issueId,
          taskId: conversation.issueId,
          source: "automation",
        },
      });
      const interaction = await issueThreadInteractionService(db).create(
        { id: conversation.issueId, companyId: fixture.companyId },
        {
          kind: "ask_user_questions",
          continuationPolicy: "wake_assignee",
          sourceRunId,
          title: "Choose the priority",
          payload: {
            version: 1,
            title: "Choose the priority",
            questions: [
              {
                id: "priority",
                prompt: "Which priority should we use?",
                selectionMode: "single",
                required: true,
                allowOther: false,
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
      await service.processPendingPublications(1_000);
      const questionPublication = await db
        .select()
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.endpointId, endpoint.id),
            eq(chatPublications.issueId, conversation.issueId),
          ),
        )
        .then((rows) =>
          rows.find((row) => row.payload.interactionId === interaction.id),
        );
      if (!questionPublication?.providerMessageId) {
        throw new Error("Discord question publication was not delivered");
      }
      const highAction = questionPublication.payload.card?.actions?.find(
        (candidate) =>
          candidate.type === "callback" && candidate.label === "High",
      );
      if (!highAction || highAction.type !== "callback") {
        throw new Error("Discord question callback was not projected");
      }

      const findHighButton = (value: unknown): string[] => {
        if (Array.isArray(value)) return value.flatMap(findHighButton);
        if (!value || typeof value !== "object") return [];
        const object = value as Record<string, unknown>;
        return [
          ...(object.label === "High" && typeof object.custom_id === "string"
            ? [object.custom_id]
            : []),
          ...Object.values(object).flatMap(findHighButton),
        ];
      };
      const customIds = renderedPayloads.flatMap(findHighButton);
      expect(customIds).toEqual([`${highAction.actionId}\n${interaction.id}`]);
      const applicationId =
        configuration.providerConfig.provider === "discord"
          ? configuration.providerConfig.credentials.applicationId
          : undefined;
      const click = (id: string) => ({
        applicationId,
        channel: { id: rootMessageId, parentId: channelId, type: 11 },
        channelId: rootMessageId,
        componentType: 2,
        customId: customIds[0],
        deferUpdate: vi.fn().mockResolvedValue(undefined),
        guildId,
        id,
        isChatInputCommand: () => false,
        isMessageComponent: () => true,
        message: { id: questionPublication.providerMessageId },
        reply: vi.fn().mockResolvedValue(undefined),
        token: "synthetic-interaction-token",
        type: 3,
        user: {
          id: externalUserId,
          username: "discord-user",
          globalName: "Discord User",
          bot: false,
        },
        version: 1,
      });
      const first = click("777777777777777711");
      const concurrent = click("777777777777777712");
      await Promise.all([
        parsedAdapter.handleGatewayInteraction(first),
        parsedAdapter.handleGatewayInteraction(concurrent),
      ]);
      expect(onAction).toHaveBeenCalledTimes(2);
      expect(onAction.mock.calls[0]![0]).toMatchObject({
        endpointId: endpoint.id,
        provider: "discord",
        transport: "discord_gateway",
        event: {
          actionId: highAction.actionId,
          value: interaction.id,
          threadId,
        },
      });
      expect(onAction.mock.calls[0]![0].event.raw).not.toHaveProperty(
        "deferUpdate",
      );
      expect(first.deferUpdate).toHaveBeenCalledOnce();
      expect(concurrent.deferUpdate).toHaveBeenCalledOnce();
      expect(first.reply).not.toHaveBeenCalled();
      expect(concurrent.reply).not.toHaveBeenCalled();
      await service.processPendingPublications(1_000);

      const [storedInteraction] = await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, interaction.id));
      expect(storedInteraction).toMatchObject({
        status: "answered",
        resolvedByUserId: linkedUserId,
        result: {
          version: 1,
          answers: [{ questionId: "priority", optionIds: ["high"] }],
        },
      });
      let resolutionPublication:
        typeof chatPublications.$inferSelect | undefined;
      await vi.waitFor(async () => {
        resolutionPublication = await db
          .select()
          .from(chatPublications)
          .where(
            and(
              eq(chatPublications.endpointId, endpoint.id),
              eq(
                chatPublications.idempotencyKey,
                `interaction-resolution:${interaction.id}:${endpoint.id}`,
              ),
            ),
          )
          .then((rows) => rows[0]);
        expect(resolutionPublication?.state).toBe("published");
      });
      expect(resolutionPublication).toMatchObject({
        state: "published",
        providerMessageId: questionPublication.providerMessageId,
        payload: {
          interactionId: interaction.id,
          text: "Answered: High.",
          card: {
            kind: "question",
            title: "Which priority should we use?",
            body: "Answered: High.",
          },
        },
      });
      expect(resolutionPublication?.payload.card?.actions).toBeUndefined();
      expect(providerRuntime?.edits).toEqual([
        expect.objectContaining({
          threadId,
          messageId: questionPublication.providerMessageId,
        }),
      ]);
      expect(providerRuntime?.edits[0]?.text).toContain("Answered: High.");

      await vi.waitFor(async () => {
        await expect(
          db
            .select({ id: heartbeatRuns.id })
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, continuationRunId)),
        ).resolves.toHaveLength(1);
      });
      expect(continuationWakeCount).toBe(1);
      const presentationAuthorization =
        await resolveChatRunPresentationAuthorizationReason(db, {
          companyId: fixture.companyId,
          issueId: conversation.issueId,
          runId: continuationRunId,
        });
      expect(presentationAuthorization).toBe("allow_chat_run_presentation");
      const exactMarker = "DISCORD-PRIORITY-HIGH";
      const continuationComment = await issueService(db).addComment(
        conversation.issueId,
        exactMarker,
        { agentId: fixture.assignedAgentId, runId: continuationRunId },
        {
          authorType: "agent",
          authorizationReason: presentationAuthorization,
        },
      );
      await service.processPendingPublications(1_000);
      await expect(
        readChatPublicationsByCommentId(continuationComment.id),
      ).resolves.toEqual([
        expect.objectContaining({
          endpointId: endpoint.id,
          conversationId: conversation.id,
          state: "published",
          payload: expect.objectContaining({ text: exactMarker }),
        }),
      ]);
      expect(providerRuntime?.posts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ threadId, text: exactMarker }),
        ]),
      );
      // A late delivery of this resolved action is idempotent at the service
      // boundary; it must not create a second continuation or final reply.
      const late = click("777777777777777713");
      await parsedAdapter.handleGatewayInteraction(late);
      await service.processPendingPublications(1_000);
      expect(late.deferUpdate).toHaveBeenCalledOnce();
      expect(late.reply).not.toHaveBeenCalled();
      expect(continuationWakeCount).toBe(1);
      expect(
        providerRuntime.posts.filter((post) => post.text === exactMarker),
      ).toHaveLength(1);
    } finally {
      threadSpy?.mockRestore();
      await pinned?.shutdown();
      await service.shutdown();
    }
  });

  it.each(["identical", "different"])(
    "opens and corrects an actual Discord modal through current service authority exactly once (%s concurrent answers)",
    async (concurrentMode) => {
      const fixture = await seedCompany();
      let holdConcurrentAnswers = false;
      let answerWaiters = 0;
      let releaseAnswers!: () => void;
      const answersReady = new Promise<void>((resolve) => {
        releaseAnswers = resolve;
      });
      const { callbacks, endpoint, runtime, service, wakeup } =
        await configuredDiscordEndpoint(fixture, {
          questionResolutionPersistBarrier: async () => {
            if (!holdConcurrentAnswers) return;
            if (++answerWaiters === 2) releaseAnswers();
            await answersReady;
          },
        });
      let pinned: ReturnType<typeof createChatSdkEndpointRuntime> | undefined;
      let cleanupSpy: ReturnType<typeof vi.spyOn> | undefined;
      try {
        const guildId = "1457808928258658549";
        const channelId = "333333333333333333";
        const rootMessageId = "555555555555555615";
        const externalUserId = "444444444444444415";
        const threadId = `discord:${guildId}:${channelId}:${rootMessageId}`;
        if (
          !callbacks.onDiscordRootMentionAdmission ||
          !callbacks.onAction ||
          !callbacks.onModalSubmit
        )
          throw new Error("Discord callbacks unavailable");
        await callbacks.onDiscordRootMentionAdmission({
          endpointId: endpoint.id,
          guildId,
          channelId,
          messageId: rootMessageId,
          message: {
            ...makeMessage({
              id: rootMessageId,
              text: "@maya collect deployment details",
              mentioned: true,
              userId: externalUserId,
            }),
            threadId,
          } as Message,
          threadId,
          userId: externalUserId,
        });
        const delivery = await db
          .select()
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, endpoint.id),
              eq(
                chatDeliveries.providerEventId,
                `${threadId}:${rootMessageId}`,
              ),
            ),
          )
          .then((rows) => rows[0]);
        if (!delivery) throw new Error("Discord delivery absent");
        await service.processPendingDeliveries(25, delivery.id);
        await qualifySetupRoundTrip(service, endpoint.id, externalUserId);
        await service.test(endpoint.id);
        const [conversation] = await service.listConversations(endpoint.id);
        const active = await service.get(endpoint.id);
        if (!conversation || !active.providerAccountId)
          throw new Error("Discord setup incomplete");
        expect(active.capabilities.modals).toBe(true);
        const linkedUserId = `discord-modal-${randomUUID()}`;
        const now = new Date();
        await db.insert(authUsers).values({
          id: linkedUserId,
          name: "Discord Modal Operator",
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
        const principal = await db
          .select()
          .from(chatExternalPrincipals)
          .where(
            and(
              eq(chatExternalPrincipals.companyId, fixture.companyId),
              eq(chatExternalPrincipals.provider, "discord"),
              eq(
                chatExternalPrincipals.providerAccountId,
                active.providerAccountId,
              ),
              eq(chatExternalPrincipals.externalId, externalUserId),
            ),
          )
          .then((rows) => rows[0]);
        if (!principal) throw new Error("Discord principal absent");
        const intent = await service.createLinkIntent(
          endpoint.id,
          principal.id,
          1800,
        );
        const linkToken = new URL(intent.confirmationUrl).searchParams.get(
          "token",
        )!;
        await service.confirmIdentityLink(linkToken, linkedUserId);
        const onAction = vi.fn(callbacks.onAction);
        const onModalSubmit = vi.fn(callbacks.onModalSubmit);
        const configuration = runtime.configurations.get(endpoint.id)!;
        pinned = createChatSdkEndpointRuntime({
          ...configuration,
          callbacks: { onMessage() {}, onAction, onModalSubmit },
          enableDiscordGateway: false,
          logger: "silent",
        });
        await pinned.initialize();
        const adapter = pinned.getProviderAdapter() as unknown as {
          handleGatewayInteraction(input: unknown): Promise<void>;
          fetchMessage(...args: unknown[]): Promise<unknown>;
          buildMessagePayload(input: unknown): {
            payload: Record<string, unknown>;
          };
        };
        // Provider HTTP/socket are the only transport doubles; modal source,
        // typed callback, token authorization, answers and wake ledger are real.
        adapter.fetchMessage = vi.fn().mockResolvedValue(null);
        const sourceRunId = randomUUID();
        await db.insert(heartbeatRuns).values({
          id: sourceRunId,
          companyId: fixture.companyId,
          agentId: fixture.assignedAgentId,
          status: "succeeded",
          contextSnapshot: {
            issueId: conversation.issueId,
            taskId: conversation.issueId,
            source: "automation",
          },
        });
        const interaction = await issueThreadInteractionService(db).create(
          { id: conversation.issueId, companyId: fixture.companyId },
          {
            kind: "ask_user_questions",
            continuationPolicy: "wake_assignee",
            sourceRunId,
            title: "Deployment details",
            payload: {
              version: 1,
              title: "Deployment details",
              questions: [
                {
                  id: "environment",
                  prompt: "Environment",
                  selectionMode: "single",
                  required: true,
                  allowOther: false,
                  options: [
                    { id: "staging", label: "Staging" },
                    { id: "production", label: "Production" },
                  ],
                },
                {
                  id: "note",
                  prompt: "Release note",
                  selectionMode: "single",
                  required: true,
                  allowOther: true,
                  options: [
                    {
                      id: "__paperclip_text__",
                      label: "Type an answer",
                      freeText: true,
                    },
                  ],
                },
              ],
              questionSet: {
                schema: "paperclip.question_set.v1",
                title: "Deployment details",
                questions: [
                  {
                    id: "environment",
                    prompt: "Environment",
                    required: true,
                    answerMode: "single_select",
                    options: [
                      { id: "staging", label: "Staging" },
                      { id: "production", label: "Production" },
                    ],
                  },
                  {
                    id: "note",
                    prompt: "Release note",
                    required: true,
                    answerMode: "text",
                    textValidation: { minLength: 3, maxLength: 4000 },
                  },
                ],
              },
            },
          },
          { agentId: fixture.assignedAgentId, runId: sourceRunId },
        );
        await service.processPendingPublications(1000);
        const publication = await db
          .select()
          .from(chatPublications)
          .where(
            and(
              eq(chatPublications.endpointId, endpoint.id),
              eq(chatPublications.issueId, conversation.issueId),
            ),
          )
          .then((rows) =>
            rows.find((row) => row.payload.interactionId === interaction.id),
          );
        if (!publication?.providerMessageId)
          throw new Error("Discord question not published");
        const open = publication.payload.card?.actions?.find(
          (action) =>
            action.type === "callback" && action.actionId.startsWith("pcf:"),
        );
        if (!open || open.type !== "callback")
          throw new Error("Native Discord form was not projected");
        type NativeModal = {
          custom_id: string;
          title: string;
          components: Array<{
            type: number;
            label: string;
            component: {
              type: number;
              custom_id: string;
              max_length?: number;
              value?: string;
              options?: Array<{
                label: string;
                value: string;
                default?: boolean;
              }>;
            };
          }>;
        };
        const click = (
          customId: string,
          id: string,
          message = publication.providerMessageId!,
        ) => ({
          applicationId: "123456789012345678",
          channel: { id: rootMessageId, parentId: channelId, type: 11 },
          channelId: rootMessageId,
          componentType: 2,
          customId,
          guildId,
          id,
          type: 3,
          version: 1,
          isChatInputCommand: () => false,
          isMessageComponent: () => true,
          isModalSubmit: () => false,
          message: { id: message },
          token: "synthetic-modal-token-never-persist",
          user: {
            id: externalUserId,
            username: "operator",
            globalName: "Operator",
            bot: false,
          },
          showModal: vi
            .fn<(modal: NativeModal) => Promise<void>>()
            .mockResolvedValue(undefined),
          deferUpdate: vi.fn().mockResolvedValue(undefined),
          reply: vi.fn().mockResolvedValue(undefined),
        });
        const first = click(
          `${open.actionId}\n${interaction.id}`,
          "777777777777777720",
        );
        wakeup.mockClear();
        await adapter.handleGatewayInteraction(first);
        expect(first.showModal).toHaveBeenCalledOnce();
        expect(first.deferUpdate).not.toHaveBeenCalled();
        const duplicateOpen = click(
          `${open.actionId}\n${interaction.id}`,
          first.id,
        );
        await adapter.handleGatewayInteraction(duplicateOpen);
        expect(duplicateOpen.showModal).not.toHaveBeenCalled();
        expect(duplicateOpen.deferUpdate).not.toHaveBeenCalled();
        expect(duplicateOpen.reply).not.toHaveBeenCalled();
        const uncertainOpen = click(
          `${open.actionId}\n${interaction.id}`,
          "777777777777777729",
        );
        uncertainOpen.showModal.mockRejectedValue(
          new Error("synthetic lost modal response"),
        );
        await adapter.handleGatewayInteraction(uncertainOpen);
        expect(uncertainOpen.showModal).toHaveBeenCalledOnce();
        expect(uncertainOpen.deferUpdate).not.toHaveBeenCalled();
        const uncertainReplay = click(
          `${open.actionId}\n${interaction.id}`,
          uncertainOpen.id,
        );
        await adapter.handleGatewayInteraction(uncertainReplay);
        expect(uncertainReplay.showModal).not.toHaveBeenCalled();
        expect(uncertainReplay.deferUpdate).not.toHaveBeenCalled();
        expect(uncertainReplay.reply).not.toHaveBeenCalled();
        const modal = first.showModal.mock.calls[0]![0];
        expect(modal.components).toHaveLength(2);
        const select = modal.components.find(
          (field) => field.component.type === 3,
        )!.component;
        const text = modal.components.find(
          (field) => field.component.type === 4,
        )!.component;
        expect(text.max_length).toBe(4000);
        const stagingValue = select.options!.find(
          (option) => option.label === "Staging",
        )!.value;
        const submission = (
          id: string,
          note: string,
          customId = modal.custom_id,
        ) => ({
          ...click(customId, id),
          type: 5,
          isMessageComponent: () => false,
          isModalSubmit: () => true,
          components: [
            {
              type: 18,
              component: {
                type: 3,
                customId: select.custom_id,
                values: [stagingValue],
              },
            },
            {
              type: 18,
              component: { type: 4, customId: text.custom_id, value: note },
            },
          ],
        });
        const invalid = submission("777777777777777721", "");
        await adapter.handleGatewayInteraction(invalid);
        expect(onModalSubmit).toHaveBeenCalledOnce();
        expect(onModalSubmit.mock.calls[0]![0].event.relatedThread?.id).toBe(
          threadId,
        );
        expect(invalid.showModal).not.toHaveBeenCalled();
        expect(invalid.reply).toHaveBeenCalledOnce();
        const correction = invalid.reply.mock.calls[0]![0] as {
          content: string;
          flags: number;
          components: Array<{ components: Array<{ custom_id: string }> }>;
        };
        expect(correction.content).toContain("Release note");
        expect(correction.content).not.toContain(text.custom_id);
        expect(correction.flags).toBe(64);
        const reopenId = correction.components[0]!.components[0]!.custom_id;
        expect(reopenId).toMatch(/^pcfr:[\w-]{43}$/);
        const readState = () =>
          db
            .select()
            .from(chatSdkState)
            .where(eq(chatSdkState.endpointId, endpoint.id));
        const invalidState = await readState();
        expect(JSON.stringify(invalidState)).not.toContain(first.token);
        expect(
          invalidState.filter((row) =>
            row.stateKey.startsWith("discord-question-correction:"),
          ),
        ).toHaveLength(1);

        // The correction button belongs to a different ephemeral message. It
        // must reauthorize the original published source and current actor.
        await db
          .update(companyMemberships)
          .set({ membershipRole: "viewer" })
          .where(
            and(
              eq(companyMemberships.companyId, fixture.companyId),
              eq(companyMemberships.principalId, linkedUserId),
            ),
          );
        const denied = click(
          reopenId,
          "777777777777777722",
          "888888888888888888",
        );
        await adapter.handleGatewayInteraction(denied);
        expect(denied.showModal).not.toHaveBeenCalled();
        expect(denied.deferUpdate).not.toHaveBeenCalled();
        expect(denied.reply).toHaveBeenCalledWith(
          expect.objectContaining({
            flags: 64,
            content: expect.stringContaining("no longer available"),
          }),
        );
        await db
          .update(companyMemberships)
          .set({ membershipRole: "operator" })
          .where(
            and(
              eq(companyMemberships.companyId, fixture.companyId),
              eq(companyMemberships.principalId, linkedUserId),
            ),
          );
        const wrongThread = click(
          reopenId,
          "777777777777777730",
          "888888888888888888",
        );
        wrongThread.channelId = "555555555555555999";
        wrongThread.channel.id = wrongThread.channelId;
        await adapter.handleGatewayInteraction(wrongThread);
        expect(wrongThread.showModal).not.toHaveBeenCalled();
        expect(wrongThread.deferUpdate).not.toHaveBeenCalled();
        const wrongActor = click(
          reopenId,
          "777777777777777731",
          "888888888888888888",
        );
        wrongActor.user.id = "444444444444444999";
        await adapter.handleGatewayInteraction(wrongActor);
        expect(wrongActor.showModal).not.toHaveBeenCalled();
        await db
          .update(chatPublications)
          .set({ providerMessageId: "999999999999999999" })
          .where(eq(chatPublications.id, publication.id));
        const changedSource = click(
          reopenId,
          "777777777777777732",
          "888888888888888888",
        );
        await adapter.handleGatewayInteraction(changedSource);
        expect(changedSource.showModal).not.toHaveBeenCalled();
        expect(changedSource.deferUpdate).not.toHaveBeenCalled();
        await db
          .update(chatPublications)
          .set({ providerMessageId: publication.providerMessageId })
          .where(eq(chatPublications.id, publication.id));
        const reopened = click(
          reopenId,
          "777777777777777723",
          "888888888888888888",
        );
        await adapter.handleGatewayInteraction(reopened);
        expect(reopened.showModal).toHaveBeenCalledOnce();
        expect(reopened.deferUpdate).not.toHaveBeenCalled();
        const edited = reopened.showModal.mock.calls[0]![0];
        expect(
          edited.components[0]!.component.options?.find(
            (option) => option.default,
          )?.value,
        ).toBe(stagingValue);
        expect(edited.components[1]!.component.value).toBe("");
        expect(edited.custom_id.split(":").slice(0, 2).join(":")).toBe(
          modal.custom_id.split(":").slice(0, 2).join(":"),
        );
        const corrected = submission(
          "777777777777777724",
          "Ship safely",
          edited.custom_id,
        );
        corrected.message.id = "888888888888888888";
        const competingOpen = click(
          `${open.actionId}\n${interaction.id}`,
          "777777777777777734",
        );
        await adapter.handleGatewayInteraction(competingOpen);
        expect(competingOpen.showModal).toHaveBeenCalledOnce();
        const competingText =
          concurrentMode === "identical" ? "Ship safely" : "Ship Friday";
        const competing = submission(
          "777777777777777735",
          competingText,
          competingOpen.showModal.mock.calls[0]![0].custom_id,
        );
        cleanupSpy = vi
          .spyOn(discordQuestionForms, "deleteDiscordQuestionFormCorrection")
          .mockRejectedValueOnce(new Error("synthetic draft cleanup failure"));
        holdConcurrentAnswers = true;
        await Promise.all([
          adapter.handleGatewayInteraction(corrected),
          adapter.handleGatewayInteraction(competing),
        ]);
        expect(answerWaiters).toBe(2);
        expect(cleanupSpy).toHaveBeenCalledTimes(
          concurrentMode === "identical" ? 2 : 1,
        );
        const [answered] = await db
          .select()
          .from(issueThreadInteractions)
          .where(eq(issueThreadInteractions.id, interaction.id));
        const winnerText = (
          answered!.result as {
            answers: Array<{ questionId: string; otherText?: string }>;
          }
        ).answers.find((answer) => answer.questionId === "note")!.otherText!;
        expect(["Ship safely", competingText]).toContain(winnerText);
        for (const [callback, submittedText] of [
          [corrected, "Ship safely"],
          [competing, competingText],
        ] as const) {
          expect(callback.reply).toHaveBeenCalledOnce();
          expect(callback.reply.mock.calls[0]![0].content).toBe(
            submittedText === winnerText
              ? "Your response was received."
              : "This response was not accepted. Open the linked Paperclip task or reopen the question to try again.",
          );
        }
        expect(answered).toMatchObject({
          status: "answered",
          resolvedByUserId: linkedUserId,
          result: {
            answers: [
              { questionId: "environment", optionIds: ["staging"] },
              { questionId: "note", optionIds: [], otherText: winnerText },
            ],
          },
        });
        await vi.waitFor(async () => {
          const [response] = await db
            .select()
            .from(issueQuestionResponseDeliveries)
            .where(
              eq(issueQuestionResponseDeliveries.interactionId, interaction.id),
            );
          expect(response?.status).toBe("fallback_queued");
        });
        const continuationWakeCount = wakeup.mock.calls.filter(
          ([, options]) =>
            options.contextSnapshot?.source === "issue.interaction.respond",
        ).length;
        expect(continuationWakeCount).toBe(1);
        expect(
          (await readState()).filter((row) =>
            row.stateKey.startsWith("discord-question-correction:"),
          ),
        ).toHaveLength(concurrentMode === "identical" ? 0 : 1);
        const duplicate = submission(
          "777777777777777725",
          winnerText,
          edited.custom_id,
        );
        await adapter.handleGatewayInteraction(duplicate);
        expect(
          onModalSubmit.mock.calls.at(-1)![0].event.relatedThread,
        ).toBeUndefined();
        expect(duplicate.reply).toHaveBeenCalledWith(
          expect.objectContaining({ content: "Your response was received." }),
        );
        expect(
          (await readState()).filter((row) =>
            row.stateKey.startsWith("discord-question-correction:"),
          ),
        ).toHaveLength(0);
        expect(
          wakeup.mock.calls.filter(
            ([, options]) =>
              options.contextSnapshot?.source === "issue.interaction.respond",
          ),
        ).toHaveLength(1);
        const differentAnswer = submission(
          "777777777777777733",
          "Ship something else",
          edited.custom_id,
        );
        await adapter.handleGatewayInteraction(differentAnswer);
        expect(differentAnswer.reply).toHaveBeenCalledWith(
          expect.objectContaining({
            content: expect.stringContaining("not accepted"),
            flags: 64,
          }),
        );
        expect(differentAnswer.reply.mock.calls[0]![0]).not.toHaveProperty(
          "components",
        );
        expect(
          wakeup.mock.calls.filter(
            ([, options]) =>
              options.contextSnapshot?.source === "issue.interaction.respond",
          ),
        ).toHaveLength(1);
        const stale = click(
          reopenId,
          "777777777777777726",
          "888888888888888888",
        );
        await adapter.handleGatewayInteraction(stale);
        expect(stale.showModal).not.toHaveBeenCalled();
        expect(stale.deferUpdate).not.toHaveBeenCalled();
        const unknown = submission(
          "777777777777777727",
          "Ship safely",
          `pcfs:${"Z".repeat(22)}:${randomUUID()}`,
        );
        await adapter.handleGatewayInteraction(unknown);
        expect(unknown.reply).toHaveBeenCalledWith(
          expect.objectContaining({
            content: expect.stringContaining("not accepted"),
            flags: 64,
          }),
        );
        expect(unknown.reply.mock.calls[0]![0]).not.toHaveProperty(
          "components",
        );
        // Scheduler is simulated: this proves wake_fallback exactly once, not a
        // model turn or a live Discord login/modal interaction.
      } finally {
        releaseAnswers();
        cleanupSpy?.mockRestore();
        try {
          await pinned?.shutdown();
        } finally {
          await retirePublicationFixture(service, endpoint.id);
        }
      }
    },
  );

  it.each([
    "warm",
    "cold",
    "failed initialization",
    "stale generation",
    "disabled connection",
  ])(
    "automatically enables native modals for an existing Discord endpoint after %s runtime qualification",
    async (mode) => {
      const fixture = await seedCompany();
      const configured = await configuredDiscordEndpoint(fixture);
      const { endpoint } = configured;
      let { runtime, service } = configured;
      try {
        const [current] = await readChatEndpointsById(endpoint.id);
        await db
          .update(chatEndpoints)
          .set({ capabilities: { ...current!.capabilities, modals: false } })
          .where(eq(chatEndpoints.id, endpoint.id));
        const [before] = await readChatEndpointsById(endpoint.id);
        const [connectionBefore] = await readToolConnectionsById(before!.connectionId);
        const resourcesBefore = await db
          .select()
          .from(chatEndpointResources)
          .where(eq(chatEndpointResources.endpointId, endpoint.id));
        const instance = runtime.endpoints.get(endpoint.id);
        if (mode !== "warm") {
          const config = runtime.configurations.get(
            endpoint.id,
          )!.providerConfig;
          if (config.provider !== "discord")
            throw new Error("Discord configuration absent");
          await service.shutdown();
          ({ runtime, service } = createService(
            new FakeChatSdkRuntime(),
            fakeDiscordFetch(
              config.credentials.applicationId,
            ) as typeof globalThis.fetch,
          ));
        }
        let targetInitializations = 0;
        if (mode === "failed initialization")
          runtime.initializeHook = async (initializingEndpointId) => {
            if (initializingEndpointId !== endpoint.id) return;
            targetInitializations += 1;
            throw new Error("synthetic initialization failed");
          };
        if (mode === "stale generation")
          runtime.initializeHook = async (initializingEndpointId) => {
            if (initializingEndpointId !== endpoint.id) return;
            targetInitializations += 1;
            await db
              .update(chatEndpoints)
              .set({
                setup: {
                  ...before!.setup,
                  runtimeGeneration:
                    Number((before!.setup as InternalSetupState).runtimeGeneration ?? 0) + 1,
                } as InternalSetupState,
              })
              .where(eq(chatEndpoints.id, endpoint.id));
          };
        if (mode === "disabled connection")
          runtime.initializeHook = async (initializingEndpointId) => {
            if (initializingEndpointId !== endpoint.id) return;
            targetInitializations += 1;
            await db
              .update(toolConnections)
              .set({ enabled: false })
              .where(eq(toolConnections.id, before!.connectionId));
          };
        await service.reconcileProviderRuntimes();
        if (mode !== "warm" && mode !== "cold")
          expect(targetInitializations).toBe(1);
        const [after] = await readChatEndpointsById(endpoint.id);
        expect(after!.capabilities.modals).toBe(
          mode === "warm" || mode === "cold",
        );
        expect({
          ...after,
          updatedAt: before!.updatedAt,
          capabilities: before!.capabilities,
          ...(mode === "stale generation" ? { setup: before!.setup } : {}),
        }).toEqual(before);
        const [connectionAfter] = await readToolConnectionsById(before!.connectionId);
        expect({
          ...connectionAfter,
          updatedAt: connectionBefore!.updatedAt,
          ...(mode === "disabled connection"
            ? { enabled: connectionBefore!.enabled }
            : {}),
        }).toEqual(connectionBefore);
        expect(
          await db
            .select()
            .from(chatEndpointResources)
            .where(eq(chatEndpointResources.endpointId, endpoint.id)),
        ).toEqual(resourcesBefore);
        if (mode === "warm")
          expect(runtime.endpoints.get(endpoint.id)).toBe(instance);
        if (mode === "warm" || mode === "cold")
          expect(
            runtime.configurations.get(endpoint.id)!.callbacks.onModalSubmit,
          ).toBeTypeOf("function");
      } finally {
        try {
          await service.shutdown();
        } finally {
          await db
            .update(chatEndpoints)
            .set({ status: "paused" })
            .where(eq(chatEndpoints.id, endpoint.id));
        }
      }
    },
  );

  it.for(["retired runtime", "replaced runtime", "changed credentials"])(
    "does not enable Discord modals after a connection-lock wait with %s",
    async (mode, { signal }) => {
      const fixture = await seedCompany();
      const { endpoint, runtime, service } =
        await configuredDiscordEndpoint(fixture);
      let reconciliation: Promise<unknown> | undefined;
      let transactionSpy: ReturnType<typeof vi.spyOn> | undefined;
      let releaseModalQuery!: () => void;
      const modalQueryGate = new Promise<void>((resolve) => {
        releaseModalQuery = resolve;
      });
      let resolveModalQuery!: (value: { pid: number; query: string }) => void;
      let rejectModalQuery!: (error: unknown) => void;
      const modalQueryReady = new Promise<{ pid: number; query: string }>(
        (resolve, reject) => {
          resolveModalQuery = resolve;
          rejectModalQuery = reject;
        },
      );
      // Readiness shares the existing test deadline; a timeout must also
      // release the intercepted statement so reconciliation can settle.
      const abort = () => {
        rejectModalQuery(signal.reason);
        releaseModalQuery();
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        const [before] = await readChatEndpointsById(endpoint.id);
        await db
          .update(chatEndpoints)
          .set({ capabilities: { ...before!.capabilities, modals: false } })
          .where(eq(chatEndpoints.id, endpoint.id));
        const original = runtime.get(endpoint.id);
        expect(original).not.toBeNull();
        const originalTransaction = db.transaction.bind(db);
        type ObservedSession = {
          prepareQuery(...args: unknown[]): {
            execute(...args: unknown[]): Promise<unknown>;
          };
        };
        let capturedModalQuery = false;
        transactionSpy = vi.spyOn(db, "transaction").mockImplementation((async (
          ...args: Parameters<typeof originalTransaction>
        ) => {
          const [callback, config] = args;
          return originalTransaction(async (tx) => {
            const session = (tx as unknown as { session: ObservedSession })
              .session;
            const prepareQuery = session.prepareQuery;
            session.prepareQuery = (...queryArgs) => {
              const query = queryArgs[0] as {
                sql: string;
                params: unknown[];
              };
              const prepared = prepareQuery.apply(session, queryArgs);
              const execute = prepared.execute.bind(prepared);
              prepared.execute = async (...executeArgs) => {
                if (
                  !capturedModalQuery &&
                  query.sql.startsWith(
                    'select "enabled", "status", "credential_secret_refs" from "tool_connections"',
                  ) &&
                  query.sql.endsWith("for no key update") &&
                  query.params.length === 2 &&
                  query.params[0] === fixture.companyId &&
                  query.params[1] === before!.connectionId
                ) {
                  capturedModalQuery = true;
                  const [backend] = (await tx.execute(
                    sql`select pg_backend_pid() as pid`,
                  )) as unknown as Array<{ pid: number }>;
                  resolveModalQuery({ pid: backend!.pid, query: query.sql });
                  await modalQueryGate;
                  signal.throwIfAborted();
                }
                return execute(...executeArgs);
              };
              return prepared;
            };
            try {
              return await callback(tx);
            } finally {
              session.prepareQuery = prepareQuery;
            }
          }, config);
        }) as typeof db.transaction);
        // Do not hold the connection during the preceding database-wide
        // runtime/command sweep: command authorization locks it too. Stop
        // only at the exact modal-upgrade query after runtime qualification.
        reconciliation = service.reconcileProviderRuntimes();
        void reconciliation.then(
          () =>
            rejectModalQuery(new Error("Modal upgrade query was not reached")),
          rejectModalQuery,
        );
        const modalQuery = await modalQueryReady;
        await db.transaction(async (tx) => {
          await tx
            .select()
            .from(toolConnections)
            .where(eq(toolConnections.id, before!.connectionId))
            .for("no key update");
          const [backend] = (await tx.execute(
            sql`select pg_backend_pid() as pid`,
          )) as unknown as Array<{ pid: number }>;
          expect(modalQuery.pid).not.toBe(backend!.pid);
          releaseModalQuery();
          await vi.waitFor(async () => {
            const [state] = (await db.execute(sql`select exists (
                select 1 from pg_stat_activity where pid = ${modalQuery.pid}
                  and datname = current_database()
                  and ${backend!.pid} = any(pg_blocking_pids(pid))
                  and query = ${modalQuery.query}
              ) as waiting`)) as unknown as Array<{ waiting: boolean }>;
            expect(state!.waiting).toBe(true);
          });
          // The actual upgrade has already qualified this runtime and now
          // waits for this exact connection lock. No provider call is mocked.
          expect(runtime.get(endpoint.id)).toBe(original);
          if (mode === "changed credentials") {
            await tx
              .update(toolConnections)
              .set({ credentialSecretRefs: [] })
              .where(eq(toolConnections.id, before!.connectionId));
          } else {
            await runtime.removeEndpoint(endpoint.id);
            if (mode === "replaced runtime") {
              await runtime.replaceEndpoint(
                runtime.configurations.get(endpoint.id)!,
              );
              expect(runtime.get(endpoint.id)).not.toBe(original);
            }
          }
        });
        await reconciliation;
        const [after] = await readChatEndpointsById(endpoint.id);
        expect(after!.capabilities.modals).toBe(false);
        expect({
          ...after,
          updatedAt: before!.updatedAt,
          capabilities: before!.capabilities,
        }).toEqual(before);
      } finally {
        releaseModalQuery();
        await reconciliation?.catch(() => undefined);
        transactionSpy?.mockRestore();
        signal.removeEventListener("abort", abort);
        await retirePublicationFixture(service, endpoint.id);
      }
    },
  );

  it("orders rapid Discord replies by provider time before waking one task", async () => {
    const fixture = await seedCompany();
    const deferred: Array<() => void> = [];
    const { callbacks, endpoint, service, wakeup } =
      await configuredDiscordEndpoint(fixture, {
        deferWebhookProcessing: true,
        scheduleDeferredWork: (task) => deferred.push(task),
      });
    try {
      const guildId = "1457808928258658549";
      const channelId = "333333333333333333";
      const rootMessageId = "555555555555555620";
      const threadId = `discord:${guildId}:${channelId}:${rootMessageId}`;
      const channel = makeThread({
        channelId,
        id: threadId,
        name: "discord-rapid-replies",
      });
      const admitRootMention = callbacks.onDiscordRootMentionAdmission;
      if (!admitRootMention) {
        throw new Error("Expected Discord root-mention admission callback");
      }
      await expect(
        admitRootMention({
          endpointId: endpoint.id,
          guildId,
          channelId,
          messageId: rootMessageId,
          message: {
            ...makeMessage({
              id: rootMessageId,
              text: "@maya create a queued reply test",
              mentioned: true,
              userId: "444444444444444420",
            }),
            threadId,
          } as Message,
          threadId,
          userId: "444444444444444420",
        }),
      ).resolves.toBe(false);
      const [rootDelivery] = await db
        .select({ id: chatDeliveries.id })
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(chatDeliveries.providerEventId, `${threadId}:${rootMessageId}`),
          ),
        );
      if (!rootDelivery) throw new Error("Expected Discord root delivery");
      await service.processPendingDeliveries(25, rootDelivery.id);
      const [conversation] = await service.listConversations(endpoint.id);
      if (!conversation) throw new Error("Expected Discord conversation");
      await db
        .update(chatEndpoints)
        .set({ status: "active" })
        .where(eq(chatEndpoints.id, endpoint.id));
      wakeup.mockClear();
      deferred.length = 0;

      const providerSentAt = new Date("2026-09-06T22:30:00.000Z");
      const laterReply = makeMessage({
        id: "555555555555555622",
        text: "second rapid Discord reply",
        userId: "444444444444444420",
      });
      laterReply.metadata.dateSent = providerSentAt;
      const earlierReply = makeMessage({
        id: "555555555555555621",
        text: "first rapid Discord reply",
        userId: "444444444444444420",
      });
      earlierReply.metadata.dateSent = providerSentAt;
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider: "discord",
        thread: channel.thread,
        message: laterReply,
        trigger: "subscribed_message",
      });
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider: "discord",
        thread: channel.thread,
        message: earlierReply,
        trigger: "subscribed_message",
      });
      const rapidIds = [
        `${threadId}:${earlierReply.id}`,
        `${threadId}:${laterReply.id}`,
      ];
      const rapidDeliveries = await db
        .select()
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            inArray(chatDeliveries.providerEventId, rapidIds),
          ),
        );
      expect(rapidDeliveries).toHaveLength(2);
      expect(rapidDeliveries.every((row) => row.state === "received")).toBe(
        true,
      );
      await db
        .update(chatDeliveries)
        .set({ nextAttemptAt: new Date(0) })
        .where(inArray(chatDeliveries.providerEventId, rapidIds));
      await service.processPendingDeliveries(1_000);

      const comments = await db
        .select({ id: issueComments.id, body: issueComments.body })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.issueId, conversation.issueId),
            inArray(issueComments.body, [earlierReply.text, laterReply.text]),
          ),
        )
        .orderBy(asc(issueComments.createdAt), asc(issueComments.id));
      expect(comments.map((comment) => comment.body)).toEqual([
        earlierReply.text,
        laterReply.text,
      ]);
      expect(wakeup).toHaveBeenCalledTimes(2);
      expect(
        wakeup.mock.calls.map((call) => call[1]?.payload?.wakeCommentId),
      ).toEqual(comments.map((comment) => comment.id));
    } finally {
      await service.shutdown();
    }
  });
});
