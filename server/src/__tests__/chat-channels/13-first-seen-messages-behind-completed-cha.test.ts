import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, like, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, chatActions, chatConversations, chatDeliveries, chatEndpointResources, chatExternalPrincipals, chatMessageLinks, chatPublications, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import type { Thread } from "chat";
import { chatChannelService, type ChatChannelServiceOptions } from "../../services/chat-channels.js";
import type { ChatSdkMessageTrigger, ChatSdkRuntime } from "../../services/chat-sdk-runtime.js";
import { issueService } from "../../services/issues.js";
import { resolveChatRunPresentationAuthorizationReason } from "../../services/chat-run-publications.js";
import { FakeChatSdkRuntime, fakeTelegramFetch, makeMessage, makeThread } from ".././helpers/chat-channels-fixture.js";
import { chatWakeContext, configuredSlackEndpoint, configuredTeamsEndpoint, configuredTelegramEndpoint, db, deliverMessage, describeChatChannelsSuite, qualifySetupRoundTrip, readChatActionsByProviderActionId, readChatConversationsByEndpointId, readChatDeliveriesByEndpointId, readChatDeliveriesById, readChatPublicationsById, readChatPublicationsByIdempotencyKey, receiptBackedWakeup, retirePublicationFixture, seedCompany } from "../helpers/chat-channels-harness.js";










describeChatChannelsSuite("chat channels 13-first-seen-messages-behind-completed-cha", () => {
  describe("first-seen messages behind completed chat controls", () => {
    async function chronologyFixture(
      provider: "slack" | "telegram",
      overrides: Parameters<typeof configuredTelegramEndpoint>[1] = {},
      sameCompany?: Awaited<ReturnType<typeof seedCompany>>,
    ) {
      const fixture = sameCompany ?? (await seedCompany());
      const configured =
        provider === "slack"
          ? await configuredSlackEndpoint(fixture, overrides)
          : await configuredTelegramEndpoint(fixture, overrides);
      const { callbacks, endpoint, service, wakeup } = configured;
      const chatId = provider === "slack" ? "D09LATECONTROL" : "77119981";
      const userId = provider === "slack" ? "U-LATE-CONTROL" : chatId;
      const thread = makeThread({
        id: provider === "slack" ? `slack:${chatId}:` : `telegram:${chatId}`,
        channelId: chatId,
        isDM: true,
        name: "Late control source",
      }).thread;
      const controlSecond = Math.floor(Date.now() / 1_000) - 10;
      const admit = async (
        sequence: number,
        second: number,
        text: string,
        destination = thread,
        trigger: ChatSdkMessageTrigger = "direct_message",
      ) => {
        const sentAt = new Date(second * 1_000);
        const providerMessageId =
          provider === "slack"
            ? `${second}.${String(sequence).padStart(6, "0")}`
            : `${chatId}:${sequence}`;
        const message = makeMessage({
          id: providerMessageId,
          text,
          userId,
          raw:
            provider === "slack"
              ? { ts: providerMessageId, user: userId, text }
              : {
                  message_id: sequence,
                  date: second,
                  chat: { id: Number(chatId), type: "private" },
                  from: { id: Number(userId), is_bot: false },
                  text,
                },
        });
        message.metadata.dateSent =
          provider === "slack"
            ? new Date(Number(providerMessageId) * 1_000)
            : sentAt;
        const currentCallbacks =
          configured.runtime.configurations.get(endpoint.id)?.callbacks ??
          callbacks;
        await deliverMessage({
          callbacks: currentCallbacks,
          endpointId: endpoint.id,
          provider,
          thread: destination,
          message,
          trigger,
        });
        const [delivery] = await db
          .select()
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, endpoint.id),
              sql`${chatDeliveries.normalizedEvent}->'message'->>'providerMessageId' = ${providerMessageId}`,
              sql`${chatDeliveries.normalizedEvent}->'conversation'->>'externalThreadId' = ${destination.id}`,
            ),
          );
        if (!delivery) throw new Error("Expected exact provider source receipt");
        await service.processPendingDeliveries(25, delivery.id);
        return readChatDeliveriesById(delivery.id)
          .then((rows) => rows[0]!);
      };
      await admit(100, controlSecond - 5, "Initial task before control");
      await qualifySetupRoundTrip(service, endpoint.id, userId);
      await service.test(endpoint.id);
      let commandSequence = 200;
      const control = async (command: "close" | "new", publish = true) => {
        await callbacks.onSlashCommand!({
          endpointId: endpoint.id,
          provider,
          event: {
            command:
              provider === "slack"
                ? String(endpoint.setup.command)
                : `/${command}`,
            text: provider === "slack" ? command : "",
            triggerId: randomUUID(),
            channel: {
              id: provider === "slack" ? `slack:${chatId}` : thread.id,
              isDM: true,
              name: "Late control source",
            } as never,
            user: {
              userId,
              userName: "late-control-user",
              fullName: "Late Control User",
              isBot: false,
              isMe: false,
              isSystem: false,
            },
            raw:
              provider === "slack"
                ? {
                    command: endpoint.setup.command,
                    text: command,
                    channel_id: chatId,
                    user_id: userId,
                  }
                : {
                    message_id: commandSequence++,
                    date: controlSecond,
                    chat: { id: Number(chatId), type: "private" },
                    from: { id: Number(userId), is_bot: false },
                    text: `/${command}`,
                    entities: [
                      {
                        offset: 0,
                        length: command.length + 1,
                        type: "bot_command",
                      },
                    ],
                  },
            adapter: {} as never,
            openModal: async () => undefined,
          },
        });
        if (publish) await service.processPendingPublications();
        const [publication] = await db
          .select()
          .from(chatPublications)
          .where(
            and(
              eq(chatPublications.endpointId, endpoint.id),
              like(chatPublications.idempotencyKey, `control:${command}:%`),
            ),
          )
          .orderBy(desc(chatPublications.createdAt));
        expect(publication).toMatchObject({
          state: publish ? "published" : "pending",
        });
        if (publish)
          expect((await service.listConversations(endpoint.id))[0]?.state).toBe(
            "completed",
          );
        return publication!;
      };
      const snapshot = async () => ({
        issues: await db
          .select({ id: issues.id })
          .from(issues)
          .where(eq(issues.companyId, fixture.companyId))
          .orderBy(asc(issues.id)),
        conversations: await db
          .select({
            id: chatConversations.id,
            state: chatConversations.state,
            generation: chatConversations.sessionGeneration,
          })
          .from(chatConversations)
          .where(eq(chatConversations.endpointId, endpoint.id))
          .orderBy(asc(chatConversations.id)),
        comments: await db
          .select({ id: issueComments.id })
          .from(issueComments)
          .where(eq(issueComments.companyId, fixture.companyId))
          .orderBy(asc(issueComments.id)),
        actions: await db
          .select({ id: chatActions.id })
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, endpoint.id),
              eq(chatActions.kind, "inbound_wakeup"),
            ),
          )
          .orderBy(asc(chatActions.id)),
        wakeCount: wakeup.mock.calls.length,
      });
      return {
        ...configured,
        fixture,
        thread,
        userId,
        chatId,
        controlSecond,
        admit,
        control,
        snapshot,
        close: () => retirePublicationFixture(service, endpoint.id),
      };
    }

    it.each([
      ["slack", "close", false],
      ["slack", "new", false],
      ["telegram", "close", false],
      ["telegram", "new", false],
      ["telegram", "close", true],
      ["telegram", "new", true],
    ] as const)(
      "refuses unseen %s input before %s (same second: %s) without creating work",
      async (provider, command, sameSecond) => {
        const f = await chronologyFixture(provider);
        try {
          const control = await f.control(command);
          const before = await f.snapshot();
          const delayed = await f.admit(
            199,
            f.controlSecond - (sameSecond ? 0 : 1),
            "Delayed old input, not a fresh request",
          );
          expect(delayed.receivedAt.getTime()).toBeGreaterThan(
            control.publishedAt!.getTime(),
          );
          expect(delayed.state).toBe("filtered");
          expect(delayed.conversationId).toBeNull();
          expect(await f.snapshot()).toEqual(before);
          const freshSecond =
            provider === "telegram" && sameSecond
              ? f.controlSecond
              : Math.floor(Date.now() / 1_000) + 1;
          if (freshSecond * 1_000 > Date.now())
            await vi.waitFor(
              () =>
                expect(Date.now()).toBeGreaterThanOrEqual(freshSecond * 1_000),
              { timeout: 1_500, interval: 10 },
            );
          const fresh = await f.admit(
            201,
            freshSecond,
            "A genuinely later explicit request",
          );
          expect(fresh.state).toBe("processed");
          const afterFresh = await f.snapshot();
          expect(afterFresh.issues).toHaveLength(before.issues.length + 1);
          expect(afterFresh.wakeCount).toBe(before.wakeCount + 1);
          expect(afterFresh.conversations).toContainEqual(
            expect.objectContaining({ state: "active", generation: 2 }),
          );
          const olderIntoNewGeneration = await f.admit(
            198,
            f.controlSecond - 1,
            "Another unseen old message after the new generation",
          );
          expect(olderIntoNewGeneration.state).toBe("filtered");
          expect(await f.snapshot()).toEqual(afterFresh);
        } finally {
          await f.close();
        }
      },
    );

    it.each(["slack", "telegram"] as const)(
      "accepts delayed %s backlog without an explicit control",
      async (provider) => {
        const f = await chronologyFixture(provider);
        try {
          const before = await f.snapshot();
          const delivery = await f.admit(
            99,
            f.controlSecond - 20,
            "Legitimate delayed backlog on the same active task",
          );
          expect(delivery.state).toBe("processed");
          const after = await f.snapshot();
          expect(after.issues).toEqual(before.issues);
          expect(after.conversations).toEqual(before.conversations);
          expect(after.comments).toHaveLength(before.comments.length + 1);
          expect(after.wakeCount).toBe(before.wakeCount + 1);
        } finally {
          await f.close();
        }
      },
    );

    it("rechecks a close committed while old input waits before the endpoint transaction", async () => {
      let arm = false;
      let entered!: () => void;
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const f = await chronologyFixture("telegram", {
        reachAuthorizationBarrier: async () => {
          if (arm) {
            entered();
            await gate;
          }
        },
      });
      let input: ReturnType<typeof f.admit> | undefined;
      try {
        await f.control("close", false);
        arm = true;
        input = f.admit(
          199,
          f.controlSecond - 1,
          "Old input held before current authority transaction",
        );
        await waiting;
        await f.service.processPendingPublications();
        const before = await f.snapshot();
        expect(before.conversations[0]?.state).toBe("completed");
        release();
        expect((await input).state).toBe("filtered");
        expect(await f.snapshot()).toEqual(before);
      } finally {
        release();
        await input;
        await f.close();
      }
    });

    it("honors operator-confirmed close without inventing an outbound message receipt", async () => {
      const f = await chronologyFixture("telegram");
      try {
        const publication = await f.control("close", false);
        const providerRuntime = f.runtime.endpoints.get(f.endpoint.id)!;
        providerRuntime.postError = new Error(
          "connection closed after provider acceptance became unknown",
        );
        await f.service.processPendingPublications();
        const [unknown] = await readChatPublicationsById(publication.id);
        expect(unknown).toMatchObject({
          state: "delivery_unknown",
          providerMessageId: null,
        });
        providerRuntime.postError = null;
        await f.service.resolvePublication(
          f.endpoint.id,
          publication.id,
          "mark_delivered",
          "owner-user",
        );
        const [receipt] = await readChatActionsByProviderActionId(`task-control-authorization:${publication.id}`);
        expect(receipt).toMatchObject({
          status: "processed",
          result: { code: "task_control_marked_delivered_by_operator" },
        });
        expect(
          await db
            .select()
            .from(chatMessageLinks)
            .where(eq(chatMessageLinks.publicationId, publication.id)),
        ).toEqual([]);
        const before = await f.snapshot();
        expect(
          (
            await f.admit(
              199,
              f.controlSecond - 1,
              "Old input after operator confirmation",
            )
          ).state,
        ).toBe("filtered");
        expect(await f.snapshot()).toEqual(before);
      } finally {
        await f.close();
      }
    });

    it.each(["slack", "telegram"] as const)(
      "does not promote metadata-only %s timestamps after a completed control",
      async (provider) => {
        const f = await chronologyFixture(provider);
        try {
          await f.control("close");
          const before = await f.snapshot();
          const message = makeMessage({
            id:
              provider === "slack"
                ? `${Math.floor(Date.now() / 1_000)}.000777`
                : `${f.chatId}:777`,
            raw: provider === "slack" ? {} : { message_id: 777 },
            text: "Metadata now is not provider chronology",
            userId: f.userId,
          });
          await deliverMessage({
            callbacks: f.callbacks,
            endpointId: f.endpoint.id,
            provider,
            thread: f.thread,
            message,
            trigger: "direct_message",
          });
          expect(await f.snapshot()).toEqual(before);
          const [delivery] = await db
            .select()
            .from(chatDeliveries)
            .where(
              and(
                eq(chatDeliveries.endpointId, f.endpoint.id),
                sql`${chatDeliveries.normalizedEvent}->'message'->>'providerMessageId' = ${message.id}`,
              ),
            );
          expect(delivery).toMatchObject({
            state: "filtered",
            normalizedEvent: expect.objectContaining({
              message: expect.objectContaining({ providerSentAt: null }),
            }),
          });
          expect(delivery?.redactedError).toContain("Send a new request");
        } finally {
          await f.close();
        }
      },
    );

    it("continues to accept authenticated Slack slash close/new on a genuinely new generation", async () => {
      const f = await chronologyFixture("slack");
      try {
        await f.control("close");
        const freshSecond = Math.floor(Date.now() / 1_000) + 1;
        await vi.waitFor(
          () => expect(Date.now()).toBeGreaterThanOrEqual(freshSecond * 1_000),
          { timeout: 1_500, interval: 10 },
        );
        expect(
          (
            await f.admit(
              901,
              freshSecond,
              "A fresh task before native slash new",
            )
          ).state,
        ).toBe("processed");
        await f.control("new");
        const controls = await db
          .select()
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, f.endpoint.id),
              sql`${chatDeliveries.normalizedEvent}->'admission'->>'origin' = 'slack_slash_control'`,
            ),
          );
        expect(controls).toHaveLength(2);
        expect(controls.every((control) => control.state === "processed")).toBe(
          true,
        );
        expect(
          (await f.snapshot()).conversations.every(
            (conversation) => conversation.state === "completed",
          ),
        ).toBe(true);
      } finally {
        await f.close();
      }
    });

    it("keeps controls scoped to their endpoint, immutable thread, and company", async () => {
      const f = await chronologyFixture("slack");
      const others: Awaited<ReturnType<typeof chronologyFixture>>[] = [];
      try {
        await f.control("close");
        const otherThread = makeThread({
          id: `${f.thread.id}111.000001`,
          channelId: f.chatId,
          isDM: true,
          name: "Independent DM thread",
        }).thread;
        expect(
          (
            await f.admit(
              299,
              f.controlSecond - 1,
              "Independent thread backlog",
              otherThread,
            )
          ).state,
        ).toBe("processed");
        others.push(await chronologyFixture("slack", {}, f.fixture));
        others.push(await chronologyFixture("slack"));
        for (const independent of others) {
          expect(
            (
              await independent.admit(
                299,
                f.controlSecond - 1,
                "Independent endpoint or tenant backlog",
              )
            ).state,
          ).toBe("processed");
        }
      } finally {
        for (const independent of others) await independent.close();
        await f.close();
      }
    });

    it("does not recreate or filter a previously committed inbound link when its delivery retries after close", async () => {
      const f = await chronologyFixture("telegram");
      try {
        const accepted = await f.admit(
          101,
          f.controlSecond - 2,
          "Already accepted before the close",
        );
        await f.control("close");
        const before = await f.snapshot();
        const links = await db
          .select()
          .from(chatMessageLinks)
          .where(eq(chatMessageLinks.deliveryId, accepted.id));
        await db
          .update(chatDeliveries)
          .set({ state: "retry", nextAttemptAt: new Date(0) })
          .where(eq(chatDeliveries.id, accepted.id));
        await f.service.processPendingDeliveries(25, accepted.id);
        const [retried] = await readChatDeliveriesById(accepted.id);
        // Existing current-access recovery refuses this now-closed source. The
        // first-seen filter must not erase or recreate its already saved work.
        expect(retried).toMatchObject({
          state: "failed",
          conversationId: accepted.conversationId,
        });
        expect(retried?.redactedError).toContain("no longer authorized");
        expect(
          await db
            .select()
            .from(chatMessageLinks)
            .where(eq(chatMessageLinks.deliveryId, accepted.id)),
        ).toEqual(links);
        expect(await f.snapshot()).toEqual(before);
      } finally {
        await f.close();
      }
    });

    it.each(["close", "new"] as const)(
      "does not let an unseen old Telegram /%s close a newer generation",
      async (command) => {
        const f = await chronologyFixture("telegram");
        try {
          await f.control("close");
          expect(
            (
              await f.admit(
                201,
                f.controlSecond + 1,
                "Fresh generation after close",
              )
            ).state,
          ).toBe("processed");
          const before = await f.snapshot();
          expect(
            (await f.admit(198, f.controlSecond - 1, `/${command}`)).state,
          ).toBe("filtered");
          await f.service.processPendingPublications();
          expect(await f.snapshot()).toEqual(before);
        } finally {
          await f.close();
        }
      },
    );

    it("retains a committed control boundary through pause, redacted duplicate, and resume", async () => {
      const f = await chronologyFixture("telegram");
      try {
        const control = await f.control("close");
        const [originalAuthorization] = await readChatActionsByProviderActionId(`task-control-authorization:${control.id}`);
        await f.service.configure(
          f.endpoint.id,
          { action: "pause" },
          "owner-user",
        );
        const duplicate = await f.admit(
          200,
          f.controlSecond,
          "/close",
          f.thread,
          "mention",
        );
        expect(duplicate).toMatchObject({
          state: "processed",
          principalId: originalAuthorization!.principalId,
          normalizedEvent: expect.objectContaining({
            filtering: { contentRetained: false },
          }),
        });
        expect(duplicate.normalizedEvent.message).not.toHaveProperty("text");
        expect(duplicate.eventKind).toBe("direct_message");
        expect(duplicate.normalizedEvent.kind).toBe("mention");
        await f.service.configure(
          f.endpoint.id,
          { action: "resume" },
          "owner-user",
        );
        const before = await f.snapshot();
        expect(
          (
            await f.admit(
              199,
              f.controlSecond - 1,
              "Old source after resumed redacted control",
            )
          ).state,
        ).toBe("filtered");
        expect(await f.snapshot()).toEqual(before);
        const freshSecond = Math.floor(Date.now() / 1_000) + 1;
        await vi.waitFor(
          () => expect(Date.now()).toBeGreaterThanOrEqual(freshSecond * 1_000),
          { timeout: 1_500, interval: 10 },
        );
        expect(
          (await f.admit(201, freshSecond, "Fresh request after resumed control"))
            .state,
        ).toBe("processed");
        const [retained] = await readChatDeliveriesById(duplicate.id);
        expect(retained?.normalizedEvent).toEqual(duplicate.normalizedEvent);
        expect(control.publishedAt).not.toBeNull();
      } finally {
        await f.close();
      }
    });

    it("retains a completed trailing-newline control as a first-seen source boundary", async () => {
      const f = await chronologyFixture("telegram");
      try {
        const delivery = await f.admit(200, f.controlSecond, "/close\n");
        await f.service.processPendingPublications();
        const [control] = await readChatPublicationsByIdempotencyKey(`control:close:${delivery.id}`);
        expect(control?.state).toBe("published");
        expect((await f.service.listConversations(f.endpoint.id))[0]?.state).toBe(
          "completed",
        );
        const before = await f.snapshot();
        expect(
          (
            await f.admit(
              199,
              f.controlSecond - 1,
              "Old input after a valid newline-terminated close",
            )
          ).state,
        ).toBe("filtered");
        expect(await f.snapshot()).toEqual(before);
      } finally {
        await f.close();
      }
    });

    it.each([false, true])(
      "preserves a Teams close across regional routes (close after route change: %s)",
      async (closeAfterRouteChange) => {
        const fixture = await seedCompany();
        const f = await configuredTeamsEndpoint(fixture);
        try {
          const conversationId = "19:late-control-route@thread.v2";
          const base = `teams:${Buffer.from(conversationId).toString("base64url")}`;
          const oldId = `${base}:${Buffer.from("https://smba.trafficmanager.net/amer/").toString("base64url")}`;
          const oldThread = makeThread({
            id: oldId,
            channelId: oldId,
            isDM: true,
          }).thread;
          const currentThread = makeThread({
            id: base,
            channelId: base,
            isDM: true,
          }).thread;
          const controlTime = new Date(Date.now() - 10_000);
          const receive = async (
            thread: Thread,
            id: string,
            time: Date,
            text: string,
          ) => {
            await deliverMessage({
              callbacks: f.callbacks,
              endpointId: f.endpoint.id,
              provider: "microsoft-teams",
              thread,
              trigger: "direct_message",
              message: makeMessage({
                id,
                userId: "teams-late-user",
                text,
                raw: {
                  timestamp: time.toISOString(),
                  serviceUrl:
                    thread.id === oldId
                      ? "https://smba.trafficmanager.net/amer/"
                      : "https://smba.trafficmanager.net/emea/",
                  from: { aadObjectId: "teams-late-user" },
                },
              }),
            });
            return db
              .select()
              .from(chatDeliveries)
              .where(
                and(
                  eq(chatDeliveries.endpointId, f.endpoint.id),
                  sql`${chatDeliveries.normalizedEvent}->'message'->>'providerMessageId' = ${id}`,
                ),
              )
              .then((rows) => rows[0]!);
          };
          await receive(
            oldThread,
            "teams-source-1",
            new Date(controlTime.getTime() - 5_000),
            "Initial Teams task",
          );
          await qualifySetupRoundTrip(
            f.service,
            f.endpoint.id,
            "teams-late-user",
          );
          await f.service.test(f.endpoint.id);
          await receive(
            closeAfterRouteChange ? currentThread : oldThread,
            "teams-close-2",
            controlTime,
            "/close",
          );
          await f.service.processPendingPublications();
          expect(
            (await f.service.listConversations(f.endpoint.id))[0]?.state,
          ).toBe("completed");
          const before = f.wakeup.mock.calls.length;
          expect(
            (
              await receive(
                currentThread,
                "teams-delayed-3",
                new Date(controlTime.getTime() - 1_000),
                "Old Teams request after close",
              )
            ).state,
          ).toBe("filtered");
          expect(f.wakeup).toHaveBeenCalledTimes(before);
          expect(await f.service.listConversations(f.endpoint.id)).toHaveLength(
            1,
          );
          expect(
            (
              await receive(
                currentThread,
                "teams-fresh-4",
                new Date(controlTime.getTime() + 1_000),
                "Fresh Teams request",
              )
            ).state,
          ).toBe("processed");
          expect(f.wakeup).toHaveBeenCalledTimes(before + 1);
          expect(await f.service.listConversations(f.endpoint.id)).toHaveLength(
            2,
          );
        } finally {
          await retirePublicationFixture(f.service, f.endpoint.id);
        }
      },
    );

    it("does not lower a newer provider boundary when an older close is confirmed later", async () => {
      const f = await chronologyFixture("telegram");
      try {
        const older = await f.control("close", false);
        const providerRuntime = f.runtime.endpoints.get(f.endpoint.id)!;
        providerRuntime.postError = new Error(
          "older control confirmation response lost",
        );
        await f.service.processPendingPublications();
        const [unknown] = await readChatPublicationsById(older.id);
        expect(unknown?.state).toBe("delivery_unknown");
        providerRuntime.postError = null;
        // FIFO correctly blocks later publications in this old conversation.
        // A normal Board task completion lets fresh DM work start a separate
        // generation; its control can complete before the old unknown result
        // receives a delayed operator confirmation.
        if (!older.issueId) throw new Error("Expected the old control task");
        await issueService(db).update(older.issueId, {
          status: "done",
          actorUserId: "owner-user",
        });
        const replacement = await f.admit(
          275,
          f.controlSecond + 1,
          "Start independently after Board task completion",
        );
        expect(replacement.state).toBe("processed");
        expect(replacement.conversationId).not.toBe(older.conversationId);
        await f.admit(300, f.controlSecond + 5, "/close");
        await f.service.processPendingPublications();
        const controls = await db
          .select()
          .from(chatPublications)
          .where(
            and(
              eq(chatPublications.endpointId, f.endpoint.id),
              like(chatPublications.idempotencyKey, "control:close:%"),
            ),
          );
        expect(controls).toHaveLength(2);
        expect(controls.find((control) => control.id !== older.id)?.state).toBe(
          "published",
        );
        await f.service.resolvePublication(
          f.endpoint.id,
          older.id,
          "mark_delivered",
          "owner-user",
        );
        const [lastConfirmed] = await db
          .select()
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, f.endpoint.id),
              eq(chatActions.kind, "task_control_authorization"),
            ),
          )
          .orderBy(desc(chatActions.updatedAt));
        expect(lastConfirmed?.payload.publicationId).toBe(older.id);
        const before = await f.snapshot();
        expect(
          (
            await f.admit(
              250,
              f.controlSecond + 2,
              "Between the older and newer provider controls",
            )
          ).state,
        ).toBe("filtered");
        expect(await f.snapshot()).toEqual(before);
        expect(
          (await f.admit(301, f.controlSecond + 6, "After both provider controls"))
            .state,
        ).toBe("processed");
      } finally {
        await f.close();
      }
    });

    it.each([
      "unprocessed_authorization",
      "unprocessed_source",
      "unbound_control_key",
    ] as const)(
      "does not infer a stop from bare completed state with %s",
      async (mode) => {
        const f = await chronologyFixture("telegram");
        try {
          const control = await f.control("close");
          if (mode === "unprocessed_authorization")
            await db
              .update(chatActions)
              .set({ status: "issued" })
              .where(
                eq(
                  chatActions.providerActionId,
                  `task-control-authorization:${control.id}`,
                ),
              );
          else if (mode === "unprocessed_source")
            await db
              .update(chatDeliveries)
              .set({ state: "failed" })
              .where(
                eq(chatDeliveries.id, control.idempotencyKey.split(":")[2]!),
              );
          else
            await db
              .update(chatPublications)
              .set({ idempotencyKey: `control:close:${randomUUID()}` })
              .where(eq(chatPublications.id, control.id));
          expect(
            (
              await f.admit(
                199,
                f.controlSecond - 1,
                "A bare completed row is not an explicit control proof",
              )
            ).state,
          ).toBe("processed");
        } finally {
          await f.close();
        }
      },
    );
  });

  it("reorders reverse-arrival Telegram webhooks by provider sequence before waking the agent", async () => {
    const fixture = await seedCompany();
    const runtime = new FakeChatSdkRuntime();
    const deferred: Array<() => void> = [];
    const wakeup = vi.fn<ChatChannelServiceOptions["heartbeat"]["wakeup"]>(async () => ({ accepted: true }));
    const service = chatChannelService(db, {
      deferWebhookProcessing: true,
      fetch: fakeTelegramFetch() as typeof globalThis.fetch,
      heartbeat: { wakeup: receiptBackedWakeup(wakeup) },
      publicBaseUrl: "https://paperclip.example",
      runtime: runtime as unknown as ChatSdkRuntime,
      scheduleDeferredWork: (task) => deferred.push(task),
    });
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
    const dm = makeThread({
      channelId: "77117711",
      id: "telegram:77117711",
      isDM: true,
      name: "Telegram ordered delivery",
    });
    const providerSecond = new Date("2026-09-05T19:15:20.000Z");
    // Only the raw provider date supplies retained Telegram chronology.
    const later = makeMessage({
      id: "telegram:77117711:102",
      raw: { message_id: 102, date: providerSecond.getTime() / 1_000 },
      text: "second Telegram turn",
      userId: "77117711",
    });
    later.metadata.dateSent = providerSecond;
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      providerUpdateId: 7002,
      thread: dm.thread,
      message: later,
      trigger: "direct_message",
    });
    const earlier = makeMessage({
      id: "telegram:77117711:101",
      raw: { message_id: 101, date: providerSecond.getTime() / 1_000 },
      text: "first Telegram turn",
      userId: "77117711",
    });
    earlier.metadata.dateSent = providerSecond;
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      providerUpdateId: 7001,
      thread: dm.thread,
      message: earlier,
      trigger: "direct_message",
    });

    const durable = await readChatDeliveriesByEndpointId(endpoint.id);
    expect(durable).toHaveLength(2);
    expect(durable.every((delivery) => delivery.nextAttemptAt !== null)).toBe(
      true,
    );
    expect(
      new Set(
        durable.map((delivery) => delivery.nextAttemptAt?.getTime() ?? null),
      ).size,
    ).toBe(1);
    expect(durable.map((delivery) => delivery.normalizedEvent)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.objectContaining({
            providerMessageSequence: 101,
            providerUpdateId: 7001,
            providerSentAt: providerSecond.toISOString(),
            providerSentAtSource: "telegram_message_date",
          }),
        }),
        expect.objectContaining({
          message: expect.objectContaining({
            providerMessageSequence: 102,
            providerUpdateId: 7002,
            providerSentAt: providerSecond.toISOString(),
            providerSentAtSource: "telegram_message_date",
          }),
        }),
      ]),
    );
    expect(
      await readChatConversationsByEndpointId(endpoint.id),
    ).toHaveLength(0);
    expect(wakeup).not.toHaveBeenCalled();
    expect(deferred).toHaveLength(1);

    deferred.shift()?.();
    await vi.waitFor(() => expect(wakeup).toHaveBeenCalledTimes(2), {
      timeout: 3_000,
    });
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    if (!conversation) throw new Error("Expected Telegram conversation");
    const comments = await db
      .select({ id: issueComments.id, body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, conversation.issueId))
      .orderBy(asc(issueComments.createdAt), asc(issueComments.id));
    expect(comments.map((comment) => comment.body)).toEqual([
      "first Telegram turn",
      "second Telegram turn",
    ]);
    expect(
      wakeup.mock.calls.map((call) => call[1]?.payload?.wakeCommentId),
    ).toEqual(comments.map((comment) => comment.id));
    await service.shutdown();
  });

  it("orders a Telegram new command before the next message from the same provider second", async () => {
    const fixture = await seedCompany();
    const runtime = new FakeChatSdkRuntime();
    const deferred: Array<() => void> = [];
    const wakeup = vi.fn(async () => ({ accepted: true }));
    const service = chatChannelService(db, {
      deferWebhookProcessing: true,
      fetch: fakeTelegramFetch() as typeof globalThis.fetch,
      heartbeat: { wakeup: receiptBackedWakeup(wakeup) },
      publicBaseUrl: "https://paperclip.example",
      runtime: runtime as unknown as ChatSdkRuntime,
      scheduleDeferredWork: (task) => deferred.push(task),
    });
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "telegram", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: { botToken: "123456:telegram-command-order-test" },
      },
      "owner-user",
    );
    const callbacks = runtime.configurations.get(endpoint.id)?.callbacks;
    if (!callbacks?.onSlashCommand)
      throw new Error("Expected Telegram slash-command callbacks");

    const providerSecond = new Date(Math.floor(Date.now() / 1_000) * 1_000);
    const thread = makeThread({
      channelId: "D-TELEGRAM-CONTROL-ORDER",
      id: "telegram:D-TELEGRAM-CONTROL-ORDER",
      isDM: true,
      name: "Telegram command ordering",
    });
    await callbacks.onSlashCommand({
      endpointId: endpoint.id,
      provider: "telegram",
      event: {
        channel: {
          id: thread.thread.id,
          name: thread.thread.channel.name,
          isDM: true,
          post: vi.fn(),
        } as never,
        command: "/new",
        text: "",
        user: {
          userId: "77117711",
          userName: "telegram-order-user",
          fullName: "Telegram Order User",
          isBot: false,
          isMe: false,
          isSystem: false,
        },
        raw: {
          message_id: 110,
          date: Math.floor(providerSecond.getTime() / 1_000),
          chat: { id: 77117711, type: "private" },
          from: { id: 77117711, is_bot: false },
          text: "/new",
          entities: [{ offset: 0, length: 4, type: "bot_command" }],
        },
        adapter: {} as never,
        openModal: async () => undefined,
      },
    });
    const request = makeMessage({
      id: "telegram:77117711:111",
      raw: { message_id: 111, date: providerSecond.getTime() / 1_000 },
      text: "Start the task after resetting this chat",
      userId: "77117711",
    });
    request.metadata.dateSent = providerSecond;
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      providerUpdateId: 8011,
      thread: thread.thread,
      message: request,
      trigger: "direct_message",
    });

    const durable = await readChatDeliveriesByEndpointId(endpoint.id);
    expect(durable).toHaveLength(2);
    expect(durable).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          normalizedEvent: expect.objectContaining({
            message: expect.objectContaining({
              providerMessageId: "77117711:110",
              providerMessageSequence: 110,
              providerSentAt: providerSecond.toISOString(),
              providerSentAtSource: "telegram_message_date",
              text: "/new",
            }),
          }),
        }),
        expect.objectContaining({
          normalizedEvent: expect.objectContaining({
            message: expect.objectContaining({
              providerMessageSequence: 111,
              providerSentAt: providerSecond.toISOString(),
              providerSentAtSource: "telegram_message_date",
              text: "Start the task after resetting this chat",
            }),
          }),
        }),
      ]),
    );
    expect(deferred).toHaveLength(1);

    deferred.shift()?.();
    await vi.waitFor(() => expect(wakeup).toHaveBeenCalledTimes(1), {
      timeout: 3_000,
    });
    await expect(service.listConversations(endpoint.id)).resolves.toEqual([
      expect.objectContaining({ state: "active", sessionGeneration: 1 }),
    ]);
    expect(runtime.endpoints.get(endpoint.id)?.posts[0]?.text).toBe(
      "Send your request to start a new Paperclip task.",
    );
    // Command-only acknowledgements have no run whose final reply can retire
    // a processing reaction. The subsequent task message has its own receipt.
    expect(runtime.endpoints.get(endpoint.id)?.reactions).not.toContainEqual({
      threadId: "telegram:D-TELEGRAM-CONTROL-ORDER",
      messageId: "77117711:110",
      emoji: "eyes",
    });
    await service.shutdown();
  });

  it("holds a delayed Slack thread reply until its older root mention arrives", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } =
      await configuredSlackEndpoint(fixture);
    await db.insert(chatEndpointResources).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      type: "channel",
      providerResourceId: "C-DELAYED-ROOT",
      label: "delayed-root",
      availability: "available",
      enabled: true,
    });
    const thread = makeThread({
      channelId: "C-DELAYED-ROOT",
      id: "slack:C-DELAYED-ROOT:9110.1",
      name: "delayed-root",
    });
    const laterReply = makeMessage({
      id: "9110.2",
      text: "follow-up whose callback arrived first",
    });
    laterReply.metadata.dateSent = new Date("2026-09-05T18:20:02.000Z");
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: thread.thread,
      message: laterReply,
      trigger: "subscribed_message",
    });

    const [deferredReply] = await readChatDeliveriesByEndpointId(endpoint.id);
    expect(deferredReply).toMatchObject({
      state: "retry",
      attempts: 1,
      redactedError: "Waiting briefly for an earlier root mention",
    });
    expect(deferredReply.nextAttemptAt).not.toBeNull();
    expect(await service.listConversations(endpoint.id)).toHaveLength(0);

    const earlierRoot = makeMessage({
      id: "9110.1",
      text: "@maya keep both messages",
      mentioned: true,
    });
    earlierRoot.metadata.dateSent = new Date("2026-09-05T18:20:01.000Z");
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: thread.thread,
      message: earlierRoot,
      trigger: "mention",
    });
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(chatDeliveries.id, deferredReply.id));
    await service.processPendingDeliveries();

    const [conversation] = await service.listConversations(endpoint.id);
    expect(conversation).toMatchObject({ externalThreadId: thread.thread.id });
    await expect(
      db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, conversation!.issueId))
        .orderBy(asc(issueComments.createdAt), asc(issueComments.id)),
    ).resolves.toEqual([
      { body: "@maya keep both messages" },
      { body: "follow-up whose callback arrived first" },
    ]);
    expect(wakeup).toHaveBeenCalledTimes(2);
  });

  it("retains a standalone unaddressed Slack thread reply for the bounded reorder window", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } =
      await configuredSlackEndpoint(fixture);
    await db.insert(chatEndpointResources).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      type: "channel",
      providerResourceId: "C-ORPHAN-ONLY",
      label: "orphan-only",
      availability: "available",
      enabled: true,
    });
    const thread = makeThread({
      channelId: "C-ORPHAN-ONLY",
      id: "slack:C-ORPHAN-ONLY:9120.1",
      name: "orphan-only",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: thread.thread,
      message: makeMessage({ id: "9120.2", text: "not for the bot" }),
      trigger: "subscribed_message",
    });
    const [delivery] = await readChatDeliveriesByEndpointId(endpoint.id);
    expect(delivery).toMatchObject({ state: "retry", attempts: 1 });

    for (let expectedAttempt = 2; expectedAttempt <= 13; expectedAttempt += 1) {
      await db
        .update(chatDeliveries)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(chatDeliveries.id, delivery.id));
      await service.processPendingDeliveries();

      await expect(
        db
          .select({
            state: chatDeliveries.state,
            attempts: chatDeliveries.attempts,
          })
          .from(chatDeliveries)
          .where(eq(chatDeliveries.id, delivery.id)),
      ).resolves.toEqual([
        {
          state: expectedAttempt === 13 ? "filtered" : "retry",
          attempts: expectedAttempt,
        },
      ]);
    }
    expect(await service.listConversations(endpoint.id)).toHaveLength(0);
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("keeps Teams group chat closed by default without consuming first-channel setup enablement", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } =
      await configuredTeamsEndpoint(fixture);
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "verifying",
      allowGroupChats: false,
    });

    const serviceUrl = "https://smba.trafficmanager.net/amer/";
    const groupConversationId = "19:teams-setup-group@unq.gbl.spaces";
    const groupThread = makeThread({
      channelId: `teams:${Buffer.from(groupConversationId).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
      id: `teams:${Buffer.from(groupConversationId).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
      name: "Setup group",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: groupThread.thread,
      message: makeMessage({
        id: "teams-setup-group-disabled",
        text: "@maya this group is still closed",
        mentioned: true,
      }),
      trigger: "mention",
    });
    expect(wakeup).not.toHaveBeenCalled();
    const [filteredGroupDelivery] = await readChatDeliveriesByEndpointId(endpoint.id);
    expect(filteredGroupDelivery).toMatchObject({
      state: "filtered",
      attempts: 0,
      principalId: null,
      redactedError: "Destination is not enabled in Paperclip",
      normalizedEvent: {
        filtering: { contentRetained: false },
        message: { providerMessageId: "teams-setup-group-disabled" },
      },
    });
    expect(
      JSON.stringify(filteredGroupDelivery?.normalizedEvent),
    ).not.toContain("this group is still closed");
    expect(
      JSON.stringify(filteredGroupDelivery?.normalizedEvent),
    ).not.toContain("U-EXTERNAL");
    await expect(
      db
        .select({ id: chatExternalPrincipals.id })
        .from(chatExternalPrincipals)
        .where(
          and(
            eq(chatExternalPrincipals.companyId, fixture.companyId),
            eq(chatExternalPrincipals.provider, "microsoft-teams"),
          ),
        ),
    ).resolves.toHaveLength(0);

    const channelConversationId = "19:teams-first-channel@thread.tacv2";
    const rootMessageId = "1740000000091";
    const channelThread = makeThread({
      channelId: `teams:${Buffer.from(channelConversationId).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
      id: `teams:${Buffer.from(`${channelConversationId};messageid=${rootMessageId}`).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
      name: "First setup channel",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: channelThread.thread,
      message: makeMessage({
        id: rootMessageId,
        text: "@maya start the channel setup task",
        mentioned: true,
      }),
      trigger: "mention",
    });

    await expect(service.listConversations(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        externalThreadId: channelThread.thread.id,
        isDirectMessage: false,
      }),
    ]);
    await expect(service.listResources(endpoint.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerResourceId: groupConversationId,
          type: "group_chat",
          enabled: false,
        }),
        expect.objectContaining({
          providerResourceId: channelConversationId,
          type: "channel",
          enabled: true,
        }),
      ]),
    );
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it("continues a legacy Teams binding across a regional route change without forking its task", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service, wakeup } =
      await configuredTeamsEndpoint(fixture);
    // The inverted question mark contributes a `/` in standard base64, which
    // becomes `_` in base64url. Keep this fixture explicit so the canonical
    // decoder is exercised on an actual URL-safe alphabet difference.
    const conversationId = "19:stable-route-¿@thread.tacv2";
    const rootMessageId = "1740000000199";
    const rootedConversationId = `${conversationId};messageid=${rootMessageId}`;
    expect(Buffer.from(rootedConversationId).toString("base64url")).toContain(
      "_",
    );
    const amerServiceUrl = "https://smba.trafficmanager.net/amer/";
    const emeaServiceUrl = "https://smba.trafficmanager.net/emea/";
    const legacyThreadId = `teams:${Buffer.from(rootedConversationId).toString("base64url")}:${Buffer.from(amerServiceUrl).toString("base64url")}`;
    const canonicalThreadId = `teams:${Buffer.from(rootedConversationId).toString("base64url")}`;
    const legacyEmeaThreadId = `teams:${Buffer.from(rootedConversationId).toString("base64url")}:${Buffer.from(emeaServiceUrl).toString("base64url")}`;
    const legacyChannelId = `teams:${Buffer.from(conversationId).toString("base64url")}:${Buffer.from(amerServiceUrl).toString("base64url")}`;
    const canonicalChannelId = `teams:${Buffer.from(conversationId).toString("base64url")}`;
    const legacyThread = makeThread({
      channelId: legacyChannelId,
      id: legacyThreadId,
      name: "Stable Teams channel",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: legacyThread.thread,
      message: makeMessage({
        id: rootMessageId,
        mentioned: true,
        raw: {
          serviceUrl: amerServiceUrl,
          from: { aadObjectId: "stable-teams-user" },
        },
        text: "@maya preserve this task across route changes",
      }),
      trigger: "mention",
    });

    const canonicalThread = makeThread({
      channelId: canonicalChannelId,
      id: canonicalThreadId,
      name: "Stable Teams channel",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: canonicalThread.thread,
      message: makeMessage({
        id: "1740000000200",
        raw: {
          serviceUrl: emeaServiceUrl,
          from: { aadObjectId: "stable-teams-user" },
        },
        text: "continue after Microsoft moved the reply route",
      }),
      trigger: "subscribed_message",
    });

    const legacyEmeaThread = makeThread({
      channelId: `teams:${Buffer.from(conversationId).toString("base64url")}:${Buffer.from(emeaServiceUrl).toString("base64url")}`,
      id: legacyEmeaThreadId,
      name: "Stable Teams channel",
    });
    // A redelivery that straddles an adapter rollout changes only the thread
    // serialization. Its canonical delivery identity must still deduplicate.
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: legacyEmeaThread.thread,
      message: makeMessage({
        id: "1740000000200",
        raw: {
          serviceUrl: emeaServiceUrl,
          from: { aadObjectId: "stable-teams-user" },
        },
        text: "continue after Microsoft moved the reply route",
      }),
      trigger: "subscribed_message",
    });

    const conversations = await service.listConversations(endpoint.id);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({
      externalThreadId: legacyThreadId,
      sessionGeneration: 1,
    });
    await expect(
      db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, conversations[0]!.issueId))
        .orderBy(asc(issueComments.createdAt), asc(issueComments.id)),
    ).resolves.toEqual([
      { body: "@maya preserve this task across route changes" },
      { body: "continue after Microsoft moved the reply route" },
    ]);
    expect(wakeup).toHaveBeenCalledTimes(2);
    expect(
      runtime.endpoints.get(endpoint.id)?.recordedMicrosoftTeamsRoutes,
    ).toEqual([
      { threadId: legacyThreadId, serviceUrl: amerServiceUrl },
      { threadId: canonicalThreadId, serviceUrl: emeaServiceUrl },
      { threadId: legacyEmeaThreadId, serviceUrl: emeaServiceUrl },
    ]);

    // Also cover the reverse rolling-upgrade direction: a canonical row must
    // accept a legacy callback without creating another task.
    await db
      .update(chatConversations)
      .set({ externalThreadId: canonicalThreadId, updatedAt: new Date() })
      .where(eq(chatConversations.id, conversations[0]!.id));
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: legacyEmeaThread.thread,
      message: makeMessage({
        id: "1740000000201",
        raw: {
          serviceUrl: emeaServiceUrl,
          from: { aadObjectId: "stable-teams-user" },
        },
        text: "continue from a rolling legacy process",
      }),
      trigger: "subscribed_message",
    });
    const afterReverseRollout = await service.listConversations(endpoint.id);
    expect(afterReverseRollout).toHaveLength(1);
    expect(afterReverseRollout[0]).toMatchObject({
      externalThreadId: canonicalThreadId,
      issueId: conversations[0]!.issueId,
    });
    await expect(
      db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, conversations[0]!.issueId))
        .orderBy(asc(issueComments.createdAt), asc(issueComments.id)),
    ).resolves.toEqual([
      { body: "@maya preserve this task across route changes" },
      { body: "continue after Microsoft moved the reply route" },
      { body: "continue from a rolling legacy process" },
    ]);
    expect(wakeup).toHaveBeenCalledTimes(3);
  });

  it("presents a fresh Teams personal generation after close and a regional route change", async () => {
    const fixture = await seedCompany();
    const f = await configuredTeamsEndpoint(fixture);
    try {
      const channel = "a:post-close-regional-personal";
      const rootMessageId = "1740000000299";
      const rooted = channel;
      const channelBase = `teams:${Buffer.from(channel).toString("base64url")}`;
      const threadBase = `teams:${Buffer.from(rooted).toString("base64url")}`;
      const oldRoute = Buffer.from(
        "https://smba.trafficmanager.net/amer/",
      ).toString("base64url");
      const oldThread = makeThread({
        id: `${threadBase}:${oldRoute}`,
        channelId: `${channelBase}:${oldRoute}`,
        isDM: true,
        name: "Regional post-close proof",
      }).thread;
      const currentThread = makeThread({
        id: threadBase,
        channelId: channelBase,
        isDM: true,
        name: "Regional post-close proof",
      }).thread;
      const controlTime = new Date(Date.now() - 10_000);
      const receive = async (
        thread: Thread,
        id: string,
        time: Date,
        text: string,
      ) => {
        await deliverMessage({
          callbacks: f.callbacks,
          endpointId: f.endpoint.id,
          provider: "microsoft-teams",
          thread,
          trigger: "direct_message",
          message: makeMessage({
            id,
            text,
            mentioned: true,
            userId: "teams-regional-author",
            raw: {
              timestamp: time.toISOString(),
              serviceUrl:
                thread.id === oldThread.id
                  ? "https://smba.trafficmanager.net/amer/"
                  : "https://smba.trafficmanager.net/emea/",
              from: { aadObjectId: "teams-regional-author" },
            },
          }),
        });
        return db
          .select()
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, f.endpoint.id),
              sql`${chatDeliveries.normalizedEvent}->'message'->>'providerMessageId' = ${id}`,
            ),
          )
          .then((rows) => rows[0]!);
      };
      await receive(
        oldThread,
        rootMessageId,
        new Date(controlTime.getTime() - 1_000),
        "@maya begin the stable channel task",
      );
      await qualifySetupRoundTrip(
        f.service,
        f.endpoint.id,
        "teams-regional-author",
      );
      await f.service.test(f.endpoint.id);
      const [original] = await f.service.listConversations(f.endpoint.id);
      await receive(oldThread, "teams-regional-close", controlTime, "/close");
      await f.service.processPendingPublications();
      expect((await f.service.listConversations(f.endpoint.id))[0]?.state).toBe(
        "completed",
      );
      const delivery = await receive(
        currentThread,
        "teams-regional-fresh",
        new Date(),
        "@maya answer this fresh request on the current route",
      );
      expect(delivery.state).toBe("processed");
      expect(delivery.conversationId).not.toBe(original.id);
      const current = (await f.service.listConversations(f.endpoint.id)).find(
        (row) => row.id === delivery.conversationId,
      )!;
      expect(current).toMatchObject({
        state: "active",
        externalThreadId: currentThread.id,
        sessionGeneration: original.sessionGeneration + 1,
      });
      expect(current.issueId).not.toBe(original.issueId);
      const context = await chatWakeContext({
        endpointId: f.endpoint.id,
        issueId: current.issueId,
        provider: "microsoft-teams",
        providerMessageId: "teams-regional-fresh",
      });
      const [action] = await db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.deliveryId, delivery.id),
            eq(chatActions.kind, "inbound_wakeup"),
          ),
        );
      expect(action?.status).toBe("processed");
      const runId = randomUUID();
      await db
        .insert(heartbeatRuns)
        .values({
          id: runId,
          companyId: fixture.companyId,
          agentId: fixture.assignedAgentId,
          nativeIssueId: current.issueId,
          runtimeMode: "native",
          status: "running",
          startedAt: new Date(),
          wakeupRequestId: action!.id,
          contextSnapshot: {
            ...context,
            endpointId: f.endpoint.id,
            paperclipHarnessCheckedOut: true,
          },
        });
      await db
        .update(agentWakeupRequests)
        .set({ runId, status: "claimed" })
        .where(eq(agentWakeupRequests.id, action!.id));
      await expect(
        resolveChatRunPresentationAuthorizationReason(db, {
          companyId: fixture.companyId,
          issueId: current.issueId,
          runId,
        }),
      ).resolves.toBe("allow_chat_run_presentation");
    } finally {
      await retirePublicationFixture(f.service, f.endpoint.id);
    }
  });

  it("applies the Teams direct-message reach toggle and starts a new generation after task completion", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } =
      await configuredTeamsEndpoint(fixture);
    const directThread = makeThread({
      channelId: "teams-personal-reach",
      id: "teams:personal-reach",
      isDM: true,
      name: "Teams personal reach",
    });
    const providerTimestamp = "2026-09-05T18:15:00.000Z";
    const send = (id: string, text: string) =>
      deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider: "microsoft-teams",
        thread: directThread.thread,
        message: makeMessage({
          id,
          raw: {
            from: { aadObjectId: "6c4dd0ef-f027-4b75-93d9-04d97424220e" },
            timestamp: providerTimestamp,
          },
          text,
          userId: "29:teams-direct-reach",
        }),
        trigger: "direct_message",
      });

    await service.update(
      endpoint.id,
      { allowDirectMessages: false },
      "owner-user",
    );
    await send("teams-direct-disabled", "This must remain outside Paperclip");
    expect(await service.listConversations(endpoint.id)).toEqual([]);
    expect(wakeup).not.toHaveBeenCalled();
    await expect(
      db
        .select({
          state: chatDeliveries.state,
          redactedError: chatDeliveries.redactedError,
          normalizedEvent: chatDeliveries.normalizedEvent,
          principalId: chatDeliveries.principalId,
        })
        .from(chatDeliveries)
        .where(eq(chatDeliveries.endpointId, endpoint.id)),
    ).resolves.toEqual([
      {
        state: "filtered",
        redactedError: "Destination is not enabled in Paperclip",
        normalizedEvent: expect.objectContaining({
          providerEventId: `${directThread.thread.id}:teams-direct-disabled`,
          kind: "direct_message",
          trigger: "direct_message",
          resource: {
            type: "direct_message",
            providerResourceId: "teams-personal-reach",
          },
          conversation: { externalThreadId: directThread.thread.id },
          message: {
            providerMessageId: "teams-direct-disabled",
            providerSentAt: providerTimestamp,
          },
          filtering: { contentRetained: false },
        }),
        principalId: null,
      },
    ]);
    const disabledDelivery = await db
      .select({ normalizedEvent: chatDeliveries.normalizedEvent })
      .from(chatDeliveries)
      .where(eq(chatDeliveries.endpointId, endpoint.id))
      .then((rows) => rows[0]);
    expect(JSON.stringify(disabledDelivery)).not.toContain(
      "This must remain outside Paperclip",
    );
    expect(JSON.stringify(disabledDelivery)).not.toContain(
      "6c4dd0ef-f027-4b75-93d9-04d97424220e",
    );
    await expect(
      db
        .select({ id: chatExternalPrincipals.id })
        .from(chatExternalPrincipals)
        .where(eq(chatExternalPrincipals.companyId, fixture.companyId)),
    ).resolves.toHaveLength(0);

    await service.update(
      endpoint.id,
      { allowDirectMessages: true },
      "owner-user",
    );
    await send("teams-direct-first", "Start the first direct-message task");
    const [firstConversation] = await service.listConversations(endpoint.id);
    expect(firstConversation).toMatchObject({
      isDirectMessage: true,
      sessionGeneration: 1,
      state: "active",
    });
    await db
      .update(issues)
      .set({ status: "done", completedAt: new Date(), updatedAt: new Date() })
      .where(eq(issues.id, firstConversation!.issueId));

    await send("teams-direct-second", "Start a fresh task after completion");
    const conversations = await service.listConversations(endpoint.id);
    expect(conversations).toHaveLength(2);
    expect(
      conversations.find(
        (conversation) => conversation.id === firstConversation!.id,
      ),
    ).toMatchObject({
      issueId: firstConversation!.issueId,
      sessionGeneration: 1,
      state: "completed",
    });
    const nextConversation = conversations.find(
      (conversation) => conversation.id !== firstConversation!.id,
    );
    expect(nextConversation).toMatchObject({
      sessionGeneration: 2,
      state: "active",
    });
    expect(nextConversation!.issueId).not.toBe(firstConversation!.issueId);
    expect(
      new Set(conversations.map((conversation) => conversation.issueId)).size,
    ).toBe(2);
    expect(wakeup).toHaveBeenCalledTimes(2);
  });
});
