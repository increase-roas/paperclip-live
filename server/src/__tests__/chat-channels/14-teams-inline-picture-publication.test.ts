import { randomUUID } from "node:crypto";
import sharp, {  } from "sharp";
import { and, asc, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { chatDeliveries, chatEndpointResources, chatEndpoints, chatExternalPrincipals, chatIdentityLinks, chatTeamsFileTransfers, companyMemberships, heartbeatRuns, issueAttachments, issueComments, issues } from "@paperclipai/db";
import { createChatSdkEndpointRuntime } from "../../services/chat-sdk-runtime.js";
import { issueService } from "../../services/issues.js";
import { FakeChatSdkRuntime, makeMessage, makeThread } from ".././helpers/chat-channels-fixture.js";
import { addSelectedChatFinal, chatWakeContext, configuredSlackEndpoint, configuredTeamsEndpoint, configuredTelegramEndpoint, createService, createStorageService, db, deliverMessage, describeChatChannelsSuite, qualifySetupRoundTrip, readChatConversationsByEndpointId, readChatDeliveriesByEndpointId, readChatPublicationsById, retirePublicationFixture, seedCompany } from "../helpers/chat-channels-harness.js";






describeChatChannelsSuite("chat channels 14-teams-inline-picture-publication", () => {
  it("uses the Teams group-chat toggle without weakening channel resource gates", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service } =
      await configuredTeamsEndpoint(fixture);
    await db
      .update(chatEndpoints)
      .set({ status: "active" })
      .where(eq(chatEndpoints.id, endpoint.id));
    await service.update(endpoint.id, { allowGroupChats: false }, "owner-user");

    const serviceUrl = "https://smba.trafficmanager.net/amer/";
    const groupConversationId = "19:teams-group-reach@unq.gbl.spaces";
    await db.insert(chatEndpointResources).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      type: "group_chat",
      providerResourceId: groupConversationId,
      label: "Launch group",
      availability: "available",
      enabled: false,
    });
    const groupThread = makeThread({
      channelId: `teams:${Buffer.from(groupConversationId).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
      id: `teams:${Buffer.from(groupConversationId).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
      name: "Launch group",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: groupThread.thread,
      message: makeMessage({
        id: "teams-group-disabled",
        text: "@maya do not start yet",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await expect(service.listConversations(endpoint.id)).resolves.toHaveLength(
      0,
    );

    await service.update(endpoint.id, { allowGroupChats: true }, "owner-user");
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: groupThread.thread,
      message: makeMessage({
        id: "teams-group-enabled",
        text: "@maya start the group task",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await expect(service.listConversations(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        externalConversationId: groupThread.thread.channelId,
        isDirectMessage: false,
      }),
    ]);
    await expect(service.listResources(endpoint.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerResourceId: groupConversationId,
          type: "group_chat",
          enabled: false,
          availability: "available",
        }),
      ]),
    );

    const channelConversationId = "19:teams-channel-reach@thread.tacv2";
    const channelRootId = "1740000000101";
    const [channelResource] = await db
      .insert(chatEndpointResources)
      .values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        type: "channel",
        providerResourceId: channelConversationId,
        label: "Engineering",
        availability: "available",
        enabled: false,
      })
      .returning();
    const channelThread = makeThread({
      channelId: `teams:${Buffer.from(channelConversationId).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
      id: `teams:${Buffer.from(`${channelConversationId};messageid=${channelRootId}`).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
      name: "Engineering",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: channelThread.thread,
      message: makeMessage({
        id: channelRootId,
        text: "@maya channel still requires enablement",
        mentioned: true,
        userId: "U-TEAMS-DISABLED-CHANNEL",
        userName: "disabled-channel-user",
      }),
      trigger: "mention",
    });
    await expect(service.listConversations(endpoint.id)).resolves.toHaveLength(
      1,
    );
    const disabledChannelDelivery = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(
            chatDeliveries.providerEventId,
            `teams:${Buffer.from(`${channelConversationId};messageid=${channelRootId}`).toString("base64url")}:${channelRootId}`,
          ),
        ),
      )
      .then((rows) => rows[0] ?? null);
    expect(disabledChannelDelivery).toMatchObject({
      state: "filtered",
      attempts: 0,
      principalId: null,
      normalizedEvent: {
        filtering: { contentRetained: false },
        message: { providerMessageId: channelRootId },
      },
    });
    expect(
      JSON.stringify(disabledChannelDelivery?.normalizedEvent),
    ).not.toContain("channel still requires enablement");
    await expect(
      db
        .select({ id: chatExternalPrincipals.id })
        .from(chatExternalPrincipals)
        .where(
          and(
            eq(chatExternalPrincipals.companyId, fixture.companyId),
            eq(chatExternalPrincipals.provider, "microsoft-teams"),
            eq(chatExternalPrincipals.externalId, "U-TEAMS-DISABLED-CHANNEL"),
          ),
        ),
    ).resolves.toHaveLength(0);

    await service.replaceResources(endpoint.id, [
      { id: channelResource!.id, enabled: true },
    ]);
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: channelThread.thread,
      message: makeMessage({
        id: `${channelRootId}-enabled`,
        text: "@maya channel is enabled now",
        mentioned: true,
        userId: "U-TEAMS-DISABLED-CHANNEL",
        userName: "disabled-channel-user",
      }),
      trigger: "mention",
    });
    await expect(service.listConversations(endpoint.id)).resolves.toHaveLength(
      2,
    );
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: channelThread.thread,
      message: makeMessage({
        id: `${channelRootId}-reply`,
        text: "continue the now-authorized Teams task",
        userId: "U-TEAMS-DISABLED-CHANNEL",
        userName: "disabled-channel-user",
      }),
      trigger: "subscribed_message",
    });
    const channelConversation = (
      await service.listConversations(endpoint.id)
    ).find(
      (conversation) =>
        conversation.externalThreadId === channelThread.thread.id,
    );
    if (!channelConversation)
      throw new Error("Expected enabled Teams channel conversation");
    await expect(
      db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, channelConversation.issueId))
        .orderBy(asc(issueComments.createdAt), asc(issueComments.id)),
    ).resolves.toEqual([
      { body: "@maya channel is enabled now" },
      { body: "continue the now-authorized Teams task" },
    ]);
    await expect(
      db
        .select({ id: chatExternalPrincipals.id })
        .from(chatExternalPrincipals)
        .where(
          and(
            eq(chatExternalPrincipals.companyId, fixture.companyId),
            eq(chatExternalPrincipals.provider, "microsoft-teams"),
            eq(chatExternalPrincipals.externalId, "U-TEAMS-DISABLED-CHANNEL"),
          ),
        ),
    ).resolves.toHaveLength(1);
  });

  it("atomically rejects Teams messages when DM, group, or channel reach is revoked at the task-mutation boundary", async () => {
    const serviceUrl = "https://smba.trafficmanager.net/amer/";
    const scenarios = [
      { kind: "direct_message" as const, label: "direct" },
      { kind: "group_chat" as const, label: "group" },
      { kind: "channel" as const, label: "channel" },
    ];

    for (const scenario of scenarios) {
      const fixture = await seedCompany();
      let releaseReachCheck!: () => void;
      let signalReachCheck!: () => void;
      const reachCheckEntered = new Promise<void>((resolve) => {
        signalReachCheck = resolve;
      });
      const reachCheckReleased = new Promise<void>((resolve) => {
        releaseReachCheck = resolve;
      });
      const { callbacks, endpoint, service, wakeup } =
        await configuredTeamsEndpoint(fixture, {
          reachAuthorizationBarrier: async () => {
            signalReachCheck();
            await reachCheckReleased;
          },
        });

      const conversationId =
        scenario.kind === "group_chat"
          ? `19:teams-revoke-${scenario.label}@unq.gbl.spaces`
          : scenario.kind === "channel"
            ? `19:teams-revoke-${scenario.label}@thread.tacv2`
            : `teams-revoke-${scenario.label}`;
      const rootMessageId = `teams-revoke-${scenario.label}-message`;
      const encodedConversationId =
        Buffer.from(conversationId).toString("base64url");
      const encodedServiceUrl = Buffer.from(serviceUrl).toString("base64url");
      const thread = makeThread({
        channelId:
          scenario.kind === "direct_message"
            ? conversationId
            : `teams:${encodedConversationId}:${encodedServiceUrl}`,
        id:
          scenario.kind === "channel"
            ? `teams:${Buffer.from(`${conversationId};messageid=${rootMessageId}`).toString("base64url")}:${encodedServiceUrl}`
            : scenario.kind === "group_chat"
              ? `teams:${encodedConversationId}:${encodedServiceUrl}`
              : `teams:${conversationId}`,
        isDM: scenario.kind === "direct_message",
        name: `Revoked ${scenario.label}`,
      });
      const durableThreadId =
        scenario.kind === "channel"
          ? `teams:${Buffer.from(`${conversationId};messageid=${rootMessageId}`).toString("base64url")}`
          : scenario.kind === "group_chat"
            ? `teams:${encodedConversationId}`
            : thread.thread.id;
      let resourceId: string | null = null;
      if (scenario.kind !== "direct_message") {
        const [resource] = await db
          .insert(chatEndpointResources)
          .values({
            companyId: fixture.companyId,
            endpointId: endpoint.id,
            type: scenario.kind,
            providerResourceId: conversationId,
            label: `Revoked ${scenario.label}`,
            availability: "available",
            enabled: true,
          })
          .returning({ id: chatEndpointResources.id });
        resourceId = resource!.id;
      }
      if (scenario.kind === "group_chat") {
        await service.update(
          endpoint.id,
          { allowGroupChats: true },
          "owner-user",
        );
      }

      const externalPrincipalId = randomUUID();
      const secretText = `must-not-persist-${scenario.label}`;
      const send = deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider: "microsoft-teams",
        thread: thread.thread,
        message: makeMessage({
          id: rootMessageId,
          raw: { from: { aadObjectId: externalPrincipalId } },
          text: `@maya ${secretText}`,
          mentioned: scenario.kind !== "direct_message",
          userId: `29:teams-revoke-${scenario.label}`,
        }),
        trigger:
          scenario.kind === "direct_message" ? "direct_message" : "mention",
      });

      await reachCheckEntered;
      if (scenario.kind === "direct_message") {
        await service.update(
          endpoint.id,
          { allowDirectMessages: false },
          "owner-user",
        );
      } else if (scenario.kind === "group_chat") {
        await service.update(
          endpoint.id,
          { allowGroupChats: false },
          "owner-user",
        );
      } else {
        await service.replaceResources(endpoint.id, [
          { id: resourceId!, enabled: false },
        ]);
      }
      releaseReachCheck();
      await send;

      await expect(service.listConversations(endpoint.id)).resolves.toEqual([]);
      await expect(
        db
          .select({ id: issues.id })
          .from(issues)
          .where(eq(issues.companyId, fixture.companyId)),
      ).resolves.toEqual([]);
      const [delivery] = await db
        .select({
          state: chatDeliveries.state,
          normalizedEvent: chatDeliveries.normalizedEvent,
          principalId: chatDeliveries.principalId,
          redactedError: chatDeliveries.redactedError,
        })
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(
              chatDeliveries.providerEventId,
              `${durableThreadId}:${rootMessageId}`,
            ),
          ),
        );
      expect(delivery).toMatchObject({
        state: "filtered",
        principalId: null,
        redactedError: "Destination is not enabled in Paperclip",
        normalizedEvent: {
          filtering: { contentRetained: false },
          message: { providerMessageId: rootMessageId },
        },
      });
      expect(JSON.stringify(delivery?.normalizedEvent)).not.toContain(
        secretText,
      );
      expect(JSON.stringify(delivery?.normalizedEvent)).not.toContain(
        externalPrincipalId,
      );
      await expect(
        db
          .select({ id: chatExternalPrincipals.id })
          .from(chatExternalPrincipals)
          .where(
            and(
              eq(chatExternalPrincipals.companyId, fixture.companyId),
              eq(chatExternalPrincipals.provider, "microsoft-teams"),
              eq(chatExternalPrincipals.externalId, externalPrincipalId),
            ),
          ),
      ).resolves.toEqual([]);
      expect(wakeup).not.toHaveBeenCalled();
    }
  });

  it("atomically rejects a Slack DM when reach is revoked after initial admission", async () => {
    const fixture = await seedCompany();
    let releaseReachCheck!: () => void;
    let signalReachCheck!: () => void;
    const reachCheckEntered = new Promise<void>((resolve) => {
      signalReachCheck = resolve;
    });
    const reachCheckReleased = new Promise<void>((resolve) => {
      releaseReachCheck = resolve;
    });
    const { callbacks, endpoint, service, wakeup } =
      await configuredSlackEndpoint(fixture, {
        allowUnlinkedPeople: true,
        reachAuthorizationBarrier: async () => {
          signalReachCheck();
          await reachCheckReleased;
        },
      });
    const thread = makeThread({
      channelId: "slack:D-REVOKED-REACH",
      id: "slack:D-REVOKED-REACH",
      isDM: true,
      name: "Revoked Slack DM",
    });
    const messageId = "slack-revoked-reach-message";
    const externalPrincipalId = "U-SLACK-REVOKED-REACH";
    const secretText = "must-not-persist-slack-race";
    const send = deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: thread.thread,
      message: makeMessage({
        id: messageId,
        text: secretText,
        userId: externalPrincipalId,
      }),
      trigger: "direct_message",
    });

    await reachCheckEntered;
    await service.update(
      endpoint.id,
      { allowDirectMessages: false },
      "owner-user",
    );
    releaseReachCheck();
    await send;

    await expect(service.listConversations(endpoint.id)).resolves.toEqual([]);
    await expect(
      db
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.companyId, fixture.companyId)),
    ).resolves.toEqual([]);
    const [delivery] = await db
      .select({
        state: chatDeliveries.state,
        normalizedEvent: chatDeliveries.normalizedEvent,
        principalId: chatDeliveries.principalId,
        redactedError: chatDeliveries.redactedError,
      })
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(
            chatDeliveries.providerEventId,
            `${thread.thread.id}:${messageId}`,
          ),
        ),
      );
    expect(delivery).toMatchObject({
      state: "filtered",
      principalId: null,
      redactedError: "Destination is not enabled in Paperclip",
      normalizedEvent: {
        filtering: { contentRetained: false },
        message: { providerMessageId: messageId },
      },
    });
    expect(JSON.stringify(delivery?.normalizedEvent)).not.toContain(secretText);
    expect(JSON.stringify(delivery?.normalizedEvent)).not.toContain(
      externalPrincipalId,
    );
    await expect(
      db
        .select({ id: chatExternalPrincipals.id })
        .from(chatExternalPrincipals)
        .where(
          and(
            eq(chatExternalPrincipals.companyId, fixture.companyId),
            eq(chatExternalPrincipals.provider, "slack"),
            eq(chatExternalPrincipals.externalId, externalPrincipalId),
          ),
        ),
    ).resolves.toEqual([]);
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("atomically rejects Slack task mutation after a linked identity is revoked or loses write membership", async () => {
    for (const authorizationChange of ["link_revoked", "viewer"] as const) {
      const fixture = await seedCompany();
      let releaseAuthorizationCheck!: () => void;
      let signalAuthorizationCheck!: () => void;
      const authorizationCheckEntered = new Promise<void>((resolve) => {
        signalAuthorizationCheck = resolve;
      });
      const authorizationCheckReleased = new Promise<void>((resolve) => {
        releaseAuthorizationCheck = resolve;
      });
      const { callbacks, endpoint, service, wakeup } =
        await configuredSlackEndpoint(fixture, {
          allowUnlinkedPeople: false,
          reachAuthorizationBarrier: async () => {
            signalAuthorizationCheck();
            await authorizationCheckReleased;
          },
        });
      const currentEndpoint = await service.get(endpoint.id);
      if (!currentEndpoint.providerAccountId) {
        throw new Error("Expected configured Slack account identity");
      }
      const externalPrincipalId = `U-SLACK-AUTH-${authorizationChange}`;
      const [principal] = await db
        .insert(chatExternalPrincipals)
        .values({
          companyId: fixture.companyId,
          provider: "slack",
          providerAccountId: currentEndpoint.providerAccountId,
          externalId: externalPrincipalId,
          kind: "user",
          displayName: "Linked Slack User",
          handle: "linked-slack-user",
          isBot: false,
        })
        .returning();
      await db.insert(chatIdentityLinks).values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        principalId: principal.id,
        paperclipUserId: "owner-user",
        status: "linked",
        confirmedAt: new Date(),
      });
      const thread = makeThread({
        channelId: `D-SLACK-AUTH-${authorizationChange}`,
        id: `slack:D-SLACK-AUTH-${authorizationChange}`,
        isDM: true,
        name: "Slack authorization race",
      });
      const messageId = `slack-auth-${authorizationChange}`;
      const secretText = `must-not-persist-${authorizationChange}`;
      const send = deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        thread: thread.thread,
        message: makeMessage({
          id: messageId,
          text: secretText,
          userId: externalPrincipalId,
        }),
        trigger: "direct_message",
      });

      await authorizationCheckEntered;
      if (authorizationChange === "link_revoked") {
        await db
          .update(chatIdentityLinks)
          .set({
            paperclipUserId: null,
            status: "revoked",
            revokedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(chatIdentityLinks.principalId, principal.id));
      } else {
        await db
          .update(companyMemberships)
          .set({ membershipRole: "viewer", updatedAt: new Date() })
          .where(
            and(
              eq(companyMemberships.companyId, fixture.companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.principalId, "owner-user"),
            ),
          );
      }
      releaseAuthorizationCheck();
      await send;

      await expect(service.listConversations(endpoint.id)).resolves.toEqual([]);
      await expect(
        db
          .select({ id: issues.id })
          .from(issues)
          .where(eq(issues.companyId, fixture.companyId)),
      ).resolves.toEqual([]);
      const [delivery] = await db
        .select({
          normalizedEvent: chatDeliveries.normalizedEvent,
          principalId: chatDeliveries.principalId,
          redactedError: chatDeliveries.redactedError,
          state: chatDeliveries.state,
        })
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(
              chatDeliveries.providerEventId,
              `${thread.thread.id}:${messageId}`,
            ),
          ),
        );
      expect(delivery).toMatchObject({
        principalId: null,
        state: "filtered",
        redactedError:
          authorizationChange === "viewer"
            ? "Linked Paperclip account is not currently permitted"
            : "External identity must be linked to a Paperclip account",
        normalizedEvent: {
          filtering: { contentRetained: false },
          message: { providerMessageId: messageId },
        },
      });
      expect(JSON.stringify(delivery?.normalizedEvent)).not.toContain(
        secretText,
      );
      expect(wakeup).not.toHaveBeenCalled();
    }
  });

  it("atomically rejects a sponsored Telegram guest after the sponsor is suspended", async () => {
    const fixture = await seedCompany();
    let releaseAuthorizationCheck!: () => void;
    let signalAuthorizationCheck!: () => void;
    const authorizationCheckEntered = new Promise<void>((resolve) => {
      signalAuthorizationCheck = resolve;
    });
    const authorizationCheckReleased = new Promise<void>((resolve) => {
      releaseAuthorizationCheck = resolve;
    });
    const { callbacks, endpoint, service, wakeup } =
      await configuredTelegramEndpoint(fixture, {
        reachAuthorizationBarrier: async () => {
          signalAuthorizationCheck();
          await authorizationCheckReleased;
        },
      });
    const chatId = "77118898";
    const thread = makeThread({
      channelId: `telegram:${chatId}`,
      id: `telegram:${chatId}`,
      isDM: true,
      name: "Suspended sponsor race",
    });
    const messageId = `${chatId}:93`;
    const secretText = "must-not-persist-suspended-sponsor";
    const send = deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: thread.thread,
      message: makeMessage({
        id: messageId,
        text: secretText,
        userId: chatId,
      }),
      trigger: "direct_message",
    });

    await authorizationCheckEntered;
    await db
      .update(companyMemberships)
      .set({ status: "suspended", updatedAt: new Date() })
      .where(
        and(
          eq(companyMemberships.companyId, fixture.companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, "owner-user"),
        ),
      );
    releaseAuthorizationCheck();
    await send;

    await expect(service.listConversations(endpoint.id)).resolves.toEqual([]);
    await expect(
      db
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.companyId, fixture.companyId)),
    ).resolves.toEqual([]);
    const [delivery] = await db
      .select({
        normalizedEvent: chatDeliveries.normalizedEvent,
        principalId: chatDeliveries.principalId,
        redactedError: chatDeliveries.redactedError,
        state: chatDeliveries.state,
      })
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(
            chatDeliveries.providerEventId,
            `${thread.thread.id}:${messageId}`,
          ),
        ),
      );
    expect(delivery).toMatchObject({
      principalId: null,
      state: "filtered",
      redactedError: "Endpoint sponsor can no longer authorize external guests",
      normalizedEvent: {
        filtering: { contentRetained: false },
        message: { providerMessageId: messageId },
      },
    });
    expect(JSON.stringify(delivery?.normalizedEvent)).not.toContain(secretText);
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("atomically rejects a Telegram DM when reach is revoked at the final task-mutation boundary", async () => {
    const fixture = await seedCompany();
    let releaseReachCheck!: () => void;
    let signalReachCheck!: () => void;
    const reachCheckEntered = new Promise<void>((resolve) => {
      signalReachCheck = resolve;
    });
    const reachCheckReleased = new Promise<void>((resolve) => {
      releaseReachCheck = resolve;
    });
    const { callbacks, endpoint, service, wakeup } =
      await configuredTelegramEndpoint(fixture, {
        reachAuthorizationBarrier: async () => {
          signalReachCheck();
          await reachCheckReleased;
        },
      });
    const chatId = "77118899";
    const thread = makeThread({
      channelId: `telegram:${chatId}`,
      id: `telegram:${chatId}`,
      isDM: true,
      name: "Revoked Telegram DM",
    });
    const messageId = `${chatId}:92`;
    const secretText = "must-not-persist-telegram-race";
    const send = deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: thread.thread,
      message: makeMessage({
        id: messageId,
        text: secretText,
        userId: chatId,
      }),
      trigger: "direct_message",
    });

    await reachCheckEntered;
    await service.update(
      endpoint.id,
      { allowDirectMessages: false },
      "owner-user",
    );
    releaseReachCheck();
    await send;

    await expect(service.listConversations(endpoint.id)).resolves.toEqual([]);
    await expect(
      db
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.companyId, fixture.companyId)),
    ).resolves.toEqual([]);
    const [delivery] = await db
      .select({
        state: chatDeliveries.state,
        normalizedEvent: chatDeliveries.normalizedEvent,
        principalId: chatDeliveries.principalId,
        redactedError: chatDeliveries.redactedError,
      })
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(
            chatDeliveries.providerEventId,
            `${thread.thread.id}:${messageId}`,
          ),
        ),
      );
    expect(delivery).toMatchObject({
      state: "filtered",
      principalId: null,
      redactedError: "Destination is not enabled in Paperclip",
      normalizedEvent: {
        filtering: { contentRetained: false },
        message: { providerMessageId: messageId },
      },
    });
    expect(JSON.stringify(delivery?.normalizedEvent)).not.toContain(secretText);
    await expect(
      db
        .select({ id: chatExternalPrincipals.id })
        .from(chatExternalPrincipals)
        .where(
          and(
            eq(chatExternalPrincipals.companyId, fixture.companyId),
            eq(chatExternalPrincipals.provider, "telegram"),
            eq(chatExternalPrincipals.externalId, chatId),
          ),
        ),
    ).resolves.toEqual([]);
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("audits Microsoft Teams reactions idempotently without treating them as task instructions", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service, wakeup } =
      await configuredTeamsEndpoint(fixture);
    const aadObjectId = "860def28-0dab-44ae-b8cf-30e168181a15";
    const serviceUrl = "https://smba.trafficmanager.net/amer/";
    const thread = makeThread({
      channelId: "teams-personal-reactions",
      id: "teams:personal-reactions:root-1",
      isDM: true,
      name: "Teams personal reactions",
    });
    const original = makeMessage({
      id: "teams-reaction-root",
      raw: { from: { aadObjectId } },
      text: "Observe Teams reactions",
      userId: "29:teams-reaction-session",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: thread.thread,
      message: original,
      trigger: "direct_message",
    });
    await qualifySetupRoundTrip(service, endpoint.id, original.author.userId);
    await service.test(endpoint.id);
    if (!callbacks.onReaction)
      throw new Error("Teams reaction callback was not registered");
    const endpointRuntime = runtime.endpoints.get(endpoint.id);
    if (!endpointRuntime) throw new Error("Expected Teams endpoint runtime");
    const initialRouteCount =
      endpointRuntime.recordedMicrosoftTeamsRoutes.length;
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    const commentCount = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.issueId, conversation!.issueId))
      .then((rows) => rows.length);
    const wakeupCount = wakeup.mock.calls.length;
    const emoji = {
      name: "thumbs_up",
      toJSON: () => "like",
      toString: () => "like",
    };
    const reaction = (
      added: boolean,
      activityId: string,
      reactionThread = thread.thread,
    ) => ({
      endpointId: endpoint.id,
      provider: "microsoft-teams" as const,
      event: {
        adapter: {} as never,
        added,
        emoji,
        message: original,
        messageId: original.id,
        raw: { id: activityId, serviceUrl, from: { aadObjectId } },
        rawEmoji: "like",
        thread: reactionThread,
        threadId: reactionThread.id,
        user: original.author,
      },
    });

    const unknownThread = makeThread({
      channelId: "teams-personal-reactions-unknown",
      id: "teams:personal-reactions:unknown-root",
      isDM: true,
      name: "Unknown Teams personal reactions",
    });
    await callbacks.onReaction(
      reaction(true, "teams-reaction-denied", unknownThread.thread),
    );
    expect(endpointRuntime.recordedMicrosoftTeamsRoutes).toHaveLength(
      initialRouteCount,
    );

    await callbacks.onReaction(reaction(true, "teams-reaction-1"));
    await callbacks.onReaction(reaction(true, "teams-reaction-1"));
    await callbacks.onReaction(reaction(false, "teams-reaction-2"));

    const reactions = await db
      .select()
      .from(chatDeliveries)
      .where(eq(chatDeliveries.conversationId, conversation!.id))
      .then((rows) =>
        rows.filter((row) => row.eventKind.startsWith("reaction_")),
      );
    expect(reactions).toHaveLength(2);
    expect(reactions.map((row) => row.eventKind).sort()).toEqual([
      "reaction_added",
      "reaction_removed",
    ]);
    expect(reactions.every((row) => row.principalId !== null)).toBe(true);
    expect(
      await db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(eq(issueComments.issueId, conversation!.issueId))
        .then((rows) => rows.length),
    ).toBe(commentCount);
    expect(wakeup).toHaveBeenCalledTimes(wakeupCount);
    expect(endpointRuntime.recordedMicrosoftTeamsRoutes.length).toBeGreaterThan(
      initialRouteCount,
    );
    expect(
      (await service.listActivity(endpoint.id)).filter((item) =>
        item.summary.startsWith("reaction "),
      ),
    ).toHaveLength(2);
  });

  it("keeps case-variant Teams Entra object ids on one external principal", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint } = await configuredTeamsEndpoint(fixture);
    const aadObjectId = "76d0cb17-5ec4-4b3d-983b-da8a01dc02c4";
    const thread = makeThread({
      channelId: "teams-personal-identity",
      id: "teams:personal-identity:root-1",
      isDM: true,
      name: "Alex External",
    });

    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: thread.thread,
      message: makeMessage({
        id: "teams-identity-root",
        raw: { from: { aadObjectId: aadObjectId.toUpperCase() } },
        text: "Start a Teams identity task",
        userId: "29:adapter-session-one",
      }),
      trigger: "direct_message",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: thread.thread,
      message: makeMessage({
        id: "teams-identity-follow-up",
        raw: { from: { aadObjectId } },
        text: "Continue from another adapter session",
        userId: "29:adapter-session-two",
      }),
      trigger: "direct_message",
    });

    const principals = await db
      .select({ externalId: chatExternalPrincipals.externalId })
      .from(chatExternalPrincipals)
      .where(
        and(
          eq(chatExternalPrincipals.companyId, fixture.companyId),
          eq(chatExternalPrincipals.provider, "microsoft-teams"),
        ),
      );
    expect(principals).toEqual([{ externalId: aadObjectId }]);
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    await expect(
      db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, conversation!.issueId)),
    ).resolves.toEqual(
      expect.arrayContaining([
        { body: "Start a Teams identity task" },
        { body: "Continue from another adapter session" },
      ]),
    );
  });

  describe("Teams inline picture publication", () => {
    it.each([
      { surface: "channel", outcome: "native" },
      { surface: "group", outcome: "native" },
      { surface: "channel", outcome: "native_http" },
      { surface: "group", outcome: "native_http" },
      { surface: "channel", outcome: "long_native_http" },
      { surface: "channel", outcome: "malformed" },
      { surface: "channel", outcome: "too_large" },
      { surface: "channel", outcome: "dimensions" },
      { surface: "channel", outcome: "source_deleted" },
      { surface: "group", outcome: "reach_revoked" },
      { surface: "channel", outcome: "lost_receipt" },
      { surface: "channel", outcome: "empty_receipt" },
    ] as const)(
      "keeps $surface picture delivery truthful for $outcome",
      async ({ surface, outcome }) => {
        const fixture = await seedCompany();
        const storage = createStorageService();
        const { callbacks, endpoint, runtime, service } =
          await configuredTeamsEndpoint(fixture, { storage: storage.storage });
        let pinned: ReturnType<typeof createChatSdkEndpointRuntime> | undefined;
        try {
          if (surface === "group") {
            await service.update(
              endpoint.id,
              { allowGroupChats: true },
              "owner-user",
            );
          }
          const serviceUrl = "https://smba.trafficmanager.net/amer/";
          const conversationId = `19:inline-picture-${surface}-${randomUUID()}@thread.${surface === "channel" ? "tacv2" : "v2"}`;
          const rootId = "1740000000491";
          const providerThread = makeThread({
            channelId: `teams:${Buffer.from(conversationId).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
            id: `teams:${Buffer.from(surface === "channel" ? `${conversationId};messageid=${rootId}` : conversationId).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
            name: "Teams picture qualification",
          });
          await deliverMessage({
            callbacks,
            endpointId: endpoint.id,
            provider: "microsoft-teams",
            thread: providerThread.thread,
            message: makeMessage({
              id: rootId,
              text: "@Maya inspect pictures here",
              mentioned: true,
            }),
            trigger: "mention",
          });
          const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
          expect(conversation).toBeDefined();
          const body =
            outcome === "malformed"
              ? Buffer.from("not a PNG")
              : outcome === "too_large"
                ? Buffer.alloc(1_000_001)
                : await sharp({
                    create: {
                      width: outcome === "dimensions" ? 1025 : 2,
                      height: 2,
                      channels: 4,
                      background: { r: 50, g: 100, b: 150, alpha: 1 },
                    },
                  })
                    .png()
                    .toBuffer();
          const stored = await storage.storage.putFile({
            companyId: fixture.companyId,
            namespace: `issues/${conversation!.issueId}`,
            originalFilename: "teams-picture.png",
            contentType: "image/png",
            body,
          });
          const attachment = await issueService(db).createAttachment({
            issueId: conversation!.issueId,
            ...stored,
            createdByUserId: "owner-user",
          });
          await service.processPendingPublications();
          const providerRuntime = runtime.endpoints.get(endpoint.id)!;
          const httpBodies: Array<{ url: string; body: unknown }> = [];
          const boardText =
            outcome === "long_native_http"
              ? "x".repeat(99_996) + "TAIL"
              : "Share this picture.";
          if (outcome === "native_http" || outcome === "long_native_http") {
            pinned = createChatSdkEndpointRuntime({
              ...runtime.configurations.get(endpoint.id)!,
              logger: "silent",
              callbacks: { onMessage() {} },
            });
            await pinned.initialize();
            const app = (
              pinned.getProviderAdapter() as unknown as {
                app: {
                  activitySender: {
                    client: {
                      post(
                        url: string,
                        body: unknown,
                      ): Promise<{ data: unknown }>;
                    };
                  };
                };
              }
            ).app;
            vi.spyOn(app.activitySender.client, "post").mockImplementation(
              async (url, body) => {
                httpBodies.push({ url, body });
                return {
                  data: { id: `teams-http-receipt-${httpBodies.length}` },
                };
              },
            );
          }
          const originalThread = providerRuntime.thread.bind(providerRuntime);
          let pictureAttempts = 0;
          let textSent = false;
          vi.spyOn(providerRuntime, "thread").mockImplementation((id) => {
            const target = originalThread(id);
            return {
              ...target,
              post: async (message: unknown) => {
                const sent = await target.post(message);
                const hasFiles = Boolean(
                  message && typeof message === "object" && "files" in message,
                );
                if (hasFiles) {
                  pictureAttempts++;
                  if (outcome === "lost_receipt")
                    throw new Error(
                      "Simulated picture response lost after acceptance",
                    );
                  if (outcome === "empty_receipt") return { ...sent, id: "" };
                } else if (!textSent) {
                  textSent = true;
                  // Mutate after the Board text's provider effect, before the
                  // separately ordered picture row claims its own authority.
                  if (outcome === "source_deleted") {
                    await db
                      .delete(issueAttachments)
                      .where(eq(issueAttachments.id, attachment.id));
                  }
                  if (outcome === "reach_revoked") {
                    await db
                      .update(chatEndpointResources)
                      .set({ availability: "unavailable" })
                      .where(
                        eq(chatEndpointResources.id, conversation!.resourceId!),
                      );
                  }
                }
                return pinned
                  ? await pinned
                      .thread(id)
                      .post(
                        message as Parameters<
                          ReturnType<typeof pinned.thread>["post"]
                        >[0],
                      )
                  : sent;
              },
            };
          });
          const result = await service.publishBoardMessage(
            endpoint.id,
            conversation!.id,
            boardText,
            `teams-inline-picture-${surface}`,
            "owner-user",
            [attachment.id],
          );
          const denied = ["source_deleted", "reach_revoked"].includes(outcome);
          const ambiguous = ["lost_receipt", "empty_receipt"].includes(outcome);
          const fallback = ["malformed", "too_large", "dimensions"].includes(
            outcome,
          );
          if (denied) expect(["failed", "cancelled"]).toContain(result.state);
          else
            expect(result.state).toBe(
              ambiguous ? "delivery_unknown" : "published",
            );
          const imagePosts = (
            runtime.endpoints.get(endpoint.id)?.posts ?? []
          ).filter((post) => post.files?.length);
          expect(imagePosts).toHaveLength(denied || fallback ? 0 : 1);
          if (!denied && !fallback) {
            expect(imagePosts[0]!.threadId).toBe(
              conversation!.externalThreadId,
            );
            expect(imagePosts[0]!.files).toEqual([
              {
                data: body,
                filename: "teams-picture.png",
                mimeType: "image/png",
              },
            ]);
            expect(imagePosts[0]!.text).not.toContain("isn't available");
          }
          if (fallback) {
            expect(
              providerRuntime.posts.some((post) =>
                post.text.includes("Direct file delivery isn't available"),
              ),
            ).toBe(true);
            if (outcome === "too_large")
              expect(storage.storage.getObject).not.toHaveBeenCalled();
          }
          const [publication] = await readChatPublicationsById(result.id);
          if (!denied)
            expect(publication).toMatchObject({
              state: ambiguous ? "delivery_unknown" : "published",
              attempts: 1,
            });
          if (!denied && !ambiguous)
            expect(publication!.providerMessageId).toBeTruthy();
          if (outcome === "native_http" || outcome === "long_native_http") {
            if (outcome === "native_http") expect(httpBodies).toHaveLength(2);
            else {
              expect(httpBodies.length).toBeGreaterThan(2);
              expect(
                providerRuntime.posts
                  .slice(0, -1)
                  .map((post) => post.text)
                  .join(""),
              ).toBe(boardText);
              expect(providerRuntime.posts.at(-1)!.files).toHaveLength(1);
            }
            const pictureRequest = httpBodies.at(-1)!;
            expect(pictureRequest.url).toBe(
              `https://smba.trafficmanager.net/amer/v3/conversations/${surface === "channel" ? `${conversationId};messageid=${rootId}` : conversationId}/activities`,
            );
            expect(pictureRequest.body).toMatchObject({
              type: "message",
              attachments: [
                {
                  name: "teams-picture.png",
                  contentType: "image/png",
                  contentUrl: `data:image/png;base64,${body.toString("base64")}`,
                },
              ],
            });
            expect(JSON.stringify(pictureRequest.body)).not.toMatch(
              /file\.consent|teams-test-secret/,
            );
            expect(publication!.providerMessageId).toBe(
              `teams-http-receipt-${httpBodies.length}`,
            );
          }
          if (ambiguous) expect(publication!.providerMessageId).toBeNull();
          await expect(
            db
              .select()
              .from(chatTeamsFileTransfers)
              .where(eq(chatTeamsFileTransfers.endpointId, endpoint.id)),
          ).resolves.toEqual([]);
          const sentCount = runtime.endpoints.get(endpoint.id)!.posts.length;
          await service.publishBoardMessage(
            endpoint.id,
            conversation!.id,
            boardText,
            `teams-inline-picture-${surface}`,
            "owner-user",
            [attachment.id],
          );
          expect(runtime.endpoints.get(endpoint.id)!.posts).toHaveLength(
            sentCount,
          );
          await service.processPendingPublications();
          expect(providerRuntime.posts).toHaveLength(sentCount);
          expect(pictureAttempts).toBe(denied || fallback ? 0 : 1);
        } finally {
          await service.configure(
            endpoint.id,
            { action: "remove" },
            "owner-user",
          );
          await service.shutdown();
          await pinned?.shutdown();
        }
      },
    );
  });

  it("links outbound Teams files instead of attempting an unsupported native upload", async () => {
    const fixture = await seedCompany();
    const storage = createStorageService();
    const { callbacks, endpoint, runtime, service } =
      await configuredTeamsEndpoint(fixture, {
        storage: storage.storage,
      });
    const serviceUrl = "https://smba.trafficmanager.net/amer/";
    const channelConversationId = "19:teams-outbound-files@thread.tacv2";
    const channelMessageId = "1740000000291";
    const channelThread = makeThread({
      channelId: `teams:${Buffer.from(channelConversationId).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
      id: `teams:${Buffer.from(`${channelConversationId};messageid=${channelMessageId}`).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
      name: "Outbound files channel",
    });
    const personalMessageId = "teams-outbound-personal-root";
    const personalThread = makeThread({
      channelId: "teams-personal-outbound-files",
      id: "teams:personal-outbound-files:root-1",
      isDM: true,
      name: "Alex External",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: channelThread.thread,
      message: makeMessage({
        id: channelMessageId,
        text: "@Maya create a channel report",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: personalThread.thread,
      message: makeMessage({
        id: personalMessageId,
        text: "Create a personal report",
      }),
      trigger: "direct_message",
    });
    const conversations = await readChatConversationsByEndpointId(endpoint.id);
    const channelConversation = conversations.find(
      (conversation) => !conversation.isDirectMessage,
    );
    const personalConversation = conversations.find(
      (conversation) => conversation.isDirectMessage,
    );
    if (!channelConversation || !personalConversation)
      throw new Error("Expected Teams channel and personal tasks");

    for (const item of [
      {
        conversation: channelConversation,
        filename: "channel-report.txt",
        providerMessageId: channelMessageId,
        text: "Channel report ready.",
      },
      {
        conversation: personalConversation,
        filename: "personal-report.txt",
        providerMessageId: personalMessageId,
        text: "Personal report ready.",
      },
    ]) {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        status: "succeeded",
        contextSnapshot: await chatWakeContext({
          endpointId: endpoint.id,
          issueId: item.conversation.issueId,
          provider: "microsoft-teams",
          providerMessageId: item.providerMessageId,
        }),
      });
      const comment = await addSelectedChatFinal({
        agentId: fixture.assignedAgentId,
        body: item.text,
        companyId: fixture.companyId,
        issueId: item.conversation.issueId,
        runId,
      });
      const stored = await storage.storage.putFile({
        companyId: fixture.companyId,
        namespace: `issues/${item.conversation.issueId}`,
        originalFilename: item.filename,
        contentType: "text/plain",
        body: Buffer.from(`${item.filename} contents`, "utf8"),
      });
      await issueService(db).createAttachment({
        issueId: item.conversation.issueId,
        issueCommentId: comment.id,
        provider: stored.provider,
        objectKey: stored.objectKey,
        contentType: stored.contentType,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        originalFilename: stored.originalFilename,
        createdByAgentId: fixture.assignedAgentId,
        createdByRunId: runId,
      });
    }
    await service.processPendingPublications();

    const posts = runtime.endpoints.get(endpoint.id)?.posts ?? [];
    const channelAttachmentPost = posts.find((post) =>
      post.text.includes(
        "File saved on the Paperclip task: channel-report.txt.",
      ),
    );
    expect(channelAttachmentPost?.text).toContain(
      "Direct file delivery isn't available for this Teams conversation.",
    );
    expect(channelAttachmentPost?.text).toContain(
      `/issues/${channelConversation.issueId}`,
    );
    expect(channelAttachmentPost?.files).toBeUndefined();
    const personalAttachmentPost = posts.find((post) =>
      post.text.includes(
        "File saved on the Paperclip task: personal-report.txt.",
      ),
    );
    expect(personalAttachmentPost?.text).toContain(
      "Direct file delivery isn't available for this Teams conversation.",
    );
    expect(personalAttachmentPost?.text).toContain(
      `/issues/${personalConversation.issueId}`,
    );
    expect(personalAttachmentPost?.files).toBeUndefined();
    expect(storage.storage.getObject).not.toHaveBeenCalled();
  });

  describe("Teams authenticated inline-picture intake", () => {
    it.each([
      ["channel", "current"],
      ["groupChat", "current"],
      ["channel", "restart"],
      ["groupChat", "restart"],
      ["channel", "revoked_after_receipt"],
      ["groupChat", "revoked_after_receipt"],
      ["groupChat", "revoked_during_download"],
      ["groupChat", "source_updated_during_download"],
      ["groupChat", "source_deleted_during_download"],
      ["groupChat", "batch_deadline"],
    ] as const)(
      "ingests an actual pinned-parser %s picture into its exact admitted turn (%s)",
      async (conversationType, mode) => {
        const fixture = await seedCompany();
        const storage = createStorageService();
        const { callbacks, endpoint, runtime, service, wakeup } =
          await configuredTeamsEndpoint(fixture, {
            storage: storage.storage,
            deferWebhookProcessing:
              mode === "restart" || mode === "revoked_after_receipt",
            scheduleDeferredWork: () => undefined,
          });
        const configuration = runtime.configurations.get(endpoint.id)!;
        if (configuration.providerConfig.provider !== "microsoft-teams")
          throw new Error("Expected Teams configuration");
        const pinned = createChatSdkEndpointRuntime({
          ...configuration,
          logger: "silent",
        });
        const image = await sharp({
          create: { width: 2, height: 2, channels: 3, background: "#224466" },
        })
          .png()
          .toBuffer();
        const url =
          "https://smba.trafficmanager.net/amer/v3/attachments/inline-fixture/views/original";
        const http = (
          pinned.getProviderAdapter() as unknown as {
            app: {
              api: { http: { get: (...args: unknown[]) => Promise<unknown> } };
            };
          }
        ).app.api.http;
        const get = vi.spyOn(http, "get").mockResolvedValue({ data: image });
        let restarted: ReturnType<typeof createService> | undefined;
        let recoveredParser:
          ReturnType<typeof createChatSdkEndpointRuntime> | undefined;
        let recoveredGet: ReturnType<typeof vi.spyOn> | undefined;
        let lifecycleCompletion: Promise<unknown> | undefined;
        let timeoutSpy: ReturnType<typeof vi.spyOn> | undefined;
        try {
          if (conversationType === "groupChat")
            await service.update(
              endpoint.id,
              { allowGroupChats: true },
              "owner-user",
            );
          Object.assign(runtime.endpoints.get(endpoint.id)!, {
            attachmentRecoveryDescriptor:
              pinned.attachmentRecoveryDescriptor.bind(pinned),
            rehydrateAttachment: pinned.rehydrateAttachment.bind(pinned),
            fetchTeamsInlineImage: pinned.fetchTeamsInlineImage.bind(pinned),
          });
          const message = pinned.parseMicrosoftTeamsMessage({
            type: "message",
            channelId: "msteams",
            id: "1740000000771",
            timestamp: new Date().toISOString(),
            text: "Inspect this exact picture",
            serviceUrl: "https://smba.trafficmanager.net/amer/",
            from: {
              id: "29:inline-picture-user",
              aadObjectId: randomUUID(),
              name: "Picture User",
            },
            recipient: {
              id: `28:${configuration.providerConfig.credentials.appId}`,
            },
            conversation: {
              id: `19:inline-picture-${conversationType}@thread.tacv2${conversationType === "channel" ? ";messageid=1740000000771" : ""}`,
              conversationType,
              tenantId: configuration.providerConfig.credentials.appTenantId,
            },
            attachments: [
              { contentType: "image/png", contentUrl: url, name: "inline.png" },
            ],
          })!;
          expect(message.attachments[0]).toMatchObject({
            type: "image",
            mimeType: "image/png",
            fetchMetadata: { auth: "bot" },
          });
          const thread = makeThread({
            id: message.threadId,
            channelId: message.threadId,
            isDM: false,
          });
          if (mode === "batch_deadline") {
            const raw = message.raw as {
              attachments: Array<Record<string, unknown>>;
            };
            raw.attachments.push({
              contentType: "image/png",
              contentUrl: url.replace("inline-fixture", "inline-second"),
              name: "second.png",
            });
            const second =
              pinned.parseMicrosoftTeamsMessage(raw)!.attachments[1]!;
            message.attachments.push(second);
            const budget = new AbortController();
            const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
            timeoutSpy = vi
              .spyOn(AbortSignal, "timeout")
              .mockImplementation((ms) =>
                ms === 10_000 ? budget.signal : originalTimeout(ms),
              );
            get.mockImplementation(async () => {
              budget.abort();
              throw new Error("Synthetic exhausted image batch budget");
            });
          }
          if (mode === "revoked_during_download") {
            get.mockImplementation(async () => {
              await db
                .update(chatEndpoints)
                .set({ allowGroupChats: false })
                .where(eq(chatEndpoints.id, endpoint.id));
              return { data: image };
            });
          }
          if (mode.startsWith("source_")) {
            get.mockImplementation(async () => {
              const updated = pinned.parseMicrosoftTeamsMessage({
                ...(message.raw as object),
                text: "Corrected source without that image",
                attachments: [],
              })!;
              lifecycleCompletion = Promise.resolve(
                mode === "source_updated_during_download"
                  ? callbacks.onMessageUpdated!({
                      endpointId: endpoint.id,
                      provider: "microsoft-teams",
                      thread: thread.thread,
                      message: updated,
                    })
                  : callbacks.onMessageDeleted!({
                      endpointId: endpoint.id,
                      provider: "microsoft-teams",
                      event: {
                        adapter: thread.thread.adapter,
                        channelId: thread.thread.channelId,
                        platform: "teams",
                        messageId: message.id,
                        threadId: thread.thread.id,
                        raw: message.raw,
                        deletedAt: new Date(),
                      },
                    }),
              ).catch((error: unknown) => error);
              // The authenticated service callback records before waiting for
              // this turn's drain. Observe that durable pending source event.
              await vi.waitFor(async () => {
                const rows = await db
                  .select({ state: chatDeliveries.state })
                  .from(chatDeliveries)
                  .where(
                    and(
                      eq(chatDeliveries.endpointId, endpoint.id),
                      eq(
                        chatDeliveries.eventKind,
                        mode === "source_updated_during_download"
                          ? "message_updated"
                          : "message_deleted",
                      ),
                    ),
                  );
                expect(rows).toEqual([{ state: "received" }]);
              });
              return { data: image };
            });
          }
          // Actual parser + durable service. Provider HTTP, outer authenticated
          // callback delivery, and native scheduler are explicitly simulated.
          const deliver = () =>
            deliverMessage({
              callbacks,
              endpointId: endpoint.id,
              provider: "microsoft-teams",
              thread: thread.thread,
              message,
              trigger: "mention",
            });
          if (mode === "revoked_during_download")
            await expect(deliver()).rejects.toThrow(
              "no longer authorized to start work",
            );
          else if (mode.startsWith("source_"))
            await expect(deliver()).rejects.toThrow("admitted source changed");
          else await deliver();
          await lifecycleCompletion;
          if (mode === "restart" || mode === "revoked_after_receipt") {
            const [received] = await readChatDeliveriesByEndpointId(endpoint.id);
            expect(received).toMatchObject({ state: "received", attempts: 0 });
            expect(get).not.toHaveBeenCalled();
            expect(storage.putFile).not.toHaveBeenCalled();
            expect(
              JSON.stringify(received.normalizedEvent.message),
            ).not.toContain("https://");
            expect(received.normalizedEvent).toMatchObject({
              message: {
                attachments: [
                  {
                    recovery: {
                      locator: {
                        kind: "teams_inline_image",
                        messageId: message.id,
                      },
                    },
                  },
                ],
              },
            });
            await service.shutdown();
            recoveredParser = createChatSdkEndpointRuntime({
              ...configuration,
              logger: "silent",
            });
            const nextHttp = (
              recoveredParser.getProviderAdapter() as unknown as {
                app: {
                  api: { http: { get(...args: unknown[]): Promise<unknown> } };
                };
              }
            ).app.api.http;
            recoveredGet = vi
              .spyOn(nextHttp, "get")
              .mockResolvedValue({ data: image });
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
                  fetchTeamsInlineImage:
                    recoveredParser!.fetchTeamsInlineImage.bind(
                      recoveredParser,
                    ),
                });
                const originalThread = next.thread.bind(next);
                vi.spyOn(next, "thread").mockImplementation((id) => ({
                  ...originalThread(id),
                  isDM: false,
                }));
                return next;
              },
            );
            if (mode === "revoked_after_receipt") {
              if (conversationType === "groupChat")
                await db
                  .update(chatEndpoints)
                  .set({ allowGroupChats: false })
                  .where(eq(chatEndpoints.id, endpoint.id));
              else
                await db
                  .update(chatEndpointResources)
                  .set({ enabled: false })
                  .where(eq(chatEndpointResources.endpointId, endpoint.id));
              // Leave verifying mode so restart cannot legitimately activate a
              // first setup channel after this explicit operator revocation.
              await db
                .update(chatEndpoints)
                .set({ status: "active" })
                .where(eq(chatEndpoints.id, endpoint.id));
            }
            await db
              .update(chatDeliveries)
              .set({ nextAttemptAt: new Date(0) })
              .where(eq(chatDeliveries.id, received.id));
            restarted = createService(nextRuntime, undefined, {
              storage: storage.storage,
              scheduleDeferredWork: () => undefined,
            });
            await restarted.service.processPendingDeliveries(25, received.id);
            expect(get).not.toHaveBeenCalled();
          }
          const [delivery] = await db
            .select()
            .from(chatDeliveries)
            .where(
              and(
                eq(chatDeliveries.endpointId, endpoint.id),
                eq(chatDeliveries.eventKind, "mention"),
              ),
            );
          if (mode === "batch_deadline") {
            expect(delivery.state).toBe("processed");
            expect(delivery.redactedError).toContain(
              "2 external attachments were omitted",
            );
            expect(storage.putFile).not.toHaveBeenCalled();
            expect(get).toHaveBeenCalledOnce();
            expect(wakeup).toHaveBeenCalledOnce();
            await expect(
              db
                .select({ id: issueAttachments.id })
                .from(issueAttachments)
                .where(eq(issueAttachments.companyId, fixture.companyId)),
            ).resolves.toHaveLength(0);
            return;
          }
          if (mode.startsWith("revoked_") || mode.startsWith("source_")) {
            expect(storage.putFile).not.toHaveBeenCalled();
            expect(restarted?.wakeup ?? wakeup).not.toHaveBeenCalled();
            expect(delivery.state).toBe(
              mode === "revoked_after_receipt" ? "filtered" : "failed",
            );
            if (mode === "revoked_after_receipt")
              expect(recoveredGet).not.toHaveBeenCalled();
            else expect(get).toHaveBeenCalledOnce();
            await expect(
              db
                .select({ id: issueAttachments.id })
                .from(issueAttachments)
                .where(eq(issueAttachments.companyId, fixture.companyId)),
            ).resolves.toHaveLength(0);
            return;
          }
          expect({
            state: delivery.state,
            error: delivery.redactedError,
          }).toEqual({ state: "processed", error: null });
          expect(storage.putFile).toHaveBeenCalledOnce();
          expect(storage.putFile.mock.calls[0]![0]).toMatchObject({
            body: image,
            contentType: "image/png",
          });
          const download = recoveredGet ?? get;
          expect(download).toHaveBeenCalledOnce();
          expect(download.mock.calls[0]![0]).toBe(url);
          expect(restarted?.wakeup ?? wakeup).toHaveBeenCalledOnce();
          expect(delivery).toMatchObject({
            state: "processed",
            redactedError: null,
          });
          expect(
            JSON.stringify(delivery.normalizedEvent.message),
          ).not.toContain("https://");
          await expect(
            db
              .select({ id: issueAttachments.id })
              .from(issueAttachments)
              .where(eq(issueAttachments.companyId, fixture.companyId)),
          ).resolves.toHaveLength(1);
          await (restarted?.service ?? service).processPendingDeliveries(
            25,
            delivery.id,
          );
          expect(download).toHaveBeenCalledOnce();
          expect(restarted?.wakeup ?? wakeup).toHaveBeenCalledOnce();
        } finally {
          await lifecycleCompletion;
          timeoutSpy?.mockRestore();
          get.mockRestore();
          recoveredGet?.mockRestore();
          try {
            await pinned.shutdown();
          } finally {
            try {
              await recoveredParser?.shutdown();
            } finally {
              try {
                await restarted?.service.shutdown();
              } finally {
                await retirePublicationFixture(service, endpoint.id);
              }
            }
          }
        }
      },
    );
  });
});
