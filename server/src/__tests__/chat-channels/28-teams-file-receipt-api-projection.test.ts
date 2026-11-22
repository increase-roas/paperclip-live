
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import request, {  } from "supertest";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { activityLog, agentWakeupRequests, chatActions, chatConversations, chatDeliveries, chatEndpointLeases, chatEndpointResources, chatEndpoints, chatExternalPrincipals, chatMessageLinks, chatPublications, chatTeamsFileTransfers, issueComments, issues } from "@paperclipai/db";
import { type ChatChannelService } from "../../services/chat-channels.js";
import { issueService } from "../../services/issues.js";
import { FakeChatSdkRuntime, makeMessage, makeThread, routesApp } from ".././helpers/chat-channels-fixture.js";
import { acceptedUnknownSlackFileReceipt, configuredDiscordEndpoint, configuredSlackEndpoint, configuredTeamsEndpoint, createService, createStorageService, db, deliverMessage, describeChatChannelsSuite, qualifySetupRoundTrip, readChatEndpointsById, readChatPublicationsByCommentId, readIssueCommentsByCompanyId, readIssuesById, readToolConnectionsById, retirePublicationFixture, seedCompany } from "../helpers/chat-channels-harness.js";








describeChatChannelsSuite("chat channels 28-teams-file-receipt-api-projection", () => {
  describe("Teams file receipt API projection", () => {
    type Part = {
      state?: typeof chatPublications.$inferInsert.state;
      transfer?: Partial<typeof chatTeamsFileTransfers.$inferInsert>;
    };

    async function projectionFixture(active = false) {
      const company = await seedCompany();
      const providerFetch = vi.fn(async () => {
        throw new Error("Projection GET must not contact a provider");
      });
      const configured = active ? await configuredTeamsEndpoint(company) : null;
      const context =
        configured ?? createService(new FakeChatSdkRuntime(), providerFetch);
      const endpoint =
        configured?.endpoint ??
        (await context.service.create(
          company.companyId,
          {
            provider: "microsoft-teams",
            assignedAgentId: company.assignedAgentId,
            name: "Read-only Teams file receipt fixture",
          },
          "owner-user",
        ));
      let issue: typeof issues.$inferSelect | undefined;
      let conversation: typeof chatConversations.$inferSelect | undefined;
      if (!configured) {
        [issue] = await db
          .insert(issues)
          .values({
            companyId: company.companyId,
            title: "Seeded file receipt projection",
            status: "backlog",
          })
          .returning();
        [conversation] = await db
          .insert(chatConversations)
          .values({
            companyId: company.companyId,
            endpointId: endpoint.id,
            issueId: issue!.id,
            externalConversationId: `teams:projection:${randomUUID()}`,
            externalLabel: "Synthetic personal conversation",
            isDirectMessage: true,
          })
          .returning();
      }
      if (configured) {
        const providerConversationId = `19:projection-${randomUUID()}@thread.tacv2`;
        const serviceUrl = "https://smba.trafficmanager.net/amer/";
        const rootMessageId = "1740000000991";
        const channel = makeThread({
          channelId: `teams:${Buffer.from(providerConversationId).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
          id: `teams:${Buffer.from(`${providerConversationId};messageid=${rootMessageId}`).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
          name: "Active projection fixture",
        });
        await deliverMessage({
          callbacks: configured.callbacks,
          endpointId: endpoint.id,
          provider: "microsoft-teams",
          thread: channel.thread,
          message: makeMessage({
            id: rootMessageId,
            text: "@maya verify this active publication fixture",
            mentioned: true,
          }),
          trigger: "mention",
        });
        await qualifySetupRoundTrip(context.service, endpoint.id);
        await context.service.test(endpoint.id);
        [conversation] = await db
          .select()
          .from(chatConversations)
          .where(
            and(
              eq(chatConversations.endpointId, endpoint.id),
              eq(chatConversations.externalThreadId, channel.thread.id),
            ),
          );
        if (!conversation)
          throw new Error("Expected admitted active Teams conversation");
        [issue] = await readIssuesById(conversation.issueId);
        await expect(context.service.get(endpoint.id)).resolves.toMatchObject({
          status: "active",
        });
      }
      const [principal] = await db
        .insert(chatExternalPrincipals)
        .values({
          companyId: company.companyId,
          provider: "microsoft-teams",
          providerAccountId: randomUUID(),
          externalId: `projection-user-${randomUUID()}`,
        })
        .returning();
      const batch = async (parts: Part[]) => {
        const [comment] = await db
          .insert(issueComments)
          .values({
            companyId: company.companyId,
            issueId: issue!.id,
            authorUserId: "owner-user",
            body: "PRIVATE-COMMENT-PROJECTION-CANARY",
          })
          .returning();
        const publications: Array<typeof chatPublications.$inferSelect> = [];
        for (const [index, part] of parts.entries()) {
          const [publication] = await db
            .insert(chatPublications)
            .values({
              companyId: company.companyId,
              endpointId: endpoint.id,
              conversationId: conversation!.id,
              issueId: issue!.id,
              commentId: comment!.id,
              idempotencyKey: `projection:${randomUUID()}:${index}`,
              payload: { text: "PRIVATE-PAYLOAD-PROJECTION-CANARY" },
              state: part.state ?? "published",
              providerMessageId: `PRIVATE-CARD-PROJECTION-CANARY-${index}`,
              attempts: 1,
              createdAt: new Date(Date.now() + index),
            })
            .returning();
          publications.push(publication!);
          if (part.transfer) {
            await db.insert(chatTeamsFileTransfers).values({
              companyId: company.companyId,
              endpointId: endpoint.id,
              conversationId: conversation!.id,
              publicationId: publication!.id,
              issueId: issue!.id,
              commentId: comment!.id,
              attachmentId: randomUUID(),
              principalId: principal!.id,
              authorizedUserId: "owner-user",
              runtimeGeneration: 1,
              credentialFingerprint: "PRIVATE-FINGERPRINT-PROJECTION-CANARY",
              conversationGeneration: 1,
              sourceDigest: "1".repeat(64),
              authorityDigest: "2".repeat(64),
              tenantId: randomUUID(),
              botAppId: randomUUID(),
              aadObjectId: randomUUID(),
              providerConversationId: "PRIVATE-CONVERSATION-PROJECTION-CANARY",
              providerUserId: "PRIVATE-USER-PROJECTION-CANARY",
              sha256: "3".repeat(64),
              byteSize: 12,
              filename: `report-${index}.txt`,
              tokenSha256: createHash("sha256")
                .update(randomUUID())
                .digest("hex"),
              phase: "awaiting_consent",
              version: 2,
              consentMessageId: `PRIVATE-CARD-PROJECTION-CANARY-${index}`,
              expiresAt: new Date(
                Date.now() +
                  (part.transfer.phase === "expired" ? -60_000 : 600_000),
              ),
              privateState: {
                schema: "synthetic-private-state",
                ciphertext: "PRIVATE-CIPHERTEXT-PROJECTION-CANARY",
                uploadUrl:
                  "https://private.invalid/upload?token=PRIVATE-TOKEN-PROJECTION-CANARY",
                contentUrl:
                  "https://private.invalid/PRIVATE-CONTENT-PROJECTION-CANARY",
              },
              ...part.transfer,
            });
          }
        }
        return publications;
      };
      const snapshot = async () => ({
        publications: await db
          .select()
          .from(chatPublications)
          .where(eq(chatPublications.companyId, company.companyId))
          .orderBy(asc(chatPublications.id)),
        transfers: await db
          .select()
          .from(chatTeamsFileTransfers)
          .where(eq(chatTeamsFileTransfers.companyId, company.companyId))
          .orderBy(asc(chatTeamsFileTransfers.id)),
        comments: await readIssueCommentsByCompanyId(company.companyId)
          .orderBy(asc(issueComments.id)),
        actions: await db
          .select()
          .from(chatActions)
          .where(eq(chatActions.companyId, company.companyId))
          .orderBy(asc(chatActions.id)),
        deliveries: await db
          .select()
          .from(chatDeliveries)
          .where(eq(chatDeliveries.companyId, company.companyId))
          .orderBy(asc(chatDeliveries.id)),
        links: await db
          .select()
          .from(chatMessageLinks)
          .where(eq(chatMessageLinks.companyId, company.companyId))
          .orderBy(asc(chatMessageLinks.id)),
        wakes: await db
          .select()
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.companyId, company.companyId))
          .orderBy(asc(agentWakeupRequests.id)),
        audit: await db
          .select()
          .from(activityLog)
          .where(eq(activityLog.companyId, company.companyId))
          .orderBy(asc(activityLog.id)),
      });
      const statusPath = (publicationId: string) =>
        `/api/chat-endpoints/${endpoint.id}/conversations/${conversation!.id}/publications/${publicationId}/status`;
      const read = async (publicationId: string) => {
        const before = await snapshot();
        const app = routesApp(db, company.companyId, context.service);
        // Own one ready loopback listener for both reads. Creating and closing
        // a separate implicit Supertest listener per GET can reset the TCP
        // connection before Express receives it under the loaded macOS suite.
        const server = createServer(app);
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
          });
        });
        const { status, activity } = await (async () => {
          try {
            const status = await request(server)
              .get(statusPath(publicationId))
              .expect(200);
            const activity = await request(server)
              .get(`/api/chat-endpoints/${endpoint.id}/activity`)
              .expect(200);
            return { status, activity };
          } finally {
            await new Promise<void>((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()));
            });
          }
        })();
        expect(status.body).toEqual(
          await context.service.getPublicationBatchStatus(
            endpoint.id,
            conversation!.id,
            publicationId,
          ),
        );
        expect(activity.body).toEqual(
          await context.service.listActivity(endpoint.id),
        );
        const serialized = JSON.stringify([status.body, activity.body]);
        expect(serialized).not.toMatch(
          /PROJECTION-CANARY|https?:|ciphertext|privateState|uploadUrl|contentUrl|tokenSha256|consentMessageId|fileInfoMessageId|responseActivityId|providerMessageId/,
        );
        expect(await snapshot()).toEqual(before);
        expect(providerFetch).not.toHaveBeenCalled();
        expect(context.wakeup).not.toHaveBeenCalled();
        expect(context.cancelRun).not.toHaveBeenCalled();
        expect(context.runtime.endpoints.size).toBe(0);
        return {
          status: status.body,
          activity: activity.body as Array<Record<string, unknown>>,
        };
      };
      return {
        ...company,
        ...context,
        endpoint,
        conversation: conversation!,
        principal: principal!,
        issue: issue!,
        batch,
        snapshot,
        read,
        statusPath,
      };
    }

    // These are persisted-state/API proofs, not provider upload or tenant-auth
    // proofs. No worker is started; every GET must preserve all seeded rows.
    it("projects mixed delivered, declined, expired and cancelled file outcomes without making GET effects", async () => {
      const fixture = await projectionFixture();
      try {
        const parts = await fixture.batch([
          {},
          {
            transfer: {
              phase: "delivered",
              fileInfoMessageId: "PRIVATE-FILE-RECEIPT-PROJECTION-CANARY",
            },
          },
          {
            transfer: {
              phase: "declined",
              responseActivityId: "PRIVATE-DECLINE-PROJECTION-CANARY",
            },
          },
          { transfer: { phase: "expired" } },
          {
            transfer: { phase: "cancelled", reason: "cancelled_after_upload" },
          },
        ]);
        const { status, activity } = await fixture.read(parts[0]!.id);
        expect(status).toMatchObject({
          total: 5,
          published: 2,
          declined: 1,
          expired: 1,
          cancelled: 1,
          settled: 5,
          awaitingConsent: 0,
          canDismiss: true,
          publication: { id: parts[2]!.id, state: "cancelled" },
        });
        expect(
          status.parts.map((part: { id: string; state: string }) => [
            part.id,
            part.state,
          ]),
        ).toEqual(
          parts.map((part, index) => [
            part.id,
            index < 2 ? "published" : "cancelled",
          ]),
        );
        expect(
          activity
            .filter((item) => parts.some((part) => part.id === item.id))
            .map((item) => item.status)
            .sort(),
        ).toEqual([
          "cancelled",
          "cancelled",
          "cancelled",
          "published",
          "published",
        ]);
        for (const item of activity) {
          expect(item.replayable).toBe(false);
          expect(item.resolutionActions).toEqual([]);
        }
      } finally {
        await fixture.service.shutdown();
      }
    });

    it("keeps a cancelled head locked while a consent-card receipt waits for the file tail", async () => {
      const fixture = await projectionFixture();
      try {
        const [head, tail] = await fixture.batch([
          { state: "cancelled" },
          { transfer: {} },
        ]);
        const { status, activity } = await fixture.read(head!.id);
        expect(status).toMatchObject({
          total: 2,
          published: 0,
          declined: 0,
          expired: 0,
          cancelled: 1,
          settled: 1,
          awaitingConsent: 1,
          canDismiss: false,
          publication: { id: tail!.id, state: "awaiting_consent" },
        });
        expect(activity.find((item) => item.id === tail!.id)).toMatchObject({
          status: "awaiting_consent",
          replayable: false,
          resolutionActions: [],
          fileTransfer: {
            phase: "awaiting_consent",
            version: 2,
            filename: "report-1.txt",
          },
        });
      } finally {
        await fixture.service.shutdown();
      }
    });

    it("preserves all-published legacy batches without transfer metadata and excludes other comments", async () => {
      const fixture = await projectionFixture();
      try {
        const parts = await fixture.batch([{}, {}]);
        await fixture.batch([{ state: "pending" }]);
        const { status } = await fixture.read(parts[0]!.id);
        expect(status).toMatchObject({
          total: 2,
          published: 2,
          declined: 0,
          expired: 0,
          cancelled: 0,
          settled: 2,
          awaitingConsent: 0,
          canDismiss: true,
          publication: { id: parts[1]!.id, state: "published" },
        });
        expect(status.parts.map((part: { id: string }) => part.id)).toEqual(
          parts.map((part) => part.id),
        );
        for (const part of status.parts)
          expect(part).not.toHaveProperty("fileTransfer");
      } finally {
        await fixture.service.shutdown();
      }
    });

    it.each([
      ["delivered without file receipt", { phase: "delivered" }],
      [
        "waiting without card receipt",
        { phase: "awaiting_consent", consentMessageId: null },
      ],
      ["declined without response receipt", { phase: "declined" }],
      [
        "malformed filename",
        {
          phase: "delivered",
          filename: "",
          fileInfoMessageId: "PRIVATE-FILE-PROJECTION-CANARY",
        },
      ],
      [
        "wrong-stage operator receipt",
        {
          phase: "delivered",
          privateState: {
            resolution: {
              schema: "paperclip.teams.file-resolution.v1",
              action: "mark_delivered",
              fromPhase: "upload_unknown",
            },
          },
        },
      ],
    ] satisfies Array<
      [string, Partial<typeof chatTeamsFileTransfers.$inferInsert>]
    >)(
      "refuses terminal success or actions for %s",
      async (_label, transfer) => {
        const fixture = await projectionFixture();
        try {
          const [part] = await fixture.batch([{ transfer }]);
          const { status, activity } = await fixture.read(part!.id);
          expect(status).toMatchObject({
            total: 1,
            published: 0,
            settled: 0,
            awaitingConsent: 0,
            canDismiss: false,
            publication: { id: part!.id, state: "delivery_unknown" },
          });
          expect(activity).toEqual([
            expect.objectContaining({
              id: part!.id,
              status: "delivery_unknown",
              replayable: false,
              resolutionActions: [],
            }),
          ]);
        } finally {
          await fixture.service.shutdown();
        }
      },
    );

    it.each([
      ["consent_unknown", ["cancel"]],
      ["upload_unknown", ["cancel"]],
      ["file_info_unknown", ["mark_delivered", "retry_anyway", "cancel"]],
      ["conflict", []],
    ] as const)(
      "offers only the exact %s stage actions",
      async (phase, actions) => {
        const fixture = await projectionFixture();
        try {
          const [part] = await fixture.batch([{ transfer: { phase } }]);
          const { status, activity } = await fixture.read(part!.id);
          expect(status).toMatchObject({
            published: 0,
            settled: 0,
            canDismiss: false,
            publication: { state: "delivery_unknown" },
          });
          expect(activity).toEqual([
            expect.objectContaining({
              id: part!.id,
              replayable: false,
              resolutionActions: actions,
              fileTransfer: {
                provider: "microsoft-teams",
                phase,
                version: 2,
                filename: "report-0.txt",
                expiresAt: expect.any(String),
              },
            }),
          ]);
        } finally {
          await fixture.service.shutdown();
        }
      },
    );

    it("requires exact endpoint, conversation, publication and Board company scope", async () => {
      const fixture = await projectionFixture();
      const other = await projectionFixture();
      try {
        const [part] = await fixture.batch([{ transfer: {} }]);
        const [foreign] = await other.batch([{ transfer: {} }]);
        const app = routesApp(db, fixture.companyId, fixture.service);
        const before = await fixture.snapshot();
        await request(app).get(fixture.statusPath(foreign!.id)).expect(404);
        await request(app)
          .get(
            fixture
              .statusPath(part!.id)
              .replace(fixture.conversation.id, other.conversation.id),
          )
          .expect(404);
        // Cross-company resources are deliberately concealed as not found.
        await request(app).get(other.statusPath(part!.id)).expect(404);
        await request(app)
          .get(`/api/chat-endpoints/${other.endpoint.id}/activity`)
          .expect(404);
        expect(await fixture.snapshot()).toEqual(before);
        const { status, activity } = await fixture.read(part!.id);
        expect(status.total).toBe(1);
        expect(activity.map((item) => item.id)).toEqual([part!.id]);
        expect(JSON.stringify([status, activity])).not.toContain(foreign!.id);
      } finally {
        try {
          await fixture.service.shutdown();
        } finally {
          await other.service.shutdown();
        }
      }
    });

    it("never projects a transfer from another conversation into Activity", async () => {
      const fixture = await projectionFixture();
      try {
        const [otherConversation] = await db
          .insert(chatConversations)
          .values({
            companyId: fixture.companyId,
            endpointId: fixture.endpoint.id,
            issueId: fixture.issue.id,
            externalConversationId: `teams:other:${randomUUID()}`,
            externalLabel: "Different conversation",
          })
          .returning();
        const [part] = await fixture.batch([
          {
            state: "pending",
            transfer: {
              conversationId: otherConversation!.id,
              phase: "file_info_unknown",
              filename: "WRONG-CONVERSATION-FILE.txt",
            },
          },
        ]);
        const { status, activity } = await fixture.read(part!.id);
        expect(status).toMatchObject({
          publication: { state: "pending" },
          canDismiss: false,
        });
        expect(status.publication).not.toHaveProperty("fileTransfer");
        expect(activity).toEqual([
          expect.objectContaining({
            id: part!.id,
            status: "pending",
            replayable: false,
            resolutionActions: [],
          }),
        ]);
        expect(activity[0]).not.toHaveProperty("fileTransfer");
      } finally {
        await fixture.service.shutdown();
      }
    });

    it.each([
      ["missing", undefined],
      ["wrong phase", { phase: "upload_unknown", version: 2 }],
      ["stale version", { phase: "file_info_unknown", version: 1 }],
    ] as const)(
      "refuses generic resolution with %s transfer preconditions without changing receipts",
      async (_label, fileTransfer) => {
        const fixture = await projectionFixture();
        try {
          const [part] = await fixture.batch([
            {
              state: "delivery_unknown",
              transfer: { phase: "file_info_unknown" },
            },
          ]);
          const before = await fixture.snapshot();
          const app = routesApp(db, fixture.companyId, fixture.service);
          // A missing or stale transfer hint must never fall through to ordinary
          // message retry, mark-delivered, or cancellation.
          for (const action of [
            "mark_delivered",
            "retry_anyway",
            "cancel",
          ] as const) {
            const response = await request(app)
              .post(
                `/api/chat-endpoints/${fixture.endpoint.id}/publications/${part!.id}/resolve`,
              )
              .send({ action, ...(fileTransfer ? { fileTransfer } : {}) })
              .expect(409);
            expect(response.body).toMatchObject({
              code: "chat_file_transfer_resolution_required",
            });
            await expect(
              fixture.service.resolvePublication(
                fixture.endpoint.id,
                part!.id,
                action,
                "owner-user",
                fileTransfer,
              ),
            ).rejects.toMatchObject({
              status: 409,
              details: { code: "chat_file_transfer_resolution_required" },
            });
            expect(await fixture.snapshot()).toEqual(before);
          }
          await fixture.read(part!.id);
        } finally {
          await fixture.service.shutdown();
        }
      },
    );

    it("refuses generic replay of a failed transfer without another provider attempt", async () => {
      const fixture = await projectionFixture();
      try {
        const [part] = await fixture.batch([
          { state: "failed", transfer: { phase: "consent_pending" } },
        ]);
        const before = await fixture.snapshot();
        const response = await request(
          routesApp(db, fixture.companyId, fixture.service),
        )
          .post(
            `/api/chat-endpoints/${fixture.endpoint.id}/publications/${part!.id}/replay`,
          )
          .expect(409);
        expect(response.body).toMatchObject({
          code: "chat_file_transfer_resolution_required",
        });
        await expect(
          fixture.service.replayPublication(fixture.endpoint.id, part!.id),
        ).rejects.toMatchObject({
          status: 409,
          details: { code: "chat_file_transfer_resolution_required" },
        });
        expect(await fixture.snapshot()).toEqual(before);
        const { activity } = await fixture.read(part!.id);
        expect(activity).toEqual([
          expect.objectContaining({
            id: part!.id,
            replayable: false,
            resolutionActions: [],
          }),
        ]);
      } finally {
        await fixture.service.shutdown();
      }
    });

    it("does not treat a caller-only transfer hint as ordinary delivery authority", async () => {
      const fixture = await projectionFixture();
      try {
        const [part] = await fixture.batch([{ state: "delivery_unknown" }]);
        const before = await fixture.snapshot();
        const response = await request(
          routesApp(db, fixture.companyId, fixture.service),
        )
          .post(
            `/api/chat-endpoints/${fixture.endpoint.id}/publications/${part!.id}/resolve`,
          )
          .send({
            action: "mark_delivered",
            fileTransfer: { phase: "file_info_unknown", version: 2 },
          })
          .expect(409);
        expect(response.body).toMatchObject({
          code: "chat_file_transfer_resolution_required",
        });
        expect(await fixture.snapshot()).toEqual(before);
        await fixture.read(part!.id);
      } finally {
        await fixture.service.shutdown();
      }
    });

    it.each(["draft", "verifying", "paused", "attention", "archived"] as const)(
      "does not consume a worker slot for a pending Teams transfer on a %s endpoint",
      async (status) => {
        const fixture = await projectionFixture();
        try {
          // Settle unrelated fixture work before arming this exact inactive
          // candidate. The transfer must not enter either publication worker.
          await fixture.service.processPendingPublications();
          await db
            .update(chatEndpoints)
            .set({ status })
            .where(eq(chatEndpoints.id, fixture.endpoint.id));
          const [part] = await fixture.batch([
            { state: "pending", transfer: { phase: "consent_pending" } },
          ]);
          const [endpointBefore] = await readChatEndpointsById(fixture.endpoint.id);
          expect(endpointBefore?.status).toBe(status);
          const before = await fixture.snapshot();
          await expect(
            fixture.service.processPendingPublications(1),
          ).resolves.toBe(0);
          await expect(
            fixture.service.processPendingPublications(1),
          ).resolves.toBe(0);
          expect(await fixture.snapshot()).toEqual(before);
          await expect(
            readChatEndpointsById(fixture.endpoint.id),
          ).resolves.toEqual([endpointBefore]);
          expect(fixture.runtime.replaceCount).toBe(0);
          // Also checks zero provider requests, runtime creation, wakeups, and
          // cancellation calls, with no projection/read-side mutations.
          await fixture.read(part!.id);
        } finally {
          await fixture.service.shutdown();
        }
      },
    );

    it.each(["pending", "streaming"] as const)(
      "generic publication worker ignores an existing %s Teams transfer on an active endpoint",
      async (state) => {
        const fixture = await projectionFixture(true);
        try {
          // Finish setup's ordinary outbox work before arming the transfer.
          await fixture.service.processPendingPublications();
          const ordinaryControl = await fixture.service.publishBoardMessage(
            fixture.endpoint.id,
            fixture.conversation.id,
            "Ordinary publication control before transfer ownership",
            `teams-worker-control-${randomUUID()}`,
            "owner-user",
          );
          expect(ordinaryControl.state).toBe("published");
          const [part] = await fixture.batch([
            {
              state,
              transfer: {
                phase:
                  state === "pending" ? "consent_pending" : "consent_sending",
                ...(state === "streaming"
                  ? {
                      attemptId: randomUUID(),
                      attemptExpiresAt: new Date(Date.now() + 90_000),
                    }
                  : {}),
              },
            },
          ]);
          if (state === "streaming")
            await db
              .update(chatPublications)
              .set({ updatedAt: new Date(Date.now() - 61_000) })
              .where(eq(chatPublications.id, part!.id));
          await expect(
            fixture.service.get(fixture.endpoint.id),
          ).resolves.toMatchObject({
            status: "active",
            setup: { step: "complete" },
          });
          const [connection] = await readToolConnectionsById(fixture.endpoint.connectionId);
          expect(connection).toMatchObject({
            status: "active",
            enabled: true,
          });
          const providerRuntime = fixture.runtime.endpoints.get(
            fixture.endpoint.id,
          );
          expect(providerRuntime).toBeDefined();
          // An actual ordinary provider post succeeded before the transfer was
          // seeded. An inactive fixture cannot satisfy this proof.
          expect(providerRuntime!.posts.length).toBeGreaterThan(0);
          const postsBefore = [...providerRuntime!.posts];
          const before = await fixture.snapshot();
          await fixture.service.processPendingPublications();
          expect(await fixture.snapshot()).toEqual(before);
          expect(providerRuntime!.posts).toEqual(postsBefore);
        } finally {
          await retirePublicationFixture(fixture.service, fixture.endpoint.id);
        }
      },
    );
  });

  it.each(["slack", "discord"] as const)(
    "preserves a published %s file prefix across restart and retries only an explicitly resolved ambiguous upload",
    async (provider) => {
      const fixture = await seedCompany();
      const storage = createStorageService();
      const { callbacks, endpoint, runtime, service } =
        provider === "slack"
          ? await configuredSlackEndpoint(fixture, {
        linkedBoardUser: true, storage: storage.storage })
          : await configuredDiscordEndpoint(fixture, {
              storage: storage.storage,
            });
      let restarted: ChatChannelService | undefined;
      try {
        const channel = makeThread({
          channelId:
            provider === "slack" ? "C-PARTIAL-FILES" : "333333333333332811",
          id:
            provider === "slack"
              ? "slack:C-PARTIAL-FILES:4400.81"
              : "discord:1457808928258658549:333333333333332811:555555555555552811",
          name: "partial-files-restart",
        });
        await deliverMessage({
          callbacks,
          endpointId: endpoint.id,
          provider,
          thread: channel.thread,
          message: makeMessage({
            id: provider === "slack" ? "4400.81" : "555555555555552811",
            text: "@maya prepare the selected file batch",
            mentioned: true,
          }),
          trigger: "mention",
        });
        await qualifySetupRoundTrip(service, endpoint.id);
        await service.test(endpoint.id);
        const [conversation] = await service.listConversations(endpoint.id);
        if (!conversation)
          throw new Error("Expected partial-file conversation");
        const attachmentIds: string[] = [];
        const bodies = [1, 2, 3].map((index) =>
          Buffer.from(`exact selected file ${index}`, "utf8"),
        );
        for (const [index, body] of bodies.entries()) {
          const stored = await storage.storage.putFile({
            companyId: fixture.companyId,
            namespace: `issues/${conversation.issueId}`,
            originalFilename: `selected-${index + 1}.txt`,
            contentType: "text/plain",
            body,
          });
          const attachment = await issueService(db).createAttachment({
            issueId: conversation.issueId,
            provider: stored.provider,
            objectKey: stored.objectKey,
            contentType: stored.contentType,
            byteSize: stored.byteSize,
            sha256: stored.sha256,
            originalFilename: stored.originalFilename,
            createdByUserId: "owner-user",
          });
          attachmentIds.push(attachment.id);
        }
        const initialRuntime = runtime.endpoints.get(endpoint.id);
        if (!initialRuntime)
          throw new Error("Expected initial provider runtime");
        initialRuntime.posts.length = 0;
        initialRuntime.postResultIds.push("1789000.000001", "1789000.000002");
        let initialAttempts = 0;
        initialRuntime.postHook = async () => {
          initialAttempts += 1;
          if (initialAttempts === 3)
            throw new Error(
              "socket closed after the second upload request was written",
            );
        };
        const text =
          "The complete answer is saved; the three selected files follow.";
        const blocked = await service.publishBoardMessage(
          endpoint.id,
          conversation.id,
          text,
          "partial-file-restart",
          "owner-user",
          attachmentIds,
        );
        expect(blocked).toMatchObject({
          state: "delivery_unknown",
          attempts: 1,
          providerMessageId: null,
        });
        if (!blocked.commentId)
          throw new Error("Expected durable batch comment");
        const readBatch = () =>
          readChatPublicationsByCommentId(blocked.commentId!)
            .orderBy(asc(chatPublications.createdAt));
        const initialBatch = await readBatch();
        expect(initialBatch.map((row) => row.state)).toEqual([
          "published",
          "published",
          "delivery_unknown",
          "pending",
        ]);
        expect(initialBatch.map((row) => row.attempts)).toEqual([1, 1, 1, 0]);
        expect(
          initialBatch.map((row) => row.payload.attachmentIds ?? []),
        ).toEqual([[], ...attachmentIds.map((id) => [id])]);
        expect(initialBatch[2]!.id).toBe(blocked.id);
        expect(initialRuntime.posts).toEqual([
          { threadId: channel.thread.id, text: provider === "slack" ? `**Owner User (via Paperclip)**\n\n${text}` : text },
          {
            threadId: channel.thread.id,
            text: provider === "slack" ? "" : "Shared selected-1.txt.",
            files: [
              expect.objectContaining({
                filename: "selected-1.txt",
                data: bodies[0],
              }),
            ],
          },
        ]);
        expect(initialAttempts).toBe(3);
        const prefix = initialBatch.slice(0, 2);
        const prefixLinks = await db
          .select()
          .from(chatMessageLinks)
          .where(
            inArray(
              chatMessageLinks.publicationId,
              prefix.map((row) => row.id),
            ),
          )
          .orderBy(asc(chatMessageLinks.id));
        expect(prefixLinks).toHaveLength(2);
        const commentBefore = await db
          .select()
          .from(issueComments)
          .where(eq(issueComments.id, blocked.commentId));
        expect(commentBefore).toEqual([
          expect.objectContaining({ body: text }),
        ]);
        await service.shutdown();

        const fresh = createService(new FakeChatSdkRuntime(), undefined, {
          storage: storage.storage,
        });
        restarted = fresh.service;
        fresh.runtime.initializeHook = async () => {
          fresh.runtime.endpoints
            .get(endpoint.id)!
            .postResultIds.push("1789000.000003", "1789000.000004");
        };
        await restarted.processPendingPublications();
        await restarted.processPendingPublications();
        expect(await readBatch()).toEqual(initialBatch);
        expect(fresh.runtime.endpoints.get(endpoint.id)?.posts ?? []).toEqual(
          [],
        );
        const partial = await request(
          routesApp(db, fixture.companyId, restarted),
        )
          .get(
            `/api/chat-endpoints/${endpoint.id}/conversations/${conversation.id}/publications/${prefix[0]!.id}/status`,
          )
          .expect(200);
        expect(partial.body).toMatchObject({
          total: 4,
          published: 2,
          publication: {
            id: blocked.id,
            state: "delivery_unknown",
            attempts: 1,
            nextAttemptAt: null,
          },
        });
        expect(
          (await restarted.listActivity(endpoint.id)).find(
            (row) => row.id === blocked.id,
          ),
        ).toMatchObject({
          kind: "publication",
          status: "delivery_unknown",
          replayable: false,
          resolutionActions: ["mark_delivered", "retry_anyway", "cancel"],
        });
        await expect(
          restarted.replayPublication(endpoint.id, blocked.id),
        ).rejects.toMatchObject({
          status: 409,
          details: { code: "chat_publication_resolution_required" },
        });
        expect(await readBatch()).toEqual(initialBatch);
        await restarted.resolvePublication(
          endpoint.id,
          blocked.id,
          "retry_anyway",
          "owner-user",
        );
        await restarted.processPendingPublications();
        const completed = await readBatch();
        expect(completed.map((row) => row.state)).toEqual([
          "published",
          "published",
          "published",
          "published",
        ]);
        expect(completed.map((row) => row.attempts)).toEqual([1, 1, 2, 1]);
        expect(completed.slice(0, 2)).toEqual(prefix);
        expect(
          await db
            .select()
            .from(chatMessageLinks)
            .where(
              inArray(
                chatMessageLinks.publicationId,
                prefix.map((row) => row.id),
              ),
            )
            .orderBy(asc(chatMessageLinks.id)),
        ).toEqual(prefixLinks);
        expect(
          await db
            .select()
            .from(issueComments)
            .where(eq(issueComments.id, blocked.commentId)),
        ).toEqual(commentBefore);
        const resumedRuntime = fresh.runtime.endpoints.get(endpoint.id);
        expect(resumedRuntime?.posts).toEqual(
          [2, 3].map((index) => ({
            threadId: channel.thread.id,
            text: provider === "slack" ? "" : `Shared selected-${index}.txt.`,
            files: [
              expect.objectContaining({
                filename: `selected-${index}.txt`,
                data: bodies[index - 1],
              }),
            ],
          })),
        );
        expect(initialRuntime.posts).toHaveLength(2);
        expect(initialAttempts).toBe(3);
        if (provider === "slack")
          expect(resumedRuntime?.slackFilePublicationAttempts).toBe(2);
        expect(
          await db
            .select({ details: activityLog.details })
            .from(activityLog)
            .where(
              and(
                eq(activityLog.entityId, blocked.id),
                eq(activityLog.action, "chat.publication_retry_anyway"),
              ),
            ),
        ).toEqual([
          {
            details: expect.objectContaining({
              duplicateRiskAccepted: true,
              previousState: "delivery_unknown",
              nextState: "retry",
            }),
          },
        ]);
        const finalStatus = await restarted.getPublicationBatchStatus(
          endpoint.id,
          conversation.id,
          prefix[0]!.id,
        );
        expect(finalStatus).toMatchObject({
          total: 4,
          published: 4,
          publication: { state: "published" },
        });
        await restarted.processPendingPublications();
        expect(resumedRuntime?.posts).toHaveLength(2);
        expect(await readBatch()).toEqual(completed);
      } finally {
        await service.shutdown();
        await retirePublicationFixture(restarted ?? service, endpoint.id);
      }
    },
  );

  it("recovers an accepted Slack file receipt without uploading twice or exposing provider identifiers", async () => {
    const fixture = await seedCompany();
    const storage = createStorageService();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture, { storage: storage.storage });
    try {
      const channel = makeThread({
        channelId: "C-SLACK-RECEIPT",
        id: "slack:C-SLACK-RECEIPT:4400.15",
        name: "slack-file-receipt",
      });
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        thread: channel.thread,
        message: makeMessage({
          id: "4400.15",
          text: "@maya start a receipt repair test",
          mentioned: true,
        }),
        trigger: "mention",
      });
      await qualifySetupRoundTrip(service, endpoint.id);
      await service.test(endpoint.id);
      const [conversation] = await service.listConversations(endpoint.id);
      if (!conversation) throw new Error("Expected Slack receipt conversation");
      const comment = await issueService(db).addComment(
        conversation.issueId,
        "Accepted Slack file fixture",
        { userId: "owner-user" },
      );
      const stored = await storage.storage.putFile({
        companyId: fixture.companyId,
        namespace: `issues/${conversation.issueId}`,
        originalFilename: "accepted-once.txt",
        contentType: "text/plain",
        body: Buffer.from("accepted exactly once", "utf8"),
      });
      const attachment = await issueService(db).createAttachment({
        issueId: conversation.issueId,
        issueCommentId: comment.id,
        provider: stored.provider,
        objectKey: stored.objectKey,
        contentType: stored.contentType,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        originalFilename: stored.originalFilename,
        createdByUserId: "owner-user",
      });
      const [publication] = await db
        .insert(chatPublications)
        .values({
          companyId: fixture.companyId,
          endpointId: endpoint.id,
          conversationId: conversation.id,
          issueId: conversation.issueId,
          commentId: comment.id,
          idempotencyKey: `slack-file-receipt:${randomUUID()}`,
          payload: { text: "", attachmentIds: [attachment.id] },
          state: "pending",
        })
        .returning();
      const providerRuntime = runtime.endpoints.get(endpoint.id);
      if (!providerRuntime) throw new Error("Expected Slack provider runtime");
      providerRuntime.posts.length = 0;
      providerRuntime.slackFileReceiptCaptureRepeats = 2;
      providerRuntime.slackFilePostAcceptanceError = new Error(
        "connection closed after Slack accepted the upload",
      );

      // Cross the earlier rate-limit fixture's five-second retry deadline.
      // A retired fixture must not be adopted by this global worker, even on
      // a slower full-suite run. This changes Date only, not transport timers.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(Date.now() + 6_000));
      const processingStartedAt = new Date();
      const processed = await service.processPendingPublications();
      const extraPublicationDiagnostics =
        processed === 1
          ? undefined
          : await db
              .select({
                id: chatPublications.id,
                endpointId: chatPublications.endpointId,
                key: chatPublications.idempotencyKey,
                state: chatPublications.state,
                attempts: chatPublications.attempts,
                nextAttemptAt: chatPublications.nextAttemptAt,
              })
              .from(chatPublications)
              .where(
                sql`${chatPublications.updatedAt} >= ${processingStartedAt.toISOString()}::timestamptz`,
              )
              .limit(20);
      expect(processed, JSON.stringify(extraPublicationDiagnostics)).toBe(1);
      expect(providerRuntime.slackFilePublicationAttempts).toBe(1);
      await expect(
        db
          .select({
            attempts: chatPublications.attempts,
            providerMessageId: chatPublications.providerMessageId,
            state: chatPublications.state,
          })
          .from(chatPublications)
          .where(eq(chatPublications.id, publication!.id)),
      ).resolves.toEqual([
        { attempts: 1, providerMessageId: null, state: "delivery_unknown" },
      ]);
      const [receipt] = await db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(chatActions.kind, "slack_file_upload_receipt"),
            eq(
              chatActions.providerActionId,
              `slack-file-receipt:${publication!.id}:1`,
            ),
          ),
        );
      expect(receipt).toMatchObject({
        status: "received",
        payload: expect.objectContaining({
          fileIds: ["FTEST1"],
          publicationAttempt: 1,
          publicationId: publication!.id,
        }),
      });
      expect(
        JSON.stringify(await service.listActivity(endpoint.id)),
      ).not.toContain("FTEST1");
      expect(
        JSON.stringify(await service.listActivity(endpoint.id)),
      ).not.toContain("credentialFingerprint");
      // Legacy/default-timestamp receipts can retain PostgreSQL microseconds
      // that JavaScript Date cannot round-trip. Row ownership must come from
      // the locked status, not a lossy timestamp equality check.
      await db
        .update(chatActions)
        .set({
          updatedAt: sql`${chatActions.updatedAt} + interval '0.000123 seconds'`,
        })
        .where(eq(chatActions.id, receipt!.id));
      const heldEndpoint = await service.create(
        fixture.companyId,
        {
          provider: "slack",
          assignedAgentId: fixture.assignedAgentId,
          name: "Paused receipt backlog",
        },
        "owner-user",
      );
      await db
        .update(chatEndpoints)
        .set({ status: "paused", updatedAt: new Date() })
        .where(eq(chatEndpoints.id, heldEndpoint.id));
      await db.insert(chatActions).values(
        Array.from({ length: 25 }, (_, index) => ({
          companyId: fixture.companyId,
          endpointId: heldEndpoint.id,
          kind: "slack_file_upload_receipt",
          providerActionId: `paused-slack-file-receipt:${index}:${randomUUID()}`,
          payload: {},
          status: "received" as const,
          result: { code: "slack_file_upload_identity_pending", attempts: 0 },
          createdAt: new Date(Date.now() - 60_000),
          updatedAt: new Date(Date.now() - 60_000),
        })),
      );

      providerRuntime.slackFilePostAcceptanceError = null;
      providerRuntime.slackFileReceiptResultIds.push("1788.990001");
      await expect(
        service.processPendingSlackFileUploadReceipts(1),
      ).resolves.toBe(1);
      expect(providerRuntime.slackFilePublicationAttempts).toBe(1);
      expect(providerRuntime.slackFileReceiptLookups).toEqual([
        {
          fileIds: ["FTEST1"],
          threadId: channel.thread.id,
        },
      ]);
      await expect(
        db
          .select({
            providerMessageId: chatPublications.providerMessageId,
            state: chatPublications.state,
          })
          .from(chatPublications)
          .where(eq(chatPublications.id, publication!.id)),
      ).resolves.toEqual([
        { providerMessageId: "1788.990001", state: "published" },
      ]);
      await expect(
        db
          .select({
            providerMessageId: chatMessageLinks.providerMessageId,
            publicationId: chatMessageLinks.publicationId,
          })
          .from(chatMessageLinks)
          .where(eq(chatMessageLinks.publicationId, publication!.id)),
      ).resolves.toEqual([
        {
          providerMessageId: "1788.990001",
          publicationId: publication!.id,
        },
      ]);
      await expect(
        db
          .select({ status: chatActions.status })
          .from(chatActions)
          .where(eq(chatActions.id, receipt!.id)),
      ).resolves.toEqual([{ status: "processed" }]);
      await expect(
        service.processPendingSlackFileUploadReceipts(),
      ).resolves.toBe(0);
      expect(providerRuntime.slackFileReceiptLookups).toHaveLength(1);

      // Operator confirmation is a state-only assertion. The later receipt
      // lookup may add the exact Slack identity, but must not replay bytes or
      // rewrite the operator's published timestamp.
      await db
        .delete(chatMessageLinks)
        .where(eq(chatMessageLinks.publicationId, publication!.id));
      await db
        .update(chatPublications)
        .set({
          state: "delivery_unknown",
          providerMessageId: null,
          publishedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(chatPublications.id, publication!.id));
      await db
        .update(chatActions)
        .set({
          status: "received",
          result: { code: "slack_file_upload_identity_pending", attempts: 1 },
          updatedAt: new Date(),
        })
        .where(eq(chatActions.id, receipt!.id));
      const [conflictingPublication] = await db
        .insert(chatPublications)
        .values({
          companyId: fixture.companyId,
          endpointId: endpoint.id,
          conversationId: conversation.id,
          issueId: conversation.issueId,
          commentId: comment.id,
          idempotencyKey: `existing-slack-message:${randomUUID()}`,
          payload: { text: "Existing provider message" },
          state: "published",
          providerMessageId: "1788.990003",
          publishedAt: new Date(),
        })
        .returning();
      await db.insert(chatMessageLinks).values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: conversation.id,
        publicationId: conflictingPublication!.id,
        commentId: comment.id,
        providerMessageId: "1788.990003",
        direction: "outbound",
      });
      providerRuntime.slackFileReceiptResultIds.push("1788.990003");
      await expect(
        service.processPendingSlackFileUploadReceipts(1),
      ).resolves.toBe(1);
      await expect(
        db
          .select({ result: chatActions.result, status: chatActions.status })
          .from(chatActions)
          .where(eq(chatActions.id, receipt!.id)),
      ).resolves.toEqual([
        {
          result: expect.objectContaining({
            code: "slack_file_upload_receipt_message_conflict",
            retryable: false,
          }),
          status: "failed",
        },
      ]);
      await db
        .update(chatActions)
        .set({
          status: "received",
          result: { code: "slack_file_upload_identity_pending", attempts: 1 },
          updatedAt: new Date(),
        })
        .where(eq(chatActions.id, receipt!.id));
      await service.resolvePublication(
        endpoint.id,
        publication!.id,
        "mark_delivered",
        "owner-user",
      );
      const operatorPublishedAt = await db
        .select({ publishedAt: chatPublications.publishedAt })
        .from(chatPublications)
        .where(eq(chatPublications.id, publication!.id))
        .then((rows) => rows[0]!.publishedAt);
      providerRuntime.slackFileReceiptResultIds.push("1788.990002");
      await expect(
        service.processPendingSlackFileUploadReceipts(1),
      ).resolves.toBe(1);
      expect(providerRuntime.slackFilePublicationAttempts).toBe(1);
      await expect(
        db
          .select({
            providerMessageId: chatPublications.providerMessageId,
            publishedAt: chatPublications.publishedAt,
            state: chatPublications.state,
          })
          .from(chatPublications)
          .where(eq(chatPublications.id, publication!.id)),
      ).resolves.toEqual([
        {
          providerMessageId: "1788.990002",
          publishedAt: operatorPublishedAt,
          state: "published",
        },
      ]);

      await db
        .delete(chatMessageLinks)
        .where(eq(chatMessageLinks.publicationId, publication!.id));
      await db
        .update(chatPublications)
        .set({
          state: "delivery_unknown",
          providerMessageId: null,
          publishedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(chatPublications.id, publication!.id));
      await db
        .update(chatActions)
        .set({
          status: "received",
          result: { code: "slack_file_upload_identity_pending", attempts: 2 },
          updatedAt: new Date(),
        })
        .where(eq(chatActions.id, receipt!.id));
      await service.resolvePublication(
        endpoint.id,
        publication!.id,
        "cancel",
        "owner-user",
      );
      await expect(
        db
          .select({ status: chatActions.status })
          .from(chatActions)
          .where(eq(chatActions.id, receipt!.id)),
      ).resolves.toEqual([{ status: "cancelled" }]);
      await expect(
        service.processPendingSlackFileUploadReceipts(1),
      ).resolves.toBe(0);
    } finally {
      vi.useRealTimers();
      await retirePublicationFixture(service, endpoint.id);
    }
  });

  it("defers Slack file receipt recovery while the original post owns the same attempt", async () => {
    const fixture = await seedCompany();
    const storage = createStorageService();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture, { storage: storage.storage });
    let releasePost!: () => void;
    const postReleased = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    let postEntered!: () => void;
    const postBlocked = new Promise<void>((resolve) => {
      postEntered = resolve;
    });
    try {
      const channel = makeThread({
        channelId: "C-SLACK-RECEIPT-STREAMING",
        id: "slack:C-SLACK-RECEIPT-STREAMING:4400.16",
        name: "slack-file-receipt-streaming",
      });
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        thread: channel.thread,
        message: makeMessage({
          id: "4400.16",
          text: "@maya start a streaming receipt test",
          mentioned: true,
        }),
        trigger: "mention",
      });
      await qualifySetupRoundTrip(service, endpoint.id);
      await service.test(endpoint.id);
      const [conversation] = await service.listConversations(endpoint.id);
      if (!conversation) throw new Error("Expected streaming conversation");
      const comment = await issueService(db).addComment(
        conversation.issueId,
        "Streaming Slack file fixture",
        { userId: "owner-user" },
      );
      const stored = await storage.storage.putFile({
        companyId: fixture.companyId,
        namespace: `issues/${conversation.issueId}`,
        originalFilename: "streaming-once.txt",
        contentType: "text/plain",
        body: Buffer.from("still owned by original post", "utf8"),
      });
      const attachment = await issueService(db).createAttachment({
        issueId: conversation.issueId,
        issueCommentId: comment.id,
        provider: stored.provider,
        objectKey: stored.objectKey,
        contentType: stored.contentType,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        originalFilename: stored.originalFilename,
        createdByUserId: "owner-user",
      });
      const [publication] = await db
        .insert(chatPublications)
        .values({
          companyId: fixture.companyId,
          endpointId: endpoint.id,
          conversationId: conversation.id,
          issueId: conversation.issueId,
          commentId: comment.id,
          idempotencyKey: `slack-file-receipt-streaming:${randomUUID()}`,
          payload: { text: "", attachmentIds: [attachment.id] },
          state: "pending",
        })
        .returning();
      const providerRuntime = runtime.endpoints.get(endpoint.id);
      if (!providerRuntime) throw new Error("Expected Slack provider runtime");
      providerRuntime.slackFilePostAcceptanceHook = async () => {
        postEntered();
        await postReleased;
      };
      const originalWorker = service.processPendingPublications();
      await postBlocked;

      await expect(
        service.processPendingSlackFileUploadReceipts(),
      ).resolves.toBe(0);
      expect(providerRuntime.slackFileReceiptLookups).toHaveLength(0);
      await expect(
        db
          .select({ state: chatPublications.state })
          .from(chatPublications)
          .where(eq(chatPublications.id, publication!.id)),
      ).resolves.toEqual([{ state: "streaming" }]);

      releasePost();
      await originalWorker;
      await expect(
        db
          .select({ state: chatPublications.state })
          .from(chatPublications)
          .where(eq(chatPublications.id, publication!.id)),
      ).resolves.toEqual([{ state: "published" }]);
      await expect(
        db
          .select({ status: chatActions.status })
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, endpoint.id),
              eq(chatActions.kind, "slack_file_upload_receipt"),
              eq(
                chatActions.providerActionId,
                `slack-file-receipt:${publication!.id}:1`,
              ),
            ),
          ),
      ).resolves.toEqual([{ status: "processed" }]);
    } finally {
      releasePost();
      await retirePublicationFixture(service, endpoint.id);
    }
  });

  it("rechecks a Slack file receipt after a competing worker changes its retry deadline", async () => {
    const { endpoint, fixture, providerRuntime, receipt, service } =
      await acceptedUnknownSlackFileReceipt("stale-worker");
    try {
      const [malformed] = await db
        .insert(chatActions)
        .values({
          companyId: fixture.companyId,
          endpointId: endpoint.id,
          kind: "slack_file_upload_receipt",
          providerActionId: `malformed-slack-file-receipt:${randomUUID()}`,
          payload: {},
          status: "received",
          result: null,
          createdAt: new Date(Date.now() - 60_000),
          updatedAt: new Date(Date.now() - 60_000),
        })
        .returning();
      await db
        .update(chatActions)
        .set({
          updatedAt: sql`${chatActions.updatedAt} + interval '0.000123 seconds'`,
        })
        .where(eq(chatActions.id, malformed!.id));
      await expect(
        service.processPendingSlackFileUploadReceipts(1),
      ).resolves.toBe(0);
      await expect(
        db
          .select({ result: chatActions.result, status: chatActions.status })
          .from(chatActions)
          .where(eq(chatActions.id, malformed!.id)),
      ).resolves.toEqual([
        {
          result: {
            code: "slack_file_upload_receipt_payload_invalid",
            retryable: false,
          },
          status: "failed",
        },
      ]);
      expect(providerRuntime.slackFileReceiptLookups).toHaveLength(0);
      const blockerToken = `test-blocker-${randomUUID()}`;
      await db.insert(chatEndpointLeases).values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        leaseKey: "credentials",
        token: blockerToken,
        expiresAt: new Date(Date.now() + 60_000),
      });
      // The endpoint can also have deferred work using this same lease. Track
      // each of the two receipt workers by its async call chain, not all lease
      // tokens observed globally, so the barrier proves both selected the row.
      const workerScope = new AsyncLocalStorage<0 | 1>();
      const attemptedWorkerTokens = [new Set<string>(), new Set<string>()];
      const originalInsert = db.insert.bind(db);
      const insertSpy = vi.spyOn(db, "insert").mockImplementation((table) => {
        const builder = originalInsert(table);
        if (table === chatEndpointLeases) {
          const originalValues = builder.values.bind(builder);
          builder.values = ((values: {
            endpointId?: string;
            leaseKey?: string;
            token?: string;
          }) => {
            if (
              values.endpointId === endpoint.id &&
              values.leaseKey === "credentials" &&
              values.token &&
              values.token !== blockerToken
            ) {
              const worker = workerScope.getStore();
              if (worker !== undefined) {
                attemptedWorkerTokens[worker]!.add(values.token);
              }
            }
            return originalValues(values);
          }) as typeof builder.values;
        }
        return builder;
      });
      const workers = [
        workerScope.run(0, () =>
          service.processPendingSlackFileUploadReceipts(1),
        ),
        workerScope.run(1, () =>
          service.processPendingSlackFileUploadReceipts(1),
        ),
      ];
      let outcomes: number[] = [];
      try {
        await expect
          .poll(() => attemptedWorkerTokens.map((tokens) => tokens.size))
          .toEqual([1, 1]);
        expect(
          new Set(attemptedWorkerTokens.flatMap((tokens) => [...tokens])).size,
        ).toBe(2);
      } finally {
        await db
          .delete(chatEndpointLeases)
          .where(
            and(
              eq(chatEndpointLeases.endpointId, endpoint.id),
              eq(chatEndpointLeases.leaseKey, "credentials"),
              eq(chatEndpointLeases.token, blockerToken),
            ),
          );
        try {
          outcomes = await Promise.all(workers);
        } finally {
          insertSpy.mockRestore();
        }
      }
      expect(outcomes.reduce((sum, value) => sum + value, 0)).toBe(1);
      expect(providerRuntime.slackFileReceiptLookups).toHaveLength(1);
      await expect(
        db
          .select({ result: chatActions.result, status: chatActions.status })
          .from(chatActions)
          .where(eq(chatActions.id, receipt.id)),
      ).resolves.toEqual([
        {
          result: expect.objectContaining({
            attempts: 1,
            code: "slack_file_upload_identity_pending",
            retryable: true,
            retryAt: expect.any(String),
          }),
          status: "failed",
        },
      ]);
      expect(providerRuntime.slackFilePublicationAttempts).toBe(1);
    } finally {
      await retirePublicationFixture(service, endpoint.id);
    }
  });

  it("rejects a recovered Slack file identity when destination reach changes during lookup", async () => {
    const {
      conversation,
      endpoint,
      providerRuntime,
      publication,
      receipt,
      service,
    } = await acceptedUnknownSlackFileReceipt("revoked-reach");
    let releaseLookup!: () => void;
    const lookupReleased = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    let lookupEntered!: () => void;
    const lookupBlocked = new Promise<void>((resolve) => {
      lookupEntered = resolve;
    });
    try {
      providerRuntime.slackFileReceiptResultIds.push("1788.991001");
      providerRuntime.slackFileReceiptHook = async () => {
        lookupEntered();
        await lookupReleased;
      };
      const recovery = service.processPendingSlackFileUploadReceipts(1);
      await lookupBlocked;
      if (!conversation.resourceId) {
        throw new Error("Expected Slack channel resource");
      }
      await db
        .update(chatEndpointResources)
        .set({ enabled: false, updatedAt: new Date() })
        .where(
          and(
            eq(chatEndpointResources.id, conversation.resourceId),
            eq(chatEndpointResources.endpointId, endpoint.id),
          ),
        );
      releaseLookup();
      await expect(recovery).resolves.toBe(1);

      await expect(
        db
          .select({
            providerMessageId: chatPublications.providerMessageId,
            state: chatPublications.state,
          })
          .from(chatPublications)
          .where(eq(chatPublications.id, publication.id)),
      ).resolves.toEqual([
        { providerMessageId: null, state: "delivery_unknown" },
      ]);
      await expect(
        db
          .select({ result: chatActions.result, status: chatActions.status })
          .from(chatActions)
          .where(eq(chatActions.id, receipt.id)),
      ).resolves.toEqual([
        {
          result: {
            attempts: 1,
            code: "slack_file_upload_receipt_authorization_changed",
          },
          status: "cancelled",
        },
      ]);
      await expect(
        db
          .select({ id: chatMessageLinks.id })
          .from(chatMessageLinks)
          .where(eq(chatMessageLinks.publicationId, publication.id)),
      ).resolves.toHaveLength(0);
      expect(providerRuntime.slackFilePublicationAttempts).toBe(1);
      expect(providerRuntime.slackFileReceiptLookups).toHaveLength(1);
    } finally {
      releaseLookup();
      await retirePublicationFixture(service, endpoint.id);
    }
  });
});
