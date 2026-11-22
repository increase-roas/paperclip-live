import {
  createHash,
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
  issueAttachments,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  createChatSdkEndpointRuntime,
} from "../../services/chat-sdk-runtime.js";
import {
  heartbeatService,
} from "../../services/heartbeat.js";
import {
  GITHUB_ATTACHMENT_BATCH_TIMEOUT_MS,
  githubPublicAttachmentsFromMessage,
} from "../../services/chat-github-attachments.js";
import {

} from "../../services/remote-http-fetch.js";
import {
  logger as chatAttachmentLogger,
} from "../../middleware/logger.js";
import {
  FakeChatSdkRuntime,
  FakeEndpointRuntime,
  fakeSlackFetch,
  makeMessage,
  makeThread,
} from ".././helpers/chat-channels-fixture.js";
import {
  configuredSlackEndpoint,
  configuredTeamsEndpoint,
  createService,
  createStorageService,
  db,
  deliverMessage,
  describeChatChannelsSuite,
  readAgentWakeupRequestsById,
  readChatConversationsByEndpointId,
  readChatDeliveriesByEndpointId,
  readChatDeliveriesById,
  readHeartbeatRunsByCompanyId,
  recordSlackUrlVerification,
  retirePublicationFixture,
  seedCompany,
  configuredGitHubEndpoint,
} from "../helpers/chat-channels-harness.js";
import type { Attachment, Thread } from "chat";
import * as attachmentEgress from "../../services/remote-http-fetch.js";

describeChatChannelsSuite("chat channels 15-ingests-teams-files-only-from-personal-c", () => {
  it("ingests Teams files only from personal chats and keeps non-DM references link-only", async () => {
    const fixture = await seedCompany();
    const storage = createStorageService();
    const { callbacks, endpoint } = await configuredTeamsEndpoint(
      fixture,
      { storage: storage.storage },
    );
    const serviceUrl = "https://smba.trafficmanager.net/amer/";
    const fileBody = Buffer.from("teams personal file", "utf8");
    const channelFetch = vi.fn(async () => fileBody);
    const personalFetch = vi.fn(async () => fileBody);

    const channelConversationId = "19:teams-file-channel@thread.tacv2";
    const channelRootId = "1740000000191";
    const channelThread = makeThread({
      channelId: `teams:${Buffer.from(channelConversationId).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
      id: `teams:${Buffer.from(`${channelConversationId};messageid=${channelRootId}`).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
      name: "Files channel",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: channelThread.thread,
      message: makeMessage({
        attachments: [
          {
            type: "file",
            name: "channel-plan.txt",
            mimeType: "text/plain",
            size: fileBody.length,
            fetchData: channelFetch,
            fetchMetadata: { testRecoveryKey: "teams-channel-file" },
          } as Attachment,
        ],
        id: channelRootId,
        text: "",
        mentioned: true,
      }),
      trigger: "mention",
    });
    expect(channelFetch).not.toHaveBeenCalled();
    expect(storage.putFile).not.toHaveBeenCalled();

    const personalConversationId = "a:teams-file-personal";
    const personalThread = makeThread({
      channelId: `teams:${Buffer.from(personalConversationId).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}:personal`,
      id: `teams:${Buffer.from(personalConversationId).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}:personal`,
      isDM: true,
      name: "Personal files",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: personalThread.thread,
      message: makeMessage({
        attachments: [
          {
            type: "file",
            name: "personal-plan.txt",
            mimeType: "text/plain",
            size: fileBody.length,
            fetchData: personalFetch,
            fetchMetadata: { testRecoveryKey: "teams-personal-file" },
          } as Attachment,
        ],
        id: "teams-personal-file-message",
        text: "",
      }),
      trigger: "direct_message",
    });

    expect(personalFetch).toHaveBeenCalledTimes(1);
    expect(storage.putFile).toHaveBeenCalledTimes(1);
    const deliveries = await readChatDeliveriesByEndpointId(endpoint.id);
    const channelDelivery = deliveries.find(
      (delivery) =>
        delivery.providerEventId ===
        `teams:${Buffer.from(`${channelConversationId};messageid=${channelRootId}`).toString("base64url")}:${channelRootId}`,
    );
    const personalDelivery = deliveries.find((delivery) =>
      delivery.providerEventId.endsWith(":teams-personal-file-message"),
    );
    expect(channelDelivery?.normalizedEvent).toMatchObject({
      message: {
        attachments: [
          expect.objectContaining({
            name: "channel-plan.txt",
            recovery: null,
          }),
        ],
      },
    });
    expect(personalDelivery?.normalizedEvent).toMatchObject({
      message: {
        attachments: [
          expect.objectContaining({
            name: "personal-plan.txt",
            recovery: expect.objectContaining({
              provider: "microsoft-teams",
            }),
          }),
        ],
      },
    });
    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .innerJoin(
        chatConversations,
        eq(chatConversations.issueId, issueComments.issueId),
      )
      .where(eq(chatConversations.endpointId, endpoint.id));
    expect(comments).toEqual(
      expect.arrayContaining([
        {
          body: "Shared 1 Microsoft Teams file reference.",
        },
        { body: "Shared 1 file." },
      ]),
    );
    await expect(
      db
        .select({ id: issueAttachments.id })
        .from(issueAttachments)
        .where(eq(issueAttachments.companyId, fixture.companyId)),
    ).resolves.toHaveLength(1);
  });

  it.each(["captioned", "file_only"] as const)(
    "preserves a Teams personal %s attachment omission after losing its live download closure",
    async (mode) => {
      const fixture = await seedCompany();
      const storage = createStorageService();
      const first = await configuredTeamsEndpoint(fixture, {
        storage: storage.storage,
        deferWebhookProcessing: true,
        scheduleDeferredWork: () => undefined,
      });
      const { endpoint } = first;
      const configuration = first.runtime.configurations.get(endpoint.id)!;
      const pinned = createChatSdkEndpointRuntime({
        ...configuration,
        callbacks: { onMessage() {} },
        logger: "silent",
      });
      const sourceUrl =
        "https://contoso.sharepoint.com/download?signature=never-persist-this";
      const caption =
        mode === "captioned" ? "Inspect only this exact new file" : "";
      const parsed = pinned.parseMicrosoftTeamsMessage({
        id: `teams-personal-unavailable-${mode}`,
        type: "message",
        text: caption,
        timestamp: new Date().toISOString(),
        serviceUrl: "https://smba.trafficmanager.net/amer/",
        from: { id: "29:personal-file-user", name: "Personal File User" },
        conversation: {
          id: `a:personal-unavailable-${mode}`,
          conversationType: "personal",
          tenantId:
            configuration.providerConfig.provider === "microsoft-teams"
              ? configuration.providerConfig.credentials.appTenantId
              : undefined,
        },
        attachments: [
          {
            contentType: "application/vnd.microsoft.teams.file.download.info",
            contentUrl:
              "https://contoso.sharepoint.com/Documents/current-plan.txt",
            name: "current-plan.txt",
            content: {
              downloadUrl: sourceUrl,
              fileType: "txt",
              uniqueId: "current-file",
            },
          },
        ],
      });
      expect(parsed?.attachments).toHaveLength(1);
      expect(parsed!.attachments[0]!.mimeType).toBe("text/plain");
      expect(
        pinned.attachmentRecoveryDescriptor(parsed!.attachments[0]!),
      ).toBeNull();
      const fetchData = vi.fn(async () => {
        throw new Error("Live closure must not survive restart");
      });
      parsed!.attachments[0]!.fetchData = fetchData;
      const descriptor = vi
        .spyOn(
          first.runtime.endpoints.get(endpoint.id)!,
          "attachmentRecoveryDescriptor",
        )
        .mockImplementation((attachment) => {
          expect(pinned.attachmentRecoveryDescriptor(attachment)).toBeNull();
          return null;
        });
      const sourceThread = makeThread({
        id: parsed!.threadId,
        channelId: parsed!.threadId,
        isDM: true,
        name: "Personal attachment recovery",
      });
      let restarted: ReturnType<typeof createService> | undefined;
      try {
        await deliverMessage({
          callbacks: first.callbacks,
          endpointId: endpoint.id,
          provider: "microsoft-teams",
          thread: sourceThread.thread,
          message: parsed!,
          trigger: "direct_message",
        });
        const [received] = await readChatDeliveriesByEndpointId(endpoint.id);
        expect(received).toMatchObject({ state: "received", attempts: 0 });
        expect(received!.normalizedEvent).toMatchObject({
          message: {
            attachments: [
              {
                name: "current-plan.txt",
                mimeType: "text/plain",
                recovery: null,
              },
            ],
          },
        });
        expect(JSON.stringify(received!.normalizedEvent)).not.toMatch(
          /signature|never-persist-this|downloadUrl|sharepoint/,
        );
        expect(first.wakeup).not.toHaveBeenCalled();
        await first.service.shutdown();
        // The fixture restarts after the provider reorder window, without
        // changing the receipt, source metadata, or recovery descriptor.
        await db
          .update(chatDeliveries)
          .set({ nextAttemptAt: new Date(0) })
          .where(eq(chatDeliveries.id, received!.id));
        const nextRuntime = new FakeChatSdkRuntime();
        const replace = nextRuntime.replaceEndpoint.bind(nextRuntime);
        vi.spyOn(nextRuntime, "replaceEndpoint").mockImplementation(
          async (options) => {
            const runtime = await replace(options);
            const thread = runtime.thread.bind(runtime);
            vi.spyOn(runtime, "thread").mockImplementation((threadId) => ({
              ...thread(threadId),
              // Use the real adapter's personal/channel classification after restart.
              isDM: pinned.getProviderAdapter().isDM!(threadId),
            }));
            return runtime;
          },
        );
        restarted = createService(nextRuntime, undefined, {
          storage: storage.storage,
          scheduleDeferredWork: () => undefined,
        });
        await restarted.service.processPendingDeliveries();
        const [processed] = await readChatDeliveriesById(received!.id);
        expect(processed).toMatchObject({
          state: "processed",
          redactedError:
            "1 external attachment was omitted (download unavailable: 1)",
        });
        const [link] = await db
          .select()
          .from(chatMessageLinks)
          .where(
            and(
              eq(chatMessageLinks.deliveryId, received!.id),
              eq(chatMessageLinks.direction, "inbound"),
            ),
          );
        const [comment] = await db
          .select()
          .from(issueComments)
          .where(eq(issueComments.id, link!.commentId!));
        expect(comment!.body).toBe(caption || "Shared 1 file.");
        expect(restarted.wakeup).toHaveBeenCalledTimes(1);
        expect(
          restarted.wakeup.mock.calls[0]![1].contextSnapshot,
        ).toMatchObject({
          wakeCommentId: comment!.id,
          externalAttachmentOmissions: [
            { commentId: comment!.id, reasons: { download_unavailable: 1 } },
          ],
        });
        const [intent] = await db
          .select()
          .from(chatActions)
          .where(
            and(
              eq(chatActions.deliveryId, received!.id),
              eq(chatActions.kind, "inbound_wakeup"),
            ),
          );
        expect(intent!.payload).toMatchObject({
          attachmentOmissionReasons: { download_unavailable: 1 },
        });
        await restarted.service.processPendingDeliveries();
        expect(restarted.wakeup).toHaveBeenCalledTimes(1);
        expect(fetchData).not.toHaveBeenCalled();
        expect(storage.putFile).not.toHaveBeenCalled();
        expect(
          await db
            .select({ id: issueAttachments.id })
            .from(issueAttachments)
            .where(eq(issueAttachments.companyId, fixture.companyId)),
        ).toEqual([]);
      } finally {
        descriptor.mockRestore();
        await first.service.shutdown();
        await pinned.shutdown();
        await retirePublicationFixture(
          restarted?.service ?? first.service,
          endpoint.id,
        );
      }
    },
  );

  it.each([
    { surface: "channel", mode: "immediate" },
    { surface: "channel", mode: "deferred" },
    { surface: "channel", mode: "restart" },
    { surface: "channel", mode: "retry_restart" },
    { surface: "group", mode: "immediate" },
    { surface: "group", mode: "deferred" },
    { surface: "group", mode: "restart" },
    { surface: "group", mode: "retry_restart" },
  ] as const)(
    "preserves unavailable Teams $surface file references through $mode admission",
    async ({ surface, mode }) => {
      const fixture = await seedCompany();
      const storage = createStorageService();
      const context = await configuredTeamsEndpoint(fixture, {
        storage: storage.storage,
        deferWebhookProcessing:
          mode !== "immediate" && mode !== "retry_restart",
        scheduleDeferredWork: () => undefined,
      });
      const { callbacks, endpoint, service } = context;
      const serviceUrl = "https://smba.trafficmanager.net/amer/";
      const conversationId = `19:teams-unavailable-${surface}-${mode}@thread.${surface === "channel" ? "tacv2" : "v2"}`;
      const rootId = "1740000000391";
      const thread = makeThread({
        channelId: `teams:${Buffer.from(conversationId).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
        id: `teams:${Buffer.from(`${conversationId}${surface === "channel" ? `;messageid=${rootId}` : ""}`).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
        name: "Unavailable current files",
      });
      const fetchData = vi.fn(async () => Buffer.from("must not download"));
      const providerUrl =
        "https://private.example/file?signature=do-not-persist";
      const attachments = [
        {
          type: "image",
          name: "../current-photo.png",
          mimeType: "image/png",
          size: 128,
          url: providerUrl,
          fetchData,
          fetchMetadata: { authorization: "do-not-persist" },
        },
        {
          type: "file",
          name: "current-plan.txt",
          mimeType: "text/plain; charset=utf-8",
          size: 32,
          url: providerUrl,
          fetchData,
        },
      ] as Attachment[];
      let active = context;
      let restarted: ReturnType<typeof createService> | undefined;
      try {
        if (surface === "group") {
          await service.update(
            endpoint.id,
            { allowGroupChats: true },
            "owner-user",
          );
        }
        await db.insert(chatEndpointResources).values({
          companyId: fixture.companyId,
          endpointId: endpoint.id,
          type: surface === "channel" ? "channel" : "group_chat",
          providerResourceId: conversationId,
          label: "Unavailable current files",
          availability: "available",
          enabled: true,
        });
        for (const [index, text] of [
          "Inspect this current image and file",
          "",
        ].entries()) {
          if (mode === "retry_restart" && index === 0) {
            thread.subscribe.mockRejectedValueOnce(
              new Error("subscription unavailable"),
            );
          }
          const deliveryAttempt = deliverMessage({
            callbacks:
              index === 0
                ? callbacks
                : active.runtime.configurations.get(endpoint.id)!.callbacks,
            endpointId: endpoint.id,
            provider: "microsoft-teams",
            thread: thread.thread,
            message: makeMessage({
              id: String(Number(rootId) + index),
              text,
              mentioned: true,
              attachments,
            }),
            trigger: "mention",
          });
          if (mode === "retry_restart" && index === 0) {
            await expect(deliveryAttempt).rejects.toThrow(
              "subscription unavailable",
            );
          } else {
            await deliveryAttempt;
          }
          const [delivery] = await db
            .select()
            .from(chatDeliveries)
            .where(
              and(
                eq(chatDeliveries.endpointId, endpoint.id),
                like(
                  chatDeliveries.providerEventId,
                  `%:${Number(rootId) + index}`,
                ),
              ),
            );
          expect(delivery).toBeDefined();
          expect(delivery!.normalizedEvent).toMatchObject({
            message: {
              attachments: [
                {
                  name: "current-photo.png",
                  mimeType: "image/png",
                  size: 128,
                  recovery: null,
                },
                {
                  name: "current-plan.txt",
                  mimeType: "text/plain",
                  size: 32,
                  recovery: null,
                },
              ],
            },
          });
          expect(JSON.stringify(delivery!.normalizedEvent)).not.toContain(
            "do-not-persist",
          );
          if (mode !== "immediate") {
            expect(delivery!.state).toBe(
              mode === "retry_restart" && index === 0 ? "retry" : "received",
            );
            if (
              (mode === "restart" || mode === "retry_restart") &&
              index === 0
            ) {
              await service.shutdown();
              restarted = createService(new FakeChatSdkRuntime(), undefined, {
                storage: storage.storage,
                deferWebhookProcessing: true,
                scheduleDeferredWork: () => undefined,
              });
              active = { ...context, ...restarted };
            }
            await db
              .update(chatDeliveries)
              .set({ nextAttemptAt: new Date(0) })
              .where(eq(chatDeliveries.id, delivery!.id));
            await active.service.processPendingDeliveries();
          }
          const [processed] = await readChatDeliveriesById(delivery!.id);
          expect(processed).toMatchObject({
            state: "processed",
            redactedError:
              "2 external attachments were omitted (download unavailable: 2)",
          });
          const [link] = await db
            .select()
            .from(chatMessageLinks)
            .where(
              and(
                eq(chatMessageLinks.deliveryId, delivery!.id),
                eq(chatMessageLinks.direction, "inbound"),
              ),
            );
          const [comment] = await db
            .select()
            .from(issueComments)
            .where(eq(issueComments.id, link!.commentId!));
          expect(comment!.body).toBe(
            text || "Shared 2 Microsoft Teams file references.",
          );
          const requests = [
            ...context.wakeup.mock.calls,
            ...(restarted?.wakeup.mock.calls ?? []),
          ]
            .map(([, request]) => request)
            .filter(
              (request) =>
                request.contextSnapshot?.wakeCommentId === comment!.id,
            );
          expect(requests).toHaveLength(1);
          expect(requests[0]!.contextSnapshot).toMatchObject({
            externalAttachmentOmissions: [
              {
                commentId: comment!.id,
                reasons: { download_unavailable: 2 },
              },
            ],
          });
          const [intent] = await db
            .select()
            .from(chatActions)
            .where(
              and(
                eq(chatActions.deliveryId, delivery!.id),
                eq(chatActions.kind, "inbound_wakeup"),
              ),
            );
          expect(intent!.payload).toMatchObject({
            commentId: comment!.id,
            attachmentOmissionReasons: { download_unavailable: 2 },
          });
        }
        await active.service.processPendingDeliveries();
        expect(
          context.wakeup.mock.calls.length +
            (restarted?.wakeup.mock.calls.length ?? 0),
        ).toBe(2);
        expect(fetchData).not.toHaveBeenCalled();
        expect(storage.putFile).not.toHaveBeenCalled();
        expect(
          active.runtime.endpoints.get(endpoint.id)!
            .rehydratedAttachmentDescriptors,
        ).toEqual([]);
        await expect(
          db
            .select({ id: issueAttachments.id })
            .from(issueAttachments)
            .where(eq(issueAttachments.companyId, fixture.companyId)),
        ).resolves.toEqual([]);
        await expect(
          db
            .select({ id: issueComments.id })
            .from(issueComments)
            .where(eq(issueComments.companyId, fixture.companyId)),
        ).resolves.toHaveLength(2);
      } finally {
        await service.shutdown();
        await restarted?.service.shutdown();
      }
    },
  );

  it("holds a delayed first Teams setup reply until its older root mention enables the channel", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } =
      await configuredTeamsEndpoint(fixture, {
        deferWebhookProcessing: true,
        scheduleDeferredWork: () => undefined,
      });
    const conversationId = "19:teams-delayed-root@thread.tacv2";
    const serviceUrl = "https://smba.trafficmanager.net/amer/";
    const rootMessageId = "1740000000001";
    const thread = makeThread({
      channelId: `teams:${Buffer.from(conversationId).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
      id: `teams:${Buffer.from(`${conversationId};messageid=${rootMessageId}`).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
      name: "delayed-root",
    });
    const laterReply = makeMessage({
      id: "1740000000002",
      raw: { timestamp: "2026-09-05T18:20:02.000Z" },
      text: "Teams follow-up whose callback arrived first",
      userId: "U-TEAMS-PROVISIONAL-PRIVATE",
      userName: "provisional-private-user",
    });
    laterReply.metadata.dateSent = new Date("2026-09-05T18:20:02.000Z");
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: thread.thread,
      message: laterReply,
      trigger: "subscribed_message",
    });
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(chatDeliveries.endpointId, endpoint.id));
    await service.processPendingDeliveries();

    const [deferredReply] = await readChatDeliveriesByEndpointId(endpoint.id);
    expect(deferredReply).toMatchObject({
      state: "retry",
      attempts: 1,
      principalId: null,
      redactedError: "Waiting briefly for an earlier root mention",
      normalizedEvent: {
        providerEventId: `teams:${Buffer.from(`${conversationId};messageid=${rootMessageId}`).toString("base64url")}:${laterReply.id}`,
        kind: "message",
        trigger: "subscribed_message",
        resource: {
          type: "channel",
          providerResourceId: conversationId,
        },
        conversation: { externalThreadId: thread.thread.id },
        message: {
          providerMessageId: laterReply.id,
          providerSentAt: "2026-09-05T18:20:02.000Z",
        },
        filtering: { contentRetained: false },
      },
    });
    const serializedDeferredReply = JSON.stringify(deferredReply);
    expect(serializedDeferredReply).not.toContain(laterReply.text);
    expect(serializedDeferredReply).not.toContain("Alex External");
    expect(serializedDeferredReply).not.toContain("provisional-private-user");
    expect(serializedDeferredReply).not.toContain(
      "U-TEAMS-PROVISIONAL-PRIVATE",
    );
    await expect(
      db
        .select({ id: chatExternalPrincipals.id })
        .from(chatExternalPrincipals)
        .where(eq(chatExternalPrincipals.companyId, fixture.companyId)),
    ).resolves.toHaveLength(0);
    expect(deferredReply.nextAttemptAt).not.toBeNull();
    expect(await service.listConversations(endpoint.id)).toHaveLength(0);
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: conversationId,
        type: "channel",
        enabled: false,
      }),
    ]);

    const earlierRoot = makeMessage({
      id: rootMessageId,
      raw: { timestamp: "2026-09-05T18:20:01.000Z" },
      text: "@maya keep both Teams messages",
      mentioned: true,
    });
    earlierRoot.metadata.dateSent = new Date("2026-09-05T18:20:01.000Z");
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: thread.thread,
      message: earlierRoot,
      trigger: "mention",
    });
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(chatDeliveries.state, "received"),
        ),
      );
    await service.processPendingDeliveries();
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(chatDeliveries.id, deferredReply.id));
    await service.processPendingDeliveries();

    const [conversation] = await service.listConversations(endpoint.id);
    expect(conversation).toMatchObject({ externalThreadId: thread.thread.id });
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: conversationId,
        type: "channel",
        enabled: true,
      }),
    ]);
    await expect(
      db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, conversation!.issueId))
        .orderBy(asc(issueComments.createdAt), asc(issueComments.id)),
    ).resolves.toEqual([
      { body: "@maya keep both Teams messages" },
      { body: "Teams follow-up whose callback arrived first" },
    ]);
    const [hydratedReply] = await readChatDeliveriesById(deferredReply.id);
    expect(hydratedReply).toMatchObject({
      state: "processed",
      principalId: expect.any(String),
      normalizedEvent: {
        principal: {
          externalId: "U-TEAMS-PROVISIONAL-PRIVATE",
          displayName: "Alex External",
          handle: "provisional-private-user",
        },
        message: {
          providerMessageId: laterReply.id,
          providerSentAt: "2026-09-05T18:20:02.000Z",
          providerSentAtSource: "teams_activity_timestamp",
          text: laterReply.text,
        },
      },
    });
    expect(
      (hydratedReply.normalizedEvent as { filtering?: unknown }).filtering,
    ).toBeUndefined();
    expect(wakeup).toHaveBeenCalledTimes(2);
  });

  it("orders rapid Teams follow-ups by provider time when callbacks arrive reversed", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } =
      await configuredTeamsEndpoint(fixture, {
        deferWebhookProcessing: true,
        scheduleDeferredWork: () => undefined,
      });
    const conversationId = "19:teams-follow-up-order@thread.tacv2";
    const serviceUrl = "https://smba.trafficmanager.net/amer/";
    const rootMessageId = "1740000000020";
    await db.insert(chatEndpointResources).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      type: "channel",
      providerResourceId: conversationId,
      label: "follow-up-order",
      availability: "available",
      enabled: true,
    });
    const thread = makeThread({
      channelId: `teams:${Buffer.from(conversationId).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
      id: `teams:${Buffer.from(`${conversationId};messageid=${rootMessageId}`).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
      name: "follow-up-order",
    });
    const root = makeMessage({
      id: rootMessageId,
      raw: { timestamp: "2026-09-05T18:30:00.000Z" },
      text: "@maya start an ordered Teams task",
      mentioned: true,
    });
    root.metadata.dateSent = new Date("2026-09-05T18:30:00.000Z");
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: thread.thread,
      message: root,
      trigger: "mention",
    });
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(chatDeliveries.endpointId, endpoint.id));
    await service.processPendingDeliveries();
    wakeup.mockClear();

    const later = makeMessage({
      id: "1740000000022",
      raw: { timestamp: "2026-09-05T18:30:02.000Z" },
      text: "Teams follow-up two",
    });
    later.metadata.dateSent = new Date("2026-09-05T18:30:02.000Z");
    const earlier = makeMessage({
      id: "1740000000021",
      raw: { timestamp: "2026-09-05T18:30:01.000Z" },
      text: "Teams follow-up one",
    });
    earlier.metadata.dateSent = new Date("2026-09-05T18:30:01.000Z");
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: thread.thread,
      message: later,
      trigger: "subscribed_message",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: thread.thread,
      message: earlier,
      trigger: "subscribed_message",
    });

    // Keep this ordering assertion independent of database/CI wall-clock speed.
    // The next drain below explicitly makes both deliveries due.
    await db.update(chatDeliveries).set({ nextAttemptAt: new Date(Date.now() + 60_000) })
      .where(and(eq(chatDeliveries.endpointId, endpoint.id), inArray(chatDeliveries.state, ["received", "retry"])));
    await service.processPendingDeliveries();
    expect(wakeup).not.toHaveBeenCalled();
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          inArray(chatDeliveries.state, ["received", "retry"]),
        ),
      );
    await service.processPendingDeliveries();

    const [conversation] = await service.listConversations(endpoint.id);
    await expect(
      db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, conversation!.issueId))
        .orderBy(asc(issueComments.createdAt), asc(issueComments.id)),
    ).resolves.toEqual([
      { body: "@maya start an ordered Teams task" },
      { body: "Teams follow-up one" },
      { body: "Teams follow-up two" },
    ]);
    expect(wakeup).toHaveBeenCalledTimes(2);
  });

  it("keeps a first-channel Teams orphan payload-free during grace and filters it without a live retry", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } =
      await configuredTeamsEndpoint(fixture, {
        deferWebhookProcessing: true,
        scheduleDeferredWork: () => undefined,
      });
    const conversationId = "19:teams-orphan-only@thread.tacv2";
    const serviceUrl = "https://smba.trafficmanager.net/amer/";
    const thread = makeThread({
      channelId: `teams:${Buffer.from(conversationId).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
      id: `teams:${Buffer.from(`${conversationId};messageid=1740000000011`).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
      name: "orphan-only",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: thread.thread,
      message: makeMessage({
        id: "1740000000012",
        text: "private orphan content not for the Teams bot",
        userId: "U-TEAMS-ORPHAN-PRIVATE",
        userName: "orphan-private-user",
      }),
      trigger: "unaddressed_message",
    });
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(chatDeliveries.endpointId, endpoint.id));
    await service.processPendingDeliveries();
    const [delivery] = await readChatDeliveriesByEndpointId(endpoint.id);
    expect(delivery).toMatchObject({
      state: "retry",
      attempts: 1,
      principalId: null,
      normalizedEvent: {
        filtering: { contentRetained: false },
        resource: { providerResourceId: conversationId, type: "channel" },
        conversation: { externalThreadId: thread.thread.id },
        message: { providerMessageId: "1740000000012" },
      },
    });
    const serializedDelivery = JSON.stringify(delivery);
    expect(serializedDelivery).not.toContain("private orphan content");
    expect(serializedDelivery).not.toContain("Alex External");
    expect(serializedDelivery).not.toContain("orphan-private-user");
    expect(serializedDelivery).not.toContain("U-TEAMS-ORPHAN-PRIVATE");
    await expect(
      db
        .select({ id: chatExternalPrincipals.id })
        .from(chatExternalPrincipals)
        .where(eq(chatExternalPrincipals.companyId, fixture.companyId)),
    ).resolves.toHaveLength(0);

    await service.shutdown();
    const restarted = createService();
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(chatDeliveries.id, delivery.id));
    await restarted.service.processPendingDeliveries();

    await expect(
      db
        .select({
          state: chatDeliveries.state,
          attempts: chatDeliveries.attempts,
        })
        .from(chatDeliveries)
        .where(eq(chatDeliveries.id, delivery.id)),
    ).resolves.toEqual([{ state: "filtered", attempts: 1 }]);
    expect(await restarted.service.listConversations(endpoint.id)).toHaveLength(
      0,
    );
    await expect(
      db
        .select({ id: chatExternalPrincipals.id })
        .from(chatExternalPrincipals)
        .where(eq(chatExternalPrincipals.companyId, fixture.companyId)),
    ).resolves.toHaveLength(0);
    expect(wakeup).not.toHaveBeenCalled();
    await restarted.service.shutdown();
  });

  it.each([
    { status: 200, count: 1, expireBatch: false },
    { status: 404, count: 1, expireBatch: false },
    { status: 200, count: 21, expireBatch: false },
    { status: 200, count: 3, expireBatch: true },
  ])(
    "ingests only admitted public GitHub attachments after restart (HTTP $status, $count files, expired batch $expireBatch)",
    async ({ status, count, expireBatch }) => {
      const fixture = await seedCompany();
      const storage = createStorageService();
      const deferred: Array<() => void> = [];
      const context = await configuredGitHubEndpoint(fixture, {
        storage: storage.storage,
        deferWebhookProcessing: true,
        scheduleDeferredWork: (work) => deferred.push(work),
      });
      const { service, endpoint, callbacks } = context;
      const sourceThreadId = "github:paperclipai/paperclip:issue:93";
      const sourceUrl =
        "https://github.com/user-attachments/files/31917991/public-proof.txt";
      const thread = makeThread({
        id: sourceThreadId,
        channelId: "github:paperclipai/paperclip",
        name: "paperclipai/paperclip",
      });
      const publicBody = Buffer.from("exact current GitHub public file");
      const batch = new AbortController();
      const egress = vi
        .spyOn(attachmentEgress, "guardedRemoteHttpFetch")
        .mockImplementation(async () => {
          if (expireBatch) batch.abort();
          return new Response(
            status === 200 ? publicBody : "private response never retained",
            { status, headers: { "content-type": "text/plain" } },
          );
        });
      let restarted: ReturnType<typeof createService> | undefined;
      let timeoutSpy: { mockRestore(): void } | undefined;
      try {
        await db
          .update(chatEndpoints)
          .set({ status: "active" })
          .where(eq(chatEndpoints.id, endpoint.id));
        const [resource] = await service.listResources(endpoint.id);
        await service.replaceResources(endpoint.id, [
          { id: resource!.id, enabled: false },
        ]);
        const send = async (id: string) => {
          const urls = Array.from({ length: count }, (_, index) =>
            index === 0
              ? sourceUrl
              : `https://github.com/user-attachments/files/${31917991 + index}/proof-${index}.txt`,
          );
          const message = makeMessage({
            id,
            text: "@maya inspect the exact current files",
            mentioned: true,
            userId: "42",
            raw: {
              type: "issue_comment",
              threadType: "issue",
              prNumber: 93,
              repository: { full_name: "paperclipai/paperclip" },
              comment: {
                id: Number(id),
                body: urls.map((url) => `[file](${url})`).join("\n"),
                user: { id: 42 },
              },
            },
          });
          Object.assign(message, { threadId: sourceThreadId });
          message.formatted = {
            type: "root",
            children: urls.map((url) => ({ type: "link", url, children: [] })),
          };
          message.attachments.push(
            ...githubPublicAttachmentsFromMessage(message),
          );
          await deliverMessage({
            callbacks,
            endpointId: endpoint.id,
            provider: "github",
            thread: thread.thread,
            trigger: "mention",
            message,
          });
        };
        await send("93001");
        await db
          .update(chatDeliveries)
          .set({ nextAttemptAt: new Date(0) })
          .where(eq(chatDeliveries.endpointId, endpoint.id));
        await service.processPendingDeliveries();
        expect(egress).not.toHaveBeenCalled();
        expect(storage.putFile).not.toHaveBeenCalled();
        await service.replaceResources(endpoint.id, [
          { id: resource!.id, enabled: true },
        ]);
        await send("93002");
        expect(egress).not.toHaveBeenCalled();
        const [delivery] = await db
          .select()
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, endpoint.id),
              like(chatDeliveries.providerEventId, "%:93002"),
            ),
          );
        expect({
          state: delivery!.state,
          error: delivery!.redactedError,
        }).toEqual({ state: "received", error: null });
        expect(
          (delivery!.normalizedEvent as { message: { attachments: unknown[] } })
            .message.attachments[0],
        ).toMatchObject({
          recovery: {
            provider: "github",
            locator: {
              url: sourceUrl,
              sourceMessageId: "93002",
              sourceThreadId,
            },
          },
        });
        expect(
          (
            delivery!.normalizedEvent as {
              message: {
                attachments: unknown[];
                attachmentLimitOmissions?: number;
              };
            }
          ).message,
        ).toMatchObject({
          attachments: expect.any(Array),
          ...(count > 20 ? { attachmentLimitOmissions: 1 } : {}),
        });
        expect(
          (delivery!.normalizedEvent as { message: { attachments: unknown[] } })
            .message.attachments,
        ).toHaveLength(Math.min(20, count));
        await service.shutdown();
        await db
          .update(chatDeliveries)
          .set({ nextAttemptAt: new Date(0) })
          .where(eq(chatDeliveries.id, delivery!.id));
        restarted = createService(
          new FakeChatSdkRuntime(),
          context.providerFetch as typeof globalThis.fetch,
          { storage: storage.storage },
        );
        if (expireBatch) {
          const timeout = AbortSignal.timeout.bind(AbortSignal);
          timeoutSpy = vi
            .spyOn(AbortSignal, "timeout")
            .mockImplementation((ms) =>
              ms === GITHUB_ATTACHMENT_BATCH_TIMEOUT_MS
                ? batch.signal
                : timeout(ms),
            );
        }
        await restarted.service.processPendingDeliveries();
        const [storedDelivery] = await readChatDeliveriesById(delivery!.id);
        expect({
          state: storedDelivery!.state,
          error: storedDelivery!.redactedError,
          recovered: restarted.runtime.endpoints.get(endpoint.id)
            ?.rehydratedAttachmentDescriptors.length,
        }).toEqual({
          state: "processed",
          error:
            status === 200 && count <= 20 && !expireBatch
              ? null
              : expect.any(String),
          recovered: Math.min(20, count),
        });
        expect(egress).toHaveBeenCalledTimes(
          expireBatch ? 1 : Math.min(20, count),
        );
        expect(restarted.wakeup).toHaveBeenCalledTimes(1);
        expect(storedDelivery!.state).toBe("processed");
        expect(JSON.stringify(storedDelivery)).not.toContain(
          "private response",
        );
        if (status === 200 && !expireBatch) {
          expect(storage.putFile).toHaveBeenCalledTimes(Math.min(20, count));
          expect(storage.putFile).toHaveBeenCalledWith(
            expect.objectContaining({
              body: publicBody,
              originalFilename: "public-proof.txt",
              contentType: "text/plain",
            }),
          );
          const storedAttachments = await db
            .select({ sha256: assets.sha256 })
            .from(issueAttachments)
            .innerJoin(assets, eq(assets.id, issueAttachments.assetId))
            .where(eq(issueAttachments.companyId, fixture.companyId));
          expect(storedAttachments).toHaveLength(Math.min(20, count));
          expect(
            storedAttachments.every(
              (row) =>
                row.sha256 ===
                createHash("sha256").update(publicBody).digest("hex"),
            ),
          ).toBe(true);
          if (count > 20) {
            const wakeJson = JSON.stringify(restarted.wakeup.mock.calls);
            expect(wakeJson).toContain('"attachment_limit":1');
            expect(wakeJson).toContain("externalAttachmentOmissions");
          }
        } else {
          expect(storage.putFile).not.toHaveBeenCalled();
          const wakeJson = JSON.stringify(restarted.wakeup.mock.calls);
          expect(wakeJson).toContain(`"download_unavailable":${count}`);
          expect(wakeJson).toContain("externalAttachmentOmissions");
          expect(
            await db
              .select()
              .from(issueAttachments)
              .where(eq(issueAttachments.companyId, fixture.companyId)),
          ).toHaveLength(0);
        }
        await restarted.service.processPendingDeliveries();
        expect(egress).toHaveBeenCalledTimes(
          expireBatch ? 1 : Math.min(20, count),
        );
        expect(restarted.wakeup).toHaveBeenCalledTimes(1);
      } finally {
        await service.shutdown();
        await restarted?.service.shutdown();
        egress.mockRestore();
        timeoutSpy?.mockRestore();
      }
    },
  );

  it.each([
    "none",
    "download",
    "storage",
    "cancel_race",
    "delivery_race",
    "signed_anchor",
    "ambiguous_anchor",
  ] as const)(
    "resolves an admitted GitHub private image after restart with current reach at %s",
    async (revokeAt) => {
      const fixture = await seedCompany();
      const storage = createStorageService();
      const context = await configuredGitHubEndpoint(fixture, {
        storage: storage.storage,
        deferWebhookProcessing: true,
        scheduleDeferredWork: () => {},
      });
      const { service, endpoint, callbacks } = context;
      const sourceThreadId = "github:paperclipai/paperclip:issue:93";
      const sourceUrl =
        "https://github.com/user-attachments/assets/11111111-2222-3333-4444-555555555555";
      const signedUrl =
        "https://private-user-images.githubusercontent.com/123/456-11111111-2222-3333-4444-555555555555.png?jwt=header.privatepayload.signature";
      const body =
        revokeAt === "signed_anchor"
          ? `<img width="512" alt="exact current image" src="${sourceUrl}" />`
          : `![exact current image](${sourceUrl})`;
      const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
      const [resource] = await service.listResources(endpoint.id);
      await service.replaceResources(endpoint.id, [
        { id: resource!.id, enabled: true },
      ]);
      const revoke = () =>
        db
          .update(chatEndpointResources)
          .set({ enabled: false })
          .where(eq(chatEndpointResources.id, resource!.id));
      const resolve = vi
        .spyOn(FakeEndpointRuntime.prototype, "resolveGitHubAttachmentComment")
        .mockResolvedValue({
          id: 93002,
          url: "https://api.github.com/repos/paperclipai/paperclip/issues/comments/93002",
          issue_url:
            "https://api.github.com/repos/paperclipai/paperclip/issues/93",
          body,
          body_html:
            `<a href="${["signed_anchor", "ambiguous_anchor"].includes(revokeAt) ? signedUrl : sourceUrl}"><img src="${signedUrl}"></a>`.repeat(
              revokeAt === "ambiguous_anchor" ? 2 : 1,
            ),
        });
      const warning = vi.spyOn(chatAttachmentLogger, "warn");
      let receiptMutation: Promise<unknown> | undefined;
      const egress = vi
        .spyOn(attachmentEgress, "guardedRemoteHttpFetch")
        .mockImplementation(async (url) => {
          if (String(url) === sourceUrl)
            return new Response("private", { status: 404 });
          if (String(url) !== signedUrl)
            throw new Error("unexpected test egress");
          if (revokeAt === "download") await revoke();
          if (revokeAt === "cancel_race" || revokeAt === "delivery_race") {
            let entered!: () => void;
            const ready = new Promise<void>((done) => {
              entered = done;
            });
            receiptMutation = db
              .transaction(async (tx) => {
                const [conversation] = await tx
                  .select()
                  .from(chatConversations)
                  .where(eq(chatConversations.endpointId, endpoint.id));
                if (revokeAt === "cancel_race") {
                  await tx
                    .select()
                    .from(issues)
                    .where(eq(issues.id, conversation!.issueId))
                    .for("update");
                } else {
                  const [action] = await tx
                    .select()
                    .from(chatActions)
                    .where(
                      and(
                        eq(chatActions.endpointId, endpoint.id),
                        eq(chatActions.kind, "inbound_wakeup"),
                      ),
                    );
                  await tx.execute(
                    sql`select pg_advisory_xact_lock(hashtextextended(${`chat-identity:${fixture.companyId}:${action!.principalId}`}, 0))`,
                  );
                }
                const [backend] = (await tx.execute(
                  sql`select pg_backend_pid() as pid`,
                )) as unknown as Array<{ pid: number }>;
                entered();
                // The issue barrier is after the initial action read; the
                // identity barrier is after the initial delivery read. Observe
                // the real blocked query before mutating its stale snapshot.
                await vi.waitFor(async () => {
                  const [state] = (await db.execute(sql`select exists (
                  select 1 from pg_stat_activity where ${backend!.pid} = any(pg_blocking_pids(pid))
                ) as waiting`)) as unknown as Array<{ waiting: boolean }>;
                  expect(state!.waiting).toBe(true);
                });
                if (revokeAt === "cancel_race") {
                  await tx
                    .update(chatActions)
                    .set({ status: "cancelled" })
                    .where(
                      and(
                        eq(chatActions.endpointId, endpoint.id),
                        eq(chatActions.kind, "inbound_wakeup"),
                      ),
                    );
                } else {
                  await tx
                    .update(chatDeliveries)
                    .set({ state: "failed" })
                    .where(eq(chatDeliveries.endpointId, endpoint.id));
                }
              })
              .then(
                () => null,
                (error: unknown) => error,
              )
              .finally(entered);
            await ready;
          }
          return new Response(bytes, {
            headers: { "content-type": "image/png" },
          });
        });
      if (revokeAt === "storage") {
        const put = storage.putFile.getMockImplementation()!;
        storage.putFile.mockImplementation(async (input) => {
          const result = await put(input);
          await revoke();
          return result;
        });
      }
      let restarted: ReturnType<typeof createService> | undefined;
      try {
        const thread = makeThread({
          id: sourceThreadId,
          channelId: "github:paperclipai/paperclip",
          name: "paperclipai/paperclip",
        });
        const message = makeMessage({
          id: "93002",
          text: "@maya inspect this exact image",
          mentioned: true,
          userId: "42",
          raw: {
            type: "issue_comment",
            threadType: "issue",
            prNumber: 93,
            repository: { full_name: "paperclipai/paperclip" },
            comment: { id: 93002, body, user: { id: 42 } },
          },
        });
        Object.assign(message, { threadId: sourceThreadId });
        message.formatted = {
          type: "root",
          children: [{ type: "image", url: sourceUrl }],
        };
        message.attachments.push(
          ...githubPublicAttachmentsFromMessage(message),
        );
        await deliverMessage({
          callbacks,
          endpointId: endpoint.id,
          provider: "github",
          thread: thread.thread,
          trigger: "mention",
          message,
        });
        expect(egress).not.toHaveBeenCalled();
        expect(resolve).not.toHaveBeenCalled();
        await service.shutdown();
        await db
          .update(chatDeliveries)
          .set({ nextAttemptAt: new Date(0) })
          .where(eq(chatDeliveries.endpointId, endpoint.id));
        restarted = createService(
          new FakeChatSdkRuntime(),
          context.providerFetch,
          { storage: storage.storage },
        );
        await restarted.service.processPendingDeliveries();
        if (receiptMutation) expect(await receiptMutation).toBeNull();
        expect(resolve).toHaveBeenCalledExactlyOnceWith(
          {
            url: "https://api.github.com/repos/paperclipai/paperclip/issues/comments/93002",
            accept: "application/vnd.github.full+json",
          },
          expect.any(AbortSignal),
        );
        expect(egress).toHaveBeenCalledTimes(
          revokeAt === "ambiguous_anchor" ? 1 : 2,
        );
        const stored = await db
          .select()
          .from(issueAttachments)
          .where(eq(issueAttachments.companyId, fixture.companyId));
        const imported = revokeAt === "none" || revokeAt === "signed_anchor";
        expect(stored).toHaveLength(imported ? 1 : 0);
        expect(restarted.wakeup).toHaveBeenCalledTimes(
          imported || revokeAt === "ambiguous_anchor" ? 1 : 0,
        );
        expect(storage.objects.size).toBe(imported ? 1 : 0);
        if (["download", "cancel_race", "delivery_race"].includes(revokeAt))
          expect(storage.putFile).not.toHaveBeenCalled();
        if (revokeAt === "storage")
          expect(storage.storage.deleteObject).toHaveBeenCalledTimes(1);
        const deliveries = await readChatDeliveriesByEndpointId(endpoint.id);
        expect(JSON.stringify(deliveries)).not.toContain("privatepayload");
        expect(JSON.stringify(deliveries)).not.toContain("body_html");
        if (revokeAt === "ambiguous_anchor") {
          const code = "github_attachment_canonical_mapping_ambiguous";
          const diagnostic = warning.mock.calls.find(
            ([fields]) =>
              typeof fields === "object" &&
              fields !== null &&
              "attachmentDiagnosticCode" in fields &&
              fields.attachmentDiagnosticCode === code,
          );
          expect(diagnostic?.[0]).toMatchObject({
            endpointId: endpoint.id,
            deliveryId: deliveries[0]!.id,
            error: code,
            attachmentDiagnosticCode: code,
          });
          expect(JSON.stringify(diagnostic)).not.toMatch(
            /privatepayload|jwt|body_html|https:/,
          );
          const wakeJson = JSON.stringify(restarted.wakeup.mock.calls);
          expect(wakeJson).toContain('"download_unavailable":1');
          expect(wakeJson).not.toContain(code);
          expect(storage.putFile).not.toHaveBeenCalled();
          expect(deliveries[0]!.state).toBe("processed");
        }
        if (imported) {
          expect([...storage.objects.values()][0]).toEqual(bytes);
          expect(JSON.stringify(restarted.wakeup.mock.calls)).not.toMatch(
            /privatepayload|jwt|body_html/,
          );
          await restarted.service.processPendingDeliveries();
          expect(egress).toHaveBeenCalledTimes(2);
          expect(restarted.wakeup).toHaveBeenCalledTimes(1);
        }
      } finally {
        await receiptMutation;
        await service.shutdown();
        await restarted?.service.shutdown();
        resolve.mockRestore();
        egress.mockRestore();
        warning.mockRestore();
      }
    },
  );

  it("rehydrates a durable attachment descriptor after restart and stores the file on the issue", async () => {
    const fixture = await seedCompany();
    const recoveryKey = `restart-attachment-${randomUUID()}`;
    const attachmentBody = Buffer.from("restart-safe attachment body", "utf8");
    const attachmentBodies = new Map([[recoveryKey, attachmentBody]]);
    const firstRuntime = new FakeChatSdkRuntime(attachmentBodies);
    const deferred: Array<() => void> = [];
    const storage = createStorageService();
    const first = createService(
      firstRuntime,
      fakeSlackFetch() as typeof globalThis.fetch,
      {
        deferWebhookProcessing: true,
        scheduleDeferredWork: (task) => deferred.push(task),
        storage: storage.storage,
      },
    );
    const endpoint = await first.service.create(
      fixture.companyId,
      { provider: "slack", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await first.service.update(endpoint.id, { allowUnlinkedPeople: true }, "owner-user");
    await first.service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          botToken: "xoxb-restart-attachment",
          signingSecret: "restart-attachment-signing-secret",
        },
      },
      "owner-user",
    );
    await recordSlackUrlVerification(first.service, endpoint.publicId, "restart-attachment-signing-secret");
    await first.service.configure(
      endpoint.id,
      { action: "verify" },
      "owner-user",
    );
    const callbacks = firstRuntime.configurations.get(endpoint.id)?.callbacks;
    if (!callbacks) throw new Error("Expected first-process callbacks");
    const thread = makeThread({
      channelId: "C-RESTART-FILE",
      id: "slack:C-RESTART-FILE:9150.1",
      name: "restart-files",
    });
    const liveFetch = vi.fn(async () => {
      throw new Error("the original attachment closure must not survive");
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: thread.thread,
      message: makeMessage({
        attachments: [
          {
            type: "file",
            name: "restart-note.txt",
            mimeType: "text/plain",
            size: attachmentBody.length,
            fetchData: liveFetch,
            fetchMetadata: { testRecoveryKey: recoveryKey },
          } as Attachment,
        ],
        id: "9150.1",
        text: "@maya preserve this attachment",
        mentioned: true,
      }),
      trigger: "mention",
    });
    const [durableDelivery] = await readChatDeliveriesByEndpointId(endpoint.id);
    expect(durableDelivery).toMatchObject({ state: "received", attempts: 0 });
    expect(JSON.stringify(durableDelivery.normalizedEvent)).not.toContain(
      "xoxb-restart-attachment",
    );
    expect(deferred).toHaveLength(1);
    expect(liveFetch).not.toHaveBeenCalled();
    await first.service.shutdown();
    // Restart after the bounded Slack reorder window has elapsed.
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date() })
      .where(eq(chatDeliveries.id, durableDelivery.id));

    const restartedRuntime = new FakeChatSdkRuntime(attachmentBodies);
    const restarted = createService(
      restartedRuntime,
      fakeSlackFetch() as typeof globalThis.fetch,
      {
        storage: storage.storage,
      },
    );
    await restarted.service.processPendingDeliveries();

    const restartedEndpointRuntime = restartedRuntime.endpoints.get(
      endpoint.id,
    );
    expect(
      restartedEndpointRuntime?.rehydratedAttachmentDescriptors,
    ).toHaveLength(1);
    expect(storage.putFile).toHaveBeenCalledTimes(1);
    expect(storage.putFile).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: fixture.companyId,
        originalFilename: "restart-note.txt",
        contentType: "text/plain",
        body: attachmentBody,
      }),
    );
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    const storedAttachments = await db
      .select({
        attachmentId: issueAttachments.id,
        issueId: issueAttachments.issueId,
        issueCommentId: issueAttachments.issueCommentId,
        contentType: assets.contentType,
        byteSize: assets.byteSize,
        originalFilename: assets.originalFilename,
      })
      .from(issueAttachments)
      .innerJoin(assets, eq(assets.id, issueAttachments.assetId))
      .where(eq(issueAttachments.issueId, conversation.issueId));
    expect(storedAttachments).toEqual([
      expect.objectContaining({
        issueId: conversation.issueId,
        issueCommentId: expect.any(String),
        contentType: "text/plain",
        byteSize: attachmentBody.length,
        originalFilename: "restart-note.txt",
      }),
    ]);
    await restarted.service.shutdown();
  });

  it("does not duplicate an inbound file when delivery recovery resumes after the task mutation", async () => {
    const fixture = await seedCompany();
    const recoveryKey = `retry-attachment-${randomUUID()}`;
    const attachmentBody = Buffer.from("retry-safe attachment body", "utf8");
    const runtime = new FakeChatSdkRuntime(
      new Map([[recoveryKey, attachmentBody]]),
    );
    const storage = createStorageService();
    const { service, wakeup } = createService(
      runtime,
      fakeSlackFetch() as typeof globalThis.fetch,
      {
        storage: storage.storage,
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
          botToken: "xoxb-retry-attachment",
          signingSecret: "retry-attachment-signing-secret",
        },
      },
      "owner-user",
    );
    await recordSlackUrlVerification(service, endpoint.publicId, "retry-attachment-signing-secret");
    await service.configure(endpoint.id, { action: "verify" }, "owner-user");
    const callbacks = runtime.configurations.get(endpoint.id)?.callbacks;
    if (!callbacks) throw new Error("Expected Slack callbacks");
    const channel = makeThread({
      channelId: "C-RETRY-FILE",
      id: "slack:C-RETRY-FILE:9160.1",
      name: "retry-files",
    });
    channel.subscribe.mockRejectedValueOnce(
      new Error("injected provider subscription failure"),
    );
    await expect(
      deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        thread: channel.thread,
        message: makeMessage({
          attachments: [
            {
              type: "file",
              name: "retry-note.txt",
              mimeType: "text/plain",
              size: attachmentBody.length,
              fetchData: async () => attachmentBody,
              fetchMetadata: { testRecoveryKey: recoveryKey },
            } as Attachment,
          ],
          id: "9160.1",
          text: "@maya preserve this retrying attachment",
          mentioned: true,
        }),
        trigger: "mention",
      }),
    ).rejects.toThrow("injected provider subscription failure");

    const [delivery] = await readChatDeliveriesByEndpointId(endpoint.id);
    expect(delivery).toMatchObject({ state: "retry", attempts: 1 });
    expect(wakeup).not.toHaveBeenCalled();
    const [pendingIntent] = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.deliveryId, delivery.id),
          eq(chatActions.kind, "inbound_wakeup"),
        ),
      );
    expect(pendingIntent.status).toBe("preparing");
    // Generic stranded-task recovery cannot bypass the not-yet-accepted input.
    await expect(
      heartbeatService(db).wakeup(fixture.assignedAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        requestedByActorType: "system",
        contextSnapshot: {
          issueId: pendingIntent.payload.issueId,
          source: "issue.assignment",
        },
        payload: { issueId: pendingIntent.payload.issueId },
      }),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: "chat_inbound_wakeup_unadmitted" },
    });
    expect(
      await readHeartbeatRunsByCompanyId(fixture.companyId),
    ).toEqual([]);
    expect(storage.putFile).toHaveBeenCalledTimes(1);
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(chatDeliveries.id, delivery.id));

    await service.processPendingDeliveries(25, delivery.id);
    expect(storage.putFile).toHaveBeenCalledTimes(1);
    await expect(
      db
        .select({ id: issueAttachments.id })
        .from(issueAttachments)
        .where(eq(issueAttachments.companyId, fixture.companyId)),
    ).resolves.toHaveLength(1);
    await expect(
      db
        .select({ state: chatDeliveries.state })
        .from(chatDeliveries)
        .where(eq(chatDeliveries.id, delivery.id)),
    ).resolves.toEqual([{ state: "processed" }]);
    expect(wakeup).toHaveBeenCalledTimes(1);
    const [action] = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.deliveryId, delivery.id),
          eq(chatActions.kind, "inbound_wakeup"),
        ),
      );
    expect(action).toMatchObject({
      status: "processed",
      result: { wakeupRequestId: action.id },
    });
    // Crash after the scheduler committed its receipt but before the action
    // acknowledgement: a new worker settles it without invoking wakeup again.
    await db
      .update(chatActions)
      .set({ status: "processing", result: null, updatedAt: new Date(0) })
      .where(eq(chatActions.id, action.id));
    await service.processPendingDeliveries(25, delivery.id);
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(
      await readAgentWakeupRequestsById(action.id),
    ).toHaveLength(1);
    expect(
      await db
        .select({ status: chatActions.status, result: chatActions.result })
        .from(chatActions)
        .where(eq(chatActions.id, action.id)),
    ).toEqual([
      expect.objectContaining({
        status: "processed",
        result: expect.objectContaining({
          code: "inbound_wakeup_already_durable",
        }),
      }),
    ]);
    await service.shutdown();
  });

  it("retries an accepted inbound wake outbox in FIFO order without blocking other conversations", async () => {
    const fixture = await seedCompany();
    let failAdmission = true;
    const admittedComments: string[] = [];
    const { service, callbacks, endpoint, wakeup } =
      await configuredSlackEndpoint(fixture, {
        deferWebhookProcessing: true,
        scheduleDeferredWork: () => {},
        wakeup: async (_agentId, opts) => {
          const request = opts.durableChatRequest!;
          const [delivery] = await db
            .select({ state: chatDeliveries.state })
            .from(chatDeliveries)
            .innerJoin(
              chatActions,
              eq(chatActions.deliveryId, chatDeliveries.id),
            )
            .where(eq(chatActions.id, request.id));
          expect(delivery?.state).toBe("processed");
          if (failAdmission) {
            failAdmission = false;
            throw new Error("injected scheduler unavailable");
          }
          admittedComments.push(request.commentId);
          return { accepted: true };
        },
      });
    const firstThread = makeThread({
      channelId: "C-OUTBOX",
      id: "slack:C-OUTBOX:9200.1",
    });
    const send = async (thread: Thread, id: string, mentioned = true) => {
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        thread,
        message: makeMessage({
          id,
          text: "@maya durable wake test",
          mentioned,
        }),
        trigger: mentioned ? "mention" : "subscribed_message",
      });
      await db
        .update(chatDeliveries)
        .set({ nextAttemptAt: new Date(0) })
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(chatDeliveries.state, "received"),
          ),
        );
      await service.processPendingDeliveries(25);
    };
    await send(firstThread.thread, "9200.1");
    const [firstAction] = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.kind, "inbound_wakeup"),
        ),
      );
    expect(firstAction).toMatchObject({
      status: "issued",
      result: { code: "inbound_wakeup_retry" },
    });
    expect(
      await readAgentWakeupRequestsById(firstAction.id),
    ).toEqual([]);
    await send(firstThread.thread, "9200.2", false);
    expect(wakeup).toHaveBeenCalledTimes(1);
    await send(
      makeThread({ channelId: "C-OUTBOX", id: "slack:C-OUTBOX:9300.1" }).thread,
      "9300.1",
    );
    expect(wakeup).toHaveBeenCalledTimes(2);
    await db
      .update(chatActions)
      .set({
        result: { ...firstAction.result, retryAt: new Date(0).toISOString() },
      })
      .where(eq(chatActions.id, firstAction.id));
    await service.processPendingDeliveries(25, firstAction.deliveryId!);
    expect(wakeup).toHaveBeenCalledTimes(4);
    const actions = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.kind, "inbound_wakeup"),
        ),
      );
    expect(actions).toHaveLength(3);
    expect(actions.every((action) => action.status === "processed")).toBe(true);
    const firstConversation = actions.filter(
      (action) => action.conversationId === firstAction.conversationId,
    );
    expect(admittedComments.slice(1)).toEqual([
      String(firstAction.payload.commentId),
      ...firstConversation
        .filter((action) => action.id !== firstAction.id)
        .map((action) => String(action.payload.commentId)),
    ]);
    expect(
      await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, fixture.companyId)),
    ).toHaveLength(3);
    await service.shutdown();
  });

  it("does not dispatch an accepted inbound wake after destination access is revoked", async () => {
    const fixture = await seedCompany();
    const { service, callbacks, endpoint, wakeup } =
      await configuredSlackEndpoint(fixture, {
        wakeup: async () => {
          throw new Error("injected scheduler unavailable");
        },
      });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: makeThread({
        channelId: "C-OUTBOX-REVOKE",
        id: "slack:C-OUTBOX-REVOKE:9400.1",
      }).thread,
      message: makeMessage({
        id: "9400.1",
        text: "@maya work must retain current reach",
        mentioned: true,
      }),
      trigger: "mention",
    });
    const [action] = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.kind, "inbound_wakeup"),
        ),
      );
    await db
      .update(chatEndpointResources)
      .set({ enabled: false })
      .where(eq(chatEndpointResources.endpointId, endpoint.id));
    await db
      .update(chatActions)
      .set({ result: { ...action.result, retryAt: new Date(0).toISOString() } })
      .where(eq(chatActions.id, action.id));
    await service.processPendingDeliveries(25, action.deliveryId!);
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(
      await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, fixture.companyId)),
    ).toEqual([]);
    expect(
      await db
        .select({ status: chatActions.status, result: chatActions.result })
        .from(chatActions)
        .where(eq(chatActions.id, action.id)),
    ).toEqual([
      expect.objectContaining({
        status: "failed",
        result: expect.objectContaining({
          code: "inbound_wakeup_authorization_changed",
        }),
      }),
    ]);
    await service.shutdown();
  });
});
