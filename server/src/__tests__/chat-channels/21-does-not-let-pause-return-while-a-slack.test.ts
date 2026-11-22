import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { activityLog, assets, chatActions, chatDeliveries, chatEndpointLeases, chatEndpointResources, chatEndpoints, chatExternalPrincipals, chatPublications, companySecretBindings, issueAttachments, issueComments, toolConnections } from "@paperclipai/db";
import type { Attachment } from "chat";
import type { InternalSetupState } from "../../services/chat-channels/runtime-types.js";
import { issueService } from "../../services/issues.js";
import { FakeChatSdkRuntime, fakeSlackFetch, makeMessage, makeThread } from ".././helpers/chat-channels-fixture.js";
import { configuredDiscordEndpoint, configuredSlackEndpoint, createService, createStorageService, db, deliverMessage, describeChatChannelsSuite, qualifySetupRoundTrip, readChatConversationsByEndpointId, readChatDeliveriesByEndpointId, readChatPublicationsByCommentId, retireFixtureState, seedCompany } from "../helpers/chat-channels-harness.js";







describeChatChannelsSuite("chat channels 21-does-not-let-pause-return-while-a-slack", () => {
  it("does not let pause return while a Slack publication is still in provider transport", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture);
    const thread = makeThread({
      channelId: "C-PAUSE-OUTBOX",
      id: "slack:C-PAUSE-OUTBOX:4090.1",
      name: "pause-outbox",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: thread.thread,
      message: makeMessage({
        id: "4090.1",
        text: "@maya create a pause-fenced task",
        mentioned: true,
      }),
      trigger: "mention",
    });
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    const [storedEndpoint] = await db
      .select({ setup: chatEndpoints.setup })
      .from(chatEndpoints)
      .where(eq(chatEndpoints.id, endpoint.id));
    await db
      .update(chatEndpoints)
      .set({
        status: "active",
        setup: { ...storedEndpoint.setup, step: "complete" },
        activatedAt: new Date(),
      })
      .where(eq(chatEndpoints.id, endpoint.id));
    const [publication] = await db
      .insert(chatPublications)
      .values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: conversation.id,
        issueId: conversation.issueId,
        idempotencyKey: `pause-fence:${endpoint.id}`,
        payload: { text: "Publication already entering Slack transport" },
        state: "pending",
      })
      .returning();
    const endpointRuntime = runtime.endpoints.get(endpoint.id);
    if (!endpointRuntime) throw new Error("Expected Slack runtime");
    let markPostStarted!: () => void;
    const postStarted = new Promise<void>((resolve) => {
      markPostStarted = resolve;
    });
    let releasePost!: () => void;
    const postBlocked = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    endpointRuntime.postHook = async () => {
      markPostStarted();
      await postBlocked;
    };

    const processing = service.processPendingPublications();
    await postStarted;
    const pausing = service.configure(
      endpoint.id,
      { action: "pause" },
      "owner-user",
    );
    await expect(
      Promise.race([
        pausing.then(() => "paused"),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("transport-in-flight"), 100),
        ),
      ]),
    ).resolves.toBe("transport-in-flight");

    releasePost();
    await Promise.all([processing, pausing]);
    await expect(
      db
        .select({ state: chatPublications.state })
        .from(chatPublications)
        .where(eq(chatPublications.id, publication.id)),
    ).resolves.toEqual([{ state: "published" }]);
    await expect(
      db
        .select({ status: chatEndpoints.status })
        .from(chatEndpoints)
        .where(eq(chatEndpoints.id, endpoint.id)),
    ).resolves.toEqual([{ status: "paused" }]);
    expect(endpointRuntime.posts).toContainEqual({
      threadId: thread.thread.id,
      text: "Publication already entering Slack transport",
    });
    await service.shutdown();
  });

  it("quarantines Telegram maintenance success when credential-lease ownership is reclaimed", async () => {
    // Global sweeps may also reconcile a retired fixture's receipt. Keep that
    // work eligible so the fault hook proves it cannot steal another owner.
    const retiredFixture = await seedCompany();
    const retired = await configuredSlackEndpoint(retiredFixture);
    const retiredThread = makeThread({ channelId: "C-LEASE-SCOPE", id: "slack:C-LEASE-SCOPE:7002.1" });
    await deliverMessage({
      callbacks: retired.callbacks,
      endpointId: retired.endpoint.id,
      thread: retiredThread.thread,
      message: makeMessage({ id: "7002.1", text: "@maya check lease isolation", mentioned: true }),
      trigger: "mention",
    });
    await retired.service.shutdown();
    const [retiredReceipt] = await db.select().from(chatActions).where(and(
      eq(chatActions.endpointId, retired.endpoint.id),
      eq(chatActions.kind, "receipt_reaction"),
    ));
    expect(retiredReceipt).toBeDefined();
    await db.update(chatActions).set({ status: "received" })
      .where(eq(chatActions.id, retiredReceipt!.id));
    await retireFixtureState([retiredFixture.companyId]);

    const fixture = await seedCompany();
    const botToken = "123456:telegram-lease-reclaim";
    let reclaimLease = false;
    let markLeaseReclaimed!: () => void;
    const leaseReclaimed = new Promise<void>((resolve) => {
      markLeaseReclaimed = resolve;
    });
    let blockCommands = false;
    let acceptedCommandMutations = 0;
    const providerFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/getMe")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              id: 884422,
              username: "paperclip_lease_reclaim_bot",
              first_name: "Paperclip Lease Reclaim",
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
        if (blockCommands) {
          reclaimLease = true;
          await leaseReclaimed;
        }
        acceptedCommandMutations += 1;
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected provider request: ${url}`);
    }) as typeof globalThis.fetch;
    const { service } = createService(new FakeChatSdkRuntime(), providerFetch, {
      credentialMutationLeaseRenewalIntervalMs: 5,
      renewCredentialMutationLease: async (input) => {
        // Force the unrelated receipt to reach its ownership check only
        // after the Telegram fault is armed, independent of query timing.
        if (blockCommands && input.companyId === retiredFixture.companyId) {
          await leaseReclaimed;
        }
        if (input.companyId !== fixture.companyId || !reclaimLease) return true;
        const reclaimed = await db
          .update(chatEndpointLeases)
          .set({
            token: `reclaimed-${randomUUID()}`,
            expiresAt: new Date(Date.now() + 90_000),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatEndpointLeases.endpointId, input.endpointId),
              eq(chatEndpointLeases.leaseKey, input.leaseKey),
              eq(chatEndpointLeases.token, input.token),
            ),
          )
          .returning({ id: chatEndpointLeases.id });
        if (reclaimed.length > 0) markLeaseReclaimed();
        return false;
      },
    });
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "telegram", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await service.configure(
      endpoint.id,
      { action: "configure", credentials: { botToken } },
      "owner-user",
    );
    const maintenance = await db
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
          providerConfirmed: false,
          retryable: true,
          retryAt: new Date(0).toISOString(),
        },
        updatedAt: new Date(),
      })
      .where(eq(chatActions.id, maintenance.id));
    acceptedCommandMutations = 0;
    blockCommands = true;

    await service.processPendingDeliveries();

    await expect(db.select({ status: chatActions.status }).from(chatActions)
      .where(eq(chatActions.id, retiredReceipt!.id)))
      .resolves.toEqual([{ status: "cancelled" }]);
    await expect(db.select().from(chatEndpointLeases)
      .where(eq(chatEndpointLeases.endpointId, retired.endpoint.id)))
      .resolves.toEqual([]);

    await expect(
      db
        .select({ status: chatActions.status, result: chatActions.result })
        .from(chatActions)
        .where(eq(chatActions.id, maintenance.id)),
    ).resolves.toEqual([
      {
        status: "failed",
        result: expect.objectContaining({
          code: "telegram_maintenance_delivery_unknown",
          providerConfirmed: true,
          retryable: true,
        }),
      },
    ]);
    const [reclaimedLease] = await db
      .select({ token: chatEndpointLeases.token })
      .from(chatEndpointLeases)
      .where(
        and(
          eq(chatEndpointLeases.endpointId, endpoint.id),
          eq(chatEndpointLeases.leaseKey, "credentials"),
        ),
      );
    expect(reclaimedLease?.token).toMatch(/^reclaimed-/);
    expect(acceptedCommandMutations).toBe(1);
    // The reclaimed owner is synthetic and will never release its 90-second
    // lease. Remove only this fixture's lease and retryable maintenance row so
    // later global recovery sweeps do not wait for a nonexistent process.
    await db.transaction(async (tx) => {
      await tx
        .update(chatActions)
        .set({
          status: "cancelled",
          result: { code: "test_fixture_complete" },
          updatedAt: new Date(),
        })
        .where(eq(chatActions.id, maintenance.id));
      await tx
        .delete(chatEndpointLeases)
        .where(
          and(
            eq(chatEndpointLeases.endpointId, endpoint.id),
            eq(chatEndpointLeases.leaseKey, "credentials"),
          ),
        );
    });
    await service.shutdown();
  });

  it("does not let stale Telegram removal clear successor credentials after lease reclamation", async () => {
    const fixture = await seedCompany();
    const botToken = "123456:telegram-removal-lease-reclaim";
    let connectionId: string | null = null;
    let successorRefs: typeof toolConnections.$inferSelect.credentialSecretRefs =
      [];
    let reclaimLease = false;
    let markLeaseReclaimed!: () => void;
    const leaseReclaimed = new Promise<void>((resolve) => {
      markLeaseReclaimed = resolve;
    });
    let blockRemoval = false;
    let acceptedRemovalMutations = 0;
    const providerFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/getMe")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              id: 884423,
              username: "paperclip_removal_reclaim_bot",
              first_name: "Paperclip Removal Reclaim",
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
      if (url.endsWith("/setWebhook") || url.endsWith("/setMyCommands")) {
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/deleteWebhook")) {
        acceptedRemovalMutations += 1;
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/deleteMyCommands")) {
        if (blockRemoval) {
          reclaimLease = true;
          await leaseReclaimed;
        }
        acceptedRemovalMutations += 1;
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected provider request: ${url}`);
    }) as typeof globalThis.fetch;
    const { service } = createService(new FakeChatSdkRuntime(), providerFetch, {
      credentialMutationLeaseRenewalIntervalMs: 5,
      renewCredentialMutationLease: async (input) => {
        if (!reclaimLease) return true;
        const reclaimed = await db
          .update(chatEndpointLeases)
          .set({
            token: `reclaimed-${randomUUID()}`,
            expiresAt: new Date(Date.now() + 90_000),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatEndpointLeases.endpointId, input.endpointId),
              eq(chatEndpointLeases.leaseKey, input.leaseKey),
              eq(chatEndpointLeases.token, input.token),
            ),
          )
          .returning({ id: chatEndpointLeases.id });
        if (reclaimed.length > 0) {
          if (!connectionId) throw new Error("Expected Telegram connection");
          await db
            .update(toolConnections)
            .set({ credentialSecretRefs: successorRefs, updatedAt: new Date() })
            .where(eq(toolConnections.id, connectionId));
          markLeaseReclaimed();
        }
        return false;
      },
    });
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "telegram", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await service.configure(
      endpoint.id,
      { action: "configure", credentials: { botToken } },
      "owner-user",
    );
    connectionId = endpoint.connectionId;
    const currentRefs = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(eq(toolConnections.id, connectionId))
      .then((rows) => rows[0]!.refs);
    successorRefs = currentRefs.map((ref) => ({
      ...ref,
      secretId: randomUUID(),
    }));
    blockRemoval = true;

    await expect(
      service.configure(endpoint.id, { action: "remove" }, "owner-user"),
    ).rejects.toMatchObject({ code: "CHAT_CREDENTIAL_LEASE_LOST" });

    await expect(
      db
        .select({ refs: toolConnections.credentialSecretRefs })
        .from(toolConnections)
        .where(eq(toolConnections.id, connectionId)),
    ).resolves.toEqual([{ refs: successorRefs }]);
    const removalAction = await db
      .select({ status: chatActions.status, result: chatActions.result })
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.kind, "telegram_maintenance"),
          sql`${chatActions.payload}->>'operation' = 'remove_endpoint'`,
        ),
      )
      .then((rows) => rows[0]);
    expect(removalAction).toEqual({
      status: "failed",
      result: expect.objectContaining({
        code: "telegram_maintenance_delivery_unknown",
        providerConfirmed: true,
      }),
    });
    expect(acceptedRemovalMutations).toBe(2);
    // The simulated successor has no live worker. Retire only its synthetic
    // lease and removal retry after proving stale settlement could not clear
    // the successor refs, keeping later global recovery tests independent.
    await db.transaction(async (tx) => {
      await tx
        .update(chatActions)
        .set({
          status: "cancelled",
          result: { code: "test_fixture_complete" },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(chatActions.kind, "telegram_maintenance"),
            sql`${chatActions.payload}->>'operation' = 'remove_endpoint'`,
          ),
        );
      await tx
        .delete(chatEndpointLeases)
        .where(
          and(
            eq(chatEndpointLeases.endpointId, endpoint.id),
            eq(chatEndpointLeases.leaseKey, "credentials"),
          ),
        );
    });
    await service.shutdown();
  });

  it("does not let stale GitHub setup-secret rotation overwrite successor credentials", async () => {
    const fixture = await seedCompany();
    let connectionId: string | null = null;
    let successorRefs: typeof toolConnections.$inferSelect.credentialSecretRefs =
      [];
    let blockPersistence = false;
    let reclaimLease = false;
    let markLeaseReclaimed!: () => void;
    const leaseReclaimed = new Promise<void>((resolve) => {
      markLeaseReclaimed = resolve;
    });
    const { service } = createService(
      new FakeChatSdkRuntime(),
      fakeSlackFetch() as typeof globalThis.fetch,
      {
        credentialMutationLeaseRenewalIntervalMs: 5,
        setupSecretCredentialPersistBarrier: async () => {
          if (!blockPersistence) return;
          reclaimLease = true;
          await leaseReclaimed;
        },
        renewCredentialMutationLease: async (input) => {
          if (!reclaimLease) return true;
          const reclaimed = await db
            .update(chatEndpointLeases)
            .set({
              token: `reclaimed-${randomUUID()}`,
              expiresAt: new Date(Date.now() + 90_000),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(chatEndpointLeases.endpointId, input.endpointId),
                eq(chatEndpointLeases.leaseKey, input.leaseKey),
                eq(chatEndpointLeases.token, input.token),
              ),
            )
            .returning({ id: chatEndpointLeases.id });
          if (reclaimed.length > 0) {
            if (!connectionId) throw new Error("Expected GitHub connection");
            await db
              .update(toolConnections)
              .set({
                credentialSecretRefs: successorRefs,
                updatedAt: new Date(),
              })
              .where(eq(toolConnections.id, connectionId));
            markLeaseReclaimed();
          }
          return false;
        },
      },
    );
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "github", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    connectionId = endpoint.connectionId;
    await service.generateSetupSecret(endpoint.id, "owner-user");
    const currentRefs = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(eq(toolConnections.id, connectionId))
      .then((rows) => rows[0]!.refs);
    successorRefs = currentRefs.map((ref) => ({
      ...ref,
      secretId: randomUUID(),
    }));
    blockPersistence = true;

    await expect(
      service.generateSetupSecret(endpoint.id, "owner-user"),
    ).rejects.toMatchObject({ code: "CHAT_CREDENTIAL_LEASE_LOST" });

    await expect(
      db
        .select({ refs: toolConnections.credentialSecretRefs })
        .from(toolConnections)
        .where(eq(toolConnections.id, connectionId)),
    ).resolves.toEqual([{ refs: successorRefs }]);
    await service.shutdown();
  });

  it("returns a committed one-time GitHub setup secret after final lease loss when its exact ref remains current", async () => {
    const fixture = await seedCompany();
    let loseFinalOwnership = false;
    const { service } = createService(
      new FakeChatSdkRuntime(),
      fakeSlackFetch() as typeof globalThis.fetch,
      {
        credentialMutationLeaseRenewalIntervalMs: 60_000,
        setupSecretFinalOwnershipBarrier: async () => {
          loseFinalOwnership = true;
        },
        renewCredentialMutationLease: async (input) => {
          if (!loseFinalOwnership) return true;
          await db
            .update(chatEndpointLeases)
            .set({
              token: `reclaimed-${randomUUID()}`,
              expiresAt: new Date(Date.now() + 90_000),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(chatEndpointLeases.endpointId, input.endpointId),
                eq(chatEndpointLeases.leaseKey, input.leaseKey),
                eq(chatEndpointLeases.token, input.token),
              ),
            );
          return false;
        },
      },
    );
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "github", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );

    const generated = await service.generateSetupSecret(
      endpoint.id,
      "owner-user",
    );

    expect(generated.webhookSecret).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      db
        .select({ refs: toolConnections.credentialSecretRefs })
        .from(toolConnections)
        .where(eq(toolConnections.id, endpoint.connectionId)),
    ).resolves.toEqual([
      {
        refs: [
          expect.objectContaining({
            configPath: "credentials.webhookSecret",
            secretId: expect.any(String),
          }),
        ],
      },
    ]);
    await expect(
      db
        .select({ token: chatEndpointLeases.token })
        .from(chatEndpointLeases)
        .where(
          and(
            eq(chatEndpointLeases.endpointId, endpoint.id),
            eq(chatEndpointLeases.leaseKey, "credentials"),
          ),
        ),
    ).resolves.toEqual([{ token: expect.stringMatching(/^reclaimed-/) }]);
    await service.shutdown();
  });

  it("withholds a committed one-time GitHub setup secret after final lease loss when its ref was superseded", async () => {
    const fixture = await seedCompany();
    let connectionId: string | null = null;
    let finalOwnershipLost = false;
    const { service } = createService(
      new FakeChatSdkRuntime(),
      fakeSlackFetch() as typeof globalThis.fetch,
      {
        credentialMutationLeaseRenewalIntervalMs: 60_000,
        setupSecretFinalOwnershipBarrier: async () => {
          if (!connectionId) throw new Error("Expected GitHub connection");
          await db.transaction(async (tx) => {
            const [reclaimed] = await tx
              .update(chatEndpointLeases)
              .set({
                token: `reclaimed-${randomUUID()}`,
                expiresAt: new Date(Date.now() + 90_000),
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(chatEndpointLeases.endpointId, endpoint.id),
                  eq(chatEndpointLeases.leaseKey, "credentials"),
                ),
              )
              .returning({ id: chatEndpointLeases.id });
            if (!reclaimed)
              throw new Error("Expected to reclaim the setup-secret lease");
            await tx
              .delete(companySecretBindings)
              .where(
                and(
                  eq(companySecretBindings.companyId, fixture.companyId),
                  eq(companySecretBindings.targetType, "tool_connection"),
                  eq(companySecretBindings.targetId, connectionId!),
                ),
              );
            await tx
              .update(toolConnections)
              .set({ credentialSecretRefs: [], updatedAt: new Date() })
              .where(eq(toolConnections.id, connectionId!));
          });
          finalOwnershipLost = true;
        },
        renewCredentialMutationLease: async () => !finalOwnershipLost,
      },
    );
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "github", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    connectionId = endpoint.connectionId;

    await expect(
      service.generateSetupSecret(endpoint.id, "owner-user"),
    ).rejects.toMatchObject({ code: "CHAT_CREDENTIAL_LEASE_LOST" });
    await expect(
      db
        .select({ refs: toolConnections.credentialSecretRefs })
        .from(toolConnections)
        .where(eq(toolConnections.id, endpoint.connectionId)),
    ).resolves.toEqual([{ refs: [] }]);
    await service.shutdown();
  });

  it("does not commit endpoint reach changes after credential-lease ownership is lost", async () => {
    const fixture = await seedCompany();
    const { service } = createService(
      new FakeChatSdkRuntime(),
      fakeSlackFetch() as typeof globalThis.fetch,
      {
        credentialMutationLeaseRenewalIntervalMs: 60_000,
        renewCredentialMutationLease: async () => false,
      },
    );
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "slack", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );

    await expect(
      service.update(endpoint.id, { allowDirectMessages: false }, "owner-user"),
    ).rejects.toMatchObject({ code: "CHAT_CREDENTIAL_LEASE_LOST" });

    await expect(
      db
        .select({ allowDirectMessages: chatEndpoints.allowDirectMessages })
        .from(chatEndpoints)
        .where(eq(chatEndpoints.id, endpoint.id)),
    ).resolves.toEqual([{ allowDirectMessages: true }]);
    await expect(
      db
        .select({ id: activityLog.id })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.entityId, endpoint.connectionId),
            eq(activityLog.action, "chat_endpoint.updated"),
          ),
        ),
    ).resolves.toEqual([]);
    await service.shutdown();
  });

  it("does not commit stale Slack task-start recovery after credential-lease ownership is lost", async () => {
    const fixture = await seedCompany();
    const { service } = createService(
      new FakeChatSdkRuntime(),
      fakeSlackFetch() as typeof globalThis.fetch,
      {
        credentialMutationLeaseRenewalIntervalMs: 60_000,
        renewCredentialMutationLease: async () => false,
      },
    );
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "slack", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await db.insert(chatActions).values([
      {
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        kind: "slash_task_start",
        providerActionId: `slash_task:lease-recovery-resolving-${randomUUID()}`,
        payload: {},
        result: { attemptCount: 1 },
        status: "resolving",
        updatedAt: new Date(0),
      },
      {
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        kind: "slash_task_start",
        providerActionId: `slash_task:lease-recovery-validating-${randomUUID()}`,
        payload: {},
        result: { attemptCount: 1 },
        status: "validating",
        updatedAt: new Date(0),
      },
    ]);

    await service.processPendingDeliveries();

    await expect(
      db
        .select({ status: chatActions.status })
        .from(chatActions)
        .where(eq(chatActions.endpointId, endpoint.id))
        .orderBy(asc(chatActions.providerActionId)),
    ).resolves.toEqual([{ status: "resolving" }, { status: "validating" }]);
    await service.shutdown();
  });

  it("does not let an obsolete Slack task-start failure quarantine successor credentials or reach", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture, {
        scheduleDeferredWork: () => undefined,
      });
    if (!callbacks.onSlashCommand || !endpoint.setup.command) {
      throw new Error("Slack slash command setup was incomplete");
    }
    const [resource] = await db
      .insert(chatEndpointResources)
      .values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        type: "channel",
        providerResourceId: "C-STALE-FAILURE-FENCE",
        label: "stale-failure-fence",
        availability: "available",
        enabled: true,
      })
      .returning();
    const current = await db
      .select({
        refs: toolConnections.credentialSecretRefs,
        setup: chatEndpoints.setup,
      })
      .from(chatEndpoints)
      .innerJoin(
        toolConnections,
        eq(toolConnections.id, chatEndpoints.connectionId),
      )
      .where(eq(chatEndpoints.id, endpoint.id))
      .then((rows) => rows[0]!);
    const successorRefs = current.refs.map((ref) => ({
      ...ref,
      secretId: randomUUID(),
    }));
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected Slack provider runtime");
    providerRuntime.postHook = async () => {
      await db.transaction(async (tx) => {
        await tx
          .update(toolConnections)
          .set({ credentialSecretRefs: successorRefs, updatedAt: new Date() })
          .where(eq(toolConnections.id, endpoint.connectionId));
        await tx
          .update(chatEndpoints)
          .set({
            setup: {
              ...current.setup,
              runtimeGeneration:
                Number(
                  (current.setup as { runtimeGeneration?: unknown })
                    .runtimeGeneration ?? 0,
                ) + 1,
            } as InternalSetupState,
            updatedAt: new Date(),
          })
          .where(eq(chatEndpoints.id, endpoint.id));
        // Model a successor that reclaimed, rotated, and released the lease
        // while the obsolete provider request was in flight.
        await tx
          .delete(chatEndpointLeases)
          .where(
            and(
              eq(chatEndpointLeases.endpointId, endpoint.id),
              eq(chatEndpointLeases.leaseKey, "credentials"),
            ),
          );
      });
    };
    providerRuntime.postError = Object.assign(new Error("Unauthorized"), {
      adapter: "slack",
      code: "AUTH_FAILED",
      name: "AuthenticationError",
      status: 401,
    });
    await callbacks.onSlashCommand({
      endpointId: endpoint.id,
      provider: "slack",
      event: {
        channel: {
          id: "C-STALE-FAILURE-FENCE",
          name: "stale-failure-fence",
          isDM: false,
          post: vi.fn(),
          postEphemeral: vi.fn(),
        } as never,
        command: endpoint.setup.command,
        text: "do not let stale auth quarantine successor credentials",
        triggerId: `trigger-stale-failure-${randomUUID()}`,
        user: {
          userId: "U-STALE-FAILURE-FENCE",
          userName: "stale-failure-fence",
          fullName: "Stale Failure Fence",
          isBot: false,
          isMe: false,
          isSystem: false,
        },
        raw: { command: endpoint.setup.command },
        adapter: {} as never,
        openModal: async () => undefined,
      },
    });

    await service.processPendingDeliveries();

    await expect(
      db
        .select({ status: chatActions.status, result: chatActions.result })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(chatActions.kind, "slash_task_start"),
          ),
        ),
    ).resolves.toEqual([
      {
        status: "queued",
        result: expect.objectContaining({
          code: "slash_task_runtime_superseded",
          retryable: true,
        }),
      },
    ]);
    await expect(
      db
        .select({
          lastError: chatEndpoints.lastError,
          status: chatEndpoints.status,
        })
        .from(chatEndpoints)
        .where(eq(chatEndpoints.id, endpoint.id)),
    ).resolves.toEqual([{ lastError: null, status: "verifying" }]);
    await expect(
      db
        .select({
          enabled: toolConnections.enabled,
          healthStatus: toolConnections.healthStatus,
          lastError: toolConnections.lastError,
          refs: toolConnections.credentialSecretRefs,
          status: toolConnections.status,
        })
        .from(toolConnections)
        .where(eq(toolConnections.id, endpoint.connectionId)),
    ).resolves.toEqual([
      {
        enabled: true,
        healthStatus: "healthy",
        lastError: null,
        refs: successorRefs,
        status: "active",
      },
    ]);
    await expect(
      db
        .select({ availability: chatEndpointResources.availability })
        .from(chatEndpointResources)
        .where(eq(chatEndpointResources.id, resource!.id)),
    ).resolves.toEqual([{ availability: "available" }]);
    expect(providerRuntime.posts).toEqual([]);
    // This fault fixture deliberately points the successor at nonexistent
    // secret ids. Keep that synthetic queued retry from entering later tests'
    // global outbox scans and obscuring their own timing/ownership assertions.
    await db
      .update(chatActions)
      .set({
        status: "cancelled",
        result: { code: "test_fixture_complete" },
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.kind, "slash_task_start"),
        ),
      );
    await service.shutdown();
  });

  it("does not cancel an ambiguous Slack task start after credential-lease ownership is lost", async () => {
    const fixture = await seedCompany();
    const { service } = createService(
      new FakeChatSdkRuntime(),
      fakeSlackFetch() as typeof globalThis.fetch,
      {
        credentialMutationLeaseRenewalIntervalMs: 60_000,
        renewCredentialMutationLease: async () => false,
      },
    );
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "slack", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    const [action] = await db
      .insert(chatActions)
      .values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        kind: "slash_task_start",
        providerActionId: `slash_task:lease-cancel-${randomUUID()}`,
        payload: {},
        status: "received",
        updatedAt: new Date(0),
      })
      .returning();

    await expect(
      service.resolveAction(endpoint.id, action!.id, "cancel", "owner-user"),
    ).rejects.toMatchObject({ code: "CHAT_CREDENTIAL_LEASE_LOST" });

    await expect(
      db
        .select({ status: chatActions.status })
        .from(chatActions)
        .where(eq(chatActions.id, action!.id)),
    ).resolves.toEqual([{ status: "received" }]);
    await expect(
      db
        .select({ id: activityLog.id })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.entityId, action!.id),
            eq(activityLog.action, "chat.slack_command_cancel"),
          ),
        ),
    ).resolves.toEqual([]);
    await service.shutdown();
  });

  it("does not normalize a stale Slack retry-anyway action after credential-lease ownership is lost", async () => {
    const fixture = await seedCompany();
    let loseLease = false;
    const { callbacks, endpoint, service } = await configuredSlackEndpoint(
      fixture,
      {
        allowUnlinkedPeople: true,
        credentialMutationLeaseRenewalIntervalMs: 60_000,
        renewCredentialMutationLease: async () => !loseLease,
        scheduleDeferredWork: () => undefined,
      },
    );
    if (!callbacks.onSlashCommand || !endpoint.setup.command) {
      throw new Error("Slack slash command setup was incomplete");
    }
    await db.insert(chatEndpointResources).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      type: "channel",
      providerResourceId: "C-LEASE-RETRY",
      label: "lease-retry",
      availability: "available",
      enabled: true,
    });
    await callbacks.onSlashCommand({
      endpointId: endpoint.id,
      provider: "slack",
      event: {
        channel: {
          id: "C-LEASE-RETRY",
          name: "lease-retry",
          isDM: false,
          post: vi.fn(),
          postEphemeral: vi.fn(),
        } as never,
        command: endpoint.setup.command,
        text: "retry this task only with a live credential lease",
        triggerId: `trigger-lease-retry-${randomUUID()}`,
        user: {
          userId: "U-LEASE-RETRY",
          userName: "lease-retry",
          fullName: "Lease Retry User",
          isBot: false,
          isMe: false,
          isSystem: false,
        },
        raw: { command: endpoint.setup.command },
        adapter: {} as never,
        openModal: async () => undefined,
      },
    });
    const action = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.kind, "slash_task_start"),
        ),
      )
      .then((rows) => rows[0]!);
    await db
      .update(chatActions)
      .set({
        status: "received",
        result: { attemptCount: 4 },
        updatedAt: new Date(0),
      })
      .where(eq(chatActions.id, action.id));
    loseLease = true;

    await expect(
      service.resolveAction(
        endpoint.id,
        action.id,
        "retry_anyway",
        "owner-user",
      ),
    ).rejects.toMatchObject({ code: "CHAT_CREDENTIAL_LEASE_LOST" });

    await expect(
      db
        .select({ status: chatActions.status, result: chatActions.result })
        .from(chatActions)
        .where(eq(chatActions.id, action.id)),
    ).resolves.toEqual([{ status: "received", result: { attemptCount: 4 } }]);
    await expect(
      db
        .select({ id: activityLog.id })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.entityId, action.id),
            eq(activityLog.action, "chat.slack_command_retry_anyway"),
          ),
        ),
    ).resolves.toEqual([]);
    await service.shutdown();
  });

  it("preserves delivery quarantine when a slow Slack post finishes after stale recovery", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture);
    const thread = makeThread({
      channelId: "C-SLOW-OUTBOX",
      id: "slack:C-SLOW-OUTBOX:4092.1",
      name: "slow-outbox",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: thread.thread,
      message: makeMessage({
        id: "4092.1",
        text: "@maya create a slow-provider task",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id);
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    const [publication] = await db
      .insert(chatPublications)
      .values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: conversation.id,
        issueId: conversation.issueId,
        idempotencyKey: `slow-provider:${endpoint.id}`,
        payload: { text: "A slow provider accepted this exactly once" },
        state: "pending",
      })
      .returning();
    const endpointRuntime = runtime.endpoints.get(endpoint.id);
    if (!endpointRuntime) throw new Error("Expected Slack runtime");
    endpointRuntime.posts.length = 0;
    let markPostStarted!: () => void;
    const postStarted = new Promise<void>((resolve) => {
      markPostStarted = resolve;
    });
    let releasePost!: () => void;
    const postBlocked = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    endpointRuntime.postHook = async () => {
      markPostStarted();
      await postBlocked;
    };

    const originalWorker = service.processPendingPublications();
    try {
      await postStarted;
      await db
        .update(chatPublications)
        .set({ updatedAt: new Date(Date.now() - 120_000) })
        .where(eq(chatPublications.id, publication.id));
      // An aged but renewed live worker is not orphaned. Explicitly expire its
      // exact durable attempt before simulating the periodic recovery scan.
      await db
        .update(chatEndpointLeases)
        .set({ expiresAt: new Date(0) })
        .where(
          and(
            eq(chatEndpointLeases.endpointId, endpoint.id),
            eq(chatEndpointLeases.leaseKey, `publication:${publication.id}:1`),
          ),
        );
      await service.schedulePendingPublications(0);
      await expect(
        db
          .select({ state: chatPublications.state })
          .from(chatPublications)
          .where(eq(chatPublications.id, publication.id)),
      ).resolves.toEqual([{ state: "delivery_unknown" }]);

      releasePost();
      await originalWorker;
      await service.processPendingPublications();

      expect(endpointRuntime.posts).toEqual([
        {
          threadId: thread.thread.id,
          text: "A slow provider accepted this exactly once",
        },
      ]);
      await expect(
        db
          .select({
            attempts: chatPublications.attempts,
            providerMessageId: chatPublications.providerMessageId,
            state: chatPublications.state,
          })
          .from(chatPublications)
          .where(eq(chatPublications.id, publication.id)),
      ).resolves.toEqual([
        {
          attempts: 1,
          providerMessageId: null,
          state: "delivery_unknown",
        },
      ]);
    } finally {
      releasePost();
      try {
        await originalWorker;
      } finally {
        await service.shutdown();
      }
    }
  });

  it("releases task-control authorization locks before provider I/O and quarantines stale claims", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture);
    const thread = makeThread({
      channelId: "C-CONTROL-CLAIM",
      id: "slack:C-CONTROL-CLAIM:4093.1",
      name: "control-claim",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: thread.thread,
      message: makeMessage({
        id: "4093.1",
        text: "@maya create a task-control claim fixture",
        mentioned: true,
        userId: "U-CONTROL-CLAIM",
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id, "U-CONTROL-CLAIM");
    await service.test(endpoint.id);
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    const [principal] = await db
      .select()
      .from(chatExternalPrincipals)
      .where(
        and(
          eq(chatExternalPrincipals.companyId, fixture.companyId),
          eq(chatExternalPrincipals.externalId, "U-CONTROL-CLAIM"),
        ),
      );
    if (!conversation || !principal) {
      throw new Error("Expected the Slack control authorization fixture");
    }
    const [publication] = await db
      .insert(chatPublications)
      .values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: conversation.id,
        issueId: conversation.issueId,
        idempotencyKey: `control:status:${randomUUID()}`,
        payload: {
          text: "Status",
        },
        state: "pending",
      })
      .returning();
    const [authorization] = await db
      .insert(chatActions)
      .values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: conversation.id,
        principalId: principal.id,
        kind: "task_control_authorization",
        providerActionId: `task-control-authorization:${publication.id}`,
        payload: { publicationId: publication.id },
        status: "issued",
      })
      .returning();
    const endpointRuntime = runtime.endpoints.get(endpoint.id);
    if (!endpointRuntime) throw new Error("Expected Slack runtime");
    endpointRuntime.posts.length = 0;
    let markPostStarted!: () => void;
    const postStarted = new Promise<void>((resolve) => {
      markPostStarted = resolve;
    });
    let releasePost!: () => void;
    const postBlocked = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    endpointRuntime.postHook = async () => {
      markPostStarted();
      await postBlocked;
    };

    const originalWorker = service.processPendingPublications();
    try {
      await postStarted;
      await expect(
        db
          .select({ status: chatActions.status, result: chatActions.result })
          .from(chatActions)
          .where(eq(chatActions.id, authorization.id)),
      ).resolves.toEqual([
        {
          status: "processing",
          result: expect.objectContaining({
            attempts: 1,
            credentialFingerprint: expect.any(String),
            runtimeGeneration: expect.any(Number),
          }),
        },
      ]);

      const authorizationLockProbe = db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`chat-identity:${fixture.companyId}:${principal.id}`}, 0))`,
        );
        return "authorization-lock-released" as const;
      });
      const lockOutcome = await Promise.race([
        authorizationLockProbe,
        new Promise<"authorization-lock-held">((resolve) =>
          setTimeout(() => resolve("authorization-lock-held"), 500),
        ),
      ]);
      if (lockOutcome !== "authorization-lock-released") {
        releasePost();
        await originalWorker;
        await authorizationLockProbe;
      }
      expect(lockOutcome).toBe("authorization-lock-released");

      await db
        .update(chatPublications)
        .set({ updatedAt: new Date(Date.now() - 120_000) })
        .where(eq(chatPublications.id, publication.id));
      await db
        .update(chatEndpointLeases)
        .set({ expiresAt: new Date(0) })
        .where(
          and(
            eq(chatEndpointLeases.endpointId, endpoint.id),
            eq(chatEndpointLeases.leaseKey, `publication:${publication.id}:1`),
          ),
        );
      await service.schedulePendingPublications(0);
      await expect(
        db
          .select({ status: chatActions.status })
          .from(chatActions)
          .where(eq(chatActions.id, authorization.id)),
      ).resolves.toEqual([{ status: "delivery_unknown" }]);

      releasePost();
      await originalWorker;
      await service.processPendingPublications();
      expect(endpointRuntime.posts).toHaveLength(1);
      await expect(
        db
          .select({ state: chatPublications.state })
          .from(chatPublications)
          .where(eq(chatPublications.id, publication.id)),
      ).resolves.toEqual([{ state: "delivery_unknown" }]);

      endpointRuntime.postHook = undefined;
      await service.resolvePublication(
        endpoint.id,
        publication.id,
        "retry_anyway",
        "owner-user",
      );
      await service.processPendingPublications();
      expect(endpointRuntime.posts).toHaveLength(2);
      await expect(
        db
          .select({ status: chatActions.status })
          .from(chatActions)
          .where(eq(chatActions.id, authorization.id)),
      ).resolves.toEqual([{ status: "processed" }]);
    } finally {
      releasePost();
      try {
        await originalWorker;
      } finally {
        await service.shutdown();
      }
    }
  });

  it("does not let Slack reach disables return ahead of in-flight provider sends", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture);
    const thread = makeThread({
      channelId: "C-RESOURCE-OUTBOX",
      id: "slack:C-RESOURCE-OUTBOX:4095.1",
      name: "resource-outbox",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: thread.thread,
      message: makeMessage({
        id: "4095.1",
        text: "@maya create a resource-fenced task",
        mentioned: true,
      }),
      trigger: "mention",
    });
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    const resource = (await service.listResources(endpoint.id)).find(
      (candidate) => candidate.providerResourceId === "C-RESOURCE-OUTBOX",
    );
    if (!resource) throw new Error("Expected the admitted Slack resource");
    const [publication] = await db
      .insert(chatPublications)
      .values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: conversation.id,
        issueId: conversation.issueId,
        idempotencyKey: `resource-fence:${endpoint.id}`,
        payload: { text: "Publication already entering Slack transport" },
        state: "pending",
      })
      .returning();
    const endpointRuntime = runtime.endpoints.get(endpoint.id);
    if (!endpointRuntime) throw new Error("Expected Slack runtime");
    let markPostStarted!: () => void;
    const postStarted = new Promise<void>((resolve) => {
      markPostStarted = resolve;
    });
    let releasePost!: () => void;
    const postBlocked = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    endpointRuntime.postHook = async () => {
      markPostStarted();
      await postBlocked;
    };

    const processing = service.processPendingPublications();
    await postStarted;
    const disabling = service.replaceResources(endpoint.id, [
      { id: resource.id, enabled: false },
    ]);
    await expect(
      Promise.race([
        disabling.then(() => "disabled"),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("transport-in-flight"), 100),
        ),
      ]),
    ).resolves.toBe("transport-in-flight");

    releasePost();
    await Promise.all([processing, disabling]);
    expect(endpointRuntime.posts).toEqual([
      {
        threadId: thread.thread.id,
        text: "Publication already entering Slack transport",
      },
    ]);
    await expect(
      db
        .select({ state: chatPublications.state })
        .from(chatPublications)
        .where(eq(chatPublications.id, publication.id)),
    ).resolves.toEqual([{ state: "published" }]);

    endpointRuntime.postHook = undefined;
    const [revokedPublication] = await db
      .insert(chatPublications)
      .values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: conversation.id,
        issueId: conversation.issueId,
        idempotencyKey: `resource-fence-revoked:${endpoint.id}`,
        payload: { text: "This must not reach Slack after disable" },
        state: "pending",
      })
      .returning();
    await service.processPendingPublications();
    expect(endpointRuntime.posts).toHaveLength(1);
    await expect(
      db
        .select({ state: chatPublications.state })
        .from(chatPublications)
        .where(eq(chatPublications.id, revokedPublication.id)),
    ).resolves.toEqual([{ state: "cancelled" }]);

    const dm = makeThread({
      channelId: "D-REACH-OUTBOX",
      id: "slack:D-REACH-OUTBOX:",
      isDM: true,
      name: "direct message",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: dm.thread,
      message: makeMessage({
        id: "4096.1",
        text: "create a direct-message-fenced task",
      }),
      trigger: "direct_message",
    });
    const dmConversation = (await service.listConversations(endpoint.id)).find(
      (candidate) => candidate.externalThreadId === dm.thread.id,
    );
    if (!dmConversation) throw new Error("Expected the admitted Slack DM");
    const [dmPublication] = await db
      .insert(chatPublications)
      .values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: dmConversation.id,
        issueId: dmConversation.issueId,
        idempotencyKey: `dm-reach-fence:${endpoint.id}`,
        payload: { text: "DM publication already entering Slack transport" },
        state: "pending",
      })
      .returning();
    let markDmPostStarted!: () => void;
    const dmPostStarted = new Promise<void>((resolve) => {
      markDmPostStarted = resolve;
    });
    let releaseDmPost!: () => void;
    const dmPostBlocked = new Promise<void>((resolve) => {
      releaseDmPost = resolve;
    });
    endpointRuntime.postHook = async () => {
      markDmPostStarted();
      await dmPostBlocked;
    };

    const processingDm = service.processPendingPublications();
    await dmPostStarted;
    const disablingDm = service.update(
      endpoint.id,
      { allowDirectMessages: false },
      "owner-user",
    );
    await expect(
      Promise.race([
        disablingDm.then(() => "disabled"),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("transport-in-flight"), 100),
        ),
      ]),
    ).resolves.toBe("transport-in-flight");

    releaseDmPost();
    await Promise.all([processingDm, disablingDm]);
    expect(endpointRuntime.posts.at(-1)).toEqual({
      threadId: dm.thread.id,
      text: "DM publication already entering Slack transport",
    });
    await expect(
      db
        .select({ state: chatPublications.state })
        .from(chatPublications)
        .where(eq(chatPublications.id, dmPublication.id)),
    ).resolves.toEqual([{ state: "published" }]);

    endpointRuntime.postHook = undefined;
    const [revokedDmPublication] = await db
      .insert(chatPublications)
      .values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: dmConversation.id,
        issueId: dmConversation.issueId,
        idempotencyKey: `dm-reach-fence-revoked:${endpoint.id}`,
        payload: { text: "This must not reach Slack after DM disable" },
        state: "pending",
      })
      .returning();
    await service.processPendingPublications();
    expect(endpointRuntime.posts).toHaveLength(2);
    await expect(
      db
        .select({ state: chatPublications.state })
        .from(chatPublications)
        .where(eq(chatPublications.id, revokedDmPublication.id)),
    ).resolves.toEqual([{ state: "cancelled" }]);
    await service.shutdown();
  });

  it("streams long output in bounded chunks after applying the safe external projection", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture);
    const channel = makeThread({
      channelId: "C-LONG-SAFE",
      id: "slack:C-LONG-SAFE:4100.1",
      name: "long-safe-output",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: channel.thread,
      message: makeMessage({
        id: "4100.1",
        text: "@maya send the long public summary",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id);
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    const publicParagraph = "External-safe result. ".repeat(220).trim();
    const comment = await issueService(db).addComment(
      conversation.issueId,
      `${publicParagraph}\n\n<analysis>private chain of thought must never stream</analysis>`,
      { userId: "owner-user" },
      { authorType: "user" },
    );

    await service.publishComment(endpoint.id, conversation.id, comment.id);
    const [publication] = await readChatPublicationsByCommentId(comment.id);
    expect(publication).toMatchObject({
      state: "published",
      payload: { text: publicParagraph },
    });
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    const streamed = providerRuntime?.posts.at(-1);
    expect(streamed?.chunks?.length).toBeGreaterThan(1);
    expect(
      streamed?.chunks?.every((chunk) => Array.from(chunk).length <= 2_000),
    ).toBe(true);
    expect(streamed?.chunks?.join("")).toBe(publication.payload.text);
    expect(streamed?.text).toBe(publicParagraph);
    expect(JSON.stringify(streamed)).not.toContain("private chain of thought");
  });

  it("imports every Discord upload when text files include MIME parameters", async () => {
    const fixture = await seedCompany();
    const storage = createStorageService();
    const { callbacks, endpoint, service, wakeup } =
      await configuredDiscordEndpoint(fixture, { storage: storage.storage });
    const textBody = Buffer.from("multi-file Discord text", "utf8");
    const imageBody = Buffer.from("multi-file Discord image", "utf8");
    const textFetch = vi.fn(async () => textBody);
    const imageFetch = vi.fn(async () => imageBody);
    const rejectedFetch = vi.fn(async () => Buffer.from("not imported"));
    const rootMessageId = "555555555555555596";
    const channel = makeThread({
      channelId: "333333333333333329",
      id: `discord:1457808928258658549:333333333333333329:${rootMessageId}`,
      name: "discord-multi-upload",
    });

    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "discord",
      thread: channel.thread,
      message: makeMessage({
        attachments: [
          {
            type: "file",
            name: "native-inbound.txt",
            mimeType: "text/plain; charset=utf-8",
            size: textBody.length,
            fetchData: textFetch,
            fetchMetadata: { testRecoveryKey: "discord-multi-text" },
          } as Attachment,
          {
            type: "image",
            name: "native-inbound.png",
            mimeType: "image/png",
            size: imageBody.length,
            fetchData: imageFetch,
            fetchMetadata: { testRecoveryKey: "discord-multi-image" },
          } as Attachment,
          {
            type: "file",
            name: "unsupported.exe",
            mimeType: "application/x-msdownload",
            size: 12,
            fetchData: rejectedFetch,
          } as Attachment,
        ],
        id: rootMessageId,
        mentioned: true,
        text: "@maya inspect both files",
      }),
      trigger: "mention",
    });

    expect(textFetch).toHaveBeenCalledTimes(1);
    expect(imageFetch).toHaveBeenCalledTimes(1);
    expect(rejectedFetch).not.toHaveBeenCalled();
    expect(storage.putFile).toHaveBeenCalledTimes(2);
    const [delivery] = await readChatDeliveriesByEndpointId(endpoint.id);
    expect(delivery).toMatchObject({
      state: "processed",
      redactedError: "1 external attachment was omitted (unsupported type: 1)",
    });
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup.mock.calls[0]?.[1]?.contextSnapshot).toMatchObject({
      externalAttachmentOmissions: [
        {
          commentId: expect.any(String),
          reasons: { unsupported_type: 1 },
        },
      ],
    });
    const [conversation] = await service.listConversations(endpoint.id);
    if (!conversation) throw new Error("Expected Discord upload conversation");
    await expect(
      db
        .select({
          contentType: assets.contentType,
          originalFilename: assets.originalFilename,
        })
        .from(issueAttachments)
        .innerJoin(assets, eq(assets.id, issueAttachments.assetId))
        .where(eq(issueAttachments.issueId, conversation.issueId))
        .orderBy(asc(assets.originalFilename)),
    ).resolves.toEqual([
      {
        contentType: "image/png",
        originalFilename: "native-inbound.png",
      },
      {
        contentType: "text/plain",
        originalFilename: "native-inbound.txt",
      },
    ]);
  });

  it("audits repeated Discord reaction cycles while deduplicating an exact Gateway replay", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } =
      await configuredDiscordEndpoint(fixture);
    const rootMessageId = "555555555555555597";
    const channel = makeThread({
      channelId: "333333333333333330",
      id: `discord:1457808928258658549:333333333333333330:${rootMessageId}`,
      name: "discord-reaction-cycles",
    });
    const original = makeMessage({
      id: rootMessageId,
      mentioned: true,
      text: "@maya observe repeated reactions",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "discord",
      thread: channel.thread,
      message: original,
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id);
    if (!callbacks.onReaction) {
      throw new Error("Discord reaction callback was not registered");
    }
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    if (!conversation) throw new Error("Expected Discord conversation");
    const commentCountBefore = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.issueId, conversation.issueId))
      .then((rows) => rows.length);
    const wakeupCountBefore = wakeup.mock.calls.length;
    const emoji = {
      name: "thumbsup",
      toJSON: () => "👍",
      toString: () => "👍",
    };
    const reaction = (
      added: boolean,
      sessionFingerprint: string,
      sequence: number,
    ) => ({
      endpointId: endpoint.id,
      provider: "discord" as const,
      event: {
        adapter: {} as never,
        added,
        emoji,
        message: original,
        messageId: original.id,
        raw: {
          channel_id: "333333333333333330",
          emoji: { id: null, name: "👍" },
          gateway_dispatch: {
            eventType: added
              ? "MESSAGE_REACTION_ADD"
              : "MESSAGE_REACTION_REMOVE",
            sequence,
            sessionFingerprint,
            shardId: 0,
          },
          guild_id: "1457808928258658549",
          message_id: original.id,
          user_id: original.author.userId,
        },
        rawEmoji: "👍",
        thread: channel.thread,
        threadId: channel.thread.id,
        user: original.author,
      },
    });
    const firstSession = "a".repeat(24);
    const nextSession = "b".repeat(24);

    await callbacks.onReaction(reaction(true, firstSession, 42));
    await callbacks.onReaction(reaction(true, firstSession, 42));
    await callbacks.onReaction(reaction(false, firstSession, 43));
    await callbacks.onReaction(reaction(true, firstSession, 44));
    await callbacks.onReaction(reaction(false, firstSession, 45));
    await callbacks.onReaction(reaction(true, nextSession, 42));

    const reactions = await db
      .select()
      .from(chatDeliveries)
      .where(eq(chatDeliveries.conversationId, conversation.id))
      .then((rows) =>
        rows.filter((row) => row.eventKind.startsWith("reaction_")),
      );
    expect(reactions).toHaveLength(5);
    expect(new Set(reactions.map((row) => row.providerEventId)).size).toBe(5);
    expect(reactions.map((row) => row.eventKind).sort()).toEqual([
      "reaction_added",
      "reaction_added",
      "reaction_added",
      "reaction_removed",
      "reaction_removed",
    ]);
    expect(reactions.every((row) => row.state === "processed")).toBe(true);
    await expect(
      db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(eq(issueComments.issueId, conversation.issueId)),
    ).resolves.toHaveLength(commentCountBefore);
    expect(wakeup.mock.calls).toHaveLength(wakeupCountBefore);
    await service.shutdown();
  });
});
