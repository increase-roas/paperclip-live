import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, chatActions, chatDeliveries, chatExternalPrincipals, chatPublications, heartbeatRuns } from "@paperclipai/db";
import { createChatSdkEndpointRuntime } from "../../services/chat-sdk-runtime.js";
import { createTeamsAdapter } from "@chat-adapter/teams";
import { bindTeamsPersonalRecipient, parseTeamsPersonalRecipient, parseTeamsPersonalRecipientBinding, type TeamsPersonalRecipientAdmission } from "../../services/chat-teams-personal-recipient.js";
import { resolveChatRunPresentationAuthorizationReason } from "../../services/chat-run-publications.js";
import { FakeChatSdkRuntime, fakeTelegramFetch, makeThread } from ".././helpers/chat-channels-fixture.js";
import { chatWakeContext, configuredTeamsEndpoint, configuredTelegramEndpoint, createService, db, deliverMessage, describeChatChannelsSuite, readChatConversationsById, readChatDeliveriesByEndpointId, readChatDeliveriesById, retirePublicationFixture, seedCompany } from "../helpers/chat-channels-harness.js";







describeChatChannelsSuite("chat channels 44-provider-timestamp-provenance-after-clos", () => {
  describe("provider timestamp provenance after closed conversations", () => {
    async function assertTimestampBinding(input: {
      context: Awaited<ReturnType<typeof configuredTeamsEndpoint>>;
      fixture: Awaited<ReturnType<typeof seedCompany>>;
      delivery: typeof chatDeliveries.$inferSelect;
      expected: string | null;
      marker: string;
    }) {
      const { context, fixture, delivery, expected, marker } = input;
      const normalized = delivery.normalizedEvent.message as Record<
        string,
        unknown
      >;
      expect(normalized.providerSentAt).toBe(expected);
      expect(normalized.providerSentAtSource).toBe(expected ? marker : undefined);
      await db
        .update(chatDeliveries)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(chatDeliveries.id, delivery.id));
      await context.service.processPendingDeliveries(25, delivery.id);
      const [processed] = await readChatDeliveriesById(delivery.id);
      expect(processed).toMatchObject({
        state: "processed",
        normalizedEvent: delivery.normalizedEvent,
      });
      const [conversation] = await readChatConversationsById(processed!.conversationId!);
      const snapshot = await chatWakeContext({
        endpointId: context.endpoint.id,
        issueId: conversation!.issueId,
        provider: context.endpoint.provider,
        providerMessageId: String(normalized.providerMessageId),
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
      // Real service admission; the fixture scheduler does not run a model.
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        runtimeMode: "native",
        nativeIssueId: conversation!.issueId,
        status: "running",
        wakeupRequestId: action!.id,
        startedAt: new Date(),
        contextSnapshot: { ...snapshot, paperclipHarnessCheckedOut: true },
      });
      await db
        .update(agentWakeupRequests)
        .set({ runId, status: "claimed" })
        .where(eq(agentWakeupRequests.id, action!.id));
      const authority = () =>
        resolveChatRunPresentationAuthorizationReason(db, {
          companyId: fixture.companyId,
          issueId: conversation!.issueId,
          runId,
        });
      // Missing timestamp provenance does not disable ordinary no-close work.
      await expect(authority()).resolves.toBe("allow_chat_run_presentation");
      // Deliberately unproved historical-control fixture. This bare publication
      // is not an authorized /close and does not simulate a Teams personal
      // close remaining in the same generation. Valid source clocks cannot
      // manufacture its missing original command and authorization receipts.
      const [unprovedControl] = await db
        .insert(chatPublications)
        .values({
          companyId: fixture.companyId,
          endpointId: context.endpoint.id,
          conversationId: conversation!.id,
          issueId: conversation!.issueId,
          idempotencyKey: `control:close:timestamp-fixture:${randomUUID()}`,
          payload: { text: "Historical conversation close" },
          state: "published",
          providerMessageId: "historical-control",
          publishedAt: new Date(
            (expected ? Date.parse(expected) : delivery.receivedAt.getTime()) -
              5_000,
          ),
        })
        .returning({ id: chatPublications.id });
      await expect(
        db
          .select({ id: chatActions.id })
          .from(chatActions)
          .where(
            eq(
              chatActions.providerActionId,
              `task-control-authorization:${unprovedControl!.id}`,
            ),
          ),
      ).resolves.toEqual([]);
      await expect(authority()).resolves.toBe("internal_agent_write");
      // A retained SDK display clock, missing marker, or foreign marker cannot
      // turn that unproved history into permission to publish either.
      const legacyMessage: Record<string, unknown> = {
        ...normalized,
        providerSentAt: expected ?? delivery.receivedAt.toISOString(),
      };
      delete legacyMessage.providerSentAtSource;
      await db
        .update(chatDeliveries)
        .set({
          normalizedEvent: {
            ...delivery.normalizedEvent,
            message: legacyMessage,
          },
        })
        .where(eq(chatDeliveries.id, delivery.id));
      await expect(authority()).resolves.toBe("internal_agent_write");
      await db
        .update(chatDeliveries)
        .set({
          normalizedEvent: {
            ...delivery.normalizedEvent,
            message: {
              ...legacyMessage,
              providerSentAtSource: "other_provider_clock",
            },
          },
        })
        .where(eq(chatDeliveries.id, delivery.id));
      await expect(authority()).resolves.toBe("internal_agent_write");
      await db
        .update(chatDeliveries)
        .set({ normalizedEvent: delivery.normalizedEvent })
        .where(eq(chatDeliveries.id, delivery.id));
      await expect(authority()).resolves.toBe("internal_agent_write");
    }

    it.each([
      "missing",
      "empty",
      "invalid",
      "numeric",
      "hour24",
      "calendar",
      "valid",
      "date_object",
      "display_override",
    ] as const)(
      "retains only the actual Teams activity clock, not SDK display fallback (%s)",
      async (mode) => {
        const fixture = await seedCompany();
        const context = await configuredTeamsEndpoint(fixture, {
          deferWebhookProcessing: true,
          scheduleDeferredWork: () => undefined,
        });
        const config = context.runtime.configurations.get(
          context.endpoint.id,
        )!.providerConfig;
        if (config.provider !== "microsoft-teams")
          throw new Error("Expected Teams");
        const adapter = createTeamsAdapter({ ...config.credentials });
        const timestamp = new Date(Date.now() - 1_000).toISOString();
        const raw = {
          id: `timestamp-${randomUUID()}`,
          type: "message",
          channelId: "msteams",
          ...(mode === "missing"
            ? {}
            : {
                timestamp:
                  mode === "empty"
                    ? ""
                    : mode === "invalid"
                      ? "not-a-date"
                      : mode === "numeric"
                        ? Date.now()
                        : mode === "hour24"
                          ? "2026-09-08T24:00:00Z"
                          : mode === "calendar"
                            ? "2026-02-30T00:00:00Z"
                            : mode === "date_object"
                              ? new Date(timestamp)
                              : timestamp,
              }),
          serviceUrl: "https://smba.trafficmanager.net/amer/",
          from: {
            id: `29:${randomUUID()}`,
            aadObjectId: randomUUID(),
            name: "Timestamp fixture",
          },
          recipient: { id: `28:${config.credentials.appId}` },
          conversation: {
            id: `a:${randomUUID()}`,
            conversationType: "personal",
            tenantId: config.credentials.appTenantId,
          },
          channelData: { tenant: { id: config.credentials.appTenantId } },
          text: "Keep this exact timestamp source",
        };
        const message = adapter.parseMessage(raw);
        const providerRuntime = context.runtime.endpoints.get(
          context.endpoint.id,
        )!;
        const getThread = providerRuntime.thread.bind(providerRuntime);
        vi.spyOn(providerRuntime, "thread").mockImplementation((id) => ({
          ...getThread(id),
          isDM: adapter.isDM(id),
        }));
        if (mode === "display_override") message.metadata.dateSent = new Date();
        const display = message.metadata.dateSent.getTime();
        try {
          await deliverMessage({
            callbacks: context.callbacks,
            endpointId: context.endpoint.id,
            provider: "microsoft-teams",
            thread: makeThread({
              id: message.threadId,
              channelId: message.threadId,
              isDM: true,
            }).thread,
            message,
            trigger: "direct_message",
          });
          const [delivery] = await readChatDeliveriesByEndpointId(context.endpoint.id);
          expect(delivery?.state).toBe("received");
          expect(message.metadata.dateSent.getTime()).toBe(display);
          await assertTimestampBinding({
            context,
            fixture,
            delivery: delivery!,
            expected: ["valid", "date_object", "display_override"].includes(
              mode,
            )
              ? timestamp
              : null,
            marker: "teams_activity_timestamp",
          });
        } finally {
          await retirePublicationFixture(context.service, context.endpoint.id);
        }
      },
    );

    it.each(["ordinary", "task"] as const)(
      "retains only raw Telegram date through the pinned parser or runtime slash path (%s)",
      async (path) => {
        for (const mode of ["missing", "invalid", "valid"] as const) {
          const fixture = await seedCompany();
          const context = await configuredTelegramEndpoint(fixture, {
            deferWebhookProcessing: true,
            scheduleDeferredWork: () => undefined,
          });
          const configuration = context.runtime.configurations.get(
            context.endpoint.id,
          )!;
          if (configuration.providerConfig.provider !== "telegram")
            throw new Error("Expected Telegram");
          const current = await context.service.get(context.endpoint.id);
          const providerFetch = fakeTelegramFetch(
            Number(current.botExternalId),
          );
          const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockImplementation(async (input) =>
              String(input).endsWith("/sendChatAction")
                ? Response.json({ ok: true, result: true })
                : providerFetch(input),
            );
          const pinned = createChatSdkEndpointRuntime({
            ...configuration,
            logger: "silent",
          });
          try {
            await pinned.initialize();
            const providerRuntime = context.runtime.endpoints.get(
              context.endpoint.id,
            )!;
            Object.assign(providerRuntime, {
              parseTelegramCommandMessage:
                pinned.parseTelegramCommandMessage.bind(pinned),
            });
            const date = Math.floor(Date.now() / 1_000) - 1;
            const text =
              path === "task"
                ? "/task Keep this exact timestamp source"
                : "Keep this exact timestamp source";
            const raw = {
              message_id: 41,
              ...(mode === "missing"
                ? {}
                : { date: mode === "invalid" ? "not-a-date" : date }),
              chat: { id: 77117711, type: "private" },
              from: {
                id: 77117711,
                is_bot: false,
                first_name: "Timestamp fixture",
              },
              text,
              ...(path === "task"
                ? { entities: [{ type: "bot_command", offset: 0, length: 5 }] }
                : {}),
            };
            if (path === "ordinary") {
              // Missing-date ordinary messages fail earlier SDK serialization;
              // isolate the real parser→service boundary here without claiming
              // that malformed ordinary input traverses the webhook dispatcher.
              const message = pinned.parseTelegramCommandMessage(raw)!;
              await deliverMessage({
                callbacks: context.callbacks,
                endpointId: context.endpoint.id,
                provider: "telegram",
                message,
                thread: makeThread({
                  id: message.threadId,
                  channelId: "77117711",
                  isDM: true,
                }).thread,
                trigger: "direct_message",
              });
            } else {
              const response = await pinned.handleWebhook(
                new Request("https://paperclip.example/timestamp-fixture", {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    "x-telegram-bot-api-secret-token":
                      configuration.providerConfig.credentials.secretToken,
                  },
                  body: JSON.stringify({ update_id: 900, message: raw }),
                }),
              );
              expect(response.status).toBe(200);
            }
            const [delivery] = await readChatDeliveriesByEndpointId(context.endpoint.id);
            expect(delivery?.state).toBe("received");
            await assertTimestampBinding({
              context,
              fixture,
              delivery: delivery!,
              expected:
                mode === "valid" ? new Date(date * 1_000).toISOString() : null,
              marker: "telegram_message_date",
            });
          } finally {
            await pinned.shutdown();
            fetchSpy.mockRestore();
            await retirePublicationFixture(
              context.service,
              context.endpoint.id,
            );
          }
        }
      },
    );
  });

  describe("Teams personal-recipient admission and durable restart", () => {
    async function recipientFixture() {
      const fixture = await seedCompany();
      const context = await configuredTeamsEndpoint(fixture, {
        deferWebhookProcessing: true,
        scheduleDeferredWork: () => undefined,
      });
      const configuration = context.runtime.configurations.get(
        context.endpoint.id,
      )!;
      if (configuration.providerConfig.provider !== "microsoft-teams") {
        throw new Error("Expected Teams provider configuration");
      }
      const credentials = configuration.providerConfig.credentials;
      const tenantId = String(credentials.appTenantId);
      const botAppId = String(credentials.appId);
      const aadObjectId = randomUUID();
      const providerUserId = `29:personal-${randomUUID()}`;
      const providerConversationId = `a:personal-${randomUUID()}`;
      const adapter = createTeamsAdapter({
        appId: botAppId,
        appPassword: "synthetic-unused-parser-secret",
        appTenantId: tenantId,
        appType: "SingleTenant",
      });
      const raw = {
        id: `recipient-${randomUUID()}`,
        type: "message",
        channelId: "msteams",
        timestamp: new Date().toISOString(),
        serviceUrl: "https://smba.trafficmanager.net/amer/",
        from: { id: providerUserId, aadObjectId, name: "Recipient Fixture" },
        recipient: { id: `28:${botAppId}` },
        conversation: {
          id: providerConversationId,
          conversationType: "personal",
          tenantId,
        },
        channelData: { tenant: { id: tenantId } },
        text: "Keep this exact personal request",
        token: "SYNTHETIC-RECIPIENT-TOKEN-NEVER-PERSIST",
      };
      // Real installed normalization; the service runtime, provider transport
      // and scheduler below are fake. This is not a JWT/live Teams send proof.
      const message = adapter.parseMessage(raw);
      const sourceThread = makeThread({
        id: message.threadId,
        channelId: message.threadId,
        isDM: true,
        name: "Personal recipient fixture",
      });
      const restart = () => {
        const runtime = new FakeChatSdkRuntime();
        const replace = runtime.replaceEndpoint.bind(runtime);
        vi.spyOn(runtime, "replaceEndpoint").mockImplementation(
          async (options) => {
            const endpointRuntime = await replace(options);
            const thread = endpointRuntime.thread.bind(endpointRuntime);
            vi.spyOn(endpointRuntime, "thread").mockImplementation((id) => ({
              ...thread(id),
              isDM: adapter.isDM(id),
            }));
            return endpointRuntime;
          },
        );
        return createService(runtime, undefined, {
          scheduleDeferredWork: () => undefined,
        });
      };
      return {
        ...context,
        fixture,
        adapter,
        raw,
        message,
        sourceThread,
        tenantId,
        botAppId,
        aadObjectId,
        providerUserId,
        providerConversationId,
        restart,
      };
    }

    it("preserves actual-parser personal recipient proof across database admission and reconstructed restart", async () => {
      const context = await recipientFixture();
      let restarted: ReturnType<typeof createService> | undefined;
      try {
        await deliverMessage({
          callbacks: context.callbacks,
          endpointId: context.endpoint.id,
          provider: "microsoft-teams",
          thread: context.sourceThread.thread,
          message: context.message,
          trigger: "direct_message",
        });
        const [received] = await readChatDeliveriesByEndpointId(context.endpoint.id);
        expect(received).toMatchObject({
          state: "received",
          attempts: 0,
          conversationId: null,
        });
        const origin = received!.normalizedEvent.runtimeContext as {
          generation: number;
          credentialFingerprint: string;
        };
        const admission: TeamsPersonalRecipientAdmission = {
          companyId: context.fixture.companyId,
          endpointId: context.endpoint.id,
          runtimeGeneration: origin.generation,
          credentialFingerprint: origin.credentialFingerprint,
          tenantId: context.tenantId,
          botAppId: context.botAppId,
          providerEventId: received!.providerEventId,
          threadId: context.message.threadId,
          isDirectMessage: true,
        };
        const proof = received!.normalizedEvent.teamsPersonalRecipient;
        expect(proof).toEqual({
          schema: "paperclip.teams.personal-recipient.v1",
          companyId: context.fixture.companyId,
          endpointId: context.endpoint.id,
          runtimeGeneration: origin.generation,
          credentialFingerprint: origin.credentialFingerprint,
          tenantId: context.tenantId,
          botAppId: context.botAppId,
          aadObjectId: context.aadObjectId,
          providerUserId: context.providerUserId,
          providerConversationId: context.providerConversationId,
          providerActivityId: context.raw.id,
          providerEventId: received!.providerEventId,
        });
        expect(parseTeamsPersonalRecipient(proof, admission)).toEqual(proof);
        expect(JSON.stringify(proof)).not.toMatch(
          /SYNTHETIC-RECIPIENT|trafficmanager|Recipient Fixture|Keep this/,
        );
        expect(JSON.stringify(received!.normalizedEvent)).not.toContain(
          "SYNTHETIC-RECIPIENT-TOKEN",
        );
        expect(context.wakeup).not.toHaveBeenCalled();
        await context.service.shutdown();
        await db
          .update(chatDeliveries)
          .set({ nextAttemptAt: new Date(0) })
          .where(eq(chatDeliveries.id, received!.id));
        restarted = context.restart();
        await restarted.service.processPendingDeliveries(1, received!.id);
        const [processed] = await readChatDeliveriesById(received!.id);
        expect(processed).toMatchObject({ state: "processed" });
        expect(processed!.normalizedEvent).toEqual(received!.normalizedEvent);
        const [conversation] = await readChatConversationsById(processed!.conversationId!);
        const [principal] = await db
          .select()
          .from(chatExternalPrincipals)
          .where(
            and(
              eq(chatExternalPrincipals.companyId, context.fixture.companyId),
              eq(chatExternalPrincipals.externalId, context.aadObjectId),
            ),
          );
        expect(principal).toBeDefined();
        const scope = {
          admission,
          deliveryId: processed!.id,
          principalId: principal!.id,
          externalPrincipalId: principal!.externalId,
          conversationId: conversation!.id,
          conversationGeneration: conversation!.sessionGeneration,
        };
        const bound = bindTeamsPersonalRecipient(
          processed!.normalizedEvent.teamsPersonalRecipient,
          scope,
        );
        expect(bound).not.toBeNull();
        expect(
          parseTeamsPersonalRecipientBinding(
            JSON.parse(JSON.stringify(bound)),
            scope,
          ),
        ).toEqual(bound);
        expect(
          parseTeamsPersonalRecipientBinding(bound, {
            ...scope,
            conversationGeneration: scope.conversationGeneration + 1,
          }),
        ).toBeNull();
        expect(restarted.wakeup).toHaveBeenCalledTimes(1);
        await restarted.service.processPendingDeliveries(1, received!.id);
        expect(restarted.wakeup).toHaveBeenCalledTimes(1);
        expect(
          (
            await readChatDeliveriesById(received!.id)
          )[0]!.normalizedEvent,
        ).toEqual(received!.normalizedEvent);
      } finally {
        try {
          await context.service.shutdown();
        } finally {
          await retirePublicationFixture(
            restarted?.service ?? context.service,
            context.endpoint.id,
          );
        }
      }
    });

    it("does not invent personal recipient proof when an AAD-only legacy delivery resumes without original runtime evidence", async () => {
      const context = await recipientFixture();
      let restarted: ReturnType<typeof createService> | undefined;
      try {
        const providerEventId = `teams:${Buffer.from(context.providerConversationId).toString("base64url")}:${context.message.id}`;
        // A separate synthetic legacy receipt, not a stripped modern proof.
        // Its AAD principal and personal route cannot reconstruct BF from.id.
        const normalizedEvent = {
          providerEventId,
          kind: "direct_message",
          trigger: "direct_message",
          principal: {
            externalId: context.aadObjectId,
            displayName: "Legacy person",
            handle: "legacy",
          },
          conversation: {
            externalConversationId: context.message.threadId,
            externalThreadId: context.message.threadId,
            label: "Legacy personal",
            isDirectMessage: true,
            providerUrl: null,
          },
          message: {
            providerMessageId: context.message.id,
            text: "Legacy receipt",
            mentionedBot: false,
            attachments: [],
          },
        };
        const [received] = await db
          .insert(chatDeliveries)
          .values({
            companyId: context.fixture.companyId,
            endpointId: context.endpoint.id,
            providerEventId,
            deduplicationKey: createHash("sha256")
              .update(providerEventId)
              .digest("hex"),
            eventKind: "direct_message",
            normalizedEvent,
            state: "received",
            nextAttemptAt: new Date(0),
          })
          .returning();
        await context.service.shutdown();
        restarted = context.restart();
        await restarted.service.processPendingDeliveries(1, received!.id);
        const [processed] = await readChatDeliveriesById(received!.id);
        expect(processed).toMatchObject({
          state: "failed",
          redactedError:
            "This accepted chat message is no longer authorized to start work",
        });
        expect(processed!.normalizedEvent).toEqual(normalizedEvent);
        expect(
          processed!.normalizedEvent.teamsPersonalRecipient,
        ).toBeUndefined();
        expect(restarted.wakeup).not.toHaveBeenCalled();
        expect(JSON.stringify(processed!.normalizedEvent)).not.toContain(
          context.providerUserId,
        );
      } finally {
        try {
          await context.service.shutdown();
        } finally {
          await retirePublicationFixture(
            restarted?.service ?? context.service,
            context.endpoint.id,
          );
        }
      }
    });

    it("redacts a rejected personal destination instead of persisting its derived recipient proof", async () => {
      const context = await recipientFixture();
      try {
        await context.service.update(
          context.endpoint.id,
          { allowDirectMessages: false },
          "owner-user",
        );
        const callbacks = context.runtime.configurations.get(
          context.endpoint.id,
        )!.callbacks;
        await deliverMessage({
          callbacks,
          endpointId: context.endpoint.id,
          provider: "microsoft-teams",
          thread: context.sourceThread.thread,
          message: context.message,
          trigger: "direct_message",
        });
        const [delivery] = await readChatDeliveriesByEndpointId(context.endpoint.id);
        expect(delivery).toMatchObject({
          state: "filtered",
          conversationId: null,
          normalizedEvent: { filtering: { contentRetained: false } },
        });
        expect(
          delivery!.normalizedEvent.teamsPersonalRecipient,
        ).toBeUndefined();
        expect(JSON.stringify(delivery!.normalizedEvent)).not.toContain(
          context.providerUserId,
        );
        expect(JSON.stringify(delivery!.normalizedEvent)).not.toContain(
          context.aadObjectId,
        );
        expect(context.wakeup).not.toHaveBeenCalled();
      } finally {
        await retirePublicationFixture(context.service, context.endpoint.id);
      }
    });
  });
});
