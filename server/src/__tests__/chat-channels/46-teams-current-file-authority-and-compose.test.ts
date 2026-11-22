import {
  chatHistoryActionBlocks,
} from ".././helpers/chat-history-proof.js";
import {
  createHash,
  randomUUID,
} from "node:crypto";
import {
  and,
  asc,
  eq,
  sql,
} from "drizzle-orm";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  chatActions,
  chatDeliveries,
  chatEndpointResources,
  chatEndpoints,
  chatExternalPrincipals,
  chatIdentityLinks,
  chatMessageLinks,
  chatPublications,
  chatTeamsFileTransfers,
  companyMemberships,
  issueComments,
} from "@paperclipai/db";
import {
  chatChannelService,
  type ChatChannelService,
  type ChatChannelServiceOptions,
} from "../../services/chat-channels.js";
import {
  issueService,
} from "../../services/issues.js";
import {
  projectSafeChatPublicationText,
} from "../../services/chat-publication-projection.js";
import {
  nativePublicationTextFits,
  renderPublicationTransportText,
} from "../../services/chat-publication-text-parts.js";
import {
  FakeChatSdkRuntime,
  fakeTelegramFetch,
  makeMessage,
  makeThread,
  routesApp,
} from ".././helpers/chat-channels-fixture.js";
import {
  committedChatResponseRecoveryFixture,
  configuredSlackEndpoint,
  configuredTeamsEndpoint,
  configuredTelegramEndpoint,
  createService,
  db,
  deliverMessage,
  describeChatChannelsSuite,
  qualifySetupRoundTrip,
  readChatActionsById,
  readChatDeliveriesByEndpointId,
  readChatDeliveriesById,
  readChatPublicationsByCommentId,
  readChatPublicationsById,
  readChatTeamsFileTransfersById,
  readHeartbeatRunsByCompanyId,
  readIssueCommentsByCompanyId,
  readIssuesByCompanyId,
  receiptBackedWakeup,
  retirePublicationFixture,
  seedCompany,
  configuredGitHubEndpoint,
  safeNativeProgressFixture,
} from "../helpers/chat-channels-harness.js";
import {
  teamsFileAuthorityFixture,
} from "../helpers/chat-channels-endpoint-fixtures.js";
import request, {  } from "supertest";
import type { ChatSdkRuntime } from "../../services/chat-sdk-runtime.js";

describeChatChannelsSuite("chat channels 46-teams-current-file-authority-and-compose", () => {
  describe("Teams current file authority and composed Board transfer", () => {
    // Actual installed inbound parser + real admission, intent, transfer,
    // projection and callback service. Runtime sends/PUT and the authenticated
    // App hook ingress are controlled here; this is not tenant/JWT/live proof.
    it("freezes the original recipient at Board Send and publishes only after consent and exact-byte PUT", async () => {
      const context = await teamsFileAuthorityFixture();
      try {
        const attachment = await context.createFile();
        const publication = await context.service.publishBoardMessage(
          context.endpoint.id,
          context.conversation.id,
          "One original file for the current task recipient",
          `teams-board-file-${randomUUID()}`,
          "owner-user",
          [attachment.id],
        );
        const [intent] = await db
          .select()
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, context.endpoint.id),
              eq(chatActions.kind, "teams_board_file_intent"),
            ),
          );
        expect(intent).toMatchObject({
          status: "processed",
          deliveryId: context.sourceDelivery.id,
          principalId: context.sourceAction.principalId,
          payload: {
            publicationId: publication.id,
            attachmentId: attachment.id,
            sourceActionId: context.sourceAction.id,
            userId: "owner-user",
          },
        });
        const [transfer] = await db
          .select()
          .from(chatTeamsFileTransfers)
          .where(eq(chatTeamsFileTransfers.publicationId, publication.id));
        expect(transfer).toMatchObject({
          phase: "awaiting_consent",
          providerUserId: context.providerUserId,
          aadObjectId: context.aadObjectId,
          providerConversationId: context.providerConversationId,
          sha256: createHash("sha256").update(context.bytes).digest("hex"),
          byteSize: context.bytes.length,
          consentMessageId: "native-consent-1",
          fileInfoMessageId: null,
        });
        expect(context.consentCards).toHaveLength(1);
        expect(context.fileCards).toEqual([]);
        expect(context.uploadRequest).not.toHaveBeenCalled();
        expect(await chatHistoryActionBlocks(db, intent!.id)).toBe(true);
        const before = await context.service.getPublicationBatchStatus(
          context.endpoint.id,
          context.conversation.id,
          publication.id,
        );
        expect(before).toMatchObject({
          published: 1,
          awaitingConsent: 1,
          canDismiss: false,
        });
        const wakeCount = context.wakeup.mock.calls.length;
        await expect(context.dispatchConsent()).resolves.toEqual({
          status: 200,
        });
        await context.service.processPendingPublications();
        const [done] = await readChatTeamsFileTransfersById(transfer!.id);
        expect(done).toMatchObject({
          phase: "delivered",
          consentMessageId: "native-consent-1",
          fileInfoMessageId: "native-file-1",
        });
        expect(context.uploadRequest).toHaveBeenCalledTimes(1);
        expect(context.uploadRequest.mock.calls[0]![1]).toMatchObject({
          method: "PUT",
          redirect: "manual",
          body: context.bytes,
        });
        expect(context.fileCards).toHaveLength(1);
        expect(await chatHistoryActionBlocks(db, intent!.id)).toBe(false);
        const status = await context.service.getPublicationBatchStatus(
          context.endpoint.id,
          context.conversation.id,
          publication.id,
        );
        expect(status).toMatchObject({
          published: 2,
          awaitingConsent: 0,
          settled: 2,
          canDismiss: true,
        });
        expect(
          JSON.stringify([
            status,
            await context.service.listActivity(context.endpoint.id),
          ]),
        ).not.toMatch(
          /PRIVATE-UPLOAD-CANARY|pcfc_|ciphertext|fixture\.sharepoint/,
        );
        await context.service.processPendingPublications();
        expect(context.consentCards).toHaveLength(1);
        expect(context.fileCards).toHaveLength(1);
        expect(context.uploadRequest).toHaveBeenCalledTimes(1);
        expect(context.wakeup).toHaveBeenCalledTimes(wakeCount);
      } finally {
        await retirePublicationFixture(context.service, context.endpoint.id);
      }
    });

    it("stages native Board file consent on the first send from a cold reconstructed service", async () => {
      const context = await teamsFileAuthorityFixture();
      const coldRuntime = new FakeChatSdkRuntime();
      const replace = coldRuntime.replaceEndpoint.bind(coldRuntime);
      const consentPost = vi.fn(async (_threadId: string, _card: unknown) => ({
        id: "cold-consent-1",
      }));
      vi.spyOn(coldRuntime, "replaceEndpoint").mockImplementation(
        async (options) => {
          const instance = await replace(options);
          const thread = instance.thread.bind(instance);
          vi.spyOn(instance, "thread").mockImplementation((id) => ({
            ...thread(id),
            isDM: true,
          }));
          Object.assign(instance, {
            sendTeamsFileConsentCard: consentPost,
            sendTeamsUploadedFileCard: async () => {
              throw new Error("No upload is authorized before consent");
            },
          });
          return instance;
        },
      );
      const coldWakeup = vi.fn<
        ChatChannelServiceOptions["heartbeat"]["wakeup"]
      >(async () => ({ accepted: true }));
      let coldService: ChatChannelService | undefined;
      try {
        const attachment = await context.createFile();
        await context.service.shutdown();
        coldService = chatChannelService(db, {
          fetch: async () =>
            Response.json({ access_token: "synthetic-cold-access" }),
          runtime: coldRuntime as unknown as ChatSdkRuntime,
          heartbeat: {
            wakeup: receiptBackedWakeup(coldWakeup),
            cancelRun: vi.fn(async () => ({ status: "cancelled" })),
          },
          storage: context.storage.storage,
          publicBaseUrl: "https://paperclip.example",
          teamsFileUploadRequest: context.uploadRequest,
          scheduleDeferredWork: () => undefined,
        });
        expect(coldRuntime.endpoints.size).toBe(0);
        expect(coldRuntime.replaceCount).toBe(0);
        await expect(
          coldService.get(context.endpoint.id),
        ).resolves.toMatchObject({ status: "active" });
        const publication = await coldService.publishBoardMessage(
          context.endpoint.id,
          context.conversation.id,
          "First Board send after service reconstruction",
          `teams-cold-${randomUUID()}`,
          "owner-user",
          [attachment.id],
        );
        const [intent] = await db
          .select()
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, context.endpoint.id),
              eq(chatActions.kind, "teams_board_file_intent"),
            ),
          );
        expect(intent).toMatchObject({
          deliveryId: context.sourceDelivery.id,
          principalId: context.sourceAction.principalId,
          payload: {
            publicationId: publication.id,
            sourceActionId: context.sourceAction.id,
            attachmentId: attachment.id,
          },
        });
        expect(
          await db
            .select()
            .from(chatTeamsFileTransfers)
            .where(eq(chatTeamsFileTransfers.publicationId, publication.id)),
        ).toEqual([
          expect.objectContaining({
            phase: "awaiting_consent",
            consentMessageId: "cold-consent-1",
            fileInfoMessageId: null,
            providerUserId: context.providerUserId,
            aadObjectId: context.aadObjectId,
            sha256: createHash("sha256").update(context.bytes).digest("hex"),
          }),
        ]);
        expect(consentPost).toHaveBeenCalledTimes(1);
        expect(coldWakeup).not.toHaveBeenCalled();
        expect(context.uploadRequest).not.toHaveBeenCalled();
        expect(
          await coldService.getPublicationBatchStatus(
            context.endpoint.id,
            context.conversation.id,
            publication.id,
          ),
        ).toMatchObject({
          published: 1,
          awaitingConsent: 1,
          canDismiss: false,
        });
      } finally {
        try {
          await context.service.shutdown();
        } finally {
          await retirePublicationFixture(
            coldService ?? context.service,
            context.endpoint.id,
          );
        }
      }
    });

    async function beginTeamsBoardTransfer(
      context: Awaited<ReturnType<typeof teamsFileAuthorityFixture>>,
    ) {
      const attachment = await context.createFile();
      const publication = await context.service.publishBoardMessage(
        context.endpoint.id,
        context.conversation.id,
        "The exact current original file",
        `teams-authority-race-${randomUUID()}`,
        "owner-user",
        [attachment.id],
      );
      const [transfer] = await db
        .select()
        .from(chatTeamsFileTransfers)
        .where(eq(chatTeamsFileTransfers.publicationId, publication.id));
      expect(transfer).toMatchObject({
        phase: "awaiting_consent",
        consentMessageId: "native-consent-1",
      });
      expect(context.consentCards).toHaveLength(1);
      expect(context.uploadRequest).not.toHaveBeenCalled();
      return { publication, transfer: transfer! };
    }

    it.each(["linked_recipient", "sponsor", "board_author"] as const)(
      "rechecks revoked %s authority before acceptance and before PUT",
      async (role) => {
        for (const boundary of ["accept", "put"] as const) {
          const context = await teamsFileAuthorityFixture({
            linkedRecipient: role === "linked_recipient",
            separateSponsor: true,
          });
          try {
            const { transfer } = await beginTeamsBoardTransfer(context);
            if (boundary === "put")
              await expect(context.dispatchConsent()).resolves.toEqual({
                status: 200,
              });
            if (role === "linked_recipient")
              await db
                .update(chatIdentityLinks)
                .set({ status: "revoked", revokedAt: new Date() })
                .where(
                  and(
                    eq(chatIdentityLinks.companyId, context.fixture.companyId),
                    eq(chatIdentityLinks.endpointId, context.endpoint.id),
                    eq(
                      chatIdentityLinks.principalId,
                      context.sourceAction.principalId!,
                    ),
                  ),
                );
            else
              await db
                .update(companyMemberships)
                .set({ membershipRole: "viewer" })
                .where(
                  and(
                    eq(companyMemberships.companyId, context.fixture.companyId),
                    eq(companyMemberships.principalType, "user"),
                    eq(
                      companyMemberships.principalId,
                      role === "sponsor" ? context.sponsorUserId : "owner-user",
                    ),
                  ),
                );
            const [before] = await readChatTeamsFileTransfersById(transfer.id);
            if (boundary === "accept") {
              const outcome = await context.dispatchConsent();
              // No success ACK for a revoked principal. The current callback
              // contract distinguishes explicit denial from closed transient failure.
              expect([403, 503]).toContain(outcome.status);
            }
            await context.service.processPendingPublications();
            expect(
              await readChatTeamsFileTransfersById(transfer.id),
            ).toEqual([before]);
            expect(context.uploadRequest).not.toHaveBeenCalled();
            expect(context.fileCards).toEqual([]);
            expect(context.consentCards).toHaveLength(1);
          } finally {
            await retirePublicationFixture(
              context.service,
              context.endpoint.id,
            );
          }
        }
      },
    );

    it("rejects a retained old-runtime consent callback after normal pause and resume", async () => {
      const context = await teamsFileAuthorityFixture();
      try {
        const { transfer } = await beginTeamsBoardTransfer(context);
        const oldRuntime = context.runtime.endpoints.get(context.endpoint.id);
        const oldHandler = context.handlers.get("file.consent.accept")!;
        await context.service.configure(
          context.endpoint.id,
          { action: "pause" },
          "owner-user",
        );
        await context.service.configure(
          context.endpoint.id,
          { action: "resume" },
          "owner-user",
        );
        expect(context.runtime.endpoints.get(context.endpoint.id)).not.toBe(
          oldRuntime,
        );
        const [before] = await readChatTeamsFileTransfersById(transfer.id);
        await expect(
          context.dispatchConsent("accept", {}, oldHandler),
        ).resolves.toEqual({ status: 403 });
        expect(
          await readChatTeamsFileTransfersById(transfer.id),
        ).toEqual([before]);
        expect(context.uploadRequest).not.toHaveBeenCalled();
        expect(context.fileCards).toEqual([]);
      } finally {
        await retirePublicationFixture(context.service, context.endpoint.id);
      }
    });

    it("deduplicates the same actual acceptance activity before and after file delivery", async () => {
      const context = await teamsFileAuthorityFixture();
      try {
        const { transfer } = await beginTeamsBoardTransfer(context);
        const activity = { id: `same-accept-${randomUUID()}` };
        await expect(
          context.dispatchConsent("accept", activity),
        ).resolves.toEqual({ status: 200 });
        await expect(
          context.dispatchConsent("accept", activity),
        ).resolves.toEqual({ status: 200 });
        await context.service.processPendingPublications();
        const [before] = await readChatTeamsFileTransfersById(transfer.id);
        expect(before?.phase).toBe("delivered");
        await expect(
          context.dispatchConsent("accept", activity),
        ).resolves.toEqual({ status: 200 });
        await context.service.processPendingPublications();
        expect(
          await readChatTeamsFileTransfersById(transfer.id),
        ).toEqual([before]);
        expect(
          await db
            .select()
            .from(chatActions)
            .where(
              and(
                eq(chatActions.endpointId, context.endpoint.id),
                eq(chatActions.kind, "teams_file_consent"),
              ),
            ),
        ).toHaveLength(1);
        expect(context.consentCards).toHaveLength(1);
        expect(context.uploadRequest).toHaveBeenCalledTimes(1);
        expect(context.fileCards).toHaveLength(1);
      } finally {
        await retirePublicationFixture(context.service, context.endpoint.id);
      }
    });

    it("durably accepts a callback inside the consent POST before the native receipt returns", async () => {
      const context = await teamsFileAuthorityFixture();
      try {
        let duringPost: typeof chatTeamsFileTransfers.$inferSelect | undefined;
        context.controls.beforeConsentReceipt = async () => {
          await expect(context.dispatchConsent()).resolves.toEqual({
            status: 200,
          });
          [duringPost] = await db
            .select()
            .from(chatTeamsFileTransfers)
            .where(eq(chatTeamsFileTransfers.endpointId, context.endpoint.id));
          expect(duringPost).toMatchObject({
            phase: "consent_sending",
            consentMessageId: null,
            responseActivityId: expect.any(String),
          });
          expect(JSON.stringify(duringPost)).not.toContain(
            "PRIVATE-UPLOAD-CANARY",
          );
          expect(context.uploadRequest).not.toHaveBeenCalled();
        };
        const attachment = await context.createFile();
        await context.service.publishBoardMessage(
          context.endpoint.id,
          context.conversation.id,
          "Early callback exact file",
          `teams-early-${randomUUID()}`,
          "owner-user",
          [attachment.id],
        );
        expect(duringPost).toBeDefined();
        const [finished] = await readChatTeamsFileTransfersById(duringPost!.id);
        expect(finished).toMatchObject({
          phase: "delivered",
          consentMessageId: "native-consent-1",
          fileInfoMessageId: "native-file-1",
        });
        expect(context.consentCards).toHaveLength(1);
        expect(context.uploadRequest).toHaveBeenCalledTimes(1);
        expect(context.fileCards).toHaveLength(1);
      } finally {
        await retirePublicationFixture(context.service, context.endpoint.id);
      }
    });

    it("offers only exact conflict cancellation after valid Teams consent receipts disagree", async () => {
      const context = await teamsFileAuthorityFixture();
      try {
        const { publication } = await beginTeamsBoardTransfer(context);
        const wakeCount = context.wakeup.mock.calls.length;
        await expect(context.dispatchConsent("accept")).resolves.toEqual({
          status: 200,
        });
        await expect(context.dispatchConsent("decline")).resolves.toEqual({
          status: 403,
        });
        const [conflict] = await db
          .select()
          .from(chatTeamsFileTransfers)
          .where(eq(chatTeamsFileTransfers.publicationId, publication.id));
        expect(conflict).toMatchObject({
          phase: "conflict",
          attemptId: null,
          attemptExpiresAt: null,
        });
        const app = routesApp(db, context.fixture.companyId, context.service);
        const before = await readChatPublicationsByCommentId(publication.commentId!);
        const activity = await request(app)
          .get(`/api/chat-endpoints/${context.endpoint.id}/activity`)
          .expect(200);
        const item = activity.body.find(
          (row: { id: string }) => row.id === publication.id,
        );
        expect(item).toMatchObject({
          status: "delivery_unknown",
          replayable: false,
          resolutionActions: ["cancel"],
          fileTransfer: { phase: "conflict", version: conflict!.version },
        });
        expect(JSON.stringify(activity.body)).not.toMatch(
          /PRIVATE-UPLOAD-CANARY|pcfc_|ciphertext|fixture\.sharepoint/,
        );
        expect(
          await db
            .select()
            .from(chatTeamsFileTransfers)
            .where(eq(chatTeamsFileTransfers.publicationId, publication.id)),
        ).toEqual([conflict]);
        expect(
          await readChatPublicationsByCommentId(publication.commentId!),
        ).toEqual(before);
        const path = `/api/chat-endpoints/${context.endpoint.id}/publications/${publication.id}/resolve`;
        const hint = { phase: "conflict", version: conflict!.version };
        for (const action of ["mark_delivered", "retry_anyway"])
          await request(app)
            .post(path)
            .send({ action, fileTransfer: hint })
            .expect(409);
        await request(app)
          .post(path)
          .send({ action: "cancel", fileTransfer: hint })
          .expect(204);
        await request(app)
          .post(path)
          .send({ action: "cancel", fileTransfer: hint })
          .expect(409);
        const [cancelled] = await db
          .select()
          .from(chatTeamsFileTransfers)
          .where(eq(chatTeamsFileTransfers.publicationId, publication.id));
        expect(cancelled).toMatchObject({
          phase: "cancelled",
          reason: "operator_cancelled_conflict",
          version: conflict!.version + 1,
          fileInfoMessageId: null,
        });
        expect(
          await context.service.getPublicationBatchStatus(
            context.endpoint.id,
            context.conversation.id,
            publication.id,
          ),
        ).toMatchObject({
          published: 1,
          cancelled: 1,
          settled: 2,
          canDismiss: true,
        });
        expect(context.consentCards).toHaveLength(1);
        expect(context.uploadRequest).not.toHaveBeenCalled();
        expect(context.fileCards).toHaveLength(0);
        expect(context.wakeup).toHaveBeenCalledTimes(wakeCount);
        await expect(
          db
            .select()
            .from(activityLog)
            .where(
              and(
                eq(activityLog.companyId, context.fixture.companyId),
                eq(activityLog.entityId, publication.id),
                eq(activityLog.action, "chat.publication_cancel"),
              ),
            ),
        ).resolves.toEqual([
          expect.objectContaining({
            actorType: "user",
            actorId: "owner-user",
            details: expect.objectContaining({
              previousPhase: "conflict",
              previousVersion: conflict!.version,
              nextPhase: "cancelled",
              duplicateRiskAcknowledged: false,
            }),
          }),
        ]);
      } finally {
        await retirePublicationFixture(context.service, context.endpoint.id);
      }
    });

    it("retries only fileInfo after a confirmed PUT and an explicitly resolved missing fileInfo receipt", async () => {
      const context = await teamsFileAuthorityFixture();
      try {
        const { transfer, publication } =
          await beginTeamsBoardTransfer(context);
        context.controls.beforeFileInfoReceipt = async () => {
          throw new Error(
            "Synthetic provider ACK timeout after attempted fileInfo POST",
          );
        };
        await expect(context.dispatchConsent()).resolves.toEqual({
          status: 200,
        });
        await context.service.processPendingPublications();
        const [unknown] = await readChatTeamsFileTransfersById(transfer.id);
        expect(unknown).toMatchObject({
          phase: "file_info_unknown",
          consentMessageId: "native-consent-1",
          fileInfoMessageId: null,
        });
        expect(context.uploadRequest).toHaveBeenCalledTimes(1);
        expect(context.fileCards).toHaveLength(1);
        await context.service.processPendingPublications();
        expect(context.fileCards).toHaveLength(1);
        context.controls.beforeFileInfoReceipt = undefined;
        await context.service.resolvePublication(
          context.endpoint.id,
          publication.id,
          "retry_anyway",
          "owner-user",
          { phase: "file_info_unknown", version: unknown!.version },
        );
        const [finished] = await readChatTeamsFileTransfersById(transfer.id);
        expect(finished).toMatchObject({
          phase: "delivered",
          fileInfoMessageId: "native-file-2",
        });
        expect(context.consentCards).toHaveLength(1);
        expect(context.uploadRequest).toHaveBeenCalledTimes(1);
        expect(context.uploadRequest.mock.calls[0]![1]).toMatchObject({
          body: context.bytes,
        });
        expect(context.fileCards).toHaveLength(2);
        expect(
          await db
            .select()
            .from(activityLog)
            .where(
              and(
                eq(activityLog.companyId, context.fixture.companyId),
                eq(activityLog.entityId, publication.id),
                eq(activityLog.action, "chat.publication_retry_anyway"),
              ),
            ),
        ).toEqual([
          expect.objectContaining({
            details: expect.objectContaining({
              previousPhase: "file_info_unknown",
              duplicateRiskAcknowledged: true,
            }),
          }),
        ]);
      } finally {
        await retirePublicationFixture(context.service, context.endpoint.id);
      }
    });

    it.each([
      "missing_original_proof",
      "mismatched_original_aad",
      "different_admitted_recipient",
    ] as const)(
      "keeps the task-link fallback with no native file intent for %s",
      async (variant) => {
        const context = await teamsFileAuthorityFixture();
        try {
          if (variant === "different_admitted_recipient") {
            await context.deliver({
              ...context.raw,
              id: `other-source-${randomUUID()}`,
              from: {
                ...context.raw.from,
                id: `29:other-${randomUUID()}`,
                aadObjectId: randomUUID(),
              },
            });
          } else {
            const normalized = { ...context.sourceDelivery.normalizedEvent };
            if (variant === "missing_original_proof")
              delete normalized.teamsPersonalRecipient;
            else
              normalized.teamsPersonalRecipient = {
                ...(normalized.teamsPersonalRecipient as Record<
                  string,
                  unknown
                >),
                aadObjectId: randomUUID(),
              };
            await db
              .update(chatDeliveries)
              .set({ normalizedEvent: normalized })
              .where(eq(chatDeliveries.id, context.sourceDelivery.id));
          }
          const attachment = await context.createFile();
          const publication = await context.service.publishBoardMessage(
            context.endpoint.id,
            context.conversation.id,
            "Share the authorized original file",
            `teams-safe-fallback-${randomUUID()}`,
            "owner-user",
            [attachment.id],
          );
          expect(
            await db
              .select()
              .from(chatActions)
              .where(
                and(
                  eq(chatActions.endpointId, context.endpoint.id),
                  eq(chatActions.kind, "teams_board_file_intent"),
                ),
              ),
          ).toEqual([]);
          expect(
            await db
              .select()
              .from(chatTeamsFileTransfers)
              .where(
                eq(chatTeamsFileTransfers.endpointId, context.endpoint.id),
              ),
          ).toEqual([]);
          expect(context.consentCards).toEqual([]);
          expect(context.fileCards).toEqual([]);
          expect(context.uploadRequest).not.toHaveBeenCalled();
          expect(publication.state).toBe("published");
          expect(
            context.runtime.endpoints
              .get(context.endpoint.id)!
              .posts.some((post) => post.text.includes(context.issue.id)),
          ).toBe(true);
        } finally {
          await retirePublicationFixture(context.service, context.endpoint.id);
        }
      },
    );
  });

  describe("Lossless long Board publications", () => {
    async function longFixture(
      provider: "slack" | "github" | "microsoft-teams",
    ) {
      const fixture = await seedCompany();
      const context =
        provider === "slack"
          ? await configuredSlackEndpoint(fixture)
          : provider === "github"
            ? await configuredGitHubEndpoint(fixture)
            : await configuredTeamsEndpoint(fixture);
      try {
        if (provider === "slack") {
          const [principal] = await db.insert(chatExternalPrincipals).values({ companyId: fixture.companyId, provider: "slack", providerAccountId: "T-PAPERCLIP", externalId: "UBOARD" }).returning();
          await db.insert(chatIdentityLinks).values({ companyId: fixture.companyId, endpointId: context.endpoint.id, principalId: principal.id, paperclipUserId: "owner-user", status: "linked", confirmedAt: new Date() });
        }
        const teamsChannel = `teams:${Buffer.from("19:long-publication@thread.tacv2").toString("base64url")}:${Buffer.from("https://smba.trafficmanager.net/amer/").toString("base64url")}`;
        if (provider === "microsoft-teams") {
          await db.insert(chatEndpointResources).values({
            companyId: fixture.companyId,
            endpointId: context.endpoint.id,
            type: "channel",
            providerResourceId: "19:long-publication@thread.tacv2",
            label: "Long publication channel",
            availability: "available",
            enabled: true,
          });
        }
        const channel = makeThread({
          channelId:
            provider === "slack"
              ? "C-LONG-BOARD"
              : provider === "github"
                ? "paperclipai/paperclip"
                : teamsChannel,
          id:
            provider === "slack"
              ? "slack:C-LONG-BOARD:9900.1"
              : provider === "github"
                ? "github:paperclipai/paperclip:issue:9900"
                : `teams:${Buffer.from("19:long-publication@thread.tacv2;messageid=99001").toString("base64url")}:${Buffer.from("https://smba.trafficmanager.net/amer/").toString("base64url")}`,
          name: "long-board",
        });
        await deliverMessage({
          callbacks: context.callbacks,
          endpointId: context.endpoint.id,
          provider,
          thread: channel.thread,
          message: makeMessage({
            id: provider === "slack" ? "9900.1" : "99001",
            text: "@maya begin the long Board publication fixture",
            mentioned: true,
          }),
          trigger: "mention",
        });
        await qualifySetupRoundTrip(context.service, context.endpoint.id);
        await context.service.test(context.endpoint.id);
        const [conversation] = await context.service.listConversations(
          context.endpoint.id,
        );
        if (!conversation)
          throw new Error("Expected long publication conversation");
        const transport = context.runtime.endpoints.get(context.endpoint.id)!;
        transport.posts.length = 0;
        return { ...context, fixture, conversation, transport, channel };
      } catch (error) {
        await retirePublicationFixture(context.service, context.endpoint.id);
        throw error;
      }
    }
    const orderedBatch = (commentId: string) =>
      readChatPublicationsByCommentId(commentId)
        .orderBy(
          asc(chatPublications.createdAt),
          asc(sql`${chatPublications.payload}->'transportPart'->>'orderKey'`),
        );

    it.each([
      ["slack", "new"],
      ["slack", "existing"],
      ["github", "new"],
      ["github", "existing"],
      ["microsoft-teams", "new"],
      ["microsoft-teams", "existing"],
    ] as const)(
      "preserves all 100000 characters for %s %s-comment publication",
      async (provider, source) => {
        const { service, endpoint, conversation, transport } =
          await longFixture(provider);
        try {
          const marker = "END-OF-100000-CHARACTER-BOARD-SEND";
          const body = "a".repeat(100_000 - marker.length) + marker;
          const comment =
            source === "existing"
              ? await issueService(db).addComment(conversation.issueId, body, {
                  userId: "owner-user",
                })
              : null;
          const publication = comment
            ? await service.publishComment(
                endpoint.id,
                conversation.id,
                comment.id,
              )
            : await service.publishBoardMessage(
                endpoint.id,
                conversation.id,
                body,
                "lossless-long-board-send",
                "owner-user",
              );
          for (let drain = 0; drain < 20; drain++)
            await service.processPendingPublications();
          expect(publication?.commentId).toBeTruthy();
          const expectedText = provider === "slack" && source === "new" ? `**Owner User (via Paperclip)**\n\n${body}` : body;
          const rows = await orderedBatch(publication!.commentId!);
          expect(rows.every((row) => row.state === "published")).toBe(true);
          expect(rows.map((row) => row.payload.text).join("") === expectedText).toBe(
            true,
          );
          expect(transport.posts.map((post) => post.text)).toEqual(
            rows.map((row) => renderPublicationTransportText(row.payload)),
          );
          expect(
            transport.posts.every((post) =>
              nativePublicationTextFits(provider, post.text),
            ),
          ).toBe(true);
          expect(rows.map(row => row.payload.text).join("").endsWith(marker)).toBe(true);
          const before = transport.posts.length;
          if (comment)
            await service.publishComment(
              endpoint.id,
              conversation.id,
              comment.id,
            );
          else
            await service.publishBoardMessage(
              endpoint.id,
              conversation.id,
              body,
              "lossless-long-board-send",
              "owner-user",
            );
          expect(transport.posts).toHaveLength(before);
        } finally {
          await retirePublicationFixture(service, endpoint.id);
        }
      },
    );

    it.each(["slack", "github", "microsoft-teams"] as const)(
      "preserves %s code, Unicode and sanitization expansion through actual durable parts",
      async (provider) => {
        const { service, endpoint, conversation, transport } =
          await longFixture(provider);
        try {
          const body =
            "```ts\n" +
            "const answer = '😀';\n".repeat(4_000) +
            "```\n\n" +
            "@here ".repeat(1_000) +
            "END-OF-RICH-BOARD";
          expect(body.length).toBeLessThanOrEqual(100_000);
          const safe = projectSafeChatPublicationText(provider === "slack" ? `**Owner User (via Paperclip)**\n\n${body}` : body);
          const publication = await service.publishBoardMessage(
            endpoint.id,
            conversation.id,
            body,
            "long-rich-board-send",
            "owner-user",
          );
          for (let drain = 0; drain < 20; drain++)
            await service.processPendingPublications();
          const rows = await orderedBatch(publication.commentId!);
          expect(rows.every((row) => row.state === "published")).toBe(true);
          expect(rows.map((row) => row.payload.text).join("") === safe).toBe(
            true,
          );
          expect(transport.posts.map((post) => post.text)).toEqual(
            rows.map((row) => renderPublicationTransportText(row.payload)),
          );
          expect(
            transport.posts.every((post) =>
              nativePublicationTextFits(provider, post.text),
            ),
          ).toBe(true);
          expect(transport.posts.at(-1)?.text).toContain("END-OF-RICH-BOARD");
          expect(JSON.stringify(transport.posts)).not.toContain("@here");
        } finally {
          await retirePublicationFixture(service, endpoint.id);
        }
      },
    );

    it.each(["discord", "telegram"] as const)(
      "retains a complete 100000-character %s response in the existing Markdown document transport",
      async (provider) => {
        const context = await safeNativeProgressFixture(
          provider,
          provider === "discord" ? "811" : "812",
        );
        try {
          await qualifySetupRoundTrip(
            context.service,
            context.endpoint.id,
            provider === "telegram"
              ? context.thread.thread.channelId
              : "U-SAFE-PROGRESS",
          );
          await context.service.test(context.endpoint.id);
          context.providerRuntime.posts.length = 0;
          const marker = "\n```\nEND-OF-COMPLETE-DOCUMENT";
          const body =
            "```txt\n" + "x".repeat(100_000 - marker.length - 7) + marker;
          expect(body.length).toBe(100_000);
          const publication = await context.service.publishBoardMessage(
            context.endpoint.id,
            context.conversation.id,
            body,
            "long-document-board-send",
            "owner-user",
          );
          for (let drain = 0; drain < 5; drain++)
            await context.service.processPendingPublications();
          const rows = await orderedBatch(publication.commentId!);
          expect(rows).toHaveLength(1);
          expect(rows[0]!.state).toBe("published");
          expect(rows[0]!.payload.text).toBe(body);
          expect(rows[0]!.payload.transportPart?.mode).toBe(
            `${provider}_markdown_attachment`,
          );
          expect(context.providerRuntime.posts).toHaveLength(1);
          const post = context.providerRuntime.posts[0]!;
          const upload = (
            provider === "discord" ? post.files?.[0] : post.attachments?.[0]
          ) as { data: Buffer };
          expect(Buffer.isBuffer(upload.data)).toBe(true);
          expect(upload.data.equals(Buffer.from(body))).toBe(true);
          await context.service.processPendingPublications();
          expect(context.providerRuntime.posts).toHaveLength(1);
        } finally {
          await retirePublicationFixture(context.service, context.endpoint.id);
        }
      },
    );

    it.each(["slack", "github"] as const)(
      "keeps an ambiguous %s text part blocked across restart and retries only that part and its tail",
      async (provider) => {
        const { service, endpoint, conversation, transport } =
          await longFixture(provider);
        let restarted: ChatChannelService | undefined;
        try {
          const body = "a".repeat(99_990) + "FINAL-TAIL";
          const expectedText = provider === "slack" ? `**Owner User (via Paperclip)**\n\n${body}` : body;
          let attempts = 0;
          transport.postHook = async () => {
            if (++attempts === 2)
              throw new Error("connection closed after request write");
          };
          const blocked = await service.publishBoardMessage(
            endpoint.id,
            conversation.id,
            body,
            "long-unknown-board-send",
            "owner-user",
          );
          expect(blocked.state).toBe("delivery_unknown");
          const initial = await orderedBatch(blocked.commentId!);
          expect(initial[0]!.state).toBe("published");
          expect(initial[1]!.id).toBe(blocked.id);
          expect(
            initial
              .slice(2)
              .every((row) => row.state === "pending" && row.attempts === 0),
          ).toBe(true);
          expect(attempts).toBe(2);
          await service.shutdown();
          const fresh = createService(new FakeChatSdkRuntime());
          restarted = fresh.service;
          await restarted.processPendingPublications();
          await restarted.processPendingPublications();
          expect(await orderedBatch(blocked.commentId!)).toEqual(initial);
          expect(fresh.runtime.endpoints.get(endpoint.id)?.posts ?? []).toEqual(
            [],
          );
          await expect(
            restarted.replayPublication(endpoint.id, blocked.id),
          ).rejects.toMatchObject({ status: 409 });
          await restarted.resolvePublication(
            endpoint.id,
            blocked.id,
            "retry_anyway",
            "owner-user",
          );
          for (let drain = 0; drain < 20; drain++)
            await restarted.processPendingPublications();
          const final = await orderedBatch(blocked.commentId!);
          expect(final[0]).toEqual(initial[0]);
          expect(final.every((row) => row.state === "published")).toBe(true);
          expect(final[1]!.attempts).toBe(2);
          expect(final.slice(2).every((row) => row.attempts === 1)).toBe(true);
          const resumed = fresh.runtime.endpoints.get(endpoint.id)!.posts;
          expect(final.map(row => row.payload.text).join("")).toBe(expectedText);
          expect([...transport.posts, ...resumed].map(post => post.text)).toEqual(
            final.map(row => renderPublicationTransportText(row.payload)),
          );
          expect(
            (
              await restarted.getPublicationBatchStatus(
                endpoint.id,
                conversation.id,
                initial[0]!.id,
              )
            ).published,
          ).toBe(final.length);
          await restarted.processPendingPublications();
          expect(await orderedBatch(blocked.commentId!)).toEqual(final);
        } finally {
          await service.shutdown();
          await retirePublicationFixture(restarted ?? service, endpoint.id);
        }
      },
    );

    it("preserves an accepted native Slack response whose rendered mentions exceed the Markdown cap", async () => {
      const summary = "@U12345678 ".repeat(1_080) + "NATIVE-END";
      expect(summary.length).toBeLessThan(12_000);
      const context = await committedChatResponseRecoveryFixture(
        "slack",
        "coordinator",
        false,
        undefined,
        () => summary,
      );
      try {
        expect(await context.repair()).toBe(true);
        const [comment] = await db
          .select()
          .from(issueComments)
          .where(eq(issueComments.createdByRunId, context.runId));
        await context.service.processPendingPublications(100);
        const rows = await orderedBatch(comment!.id);
        expect(rows.length).toBeGreaterThan(1);
        expect(rows.every((row) => row.state === "published")).toBe(true);
        expect(rows.map((row) => row.payload.text).join("")).toBe(
          summary.trim(),
        );
        expect(
          rows.every((row) =>
            nativePublicationTextFits(
              "slack",
              renderPublicationTransportText(row.payload),
            ),
          ),
        ).toBe(true);
        expect(await context.repair()).toBe(false);
      } finally {
        await retirePublicationFixture(context.service, context.endpoint.id);
      }
    });

    it.each([
      { prefix: "https://private.example/?token=PRIVATE" },
      { suffix: { token: "PRIVATE" } },
    ])(
      "refuses malformed persisted wrappers before provider I/O %#",
      async (badWrapper) => {
        const { service, endpoint, conversation, transport, fixture } =
          await longFixture("slack");
        try {
          const comment = await issueService(db).addComment(
            conversation.issueId,
            "Safe content",
            { userId: "owner-user" },
          );
          const [publication] = await db
            .insert(chatPublications)
            .values({
              companyId: fixture.companyId,
              endpointId: endpoint.id,
              conversationId: conversation.id,
              issueId: conversation.issueId,
              commentId: comment.id,
              idempotencyKey: `explicit:${comment.id}:${endpoint.id}`,
              state: "pending",
              payload: {
                text: "Safe content",
                transportPart: {
                  batchId: randomUUID(),
                  count: 1,
                  index: 0,
                  orderKey: "fixture:0000",
                  ...badWrapper,
                },
              } as never,
            })
            .returning();
          await service.processPendingPublications();
          expect(transport.posts).toEqual([]);
          const [after] = await readChatPublicationsById(publication!.id);
          expect(after!.state).toBe("failed");
          expect(after!.redactedError).not.toContain("PRIVATE");
          expect(after!.providerMessageId).toBeNull();
        } finally {
          await retirePublicationFixture(service, endpoint.id);
        }
      },
    );
  });

  describe("Telegram retained zero-message admission", () => {
    it.each([
      { state: "received", command: false, source: "zero" },
      { state: "retry", command: false, source: "zero" },
      { state: "processing", command: false, source: "zero" },
      { state: "received", command: true, source: "zero" },
      { state: "retry", command: true, source: "zero" },
      { state: "processing", command: true, source: "zero" },
      { state: "issued", command: false, source: "zero" },
      { state: "issued", command: false, source: "zero_sequence" },
      { state: "retry", command: false, source: "zero_event" },
      { state: "processing", command: false, source: "zero_microseconds" },
      { state: "processing", command: false, source: "zero_locked" },
      { state: "processing", command: false, source: "zero_replaced" },
      { state: "received", command: false, source: "positive" },
      { state: "issued", command: false, source: "positive" },
      { state: "received", command: false, source: "legacy" },
    ] as const)(
      "recovers only ordinary source identity ($state / command=$command / $source)",
      async ({ state, command, source }) => {
        const fixture = await seedCompany();
        const pendingWake = state === "issued";
        const replacedSource = source === "zero_replaced";
        const preparingWake = source === "zero_locked" || replacedSource;
        const seededWake = pendingWake || preparingWake;
        const denied = source.startsWith("zero") && !replacedSource;
        const first = await configuredTelegramEndpoint(fixture, {
          deferWebhookProcessing: !seededWake,
          scheduleDeferredWork: () => undefined,
          ...(seededWake
            ? {
                wakeup: async () => {
                  throw new Error("injected scheduler outage before receipt");
                },
              }
            : {}),
        });
        let restarted: ReturnType<typeof createService> | undefined;
        try {
          await db
            .update(chatEndpoints)
            .set({ status: "active" })
            .where(eq(chatEndpoints.id, first.endpoint.id));
          await db.insert(chatEndpointResources).values({
            companyId: fixture.companyId,
            endpointId: first.endpoint.id,
            type: "chat",
            providerResourceId: "-100123",
            label: "Retained source fixture",
            availability: "available",
            enabled: true,
          });
          const channel = makeThread({
            channelId: "-100123",
            id: "telegram:-100123",
            isDM: false,
          });
          await deliverMessage({
            callbacks: first.callbacks,
            endpointId: first.endpoint.id,
            provider: "telegram",
            thread: channel.thread,
            trigger: "mention",
            message: makeMessage({
              id: "-100123:71",
              text: command
                ? "/task PRIVATE_RETAINED_ZERO_BODY"
                : "@maya PRIVATE_RETAINED_ZERO_BODY",
              mentioned: true,
              userId: "77115580",
              raw: {
                message_id: 71,
                chat: { id: -100123 },
                from: { id: 77115580 },
                date: Math.floor(Date.now() / 1000),
              },
            }),
          });
          const [original] = await readChatDeliveriesByEndpointId(first.endpoint.id);
          expect(original).toMatchObject({
            state: seededWake ? "processed" : "received",
          });
          const actions = await db
            .select()
            .from(chatActions)
            .where(
              and(
                eq(chatActions.deliveryId, original.id),
                eq(chatActions.kind, "inbound_wakeup"),
              ),
            );
          expect(actions).toHaveLength(seededWake ? 1 : 0);
          if (seededWake)
            expect(actions[0]).toMatchObject({ status: "issued" });
          expect(
            await db
              .select()
              .from(agentWakeupRequests)
              .where(eq(agentWakeupRequests.companyId, fixture.companyId)),
          ).toEqual([]);
          await first.service.shutdown();
          expect(first.runtime.get(first.endpoint.id)).toBeNull();
          // Simulate a receipt saved by an older process. No current runtime
          // callback supplies raw message_id during either recovery path.
          const messageId =
            source === "zero" || source === "zero_microseconds" || preparingWake
              ? "-100123:0"
              : source === "legacy"
                ? "legacy-message"
                : "-100123:71";
          const eventId = `${channel.thread.id}:${source === "zero_event" ? "-100123:0" : messageId}`;
          const normalized = original.normalizedEvent as {
            message: Record<string, unknown>;
          };
          const retained = {
            ...original.normalizedEvent,
            providerEventId: eventId,
            message: {
              ...normalized.message,
              providerMessageId: messageId,
              providerMessageSequence:
                source === "zero_sequence"
                  ? 0
                  : source === "legacy" || source === "zero"
                    ? null
                    : 71,
            },
          };
          await db
            .update(chatDeliveries)
            .set({
              providerEventId: eventId,
              normalizedEvent: retained,
              state: pendingWake
                ? "processed"
                : (state as "received" | "retry" | "processing"),
              nextAttemptAt: new Date(0),
              updatedAt: new Date(0),
            })
            .where(eq(chatDeliveries.id, original.id));
          if (source === "zero_microseconds") {
            await db.execute(
              sql`update chat_deliveries set updated_at = '2026-09-01 12:00:00.123456+00'::timestamptz where id = ${original.id}::uuid`,
            );
            expect(
              await db
                .select({
                  micros: sql<string>`to_char(${chatDeliveries.updatedAt}, 'US')`,
                })
                .from(chatDeliveries)
                .where(eq(chatDeliveries.id, original.id)),
            ).toEqual([{ micros: "123456" }]);
          }
          if (seededWake) {
            await db
              .update(chatActions)
              .set({
                ...(preparingWake ? { status: "preparing" } : {}),
                result: {
                  code: "inbound_wakeup_retry",
                  retryAt: new Date(0).toISOString(),
                },
              })
              .where(eq(chatActions.id, actions[0]!.id));
            await db
              .update(chatMessageLinks)
              .set({ providerMessageId: messageId })
              .where(eq(chatMessageLinks.deliveryId, original.id));
          }
          const commentsBefore = await readIssueCommentsByCompanyId(fixture.companyId);
          const issuesBefore = await readIssuesByCompanyId(fixture.companyId);
          const publicationsBefore = await db
            .select()
            .from(chatPublications)
            .where(eq(chatPublications.companyId, fixture.companyId));
          restarted = createService(
            new FakeChatSdkRuntime(),
            fakeTelegramFetch() as typeof globalThis.fetch,
            { scheduleDeferredWork: () => undefined },
          );
          if (preparingWake) {
            const replacement = {
              ...retained,
              providerEventId: `${channel.thread.id}:-100123:71`,
              message: {
                ...retained.message,
                providerMessageId: "-100123:71",
                providerMessageSequence: 71,
              },
            };
            let release!: () => void;
            let acquired!: () => void;
            const held = new Promise<void>((resolve) => {
              release = resolve;
            });
            const locked = new Promise<void>((resolve) => {
              acquired = resolve;
            });
            const owner = db.transaction(async (tx) => {
              await tx
                .select()
                .from(chatDeliveries)
                .where(eq(chatDeliveries.id, original.id))
                .for("update");
              await tx
                .update(chatDeliveries)
                .set({
                  updatedAt: new Date(),
                  ...(replacedSource
                    ? {
                        providerEventId: replacement.providerEventId,
                        normalizedEvent: replacement,
                      }
                    : {}),
                })
                .where(eq(chatDeliveries.id, original.id));
              if (replacedSource)
                await tx
                  .update(chatMessageLinks)
                  .set({ providerMessageId: "-100123:71" })
                  .where(eq(chatMessageLinks.deliveryId, original.id));
              acquired();
              await held;
            });
            await locked;
            let drain: Promise<unknown> | undefined;
            let deadline: ReturnType<typeof setTimeout> | undefined;
            try {
              drain = restarted.service.processPendingDeliveries(
                25,
                original.id,
              );
              await Promise.race([
                drain,
                new Promise<never>((_resolve, reject) => {
                  deadline = setTimeout(
                    () =>
                      reject(
                        new Error(
                          "held claim must stop the drain without waiting",
                        ),
                      ),
                    1500,
                  );
                }),
              ]);
              expect(
                await db
                  .select({ state: chatDeliveries.state })
                  .from(chatDeliveries)
                  .where(eq(chatDeliveries.id, original.id)),
              ).toEqual([{ state: "processing" }]);
              expect(
                await db
                  .select({ status: chatActions.status })
                  .from(chatActions)
                  .where(eq(chatActions.id, actions[0]!.id)),
              ).toEqual([{ status: "preparing" }]);
              expect(restarted.wakeup).not.toHaveBeenCalled();
            } finally {
              if (deadline) clearTimeout(deadline);
              release();
              await owner;
              await drain;
            }
            // The newly committed live claim remains owned; filtering must
            // not continue from the stale pre-lock candidate snapshot.
            await restarted.service.processPendingDeliveries(25, original.id);
            if (replacedSource)
              expect(
                await db
                  .select({ normalizedEvent: chatDeliveries.normalizedEvent })
                  .from(chatDeliveries)
                  .where(eq(chatDeliveries.id, original.id)),
              ).toEqual([{ normalizedEvent: replacement }]);
            expect(
              await db
                .select({ status: chatActions.status })
                .from(chatActions)
                .where(eq(chatActions.id, actions[0]!.id)),
            ).toEqual([{ status: "preparing" }]);
            await db.execute(
              sql`update chat_deliveries set updated_at = '2026-09-01 12:00:00.123456+00'::timestamptz where id = ${original.id}::uuid`,
            );
          }
          await restarted.service.processPendingDeliveries(25, original.id);
          const [settled] = await readChatDeliveriesById(original.id);
          if (denied) {
            expect(restarted.wakeup).not.toHaveBeenCalled();
            expect(settled).toMatchObject({
              state: pendingWake ? "processed" : "filtered",
            });
            expect(settled.normalizedEvent).toEqual(retained);
            expect(settled.redactedError).not.toContain(
              "PRIVATE_RETAINED_ZERO_BODY",
            );
            expect(
              await readIssueCommentsByCompanyId(fixture.companyId),
            ).toEqual(commentsBefore);
            expect(
              await readIssuesByCompanyId(fixture.companyId),
            ).toEqual(issuesBefore);
            expect(
              await db
                .select()
                .from(chatPublications)
                .where(eq(chatPublications.companyId, fixture.companyId)),
            ).toEqual(publicationsBefore);
            if (seededWake)
              expect(
                await readChatActionsById(actions[0]!.id),
              ).toEqual([
                expect.objectContaining({
                  status: "failed",
                  payload: actions[0]!.payload,
                  result: expect.objectContaining({
                    code: preparingWake
                      ? "inbound_wakeup_delivery_rejected"
                      : "inbound_wakeup_authorization_changed",
                  }),
                }),
              ]);
            for (const runtime of restarted.runtime.endpoints.values()) {
              expect(runtime.posts).toEqual([]);
              expect(runtime.reactions).toEqual([]);
              expect(runtime.rehydratedAttachmentDescriptors).toEqual([]);
            }
          } else {
            expect(restarted.wakeup).toHaveBeenCalledOnce();
            expect(settled.state).toBe("processed");
          }
          expect(
            await db
              .select()
              .from(agentWakeupRequests)
              .where(eq(agentWakeupRequests.companyId, fixture.companyId)),
          ).toHaveLength(denied ? 0 : 1);
          expect(
            await readHeartbeatRunsByCompanyId(fixture.companyId),
          ).toEqual([]);
          await restarted.service.processPendingDeliveries(25, original.id);
          expect(restarted.wakeup).toHaveBeenCalledTimes(denied ? 0 : 1);
          if (denied)
            expect(
              await readChatDeliveriesById(original.id),
            ).toEqual([settled]);
        } finally {
          try {
            await retirePublicationFixture(
              restarted?.service ?? first.service,
              first.endpoint.id,
            );
          } finally {
            await first.service.shutdown();
          }
        }
      },
    );
  });
});
