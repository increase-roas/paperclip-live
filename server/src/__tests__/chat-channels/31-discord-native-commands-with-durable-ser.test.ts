import { nativeChatProgressWork } from "../../services/chat-native-progress-work.js";
import { cloudActorHeaderSourceFromHeaders, resolveCloudTenantActor } from "../../middleware/auth.js";
import { cloudTenantPrimaryCompanyId } from "../../services/cloud-instance.js";
import { accessService } from "../../services/access.js";
import { agentWakeupRequests, authUsers, chatActions, chatConversations, chatDeliveries, chatDiscordCommandOwners, chatEndpointLeases, chatEndpointResources, chatEndpoints, chatExternalPrincipals, chatIdentityLinks, chatPublications, companyMemberships, heartbeatRunEvents, heartbeatRuns, issueComments, issues, joinRequests, subscribeDatabaseWork, toolConnections } from "@paperclipai/db";
import { idleWorkSnapshot } from "../../services/task-admission.js";
import { chatRunMilestoneWork } from "../../services/chat-run-milestone-work.js";
import { createDeliveryWorkCoordinator } from "../../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../../services/delivery-work-notifications.js";
import { toolAccessService } from "../../services/tool-access.js";
import { randomUUID } from "node:crypto";
import request, {  } from "supertest";
import { and, asc, eq, inArray, like, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { Message, Thread } from "chat";
import type { InternalSetupState } from "../../services/chat-channels/runtime-types.js";
import { issueService } from "../../services/issues.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { enqueueChatRunMilestones, resolveChatRunPresentationAuthorizationReason } from "../../services/chat-run-publications.js";
import { makeMessage, makeThread, routesApp } from ".././helpers/chat-channels-fixture.js";
import {
addSelectedChatFinal, chatWakeContext, configuredSlackEndpoint, db, deliverMessage, describeChatChannelsSuite, readChatActionsByProviderActionId, readChatConversationsById, readChatEndpointsById, readChatPublicationsByCommentId, seedCompany, waitForProcessedReceiptRemoval
} from "../helpers/chat-channels-harness.js";
import {
channelId, commandFixture, externalUserId, guildId, rootMessageId
} from "../helpers/chat-channels-provider-fixtures.js";










describeChatChannelsSuite("chat channels 31-discord-native-commands-with-durable-ser", () => {
  describe("Discord native commands with durable service authority", () => {

    it.each(["working", "final", "unknown_final", "card"] as const)(
      "qualifies pinned Discord close-owned progress retirement (%s)",
      async (mode) => {
        const f = await commandFixture();
        try {
          // The setup root can still have a retryable wake after a concurrent
          // fixture drain. Start this run from a fresh, actually accepted
          // request and prove its receipt exists before testing its removal.
          const sourceMessageId = (
            ((BigInt(Date.now()) - 1420070400000n) << 22n) +
            1n
          ).toString();
          const sourceThread = makeThread({
            id: f.conversation.externalThreadId,
            channelId: f.conversation.externalConversationId,
            name: "Close-owned progress qualification",
          });
          await deliverMessage({
            callbacks: f.callbacks,
            endpointId: f.endpoint.id,
            provider: "discord",
            thread: sourceThread.thread,
            message: makeMessage({
              id: sourceMessageId,
              text: "Work on this request while I test closing the conversation",
              userId: externalUserId,
            }),
            trigger: "subscribed_message",
          });
          const [sourceDelivery] = await db
            .select({ id: chatDeliveries.id, state: chatDeliveries.state })
            .from(chatDeliveries)
            .where(
              and(
                eq(chatDeliveries.endpointId, f.endpoint.id),
                sql`${chatDeliveries.normalizedEvent}->'message'->>'providerMessageId' = ${sourceMessageId}`,
              ),
            );
          expect(sourceDelivery?.state).toBe("processed");
          await expect(
            db
              .select({ status: chatActions.status })
              .from(chatActions)
              .where(
                and(
                  eq(chatActions.endpointId, f.endpoint.id),
                  eq(chatActions.deliveryId, sourceDelivery!.id),
                  eq(chatActions.kind, "inbound_wakeup"),
                ),
              ),
          ).resolves.toEqual([{ status: "processed" }]);
          await expect(
            db
              .select({ status: chatActions.status })
              .from(chatActions)
              .where(
                and(
                  eq(chatActions.endpointId, f.endpoint.id),
                  eq(
                    chatActions.providerActionId,
                    `receipt_reaction:${sourceDelivery!.id}`,
                  ),
                ),
              ),
          ).resolves.toEqual([{ status: "processed" }]);
          const runId = randomUUID();
          await db.insert(heartbeatRuns).values({
            id: runId,
            companyId: f.fixture.companyId,
            agentId: f.fixture.assignedAgentId,
            status: "running",
            contextSnapshot: await chatWakeContext({
              endpointId: f.endpoint.id,
              issueId: f.conversation.issueId,
              provider: "discord",
              providerMessageId: sourceMessageId,
            }),
          });
          const [progress] = await db
            .insert(chatPublications)
            .values({
              companyId: f.fixture.companyId,
              endpointId: f.endpoint.id,
              conversationId: f.conversation.id,
              issueId: f.conversation.issueId,
              idempotencyKey: `run:${runId}:working:${f.endpoint.id}`,
              payload: { text: "Maya is working…", progressState: "working" },
              state: "pending",
            })
            .returning();
          await f.service.processPendingPublications();
          const runtime = f.runtime.endpoints.get(f.endpoint.id)!;
          const progressMessageId = await db
            .select({ id: chatPublications.providerMessageId })
            .from(chatPublications)
            .where(eq(chatPublications.id, progress.id))
            .then((rows) => rows[0]!.id!);
          if (mode === "final") {
            await addSelectedChatFinal({
              agentId: f.fixture.assignedAgentId,
              body: "The Discord final must remain",
              companyId: f.fixture.companyId,
              issueId: f.conversation.issueId,
              runId,
            });
            await f.service.processPendingPublications();
          }
          if (mode === "card")
            await db
              .update(chatPublications)
              .set({
                payload: {
                  ...progress.payload,
                  card: { schema: "paperclip.chat.card.v1", kind: "status", title: "Not a plain progress lane" },
                },
              })
              .where(eq(chatPublications.id, progress.id));
          const command = f.interaction("close");
          await f.adapter.handleGatewayInteraction(command);
          const close = (await f.publications()).find((publication) =>
            publication.idempotencyKey.startsWith("control:close:"),
          )!;
          expect(close).toBeDefined();
          if (mode === "unknown_final") {
            const final = await addSelectedChatFinal({
              agentId: f.fixture.assignedAgentId,
              body: "Possibly delivered Discord final",
              companyId: f.fixture.companyId,
              issueId: f.conversation.issueId,
              runId,
            });
            await db
              .update(chatPublications)
              .set({
                state: "delivery_unknown",
                createdAt: new Date(close.createdAt.getTime() + 1000),
              })
              .where(eq(chatPublications.commentId, final.id));
          }
          const editCount = runtime.edits.length,
            postCount = runtime.posts.length;
          await f.service.processPendingPublications();
          await f.service.processPendingReceiptReactions();
          expect(runtime.edits).toHaveLength(
            editCount + (mode === "working" ? 1 : 0),
          );
          expect(runtime.posts).toHaveLength(
            postCount + (mode === "working" ? 0 : 1),
          );
          if (mode === "working") {
            expect(runtime.edits.at(-1)).toMatchObject({
              messageId: progressMessageId,
              text: close.payload.text,
            });
            await waitForProcessedReceiptRemoval(f.endpoint.id, {
              threadId: f.conversation.externalThreadId,
              messageId: sourceMessageId,
              emoji: "eyes",
            });
            expect(runtime.removedReactions).toContainEqual({
              threadId: f.conversation.externalThreadId,
              messageId: sourceMessageId,
              emoji: "eyes",
            });
          }
          await expect(
            db
              .select({ status: heartbeatRuns.status })
              .from(heartbeatRuns)
              .where(eq(heartbeatRuns.id, runId)),
          ).resolves.toEqual([{ status: "running" }]);
          await f.adapter.handleGatewayInteraction(command);
          await f.service.processPendingPublications();
          expect(runtime.edits).toHaveLength(
            editCount + (mode === "working" ? 1 : 0),
          );
        } finally {
          await f.close();
        }
      },
    );

    it("answers a cold unavailable Discord command privately without leaving the interaction thinking", async () => {
      const f = await commandFixture();
      try {
        const cold = await f.coldUnavailableParser();
        const beforeActions = await f.actions();
        const beforePublications = await f.publications();
        const command = f.interaction("close");
        await cold.adapter.handleGatewayInteraction(command);
        expect
          .soft(command.deferReply)
          .toHaveBeenCalledExactlyOnceWith({ flags: 64 });
        expect(command.editReply).toHaveBeenCalledExactlyOnceWith({
          content: expect.stringContaining(
            "This command is not available here",
          ),
          allowedMentions: { parse: [] },
        });
        expect(await f.actions()).toEqual(beforeActions);
        expect(await f.publications()).toEqual(beforePublications);
        expect(cold.wakeup).not.toHaveBeenCalled();
        expect(
          (
            await readChatConversationsById(f.conversation.id)
          )[0]?.state,
        ).toBe("active");
      } finally {
        await f.close();
      }
    });

    it("upgrades a retained prior-copy registration after service restart before admitting close", async () => {
      const f = await commandFixture();
      try {
        const cold = await f.coldUnavailableParser(true);
        expect(
          f.registrationCalls.filter((method) => method === "POST"),
        ).toHaveLength(1);
        expect(
          f.registrationCalls.filter((method) => method === "PATCH"),
        ).toHaveLength(1);
        const command = f.interaction("close");
        await cold.adapter.handleGatewayInteraction(command);
        expect(command.editReply).toHaveBeenCalledExactlyOnceWith({
          content: expect.stringContaining("request recorded"),
          allowedMentions: { parse: [] },
        });
        expect(await f.actions()).toHaveLength(1);
        expect(await f.publications()).toHaveLength(1);
        expect(cold.wakeup).not.toHaveBeenCalled();
        await cold.service.processPendingPublications(100);
        expect((await f.publications())[0]?.state).toBe("published");
        expect(
          (
            await readChatConversationsById(f.conversation.id)
          )[0]?.state,
        ).toBe("completed");
      } finally {
        await f.close();
      }
    });

    it("returns private status, keeps guild new as guidance, and closes only after a real public control receipt", async () => {
      const f = await commandFixture();
      try {
        const wakeCount = f.wakeup.mock.calls.length;
        const status = f.interaction("status");
        await f.adapter.handleGatewayInteraction(status);
        expect(status.deferReply).toHaveBeenCalledWith({ flags: 64 });
        expect(status.editReply).toHaveBeenCalledWith(
          expect.objectContaining({
            content: expect.stringContaining(f.conversation.issueIdentifier!),
            allowedMentions: { parse: [] },
          }),
        );
        expect(await f.publications()).toHaveLength(0);
        const newCommand = f.interaction("new");
        await f.adapter.handleGatewayInteraction(newCommand);
        expect(newCommand.editReply).toHaveBeenCalledWith(
          expect.objectContaining({
            content: expect.stringContaining("new Discord thread"),
          }),
        );
        expect(await f.publications()).toHaveLength(0);
        const close = f.interaction("close");
        await f.adapter.handleGatewayInteraction(close);
        expect(close.editReply).toHaveBeenCalledWith(
          expect.objectContaining({
            content: expect.stringContaining("recorded"),
          }),
        );
        const [publication] = await f.publications();
        expect(publication).toMatchObject({
          state: "pending",
          conversationId: f.conversation.id,
          issueId: f.conversation.issueId,
        });
        expect(publication.idempotencyKey).toMatch(/^control:close:/);
        expect(
          (
            await readChatConversationsById(f.conversation.id)
          )[0]?.state,
        ).toBe("active");
        expect(await f.actions()).toHaveLength(3);
        expect(f.wakeup).toHaveBeenCalledTimes(wakeCount);
        await f.service.processPendingPublications(100);
        expect((await f.publications())[0]).toMatchObject({
          state: "published",
        });
        expect(
          (
            await readChatConversationsById(f.conversation.id)
          )[0]?.state,
        ).toBe("completed");
        // Fresh adapter removes only process-local ACK suppression. The real
        // service must replay the exact durable action, not stage another close
        // or infer a replacement conversation from its now-completed target.
        const replayAdapter = await f.parser();
        const replay = f.interaction("close", { id: close.id });
        await replayAdapter.handleGatewayInteraction(replay);
        expect(replay.editReply).toHaveBeenCalledWith(
          expect.objectContaining({
            content: expect.stringContaining("recorded"),
          }),
        );
        expect(await f.actions()).toHaveLength(3);
        expect(await f.publications()).toHaveLength(1);
        expect(await f.service.listConversations(f.endpoint.id)).toHaveLength(
          1,
        );
        expect(JSON.stringify(await f.actions())).not.toContain(
          "synthetic-command-interaction-token",
        );
      } finally {
        await f.close();
      }
    });

    it.each([
      "missing owner",
      "unconfirmed registration",
      "disabled capability",
      "altered origin fence",
      "viewer",
      "disabled reach",
      "disabled connection",
      "stale generation",
      "replaced Gateway lease",
    ] as const)(
      "denies a previously accepted command after %s without another action or public receipt",
      async (reason) => {
        const f = await commandFixture();
        try {
          const first = f.interaction("status");
          await f.adapter.handleGatewayInteraction(first);
          expect(first.editReply).toHaveBeenCalledWith(
            expect.objectContaining({
              content: expect.stringContaining(f.conversation.issueIdentifier!),
            }),
          );
          const before = await f.actions();
          expect(before).toHaveLength(1);
          const current = await readChatEndpointsById(f.endpoint.id)
            .then((rows) => rows[0]!);
          if (reason === "missing owner")
            await db
              .delete(chatDiscordCommandOwners)
              .where(
                eq(chatDiscordCommandOwners.applicationId, f.applicationId),
              );
          if (reason === "unconfirmed registration")
            await db
              .update(chatActions)
              .set({ result: { outcome: "unknown" } })
              .where(
                and(
                  eq(chatActions.endpointId, f.endpoint.id),
                  eq(chatActions.kind, "discord_command_registration"),
                ),
              );
          if (reason === "disabled capability")
            await db
              .update(chatEndpoints)
              .set({
                capabilities: { ...current.capabilities, slashCommands: false },
              })
              .where(eq(chatEndpoints.id, current.id));
          if (reason === "altered origin fence")
            await db
              .update(chatActions)
              .set({
                payload: {
                  ...before[0]!.payload,
                  runtimeFence: {
                    ...(before[0]!.payload.runtimeFence as object),
                    generation: 999999,
                  },
                },
              })
              .where(eq(chatActions.id, before[0]!.id));
          if (reason === "viewer")
            await db
              .update(companyMemberships)
              .set({ membershipRole: "viewer" })
              .where(
                and(
                  eq(companyMemberships.companyId, f.fixture.companyId),
                  eq(companyMemberships.principalId, "owner-user"),
                ),
              );
          if (reason === "disabled reach")
            await db
              .update(chatEndpointResources)
              .set({ enabled: false })
              .where(
                and(
                  eq(chatEndpointResources.endpointId, f.endpoint.id),
                  eq(chatEndpointResources.providerResourceId, channelId),
                ),
              );
          if (reason === "disabled connection")
            await db
              .update(toolConnections)
              .set({ enabled: false })
              .where(eq(toolConnections.id, current.connectionId));
          if (reason === "stale generation")
            await db
              .update(chatEndpoints)
              .set({
                setup: {
                  ...current.setup,
                  runtimeGeneration:
                    Number((current.setup as InternalSetupState).runtimeGeneration ?? 0) + 1,
                } as InternalSetupState,
              })
              .where(eq(chatEndpoints.id, current.id));
          if (reason === "replaced Gateway lease")
            await db
              .update(chatEndpointLeases)
              .set({ token: randomUUID() })
              .where(
                and(
                  eq(chatEndpointLeases.endpointId, f.endpoint.id),
                  eq(chatEndpointLeases.leaseKey, "discord_gateway_runtime"),
                ),
              );
          const afterRevocation = await f.actions();
          const replay = f.interaction("status", { id: first.id });
          await (await f.parser()).handleGatewayInteraction(replay);
          expect(replay.deferReply).toHaveBeenCalledExactlyOnceWith({
            flags: 64,
          });
          expect(replay.editReply).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              content: expect.stringContaining("not available"),
            }),
          );
          expect(await f.actions()).toEqual(afterRevocation);
          expect(await f.publications()).toHaveLength(0);
        } finally {
          await f.close();
        }
      },
    );

    it("serializes simultaneous exact close deliveries and denies a changed command or registered ID", async () => {
      const f = await commandFixture();
      try {
        const first = f.interaction("close");
        const duplicate = f.interaction("close", { id: first.id });
        const other = await f.parser();
        await Promise.all([
          f.adapter.handleGatewayInteraction(first),
          other.handleGatewayInteraction(duplicate),
        ]);
        for (const command of [first, duplicate])
          expect(command.editReply).toHaveBeenCalledWith(
            expect.objectContaining({
              content: expect.stringContaining("recorded"),
            }),
          );
        const before = await f.actions();
        expect(before).toHaveLength(1);
        expect(await f.publications()).toHaveLength(1);
        const changed = f.interaction("new", { id: first.id });
        await (await f.parser()).handleGatewayInteraction(changed);
        expect(changed.editReply).toHaveBeenCalledWith(
          expect.objectContaining({
            content: expect.stringContaining("not available"),
          }),
        );
        const changedActor = f.interaction("close", {
          id: first.id,
          user: {
            id: "444444444444444420",
            username: "other",
            bot: false,
            discriminator: "0",
          },
        });
        await (await f.parser()).handleGatewayInteraction(changedActor);
        expect(changedActor.editReply).toHaveBeenCalledWith(
          expect.objectContaining({
            content: expect.stringContaining("not available"),
          }),
        );
        const unregistered = f.interaction("close", {
          commandId: "888888888888888820",
        });
        await (await f.parser()).handleGatewayInteraction(unregistered);
        expect(unregistered.editReply).toHaveBeenCalledWith(
          expect.objectContaining({
            content: expect.stringContaining("not available"),
          }),
        );
        expect(await f.actions()).toEqual(before);
        expect(await f.publications()).toHaveLength(1);
      } finally {
        await f.close();
      }
    });

    it("records DM new once and never applies its old replay to a replacement conversation", async () => {
      const f = await commandFixture();
      try {
        const dmId = "666666666666666619";
        const dmThreadId = `discord:@me:${dmId}`;
        const thread = f.runtime
          .get(f.endpoint.id)!
          .thread(dmThreadId) as unknown as Thread;
        const message = (id: string, text: string) =>
          ({
            ...makeMessage({ id, text, userId: externalUserId }),
            threadId: dmThreadId,
          }) as Message;
        const receive = async (id: string, text: string) => {
          await f.callbacks.onMessage({
            endpointId: f.endpoint.id,
            provider: "discord",
            trigger: "direct_message",
            thread,
            message: message(id, text),
          });
          const delivery = await db
            .select()
            .from(chatDeliveries)
            .where(
              and(
                eq(chatDeliveries.endpointId, f.endpoint.id),
                eq(chatDeliveries.providerEventId, `${dmThreadId}:${id}`),
              ),
            )
            .then((rows) => rows[0]);
          if (!delivery) throw new Error("DM fixture delivery absent");
          await f.service.processPendingDeliveries(25, delivery.id);
          expect(
            await db
              .select({
                state: chatDeliveries.state,
                error: chatDeliveries.redactedError,
              })
              .from(chatDeliveries)
              .where(eq(chatDeliveries.id, delivery.id)),
          ).toEqual([expect.objectContaining({ state: "processed" })]);
        };
        await receive("555555555555555620", "Investigate the original DM task");
        const old = await db
          .select()
          .from(chatConversations)
          .where(
            and(
              eq(chatConversations.endpointId, f.endpoint.id),
              eq(chatConversations.externalThreadId, dmThreadId),
            ),
          )
          .then((rows) => rows[0]!);
        expect(old).toMatchObject({
          state: "active",
          isDirectMessage: true,
          sessionGeneration: 1,
        });
        const dm = {
          context: 1,
          guildId: null,
          channelId: dmId,
          channel: { id: dmId, type: 1 },
          authorizingIntegrationOwners: { guildId: "0", userId: null },
        };
        const next = f.interaction("new", dm);
        await f.adapter.handleGatewayInteraction(next);
        expect(next.editReply).toHaveBeenCalledWith(
          expect.objectContaining({
            content: expect.stringContaining("recorded"),
          }),
        );
        expect((await f.publications())[0]).toMatchObject({
          state: "pending",
          conversationId: old.id,
        });
        await f.service.processPendingPublications(100);
        expect((await f.publications())[0]).toMatchObject({
          state: "published",
        });
        await receive(
          (((BigInt(Date.now()) - 1420070400000n) << 22n) + 1000n).toString(),
          "Start the replacement DM task",
        );
        const conversations = await db
          .select()
          .from(chatConversations)
          .where(
            and(
              eq(chatConversations.endpointId, f.endpoint.id),
              eq(chatConversations.externalThreadId, dmThreadId),
            ),
          )
          .orderBy(asc(chatConversations.sessionGeneration));
        expect(conversations).toHaveLength(2);
        expect(conversations[0]).toMatchObject({
          id: old.id,
          state: "completed",
          sessionGeneration: 1,
        });
        expect(conversations[1]).toMatchObject({
          state: "active",
          sessionGeneration: 2,
        });
        expect(conversations[1]!.issueId).not.toBe(old.issueId);
        const wakeCount = f.wakeup.mock.calls.length;
        const replay = f.interaction("new", { ...dm, id: next.id });
        await (await f.parser()).handleGatewayInteraction(replay);
        expect(replay.editReply).toHaveBeenCalledWith(
          expect.objectContaining({
            content: expect.stringContaining("recorded"),
          }),
        );
        expect(await f.actions()).toHaveLength(1);
        expect(await f.publications()).toHaveLength(1);
        expect(
          (
            await readChatConversationsById(conversations[1]!.id)
          )[0]?.state,
        ).toBe("active");
        expect(f.wakeup).toHaveBeenCalledTimes(wakeCount);
        for (const [offset, command] of [
          [1n, "new"],
          [2n, "close"],
        ] as const) {
          const stale = f.interaction(command, {
            ...dm,
            id: (BigInt(next.id) - offset).toString(),
          });
          await f.adapter.handleGatewayInteraction(stale);
          expect(stale.editReply).toHaveBeenCalledWith(
            expect.objectContaining({
              content: expect.stringContaining("predates"),
            }),
          );
          expect(await f.publications()).toHaveLength(1);
          expect(
            (
              await readChatConversationsById(conversations[1]!.id)
            )[0]?.state,
          ).toBe("active");
          expect(f.wakeup).toHaveBeenCalledTimes(wakeCount);
        }
      } finally {
        await f.close();
      }
    });

    it.each(["retired runtime", "replaced lease"] as const)(
      "acknowledges privately before a blocked DB wait but denies %s before commit",
      async (loss) => {
        const f = await commandFixture();
        let release = () => {};
        let blocker: Promise<unknown> | undefined;
        let delivery: Promise<void> | undefined;
        try {
          const current = await readChatEndpointsById(f.endpoint.id)
            .then((rows) => rows[0]!);
          let locked = () => {};
          const acquired = new Promise<void>((resolve) => {
            locked = resolve;
          });
          const held = new Promise<void>((resolve) => {
            release = resolve;
          });
          blocker = db.transaction(async (tx) => {
            await tx
              .select()
              .from(toolConnections)
              .where(eq(toolConnections.id, current.connectionId))
              .for("no key update");
            locked();
            await held;
          });
          await acquired;
          const command = f.interaction("close");
          delivery = f.adapter.handleGatewayInteraction(command);
          await expect.poll(() => command.deferReply.mock.calls.length).toBe(1);
          await expect
            .poll(async () => {
              try {
                await db.transaction(async (tx) => {
                  await tx
                    .select()
                    .from(chatEndpoints)
                    .where(eq(chatEndpoints.id, f.endpoint.id))
                    .for("no key update", { noWait: true });
                });
                return false;
              } catch (error) {
                const code =
                  (error as { code?: unknown; cause?: { code?: unknown } })
                    .cause?.code ?? (error as { code?: unknown }).code;
                if (code !== "55P03") throw error;
                return true;
              }
            })
            .toBe(true);
          expect(command.editReply).not.toHaveBeenCalled();
          if (loss === "retired runtime")
            await f.runtime.removeEndpoint(f.endpoint.id);
          else
            await db
              .update(chatEndpointLeases)
              .set({ token: randomUUID() })
              .where(
                and(
                  eq(chatEndpointLeases.endpointId, f.endpoint.id),
                  eq(chatEndpointLeases.leaseKey, "discord_gateway_runtime"),
                ),
              );
          release();
          await blocker;
          await delivery;
          expect(command.editReply).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              content: expect.stringContaining("not available"),
            }),
          );
          expect(await f.actions()).toHaveLength(0);
          expect(await f.publications()).toHaveLength(0);
          expect(
            (
              await readChatConversationsById(f.conversation.id)
            )[0]?.state,
          ).toBe("active");
        } finally {
          release();
          try {
            await blocker;
            await delivery;
          } finally {
            await f.close();
          }
        }
      },
    );

    describe("fresh-after-close publication bindings", () => {
      let lastFreshDiscordMessageId = 0n;
      const freshDiscordMessageId = () => {
        const current = ((BigInt(Date.now()) - 1420070400000n) << 22n) + 1000n;
        lastFreshDiscordMessageId =
          current > lastFreshDiscordMessageId
            ? current
            : lastFreshDiscordMessageId + 1n;
        return lastFreshDiscordMessageId.toString();
      };
      async function reopenedFixture(includeDuringConfirmationSource = false, companyId?: string) {
        const f = await commandFixture(companyId);
        const threadId = `discord:${guildId}:${channelId}:${rootMessageId}`;
        const admitMessage = async (message: ReturnType<typeof makeMessage>) => {
          await deliverMessage({
            callbacks: f.callbacks,
            endpointId: f.endpoint.id,
            provider: "discord",
            thread: makeThread({
              id: threadId,
              channelId: f.conversation.externalConversationId,
              name: "reopened",
            }).thread,
            message,
            trigger: "mention",
          });
          const [delivery] = await db
            .select()
            .from(chatDeliveries)
            .where(
              and(
                eq(chatDeliveries.endpointId, f.endpoint.id),
                sql`${chatDeliveries.normalizedEvent}->'message'->>'providerMessageId' = ${message.id}`,
              ),
            );
          if (!delivery) throw new Error("Expected exact source delivery");
          await f.service.processPendingDeliveries(25, delivery.id);
          return delivery;
        };
        const bindRun = async (messageId: string, admitted = true) => {
          const context = await chatWakeContext({
            endpointId: f.endpoint.id,
            issueId: f.conversation.issueId,
            provider: "discord",
            providerMessageId: messageId,
          });
          const [action] = await db
            .select()
            .from(chatActions)
            .where(
              and(
                eq(chatActions.endpointId, f.endpoint.id),
                eq(chatActions.kind, "inbound_wakeup"),
                sql`${chatActions.payload}->>'commentId' = ${context.wakeCommentId}`,
              ),
            );
          if (!action) throw new Error("Expected admitted source action");
          const runId = randomUUID();
          // The fixture heartbeat does not execute a model. Persist the exact
          // scheduler linkage for the already admitted source, then exercise
          // real binding/milestone/final publication code, not an auth mock.
          await db.insert(heartbeatRuns).values({
            id: runId,
            companyId: f.fixture.companyId,
            agentId: f.fixture.assignedAgentId,
            runtimeMode: "native",
            nativeIssueId: f.conversation.issueId,
            status: "running",
            wakeupRequestId: admitted ? action.id : null,
            startedAt: new Date(),
            contextSnapshot: {
              ...context,
              endpointId: f.endpoint.id,
              paperclipHarnessCheckedOut: true,
            },
          });
          if (admitted) {
            const receipt = await db
              .update(agentWakeupRequests)
              .set({ runId, status: "claimed" })
              .where(eq(agentWakeupRequests.id, action.id))
              .returning({ id: agentWakeupRequests.id });
            expect(receipt).toHaveLength(1);
          }
          return { runId, action, context };
        };
        const historical = await bindRun(rootMessageId, false);
        const oldMessage = makeMessage({
          id: "555555555555555620",
          text: "@maya old request before close",
          mentioned: true,
          userId: externalUserId,
        });
        await admitMessage(oldMessage);
        const old = await bindRun(oldMessage.id);
        await db
          .update(heartbeatRuns)
          .set({ status: "succeeded", finishedAt: new Date() })
          .where(inArray(heartbeatRuns.id, [old.runId, historical.runId]));
        const controlInvocation = f.interaction("close");
        await f.adapter.handleGatewayInteraction(controlInvocation);
        let duringConfirmation: { runId: string; receivedAt: Date } | null = null;
        if (includeDuringConfirmationSource) {
          const messageId = freshDiscordMessageId();
          const message = makeMessage({
            id: messageId,
            text: "@maya this source was already admitted before close committed",
            mentioned: true,
            userId: externalUserId,
          });
          message.metadata.dateSent = new Date(
            Number((BigInt(messageId) >> 22n) + 1420070400000n),
          );
          const delivery = await admitMessage(message);
          const admitted = await bindRun(messageId);
          duringConfirmation = {
            runId: admitted.runId,
            receivedAt: delivery.receivedAt,
          };
        }
        await f.service.processPendingPublications();
        const [control] = await f.publications();
        expect(control).toMatchObject({
          state: "published",
          conversationId: f.conversation.id,
        });
        expect((await f.service.listConversations(f.endpoint.id))[0]?.state).toBe(
          "completed",
        );
        const messageId = freshDiscordMessageId();
        const freshMessage = makeMessage({
          id: messageId,
          text: "@maya reply to this fresh request",
          mentioned: true,
          userId: externalUserId,
        });
        const delivery = await admitMessage(freshMessage);
        const fresh = await bindRun(messageId);
        expect((await f.service.listConversations(f.endpoint.id))[0]).toMatchObject(
          {
            id: f.conversation.id,
            state: "active",
            sessionGeneration: f.conversation.sessionGeneration,
          },
        );
        return {
          ...f,
          old,
          historical,
          fresh,
          delivery,
          control,
          controlInvocation,
          duringConfirmation,
          admitMessage,
          bindRun,
        };
      }

      it.each(["action", "delivery"] as const)("wakes a post-close milestone when interrupted inbound acceptance settles its %s receipt", async receipt => {
        const f = await reopenedFixture();
        const onError = vi.fn();
        const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError });
        const notice = () => db.select().from(chatPublications).where(and(
          eq(chatPublications.issueId, f.conversation.issueId),
          eq(chatPublications.idempotencyKey, `run:${f.fresh.runId}:working:${f.endpoint.id}`),
        ));
        try {
          // Crash boundary: the run/wake is durable, but its inbound action has
          // not yet recorded settlement. Recovery must not dispatch it again.
          if (receipt === "action") {
            await db.update(chatActions).set({ status: "issued", result: {}, updatedAt: new Date() })
              .where(eq(chatActions.id, f.fresh.action.id));
          } else {
            // Operator repair of a failed ledger keeps the already-admitted
            // action/run. Only delivery acceptance needs to commit again.
            await db.update(chatDeliveries).set({ state: "retry", processedAt: null, nextAttemptAt: null })
              .where(eq(chatDeliveries.id, f.delivery.id));
          }
          await chatRunMilestoneWork(db).register(coordinator, () => true).ready;
          await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBeNull());
          expect(await notice()).toEqual([]);
          const wakesBefore = f.wakeup.mock.calls.length;
          await expect.poll(async () => {
            await f.service.processPendingDeliveries(25, f.delivery.id);
            const [action] = await db.select().from(chatActions).where(eq(chatActions.id, f.fresh.action.id));
            const [delivery] = await db.select().from(chatDeliveries).where(eq(chatDeliveries.id, f.delivery.id));
            return [action.status, delivery.state];
          }, { timeout: 10_000 }).toEqual(["processed", "processed"]);
          expect(f.wakeup.mock.calls.length).toBe(wakesBefore);
          await expect.poll(notice, { timeout: 5000 }).toEqual([
            expect.objectContaining({ idempotencyKey: `run:${f.fresh.runId}:working:${f.endpoint.id}` }),
          ]);
          await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBeNull());
          expect(onError).not.toHaveBeenCalled();
        } finally { await coordinator.stop(); await f.close(); }
      });

      it.each(["connection", "resource", "unlinked", "identity", "member", "member_permissions", "ensure_membership", "company_access", "visibility", "cloud_sync"] as const)(
        "wakes a post-close milestone when %s authority is restored", async owner => {
          const stackId = randomUUID();
          const f = await reopenedFixture(false, owner === "cloud_sync" ? cloudTenantPrimaryCompanyId(stackId) : undefined);
          const previousToken = process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
          const [previousUser] = owner === "cloud_sync"
            ? await db.select().from(authUsers).where(eq(authUsers.id, "owner-user"))
            : [];
          const onError = vi.fn();
          const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError });
          const notice = () => db.select().from(chatPublications).where(and(
            eq(chatPublications.issueId, f.conversation.issueId),
            eq(chatPublications.idempotencyKey, `run:${f.fresh.runId}:working:${f.endpoint.id}`),
          ));
          const access = accessService(db);
          const membership = (await db.select().from(companyMemberships).where(and(
            eq(companyMemberships.companyId, f.fixture.companyId), eq(companyMemberships.principalId, "owner-user"),
          )))[0];
          try {
            let restore: () => Promise<unknown>;
            if (owner === "connection") {
              await toolAccessService(db).updateConnection(f.endpoint.connectionId, { enabled: false });
              restore = () => toolAccessService(db).updateConnection(f.endpoint.connectionId, { enabled: true });
            } else if (owner === "resource") {
              const [conversation] = await db.select().from(chatConversations).where(eq(chatConversations.id, f.conversation.id));
              expect(conversation.resourceId).not.toBeNull();
              await f.service.replaceResources(f.endpoint.id, [{ id: conversation.resourceId!, enabled: false }], "owner-user");
              restore = () => f.service.replaceResources(f.endpoint.id, [{ id: conversation.resourceId!, enabled: true }], "owner-user");
            } else if (owner === "identity" || owner === "unlinked") {
              await f.service.update(f.endpoint.id, { allowUnlinkedPeople: false }, "owner-user");
              await f.service.revokeLink(f.endpoint.id, f.fresh.action.principalId!);
              if (owner === "unlinked") {
                restore = () => f.service.update(f.endpoint.id, { allowUnlinkedPeople: true }, "owner-user");
              } else {
                const intent = await f.service.createLinkIntent(f.endpoint.id, f.fresh.action.principalId!, 1800);
                restore = () => f.service.confirmIdentityLink(new URL(intent.confirmationUrl).searchParams.get("token")!, "owner-user");
              }
            } else if (owner === "visibility") {
              await issueService(db).update(f.conversation.issueId, { hiddenAt: new Date() });
              restore = () => issueService(db).update(f.conversation.issueId, { hiddenAt: null });
            } else {
              // Model existing denied authority without exercising revocation's
              // unrelated credential cleanup; restoration uses its actual owner.
              await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.id, membership.id));
              if (owner === "member") restore = () => access.updateMember(f.fixture.companyId, membership.id, { status: "active" });
              else if (owner === "member_permissions") restore = () => access.updateMemberAndPermissions(f.fixture.companyId, membership.id, { status: "active", grants: [] }, "owner-user");
              else if (owner === "cloud_sync") {
                process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = "milestone-cloud-sync-test";
                let request = 0;
                restore = () => resolveCloudTenantActor(db, cloudActorHeaderSourceFromHeaders({
                  "x-paperclip-cloud-tenant-token": "milestone-cloud-sync-test",
                  "x-paperclip-cloud-user-id": "owner-user",
                  "x-paperclip-cloud-user-email": "owner@example.test",
                  // Change the profile to force an actual sync on replay. The
                  // debounce must not hide repeated unchanged membership wakes.
                  "x-paperclip-cloud-user-name": `Owner ${request++}`,
                  "x-paperclip-cloud-stack-id": stackId,
                  "x-paperclip-cloud-stack-role": "owner",
                }));
              }
              else if (owner === "ensure_membership") restore = () => access.ensureMembership(f.fixture.companyId, "user", "owner-user", membership.membershipRole, "active");
              else {
                const existing = await db.select().from(companyMemberships).where(and(
                  eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, "owner-user"),
                ));
                restore = () => access.setUserCompanyAccess("owner-user", existing.map(row => row.companyId));
              }
            }
            await chatRunMilestoneWork(db).register(coordinator, () => true).ready;
            await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBeNull());
            expect(await notice()).toEqual([]);
            await restore();
            await expect.poll(notice, { timeout: 5000 }).toEqual([
              expect.objectContaining({ idempotencyKey: `run:${f.fresh.runId}:working:${f.endpoint.id}` }),
            ]);
            await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBeNull());
            if (owner !== "identity" && owner !== "connection") {
              const notices: string[] = [];
              const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.chatRunMilestones, event => notices.push(event));
              try { await restore(); expect(notices).toEqual([]); }
              finally { unsubscribe(); }
              expect(await notice()).toHaveLength(1);
            }
            expect(onError).not.toHaveBeenCalled();
          } finally {
            if (previousToken === undefined) delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
            else process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = previousToken;
            await coordinator.stop();
            if (previousUser) await db.update(authUsers).set({
              name: previousUser.name, email: previousUser.email,
              emailVerified: previousUser.emailVerified, updatedAt: previousUser.updatedAt,
            }).where(eq(authUsers.id, previousUser.id));
            await f.close();
          }
        },
      );

      it.each(["identity", "resource", "visibility"] as const)(
        "wakes saved post-close native progress when %s authority returns", async owner => {
          const f = await reopenedFixture();
          const onError = vi.fn();
          const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError });
          const progress = () => db.select().from(chatPublications).where(and(
            eq(chatPublications.issueId, f.conversation.issueId), like(chatPublications.idempotencyKey, "%:native:%"),
          ));
          try {
            await db.insert(chatPublications).values({
              companyId: f.fixture.companyId, endpointId: f.endpoint.id,
              conversationId: f.conversation.id, issueId: f.conversation.issueId,
              idempotencyKey: `run:${f.fresh.runId}:working:${f.endpoint.id}`,
              payload: { text: "Maya is working…", progressState: "working" }, state: "published",
              createdAt: new Date(Date.now() - 60_000),
            });
            await db.insert(heartbeatRunEvents).values({
              companyId: f.fixture.companyId, agentId: f.fixture.assignedAgentId,
              runId: f.fresh.runId, seq: 1, eventType: "item.completed",
            });
            let restore: () => Promise<unknown>;
            if (owner === "identity") {
              await f.service.update(f.endpoint.id, { allowUnlinkedPeople: false }, "owner-user");
              await f.service.revokeLink(f.endpoint.id, f.fresh.action.principalId!);
              const intent = await f.service.createLinkIntent(f.endpoint.id, f.fresh.action.principalId!, 1800);
              restore = () => f.service.confirmIdentityLink(new URL(intent.confirmationUrl).searchParams.get("token")!, "owner-user");
            } else if (owner === "resource") {
              const [conversation] = await db.select().from(chatConversations).where(eq(chatConversations.id, f.conversation.id));
              expect(conversation.resourceId).not.toBeNull();
              await f.service.replaceResources(f.endpoint.id, [{ id: conversation.resourceId!, enabled: false }], "owner-user");
              restore = () => f.service.replaceResources(f.endpoint.id, [{ id: conversation.resourceId!, enabled: true }], "owner-user");
            } else {
              await issueService(db).update(f.conversation.issueId, { hiddenAt: new Date() });
              restore = () => issueService(db).update(f.conversation.issueId, { hiddenAt: null });
            }
            await nativeChatProgressWork(db).register(coordinator, () => true).ready;
            await vi.waitFor(() => { expect(coordinator.nextWakeAt()).toBeNull(); expect(idleWorkSnapshot().active).toBe(0); });
            expect(await progress()).toEqual([]);
            await restore();
            await expect.poll(progress, { timeout: 5000 }).toEqual([
              expect.objectContaining({ idempotencyKey: `run:${f.fresh.runId}:working:${f.endpoint.id}:native:making_progress:1` }),
            ]);
            await vi.waitFor(() => { expect(coordinator.nextWakeAt()).toBeNull(); expect(idleWorkSnapshot().active).toBe(0); });
            const select = vi.spyOn(db, "select");
            try { await new Promise(resolve => setTimeout(resolve, 1200)); expect(select).not.toHaveBeenCalled(); }
            finally { select.mockRestore(); }
            expect(onError).not.toHaveBeenCalled();
          } finally { await coordinator.stop(); await f.close(); }
        },
      );

      it("publishes working and the exact fresh final after pinned close without resurrecting the old source", async () => {
        const f = await reopenedFixture();
        try {
          const scope = {
            companyId: f.fixture.companyId,
            issueId: f.conversation.issueId,
          };
          await expect(
            resolveChatRunPresentationAuthorizationReason(db, {
              ...scope,
              runId: f.old.runId,
            }),
          ).resolves.toBe("internal_agent_write");
          await expect(
            resolveChatRunPresentationAuthorizationReason(db, {
              ...scope,
              runId: f.historical.runId,
            }),
          ).resolves.toBe("internal_agent_write");
          await expect(
            resolveChatRunPresentationAuthorizationReason(db, {
              ...scope,
              runId: f.fresh.runId,
            }),
          ).resolves.toBe("allow_chat_run_presentation");
          await enqueueChatRunMilestones(db);
          await f.service.processPendingPublications();
          expect(
            f.runtime.get(f.endpoint.id)?.posts.map((post) => post.text),
          ).toContain("Maya is working…");
          await db
            .update(heartbeatRuns)
            .set({ status: "succeeded", finishedAt: new Date() })
            .where(eq(heartbeatRuns.id, f.fresh.runId));
          const comment = await addSelectedChatFinal({
            ...scope,
            agentId: f.fixture.assignedAgentId,
            runId: f.fresh.runId,
            body: "DISCORD-FRESH-AFTER-CLOSE",
          });
          await f.service.processPendingPublications();
          const publications = await readChatPublicationsByCommentId(comment.id);
          expect(publications).toEqual([
            expect.objectContaining({
              conversationId: f.conversation.id,
              state: "published",
              attempts: 1,
              payload: { text: "DISCORD-FRESH-AFTER-CLOSE" },
            }),
          ]);
          expect((await f.publications())[0]).toEqual(f.control);
        } finally {
          await f.close();
        }
      });

      it("allows an admitted source sent after close command but before close confirmation to present", async () => {
        const f = await reopenedFixture();
        try {
          const commandTime = Number(
            (BigInt(f.controlInvocation.id) >> 22n) + 1420070400000n,
          );
          const sourceTime = commandTime + 1;
          expect(sourceTime).toBeLessThan(f.control.publishedAt!.getTime());
          const message = makeMessage({
            id: (((BigInt(sourceTime) - 1420070400000n) << 22n) + 1001n).toString(),
            text: "@maya answer this genuinely post-command request",
            mentioned: true,
            userId: externalUserId,
          });
          message.metadata.dateSent = new Date(sourceTime);
          const delivery = await f.admitMessage(message);
          expect(delivery).toMatchObject({
            state: "processed",
            conversationId: f.conversation.id,
          });
          expect(delivery.receivedAt.getTime()).toBeGreaterThan(
            f.control.publishedAt!.getTime(),
          );
          const admitted = await f.bindRun(message.id);
          expect(admitted.action.status).toBe("processed");
          await expect(
            resolveChatRunPresentationAuthorizationReason(db, {
              companyId: f.fixture.companyId,
              issueId: f.conversation.issueId,
              runId: admitted.runId,
            }),
          ).resolves.toBe("allow_chat_run_presentation");
        } finally {
          await f.close();
        }
      });

      it("keeps a source admitted before close confirmation internal after a fresh source reopens", async () => {
        const f = await reopenedFixture(true);
        try {
          expect(f.duringConfirmation).not.toBeNull();
          expect(f.duringConfirmation!.receivedAt.getTime()).toBeLessThan(
            f.control.publishedAt!.getTime(),
          );
          await expect(
            resolveChatRunPresentationAuthorizationReason(db, {
              companyId: f.fixture.companyId,
              issueId: f.conversation.issueId,
              runId: f.duringConfirmation!.runId,
            }),
          ).resolves.toBe("internal_agent_write");
          await expect(
            resolveChatRunPresentationAuthorizationReason(db, {
              companyId: f.fixture.companyId,
              issueId: f.conversation.issueId,
              runId: f.fresh.runId,
            }),
          ).resolves.toBe("allow_chat_run_presentation");
        } finally {
          await f.close();
        }
      });

      it.each(["only_unproven", "newer_unproven", "newer_issue_mismatch"] as const)(
        "does not grant presentation across a published control with %s proof",
        async (mode) => {
          const f = await reopenedFixture();
          try {
            let control = f.control;
            let source = f.fresh;
            if (mode !== "only_unproven") {
              await f.adapter.handleGatewayInteraction(f.interaction("close"));
              await f.service.processPendingPublications();
              control = (await f.publications()).find(
                (row) => row.id !== f.control.id,
              )!;
              expect(control.state).toBe("published");
              const messageId = freshDiscordMessageId();
              const message = makeMessage({
                id: messageId,
                text: "@maya a genuinely fresh source still needs every control proof",
                mentioned: true,
                userId: externalUserId,
              });
              message.metadata.dateSent = new Date(
                Number((BigInt(messageId) >> 22n) + 1420070400000n),
              );
              expect((await f.admitMessage(message)).state).toBe("processed");
              source = await f.bindRun(messageId);
              await expect(
                resolveChatRunPresentationAuthorizationReason(db, {
                  companyId: f.fixture.companyId,
                  issueId: f.conversation.issueId,
                  runId: source.runId,
                }),
              ).resolves.toBe("allow_chat_run_presentation");
            }
            if (mode === "newer_issue_mismatch") {
              const unrelated = await issueService(db).create(f.fixture.companyId, {
                title: "Independent task must not supply control proof",
                createdByUserId: "owner-user",
              });
              await db
                .update(chatPublications)
                .set({ issueId: unrelated.id })
                .where(eq(chatPublications.id, control.id));
            } else {
              await db
                .update(chatActions)
                .set({ status: "issued" })
                .where(
                  eq(
                    chatActions.providerActionId,
                    `task-control-authorization:${control.id}`,
                  ),
                );
            }
            if (mode !== "only_unproven") {
              expect(
                (
                  await readChatActionsByProviderActionId(`task-control-authorization:${f.control.id}`)
                )[0]?.status,
              ).toBe("processed");
            }
            await expect(
              resolveChatRunPresentationAuthorizationReason(db, {
                companyId: f.fixture.companyId,
                issueId: f.conversation.issueId,
                runId: source.runId,
              }),
            ).resolves.toBe("internal_agent_write");
          } finally {
            await f.close();
          }
        },
      );

      it.each(["old_source", "fresh_source"] as const)(
        "does not let an automatic child copy %s presentation authority",
        async (source) => {
          const f = await reopenedFixture();
          try {
            const parent = source === "old_source" ? f.old : f.fresh;
            const runId = randomUUID(),
              wakeId = randomUUID();
            await db.insert(agentWakeupRequests).values({
              id: wakeId,
              companyId: f.fixture.companyId,
              agentId: f.fixture.assignedAgentId,
              source: "automation",
              triggerDetail: "system",
              reason: "issue_continuation_needed",
              requestedByActorType: "system",
              status: "queued",
              payload: {
                issueId: f.conversation.issueId,
                retryOfRunId: parent.runId,
              },
            });
            await db.insert(heartbeatRuns).values({
              id: runId,
              companyId: f.fixture.companyId,
              agentId: f.fixture.assignedAgentId,
              nativeIssueId: f.conversation.issueId,
              runtimeMode: "native",
              status: "running",
              startedAt: new Date(),
              wakeupRequestId: wakeId,
              retryOfRunId: parent.runId,
              contextSnapshot: {
                ...parent.context,
                endpointId: f.endpoint.id,
                paperclipHarnessCheckedOut: true,
              },
            });
            await db
              .update(agentWakeupRequests)
              .set({ runId, status: "claimed" })
              .where(eq(agentWakeupRequests.id, wakeId));
            await expect(
              resolveChatRunPresentationAuthorizationReason(db, {
                companyId: f.fixture.companyId,
                issueId: f.conversation.issueId,
                runId,
              }),
            ).resolves.toBe("internal_agent_write");
          } finally {
            await f.close();
          }
        },
      );

      it("does not drop an older coalesced source while selecting the fresh batch", async () => {
        const f = await reopenedFixture();
        try {
          await db
            .update(agentWakeupRequests)
            .set({
              status: "coalesced",
              runId: f.fresh.runId,
              payload: sql`${agentWakeupRequests.payload} || ${JSON.stringify({ coalescedIntoWakeupRequestId: f.fresh.action.id })}::jsonb`,
            })
            .where(eq(agentWakeupRequests.id, f.old.action.id));
          // The submitted context omits the old sibling. The receipt set, not
          // this mutable subset, must determine whether the batch is fresh.
          await expect(
            resolveChatRunPresentationAuthorizationReason(db, {
              companyId: f.fixture.companyId,
              issueId: f.conversation.issueId,
              runId: f.fresh.runId,
            }),
          ).resolves.toBe("internal_agent_write");
          await db
            .update(heartbeatRuns)
            .set({
              contextSnapshot: {
                ...f.fresh.context,
                endpointId: f.endpoint.id,
                paperclipHarnessCheckedOut: true,
                wakeCommentIds: [
                  f.old.context.wakeCommentId,
                  f.fresh.context.wakeCommentId,
                ],
              },
            })
            .where(eq(heartbeatRuns.id, f.fresh.runId));
          await expect(
            resolveChatRunPresentationAuthorizationReason(db, {
              companyId: f.fixture.companyId,
              issueId: f.conversation.issueId,
              runId: f.fresh.runId,
            }),
          ).resolves.toBe("internal_agent_write");
        } finally {
          await f.close();
        }
      });

      it("allows a complete freshly admitted coalesced batch", async () => {
        const f = await reopenedFixture();
        try {
          const secondMessage = makeMessage({
            id: freshDiscordMessageId(),
            text: "@maya include this fresh detail",
            mentioned: true,
            userId: externalUserId,
          });
          await f.admitMessage(secondMessage);
          const second = await chatWakeContext({
            endpointId: f.endpoint.id,
            issueId: f.conversation.issueId,
            provider: "discord",
            providerMessageId: secondMessage.id,
          });
          const [action] = await db
            .select()
            .from(chatActions)
            .where(
              and(
                eq(chatActions.endpointId, f.endpoint.id),
                eq(chatActions.kind, "inbound_wakeup"),
                sql`${chatActions.payload}->>'commentId' = ${second.wakeCommentId}`,
              ),
            );
          const receipt = await db
            .update(agentWakeupRequests)
            .set({
              status: "coalesced",
              runId: f.fresh.runId,
              payload: sql`${agentWakeupRequests.payload} || ${JSON.stringify({ coalescedIntoWakeupRequestId: f.fresh.action.id })}::jsonb`,
            })
            .where(eq(agentWakeupRequests.id, action.id))
            .returning({ id: agentWakeupRequests.id });
          expect(receipt).toHaveLength(1);
          // Model the scheduler's queued-batch claim only after both actual
          // admissions. Coalescing execution itself has its own heartbeat tests.
          await db
            .update(heartbeatRuns)
            .set({
              startedAt: new Date(),
              contextSnapshot: {
                ...f.fresh.context,
                endpointId: f.endpoint.id,
                paperclipHarnessCheckedOut: true,
                wakeCommentIds: [
                  f.fresh.context.wakeCommentId,
                  second.wakeCommentId,
                ],
              },
            })
            .where(eq(heartbeatRuns.id, f.fresh.runId));
          await expect(
            resolveChatRunPresentationAuthorizationReason(db, {
              companyId: f.fixture.companyId,
              issueId: f.conversation.issueId,
              runId: f.fresh.runId,
            }),
          ).resolves.toBe("allow_chat_run_presentation");
        } finally {
          await f.close();
        }
      });

      it("keeps a newly closed source internal after a still newer source reopens the thread", async () => {
        const f = await reopenedFixture();
        try {
          await f.adapter.handleGatewayInteraction(f.interaction("close"));
          await f.service.processPendingPublications();
          const controls = await f.publications();
          expect(controls).toHaveLength(2);
          expect(controls.every((control) => control.state === "published")).toBe(
            true,
          );
          const nextMessage = makeMessage({
            id: freshDiscordMessageId(),
            text: "@maya genuinely new request after second close",
            mentioned: true,
            userId: externalUserId,
          });
          await f.admitMessage(nextMessage);
          const next = await f.bindRun(nextMessage.id);
          expect((await f.service.listConversations(f.endpoint.id))[0]?.state).toBe(
            "active",
          );
          const scope = {
            companyId: f.fixture.companyId,
            issueId: f.conversation.issueId,
          };
          await expect(
            resolveChatRunPresentationAuthorizationReason(db, {
              ...scope,
              runId: f.fresh.runId,
            }),
          ).resolves.toBe("internal_agent_write");
          await expect(
            resolveChatRunPresentationAuthorizationReason(db, {
              ...scope,
              runId: next.runId,
            }),
          ).resolves.toBe("allow_chat_run_presentation");
        } finally {
          await f.close();
        }
      });

      it.each(["delayed", "missing"] as const)(
        "refuses %s provider chronology at intake when first ingested after close",
        async (mode) => {
          const f = await reopenedFixture();
          try {
            const before = await db
              .select({ id: issueComments.id })
              .from(issueComments)
              .where(eq(issueComments.issueId, f.conversation.issueId))
              .orderBy(asc(issueComments.id));
            const message = makeMessage({
              id:
                mode === "delayed"
                  ? (BigInt(f.controlInvocation.id) - (5000n << 22n)).toString()
                  : "missing-provider-snowflake",
              text: "@maya this unseen source must not become fresh work",
              mentioned: true,
              userId: externalUserId,
            });
            const delivery = await f.admitMessage(message);
            expect(delivery.receivedAt.getTime()).toBeGreaterThan(
              f.control.publishedAt!.getTime(),
            );
            expect(delivery).toMatchObject({
              state: "filtered",
              conversationId: null,
            });
            expect(
              await db
                .select({ id: issueComments.id })
                .from(issueComments)
                .where(eq(issueComments.issueId, f.conversation.issueId))
                .orderBy(asc(issueComments.id)),
            ).toEqual(before);
            expect(
              await db
                .select()
                .from(chatActions)
                .where(
                  and(
                    eq(chatActions.deliveryId, delivery.id),
                    eq(chatActions.kind, "inbound_wakeup"),
                  ),
                ),
            ).toEqual([]);
          } finally {
            await f.close();
          }
        },
      );

      it("orders same-millisecond Discord sources only within the same worker and process", async () => {
        const f = await reopenedFixture();
        try {
          for (const offset of [-1n, 1n << 12n, 1n << 17n, 1n]) {
            const message = makeMessage({
              id: (BigInt(f.controlInvocation.id) + offset).toString(),
              text: "@maya same provider millisecond",
              mentioned: true,
              userId: externalUserId,
            });
            const delivery = await f.admitMessage(message);
            expect(delivery.state).toBe(offset === 1n ? "processed" : "filtered");
          }
        } finally {
          await f.close();
        }
      });

      it.each(["close", "new"] as const)(
        "does not let an unseen stale native Discord %s act on reopened work",
        async (command) => {
          const f = await reopenedFixture();
          try {
            const before = await f.publications();
            const stale = f.interaction(command, {
              id: (BigInt(f.controlInvocation.id) - 1n).toString(),
            });
            await f.adapter.handleGatewayInteraction(stale);
            expect(await f.publications()).toEqual(before);
            expect(
              (await f.service.listConversations(f.endpoint.id))[0]?.state,
            ).toBe("active");
            if (command === "close")
              expect(stale.editReply).toHaveBeenCalledWith(
                expect.objectContaining({
                  content: expect.stringContaining("predates"),
                }),
              );
            // Guild-thread /new remains guidance-only regardless of age.
          } finally {
            await f.close();
          }
        },
      );

      it.each([
        "edited",
        "deleted",
        "pending_lifecycle",
        "generation",
        "runtime",
        "credentials",
        "revoked_access",
        "reach",
        "thread",
        "unadmitted",
        "reassigned",
      ] as const)(
        "does not cross a historical close after current %s authority changes",
        async (mode) => {
          const f = await reopenedFixture();
          try {
            if (mode === "edited")
              await db
                .update(issueComments)
                .set({ body: "Edited source", updatedAt: new Date() })
                .where(eq(issueComments.id, f.fresh.context.wakeCommentId));
            if (mode === "deleted")
              await db
                .update(issueComments)
                .set({ deletedAt: new Date() })
                .where(eq(issueComments.id, f.fresh.context.wakeCommentId));
            if (mode === "pending_lifecycle")
              await db.insert(chatDeliveries).values({
                companyId: f.fixture.companyId,
                endpointId: f.endpoint.id,
                conversationId: f.conversation.id,
                providerEventId: `edit:${randomUUID()}`,
                deduplicationKey: randomUUID(),
                eventKind: "message_updated",
                state: "received",
                normalizedEvent: {
                  runtimeContext: f.delivery.normalizedEvent.runtimeContext,
                  message: {
                    targetProviderEventId: f.delivery.providerEventId,
                  },
                },
              });
            if (mode === "generation")
              await db
                .update(chatConversations)
                .set({
                  sessionGeneration: f.conversation.sessionGeneration + 1,
                })
                .where(eq(chatConversations.id, f.conversation.id));
            if (mode === "runtime")
              await db
                .update(chatEndpoints)
                .set({
                  setup: sql`jsonb_set(${chatEndpoints.setup}, '{runtimeGeneration}', to_jsonb(coalesce((${chatEndpoints.setup}->>'runtimeGeneration')::integer, 0) + 1))`,
                })
                .where(eq(chatEndpoints.id, f.endpoint.id));
            if (mode === "credentials")
              await db
                .update(toolConnections)
                .set({ credentialSecretRefs: [] })
                .where(eq(toolConnections.id, f.endpoint.connectionId));
            if (mode === "revoked_access") {
              await db
                .update(chatEndpoints)
                .set({ allowUnlinkedPeople: false })
                .where(eq(chatEndpoints.id, f.endpoint.id));
              await db
                .update(chatIdentityLinks)
                .set({ status: "revoked" })
                .where(
                  and(
                    eq(chatIdentityLinks.endpointId, f.endpoint.id),
                    eq(chatIdentityLinks.principalId, f.principal.id),
                  ),
                );
            }
            if (mode === "reach")
              await db
                .update(chatEndpointResources)
                .set({ enabled: false })
                .where(eq(chatEndpointResources.endpointId, f.endpoint.id));
            if (mode === "thread")
              await db
                .update(chatDeliveries)
                .set({
                  normalizedEvent: {
                    ...f.delivery.normalizedEvent,
                    conversation: {
                      ...(f.delivery.normalizedEvent.conversation as Record<
                        string,
                        unknown
                      >),
                      externalThreadId: "discord:foreign:thread",
                    },
                  },
                })
                .where(eq(chatDeliveries.id, f.delivery.id));
            if (mode === "unadmitted")
              await db
                .update(agentWakeupRequests)
                .set({ status: "skipped" })
                .where(eq(agentWakeupRequests.id, f.fresh.action.id));
            if (mode === "reassigned")
              await db
                .update(issues)
                .set({ assigneeAgentId: f.fixture.replacementAgentId })
                .where(eq(issues.id, f.conversation.issueId));
            await expect(
              resolveChatRunPresentationAuthorizationReason(db, {
                companyId: f.fixture.companyId,
                issueId: f.conversation.issueId,
                runId: f.fresh.runId,
              }),
            ).resolves.toBe("internal_agent_write");
            await enqueueChatRunMilestones(db);
            expect(
              await db
                .select()
                .from(chatPublications)
                .where(
                  like(chatPublications.idempotencyKey, `run:${f.fresh.runId}:%`),
                ),
            ).toEqual([]);
          } finally {
            await f.close();
          }
        },
      );
    });

    it("rolls back staged public control when the durable command receipt fails", async () => {
      const f = await commandFixture();
      const functionName = `discord_command_failure_${randomUUID().replaceAll("-", "")}`;
      const triggerName = `${functionName}_trigger`;
      try {
        // Synthetic PostgreSQL fault after the outbox insert, scoped only to
        // this endpoint. Provider error text must never become private content.
        await db.execute(
          sql.raw(
            `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.endpoint_id = '${f.endpoint.id}'::uuid AND NEW.kind = 'discord_native_command' THEN RAISE EXCEPTION 'PRIVATE-COMMAND-PERSISTENCE-DETAIL'; END IF; RETURN NEW; END $$`,
          ),
        );
        await db.execute(
          sql.raw(
            `CREATE TRIGGER ${triggerName} BEFORE INSERT ON chat_actions FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
          ),
        );
        const close = f.interaction("close");
        await f.adapter.handleGatewayInteraction(close);
        expect(close.deferReply).toHaveBeenCalledExactlyOnceWith({ flags: 64 });
        expect(close.editReply).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            content: expect.stringContaining("could not be confirmed"),
          }),
        );
        expect(JSON.stringify(close.editReply.mock.calls)).not.toContain(
          "PRIVATE-COMMAND",
        );
        expect(await f.actions()).toHaveLength(0);
        expect(await f.publications()).toHaveLength(0);
        expect(
          (
            await readChatConversationsById(f.conversation.id)
          )[0]?.state,
        ).toBe("active");
      } finally {
        try {
          await db.execute(
            sql.raw(`DROP TRIGGER IF EXISTS ${triggerName} ON chat_actions`),
          );
          await db.execute(
            sql.raw(`DROP FUNCTION IF EXISTS ${functionName}()`),
          );
        } finally {
          await f.close();
        }
      }
    });
  });

  it("discovers a Slack connect identity without starting work or granting access", async () => {
    await instanceSettingsService(db).updateExperimental({ enableChatConnectors: true });
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service, wakeup } = await configuredSlackEndpoint(fixture, { allowUnlinkedPeople: false });
    const post = vi.fn();
    const postEphemeral = vi.fn(async () => ({ id: "connect-notice", usedFallback: false }));
    const event = {
      endpointId: endpoint.id, provider: "slack" as const,
      event: {
        channel: { id: "C-CONNECT", isDM: false, post, postEphemeral } as never,
        command: endpoint.setup.command!, text: "connect", triggerId: "connect-discovery-1",
        user: { userId: "U-CONNECT", userName: "connector", fullName: "Connect Person", isBot: false, isMe: false, isSystem: false },
        raw: { trigger_id: "connect-discovery-1" }, adapter: {} as never, openModal: async () => undefined,
      },
    };
    await callbacks.onSlashCommand!(event);
    await callbacks.onSlashCommand!(event);
    await vi.waitFor(() => expect(postEphemeral).toHaveBeenCalledTimes(1));
    const [identity] = await service.listPrincipals(endpoint.id);
    expect(identity).toMatchObject({ externalLabel: "Connect Person", status: "pending", paperclipUserId: null, lastConnectAt: expect.any(String) });
    expect(await service.listConversations(endpoint.id)).toHaveLength(0);
    expect(wakeup).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(await db.select().from(chatActions).where(and(eq(chatActions.endpointId, endpoint.id), eq(chatActions.kind, "slack_connect")))).toHaveLength(1);
    expect(await db.select().from(chatActions).where(and(eq(chatActions.endpointId, endpoint.id), eq(chatActions.kind, "slash_task_start")))).toHaveLength(0);
    const other = await service.create(fixture.companyId, { provider: "slack", assignedAgentId: fixture.assignedAgentId }, "owner-user");
    await db.update(chatEndpoints).set({ status: "verifying", providerAccountId: (await service.get(endpoint.id)).providerAccountId }).where(eq(chatEndpoints.id, other.id));
    expect((await service.listPrincipals(other.id))[0]?.lastConnectAt).toBeNull();
    const notice = String((postEphemeral.mock.calls[0] as unknown[])[1]);
    const token = /token=([A-Za-z0-9_-]+)/.exec(notice)![1];
    expect(notice).toContain("Connect your Paperclip account");
    expect((postEphemeral.mock.calls[0] as unknown[])[2]).toEqual({ fallbackToDM: false });
    expect(await service.previewIdentityLink(token, "owner-user")).toMatchObject({ selfService: true, canConfirm: true, externalLabel: "Connect Person" });
    expect(await service.setupTestStatus(endpoint.id, "owner-user")).toEqual({ messageReceivedAt: null });
    await expect(service.finishSlackSetup(endpoint.id, "owner-user")).rejects.toMatchObject({ status: 403 });
    const outsiderId = `outsider-${fixture.companyId}`;
    const now = new Date();
    await db.insert(authUsers).values({ id: outsiderId, name: "Outside Person", email: `${outsiderId}@example.test`, emailVerified: true, createdAt: now, updatedAt: now });
    const outsideApp = routesApp(db, randomUUID(), service, outsiderId);
    expect((await request(outsideApp).get(`/api/chat-identity-links/preview?token=${token}`)).body).toMatchObject({ selfService: true, canConfirm: false });
    await expect(service.confirmIdentityLink(token, outsiderId)).rejects.toMatchObject({ status: 403 });
    await request(outsideApp).post("/api/chat-identity-links/confirm").send({ token }).expect(403);
    expect((await request(outsideApp).post("/api/chat-identity-links/request-access").send({ token })).body).toMatchObject({ status: "pending_approval" });
    await service.requestIdentityAccess(token, outsiderId, "test");
    expect(await db.select().from(joinRequests).where(eq(joinRequests.companyId, fixture.companyId))).toHaveLength(1);
    expect(await db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, fixture.companyId), eq(companyMemberships.principalId, outsiderId)))).toHaveLength(0);
    const adminOnly = await service.createLinkIntent(other.id, identity.principalId, 600);
    const adminToken = new URL(adminOnly.confirmationUrl).searchParams.get("token")!;
    expect((await request(outsideApp).get(`/api/chat-identity-links/preview?token=${adminToken}`)).status).toBe(404);
    await expect(service.requestIdentityAccess(adminToken, outsiderId, "test")).rejects.toMatchObject({ status: 403 });
    const providerRuntime = runtime.endpoints.get(endpoint.id)!;
    const originalThread = providerRuntime.thread.bind(providerRuntime);
    const confirmationNotice = vi.fn(async () => ({ id: "linked-notice", threadId: "C-CONNECT" }));
    providerRuntime.thread = (id: string) => ({ ...originalThread(id), postEphemeral: confirmationNotice });
    await service.confirmIdentityLink(token, "owner-user");
    await vi.waitFor(() => expect(confirmationNotice).toHaveBeenCalledWith("U-CONNECT", expect.stringContaining("account is connected"), { fallbackToDM: false }));
    expect((await service.listPrincipals(endpoint.id))[0]).toMatchObject({ status: "linked", paperclipUserId: "owner-user" });
    await expect(service.test(endpoint.id)).rejects.toMatchObject({ details: { code: "chat_test_follow_up_missing" } });
    await expect(service.confirmIdentityLink(token, "owner-user")).rejects.toMatchObject({ status: 422 });
    await request(outsideApp).post("/api/chat-identity-links/request-access").send({ token }).expect(422);
    expect(await service.setupTestStatus(endpoint.id, "owner-user")).toEqual({ messageReceivedAt: null });
    const finished = await service.finishSlackSetup(endpoint.id, "owner-user");
    expect(finished).toMatchObject({ status: "active", setup: { step: "complete", testSkipped: true } });
    expect(wakeup).not.toHaveBeenCalled();
  });

  it.each(["message", "mention", "slash"] as const)("scopes Slack setup %s detection to the linked user and current test", async (kind) => {
    const fixture = await seedCompany();
    const { endpoint, service } = await configuredSlackEndpoint(fixture);
    const now = new Date();
    const [principal] = await db.insert(chatExternalPrincipals).values({ companyId: fixture.companyId, provider: "slack", providerAccountId: (await service.get(endpoint.id)).providerAccountId!, externalId: "U-TEST", kind: "user", displayName: "Test" }).returning();
    const intent = await service.createLinkIntent(endpoint.id, principal.id, 600);
    const token = new URL(intent.confirmationUrl).searchParams.get("token")!;
    await db.update(chatIdentityLinks).set({ expiresAt: new Date(now.getTime() - 1) }).where(eq(chatIdentityLinks.principalId, principal.id));
    await expect(service.confirmIdentityLink(token, "owner-user")).rejects.toMatchObject({ status: 422 });
    const fresh = await service.createLinkIntent(endpoint.id, principal.id, 600);
    await service.confirmIdentityLink(new URL(fresh.confirmationUrl).searchParams.get("token")!, "owner-user");
    await db.insert(chatActions).values({ companyId: fixture.companyId, endpointId: endpoint.id, principalId: principal.id, kind: "slash_task_start", providerActionId: "old-test-message", createdAt: new Date(now.getTime() - 60_000), status: "processed" });
    expect(await service.setupTestStatus(endpoint.id, "owner-user")).toEqual({ messageReceivedAt: null });
    if (kind === "slash") {
    await db.insert(chatActions).values({ companyId: fixture.companyId, endpointId: endpoint.id, principalId: principal.id, kind: "slash_task_start", providerActionId: "current-test-message", status: "processed" });
    } else {
      await db.insert(chatDeliveries).values({ companyId: fixture.companyId, endpointId: endpoint.id, principalId: principal.id, providerEventId: "current-test-message", deduplicationKey: "current-test-message", eventKind: kind, normalizedEvent: {}, state: "processed" });
    }
    expect(await service.setupTestStatus(endpoint.id, "owner-user")).toMatchObject({ messageReceivedAt: expect.any(String) });
    expect(await service.setupTestStatus(endpoint.id, "someone-else")).toEqual({ messageReceivedAt: null });
  });
});
