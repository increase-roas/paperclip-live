import { activityLog, agentWakeupRequests, authUsers, chatActions, chatDeliveries, chatEndpoints, chatExternalPrincipals, chatPublications, companyMemberships, issueQuestionResponseDeliveries, issueThreadInteractions, issues, signalDatabaseWork } from "@paperclipai/db";
import { idleWorkSnapshot } from "../../services/task-admission.js";
import type { Db } from "@paperclipai/db";
import { createDeliveryWorkCoordinator } from "../../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../../services/delivery-work-notifications.js";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { issueThreadInteractionService } from "../../services/issue-thread-interactions.js";
import { TELEGRAM_CALLBACK_DATA_LIMIT_BYTES, telegramChatSdkCallbackData } from "../../services/chat-interaction-publications.js";
import { FakeChatSdkRuntime, fakeTelegramFetch, makeMessage, makeThread } from ".././helpers/chat-channels-fixture.js";
import {
configuredSlackEndpoint,
configuredTelegramEndpoint,
createService,
db,
deliverMessage,
describeChatChannelsSuite,
qualifySetupRoundTrip,
readChatActionsById,
readChatConversationsByEndpointId,
readChatPublicationsByIdempotencyKey,
seedCompany
} from "../helpers/chat-channels-harness.js";
import {
telegramConfirmationRecoveryFixture
} from "../helpers/chat-channels-endpoint-fixtures.js";








describeChatChannelsSuite("chat channels 26-uses-compact-single-use-telegram-action", () => {
  it("uses compact single-use Telegram action tokens and filters forged, expired, and oversized callbacks", async () => {
    const fixture = await seedCompany();
    let pauseNextQuestionResolution = false;
    let releaseQuestionResolution!: () => void;
    let signalQuestionResolution!: () => void;
    const questionResolutionEntered = new Promise<void>((resolve) => {
      signalQuestionResolution = resolve;
    });
    const questionResolutionReleased = new Promise<void>((resolve) => {
      releaseQuestionResolution = resolve;
    });
    const { callbacks, endpoint, service } = await configuredTelegramEndpoint(
      fixture,
      {
        questionResolutionPersistBarrier: async () => {
          if (!pauseNextQuestionResolution) return;
          signalQuestionResolution();
          await questionResolutionReleased;
        },
      },
    );
    const externalUserId = "771234567";
    const channel = makeThread({
      channelId: externalUserId,
      id: `telegram:${externalUserId}`,
      isDM: true,
      name: "Maya direct message",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: channel.thread,
      message: makeMessage({
        id: "tg-question-1",
        text: "Help me choose a priority",
        userId: externalUserId,
      }),
      trigger: "direct_message",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id);
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);

    const linkedUserId = `telegram-question-user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({
      id: linkedUserId,
      name: "Telegram Question User",
      email: `${linkedUserId}@example.com`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId: fixture.companyId,
      principalType: "user",
      principalId: linkedUserId,
      status: "active",
      membershipRole: "operator",
    });
    const principal = await db
      .select()
      .from(chatExternalPrincipals)
      .where(eq(chatExternalPrincipals.externalId, externalUserId))
      .then((rows) => rows[0]);
    const intent = await service.createLinkIntent(
      endpoint.id,
      principal.id,
      1_800,
    );
    const identityToken = new URL(intent.confirmationUrl).searchParams.get(
      "token",
    );
    if (!identityToken) throw new Error("Telegram identity token was absent");
    await service.confirmIdentityLink(identityToken, linkedUserId);

    async function publishQuestion(title: string) {
      const interaction = await issueThreadInteractionService(db).create(
        {
          id: conversation.issueId,
          companyId: fixture.companyId,
        },
        {
          kind: "ask_user_questions",
          continuationPolicy: "wake_assignee",
          title,
          payload: {
            version: 1,
            title,
            questions: [
              {
                id: "priority",
                prompt: "Which priority should we use?",
                selectionMode: "single",
                required: true,
                allowOther: false,
                options: [
                  { id: "high", label: "High" },
                  { id: "normal", label: "Normal" },
                ],
              },
            ],
          },
        },
        { agentId: fixture.assignedAgentId },
      );
      // This suite intentionally leaves some retryable fixtures behind. Drain
      // a bounded full-page backlog so this helper does not assume its question
      // is among the global oldest 25. A delivery scheduled by the preceding
      // answer may concurrently claim this exact row, so await its durable
      // published state instead of treating that in-flight claim as failure.
      await service.processPendingPublications(1_000);
      let publication: typeof chatPublications.$inferSelect | undefined;
      await vi.waitFor(async () => {
        publication = await db
          .select()
          .from(chatPublications)
          .where(
            and(
              eq(chatPublications.endpointId, endpoint.id),
              eq(chatPublications.issueId, conversation.issueId),
            ),
          )
          .then((rows) =>
            rows.find((row) => row.payload.interactionId === interaction.id),
          );
        expect(publication).toMatchObject({
          state: "published",
          providerMessageId: expect.any(String),
        });
      });
      if (!publication?.providerMessageId)
        throw new Error("Telegram question publication was not delivered");
      const action = publication.payload.card?.actions?.find(
        (candidate) =>
          candidate.type === "callback" && candidate.label === "High",
      );
      if (!action || action.type !== "callback")
        throw new Error("Telegram callback action was not projected");
      const token = await db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(chatActions.providerActionId, action.actionId),
          ),
        )
        .then((rows) => rows[0]);
      if (!token) throw new Error("Telegram action token was not persisted");
      return { interaction, publication, action, token };
    }

    const first = await publishQuestion("Choose the initial priority");
    const callbackData = telegramChatSdkCallbackData(first.action.actionId);
    expect(Buffer.byteLength(callbackData, "utf8")).toBe(39);
    expect(Buffer.byteLength(callbackData, "utf8")).toBeLessThanOrEqual(
      TELEGRAM_CALLBACK_DATA_LIMIT_BYTES,
    );
    expect(first.token).toMatchObject({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      conversationId: conversation.id,
      principalId: null,
      kind: "question_answer",
      providerActionId: first.action.actionId,
      status: "issued",
      payload: {
        version: 1,
        publicationId: first.publication.id,
        interactionId: first.interaction.id,
        questionId: "priority",
        optionId: "high",
        expiresAt: expect.any(String),
      },
    });

    const actionEvent = (input: {
      actionId: string;
      callbackData: string;
      messageId?: string;
    }) => ({
      endpointId: endpoint.id,
      provider: "telegram" as const,
      event: {
        actionId: input.actionId,
        adapter: {} as never,
        messageId: input.messageId ?? first.publication.providerMessageId!,
        openModal: async () => undefined,
        raw: {
          id: `callback-${randomUUID()}`,
          data: input.callbackData,
          from: { id: Number(externalUserId), first_name: "Telegram User" },
        },
        thread: channel.thread,
        threadId: channel.thread.id,
        user: {
          userId: externalUserId,
          userName: "telegram-user",
          fullName: "Telegram User",
          isBot: false,
          isMe: false,
          isSystem: false,
        },
        value: undefined,
      },
    });

    const forgedActionId = "pcq:AAAAAAAAAAAAAAAAAAAAAA";
    const forgedTelegramAction = actionEvent({
      actionId: forgedActionId,
      callbackData: telegramChatSdkCallbackData(forgedActionId),
    });
    await callbacks.onAction!(forgedTelegramAction);
    // These hand-built events prove action authorization, not authenticated
    // Telegram response provenance. Their denials must not publish a fallback.
    await service.processPendingProviderEffects();
    expect(channel.post).not.toHaveBeenCalled();
    expect(JSON.stringify(channel.post.mock.calls)).not.toContain(
      forgedActionId,
    );
    expect(JSON.stringify(channel.post.mock.calls)).not.toContain(
      telegramChatSdkCallbackData(forgedActionId),
    );
    channel.post.mockClear();
    await callbacks.onAction!(forgedTelegramAction);
    expect(channel.post).not.toHaveBeenCalled();
    const deniedTelegramActions = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(chatDeliveries.eventKind, "action"),
        ),
      );
    expect(deniedTelegramActions).toEqual([
      expect.objectContaining({
        conversationId: null,
        principalId: principal.id,
        state: "filtered",
        attempts: 1,
        redactedError: "External action denied by Paperclip authorization",
        normalizedEvent: {
          providerEventId: expect.stringMatching(
            /^action-denied:[a-f0-9]{64}$/,
          ),
          kind: "action",
          authorization: { outcome: "denied" },
        },
      }),
    ]);
    expect(JSON.stringify(deniedTelegramActions[0])).not.toContain(
      forgedActionId,
    );
    expect(JSON.stringify(deniedTelegramActions[0])).not.toContain(
      telegramChatSdkCallbackData(forgedActionId),
    );
    expect(await service.listActivity(endpoint.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: deniedTelegramActions[0]!.id,
          kind: "delivery",
          status: "filtered",
          summary: "action ignored",
          detail: "External action denied by Paperclip authorization",
          replayable: false,
        }),
      ]),
    );

    const oversizedCallbackData = "x".repeat(
      TELEGRAM_CALLBACK_DATA_LIMIT_BYTES + 1,
    );
    expect(Buffer.byteLength(oversizedCallbackData, "utf8")).toBe(65);
    await callbacks.onAction!(
      actionEvent({
        actionId: first.action.actionId,
        callbackData: oversizedCallbackData,
      }),
    );

    await db
      .update(chatActions)
      .set({ payload: { ...first.token.payload, optionId: "forged-option" } })
      .where(eq(chatActions.id, first.token.id));
    await callbacks.onAction!(
      actionEvent({
        actionId: first.action.actionId,
        callbackData,
      }),
    );
    await db
      .update(chatActions)
      .set({ payload: first.token.payload })
      .where(eq(chatActions.id, first.token.id));

    await callbacks.onAction!(
      actionEvent({
        actionId: first.action.actionId,
        callbackData,
      }),
    );
    const [answered] = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, first.interaction.id));
    expect(answered).toMatchObject({
      status: "answered",
      resolvedByUserId: linkedUserId,
      result: {
        version: 1,
        answers: [{ questionId: "priority", optionIds: ["high"] }],
      },
    });
    await callbacks.onAction!(
      actionEvent({
        actionId: first.action.actionId,
        callbackData,
      }),
    );
    expect(
      await db
        .select()
        .from(issueQuestionResponseDeliveries)
        .where(
          eq(
            issueQuestionResponseDeliveries.interactionId,
            first.interaction.id,
          ),
        ),
    ).toHaveLength(1);
    await service.processPendingProviderEffects();
    expect(channel.post).not.toHaveBeenCalled();
    channel.post.mockClear();

    const authorization = await publishQuestion(
      "Choose a permission-sensitive priority",
    );
    const authorizationCallbackData = telegramChatSdkCallbackData(
      authorization.action.actionId,
    );
    await db
      .update(companyMemberships)
      .set({ membershipRole: "viewer" })
      .where(
        and(
          eq(companyMemberships.companyId, fixture.companyId),
          eq(companyMemberships.principalId, linkedUserId),
        ),
      );
    await callbacks.onAction!(
      actionEvent({
        actionId: authorization.action.actionId,
        callbackData: authorizationCallbackData,
        messageId: authorization.publication.providerMessageId!,
      }),
    );
    await service.processPendingProviderEffects();
    expect(channel.post).not.toHaveBeenCalled();
    await expect(
      db
        .select({ status: chatActions.status })
        .from(chatActions)
        .where(eq(chatActions.id, authorization.token.id)),
    ).resolves.toEqual([{ status: "issued" }]);
    await expect(
      db
        .select({ status: issueThreadInteractions.status })
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, authorization.interaction.id)),
    ).resolves.toEqual([{ status: "pending" }]);
    await db
      .update(companyMemberships)
      .set({ membershipRole: "operator" })
      .where(
        and(
          eq(companyMemberships.companyId, fixture.companyId),
          eq(companyMemberships.principalId, linkedUserId),
        ),
      );
    channel.post.mockClear();

    const authorizationRace = await publishQuestion(
      "Choose a priority while membership changes",
    );
    const authorizationRaceCallbackData = telegramChatSdkCallbackData(
      authorizationRace.action.actionId,
    );
    pauseNextQuestionResolution = true;
    const racedCallback = callbacks.onAction!(
      actionEvent({
        actionId: authorizationRace.action.actionId,
        callbackData: authorizationRaceCallbackData,
        messageId: authorizationRace.publication.providerMessageId!,
      }),
    );
    await questionResolutionEntered;
    await db
      .update(companyMemberships)
      .set({ membershipRole: "viewer", updatedAt: new Date() })
      .where(
        and(
          eq(companyMemberships.companyId, fixture.companyId),
          eq(companyMemberships.principalId, linkedUserId),
        ),
      );
    releaseQuestionResolution();
    await racedCallback;
    await service.processPendingProviderEffects();
    expect(channel.post).not.toHaveBeenCalled();
    await expect(
      db
        .select({ status: issueThreadInteractions.status })
        .from(issueThreadInteractions)
        .where(
          eq(issueThreadInteractions.id, authorizationRace.interaction.id),
        ),
    ).resolves.toEqual([{ status: "pending" }]);
    await expect(
      db
        .select({ status: chatActions.status })
        .from(chatActions)
        .where(eq(chatActions.id, authorizationRace.token.id)),
    ).resolves.toEqual([{ status: "issued" }]);
    await db
      .update(companyMemberships)
      .set({ membershipRole: "operator", updatedAt: new Date() })
      .where(
        and(
          eq(companyMemberships.companyId, fixture.companyId),
          eq(companyMemberships.principalId, linkedUserId),
        ),
      );
    channel.post.mockClear();

    const expired = await publishQuestion("Choose an expired priority");
    await db
      .update(chatActions)
      .set({
        payload: {
          ...expired.token.payload,
          expiresAt: new Date(Date.now() - 1_000).toISOString(),
        },
      })
      .where(eq(chatActions.id, expired.token.id));
    const expiredCallbackData = telegramChatSdkCallbackData(
      expired.action.actionId,
    );
    await callbacks.onAction!(
      actionEvent({
        actionId: expired.action.actionId,
        callbackData: expiredCallbackData,
        messageId: expired.publication.providerMessageId!,
      }),
    );
    await service.processPendingProviderEffects();
    expect(channel.post).not.toHaveBeenCalled();
    expect(JSON.stringify(channel.post.mock.calls)).not.toContain(
      expired.action.actionId,
    );
    expect(JSON.stringify(channel.post.mock.calls)).not.toContain(
      expiredCallbackData,
    );
    const [expiredToken] = await readChatActionsById(expired.token.id);
    expect(expiredToken).toMatchObject({
      status: "expired",
      result: { code: "question_action_token_expired" },
    });
    const [stillPending] = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, expired.interaction.id));
    expect(stillPending.status).toBe("pending");
  });

  it("bounds interaction continuation recovery reads with completed history", async () => {
    const context = await telegramConfirmationRecoveryFixture();
    await expect(context.onAction(context.actionEvent))
      .rejects.toThrow("injected post-interaction confirmation settlement crash");
    const [action] = await db.select().from(chatActions).where(and(
      eq(chatActions.companyId, context.fixture.companyId), eq(chatActions.kind, "interaction_wakeup"),
    ));
    expect(action).toBeDefined();
    await db.update(chatActions).set({ status: "processing", updatedAt: new Date() }).where(eq(chatActions.id, action.id));
    const prefix = `continuation-plan:${randomUUID()}:`;
    await db.execute(sql`
      INSERT INTO chat_actions (company_id, endpoint_id, kind, provider_action_id, status)
      SELECT ${context.fixture.companyId}::uuid, ${context.endpoint.id}::uuid,
        CASE WHEN n <= 10000 THEN 'interaction_wakeup' ELSE 'unrelated_action' END,
        ${prefix} || n,
        CASE WHEN n <= 10000 THEN 'processed' ELSE 'processing' END
      FROM generate_series(1, 20000) AS n
    `);
    await db.execute(sql`VACUUM (ANALYZE) chat_actions`);
    const statements: { sql: string; params: unknown[] }[] = [];
    const select = db.select.bind(db);
    const reads = vi.spyOn(db, "select").mockImplementation((...args) => {
      const selection = select(...args), from = selection.from.bind(selection);
      vi.spyOn(selection, "from").mockImplementation(table => {
        const query = from(table);
        if (table === chatActions) {
          const execute = query.execute.bind(query);
          vi.spyOn(query, "execute").mockImplementation(async () => {
            const statement = query.toSQL();
            if (statement.params.includes("interaction_wakeup") || statement.sql.includes("'interaction_wakeup'")) {
              statements.push(statement);
            }
            return execute();
          });
        }
        return query;
      });
      return selection;
    });
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true,
      canReconcile: () => true, onError: error => errors.push(error) });
    try {
      await context.service.registerInteractionContinuationWork(coordinator, () => true).ready;
      expect(statements.length).toBeGreaterThan(0);
      const startup = statements[0], beforeHint = statements.length;
      await db.transaction(async tx => {
        await signalDatabaseWork(tx, DELIVERY_QUEUES.chatInteractionContinuations,
          JSON.stringify({ companyId: context.fixture.companyId }));
      });
      await vi.waitFor(() => expect(statements.length).toBeGreaterThan(beforeHint), { timeout: 5_000 });
      const scoped = statements.at(-1)!;
      expect(scoped.params).toContain(context.fixture.companyId);
      await coordinator.stop(); reads.mockRestore();
      for (const statement of [startup, scoped]) {
        expect(await db.$client.unsafe(statement.sql, statement.params as Parameters<typeof db.$client.unsafe>[1]))
          .toMatchObject([{ id: action.id }]);
        const result = await db.$client.unsafe(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.sql}`,
          statement.params as Parameters<typeof db.$client.unsafe>[1],
        );
        type PlanNode = { Plans?: PlanNode[]; [key: string]: unknown };
        const nodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodes)];
        const actionReads = nodes(result[0]["QUERY PLAN"][0].Plan)
          .filter(node => node["Relation Name"] === "chat_actions");
        expect(actionReads).toHaveLength(1);
        expect(Number(actionReads[0]["Actual Rows"]) + Number(actionReads[0]["Rows Removed by Filter"] ?? 0),
          JSON.stringify({ params: statement.params, actionReads })).toBeLessThanOrEqual(2);
        expect(Number(actionReads[0]["Shared Hit Blocks"]) + Number(actionReads[0]["Shared Read Blocks"]))
          .toBeLessThan(20);
      }
      await db.update(chatActions).set({ status: "processed" }).where(eq(chatActions.id, action.id));
      await db.execute(sql`ANALYZE chat_actions`);
      expect(await db.$client.unsafe(scoped.sql, scoped.params as Parameters<typeof db.$client.unsafe>[1])).toHaveLength(0);
      const empty = await db.$client.unsafe(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${scoped.sql}`, scoped.params as Parameters<typeof db.$client.unsafe>[1],
      );
      expect(empty[0]["QUERY PLAN"][0].Plan["Shared Hit Blocks"]
        + empty[0]["QUERY PLAN"][0].Plan["Shared Read Blocks"]).toBeLessThan(20);
      expect(errors).toEqual([]);
    } finally {
      await coordinator.stop(); reads.mockRestore();
      await db.delete(chatActions).where(sql`${chatActions.providerActionId} LIKE ${`${prefix}%`}`);
    }
  });

  it.each(["accept", "reject", "drain", "restart", "deferred", "failure", "paused endpoint", "future publication", "stale claim"] as const)("wakes interaction continuations from a committed response through %s", async mode => {
    const context = await telegramConfirmationRecoveryFixture(mode === "reject" ? "reject" : "accept");
    const errors: unknown[] = [];
    let canRun = true;
    let coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => canRun,
      canReconcile: () => true, onError: error => errors.push(error) });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const settle = async () => vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(10);
      expect(idleWorkSnapshot().active).toBe(0); expect(coordinator.nextWakeAt()).toBeNull();
    }, { timeout: 10_000 });
    const quiet = async () => {
      const select = vi.spyOn(db, "select"), transaction = vi.spyOn(db, "transaction");
      try {
        await vi.advanceTimersByTimeAsync(120_000);
        expect(select).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled();
      } finally { select.mockRestore(); transaction.mockRestore(); }
    };
    const originalWake = context.wakeup.getMockImplementation()!;
    context.wakeup.mockImplementation(async (...args) => {
      expect((context.service.runtime as unknown as FakeChatSdkRuntime).endpoints.get(context.endpoint.id)?.edits).toHaveLength(["paused endpoint", "future publication"].includes(mode) ? 0 : 1);
      return originalWake(...args);
    });
    if (mode === "deferred") context.wakeup.mockResolvedValueOnce(null);
    if (mode === "failure") context.wakeup.mockRejectedValueOnce(new Error("temporary continuation admission failure"));
    try {
      await context.service.registerInteractionContinuationWork(coordinator, () => canRun).ready;
      await settle(); await quiet();
      if (["drain", "paused endpoint", "future publication"].includes(mode)) canRun = false;
      if (mode === "restart" || mode === "stale claim") await coordinator.stop();
      await expect(context.onAction(context.actionEvent)).rejects.toThrow("injected post-interaction confirmation settlement crash");
      if (["drain", "paused endpoint", "future publication"].includes(mode) || mode === "restart" || mode === "stale claim") {
        await vi.advanceTimersByTimeAsync(1000);
        await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0));
        expect(context.wakeup).not.toHaveBeenCalled();
        await quiet();
        if (mode === "paused endpoint") await db.update(chatEndpoints).set({ status: "paused" }).where(eq(chatEndpoints.id, context.endpoint.id));
        if (mode === "future publication") await db.update(chatPublications).set({ state: "retry", nextAttemptAt: new Date(Date.now() + 60_000) })
          .where(eq(chatPublications.idempotencyKey, `interaction-resolution:${context.interaction.id}:${context.endpoint.id}`));
        if (mode === "stale claim") await db.update(chatActions).set({ status: "processing", updatedAt: new Date() }).where(and(
          eq(chatActions.companyId, context.fixture.companyId), eq(chatActions.kind, "interaction_wakeup"),
        ));
        canRun = true;
        if (mode === "restart" || mode === "stale claim") {
          coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => canRun,
            canReconcile: () => true, onError: error => errors.push(error) });
          await context.service.registerInteractionContinuationWork(coordinator, () => canRun).ready;
        } else if (coordinator.nextWakeAt() !== null) {
          await vi.advanceTimersByTimeAsync(Math.max(0, coordinator.nextWakeAt()! - Date.now()));
        }
      }
      if (mode === "stale claim") {
        const [action] = await db.select().from(chatActions).where(and(
          eq(chatActions.companyId, context.fixture.companyId), eq(chatActions.kind, "interaction_wakeup"),
        ));
        expect(coordinator.nextWakeAt()).toBe(action.updatedAt.getTime() + 30_000);
        await vi.advanceTimersByTimeAsync(Math.max(0, coordinator.nextWakeAt()! - Date.now() - 1));
        expect(context.wakeup).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
      }
      if (mode === "deferred" || mode === "failure") {
        let retryAt = 0;
        await vi.waitFor(async () => {
          await vi.advanceTimersByTimeAsync(10);
          const [action] = await db.select().from(chatActions).where(and(
            eq(chatActions.companyId, context.fixture.companyId), eq(chatActions.kind, "interaction_wakeup"),
          ));
          expect(action).toMatchObject({ status: "issued", result: { code: mode === "deferred" ? "interaction_wakeup_deferred" : "interaction_wakeup_failed" } });
          retryAt = action.updatedAt.getTime() + 30_000;
          expect(idleWorkSnapshot().active).toBe(0);
          expect(coordinator.nextWakeAt()).toBe(retryAt);
        }, { timeout: 10_000 });
        expect(context.wakeup).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(Math.max(0, retryAt - Date.now() - 1));
        expect(context.wakeup).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
      }
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(10);
        expect(await db.select({ status: chatActions.status }).from(chatActions).where(and(
          eq(chatActions.companyId, context.fixture.companyId), eq(chatActions.kind, "interaction_wakeup"),
        ))).toEqual([{ status: "processed" }]);
      }, { timeout: 10_000 });
      expect(context.wakeup).toHaveBeenCalledTimes(mode === "deferred" || mode === "failure" ? 2 : 1);
      expect(context.wakeup).toHaveBeenCalledWith(context.fixture.assignedAgentId, expect.objectContaining({
        idempotencyKey: `interaction:${context.interaction.id}:${mode === "reject" ? "rejected" : "accepted"}`, allowRunCoalescing: false,
      }));
      await settle(); await quiet();
      expect(errors).toEqual([]);
    } finally { await coordinator.stop(); vi.useRealTimers(); await context.service.shutdown(); }
  });

  it("passes historical continuation prefixes and retains a response committed during dispatch", async () => {
    const first = await telegramConfirmationRecoveryFixture();
    const second = await telegramConfirmationRecoveryFixture();
    await expect(first.onAction(first.actionEvent)).rejects.toThrow("injected post-interaction confirmation settlement crash");
    const invalidIds = Array.from({ length: 101 }, (_, index) => `00000000-0000-4000-8002-${String(index + 1).padStart(12, "0")}`);
    await db.insert(chatActions).values(invalidIds.map(id => ({
      id, companyId: first.fixture.companyId, endpointId: first.endpoint.id,
      kind: "interaction_wakeup", providerActionId: `invalid-continuation:${id}`, status: "issued", payload: {},
    })));
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const originalWake = first.wakeup.getMockImplementation()!;
    first.wakeup.mockImplementationOnce(async (...args) => { await barrier; return originalWake(...args); });
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true,
      canReconcile: () => true, onError: error => errors.push(error) });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const ready = first.service.registerInteractionContinuationWork(coordinator, () => true).ready;
    try {
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(10);
        expect(first.wakeup).toHaveBeenCalledTimes(1);
      }, { timeout: 15_000 });
      await expect(second.onAction(second.actionEvent)).rejects.toThrow("injected post-interaction confirmation settlement crash");
      expect(await db.select({ status: chatActions.status }).from(chatActions).where(and(
        eq(chatActions.companyId, second.fixture.companyId), eq(chatActions.kind, "interaction_wakeup"),
      ))).toEqual([{ status: "issued" }]);
      release(); await ready;
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(10);
        expect(first.wakeup).toHaveBeenCalledTimes(2);
        expect(idleWorkSnapshot().active).toBe(0); expect(coordinator.nextWakeAt()).toBeNull();
      }, { timeout: 15_000 });
      expect(await db.select({ id: chatActions.id }).from(chatActions).where(and(
        inArray(chatActions.id, invalidIds), eq(chatActions.status, "failed"),
        eq(sql<string>`${chatActions.result}->>'code'`, "interaction_wakeup_payload_invalid"),
      ))).toHaveLength(101);
      expect(await db.select({ id: chatActions.id }).from(chatActions).where(and(
        inArray(chatActions.companyId, [first.fixture.companyId, second.fixture.companyId]),
        eq(chatActions.kind, "interaction_wakeup"), eq(chatActions.status, "processed"),
      ))).toHaveLength(2);
      const select = vi.spyOn(db, "select"), transaction = vi.spyOn(db, "transaction");
      try {
        await vi.advanceTimersByTimeAsync(120_000);
        expect(select).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled();
      } finally { select.mockRestore(); transaction.mockRestore(); }
      expect(errors).toEqual([]);
    } finally {
      release(); await ready; await coordinator.stop(); vi.useRealTimers();
      await db.delete(chatActions).where(inArray(chatActions.id, invalidIds));
      await first.service.shutdown(); await second.service.shutdown();
    }
  });

  it.each(["drain", "standby", "shutdown"] as const)("stops starting continuation publications during %s", async mode => {
    const context = await telegramConfirmationRecoveryFixture();
    await expect(context.onAction(context.actionEvent)).rejects.toThrow("injected post-interaction confirmation settlement crash");
    const next = await issueThreadInteractionService(db).create(
      { id: context.conversation.issueId, companyId: context.fixture.companyId },
      { kind: "request_confirmation", continuationPolicy: "wake_assignee", title: "Next decision",
        payload: { version: 1, prompt: "A second decision after the accepted response?" } },
      { agentId: context.fixture.assignedAgentId },
    );
    const nextPublication = () => db.select({ state: chatPublications.state }).from(chatPublications).where(
      eq(chatPublications.idempotencyKey, `interaction:${next.id}:${context.endpoint.id}`));
    expect(await nextPublication()).toEqual([{ state: "pending" }]);
    const provider = (context.service.runtime as unknown as FakeChatSdkRuntime).endpoints.get(context.endpoint.id)!;
    const originalThread = provider.thread.bind(provider);
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const threadSpy = vi.spyOn(provider, "thread").mockImplementation(threadId => {
      const thread = originalThread(threadId), edit = thread.adapter.editMessage.bind(thread.adapter);
      thread.adapter.editMessage = async (...args) => { entered = true; await gate; return edit(...args); };
      return thread;
    });
    let canRun = true;
    const errors: unknown[] = [];
    let coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => canRun,
      canReconcile: () => true, onError: error => errors.push(error) });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const ready = context.service.registerInteractionContinuationWork(coordinator, () => canRun).ready;
    let stopping: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(entered).toBe(true), { timeout: 10_000 });
      if (mode === "shutdown") stopping = coordinator.stop(); else canRun = false;
      release(); await ready; await stopping;
      await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0));
      expect(provider.edits).toHaveLength(1);
      expect(await nextPublication()).toEqual([{ state: "pending" }]);
      expect(context.wakeup).not.toHaveBeenCalled();
      if (mode === "shutdown") {
        coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => canRun,
          canReconcile: () => true, onError: error => errors.push(error) });
        await context.service.registerInteractionContinuationWork(coordinator, () => canRun).ready;
      } else {
        canRun = true;
        await vi.advanceTimersByTimeAsync(Math.max(0, coordinator.nextWakeAt()! - Date.now()));
      }
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(10);
        expect(context.wakeup).toHaveBeenCalledTimes(1);
        expect(await nextPublication()).toEqual([{ state: "published" }]);
        expect(idleWorkSnapshot().active).toBe(0); expect(coordinator.nextWakeAt()).toBeNull();
      }, { timeout: 10_000 });
      expect(errors).toEqual([]);
    } finally {
      release(); await ready; await stopping; await coordinator.stop(); vi.useRealTimers();
      threadSpy.mockRestore(); await context.service.shutdown();
    }
  });

  it("defers continuation dispatch until the outer response transaction commits", async () => {
    const context = await telegramConfirmationRecoveryFixture();
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true,
      canReconcile: () => true, onError: error => errors.push(error) });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const settle = async () => vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(10);
      expect(idleWorkSnapshot().active).toBe(0); expect(coordinator.nextWakeAt()).toBeNull();
    }, { timeout: 10_000 });
    const originalWake = context.wakeup.getMockImplementation()!;
    context.wakeup.mockImplementation(async (...args) => {
      expect((context.service.runtime as unknown as FakeChatSdkRuntime).endpoints.get(context.endpoint.id)?.edits).toHaveLength(1);
      return originalWake(...args);
    });
    try {
      await context.service.registerInteractionContinuationWork(coordinator, () => true).ready;
      await settle();
      const [issue] = await db.select().from(issues).where(eq(issues.id, context.conversation.issueId));
      const accept = async (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => {
        await issueThreadInteractionService(tx as unknown as Db).acceptInteraction(issue, context.interaction.id, {}, { userId: context.linkedUserId });
        await vi.advanceTimersByTimeAsync(100);
        expect(context.wakeup).not.toHaveBeenCalled();
        expect(await db.select({ status: issueThreadInteractions.status }).from(issueThreadInteractions)
          .where(eq(issueThreadInteractions.id, context.interaction.id))).toEqual([{ status: "pending" }]);
        expect(await db.select({ id: chatActions.id }).from(chatActions).where(and(
          eq(chatActions.companyId, context.fixture.companyId), eq(chatActions.kind, "interaction_wakeup"),
        ))).toEqual([]);
      };
      await expect(db.transaction(async tx => {
        await accept(tx);
        throw new Error("rollback outer continuation decision");
      })).rejects.toThrow("rollback outer continuation decision");
      await settle();
      expect(context.wakeup).not.toHaveBeenCalled();
      const select = vi.spyOn(db, "select"), transaction = vi.spyOn(db, "transaction");
      try {
        await vi.advanceTimersByTimeAsync(120_000);
        expect(select).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled();
      } finally { select.mockRestore(); transaction.mockRestore(); }
      await db.transaction(accept);
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(10);
        expect(context.wakeup).toHaveBeenCalledTimes(1);
      });
      await settle();
      expect(await db.select({ status: chatActions.status }).from(chatActions).where(and(
        eq(chatActions.companyId, context.fixture.companyId), eq(chatActions.kind, "interaction_wakeup"),
      ))).toEqual([{ status: "processed" }]);
      expect(errors).toEqual([]);
    } finally { await coordinator.stop(); vi.useRealTimers(); await context.service.shutdown(); }
  });

  it.each(["accept", "reject", "drain", "restart", "failed selection"] as const)("recovers committed terminal confirmations without polling through %s", async mode => {
    const context = await telegramConfirmationRecoveryFixture(mode === "reject" ? "reject" : "accept");
    let canRun = true;
    const errors: unknown[] = [];
    let coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => canRun,
      canReconcile: () => true, onError: error => errors.push(error) });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const settle = async () => vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(10);
      expect(idleWorkSnapshot().active).toBe(0); expect(coordinator.nextWakeAt()).toBeNull();
    }, { timeout: 10_000 });
    const quiet = async () => {
      const select = vi.spyOn(db, "select"), transaction = vi.spyOn(db, "transaction");
      try {
        await vi.advanceTimersByTimeAsync(120_000);
        expect(select).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled();
      } finally { select.mockRestore(); transaction.mockRestore(); }
    };
    try {
      await context.service.registerTerminalConfirmationWork(coordinator, () => canRun).ready;
      await settle(); await quiet();
      if (["drain", "failed selection"].includes(mode)) canRun = false;
      if (mode === "restart") await coordinator.stop();
      await expect(context.onAction(context.actionEvent)).rejects.toThrow("injected post-interaction confirmation settlement crash");
      if (["drain", "failed selection", "restart"].includes(mode)) {
        await vi.advanceTimersByTimeAsync(1000);
        await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0));
        expect(await db.select({ status: chatActions.status }).from(chatActions)
          .where(eq(chatActions.id, context.acceptAction.id))).toEqual([{ status: "processing" }]);
        await quiet();
        if (mode === "failed selection") {
          const select = vi.spyOn(db, "select").mockImplementationOnce(() => { throw new Error("temporary confirmation selection failure"); });
          try {
            canRun = true;
            await vi.advanceTimersByTimeAsync(Math.max(0, coordinator.nextWakeAt()! - Date.now()));
            await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(10); expect(errors).toHaveLength(1); });
            canRun = false;
          } finally { select.mockRestore(); }
          await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0));
          await quiet();
        }
        canRun = true;
        if (coordinator.nextWakeAt() !== null) await vi.advanceTimersByTimeAsync(Math.max(0, coordinator.nextWakeAt()! - Date.now()));
        if (mode === "restart") {
          coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => canRun,
            canReconcile: () => true, onError: error => errors.push(error) });
          await context.service.registerTerminalConfirmationWork(coordinator, () => canRun).ready;
        }
      }
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(10);
        expect(await db.select({ status: chatActions.status }).from(chatActions)
          .where(eq(chatActions.id, context.acceptAction.id))).toEqual([{ status: "processed" }]);
      }, { timeout: 10_000 });
      await settle(); await quiet();
      expect(await db.select({ id: chatActions.id }).from(chatActions).where(and(
        eq(chatActions.companyId, context.fixture.companyId), eq(chatActions.kind, "interaction_wakeup"),
        eq(sql<string>`${chatActions.payload}->>'interactionId'`, context.interaction.id),
      ))).toHaveLength(1);
      expect(await db.select({ id: activityLog.id }).from(activityLog).where(and(
        eq(activityLog.companyId, context.fixture.companyId),
        eq(sql<string>`${activityLog.details}->>'interactionId'`, context.interaction.id),
        eq(sql<string>`${activityLog.details}->>'source'`, "external_chat"),
      ))).toHaveLength(1);
      expect(errors).toEqual(mode === "failed selection" ? [expect.objectContaining({
        errors: [expect.objectContaining({ message: "temporary confirmation selection failure" })],
      })] : []);
    } finally { await coordinator.stop(); vi.useRealTimers(); await context.service.shutdown(); }
  });

  it("parks pending confirmation history, passes malformed prefixes, and wakes on the outer interaction commit", async () => {
    const waiting = await telegramConfirmationRecoveryFixture();
    const terminal = await telegramConfirmationRecoveryFixture();
    const pendingIds = Array.from({ length: 101 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
    const invalidIds = Array.from({ length: 101 }, (_, index) => `00000000-0000-4000-8001-${String(index + 1).padStart(12, "0")}`);
    await db.insert(chatActions).values([...pendingIds, ...invalidIds].map(id => ({
      ...waiting.acceptAction, id, providerActionId: `confirmation-history:${id}`, status: "processing",
      conversationId: invalidIds.includes(id) ? null : waiting.conversation.id, result: null,
    })));
    await expect(terminal.onAction(terminal.actionEvent)).rejects.toThrow("injected post-interaction confirmation settlement crash");
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true,
      canReconcile: () => true, onError: error => errors.push(error) });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const settle = async () => vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(10);
      expect(idleWorkSnapshot().active).toBe(0); expect(coordinator.nextWakeAt()).toBeNull();
    }, { timeout: 30_000 });
    const quiet = async () => {
      const select = vi.spyOn(db, "select"), transaction = vi.spyOn(db, "transaction");
      try {
        await vi.advanceTimersByTimeAsync(120_000);
        expect(select).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled();
      } finally { select.mockRestore(); transaction.mockRestore(); }
    };
    try {
      await waiting.service.registerTerminalConfirmationWork(coordinator, () => true).ready;
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(10);
        expect(await db.select({ status: chatActions.status }).from(chatActions)
          .where(eq(chatActions.id, terminal.acceptAction.id))).toEqual([{ status: "processed" }]);
      }, { timeout: 10_000 });
      await settle();
      expect(await db.select({ id: chatActions.id }).from(chatActions)
        .where(and(inArray(chatActions.id, pendingIds), eq(chatActions.status, "processing")))).toHaveLength(101);
      expect(await db.select({ id: chatActions.id }).from(chatActions).where(and(
        inArray(chatActions.id, invalidIds), eq(chatActions.status, "failed"),
        eq(sql<string>`${chatActions.result}->>'code'`, "confirmation_action_binding_invalid"),
      ))).toHaveLength(101);
      await quiet();
      const [issue] = await db.select().from(issues).where(eq(issues.id, waiting.conversation.issueId));
      await expect(db.transaction(async tx => {
        await issueThreadInteractionService(tx as unknown as Db).acceptInteraction(issue, waiting.interaction.id, {}, { userId: waiting.linkedUserId });
        expect(await db.select({ status: issueThreadInteractions.status }).from(issueThreadInteractions)
          .where(eq(issueThreadInteractions.id, waiting.interaction.id))).toEqual([{ status: "pending" }]);
        throw new Error("rollback outer confirmation decision");
      })).rejects.toThrow("rollback outer confirmation decision");
      await settle(); await quiet();
      expect(await db.select({ id: chatActions.id }).from(chatActions)
        .where(and(inArray(chatActions.id, pendingIds), eq(chatActions.status, "processing")))).toHaveLength(101);
      await db.transaction(async tx => {
        await issueThreadInteractionService(tx as unknown as Db).acceptInteraction(issue, waiting.interaction.id, {}, { userId: waiting.linkedUserId });
        expect(await db.select({ status: issueThreadInteractions.status }).from(issueThreadInteractions)
          .where(eq(issueThreadInteractions.id, waiting.interaction.id))).toEqual([{ status: "pending" }]);
        expect(await db.select({ id: chatActions.id }).from(chatActions)
          .where(and(inArray(chatActions.id, pendingIds), eq(chatActions.status, "processing")))).toHaveLength(101);
      });
      await settle(); await quiet();
      expect(await db.select({ id: chatActions.id }).from(chatActions)
        .where(and(inArray(chatActions.id, pendingIds), eq(chatActions.status, "processing")))).toHaveLength(0);
      expect(await db.select({ id: chatActions.id }).from(chatActions)
        .where(and(inArray(chatActions.id, pendingIds), eq(chatActions.status, "processed")))).toHaveLength(1);
      expect(await db.select({ id: activityLog.id }).from(activityLog).where(and(
        eq(activityLog.companyId, waiting.fixture.companyId),
        eq(sql<string>`${activityLog.details}->>'interactionId'`, waiting.interaction.id),
        eq(sql<string>`${activityLog.details}->>'source'`, "external_chat"),
      ))).toHaveLength(0);
      expect(errors).toEqual([]);
    } finally {
      await coordinator.stop(); vi.useRealTimers();
      await db.delete(chatActions).where(inArray(chatActions.id, [...pendingIds, ...invalidIds]));
    }
  });

  it("bounds terminal confirmation recovery reads with completed history", async () => {
    const waiting = await telegramConfirmationRecoveryFixture();
    const prefix = `confirmation-plan:${randomUUID()}:`;
    await db.execute(sql`
      INSERT INTO chat_actions (company_id, endpoint_id, kind, provider_action_id, status)
      SELECT ${waiting.fixture.companyId}::uuid, ${waiting.endpoint.id}::uuid,
        CASE WHEN n <= 10000 THEN 'confirmation_response' ELSE 'unrelated_action' END,
        ${prefix} || n,
        CASE WHEN n <= 10000 THEN 'processed' ELSE 'processing' END
      FROM generate_series(1, 20000) AS n
    `);
    await db.update(chatActions).set({ status: "processing", result: null })
      .where(eq(chatActions.id, waiting.acceptAction.id));
    await db.execute(sql`VACUUM (ANALYZE) chat_actions`);
    const statements: { sql: string; params: unknown[] }[] = [];
    const select = db.select.bind(db);
    const reads = vi.spyOn(db, "select").mockImplementation((...args) => {
      const selection = select(...args), from = selection.from.bind(selection);
      vi.spyOn(selection, "from").mockImplementation(table => {
        const query = from(table);
        if (table === chatActions) {
          const execute = query.execute.bind(query);
          vi.spyOn(query, "execute").mockImplementation(async () => {
            const statement = query.toSQL();
            if (statement.sql.includes("'confirmation_response'") && statement.sql.includes("'processing'")) {
              statements.push(statement);
            }
            return execute();
          });
        }
        return query;
      });
      return selection;
    });
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true,
      canReconcile: () => true, onError: error => errors.push(error) });
    try {
      await waiting.service.registerTerminalConfirmationWork(coordinator, () => true).ready;
      await vi.waitFor(() => expect(statements.length).toBeGreaterThan(0));
      const startup = statements[0];
      const beforeHint = statements.length;
      await db.transaction(async tx => {
        await signalDatabaseWork(tx, DELIVERY_QUEUES.chatTerminalConfirmations,
          JSON.stringify({ companyId: waiting.fixture.companyId }));
      });
      await vi.waitFor(() => expect(statements.length).toBeGreaterThan(beforeHint), { timeout: 5_000 });
      const scoped = statements.at(-1)!;
      expect(scoped.params).toContain(waiting.fixture.companyId);
      await coordinator.stop();
      reads.mockRestore();
      for (const statement of [startup, scoped]) {
        expect(await db.$client.unsafe(statement.sql, statement.params as Parameters<typeof db.$client.unsafe>[1]))
          .toMatchObject([{ id: waiting.acceptAction.id }]);
        const result = await db.$client.unsafe(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.sql}`, statement.params as Parameters<typeof db.$client.unsafe>[1],
        );
        const plan = result[0]["QUERY PLAN"][0].Plan;
        type PlanNode = { Plans?: PlanNode[]; [key: string]: unknown };
        const nodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodes)];
        const actionReads = nodes(plan).filter(node => node["Relation Name"] === "chat_actions");
        expect(actionReads).toHaveLength(1);
        expect(Number(actionReads[0]["Actual Rows"]) + Number(actionReads[0]["Rows Removed by Filter"] ?? 0),
          JSON.stringify({ params: statement.params, actionReads }))
          .toBeLessThanOrEqual(2);
        expect(Number(actionReads[0]["Shared Hit Blocks"]) + Number(actionReads[0]["Shared Read Blocks"]))
          .toBeLessThan(20);
      }
      await db.update(chatActions).set({ status: "processed" }).where(eq(chatActions.id, waiting.acceptAction.id));
      await db.execute(sql`ANALYZE chat_actions`);
      expect(await db.$client.unsafe(scoped.sql, scoped.params as Parameters<typeof db.$client.unsafe>[1])).toHaveLength(0);
      const empty = await db.$client.unsafe(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${scoped.sql}`, scoped.params as Parameters<typeof db.$client.unsafe>[1],
      );
      expect(empty[0]["QUERY PLAN"][0].Plan["Shared Hit Blocks"]
        + empty[0]["QUERY PLAN"][0].Plan["Shared Read Blocks"]).toBeLessThan(20);
      expect(errors).toEqual([]);
    } finally {
      await coordinator.stop(); reads.mockRestore();
      await db.delete(chatActions).where(sql`${chatActions.providerActionId} LIKE ${`${prefix}%`}`);
    }
  });

  it("retains a confirmation committed while another settlement is in flight", async () => {
    const first = await telegramConfirmationRecoveryFixture();
    const second = await telegramConfirmationRecoveryFixture();
    await expect(first.onAction(first.actionEvent)).rejects.toThrow("injected post-interaction confirmation settlement crash");
    let locked!: () => void, release!: () => void;
    const lockReady = new Promise<void>(resolve => { locked = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const transaction = db.transaction(async tx => {
      await tx.select({ id: chatActions.id }).from(chatActions).where(eq(chatActions.id, first.acceptAction.id)).for("update");
      locked(); await held;
    });
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true,
      canReconcile: () => true, onError: error => errors.push(error) });
    let ready: Promise<unknown> | undefined;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    try {
      await lockReady;
      ready = first.service.registerTerminalConfirmationWork(coordinator, () => true).ready;
      await vi.waitFor(async () => {
        const blocked = await db.execute(sql`select pid from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
            and query like 'update "chat_actions"%'`);
        expect(blocked.length).toBeGreaterThan(0);
      }, { timeout: 10_000 });
      await expect(second.onAction(second.actionEvent)).rejects.toThrow("injected post-interaction confirmation settlement crash");
      expect(await db.select({ status: chatActions.status }).from(chatActions)
        .where(eq(chatActions.id, second.acceptAction.id))).toEqual([{ status: "processing" }]);
      release(); await transaction; await ready;
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(10);
        expect(await db.select({ status: chatActions.status }).from(chatActions)
          .where(inArray(chatActions.id, [first.acceptAction.id, second.acceptAction.id])))
          .toEqual([{ status: "processed" }, { status: "processed" }]);
        expect(idleWorkSnapshot().active).toBe(0); expect(coordinator.nextWakeAt()).toBeNull();
      }, { timeout: 10_000 });
      const select = vi.spyOn(db, "select"), queryTransaction = vi.spyOn(db, "transaction");
      try {
        await vi.advanceTimersByTimeAsync(120_000);
        expect(select).not.toHaveBeenCalled(); expect(queryTransaction).not.toHaveBeenCalled();
      } finally { select.mockRestore(); queryTransaction.mockRestore(); }
      expect(errors).toEqual([]);
    } finally {
      release(); await transaction; await ready; await coordinator.stop(); vi.useRealTimers();
    }
  });

  it("renders safe Telegram confirmations as opaque one-use buttons and wakes the resolved task", async () => {
    const { fixture, onAction, endpoint, service, wakeup, settlementBarrier, dm, conversation, linkedUserId, principal, interaction, publication, acceptAction, actionEvent } = await telegramConfirmationRecoveryFixture();
    await expect(onAction(actionEvent)).rejects.toThrow(
      "injected post-interaction confirmation settlement crash",
    );
    expect(settlementBarrier).toHaveBeenCalledTimes(1);
    await expect(
      db
        .select({
          status: issueThreadInteractions.status,
          resolvedByUserId: issueThreadInteractions.resolvedByUserId,
        })
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, interaction.id)),
    ).resolves.toEqual([
      { status: "accepted", resolvedByUserId: linkedUserId },
    ]);
    await expect(
      db
        .select({
          decision: sql<string>`${chatActions.payload}->>'decision'`,
          status: chatActions.status,
        })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(chatActions.kind, "confirmation_response"),
          ),
        ),
    ).resolves.toEqual(
      expect.arrayContaining([
        { decision: "accept", status: "processing" },
        { decision: "reject", status: "expired" },
      ]),
    );
    expect(wakeup).not.toHaveBeenCalled();
    const crashWindowPublication = await db
      .select({ state: chatPublications.state })
      .from(chatPublications)
      .where(
        eq(
          chatPublications.idempotencyKey,
          `interaction-resolution:${interaction.id}:${endpoint.id}`,
        ),
      )
      .then((rows) => rows[0]);
    expect(crashWindowPublication).toBeDefined();
    expect(crashWindowPublication?.state).not.toBe("published");
    expect(
      (service.runtime as unknown as FakeChatSdkRuntime).endpoints.get(
        endpoint.id,
      )?.edits,
    ).toHaveLength(0);

    const recoveryRuntime = new FakeChatSdkRuntime();
    const recovery = createService(
      recoveryRuntime,
      fakeTelegramFetch() as typeof globalThis.fetch,
      {
        wakeup: async () => {
          expect(
            recoveryRuntime.endpoints.get(endpoint.id)?.edits,
          ).toHaveLength(1);
          return { accepted: true };
        },
      },
    );
    await recovery.service.processPendingPublications();
    await vi.waitFor(async () => {
      await expect(
        db
          .select({ state: chatPublications.state })
          .from(chatPublications)
          .where(
            and(
              eq(chatPublications.endpointId, endpoint.id),
              eq(
                chatPublications.idempotencyKey,
                `interaction-resolution:${interaction.id}:${endpoint.id}`,
              ),
            ),
          ),
      ).resolves.toEqual([{ state: "published" }]);
    });
    const resolutionPublication = await db
      .select()
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.endpointId, endpoint.id),
          eq(
            chatPublications.idempotencyKey,
            `interaction-resolution:${interaction.id}:${endpoint.id}`,
          ),
        ),
      )
      .then((rows) => rows[0]);
    expect(resolutionPublication).toMatchObject({
      state: "published",
      providerMessageId: publication.providerMessageId,
      payload: {
        interactionId: interaction.id,
        card: {
          kind: "confirmation",
          title: "Proceed with Telegram production qualification?",
          body: "Accepted",
        },
      },
    });
    const providerRuntime = recovery.runtime.endpoints.get(endpoint.id);
    expect(providerRuntime?.edits).toHaveLength(1);
    expect(providerRuntime?.edits[0]).toMatchObject({
      messageId: publication.providerMessageId,
    });
    expect(providerRuntime?.edits[0]?.text).toContain("Accepted");
    expect(providerRuntime?.edits[0]?.text).not.toContain(
      acceptAction.providerActionId,
    );

    await expect(
      db
        .select({
          decision: sql<string>`${chatActions.payload}->>'decision'`,
          status: chatActions.status,
        })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(chatActions.kind, "confirmation_response"),
          ),
        )
        .orderBy(asc(chatActions.createdAt), asc(chatActions.id)),
    ).resolves.toEqual(
      expect.arrayContaining([
        { decision: "accept", status: "processed" },
        { decision: "reject", status: "expired" },
      ]),
    );
    expect(recovery.wakeup).toHaveBeenCalledTimes(1);
    expect(recovery.wakeup).toHaveBeenCalledWith(
      fixture.assignedAgentId,
      expect.objectContaining({
        allowRunCoalescing: false,
        idempotencyKey: `interaction:${interaction.id}:accepted`,
        reason: "issue_commented",
        payload: expect.objectContaining({
          interactionId: interaction.id,
          interactionStatus: "accepted",
        }),
      }),
    );
    await expect(
      db
        .select()
        .from(activityLog)
        .where(
          and(
            eq(activityLog.action, "issue.thread_interaction_accepted"),
            eq(
              sql<string>`${activityLog.details}->>'interactionId'`,
              interaction.id,
            ),
            eq(sql<string>`${activityLog.details}->>'source'`, "external_chat"),
          ),
        ),
    ).resolves.toHaveLength(1);

    const providerPostCountBeforeRedelivery = dm.post.mock.calls.length;
    const providerEffectCountBeforeRedelivery = await db
      .select({ id: chatActions.id })
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.conversationId, conversation.id),
          eq(chatActions.kind, "provider_effect"),
        ),
      )
      .then((rows) => rows.length);
    await onAction(actionEvent);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(dm.post).toHaveBeenCalledTimes(providerPostCountBeforeRedelivery);
    await expect(
      db
        .select({ id: chatActions.id })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(chatActions.conversationId, conversation.id),
            eq(chatActions.kind, "provider_effect"),
          ),
        )
        .then((rows) => rows.length),
    ).resolves.toBe(providerEffectCountBeforeRedelivery);
    await recovery.service.processPendingPublications();
    expect(recovery.wakeup).toHaveBeenCalledTimes(1);

    const confirmationWake = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.kind, "interaction_wakeup"),
        ),
      )
      .then((rows) => rows[0]);
    if (!confirmationWake)
      throw new Error("Expected durable confirmation wake");
    await db
      .update(chatActions)
      .set({ status: "processing", updatedAt: new Date(Date.now() - 60_000) })
      .where(eq(chatActions.id, confirmationWake.id));
    await db.insert(agentWakeupRequests).values({
      companyId: fixture.companyId,
      agentId: fixture.assignedAgentId,
      source: "automation",
      reason: "issue_commented",
      status: "queued",
      idempotencyKey: `interaction:${interaction.id}:accepted`,
    });
    recovery.wakeup.mockClear();
    await recovery.service.processPendingPublications();
    expect(recovery.wakeup).not.toHaveBeenCalled();
    await expect(
      db
        .select({ status: chatActions.status, result: chatActions.result })
        .from(chatActions)
        .where(eq(chatActions.id, confirmationWake.id)),
    ).resolves.toEqual([
      {
        status: "processed",
        result: { code: "interaction_wakeup_already_durable" },
      },
    ]);

    const boardRace = await issueThreadInteractionService(db).create(
      { id: conversation.issueId, companyId: fixture.companyId },
      {
        kind: "request_confirmation",
        continuationPolicy: "wake_assignee",
        payload: {
          version: 1,
          prompt: "Let the board resolve after Telegram claims this action?",
        },
      },
      { agentId: fixture.assignedAgentId },
    );
    await service.processPendingPublications();
    const boardRaceActions = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.kind, "confirmation_response"),
          eq(
            sql<string>`${chatActions.payload}->>'interactionId'`,
            boardRace.id,
          ),
        ),
      );
    const boardRaceAccept = boardRaceActions.find(
      (action) => action.payload.decision === "accept",
    );
    if (!boardRaceAccept)
      throw new Error("Expected board-race Telegram accept action");
    await db
      .update(chatActions)
      .set({
        principalId: principal.id,
        status: "processing",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(chatActions.id, boardRaceAccept.id),
          eq(chatActions.status, "issued"),
        ),
      );
    const boardIssue = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, fixture.companyId),
          eq(issues.id, conversation.issueId),
        ),
      )
      .then((rows) => rows[0]);
    if (!boardIssue) throw new Error("Expected board-race issue");
    await issueThreadInteractionService(db).acceptInteraction(
      boardIssue,
      boardRace.id,
      {},
      { userId: linkedUserId },
    );
    await db.insert(agentWakeupRequests).values({
      companyId: fixture.companyId,
      agentId: fixture.replacementAgentId,
      source: "automation",
      reason: "issue_commented",
      status: "queued",
      idempotencyKey: `interaction:${boardRace.id}:accepted`,
    });
    recovery.wakeup.mockClear();
    await recovery.service.processPendingPublications();
    expect(recovery.wakeup).not.toHaveBeenCalled();
    await expect(
      db
        .select({ status: chatActions.status, result: chatActions.result })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.kind, "interaction_wakeup"),
            eq(
              sql<string>`${chatActions.payload}->>'interactionId'`,
              boardRace.id,
            ),
          ),
        ),
    ).resolves.toEqual([
      {
        status: "processed",
        result: {
          code: "interaction_wakeup_coalesced_after_reassignment",
        },
      },
    ]);
    await expect(
      db
        .select({
          decision: sql<string>`${chatActions.payload}->>'decision'`,
          status: chatActions.status,
        })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(chatActions.kind, "confirmation_response"),
            eq(
              sql<string>`${chatActions.payload}->>'interactionId'`,
              boardRace.id,
            ),
          ),
        ),
    ).resolves.toEqual(
      expect.arrayContaining([
        { decision: "accept", status: "processed" },
        { decision: "reject", status: "expired" },
      ]),
    );
    await expect(
      db
        .select({
          state: chatPublications.state,
          payload: chatPublications.payload,
        })
        .from(chatPublications)
        .where(
          eq(
            chatPublications.idempotencyKey,
            `interaction-resolution:${boardRace.id}:${endpoint.id}`,
          ),
        ),
    ).resolves.toEqual([
      expect.objectContaining({
        state: "published",
        payload: expect.objectContaining({ interactionId: boardRace.id }),
      }),
    ]);
    await expect(
      db
        .select()
        .from(activityLog)
        .where(
          and(
            eq(activityLog.action, "issue.thread_interaction_accepted"),
            eq(
              sql<string>`${activityLog.details}->>'interactionId'`,
              boardRace.id,
            ),
            eq(sql<string>`${activityLog.details}->>'source'`, "external_chat"),
          ),
        ),
    ).resolves.toHaveLength(0);

    const failingWakeup = vi.fn(async () => {
      throw new Error("injected permanent confirmation wake failure");
    });
    const retryingWakeService = createService(
      new FakeChatSdkRuntime(),
      fakeTelegramFetch() as typeof globalThis.fetch,
      { wakeup: failingWakeup },
    );
    // These rows exercise the recovery worker itself. Insert them directly so
    // the original endpoint service's interaction-created subscription cannot
    // race this deliberately failing worker and queue the continuation first.
    const [retryingInteraction] = await db
      .insert(issueThreadInteractions)
      .values({
        companyId: fixture.companyId,
        issueId: conversation.issueId,
        kind: "request_confirmation",
        continuationPolicy: "none",
        createdByAgentId: fixture.assignedAgentId,
        status: "accepted",
        resolvedByUserId: linkedUserId,
        resolvedAt: new Date(),
        payload: {
          version: 1,
          prompt: "Exercise interaction wake retry exhaustion",
        },
      })
      .returning();
    const retryingWakeId = randomUUID();
    await db.insert(chatActions).values({
      id: retryingWakeId,
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      conversationId: conversation.id,
      principalId: principal.id,
      kind: "interaction_wakeup",
      providerActionId: `interaction_wakeup:${randomUUID()}`,
      payload: {
        version: 1,
        interactionId: retryingInteraction.id,
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
        issueId: conversation.issueId,
        agentId: fixture.assignedAgentId,
        sourceCommentId: null,
        sourceRunId: null,
        requestedByUserId: linkedUserId,
      },
      status: "issued",
    });
    try {
      await retryingWakeService.service.processPendingPublications(1_000);
      expect(failingWakeup).toHaveBeenCalledTimes(1);
      await expect(
        db
          .select({ status: chatActions.status, result: chatActions.result })
          .from(chatActions)
          .where(eq(chatActions.id, retryingWakeId)),
      ).resolves.toEqual([
        {
          status: "issued",
          result: { code: "interaction_wakeup_failed", attemptCount: 1 },
        },
      ]);
      await retryingWakeService.service.processPendingPublications(1_000);
      expect(failingWakeup).toHaveBeenCalledTimes(1);
      for (let attempt = 2; attempt <= 5; attempt += 1) {
        await db
          .update(chatActions)
          .set({ updatedAt: new Date(Date.now() - 31_000) })
          .where(eq(chatActions.id, retryingWakeId));
        await retryingWakeService.service.processPendingPublications(1_000);
      }
      expect(failingWakeup).toHaveBeenCalledTimes(5);
      await expect(
        db
          .select({ status: chatActions.status, result: chatActions.result })
          .from(chatActions)
          .where(eq(chatActions.id, retryingWakeId)),
      ).resolves.toEqual([
        {
          status: "issued",
          result: { code: "interaction_wakeup_failed", attemptCount: 5 },
        },
      ]);
      await db
        .update(chatActions)
        .set({ updatedAt: new Date(Date.now() - 31_000) })
        .where(eq(chatActions.id, retryingWakeId));
      await retryingWakeService.service.processPendingPublications(1_000);
      expect(failingWakeup).toHaveBeenCalledTimes(6);
      await expect(
        db
          .select({ status: chatActions.status, result: chatActions.result })
          .from(chatActions)
          .where(eq(chatActions.id, retryingWakeId)),
      ).resolves.toEqual([
        {
          status: "issued",
          result: { code: "interaction_wakeup_failed", attemptCount: 6 },
        },
      ]);
    } finally {
      try {
        await retryingWakeService.service.shutdown();
      } finally {
        // This intentionally retryable synthetic action must not become due
        // during a later test's global drain. Remove only this fixture row;
        // production shutdown must preserve durable retry work.
        await db
          .delete(chatActions)
          .where(
            and(
              eq(chatActions.id, retryingWakeId),
              eq(chatActions.endpointId, endpoint.id),
              eq(chatActions.kind, "interaction_wakeup"),
            ),
          );
      }
    }
    await expect(
      db
        .select({ id: chatActions.id })
        .from(chatActions)
        .where(eq(chatActions.id, retryingWakeId)),
    ).resolves.toEqual([]);

    const [deferredInteraction] = await db
      .insert(issueThreadInteractions)
      .values({
        companyId: fixture.companyId,
        issueId: conversation.issueId,
        kind: "request_confirmation",
        continuationPolicy: "none",
        createdByAgentId: fixture.assignedAgentId,
        status: "accepted",
        resolvedByUserId: linkedUserId,
        resolvedAt: new Date(),
        payload: {
          version: 1,
          prompt: "Exercise a scheduler-deferred interaction wake",
        },
      })
      .returning();
    const deferredWakeId = randomUUID();
    await db.insert(chatActions).values({
      id: deferredWakeId,
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      conversationId: conversation.id,
      principalId: principal.id,
      kind: "interaction_wakeup",
      providerActionId: `interaction_wakeup:${randomUUID()}`,
      payload: {
        version: 1,
        interactionId: deferredInteraction.id,
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
        issueId: conversation.issueId,
        agentId: fixture.assignedAgentId,
        sourceCommentId: null,
        sourceRunId: null,
        requestedByUserId: linkedUserId,
      },
      status: "issued",
    });
    const deferredWakeup = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ accepted: true });
    const deferredWakeService = createService(
      new FakeChatSdkRuntime(),
      fakeTelegramFetch() as typeof globalThis.fetch,
      { wakeup: deferredWakeup },
    );
    await deferredWakeService.service.processPendingPublications();
    expect(deferredWakeup).toHaveBeenCalledTimes(1);
    await expect(
      db
        .select({ status: chatActions.status, result: chatActions.result })
        .from(chatActions)
        .where(eq(chatActions.id, deferredWakeId)),
    ).resolves.toEqual([
      {
        status: "issued",
        result: { code: "interaction_wakeup_deferred" },
      },
    ]);
    await deferredWakeService.service.processPendingPublications();
    expect(deferredWakeup).toHaveBeenCalledTimes(1);
    await db
      .update(chatActions)
      .set({ updatedAt: new Date(Date.now() - 31_000) })
      .where(eq(chatActions.id, deferredWakeId));
    await deferredWakeService.service.processPendingPublications();
    expect(deferredWakeup).toHaveBeenCalledTimes(2);
    await expect(
      db
        .select({ status: chatActions.status, result: chatActions.result })
        .from(chatActions)
        .where(eq(chatActions.id, deferredWakeId)),
    ).resolves.toEqual([
      {
        status: "processed",
        result: { code: "interaction_wakeup_queued" },
      },
    ]);
    await deferredWakeService.service.shutdown();

    const governed = await issueThreadInteractionService(db).create(
      { id: conversation.issueId, companyId: fixture.companyId },
      {
        kind: "request_confirmation",
        continuationPolicy: "wake_assignee",
        payload: {
          version: 1,
          prompt: "Explain why this should be rejected",
          rejectRequiresReason: true,
        },
      },
      { agentId: fixture.assignedAgentId },
    );
    await service.processPendingPublications();
    const guardedPublication = await readChatPublicationsByIdempotencyKey(`interaction:${governed.id}:${endpoint.id}`)
      .then((rows) => rows[0]);
    expect(
      guardedPublication.payload.card?.actions?.some(
        (action) => action.type === "callback",
      ) ?? false,
    ).toBe(false);
    expect(
      await db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.kind, "confirmation_response"),
            eq(
              sql<string>`${chatActions.payload}->>'interactionId'`,
              governed.id,
            ),
          ),
        ),
    ).toHaveLength(0);
  });

  it("publishes complex question sets as non-executable Paperclip fallbacks", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service } =
      await configuredSlackEndpoint(fixture);
    const channel = makeThread({
      channelId: "C-COMPLEX-QUESTION",
      id: "slack:C-COMPLEX-QUESTION:4550.1",
      name: "complex-questions",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: channel.thread,
      message: makeMessage({
        id: "4550.1",
        text: "@maya ask for several inputs",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id);
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    const interaction = await issueThreadInteractionService(db).create(
      { id: conversation.issueId, companyId: fixture.companyId },
      {
        kind: "ask_user_questions",
        payload: {
          version: 1,
          questions: [
            {
              id: "regions",
              prompt: "Which regions?",
              selectionMode: "multi",
              required: true,
              allowOther: false,
              options: [
                { id: "us", label: "US" },
                { id: "eu", label: "EU" },
              ],
            },
            {
              id: "notes",
              prompt: "Any constraints?",
              selectionMode: "single",
              required: false,
              allowOther: true,
              options: [
                { id: "other", label: "Describe them", freeText: true },
              ],
            },
          ],
        },
      },
      { agentId: fixture.assignedAgentId },
    );
    const publications = await db
      .select()
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.endpointId, endpoint.id),
          eq(chatPublications.issueId, conversation.issueId),
        ),
      );
    const publication = publications.find(
      (candidate) => candidate.payload.interactionId === interaction.id,
    );
    expect(publication).toBeDefined();
    if (!publication) throw new Error("Expected interaction publication");
    expect(publication.payload).toMatchObject({
      interactionId: interaction.id,
    });
    expect(
      publication.payload.card?.actions?.filter(
        (action) => action.type === "callback",
      ) ?? [],
    ).toEqual([]);
    expect(publication.payload.text).toContain(
      "Open the task in Paperclip to respond",
    );
    expect(callbacks.onModalSubmit).toBeTypeOf("function");
    expect(callbacks.onModalClose).toBeUndefined();
    expect(callbacks.onReaction).toBeTypeOf("function");
  });
});
