import { pendingNativeRecoveryNotices, resolveCommittedNativeRecoveryNotices } from "../../services/native-runtime/native-recovery-notices.js";
import { issueRecoveryActionService } from "../../services/issue-recovery-actions.js";
import { projectCommittedRun } from "../../services/native-runtime/native-run-projection.js";
import { notifyNativeFinalizationWork } from "../../services/native-finalization-notifications.js";
import { nativeResponsePresentationWork } from "../../services/native-runtime/native-response-presentation-work.js";
import { notifyChatRunMilestones } from "../../services/chat-run-milestone-notifications.js";
import { accessService } from "../../services/access.js";
import { idleWorkSnapshot } from "../../services/task-admission.js";
import type { Db } from "@paperclipai/db";
import { createDeliveryWorkCoordinator } from "../../services/delivery-work-coordinator.js";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, like, sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agentWakeupRequests, chatActions, chatDeliveries, chatEndpointLeases, chatEndpoints, chatMessageLinks, chatPublications, companyMemberships, heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations, nativeRunResults, statusDecisions } from "@paperclipai/db";
import { type ChatChannelServiceOptions } from "../../services/chat-channels.js";
import type { InternalSetupState } from "../../services/chat-channels/runtime-types.js";
import { createChatSdkEndpointRuntime } from "../../services/chat-sdk-runtime.js";
import { issueService } from "../../services/issues.js";
import { resolveChatRunPresentationAuthorizationReason } from "../../services/chat-run-publications.js";
import type { PrpStructuredRunResult, PrpTerminalState } from "../../vendor/paperclip-runner/index.js";
import { finalizeNativeRun, recoverCommittedNativeChatResponse, repairCommittedNativeChatResponse } from "../../services/native-runtime/native-run-finalizer.js";
import { NativeRunCoordinatorStore } from "../../services/native-runtime/native-run-coordinator-store.js";
import { reconcileNativeFinalizations } from "../../services/native-runtime/native-finalization-reconciler.js";
import { FakeChatSdkRuntime, FakeEndpointRuntime, fakeTelegramFetch, makeMessage, makeThread } from ".././helpers/chat-channels-fixture.js";
import { addSelectedChatFinal, chatWakeContext, committedChatResponseRecoveryFixture, configuredSlackEndpoint, configuredTelegramEndpoint, createService, db, deliverMessage, describeChatChannelsSuite, githubOmissionFixture, linkedCommittedResponseFailure, qualifySetupRoundTrip, readChatActionsById, readChatActionsByProviderActionId, readChatDeliveriesByEndpointId, readChatEndpointsById, readChatPublicationsByCommentId, readChatPublicationsByEndpointId, readChatPublicationsById, readHeartbeatRunsById, readIssuesById, retirePublicationFixture, seedCompany } from "../helpers/chat-channels-harness.js";








describeChatChannelsSuite("chat channels 42-cases", () => {
  it.each([
    { command: "/new", bound: true, denied: false },
    { command: "/status", bound: true, denied: false },
    { command: "/close", bound: true, denied: false },
    { command: "/help", bound: true, denied: false },
    { command: "/new", bound: false, denied: false },
    { command: "/start", bound: false, denied: false },
    { command: "/task", bound: false, denied: false },
    { command: "/status", bound: false, denied: true },
  ])(
    "acknowledges Telegram control $command without a processing receipt (bound=$bound denied=$denied)",
    async ({ command, bound, denied }) => {
      const fixture = await seedCompany();
      const { callbacks, endpoint, runtime, service, wakeup } =
        await configuredTelegramEndpoint(fixture, {
          scheduleDeferredWork: () => undefined,
        });
      const dm = makeThread({
        channelId: "77115570",
        id: "telegram:77115570",
        isDM: true,
        name: "Telegram control receipt",
      });
      try {
        await db
          .update(chatEndpoints)
          .set({
            status: "active",
            ...(denied ? { allowUnlinkedPeople: false } : {}),
          })
          .where(eq(chatEndpoints.id, endpoint.id));
        if (bound) {
          await deliverMessage({
            callbacks,
            endpointId: endpoint.id,
            provider: "telegram",
            thread: dm.thread,
            message: makeMessage({
              id: "77115570:50",
              text: "Ordinary work keeps its processing receipt",
              userId: "77115570",
            }),
            trigger: "direct_message",
          });
        }
        const providerRuntime = runtime.endpoints.get(endpoint.id)!;
        const originalReceipts = [...providerRuntime.reactions];
        expect(originalReceipts).toHaveLength(bound ? 1 : 0);
        await deliverMessage({
          callbacks,
          endpointId: endpoint.id,
          provider: "telegram",
          thread: dm.thread,
          message: makeMessage({
            id: "77115570:51",
            text: command,
            userId: "77115570",
          }),
          trigger: "direct_message",
        });
        await service.processPendingPublications();
        const [delivery] = await db
          .select()
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, endpoint.id),
              like(chatDeliveries.providerEventId, "%77115570:51"),
            ),
          );
        expect(delivery).toMatchObject({
          state: denied ? "filtered" : "processed",
        });
        expect(providerRuntime.reactions).toEqual(originalReceipts);
        await expect(
          db
            .select({ id: chatActions.id })
            .from(chatActions)
            .where(
              and(
                eq(chatActions.deliveryId, delivery.id),
                eq(chatActions.kind, "receipt_reaction"),
              ),
            ),
        ).resolves.toEqual([]);
        expect(wakeup).toHaveBeenCalledTimes(bound ? 1 : 0);
        if (!denied) {
          expect(
            providerRuntime.posts.length + dm.post.mock.calls.length,
          ).toBeGreaterThan(0);
        } else {
          expect(providerRuntime.posts).toEqual([]);
          expect(dm.post).not.toHaveBeenCalled();
        }
      } finally {
        await retirePublicationFixture(service, endpoint.id);
      }
    },
  );

  it.each([
    "ordinary",
    "final_before_add",
    "newer_followup",
    "restart",
    "superseded",
    "remove_retry",
  ] as const)(
    "retires only the exact Telegram final receipt through the pinned adapter (%s)",
    async (mode) => {
      const fixture = await seedCompany();
    // Assigned once before the async checks below; `let` with definite assignment is the TS idiom here.
    // oxlint-disable-next-line prefer-const
      let earlyFinal:
        | ((
            agentId: string,
            opts: Parameters<
              ChatChannelServiceOptions["heartbeat"]["wakeup"]
            >[1],
          ) => Promise<unknown>)
        | undefined;
      const context = await configuredTelegramEndpoint(fixture, {
        scheduleDeferredWork: () => undefined,
        ...(mode === "final_before_add"
          ? { wakeup: async (agentId, opts) => earlyFinal!(agentId, opts) }
          : {}),
      });
      const { callbacks, endpoint, runtime, service, wakeup } = context;
      let activeService = service;
      const pinned = createChatSdkEndpointRuntime({
        ...runtime.configurations.get(endpoint.id)!,
        logger: "silent",
      });
      const adapter = pinned.getProviderAdapter();
      const reactionRequests: Array<Record<string, unknown>> = [];
      let failRemoval = mode === "remove_retry";
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (input, init) => {
          if (!String(input).endsWith("/setMessageReaction"))
            throw new Error("Unexpected Telegram fixture HTTP");
          const body = JSON.parse(String(init?.body)) as Record<
            string,
            unknown
          >;
          reactionRequests.push(body);
          if (
            failRemoval &&
            Array.isArray(body.reaction) &&
            body.reaction.length === 0
          ) {
            failRemoval = false;
            return Response.json(
              {
                ok: false,
                error_code: 429,
                description: "Too Many Requests",
                parameters: { retry_after: 60 },
              },
              { status: 429 },
            );
          }
          return Response.json({ ok: true, result: true });
        });
      const attachPinnedReactions = (providerRuntime: FakeEndpointRuntime) => {
        const thread = providerRuntime.thread.bind(providerRuntime);
        providerRuntime.thread = (id) => {
          const value = thread(id);
          value.adapter.addReaction = (...args) => adapter.addReaction(...args);
          value.adapter.removeReaction = (...args) =>
            adapter.removeReaction(...args);
          return value;
        };
      };
      const originalRuntime = runtime.endpoints.get(endpoint.id)!;
      attachPinnedReactions(originalRuntime);
      const dm = makeThread({
        channelId: "77115569",
        id: "telegram:77115569",
        isDM: true,
        name: "Telegram terminal receipt",
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
            provider: "telegram",
            providerMessageId: "77115569:43",
          }),
        });
        await addSelectedChatFinal({
          agentId: fixture.assignedAgentId,
          body: "TELEGRAM-RECEIPT-FINAL",
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
        expect(reactionRequests).toEqual([]);
        await publishFinal();
        return { runId };
      };
      try {
        await db
          .update(chatEndpoints)
          .set({ status: "active" })
          .where(eq(chatEndpoints.id, endpoint.id));
        await deliverMessage({
          callbacks,
          endpointId: endpoint.id,
          provider: "telegram",
          thread: dm.thread,
          message: makeMessage({
            id: "77115569:43",
            text: "Reply once, then retire this receipt",
            userId: "77115569",
          }),
          trigger: "direct_message",
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
            provider: "telegram",
            thread: dm.thread,
            message: makeMessage({
              id: "77115569:44",
              text: "A separate turn must retain its own receipt",
              userId: "77115569",
            }),
            trigger: "direct_message",
          });
        }
        if (mode === "restart") {
          await service.shutdown();
          const next = createService(
            new FakeChatSdkRuntime(),
            fakeTelegramFetch() as typeof globalThis.fetch,
            { scheduleDeferredWork: () => undefined },
          );
          activeService = next.service;
          next.runtime.initializeHook = async (id) => {
            if (id === endpoint.id)
              attachPinnedReactions(next.runtime.endpoints.get(id)!);
          };
        }
        if (mode === "superseded") {
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
        await activeService.processPendingReceiptReactions(1, removal!.id);
        if (mode === "remove_retry") {
          const [failed] = await readChatActionsById(removal!.id);
          expect(failed).toMatchObject({
            status: "failed",
            result: { retryable: true, attempts: 1 },
          });
          await db
            .update(chatActions)
            .set({
              result: { ...failed.result, retryAt: new Date(0).toISOString() },
            })
            .where(eq(chatActions.id, failed.id));
        }
        await activeService.processPendingReceiptReactions(1, removal!.id);
        await activeService.processPendingReceiptReactions(1, removal!.id);
        const adds = reactionRequests.filter(
          (value) => (value.reaction as unknown[]).length > 0,
        );
        const removals = reactionRequests.filter(
          (value) => (value.reaction as unknown[]).length === 0,
        );
        expect(adds.map((value) => value.message_id)).toEqual(
          mode === "final_before_add"
            ? []
            : mode === "newer_followup"
              ? [43, 44]
              : [43],
        );
        expect(removals).toEqual(
          Array.from(
            {
              length:
                mode === "superseded" ? 0 : mode === "remove_retry" ? 2 : 1,
            },
            () => ({ chat_id: "77115569", message_id: 43, reaction: [] }),
          ),
        );
        const [add] = await readChatActionsByProviderActionId(`receipt_reaction:${delivery.id}`);
        await db
          .update(chatActions)
          .set({
            status: "failed",
            result: { retryable: true, retryAt: new Date(0).toISOString() },
          })
          .where(eq(chatActions.id, add.id));
        await activeService.processPendingReceiptReactions(1, add.id);
        expect(
          reactionRequests.filter(
            (value) => (value.reaction as unknown[]).length > 0,
          ),
        ).toEqual(adds);
        expect(
          [...originalRuntime.posts, ...originalRuntime.edits].filter(
            (entry) => entry.text === "TELEGRAM-RECEIPT-FINAL",
          ),
        ).toHaveLength(1);
        expect(wakeup).toHaveBeenCalledTimes(mode === "newer_followup" ? 2 : 1);
        await expect(
          db
            .select({ status: heartbeatRuns.status })
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, runId)),
        ).resolves.toEqual([{ status: "succeeded" }]);
      } finally {
        fetchSpy.mockRestore();
        await pinned.shutdown();
        await retirePublicationFixture(activeService, endpoint.id);
        if (activeService !== service) await service.shutdown();
      }
    },
  );

  it("defers a rate-limited Telegram receipt reaction for the full provider interval without blocking the inbound turn", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service, wakeup } =
      await configuredTelegramEndpoint(fixture);
    const dm = makeThread({
      channelId: "77115568",
      id: "telegram:77115568",
      isDM: true,
      name: "Telegram receipt retry DM",
    });
    const endpointRuntime = runtime.endpoints.get(endpoint.id);
    if (!endpointRuntime) throw new Error("Expected Telegram runtime");
    endpointRuntime.reactionErrors.push(
      Object.assign(new Error("Telegram flood control"), {
        adapter: "telegram",
        code: "RATE_LIMITED",
        name: "AdapterRateLimitError",
        retryAfter: 60 * 60,
      }),
    );
    const startedAt = Date.now();
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: dm.thread,
      message: makeMessage({
        id: "77115568:42",
        text: "Do the work while the receipt is rate limited",
        userId: "77115568",
      }),
      trigger: "direct_message",
    });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(wakeup).toHaveBeenCalledTimes(1);
    const [reactionAction] = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.kind, "receipt_reaction"),
        ),
      );
    expect(reactionAction).toMatchObject({
      status: "failed",
      result: {
        attempts: 1,
        retryable: true,
        code: "receipt_reaction_retry",
      },
    });
    expect(
      Date.parse(String(reactionAction.result?.retryAt)) - startedAt,
    ).toBeGreaterThanOrEqual(60 * 60 * 1000 - 1_000);

    await db
      .update(chatActions)
      .set({
        result: {
          ...reactionAction.result,
          retryAt: new Date(0).toISOString(),
        },
      })
      .where(eq(chatActions.id, reactionAction.id));
    await service.processPendingDeliveries();
    await expect(
      db
        .select({ status: chatActions.status, result: chatActions.result })
        .from(chatActions)
        .where(eq(chatActions.id, reactionAction.id)),
    ).resolves.toEqual([{ status: "processed", result: { attempts: 2 } }]);
    expect(runtime.endpoints.get(endpoint.id)?.reactions).toContainEqual({
      threadId: dm.thread.id,
      messageId: "77115568:42",
      emoji: "eyes",
    });
  });

  it("honors Telegram flood-control timing and publishes one final message after retry", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredTelegramEndpoint(fixture);
    const dm = makeThread({
      channelId: "77116677",
      id: "telegram:77116677",
      isDM: true,
      name: "Telegram flood-control DM",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: dm.thread,
      message: makeMessage({
        id: "77116677:50",
        text: "Exercise Telegram flood control",
        userId: "77116677",
      }),
      trigger: "direct_message",
    });
    await qualifySetupRoundTrip(service, endpoint.id, "77116677");
    await service.test(endpoint.id);
    const [conversation] = await service.listConversations(endpoint.id);
    if (!conversation)
      throw new Error("Expected Telegram flood-control conversation");
    const comment = await issueService(db).addComment(
      conversation.issueId,
      "Telegram flood-control final",
      { userId: "owner-user" },
      { authorType: "user" },
    );
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected Telegram provider runtime");
    providerRuntime.postError = Object.assign(
      new Error("Telegram flood control"),
      {
        name: "AdapterRateLimitError",
        adapter: "telegram",
        code: "RATE_LIMITED",
        retryAfter: 7,
      },
    );
    const beforeAttempt = Date.now();
    await service.publishComment(endpoint.id, conversation.id, comment.id);
    const [retrying] = await readChatPublicationsByCommentId(comment.id);
    expect(retrying).toMatchObject({ state: "retry", attempts: 1 });
    expect(retrying.nextAttemptAt?.getTime()).toBeGreaterThanOrEqual(
      beforeAttempt + 6_500,
    );
    expect(providerRuntime.posts).toEqual([]);

    await db
      .update(chatPublications)
      .set({ attempts: 4, nextAttemptAt: new Date(0) })
      .where(eq(chatPublications.id, retrying.id));
    await service.processPendingPublications();
    const [stillRetrying] = await readChatPublicationsById(retrying.id);
    expect(stillRetrying).toMatchObject({ state: "retry", attempts: 5 });

    providerRuntime.postError = null;
    await db
      .update(chatPublications)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(chatPublications.id, retrying.id));
    await service.processPendingPublications();
    await expect(
      db
        .select({
          attempts: chatPublications.attempts,
          state: chatPublications.state,
        })
        .from(chatPublications)
        .where(eq(chatPublications.id, retrying.id)),
    ).resolves.toEqual([{ attempts: 6, state: "published" }]);
    expect(providerRuntime.posts).toEqual([
      { threadId: dm.thread.id, text: "Telegram flood-control final" },
    ]);
  });

  it("recovers the same Telegram bot and historical task after token rotation", async () => {
    const fixture = await seedCompany();
    const firstToken = "445500:telegram-rotation-first";
    const replacementToken = "445500:telegram-rotation-replacement";
    const registeredTokens: string[] = [];
    const providerFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const token = url.includes(encodeURIComponent(replacementToken))
        ? replacementToken
        : firstToken;
      if (url.endsWith("/getMe")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              id: 445500,
              username: "maya_rotation_bot",
              first_name: "Maya",
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
        registeredTokens.push(token);
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/setMyCommands")) {
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error("Unexpected Telegram rotation fixture request");
    }) as typeof globalThis.fetch;
    const runtime = new FakeChatSdkRuntime();
    const { service } = createService(runtime, providerFetch);
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "telegram", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await service.configure(
      endpoint.id,
      { action: "configure", credentials: { botToken: firstToken } },
      "owner-user",
    );
    const firstCallbacks = runtime.configurations.get(endpoint.id)?.callbacks;
    if (!firstCallbacks) throw new Error("Expected initial Telegram callbacks");
    const dm = makeThread({
      channelId: "77117788",
      id: "telegram:77117788",
      isDM: true,
      name: "Telegram rotation DM",
    });
    await deliverMessage({
      callbacks: firstCallbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: dm.thread,
      message: makeMessage({
        id: "77117788:60",
        text: "Create the durable task before rotation",
        userId: "77117788",
      }),
      trigger: "direct_message",
    });
    await qualifySetupRoundTrip(service, endpoint.id, "77117788");
    await service.test(endpoint.id);
    const [beforeRotation] = await service.listConversations(endpoint.id);
    if (!beforeRotation)
      throw new Error("Expected pre-rotation Telegram conversation");

    const failureComment = await issueService(db).addComment(
      beforeRotation.issueId,
      "Detect revoked Telegram credentials",
      { userId: "owner-user" },
      { authorType: "user" },
    );
    const activeRuntime = runtime.endpoints.get(endpoint.id);
    if (!activeRuntime) throw new Error("Expected active Telegram runtime");
    activeRuntime.postError = Object.assign(new Error("Unauthorized"), {
      name: "AuthenticationError",
      adapter: "telegram",
      code: "AUTH_FAILED",
    });
    await service.publishComment(
      endpoint.id,
      beforeRotation.id,
      failureComment.id,
    );
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "attention",
      healthMessage: "Provider credentials or permissions need attention",
    });
    expect(runtime.endpoints.has(endpoint.id)).toBe(false);

    const reconnected = await service.configure(
      endpoint.id,
      { action: "reconnect", credentials: { botToken: replacementToken } },
      "owner-user",
    );
    expect(reconnected).toMatchObject({
      status: "verifying",
      botExternalId: "445500",
      botUsername: "maya_rotation_bot",
      setup: { step: "test" },
    });
    expect(registeredTokens).toEqual([firstToken, replacementToken]);
    const replacementCallbacks = runtime.configurations.get(
      endpoint.id,
    )?.callbacks;
    if (!replacementCallbacks)
      throw new Error("Expected replacement Telegram callbacks");
    await deliverMessage({
      callbacks: replacementCallbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: dm.thread,
      message: makeMessage({
        id: "77117788:61",
        text: "Continue the same task after rotation",
        userId: "77117788",
      }),
      trigger: "direct_message",
    });
    await qualifySetupRoundTrip(service, endpoint.id, "77117788");
    await service.test(endpoint.id);

    const [afterRotation] = await service.listConversations(endpoint.id);
    expect(afterRotation).toMatchObject({
      id: beforeRotation.id,
      issueId: beforeRotation.issueId,
      state: "active",
    });
    await expect(
      db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, beforeRotation.issueId)),
    ).resolves.toEqual(
      expect.arrayContaining([
        { body: "Create the durable task before rotation" },
        { body: "Continue the same task after rotation" },
      ]),
    );
    const safeEndpoint = await service.get(endpoint.id);
    expect(safeEndpoint.status).toBe("active");
    expect(JSON.stringify(safeEndpoint)).not.toContain(firstToken);
    expect(JSON.stringify(safeEndpoint)).not.toContain(replacementToken);
  });

  it("settles a shared-endpoint accepted-response backlog without retrying its own locks", async () => {
    const fixture = await seedCompany();
    const configured = await configuredTelegramEndpoint(fixture);
    const contexts = [];
    for (let index = 0; index < 4; index++) {
      contexts.push(await committedChatResponseRecoveryFixture("telegram", "coordinator", false,
        undefined, undefined, true, { fixture, configured, suffix: String(211 + index) }));
    }
    expect(new Set(contexts.map(context => context.issue.id)).size).toBe(4);
    const independent = await committedChatResponseRecoveryFixture("telegram");
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    // Hold one real comment write after authority locks are acquired. Another
    // endpoint must still publish while this endpoint's backlog waits.
    const functionName = `hold_presentation_${randomUUID().replaceAll("-", "")}`;
    const gate = Math.floor(Math.random() * 1_000_000_000);
    let release!: () => void, locked!: () => void;
    let holderPid = 0;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const holder = db.transaction(async tx => {
      const [backend] = await tx.execute(sql`select pg_backend_pid() as pid`);
      holderPid = Number(backend.pid);
      await tx.execute(sql`select pg_advisory_xact_lock(${gate})`); locked(); await hold;
    });
    await acquired;
    const sharedRuns = contexts.map(context => `'${context.runId}'::uuid`).join(",");
    await db.execute(sql.raw(`create function ${functionName}() returns trigger language plpgsql as $$ begin if NEW.created_by_run_id in (${sharedRuns}) then perform pg_advisory_xact_lock(${gate}); end if; return NEW; end $$`));
    await db.execute(sql.raw(`create trigger ${functionName} before insert on issue_comments for each row execute function ${functionName}()`));
    const worker = nativeResponsePresentationWork(db).register(coordinator, () => true);
    try {
      await expect.poll(async () => {
        const [state] = await db.execute(sql`select exists (select 1 from pg_stat_activity
          where datname = current_database() and ${holderPid} = any(pg_blocking_pids(pid))) as blocked`);
        return state.blocked;
      }, { timeout: 10_000 }).toBe(true);
      await expect.poll(async () => (await db.select({ id: issueComments.id }).from(issueComments)
        .where(eq(issueComments.createdByRunId, independent.runId))).length, { timeout: 10_000 }).toBe(1);
      expect(await db.select({ id: issueComments.id }).from(issueComments)
        .where(inArray(issueComments.createdByRunId, contexts.map(context => context.runId)))).toHaveLength(0);
      release(); await holder;
      await worker.ready;
      await expect.poll(() => idleWorkSnapshot().active, { timeout: 10_000 }).toBe(0);
      expect(errors).toEqual([]);
      for (const context of contexts) {
        const comments = await db.select().from(issueComments).where(eq(issueComments.createdByRunId, context.runId));
        expect(comments).toHaveLength(1);
        expect(comments[0].body).toBe(context.result.summary);
        const publications = await readChatPublicationsByCommentId(comments[0].id);
        expect(publications).toHaveLength(1);
        expect(publications[0]).toMatchObject({ companyId: fixture.companyId, endpointId: configured.endpoint.id,
          issueId: context.issue.id, conversationId: context.conversation.id, payload: { text: context.result.summary } });
      }
      expect(await readChatPublicationsByEndpointId(configured.endpoint.id)).toHaveLength(4);
      expect(coordinator.nextWakeAt()).toBeNull();
    } finally {
      release(); await holder;
      worker.stop(); await coordinator.stop();
      await db.execute(sql.raw(`drop trigger ${functionName} on issue_comments`));
      await db.execute(sql.raw(`drop function ${functionName}()`));
      await configured.service.shutdown(); await independent.service.shutdown();
    }
  });

  it.each(["initial", "rescoped"] as const)("settles responses on different endpoints for one principal without retrying its own identity lock: %s", async (mode) => {
    const fixture = await seedCompany();
    const first = await configuredSlackEndpoint(fixture);
    const second = await configuredSlackEndpoint(fixture);
    const contexts = [
      await committedChatResponseRecoveryFixture("slack", "coordinator", false, undefined, undefined, true,
        { fixture, configured: first, suffix: "221" }),
      await committedChatResponseRecoveryFixture("slack", "coordinator", false, undefined, undefined, true,
        { fixture, configured: second, suffix: "222" }),
    ];
    expect(contexts[0].action.principalId).toBeTruthy();
    expect(contexts[0].action.principalId).toBe(contexts[1].action.principalId);
    expect(contexts[0].endpoint.id).not.toBe(contexts[1].endpoint.id);
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const functionName = `hold_identity_${randomUUID().replaceAll("-", "")}`;
    await db.execute(sql.raw(`create function ${functionName}() returns trigger language plpgsql as $$ begin perform pg_sleep(0.1); return NEW; end $$`));
    await db.execute(sql.raw(`create trigger ${functionName} before insert on issue_comments for each row execute function ${functionName}()`));
    const scopedWork = await import("../../services/scoped-deadline-work.js");
    const register = scopedWork.registerScopedDeadlineWork;
    let invalidated = false;
    let invalidationRevision: string | undefined;
    // Assigned once before the async checks below; `let` with definite assignment is the TS idiom here.
    // oxlint-disable-next-line prefer-const
    let invalidateSource: (() => void) | undefined;
    const registration = vi.spyOn(scopedWork, "registerScopedDeadlineWork").mockImplementation((owner, options, canRun) =>
      register(owner, { ...options, load: async (scope, signal) => {
        const entries = await options.load(scope, signal);
        // An authority registration can invalidate discovery while its read is
        // in flight. The real worker retains another pass under its deadline.
        if (mode === "rescoped" && !invalidated) {
          invalidated = true;
          invalidateSource!();
        }
        return entries;
      } }, canRun));
    const worker = nativeResponsePresentationWork(db).register(coordinator, () => true);
    invalidateSource = () => {
      worker.invalidate();
      invalidationRevision = worker.reconciliationSnapshot().revision;
    };
    registration.mockRestore();
    try {
      await worker.ready;
      await expect.poll(() => idleWorkSnapshot().active, { timeout: 10_000 }).toBe(0);
      if (mode === "rescoped") {
        expect(invalidated).toBe(true);
        expect(invalidationRevision).toBeTypeOf("string");
        // Independent admission can finish the rescope before this check.
        // Observe its settled generation rather than an intermediate timer.
        await expect.poll(() => worker.reconciliationSnapshot().reconciled, { timeout: 10_000 }).toBe(true);
        expect(worker.reconciliationSnapshot().revision).not.toBe(invalidationRevision);
      }
      await expect.poll(async () => Promise.all(contexts.map(async context =>
        (await db.select({ id: issueComments.id }).from(issueComments)
          .where(eq(issueComments.createdByRunId, context.runId))).length)), { timeout: 10_000 }).toEqual([1, 1]);
      await expect.poll(() => ({ active: idleWorkSnapshot().active, nextWakeAt: coordinator.nextWakeAt() }),
        { timeout: 10_000 }).toEqual({ active: 0, nextWakeAt: null });
      expect(errors).toEqual([]);
      for (const context of contexts) {
        const comments = await db.select().from(issueComments).where(eq(issueComments.createdByRunId, context.runId));
        expect(comments).toHaveLength(1);
        expect(comments[0].body).toBe(context.result.summary);
        const publications = await readChatPublicationsByCommentId(comments[0].id);
        expect(publications).toHaveLength(1);
        expect(publications[0]).toMatchObject({ companyId: fixture.companyId, endpointId: context.endpoint.id,
          issueId: context.issue.id, conversationId: context.conversation.id, payload: { text: context.result.summary } });
      }
      expect(coordinator.nextWakeAt()).toBeNull();
    } finally {
      worker.stop(); await coordinator.stop();
      await db.execute(sql.raw(`drop trigger ${functionName} on issue_comments`));
      await db.execute(sql.raw(`drop function ${functionName}()`));
      await first.service.shutdown(); await second.service.shutdown();
    }
  });

  it("does not treat an accepted-response endpoint scheduling hint as current authority", async () => {
    const context = await committedChatResponseRecoveryFixture("telegram");
    const work = nativeResponsePresentationWork(db);
    try {
      const [entry] = await work.load({ companyId: context.fixture.companyId });
      expect(entry.endpointId).toBe(context.endpoint.id);
      await db.update(chatEndpoints).set({ status: "paused" }).where(eq(chatEndpoints.id, context.endpoint.id));
      // A stale or forged hint cannot authorize presentation against the real source.
      await expect(work.check({ ...entry, endpointId: randomUUID(), principalId: randomUUID() })).resolves.toBeNull();
      expect(await db.select({ id: issueComments.id }).from(issueComments)
        .where(eq(issueComments.createdByRunId, context.runId))).toHaveLength(0);
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(0);
    } finally { await context.service.shutdown(); }
  });

  it("repairs a committed reply and its recovery notice without reversing row locks", async () => {
    const context = await committedChatResponseRecoveryFixture("telegram");
    const scope = { companyId: context.fixture.companyId, issueId: context.issue.id, runId: context.runId };
    let response: Promise<boolean> | undefined;
    try {
      const [run] = await readHeartbeatRunsById(context.runId);
      await projectCommittedRun({ db, run, coordinator: context.coordinator });
      const notice = await issueRecoveryActionService(db).upsertSourceScoped({
        companyId: scope.companyId, sourceIssueId: scope.issueId, kind: "active_run_watchdog",
        ownerType: "system", cause: "native_workspace_sync_out_failed", fingerprint: scope.runId,
        evidence: { runId: scope.runId }, nextAction: "Retry finalization",
        wakePolicy: { kind: "resume_native_run", runId: scope.runId },
      });
      expect(await pendingNativeRecoveryNotices(db, scope)).toHaveLength(1);
      await db.transaction(async tx => {

        await tx.select().from(nativeRunFinalizations)
          .where(eq(nativeRunFinalizations.runId, scope.runId)).for("update");
        const [backend] = await tx.execute(sql`select pg_backend_pid() as pid`) as unknown as Array<{ pid: number }>;
        response = recoverCommittedNativeChatResponse(db, { ...scope, onlyWhenDue: true });

        void response.catch(() => {});
        await vi.waitFor(async () => {
          const [state] = await db.execute(sql`select exists (
            select 1 from pg_stat_activity where datname = current_database()
              and ${backend.pid} = any(pg_blocking_pids(pid))
          ) as blocked`) as unknown as Array<{ blocked: boolean }>;
          expect(state.blocked).toBe(true);
        });
        await tx.execute(sql`set local lock_timeout = '1s'`);
        await resolveCommittedNativeRecoveryNotices(tx as unknown as Db, scope, true);
      });
      await expect(response).resolves.toBe(true);
      expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, notice.id)))[0])
        .toMatchObject({ status: "resolved", outcome: "restored" });
      const comments = await db.select().from(issueComments).where(eq(issueComments.createdByRunId, scope.runId));
      expect(comments).toHaveLength(1);
      expect(comments[0].body).toBe(context.result.summary);
      expect(await readChatPublicationsByCommentId(comments[0].id)).toHaveLength(1);
      await expect(recoverCommittedNativeChatResponse(db, scope)).resolves.toBe(false);
      expect(await pendingNativeRecoveryNotices(db, scope)).toEqual([]);
    } finally {
      await response?.catch(() => {});
      await context.service.shutdown();
    }
  });

  it.each(["slack", "telegram"] as const)(
    "recovers a committed %s answer once without rerunning or changing review/quarantine evidence",
    async (provider) => {
      const context = await committedChatResponseRecoveryFixture(provider);
      try {
        expect(await Promise.all([context.repair(), context.repair()])).toEqual(
          expect.arrayContaining([true, false]),
        );
        await expect(context.repair()).resolves.toBe(false);
        const comments = await db
          .select()
          .from(issueComments)
          .where(eq(issueComments.createdByRunId, context.runId));
        expect(comments).toHaveLength(1);
        expect(comments[0].body).toBe(context.result.summary);
        const publications = await readChatPublicationsByCommentId(comments[0].id);
        expect(publications).toHaveLength(1);
        expect(publications[0]).toMatchObject({
          state: "pending",
          endpointId: context.endpoint.id,
          conversationId: context.conversation.id,
        });
        const [run] = await readHeartbeatRunsById(context.runId);
        expect(run).toMatchObject({
          status: "succeeded",
          errorCode: null,
          error: null,
          processPid: 987654,
          runnerProfileJson: {
            sessionCheckpoint: { retainedEvidence: "do not alter" },
          },
          resultJson: {
            recoveredExecutionFailure: {
              errorCode: "adapter_failed",
              error: "provider_transport_failed: checkpoint is quarantined",
            },
            nativeCommittedChatResponse: {
              resultId: context.accepted.resultId,
            },
            presentationDecision: { commentId: comments[0].id },
          },
        });
        const [afterIssue] = await readIssuesById(context.issue.id);
        expect(afterIssue).toMatchObject({
          status: context.beforeIssue.status,
          statusVersion: context.beforeIssue.statusVersion,
          lastStatusDecisionId: context.beforeIssue.lastStatusDecisionId,
          executionRunId: context.beforeIssue.executionRunId,
        });
        await context.service.processPendingPublications(100);
        expect(
          JSON.stringify({
            posts: context.providerRuntime.posts,
            edits: context.providerRuntime.edits,
          }),
        ).not.toContain("PRIVATE");
        expect(
          [
            ...context.providerRuntime.posts,
            ...context.providerRuntime.edits,
          ].filter((entry) => entry.text === context.result.summary),
        ).toHaveLength(1);
      } finally {
        await context.service.shutdown();
      }
    },
  );

  it.each([
    "source_edited",
    "source_deleted",
    "principal_revoked",
    "endpoint_paused",
    "generation_changed",
    "digest_changed",
    "private_disposition",
    "missing_authority",
    "cross_company",
    "cross_run",
    "ambiguous_delivery",
    "live_heartbeat",
  ] as const)(
    "does not recover a committed answer after %s",
    async (mutation) => {
      const context = await committedChatResponseRecoveryFixture("slack");
      try {
        if (mutation === "source_edited")
          await db
            .update(issueComments)
            .set({
              body: "Changed request",
              updatedAt: new Date(Date.now() + 1),
            })
            .where(
              eq(issueComments.id, String(context.action.payload.commentId)),
            );
        if (mutation === "source_deleted")
          await db
            .update(issueComments)
            .set({ deletedAt: new Date() })
            .where(
              eq(issueComments.id, String(context.action.payload.commentId)),
            );
        if (mutation === "principal_revoked")
          await db
            .update(chatEndpoints)
            .set({ allowUnlinkedPeople: false })
            .where(eq(chatEndpoints.id, context.endpoint.id));
        if (mutation === "endpoint_paused")
          await db
            .update(chatEndpoints)
            .set({ status: "paused" })
            .where(eq(chatEndpoints.id, context.endpoint.id));
        if (mutation === "generation_changed")
          await db
            .update(chatEndpoints)
            .set({
              setup: sql`jsonb_set(${chatEndpoints.setup}, '{runtimeGeneration}', to_jsonb(coalesce((${chatEndpoints.setup}->>'runtimeGeneration')::int, 0) + 1))`,
            })
            .where(eq(chatEndpoints.id, context.endpoint.id));
        if (mutation === "ambiguous_delivery")
          await db.insert(chatPublications).values({
            companyId: context.fixture.companyId,
            endpointId: context.endpoint.id,
            conversationId: context.conversation.id,
            issueId: context.issue.id,
            idempotencyKey: `run:${context.runId}:working:${context.endpoint.id}`,
            payload: { text: "Maya is working…" },
            state: "delivery_unknown",
          });
        if (mutation === "digest_changed")
          await db
            .update(nativeRunResults)
            .set({ canonicalSha256: "sha256:changed" })
            .where(eq(nativeRunResults.id, context.accepted.resultId));
        if (mutation === "private_disposition")
          await db
            .update(nativeRunResults)
            .set({
              resultJson: {
                result: {
                  ...context.result,
                  reportedWorkDisposition: "needs_review",
                },
                terminal: {},
              },
            })
            .where(eq(nativeRunResults.id, context.accepted.resultId));
        if (mutation === "missing_authority") await context.service.shutdown();
        if (mutation === "live_heartbeat")
          await db
            .update(heartbeatRuns)
            .set({ status: "running", finishedAt: null })
            .where(eq(heartbeatRuns.id, context.runId));
        await expect(
          mutation === "cross_company"
            ? repairCommittedNativeChatResponse(db, {
                companyId: randomUUID(),
                issueId: context.issue.id,
                runId: context.runId,
              })
            : mutation === "cross_run"
              ? repairCommittedNativeChatResponse(db, {
                  companyId: context.fixture.companyId,
                  issueId: context.issue.id,
                  runId: randomUUID(),
                })
              : context.repair(),
        ).resolves.toBe(false);
        await expect(recoverCommittedNativeChatResponse(db, {
          companyId: mutation === "cross_company" ? randomUUID() : context.fixture.companyId,
          issueId: context.issue.id,
          runId: mutation === "cross_run" ? randomUUID() : context.runId,
        })).resolves.toBe(false);
        await expect(
          db
            .select()
            .from(issueComments)
            .where(eq(issueComments.createdByRunId, context.runId)),
        ).resolves.toHaveLength(0);
        await expect(
          readChatPublicationsByEndpointId(context.endpoint.id),
        ).resolves.toHaveLength(mutation === "ambiguous_delivery" ? 1 : 0);
      } finally {
        await context.service.shutdown();
      }
    },
  );

  it("recovers the exact port-bound canonical response before skipping a superseded native decision", async () => {
    const context = await committedChatResponseRecoveryFixture(
      "telegram",
      "port",
    );
    try {
      const [originalRun] = await readHeartbeatRunsById(context.runId);
      const laterId = randomUUID();
      await db.insert(heartbeatRuns).values({
        ...originalRun,
        id: laterId,
        wakeupRequestId: null,
        nativeSessionId: randomUUID(),
        runnerInstanceId: randomUUID(),
        contextSnapshot: {},
        status: "running",
        resultJson: null,
      });
      const laterResult = {
        ...context.result,
        reportedWorkDisposition: "needs_review" as const,
      };
      delete laterResult.continuation;
      await new NativeRunCoordinatorStore(db, {
        ...context.binding,
        runId: laterId,
      }).completeRun({
        result: laterResult,
        terminal: {
          ...context.terminal,
          reportedWorkDisposition: "needs_review",
        },
      });
      await finalizeNativeRun({
        db,
        runId: laterId,
        workspaceFinalizeStatus: "succeeded",
      });
      const [laterIssue] = await readIssuesById(context.issue.id);
      expect(laterIssue.lastStatusDecisionId).not.toBe(
        context.coordinator.decisionId,
      );
      await reconcileNativeFinalizations(db, [context.runId]);
      await reconcileNativeFinalizations(db, [context.runId]);
      const comments = await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.createdByRunId, context.runId));
      expect(comments).toHaveLength(1);
      expect(comments[0].body).toBe(context.result.summary);
      const [after] = await readIssuesById(context.issue.id);
      expect(after).toMatchObject({
        status: laterIssue.status,
        statusVersion: laterIssue.statusVersion,
        lastStatusDecisionId: laterIssue.lastStatusDecisionId,
      });
    } finally {
      await context.service.shutdown();
    }
  });

  it.each([true, false])("keeps recovered GitHub final prose and attachment navigation internal (omission: %s)", async unavailable => {
    const context = await githubOmissionFixture(unavailable);
    try {
      await expect(context.repair()).resolves.toBe(false);
      await context.service.processPendingPublications(100);
      expect(context.providerRuntime.posts).toEqual([]);
      expect(context.providerRuntime.edits).toEqual([]);
      const publications = await db.select().from(chatPublications).where(and(
        eq(chatPublications.endpointId, context.endpoint.id), isNotNull(chatPublications.commentId),
      ));
      expect(publications.every(publication => publication.state === "cancelled")).toBe(true);
      expect(await resolveChatRunPresentationAuthorizationReason(db, {
        companyId: context.fixture.companyId, issueId: context.issue.id, runId: context.runId,
      })).toBe("internal_agent_write");
    } finally {
      await context.cleanup();
    }
  });

  it.each(["slack", "telegram"] as const)(
    "updates only the linked same-run %s failure notice when recovering an accepted response",
    async (provider) => {
      const context = await committedChatResponseRecoveryFixture(provider);
      try {
        const unrelatedRunId = randomUUID();
        for (const [runId, messageId] of [
          [context.runId, "same-run-message"],
          [unrelatedRunId, "later-turn-message"],
        ]) {
          await linkedCommittedResponseFailure(context, runId, messageId);
        }
        await expect(context.repair()).resolves.toBe(true);
        await context.service.processPendingPublications(100);
        expect(context.providerRuntime.posts).toEqual([]);
        expect(context.providerRuntime.edits).toEqual([
          {
            threadId: context.thread.thread.id,
            messageId: "same-run-message",
            text: context.result.summary,
          },
        ]);
        await context.service.processPendingPublications(100);
        expect(context.providerRuntime.edits).toHaveLength(1);
        expect(context.providerRuntime.posts).toEqual([]);
        const [answer] = await db
          .select()
          .from(chatPublications)
          .where(
            and(
              eq(chatPublications.endpointId, context.endpoint.id),
              isNotNull(chatPublications.commentId),
            ),
          );
        expect(answer).toMatchObject({
          state: "published",
          providerMessageId: "same-run-message",
          attempts: 1,
        });
        await expect(
          db
            .select({ publicationId: chatMessageLinks.publicationId })
            .from(chatMessageLinks)
            .where(
              and(
                eq(chatMessageLinks.endpointId, context.endpoint.id),
                eq(chatMessageLinks.providerMessageId, "same-run-message"),
              ),
            ),
        ).resolves.toEqual([{ publicationId: answer.id }]);
        await expect(
          db
            .select({ id: heartbeatRuns.id })
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.nativeIssueId, context.issue.id)),
        ).resolves.toEqual([{ id: context.runId }]);
      } finally {
        await context.service.shutdown();
      }
    },
  );

  it.each([
    "source_edited",
    "principal_revoked",
    "generation_changed",
    "marker_changed",
    "delivery_unknown",
  ] as const)(
    "rechecks a recovered response at provider dispatch after %s",
    async (mutation) => {
      const context = await committedChatResponseRecoveryFixture("slack");
      try {
        const failure = await linkedCommittedResponseFailure(context);
        await expect(context.repair()).resolves.toBe(true);
        if (mutation === "source_edited")
          await db
            .update(issueComments)
            .set({
              updatedAt: new Date(Date.now() + 1),
              body: "Edited original request",
            })
            .where(
              eq(issueComments.id, String(context.action.payload.commentId)),
            );
        if (mutation === "principal_revoked")
          await db
            .update(chatEndpoints)
            .set({ allowUnlinkedPeople: false })
            .where(eq(chatEndpoints.id, context.endpoint.id));
        if (mutation === "generation_changed")
          await db
            .update(chatEndpoints)
            .set({
              setup: sql`jsonb_set(${chatEndpoints.setup}, '{runtimeGeneration}', to_jsonb(coalesce((${chatEndpoints.setup}->>'runtimeGeneration')::int, 0) + 1))`,
            })
            .where(eq(chatEndpoints.id, context.endpoint.id));
        if (mutation === "marker_changed")
          await db
            .update(heartbeatRuns)
            .set({
              resultJson: sql`jsonb_set(${heartbeatRuns.resultJson}, '{nativeCommittedChatResponse,resultId}', to_jsonb(${randomUUID()}::text))`,
            })
            .where(eq(heartbeatRuns.id, context.runId));
        if (mutation === "delivery_unknown")
          await db
            .update(chatPublications)
            .set({ state: "delivery_unknown" })
            .where(eq(chatPublications.id, failure.id));
        await context.service.processPendingPublications(100);
        expect(context.providerRuntime.posts).toEqual([]);
        expect(context.providerRuntime.edits).toEqual([]);
        await expect(
          db
            .select({ state: chatPublications.state })
            .from(chatPublications)
            .where(
              and(
                eq(chatPublications.endpointId, context.endpoint.id),
                isNotNull(chatPublications.commentId),
              ),
            ),
        ).resolves.toEqual([
          { state: mutation === "delivery_unknown" ? "pending" : "cancelled" },
        ]);
        await expect(
          readChatPublicationsById(failure.id),
        ).resolves.toEqual([
          {
            ...failure,
            state:
              mutation === "delivery_unknown"
                ? "delivery_unknown"
                : "published",
          },
        ]);
      } finally {
        await context.service.shutdown();
      }
    },
  );

  it.each([
    "other_run_failure",
    "authored_answer",
    "payload_claim_only",
  ] as const)(
    "does not lend a consumed failure lane to a recovered answer with %s",
    async (mutation) => {
      const context = await committedChatResponseRecoveryFixture("telegram");
      try {
        const failure = await linkedCommittedResponseFailure(context);
        await expect(context.repair()).resolves.toBe(true);
        const [answer] = await db
          .select()
          .from(chatPublications)
          .where(
            and(
              eq(chatPublications.endpointId, context.endpoint.id),
              isNotNull(chatPublications.commentId),
            ),
          );
        let currentLinkPublicationId = failure.id;
        if (mutation === "payload_claim_only") {
          const [run] = await readHeartbeatRunsById(context.runId);
          const callerPayload = {
            ...answer.payload,
            nativeCommittedChatResponse:
              run.resultJson!.nativeCommittedChatResponse,
          };
          await db
            .update(chatPublications)
            .set({ payload: callerPayload })
            .where(eq(chatPublications.id, answer.id));
          await db
            .update(heartbeatRuns)
            .set({
              resultJson: sql`${heartbeatRuns.resultJson} - 'nativeCommittedChatResponse'`,
            })
            .where(eq(heartbeatRuns.id, context.runId));
        } else {
          // The old same-run failure retains its provider ID, but the current
          // outbound link is now owned by a different failure or authored text.
          const [otherComment] =
            mutation === "authored_answer"
              ? await db
                  .insert(issueComments)
                  .values({
                    companyId: context.fixture.companyId,
                    issueId: context.issue.id,
                    authorAgentId: context.fixture.assignedAgentId,
                    body: "An already published answer",
                  })
                  .returning()
              : [];
          const [current] = await db
            .insert(chatPublications)
            .values({
              companyId: context.fixture.companyId,
              endpointId: context.endpoint.id,
              conversationId: context.conversation.id,
              issueId: context.issue.id,
              idempotencyKey: `run:${randomUUID()}:failed:${context.endpoint.id}`,
              ...(otherComment ? { commentId: otherComment.id } : {}),
              payload:
                mutation === "authored_answer"
                  ? { text: "An already published answer" }
                  : { text: "A later run failed", progressState: "failed" },
              state: "published",
              providerMessageId: failure.providerMessageId,
              publishedAt: new Date(),
              attempts: 1,
            })
            .returning();
          currentLinkPublicationId = current.id;
          await db
            .update(chatMessageLinks)
            .set({ publicationId: current.id, commentId: current.commentId })
            .where(
              and(
                eq(chatMessageLinks.endpointId, context.endpoint.id),
                eq(
                  chatMessageLinks.providerMessageId,
                  failure.providerMessageId!,
                ),
              ),
            );
        }
        await context.service.processPendingPublications(100);
        expect(context.providerRuntime.edits).toEqual([]);
        // A denied replacement is not a denied, otherwise-authorized answer.
        expect(context.providerRuntime.posts).toEqual([
          { threadId: context.thread.thread.id, text: context.result.summary },
        ]);
        await expect(
          db
            .select({ publicationId: chatMessageLinks.publicationId })
            .from(chatMessageLinks)
            .where(
              and(
                eq(chatMessageLinks.endpointId, context.endpoint.id),
                eq(
                  chatMessageLinks.providerMessageId,
                  failure.providerMessageId!,
                ),
              ),
            ),
        ).resolves.toEqual([{ publicationId: currentLinkPublicationId }]);
        await context.service.processPendingPublications(100);
        expect(context.providerRuntime.posts).toHaveLength(1);
        expect(context.providerRuntime.edits).toEqual([]);
      } finally {
        await context.service.shutdown();
      }
    },
  );

  it.each(["streaming", "delivery_unknown"] as const)(
    "does not replace a failure while another exact-run authored publication is %s",
    async (state) => {
      const context = await committedChatResponseRecoveryFixture("slack");
      try {
        const failure = await linkedCommittedResponseFailure(context);
        await expect(context.repair()).resolves.toBe(true);
        const [answer] = await db
          .select()
          .from(chatPublications)
          .where(
            and(
              eq(chatPublications.endpointId, context.endpoint.id),
              isNotNull(chatPublications.commentId),
            ),
          );
        // Later-created unresolved output deliberately does not block the
        // normal FIFO head. The replacement check must see it independently.
        const [unresolved] = await db
          .insert(chatPublications)
          .values({
            companyId: context.fixture.companyId,
            endpointId: context.endpoint.id,
            conversationId: context.conversation.id,
            issueId: context.issue.id,
            commentId: answer.commentId,
            idempotencyKey: `uncertain-answer:${randomUUID()}`,
            payload: { text: "Another unresolved authored output" },
            state,
            attempts: 1,
            createdAt: new Date(answer.createdAt.getTime() + 1),
          })
          .returning();
        await context.service.processPendingPublications(100);
        expect(context.providerRuntime.edits).toEqual([]);
        expect(context.providerRuntime.posts).toEqual(
          state === "delivery_unknown"
            ? []
            : [
                {
                  threadId: context.thread.thread.id,
                  text: context.result.summary,
                },
              ],
        );
        await expect(
          readChatPublicationsById(unresolved.id),
        ).resolves.toEqual([unresolved]);
        await expect(
          db
            .select({ publicationId: chatMessageLinks.publicationId })
            .from(chatMessageLinks)
            .where(
              and(
                eq(chatMessageLinks.endpointId, context.endpoint.id),
                eq(
                  chatMessageLinks.providerMessageId,
                  failure.providerMessageId!,
                ),
              ),
            ),
        ).resolves.toEqual([{ publicationId: failure.id }]);
      } finally {
        await context.service.shutdown();
      }
    },
  );

  it("rechecks the recovered failure link after waiting for the provider mutation lane", async () => {
    const context = await committedChatResponseRecoveryFixture("telegram");
    const blockerToken = `recovery-link-owner:${randomUUID()}`;
    let worker: Promise<number> | undefined;
    let restore = () => {};
    const releaseBlocker = () =>
      db
        .delete(chatEndpointLeases)
        .where(
          and(
            eq(chatEndpointLeases.endpointId, context.endpoint.id),
            eq(chatEndpointLeases.leaseKey, "credentials"),
            eq(chatEndpointLeases.token, blockerToken),
          ),
        );
    try {
      const failure = await linkedCommittedResponseFailure(context);
      await expect(context.repair()).resolves.toBe(true);
      await db.insert(chatEndpointLeases).values({
        companyId: context.fixture.companyId,
        endpointId: context.endpoint.id,
        leaseKey: "credentials",
        token: blockerToken,
        expiresAt: new Date(Date.now() + 60_000),
      });
      let attempted = false;
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
              values.endpointId === context.endpoint.id &&
              values.leaseKey === "credentials" &&
              values.token !== blockerToken
            )
              attempted = true;
            return originalValues(values);
          }) as typeof builder.values;
        }
        return builder;
      });
      restore = () => insertSpy.mockRestore();
      worker = context.service.processPendingPublications(100);
      await expect.poll(() => attempted).toBe(true);
      expect(context.providerRuntime.posts).toEqual([]);
      expect(context.providerRuntime.edits).toEqual([]);
      // Simulate the current lease owner's durable publication commit before
      // releasing the endpoint. The earlier same-run row keeps its old ID.
      const [successor] = await db
        .insert(chatPublications)
        .values({
          companyId: context.fixture.companyId,
          endpointId: context.endpoint.id,
          conversationId: context.conversation.id,
          issueId: context.issue.id,
          idempotencyKey: `run:${randomUUID()}:failed:${context.endpoint.id}`,
          payload: {
            text: "A successor's failure must not be rewritten",
            progressState: "failed",
          },
          state: "published",
          providerMessageId: failure.providerMessageId,
          attempts: 1,
          publishedAt: new Date(),
        })
        .returning();
      await db
        .update(chatMessageLinks)
        .set({ publicationId: successor.id })
        .where(
          and(
            eq(chatMessageLinks.endpointId, context.endpoint.id),
            eq(chatMessageLinks.providerMessageId, failure.providerMessageId!),
          ),
        );
      await releaseBlocker();
      await worker;
      expect(context.providerRuntime.edits).toEqual([]);
      expect(context.providerRuntime.posts).toEqual([
        { threadId: context.thread.thread.id, text: context.result.summary },
      ]);
      await expect(
        db
          .select({ publicationId: chatMessageLinks.publicationId })
          .from(chatMessageLinks)
          .where(
            and(
              eq(chatMessageLinks.endpointId, context.endpoint.id),
              eq(
                chatMessageLinks.providerMessageId,
                failure.providerMessageId!,
              ),
            ),
          ),
      ).resolves.toEqual([{ publicationId: successor.id }]);
    } finally {
      await releaseBlocker();
      try {
        await worker;
      } finally {
        restore();
        await context.service.shutdown();
      }
    }
  });

  it.each([false, true])(
    "never replaces or resurrects an already selected answer (deleted=%s)",
    async (deleted) => {
      const context = await committedChatResponseRecoveryFixture("slack");
      try {
        const comment = await issueService(db).addComment(
          context.issue.id,
          "The real provider final answer is already selected.",
          { agentId: context.fixture.assignedAgentId, runId: context.runId },
          { authorizationReason: "internal_agent_write" },
        );
        await db
          .update(heartbeatRuns)
          .set({
            resultJson: { presentationDecision: { commentId: comment.id } },
          })
          .where(eq(heartbeatRuns.id, context.runId));
        if (deleted)
          await db
            .update(issueComments)
            .set({ deletedAt: new Date(), body: "Deleted" })
            .where(eq(issueComments.id, comment.id));
        await expect(context.repair()).resolves.toBe(false);
        await expect(
          db
            .select()
            .from(issueComments)
            .where(eq(issueComments.createdByRunId, context.runId)),
        ).resolves.toHaveLength(1);
        await expect(
          readChatPublicationsByEndpointId(context.endpoint.id),
        ).resolves.toHaveLength(0);
      } finally {
        await context.service.shutdown();
      }
    },
  );

  it.each(["none", "reuse"] as const)("preserves a recorded %s presentation instead of recovering an unsolicited answer", async commentAction => {
    const context = await committedChatResponseRecoveryFixture("telegram");
    const presentationDecision = { commentAction, commentId: null, reasonCodes: ["interaction_owns_response"] };
    try {
      await db.update(heartbeatRuns).set({ resultJson: { presentationDecision } }).where(eq(heartbeatRuns.id, context.runId));
      await expect(recoverCommittedNativeChatResponse(db, { companyId: context.fixture.companyId,
        issueId: context.issue.id, runId: context.runId })).resolves.toBe(false);
      expect(await nativeResponsePresentationWork(db).load({ companyId: context.fixture.companyId, runId: context.runId })).toEqual([]);
      expect(await db.select().from(issueComments).where(eq(issueComments.createdByRunId, context.runId))).toEqual([]);
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toEqual([]);
      expect((await readHeartbeatRunsById(context.runId))[0].resultJson).toEqual({ presentationDecision });
    } finally { await context.service.shutdown(); }
  });

  it.each(["create", "legacy", "missing"] as const)("recovers a genuine unanswered %s presentation", async action => {
    const context = await committedChatResponseRecoveryFixture("telegram");
    try {
      await db.update(heartbeatRuns).set({ resultJson: action === "missing" ? {} : {
        presentationDecision: { commentId: null, ...(action === "create" ? { commentAction: "create" } : {}) },
      } }).where(eq(heartbeatRuns.id, context.runId));
      const work = nativeResponsePresentationWork(db);
      const entries = await work.load({ companyId: context.fixture.companyId, runId: context.runId });
      expect(entries).toHaveLength(1);
      await expect(work.check(entries[0])).resolves.toBeNull();
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(1);
      await expect(context.repair()).resolves.toBe(false);
    } finally { await context.service.shutdown(); }
  });

  it.each(["conversation_done", "attention_request", "same_agent_reason", "monitor_reason", "skip_comment"] as const)(
    "does not lock durably ineligible %s history on repeated issue milestones", async kind => {
      const context = await committedChatResponseRecoveryFixture("telegram");
      await context.service.shutdown();
      await db.update(heartbeatRuns).set({ status: "succeeded",
        ...(kind === "skip_comment" ? { contextSnapshot: { skipIssueComment: true } } : {}) }).where(eq(heartbeatRuns.id, context.runId));
      const [accepted] = await db.select().from(nativeRunResults).where(eq(nativeRunResults.id, context.accepted.resultId));
      const envelope = accepted.resultJson as { result: PrpStructuredRunResult; terminal: PrpTerminalState };
      if (kind === "conversation_done") {
        envelope.result = { ...envelope.result, reportedWorkDisposition: "done" };
        envelope.terminal = { ...envelope.terminal, reportedWorkDisposition: "done" };
        await db.update(issues).set({ conversationAgentId: context.fixture.assignedAgentId, conversationUserId: "owner-user", conversationState: "active", assigneeUserId: null })
          .where(eq(issues.id, context.issue.id));
      } else if (kind === "attention_request") {
        envelope.result = { ...envelope.result, attentionRequests: [{ kind: "review", summary: "Needs a decision", ownerClass: "human" }] };
      } else if (kind === "same_agent_reason" || kind === "monitor_reason") {
        envelope.result = { ...envelope.result, continuation: { ...envelope.result.continuation,
          kind: kind === "same_agent_reason" ? "same_agent" : "monitor" } as PrpStructuredRunResult["continuation"] };
        await db.update(statusDecisions).set({ reasonCode: "external_chat_response_waiting" })
          .where(eq(statusDecisions.id, context.coordinator.decisionId!));
      }
      await db.update(nativeRunResults).set({ resultJson: envelope }).where(eq(nativeRunResults.id, accepted.id));
      const errors: unknown[] = [];
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
      const work = nativeResponsePresentationWork(db);
      const worker = work.register(coordinator, () => true);
      const debug = db.$client.options.debug;
      const locks: string[] = [];
      try {
        await worker.ready;
        await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }), { timeout: 10_000 })
          .toEqual({ active: 0, next: null });
        db.$client.options.debug = (_connection, query) => {
          if (query.startsWith("select") && query.includes("for update") && /"(?:issues|heartbeat_runs|native_run_finalizations)"/.test(query)) locks.push(query);
        };
        for (let i = 0; i < 3; i++) {
          await db.transaction(tx => notifyChatRunMilestones(tx, { companyId: context.fixture.companyId, issueId: context.issue.id }));
          await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }), { timeout: 5000 })
            .toEqual({ active: 0, next: null });
        }
        expect(locks).toEqual([]);
        expect(await work.load({ companyId: context.fixture.companyId, issueId: context.issue.id })).toEqual([]);
        expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toEqual([]);
        expect(errors).toEqual([]);
      } finally { db.$client.options.debug = debug; worker.stop(); await coordinator.stop(); }
    });

  it("leaves fresh-commit accepted-response presentation to the worker when periodic replay skips it", async () => {
    const context = await committedChatResponseRecoveryFixture("telegram", "coordinator", false, undefined, undefined, false);
    try {
      await finalizeNativeRun({ db, runId: context.runId, workspaceFinalizeStatus: "succeeded",
        projectRunStatus: true, skipNativeResponsePresentation: true });
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toEqual([]);
      expect(await db.select().from(issueComments).where(eq(issueComments.createdByRunId, context.runId))).toEqual([]);
      const work = nativeResponsePresentationWork(db);
      const entries = await work.load({ companyId: context.fixture.companyId, runId: context.runId });
      expect(entries).toHaveLength(1);
      await expect(work.check(entries[0])).resolves.toBeNull();
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(1);
    } finally { await context.service.shutdown(); }
  });

  it.each(["reconciler", "finalizer"])("leaves accepted-response presentation to its worker during periodic %s replay", async caller => {
    const context = await committedChatResponseRecoveryFixture("telegram");
    try {
      if (caller === "reconciler") {
        await reconcileNativeFinalizations(db, [context.runId], { skipNativeResponsePresentation: true });
      } else {
        await finalizeNativeRun({ db, runId: context.runId, workspaceFinalizeStatus: "succeeded",
          projectRunStatus: true, skipNativeResponsePresentation: true });
      }
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(0);
      expect(await db.select().from(issueComments).where(eq(issueComments.createdByRunId, context.runId))).toHaveLength(0);
      const work = nativeResponsePresentationWork(db);
      const entries = await work.load({ companyId: context.fixture.companyId, runId: context.runId });
      expect(entries).toHaveLength(1);
      await expect(work.check(entries[0])).resolves.toBeNull();
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(1);
      await expect(context.repair()).resolves.toBe(false);
    } finally { await context.service.shutdown(); }
  });

  it("recovers accepted-response work on startup and leaves selected history quiet", async () => {
    const context = await committedChatResponseRecoveryFixture("telegram");
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const work = nativeResponsePresentationWork(db);
    const worker = work.register(coordinator, () => true);
    try {
      await worker.ready;
      await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }),
        { timeout: 10_000 }).toEqual({ active: 0, next: null });
      const comments = await db.select().from(issueComments).where(eq(issueComments.createdByRunId, context.runId));
      expect(comments).toHaveLength(1);
      expect(comments[0].body).toBe(context.result.summary);
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(1);
      expect(await work.load({ companyId: context.fixture.companyId })).toEqual([]);
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction");
      try {
        await vi.advanceTimersByTimeAsync(120_000);
        expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
      } finally { reads.mockRestore(); writes.mockRestore(); }
      expect(errors).toEqual([]);
    } finally { worker.stop(); await coordinator.stop(); vi.useRealTimers(); await context.service.shutdown(); }
  });

  it("reactivates dormant accepted-response work when the live chat authority registers", async () => {
    const context = await committedChatResponseRecoveryFixture("telegram");
    await context.service.shutdown();
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const worker = nativeResponsePresentationWork(db).register(coordinator, () => true);
    let replacement: ReturnType<typeof createService> | undefined;
    try {
      await worker.ready;
      await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }),
        { timeout: 10_000 }).toEqual({ active: 0, next: null });
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(0);
      replacement = createService(new FakeChatSdkRuntime(), fakeTelegramFetch() as typeof fetch);
      await expect.poll(async () => (await readChatPublicationsByEndpointId(context.endpoint.id)).length, { timeout: 5000 }).toBe(1);
      await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }),
        { timeout: 10_000 }).toEqual({ active: 0, next: null });
      expect(errors).toEqual([]);
    } finally { worker.stop(); await coordinator.stop(); await replacement?.service.shutdown(); }
  });

  it.each(["issue", "run"])("does not reload dormant accepted-response history for an unrelated %s wake", async scope => {
    const context = await committedChatResponseRecoveryFixture("telegram");
    await context.service.shutdown();
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const work = nativeResponsePresentationWork(db);
    const worker = work.register(coordinator, () => true);
    try {
      await worker.ready;
      await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }),
        { timeout: 10_000 }).toEqual({ active: 0, next: null });
      expect(await work.load({ companyId: context.fixture.companyId, runId: context.runId })).toHaveLength(1);
      const previousDebug = db.$client.options.debug;
      const queries: string[] = [];
      db.$client.options.debug = (_connection, query) => {
        if (query.startsWith("select") && query.includes("native_run_finalizations")) queries.push(query);
      };
      try {
        await db.transaction(tx => notifyChatRunMilestones(tx, { companyId: context.fixture.companyId,
          ...(scope === "issue" ? { issueId: randomUUID() } : { runId: randomUUID() }) }));
        await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }),
          { timeout: 5000 }).toEqual({ active: 0, next: null });
        expect(queries).toHaveLength(1);
      } finally { db.$client.options.debug = previousDebug; }
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(0);
      expect(errors).toEqual([]);
    } finally { worker.stop(); await coordinator.stop(); }
  });

  it.each(["milestone", "finalization"] as const)("ignores repeated unscoped routine %s hints without rebuilding dormant accepted-response history", async source => {
    const context = await committedChatResponseRecoveryFixture("telegram");
    await context.service.shutdown();
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const work = nativeResponsePresentationWork(db);
    const worker = work.register(coordinator, () => true);
    try {
      await worker.ready;
      await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }), { timeout: 10_000 })
        .toEqual({ active: 0, next: null });
      expect(await work.load({ companyId: context.fixture.companyId, runId: context.runId })).toHaveLength(1);
      const debug = db.$client.options.debug;
      const queries: string[] = [];
      db.$client.options.debug = (_connection, query) => {
        if (query.startsWith("select") && query.includes("native_run_finalizations")) queries.push(query);
      };
      try {
        for (let i = 0; i < 3; i++) {
          await db.transaction(tx => source === "milestone"
            ? notifyChatRunMilestones(tx, { companyId: context.fixture.companyId })
            : notifyNativeFinalizationWork(tx, { companyId: context.fixture.companyId }));
          await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }), { timeout: 5000 })
            .toEqual({ active: 0, next: null });
        }
        expect(queries).toEqual([]);
      } finally { db.$client.options.debug = debug; }
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(0);
      expect(errors).toEqual([]);
    } finally { worker.stop(); await coordinator.stop(); }
  });

  it("wakes dormant accepted-response history from the real company membership restoration owner", async () => {
    const context = await committedChatResponseRecoveryFixture("telegram");
    const [membership] = await db.select().from(companyMemberships).where(and(
      eq(companyMemberships.companyId, context.fixture.companyId), eq(companyMemberships.principalId, "owner-user")));
    await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.id, membership.id));
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const worker = nativeResponsePresentationWork(db).register(coordinator, () => true);
    try {
      await worker.ready;
      await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }), { timeout: 10_000 })
        .toEqual({ active: 0, next: null });
      expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(0);
      await accessService(db).updateMember(context.fixture.companyId, membership.id, { status: "active" });
      await expect.poll(async () => ({ count: (await readChatPublicationsByEndpointId(context.endpoint.id)).length,
        active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }), { timeout: 5000 })
        .toEqual({ count: 1, active: 0, next: null });
      expect(errors).toEqual([]);
    } finally { worker.stop(); await coordinator.stop(); await context.service.shutdown(); }
  });

  it.each(["commit", "rollback"])("keeps accepted-response work behind the outer %s boundary", async outcome => {
    const context = await committedChatResponseRecoveryFixture("telegram");
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, context.runId));
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const worker = nativeResponsePresentationWork(db).register(coordinator, () => true);
    try {
      await worker.ready;
      await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }),
        { timeout: 10_000 }).toEqual({ active: 0, next: null });
      const transaction = db.transaction(async tx => {
        await tx.transaction(async nested => {
          await notifyChatRunMilestones(nested, { companyId: context.fixture.companyId, issueId: context.issue.id, runId: randomUUID() });
          await nested.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, context.runId));
        });
        expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toHaveLength(0);
        expect(idleWorkSnapshot().active).toBeGreaterThan(0);
        if (outcome === "rollback") throw new Error("response fixture rollback");
      });
      if (outcome === "rollback") await expect(transaction).rejects.toThrow("response fixture rollback");
      else await transaction;
      await expect.poll(async () => ({
        publications: (await readChatPublicationsByEndpointId(context.endpoint.id)).length,
        active: idleWorkSnapshot().active,
        next: coordinator.nextWakeAt(),
      }), { timeout: 5000 }).toEqual({ publications: outcome === "commit" ? 1 : 0, active: 0, next: null });
      expect(errors).toEqual([]);
    } finally { worker.stop(); await coordinator.stop(); await context.service.shutdown(); }
  });
});
