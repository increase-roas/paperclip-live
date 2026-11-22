import sharp, {  } from "sharp";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, chatActions, chatDeliveries, chatEndpointResources, chatEndpoints, issueComments } from "@paperclipai/db";
import { createChatSdkEndpointRuntime } from "../../services/chat-sdk-runtime.js";
import { MAX_ATTACHMENT_BYTES, formatAttachmentSize } from "../../attachment-types.js";
import { TELEGRAM_VIDEO_NOTE_MP4 } from ".././fixtures/telegram-video-note.js";
import { TELEGRAM_VOICE_OGG } from ".././fixtures/telegram-voice.js";
import { FakeChatSdkRuntime, fakeTelegramFetch, makeThread } from ".././helpers/chat-channels-fixture.js";
import { configuredTelegramEndpoint, createService, createStorageService, db, deliverMessage, describeChatChannelsSuite, readChatDeliveriesByEndpointId, readIssueCommentsByCompanyId, retirePublicationFixture, seedCompany } from "../helpers/chat-channels-harness.js";





describeChatChannelsSuite("chat channels 47-telegram-current-rich-inbound-compatibil", () => {
  describe("Telegram current rich inbound compatibility", () => {
    it.each([
      "mixed_files",
      "restart_topic",
      "revoked",
      "source_edit",
      "unknown_document",
      "unknown_block",
      "malformed_block",
    ] as const)(
      "keeps rich files and omissions scoped through lifecycle recovery (%s)",
      async (mode) => {
        const fixture = await seedCompany();
        const storage = createStorageService();
        const deferred = mode === "restart_topic" || mode === "revoked";
        const first = await configuredTelegramEndpoint(fixture, {
          storage: storage.storage,
          deferWebhookProcessing: deferred,
          scheduleDeferredWork: () => undefined,
        });
        const { service, runtime, endpoint, callbacks, wakeup } = first;
        const configuration = runtime.configurations.get(endpoint.id)!;
        const pinned = createChatSdkEndpointRuntime({
          ...configuration,
          logger: "silent",
        });
        const recovered = createChatSdkEndpointRuntime({
          ...configuration,
          logger: "silent",
        });
        let restarted: ReturnType<typeof createService> | undefined;
        const topic = mode === "restart_topic";
        const chatId = topic ? -10077115580 : 77115580;
        const threadId = `telegram:${chatId}${topic ? ":42" : ""}`;
        const thread = makeThread({
          channelId: String(chatId),
          id: threadId,
          isDM: !topic,
        }).thread;
        const bytes = Buffer.from("Exact rich restart file\nshape=hexagon\n");
        const photo = await sharp({
          create: { width: 16, height: 16, channels: 3, background: "teal" },
        })
          .jpeg()
          .toBuffer();
        const document = {
          type: "document",
          document: {
            file_id: "rich-document",
            file_unique_id: "rich-unique",
            file_name: "rich-document.txt",
            mime_type: "text/plain",
            file_size: bytes.length,
          },
        };
        const raw = {
          message_id: 71,
          date: Math.floor(Date.now() / 1_000),
          ...(topic ? { message_thread_id: 42 } : {}),
          chat: { id: chatId, type: topic ? "supergroup" : "private" },
          from: {
            id: 77115580,
            is_bot: false,
            first_name: "Rich lifecycle fixture",
          },
          rich_message: {
            blocks:
              mode === "unknown_block"
                ? [{ type: "future_block", text: "PRIVATE_UNSUPPORTED_BODY" }]
                : mode === "malformed_block"
                  ? [{ type: "details", blocks: null }]
                  : mode === "unknown_document"
                    ? [
                        {
                          type: "document",
                          document: {
                            file_id: "rich-document",
                            file_unique_id: "rich-unique",
                            file_name: "unknown.bin",
                            file_size: bytes.length,
                          },
                        },
                      ]
                    : mode === "mixed_files"
                      ? [
                          { type: "paragraph", text: "Before files" },
                          {
                            type: "details",
                            summary: "File section",
                            blocks: [
                              document,
                              {
                                type: "photo",
                                photo: [
                                  {
                                    file_id: "rich-photo",
                                    file_unique_id: "rich-photo-unique",
                                    width: 16,
                                    height: 16,
                                    file_size: photo.length,
                                  },
                                ],
                                caption: { text: "Photo caption" },
                              },
                            ],
                          },
                          {
                            type: "expandable_blockquote",
                            text: "Quoted tail",
                            credit: "Quote author",
                          },
                        ]
                      : [document],
          },
        };
        const requests: string[] = [];
        const fetchSpy = vi
          .spyOn(globalThis, "fetch")
          .mockImplementation(async (input, init) => {
            const url = new URL(
              input instanceof Request ? input.url : String(input),
            );
            if (url.hostname !== "api.telegram.org")
              throw new Error("Unexpected fixture host");
            if (url.pathname.endsWith("/getFile")) {
              const file = JSON.parse(String(init?.body)).file_id;
              expect(["rich-document", "rich-photo"]).toContain(file);
              requests.push(`getFile:${file}`);
              return Response.json({
                ok: true,
                result: { file_path: `fixture/${file}` },
              });
            }
            const file = url.pathname.split("/").at(-1)!;
            if (!["rich-document", "rich-photo"].includes(file))
              throw new Error("Unexpected fixture method");
            requests.push(`download:${file}`);
            if (mode === "source_edit") {
              const updated = pinned.parseTelegramCommandMessage({
                ...raw,
                edit_date: raw.date + 1,
                rich_message: {
                  blocks: [
                    {
                      ...document,
                      document: {
                        ...document.document,
                        file_id: "different-file",
                      },
                    },
                  ],
                },
              })!;
              await callbacks.onMessageUpdated!({
                endpointId: endpoint.id,
                provider: "telegram",
                thread,
                message: updated,
              });
            }
            return new Response(file === "rich-photo" ? photo : bytes);
          });
        try {
          Object.assign(runtime.endpoints.get(endpoint.id)!, {
            attachmentRecoveryDescriptor:
              pinned.attachmentRecoveryDescriptor.bind(pinned),
            rehydrateAttachment: pinned.rehydrateAttachment.bind(pinned),
          });
          if (topic) {
            await db
              .update(chatEndpoints)
              .set({ status: "active" })
              .where(eq(chatEndpoints.id, endpoint.id));
            await db.insert(chatEndpointResources).values({
              companyId: fixture.companyId,
              endpointId: endpoint.id,
              type: "chat",
              providerResourceId: String(chatId),
              label: "Rich topic",
              availability: "available",
              enabled: true,
            });
          }
          const message = pinned.parseTelegramCommandMessage(raw)!;
          if (topic) message.isMention = true; // Verified runtime callback addressing, not attachment authority.
          const ingress = deliverMessage({
            callbacks,
            endpointId: endpoint.id,
            provider: "telegram",
            thread,
            message,
            trigger: topic ? "mention" : "direct_message",
          });
          if (mode === "source_edit")
            await expect(ingress).rejects.toThrow("admitted source changed");
          else await ingress;
          const [delivery] = await db
            .select()
            .from(chatDeliveries)
            .where(
              and(
                eq(chatDeliveries.endpointId, endpoint.id),
                eq(
                  chatDeliveries.eventKind,
                  topic ? "mention" : "direct_message",
                ),
              ),
            );
          if (deferred) {
            expect(delivery).toMatchObject({ state: "received", attempts: 0 });
            expect(requests).toEqual([]);
            expect(wakeup).not.toHaveBeenCalled();
            const retired = vi.fn(async () => {
              throw new Error("Retired rich closure used");
            });
            message.attachments[0]!.fetchData = retired;
            await service.shutdown();
            if (mode === "revoked")
              await db
                .update(chatEndpoints)
                .set({ allowDirectMessages: false })
                .where(eq(chatEndpoints.id, endpoint.id));
            await db
              .update(chatDeliveries)
              .set({ nextAttemptAt: new Date(0) })
              .where(eq(chatDeliveries.id, delivery.id));
            const nextRuntime = new FakeChatSdkRuntime();
            const replace = nextRuntime.replaceEndpoint.bind(nextRuntime);
            vi.spyOn(nextRuntime, "replaceEndpoint").mockImplementation(
              async (options) => {
                const next = await replace(options);
                Object.assign(next, {
                  attachmentRecoveryDescriptor:
                    recovered.attachmentRecoveryDescriptor.bind(recovered),
                  rehydrateAttachment:
                    recovered.rehydrateAttachment.bind(recovered),
                });
                const originalThread = next.thread.bind(next);
                vi.spyOn(next, "thread").mockImplementation((id) => ({
                  ...originalThread(id),
                  channelId: String(chatId),
                  isDM: !topic,
                }));
                return next;
              },
            );
            restarted = createService(
              nextRuntime,
              fakeTelegramFetch() as typeof globalThis.fetch,
              {
                storage: storage.storage,
                scheduleDeferredWork: () => undefined,
              },
            );
            await restarted.service.processPendingDeliveries(25, delivery.id);
            expect(retired).not.toHaveBeenCalled();
          }
          const finalService = restarted?.service ?? service;
          const finalWake = restarted?.wakeup ?? wakeup;
          if (["revoked", "source_edit", "unknown_document"].includes(mode)) {
            expect(storage.putFile).not.toHaveBeenCalled();
            expect(finalWake).not.toHaveBeenCalled();
            expect(requests).toEqual(
              mode === "source_edit"
                ? ["getFile:rich-document", "download:rich-document"]
                : [],
            );
          } else if (mode === "unknown_block" || mode === "malformed_block") {
            const comments = await db
              .select({ body: issueComments.body })
              .from(issueComments)
              .where(eq(issueComments.companyId, fixture.companyId));
            expect(comments[0]?.body).toContain("could not import");
            expect(JSON.stringify(comments)).not.toContain(
              "PRIVATE_UNSUPPORTED_BODY",
            );
            expect(requests).toEqual([]);
          } else {
            expect(storage.putFile).toHaveBeenCalledTimes(
              mode === "mixed_files" ? 2 : 1,
            );
            expect(storage.putFile.mock.calls[0]![0]).toMatchObject({
              body: bytes,
              contentType: "text/plain",
            });
            if (mode === "mixed_files") {
              expect(storage.putFile.mock.calls[1]![0]).toMatchObject({
                body: photo,
                contentType: "image/jpeg",
              });
              const [comment] = await readIssueCommentsByCompanyId(fixture.companyId);
              expect(comment.body).toBe(
                "Before files\n\nFile section\n\nPhoto caption\n\nQuoted tail\n\nQuote author",
              );
            }
            expect(finalWake).toHaveBeenCalledOnce();
            expect(await finalService.listConversations(endpoint.id)).toEqual([
              expect.objectContaining({ externalThreadId: threadId }),
            ]);
            const before = [...requests];
            await finalService.processPendingDeliveries(25, delivery.id);
            if (!deferred)
              await deliverMessage({
                callbacks,
                endpointId: endpoint.id,
                provider: "telegram",
                thread,
                message,
                trigger: "direct_message",
              });
            expect(requests).toEqual(before);
            expect(finalWake).toHaveBeenCalledOnce();
          }
        } finally {
          try {
            await pinned.shutdown();
          } finally {
            try {
              await recovered.shutdown();
            } finally {
              try {
                await retirePublicationFixture(
                  restarted?.service ?? service,
                  endpoint.id,
                );
              } finally {
                try {
                  await service.shutdown();
                } finally {
                  fetchSpy.mockRestore();
                }
              }
            }
          }
        }
      },
    );

    it.each(["quote", "mixed", "document"] as const)(
      "retains current rich content through the pinned parser and service (%s)",
      async (mode) => {
        const fixture = await seedCompany();
        const storage = createStorageService();
        const { service, runtime, endpoint, callbacks, wakeup } =
          await configuredTelegramEndpoint(fixture, {
            storage: storage.storage,
          });
        const pinned = createChatSdkEndpointRuntime({
          ...runtime.configurations.get(endpoint.id)!,
          logger: "silent",
        });
        const bytes = Buffer.from(
          "Exact rich document fixture\nshape=hexagon\n",
        );
        const requests: string[] = [];
        const fetchSpy = vi
          .spyOn(globalThis, "fetch")
          .mockImplementation(async (input, init) => {
            const url = new URL(
              input instanceof Request ? input.url : String(input),
            );
            if (url.hostname !== "api.telegram.org")
              throw new Error("Unexpected fixture host");
            if (url.pathname.endsWith("/getFile")) {
              expect(JSON.parse(String(init?.body))).toEqual({
                file_id: "rich-document",
              });
              requests.push("getFile");
              return Response.json({
                ok: true,
                result: { file_path: "fixture/rich-document.txt" },
              });
            }
            if (!url.pathname.endsWith("/fixture/rich-document.txt"))
              throw new Error("Unexpected fixture method");
            requests.push("download");
            return new Response(bytes);
          });
        try {
          Object.assign(runtime.endpoints.get(endpoint.id)!, {
            attachmentRecoveryDescriptor:
              pinned.attachmentRecoveryDescriptor.bind(pinned),
            rehydrateAttachment: pinned.rehydrateAttachment.bind(pinned),
          });
          const quote = {
            type: "expandable_blockquote",
            text: ["Exact quoted ", { type: "bold", text: "tail" }],
            credit: "Visible credit",
          };
          const blocks =
            mode === "document"
              ? [
                  {
                    type: "document",
                    document: {
                      file_id: "rich-document",
                      file_unique_id: "rich-unique",
                      file_name: "rich-document.txt",
                      mime_type: "text/plain",
                      file_size: bytes.length,
                    },
                  },
                ]
              : mode === "mixed"
                ? [
                    { type: "paragraph", text: "Before" },
                    quote,
                    { type: "paragraph", text: "After" },
                  ]
                : [quote];
          const message = pinned.parseTelegramCommandMessage({
            message_id: 70,
            date: Math.floor(Date.now() / 1_000),
            chat: { id: 77115580, type: "private" },
            from: { id: 77115580, is_bot: false, first_name: "Rich fixture" },
            rich_message: { blocks },
          })!;
          await deliverMessage({
            callbacks,
            endpointId: endpoint.id,
            provider: "telegram",
            thread: makeThread({
              channelId: "77115580",
              id: "telegram:77115580",
              isDM: true,
            }).thread,
            message,
            trigger: "direct_message",
          });
          if (mode === "document") {
            expect(storage.putFile).toHaveBeenCalledOnce();
            expect(storage.putFile.mock.calls[0]![0]).toMatchObject({
              body: bytes,
              contentType: "text/plain",
              originalFilename: "rich-document.txt",
            });
            expect(requests).toEqual(["getFile", "download"]);
          } else {
            const [comment] = await readIssueCommentsByCompanyId(fixture.companyId);
            expect(comment?.body).toBe(
              mode === "mixed"
                ? "Before\n\nExact quoted tail\n\nVisible credit\n\nAfter"
                : "Exact quoted tail\n\nVisible credit",
            );
          }
          expect(wakeup).toHaveBeenCalledOnce();
        } finally {
          try {
            await pinned.shutdown();
          } finally {
            try {
              await retirePublicationFixture(service, endpoint.id);
            } finally {
              fetchSpy.mockRestore();
            }
          }
        }
      },
    );
  });

  describe("Telegram source-bound optional media", () => {
    it.each([
      "topic_restart",
      "changed_locator",
      "revoked_before_fetch",
      "revoked_during_fetch",
    ] as const)(
      "retains exact durable media authority across restart (%s)",
      async (mode) => {
        const fixture = await seedCompany();
        const storage = createStorageService();
        const first = await configuredTelegramEndpoint(fixture, {
          storage: storage.storage,
          deferWebhookProcessing: true,
          scheduleDeferredWork: () => undefined,
        });
        const { endpoint, runtime, service, callbacks, wakeup } = first;
        const configuration = runtime.configurations.get(endpoint.id)!;
        const pinned = createChatSdkEndpointRuntime({
          ...configuration,
          logger: "silent",
        });
        const recovered = createChatSdkEndpointRuntime({
          ...configuration,
          logger: "silent",
        });
        let restarted: ReturnType<typeof createService> | undefined;
        const topic = mode === "topic_restart";
        const chatId = topic ? -10077115579 : 77115579;
        const threadId = `telegram:${chatId}${topic ? ":42" : ""}`;
        const requests: string[] = [];
        const fetchSpy = vi
          .spyOn(globalThis, "fetch")
          .mockImplementation(async (input, init) => {
            const url = new URL(
              input instanceof Request ? input.url : String(input),
            );
            if (url.hostname !== "api.telegram.org")
              throw new Error("Unexpected fixture host");
            if (url.pathname.endsWith("/getFile")) {
              expect(JSON.parse(String(init?.body))).toEqual({
                file_id: "restart-media",
              });
              requests.push("getFile");
              return Response.json({
                ok: true,
                result: { file_path: "fixture/restart.mp4" },
              });
            }
            if (!url.pathname.endsWith("/fixture/restart.mp4"))
              throw new Error("Unexpected fixture method");
            requests.push("download");
            if (mode === "revoked_during_fetch")
              await db
                .update(chatEndpoints)
                .set({ allowDirectMessages: false })
                .where(eq(chatEndpoints.id, endpoint.id));
            return new Response(TELEGRAM_VIDEO_NOTE_MP4);
          });
        try {
          Object.assign(runtime.endpoints.get(endpoint.id)!, {
            attachmentRecoveryDescriptor:
              pinned.attachmentRecoveryDescriptor.bind(pinned),
            rehydrateAttachment: pinned.rehydrateAttachment.bind(pinned),
          });
          if (topic) {
            await db
              .update(chatEndpoints)
              .set({ status: "active" })
              .where(eq(chatEndpoints.id, endpoint.id));
            await db.insert(chatEndpointResources).values({
              companyId: fixture.companyId,
              endpointId: endpoint.id,
              type: "chat",
              providerResourceId: String(chatId),
              label: "Fixture topic",
              availability: "available",
              enabled: true,
            });
          }
          const message = pinned.parseTelegramCommandMessage({
            message_id: 50,
            date: Math.floor(Date.now() / 1_000),
            ...(topic ? { message_thread_id: 42 } : {}),
            chat: { id: chatId, type: topic ? "supergroup" : "private" },
            from: {
              id: 77115579,
              is_bot: false,
              first_name: "Restart fixture",
            },
            video: {
              file_id: "restart-media",
              file_unique_id: "restart-unique",
              file_size: TELEGRAM_VIDEO_NOTE_MP4.length,
              width: 16,
              height: 16,
              duration: 1,
            },
          })!;
          // The runtime's verified mention callback supplies addressing;
          // attachment bytes/identity still come from the actual pinned parser.
          if (topic) message.isMention = true;
          await deliverMessage({
            callbacks,
            endpointId: endpoint.id,
            provider: "telegram",
            thread: makeThread({
              channelId: String(chatId),
              id: threadId,
              isDM: !topic,
            }).thread,
            message,
            trigger: topic ? "mention" : "direct_message",
          });
          const [received] = await readChatDeliveriesByEndpointId(endpoint.id);
          expect(received).toMatchObject({ state: "received", attempts: 0 });
          expect(received.normalizedEvent).toMatchObject({
            message: {
              attachments: [
                {
                  recovery: {
                    locator: {
                      kind: "telegram_media",
                      fileId: "restart-media",
                      fileUniqueId: "restart-unique",
                      threadId,
                      messageId: `${chatId}:50`,
                      principalExternalId: "77115579",
                    },
                  },
                },
              ],
            },
          });
          expect(requests).toEqual([]);
          expect(wakeup).not.toHaveBeenCalled();
          const originalFetch = vi.fn(async () => {
            throw new Error("Retired closure used");
          });
          message.attachments[0]!.fetchData = originalFetch;
          await service.shutdown();
          if (mode === "changed_locator") {
            const normalized = structuredClone(received.normalizedEvent) as {
              message: {
                attachments: Array<{
                  recovery: { locator: { fileId: string } };
                }>;
              };
            };
            normalized.message.attachments[0]!.recovery.locator.fileId =
              "unrelated-file";
            await db
              .update(chatDeliveries)
              .set({ normalizedEvent: normalized })
              .where(eq(chatDeliveries.id, received.id));
          }
          if (mode === "revoked_before_fetch")
            await db
              .update(chatEndpoints)
              .set({ allowDirectMessages: false })
              .where(eq(chatEndpoints.id, endpoint.id));
          await db
            .update(chatDeliveries)
            .set({ nextAttemptAt: new Date(0) })
            .where(eq(chatDeliveries.id, received.id));
          const nextRuntime = new FakeChatSdkRuntime();
          const replace = nextRuntime.replaceEndpoint.bind(nextRuntime);
          vi.spyOn(nextRuntime, "replaceEndpoint").mockImplementation(
            async (options) => {
              const next = await replace(options);
              Object.assign(next, {
                attachmentRecoveryDescriptor:
                  recovered.attachmentRecoveryDescriptor.bind(recovered),
                rehydrateAttachment:
                  recovered.rehydrateAttachment.bind(recovered),
              });
              const thread = next.thread.bind(next);
              vi.spyOn(next, "thread").mockImplementation((id) => ({
                ...thread(id),
                channelId: String(chatId),
                isDM: !topic,
              }));
              return next;
            },
          );
          restarted = createService(
            nextRuntime,
            fakeTelegramFetch() as typeof globalThis.fetch,
            { storage: storage.storage, scheduleDeferredWork: () => undefined },
          );
          await restarted.service.processPendingDeliveries(25, received.id);
          expect(originalFetch).not.toHaveBeenCalled();
          if (topic) {
            expect(requests).toEqual(["getFile", "download"]);
            expect(storage.putFile).toHaveBeenCalledOnce();
            expect(storage.putFile.mock.calls[0]![0]).toMatchObject({
              body: TELEGRAM_VIDEO_NOTE_MP4,
              contentType: "video/mp4",
            });
            expect(restarted.wakeup).toHaveBeenCalledOnce();
            expect(
              await restarted.service.listConversations(endpoint.id),
            ).toEqual([
              expect.objectContaining({ externalThreadId: threadId }),
            ]);
            await restarted.service.processPendingDeliveries(25, received.id);
            expect(requests).toEqual(["getFile", "download"]);
            expect(restarted.wakeup).toHaveBeenCalledOnce();
          } else {
            expect(storage.putFile).not.toHaveBeenCalled();
            expect(restarted.wakeup).not.toHaveBeenCalled();
            expect(requests).toEqual(
              mode === "revoked_during_fetch" ? ["getFile", "download"] : [],
            );
            if (mode === "changed_locator") {
              const [comment] = await readIssueCommentsByCompanyId(fixture.companyId);
              expect(comment!.body).toContain("could not safely import");
            }
          }
        } finally {
          try {
            await pinned.shutdown();
          } finally {
            try {
              await recovered.shutdown();
            } finally {
              try {
                await retirePublicationFixture(
                  restarted?.service ?? service,
                  endpoint.id,
                );
              } finally {
                try {
                  await service.shutdown();
                } finally {
                  fetchSpy.mockRestore();
                }
              }
            }
          }
        }
      },
    );

    it.each([
      "video",
      "voice",
      "live_photo",
      "oversize",
      "unknown_document",
      "malformed_video",
      "malformed_live_photo",
      "malformed_bytes",
      "office_named_video",
      "office_named_invalid",
    ] as const)(
      "imports exact permitted bytes or gives accurate recovery advice (%s)",
      async (mode) => {
        const fixture = await seedCompany();
        const storage = createStorageService();
        const context = await configuredTelegramEndpoint(fixture, {
          storage: storage.storage,
        });
        const { service, runtime, endpoint, callbacks, wakeup } = context;
        const pinned = createChatSdkEndpointRuntime({
          ...runtime.configurations.get(endpoint.id)!,
          logger: "silent",
        });
        const photo = await sharp({
          create: { width: 16, height: 16, channels: 3, background: "teal" },
        })
          .jpeg()
          .toBuffer();
        const bytes =
          mode === "voice"
            ? TELEGRAM_VOICE_OGG
            : mode === "malformed_bytes" || mode === "office_named_invalid"
              ? TELEGRAM_VIDEO_NOTE_MP4.subarray(0, -1)
              : TELEGRAM_VIDEO_NOTE_MP4;
        const requests: string[] = [];
        const fetchSpy = vi
          .spyOn(globalThis, "fetch")
          .mockImplementation(async (input, init) => {
            const url = new URL(
              input instanceof Request ? input.url : String(input),
            );
            if (url.hostname !== "api.telegram.org")
              throw new Error("Unexpected fixture host");
            if (url.pathname.endsWith("/getFile")) {
              const fileId = JSON.parse(String(init?.body)).file_id as string;
              expect(["optional-media", "optional-photo"]).toContain(fileId);
              requests.push(`getFile:${fileId}`);
              return Response.json({
                ok: true,
                result: { file_path: `fixture/${fileId}` },
              });
            }
            const file = url.pathname.split("/").at(-1)!;
            if (!["optional-media", "optional-photo"].includes(file))
              throw new Error("Unexpected fixture method");
            requests.push(`download:${file}`);
            return new Response(file === "optional-photo" ? photo : bytes);
          });
        try {
          Object.assign(runtime.endpoints.get(endpoint.id)!, {
            attachmentRecoveryDescriptor:
              pinned.attachmentRecoveryDescriptor.bind(pinned),
            rehydrateAttachment: pinned.rehydrateAttachment.bind(pinned),
          });
          const media = {
            file_id: "optional-media",
            file_unique_id: "optional-media-unique",
            file_size:
              mode === "oversize" ? MAX_ATTACHMENT_BYTES + 1 : bytes.length,
            duration:
              mode === "malformed_video" || mode === "malformed_live_photo"
                ? -1
                : 1,
            ...(mode.startsWith("office_named")
              ? { file_name: "recording.docx" }
              : {}),
          };
          const raw = {
            message_id: 41,
            date: Math.floor(Date.now() / 1_000),
            chat: { id: 77115579, type: "private" },
            from: {
              id: 77115579,
              is_bot: false,
              first_name: "Optional media fixture",
            },
            ...(mode === "unknown_document"
              ? { document: media }
              : mode === "voice"
                ? { voice: media }
                : mode === "live_photo" || mode === "malformed_live_photo"
                  ? {
                      live_photo: {
                        ...media,
                        width: 16,
                        height: 16,
                        photo: [
                          {
                            file_id: "optional-photo",
                            file_unique_id: "optional-photo-unique",
                            file_size: photo.length,
                            width: 16,
                            height: 16,
                          },
                        ],
                      },
                    }
                  : { video: { ...media, width: 16, height: 16 } }),
          };
          const message = pinned.parseTelegramCommandMessage(raw)!;
          await deliverMessage({
            callbacks,
            endpointId: endpoint.id,
            provider: "telegram",
            thread: makeThread({
              channelId: "77115579",
              id: "telegram:77115579",
              isDM: true,
            }).thread,
            message,
            trigger: "direct_message",
          });
          if (
            [
              "oversize",
              "unknown_document",
              "malformed_video",
              "malformed_live_photo",
              "malformed_bytes",
              "office_named_invalid",
            ].includes(mode)
          ) {
            expect(storage.putFile).not.toHaveBeenCalled();
            expect(requests).toEqual(
              mode === "malformed_bytes" || mode === "office_named_invalid"
                ? ["getFile:optional-media", "download:optional-media"]
                : [],
            );
            const [comment] = await readIssueCommentsByCompanyId(fixture.companyId);
            expect(comment!.body).toContain(
              `under ${formatAttachmentSize(MAX_ATTACHMENT_BYTES)}`,
            );
            expect(wakeup).not.toHaveBeenCalled();
            return;
          }
          expect(storage.putFile).toHaveBeenCalledTimes(
            mode === "live_photo" ? 2 : 1,
          );
          expect(
            storage.putFile.mock.calls.some(
              ([input]) =>
                Buffer.isBuffer(input.body) && input.body.equals(bytes) &&
                input.contentType ===
                  (mode === "voice" ? "audio/ogg" : "video/mp4"),
            ),
          ).toBe(true);
          if (mode === "live_photo")
            expect(
              storage.putFile.mock.calls.some(
                ([input]) =>
                  Buffer.isBuffer(input.body) && input.body.equals(photo) &&
                  input.contentType === "image/jpeg",
              ),
            ).toBe(true);
          expect(wakeup).toHaveBeenCalledOnce();
          const [delivery] = await readChatDeliveriesByEndpointId(endpoint.id);
          expect(delivery).toMatchObject({
            state: "processed",
            redactedError: null,
          });
          // Replay this exact source, not unrelated admission retries left in
          // the shared fixture DB by tests exercising failed scheduler calls.
          await service.processPendingDeliveries(25, delivery.id);
          expect(requests).toHaveLength(mode === "live_photo" ? 4 : 2);
          expect(wakeup).toHaveBeenCalledOnce();
          expect(wakeup.mock.calls[0]![0]).toBe(fixture.assignedAgentId);
          await expect(
            db
              .select({ id: agentWakeupRequests.id })
              .from(agentWakeupRequests)
              .innerJoin(
                chatActions,
                eq(chatActions.id, agentWakeupRequests.id),
              )
              .where(
                and(
                  eq(chatActions.deliveryId, delivery.id),
                  eq(agentWakeupRequests.companyId, fixture.companyId),
                  eq(agentWakeupRequests.agentId, fixture.assignedAgentId),
                ),
              ),
          ).resolves.toHaveLength(1);
        } finally {
          try {
            await pinned.shutdown();
          } finally {
            try {
              await retirePublicationFixture(service, endpoint.id);
            } finally {
              fetchSpy.mockRestore();
            }
          }
        }
      },
    );
  });
});
