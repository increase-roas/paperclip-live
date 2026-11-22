import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { activityLog, chatActions, chatConversations, chatDeliveries, chatEndpointResources, chatEndpoints, chatPublications, companySecretBindings, companySecrets, heartbeatRuns, toolConnections } from "@paperclipai/db";
import type { Message } from "chat";
import { FakeChatSdkRuntime, TEST_SLACK_BOT_SCOPES, fakeDiscordFetch, makeMessage, makeThread, uniqueDiscordApplicationId } from ".././helpers/chat-channels-fixture.js";
import { addSelectedChatFinal, chatWakeContext, configuredTelegramEndpoint, createService, db, deliverMessage, describeChatChannelsSuite, readChatConversationsByEndpointId, readChatEndpointsById, seedCompany } from "../helpers/chat-channels-harness.js";







describeChatChannelsSuite("chat channels 10-does-not-let-pause-overtake-a-credential", () => {
  it("does not let pause overtake a credential-fenced Discord root thread creation", async () => {
    const fixture = await seedCompany();
    const applicationId = uniqueDiscordApplicationId();
    let releaseTransport!: () => void;
    let transportEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      transportEntered = resolve;
    });
    const transportBarrier = new Promise<void>((resolve) => {
      releaseTransport = resolve;
    });
    const runtime = new FakeChatSdkRuntime();
    const { service } = createService(
      runtime,
      fakeDiscordFetch(applicationId) as typeof globalThis.fetch,
      {
        discordRootThreadTransportBarrier: async () => {
          transportEntered();
          await transportBarrier;
        },
        scheduleDeferredWork: () => undefined,
      },
    );
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "discord", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          applicationId,
          botToken: "discord-secret",
          guildId: "1457808928258658549",
        },
      },
      "owner-user",
    );
    const setup = await db
      .select({ setup: chatEndpoints.setup })
      .from(chatEndpoints)
      .where(eq(chatEndpoints.id, endpoint.id))
      .then((rows) => rows[0]!.setup);
    await db
      .update(chatEndpoints)
      .set({
        allowUnlinkedPeople: true,
        status: "active",
        setup: { ...setup, step: "complete" },
      })
      .where(eq(chatEndpoints.id, endpoint.id));
    await db
      .update(chatEndpointResources)
      .set({ enabled: true })
      .where(eq(chatEndpointResources.endpointId, endpoint.id));

    const admission = runtime.configurations.get(endpoint.id)?.callbacks
      .onDiscordRootMentionAdmission;
    if (!admission) throw new Error("Expected Discord admission callback");
    const ownedRuntime = runtime.endpoints.get(endpoint.id);
    if (!ownedRuntime)
      throw new Error("Expected Discord Gateway owner runtime");
    const messageId = "555555555555555590";
    const threadId = `discord:1457808928258658549:333333333333333333:${messageId}`;
    const message = {
      ...makeMessage({
        id: messageId,
        mentioned: true,
        text: "@maya serialize this root",
        userId: "444444444444444444",
      }),
      threadId,
    } as Message;
    const admitting = Promise.resolve(
      admission({
        channelId: "333333333333333333",
        endpointId: endpoint.id,
        guildId: "1457808928258658549",
        message,
        messageId,
        threadId,
        userId: "444444444444444444",
      }),
    );
    await entered;

    let pauseSettled = false;
    const pausing = service
      .configure(endpoint.id, { action: "pause" }, "owner-user")
      .then((result) => {
        pauseSettled = true;
        return result;
      });
    await Promise.resolve();
    expect(pauseSettled).toBe(false);
    releaseTransport();
    await expect(admitting).resolves.toBe(false);
    await expect(pausing).resolves.toMatchObject({ status: "paused" });
    expect(ownedRuntime.ensuredDiscordRootThreads).toEqual([
      {
        channelId: "333333333333333333",
        content: "@maya serialize this root",
        messageId,
      },
    ]);
    expect(runtime.configurations.get(endpoint.id)?.enableDiscordGateway).toBe(
      true,
    );
    expect(runtime.endpoints.has(endpoint.id)).toBe(false);
    await service.shutdown();
  });

  it("configures a Discord bot only after identity, intent, server, and channel permissions verify", async () => {
    const fixture = await seedCompany();
    const applicationId = uniqueDiscordApplicationId();
    const guildId = "1457808928258658549";
    const providerFetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("authorization")).toMatch(
          /^Bot discord-secret(?:-rotated)?$/,
        );
        const path = new URL(String(input)).pathname;
        const responses: Record<string, unknown> = {
          "/api/v10/users/@me": {
            id: applicationId,
            username: "maya",
            global_name: "Maya",
            bot: true,
          },
          "/api/v10/oauth2/applications/@me": {
            id: applicationId,
            name: "Maya",
            flags: 1 << 18,
          },
          [`/api/v10/guilds/${guildId}`]: { id: guildId, name: "Clawd" },
          [`/api/v10/guilds/${guildId}/members/${applicationId}`]: {
            roles: ["222222222222222222"],
            user: { id: applicationId },
          },
          [`/api/v10/guilds/${guildId}/roles`]: [
            {
              id: "222222222222222222",
              permissions: "309237763136",
            },
          ],
          [`/api/v10/guilds/${guildId}/channels`]: [
            {
              id: "333333333333333333",
              name: "agent-lab",
              position: 1,
              type: 0,
            },
          ],
        };
        return new Response(JSON.stringify(responses[path]), {
          status: path in responses ? 200 : 404,
          headers: { "content-type": "application/json" },
        });
      },
    ) as unknown as typeof globalThis.fetch;
    const { runtime, service } = createService(
      new FakeChatSdkRuntime(),
      providerFetch,
    );
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "discord", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );

    const configured = await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          applicationId,
          botToken: "discord-secret",
          guildId,
        },
      },
      "owner-user",
    );

    expect(configured).toMatchObject({
      provider: "discord",
      providerAccountId: guildId,
      providerAccountLabel: "Clawd",
      botExternalId: applicationId,
      botUsername: "maya",
      status: "verifying",
      setup: { step: "test" },
    });
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "333333333333333333",
        parentProviderResourceId: guildId,
        label: "#agent-lab",
        enabled: false,
      }),
    ]);
    expect(
      runtime.configurations.get(endpoint.id)?.providerConfig,
    ).toMatchObject({
      provider: "discord",
      credentials: {
        applicationId,
        botToken: "discord-secret",
        guildId,
      },
    });
    const connection = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId))
      .then((rows) => rows[0]!);
    expect(connection.refs).toHaveLength(3);
    expect(JSON.stringify(connection)).not.toContain("discord-secret");

    const callbacks = runtime.configurations.get(endpoint.id)?.callbacks;
    const admitRootMention = callbacks?.onDiscordRootMentionAdmission;
    if (!admitRootMention)
      throw new Error("Expected Discord root-mention admission callback");
    const rootMention = (messageId: string) => {
      const threadId = `discord:${guildId}:333333333333333333:${messageId}`;
      const message = {
        ...makeMessage({
          id: messageId,
          text: "@maya investigate the queue",
          mentioned: true,
          userId: "444444444444444444",
        }),
        threadId,
      } as Message;
      return {
        message,
        thread: makeThread({
          channelId: "333333333333333333",
          id: threadId,
        }).thread,
        threadId,
      };
    };
    const admission = async (messageId: string) => {
      const root = rootMention(messageId);
      return await admitRootMention({
        endpointId: endpoint.id,
        guildId,
        channelId: "333333333333333333",
        messageId,
        message: root.message,
        threadId: root.threadId,
        userId: "444444444444444444",
      });
    };
    await expect(admission("555555555555555551")).resolves.toBe(false);
    const [admittedRoot] = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(
            chatDeliveries.providerEventId,
            `discord:${guildId}:333333333333333333:555555555555555551:555555555555555551`,
          ),
        ),
      );
    expect(admittedRoot).toMatchObject({
      state: "received",
      redactedError: null,
      normalizedEvent: expect.objectContaining({
        message: expect.objectContaining({
          text: "@maya investigate the queue",
        }),
      }),
    });
    expect(admittedRoot?.nextAttemptAt).toBeNull();
    expect(
      runtime.endpoints.get(endpoint.id)?.ensuredDiscordRootThreads,
    ).toContainEqual({
      channelId: "333333333333333333",
      messageId: "555555555555555551",
      content: "@maya investigate the queue",
    });
    await expect(service.listConversations(endpoint.id)).resolves.toHaveLength(
      0,
    );
    await service.processPendingDeliveries(25, admittedRoot!.id);
    await vi.waitFor(async () => {
      await expect(
        db
          .select({
            normalizedEvent: chatDeliveries.normalizedEvent,
            state: chatDeliveries.state,
          })
          .from(chatDeliveries)
          .where(eq(chatDeliveries.id, admittedRoot!.id)),
      ).resolves.toEqual([
        expect.objectContaining({
          state: "processed",
          normalizedEvent: expect.not.objectContaining({
            providerThreadPending: true,
          }),
        }),
      ]);
    });

    await db
      .update(chatEndpoints)
      .set({ status: "active" })
      .where(eq(chatEndpoints.id, endpoint.id));
    await db
      .update(chatEndpointResources)
      .set({ enabled: false })
      .where(eq(chatEndpointResources.endpointId, endpoint.id));
    await expect(admission("555555555555555552")).resolves.toBe(false);
    await expect(
      db
        .select({
          normalizedEvent: chatDeliveries.normalizedEvent,
          redactedError: chatDeliveries.redactedError,
          state: chatDeliveries.state,
        })
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(
              chatDeliveries.providerEventId,
              `discord:${guildId}:333333333333333333:555555555555555552:555555555555555552`,
            ),
          ),
        ),
    ).resolves.toEqual([
      {
        normalizedEvent: expect.objectContaining({
          filtering: {
            contentRetained: false,
            providerThreadCreated: false,
          },
        }),
        redactedError: "Destination is not enabled in Paperclip",
        state: "filtered",
      },
    ]);

    await db
      .update(chatEndpointResources)
      .set({ enabled: true })
      .where(eq(chatEndpointResources.endpointId, endpoint.id));
    await db
      .update(chatEndpoints)
      .set({ allowGroupChats: false })
      .where(eq(chatEndpoints.id, endpoint.id));
    await expect(admission("555555555555555553")).resolves.toBe(false);
    await db
      .update(chatEndpoints)
      .set({ allowGroupChats: true, allowUnlinkedPeople: false })
      .where(eq(chatEndpoints.id, endpoint.id));
    await expect(admission("555555555555555554")).resolves.toBe(false);
    await db
      .update(chatEndpoints)
      .set({ allowUnlinkedPeople: true })
      .where(eq(chatEndpoints.id, endpoint.id));
    const activeRuntime = runtime.endpoints.get(endpoint.id);
    if (!activeRuntime) throw new Error("Expected active Discord runtime");
    const ensureDiscordRootThread = activeRuntime.ensureDiscordRootThread;
    activeRuntime.ensureDiscordRootThread = vi.fn(async () => {
      throw new Error("temporary Discord API failure");
    });
    await expect(admission("555555555555555555")).resolves.toBe(false);
    const [interruptedRoot] = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(
            chatDeliveries.providerEventId,
            `discord:${guildId}:333333333333333333:555555555555555555:555555555555555555`,
          ),
        ),
      );
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(chatDeliveries.id, interruptedRoot!.id));
    activeRuntime.ensureDiscordRootThread = ensureDiscordRootThread;
    await service.processPendingDeliveries(25, interruptedRoot!.id);
    expect(
      runtime.endpoints.get(endpoint.id)?.ensuredDiscordRootThreads,
    ).toContainEqual({
      channelId: "333333333333333333",
      messageId: "555555555555555555",
      content: "@maya investigate the queue",
    });
    await expect(
      db
        .select({
          normalizedEvent: chatDeliveries.normalizedEvent,
          state: chatDeliveries.state,
        })
        .from(chatDeliveries)
        .where(eq(chatDeliveries.id, interruptedRoot!.id)),
    ).resolves.toEqual([
      expect.objectContaining({
        state: "processed",
        normalizedEvent: expect.not.objectContaining({
          providerThreadPending: true,
        }),
      }),
    ]);

    const runtimeBeforeRotation = runtime.endpoints.get(endpoint.id);
    const firstSecretIds = new Set(connection.refs.map((ref) => ref.secretId));
    const conversationsBeforeRotation = await service.listConversations(
      endpoint.id,
    );
    expect(conversationsBeforeRotation.length).toBeGreaterThan(0);

    const reconnected = await service.configure(
      endpoint.id,
      {
        action: "reconnect",
        // Rotation accepts the one changed secret and merges the immutable
        // Application/Server identity from Paperclip's existing vault refs.
        credentials: { botToken: "discord-secret-rotated" },
      },
      "owner-user",
    );
    expect(reconnected).toMatchObject({
      id: endpoint.id,
      providerAccountId: guildId,
      botExternalId: applicationId,
      status: "verifying",
      setup: { step: "test" },
    });
    expect(runtimeBeforeRotation?.shutdown).toHaveBeenCalledTimes(1);
    expect(
      runtime.configurations.get(endpoint.id)?.providerConfig,
    ).toMatchObject({
      provider: "discord",
      credentials: {
        applicationId,
        botToken: "discord-secret-rotated",
        guildId,
      },
    });
    const [rotatedConnection] = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));
    expect(rotatedConnection?.refs).toHaveLength(3);
    expect(
      rotatedConnection?.refs.every((ref) => !firstSecretIds.has(ref.secretId)),
    ).toBe(true);
    await expect(service.listConversations(endpoint.id)).resolves.toMatchObject(
      conversationsBeforeRotation.map((conversation) => ({
        id: conversation.id,
        issueId: conversation.issueId,
      })),
    );
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "333333333333333333",
        enabled: true,
      }),
    ]);
    const reconnectActivity = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.entityId, endpoint.connectionId))
      .then((rows) =>
        rows.find((row) => row.action === "chat_endpoint.reconnected"),
      );
    expect(reconnectActivity).toEqual({
      action: "chat_endpoint.reconnected",
      details: { endpointId: endpoint.id, provider: "discord" },
    });
    expect(JSON.stringify(reconnectActivity)).not.toContain(
      "discord-secret-rotated",
    );

    const reconnectedCallbacks = runtime.configurations.get(
      endpoint.id,
    )?.callbacks;
    const reconnectedAdmission =
      reconnectedCallbacks?.onDiscordRootMentionAdmission;
    const onDiscordGatewayEvent = reconnectedCallbacks?.onDiscordGatewayEvent;
    if (!reconnectedAdmission || !onDiscordGatewayEvent) {
      throw new Error("Expected Discord lifecycle callbacks after reconnect");
    }
    const inaccessibleRoot = rootMention("555555555555555556");
    const currentRuntime = runtime.endpoints.get(endpoint.id);
    if (!currentRuntime) throw new Error("Expected active Discord runtime");
    currentRuntime.ensureDiscordRootThread = vi.fn(async () => {
      throw Object.assign(new Error("provider detail must not escape"), {
        adapter: "discord",
        code: 50013,
        status: 403,
      });
    });
    await expect(
      reconnectedAdmission({
        endpointId: endpoint.id,
        guildId,
        channelId: "333333333333333333",
        messageId: inaccessibleRoot.message.id,
        message: inaccessibleRoot.message,
        threadId: inaccessibleRoot.threadId,
        userId: "444444444444444444",
      }),
    ).resolves.toBe(false);
    const [inaccessibleDelivery] = await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(
            chatDeliveries.providerEventId,
            `discord:${guildId}:333333333333333333:555555555555555556:555555555555555556`,
          ),
        ),
      )
      .returning({ id: chatDeliveries.id });
    if (!inaccessibleDelivery) {
      throw new Error("Expected provisional inaccessible Discord root");
    }
    await service.processPendingDeliveries(25, inaccessibleDelivery.id);
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "333333333333333333",
        availability: "unavailable",
      }),
    ]);
    await expect(service.listConversations(endpoint.id)).resolves.toEqual(
      conversationsBeforeRotation.map((conversation) =>
        expect.objectContaining({
          id: conversation.id,
          state: "unavailable",
        }),
      ),
    );

    await db
      .update(chatEndpointResources)
      .set({ availability: "available" })
      .where(eq(chatEndpointResources.endpointId, endpoint.id));
    await db
      .update(chatConversations)
      .set({ state: "active" })
      .where(eq(chatConversations.endpointId, endpoint.id));
    await onDiscordGatewayEvent({
      endpointId: endpoint.id,
      provider: "discord",
      sequence: 1,
      event: { type: "disconnected", fatal: false, code: 1001 },
    });
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "attention",
      healthMessage: "Discord Gateway disconnected (code 1001); reconnecting",
    });
    await expect(
      db
        .select({
          enabled: toolConnections.enabled,
          healthStatus: toolConnections.healthStatus,
          status: toolConnections.status,
        })
        .from(toolConnections)
        .where(eq(toolConnections.id, endpoint.connectionId)),
    ).resolves.toEqual([
      { enabled: true, healthStatus: "degraded", status: "active" },
    ]);
    await onDiscordGatewayEvent({
      endpointId: endpoint.id,
      provider: "discord",
      sequence: 2,
      event: { type: "ready", botUserId: applicationId },
    });
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "verifying",
      healthMessage: "Waiting for a test conversation",
    });
    await onDiscordGatewayEvent({
      endpointId: endpoint.id,
      provider: "discord",
      sequence: 3,
      event: {
        type: "channel_removed",
        channelId: "333333333333333333",
        guildId,
        label: "agent-lab",
      },
    });
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "333333333333333333",
        availability: "removed",
      }),
    ]);
    await expect(service.listConversations(endpoint.id)).resolves.toEqual(
      conversationsBeforeRotation.map((conversation) =>
        expect.objectContaining({
          id: conversation.id,
          state: "unavailable",
        }),
      ),
    );
    await onDiscordGatewayEvent({
      endpointId: endpoint.id,
      provider: "discord",
      sequence: 4,
      event: { type: "guild_removed", guildId },
    });
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "revoked",
      healthMessage: "Discord bot was removed from the configured server",
    });
    await expect(
      db
        .select({
          enabled: toolConnections.enabled,
          healthStatus: toolConnections.healthStatus,
          status: toolConnections.status,
        })
        .from(toolConnections)
        .where(eq(toolConnections.id, endpoint.connectionId)),
    ).resolves.toEqual([
      { enabled: false, healthStatus: "failed", status: "disabled" },
    ]);

    await service.configure(endpoint.id, { action: "remove" }, "owner-user");
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "archived",
    });
    await expect(service.listConversations(endpoint.id)).resolves.toEqual(
      conversationsBeforeRotation.map((conversation) =>
        expect.objectContaining({
          id: conversation.id,
          issueId: conversation.issueId,
          state: "endpoint_removed",
        }),
      ),
    );
    await expect(
      db
        .select({ refs: toolConnections.credentialSecretRefs })
        .from(toolConnections)
        .where(eq(toolConnections.id, endpoint.connectionId))
        .then((rows) => rows[0]?.refs),
    ).resolves.toEqual([]);
    await expect(
      db
        .select({ id: companySecrets.id })
        .from(companySecrets)
        .where(eq(companySecrets.companyId, fixture.companyId)),
    ).resolves.toHaveLength(0);
    expect(runtime.endpoints.has(endpoint.id)).toBe(false);
    await service.shutdown();
  });

  it("allows only one concurrent live endpoint to claim a Discord bot across guilds", async () => {
    const fixture = await seedCompany();
    const applicationId = "623456789012345678";
    const guildIds = ["723456789012345678", "823456789012345678"];
    const providerFetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("authorization")).toMatch(
          /^Bot discord-secret-/,
        );
        const path = new URL(String(input)).pathname;
        if (path === "/api/v10/users/@me") {
          return new Response(
            JSON.stringify({
              id: applicationId,
              username: "shared-maya",
              global_name: "Shared Maya",
              bot: true,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (path === "/api/v10/oauth2/applications/@me") {
          return new Response(
            JSON.stringify({
              id: applicationId,
              name: "Shared Maya",
              flags: 1 << 18,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        const guildId = guildIds.find((candidate) => path.includes(candidate));
        if (!guildId) {
          return new Response(JSON.stringify({ message: "not found" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        }
        let body: unknown;
        if (path === `/api/v10/guilds/${guildId}`) {
          body = { id: guildId, name: `Guild ${guildId}` };
        } else if (path.endsWith(`/members/${applicationId}`)) {
          body = {
            roles: ["923456789012345678"],
            user: { id: applicationId },
          };
        } else if (path.endsWith("/roles")) {
          body = [
            {
              id: "923456789012345678",
              permissions: "309237763136",
            },
          ];
        } else if (path.endsWith("/channels")) {
          body = [
            {
              id:
                guildId === guildIds[0]
                  ? "333333333333333334"
                  : "333333333333333335",
              name: "agent-lab",
              position: 1,
              type: 0,
            },
          ];
        }
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    ) as unknown as typeof globalThis.fetch;
    const { service } = createService(new FakeChatSdkRuntime(), providerFetch);
    const endpoints = await Promise.all([
      service.create(
        fixture.companyId,
        { provider: "discord", assignedAgentId: fixture.assignedAgentId },
        "owner-user",
      ),
      service.create(
        fixture.companyId,
        { provider: "discord", assignedAgentId: fixture.replacementAgentId },
        "owner-user",
      ),
    ]);

    const outcomes = await Promise.allSettled(
      endpoints.map((endpoint, index) =>
        service.configure(
          endpoint.id,
          {
            action: "configure",
            credentials: {
              applicationId,
              botToken: `discord-secret-${index}`,
              guildId: guildIds[index]!,
            },
          },
          "owner-user",
        ),
      ),
    );

    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = outcomes.find(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === "rejected",
    );
    expect(rejected?.reason).toMatchObject({
      status: 409,
      details: { code: "chat_bot_identity_in_use" },
    });
    const live = await db
      .select({ id: chatEndpoints.id })
      .from(chatEndpoints)
      .where(
        and(
          eq(chatEndpoints.provider, "discord"),
          eq(chatEndpoints.botExternalId, applicationId),
          inArray(chatEndpoints.status, [
            "verifying",
            "active",
            "paused",
            "attention",
          ]),
        ),
      );
    expect(live).toHaveLength(1);
  });

  it("rotates Microsoft Teams secrets without changing bot identity and preserves the last good credentials on rejection", async () => {
    const fixture = await seedCompany();
    const clientId = "00000000-0000-4000-8000-000000000011";
    const tenantId = "00000000-0000-4000-8000-000000000012";
    const providerFetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        const body = new URLSearchParams(String(init?.body));
        if (body.get("client_secret") === "revoked-secret") {
          return new Response(
            JSON.stringify({
              error_description: "client secret is invalid or expired",
            }),
            {
              status: 401,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response(JSON.stringify({ access_token: "teams-access" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    ) as unknown as typeof globalThis.fetch;
    const { runtime, service } = createService(
      new FakeChatSdkRuntime(),
      providerFetch,
    );
    const endpoint = await service.create(
      fixture.companyId,
      {
        provider: "microsoft-teams",
        assignedAgentId: fixture.assignedAgentId,
      },
      "owner-user",
    );
    await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: { clientId, tenantId, clientSecret: "first-secret" },
      },
      "owner-user",
    );
    const refs = () =>
      db
        .select({ refs: toolConnections.credentialSecretRefs })
        .from(toolConnections)
        .where(eq(toolConnections.id, endpoint.connectionId))
        .then((rows) => rows[0]!.refs);
    const firstRefs = await refs();
    expect(firstRefs).toHaveLength(3);

    await expect(
      service.configure(
        endpoint.id,
        {
          action: "reconnect",
          credentials: { clientId, tenantId, clientSecret: "revoked-secret" },
        },
        "owner-user",
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(await refs()).toEqual(firstRefs);
    expect(runtime.endpoints.has(endpoint.id)).toBe(true);

    await expect(
      service.configure(
        endpoint.id,
        {
          action: "reconnect",
          credentials: { clientId, tenantId, clientSecret: "rotated-secret" },
        },
        "owner-user",
      ),
    ).resolves.toMatchObject({
      providerAccountId: tenantId,
      botExternalId: clientId,
      status: "verifying",
    });
    const rotatedRefs = await refs();
    expect(rotatedRefs).toHaveLength(3);
    expect(
      rotatedRefs.every((ref) =>
        firstRefs.every((firstRef) => firstRef.secretId !== ref.secretId),
      ),
    ).toBe(true);
    await expect(
      db
        .select({ id: companySecrets.id })
        .from(companySecrets)
        .where(eq(companySecrets.companyId, fixture.companyId)),
    ).resolves.toHaveLength(3);

    await expect(
      service.configure(
        endpoint.id,
        {
          action: "reconnect",
          credentials: {
            clientId,
            tenantId: "00000000-0000-4000-8000-000000000099",
            clientSecret: "other-tenant-secret",
          },
        },
        "owner-user",
      ),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: "chat_bot_identity_changed" },
    });
    expect(await refs()).toEqual(rotatedRefs);
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      providerAccountId: tenantId,
      botExternalId: clientId,
    });
  });

  it("coalesces one Microsoft Teams run into one provider reply", async () => {
    const fixture = await seedCompany();
    const clientId = randomUUID();
    const tenantId = randomUUID();
    const context = createService(
      new FakeChatSdkRuntime(),
      (async () =>
        new Response(JSON.stringify({ access_token: "teams-run-access" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof globalThis.fetch,
    );
    const endpoint = await context.service.create(
      fixture.companyId,
      {
        provider: "microsoft-teams",
        assignedAgentId: fixture.assignedAgentId,
      },
      "owner-user",
    );
    await context.service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          clientId,
          tenantId,
          clientSecret: "teams-run-secret",
        },
      },
      "owner-user",
    );
    const callbacks = context.runtime.configurations.get(
      endpoint.id,
    )?.callbacks;
    if (!callbacks) throw new Error("Expected Teams callbacks");
    const thread = makeThread({
      channelId: "teams-personal-run",
      id: "teams:personal-run:root-1",
      isDM: true,
      name: "Alex External",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: thread.thread,
      message: makeMessage({
        id: "teams-run-root-1",
        text: "@Maya produce one quiet Teams response",
        mentioned: true,
      }),
      trigger: "mention",
    });
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    if (!conversation) throw new Error("Expected Teams conversation");
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: fixture.companyId,
      agentId: fixture.assignedAgentId,
      status: "running",
      contextSnapshot: await chatWakeContext({
        endpointId: endpoint.id,
        issueId: conversation.issueId,
        provider: "microsoft-teams",
        providerMessageId: "teams-run-root-1",
      }),
    });
    for (const progressState of ["queued", "working"] as const) {
      await db.insert(chatPublications).values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: conversation.id,
        issueId: conversation.issueId,
        idempotencyKey: `run:${runId}:${progressState}:${endpoint.id}`,
        payload: {
          text:
            progressState === "queued" ? "Maya is queued." : "Maya is working…",
          progressState,
        },
        state: "pending",
      });
      await context.service.processPendingPublications();
    }
    await addSelectedChatFinal({
      agentId: fixture.assignedAgentId,
      body: "Final Teams result",
      companyId: fixture.companyId,
      issueId: conversation.issueId,
      runId,
    });
    await context.service.processPendingPublications();

    const providerRuntime = context.runtime.endpoints.get(endpoint.id);
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
        text: "Final Teams result",
      },
    ]);
    const publications = await db
      .select()
      .from(chatPublications)
      .where(eq(chatPublications.conversationId, conversation.id));
    expect(publications).toHaveLength(3);
    expect(
      publications.every(
        (publication) =>
          publication.state === "published" &&
          publication.providerMessageId === "outbound-1",
      ),
    ).toBe(true);
    await context.service.shutdown();
  });

  it("rejects unsupported Telegram webhook ports before provider access or secret persistence", async () => {
    const fixture = await seedCompany();
    const providerFetch = vi.fn(async () => {
      throw new Error("Telegram provider access must not start");
    }) as unknown as typeof globalThis.fetch;
    const { service } = createService(new FakeChatSdkRuntime(), providerFetch, {
      webhookPublicBaseUrl: "https://unsupported-telegram-origin.example:10000",
    });
    const endpoint = await service.create(
      fixture.companyId,
      {
        provider: "telegram",
        assignedAgentId: fixture.assignedAgentId,
      },
      "owner-user",
    );

    const failure = await service
      .configure(
        endpoint.id,
        {
          action: "configure",
          credentials: { botToken: "123456:telegram-port-canary" },
        },
        "owner-user",
      )
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(failure).toMatchObject({
      status: 422,
      message:
        "Telegram webhooks require PAPERCLIP_CHAT_WEBHOOK_PUBLIC_URL to use HTTPS on port 443, 80, 88, or 8443",
      details: {
        code: "chat_telegram_webhook_url_unsupported",
        provider: "telegram",
        supportedPorts: [443, 80, 88, 8443],
      },
    });
    expect(String((failure as Error | null)?.message)).not.toContain(
      "unsupported-telegram-origin",
    );
    expect(String((failure as Error | null)?.message)).not.toContain(
      "telegram-port-canary",
    );
    expect(providerFetch).not.toHaveBeenCalled();
    await expect(
      db
        .select({ refs: toolConnections.credentialSecretRefs })
        .from(toolConnections)
        .where(eq(toolConnections.id, endpoint.connectionId)),
    ).resolves.toEqual([{ refs: [] }]);
    await expect(
      db
        .select({ id: companySecretBindings.id })
        .from(companySecretBindings)
        .where(
          and(
            eq(companySecretBindings.companyId, fixture.companyId),
            eq(companySecretBindings.targetType, "tool_connection"),
            eq(companySecretBindings.targetId, endpoint.connectionId),
          ),
        ),
    ).resolves.toEqual([]);
    await expect(
      db
        .select({ id: companySecrets.id })
        .from(companySecrets)
        .where(eq(companySecrets.companyId, fixture.companyId)),
    ).resolves.toEqual([]);
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "draft",
      providerAccountId: null,
      botExternalId: null,
    });
    await service.shutdown();
  });

  it("preserves stored Telegram credentials and lifecycle when reconnect uses an unsupported webhook port", async () => {
    const fixture = await seedCompany();
    const configured = await configuredTelegramEndpoint(fixture);
    await configured.service.shutdown();
    await db
      .update(chatEndpoints)
      .set({
        status: "attention",
        healthMessage: "Telegram webhook registration needs attention",
        lastError: "Telegram webhook registration failed",
        updatedAt: new Date(),
      })
      .where(eq(chatEndpoints.id, configured.endpoint.id));
    const [endpointBefore] = await readChatEndpointsById(configured.endpoint.id);
    if (!endpointBefore) throw new Error("Expected Telegram endpoint row");
    const [connectionBefore] = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(eq(toolConnections.id, configured.endpoint.connectionId));
    const secretIdsBefore = await db
      .select({ id: companySecrets.id })
      .from(companySecrets)
      .where(eq(companySecrets.companyId, fixture.companyId));
    expect(connectionBefore?.refs).toHaveLength(2);

    const providerFetch = vi.fn(async () => {
      throw new Error("Telegram provider access must not start");
    }) as unknown as typeof globalThis.fetch;
    const reconnect = createService(new FakeChatSdkRuntime(), providerFetch, {
      webhookPublicBaseUrl:
        "https://unsupported-telegram-reconnect.example:10000",
    });
    await expect(
      reconnect.service.configure(
        configured.endpoint.id,
        { action: "reconnect" },
        "owner-user",
      ),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: "chat_telegram_webhook_url_unsupported" },
    });

    expect(providerFetch).not.toHaveBeenCalled();
    await expect(
      readChatEndpointsById(configured.endpoint.id),
    ).resolves.toEqual([endpointBefore]);
    await expect(
      db
        .select({ refs: toolConnections.credentialSecretRefs })
        .from(toolConnections)
        .where(eq(toolConnections.id, configured.endpoint.connectionId)),
    ).resolves.toEqual([connectionBefore]);
    await expect(
      db
        .select({ id: companySecrets.id })
        .from(companySecrets)
        .where(eq(companySecrets.companyId, fixture.companyId)),
    ).resolves.toEqual(secretIdsBefore);
    await reconnect.service.shutdown();
  });

  it.each([
    undefined,
    "https://ingress.example",
    "https://ingress.example:8443",
  ])(
    "configures Telegram and preserves queued updates with webhook origin %s",
    async (webhookPublicBaseUrl) => {
      const fixture = await seedCompany();
      const botToken = "123456:telegram-test-token";
      const botId = Number.parseInt(
        randomUUID().replaceAll("-", "").slice(0, 12),
        16,
      );
      const observedUrls: string[] = [];
      let existingWebhookUrl = "";
      let observedWebhook: Record<string, unknown> | null = null;
      let observedCommands: Record<string, unknown> | null = null;
      let observedWebhookDelete: Record<string, unknown> | null = null;
      let observedCommandsDelete: Record<string, unknown> | null = null;
      const providerFetch = vi.fn(
        async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          observedUrls.push(url);
          if (url.endsWith("/getMe")) {
            expect(init?.signal).toBeInstanceOf(AbortSignal);
            return new Response(
              JSON.stringify({
                ok: true,
                result: {
                  id: botId,
                  username: "maya_paperclip_bot",
                  first_name: "Maya",
                },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          if (url.endsWith("/getWebhookInfo")) {
            expect(init?.signal).toBeInstanceOf(AbortSignal);
            return new Response(
              JSON.stringify({ ok: true, result: { url: existingWebhookUrl } }),
              {
                status: 200,
                headers: { "content-type": "application/json" },
              },
            );
          }
          if (url.endsWith("/setWebhook")) {
            expect(init?.method).toBe("POST");
            observedWebhook = JSON.parse(String(init?.body)) as Record<
              string,
              unknown
            >;
            existingWebhookUrl = String(observedWebhook.url ?? "");
            return new Response(JSON.stringify({ ok: true, result: true }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          if (url.endsWith("/setMyCommands")) {
            expect(init?.method).toBe("POST");
            observedCommands = JSON.parse(String(init?.body)) as Record<
              string,
              unknown
            >;
            return new Response(JSON.stringify({ ok: true, result: true }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          if (url.endsWith("/deleteWebhook")) {
            expect(init?.method).toBe("POST");
            observedWebhookDelete = JSON.parse(String(init?.body)) as Record<
              string,
              unknown
            >;
            return new Response(JSON.stringify({ ok: true, result: true }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          if (url.endsWith("/deleteMyCommands")) {
            expect(init?.method).toBe("POST");
            observedCommandsDelete = JSON.parse(String(init?.body)) as Record<
              string,
              unknown
            >;
            return new Response(JSON.stringify({ ok: true, result: true }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          throw new Error(`Unexpected provider request: ${url}`);
        },
      ) as unknown as typeof globalThis.fetch;
      const { runtime, service } = createService(
        new FakeChatSdkRuntime(),
        providerFetch,
        { webhookPublicBaseUrl },
      );
      const endpoint = await service.create(
        fixture.companyId,
        {
          provider: "telegram",
          assignedAgentId: fixture.assignedAgentId,
        },
        "owner-user",
      );
      expect(endpoint.setup).toMatchObject({
        step: "provider_setup",
        providerUrl: "https://t.me/BotFather",
      });

      const configured = await service.configure(
        endpoint.id,
        {
          action: "configure",
          credentials: { botToken },
        },
        "owner-user",
      );

      expect(observedUrls).toEqual([
        `https://api.telegram.org/bot${encodeURIComponent(botToken)}/getMe`,
        `https://api.telegram.org/bot${encodeURIComponent(botToken)}/getWebhookInfo`,
        `https://api.telegram.org/bot${encodeURIComponent(botToken)}/setWebhook`,
        `https://api.telegram.org/bot${encodeURIComponent(botToken)}/setMyCommands`,
      ]);
      expect(configured).toMatchObject({
        status: "verifying",
        providerAccountId: String(botId),
        botExternalId: String(botId),
        botUsername: "maya_paperclip_bot",
        capabilities: { messageEdits: true, messageDeletes: false },
        setup: {
          step: "test",
          providerUrl: "https://t.me/maya_paperclip_bot",
        },
      });
      const providerConfig = runtime.configurations.get(
        endpoint.id,
      )?.providerConfig;
      expect(providerConfig).toMatchObject({
        provider: "telegram",
        credentials: { botToken, secretToken: expect.any(String) },
      });
      if (providerConfig?.provider !== "telegram")
        throw new Error("Telegram runtime configuration was not created");
      expect(observedWebhook).toEqual({
        url: `${webhookPublicBaseUrl ?? "https://paperclip.example"}/api/chat-webhooks/${endpoint.publicId}/telegram`,
        secret_token: providerConfig.credentials.secretToken,
        allowed_updates: [
          "message",
          "edited_message",
          "callback_query",
          "stopped_message_generation",
          "message_reaction",
          "my_chat_member",
        ],
        drop_pending_updates: true,
      });
      expect(observedCommands).toEqual({
        commands: [
          {
            command: "task",
            description: "Start or continue a Paperclip task",
          },
          { command: "status", description: "Show the active Paperclip task" },
          {
            command: "new",
            description: "Start a new task after the current one",
          },
          {
            command: "close",
            description: "Close the active chat conversation",
          },
        ],
      });
      const [connection] = await db
        .select({ refs: toolConnections.credentialSecretRefs })
        .from(toolConnections)
        .where(eq(toolConnections.id, endpoint.connectionId));
      expect(connection.refs.map((ref) => ref.configPath).sort()).toEqual([
        "credentials.botToken",
        "credentials.webhookSecret",
      ]);

      await db
        .update(chatEndpoints)
        .set({ status: "active", setup: { step: "complete" } })
        .where(eq(chatEndpoints.id, endpoint.id));
      existingWebhookUrl =
        "https://expired.example/api/chat-webhooks/old-public-id/telegram";
      observedUrls.length = 0;
      observedWebhook = null;
      observedCommands = null;

      const reconnected = await service.configure(
        endpoint.id,
        { action: "reconnect" },
        "owner-user",
      );

      expect(reconnected).toMatchObject({
        status: "verifying",
        setup: { step: "test" },
      });
      expect(observedUrls).toEqual([
        `https://api.telegram.org/bot${encodeURIComponent(botToken)}/getMe`,
        `https://api.telegram.org/bot${encodeURIComponent(botToken)}/getWebhookInfo`,
        `https://api.telegram.org/bot${encodeURIComponent(botToken)}/setWebhook`,
        `https://api.telegram.org/bot${encodeURIComponent(botToken)}/setMyCommands`,
      ]);
      expect(observedWebhook).toMatchObject({
        url: `${webhookPublicBaseUrl ?? "https://paperclip.example"}/api/chat-webhooks/${endpoint.publicId}/telegram`,
        // Repointing an existing bot must retain updates Telegram queued while
        // the old callback URL was unavailable.
        drop_pending_updates: false,
      });

      await service.configure(endpoint.id, { action: "remove" }, "owner-user");
      expect(observedWebhookDelete).toEqual({ drop_pending_updates: false });
      expect(observedCommandsDelete).toEqual({});
      expect(observedUrls.at(-2)).toBe(
        `https://api.telegram.org/bot${encodeURIComponent(botToken)}/deleteWebhook`,
      );
      expect(observedUrls.at(-1)).toBe(
        `https://api.telegram.org/bot${encodeURIComponent(botToken)}/deleteMyCommands`,
      );
    },
  );

  it("durably recovers rate-limited Telegram menu registration and removal cleanup", async () => {
    const fixture = await seedCompany();
    const botToken = "123456:telegram-maintenance-test";
    const botId = Number.parseInt(
      randomUUID().replaceAll("-", "").slice(0, 12),
      16,
    );
    let commandRateLimits = 0;
    let deleteWebhookRateLimits = 0;
    let deleteMyCommandsCalls = 0;
    const providerFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/getMe")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              id: botId,
              username: "paperclip_maintenance_bot",
              first_name: "Paperclip Maintenance",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/getWebhookInfo")) {
        return new Response(JSON.stringify({ ok: true, result: { url: "" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/setWebhook")) {
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/setMyCommands")) {
        if (commandRateLimits > 0) {
          commandRateLimits -= 1;
          return new Response(
            JSON.stringify({
              ok: false,
              description: "Too Many Requests",
              parameters: { retry_after: 60 * 60 },
            }),
            {
              status: 429,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/deleteWebhook")) {
        if (deleteWebhookRateLimits > 0) {
          deleteWebhookRateLimits -= 1;
          return new Response(
            JSON.stringify({
              ok: false,
              description: "Too Many Requests",
              parameters: { retry_after: 2 * 60 * 60 },
            }),
            {
              status: 429,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/deleteMyCommands")) {
        deleteMyCommandsCalls += 1;
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected provider request: ${url}`);
    }) as typeof globalThis.fetch;
    const { service } = createService(new FakeChatSdkRuntime(), providerFetch);
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "telegram", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    const configured = await service.configure(
      endpoint.id,
      { action: "configure", credentials: { botToken } },
      "owner-user",
    );
    await db
      .update(chatEndpoints)
      .set({
        status: "active",
        setup: { ...configured.setup, step: "complete" },
      })
      .where(eq(chatEndpoints.id, endpoint.id));

    commandRateLimits = 1;
    const reconnectStartedAt = Date.now();
    await expect(
      service.configure(endpoint.id, { action: "reconnect" }, "owner-user"),
    ).resolves.toMatchObject({ status: "verifying" });
    const reconnectAction = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.kind, "telegram_maintenance"),
          sql`${chatActions.payload}->>'operation' = 'register_commands'`,
        ),
      )
      .orderBy(desc(chatActions.createdAt))
      .then((rows) => rows[0]);
    expect(reconnectAction).toMatchObject({
      status: "failed",
      result: { retryable: true, attempts: 1 },
    });
    expect(
      Date.parse(String(reconnectAction.result?.retryAt)) - reconnectStartedAt,
    ).toBeGreaterThanOrEqual(60 * 60 * 1000 - 1_000);
    await db
      .update(chatActions)
      .set({
        result: {
          ...reconnectAction.result,
          retryAt: new Date(0).toISOString(),
        },
      })
      .where(eq(chatActions.id, reconnectAction.id));
    await service.processPendingDeliveries();
    await expect(
      db
        .select({ status: chatActions.status })
        .from(chatActions)
        .where(eq(chatActions.id, reconnectAction.id)),
    ).resolves.toEqual([{ status: "processed" }]);

    deleteWebhookRateLimits = 1;
    const removeStartedAt = Date.now();
    await expect(
      service.configure(endpoint.id, { action: "remove" }, "owner-user"),
    ).resolves.toMatchObject({ status: "archived" });
    const removeAction = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.kind, "telegram_maintenance"),
          sql`${chatActions.payload}->>'operation' = 'remove_endpoint'`,
        ),
      )
      .then((rows) => rows[0]);
    expect(removeAction).toMatchObject({
      status: "failed",
      result: { retryable: true, attempts: 1 },
    });
    expect(
      Date.parse(String(removeAction.result?.retryAt)) - removeStartedAt,
    ).toBeGreaterThanOrEqual(2 * 60 * 60 * 1000 - 1_000);
    await expect(
      db
        .select({ action: activityLog.action, details: activityLog.details })
        .from(activityLog)
        .where(eq(activityLog.entityId, endpoint.connectionId)),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "chat_endpoint.telegram_register_commands_deferred",
          details: expect.objectContaining({
            endpointId: endpoint.id,
            attempt: 1,
            disposition: "retry",
          }),
        }),
        expect.objectContaining({
          action: "chat_endpoint.telegram_remove_endpoint_deferred",
          details: expect.objectContaining({
            endpointId: endpoint.id,
            attempt: 1,
            disposition: "retry",
          }),
        }),
      ]),
    );
    expect(deleteMyCommandsCalls).toBe(0);
    const [pendingCleanupConnection] = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));
    expect(pendingCleanupConnection.refs.length).toBeGreaterThan(0);

    await db
      .update(chatActions)
      .set({
        result: { ...removeAction.result, retryAt: new Date(0).toISOString() },
      })
      .where(eq(chatActions.id, removeAction.id));
    await service.processPendingDeliveries();
    expect(deleteMyCommandsCalls).toBe(1);
    await expect(
      db
        .select({ status: chatActions.status })
        .from(chatActions)
        .where(eq(chatActions.id, removeAction.id)),
    ).resolves.toEqual([{ status: "processed" }]);
    await expect(
      db
        .select({ refs: toolConnections.credentialSecretRefs })
        .from(toolConnections)
        .where(eq(toolConnections.id, endpoint.connectionId)),
    ).resolves.toEqual([{ refs: [] }]);
  });

  it("serializes recovered Telegram maintenance behind credential rotation", async () => {
    const fixture = await seedCompany();
    const oldBotToken = "123456:telegram-old-maintenance-token";
    const newBotToken = "123456:telegram-new-maintenance-token";
    const botId = Number.parseInt(
      randomUUID().replaceAll("-", "").slice(0, 12),
      16,
    );
    let blockNewCredentialCheck = false;
    let markCredentialCheckReady!: () => void;
    let releaseCredentialCheck!: () => void;
    const credentialCheckReady = new Promise<void>((resolve) => {
      markCredentialCheckReady = resolve;
    });
    const credentialCheckRelease = new Promise<void>((resolve) => {
      releaseCredentialCheck = resolve;
    });
    const commandTokens: string[] = [];
    const providerFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/getMe")) {
        if (
          blockNewCredentialCheck &&
          url.includes(encodeURIComponent(newBotToken))
        ) {
          markCredentialCheckReady();
          await credentialCheckRelease;
        }
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              id: botId,
              username: "paperclip_maintenance_race_bot",
              first_name: "Paperclip Maintenance Race",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/getWebhookInfo")) {
        return new Response(JSON.stringify({ ok: true, result: { url: "" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/setWebhook")) {
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/setMyCommands")) {
        commandTokens.push(
          url.includes(encodeURIComponent(newBotToken))
            ? newBotToken
            : oldBotToken,
        );
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected provider request: ${url}`);
    }) as typeof globalThis.fetch;
    const { service } = createService(new FakeChatSdkRuntime(), providerFetch);
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "telegram", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await service.configure(
      endpoint.id,
      { action: "configure", credentials: { botToken: oldBotToken } },
      "owner-user",
    );
    const staleAction = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.kind, "telegram_maintenance"),
        ),
      )
      .then((rows) => rows[0]!);
    await db
      .update(chatActions)
      .set({
        status: "failed",
        result: {
          attempts: 1,
          retryable: true,
          retryAt: new Date(0).toISOString(),
        },
      })
      .where(eq(chatActions.id, staleAction.id));
    commandTokens.length = 0;

    blockNewCredentialCheck = true;
    const reconnect = service.configure(
      endpoint.id,
      { action: "reconnect", credentials: { botToken: newBotToken } },
      "owner-user",
    );
    await credentialCheckReady;
    const recovery = service.processPendingDeliveries();
    releaseCredentialCheck();
    await reconnect;
    await recovery;

    expect(commandTokens).toEqual([newBotToken]);
    await expect(
      db
        .select({ status: chatActions.status, result: chatActions.result })
        .from(chatActions)
        .where(eq(chatActions.id, staleAction.id)),
    ).resolves.toEqual([
      {
        status: "cancelled",
        result: expect.objectContaining({
          code: "telegram_maintenance_credentials_superseded",
        }),
      },
    ]);
  });

  it("reconciles Slack membership during configure, resume, and reconnect", async () => {
    const fixture = await seedCompany();
    let channels = [
      { id: "C-ONE", name: "one", is_member: true, is_archived: false, creator: "U-HUMAN" },
    ];
    const providerFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://slack.com/api/auth.test") {
        return new Response(
          JSON.stringify({
            ok: true,
            team_id: "T-RECONCILE",
            team: "Reconcile Test",
            user_id: "U-RECONCILE",
            user: "maya-reconcile",
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-oauth-scopes": TEST_SLACK_BOT_SCOPES,
            },
          },
        );
      }
      if (url.startsWith("https://slack.com/api/conversations.list")) {
        return new Response(
          JSON.stringify({
            ok: true,
            channels,
            response_metadata: { next_cursor: "" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected provider request: ${url}`);
    }) as typeof globalThis.fetch;
    const { service } = createService(new FakeChatSdkRuntime(), providerFetch);
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "slack", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          botToken: "xoxb-reconcile",
          signingSecret: "reconcile-signing-secret",
        },
      },
      "owner-user",
    );
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "C-ONE",
        availability: "available",
        enabled: true,
      }),
    ]);

    const [firstResource] = await service.listResources(endpoint.id);
    await service.replaceResources(endpoint.id, [{ id: firstResource!.id, enabled: false }]);
    await service.configure(endpoint.id, { action: "reconnect", credentials: {
      botToken: "xoxb-reconcile", signingSecret: "reconcile-signing-secret",
    } }, "owner-user");
    expect((await service.listResources(endpoint.id))[0]).toMatchObject({
      id: firstResource!.id, enabled: false, availability: "available",
    });

    await db
      .update(chatEndpoints)
      .set({ status: "active", setup: { step: "complete" } })
      .where(eq(chatEndpoints.id, endpoint.id));
    await service.configure(endpoint.id, { action: "pause" }, "owner-user");
    channels = [
      { id: "C-TWO", name: "two", is_member: true, is_archived: false, creator: "U-HUMAN" },
    ];
    await service.configure(endpoint.id, { action: "resume" }, "owner-user");
    expect(
      (await service.listResources(endpoint.id)).map((resource) => ({
        id: resource.providerResourceId,
        availability: resource.availability,
      })),
    ).toEqual([
      { id: "C-ONE", availability: "unavailable" },
      { id: "C-TWO", availability: "available" },
    ]);

    await db
      .update(chatEndpoints)
      .set({ status: "attention" })
      .where(eq(chatEndpoints.id, endpoint.id));
    channels = [
      { id: "C-THREE", name: "three", is_member: true, is_archived: false, creator: "U-RECONCILE" },
    ];
    await service.configure(
      endpoint.id,
      {
        action: "reconnect",
        credentials: {
          botToken: "xoxb-reconcile",
          signingSecret: "reconcile-signing-secret",
        },
      },
      "owner-user",
    );
    expect(
      (await service.listResources(endpoint.id)).map((resource) => ({
        id: resource.providerResourceId,
        availability: resource.availability,
      })),
    ).toEqual([
      { id: "C-ONE", availability: "unavailable" },
      { id: "C-THREE", availability: "available" },
      { id: "C-TWO", availability: "unavailable" },
    ]);
    expect((await service.listResources(endpoint.id)).find(resource => resource.providerResourceId === "C-THREE"))
      .toMatchObject({ enabled: false });
  });
});
