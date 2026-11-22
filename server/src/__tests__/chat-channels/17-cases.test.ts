import {
  stageReceiptReactionRemovals,
} from "../../services/chat-receipt-reactions.js";
import {
  DELIVERY_QUEUES,
  subscribeDeliveryWork,
} from "../../services/delivery-work-notifications.js";
import {
  githubChatManagementService,
} from "../../services/chat-github-management.js";
import {
  agentWakeupRequests,
  authUsers,
  chatActions,
  chatConversations,
  chatDeliveries,
  chatEndpointLeases,
  chatEndpointResources,
  chatEndpoints,
  chatExternalPrincipals,
  chatGitHubConfigurations,
  chatIdentityLinks,
  chatPublications,
  companyMemberships,
  heartbeatRuns,
  issueComments,
  toolConnections,
} from "@paperclipai/db";
import {
  randomUUID,
} from "node:crypto";
import {
  and,
  asc,
  eq,
  like,
} from "drizzle-orm";
import {
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import {
  type ChatChannelServiceOptions,
} from "../../services/chat-channels.js";
import {
  createChatSdkEndpointRuntime,
} from "../../services/chat-sdk-runtime.js";
import {
  enqueueChatRunMilestones,
} from "../../services/chat-run-publications.js";
import {
  FakeChatSdkRuntime,
  FakeEndpointRuntime,
  TEST_SLACK_BOT_SCOPES,
  fakeSlackFetch,
  makeMessage,
  makeThread,
} from ".././helpers/chat-channels-fixture.js";
import {
  addSelectedChatFinal,
  chatWakeContext,
  configuredSlackEndpoint,
  createService,
  createStorageService,
  db,
  deliverLegacyGitHubReceipt,
  deliverMessage,
  describeChatChannelsSuite,
  qualifySetupRoundTrip,
  readChatActionsById,
  readChatActionsByProviderActionId,
  readChatConversationsByEndpointId,
  readChatDeliveriesByEndpointId,
  readChatEndpointsById,
  readHeartbeatRunsByCompanyId,
  readIssueCommentsByIssueId,
  readIssuesByCompanyId,
  readIssuesById,
  retirePublicationFixture,
  seedCompany,
  signedSlackWebhookRequest,
  configuredGitHubEndpoint,
} from "../helpers/chat-channels-harness.js";
import type { Db } from "@paperclipai/db";
import type { Attachment } from "chat";
import type { ChatSdkEndpointRuntime } from "../../services/chat-sdk-runtime.js";
import type { InternalSetupState } from "../../services/chat-channels/runtime-types.js";

describeChatChannelsSuite("chat channels 17-cases", () => {
  it.each([
    "ordinary",
    "final_before_add",
    "held_token",
    "held_add",
    "newer_followup",
    "restart",
    "rotation",
    "remove_retry",
    "unknown_bot",
    "incomplete_page",
    "connection_revoked",
  ] as const)(
    "GitHub terminal receipt composes pinned HTTP and durable source authority (%s)",
    async (mode) => {
      const fixture = await seedCompany();
    // Assigned once before the async checks below; `let` with definite assignment is the TS idiom here.
    // oxlint-disable-next-line prefer-const
      let earlyFinal: (() => Promise<void>) | undefined;
      const { callbacks, endpoint, runtime, service, wakeup, providerFetch } =
        await configuredGitHubEndpoint(fixture, {
          scheduleDeferredWork: () => undefined,
          ...(mode === "final_before_add"
            ? {
                wakeup: async () => {
                  await earlyFinal!();
                  return { accepted: true };
                },
              }
            : {}),
        });
      // Pin the upgraded reply policy before admission. Changing it after the
      // source arrives would correctly invalidate its saved authorization.
      const currentEndpoint = await service.get(endpoint.id);
      const [principal] = await db.insert(chatExternalPrincipals).values({
        companyId: fixture.companyId,
        provider: "github",
        providerAccountId: currentEndpoint.providerAccountId!,
        externalId: "42",
        kind: "user",
        displayName: "Octocat",
        handle: "octocat",
        isBot: false,
      }).returning();
      await db.insert(chatIdentityLinks).values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        principalId: principal.id,
        paperclipUserId: "owner-user",
        status: "linked",
        confirmedAt: new Date(),
      });
      const config = await githubChatManagementService(db).configuration(endpoint.id, "owner-user");
      await db.insert(chatGitHubConfigurations).values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        configuration: { ...config.configuration, toolsEnabled: true },
        updatedByUserId: "owner-user",
      });
      await db.update(chatEndpoints).set({ allowGroupChats: true }).where(eq(chatEndpoints.id, endpoint.id));
      let activeService = service;
      const pins: ChatSdkEndpointRuntime[] = [];
      const calls: Array<{ method: string; path: string }> = [];
      const remote = new Map<string, number>();
      let failRemoval = mode === "remove_retry";
      let removing = false;
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let heldOnce = false;
      const inFlight: Promise<unknown>[] = [];
      const configuration = runtime.configurations.get(endpoint.id)!;
      if (
        configuration.providerConfig.provider !== "github" ||
        !("appId" in configuration.providerConfig.credentials)
      )
        throw new Error("Expected GitHub App runtime");
      const appId = Number(configuration.providerConfig.credentials.appId);
      const requestFetch: typeof fetch = async (input, init = {}) => {
        const url = new URL(String(input));
        calls.push({ method: init.method ?? "GET", path: url.pathname });
        if (
          !heldOnce &&
          ((mode === "held_token" && url.pathname.includes("/access_tokens")) ||
            (mode === "held_add" &&
              init.method === "POST" &&
              url.pathname.endsWith("/reactions")))
        ) {
          heldOnce = true;
          entered();
          await new Promise<void>((resolve, reject) => {
            const abort = () =>
              reject(new Error("synthetic held receipt deadline"));
            init.signal!.addEventListener("abort", abort, { once: true });
            void held.then(() => {
              init.signal!.removeEventListener("abort", abort);
              resolve();
            });
          });
        }
        if (url.pathname.includes("/access_tokens"))
          return Response.json(
            { token: "synthetic-joined-token" },
            { status: 201 },
          );
        if (url.pathname === "/app")
          return Response.json({ id: appId, slug: "receipt-fixture" });
        if (url.pathname.startsWith("/users/"))
          return Response.json({
            id: removing && mode === "unknown_bot" ? null : 9001,
            login: "receipt-fixture[bot]",
            type: "Bot",
          });
        const match = /\/issues\/comments\/(\d+)\/reactions(?:\/(\d+))?$/.exec(
          url.pathname,
        );
        if (!match) throw new Error("Unexpected synthetic GitHub receipt route");
        if (init.method === "POST") {
          const id = match[1] === "5603841952" ? 700 : 701;
          remote.set(match[1]!, id);
          return Response.json(
            { id, content: "eyes", user: { id: 9001 } },
            { status: 201 },
          );
        }
        if (init.method === "DELETE") {
          if (failRemoval) {
            failRemoval = false;
            return Response.json(
              {},
              { status: 429, headers: { "retry-after": "60" } },
            );
          }
          expect(Number(match[2])).toBe(remote.get(match[1]!));
          remote.delete(match[1]!);
          return new Response(null, { status: 204 });
        }
        if (mode === "connection_revoked")
          await db
            .update(toolConnections)
            .set({ enabled: false })
            .where(eq(toolConnections.id, endpoint.connectionId));
        if (mode === "incomplete_page")
          return Response.json(
            url.searchParams.get("page") === "1"
              ? Array.from({ length: 100 }, (_, index) => ({
                  id: 1000 + index,
                  content: "eyes",
                  user: { id: 10000 + index },
                }))
              : null,
          );
        return Response.json([
          { id: 702, content: "eyes", user: { id: 9002 } },
          ...(remote.has(match[1]!)
            ? [{ id: remote.get(match[1]!), content: "eyes", user: { id: 9001 } }]
            : []),
        ]);
      };
      const attach = (target: FakeEndpointRuntime) => {
        const pinned = createChatSdkEndpointRuntime({
          ...configuration,
          logger: "silent",
        });
        pins.push(pinned);
        Object.assign(target, {
          applyGitHubReceiptReaction: (
            input: Parameters<typeof pinned.applyGitHubReceiptReaction>[0],
            check: () => Promise<void>,
          ) => pinned.applyGitHubReceiptReaction(input, check, requestFetch),
        });
      };
      const originalRuntime = runtime.endpoints.get(endpoint.id)!;
      attach(originalRuntime);
      const thread = makeThread({
        channelId: "github:paperclipai/paperclip",
        id: "github:paperclipai/paperclip:issue:5",
      });
      const runId = randomUUID();
      const publish = async () => {
        const [conversation] = await service.listConversations(endpoint.id);
        await db
          .insert(heartbeatRuns)
          .values({
            id: runId,
            companyId: fixture.companyId,
            agentId: fixture.assignedAgentId,
            status: "succeeded",
            contextSnapshot: await chatWakeContext({
              endpointId: endpoint.id,
              issueId: conversation.issueId,
              provider: "github",
              providerMessageId: "5603841952",
            }),
          });
        await addSelectedChatFinal({
          companyId: fixture.companyId,
          issueId: conversation.issueId,
          agentId: fixture.assignedAgentId,
          runId,
          body: "PINNED-GITHUB-RECEIPT-FINAL",
        });
        await db.update(heartbeatRuns).set({ resultJson: { presentationDecision: { authorizationReason: "internal_agent_write" } } }).where(eq(heartbeatRuns.id, runId));
        // Model a terminal publication persisted before the tool-owned reply
        // upgrade. Its suppression must still remove the old eyes receipt,
        // including when the original add HTTP request has not settled yet.
        await db.insert(chatPublications).values({
          companyId: fixture.companyId,
          endpointId: endpoint.id,
          conversationId: conversation.id,
          issueId: conversation.issueId!,
          idempotencyKey: `run:${runId}:completed:${endpoint.id}`,
          payload: { text: "PINNED-GITHUB-RECEIPT-FINAL", progressState: "completed" },
          state: "pending",
        });
        await enqueueChatRunMilestones(db);
        await service.processPendingPublications();
      };
      earlyFinal = publish;
      try {
        await db
          .update(chatEndpoints)
          .set({ status: "active" })
          .where(eq(chatEndpoints.id, endpoint.id));
        const deliveryWork = deliverLegacyGitHubReceipt({
          callbacks,
          endpointId: endpoint.id,
          provider: "github",
          thread: thread.thread,
          message: makeMessage({
            id: "5603841952",
            userId: "42",
            userName: "octocat",
            text: "@maya answer exactly once",
            mentioned: true,
          }),
          trigger: "mention",
        }, service);
        inFlight.push(deliveryWork);
        if (mode === "held_token" || mode === "held_add") {
          await ready;
          const finalWork = publish();
          inFlight.push(finalWork);
          await vi.waitFor(async () => {
            const rows = await db
              .select({ state: chatPublications.state })
              .from(chatPublications)
              .where(
                and(
                  eq(chatPublications.endpointId, endpoint.id),
                  eq(chatPublications.idempotencyKey, `run:${runId}:completed:${endpoint.id}`),
                ),
              );
            expect(rows).toHaveLength(1);
          });
          // Wait for durable staging, not settlement while the receipt owns
          // the credential lease. Neither reply nor cleanup can overtake it.
          expect(
            originalRuntime.posts.filter(
              (post) => post.text === "PINNED-GITHUB-RECEIPT-FINAL",
            ),
          ).toHaveLength(0);
          expect(calls.some((call) => call.method === "DELETE")).toBe(false);
          release();
          await Promise.all([deliveryWork, finalWork]);
          const pendingRemovals = await db
            .select({ id: chatActions.id })
            .from(chatActions)
            .where(
              and(
                eq(chatActions.endpointId, endpoint.id),
                like(chatActions.providerActionId, "receipt_reaction_remove:%"),
              ),
            );
          expect(pendingRemovals).toHaveLength(1);
        } else {
          await deliveryWork;
          if (mode !== "final_before_add") await publish();
        }
        const [delivery] = await readChatDeliveriesByEndpointId(endpoint.id);
        const [removal] = await readChatActionsByProviderActionId(`receipt_reaction_remove:${delivery.id}`);
        expect(removal).toBeDefined();
        if (!["final_before_add", "held_token", "held_add"].includes(mode))
          expect(removal.payload.githubReceipt).toEqual({
            botUserId: "9001",
            reactionId: "700",
          });
        if (mode === "newer_followup")
          await deliverLegacyGitHubReceipt({
            callbacks,
            endpointId: endpoint.id,
            provider: "github",
            thread: thread.thread,
            message: makeMessage({
              id: "5603841953",
              userId: "42",
              userName: "octocat",
              text: "A separate fresh queued question",
            }),
            trigger: "subscribed_message",
          }, service);
        removing = true;
        if (["restart", "unknown_bot"].includes(mode)) {
          await service.shutdown();
          const next = createService(new FakeChatSdkRuntime(), providerFetch, {
            scheduleDeferredWork: () => undefined,
          });
          next.runtime.initializeHook = async (id) => {
            if (id === endpoint.id) attach(next.runtime.endpoints.get(id)!);
          };
          activeService = next.service;
        }
        if (mode === "rotation") {
          const [current] = await readChatEndpointsById(endpoint.id);
          await db
            .update(chatEndpoints)
            .set({
              setup: {
                ...current.setup,
                runtimeGeneration:
                  Number((current.setup as InternalSetupState).runtimeGeneration ?? 0) + 1,
              } as InternalSetupState,
            })
            .where(eq(chatEndpoints.id, endpoint.id));
        }
        const blocked = [
          "unknown_bot",
          "incomplete_page",
          "connection_revoked",
        ].includes(mode);
        await activeService.processPendingReceiptReactions(1, removal.id);
        if (mode === "remove_retry") {
          const [failed] = await readChatActionsById(removal.id);
          expect(failed).toMatchObject({
            status: "failed",
            result: { retryable: true, attempts: 1 },
          });
          await db
            .update(chatActions)
            .set({
              result: { ...failed.result, retryAt: new Date(0).toISOString() },
            })
            .where(eq(chatActions.id, removal.id));
        }
        // Blocked operations retain their failed audit result. Retry only the
        // explicit rate-limit case; successful cases also prove idempotency.
        if (!blocked) await activeService.processPendingReceiptReactions(1, removal.id);
        const [result] = await readChatActionsById(removal.id);
        expect(result.status).toBe(
          mode === "rotation" ? "cancelled" : blocked ? "failed" : "processed",
        );
        expect(remote.has("5603841952")).toBe(blocked || mode === "rotation");
        expect(remote.has("5603841953")).toBe(mode === "newer_followup");
        expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(
          blocked || mode === "rotation" || mode === "final_before_add"
            ? 0
            : mode === "remove_retry"
              ? 2
              : 1,
        );
        expect(
          calls.filter(
            (call) => call.method === "POST" && call.path.endsWith("/reactions"),
          ),
        ).toHaveLength(
          mode === "final_before_add" ? 0 : mode === "newer_followup" ? 2 : 1,
        );
        expect(
          originalRuntime.posts.filter(
            (post) => post.text === "PINNED-GITHUB-RECEIPT-FINAL",
          ),
        ).toHaveLength(0);
        expect(wakeup).toHaveBeenCalledTimes(mode === "newer_followup" ? 2 : 1);
      } finally {
        release();
        await Promise.allSettled(inFlight);
        try {
          await retirePublicationFixture(activeService, endpoint.id);
        } finally {
          if (activeService !== service) await service.shutdown();
          await Promise.all(pins.map((pin) => pin.shutdown()));
        }
      }
    },
  );

  it.each([
    {
      label: "records a successful GitHub receipt reaction once",
      failures: [] as Error[],
      terminalFailure: null as Error | null,
      expectedAttempts: 1,
      expectedDiagnostic: null as RegExp | null,
    },
    {
      label: "keeps an accepted task authoritative after a GitHub 403",
      failures: [] as Error[],
      terminalFailure: Object.assign(new Error("GitHub reaction forbidden"), {
        status: 403,
      }),
      expectedAttempts: 1,
      expectedDiagnostic:
        /Receipt reaction failed after 1 attempt \(failed\): GitHub reaction forbidden/,
    },
    {
      label: "retries a GitHub 429 receipt reaction with bounded backoff",
      failures: [
        Object.assign(new Error("GitHub reaction rate limited"), {
          status: 429,
          retryAfterMs: 1,
        }),
      ],
      terminalFailure: null as Error | null,
      expectedAttempts: 2,
      expectedDiagnostic: null as RegExp | null,
    },
    {
      label: "retries idempotent GitHub receipt reactions after network errors",
      failures: [
        Object.assign(new Error("connection reset before response"), {
          code: "ECONNRESET",
          name: "NetworkError",
        }),
        Object.assign(new Error("temporary network timeout"), {
          code: "ETIMEDOUT",
          name: "NetworkError",
        }),
      ],
      terminalFailure: null as Error | null,
      expectedAttempts: 3,
      expectedDiagnostic: null as RegExp | null,
    },
  ])(
    "$label",
    async ({
      expectedAttempts,
      expectedDiagnostic,
      failures,
      terminalFailure,
    }) => {
      const fixture = await seedCompany();
      const { callbacks, endpoint, runtime, service, wakeup } =
        await configuredGitHubEndpoint(fixture);
      const endpointRuntime = runtime.endpoints.get(endpoint.id);
      if (!endpointRuntime) throw new Error("Expected GitHub runtime");
      const github = makeThread({
        channelId: "github:paperclipai/paperclip",
        id: "github:paperclipai/paperclip:issue:receipt-reaction",
        name: "paperclipai/paperclip",
      });
      for (const failure of failures) {
        endpointRuntime.reactionErrors.push(failure);
      }
      if (terminalFailure) {
        endpointRuntime.reactionErrors.push(terminalFailure);
      }

      await deliverLegacyGitHubReceipt({
        callbacks,
        endpointId: endpoint.id,
        provider: "github",
        thread: github.thread,
        message: makeMessage({
          id: "880011",
          text: "@maya verify receipt reaction reliability",
          mentioned: true,
        }),
        trigger: "mention",
      }, service);

      for (let attempt = 1; attempt < expectedAttempts; attempt += 1) {
        const pending = await db
          .select()
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, endpoint.id),
              eq(chatActions.kind, "receipt_reaction"),
            ),
          )
          .then((rows) => rows[0]);
        if (!pending) throw new Error("Expected durable receipt reaction");
        await db
          .update(chatActions)
          .set({
            result: { ...pending.result, retryAt: new Date(0).toISOString() },
            updatedAt: new Date(),
          })
          .where(eq(chatActions.id, pending.id));
        await service.processPendingReceiptReactions(1, pending.id);
      }

      expect(endpointRuntime.reactionErrors).toHaveLength(0);
      expect(endpointRuntime.reactions).toEqual(
        terminalFailure
          ? []
          : [
              {
                threadId: github.thread.id,
                messageId: "880011",
                emoji: "eyes",
              },
            ],
      );
      const [delivery] = await readChatDeliveriesByEndpointId(endpoint.id);
      expect(delivery).toMatchObject({ state: "processed", attempts: 1 });
      expect(wakeup).toHaveBeenCalledTimes(1);
      expect(
        await readIssuesByCompanyId(fixture.companyId),
      ).toHaveLength(1);
      const activity = (await service.listActivity(endpoint.id)).find(
        (item) => item.id === delivery.id,
      );
      await expect(
        db
          .select({ result: chatActions.result, status: chatActions.status })
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, endpoint.id),
              eq(chatActions.kind, "receipt_reaction"),
            ),
          ),
      ).resolves.toEqual([
        {
          status: terminalFailure ? "failed" : "processed",
          result: expect.objectContaining({ attempts: expectedAttempts }),
        },
      ]);
      if (expectedDiagnostic) {
        expect(delivery.redactedError).toMatch(expectedDiagnostic);
        expect(activity?.detail).toMatch(expectedDiagnostic);
        await expect(service.get(endpoint.id)).resolves.toMatchObject({
          status: "verifying",
        });
      } else {
        expect(delivery.redactedError).toBeNull();
        expect(activity?.detail).toBeNull();
      }
      await service.shutdown();
    },
  );

  it.each([
    "ordinary",
    "final_before_add",
    "newer_followup",
    "same_source_retry",
  ] as const)(
    "retires only the exact Slack final's receipt (%s)",
    async (mode) => {
      const fixture = await seedCompany();
      const statusCalls: string[] = [];
      const ordinaryFetch = fakeSlackFetch();
      let releaseReceipt!: () => void;
      const receiptGate = new Promise<void>((resolve) => { releaseReceipt = resolve; });
    // Assigned before the wakeup callback runs; `let` with definite assignment is the TS idiom here.
    // oxlint-disable-next-line prefer-const
      let earlyFinal:
        | ((
            agentId: string,
            opts: Parameters<
              ChatChannelServiceOptions["heartbeat"]["wakeup"]
            >[1],
          ) => Promise<unknown>)
        | undefined;
      const context = await configuredSlackEndpoint(fixture, {
        scheduleDeferredWork: () => undefined,
        ...(mode === "final_before_add" ? { receiptReactionTransportBarrier: () => receiptGate } : {}),
        fetch: async (input, init) => {
          if (
            String(input) === "https://slack.com/api/agents.sessions.setStatus"
          )
            statusCalls.push(JSON.parse(String(init?.body)).status);
          return await ordinaryFetch(input);
        },
        ...(mode === "final_before_add"
          ? {
              wakeup: async (agentId, opts) => await earlyFinal!(agentId, opts),
            }
          : {}),
      });
      const { callbacks, endpoint, runtime, service, wakeup } = context;
      const providerRuntime = runtime.endpoints.get(endpoint.id)!;
      const thread = makeThread({
        channelId: "CCLEANUP",
        id: "slack:CCLEANUP:1740000021.1",
      });
      const runId = randomUUID();
      const publishFinal = async () => {
        const [conversation] = await service.listConversations(endpoint.id);
        await db.insert(heartbeatRuns).values({
          id: runId,
          companyId: fixture.companyId,
          agentId: fixture.assignedAgentId,
          status: "succeeded",
          contextSnapshot: await chatWakeContext({
            endpointId: endpoint.id,
            issueId: conversation.issueId,
            provider: "slack",
            providerMessageId: "1740000021.1",
          }),
        });
        await addSelectedChatFinal({
          agentId: fixture.assignedAgentId,
          body: "SLACK-RECEIPT-FINAL",
          companyId: fixture.companyId,
          issueId: conversation.issueId,
          runId,
        });
        await service.processPendingPublications();
      };
      earlyFinal = async (agentId, opts) => {
        const request = opts.durableChatRequest!;
        await db.transaction(async (tx) => {
          await request.authorize(tx as never);
          await tx.insert(agentWakeupRequests).values({
            id: request.id,
            companyId: request.companyId,
            agentId,
            source: opts.source!,
            triggerDetail: opts.triggerDetail,
            reason: opts.reason,
            payload: opts.payload,
            requestedByActorType: opts.requestedByActorType,
            requestedByActorId: opts.requestedByActorId,
            idempotencyKey: request.idempotencyKey,
            requestedAt: request.requestedAt,
            status: "queued",
          });
        });
        await expect(
          db
            .select({ id: chatActions.id })
            .from(chatActions)
            .where(
              and(
                eq(chatActions.endpointId, endpoint.id),
                eq(chatActions.kind, "receipt_reaction"),
              ),
            ),
        ).resolves.toHaveLength(1);
        await publishFinal();
        releaseReceipt();
        return { runId };
      };
      try {
        await deliverMessage({
          callbacks,
          endpointId: endpoint.id,
          thread: thread.thread,
          message: makeMessage({
            id: "1740000021.1",
            text: "@maya reply exactly",
            mentioned: true,
          }),
          trigger: "mention",
        });
        if (mode !== "final_before_add") await publishFinal();
        const [delivery] = await readChatDeliveriesByEndpointId(endpoint.id);
        const [removal] = await db
          .select()
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, endpoint.id),
              eq(
                chatActions.providerActionId,
                `receipt_reaction_remove:${delivery.id}`,
              ),
            ),
          );
        expect(removal).toBeDefined();
        if (mode === "newer_followup") {
          await deliverMessage({
            callbacks,
            endpointId: endpoint.id,
            thread: thread.thread,
            message: makeMessage({
              id: "1740000022.2",
              text: "Newer follow-up must retain its own receipt",
            }),
            trigger: "subscribed_message",
          });
        }
        await service.processPendingReceiptReactions(1, removal!.id);
        await service.processPendingReceiptReactions(1, removal!.id);
        expect(providerRuntime.removedReactions).toEqual([
          {
            threadId: thread.thread.id,
            messageId: "1740000021.1",
            emoji: "eyes",
          },
        ]);
        const expectedAdds =
          mode === "final_before_add"
            ? []
            : [
                {
                  threadId: thread.thread.id,
                  messageId: "1740000021.1",
                  emoji: "eyes",
                },
              ];
        if (mode === "newer_followup")
          expectedAdds.push({
            threadId: thread.thread.id,
            messageId: "1740000022.2",
            emoji: "eyes",
          });
        expect(providerRuntime.reactions).toEqual(expectedAdds);
        const [add] = await readChatActionsByProviderActionId(`receipt_reaction:${delivery.id}`);
        await db
          .update(chatActions)
          .set({
            status: "failed",
            result: { retryable: true, retryAt: new Date(0).toISOString() },
          })
          .where(eq(chatActions.id, add.id));
        await service.processPendingReceiptReactions(1, add.id);
        expect(providerRuntime.reactions).toEqual(expectedAdds);
        if (mode === "same_source_retry") {
          const [conversation] = await service.listConversations(endpoint.id);
          const retryRunId = randomUUID();
          await db.insert(heartbeatRuns).values({
            id: retryRunId,
            companyId: fixture.companyId,
            agentId: fixture.assignedAgentId,
            runtimeMode: "native",
            status: "running",
            contextSnapshot: await chatWakeContext({
              endpointId: endpoint.id,
              issueId: conversation.issueId,
              provider: "slack",
              providerMessageId: "1740000021.1",
            }),
          });
          await enqueueChatRunMilestones(db);
          await service.processPendingPublications();
          const [statusAction] = await db
            .select({ id: chatActions.id })
            .from(chatActions)
            .where(
              and(
                eq(chatActions.endpointId, endpoint.id),
                eq(chatActions.kind, "slack_session_sync"),
              ),
            );
          await service.processPendingSlackSessionSyncs(1, statusAction.id);
          expect(statusCalls.at(-1)).toBe("processing");
          // The retry has native working status, not a reminted acknowledgement
          // for the same original provider message. Late add replay stays inert.
          await service.processPendingDeliveries(25, delivery.id);
          expect(providerRuntime.reactions).toEqual(expectedAdds);
          expect(providerRuntime.removedReactions).toHaveLength(1);
        }
        expect(
          [...providerRuntime.posts, ...providerRuntime.edits].filter(
            (entry) => entry.text === "SLACK-RECEIPT-FINAL",
          ),
        ).toHaveLength(1);
        expect(wakeup).toHaveBeenCalledTimes(mode === "newer_followup" ? 2 : 1);
      } finally {
        releaseReceipt();
        // Retire the synthetic still-running retry's conversation so later
        // globally-scanned milestone fixtures cannot inherit this test's work.
        if (mode === "same_source_retry")
          await db
            .update(chatConversations)
            .set({ state: "completed" })
            .where(eq(chatConversations.endpointId, endpoint.id));
        await retirePublicationFixture(service, endpoint.id);
      }
    },
  );

  it.each([429, 503])(
    "does not accept a contradictory HTTP%s Slack duplicate receipt",
    async (status) => {
      const fixture = await seedCompany();
      const { callbacks, endpoint, runtime, service } =
        await configuredSlackEndpoint(fixture, {
          scheduleDeferredWork: () => undefined,
        });
      const pinned = createChatSdkEndpointRuntime({
        ...runtime.configurations.get(endpoint.id)!,
        logger: "silent",
      });
      Object.assign(runtime.endpoints.get(endpoint.id)!, {
        applySlackReceiptReaction: (
          input: Parameters<typeof pinned.applySlackReceiptReaction>[0],
        ) =>
          pinned.applySlackReceiptReaction(input, async () =>
            Response.json(
              { ok: false, error: "already_reacted" },
              { status, headers: { "retry-after": "60" } },
            ),
          ),
      });
      try {
        const thread = makeThread({
          channelId: "CRECEIPTDENY",
          id: "slack:CRECEIPTDENY:1740000041.1",
        });
        await deliverMessage({
          callbacks,
          endpointId: endpoint.id,
          thread: thread.thread,
          message: makeMessage({
            id: "1740000041.1",
            text: "@maya receipt must be coherent",
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
              eq(chatActions.kind, "receipt_reaction"),
            ),
          );
        expect(action.status).toBe("failed");
        expect(action.result?.code).not.toBe(
          "receipt_reaction_already_applied",
        );
        expect(action.result?.retryable).toBe(true);
      } finally {
        try {
          await pinned.shutdown();
        } finally {
          await retirePublicationFixture(service, endpoint.id);
        }
      }
    },
  );

  it("bounds a held Slack receipt before delivering an already-ready same-endpoint final", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture, {
        scheduleDeferredWork: () => undefined,
      });
    const providerRuntime = runtime.endpoints.get(endpoint.id)!;
    const pinned = createChatSdkEndpointRuntime({
      ...runtime.configurations.get(endpoint.id)!,
      logger: "silent",
    });
    let started!: () => void;
    const start = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    let localTransportSettled = false;
    let aborted = false;
    const hold = async (signal?: AbortSignal | null) => {
      await new Promise<void>((resolve, reject) => {
        const stop = () => {
          aborted = true;
          localTransportSettled = true;
          reject(new Error("synthetic local transport aborted"));
        };
        release = () => {
          signal?.removeEventListener("abort", stop);
          localTransportSettled = true;
          resolve();
        };
        signal?.addEventListener("abort", stop, { once: true });
        started();
      });
    };
    const originalThread = providerRuntime.thread.bind(providerRuntime);
    vi.spyOn(providerRuntime, "thread").mockImplementation((id) => {
      const thread = originalThread(id);
      return {
        ...thread,
        adapter: { ...thread.adapter, addReaction: async () => hold() },
      };
    });
    // Before the repair, the real service calls its unbounded adapter method.
    // Afterward, forward only the new runtime transport into fake provider HTTP.
    const bounded = (
      pinned as unknown as {
        applySlackReceiptReaction?: (...args: unknown[]) => Promise<void>;
      }
    ).applySlackReceiptReaction;
    if (bounded)
      Object.assign(providerRuntime, {
        applySlackReceiptReaction: (...args: unknown[]) =>
          bounded.call(
            pinned,
            ...args.slice(0, 1),
            async (_url: unknown, init?: RequestInit) => {
              await hold(init?.signal);
              return Response.json({ ok: true });
            },
          ),
      });
    const thread = makeThread({
      channelId: "CRECEIPTBOUND",
      id: "slack:CRECEIPTBOUND:1740000011.1",
    });
    let inbound: Promise<unknown> | undefined;
    let publication: Promise<unknown> | undefined;
    try {
      inbound = deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        thread: thread.thread,
        message: makeMessage({
          id: "1740000011.1",
          text: "@maya a fast final",
          mentioned: true,
        }),
        trigger: "mention",
      });
      await start;
      const [lease] = await db
        .select()
        .from(chatEndpointLeases)
        .where(
          and(
            eq(chatEndpointLeases.endpointId, endpoint.id),
            eq(chatEndpointLeases.leaseKey, "credentials"),
          ),
        );
      expect(lease).toBeDefined();
      const [conversation] = await service.listConversations(endpoint.id);
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        status: "succeeded",
        contextSnapshot: await chatWakeContext({
          endpointId: endpoint.id,
          issueId: conversation.issueId,
          provider: "slack",
          providerMessageId: "1740000011.1",
        }),
      });
      await addSelectedChatFinal({
        agentId: fixture.assignedAgentId,
        body: "SLACK-FAST-FINAL",
        companyId: fixture.companyId,
        issueId: conversation.issueId,
        runId,
      });
      publication = service.processPendingPublications();
      await vi.waitFor(
        () =>
          expect(
            [...providerRuntime.posts, ...providerRuntime.edits].filter(
              (entry) => entry.text === "SLACK-FAST-FINAL",
            ),
          ).toHaveLength(1),
        { timeout: 3_500, interval: 25 },
      );
      expect(aborted).toBe(true);
      expect(localTransportSettled).toBe(true);
      await Promise.all([inbound, publication]);
    } finally {
      release?.();
      await Promise.allSettled([inbound, publication]);
      try {
        await pinned.shutdown();
      } finally {
        await retirePublicationFixture(service, endpoint.id);
      }
    }
  });

  it.each(["attachment", "subscription", "wakeup"] as const)("acknowledges a Slack mention while %s is blocked", async (phase) => {
    const fixture = await seedCompany();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = vi.fn();
    const blocked = async () => { entered(); await gate; return { accepted: true }; };
    const { callbacks, endpoint, runtime, service, wakeup } = await configuredSlackEndpoint(fixture, {
      ...(phase === "wakeup" ? { wakeup: blocked } : {}),
      ...(phase === "attachment" ? { storage: createStorageService().storage } : {}),
    });
    const thread = makeThread({ channelId: "CFAST", id: "slack:CFAST:1740000088.1" });
    if (phase === "subscription") thread.thread.subscribe = async () => { await blocked(); };
    const message = makeMessage({ id: "1740000088.1", text: "@maya acknowledge immediately", mentioned: true,
      ...(phase === "attachment" ? { attachments: [{ type: "file", name: "receipt.txt", mimeType: "text/plain", fetchData: async () => { await blocked(); return Buffer.from("synthetic attachment"); } } as Attachment] } : {}),
    });
    const startedAt = performance.now();
    const inbound = deliverMessage({ callbacks, endpointId: endpoint.id, thread: thread.thread, message, trigger: "mention" });
    try {
      await vi.waitFor(() => expect(entered).toHaveBeenCalled(), { timeout: 3_000, interval: 10 });
      await vi.waitFor(() => expect(runtime.endpoints.get(endpoint.id)!.reactions).toHaveLength(1), { timeout: 1_000, interval: 10 });
      const [delivery] = await readChatDeliveriesByEndpointId(endpoint.id);
      await vi.waitFor(async () => {
        const [receipt] = await readChatActionsByProviderActionId(`receipt_reaction:${delivery.id}`);
        expect(receipt.status).toBe("processed");
      }, { timeout: 1_000, interval: 10 });
      const [receipt] = await readChatActionsByProviderActionId(`receipt_reaction:${delivery.id}`);
      expect(await readIssuesByCompanyId(fixture.companyId)).toHaveLength(1);
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, fixture.companyId))).toHaveLength(0);
      process.stdout.write(`Slack ${phase} blocked: eyes confirmed in ${(performance.now() - startedAt).toFixed(1)}ms; durable receipt to confirmed action ${receipt.updatedAt.getTime() - delivery.receivedAt.getTime()}ms (synthetic Slack, real PostgreSQL)\n`);
    } finally {
      release();
      await inbound;
    }
    await deliverMessage({ callbacks, endpointId: endpoint.id, thread: thread.thread, message, trigger: "mention" });
    expect(runtime.endpoints.get(endpoint.id)!.reactions).toHaveLength(1);
    expect(wakeup).toHaveBeenCalledTimes(1);
    await service.shutdown();
  });

  it.each(["attachment", "subscription"] as const)("preserves an early Slack receipt failure after %s acceptance", async phase => {
    const fixture = await seedCompany();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = vi.fn();
    const block = async () => { entered(); await gate; };
    const { callbacks, endpoint, runtime, service } = await configuredSlackEndpoint(fixture, {
      ...(phase === "attachment" ? { storage: createStorageService().storage } : {}),
    });
    const provider = runtime.endpoints.get(endpoint.id)!;
    provider.reactionErrors.push(Object.assign(new Error("missing_scope"), { code: "slack_webapi_platform_error", data: { error: "missing_scope" } }));
    const reaction = vi.spyOn(provider, "applySlackReceiptReaction");
    const thread = makeThread({ channelId: "CEARLYERROR", id: "slack:CEARLYERROR:1740000091.1" });
    if (phase === "subscription") thread.thread.subscribe = block;
    const message = makeMessage({ id: "1740000091.1", text: "@maya preserve the receipt warning", mentioned: true,
      ...(phase === "attachment" ? { attachments: [{ type: "file", name: "receipt.txt", mimeType: "text/plain", fetchData: async () => { await block(); return Buffer.from("synthetic attachment"); } } as Attachment] } : {}),
    });
    const inbound = deliverMessage({ callbacks, endpointId: endpoint.id, thread: thread.thread, message, trigger: "mention" });
    try {
      await vi.waitFor(() => expect(entered).toHaveBeenCalled(), { timeout: 3_000, interval: 10 });
      const [delivery] = await readChatDeliveriesByEndpointId(endpoint.id);
      await vi.waitFor(async () => {
        const [receipt] = await readChatActionsByProviderActionId(`receipt_reaction:${delivery.id}`);
        expect(receipt).toMatchObject({ status: "failed", result: { redactedError: expect.stringContaining("missing_scope") } });
      }, { timeout: 1_000, interval: 10 });
      expect((await readChatDeliveriesByEndpointId(endpoint.id))[0].state).toBe("processing");
      release();
      await inbound;
      expect((await readChatDeliveriesByEndpointId(endpoint.id))[0]).toMatchObject({
        state: "processed", redactedError: expect.stringMatching(/Receipt reaction .*missing_scope/),
      });
      expect(reaction).toHaveBeenCalledTimes(1);
    } finally { release(); await inbound; await service.shutdown(); }
  });

  it.each(["confirmed", "already reacted"] as const)("keeps an omitted-file warning after an early Slack receipt failure and %s retry", async outcome => {
    const fixture = await seedCompany();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = vi.fn();
    const { callbacks, endpoint, runtime, service } = await configuredSlackEndpoint(fixture, { storage: createStorageService().storage });
    const provider = runtime.endpoints.get(endpoint.id)!;
    provider.reactionErrors.push(Object.assign(new Error("missing_scope\nsynthetic provider detail"), { code: "slack_webapi_platform_error", data: { error: "missing_scope" } }));
    if (outcome === "already reacted") provider.reactionErrors.push(Object.assign(new Error("already reacted"), { code: "slack_webapi_platform_error", data: { error: "already_reacted" } }));
    const reaction = vi.spyOn(provider, "applySlackReceiptReaction");
    const thread = makeThread({ channelId: "COMITTEDERROR", id: "slack:COMITTEDERROR:1740000092.1" });
    const inbound = deliverMessage({ callbacks, endpointId: endpoint.id, thread: thread.thread, trigger: "mention",
      message: makeMessage({ id: "1740000092.1", text: "@maya retain both warnings", mentioned: true,
        attachments: [{ type: "file", name: "omitted.txt", mimeType: "text/plain", fetchData: async () => { entered(); await gate; throw new Error("controlled file download failure"); } } as Attachment],
      }),
    });
    try {
      await vi.waitFor(() => expect(entered).toHaveBeenCalled(), { timeout: 3_000, interval: 10 });
      const [delivery] = await readChatDeliveriesByEndpointId(endpoint.id);
      await vi.waitFor(async () => {
        const [receipt] = await readChatActionsByProviderActionId(`receipt_reaction:${delivery.id}`);
        expect(receipt.status).toBe("failed");
      }, { timeout: 1_000, interval: 10 });
      release();
      await inbound;
      const before = (await readChatDeliveriesByEndpointId(endpoint.id))[0];
      expect(before.redactedError).toContain("Receipt reaction");
      expect(before.redactedError).toContain("1 external attachment was omitted");
      expect(reaction).toHaveBeenCalledTimes(1);
      const [receipt] = await readChatActionsByProviderActionId(`receipt_reaction:${delivery.id}`);
      await db.update(chatActions).set({ result: { ...receipt.result, retryable: true, retryAt: new Date(0).toISOString() } }).where(eq(chatActions.id, receipt.id));
      await service.processPendingReceiptReactions(1, receipt.id);
      const after = (await readChatDeliveriesByEndpointId(endpoint.id))[0];
      expect(after.redactedError).toContain("1 external attachment was omitted");
      expect(after.redactedError).not.toContain("Receipt reaction");
      expect(after.redactedError).not.toContain("synthetic provider detail");
      expect(reaction).toHaveBeenCalledTimes(2);
      expect((await readChatActionsById(receipt.id))[0].status).toBe("processed");
    } finally { release(); await inbound; await service.shutdown(); }
  });

  it("acknowledges a signed URL mention through the real Slack SDK without waiting for an unfurl", async () => {
    const fixture = await seedCompany();
    const { endpoint, runtime, service, wakeup } = await configuredSlackEndpoint(fixture);
    const pinned = createChatSdkEndpointRuntime({ ...runtime.configurations.get(endpoint.id)!, logger: "silent" });
    const threadId = "slack:CFASTSDK:1740000090.1";
    const adapter = pinned.thread(threadId).adapter as unknown as {
      _client: { auth: { test: (...args: unknown[]) => Promise<unknown> }; users: { info: (...args: unknown[]) => Promise<unknown> } };
    };
    adapter._client.auth.test = vi.fn(async () => ({ ok: true, user_id: "UBOT", user: "maya", team_id: "T-PAPERCLIP" }));
    adapter._client.users.info = vi.fn(async () => ({ ok: true, user: { id: "USENDER", profile: { display_name: "Test sender" } } }));
    const startedAt = performance.now();
    try {
      const response = await pinned.handleWebhook(signedSlackWebhookRequest({
        url: `https://paperclip.example/api/chat-webhooks/${endpoint.publicId}/slack`, contentType: "application/json",
        body: JSON.stringify({ type: "event_callback", event_id: "EvFASTSDK", team_id: "T-PAPERCLIP",
          event: { type: "app_mention", channel: "CFASTSDK", user: "USENDER", ts: "1740000090.1", text: "<@UBOT> review <https://example.com/review|this link>" },
        }),
      }));
      expect(response.status).toBe(200);
      await vi.waitFor(() => expect(runtime.endpoints.get(endpoint.id)!.reactions).toEqual([
        { threadId, messageId: "1740000090.1", emoji: "eyes" },
      ]), { timeout: 1_000, interval: 10 });
      expect(wakeup).toHaveBeenCalledTimes(1);
      expect(adapter._client.users.info).toHaveBeenCalled();
      process.stdout.write(`Signed URL mention through real Slack SDK: eyes confirmed in ${(performance.now() - startedAt).toFixed(1)}ms (real PostgreSQL, simulated provider APIs)\n`);
    } finally {
      await pinned.shutdown();
      await service.shutdown();
    }
  });

  it("settles a retried Slack receipt reaction when the provider reports already_reacted", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture);
    const workWake = vi.fn();
    const stopWorkObserver = subscribeDeliveryWork(db, DELIVERY_QUEUES.chatReceiptReactions, workWake);
    onTestFinished(() => { stopWorkObserver(); expect(workWake).toHaveBeenCalled(); });
    const endpointRuntime = runtime.endpoints.get(endpoint.id);
    if (!endpointRuntime) throw new Error("Expected Slack runtime");
    endpointRuntime.reactionErrors.push(
      Object.assign(new Error("response lost after provider acceptance"), {
        code: "ECONNRESET",
        name: "NetworkError",
      }),
      Object.assign(new Error("reaction already exists"), {
        code: "slack_webapi_platform_error",
        data: { error: "already_reacted" },
      }),
    );
    const slack = makeThread({
      channelId: "C-RECEIPT-IDEMPOTENT",
      id: "slack:C-RECEIPT-IDEMPOTENT:880012",
      name: "receipt-idempotent",
    });

    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: slack.thread,
      message: makeMessage({
        id: "880012",
        text: "@maya verify idempotent Slack receipt recovery",
        mentioned: true,
      }),
      trigger: "mention",
    });
    const action = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.kind, "receipt_reaction"),
        ),
      )
      .then((rows) => rows[0]!);
    expect(action).toMatchObject({ status: "failed" });
    await db
      .update(chatActions)
      .set({
        result: {
          ...(action.result ?? {}),
          retryAt: new Date(0).toISOString(),
        },
        updatedAt: new Date(),
      })
      .where(eq(chatActions.id, action.id));

    await service.processPendingDeliveries();

    await expect(
      db
        .select({ status: chatActions.status, result: chatActions.result })
        .from(chatActions)
        .where(eq(chatActions.id, action.id)),
    ).resolves.toEqual([
      {
        status: "processed",
        result: {
          attempts: 2,
          code: "receipt_reaction_already_applied",
        },
      },
    ]);
    await expect(
      db
        .select({ redactedError: chatDeliveries.redactedError })
        .from(chatDeliveries)
        .where(eq(chatDeliveries.id, action.deliveryId!)),
    ).resolves.toEqual([{ redactedError: null }]);
    expect(endpointRuntime.reactionErrors).toEqual([]);
    await service.shutdown();
  });

  it.each([false, true])("clears an older multi-line Slack receipt diagnostic on terminal removal with attachment warning %s", async hasAttachmentWarning => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } = await configuredSlackEndpoint(fixture);
    try {
      const thread = makeThread({ channelId: "COLDWARNING", id: "slack:COLDWARNING:1740000093.1" });
      await deliverMessage({ callbacks, endpointId: endpoint.id, thread: thread.thread, trigger: "mention",
        message: makeMessage({ id: "1740000093.1", text: "@maya clear an older receipt diagnostic", mentioned: true }),
      });
      const [delivery] = await readChatDeliveriesByEndpointId(endpoint.id);
      const [receipt] = await readChatActionsByProviderActionId(`receipt_reaction:${delivery.id}`);
      const diagnostic = "Receipt reaction failed after 1 attempt (endpoint_attention): missing_scope\nsynthetic provider detail";
      const attachmentWarning = "1 external attachment was omitted";
      await db.update(chatActions).set({ status: "failed", result: { attempts: 1, retryable: false, redactedError: diagnostic } }).where(eq(chatActions.id, receipt.id));
      await db.update(chatDeliveries).set({ redactedError: diagnostic + (hasAttachmentWarning ? `\n${attachmentWarning}` : "") }).where(eq(chatDeliveries.id, delivery.id));
      const [conversation] = await service.listConversations(endpoint.id);
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId: fixture.companyId, agentId: fixture.assignedAgentId, status: "succeeded",
        contextSnapshot: await chatWakeContext({ endpointId: endpoint.id, issueId: conversation.issueId, provider: "slack", providerMessageId: "1740000093.1" }),
      });
      const [endpointRow] = await readChatEndpointsById(endpoint.id);
      const removalIds = await db.transaction(tx => stageReceiptReactionRemovals(tx as unknown as Db, {
        endpoint: endpointRow, binding: { companyId: fixture.companyId, endpointId: endpoint.id, conversationId: conversation.id, issueId: conversation.issueId }, runId,
        runtimeContext: { generation: Number(receipt.payload.runtimeGeneration), credentialFingerprint: String(receipt.payload.credentialFingerprint) },
      }));
      expect(removalIds).toHaveLength(1);
      await service.processPendingReceiptReactions(1, removalIds[0]);
      expect(runtime.endpoints.get(endpoint.id)!.removedReactions).toEqual([{ threadId: thread.thread.id, messageId: "1740000093.1", emoji: "eyes" }]);
      expect((await readChatActionsById(removalIds[0]))[0].status).toBe("processed");
      expect((await readChatDeliveriesByEndpointId(endpoint.id))[0].redactedError).toBe(hasAttachmentWarning ? attachmentWarning : null);
    } finally { await service.shutdown(); }
  });

  it("canonicalizes prefixed Chat SDK channel ids onto provider inventory resources", async () => {
    const fixture = await seedCompany();
    const providerFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://slack.com/api/auth.test") {
        return new Response(
          JSON.stringify({
            ok: true,
            team_id: "T-PREFIXED",
            team: "Prefixed Workspace",
            user_id: "U-PREFIXED-BOT",
            user: "maya-prefixed",
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
            channels: [
              {
                id: "C-PREFIXED",
                name: "prefixed-channel",
                is_member: true,
                is_archived: false,
              },
            ],
            response_metadata: { next_cursor: "" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected provider request: ${url}`);
    }) as typeof globalThis.fetch;
    const runtime = new FakeChatSdkRuntime();
    const { service } = createService(runtime, providerFetch);
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
          botToken: "xoxb-prefixed-channel",
          signingSecret: "prefixed-channel-secret",
        },
      },
      "owner-user",
    );
    const [inventoryResource] = await service.listResources(endpoint.id);
    await service.replaceResources(endpoint.id, [
      { id: inventoryResource!.id, enabled: true },
    ]);
    const callbacks = runtime.configurations.get(endpoint.id)?.callbacks;
    if (!callbacks) throw new Error("Expected Slack callbacks");
    const thread = makeThread({
      channelId: "slack:C-PREFIXED",
      id: "slack:C-PREFIXED:2200.1",
      name: "prefixed-channel",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: thread.thread,
      message: makeMessage({
        id: "2200.1",
        text: "@maya use the inventoried destination",
        mentioned: true,
      }),
      trigger: "mention",
    });

    const resources = await service.listResources(endpoint.id);
    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({
      id: inventoryResource!.id,
      providerResourceId: "C-PREFIXED",
      availability: "available",
      enabled: true,
    });
    await expect(service.listConversations(endpoint.id)).resolves.toEqual([
      expect.objectContaining({ externalThreadId: thread.thread.id }),
    ]);
  });

  it("refuses to enable a destination the provider no longer exposes", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service } =
      await configuredSlackEndpoint(fixture);
    const channel = makeThread({
      channelId: "C-REMOVED",
      id: "slack:C-REMOVED:2100.1",
      name: "removed-channel",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: channel.thread,
      message: makeMessage({
        id: "2100.1",
        text: "This unaddressed event only discovers the channel",
      }),
      trigger: "unaddressed_message",
    });
    const [resource] = await db
      .select()
      .from(chatEndpointResources)
      .where(eq(chatEndpointResources.endpointId, endpoint.id));
    await db
      .update(chatEndpointResources)
      .set({ availability: "removed", updatedAt: new Date() })
      .where(eq(chatEndpointResources.id, resource.id));

    await expect(
      service.replaceResources(endpoint.id, [
        { id: resource.id, enabled: true },
      ]),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        code: "chat_resource_unavailable",
        resourceId: resource.id,
      },
    });
  });

  it("filters unlinked people when configured, then honors a confirmed active-member identity link", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service } = await configuredSlackEndpoint(
      fixture,
      { allowUnlinkedPeople: false },
    );
    const channel = makeThread({
      channelId: "C-PRIVATE",
      id: "slack:C-PRIVATE:3000.1",
      name: "private",
    });

    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: channel.thread,
      message: makeMessage({
        id: "3000.1",
        text: "@maya private task",
        mentioned: true,
        userId: "U-LINK-ME",
      }),
      trigger: "mention",
    });
    expect(
      await readChatConversationsByEndpointId(endpoint.id),
    ).toHaveLength(0);
    const [filtered] = await readChatDeliveriesByEndpointId(endpoint.id);
    expect(filtered.state).toBe("filtered");

    const now = new Date();
    await db.insert(authUsers).values({
      id: "linked-paperclip-user",
      name: "Linked User",
      email: `linked-${fixture.companyId}@example.com`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId: fixture.companyId,
      principalType: "user",
      principalId: "linked-paperclip-user",
      status: "active",
      membershipRole: "viewer",
    });
    const [principal] = await db
      .select()
      .from(chatExternalPrincipals)
      .where(eq(chatExternalPrincipals.externalId, "U-LINK-ME"));
    const intent = await service.createLinkIntent(
      endpoint.id,
      principal.id,
      1_800,
    );
    const token = new URL(intent.confirmationUrl).searchParams.get("token");
    if (!token) throw new Error("Identity-link confirmation token was absent");
    await expect(service.previewIdentityLink(token)).resolves.toMatchObject({
      endpointId: endpoint.id,
      companyId: fixture.companyId,
      provider: "slack",
      externalLabel: "Alex External",
    });
    await expect(
      service.confirmIdentityLink(token, "linked-paperclip-user"),
    ).resolves.toEqual({
      ok: true,
      endpointId: endpoint.id,
    });

    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: channel.thread,
      message: makeMessage({
        id: "3000.2",
        text: "@maya private task",
        mentioned: true,
        userId: "U-LINK-ME",
      }),
      trigger: "mention",
    });
    expect(
      await readChatConversationsByEndpointId(endpoint.id),
    ).toHaveLength(0);
    const viewerDelivery = await readChatDeliveriesByEndpointId(endpoint.id)
      .then((rows) =>
        rows.find((delivery) => delivery.providerEventId.includes("3000.2")),
      );
    expect(viewerDelivery?.state).toBe("filtered");

    await db
      .update(companyMemberships)
      .set({ membershipRole: "operator" })
      .where(eq(companyMemberships.principalId, "linked-paperclip-user"));
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: channel.thread,
      message: makeMessage({
        id: "3000.3",
        text: "@maya private task",
        mentioned: true,
        userId: "U-LINK-ME",
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id, "U-LINK-ME");
    await service.test(endpoint.id);
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    expect(conversation).toBeDefined();
    const [comment] = await db
      .select()
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, conversation.issueId),
          eq(issueComments.authorType, "user"),
        ),
      );
    expect(comment.authorType).toBe("user");
    expect(comment.authorUserId).toBe("linked-paperclip-user");
    const userCommentCountBeforeSuspend = (
      await readIssueCommentsByIssueId(conversation.issueId)
    ).filter((candidate) => candidate.authorType === "user").length;

    await db
      .update(companyMemberships)
      .set({ status: "suspended" })
      .where(eq(companyMemberships.principalId, "linked-paperclip-user"));
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: channel.thread,
      message: makeMessage({
        id: "3000.4",
        text: "This must no longer pass",
        userId: "U-LINK-ME",
      }),
      trigger: "subscribed_message",
    });
    const allComments = await readIssueCommentsByIssueId(conversation.issueId);
    expect(
      allComments.filter((candidate) => candidate.authorType === "user"),
    ).toHaveLength(userCommentCountBeforeSuspend);
    const allDeliveries = await readChatDeliveriesByEndpointId(endpoint.id);
    expect(
      allDeliveries.find((delivery) =>
        delivery.providerEventId.includes("3000.4"),
      )?.state,
    ).toBe("filtered");
  });

  it("filters an unlinked guest when the endpoint sponsor is suspended and exposes the reason and duplicate count", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service } =
      await configuredSlackEndpoint(fixture);
    await db
      .update(companyMemberships)
      .set({ status: "suspended" })
      .where(
        and(
          eq(companyMemberships.companyId, fixture.companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, "owner-user"),
        ),
      );
    const channel = makeThread({
      channelId: "C-SPONSOR-SUSPENDED",
      id: "slack:C-SPONSOR-SUSPENDED:3100.1",
      name: "sponsor-suspended",
    });
    const message = makeMessage({
      id: "3100.1",
      text: "@maya this guest no longer has a sponsor",
      mentioned: true,
      userId: `U-UNLINKED-${randomUUID()}`,
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        thread: channel.thread,
        message,
        trigger: "mention",
      });
    }

    expect(await service.listConversations(endpoint.id)).toEqual([]);
    const [delivery] = await readChatDeliveriesByEndpointId(endpoint.id);
    expect(delivery).toMatchObject({
      state: "filtered",
      redactedError: "Endpoint sponsor can no longer authorize external guests",
      normalizedEvent: {
        deduplication: { duplicateCount: 2 },
      },
    });
    await expect(service.listActivity(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        id: delivery.id,
        kind: "delivery",
        status: "filtered",
        summary: "mention ignored · 2 duplicates ignored",
        detail: "Endpoint sponsor can no longer authorize external guests",
        replayable: false,
      }),
    ]);
  });

  it("starts real Slack conversations from bare mentions and accepts same-thread follow-ups", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service, wakeup } =
      await configuredSlackEndpoint(fixture, { linkedBoardUser: true, allowUnlinkedPeople: false });
    const configured = await service.get(endpoint.id);
    const variants = [
      "",
      "   \t\n",
      `<@${configured.botExternalId}>`,
      ` \u200b <@${configured.botExternalId}>  @maya !!! `,
    ];

    for (const [index, text] of variants.entries()) {
      const root = makeThread({
        channelId: "C-EMPTY-MENTION",
        id: `slack:C-EMPTY-MENTION:3200.${index}`,
        name: "empty-mention",
      });
      const message = makeMessage({
        id: `3200.${index}`,
        text,
        mentioned: true,
        userId: "UBOARD",
      });
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        thread: root.thread,
        message,
        trigger: "mention",
      });
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        thread: root.thread,
        message,
        trigger: "mention",
      });

      expect(root.post).not.toHaveBeenCalled();
      expect(root.subscribe).toHaveBeenCalledTimes(1);
      expect(wakeup).toHaveBeenCalledTimes(index * 2 + 1);
      const conversation = (await service.listConversations(endpoint.id)).find(row => row.externalThreadId === root.thread.id)!;
      expect(conversation).toMatchObject({ state: "active" });
      const task = await readIssuesById(conversation.issueId!).then(rows => rows[0]);
      expect(task).toMatchObject({ assigneeAgentId: fixture.assignedAgentId, responsibleUserId: "owner-user" });
      await deliverMessage({
        callbacks, endpointId: endpoint.id, thread: root.thread,
        message: makeMessage({ id: `3201.${index}`, text: "u there?", userId: "UBOARD" }),
        trigger: "subscribed_message",
      });
      expect(wakeup).toHaveBeenCalledTimes(index * 2 + 2);
      const comments = await readIssueCommentsByIssueId(task!.id).orderBy(asc(issueComments.createdAt), asc(issueComments.id));
      expect(comments.map(comment => comment.body)).toEqual([text.trim() || "Started a conversation by mentioning the agent.", "u there?"]);
      expect(runtime.endpoints.get(endpoint.id)?.reactions).toContainEqual({
        threadId: root.thread.id,
        messageId: message.id,
        emoji: "eyes",
      });
      expect(root.addReaction).not.toHaveBeenCalled();
    }

    expect(await service.listConversations(endpoint.id)).toHaveLength(variants.length);
    expect(
      await readIssuesByCompanyId(fixture.companyId),
    ).toHaveLength(variants.length);
    expect(
      await readHeartbeatRunsByCompanyId(fixture.companyId),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(chatPublications)
        .where(eq(chatPublications.companyId, fixture.companyId)),
    ).toHaveLength(0);
    const deliveries = await readChatDeliveriesByEndpointId(endpoint.id);
    expect(deliveries).toHaveLength(variants.length * 2);
    expect(
      deliveries.every(
        (delivery) =>
          delivery.state === "processed" &&
          (delivery.eventKind !== "mention" || (delivery.normalizedEvent.deduplication as { duplicateCount?: number } | undefined)?.duplicateCount === 1),
      ),
    ).toBe(true);
    expect(wakeup).toHaveBeenCalledTimes(variants.length * 2);
  });

  it.each(["unlinked", "disabled"] as const)("keeps bare Slack mentions subject to %s access restrictions", async restriction => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } = await configuredSlackEndpoint(fixture, { linkedBoardUser: true, allowUnlinkedPeople: false });
    const root = makeThread({ channelId: "C-BARE-RESTRICTED", id: "slack:C-BARE-RESTRICTED:3300.1" });
    if (restriction === "disabled") await db.insert(chatEndpointResources).values({
      companyId: fixture.companyId, endpointId: endpoint.id, type: "channel",
      providerResourceId: "C-BARE-RESTRICTED", label: "restricted", availability: "available", enabled: false,
    });
    await deliverMessage({
      callbacks, endpointId: endpoint.id, thread: root.thread, trigger: "mention",
      message: makeMessage({ id: "3300.1", text: "", mentioned: true, userId: restriction === "unlinked" ? "U-UNLINKED" : "UBOARD" }),
    });
    expect(await service.listConversations(endpoint.id)).toEqual([]);
    expect(await readIssuesByCompanyId(fixture.companyId)).toHaveLength(0);
    expect(root.subscribe).not.toHaveBeenCalled();
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("suppresses a queued provider reply when destination reach is revoked before transport", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture);
    const root = makeThread({
      channelId: "C-EFFECT-REVOKE",
      id: "slack:C-EFFECT-REVOKE:3210.1",
      name: "effect-revoke",
      isDM: true,
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: root.thread,
      message: makeMessage({
        id: "3210.1",
        text: "/status",
        mentioned: true,
        userId: "U-EFFECT-REVOKE",
      }),
      trigger: "mention",
    });
    const seedEffect = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.kind, "provider_effect"),
        ),
      )
      .then((rows) => rows[0]);
    if (!seedEffect?.principalId)
      throw new Error("Expected an authorized provider-effect seed");
    const resource = await db
      .select()
      .from(chatEndpointResources)
      .where(
        and(
          eq(chatEndpointResources.endpointId, endpoint.id),
          eq(chatEndpointResources.providerResourceId, "C-EFFECT-REVOKE"),
        ),
      )
      .then((rows) => rows[0]);
    if (!resource) throw new Error("Expected the discovered Slack resource");
    const [queuedDelivery] = await db
      .insert(chatDeliveries)
      .values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        principalId: seedEffect.principalId,
        providerEventId: "queued-provider-effect-reach-revoke",
        deduplicationKey: "queued-provider-effect-reach-revoke",
        eventKind: "mention",
        normalizedEvent: {},
        state: "processing",
        attempts: 1,
      })
      .returning();
    const [queuedEffect] = await db
      .insert(chatActions)
      .values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        deliveryId: queuedDelivery!.id,
        principalId: seedEffect.principalId,
        kind: "provider_effect",
        providerActionId: "provider_effect:queued-reach-revoke",
        payload: seedEffect.payload,
        status: "received",
      })
      .returning();

    await service.update(endpoint.id, { allowDirectMessages: false }, "owner-user");
    await service.processPendingProviderEffects();

    expect(runtime.endpoints.get(endpoint.id)?.posts).toEqual([]);
    await expect(
      db
        .select({ status: chatActions.status, result: chatActions.result })
        .from(chatActions)
        .where(eq(chatActions.id, queuedEffect!.id)),
    ).resolves.toEqual([
      {
        status: "cancelled",
        result: {
          attempts: 1,
          code: "provider_effect_no_longer_authorized",
        },
      },
    ]);
    await expect(
      db
        .select({ state: chatDeliveries.state })
        .from(chatDeliveries)
        .where(eq(chatDeliveries.id, queuedDelivery!.id)),
    ).resolves.toEqual([{ state: "filtered" }]);
  });
});
