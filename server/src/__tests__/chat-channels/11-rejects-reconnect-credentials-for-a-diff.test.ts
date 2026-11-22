import {

} from "../../services/cloud-runtime-identity.js";
import {
  randomUUID,
} from "node:crypto";
import {
  and,
  eq,
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
  chatExternalPrincipals,
  chatPublications,
  heartbeatRuns,
  issues,
  toolConnections,
} from "@paperclipai/db";
import {
  FakeChatSdkRuntime,
  TEST_SLACK_BOT_SCOPES,
  fakeSlackFetch,
  fakeTelegramFetch,
  makeMessage,
  makeThread,
} from ".././helpers/chat-channels-fixture.js";
import {
  addSelectedChatFinal,
  chatWakeContext,
  configuredSlackEndpoint,
  createService,
  db,
  deliverMessage,
  describeChatChannelsSuite,
  qualifySetupRoundTrip,
  readChatConversationsByEndpointId,
  readChatDeliveriesByEndpointId,
  readIssuesByCompanyId,
  readIssuesById,
  readToolConnectionsById,
  recordSlackUrlVerification,
  seedCompany,
  signedSlackWebhookRequest,
  configuredGitHubEndpoint,
} from "../helpers/chat-channels-harness.js";
import * as cloudRuntimeIdentity from "../../services/cloud-runtime-identity.js";

describeChatChannelsSuite("chat channels 11-rejects-reconnect-credentials-for-a-diff", () => {
  it("rejects reconnect credentials for a different Slack bot without rotating secrets", async () => {
    const fixture = await seedCompany();
    let botId = "U-ORIGINAL-BOT";
    const providerFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://slack.com/api/auth.test") {
        return new Response(
          JSON.stringify({
            ok: true,
            team_id: "T-IMMUTABLE",
            team: "Immutable Test",
            user_id: botId,
            user: botId === "U-ORIGINAL-BOT" ? "maya-original" : "maya-other",
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
            channels: [],
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
          botToken: "xoxb-original",
          signingSecret: "original-secret",
        },
      },
      "owner-user",
    );
    const [before] = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));

    botId = "U-DIFFERENT-BOT";
    await expect(
      service.configure(
        endpoint.id,
        {
          action: "reconnect",
          credentials: {
            botToken: "xoxb-different",
            signingSecret: "different-secret",
          },
        },
        "owner-user",
      ),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: "chat_bot_identity_changed" },
    });

    const [after] = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));
    expect(after.refs).toEqual(before.refs);
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      botExternalId: "U-ORIGINAL-BOT",
    });
  });

  it.each(["membership-first", "mention-first"])(
    "accepts the Slack invitation mention exactly once (%s)",
    async (order) => {
      const fixture = await seedCompany();
      const { callbacks, endpoint, service, wakeup } =
        await configuredSlackEndpoint(fixture);
      await db
        .update(chatEndpoints)
        .set({ status: "active" })
        .where(eq(chatEndpoints.id, endpoint.id));
      const current = await service.get(endpoint.id);
      const channel = makeThread({
        channelId: "C-INVITED",
        id: "slack:C-INVITED:100.1",
        name: "invited",
      });
      const mention = () =>
        deliverMessage({
          callbacks,
          endpointId: endpoint.id,
          thread: channel.thread,
          message: makeMessage({
            id: "100.1",
            text: "@maya summarize the recent papercuts",
            mentioned: true,
          }),
          trigger: "mention",
        });
      const joined = () =>
        service.handleWebhook(
          endpoint.publicId,
          "slack",
          new Request("https://paperclip.example/slack", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              event_id: "Ev-invited",
              event: {
                type: "member_joined_channel",
                event_ts: "101.0",
                user: current.botExternalId,
                channel: "C-INVITED",
                channel_type: "C",
              },
            }),
          }),
        );
      if (order === "membership-first") {
        await joined();
        await mention();
      } else {
        await mention();
        await joined();
      }
      // Slack may retry either event. Neither changes the resource choice or starts duplicate work.
      await joined();
      await mention();
      const resources = await service.listResources(endpoint.id);
      expect(resources).toHaveLength(1);
      expect(resources[0]).toMatchObject({
        providerResourceId: "C-INVITED",
        availability: "available",
        enabled: true,
      });
      expect(await service.listConversations(endpoint.id)).toHaveLength(1);
      expect(
        await readIssuesByCompanyId(fixture.companyId),
      ).toHaveLength(1);
      expect(wakeup).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["verifying", "active"] as const)(
    "preserves an explicitly disabled Slack channel after invitation and mentions (%s)",
    async (status) => {
      const fixture = await seedCompany();
      const { callbacks, endpoint, service, wakeup } =
        await configuredSlackEndpoint(fixture);
      if (status === "active")
        await db
          .update(chatEndpoints)
          .set({ status })
          .where(eq(chatEndpoints.id, endpoint.id));
      const current = await service.get(endpoint.id);
      let eventSequence = 100;
      const membership = (type: string) =>
        service.handleWebhook(
          endpoint.publicId,
          "slack",
          new Request("https://paperclip.example/slack", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              event_id: `Ev-disabled-${eventSequence}`,
              event: {
                type,
                event_ts: String(eventSequence++),
                user: current.botExternalId,
                channel: "C-DISABLED",
                channel_type: "C",
              },
            }),
          }),
        );
      await membership("member_joined_channel");
      const [resource] = await service.listResources(endpoint.id);
      expect(resource!.enabled).toBe(true);
      await service.replaceResources(endpoint.id, [
        { id: resource!.id, enabled: false },
      ]);
      await membership("member_left_channel");
      await membership("member_joined_channel");
      const channel = makeThread({
        channelId: "C-DISABLED",
        id: "slack:C-DISABLED:200.1",
        name: "disabled",
      });
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        thread: channel.thread,
        message: makeMessage({
          id: "200.1",
          text: "@maya do not override the opt-out",
          mentioned: true,
        }),
        trigger: "mention",
      });
      expect((await service.listResources(endpoint.id))[0]).toMatchObject({
        enabled: false,
        availability: "available",
      });
      expect(await service.listConversations(endpoint.id)).toHaveLength(0);
      expect(wakeup).not.toHaveBeenCalled();
    },
  );

  it("persists Slack membership, uninstall, and same-bot reinstall lifecycle before acknowledging", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture);
    const configuredEndpoint = await service.get(endpoint.id);
    const send = (payload: unknown) =>
      service.handleWebhook(
        endpoint.publicId,
        "slack",
        new Request("https://paperclip.example/slack", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }),
      );

    await send({
      event_id: "Ev-member-joined",
      event: {
        type: "member_joined_channel",
        event_ts: "100.000000",
        user: configuredEndpoint.botExternalId,
        channel: "C-LIFECYCLE",
        channel_type: "C",
      },
    });
    const [resource] = await db
      .select()
      .from(chatEndpointResources)
      .where(eq(chatEndpointResources.endpointId, endpoint.id));
    expect(resource).toMatchObject({
      providerResourceId: "C-LIFECYCLE",
      availability: "available",
      enabled: true,
    });
    await vi.waitFor(async () => {
      await expect(service.listResources(endpoint.id)).resolves.toEqual([
        expect.objectContaining({ label: "#c-lifecycle" }),
      ]);
    });
    await service.replaceResources(endpoint.id, [
      { id: resource.id, enabled: true },
    ]);

    const thread = makeThread({
      channelId: "C-LIFECYCLE",
      id: "slack:C-LIFECYCLE:123.45",
      name: "slack:C-LIFECYCLE",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: thread.thread,
      message: makeMessage({
        id: "123.45",
        text: "@maya preserve this task",
        mentioned: true,
      }),
      trigger: "mention",
    });
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    expect(conversation).toBeDefined();
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({ label: "#c-lifecycle" }),
    ]);

    const leftEvent = {
      event_id: "Ev-member-left",
      event: {
        type: "channel_left",
        event_ts: "200.000000",
        channel: "C-LIFECYCLE",
      },
    };
    await send(leftEvent);
    await send(leftEvent);
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "C-LIFECYCLE",
        availability: "unavailable",
        label: "#c-lifecycle",
      }),
    ]);
    expect(
      await db
        .select({ state: chatConversations.state })
        .from(chatConversations)
        .where(eq(chatConversations.id, conversation.id)),
    ).toEqual([{ state: "unavailable" }]);
    expect(
      await readIssuesById(conversation.issueId),
    ).toHaveLength(1);
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: makeThread({
        channelId: "C-LIFECYCLE",
        id: "slack:C-LIFECYCLE:999.01",
        name: "lifecycle",
      }).thread,
      message: makeMessage({
        id: "999.01",
        text: "@maya this delayed root must stay blocked",
        mentioned: true,
      }),
      trigger: "mention",
    });
    expect(
      await readIssuesByCompanyId(fixture.companyId),
    ).toHaveLength(1);
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({ availability: "unavailable", enabled: true }),
    ]);
    await send({
      event_id: "Ev-stale-member-joined",
      event: {
        type: "member_joined_channel",
        event_ts: "150.000000",
        user: configuredEndpoint.botExternalId,
        channel: "C-LIFECYCLE",
      },
    });
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({ availability: "unavailable", enabled: true }),
    ]);
    expect(
      (
        await readChatDeliveriesByEndpointId(endpoint.id)
      ).filter(
        (delivery) => delivery.providerEventId === "lifecycle:Ev-member-left",
      ),
    ).toHaveLength(1);

    await send({
      event_id: "Ev-uninstalled",
      event: { type: "app_uninstalled" },
    });
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "revoked",
      healthMessage: "Slack app was uninstalled",
    });
    expect(runtime.endpoints.has(endpoint.id)).toBe(false);
    const [connection] = await readToolConnectionsById(endpoint.connectionId);
    expect(connection).toMatchObject({
      status: "disabled",
      enabled: false,
      healthStatus: "failed",
    });

    const reconnecting = await service.configure(
      endpoint.id,
      {
        action: "reconnect",
        credentials: {
          botToken: "xoxb-test-token",
          signingSecret: "test-signing-secret",
        },
      },
      "owner-user",
    );
    expect(reconnecting).toMatchObject({
      status: "verifying",
      botExternalId: configuredEndpoint.botExternalId,
      // Same app, signing secret, and callback URL retain their signed proof.
      setup: { step: "provider_setup", webhookVerifiedAt: configuredEndpoint.setup?.webhookVerifiedAt },
    });
    expect(runtime.endpoints.has(endpoint.id)).toBe(true);
    await recordSlackUrlVerification(service, endpoint.publicId);
    await expect(
      service.configure(endpoint.id, { action: "verify" }, "owner-user"),
    ).resolves.toMatchObject({
      status: "verifying",
      setup: { step: "test", webhookVerifiedAt: expect.any(String) },
    });
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "C-LIFECYCLE",
        availability: "unavailable",
        enabled: true,
        label: "#c-lifecycle",
      }),
    ]);
  });

  it("orders Slack private-channel archive, unarchive, and rename lifecycle", async () => {
    const fixture = await seedCompany();
    const { endpoint, service } = await configuredSlackEndpoint(fixture);
    const webhookUrl = `https://paperclip.example/api/chat-webhooks/${endpoint.publicId}/slack`;
    const send = async (
      eventId: string,
      type: string,
      eventTs: string,
      channel: string | { id: string; name: string },
    ) => {
      const body = JSON.stringify({
        event_id: eventId,
        event: { type, event_ts: eventTs, channel },
      });
      await service.handleWebhook(
        endpoint.publicId,
        "slack",
        signedSlackWebhookRequest({
          url: webhookUrl,
          contentType: "application/json",
          body,
        }),
      );
    };
    const resource = async () =>
      (await service.listResources(endpoint.id)).find(
        (candidate) => candidate.providerResourceId === "G-PRIVATE-LIFECYCLE",
      );

    await send(
      "Ev-group-archive",
      "group_archive",
      "300.000000",
      "G-PRIVATE-LIFECYCLE",
    );
    await expect(resource()).resolves.toMatchObject({
      availability: "unavailable",
    });

    await send(
      "Ev-group-unarchive",
      "group_unarchive",
      "400.000000",
      "G-PRIVATE-LIFECYCLE",
    );
    await send(
      "Ev-stale-group-archive",
      "group_archive",
      "350.000000",
      "G-PRIVATE-LIFECYCLE",
    );
    await expect(resource()).resolves.toMatchObject({
      availability: "available",
    });

    await send("Ev-group-rename", "group_rename", "500.000000", {
      id: "G-PRIVATE-LIFECYCLE",
      name: "private-renamed",
    });
    await expect(resource()).resolves.toMatchObject({
      availability: "available",
      label: "private-renamed",
    });
  });

  it("applies Teams installation and Telegram membership resource lifecycle", async () => {
    const fixture = await seedCompany();
    const teams = createService(
      new FakeChatSdkRuntime(),
      (async () =>
        new Response(JSON.stringify({ access_token: "teams-access" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof globalThis.fetch,
    );
    const teamsEndpoint = await teams.service.create(
      fixture.companyId,
      {
        provider: "microsoft-teams",
        assignedAgentId: fixture.assignedAgentId,
      },
      "owner-user",
    );
    const teamsClientId = "00000000-0000-4000-8000-000000000111";
    await teams.service.configure(
      teamsEndpoint.id,
      {
        action: "configure",
        credentials: {
          clientId: teamsClientId,
          tenantId: "00000000-0000-4000-8000-000000000222",
          clientSecret: "teams-secret",
        },
      },
      "owner-user",
    );
    const teamsTenantId = "00000000-0000-4000-8000-000000000222";
    const teamsPayload = (
      action: "add" | "remove",
      id = `teams-${action}`,
      timestamp = action === "add"
        ? "2026-09-05T14:00:00.000Z"
        : "2026-09-05T14:01:00.000Z",
    ) => ({
      id,
      type: "installationUpdate",
      action,
      timestamp,
      conversation: {
        id: "19:conversation@thread.tacv2",
        isGroup: true,
        tenantId: teamsTenantId,
      },
      channelData: {
        tenant: { id: teamsTenantId },
        team: { id: "team-1", name: "Paperclip" },
        channel: { id: "channel-1", name: "Engineering" },
      },
    });
    const deliverTeamsLifecycle = (payload: unknown) =>
      teams.service.handleWebhook(
        teamsEndpoint.publicId,
        "microsoft-teams",
        new Request("https://paperclip.example/teams", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }),
      );
    const foreignTenantPayload = teamsPayload("add");
    foreignTenantPayload.id = "teams-foreign-tenant";
    foreignTenantPayload.conversation.tenantId = "foreign-tenant";
    foreignTenantPayload.channelData.tenant.id = "foreign-tenant";
    await expect(
      deliverTeamsLifecycle(foreignTenantPayload),
    ).resolves.toMatchObject({ status: 202 });
    const missingTenantPayload = teamsPayload("add") as Omit<
      ReturnType<typeof teamsPayload>,
      "conversation" | "channelData"
    > & {
      conversation: Omit<
        ReturnType<typeof teamsPayload>["conversation"],
        "tenantId"
      >;
      channelData: Omit<
        ReturnType<typeof teamsPayload>["channelData"],
        "tenant"
      >;
    };
    delete (missingTenantPayload.conversation as { tenantId?: string })
      .tenantId;
    delete (missingTenantPayload.channelData as { tenant?: { id: string } })
      .tenant;
    missingTenantPayload.id = "teams-missing-tenant";
    await expect(
      deliverTeamsLifecycle(missingTenantPayload),
    ).resolves.toMatchObject({ status: 202 });
    await expect(
      teams.service.listResources(teamsEndpoint.id),
    ).resolves.toEqual([]);
    await expect(
      readChatDeliveriesByEndpointId(teamsEndpoint.id),
    ).resolves.toHaveLength(0);

    await deliverTeamsLifecycle(teamsPayload("add"));
    const [teamsResource] = await teams.service.listResources(teamsEndpoint.id);
    expect(teamsResource).toMatchObject({
      providerResourceId: "19:conversation@thread.tacv2",
      availability: "available",
      enabled: false,
    });
    await teams.service.replaceResources(teamsEndpoint.id, [
      { id: teamsResource!.id, enabled: true },
    ]);
    const teamsCallbacks = teams.runtime.configurations.get(
      teamsEndpoint.id,
    )?.callbacks;
    if (!teamsCallbacks) throw new Error("Expected Teams callbacks");
    const teamsServiceUrl = "https://smba.trafficmanager.net/amer/";
    const teamsConversationId = "19:conversation@thread.tacv2";
    const teamsChannelId = `teams:${Buffer.from(teamsConversationId).toString("base64url")}:${Buffer.from(teamsServiceUrl).toString("base64url")}`;
    const teamsThreadId = `teams:${Buffer.from(`${teamsConversationId};messageid=1729`).toString("base64url")}:${Buffer.from(teamsServiceUrl).toString("base64url")}`;
    await deliverMessage({
      callbacks: teamsCallbacks,
      endpointId: teamsEndpoint.id,
      provider: "microsoft-teams",
      thread: makeThread({
        channelId: teamsChannelId,
        id: teamsThreadId,
        name: "Engineering",
      }).thread,
      message: makeMessage({
        id: "teams-root-1729",
        text: "@Maya investigate the alert",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await expect(
      readChatConversationsByEndpointId(teamsEndpoint.id),
    ).resolves.toHaveLength(1);
    await deliverTeamsLifecycle(teamsPayload("remove"));
    await expect(
      teams.service.listResources(teamsEndpoint.id),
    ).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "19:conversation@thread.tacv2",
        label: "Engineering",
        availability: "removed",
      }),
    ]);
    await expect(
      db
        .select({ state: chatConversations.state })
        .from(chatConversations)
        .where(eq(chatConversations.endpointId, teamsEndpoint.id)),
    ).resolves.toEqual([{ state: "unavailable" }]);
    await deliverTeamsLifecycle(
      teamsPayload("add", "teams-stale-add", "2026-09-05T14:00:30.000Z"),
    );
    await expect(
      teams.service.listResources(teamsEndpoint.id),
    ).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "19:conversation@thread.tacv2",
        availability: "removed",
      }),
    ]);
    await deliverTeamsLifecycle(
      teamsPayload("add", "teams-reinstalled", "2026-09-05T14:02:00.000Z"),
    );
    await expect(
      teams.service.listResources(teamsEndpoint.id),
    ).resolves.toEqual([
      expect.objectContaining({
        id: teamsResource!.id,
        providerResourceId: "19:conversation@thread.tacv2",
        label: "Engineering",
        availability: "available",
        enabled: true,
      }),
    ]);
    await expect(
      db
        .select({
          id: chatConversations.id,
          issueId: chatConversations.issueId,
          state: chatConversations.state,
        })
        .from(chatConversations)
        .where(eq(chatConversations.endpointId, teamsEndpoint.id)),
    ).resolves.toEqual([
      {
        id: expect.any(String),
        issueId: expect.any(String),
        state: "active",
      },
    ]);
    await expect(
      db
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.companyId, fixture.companyId)),
    ).resolves.toHaveLength(1);

    const personalPayload = (action: "add" | "remove") => ({
      id: `teams-personal-${action}`,
      type: "installationUpdate",
      action,
      conversation: {
        id: "a:teams-personal-conversation",
        conversationType: "personal",
        tenantId: teamsTenantId,
      },
      channelData: { tenant: { id: teamsTenantId } },
    });
    await deliverTeamsLifecycle(personalPayload("add"));
    await expect(
      db
        .select()
        .from(chatEndpointResources)
        .where(
          and(
            eq(chatEndpointResources.endpointId, teamsEndpoint.id),
            eq(
              chatEndpointResources.providerResourceId,
              "a:teams-personal-conversation",
            ),
          ),
        ),
    ).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "a:teams-personal-conversation",
        type: "direct_message",
        availability: "available",
      }),
    ]);
    await deliverTeamsLifecycle(personalPayload("remove"));
    await expect(
      db
        .select()
        .from(chatEndpointResources)
        .where(
          and(
            eq(chatEndpointResources.endpointId, teamsEndpoint.id),
            eq(
              chatEndpointResources.providerResourceId,
              "a:teams-personal-conversation",
            ),
          ),
        ),
    ).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "a:teams-personal-conversation",
        type: "direct_message",
        availability: "removed",
      }),
    ]);

    await deliverTeamsLifecycle({
      id: "teams-group-member-added",
      type: "conversationUpdate",
      conversation: {
        id: "19:teams-group-conversation@unq.gbl.spaces",
        conversationType: "group",
        tenantId: teamsTenantId,
      },
      channelData: { tenant: { id: teamsTenantId } },
      membersAdded: [{ id: `28:${teamsClientId}` }],
    });
    await expect(
      teams.service.listResources(teamsEndpoint.id),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerResourceId: "19:teams-group-conversation@unq.gbl.spaces",
          type: "group_chat",
          availability: "available",
        }),
      ]),
    );
    await deliverTeamsLifecycle({
      id: "teams-group-member-removed",
      type: "conversationUpdate",
      conversation: {
        id: "19:teams-group-conversation@unq.gbl.spaces",
        conversationType: "groupChat",
        tenantId: teamsTenantId,
      },
      channelData: { tenant: { id: teamsTenantId } },
      membersRemoved: [{ id: `28:${teamsClientId}` }],
    });
    await expect(
      teams.service.listResources(teamsEndpoint.id),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerResourceId: "19:teams-group-conversation@unq.gbl.spaces",
          type: "group_chat",
          availability: "unavailable",
        }),
      ]),
    );

    const telegram = createService(
      new FakeChatSdkRuntime(),
      fakeTelegramFetch(445566) as typeof globalThis.fetch,
    );
    const telegramEndpoint = await telegram.service.create(
      fixture.companyId,
      { provider: "telegram", assignedAgentId: fixture.replacementAgentId },
      "owner-user",
    );
    await telegram.service.configure(
      telegramEndpoint.id,
      {
        action: "configure",
        credentials: { botToken: "445566:telegram-lifecycle" },
      },
      "owner-user",
    );
    const telegramMembership = (updateId: number, status: string) =>
      telegram.service.handleWebhook(
        telegramEndpoint.publicId,
        "telegram",
        new Request("https://paperclip.example/telegram", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            update_id: updateId,
            my_chat_member: {
              chat: { id: -100123, type: "supergroup", title: "Engineering" },
              new_chat_member: { status },
            },
          }),
        }),
      );
    await telegramMembership(1, "member");
    const [telegramResource] = await telegram.service.listResources(
      telegramEndpoint.id,
    );
    await telegram.service.replaceResources(telegramEndpoint.id, [
      { id: telegramResource!.id, enabled: true },
    ]);
    const telegramCallbacks = telegram.runtime.configurations.get(
      telegramEndpoint.id,
    )?.callbacks;
    if (!telegramCallbacks) throw new Error("Expected Telegram callbacks");
    await deliverMessage({
      callbacks: telegramCallbacks,
      endpointId: telegramEndpoint.id,
      provider: "telegram",
      thread: makeThread({
        channelId: "-100123",
        id: "telegram:-100123:77",
        // The native adapter may expose this fallback when the message and
        // my_chat_member callbacks are interleaved. It must not replace the
        // human title already learned from the membership payload.
        name: "telegram:-100123",
      }).thread,
      message: makeMessage({
        id: "telegram-root-77",
        text: "@paperclip investigate the alert",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await expect(
      readChatConversationsByEndpointId(telegramEndpoint.id),
    ).resolves.toHaveLength(1);
    await expect(
      telegram.service.listResources(telegramEndpoint.id),
    ).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "-100123",
        label: "Engineering",
        availability: "available",
      }),
    ]);
    await telegramMembership(2, "left");
    await expect(
      telegram.service.listResources(telegramEndpoint.id),
    ).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "-100123",
        label: "Engineering",
        availability: "unavailable",
      }),
    ]);
    await telegramMembership(0, "administrator");
    await expect(
      telegram.service.listResources(telegramEndpoint.id),
    ).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "-100123",
        availability: "unavailable",
      }),
    ]);
  });

  it("does not acknowledge lifecycle callbacks whose durable write fails", async () => {
    const fixture = await seedCompany();
    const { endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture);
    const configuredEndpoint = await service.get(endpoint.id);
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected provider runtime");
    providerRuntime.handleWebhook = vi.fn(async () => {
      await db.delete(chatEndpoints).where(eq(chatEndpoints.id, endpoint.id));
      return new Response("accepted", { status: 202 });
    });
    await expect(
      service.handleWebhook(
        endpoint.publicId,
        "slack",
        new Request("https://paperclip.example/slack", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            event_id: "Ev-must-persist",
            event: {
              type: "member_joined_channel",
              user: configuredEndpoint.botExternalId,
              channel: "C-MUST-PERSIST",
            },
          }),
        }),
      ),
    ).rejects.toBeDefined();
  });

  it("retries a durable lifecycle row without treating it as a message delivery", async () => {
    const fixture = await seedCompany();
    const { endpoint, service } = await configuredSlackEndpoint(fixture);
    const configuredEndpoint = await service.get(endpoint.id);
    const originalTransaction = db.transaction.bind(db);
    const transaction = vi.spyOn(db, "transaction");
    let injected = false;
    transaction.mockImplementation(async (callback, options) => {
      const [delivery] = await db.select({ state: chatDeliveries.state }).from(chatDeliveries).where(and(
        eq(chatDeliveries.endpointId, endpoint.id),
        eq(chatDeliveries.providerEventId, "lifecycle:Ev-lifecycle-retry"),
      ));
      // Fail the lifecycle effect after durable admission and claim, regardless
      // of how many transaction boundaries those writes require.
      if (!injected && delivery?.state === "processing") {
        injected = true;
        throw new Error("injected lifecycle persistence failure");
      }
      return originalTransaction(callback, options);
    });
    await expect(
      service.handleWebhook(
        endpoint.publicId,
        "slack",
        new Request("https://paperclip.example/slack", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            event_id: "Ev-lifecycle-retry",
            event: {
              type: "member_joined_channel",
              user: configuredEndpoint.botExternalId,
              channel: "C-RETRY-LIFECYCLE",
            },
          }),
        }),
      ),
    ).rejects.toThrow("injected lifecycle persistence failure");
    transaction.mockRestore();
    const [retry] = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(chatDeliveries.providerEventId, "lifecycle:Ev-lifecycle-retry"),
        ),
      );
    expect(retry).toMatchObject({ state: "retry", attempts: 1 });

    await service.processPendingDeliveries(25, retry!.id);
    await expect(
      db
        .select({ state: chatDeliveries.state })
        .from(chatDeliveries)
        .where(eq(chatDeliveries.id, retry!.id)),
    ).resolves.toEqual([{ state: "processed" }]);
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "C-RETRY-LIFECYCLE",
        availability: "available",
      }),
    ]);
  });

  it("activates Slack only after provider verification and a real test message", async () => {
    const fixture = await seedCompany();
    const { runtime, service } = createService();
    const endpoint = await service.create(
      fixture.companyId,
      {
        provider: "slack",
        assignedAgentId: fixture.assignedAgentId,
      },
      "owner-user",
    );
    expect(endpoint.allowUnlinkedPeople).toBe(false);
    await service.update(endpoint.id, { allowUnlinkedPeople: true }, "owner-user");

    const configured = await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          botToken: "xoxb-test-token",
          signingSecret: "test-signing-secret",
        },
      },
      "owner-user",
    );
    expect(configured).toMatchObject({
      status: "verifying",
      setup: { step: "provider_setup" },
    });
    const [storedConfigured] = await db
      .select({ setup: chatEndpoints.setup })
      .from(chatEndpoints)
      .where(eq(chatEndpoints.id, endpoint.id));
    expect(storedConfigured.setup).toMatchObject({
      step: "provider_setup",
      testStartedAt: null,
      webhookVerifiedAt: null,
      runtimeGeneration: expect.any(Number),
    });

    await expect(
      service.configure(endpoint.id, { action: "verify" }, "owner-user"),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: "chat_webhook_not_verified" },
    });
    await recordSlackUrlVerification(service, endpoint.publicId);

    const providerVerified = await service.configure(
      endpoint.id,
      { action: "verify" },
      "owner-user",
    );
    expect(providerVerified).toMatchObject({
      status: "verifying",
      setup: { step: "test" },
    });
    const [storedProviderVerified] = await db
      .select({ setup: chatEndpoints.setup })
      .from(chatEndpoints)
      .where(eq(chatEndpoints.id, endpoint.id));
    expect(storedProviderVerified.setup).toMatchObject({
      step: "test",
      testStartedAt: expect.any(String),
    });
    await expect(service.test(endpoint.id)).rejects.toMatchObject({
      status: 409,
      details: { code: "chat_test_message_missing" },
    });

    const callbacks = runtime.configurations.get(endpoint.id)?.callbacks;
    if (!callbacks)
      throw new Error("Fake runtime did not receive endpoint callbacks");
    const testThread = makeThread({
      channelId: "C-SETUP",
      id: "slack:C-SETUP:9000.1",
      name: "setup",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: testThread.thread,
      message: makeMessage({
        id: "9000.1",
        text: "@maya verify this connection",
        mentioned: true,
      }),
      trigger: "mention",
    });

    await expect(service.test(endpoint.id)).rejects.toMatchObject({
      status: 409,
      details: { code: "chat_test_follow_up_missing" },
    });
    await qualifySetupRoundTrip(service, endpoint.id);

    const activated = await service.test(endpoint.id);
    expect(activated).toMatchObject({
      status: "active",
      healthMessage: "Connected",
      activatedAt: expect.any(String),
      setup: { step: "complete" },
    });
    const [storedActivated] = await db
      .select({ setup: chatEndpoints.setup })
      .from(chatEndpoints)
      .where(eq(chatEndpoints.id, endpoint.id));
    expect(storedActivated.setup).toMatchObject({
      step: "complete",
      testStartedAt: null,
      runtimeGeneration: expect.any(Number),
    });
  });

  it("serializes setup activation ahead of a concurrent reconnect without overwriting the newer runtime", async () => {
    const fixture = await seedCompany();
    let enterActivation!: () => void;
    const activationEntered = new Promise<void>((resolve) => {
      enterActivation = resolve;
    });
    let releaseActivation!: () => void;
    const activationReleased = new Promise<void>((resolve) => {
      releaseActivation = resolve;
    });
    const runtime = new FakeChatSdkRuntime();
    const { service } = createService(
      runtime,
      fakeSlackFetch() as typeof globalThis.fetch,
      {
        setupTestActivationBarrier: async () => {
          enterActivation();
          await activationReleased;
        },
      },
    );
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "slack", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await service.update(endpoint.id, { allowUnlinkedPeople: true }, "owner-user");
    await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          botToken: "xoxb-test-token",
          signingSecret: "test-signing-secret",
        },
      },
      "owner-user",
    );
    await recordSlackUrlVerification(service, endpoint.publicId);
    await service.configure(endpoint.id, { action: "verify" }, "owner-user");
    const callbacks = runtime.configurations.get(endpoint.id)?.callbacks;
    if (!callbacks) throw new Error("Expected Slack runtime callbacks");
    const testThread = makeThread({
      channelId: "C-SETUP-RECONNECT-RACE",
      id: "slack:C-SETUP-RECONNECT-RACE:9001.1",
      name: "setup-reconnect-race",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: testThread.thread,
      message: makeMessage({
        id: "9001.1",
        text: "@maya verify setup before reconnect",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id);

    const activation = service.test(endpoint.id);
    await activationEntered;
    let reconnectSettled = false;
    const reconnect = service
      .configure(endpoint.id, { action: "reconnect" }, "owner-user")
      .finally(() => {
        reconnectSettled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(reconnectSettled).toBe(false);

    releaseActivation();
    await expect(activation).resolves.toMatchObject({
      status: "active",
      setup: { step: "complete" },
    });
    await expect(reconnect).resolves.toMatchObject({
      status: "verifying",
      setup: { step: "provider_setup" },
    });
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "verifying",
      setup: { step: "provider_setup" },
    });
    await service.shutdown();
  });

  it.each([undefined, "https://ingress.example"])(
    "uses a live Cloud claim after chat service startup (ingress: %s)",
    async (webhookPublicBaseUrl) => {
      const poolOrigin = "https://pool-fixture.staging.paperclip.app";
      const claimedOrigin = "https://claimed-fixture.staging.paperclip.app";
      const canonicalOrigin = vi.spyOn(cloudRuntimeIdentity, "runtimeCanonicalOrigin").mockReturnValue(null);
      let context: ReturnType<typeof createService> | undefined;
      try {
        const fixture = await seedCompany();
        context = createService(new FakeChatSdkRuntime(), fakeSlackFetch(), {
          publicBaseUrl: poolOrigin,
          webhookPublicBaseUrl,
        });
        const { service } = context;
        const endpoints = [];
        for (const provider of ["slack", "github", "microsoft-teams", "telegram"] as const) {
          endpoints.push(await service.create(fixture.companyId, {
            provider,
            assignedAgentId: fixture.assignedAgentId,
          }, "owner-user"));
        }
        expect(endpoints[0].setup.webhookUrl).toBe(
          `${webhookPublicBaseUrl ?? poolOrigin}/api/chat-webhooks/${endpoints[0].publicId}/slack`,
        );

        // The warm process is already serving; applying a signed claim changes
        // the trusted identity provider without constructing another service.
        canonicalOrigin.mockReturnValue(claimedOrigin);
        for (const endpoint of endpoints) {
          const updated = await service.get(endpoint.id);
          const callback = `${webhookPublicBaseUrl ?? claimedOrigin}/api/chat-webhooks/${endpoint.publicId}/${endpoint.provider}`;
          expect(updated.setup).toMatchObject(endpoint.provider === "microsoft-teams"
            ? { messagingEndpoint: callback }
            : { webhookUrl: callback });
          const [principal] = await db.insert(chatExternalPrincipals).values({
            companyId: fixture.companyId,
            provider: endpoint.provider,
            providerAccountId: "",
            externalId: randomUUID(),
            kind: "user",
            isBot: false,
          }).returning();
          const intent = await service.createLinkIntent(endpoint.id, principal.id, 1800);
          expect(intent.confirmationUrl).toMatch(
            /^https:\/\/claimed-fixture\.staging\.paperclip\.app\/chat-identity\/confirm\?token=/,
          );
        }
        const fresh = await service.create(fixture.companyId, {
          provider: "slack",
          assignedAgentId: fixture.assignedAgentId,
        }, "owner-user");
        expect(fresh.setup.webhookUrl).toBe(
          `${webhookPublicBaseUrl ?? claimedOrigin}/api/chat-webhooks/${fresh.publicId}/slack`,
        );
      } finally {
        try {
          await context?.service.shutdown();
        } finally {
          canonicalOrigin.mockRestore();
        }
      }
    },
  );

  it.each([undefined, "https://ingress.example"])(
    "registers provider callbacks after a live Cloud claim (ingress: %s)",
    async (webhookPublicBaseUrl) => {
      const poolOrigin = "https://pool-fixture.staging.paperclip.app";
      const claimedOrigin = "https://claimed-fixture.staging.paperclip.app";
      const canonicalOrigin = vi.spyOn(cloudRuntimeIdentity, "runtimeCanonicalOrigin").mockReturnValue(null);
      let telegram: ReturnType<typeof createService> | undefined;
      let github: Awaited<ReturnType<typeof configuredGitHubEndpoint>> | undefined;
      try {
        const fixture = await seedCompany();
        const telegramRequests: Array<Record<string, unknown>> = [];
        const telegramFetch = fakeTelegramFetch();
        telegram = createService(new FakeChatSdkRuntime(), (async (input, init) => {
          if (String(input).endsWith("/setWebhook")) {
            telegramRequests.push(JSON.parse(String(init?.body)));
          }
          return telegramFetch(input);
        }) as typeof globalThis.fetch, { publicBaseUrl: poolOrigin, webhookPublicBaseUrl });
        const endpoint = await telegram.service.create(fixture.companyId, {
          provider: "telegram",
          assignedAgentId: fixture.assignedAgentId,
        }, "owner-user");
        github = await configuredGitHubEndpoint(fixture, { publicBaseUrl: poolOrigin, webhookPublicBaseUrl });
        expect(github.webhookSyncRequests).toHaveLength(0);

        canonicalOrigin.mockReturnValue(claimedOrigin);
        await telegram.service.configure(endpoint.id, {
          action: "configure",
          credentials: { botToken: "123456:telegram-cloud-claim-test" },
        }, "owner-user");
        expect(telegramRequests).toEqual([expect.objectContaining({
          url: `${webhookPublicBaseUrl ?? claimedOrigin}/api/chat-webhooks/${endpoint.publicId}/telegram`,
        })]);
        await github.service.configure(github.endpoint.id, { action: "reconnect" }, "owner-user");
        expect(github.webhookSyncRequests).toEqual([expect.objectContaining({
          url: `${webhookPublicBaseUrl ?? claimedOrigin}/api/chat-webhooks/${github.endpoint.publicId}/github`,
        })]);
      } finally {
        try {
          await Promise.all([telegram?.service.shutdown(), github?.service.shutdown()]);
        } finally {
          canonicalOrigin.mockRestore();
        }
      }
    },
  );

  it("separates verified webhook ingress from board identity links for every webhook provider", async () => {
    const fixture = await seedCompany();
    for (const publicBaseUrl of [
      null,
      "http://127.0.0.1:3103",
      "https://board.example",
    ]) {
      const { service } = createService(
        new FakeChatSdkRuntime(),
        fakeSlackFetch(),
        {
          publicBaseUrl,
          webhookPublicBaseUrl: "https://ingress.example",
        },
      );
      for (const provider of [
        "slack",
        "github",
        "microsoft-teams",
        "telegram",
      ] as const) {
        const endpoint = await service.create(
          fixture.companyId,
          {
            provider,
            assignedAgentId: fixture.assignedAgentId,
          },
          "owner-user",
        );
        const callback = `https://ingress.example/api/chat-webhooks/${endpoint.publicId}/${provider}`;
        expect(endpoint.setup).toMatchObject(
          provider === "microsoft-teams"
            ? { messagingEndpoint: callback }
            : { webhookUrl: callback },
        );
        const [principal] = await db
          .insert(chatExternalPrincipals)
          .values({
            companyId: fixture.companyId,
            provider,
            providerAccountId: "",
            externalId: randomUUID(),
            kind: "user",
            isBot: false,
          })
          .returning();
        const intent = await service.createLinkIntent(
          endpoint.id,
          principal.id,
          1800,
        );
        expect(intent.confirmationUrl).toMatch(
          new RegExp(
            `^${publicBaseUrl ? publicBaseUrl.replaceAll(".", "\\.") : ""}/chat-identity/confirm\\?token=`,
          ),
        );
        expect(intent.confirmationUrl).not.toContain("ingress.example");
      }
      await service.shutdown();
    }
  });

  it("paginates mixed activity beyond 100 rows without losing timestamp ties", async () => {
    const fixture = await seedCompany();
    const { service } = createService(new FakeChatSdkRuntime(), fakeSlackFetch());
    const endpoint = await service.create(fixture.companyId, { provider: "slack", assignedAgentId: fixture.assignedAgentId }, "owner-user");
    const other = await service.create(fixture.companyId, { provider: "slack", assignedAgentId: fixture.assignedAgentId }, "owner-user");
    const createdAt = new Date("2026-01-01T00:00:00.123Z");
    const deliveries = await db.insert(chatDeliveries).values(Array.from({ length: 110 }, (_, index) => ({
      companyId: fixture.companyId, endpointId: endpoint.id,
      providerEventId: `page-${index}`, deduplicationKey: `page-${index}`,
      eventKind: "message" as const, normalizedEvent: {}, state: "processed" as const, createdAt,
    }))).returning();
    const actions = await db.insert(chatActions).values(Array.from({ length: 15 }, (_, index) => ({
      companyId: fixture.companyId, endpointId: endpoint.id,
      kind: "slack_session_sync", providerActionId: `page-${index}`,
      // Activity for session actions follows updatedAt, not createdAt.
      createdAt: new Date("2025-01-01T00:00:00Z"), updatedAt: createdAt,
    }))).returning();
    await db.insert(chatActions).values({ companyId: fixture.companyId, endpointId: other.id, kind: "slash_task_start", providerActionId: "other-endpoint", createdAt });
    const expected = [...deliveries, ...actions].map((row) => row.id).sort((a, b) => b.localeCompare(a));
    const found: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const result = await service.listActivityPage(endpoint.id, 25, cursor);
      expect(result.items).toHaveLength(25);
      found.push(...result.items.map((row) => row.id));
      expect(Boolean(result.nextCursor)).toBe(page < 4);
      cursor = result.nextCursor ?? undefined;
      if (page === 0) {
        // New arrivals must not shift the older pages.
        await db.insert(chatActions).values({ companyId: fixture.companyId, endpointId: endpoint.id, kind: "slash_task_start", providerActionId: "new-arrival", createdAt: new Date("2026-01-02T00:00:00Z") });
      }
    }
    expect(found).toEqual(expected);
    expect(await service.listActivity(endpoint.id)).toHaveLength(100);
    await expect(service.listActivityPage(endpoint.id, 0)).rejects.toMatchObject({ status: 400 });
    await expect(service.listActivityPage(endpoint.id, 101)).rejects.toMatchObject({ status: 400 });
    await expect(service.listActivityPage(endpoint.id, 25, "invalid")).rejects.toMatchObject({ status: 400 });
  });

  it("recognizes Slack callbacks behind TLS termination without trusting forwarded headers", async () => {
    const fixture = await seedCompany();
    const { endpoint, service } = await configuredSlackEndpoint(fixture);
    const path = `/api/chat-webhooks/${endpoint.publicId}/slack`;
    const body = JSON.stringify({ type: "url_verification", challenge: "proxy-check" });
    const request = signedSlackWebhookRequest({ url: `http://paperclip.example${path}`, contentType: "application/json", body });
    request.headers.set("x-forwarded-host", "untrusted.example");
    request.headers.set("x-paperclip-cloud-forwarded-host", "untrusted.example");
    request.headers.set("x-paperclip-cloud-forwarded-proto", "https");
    request.headers.set("x-forwarded-proto", "https");
    await service.handleWebhook(endpoint.publicId, "slack", request);
    await expect(service.get(endpoint.id)).resolves.toMatchObject({ setup: { callbacksNeedUpdate: false, callbackSurfaces: { events: { status: "current" } } } });
    // A different public host or port is still drift, even with TLS termination.
    for (const publicBaseUrl of ["https://moved.example", "https://paperclip.example:8443"]) {
      const moved = createService(new FakeChatSdkRuntime(), fakeSlackFetch(), { publicBaseUrl });
      await expect(moved.service.get(endpoint.id)).resolves.toMatchObject({ setup: { callbacksNeedUpdate: true, callbackSurfaces: { events: { status: "stale" } } } });
      await moved.service.shutdown();
    }
  });

  it("records the public Cloud proxy host for authenticated Slack callback health", async () => {
    const fixture = await seedCompany();
    const { endpoint, service } = await configuredSlackEndpoint(fixture);
    const canonicalOrigin = vi.spyOn(cloudRuntimeIdentity, "runtimeCanonicalOrigin").mockReturnValue("https://paperclip.example");
    const path = `/api/chat-webhooks/${endpoint.publicId}/slack`;
    const cases = [
      ["events", "application/json", JSON.stringify({ type: "url_verification", challenge: "cloud-proxy-check" })],
      ["interactivity", "application/x-www-form-urlencoded", new URLSearchParams({ payload: JSON.stringify({ type: "block_actions", team: { id: "T-PAPERCLIP" } }) }).toString()],
      ["slashCommands", "application/x-www-form-urlencoded", new URLSearchParams({ command: "/maya-paperclip", team_id: "T-PAPERCLIP" }).toString()],
    ] as const;
    try {
      for (const prefix of ["x-forwarded", "x-paperclip-cloud-forwarded"]) {
        for (const [surface, contentType, body] of cases) {
          const request = signedSlackWebhookRequest({ url: `http://tenant.internal:3100${path}`, contentType, body });
          request.headers.set("x-forwarded-host", "tenant.up.railway.app");
          request.headers.set(`${prefix}-host`, "paperclip.example");
          request.headers.set(`${prefix}-proto`, "https");
          expect((await service.handleWebhook(endpoint.publicId, "slack", request)).ok).toBe(true);
          await expect(service.get(endpoint.id)).resolves.toMatchObject({ setup: {
            callbacksNeedUpdate: false, callbackSurfaces: { [surface]: { status: "current" } },
          } });
          // The proxy hint is evidence, not a rewrite to the adapter request.
          expect(request.url).toBe(`http://tenant.internal:3100${path}`);
        }
      }
      canonicalOrigin.mockReturnValue("https://moved.example");
      await expect(service.get(endpoint.id)).resolves.toMatchObject({ setup: {
        callbacksNeedUpdate: true, callbackSurfaces: { events: { status: "stale" }, interactivity: { status: "stale" }, slashCommands: { status: "stale" } },
      } });
    } finally {
      await service.shutdown();
      canonicalOrigin.mockRestore();
    }
  });

  it("does not let rejected callbacks or malformed proxy hints establish healthy Slack callbacks", async () => {
    const fixture = await seedCompany();
    const { endpoint, runtime, service } = await configuredSlackEndpoint(fixture);
    const providerRuntime = runtime.endpoints.get(endpoint.id)!;
    const canonicalOrigin = vi.spyOn(cloudRuntimeIdentity, "runtimeCanonicalOrigin").mockReturnValue("https://paperclip.example");
    const path = `/api/chat-webhooks/${endpoint.publicId}/slack`;
    const body = JSON.stringify({ type: "url_verification", challenge: "proxy-hint-check" });
    const send = async (host: string, protocol = "https", signed = true) => {
      const request = signedSlackWebhookRequest({ url: `http://tenant.internal:3100${path}`, contentType: "application/json", body });
      request.headers.set("x-paperclip-cloud-forwarded-host", host);
      request.headers.set("x-paperclip-cloud-forwarded-proto", protocol);
      if (!signed) request.headers.delete("x-slack-signature");
      // The fake provider runtime supplies the adapter's authentication result.
      providerRuntime.webhookResponse = new Response(signed ? "accepted" : "rejected", { status: signed ? 202 : 401 });
      return service.handleWebhook(endpoint.publicId, "slack", request);
    };
    try {
      // A real callback on an old public hostname must still warn.
      await send("old.example");
      await expect(service.get(endpoint.id)).resolves.toMatchObject({ setup: { callbacksNeedUpdate: true } });
      expect((await send("paperclip.example", "https", false)).status).toBe(401);
      await expect(service.get(endpoint.id)).resolves.toMatchObject({ setup: { callbacksNeedUpdate: true } });
      for (const host of ["paperclip.example, proxy.example", "paperclip.example/path", "user@paperclip.example", "paperclip.example?query=1", "paperclip.example#fragment", "paperclip.example:8443"]) {
        await send(host);
        await expect(service.get(endpoint.id)).resolves.toMatchObject({ setup: { callbacksNeedUpdate: true } });
      }
      await send("paperclip.example", "javascript");
      await expect(service.get(endpoint.id)).resolves.toMatchObject({ setup: { callbacksNeedUpdate: true } });
      await send("paperclip.example");
      await expect(service.get(endpoint.id)).resolves.toMatchObject({ setup: { callbacksNeedUpdate: false } });
      for (const host of ["paperclip.example:443", "PAPERCLIP.EXAMPLE:443", "paperclip.example.", "paperclip.example.:443"]) {
        await send(host);
        await expect(service.get(endpoint.id)).resolves.toMatchObject({ setup: { callbacksNeedUpdate: false } });
      }
    } finally {
      await service.shutdown();
      canonicalOrigin.mockRestore();
    }
  });

  it("tracks Slack callback surfaces independently and reports public URL drift", async () => {
    const fixture = await seedCompany();
    const { endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture);
    const webhookUrl = `https://paperclip.example/api/chat-webhooks/${endpoint.publicId}/slack`;

    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      setup: {
        callbacksNeedUpdate: false,
        callbackSurfaces: {
          events: { status: "current", observedAt: expect.any(String) },
          interactivity: { status: "unverified" },
          slashCommands: { status: "unverified" },
        },
      },
    });

    const interactiveBody = new URLSearchParams({
      payload: JSON.stringify({
        type: "block_actions",
        team: { id: "T-PAPERCLIP" },
      }),
    }).toString();
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected Slack runtime");
    providerRuntime.webhookResponse = new Response("rejected", { status: 401 });
    await service.handleWebhook(
      endpoint.publicId,
      "slack",
      signedSlackWebhookRequest({
        url: webhookUrl,
        contentType: "application/x-www-form-urlencoded",
        body: interactiveBody,
      }),
    );
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      setup: {
        callbackSurfaces: { interactivity: { status: "unverified" } },
      },
    });

    providerRuntime.webhookResponse = new Response("accepted", { status: 202 });
    await service.handleWebhook(
      endpoint.publicId,
      "slack",
      signedSlackWebhookRequest({
        url: webhookUrl,
        contentType: "application/x-www-form-urlencoded",
        body: interactiveBody,
      }),
    );

    const slashBody = new URLSearchParams({
      command: "/maya-paperclip",
      team_id: "T-PAPERCLIP",
    }).toString();
    await service.handleWebhook(
      endpoint.publicId,
      "slack",
      signedSlackWebhookRequest({
        url: webhookUrl,
        contentType: "application/x-www-form-urlencoded",
        body: slashBody,
      }),
    );

    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      setup: {
        callbacksNeedUpdate: false,
        callbackSurfaces: {
          events: { status: "current" },
          interactivity: { status: "current", observedAt: expect.any(String) },
          slashCommands: {
            status: "current",
            observedAt: expect.any(String),
          },
        },
      },
    });

    const boardOnlyMove = createService(
      new FakeChatSdkRuntime(),
      fakeSlackFetch(),
      {
        publicBaseUrl: "https://board-moved.example",
        webhookPublicBaseUrl: "https://paperclip.example",
      },
    );
    await expect(boardOnlyMove.service.get(endpoint.id)).resolves.toMatchObject(
      {
        setup: {
          webhookUrl,
          callbacksNeedUpdate: false,
          callbackSurfaces: {
            events: { status: "current" },
            interactivity: { status: "current" },
            slashCommands: { status: "current" },
          },
        },
      },
    );
    await boardOnlyMove.service.shutdown();

    const rotated = createService(new FakeChatSdkRuntime(), fakeSlackFetch(), {
      publicBaseUrl: "https://rotated.example",
    });
    await expect(rotated.service.get(endpoint.id)).resolves.toMatchObject({
      setup: {
        webhookUrl: `https://rotated.example/api/chat-webhooks/${endpoint.publicId}/slack`,
        callbacksNeedUpdate: true,
        callbackSurfaces: {
          events: { status: "stale" },
          interactivity: { status: "stale" },
          slashCommands: { status: "stale" },
        },
      },
    });
  });

  it("does not let an obsolete Slack signing secret verify a reconnected configuration", async () => {
    const fixture = await seedCompany();
    const { endpoint, service } = await configuredSlackEndpoint(fixture);
    await service.configure(endpoint.id, { action: "reconnect", credentials: {
      botToken: "xoxb-test-token", signingSecret: "replacement-signing-secret",
    } }, "owner-user");
    const response = await service.handleWebhook(endpoint.publicId, "slack", signedSlackWebhookRequest({
      url: endpoint.setup.webhookUrl!, contentType: "application/json",
      body: JSON.stringify({ type: "url_verification", challenge: "old-secret-challenge" }),
    }));
    expect(response.status).toBe(401);
    expect((await service.get(endpoint.id)).setup.webhookVerifiedAt).toBeNull();
  });

  it("requires a successful final response for setup qualification", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service } =
      await configuredSlackEndpoint(fixture);
    const testThread = makeThread({
      channelId: "C-SETUP-FAILED",
      id: "slack:C-SETUP-FAILED:9001.1",
      name: "setup-failed",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: testThread.thread,
      message: makeMessage({
        id: "9001.1",
        text: "@maya verify a failed setup turn",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: testThread.thread,
      message: makeMessage({
        id: "9001.2",
        text: "Setup follow-up",
      }),
      trigger: "subscribed_message",
    });
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    if (!conversation) throw new Error("Expected setup conversation");

    for (const progressState of ["queued", "working"] as const) {
      await db.insert(chatPublications).values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: conversation.id,
        issueId: conversation.issueId,
        idempotencyKey: `setup-transport:${progressState}:${endpoint.id}`,
        payload: {
          text: `Maya is ${progressState}.`,
          progressState,
        },
        state: "pending",
      });
      await service.processPendingPublications();
      await expect(service.test(endpoint.id)).rejects.toMatchObject({
        status: 409,
        details: { code: "chat_test_round_trip_incomplete" },
      });
    }

    await db.insert(chatPublications).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      conversationId: conversation.id,
      issueId: conversation.issueId,
      idempotencyKey: `setup-transport:failed:${endpoint.id}`,
      payload: {
        text: "Maya stopped before completing this turn.",
        progressState: "failed",
      },
      state: "pending",
    });
    await service.processPendingPublications();

    await expect(service.test(endpoint.id)).rejects.toMatchObject({
      status: 409,
      details: { code: "chat_test_round_trip_incomplete" },
    });

    const contextSnapshot = await chatWakeContext({
      endpointId: endpoint.id,
      issueId: conversation.issueId,
      provider: "slack",
      providerMessageId: "9001.2",
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: fixture.companyId,
      agentId: endpoint.assignedAgentId,
      status: "succeeded",
      contextSnapshot,
    });
    await addSelectedChatFinal({
      agentId: endpoint.assignedAgentId,
      body: "Setup completed successfully.",
      companyId: fixture.companyId,
      issueId: conversation.issueId,
      runId,
    });
    await service.processPendingPublications();

    await expect(service.test(endpoint.id)).resolves.toMatchObject({
      status: "active",
      setup: { step: "complete" },
    });
  });

  it("requires the successful setup final to consume the qualifying follow-up", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service } =
      await configuredSlackEndpoint(fixture);
    const testThread = makeThread({
      channelId: "C-SETUP-RUN-PROVENANCE",
      id: "slack:C-SETUP-RUN-PROVENANCE:9002.1",
      name: "setup-run-provenance",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: testThread.thread,
      message: makeMessage({
        id: "9002.1",
        text: "@maya begin a deliberately slow setup answer",
        mentioned: true,
      }),
      trigger: "mention",
    });
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    if (!conversation) throw new Error("Expected setup conversation");

    const rootContext = await chatWakeContext({
      endpointId: endpoint.id,
      issueId: conversation.issueId,
      provider: "slack",
      providerMessageId: "9002.1",
    });
    const rootRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: rootRunId,
      companyId: fixture.companyId,
      agentId: endpoint.assignedAgentId,
      status: "succeeded",
      contextSnapshot: rootContext,
    });
    await addSelectedChatFinal({
      agentId: endpoint.assignedAgentId,
      body: "The earlier root turn finished after the follow-up arrived.",
      companyId: fixture.companyId,
      issueId: conversation.issueId,
      runId: rootRunId,
    });

    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: testThread.thread,
      message: makeMessage({
        id: "9002.2",
        text: "This is the required setup follow-up.",
      }),
      trigger: "subscribed_message",
    });
    // Publish the older root run only after the follow-up has been accepted.
    // Timestamp ordering alone must not make that unrelated final qualify.
    await service.processPendingPublications();
    await expect(service.test(endpoint.id)).rejects.toMatchObject({
      status: 409,
      details: { code: "chat_test_round_trip_incomplete" },
    });

    const followUpContext = await chatWakeContext({
      endpointId: endpoint.id,
      issueId: conversation.issueId,
      provider: "slack",
      providerMessageId: "9002.2",
    });
    const followUpRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: followUpRunId,
      companyId: fixture.companyId,
      agentId: endpoint.assignedAgentId,
      status: "succeeded",
      contextSnapshot: {
        issueId: followUpContext.issueId,
        source: followUpContext.source,
        // Deferred wakeups may coalesce several accepted messages and retain
        // only the durable list of causal comment ids.
        wakeCommentIds: [followUpContext.wakeCommentId],
      },
    });
    await addSelectedChatFinal({
      agentId: endpoint.assignedAgentId,
      body: "The qualifying follow-up was handled successfully.",
      companyId: fixture.companyId,
      issueId: conversation.issueId,
      runId: followUpRunId,
    });
    await service.processPendingPublications();

    await expect(service.test(endpoint.id)).resolves.toMatchObject({
      status: "active",
      setup: { step: "complete" },
    });
    await service.shutdown();
  });
});
