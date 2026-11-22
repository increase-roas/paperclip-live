import { idleWorkSnapshot } from "../../services/task-admission.js";
import type { Db } from "@paperclipai/db";
import * as connectionCredentialBindings from "../../services/connection-credential-bindings.js";
import {  } from "../../services/connection-credential-bindings.js";
import { registerChatActionWork } from "../../services/chat-action-work.js";
import { createDeliveryWorkCoordinator } from "../../services/delivery-work-coordinator.js";
import { toolAccessService } from "../../services/tool-access.js";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, chatActions, chatConversations, chatEndpoints, chatPublications, chatTeamsFileTransfers, companySecretBindings, completionContracts, heartbeatRuns, issueAttachments, issueComments, issues, toolConnections } from "@paperclipai/db";
import type { InternalSetupState } from "../../services/chat-channels/runtime-types.js";
import { createChatSdkEndpointRuntime } from "../../services/chat-sdk-runtime.js";
import { issueService } from "../../services/issues.js";
import type { PrpStructuredRunResult, PrpTerminalState } from "../../vendor/paperclip-runner/index.js";
import { finalizeNativeRun, repairCommittedNativeChatResponse } from "../../services/native-runtime/native-run-finalizer.js";
import { NativeRunCoordinatorStore } from "../../services/native-runtime/native-run-coordinator-store.js";
import { FakeChatSdkRuntime, fakeTelegramFetch, makeMessage, makeThread } from ".././helpers/chat-channels-fixture.js";
import {
createService, db, deliverMessage, describeChatChannelsSuite, qualifySetupRoundTrip, readChatEndpointsById, readChatPublicationsById, readChatTeamsFileTransfersById, readHeartbeatRunsByCompanyId, readHeartbeatRunsById, readToolConnectionsById, retirePublicationFixture, seedCompany
} from "../helpers/chat-channels-harness.js";
import {
teamsFileAuthorityFixture
} from "../helpers/chat-channels-endpoint-fixtures.js";








describeChatChannelsSuite("chat channels 45-telegram-durable-private-draft-stop", () => {
  describe("Telegram durable private draft Stop", () => {
    async function draftFixture(
      reusedBotId?: number,
      webhookOk: unknown = true,
    ) {
      const fixture = await seedCompany();
      const providerFetch = fakeTelegramFetch(reusedBotId);
      const botToken = `123456:telegram-draft-${randomUUID().replaceAll("-", "")}`;
      let configuredWebhook: Record<string, unknown> | null = null;
      let subscriptionInfo: Record<string, unknown> | null = null;
      const maintenanceRequests: Array<{
        method: string;
        body: Record<string, unknown>;
      }> = [];
      let maintenanceHook:
        | ((
            method: string,
            body: Record<string, unknown>,
          ) => Promise<Response | undefined>)
        | undefined;
      const administrativeFetch = (async (input, init) => {
        const method = new URL(String(input)).pathname.split("/").at(-1)!;
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (
          subscriptionInfo &&
          new URL(String(input)).pathname.startsWith(
            `/bot${encodeURIComponent(botToken)}/`,
          ) &&
          ["getMe", "getWebhookInfo", "setWebhook"].includes(method)
        ) {
          maintenanceRequests.push({ method, body });
          const override = await maintenanceHook?.(method, body);
          if (override) return override;
          if (method === "getWebhookInfo")
            return Response.json({ ok: true, result: subscriptionInfo });
          if (method === "setWebhook") {
            subscriptionInfo = {
              ...subscriptionInfo,
              url: body.url,
              allowed_updates: body.allowed_updates,
              max_connections: body.max_connections,
            };
            return Response.json({ ok: true, result: true });
          }
          const result = await (await providerFetch(input)).json();
          return Response.json({
            ...result,
            result: { ...result.result, is_bot: true },
          });
        }
        if (method === "setWebhook") {
          configuredWebhook = body;
          return Response.json({ ok: webhookOk, result: true });
        }
        return providerFetch(input);
      }) as typeof fetch;
      const initial = createService(
        new FakeChatSdkRuntime(),
        administrativeFetch,
      );
      const created = await initial.service.create(
        fixture.companyId,
        {
          provider: "telegram",
          assignedAgentId: fixture.assignedAgentId,
          name: "Private draft fixture",
        },
        "owner-user",
      );
      await initial.service.configure(
        created.id,
        {
          action: "configure",
          credentials: {
            botToken,
          },
        },
        "owner-user",
      );
      let context = {
        ...initial,
        endpoint: created,
        callbacks: initial.runtime.configurations.get(created.id)!.callbacks,
      };
      const { endpoint, callbacks } = context;
      const chatId = "77118878";
      const threadId = `telegram:${chatId}:42`;
      const thread = makeThread({
        channelId: chatId,
        id: threadId,
        isDM: true,
        name: "Telegram private draft",
      });
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider: "telegram",
        thread: thread.thread,
        message: makeMessage({
          id: `${chatId}:71`,
          text: "Return the complete approved answer",
          userId: chatId,
        }),
        trigger: "direct_message",
      });
      await qualifySetupRoundTrip(context.service, endpoint.id, chatId);
      await context.service.test(endpoint.id);
      const [conversation] = await db
        .select()
        .from(chatConversations)
        .where(
          and(
            eq(chatConversations.endpointId, endpoint.id),
            eq(chatConversations.externalThreadId, threadId),
          ),
        );
      if (!conversation)
        throw new Error("Expected exact private topic conversation");
      const [currentEndpoint] = await readChatEndpointsById(endpoint.id);
      const botId = Number(currentEndpoint!.botExternalId);
      const requests: Array<{ method: string; body: Record<string, unknown> }> =
        [];
      let hook:
        | ((method: string, body: Record<string, unknown>) => Promise<void>)
        | undefined;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (input, init) => {
        const method = new URL(String(input)).pathname.split("/").at(-1)!;
        if (method === "getMe")
          return Response.json({
            ok: true,
            result: {
              id: botId,
              is_bot: true,
              first_name: "Fixture",
              username: "fixture_bot",
            },
          });
        const body = JSON.parse(String(init?.body ?? "{}"));
        requests.push({ method, body });
        await hook?.(method, body);
        if (method.endsWith("Draft"))
          return Response.json({ ok: true, result: true });
        if (!["sendMessage", "sendRichMessage"].includes(method))
          throw new Error("Unexpected draft fixture provider I/O");
        return Response.json({
          ok: true,
          result: {
            message_id: 900 + requests.length,
            date: 1,
            chat: { id: Number(chatId), type: "private" },
            from: { id: botId, is_bot: true, first_name: "Fixture" },
            text: "approved",
          },
        });
      });
      let pinned: ReturnType<typeof createChatSdkEndpointRuntime>;
      const install = async () => {
        const configuration = context.runtime.configurations.get(endpoint.id)!;
        pinned = createChatSdkEndpointRuntime({
          ...configuration,
          logger: "silent",
        });
        await pinned.initialize();
        Object.assign(context.runtime.endpoints.get(endpoint.id)!, {
          thread: (threadId: string) => pinned.thread(threadId),
          handleWebhook: (...args: Parameters<typeof pinned.handleWebhook>) =>
            pinned.handleWebhook(...args),
          streamTelegramDraft: (
            ...args: Parameters<typeof pinned.streamTelegramDraft>
          ) => pinned.streamTelegramDraft(...args),
        });
      };
      await install();
      let updateId = 900;
      const deliver = async (
        draftId: number,
        patch: Record<string, unknown> = {},
        validSecret = true,
        exactUpdateId?: number,
        retainedRuntime = false,
      ) => {
        const configuration = context.runtime.configurations.get(endpoint.id)!;
        if (configuration.providerConfig.provider !== "telegram")
          throw new Error("Expected Telegram");
        const request = new Request("https://paperclip.example/fixture", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-telegram-bot-api-secret-token": validSecret
              ? configuration.providerConfig.credentials.secretToken
              : "wrong",
          },
          body: JSON.stringify({
            update_id: exactUpdateId ?? ++updateId,
            stopped_message_generation: {
              chat: { id: Number(chatId), type: "private" },
              message_thread_id: 42,
              draft_id: draftId,
              ...patch,
            },
          }),
        });
        return retainedRuntime
          ? pinned.handleWebhook(request)
          : context.service.handleWebhook(
              endpoint.publicId,
              "telegram",
              request,
            );
      };
      return {
        fixture,
        endpoint,
        conversation,
        requests,
        maintenanceRequests,
        get configuredWebhook() {
          return configuredWebhook!;
        },
        setSubscriptionInfo(patch: Record<string, unknown>) {
          subscriptionInfo = {
            url: configuredWebhook!.url,
            has_custom_certificate: false,
            pending_update_count: 23,
            max_connections: 37,
            ip_address: "203.0.113.4",
            allowed_updates: ["message", "message_reaction", "future_update"],
            ...patch,
          };
        },
        setMaintenanceHook(value: typeof maintenanceHook) {
          maintenanceHook = value;
        },
        async processSubscriptionAttempt() {
          const previousRequests = maintenanceRequests.length;
          const candidates = await db
            .select({ id: chatEndpoints.id })
            .from(chatEndpoints)
            .where(
              and(
                eq(chatEndpoints.provider, "telegram"),
                eq(chatEndpoints.status, "active"),
              ),
            );
          const queued = await db
            .select({ id: chatActions.id })
            .from(chatActions)
            .where(
              and(
                eq(chatActions.kind, "telegram_maintenance"),
                inArray(chatActions.status, [
                  "received",
                  "processing",
                  "failed",
                ]),
              ),
            );
          // The worker deliberately scans finite pages. Older fixtures may
          // precede this endpoint; wait for its first attempt, not a UUID's
          // chance placement in the first page. Stop before retrying its RPC.
          for (
            let remaining = candidates.length + queued.length + 2;
            remaining > 0 && maintenanceRequests.length === previousRequests;
            remaining--
          ) {
            await context.service.processPendingDeliveries();
          }
          expect(maintenanceRequests.length).toBeGreaterThan(previousRequests);
        },
        deliver,
        botId,
        get context() {
          return context;
        },
        setHook(value: typeof hook) {
          hook = value;
        },
        async send(key: string) {
          return context.service.publishBoardMessage(
            endpoint.id,
            conversation.id,
            `Approved output ${"complete safe answer. ".repeat(60)}END-${key}`,
            key,
            "owner-user",
          );
        },
        actions: () =>
          db
            .select()
            .from(chatActions)
            .where(
              and(
                eq(chatActions.endpointId, endpoint.id),
                eq(chatActions.kind, "telegram_publication_draft"),
              ),
            )
            .orderBy(asc(chatActions.createdAt)),
        async restart() {
          const configuration = context.runtime.configurations.get(
            endpoint.id,
          )!;
          if (configuration.providerConfig.provider !== "telegram")
            throw new Error("Expected Telegram");
          await pinned.shutdown();
          await context.service.shutdown();
          const resumed = createService(
            new FakeChatSdkRuntime(),
            administrativeFetch,
          );
          context = { ...context, ...resumed };
          // Telegram is lazy, not a Gateway runtime. A verified inert update
          // initializes the new service's actual callback binding; the next
          // Stop below then traverses the pinned verifier/parser again.
          await context.service.handleWebhook(
            endpoint.publicId,
            "telegram",
            new Request("https://paperclip.example/fixture", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-telegram-bot-api-secret-token":
                  configuration.providerConfig.credentials.secretToken,
              },
              body: "{}",
            }),
          );
          await install();
        },
        async close() {
          try {
            await pinned.shutdown();
          } finally {
            try {
              await retirePublicationFixture(context.service, endpoint.id);
            } finally {
              globalThis.fetch = originalFetch;
            }
          }
        },
      };
    }

    it.each(["startup", "connection_commit", "rollback", "retry", "stale_claim"] as const)(
      "recovers Telegram maintenance from committed work and becomes SQL quiet: %s",
      async mode => {
        const lane = await draftFixture();
        const onError = vi.fn();
        const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError });
        const maintenance = () => db.select().from(chatActions).where(and(
          eq(chatActions.endpointId, lane.endpoint.id), eq(chatActions.kind, "telegram_maintenance"),
          sql`${chatActions.payload}->>'operation' = 'stop_subscription'`,
        ));
        try {
          await db.delete(chatActions).where(and(eq(chatActions.endpointId, lane.endpoint.id),
            eq(chatActions.kind, "telegram_stop_subscription")));
          lane.setSubscriptionInfo({});
          if (mode === "connection_commit" || mode === "rollback") {
            await toolAccessService(db).updateConnection(lane.endpoint.connectionId, { enabled: false });
          }
          if (mode === "stale_claim") {
            // Leave committed legacy work behind before starting the workers.
            await lane.context.service.processTelegramSubscriptionDiscovery();
            const [action] = await maintenance();
            expect(action).toBeDefined();
            await db.update(chatActions).set({ status: "processing", updatedAt: new Date(Date.now() - 120_000) })
              .where(eq(chatActions.id, action!.id));
          }
          let failedAt = 0;
          let sends = 0;
          if (mode === "retry") lane.setMaintenanceHook(async method => {
            if (method === "setWebhook" && sends++ === 0) {
              failedAt = Date.now();
              throw new Error("temporary subscription transport outage");
            }
            if (method === "setWebhook") expect(Date.now() - failedAt).toBeGreaterThanOrEqual(1000);
            return undefined;
          });
          await registerChatActionWork(coordinator, lane.context.service, () => true).ready;
          if (mode === "connection_commit" || mode === "rollback") {
            expect(lane.maintenanceRequests).toEqual([]);
            if (mode === "rollback") {
              await expect(db.transaction(async tx => {
                await toolAccessService(tx as unknown as Db).updateConnection(lane.endpoint.connectionId, { enabled: true });
                await new Promise(resolve => setTimeout(resolve, 25));
                expect(lane.maintenanceRequests).toEqual([]);
                throw new Error("rollback connection wake");
              })).rejects.toThrow("rollback connection wake");
              await vi.waitFor(() => {
                expect(coordinator.nextWakeAt()).toBeNull();
                expect(idleWorkSnapshot().active).toBe(0);
              }, { timeout: 10_000 });
              expect(lane.maintenanceRequests).toEqual([]);
              expect(await maintenance()).toEqual([]);
            }
            await db.transaction(async tx => {
              await toolAccessService(tx as unknown as Db).updateConnection(lane.endpoint.connectionId, { enabled: true });
              await new Promise(resolve => setTimeout(resolve, 25));
              expect(lane.maintenanceRequests).toEqual([]);
            });
          }
          await vi.waitFor(async () => {
            const actions = await maintenance();
            expect(actions).toHaveLength(1);
            expect(actions[0]?.status).toBe("processed");
            expect(actions[0]?.result?.attempts).toBe(mode === "retry" ? 2 : 1);
            expect(coordinator.nextWakeAt()).toBeNull();
            expect(idleWorkSnapshot().active).toBe(0);
          }, { timeout: 10_000 });
          expect(lane.maintenanceRequests.filter(x => x.method === "setWebhook")).toHaveLength(mode === "retry" ? 2 : 1);
          expect(await db.select().from(chatActions).where(and(eq(chatActions.endpointId, lane.endpoint.id),
            eq(chatActions.kind, "telegram_stop_subscription"), eq(chatActions.status, "processed")))).toHaveLength(1);
          const scans = vi.spyOn(db, "select");
          try {
            await new Promise(resolve => setTimeout(resolve, 1200));
            expect(scans).not.toHaveBeenCalled();
          } finally { scans.mockRestore(); }
          expect(onError).not.toHaveBeenCalled();
        } finally { await coordinator.stop(); await lane.close(); }
      },
    );

    it("commits chat connection credentials atomically before waking maintenance", async () => {
      const lane = await draftFixture();
      const onError = vi.fn();
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError });
      const bindings = () => db.select({ secretId: companySecretBindings.secretId, configPath: companySecretBindings.configPath })
        .from(companySecretBindings).where(and(eq(companySecretBindings.companyId, lane.fixture.companyId),
          eq(companySecretBindings.targetType, "tool_connection"), eq(companySecretBindings.targetId, lane.endpoint.connectionId)))
        .orderBy(asc(companySecretBindings.configPath));
      let release!: () => void;
      let entered!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const rebuilding = new Promise<void>(resolve => { entered = resolve; });
      let update: Promise<unknown> | undefined;
      const original = connectionCredentialBindings.syncConnectionCredentialBindings;
      const spy = vi.spyOn(connectionCredentialBindings, "syncConnectionCredentialBindings");
      try {
        await db.delete(chatActions).where(and(eq(chatActions.endpointId, lane.endpoint.id),
          eq(chatActions.kind, "telegram_stop_subscription")));
        lane.setSubscriptionInfo({});
        await lane.context.service.processTelegramSubscriptionDiscovery();
        await toolAccessService(db).updateConnection(lane.endpoint.connectionId, { enabled: false });
        await registerChatActionWork(coordinator, lane.context.service, () => true).ready;
        const before = await bindings();
        expect(before.length).toBeGreaterThan(0);
        spy.mockImplementation(async (database, connection, refs, client = database) => {
          if (connection.id === lane.endpoint.connectionId) {
            // Hold the real binding rebuild after its delete boundary. Another
            // connection must still see the old bindings until outer commit.
            await client.delete(companySecretBindings).where(and(eq(companySecretBindings.companyId, connection.companyId),
              eq(companySecretBindings.targetType, "tool_connection"), eq(companySecretBindings.targetId, connection.id)));
            entered();
            await held;
          }
          return original(database, connection, refs, client);
        });
        update = toolAccessService(db).updateConnection(lane.endpoint.connectionId, { name: "Renamed fixture", enabled: true });
        await rebuilding;
        expect(await bindings()).toEqual(before);
        await new Promise(resolve => setTimeout(resolve, 25));
        expect(lane.maintenanceRequests).toEqual([]);
        release();
        await update;
        await vi.waitFor(async () => {
          expect(await db.select({ status: chatActions.status }).from(chatActions).where(and(
            eq(chatActions.endpointId, lane.endpoint.id), eq(chatActions.kind, "telegram_maintenance"),
            sql`${chatActions.payload}->>'operation' = 'stop_subscription'`,
          ))).toEqual([{ status: "processed" }]);
          expect(coordinator.nextWakeAt()).toBeNull();
        }, { timeout: 10_000 });
        expect(await bindings()).toEqual(before);
        expect(lane.maintenanceRequests.filter(x => x.method === "setWebhook")).toHaveLength(1);
        expect(onError).not.toHaveBeenCalled();
      } finally { release(); await update; spy.mockRestore(); await coordinator.stop(); await lane.close(); }
    });

    it.each(["endpoint", "connection"] as const)("parks pending Telegram subscription repair while its %s is inactive", async inactive => {
      const lane = await draftFixture();
      const onError = vi.fn();
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError });
      const actions = () => db.select().from(chatActions).where(and(
        eq(chatActions.endpointId, lane.endpoint.id), eq(chatActions.kind, "telegram_maintenance"),
        sql`${chatActions.payload}->>'operation' = 'stop_subscription'`,
      ));
      try {
        await db.delete(chatActions).where(and(eq(chatActions.endpointId, lane.endpoint.id),
          eq(chatActions.kind, "telegram_stop_subscription")));
        lane.setSubscriptionInfo({});
        await lane.context.service.processTelegramSubscriptionDiscovery();
        expect(await actions()).toEqual([expect.objectContaining({ status: "received" })]);
        if (inactive === "endpoint") {
          await lane.context.service.configure(lane.endpoint.id, { action: "pause" }, "owner-user");
        } else {
          await toolAccessService(db).updateConnection(lane.endpoint.connectionId, { enabled: false });
        }
        await registerChatActionWork(coordinator, lane.context.service, () => true).ready;
        await vi.waitFor(() => {
          expect(coordinator.nextWakeAt()).toBeNull();
          expect(idleWorkSnapshot().active).toBe(0);
        }, { timeout: 10_000 });
        expect(await lane.context.service.nextChatActionAt("telegram_maintenance")).toBeNull();
        expect(lane.maintenanceRequests).toEqual([]);
        expect(await actions()).toEqual([expect.objectContaining({ status: "received" })]);
        const scans = vi.spyOn(db, "select");
        try {
          await new Promise(resolve => setTimeout(resolve, 1200));
          expect(scans).not.toHaveBeenCalled();
        } finally { scans.mockRestore(); }
        if (inactive === "endpoint") {
          await lane.context.service.configure(lane.endpoint.id, { action: "resume" }, "owner-user");
        } else {
          await toolAccessService(db).updateConnection(lane.endpoint.connectionId, { enabled: true });
        }
        await vi.waitFor(async () => {
          const rows = await actions();
          expect(rows.filter(row => row.status === "processed")).toEqual([
            expect.objectContaining({ result: expect.objectContaining({ attempts: 1 }) }),
          ]);
          // Endpoint pause/resume advances its ownership generation. The old
          // obligation must settle without touching the provider again.
          expect(rows.filter(row => row.status !== "processed")).toEqual(inactive === "endpoint" ? [
            expect.objectContaining({ status: "cancelled", result: expect.objectContaining({ code: "telegram_maintenance_credentials_superseded" }) }),
          ] : []);
          expect(coordinator.nextWakeAt()).toBeNull();
          expect(idleWorkSnapshot().active).toBe(0);
        }, { timeout: 10_000 });
        expect(lane.maintenanceRequests.filter(x => x.method === "setWebhook")).toHaveLength(1);
        expect(onError).not.toHaveBeenCalled();
      } finally { await coordinator.stop(); await lane.close(); }
    });

    it("durably stops during the first draft RPC without cancelling a run, and never reuses its ID after restart", async () => {
      const lane = await draftFixture();
      try {
        const runId = randomUUID();
        await db.insert(heartbeatRuns).values({
          id: runId,
          companyId: lane.fixture.companyId,
          agentId: lane.fixture.assignedAgentId,
          status: "running",
          contextSnapshot: {},
        });
        const runsBefore = (await readHeartbeatRunsByCompanyId(lane.fixture.companyId))
          .toSorted((a, b) => a.id.localeCompare(b.id));
        let stoppedId = 0;
        lane.setHook(async (method, body) => {
          if (method.endsWith("Draft") && !stoppedId) {
            stoppedId = Number(body.draft_id);
            expect((await lane.deliver(stoppedId)).status).toBe(200);
          }
        });
        const publication = await lane.send("first-stopped");
        expect(publication).toMatchObject({
          state: "cancelled",
          providerMessageId: null,
          publishedAt: null,
          redactedError:
            "Telegram draft presentation was stopped. The saved answer and task are unchanged.",
        });
        expect(lane.requests.map((request) => request.method)).toEqual([
          "sendRichMessageDraft",
        ]);
        expect((await lane.actions())[0]).toMatchObject({
          status: "cancelled",
          result: { phase: "stopped" },
        });
        const [comment] = await db
          .select()
          .from(issueComments)
          .where(eq(issueComments.id, publication!.commentId!));
        expect(comment!.body).toContain("END-first-stopped");
        expect(
          (await readHeartbeatRunsByCompanyId(lane.fixture.companyId))
            .toSorted((a, b) => a.id.localeCompare(b.id)),
        ).toEqual(runsBefore);
        expect(lane.context.cancelRun).not.toHaveBeenCalled();
        expect(
          await lane.context.service.getPublicationBatchStatus(
            lane.endpoint.id,
            lane.conversation.id,
            publication!.id,
          ),
        ).toMatchObject({
          published: 0,
          total: 1,
          cancelled: 1,
          settled: 1,
          canDismiss: true,
        });
        await expect(
          lane.context.service.replayPublication(
            lane.endpoint.id,
            publication!.id,
          ),
        ).rejects.toThrow();
        expect((await lane.deliver(stoppedId)).status).toBe(200);
        await lane.restart();
        await lane.context.service.processPendingPublications();
        expect(lane.requests).toHaveLength(1);
        lane.setHook(async (method) => {
          if (method.endsWith("Draft"))
            expect((await lane.deliver(stoppedId)).status).toBe(200);
        });
        const next = await lane.send("successor");
        expect(next?.state).toBe("published");
        const actions = await lane.actions();
        expect(actions).toHaveLength(2);
        expect(actions[1]!.payload.draftId).not.toBe(stoppedId);
        expect(actions[1]).toMatchObject({
          status: "processed",
          result: {
            phase: "published",
            providerMessageId: next!.providerMessageId,
          },
        });
        expect(
          lane.requests.filter((request) => !request.method.endsWith("Draft")),
        ).toHaveLength(1);
      } finally {
        await lane.close();
      }
    });

    it("does not reuse an old draft ID after endpoint cascade deletion and same-bot re-binding", async () => {
      const original = await draftFixture();
      let originalClosed = false;
      let successor: Awaited<ReturnType<typeof draftFixture>> | undefined;
      try {
        let oldDraftId = 0;
        original.setHook(async (method, body) => {
          if (method.endsWith("Draft")) {
            oldDraftId = Number(body.draft_id);
            expect((await original.deliver(oldDraftId)).status).toBe(200);
          }
        });
        expect((await original.send("before-delete"))?.state).toBe("cancelled");
        await original.close();
        originalClosed = true;
        await db
          .delete(chatEndpoints)
          .where(eq(chatEndpoints.id, original.endpoint.id));
        expect(await original.actions()).toEqual([]);
        successor = await draftFixture(original.botId);
        successor.setHook(async (method) => {
          if (method.endsWith("Draft"))
            expect((await successor!.deliver(oldDraftId)).status).toBe(200);
        });
        expect((await successor.send("after-rebind"))?.state).toBe("published");
        const [newDraft] = await successor.actions();
        expect(Number(newDraft!.payload.draftId)).toBeGreaterThan(oldDraftId);
        expect(newDraft).toMatchObject({ result: { phase: "published" } });
        expect(
          successor.requests.filter(
            (request) => !request.method.endsWith("Draft"),
          ),
        ).toHaveLength(1);
      } finally {
        try {
          if (successor) await successor.close();
        } finally {
          if (!originalClosed) await original.close();
        }
      }
    });

    it.each(["missing", "bot", "generation", "fingerprint", "url"] as const)(
      "sends ordinary complete output without Stop when subscription proof is %s",
      async (changed) => {
        const lane = await draftFixture();
        try {
          const [receipt] = await db
            .select()
            .from(chatActions)
            .where(
              and(
                eq(chatActions.endpointId, lane.endpoint.id),
                eq(chatActions.kind, "telegram_stop_subscription"),
              ),
            );
          expect(receipt?.status).toBe("processed");
          if (changed === "missing")
            await db.delete(chatActions).where(eq(chatActions.id, receipt!.id));
          else
            await db
              .update(chatActions)
              .set({
                payload: {
                  ...receipt!.payload,
                  ...(changed === "bot"
                    ? { botUserId: String(lane.botId + 1) }
                    : changed === "generation"
                      ? {
                          runtimeGeneration:
                            Number(receipt!.payload.runtimeGeneration) + 1,
                        }
                      : changed === "fingerprint"
                        ? { credentialFingerprint: "stale" }
                        : { webhookUrlSha256: "0".repeat(64) }),
                },
              })
              .where(eq(chatActions.id, receipt!.id));
          const publication = await lane.send(`subscription-${changed}`);
          expect(publication?.state).toBe("published");
          expect(lane.requests).toHaveLength(1);
          expect(lane.requests[0]!.method.endsWith("Draft")).toBe(false);
          expect(JSON.stringify(lane.requests[0]!.body)).toContain(
            `END-subscription-${changed}`,
          );
          expect(lane.requests[0]!.body.can_stop).toBeUndefined();
          expect(await lane.actions()).toEqual([]);
          expect(lane.context.cancelRun).not.toHaveBeenCalled();
        } finally {
          await lane.close();
        }
      },
    );

    it.each(["false", 1])(
      "does not confirm a subscription from non-boolean ok=%s",
      async (ok) => {
        const lane = await draftFixture(undefined, ok);
        try {
          expect(
            await db
              .select()
              .from(chatActions)
              .where(
                and(
                  eq(chatActions.endpointId, lane.endpoint.id),
                  eq(chatActions.kind, "telegram_stop_subscription"),
                ),
              ),
          ).toEqual([]);
          const publication = await lane.send("malformed-subscription");
          expect(publication?.state).toBe("published");
          expect(lane.requests).toHaveLength(1);
          expect(lane.requests[0]!.method.endsWith("Draft")).toBe(false);
          expect(JSON.stringify(lane.requests[0]!.body)).toContain(
            "END-malformed-subscription",
          );
          expect(lane.requests[0]!.body.can_stop).toBeUndefined();
          expect(await lane.actions()).toEqual([]);
        } finally {
          await lane.close();
        }
      },
    );

    it.each(["explicit", "empty", "omitted", "worker"] as const)(
      "automatically repairs an existing %s subscription after restart without dropping updates",
      async (mode) => {
        const shape = mode === "worker" ? "explicit" : mode;
        const lane = await draftFixture();
        const prefixIds: string[] = [];
        const onError = vi.fn();
        const coordinator = mode === "worker" ? createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError }) : null;
        try {
          // Scheduler-only fixtures model a full already-confirmed first page.
          // They have no credentials; no provider qualification is claimed for
          // these rows. The target still uses actual configure/runtime/Stop.
          const [templateEndpoint] = await readChatEndpointsById(lane.endpoint.id);
          const [templateConnection] = await readToolConnectionsById(lane.endpoint.connectionId);
          const fingerprint = createHash("sha256").update("[]").digest("hex");
          for (let index = 0; index < (mode === "worker" ? 105 : 25); index++) {
            const id = `00000000-${randomUUID().slice(9)}`;
            expect(id < lane.endpoint.id).toBe(true);
            const connectionId = randomUUID();
            const publicId = randomUUID();
            const botUserId = String(
              Number.parseInt(
                randomUUID().replaceAll("-", "").slice(0, 12),
                16,
              ),
            );
            const webhookUrlSha256 = createHash("sha256")
              .update(
                `https://paperclip.example/api/chat-webhooks/${publicId}/telegram`,
              )
              .digest("hex");
            await db.transaction(async (tx) => {
              await tx.insert(toolConnections).values({
                ...templateConnection!,
                id: connectionId,
                uid: `prefix-${connectionId}`,
                credentialRefs: [],
                credentialSecretRefs: [],
                config: {},
                transportConfig: {},
                status: "active",
                enabled: true,
              });
              await tx.insert(chatEndpoints).values({
                ...templateEndpoint!,
                id,
                connectionId,
                publicId,
                botExternalId: botUserId,
                botUsername: `prefix_${publicId}`,
                status: "active",
                setup: { ...templateEndpoint!.setup, runtimeGeneration: 1 } as InternalSetupState,
              });
              await tx.insert(chatActions).values({
                companyId: lane.fixture.companyId,
                endpointId: id,
                kind: "telegram_stop_subscription",
                providerActionId: `telegram-stop-subscription:1:${fingerprint}:${webhookUrlSha256}`,
                payload: {
                  version: 1,
                  botUserId,
                  runtimeGeneration: 1,
                  credentialFingerprint: fingerprint,
                  webhookUrlSha256,
                },
                status: "processed",
                result: { code: "telegram_stop_subscription_confirmed" },
              });
            });
            prefixIds.push(id);
          }
          await db
            .delete(chatActions)
            .where(
              and(
                eq(chatActions.endpointId, lane.endpoint.id),
                eq(chatActions.kind, "telegram_stop_subscription"),
              ),
            );
          lane.setSubscriptionInfo(
            shape === "explicit"
              ? {}
              : { allowed_updates: shape === "empty" ? [] : undefined },
          );
          await lane.restart();
          const prefixReceipts = await db
            .select()
            .from(chatActions)
            .where(inArray(chatActions.endpointId, prefixIds))
            .orderBy(asc(chatActions.id));
          const eligible = await db
            .select({ id: chatEndpoints.id })
            .from(chatEndpoints)
            .innerJoin(
              toolConnections,
              and(
                eq(toolConnections.id, chatEndpoints.connectionId),
                eq(toolConnections.companyId, chatEndpoints.companyId),
              ),
            )
            .where(
              and(
                eq(chatEndpoints.provider, "telegram"),
                eq(chatEndpoints.status, "active"),
                eq(toolConnections.status, "active"),
                eq(toolConnections.enabled, true),
              ),
            )
            .orderBy(asc(chatEndpoints.id));
          const targetIndex = eligible.findIndex(
            ({ id }) => id === lane.endpoint.id,
          );
          expect(targetIndex).toBeGreaterThanOrEqual(mode === "worker" ? 105 : 25);
          const discoveryPasses = Math.floor(targetIndex / 25) + 1;
          const targetActions = () =>
            db
              .select()
              .from(chatActions)
              .where(
                and(
                  eq(chatActions.endpointId, lane.endpoint.id),
                  eq(chatActions.kind, "telegram_maintenance"),
                  sql`${chatActions.payload}->>'operation' = 'stop_subscription'`,
                ),
              );
          if (coordinator) {
            await registerChatActionWork(coordinator, lane.context.service, () => true).ready;
            // Startup recovery uses successive bounded pages. The target is
            // beyond a complete 100-row confirmed prefix and is not in page one.
            expect(await targetActions()).toEqual([]);
            await vi.waitFor(async () => {
              expect((await targetActions())[0]?.status).toBe("processed");
              expect(coordinator.nextWakeAt()).toBeNull();
            }, { timeout: 30_000 });
            expect(onError).not.toHaveBeenCalled();
          } else for (let page = 1; page <= discoveryPasses; page++) {
            await lane.context.service.processPendingDeliveries();
            if (page < discoveryPasses) {
              expect(await targetActions()).toEqual([]);
              expect(lane.maintenanceRequests).toEqual([]);
            }
          }
          const [discovered] = await targetActions();
          expect(discovered).toBeDefined();
          // Discovery and action execution have independent 25-row budgets.
          // Include every older unsettled action, even future retries, so the
          // finite bound does not assume this global outbox is otherwise empty.
          const olderActions = await db
            .select({ id: chatActions.id })
            .from(chatActions)
            .where(
              and(
                eq(chatActions.kind, "telegram_maintenance"),
                sql`${chatActions.createdAt} <= ${new Date(discovered!.createdAt.getTime() + 1).toISOString()}::timestamptz`,
                inArray(chatActions.status, [
                  "received",
                  "processing",
                  "failed",
                ]),
              ),
            );
          for (
            let remaining = olderActions.length + 1;
            remaining > 0 &&
            !(await targetActions()).some(
              (action) => action.status === "processed",
            );
            remaining--
          )
            await lane.context.service.processPendingDeliveries();
          expect((await targetActions())[0]?.status).toBe("processed");
          expect(lane.maintenanceRequests.map(({ method }) => method)).toEqual([
            "getMe",
            "getWebhookInfo",
            "setWebhook",
            "getWebhookInfo",
          ]);
          expect(
            await db
              .select()
              .from(chatActions)
              .where(inArray(chatActions.endpointId, prefixIds))
              .orderBy(asc(chatActions.id)),
          ).toEqual(prefixReceipts);
          const mutations = lane.maintenanceRequests.filter(
            ({ method }) => method === "setWebhook",
          );
          expect(mutations).toHaveLength(1);
          if (coordinator) {
            // A committed edit must not rediscover another connection, even
            // when its durable proof is absent. Startup covers that inventory.
            const foreignEndpoint = prefixIds[0]!;
            await db.delete(chatActions).where(and(eq(chatActions.endpointId, foreignEndpoint),
              eq(chatActions.kind, "telegram_stop_subscription")));
            await toolAccessService(db).updateConnection(lane.endpoint.connectionId, { name: "Scoped Telegram edit" });
            await vi.waitFor(() => {
              expect(coordinator.nextWakeAt()).toBeNull();
              expect(idleWorkSnapshot().active).toBe(0);
            }, { timeout: 10_000 });
            expect(await db.select().from(chatActions).where(and(eq(chatActions.endpointId, foreignEndpoint),
              eq(chatActions.kind, "telegram_maintenance")))).toEqual([]);
            expect(lane.maintenanceRequests.filter(({ method }) => method === "setWebhook")).toHaveLength(1);
          }
          expect(mutations[0]!.body).toEqual({
            url: lane.configuredWebhook.url,
            secret_token: lane.configuredWebhook.secret_token,
            max_connections: 37,
            drop_pending_updates: false,
            allowed_updates:
              shape === "explicit"
                ? [
                    "message",
                    "message_reaction",
                    "future_update",
                    "stopped_message_generation",
                  ]
                : [],
          });
          expect(
            await db
              .select()
              .from(chatActions)
              .where(
                and(
                  eq(chatActions.endpointId, lane.endpoint.id),
                  eq(chatActions.kind, "telegram_stop_subscription"),
                ),
              ),
          ).toHaveLength(1);
          lane.setHook(async (method, body) => {
            if (method.endsWith("Draft"))
              expect((await lane.deliver(Number(body.draft_id))).status).toBe(
                200,
              );
          });
          expect((await lane.send(`upgraded-${shape}`))?.state).toBe(
            "cancelled",
          );
          expect(lane.requests.map(({ method }) => method)).toEqual([
            "sendRichMessageDraft",
          ]);
          await lane.context.service.processPendingDeliveries();
          expect(
            lane.maintenanceRequests.filter(
              ({ method }) => method === "setWebhook",
            ),
          ).toHaveLength(1);
        } finally {
          try {
            await coordinator?.stop();
            if (prefixIds.length)
              await db
                .update(chatEndpoints)
                .set({ status: "archived", archivedAt: new Date() })
                .where(
                  and(
                    eq(chatEndpoints.companyId, lane.fixture.companyId),
                    inArray(chatEndpoints.id, prefixIds),
                  ),
                );
          } finally {
            await lane.close();
          }
        }
      },
    );

    it.each([
      "foreign_url",
      "certificate",
      "malformed_updates",
      "malformed_max",
      "wrong_bot",
      "nonboolean_ok",
      "missing_result",
      "contradictory_get",
      "changed_generation",
      "disabled_connection",
    ] as const)(
      "keeps ordinary output when automatic subscription repair is unsafe: %s",
      async (mode) => {
        const lane = await draftFixture();
        try {
          await db
            .delete(chatActions)
            .where(
              and(
                eq(chatActions.endpointId, lane.endpoint.id),
                eq(chatActions.kind, "telegram_stop_subscription"),
              ),
            );
          lane.setSubscriptionInfo(
            mode === "foreign_url"
              ? { url: "https://elsewhere.example/callback" }
              : mode === "certificate"
                ? { has_custom_certificate: true }
                : mode === "malformed_updates"
                  ? { allowed_updates: null }
                  : mode === "malformed_max"
                    ? { max_connections: 101 }
                    : {},
          );
          let getCount = 0;
          lane.setMaintenanceHook(async (method) => {
            if (method === "getMe" && mode === "wrong_bot")
              return Response.json({
                ok: true,
                result: { id: lane.botId + 1, is_bot: true },
              });
            if (method === "setWebhook" && mode === "nonboolean_ok")
              return Response.json({ ok: "false", result: true });
            if (method === "setWebhook" && mode === "missing_result")
              return Response.json({ ok: true });
            if (method === "getWebhookInfo") {
              getCount++;
              if (mode === "contradictory_get" && getCount === 2)
                return Response.json({
                  ok: true,
                  result: {
                    url: lane.configuredWebhook.url,
                    has_custom_certificate: false,
                    max_connections: 37,
                    allowed_updates: [
                      "message",
                      "message_reaction",
                      "future_update",
                    ],
                  },
                });
              if (mode === "changed_generation") {
                const [current] = await readChatEndpointsById(lane.endpoint.id);
                await db
                  .update(chatEndpoints)
                  .set({
                    setup: {
                      ...current!.setup,
                      runtimeGeneration:
                        Number((current!.setup as InternalSetupState).runtimeGeneration) + 1,
                    } as InternalSetupState,
                  })
                  .where(eq(chatEndpoints.id, lane.endpoint.id));
              }
              if (mode === "disabled_connection")
                await db
                  .update(toolConnections)
                  .set({ enabled: false })
                  .where(eq(toolConnections.id, lane.endpoint.connectionId));
            }
            return undefined;
          });
          await lane.processSubscriptionAttempt();
          expect(
            await db
              .select()
              .from(chatActions)
              .where(
                and(
                  eq(chatActions.endpointId, lane.endpoint.id),
                  eq(chatActions.kind, "telegram_stop_subscription"),
                ),
              ),
          ).toEqual([]);
          expect(
            lane.maintenanceRequests.filter(
              ({ method }) => method === "setWebhook",
            ),
          ).toHaveLength(
            ["nonboolean_ok", "missing_result", "contradictory_get"].includes(
              mode,
            )
              ? 1
              : 0,
          );
          if (mode !== "changed_generation" && mode !== "disabled_connection") {
            expect((await lane.send(`unconfirmed-${mode}`))?.state).toBe(
              "published",
            );
            expect(lane.requests).toHaveLength(1);
            expect(lane.requests[0]!.method.endsWith("Draft")).toBe(false);
            expect(JSON.stringify(lane.requests[0]!.body)).toContain(
              `END-unconfirmed-${mode}`,
            );
          }
          expect(await lane.actions()).toEqual([]);
          expect(lane.context.cancelRun).not.toHaveBeenCalled();
        } finally {
          await lane.close();
        }
      },
    );

    it("retries an unknown subscription mutation after restart using freshly observed options, not a recovered confirmation flag", async ({ onTestFailed }) => {
      let phase = "create fixture";
      onTestFailed(() => {
        console.error(`Telegram subscription recovery failed during: ${phase}`);
      });
      const lane = await draftFixture();
      try {
        await db
          .delete(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, lane.endpoint.id),
              eq(chatActions.kind, "telegram_stop_subscription"),
            ),
          );
        lane.setSubscriptionInfo({});
        lane.setMaintenanceHook(async (method) => {
          if (method === "setWebhook")
            throw new Error("Synthetic unknown subscription response");
          return undefined;
        });
        phase = "first subscription attempt";
        await lane.processSubscriptionAttempt();
        const [action] = await db
          .select()
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, lane.endpoint.id),
              eq(chatActions.kind, "telegram_maintenance"),
              sql`${chatActions.payload}->>'operation' = 'stop_subscription'`,
            ),
          );
        expect(action).toMatchObject({
          status: "failed",
          result: { retryable: true, providerConfirmed: false },
        });
        // Keep the retry pending until the explicit post-restart transition below.
        // A busy runner can otherwise exhaust the real one-second backoff here.
        await db
          .update(chatActions)
          .set({
            result: { ...action!.result, retryAt: "2099-01-01T00:00:00.000Z" },
          })
          .where(eq(chatActions.id, action!.id));
        phase = "ordinary publication before restart";
        expect((await lane.send("unknown-subscription"))?.state).toBe(
          "published",
        );
        expect(lane.requests).toHaveLength(1);
        expect(lane.requests[0]!.method.endsWith("Draft")).toBe(false);
        phase = "pending recovery before restart";
        await lane.context.service.processPendingDeliveries();
        expect(
          lane.maintenanceRequests.filter(
            ({ method }) => method === "setWebhook",
          ),
        ).toHaveLength(1);
        phase = "restart";
        await lane.restart();
        lane.setSubscriptionInfo({
          allowed_updates: ["message", "chat_member"],
        });
        lane.setMaintenanceHook(undefined);
        await db
          .update(chatActions)
          .set({
            result: {
              ...action!.result,
              providerConfirmed: true,
              retryAt: new Date(0).toISOString(),
            },
          })
          .where(eq(chatActions.id, action!.id));
        phase = "concurrent recovery after restart";
        await Promise.all([
          lane.context.service.processPendingDeliveries(),
          lane.context.service.processPendingDeliveries(),
        ]);
        phase = "verify recovered subscription";
        const mutations = lane.maintenanceRequests.filter(
          ({ method }) => method === "setWebhook",
        );
        expect(mutations).toHaveLength(2);
        expect(mutations[1]!.body.allowed_updates).toEqual([
          "message",
          "chat_member",
          "stopped_message_generation",
        ]);
        const [receipt] = await db
          .select()
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, lane.endpoint.id),
              eq(chatActions.kind, "telegram_stop_subscription"),
            ),
          );
        expect(receipt?.status).toBe("processed");
        const serialized = JSON.stringify(receipt);
        expect(serialized).not.toContain(lane.configuredWebhook.url);
        expect(serialized).not.toContain(lane.configuredWebhook.secret_token);
        lane.requests.length = 0;
        lane.setHook(async (method, body) => {
          if (method.endsWith("Draft"))
            expect((await lane.deliver(Number(body.draft_id))).status).toBe(
              200,
            );
        });
        phase = "publication after subscription recovery";
        expect((await lane.send("repaired-after-unknown"))?.state).toBe(
          "cancelled",
        );
        phase = "close fixture";
      } finally {
        await lane.close();
      }
    });

    it("returns 503 on failed Stop commit and accepts the exact verified retry before final send", async () => {
      const lane = await draftFixture();
      const suffix = randomUUID().replaceAll("-", "");
      const functionName = `stop_fail_${suffix}`;
      const triggerName = `stop_trigger_${suffix}`;
      let created = false;
      try {
        let checked = false;
        lane.setHook(async (method, body) => {
          if (!method.endsWith("Draft") || checked) return;
          checked = true;
          const [action] = await lane.actions();
          await db.execute(
            sql.raw(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
              IF NEW.id = '${action!.id}'::uuid AND NEW.result->>'phase' = 'stopped' THEN RAISE EXCEPTION 'synthetic stop commit fault'; END IF;
              RETURN NEW; END $$`),
          );
          await db.execute(
            sql.raw(
              `CREATE TRIGGER ${triggerName} BEFORE UPDATE ON chat_actions FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
            ),
          );
          created = true;
          expect(
            (await lane.deliver(Number(body.draft_id), {}, true, 1777)).status,
          ).toBe(503);
          expect((await lane.actions())[0]).toMatchObject({
            status: "processing",
            result: { phase: "drafting" },
          });
          await db.execute(
            sql.raw(`DROP TRIGGER ${triggerName} ON chat_actions`),
          );
          await db.execute(sql.raw(`DROP FUNCTION ${functionName}()`));
          created = false;
          expect(
            (await lane.deliver(Number(body.draft_id), {}, true, 1777)).status,
          ).toBe(200);
        });
        expect((await lane.send("commit-retry"))?.state).toBe("cancelled");
        expect(checked).toBe(true);
        expect(lane.requests.map((request) => request.method)).toEqual([
          "sendRichMessageDraft",
        ]);
        expect((await lane.actions())[0]).toMatchObject({
          result: { phase: "stopped", updateId: 1777 },
        });
      } finally {
        try {
          if (created) {
            await db.execute(
              sql.raw(`DROP TRIGGER ${triggerName} ON chat_actions`),
            );
            await db.execute(sql.raw(`DROP FUNCTION ${functionName}()`));
          }
        } finally {
          await lane.close();
        }
      }
    });

    it("preserves an uncertain final after restart and a late Stop without automatic replay", async () => {
      const lane = await draftFixture();
      try {
        let draftId = 0;
        lane.setHook(async (method, body) => {
          if (method.endsWith("Draft")) draftId = Number(body.draft_id);
          else throw new TypeError("fetch failed");
        });
        const publication = await lane.send("unknown-final");
        expect(publication).toMatchObject({
          state: "delivery_unknown",
          providerMessageId: null,
          publishedAt: null,
        });
        expect((await lane.actions())[0]).toMatchObject({
          status: "processing",
          result: { phase: "final_sending" },
        });
        const before = lane.requests.length;
        lane.setHook(undefined);
        await lane.restart();
        expect((await lane.deliver(draftId)).status).toBe(200);
        await lane.context.service.processPendingPublications();
        expect(lane.requests).toHaveLength(before);
        const [current] = await readChatPublicationsById(publication!.id);
        expect(current!.state).toBe("delivery_unknown");
        await expect(
          lane.context.service.replayPublication(
            lane.endpoint.id,
            publication!.id,
          ),
        ).rejects.toThrow();
        expect(lane.context.cancelRun).not.toHaveBeenCalled();
      } finally {
        await lane.close();
      }
    });

    it.each(["bot", "generation", "source", "connection"] as const)(
      "refuses a retained Stop and later final after current %s authority changes",
      async (changed) => {
        const lane = await draftFixture();
        try {
          let checked = false;
          lane.setHook(async (method, body) => {
            if (!method.endsWith("Draft") || checked) return;
            checked = true;
            const [action] = await lane.actions();
            const [endpoint] = await readChatEndpointsById(lane.endpoint.id);
            if (changed === "bot")
              await db
                .update(chatEndpoints)
                .set({ botExternalId: String(lane.botId + 1) })
                .where(eq(chatEndpoints.id, lane.endpoint.id));
            if (changed === "generation")
              await db
                .update(chatEndpoints)
                .set({
                  setup: {
                    ...endpoint!.setup,
                    runtimeGeneration:
                      Number((endpoint!.setup as InternalSetupState).runtimeGeneration ?? 0) + 1,
                  } as InternalSetupState,
                })
                .where(eq(chatEndpoints.id, lane.endpoint.id));
            if (changed === "connection")
              await db
                .update(toolConnections)
                .set({ enabled: false })
                .where(eq(toolConnections.id, endpoint!.connectionId));
            if (changed === "source")
              await db
                .update(chatPublications)
                .set({ payload: { text: "Changed current source" } })
                .where(
                  eq(
                    chatPublications.id,
                    String(action!.payload.publicationId),
                  ),
                );
            expect(
              (
                await lane.deliver(
                  Number(body.draft_id),
                  {},
                  true,
                  undefined,
                  true,
                )
              ).status,
            ).toBe(200);
            expect((await lane.actions())[0]).toMatchObject({
              status: "processing",
              result: { phase: "drafting" },
            });
          });
          const publication = await lane.send(`changed-${changed}`);
          expect(checked).toBe(true);
          expect(publication!.state).not.toBe("published");
          expect(publication!.state).not.toBe("cancelled");
          expect(
            lane.requests.every((request) => request.method.endsWith("Draft")),
          ).toBe(true);
          expect(lane.context.cancelRun).not.toHaveBeenCalled();
        } finally {
          await lane.close();
        }
      },
    );

    it.each([
      "wrong_chat",
      "wrong_topic",
      "wrong_draft",
      "wrong_secret",
      "late_final",
    ] as const)(
      "does not withdraw an unowned or already-claimed final (%s)",
      async (mode) => {
        const lane = await draftFixture();
        try {
          let draftId = 0;
          lane.setHook(async (method, body) => {
            if (method.endsWith("Draft")) draftId = Number(body.draft_id);
            if ((mode === "late_final") === !method.endsWith("Draft")) {
              const patch =
                mode === "wrong_chat"
                  ? { chat: { id: 444, type: "private" } }
                  : mode === "wrong_topic"
                    ? { message_thread_id: 43 }
                    : {};
              const result = await lane.deliver(
                mode === "wrong_draft"
                  ? (draftId % 2_147_483_647) + 1
                  : draftId,
                patch,
                mode !== "wrong_secret",
              );
              expect(result.status).toBe(mode === "wrong_secret" ? 403 : 200);
            }
          });
          const publication = await lane.send(mode);
          expect(publication?.state).toBe("published");
          expect(
            lane.requests.filter(
              (request) => !request.method.endsWith("Draft"),
            ),
          ).toHaveLength(1);
          expect((await lane.actions())[0]).toMatchObject({
            status: "processed",
            result: { phase: "published" },
          });
          expect(lane.context.cancelRun).not.toHaveBeenCalled();
        } finally {
          await lane.close();
        }
      },
    );
  });

  describe("Teams exact self-unknown source continuation", () => {
    async function nativeFileFixture() {
      const context = await teamsFileAuthorityFixture();
      const runId = randomUUID();
      const contractId = randomUUID();
      const sessionId = randomUUID();
      const runnerId = randomUUID();
      const contractSha256 = createHash("sha256")
        .update(contractId)
        .digest("hex");
      await db.insert(completionContracts).values({
        id: contractId,
        companyId: context.fixture.companyId,
        issueId: context.issue.id,
        revision: 1,
        schemaVersion: "paperclip.completion-contract.v1",
        policyVersion: "phase6-v3",
        risk: "low",
        completionAuthority: "agent_claim_policy",
        incompleteCriteriaPolicy: "preserve_non_terminal",
        contractJson: {
          revision: "teams-native-v1",
          objective: "Return the requested file",
          criteria: [
            { id: "response", requirement: "Return the exact selected file" },
          ],
        },
        canonicalSha256: contractSha256,
        createdByActorType: "system",
        createdByActorId: "test",
      });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: context.fixture.companyId,
        agentId: context.fixture.assignedAgentId,
        status: "running",
        wakeupRequestId: context.sourceAction.id,
        runtimeMode: "native",
        nativeIssueId: context.issue.id,
        nativeSessionId: sessionId,
        runnerInstanceId: runnerId,
        completionContractId: contractId,
        completionContractSha256: contractSha256,
        contextSnapshot: {
          issueId: context.issue.id,
          taskKey: context.issue.identifier,
          source: "chat:microsoft-teams",
          wakeCommentId: context.sourceAction.payload.commentId,
          wakeCommentIds: [context.sourceAction.payload.commentId],
        },
      });
      await db
        .update(agentWakeupRequests)
        .set({ status: "completed", runId })
        .where(eq(agentWakeupRequests.id, context.sourceAction.id));
      const stored = await context.storage.storage.putFile({
        companyId: context.fixture.companyId,
        namespace: `issues/${context.issue.id}`,
        originalFilename: "authority-report.txt",
        contentType: "text/plain",
        body: context.bytes,
      });
      const attachment = await issueService(db).createAttachment({
        issueId: context.issue.id,
        ...stored,
        createdByAgentId: context.fixture.assignedAgentId,
        createdByRunId: runId,
      });
      await issueService(db).addComment(
        context.issue.id,
        "Selected the exact requested file.",
        { agentId: context.fixture.assignedAgentId, runId },
        {
          attachmentIds: [attachment.id],
          authorType: "agent",
          authorizationReason: "allow_self",
        },
      );
      await db
        .update(heartbeatRuns)
        .set({
          status: "failed",
          errorCode: "adapter_failed",
          finishedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, runId));
      await db
        .update(issues)
        .set({ status: "in_review", executionRunId: null })
        .where(eq(issues.id, context.issue.id));
      const result: PrpStructuredRunResult = {
        schema: "paperclip.run_result.v1",
        reportedWorkDisposition: "yielded",
        summary:
          "Here is the exact requested file. I will wait for your next message.",
        completionClaim: {
          contractRevision: "teams-native-v1",
          objectiveSatisfied: true,
          criteria: [
            { criterionId: "response", status: "satisfied", evidenceRefs: [] },
          ],
          remainingWork: [],
        },
        evidence: [],
        verification: [],
        attentionRequests: [],
        artifacts: [],
        continuation: {
          kind: "response_wake",
          summary: "Wait for the next authorized message.",
          idempotencyKey: `wait:${runId}`,
        },
      };
      const terminal: PrpTerminalState = {
        schema: "paperclip.prp.terminal.v1",
        turnTerminalState: "completed",
        runTerminalState: "succeeded",
        reportedWorkDisposition: "yielded",
        workAssessmentId: randomUUID(),
        statusDecisionId: randomUUID(),
      };
      await new NativeRunCoordinatorStore(db, {
        companyId: context.fixture.companyId,
        issueId: context.issue.id,
        runId,
        agentId: context.fixture.assignedAgentId,
        normalizedSessionId: sessionId,
        runnerSourceInstanceId: runnerId,
        completionContractId: contractId,
        completionContractSha256: contractSha256,
        completionContractRevision: "teams-native-v1",
        completionContractCriterionIds: ["response"],
      }).completeRun({ result, terminal, turnId: `turn-${runId}` });
      await finalizeNativeRun({
        db,
        runId,
        workspaceFinalizeStatus: "succeeded",
      });
      await repairCommittedNativeChatResponse(db, {
        companyId: context.fixture.companyId,
        issueId: context.issue.id,
        runId,
      });
      const [run] = await readHeartbeatRunsById(runId);
      expect(run).toMatchObject({
        status: "succeeded",
        resultJson: {
          nativeCommittedChatResponse: {
            schema: "paperclip.native_committed_chat_response.v1",
          },
        },
      });
      return { ...context, runId, attachment };
    }

    // Actual parser/admission and accepted native-result composition. Provider
    // sends and authenticated App routing are controlled, not live tenant proof.
    it("accepts the exact native file after a lost consent-card receipt without reposting", async () => {
      const context = await nativeFileFixture();
      try {
        const instance = context.runtime.endpoints.get(
          context.endpoint.id,
        )! as unknown as {
          sendTeamsFileConsentCard: (
            threadId: string,
            card: unknown,
          ) => Promise<{ id: string }>;
        };
        const send = instance.sendTeamsFileConsentCard.bind(instance);
        vi.spyOn(instance, "sendTeamsFileConsentCard").mockImplementation(
          async (threadId, card) => {
            await send(threadId, card);
            throw new Error("controlled lost card POST receipt");
          },
        );
        await context.service.processPendingPublications();
        const [unknown] = await db
          .select()
          .from(chatTeamsFileTransfers)
          .where(eq(chatTeamsFileTransfers.endpointId, context.endpoint.id));
        expect(unknown).toMatchObject({
          phase: "consent_unknown",
          consentMessageId: null,
          attemptId: null,
        });
        expect(context.consentCards).toHaveLength(1);
        const wakeCount = context.wakeup.mock.calls.length;
        await expect(context.dispatchConsent()).resolves.toEqual({
          status: 200,
        });
        await context.service.processPendingPublications();
        const [done] = await readChatTeamsFileTransfersById(unknown!.id);
        expect(done).toMatchObject({
          phase: "delivered",
          consentMessageId: null,
          fileInfoMessageId: "native-file-1",
        });
        expect(context.consentCards).toHaveLength(1);
        expect(context.uploadRequest).toHaveBeenCalledTimes(1);
        expect(context.fileCards).toHaveLength(1);
        expect(context.wakeup).toHaveBeenCalledTimes(wakeCount);
        await expect(
          db.transaction((tx) =>
            context.service.prepareFailedChatRunRetry(tx, {
              companyId: context.fixture.companyId,
              issueId: context.issue.id,
              agentId: context.fixture.assignedAgentId,
              failedRunId: context.runId,
              initiatedByUserId: "owner-user",
            }),
          ),
        ).rejects.toMatchObject({
          details: { code: "chat_failed_run_retry_not_authorized" },
        });
      } finally {
        await retirePublicationFixture(context.service, context.endpoint.id);
      }
    });
    it.each([
      "sibling_unknown",
      "foreign_comment_run",
      "unowned_attachment",
      "source_edited",
      "upload_unknown",
      "active_attempt",
    ] as const)(
      "does not exempt other unknown effects or changed native authority: %s",
      async (variant) => {
        const context = await nativeFileFixture();
        try {
          context.controls.beforeConsentReceipt = async () => {
            throw new Error("controlled lost card POST receipt");
          };
          await context.service.processPendingPublications();
          const [unknown] = await db
            .select()
            .from(chatTeamsFileTransfers)
            .where(eq(chatTeamsFileTransfers.endpointId, context.endpoint.id));
          expect(unknown).toMatchObject({
            phase: "consent_unknown",
            attemptId: null,
          });
          if (variant === "sibling_unknown") {
            await db.insert(chatPublications).values({
              companyId: unknown!.companyId,
              endpointId: unknown!.endpointId,
              conversationId: unknown!.conversationId,
              issueId: unknown!.issueId,
              commentId: unknown!.commentId,
              state: "delivery_unknown",
              idempotencyKey: `run:${context.runId}:other-unknown`,
              payload: { text: "Other uncertain effect" },
            });
          } else if (variant === "foreign_comment_run") {
            await db
              .update(issueComments)
              .set({ createdByRunId: null })
              .where(eq(issueComments.id, unknown!.commentId));
          } else if (variant === "unowned_attachment") {
            await db
              .update(issueAttachments)
              .set({ originatingRunId: null })
              .where(eq(issueAttachments.id, context.attachment.id));
          } else if (variant === "source_edited") {
            await db
              .update(issueComments)
              .set({ updatedAt: new Date(Date.now() + 1) })
              .where(
                eq(
                  issueComments.id,
                  String(context.sourceAction.payload.commentId),
                ),
              );
          } else if (variant === "upload_unknown") {
            await db
              .update(chatTeamsFileTransfers)
              .set({ phase: "upload_unknown", version: unknown!.version + 1 })
              .where(eq(chatTeamsFileTransfers.id, unknown!.id));
          } else {
            await db
              .update(chatTeamsFileTransfers)
              .set({
                attemptId: randomUUID(),
                attemptExpiresAt: new Date(Date.now() + 90_000),
              })
              .where(eq(chatTeamsFileTransfers.id, unknown!.id));
          }
          const [before] = await readChatTeamsFileTransfersById(unknown!.id);
          await expect(context.dispatchConsent()).resolves.toEqual({
            status: 403,
          });
          const [after] = await readChatTeamsFileTransfersById(unknown!.id);
          expect(after).toEqual(before);
          expect(context.consentCards).toHaveLength(1);
          expect(context.uploadRequest).not.toHaveBeenCalled();
          expect(context.fileCards).toEqual([]);
        } finally {
          await retirePublicationFixture(context.service, context.endpoint.id);
        }
      },
    );

    it("retries only the confirmed native file-info stage with an exact audited phase/version, never its PUT", async () => {
      const context = await nativeFileFixture();
      try {
        await context.service.processPendingPublications();
        context.controls.beforeFileInfoReceipt = async () => {
          throw new Error("controlled lost file-info POST receipt");
        };
        await expect(context.dispatchConsent()).resolves.toEqual({
          status: 200,
        });
        await context.service.processPendingPublications();
        const [unknown] = await db
          .select()
          .from(chatTeamsFileTransfers)
          .where(eq(chatTeamsFileTransfers.endpointId, context.endpoint.id));
        expect(unknown).toMatchObject({
          phase: "file_info_unknown",
          attemptId: null,
          fileInfoMessageId: null,
        });
        expect(context.uploadRequest).toHaveBeenCalledTimes(1);
        expect(context.fileCards).toHaveLength(1);
        for (const requested of [
          undefined,
          { phase: "consent_unknown" as const, version: unknown!.version },
          {
            phase: "file_info_unknown" as const,
            version: unknown!.version - 1,
          },
        ]) {
          await expect(
            context.service.resolvePublication(
              context.endpoint.id,
              unknown!.publicationId,
              "retry_anyway",
              "owner-user",
              requested,
            ),
          ).rejects.toMatchObject({
            status: 409,
            details: { code: "chat_file_transfer_resolution_required" },
          });
        }
        const [unchanged] = await readChatTeamsFileTransfersById(unknown!.id);
        expect(unchanged).toEqual(unknown);
        context.controls.beforeFileInfoReceipt = undefined;
        await context.service.resolvePublication(
          context.endpoint.id,
          unknown!.publicationId,
          "retry_anyway",
          "owner-user",
          { phase: "file_info_unknown", version: unknown!.version },
        );
        await context.service.processPendingPublications();
        const [done] = await readChatTeamsFileTransfersById(unknown!.id);
        expect(done).toMatchObject({
          phase: "delivered",
          fileInfoMessageId: "native-file-2",
        });
        expect(context.consentCards).toHaveLength(1);
        expect(context.uploadRequest).toHaveBeenCalledTimes(1);
        expect(context.fileCards).toHaveLength(2);
      } finally {
        await retirePublicationFixture(context.service, context.endpoint.id);
      }
    });
  });
});
