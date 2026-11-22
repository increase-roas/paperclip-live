/**
 * Harness for the chat-channel control-plane integration suites.
 *
 * Owns the database, the secrets key file, the per-case fixture cleanup and the
 * helpers every provider area uses. Area files call
 * `describeChatChannelsSuite(name, () => { ...describes })`; the helpers are
 * module-level exports bound to this file's own database instance.
 */
import {
  reconcilePersistedRuntimeServicesOnStartup,
  readWorkspaceRuntimeIdleWork,
} from "../../services/workspace-runtime.js";
import {
  readIdleLocalWork,
} from "../../services/idle-local-work.js";
import {
  requestTaskRetry,
} from "../../services/task-retry.js";
import {
  withQueuedCommentIdsInWakePayload,
} from "../../services/issue-queued-comment-queue.js";
import {
  createSystemRecovery,
} from "../../services/system-recovery-state.js";
import {
  createDeliveryWorkCoordinator,
} from "../../services/delivery-work-coordinator.js";
import {
  githubChatManagementService,
} from "../../services/chat-github-management.js";
import {
  githubResponseCommentService,
} from "../../services/chat-github-response-comments.js";
import {
  syncGitHubBotTools,
} from "../../services/chat-github-tools.js";
import {
  agentWakeupRequests,
  agents,
  applyPendingMigrations,
  authUsers,
  chatActions,
  chatConversations,
  chatDeliveries,
  chatEndpointLeases,
  chatEndpointResources,
  chatEndpoints,
  chatExternalPrincipals,
  chatGitHubConfigurations,
  chatGitHubRegistrations,
  chatGitHubReviews,
  chatIdentityLinks,
  chatMessageLinks,
  chatPublications,
  chatTeamsFileTransfers,
  closeCheckpointDb,
  closeFileStorageDb,
  closeLivenessDb,
  companies,
  companyMemberships,
  completionContracts,
  createDb,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  principalPermissionGrants,
  toolConnections,
} from "@paperclipai/db";
import {
  createHash,
  createHmac,
  generateKeyPairSync,
  randomUUID,
} from "node:crypto";
import {
  mkdirSync,
  rmSync,
} from "node:fs";
import {
  Readable,
} from "node:stream";
import {
  and,
  eq,
  inArray,
  notInArray,
  sql,
} from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  vi,
} from "vitest";
import {
  type ChatProvider,
} from "@paperclipai/shared";
import {
  errorHandler,
} from "../../middleware/index.js";
import {
  chatChannelService,
  type ChatChannelServiceOptions,
  type ChatChannelService,
} from "../../services/chat-channels.js";
import {

} from "@chat-adapter/teams";
import {
  issueService,
} from "../../services/issues.js";
import {

} from "../../services/issue-thread-interactions.js";
import {

} from "../../services/chat-interaction-publications.js";
import {
  resolveChatRunPresentationAuthorizationReason,
} from "../../services/chat-run-publications.js";
import {
  heartbeatService,
} from "../../services/heartbeat.js";
import {
  githubPublicAttachmentsFromMessage,
} from "../../services/chat-github-attachments.js";
import {
  finalizeNativeRun,
  repairCommittedNativeChatResponse,
} from "../../services/native-runtime/native-run-finalizer.js";
import {
  NativeRunCoordinatorStore,
} from "../../services/native-runtime/native-run-coordinator-store.js";
import {
  PaperclipControlPlanePort,
} from "../../services/native-runtime/paperclip-control-plane-port.js";
import {
  startEmbeddedPostgresTestDatabase,
} from "./embedded-postgres.js";
import {
  slackProtocolCapture,
  slackProtocolDatabaseUrl,
  externalTestDatabaseUrl,
  describeEmbeddedPostgres,
  TestDb,
  FakeEndpointRuntime,
  FakeChatSdkRuntime,
  uniqueDiscordApplicationId,
  fakeSlackFetch,
  fakeDiscordFetch,
  fakeTelegramFetch,
  chatSdkProvider,
  makeThread,
  makeMessage,
  boardActor,
} from "./chat-channels-fixture.js";
import {

} from "../../services/chat-github-reviews.js";
import {

} from "../../services/chat-github-events.js";
import {

} from "../../services/chat-github-checks.js";
import {

} from "@chat-adapter/discord";
import {

} from "../../services/chat-sdk-runtime.js";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { Message, Thread } from "chat";
import type { CreateChatSdkEndpointRuntimeOptions, ChatSdkMessageTrigger, ChatSdkRuntime } from "../../services/chat-sdk-runtime.js";
import type { StorageService } from "../../storage/types.js";
import * as attachmentEgress from "../../services/remote-http-fetch.js";
import type {
  PrpStructuredRunResult,
  PrpTerminalState,
} from "../../vendor/paperclip-runner/index.js";

export function describeChatChannelsSuite(name: string, body: () => void) {
  describeEmbeddedPostgres(name, () => {
      beforeAll(async () => {
        if (slackProtocolDatabaseUrl) await applyPendingMigrations(slackProtocolDatabaseUrl);
        mkdirSync(secretsTmpDir, { recursive: true });
        process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(
          secretsTmpDir,
          "master.key",
        );
        if (!externalTestDatabaseUrl) {
          tempDb = await startEmbeddedPostgresTestDatabase("paperclip-chat-channels-");
        }
        // Scheduler tests advance virtual time while PostgreSQL uses real I/O.
        // Do not expire or time out its connections on those virtual clock jumps.
        db = createDb(externalTestDatabaseUrl ?? tempDb!.connectionString, {
          idleTimeoutSeconds: 0, connectTimeoutSeconds: 0, maxLifetimeSeconds: 0,
          ...(externalTestDatabaseUrl ? { maxConnections: 4 } : {}),
        });
        // The composed local-probe inventory includes the workspace owner. Match
        // server startup on this fresh fixture; never adopt or start a leftover.
        const [runtimeState] = await db.execute<{ configured: boolean }>(sql`SELECT
          EXISTS (SELECT 1 FROM workspace_runtime_services)
          OR EXISTS (SELECT 1 FROM project_workspaces)
          OR EXISTS (SELECT 1 FROM execution_workspaces) AS configured`);
        expect(runtimeState.configured).toBe(false);
        expect(await reconcilePersistedRuntimeServicesOnStartup(db)).toEqual({
          reconciled: 0, adopted: 0, stopped: 0, backfilled: 0, restarted: 0,
          restartFailed: 0, exposureReservationDrift: [],
        });
        expect(readWorkspaceRuntimeIdleWork()).toBe("none");
      }, 90_000);

      afterAll(async () => {
        if (slackProtocolCapture && db) { await closeCheckpointDb(db, 1); await closeFileStorageDb(db, 1); await closeLivenessDb(db, 1); }
        await db?.$client.end();
        await tempDb?.cleanup();
        if (previousKeyFile === undefined)
          delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
        else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
        rmSync(secretsTmpDir, { recursive: true, force: true });
      });

      afterEach(async () => {
        try {
          await Promise.all([...fixtureServices].map((service) => service.shutdown()));
        } finally {
          const companyIds = [...fixtureCompanies];
          await retireFixtureState(companyIds);
          if (companyIds.length > 0) {
            // Pausing an endpoint does not remove its rows from global recovery
            // selectors. After every assertion and worker shutdown, settle leftover
            // fixture work so later cases cannot claim its leases or retry its I/O.
            await db.update(chatActions).set({ status: "cancelled" })
              .where(and(inArray(chatActions.companyId, companyIds), notInArray(chatActions.status, ["processed", "cancelled"])));
            await db.update(chatDeliveries).set({ state: "failed", nextAttemptAt: null })
              .where(and(inArray(chatDeliveries.companyId, companyIds), inArray(chatDeliveries.state, ["received", "processing", "retry"])));
            await db.update(chatPublications).set({ state: "cancelled", nextAttemptAt: null })
              .where(and(inArray(chatPublications.companyId, companyIds), inArray(chatPublications.state, ["pending", "awaiting_consent", "streaming", "retry"])));
          }
          fixtureServices.clear();
          fixtureCompanies.clear();
        }
      });

    body();
  });
}

  export let db!: TestDb;

  export let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;

  export const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;

  export const secretsTmpDir = path.join(
    os.tmpdir(),
    `paperclip-chat-channels-${randomUUID()}`,
  );

  export const fixtureCompanies = new Set<string>();

  export const fixtureServices = new Set<ChatChannelService>();

  export async function retireFixtureState(companyIds: string[]) {
    if (companyIds.length === 0) return;
    // Verifying endpoints can also own receipts. Once a receipt is 60s old,
    // another test's global sweep can reclaim it. Retire every live endpoint,
    // then release synthetic lease owners after their services have stopped.
    await db.update(chatEndpoints).set({ status: "paused" })
      .where(and(inArray(chatEndpoints.companyId, companyIds), notInArray(chatEndpoints.status, ["archived", "revoked"])));
    await db.delete(chatEndpointLeases)
      .where(inArray(chatEndpointLeases.companyId, companyIds));
    // The milestone scanner includes paused endpoints with active bindings.
    await db.update(chatConversations).set({ state: "completed" })
      .where(and(inArray(chatConversations.companyId, companyIds), inArray(chatConversations.state, ["active", "waiting"])));
  }

  export const companyPrefixAttempts = 8;

  export const freshCompanyPrefix = () => `C${randomUUID().replaceAll("-", "").slice(0, 7).toUpperCase()}`;

  export async function seedCompany(nextIssuePrefix = freshCompanyPrefix, companyId: string = randomUUID()) {
    const assignedAgentId = randomUUID();
    const replacementAgentId = randomUUID();
    let inserted = false;
    // Retired fixtures retain company rows. Retry only the short-prefix unique
    // conflict; every other database error must still fail the test immediately.
    for (let attempt = 0; attempt < companyPrefixAttempts; attempt += 1) {
      const [company] = await db.insert(companies).values({
        id: companyId,
        name: `Chat Test ${companyId.slice(0, 8)}`,
        issuePrefix: nextIssuePrefix(),
        requireBoardApprovalForNewAgents: false,
      }).onConflictDoNothing({ target: companies.issuePrefix }).returning({ id: companies.id });
      if (company) {
        inserted = true;
        fixtureCompanies.add(companyId);
        break;
      }
    }
    if (!inserted) throw new Error(`Could not allocate a chat fixture company prefix after ${companyPrefixAttempts} attempts`);
    const now = new Date();
    await db
      .insert(authUsers)
      .values({
        id: "owner-user",
        name: "Owner User",
        email: "owner-user@example.com",
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "owner-user",
      status: "active",
      membershipRole: "operator",
    });
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "user",
      principalId: "owner-user",
      permissionKey: "tools:manage_connections",
      scope: null,
      grantedByUserId: "owner-user",
    });
    await db.insert(agents).values([
      {
        id: assignedAgentId,
        companyId,
        name: "Maya",
        role: "engineer",
        status: "idle",
        adapterType: "paperclip_runner",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: replacementAgentId,
        companyId,
        name: "Linus",
        role: "engineer",
        status: "idle",
        adapterType: "paperclip_runner",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    return { companyId, assignedAgentId, replacementAgentId };
  }

  export function readChatConversationsByEndpointId(value: (typeof chatConversations.$inferSelect)["endpointId"]) {
    return db.select().from(chatConversations).where(eq(chatConversations.endpointId, value));
  }

  export function readChatEndpointsById(value: (typeof chatEndpoints.$inferSelect)["id"]) {
    return db.select().from(chatEndpoints).where(eq(chatEndpoints.id, value));
  }

  export function readIssueCommentsByIssueId(value: (typeof issueComments.$inferSelect)["issueId"]) {
    return db.select().from(issueComments).where(eq(issueComments.issueId, value));
  }

  export function readChatDeliveriesByEndpointId(value: (typeof chatDeliveries.$inferSelect)["endpointId"]) {
    return db.select().from(chatDeliveries).where(eq(chatDeliveries.endpointId, value));
  }

  export function readChatDeliveriesById(value: (typeof chatDeliveries.$inferSelect)["id"]) {
    return db.select().from(chatDeliveries).where(eq(chatDeliveries.id, value));
  }

  export function readHeartbeatRunsById(value: (typeof heartbeatRuns.$inferSelect)["id"]) {
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, value));
  }

  export function readIssuesById(value: (typeof issues.$inferSelect)["id"]) {
    return db.select().from(issues).where(eq(issues.id, value));
  }

  export function readChatActionsById(value: (typeof chatActions.$inferSelect)["id"]) {
    return db.select().from(chatActions).where(eq(chatActions.id, value));
  }

  export function readChatGitHubReviewsByEndpointId(value: (typeof chatGitHubReviews.$inferSelect)["endpointId"]) {
    return db.select().from(chatGitHubReviews).where(eq(chatGitHubReviews.endpointId, value));
  }

  export function readChatPublicationsByEndpointId(value: (typeof chatPublications.$inferSelect)["endpointId"]) {
    return db.select().from(chatPublications).where(eq(chatPublications.endpointId, value));
  }

  export function readChatPublicationsById(value: (typeof chatPublications.$inferSelect)["id"]) {
    return db.select().from(chatPublications).where(eq(chatPublications.id, value));
  }

  export function readChatGitHubRegistrationsByEndpointId(value: (typeof chatGitHubRegistrations.$inferSelect)["endpointId"]) {
    return db.select().from(chatGitHubRegistrations).where(eq(chatGitHubRegistrations.endpointId, value));
  }

  export function readToolConnectionsById(value: (typeof toolConnections.$inferSelect)["id"]) {
    return db.select().from(toolConnections).where(eq(toolConnections.id, value));
  }

  export function readChatConversationsById(value: (typeof chatConversations.$inferSelect)["id"]) {
    return db.select().from(chatConversations).where(eq(chatConversations.id, value));
  }

  export function readIssuesByCompanyId(value: (typeof issues.$inferSelect)["companyId"]) {
    return db.select().from(issues).where(eq(issues.companyId, value));
  }

  export function readChatPublicationsByCommentId(value: NonNullable<(typeof chatPublications.$inferSelect)["commentId"]>) {
    return db.select().from(chatPublications).where(eq(chatPublications.commentId, value));
  }

  export function readChatActionsByProviderActionId(value: (typeof chatActions.$inferSelect)["providerActionId"]) {
    return db.select().from(chatActions).where(eq(chatActions.providerActionId, value));
  }

  export function readChatPublicationsByIdempotencyKey(value: (typeof chatPublications.$inferSelect)["idempotencyKey"]) {
    return db.select().from(chatPublications).where(eq(chatPublications.idempotencyKey, value));
  }

  export function readHeartbeatRunsByCompanyId(value: (typeof heartbeatRuns.$inferSelect)["companyId"]) {
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, value));
  }

  export function readAgentWakeupRequestsById(value: (typeof agentWakeupRequests.$inferSelect)["id"]) {
    return db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, value));
  }

  export function readIssueCommentsByCompanyId(value: (typeof issueComments.$inferSelect)["companyId"]) {
    return db.select().from(issueComments).where(eq(issueComments.companyId, value));
  }

  export function readChatTeamsFileTransfersById(value: (typeof chatTeamsFileTransfers.$inferSelect)["id"]) {
    return db.select().from(chatTeamsFileTransfers).where(eq(chatTeamsFileTransfers.id, value));
  }

  export function receiptBackedWakeup(
    wakeup: ChatChannelServiceOptions["heartbeat"]["wakeup"],
  ): ChatChannelServiceOptions["heartbeat"]["wakeup"] {
    return async (agentId, opts) => {
      const result = await wakeup(agentId, opts);
      const request = opts.durableChatRequest;
      if (request && result !== null && result !== undefined) {
        const [existing] = await db
          .select({ id: agentWakeupRequests.id })
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.id, request.id));
        if (existing) return result;
        await db.transaction(async (tx) => {
          await request.authorize(
            tx as unknown as Parameters<typeof request.authorize>[0],
          );
          await tx
            .insert(agentWakeupRequests)
            .values({
              id: request.id,
              companyId: request.companyId,
              agentId,
              source: opts.source ?? "assignment",
              triggerDetail: opts.triggerDetail,
              reason: opts.reason,
              payload: opts.payload,
              requestedByActorType: opts.requestedByActorType,
              requestedByActorId: opts.requestedByActorId,
              idempotencyKey: request.idempotencyKey,
              requestedAt: request.requestedAt,
              status: "queued",
            })
            .onConflictDoNothing();
        });
      }
      return result;
    };
  }

  export function createService(
    runtime = new FakeChatSdkRuntime(),
    providerFetch: typeof globalThis.fetch = fakeSlackFetch() as typeof globalThis.fetch,
    overrides: Partial<
      Pick<
        ChatChannelServiceOptions,
        | "credentialMutationLeaseRenewalIntervalMs"
        | "deferWebhookProcessing"
        | "discordGatewayEventBarrier"
        | "discordGatewayMessageAdmissionBarrier"
        | "discordRootThreadTransportBarrier"
        | "discordGatewayLeaseRenewalIntervalMs"
        | "discordGatewayLeaseTtlMs"
        | "discordGatewayLeaseWaitMs"
        | "githubWebhookAuthenticationBarrier"
        | "githubWebhookReplayBarrier"
        | "githubWebhookResponseBudgetMs"
        | "publicationTransportPreparationBarrier"
        | "renderSlackAvatar"
        | "slackManaged"
        | "publicBaseUrl"
        | "webhookPublicBaseUrl"
        | "nativeBotIdentityClaimBarrier"
        | "confirmationResolutionPersistBarrier"
        | "conversationLeaseRenewalIntervalMs"
        | "questionFormOpenAuthorizationBarrier"
        | "questionResolutionPersistBarrier"
        | "reactionLinkPreflightBarrier"
        | "reactionReplayConversationLockBarrier"
        | "reactionReplayEndpointLockBarrier"
        | "receiptReactionTransportBarrier"
        | "resolveNativeQuestion"
        | "renewCredentialMutationLease"
        | "renewConversationDeliveryLease"
        | "renewDiscordGatewayLease"
        | "scheduleDeferredWork"
        | "slackTaskAdmissionClaimBarrier"
        | "slackSessionSyncSelectionBarrier"
        | "setupSecretActivityLogger"
        | "setupSecretCredentialPersistBarrier"
        | "setupSecretFinalOwnershipBarrier"
        | "setupTestActivationBarrier"
        | "storage"
        | "reachAuthorizationBarrier"
      >
    > & {
      cancelRun?: NonNullable<
        ChatChannelServiceOptions["heartbeat"]["cancelRun"]
      >;
      wakeup?: ChatChannelServiceOptions["heartbeat"]["wakeup"];
    } = {},
  ) {
    const {
      cancelRun: cancelRunOverride,
      wakeup: wakeupOverride,
      ...serviceOverrides
    } = overrides;
    const wakeup = vi.fn<ChatChannelServiceOptions["heartbeat"]["wakeup"]>(wakeupOverride ?? (async () => ({ accepted: true })));
    const cancelRun = vi.fn<NonNullable<ChatChannelServiceOptions["heartbeat"]["cancelRun"]>>(
      cancelRunOverride ?? (async () => ({ status: "cancelled" })),
    );
    const service = chatChannelService(db, {
      fetch: providerFetch,
      heartbeat: { cancelRun, wakeup: receiptBackedWakeup(wakeup) },
      publicBaseUrl: "https://paperclip.example",
      runtime: runtime as unknown as ChatSdkRuntime,
      ...serviceOverrides,
    });
    fixtureServices.add(service);
    return { cancelRun, runtime, service, wakeup };
  }

  export function createStorageService() {
    const objects = new Map<string, Buffer>();
    const putFile = vi.fn<StorageService["putFile"]>(async (input) => {
      if (!Buffer.isBuffer(input.body)) throw new Error("Expected a buffered attachment body");
      const objectKey = `${input.namespace}/${randomUUID()}-${input.originalFilename ?? "attachment"}`;
      objects.set(objectKey, input.body);
      return {
        provider: "local_disk",
        objectKey,
        contentType: input.contentType,
        byteSize: input.body.length,
        sha256: createHash("sha256").update(input.body).digest("hex"),
        originalFilename: input.originalFilename,
      };
    });
    const storage: StorageService = {
      provider: "local_disk",
      putFile,
      getObject: vi.fn(async (_companyId, objectKey) => {
        const body = objects.get(objectKey);
        if (!body) throw new Error(`Missing test object ${objectKey}`);
        return {
          stream: Readable.from([body]),
          contentLength: body.length,
        };
      }),
      headObject: vi.fn(async (_companyId, objectKey) => ({
        exists: objects.has(objectKey),
        contentLength: objects.get(objectKey)?.length,
      })),
      deleteObject: vi.fn(async (_companyId, objectKey) => {
        objects.delete(objectKey);
      }),
    };
    return { objects, putFile, storage };
  }

  export async function retirePublicationFixture(
    service: ChatChannelService,
    endpointId: string,
  ) {
    try {
      await service.shutdown();
    } finally {
      // Workers scan the shared fixture database. Local shutdown alone leaves
      // future retries/receipts eligible for the next test's service. Preserve
      // their asserted audit state, but retire this endpoint after assertions.
      await db
        .update(chatEndpoints)
        .set({ status: "paused" })
        .where(
          and(
            eq(chatEndpoints.id, endpointId),
            eq(chatEndpoints.status, "active"),
          ),
        );
    }
  }

  export async function recordSlackUrlVerification(
    service: ChatChannelService,
    publicId: string,
    signingSecret = "test-signing-secret",
  ) {
    const response = await service.handleWebhook(
      publicId,
      "slack",
      signedSlackWebhookRequest({
        url: `https://paperclip.example/api/chat-webhooks/${publicId}/slack`,
        contentType: "application/json",
        body: JSON.stringify({ type: "url_verification", challenge: "verified-challenge" }),
        signingSecret,
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challenge: "verified-challenge" });
  }

  export function signedSlackWebhookRequest(input: {
    url: string;
    body: string;
    contentType: string;
    signingSecret?: string;
    timestamp?: string;
  }) {
    const timestamp = input.timestamp ?? String(Math.floor(Date.now() / 1000));
    const signature = createHmac(
      "sha256",
      input.signingSecret ?? "test-signing-secret",
    )
      .update(`v0:${timestamp}:${input.body}`)
      .digest("hex");
    return new Request(input.url, {
      method: "POST",
      headers: {
        "content-type": input.contentType,
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": `v0=${signature}`,
      },
      body: input.body,
    });
  }

  export function githubWebhookVerificationResponse(
    service: ChatChannelService,
    publicId: string,
    webhookSecret: string,
    providerDeliveryId = `github-setup-ping-${randomUUID()}`,
  ) {
    const body = JSON.stringify({ zen: "Keep it logically awesome." });
    const signature = createHmac("sha256", webhookSecret)
      .update(body)
      .digest("hex");
    return service.handleWebhook(
      publicId,
      "github",
      new Request(
        `https://paperclip.example/api/chat-webhooks/${publicId}/github`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-github-delivery": providerDeliveryId,
            "x-github-event": "ping",
            "x-hub-signature-256": `sha256=${signature}`,
          },
          body,
        },
      ),
    );
  }

  export async function recordGitHubWebhookVerification(
    service: ChatChannelService,
    publicId: string,
    webhookSecret: string,
  ) {
    const providerDeliveryId = `github-setup-ping-${randomUUID()}`;
    const response = await githubWebhookVerificationResponse(
      service,
      publicId,
      webhookSecret,
      providerDeliveryId,
    );
    expect([200, 202]).toContain(response.status);
    const action = await db
      .select({ id: chatActions.id })
      .from(chatActions)
      .innerJoin(chatEndpoints, eq(chatEndpoints.id, chatActions.endpointId))
      .where(
        and(
          eq(chatEndpoints.publicId, publicId),
          eq(
            chatActions.providerActionId,
            `github_webhook_ingress:${providerDeliveryId}`,
          ),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (action) {
      await service.processPendingGitHubWebhookIngress(1, action.id);
    }
    await vi.waitFor(async () => {
      const setup = await db
        .select({ setup: chatEndpoints.setup })
        .from(chatEndpoints)
        .where(eq(chatEndpoints.publicId, publicId))
        .then((rows) => rows[0]?.setup);
      expect(setup).toMatchObject({ webhookVerifiedAt: expect.any(String) });
    });
  }

  export function signedGitHubWebhookRequest(input: {
    delivery: string;
    event: string;
    payload: unknown;
    webhookSecret: string;
    url?: string;
  }) {
    const body = JSON.stringify(input.payload);
    const signature = createHmac("sha256", input.webhookSecret)
      .update(body)
      .digest("hex");
    return new Request(input.url ?? "https://paperclip.example/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": input.event,
        "x-github-delivery": input.delivery,
        "x-hub-signature-256": `sha256=${signature}`,
      },
      body,
    });
  }

  export async function chatWakeContext(input: {
    endpointId: string;
    issueId: string;
    provider: ChatProvider;
    providerMessageId: string;
  }) {
    const wakeCommentId = await db
      .select({ commentId: chatMessageLinks.commentId })
      .from(chatMessageLinks)
      .where(
        and(
          eq(chatMessageLinks.endpointId, input.endpointId),
          eq(chatMessageLinks.providerMessageId, input.providerMessageId),
          eq(chatMessageLinks.direction, "inbound"),
        ),
      )
      .then((rows) => rows[0]?.commentId ?? null);
    if (!wakeCommentId) {
      throw new Error(
        `Expected inbound comment link ${input.providerMessageId}`,
      );
    }
    return {
      issueId: input.issueId,
      source: `chat:${input.provider}`,
      wakeCommentId,
      wakeCommentIds: [wakeCommentId],
    };
  }

  export async function addSelectedChatFinal(input: {
    agentId: string;
    body: string;
    companyId: string;
    issueId: string;
    runId: string;
  }) {
    const authorizationReason =
      await resolveChatRunPresentationAuthorizationReason(db, {
        companyId: input.companyId,
        issueId: input.issueId,
        runId: input.runId,
      });
    return issueService(db).addComment(
      input.issueId,
      input.body,
      { agentId: input.agentId, runId: input.runId },
      { authorType: "agent", authorizationReason },
    );
  }

  export async function qualifySetupRoundTrip(
    service: ChatChannelService,
    endpointId: string,
    userId = "U-EXTERNAL",
  ) {
    const endpoint = await service.get(endpointId);
    let conversation: typeof chatConversations.$inferSelect | undefined;
    await vi.waitFor(async () => {
      conversation = await readChatConversationsByEndpointId(endpointId)
        .then((rows) => rows.at(-1));
      expect(conversation).toBeDefined();
    });
    if (!conversation) throw new Error("Expected setup conversation");
    const fakeRuntime = service.runtime as unknown as FakeChatSdkRuntime;
    const callbacks = fakeRuntime.configurations.get(endpointId)?.callbacks;
    if (!callbacks) throw new Error("Expected setup callbacks");
    const { thread } = makeThread({
      id: conversation.externalThreadId,
      channelId: conversation.externalConversationId,
      isDM: conversation.isDirectMessage,
      name: conversation.externalLabel,
    });
    const setupFollowUpMessageId = `setup-follow-up-${randomUUID()}`;
    await callbacks.onMessage({
      endpointId,
      provider: chatSdkProvider(endpoint.provider),
      thread,
      message: makeMessage({
        id: setupFollowUpMessageId,
        text: "Setup follow-up",
        mentioned: endpoint.provider === "slack",
        userId,
      }),
      trigger:
        endpoint.provider === "telegram"
          ? "direct_message"
          : "subscribed_message",
    });
    const contextSnapshot = await chatWakeContext({
      endpointId,
      issueId: conversation.issueId,
      provider: endpoint.provider,
      providerMessageId: setupFollowUpMessageId,
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: endpoint.companyId,
      agentId: endpoint.assignedAgentId,
      status: "succeeded",
      contextSnapshot,
    });
    if (endpoint.provider === "github") {
      // Generic transport fixtures supply a confirmed task-tool receipt.
      // Real tool execution and provider I/O have separate integration tests.
      await db.insert(chatActions).values({ companyId: endpoint.companyId, endpointId, conversationId: conversation.id,
        kind: "github_review_publication", providerActionId: `github_publication:setup:${runId}`,
        payload: { operation: "comment", session: { companyId: endpoint.companyId, agentId: endpoint.assignedAgentId, issueId: conversation.issueId, runId } },
        status: "processed", result: { id: "setup-tool-reply", url: "https://github.com/test/setup-tool-reply" } });
    } else {
      await addSelectedChatFinal({
        agentId: endpoint.assignedAgentId,
        body: "Setup round trip complete",
        companyId: endpoint.companyId,
        issueId: conversation.issueId,
        runId,
      });
    }
    await service.processPendingPublications();
    const providerRuntime = fakeRuntime.endpoints.get(endpointId);
    if (providerRuntime) providerRuntime.posts.length = 0;
    return setupFollowUpMessageId;
  }

  export async function configuredSlackEndpoint(
    fixture: Awaited<ReturnType<typeof seedCompany>>,
    overrides: { allowUnlinkedPeople?: boolean; linkedBoardUser?: boolean; requireAtMention?: boolean } & Partial<
      Pick<
        ChatChannelServiceOptions,
        | "credentialMutationLeaseRenewalIntervalMs"
        | "conversationLeaseRenewalIntervalMs"
        | "deferWebhookProcessing"
        | "fetch"
        | "questionFormOpenAuthorizationBarrier"
        | "questionResolutionPersistBarrier"
        | "reactionLinkPreflightBarrier"
        | "reactionReplayConversationLockBarrier"
        | "reactionReplayEndpointLockBarrier"
        | "receiptReactionTransportBarrier"
        | "reachAuthorizationBarrier"
        | "resolveNativeQuestion"
        | "renewCredentialMutationLease"
        | "renewConversationDeliveryLease"
        | "scheduleDeferredWork"
        | "slackTaskAdmissionClaimBarrier"
        | "storage"
      >
    > & {
        cancelRun?: NonNullable<
          ChatChannelServiceOptions["heartbeat"]["cancelRun"]
        >;
        wakeup?: ChatChannelServiceOptions["heartbeat"]["wakeup"];
      } = {},
  ) {
    const context = createService(
      new FakeChatSdkRuntime(),
      overrides.fetch ?? (fakeSlackFetch() as typeof globalThis.fetch),
      overrides,
    );
    const endpoint = await context.service.create(
      fixture.companyId,
      {
        provider: "slack",
        assignedAgentId: fixture.assignedAgentId,
        name: "Maya in Slack",
      },
      "owner-user",
    );
    // Most transport fixtures exercise restricted guests explicitly. Production
    // Slack creation defaults to linked accounts only (covered separately).
    await context.service.update(endpoint.id, {
      allowUnlinkedPeople: overrides.allowUnlinkedPeople ?? true,
      // Existing transport tests explicitly exercise the optional unmentioned mode.
      requireAtMention: overrides.requireAtMention ?? false,
    }, "owner-user");
    await context.service.configure(
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
    if (overrides.linkedBoardUser) {
      const [principal] = await db.insert(chatExternalPrincipals).values({ companyId: fixture.companyId, provider: "slack", providerAccountId: "T-PAPERCLIP", externalId: "UBOARD" }).returning();
      await db.insert(chatIdentityLinks).values({ companyId: fixture.companyId, endpointId: endpoint.id, principalId: principal.id, paperclipUserId: "owner-user", status: "linked", confirmedAt: new Date() });
    }
    await recordSlackUrlVerification(context.service, endpoint.publicId);
    await context.service.configure(
      endpoint.id,
      { action: "verify" },
      "owner-user",
    );
    const callbacks = context.runtime.configurations.get(
      endpoint.id,
    )?.callbacks;
    if (!callbacks)
      throw new Error("Fake runtime did not receive endpoint callbacks");
    return { ...context, endpoint, callbacks };
  }

  export async function acceptedUnknownSlackFileReceipt(label: string) {
    const fixture = await seedCompany();
    const storage = createStorageService();
    const configured = await configuredSlackEndpoint(fixture, {
      storage: storage.storage,
    });
    const { callbacks, endpoint, runtime, service } = configured;
    const channel = makeThread({
      channelId: `C-RECEIPT-${label.toUpperCase()}`,
      id: `slack:C-RECEIPT-${label.toUpperCase()}:${Date.now()}.1`,
      name: `receipt-${label}`,
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: channel.thread,
      message: makeMessage({
        id: `${Date.now()}.1`,
        text: "@maya start a receipt authorization test",
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
      "Accepted Slack authorization fixture",
      { userId: "owner-user" },
    );
    const stored = await storage.storage.putFile({
      companyId: fixture.companyId,
      namespace: `issues/${conversation.issueId}`,
      originalFilename: `${label}.txt`,
      contentType: "text/plain",
      body: Buffer.from(`accepted ${label}`, "utf8"),
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
        idempotencyKey: `slack-file-receipt-${label}:${randomUUID()}`,
        payload: { text: "", attachmentIds: [attachment.id] },
        state: "pending",
      })
      .returning();
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected Slack provider runtime");
    providerRuntime.slackFilePostAcceptanceError = new Error(
      "connection closed after Slack accepted the upload",
    );
    await service.processPendingPublications();
    providerRuntime.slackFilePostAcceptanceError = null;
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
    if (!publication || !receipt) {
      throw new Error("Expected accepted Slack receipt fixture");
    }
    return {
      ...configured,
      channel,
      conversation,
      fixture,
      providerRuntime,
      publication,
      receipt,
    };
  }

  export async function configuredTeamsEndpoint(
    fixture: Awaited<ReturnType<typeof seedCompany>>,
    overrides: Partial<
      Pick<
        ChatChannelServiceOptions,
        | "deferWebhookProcessing"
        | "githubWebhookAuthenticationBarrier"
        | "githubWebhookResponseBudgetMs"
        | "scheduleDeferredWork"
        | "storage"
        | "reachAuthorizationBarrier"
      >
    > = {},
  ) {
    const context = createService(
      new FakeChatSdkRuntime(),
      (async () =>
        new Response(JSON.stringify({ access_token: "teams-test-access" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof globalThis.fetch,
      overrides,
    );
    const endpoint = await context.service.create(
      fixture.companyId,
      {
        provider: "microsoft-teams",
        assignedAgentId: fixture.assignedAgentId,
        name: "Maya in Teams",
      },
      "owner-user",
    );
    await context.service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          clientId: randomUUID(),
          tenantId: randomUUID(),
          clientSecret: "teams-test-secret",
        },
      },
      "owner-user",
    );
    const callbacks = context.runtime.configurations.get(
      endpoint.id,
    )?.callbacks;
    if (!callbacks)
      throw new Error("Fake runtime did not receive Teams callbacks");
    return { ...context, endpoint, callbacks };
  }


  export async function configuredTelegramEndpoint(
    fixture: Awaited<ReturnType<typeof seedCompany>>,
    overrides: Parameters<typeof createService>[2] = {},
  ) {
    const context = createService(
      new FakeChatSdkRuntime(),
      fakeTelegramFetch() as typeof globalThis.fetch,
      overrides,
    );
    const endpoint = await context.service.create(
      fixture.companyId,
      {
        provider: "telegram",
        assignedAgentId: fixture.assignedAgentId,
        name: "Maya in Telegram",
      },
      "owner-user",
    );
    await context.service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: { botToken: "123456:telegram-interaction-test" },
      },
      "owner-user",
    );
    const callbacks = context.runtime.configurations.get(
      endpoint.id,
    )?.callbacks;
    if (!callbacks)
      throw new Error("Fake runtime did not receive Telegram callbacks");
    return { ...context, endpoint, callbacks };
  }

  export async function configuredDiscordEndpoint(
    fixture: Awaited<ReturnType<typeof seedCompany>>,
    overrides: Parameters<typeof createService>[2] = {},
  ) {
    const applicationId = uniqueDiscordApplicationId();
    const context = createService(
      new FakeChatSdkRuntime(),
      fakeDiscordFetch(applicationId) as typeof globalThis.fetch,
      overrides,
    );
    const endpoint = await context.service.create(
      fixture.companyId,
      {
        provider: "discord",
        assignedAgentId: fixture.assignedAgentId,
        name: "Maya in Discord",
      },
      "owner-user",
    );
    await context.service.configure(
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
    const callbacks = context.runtime.configurations.get(
      endpoint.id,
    )?.callbacks;
    if (!callbacks)
      throw new Error("Fake runtime did not receive Discord callbacks");
    return { ...context, endpoint, callbacks };
  }

  export async function recoverDiscordCommands(service: ChatChannelService) {
    const onError = vi.fn();
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError });
    try {
      await service.registerCommandWork(coordinator, () => true).ready;
      expect(onError).not.toHaveBeenCalled();
    } finally {
      await coordinator.stop();
    }
  }

  export async function deliverMessage(input: {
    callbacks: CreateChatSdkEndpointRuntimeOptions["callbacks"];
    endpointId: string;
    message: Message;
    provider?: ChatProvider;
    providerUpdateId?: number;
    thread: Thread;
    trigger: ChatSdkMessageTrigger;
  }) {
    await input.callbacks.onMessage({
      endpointId: input.endpointId,
      provider: chatSdkProvider(input.provider ?? "slack"),
      providerUpdateId: input.providerUpdateId,
      thread: input.thread,
      message: input.message,
      trigger: input.trigger,
    });
  }

  export async function deliverLegacyGitHubReceipt(
    input: Parameters<typeof deliverMessage>[0], service: ChatChannelService,
  ) {
    await deliverMessage(input);
    const [delivery] = await db.select().from(chatDeliveries).where(and(
      eq(chatDeliveries.endpointId, input.endpointId),
      eq(chatDeliveries.providerEventId, `${input.thread.id}:${input.message.id}`),
    ));
    if (!delivery) throw new Error("Expected admitted legacy GitHub delivery");
    const fence = delivery.normalizedEvent.runtimeContext as { generation: number; credentialFingerprint: string };
    const [action] = await db.insert(chatActions).values({ companyId: delivery.companyId,
      endpointId: input.endpointId, deliveryId: delivery.id, kind: "receipt_reaction",
      providerActionId: `receipt_reaction:${delivery.id}`, status: "received",
      payload: { version: 1, operation: "add", threadId: input.thread.id, messageId: input.message.id,
        reaction: "eyes", runtimeGeneration: fence.generation, credentialFingerprint: fence.credentialFingerprint },
    }).returning();
    await service.processPendingReceiptReactions(1, action.id);
  }

  export function attachFakeGitHubIssueCommentWebhook(input: {
    botUsername: string;
    callbacks: CreateChatSdkEndpointRuntimeOptions["callbacks"];
    endpointId: string;
    runtime: FakeEndpointRuntime;
  }) {
    input.runtime.webhookHook = async (request) => {
      const payload = (await request.clone().json()) as {
        action?: unknown;
        comment?: {
          body?: unknown;
          created_at?: unknown;
          id?: unknown;
          updated_at?: unknown;
          user?: { id?: unknown; login?: unknown };
        };
        issue?: { number?: unknown; pull_request?: unknown };
        repository?: {
          full_name?: unknown;
          name?: unknown;
          owner?: { login?: unknown };
        };
        sender?: { id?: unknown; login?: unknown };
      };
      if (payload.action !== "created") return;
      const fullName =
        typeof payload.repository?.full_name === "string"
          ? payload.repository.full_name
          : typeof payload.repository?.owner?.login === "string" &&
              typeof payload.repository.name === "string"
            ? `${payload.repository.owner.login}/${payload.repository.name}`
            : null;
      const issueNumber = payload.issue?.number;
      const messageId = payload.comment?.id;
      const text = payload.comment?.body;
      if (
        !fullName ||
        typeof issueNumber !== "number" ||
        (typeof messageId !== "number" && typeof messageId !== "string") ||
        typeof text !== "string"
      ) {
        return;
      }
      const mentionNames = new Set([
        input.botUsername,
        input.botUsername.replace(/\[bot\]$/i, ""),
      ]);
      const mentioned = [...mentionNames].some((identity) =>
        new RegExp(
          `(?<!\\w)@${identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`,
          "i",
        ).test(text),
      );
      const thread = makeThread({
        channelId: fullName,
        id: payload.issue?.pull_request
          ? `github:${fullName}:${issueNumber}`
          : `github:${fullName}:issue:${issueNumber}`,
        name: fullName,
      }).thread;
      const message = makeMessage({
        id: String(messageId),
        raw: payload,
        text,
        mentioned,
        userId: String(payload.sender?.id ?? payload.comment?.user?.id ?? "42"),
        userName: String(
          payload.sender?.login ?? payload.comment?.user?.login ?? "octocat",
        ),
      });
      const createdAt = payload.comment?.created_at;
      if (typeof createdAt === "string")
        message.metadata.dateSent = new Date(createdAt);
      await deliverMessage({
        callbacks: input.callbacks,
        endpointId: input.endpointId,
        message,
        provider: "github",
        thread,
        trigger: mentioned ? "mention" : "unaddressed_message",
      });
    };
  }


  export async function waitForProcessedReceiptRemoval(
    endpointId: string,
    receipt: { threadId: string; messageId: string; emoji: string },
  ) {
    // Publication settlement only schedules this non-critical provider I/O.
    // A sweep skips an action already owned by a fresh processing worker.
    const removals = await db
      .select({
        id: chatActions.id,
        deliveryId: chatActions.deliveryId,
        providerActionId: chatActions.providerActionId,
      })
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpointId),
          eq(chatActions.kind, "receipt_reaction"),
          sql`${chatActions.payload}->>'operation' = 'remove'`,
          sql`${chatActions.payload}->>'threadId' = ${receipt.threadId}`,
          sql`${chatActions.payload}->>'messageId' = ${receipt.messageId}`,
          sql`${chatActions.payload}->>'reaction' = ${receipt.emoji}`,
        ),
      );
    expect(removals).toHaveLength(1);
    const removal = removals[0]!;
    expect(removal.deliveryId).toEqual(expect.any(String));
    expect(removal.providerActionId).toBe(
      `receipt_reaction_remove:${removal.deliveryId}`,
    );
    await vi.waitFor(async () => {
      await expect(
        db
          .select({ status: chatActions.status })
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, endpointId),
              eq(chatActions.id, removal.id),
            ),
          ),
      ).resolves.toEqual([{ status: "processed" }]);
    });
    return removal.id;
  }



  export async function registeredIdleProbeState() {
    let state: string | undefined;
    await readIdleLocalWork({ diagnostic: (reason, value) => { if (reason === "local.registered_probes") state = value; } });
    return state;
  }

  export async function linkLifecycleFixtureActor(input: {
    companyId: string;
    endpointId: string;
    externalId: string;
  }) {
    const [principal] = await db
      .select()
      .from(chatExternalPrincipals)
      .where(
        and(
          eq(chatExternalPrincipals.companyId, input.companyId),
          eq(chatExternalPrincipals.externalId, input.externalId),
        ),
      );
    if (!principal) throw new Error("Expected original lifecycle principal");
    await db.insert(chatIdentityLinks).values({
      companyId: input.companyId,
      endpointId: input.endpointId,
      principalId: principal.id,
      paperclipUserId: "owner-user",
      status: "linked",
      confirmedAt: new Date(),
    });
    await db
      .update(chatEndpoints)
      .set({ allowUnlinkedPeople: false })
      .where(
        and(
          eq(chatEndpoints.companyId, input.companyId),
          eq(chatEndpoints.id, input.endpointId),
        ),
      );
    return principal.id;
  }

  export type SharedEndpointProgress = {
    fixture: Awaited<ReturnType<typeof seedCompany>>;
    configured: Awaited<ReturnType<typeof configuredTelegramEndpoint>> | Awaited<ReturnType<typeof configuredSlackEndpoint>>;
    suffix: string;
  };


  export async function currentGitHubTaskRetryFixture(withPending = false, pendingCount = 1) {
    const f = await failedChatRetryFixture("github", "42", true);
    const companyId = f.fixture.companyId, issueId = f.issue.id;
    await githubResponseCommentService(db, f.providerFetch).tryAcknowledge(f.action.deliveryId!);
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issueId,
      nativePhase: "terminal_failure", runnerProfileJson: {} }).where(eq(heartbeatRuns.id, f.runId));
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId: f.runId, phase: "terminal_failure" });
    await db.insert(heartbeatRunEvents).values({ companyId, agentId: f.fixture.assignedAgentId, runId: f.runId,
      seq: 1, eventType: "native.local_process_stopped", payload: { processPid: 999999999, processGroupId: null } });
    let pending: typeof chatActions.$inferSelect | undefined;
    if (withPending) {
      for (let index = 0; index < pendingCount; index++) {
        await deliverMessage({ callbacks: f.runtime.configurations.get(f.endpoint.id)!.callbacks,
          endpointId: f.endpoint.id, provider: "github", thread: f.thread.thread,
          message: makeMessage({ id: String(990092 + index), text: `@maya continue saved follow-up ${index}`, userId: "42", mentioned: true }),
          trigger: "mention" });
        const [{ source }] = await db.select({ source: chatActions }).from(chatActions)
          .innerJoin(chatDeliveries, eq(chatDeliveries.id, chatActions.deliveryId)).where(and(
            eq(chatActions.conversationId, f.conversation.id), eq(chatActions.kind, "inbound_wakeup"),
            eq(chatDeliveries.providerEventId, `${f.thread.thread.id}:${990092 + index}`)));
        pending ??= source;
        await db.update(agentWakeupRequests).set({ status: "deferred_issue_execution", runId: null })
          .where(eq(agentWakeupRequests.id, source.id));
        await githubResponseCommentService(db, f.providerFetch).tryAcknowledge(source.deliveryId!);
      }
    }
    const [originalDelivery] = await db.select().from(chatDeliveries).where(eq(chatDeliveries.id, f.action.deliveryId!));

    await db.update(agents).set({ adapterType: "paperclip_runner", status: "running",
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } })
      .where(eq(agents.id, f.fixture.assignedAgentId));
    await db.insert(heartbeatRuns).values({ companyId, agentId: f.fixture.assignedAgentId,
      status: "running", startedAt: new Date() });
    f.wakeup.mockImplementation(heartbeatService(db).wakeup);
    return { ...f, pending, originalDelivery };
  }

  export async function busyChatRetryHttpFixture(withPending = false) {
    const f = await currentGitHubTaskRetryFixture(withPending);
    const originalPublications = await readChatPublicationsByEndpointId(f.endpoint.id);
    const { issueRoutes } = await import("../../routes/issues.js");
    const companyId = f.fixture.companyId, issueId = f.issue.id;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = boardActor(companyId); next(); });
    app.use("/api", issueRoutes(db, createStorageService().storage, { chatRunRetries: f.service }));
    app.use(errorHandler);
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    let acquired = () => {};
    const locked = new Promise<void>(resolve => { acquired = resolve; });
    const holding = db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`chat-identity:${companyId}:${f.action.principalId}`}, 0))`);
      acquired();
      await held;
    });
    await locked;
    f.wakeup.mockClear();
    return { ...f, app, companyId, issueId, originalPublications,
      releaseIdentity: async () => { release(); await holding; } };
  }

  export async function successfulGitHubQueuedInputFixture() {
    const f = await currentGitHubTaskRetryFixture(true);
    const companyId = f.fixture.companyId, issueId = f.issue.id;
    const [saved] = await readAgentWakeupRequestsById(f.pending!.id);
    await db.update(agentWakeupRequests).set({ payload: withQueuedCommentIdsInWakePayload(saved.payload,
      [String(f.pending!.payload.commentId)]) }).where(eq(agentWakeupRequests.id, saved.id));
    const contractId = randomUUID(), resultId = randomUUID();
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: {},
      canonicalSha256: contractId, createdByActorType: "system", createdByActorId: "test" });
    await db.update(heartbeatRuns).set({ status: "succeeded", errorCode: null, nativePhase: "committed",
      completionContractId: contractId }).where(eq(heartbeatRuns.id, f.runId));
    const [result] = await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId, runId: f.runId,
      completionContractId: contractId, serverFingerprint: resultId, schemaStatus: "accepted", canonicalSha256: resultId,
      resultJson: { terminal: { runTerminalState: "succeeded" }, summary: "Earlier review remains saved" } }).returning();
    await db.update(nativeRunFinalizations).set({ phase: "committed", resultId }).where(eq(nativeRunFinalizations.runId, f.runId));
    await db.update(agentWakeupRequests).set({ status: "completed" }).where(eq(agentWakeupRequests.id, f.receipt.id));
    const input = { db, companyId, issueId, actorId: "owner-user", actorSource: "cloud_tenant",
      observedRunId: f.runId, idempotencyKey: randomUUID(), prepareChatRetry: f.service.prepareFailedChatRunRetry };
    return { ...f, input, result };
  }

  export async function deferredFailedRetryNoticeFixture(wakeOnDemand = true) {
    const context = await failedChatRetryFixture("telegram", undefined, true);
    const companyId = context.fixture.companyId, issueId = context.issue.id, leaseId = randomUUID();
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issueId,
      nativePhase: "terminal_failure", runnerProfileJson: {},
      resultJson: { workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: {
        schema: "paperclip.workspace-restore-recovery.v1", runId: context.runId, leaseIds: [leaseId],
      } },
    }).where(eq(heartbeatRuns.id, context.runId));
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId: context.runId, phase: "terminal_failure" });
    await db.insert(environmentLeases).values({ id: leaseId, companyId, issueId,
      heartbeatRunId: context.runId, provider: "daytona", providerLeaseId: randomUUID(),
      status: "pending_cleanup", cleanupStatus: "failed", leasePolicy: "retain_on_failure",
      metadata: { remoteCwd: "/home/daytona/paperclip-workspace", pendingCleanupInFlight: false },
    });
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", status: "resolved", ownerType: "system",
      cause: "native_continuation_requires_reconciliation", fingerprint: randomUUID(),
      nextAction: "Verify and preserve the retained source before continuing.",
      evidence: { runId: context.runId, automaticRecovery: { replay: "blocked" },
        workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [leaseId] },
        historicalWorkspaceSource: { schema: "paperclip.historical-workspace-source.v1", runId: context.runId, leaseIds: [leaseId] },
        systemRecovery: { ...createSystemRecovery(context.runId), state: "exhausted", attempts: 2, retriesUsed: 1,
          attemptId: randomUUID(), firstFailureAt: Date.now() - 1000, deadlineAt: Date.now() + 60_000,
          preservationOperationIds: [randomUUID()] },
      },
    });
    const retry = await requestTaskRetry({ db, companyId, issueId, actorId: "owner-user",
      actorSource: "cloud_tenant", observedRunId: context.runId, idempotencyKey: randomUUID(),
      prepareChatRetry: context.service.prepareFailedChatRunRetry });
    await db.update(agents).set({ adapterType: "paperclip_runner", status: "running",
      runtimeConfig: { heartbeat: { wakeOnDemand, maxConcurrentRuns: 1 } },
    }).where(eq(agents.id, context.fixture.assignedAgentId));
    await db.insert(heartbeatRuns).values({ companyId, agentId: context.fixture.assignedAgentId,
      status: "running", startedAt: new Date() });
    context.wakeup.mockImplementation(heartbeatService(db).wakeup);
    return { ...context, retry, admit: () => context.service.processFailedChatRunRetry(retry.chatActionId!) };
  }

  export async function failedReviewedGitHubRetryFixture() {
    const context = await failedChatRetryFixture("github");
    await db
      .update(issues)
      .set({ status: "in_review" })
      .where(eq(issues.id, context.issue.id));
    await db
      .update(heartbeatRuns)
      .set({
        errorCode: "setup_failed",
        error: "reviewed_chat_execution_binding_not_authorized",
        startedAt: new Date(Date.now() - 10),
        finishedAt: new Date(),
        // Admission captures the prior display/session identity before any
        // execution starts. It is not evidence of a turn for this new run.
        sessionIdBefore: "prior-provider-session",
      })
      .where(eq(heartbeatRuns.id, context.runId));
    await db.insert(heartbeatRunEvents).values({
      companyId: context.fixture.companyId,
      agentId: context.fixture.assignedAgentId,
      runId: context.runId,
      seq: 1,
      eventType: "error",
      stream: "system",
      level: "error",
      message: "reviewed_chat_execution_binding_not_authorized",
    });
    return context;
  }


  export async function committedChatResponseRecoveryFixture(
    provider: "slack" | "telegram" | "github",
    format: "coordinator" | "port" = "coordinator",
    githubUnavailableFile = false,
    beforeAcceptance?: (
      context: Awaited<ReturnType<typeof failedChatRetryFixture>>,
    ) => Promise<void>,
    summary?: (issueId: string) => string,
    finalize = true,
    shared?: SharedEndpointProgress,
  ) {
    const context = await failedChatRetryFixture(
      provider,
      provider === "github" ? "42" : undefined,
      false,
      githubUnavailableFile,
      false,
      shared,
    );
    if (provider === "github") {
      const config = await githubChatManagementService(db).configuration(context.endpoint.id, "owner-user");
      await db.insert(chatGitHubConfigurations).values({ companyId: context.fixture.companyId, endpointId: context.endpoint.id, configuration: config.configuration, updatedByUserId: "owner-user" });
    }
    await beforeAcceptance?.(context);
    const contractId = randomUUID();
    const sessionId = randomUUID();
    const runnerId = randomUUID();
    const contractSha256 = `recovered-response-${randomUUID()}`;
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
        revision: "recovered-response-v1",
        objective: "Answer the exact message",
        criteria: [
          { id: "response", requirement: "Return the requested answer" },
        ],
      },
      canonicalSha256: contractSha256,
      createdByActorType: "system",
      createdByActorId: "test",
    });
    await db
      .update(heartbeatRuns)
      .set({
        runtimeMode: "native",
        nativeIssueId: context.issue.id,
        nativeSessionId: sessionId,
        runnerInstanceId: runnerId,
        completionContractId: contractId,
        completionContractSha256: contractSha256,
        status: "failed",
        errorCode: "adapter_failed",
        error: "provider_transport_failed: checkpoint is quarantined",
        finishedAt: new Date(),
        processPid: 987654,
        runnerProfileJson: {
          sessionCheckpoint: { retainedEvidence: "do not alter" },
        },
      })
      .where(eq(heartbeatRuns.id, context.runId));
    await db
      .update(issues)
      .set({ status: "in_review", executionRunId: null })
      .where(eq(issues.id, context.issue.id));
    const result: PrpStructuredRunResult = {
      schema: "paperclip.run_result.v1",
      reportedWorkDisposition: "yielded",
      summary:
        summary?.(context.issue.id) ??
        "This is the exact accepted answer. I will wait for your next message.",
      completionClaim: {
        contractRevision: "recovered-response-v1",
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
        idempotencyKey: `wait:${context.runId}`,
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
    const binding = {
      companyId: context.fixture.companyId,
      issueId: context.issue.id,
      runId: context.runId,
      agentId: context.fixture.assignedAgentId,
      normalizedSessionId: sessionId,
      runnerSourceInstanceId: runnerId,
      completionContractId: contractId,
      completionContractSha256: contractSha256,
      completionContractRevision: "recovered-response-v1",
      completionContractCriterionIds: ["response"],
    };
    if (format === "coordinator") {
      await new NativeRunCoordinatorStore(db, binding).completeRun({
        result,
        terminal,
        turnId: `turn-${context.runId}`,
      });
    } else {
      const controlPlaneSourceInstanceId = `control-${context.runId}`;
      const port = new PaperclipControlPlanePort(db, {
        companyId: binding.companyId,
        issueId: binding.issueId,
        runId: binding.runId,
        agentId: binding.agentId,
        sessionId,
        completionContractId: contractId,
        completionContractSha256: contractSha256,
        sourceInstanceId: runnerId,
        controlPlaneSourceInstanceId,
      });
      await port.openRun({
        identity: {
          companyId: binding.companyId,
          issueId: binding.issueId,
          runId: binding.runId,
          agentId: binding.agentId,
          sessionId,
        },
        backendKind: "mock",
        sourceInstanceId: runnerId,
      });
      await port.completeRun({
        result,
        terminal,
        turnId: `turn-${context.runId}`,
      });
      await db.insert(heartbeatRunEvents).values({
        companyId: binding.companyId,
        agentId: binding.agentId,
        runId: binding.runId,
        seq: 1,
        eventType: "run.result.accepted",
        sourceInstanceId: controlPlaneSourceInstanceId,
        payload: { prpEvent: { sourceKind: "control_plane" } },
      });
    }
    const [acceptedRow] = await db
      .select()
      .from(nativeRunResults)
      .where(eq(nativeRunResults.runId, context.runId));
    const accepted = { resultId: acceptedRow.id };
    if (finalize) await finalizeNativeRun({
      db,
      runId: context.runId,
      workspaceFinalizeStatus: "succeeded",
    });
    const [coordinator] = await db
      .select()
      .from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, context.runId));
    if (finalize) expect(coordinator.phase).toBe("committed");
    else expect(coordinator.phase).not.toBe("committed");
    await db
      .update(heartbeatRuns)
      .set({
        resultJson: {
          finalResponse: "PRIVATE provider narration must not be recovered",
          privateTrace: "PRIVATE tool arguments",
        },
      })
      .where(eq(heartbeatRuns.id, context.runId));
    const [beforeIssue] = await readIssuesById(context.issue.id);
    const repair = () =>
      repairCommittedNativeChatResponse(db, {
        companyId: context.fixture.companyId,
        issueId: context.issue.id,
        runId: context.runId,
      });
    return {
      ...context,
      accepted,
      result,
      terminal,
      binding,
      coordinator,
      beforeIssue,
      repair,
    };
  }

  export async function githubOmissionFixture(
    unavailable = true,
    beforeAcceptance?: Parameters<
      typeof committedChatResponseRecoveryFixture
    >[3],
    summary?: Parameters<typeof committedChatResponseRecoveryFixture>[4],
  ) {
    const egress = vi
      .spyOn(attachmentEgress, "guardedRemoteHttpFetch")
      .mockResolvedValue(
        new Response("private file unavailable", { status: 404 }),
      );
    try {
      const context = await committedChatResponseRecoveryFixture(
        "github",
        "coordinator",
        unavailable,
        beforeAcceptance,
        summary,
      );
      return {
        ...context,
        egress,
        cleanup: async () => {
          try {
            await context.service.shutdown();
          } finally {
            egress.mockRestore();
          }
        },
      };
    } catch (error) {
      egress.mockRestore();
      throw error;
    }
  }

  export async function linkedCommittedResponseFailure(
    context: Awaited<ReturnType<typeof committedChatResponseRecoveryFixture>>,
    runId: string = context.runId,
    messageId = "same-run-message",
  ) {
    const [failure] = await db
      .insert(chatPublications)
      .values({
        companyId: context.fixture.companyId,
        endpointId: context.endpoint.id,
        conversationId: context.conversation.id,
        issueId: context.issue.id,
        idempotencyKey: `run:${runId}:failed:${context.endpoint.id}`,
        payload: {
          text: "Maya stopped before completing this turn.",
          progressState: "failed",
        },
        state: "published",
        providerMessageId: messageId,
        publishedAt: new Date(),
        attempts: 1,
      })
      .returning();
    await db.insert(chatMessageLinks).values({
      companyId: context.fixture.companyId,
      endpointId: context.endpoint.id,
      conversationId: context.conversation.id,
      publicationId: failure.id,
      providerMessageId: messageId,
      direction: "outbound",
    });
    return failure;
  }



export async function configuredGitHubEndpoint(
  fixture: Awaited<ReturnType<typeof seedCompany>>,
  overrides: Partial<
    Pick<
      ChatChannelServiceOptions,
      | "deferWebhookProcessing"
      | "githubWebhookAuthenticationBarrier"
      | "githubWebhookReplayBarrier"
      | "githubWebhookResponseBudgetMs"
      | "publicBaseUrl"
      | "webhookPublicBaseUrl"
      | "scheduleDeferredWork"
      | "setupSecretActivityLogger"
      | "setupSecretCredentialPersistBarrier"
      | "receiptReactionTransportBarrier"
      | "storage"
    >
  > & { wakeup?: ChatChannelServiceOptions["heartbeat"]["wakeup"] } = {},
  useVerifiedAppId = false,
  registerWithManifest = false,
  connectExistingApp = false,
  interruptAppVault = false,
) {
  let setupComplete = false;
  const deferredSchedule = overrides.scheduleDeferredWork;
  let installationId = 2468;
  let additionalInstallationIds: number[] = [];
  let installationAvailable = true;
  let repositories = [
    {
      id: 97531,
      full_name: "paperclipai/paperclip",
      html_url: "https://github.com/paperclipai/paperclip",
      owner: { id: 1357, login: "paperclipai" },
      private: false,
    },
  ];
  let appPermissions: Record<string, string> = {
    contents: "read",
    checks: "write",
    issues: "write",
    metadata: "read",
    pull_requests: "write",
  };
  let installationPermissions: Record<string, string> = {
    contents: "read",
    checks: "write",
    issues: "write",
    metadata: "read",
    pull_requests: "write",
  };
  let appEvents = [
    "pull_request",
    "github_app_authorization",
    "installation",
    "installation_repositories",
    "issue_comment",
    "pull_request_review_comment",
  ];
  const webhookSyncRequests: Array<Record<string, unknown>> = [];
  let webhookSyncResponse: (() => Promise<Response>) | null = null;
  let supplementalProviderFetch:
    | ((
        input: string | URL | Request,
        init?: RequestInit,
      ) => Promise<Response | undefined>)
    | null = null;
  const appRegistrationId = Number.parseInt(
    fixture.companyId.replaceAll("-", "").slice(0, 8),
    16,
  );
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const responseComments = new Map<number, { id: number; body: string; html_url: string; user: { login: string }; thread: string }>();
  const responseWrites: Array<{ method: string; id: number; body: string }> = [];
  let nextResponseId = 800000;
  const providerFetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const supplemental = await supplementalProviderFetch?.(input, init);
    if (supplemental) return supplemental;
    const list = /\/repos\/paperclipai\/paperclip\/(issues|pulls)\/([1-9][0-9]*)\/comments(?:\?.*)?$/.exec(url);
    const reply = /\/repos\/paperclipai\/paperclip\/pulls\/([1-9][0-9]*)\/comments\/[1-9][0-9]*\/replies$/.exec(url);
    const item = /\/repos\/paperclipai\/paperclip\/(issues|pulls)\/comments\/([1-9][0-9]*)$/.exec(url);
    if (item) {
      const comment = responseComments.get(Number(item[2]));
      if (!comment) return Response.json({ message: "Not Found" }, { status: 404 });
      if (init?.method === "PATCH") {
        comment.body = JSON.parse(String(init.body)).body;
        responseWrites.push({ method: "PATCH", id: comment.id, body: comment.body });
      }
      return Response.json(comment);
    }
    if ((list || reply) && init?.method === "POST") {
      const id = ++nextResponseId;
      const thread = list ? `${list[1]}:${list[2]}` : `pulls:${reply![1]}`;
      const body = JSON.parse(String(init.body)).body;
      const comment = { id, body, thread, html_url: `https://github.com/paperclipai/paperclip/issues/${list?.[2] ?? reply![1]}#issuecomment-${id}`,
        user: { login: `maya-${fixture.companyId.slice(0, 8)}[bot]` } };
      responseComments.set(id, comment);
      responseWrites.push({ method: "POST", id, body });
      return Response.json(comment, { status: 201 });
    }
    if (list && (!init?.method || init.method === "GET")) return Response.json([...responseComments.values()].filter(row => row.thread === `${list[1]}:${list[2]}`));
    if (url === "https://api.github.com/app/hook/config") {
      expect(init?.method).toBe("PATCH");
      const config = JSON.parse(String(init?.body)) as Record<
        string,
        unknown
      >;
      webhookSyncRequests.push(config);
      if (webhookSyncResponse) return webhookSyncResponse();
      return new Response(
        JSON.stringify({
          url: config.url,
          content_type: config.content_type,
          insecure_ssl: config.insecure_ssl,
        }),
        { status: 200 },
      );
    }
    if (url === "https://api.github.com/app") {
      return new Response(
        JSON.stringify({
          id: appRegistrationId,
          slug: `maya-${fixture.companyId.slice(0, 8)}`,
          name: "Maya Paperclip",
          owner: { login: "paperclipai" },
          permissions: appPermissions,
          events: appEvents,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url === `https://api.github.com/app/installations/${installationId}`)
      return Response.json({ permissions: installationPermissions, suspended_at: null });
    if (url === "https://api.github.com/app/installations?per_page=100") {
      return new Response(
        JSON.stringify(
          installationAvailable
            ? [
                {
                  id: installationId,
                  account: {
                    id: 1357,
                    login: "paperclipai",
                    type: "Organization",
                  },
                  permissions: installationPermissions,
                  suspended_at: null,
                },
                ...additionalInstallationIds.map((id) => ({
                  id,
                  account: {
                    id: id + 10_000,
                    login: `additional-${id}`,
                    type: "Organization",
                  },
                  permissions: installationPermissions,
                  suspended_at: null,
                })),
              ]
            : [],
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (
      url ===
      `https://api.github.com/app/installations/${installationId}/access_tokens`
    ) {
      return new Response(JSON.stringify({ token: "installation-token" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    if (
      url ===
      "https://api.github.com/installation/repositories?per_page=100&page=1"
    ) {
      return new Response(JSON.stringify({ repositories }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected provider request: ${url}`);
  }) as typeof globalThis.fetch;
  const context = createService(
    new FakeChatSdkRuntime(),
    providerFetch,
    deferredSchedule
      ? {
          ...overrides,
          scheduleDeferredWork: (task) => {
            if (setupComplete) deferredSchedule(task);
            else setImmediate(task);
          },
        }
      : overrides,
  );
  const endpoint = await context.service.create(
    fixture.companyId,
    {
      provider: "github",
      assignedAgentId: fixture.assignedAgentId,
      name: "Maya in GitHub",
    },
    "owner-user",
  );
  const { webhookSecret } = await context.service.generateSetupSecret(
    endpoint.id,
    "owner-user",
  );
  await recordGitHubWebhookVerification(
    context.service,
    endpoint.publicId,
    webhookSecret,
  );
  if (registerWithManifest)
    await context.service.startGitHubRegistration(endpoint.id, "owner-user", "Maya");
  if (connectExistingApp) {
    const credentials = { appId: String(appRegistrationId), privateKey, webhookSecret };
    if (interruptAppVault) {
      // Fail the real vault write after App identity has been durably claimed.
      await db.execute(sql.raw("CREATE FUNCTION github_wizard_fail_vault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Simulated App vault failure'; END $$"));
      await db.execute(sql.raw("CREATE TRIGGER github_wizard_fail_vault BEFORE INSERT ON company_secrets FOR EACH ROW WHEN (lower(NEW.key) LIKE '%privatekey%') EXECUTE FUNCTION github_wizard_fail_vault()"));
      try {
        await expect(context.service.storeGitHubApp(endpoint.id, "owner-user", credentials)).rejects.toThrow();
        expect(await context.service.githubWizard.advance(endpoint.id, "owner-user")).toMatchObject({ state: "recovery" });
        expect((await context.service.get(endpoint.id)).setup.github).toMatchObject({ initialSetupPending: true, initialRepositoryImportPending: true });
        expect((await context.service.get(endpoint.id)).setup.github?.initialRepositoriesImported).not.toBe(true);
        expect(await context.service.listResources(endpoint.id)).toHaveLength(0);
        expect((await githubChatManagementService(db, providerFetch).configuration(endpoint.id, "owner-user")).revision).toBe(0);
      } finally {
        await db.execute(sql.raw("DROP TRIGGER github_wizard_fail_vault ON company_secrets"));
        await db.execute(sql.raw("DROP FUNCTION github_wizard_fail_vault()"));
      }
    }
    await context.service.storeGitHubApp(endpoint.id, "owner-user", credentials);
  }
  await context.service.configure(
    endpoint.id,
    {
      action: "configure",
      credentials: {
        appId: useVerifiedAppId ? String(appRegistrationId) : "123456",
        privateKey,
      },
    },
    "owner-user",
  );
  if (!useVerifiedAppId) {
    const [configured] = await readChatEndpointsById(endpoint.id);
    // Legacy transport fixtures already have explicit tool authority. Do not
    // save a review configuration: that would switch their admission model.
    await db.transaction((tx) => syncGitHubBotTools(tx, configured!, "owner-user", true));
  }
  const resources = await context.service.listResources(endpoint.id);
  if (!registerWithManifest && !connectExistingApp)
    await context.service.replaceResources(endpoint.id, [
      { id: resources[0]!.id, enabled: true },
    ]);
  setupComplete = true;
  const callbacks = context.runtime.configurations.get(
    endpoint.id,
  )?.callbacks;
  if (!callbacks)
    throw new Error("Fake runtime did not receive GitHub callbacks");
  return {
    ...context,
    endpoint,
    callbacks,
    webhookSecret,
    providerFetch,
    responseComments,
    responseWrites,
    webhookSyncRequests,
    privateKey,
    setSupplementalProviderFetch(value: typeof supplementalProviderFetch) {
      supplementalProviderFetch = value;
    },
    setWebhookSyncResponse(value: (() => Promise<Response>) | null) {
      webhookSyncResponse = value;
    },
    setInstallationId(value: number) {
      installationId = value;
    },
    setAdditionalInstallationIds(value: number[]) {
      additionalInstallationIds = value;
    },
    setInstallationAvailable(value: boolean) {
      installationAvailable = value;
    },
    setRepositories(
      value: Array<{
        id: number;
        full_name: string;
        html_url: string;
        owner: { id: number; login: string };
        private: boolean;
      }>,
    ) {
      repositories = value;
    },
    setAppAccess(input: {
      permissions?: Record<string, string>;
      events?: string[];
    }) {
      if (input.permissions) appPermissions = input.permissions;
      if (input.events) appEvents = input.events;
    },
    setInstallationAccess(permissions: Record<string, string>) {
      installationPermissions = permissions;
    },
  };
}

export async function safeNativeProgressFixture(
provider: ChatProvider,
suffix: string,
teamsSurface: "channel" | "personal" = "channel",
externalActorId?: string,
linkedOriginalActor = false,
githubUnavailableFile = false,
upgradedGitHub = true,
currentGitHubPr = false,
shared?: SharedEndpointProgress,
) {
const fixture = shared?.fixture ?? await seedCompany();
const configured = shared?.configured ?? (
provider === "slack"
  ? await configuredSlackEndpoint(fixture)
  : provider === "github"
    ? await configuredGitHubEndpoint(
        fixture,
        githubUnavailableFile
          ? { storage: createStorageService().storage }
          : {},
      )
    : provider === "discord"
      ? await configuredDiscordEndpoint(fixture)
      : provider === "microsoft-teams"
        ? await configuredTeamsEndpoint(fixture)
        : await configuredTelegramEndpoint(fixture));
const { callbacks, endpoint, runtime, service } = configured;
const telegramChatId = `77113${suffix.padStart(3, "0")}`;
const teamsConversationId = `19:safe-progress-${suffix}@thread.${teamsSurface === "channel" ? "tacv2" : "v2"}`;
const teamsServiceUrl = "https://smba.trafficmanager.net/amer/";
const messageId =
provider === "slack"
  ? `1789000${suffix}.100001`
  : provider === "github"
    ? `9900${suffix}`
    : provider === "discord"
      ? `55555555555556${suffix.padStart(3, "0")}`
      : provider === "microsoft-teams"
        ? `17400000${suffix.padStart(5, "0")}`
        : `${telegramChatId}:101`;
const thread =
provider === "slack"
  ? makeThread({
      channelId: `C-SAFE-PROGRESS-${suffix}`,
      id: `slack:C-SAFE-PROGRESS-${suffix}:${messageId}`,
      name: `safe-progress-${suffix}`,
    })
  : provider === "github"
    ? makeThread({
        channelId: currentGitHubPr ? "paperclipai/paperclip" : "github:paperclipai/paperclip",
        id: currentGitHubPr ? `github:paperclipai/paperclip:${700 + Number(suffix)}` : `github:paperclipai/paperclip:issue:${700 + Number(suffix)}`,
        name: "paperclipai/paperclip",
      })
    : provider === "discord"
      ? makeThread({
          channelId: `33333333333334${suffix.padStart(3, "0")}`,
          id: `discord:1457808928258658549:33333333333334${suffix.padStart(3, "0")}:${messageId}`,
          name: `safe-progress-${suffix}`,
        })
      : provider === "microsoft-teams"
        ? makeThread({
            channelId: `teams:${Buffer.from(teamsConversationId).toString("base64url")}:${Buffer.from(teamsServiceUrl).toString("base64url")}`,
            id: `teams:${Buffer.from(`${teamsConversationId}${teamsSurface === "channel" ? `;messageid=${messageId}` : ""}`).toString("base64url")}:${Buffer.from(teamsServiceUrl).toString("base64url")}`,
            isDM: teamsSurface === "personal",
            name: `safe-progress-${suffix}`,
          })
        : makeThread({
            channelId: telegramChatId,
            id: `telegram:${telegramChatId}`,
            isDM: true,
            name: `safe-progress-${suffix}`,
          });
if (provider === "microsoft-teams" && teamsSurface === "channel") {
await db.insert(chatEndpointResources).values({
  companyId: fixture.companyId,
  endpointId: endpoint.id,
  type: "channel",
  providerResourceId: teamsConversationId,
  label: "Native progress channel",
  availability: "available",
  enabled: true,
});
}
if (linkedOriginalActor) {
const currentEndpoint = await service.get(endpoint.id);
const originalActorId =
  externalActorId ??
  (provider === "telegram" ? telegramChatId : "U-SAFE-PROGRESS");
await db.insert(chatExternalPrincipals).values({
  companyId: fixture.companyId,
  provider,
  providerAccountId: currentEndpoint.providerAccountId!,
  externalId: originalActorId,
  kind: "user",
  isBot: false,
});
await linkLifecycleFixtureActor({
  companyId: fixture.companyId,
  endpointId: endpoint.id,
  externalId: originalActorId,
});
}
if (provider === "github" && currentGitHubPr) {
const config = await githubChatManagementService(db).configuration(endpoint.id, "owner-user");
await db.insert(chatGitHubConfigurations).values({ companyId: fixture.companyId, endpointId: endpoint.id,
  configuration: { ...config.configuration, toolsEnabled: true, defaults: { ...config.configuration.defaults,
    invocation: "mentions_only", events: [] } }, updatedByUserId: "owner-user" });
}
const sourceMessage = makeMessage({
id: messageId,
mentioned: !thread.thread.isDM,
text: thread.thread.isDM
  ? "Show safe progress"
  : "@maya show safe progress",
userId:
  externalActorId ??
  (provider === "telegram" ? telegramChatId : "U-SAFE-PROGRESS"),
});
if (currentGitHubPr) sourceMessage.raw = { action: "created", installation: { id: 2468 },
repository: { id: 97531, full_name: "paperclipai/paperclip" }, issue: { number: 791, pull_request: {} },
sender: { id: 42, login: "octocat", type: "User" }, comment: { id: Number(messageId), body: sourceMessage.text, user: { id: 42 } } };
if (githubUnavailableFile) {
const url =
  "https://github.com/user-attachments/files/31967808/private-current.txt";
sourceMessage.text = `@maya inspect only this exact file: [file](${url})`;
Object.assign(sourceMessage, { threadId: thread.thread.id });
sourceMessage.raw = {
  type: "issue_comment",
  threadType: "issue",
  prNumber: 700 + Number(suffix),
  repository: { full_name: "paperclipai/paperclip" },
  comment: {
    id: Number(messageId),
    body: sourceMessage.text,
    user: { id: 42 },
  },
};
sourceMessage.formatted = {
  type: "root",
  children: [{ type: "link", url, children: [] }],
};
sourceMessage.attachments.push(
  ...githubPublicAttachmentsFromMessage(sourceMessage),
);
}
await deliverMessage({
callbacks,
endpointId: endpoint.id,
provider,
thread: thread.thread,
message: sourceMessage,
trigger: thread.thread.isDM ? "direct_message" : "mention",
});
const conversations = await readChatConversationsByEndpointId(endpoint.id);
const conversation = shared ? conversations.find(row => row.externalThreadId === thread.thread.id) : conversations[0];
if (!conversation) throw new Error("Expected safe-progress conversation");
const providerRuntime = runtime.endpoints.get(endpoint.id);
if (!providerRuntime) throw new Error("Expected safe-progress runtime");

if (provider === "github" && upgradedGitHub) {
// These fixtures exercise upgraded bots' tool-owned reply model.
const config = await githubChatManagementService(db).configuration(endpoint.id, "owner-user");
await db.insert(chatGitHubConfigurations).values({ companyId: fixture.companyId, endpointId: endpoint.id, configuration: config.configuration, updatedByUserId: "owner-user" });
}

const createRun = async (label: string) => {
const runId = randomUUID();
const baseCreatedAt = new Date(Date.now() - 60_000);
await db.insert(heartbeatRuns).values({
  id: runId,
  companyId: fixture.companyId,
  agentId: fixture.assignedAgentId,
  runtimeMode: "native",
  status: "running",
  contextSnapshot: await chatWakeContext({
    endpointId: endpoint.id,
    issueId: conversation.issueId,
    provider,
    providerMessageId: messageId,
  }),
});
await db.insert(chatPublications).values({
  companyId: fixture.companyId,
  endpointId: endpoint.id,
  conversationId: conversation.id,
  issueId: conversation.issueId,
  idempotencyKey: `run:${runId}:working:${endpoint.id}`,
  payload: {
    text: `Maya is working on ${label}…`,
    progressState: "working",
  },
  state: "pending",
  createdAt: baseCreatedAt,
  updatedAt: baseCreatedAt,
});
await service.processPendingPublications(100);
return { baseCreatedAt, runId };
};
const addEvent = async (
run: Awaited<ReturnType<typeof createRun>>,
eventType = "item.completed",
seq = 1,
createdAt = new Date(run.baseCreatedAt.getTime() + 30_000 + seq),
) => {
await db.insert(heartbeatRunEvents).values({
  companyId: fixture.companyId,
  runId: run.runId,
  agentId: fixture.assignedAgentId,
  seq,
  eventType,
  message: "PRIVATE native event prose must stay in Paperclip",
  payload: {
    toolName: "secret_internal_tool",
    arguments: { token: "PRIVATE-NATIVE-TOKEN" },
    result: "PRIVATE-NATIVE-RESULT",
    target: "PRIVATE-NATIVE-TARGET",
  },
  createdAt,
});
};
return {
addEvent,
conversation,
createRun,
endpoint,
fixture,
messageId,
providerRuntime,
runtime,
service,
thread,
wakeup: configured.wakeup,
providerFetch:
  "providerFetch" in configured ? (configured.providerFetch as typeof globalThis.fetch) : undefined,
};
}

export async function failedChatRetryFixture(
provider: "slack" | "telegram" | "github",
externalActorId?: string,
linkedOriginalActor = false,
githubUnavailableFile = false,
currentGitHubPr = false,
shared?: SharedEndpointProgress,
) {
// Keep the policy under which the source was admitted. Inserting an
// upgraded GitHub policy after receipt correctly invalidates retry proof.
const context = await safeNativeProgressFixture(
  provider,
  shared?.suffix ?? "91",
  "channel",
  externalActorId,
  linkedOriginalActor,
  githubUnavailableFile,
  false,
  currentGitHubPr,
  shared,
);
const [issue] = await readIssuesById(context.conversation.issueId);
const [action] = await db
  .select()
  .from(chatActions)
  .where(
    and(
      eq(chatActions.conversationId, context.conversation.id),
      eq(chatActions.kind, "inbound_wakeup"),
    ),
  );
const [receipt] = await readAgentWakeupRequestsById(action.id);
const runId = randomUUID();
await db.insert(heartbeatRuns).values({
  id: runId,
  companyId: context.fixture.companyId,
  agentId: context.fixture.assignedAgentId,
  status: "failed",
  errorCode: "adapter_failed",
  finishedAt: new Date(),
  wakeupRequestId: receipt.id,
  contextSnapshot: {
    issueId: issue.id,
    taskKey: issue.identifier,
    source: `chat:${provider}`,
    wakeCommentId: action.payload.commentId,
    wakeCommentIds: [action.payload.commentId],
  },
});
await db
  .update(agentWakeupRequests)
  .set({ status: "failed", runId })
  .where(eq(agentWakeupRequests.id, receipt.id));
await db
  .update(issues)
  .set({
    description: "ORIGINAL task, not the failed request",
    status: "blocked",
    executionRunId: null,
  })
  .where(eq(issues.id, issue.id));
return { ...context, issue, action, receipt, runId };
}
