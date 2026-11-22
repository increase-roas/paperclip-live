import {
  createHash,
  createHmac,
  randomUUID,
} from "node:crypto";
import {
  and,
  asc,
  eq,
  sql,
} from "drizzle-orm";
import {
  expect,
  it,
  vi,
} from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  chatActions,
  chatConversations,
  chatDeliveries,
  chatEndpointResources,
  chatEndpoints,
  chatExternalPrincipals,
  chatPublications,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  unadmittedChatWakeupCondition,
} from "../../services/durable-chat-wakeup.js";
import {
  type ChatWebhookDiagnosticEvent,
} from "../../services/chat-webhook-diagnostics.js";
import {
  chatChannelService,
} from "../../services/chat-channels.js";
import {
  issueService,
} from "../../services/issues.js";
import {
  issueThreadInteractionService,
} from "../../services/issue-thread-interactions.js";
import {
  enqueueChatRunMilestones,
} from "../../services/chat-run-publications.js";
import {
  FakeChatSdkRuntime,
  fakeSlackFetch,
  makeMessage,
  makeThread,
  webhookApp,
} from ".././helpers/chat-channels-fixture.js";
import {
  addSelectedChatFinal,
  chatWakeContext,
  configuredSlackEndpoint,
  createService,
  db,
  deliverLegacyGitHubReceipt,
  deliverMessage,
  describeChatChannelsSuite,
  qualifySetupRoundTrip,
  readChatActionsByProviderActionId,
  readChatConversationsByEndpointId,
  readChatDeliveriesByEndpointId,
  readHeartbeatRunsByCompanyId,
  readIssueCommentsByCompanyId,
  readIssueCommentsByIssueId,
  readIssuesByCompanyId,
  readToolConnectionsById,
  receiptBackedWakeup,
  recordSlackUrlVerification,
  registeredIdleProbeState,
  retirePublicationFixture,
  seedCompany,
  configuredGitHubEndpoint,
} from "../helpers/chat-channels-harness.js";
import request, {  } from "supertest";

describeChatChannelsSuite("chat channels 16-settles-rejected-pre-acceptance-intent-a", () => {
  it("settles rejected pre-acceptance intent and permits a later authorized external message", async () => {
    const fixture = await seedCompany();
    const { service, callbacks, endpoint, wakeup } =
      await configuredSlackEndpoint(fixture);
    const thread = makeThread({
      channelId: "C-ACCEPT-REVOKE",
      id: "slack:C-ACCEPT-REVOKE:9500.1",
    });
    thread.subscribe.mockImplementationOnce(async () => {
      await db
        .update(chatEndpointResources)
        .set({ enabled: false })
        .where(eq(chatEndpointResources.endpointId, endpoint.id));
    });
    await expect(
      deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        thread: thread.thread,
        message: makeMessage({
          id: "9500.1",
          text: "@maya first message",
          mentioned: true,
        }),
        trigger: "mention",
      }),
    ).rejects.toThrow("no longer authorized");
    const [first] = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.kind, "inbound_wakeup"),
        ),
      );
    expect(first).toMatchObject({
      status: "failed",
      result: { code: "inbound_wakeup_delivery_rejected" },
    });
    expect(wakeup).not.toHaveBeenCalled();
    const heldIssues = () =>
      db
        .select({ id: issues.id })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, fixture.companyId),
            unadmittedChatWakeupCondition(issues.id, issues.companyId),
          ),
        );
    expect(await heldIssues()).toHaveLength(1);
    await db
      .update(chatEndpointResources)
      .set({ enabled: true })
      .where(eq(chatEndpointResources.endpointId, endpoint.id));
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: thread.thread,
      message: makeMessage({
        id: "9500.2",
        text: "@maya new authorized request",
        mentioned: true,
      }),
      trigger: "mention",
    });
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(await heldIssues()).toEqual([]);
    // A later execution failure does not erase historical authorization.
    await db
      .update(agentWakeupRequests)
      .set({ status: "failed" })
      .where(eq(agentWakeupRequests.companyId, fixture.companyId));
    expect(await heldIssues()).toEqual([]);
    await service.shutdown();
  });

  it("ignores signed Slack callbacks from a different workspace before SDK dispatch", async () => {
    const fixture = await seedCompany();
    const runtime = new FakeChatSdkRuntime();
    const { service } = createService(
      runtime,
      fakeSlackFetch("U-BOT-WORKSPACE-SCOPE") as typeof globalThis.fetch,
    );
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "slack", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    const signingSecret = "workspace-scope-signing-secret";
    await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          botToken: "xoxb-workspace-scope",
          signingSecret,
        },
      },
      "owner-user",
    );
    const endpointRuntime = runtime.endpoints.get(endpoint.id)!;
    expect(endpointRuntime).toBeDefined();

    const signedRequest = (body: string, contentType: string) => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
      return new Request(
        `https://paperclip.example/api/chat-webhooks/${endpoint.publicId}/slack`,
        {
          method: "POST",
          headers: {
            "content-type": contentType,
            "x-slack-request-timestamp": timestamp,
            "x-slack-signature": signature,
          },
          body,
        },
      );
    };
    const formBody = (values: Record<string, string>) =>
      new URLSearchParams(values).toString();
    const cases = [
      {
        name: "Events API JSON",
        contentType: "application/json",
        foreignBody: JSON.stringify({
          type: "event_callback",
          team_id: "T-FOREIGN",
          event: { type: "app_mention" },
        }),
        localBody: JSON.stringify({
          type: "event_callback",
          team_id: "T-PAPERCLIP",
          enterprise_id: "E-PAPERCLIP",
          event: { type: "app_mention" },
        }),
      },
      {
        name: "interactive form payload",
        contentType: "application/x-www-form-urlencoded",
        foreignBody: formBody({
          payload: JSON.stringify({
            type: "block_actions",
            team: { id: "T-FOREIGN" },
          }),
        }),
        localBody: formBody({
          payload: JSON.stringify({
            type: "block_actions",
            team: { id: "T-PAPERCLIP" },
          }),
        }),
      },
      {
        name: "slash command",
        contentType: "application/x-www-form-urlencoded",
        foreignBody: formBody({
          team_id: "T-FOREIGN",
          command: "/maya",
          text: "status",
        }),
        localBody: formBody({
          team_id: "T-PAPERCLIP",
          command: "/maya",
          text: "status",
        }),
      },
      {
        name: "enterprise-scoped callback",
        contentType: "application/json",
        foreignBody: JSON.stringify({
          type: "event_callback",
          enterprise_id: "E-FOREIGN",
          event: { type: "app_mention" },
        }),
        localBody: JSON.stringify({
          type: "event_callback",
          enterprise_id: "T-PAPERCLIP",
          event: { type: "app_mention" },
        }),
      },
    ];

    for (const testCase of cases) {
      endpointRuntime.webhookRequest = null;
      const ignored = await service.handleWebhook(
        endpoint.publicId,
        "slack",
        signedRequest(testCase.foreignBody, testCase.contentType),
      );
      expect(ignored.status, testCase.name).toBe(200);
      await expect(ignored.text()).resolves.toBe("ignored");
      expect(endpointRuntime.webhookRequest, testCase.name).toBeNull();

      const accepted = await service.handleWebhook(
        endpoint.publicId,
        "slack",
        signedRequest(testCase.localBody, testCase.contentType),
      );
      expect(accepted.status, testCase.name).toBe(202);
      expect(endpointRuntime.webhookRequest, testCase.name).not.toBeNull();
    }

    // Scope inspection is not a substitute for the adapter's signature gate.
    // An invalid request must continue to the SDK so it receives the normal
    // authentication failure instead of Paperclip acknowledging it as foreign.
    endpointRuntime.webhookRequest = null;
    const forgedForeign = signedRequest(
      cases[0]!.foreignBody,
      cases[0]!.contentType,
    );
    forgedForeign.headers.set("x-slack-signature", "v0=forged");
    const forgedResponse = await service.handleWebhook(
      endpoint.publicId,
      "slack",
      forgedForeign,
    );
    expect(forgedResponse.status).toBe(202);
    expect(endpointRuntime.webhookRequest).not.toBeNull();

    await service.shutdown();
  });

  it("returns a retryable webhook failure when the delivery insert fails before durable receipt", async () => {
    const fixture = await seedCompany();
    const service = chatChannelService(db, {
      deferWebhookProcessing: true,
      fetch: fakeSlackFetch("U-BOT-DURABILITY") as typeof globalThis.fetch,
      heartbeat: {
        wakeup: receiptBackedWakeup(vi.fn(async () => ({ accepted: true }))),
      },
      publicBaseUrl: "https://paperclip.example",
    });
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "slack", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await service.update(endpoint.id, { allowUnlinkedPeople: true }, "owner-user");
    const signingSecret = "durable-ingress-signing-secret";
    await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          botToken: "xoxb-durable-ingress",
          signingSecret,
        },
      },
      "owner-user",
    );

    const body = JSON.stringify({
      type: "event_callback",
      event_id: `Ev-${randomUUID()}`,
      event_time: Math.floor(Date.now() / 1000),
      team_id: "T-PAPERCLIP",
      event: {
        type: "app_mention",
        user: "U-EXTERNAL",
        username: "alex",
        text: "@maya prove durable receipt",
        ts: "9200.1",
        channel: "C-DURABILITY",
        channel_type: "channel",
        team: "T-PAPERCLIP",
      },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
    const providerRequest = (retry = false) =>
      new Request(
        `https://paperclip.example/api/chat-webhooks/${endpoint.publicId}/slack`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-slack-request-timestamp": timestamp,
            "x-slack-signature": signature,
            ...(retry ? { "x-slack-retry-num": "1" } : {}),
          },
          body,
        },
      );

    const timingEvents: ChatWebhookDiagnosticEvent[] = [];
    const observedApp = webhookApp(service, (event) =>
      timingEvents.push(event),
    );
    const observedRequest = (retry = false, signatureOverride?: string) =>
      request(observedApp)
        .post(`/api/chat-webhooks/${endpoint.publicId}/slack`)
        .set(Object.fromEntries(providerRequest(retry).headers))
        .set("x-slack-signature", signatureOverride ?? signature)
        .send(body);
    const forged = await observedRequest(false, "v0=forged");
    expect(forged.status).toBe(401);
    expect(
      timingEvents.some((event) => event.stage === "durable_receipt"),
    ).toBe(false);
    expect(timingEvents.at(-1)?.statusCode).toBe(401);
    expect(
      await readChatDeliveriesByEndpointId(endpoint.id),
    ).toHaveLength(0);

    const originalTransaction = db.transaction.bind(db);
    let injectedAdmissionFailure = false;
    const transactionSpy = vi
      .spyOn(db, "transaction")
      .mockImplementation((async (
        ...args: Parameters<typeof originalTransaction>
      ) => {
        const [callback, config] = args;
        return originalTransaction(async (tx) => {
          const result = await callback(tx);
          if (!injectedAdmissionFailure) {
            const [uncommittedReceipt] = await tx
              .select({ id: chatDeliveries.id })
              .from(chatDeliveries)
              .where(
                and(
                  eq(chatDeliveries.companyId, fixture.companyId),
                  eq(chatDeliveries.endpointId, endpoint.id),
                  sql`${chatDeliveries.normalizedEvent}->'message'->>'providerMessageId' = '9200.1'`,
                ),
              );
            if (uncommittedReceipt) {
              // Only the receipt transaction can see its uncommitted insert.
              // Fail before commit/ack, leaving unrelated transactions intact.
              injectedAdmissionFailure = true;
              throw new Error("injected durable admission failure");
            }
          }
          return result;
        }, config);
      }) as typeof db.transaction);

    try {
      // A Gateway ownership renewal or another endpoint's work may transact
      // before this receipt. It must not consume this endpoint's insert fault.
      await expect(
        db.transaction(async (tx) =>
          tx
            .select({ id: chatEndpoints.id })
            .from(chatEndpoints)
            .where(eq(chatEndpoints.id, endpoint.id)),
        ),
      ).resolves.toEqual([{ id: endpoint.id }]);
      expect(injectedAdmissionFailure).toBe(false);

      timingEvents.length = 0;
      const rejected = await observedRequest();
      expect(injectedAdmissionFailure).toBe(true);
      expect(rejected.status).toBe(503);
      expect(rejected.headers["retry-after"]).toBe("1");
      expect(timingEvents.map((event) => event.stage)).toEqual([
        "http_received",
        "handler_started",
        "endpoint_resolved",
        "runtime_requested",
        "runtime_ready",
        "response_ready",
        "response_finished",
      ]);
      expect(timingEvents.at(-1)?.statusCode).toBe(503);
      expect(
        await readChatDeliveriesByEndpointId(endpoint.id),
      ).toHaveLength(0);

      transactionSpy.mockRestore();
      await service.runtime.removeEndpoint(endpoint.id);
      timingEvents.length = 0;
      const acceptedRetry = await observedRequest(true);
      expect(acceptedRetry.status).toBe(200);
      // This checks eventual processing after durable acknowledgement, not a
      // one-second worker SLA. Keep the condition bounded under suite load.
      await vi.waitFor(
        async () => {
          const deliveries = await readChatDeliveriesByEndpointId(endpoint.id);
          expect(deliveries).toHaveLength(1);
          expect(deliveries[0].state).toBe("processed");
        },
        { timeout: 5_000 },
      );
      const [initialDelivery] = await readChatDeliveriesByEndpointId(endpoint.id);
      const initialDuplicateCount = Number(
        (initialDelivery.normalizedEvent.deduplication as { duplicateCount?: number } | undefined)?.duplicateCount ?? 0,
      );
      expect(initialDuplicateCount).toBe(0);
      const receiptEvent = timingEvents.find(
        (event) => event.stage === "durable_receipt",
      );
      expect(receiptEvent).toMatchObject({
        endpointId: endpoint.id,
        receiptId: initialDelivery.id,
        receiptKind: "message_delivery",
        slackRetryNumHint: 1,
      });
      expect(timingEvents.map((event) => event.stage)).toEqual([
        "http_received",
        "handler_started",
        "endpoint_resolved",
        "runtime_requested",
        "runtime_initializing",
        "runtime_ready",
        "durable_receipt",
        "response_ready",
        "response_finished",
      ]);
      expect(timingEvents.indexOf(receiptEvent!)).toBeLessThan(
        timingEvents.findIndex((event) => event.stage === "response_ready"),
      );
      expect(JSON.stringify(timingEvents)).not.toContain(signingSecret);
      expect(JSON.stringify(timingEvents)).not.toContain(
        "@maya prove durable receipt",
      );
      expect(JSON.stringify(timingEvents)).not.toContain(signature);
      // A duplicate redelivery can momentarily contend with the first
      // delivery's settlement and draw the retryable 503 — that is the
      // webhook contract (Slack re-sends, the dedup path keeps it
      // idempotent), not a defect. Retry the way the provider would
      // instead of asserting an accidental no-contention property; this
      // exact assertion drew a 503 under CI shard load on 2026-09-10.
      let acceptedRedelivery = await observedRequest(true);
      for (
        let attempt = 0;
        acceptedRedelivery.status === 503 && attempt < 20;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        acceptedRedelivery = await observedRequest(true);
      }
      expect(acceptedRedelivery.status).toBe(200);
      await vi.waitFor(async () => {
        const [delivery] = await readChatDeliveriesByEndpointId(endpoint.id);
        expect(
          Number((delivery.normalizedEvent.deduplication as { duplicateCount?: number } | undefined)?.duplicateCount ?? 0),
        ).toBeGreaterThan(initialDuplicateCount);
        expect(
          await readIssuesByCompanyId(fixture.companyId),
        ).toHaveLength(1);
      });
    } finally {
      transactionSpy.mockRestore();
      await service.shutdown();
    }
  });

  it.each(["success", "endpoint_attention", "resource_unavailable"] as const)(
    "serializes duplicate Slack admission with an owned provider-reply settlement: %s",
    async (disposition) => {
      const fixture = await seedCompany();
      const { callbacks, endpoint, service, wakeup } =
        await configuredSlackEndpoint(fixture);
      const channel = makeThread({
        channelId: "C-DUPLICATE-SETTLEMENT",
        id: "slack:C-DUPLICATE-SETTLEMENT:9201.1",
        name: "duplicate-settlement",
        isDM: true,
      });
      const message = makeMessage({
        id: "9201.1",
        text: "/status",
        mentioned: true,
      });
      const providerError =
        disposition === "success"
          ? null
          : Object.assign(new Error(`Synthetic provider reply ${disposition}`), {
              data: {
                error:
                  disposition === "endpoint_attention"
                    ? "invalid_auth"
                    : "channel_not_found",
              },
            });
      if (providerError) channel.post.mockRejectedValue(providerError);
      const terminalState = providerError ? "failed" : "processed";
      const deliver = () =>
        deliverMessage({
          callbacks,
          endpointId: endpoint.id,
          thread: channel.thread,
          message,
          trigger: "mention",
        });
      let releaseSettlement!: () => void;
      const settlementGate = new Promise<void>((resolve) => {
        releaseSettlement = resolve;
      });
      let settlementPid: number | null = null;
      let heldDeliveryId: string | null = null;
      let heldActionId: string | null = null;
      const originalTransaction = db.transaction.bind(db);
      type ObservedSession = {
        prepareQuery(...args: unknown[]): {
          execute(...args: unknown[]): Promise<unknown>;
        };
      };
      const transactionSpy = vi
        .spyOn(db, "transaction")
        .mockImplementation((async (
          ...args: Parameters<typeof originalTransaction>
        ) => {
          const [callback, config] = args;
          return originalTransaction(async (tx) => {
            const session = (tx as unknown as { session: ObservedSession })
              .session;
            const prepareQuery = session.prepareQuery.bind(session);
            session.prepareQuery = (...queryArgs) => {
              const query = queryArgs[0] as { sql: string; params: unknown[] };
              const prepared = prepareQuery(...queryArgs);
              const execute = prepared.execute.bind(prepared);
              prepared.execute = async (...executeArgs) => {
                const result = await execute(...executeArgs);
                if (
                  heldDeliveryId === null &&
                  query.sql.startsWith('update "chat_deliveries" set "state"') &&
                  query.params[0] === terminalState
                ) {
                  const [effect] = await tx
                    .select({
                      id: chatActions.id,
                      deliveryId: chatActions.deliveryId,
                    })
                    .from(chatActions)
                    .where(
                      and(
                        eq(chatActions.endpointId, endpoint.id),
                        eq(chatActions.kind, "provider_effect"),
                        eq(chatActions.status, terminalState),
                      ),
                    );
                  if (
                    effect?.deliveryId &&
                    query.params.includes(effect.deliveryId)
                  ) {
                    if (providerError) {
                      expect((result as { count?: number }).count).toBe(1);
                    } else {
                      expect(result).toEqual([{ id: effect.deliveryId }]);
                    }
                    heldDeliveryId = effect.deliveryId;
                    heldActionId = effect.id;
                    const [backend] = (await tx.execute(
                      sql`select pg_backend_pid() as pid`,
                    )) as unknown as Array<{ pid: number }>;
                    settlementPid = backend!.pid;
                    // The real provider outcome and its real delivery UPDATE have
                    // completed. Hold only the statement return, not fabricated
                    // ledger state, while a duplicate enters normal admission.
                    await settlementGate;
                  }
                }
                return result;
              };
              return prepared;
            };
            return callback(tx);
          }, config);
        }) as typeof db.transaction);
      const outcome = (operation: Promise<unknown>) =>
        operation.then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      const first = outcome(deliver());
      let duplicate: ReturnType<typeof outcome> | undefined;
      try {
        await vi.waitFor(() => expect(settlementPid).not.toBeNull());
        expect(channel.post).toHaveBeenCalledTimes(1);
        const [uncommitted] = await db
          .select({ state: chatDeliveries.state })
          .from(chatDeliveries)
          .where(eq(chatDeliveries.id, heldDeliveryId!));
        expect(uncommitted?.state).toBe("processing");
        duplicate = outcome(deliver());
        let blockedQuery: string | null = null;
        await vi.waitFor(async () => {
          const rows = (await db.execute(sql`
            select query from pg_stat_activity
            where datname = current_database()
              and ${settlementPid} = any(pg_blocking_pids(pid))
              and (query like 'insert into "chat_deliveries"%'
                or (query like 'select %' and query like '%"chat_endpoints"%for %update%'))
          `)) as unknown as Array<{ query: string }>;
          expect(rows).toHaveLength(1);
          blockedQuery = rows[0]!.query;
        });
        // The old order waits at the delivery unique index while owning the
        // endpoint; endpoint-first settlement instead makes admission wait at
        // its endpoint lock. Both are real, observed PostgreSQL dependencies.
        console.info("duplicate settlement blocked statement", blockedQuery);
        releaseSettlement();
        const outcomes = await Promise.all([first, duplicate]);
        expect(outcomes).toEqual([
          providerError ? { ok: false, error: providerError } : { ok: true },
          { ok: true },
        ]);
        const [delivery] = await readChatDeliveriesByEndpointId(endpoint.id);
        expect(delivery).toMatchObject({
          id: heldDeliveryId,
          state: terminalState,
          normalizedEvent: { deduplication: { duplicateCount: 1 } },
        });
        expect(
          await db
            .select({ id: chatActions.id, status: chatActions.status })
            .from(chatActions)
            .where(
              and(
                eq(chatActions.endpointId, endpoint.id),
                eq(chatActions.kind, "provider_effect"),
              ),
            ),
        ).toEqual([{ id: heldActionId, status: terminalState }]);
        if (providerError) {
          const [effect] = await db
            .select({ result: chatActions.result })
            .from(chatActions)
            .where(eq(chatActions.id, heldActionId!));
          expect(effect?.result).toMatchObject({
            code: `provider_effect_${disposition}`,
            attempts: 1,
            retryable: false,
          });
          if (disposition === "endpoint_attention") {
            const [currentEndpoint] = await db
              .select({ status: chatEndpoints.status })
              .from(chatEndpoints)
              .where(eq(chatEndpoints.id, endpoint.id));
            expect(currentEndpoint?.status).toBe("attention");
            expect((await readToolConnectionsById(endpoint.connectionId))[0]).toMatchObject({
              status: "active", enabled: true, healthStatus: "failed",
            });
          } else {
            const [resource] = await db
              .select({ availability: chatEndpointResources.availability })
              .from(chatEndpointResources)
              .where(
                and(
                  eq(chatEndpointResources.endpointId, endpoint.id),
                  eq(
                    chatEndpointResources.providerResourceId,
                    "C-DUPLICATE-SETTLEMENT",
                  ),
                ),
              );
            expect(resource?.availability).toBe("unavailable");
          }
        }
        expect(channel.post).toHaveBeenCalledTimes(1);
        expect(channel.post).toHaveBeenCalledWith(
          "No task is active in this conversation.",
        );
        expect(
          await db
            .select({ id: issues.id })
            .from(issues)
            .where(eq(issues.companyId, fixture.companyId)),
        ).toEqual([]);
        expect(
          await db
            .select({ id: heartbeatRuns.id })
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.companyId, fixture.companyId)),
        ).toEqual([]);
        expect(wakeup).not.toHaveBeenCalled();
      } finally {
        releaseSettlement();
        await Promise.all([first, duplicate]);
        transactionSpy.mockRestore();
        await service.shutdown();
      }
    },
  );

  it("cannot publish a runtime whose initialization is overtaken by pause", async () => {
    const fixture = await seedCompany();
    const { endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture);
    const [beforeActivation] = await db
      .select({ setup: chatEndpoints.setup })
      .from(chatEndpoints)
      .where(eq(chatEndpoints.id, endpoint.id));
    await db
      .update(chatEndpoints)
      .set({
        status: "active",
        setup: { ...beforeActivation!.setup, step: "complete" },
        activatedAt: new Date(),
      })
      .where(eq(chatEndpoints.id, endpoint.id));
    await runtime.removeEndpoint(endpoint.id);

    let releaseInitialization!: () => void;
    let markInitializationEntered!: () => void;
    const initializationGate = new Promise<void>((resolve) => {
      releaseInitialization = resolve;
    });
    const initializationEntered = new Promise<void>((resolve) => {
      markInitializationEntered = resolve;
    });
    runtime.initializeHook = async () => {
      markInitializationEntered();
      await initializationGate;
    };

    const initializingWebhook = service.handleWebhook(
      endpoint.publicId,
      "slack",
      new Request("https://paperclip.example/slack", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "event_callback", event: {} }),
      }),
    );
    await initializationEntered;
    expect(runtime.hasUnsettledLifecycle()).toBe(false); // Fake registry tail is already settled.
    expect(await registeredIdleProbeState()).toBe("present");
    await service.configure(endpoint.id, { action: "pause" }, "owner-user");
    let shutdownSettled = false;
    const shutdown = service.shutdown().then(() => { shutdownSettled = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(shutdownSettled).toBe(false);
    expect(await registeredIdleProbeState()).toBe("present");
    releaseInitialization();

    await expect(initializingWebhook).rejects.toMatchObject({
      status: 409,
      details: { code: "chat_endpoint_runtime_superseded" },
    });
    await shutdown;
    expect(shutdownSettled).toBe(true);
    expect(await registeredIdleProbeState()).toBe("none");
    expect(runtime.endpoints.has(endpoint.id)).toBe(false);
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "paused",
    });
  });

  it("acknowledges durable Slack ingress promptly and never replays paused traffic on resume", async () => {
    const fixture = await seedCompany();
    const deferred: Array<() => void> = [];
    const wakeup = vi.fn(async () => ({ accepted: true }));
    const service = chatChannelService(db, {
      deferWebhookProcessing: true,
      fetch: fakeSlackFetch("U-BOT-PAUSE") as typeof globalThis.fetch,
      heartbeat: { wakeup: receiptBackedWakeup(wakeup) },
      publicBaseUrl: "https://paperclip.example",
      scheduleDeferredWork: (task) => deferred.push(task),
    });
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "slack", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    const signingSecret = "pause-ingress-signing-secret";
    await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          botToken: "xoxb-pause-ingress",
          signingSecret,
        },
      },
      "owner-user",
    );
    await db
      .update(chatEndpoints)
      .set({ status: "active", setup: { step: "complete" } })
      .where(eq(chatEndpoints.id, endpoint.id));

    const signedRequest = (input: {
      eventId: string;
      messageId: string;
      text: string;
    }) => {
      const body = JSON.stringify({
        type: "event_callback",
        event_id: input.eventId,
        event_time: Math.floor(Date.now() / 1000),
        team_id: "T-PAPERCLIP",
        event: {
          type: "app_mention",
          user: "U-PAUSED-SENDER",
          username: "alex",
          text: input.text,
          ts: input.messageId,
          channel: "C-PAUSED-INGRESS",
          channel_type: "channel",
          team: "T-PAPERCLIP",
        },
      });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
      return new Request(
        `https://paperclip.example/api/chat-webhooks/${endpoint.publicId}/slack`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-slack-request-timestamp": timestamp,
            "x-slack-signature": signature,
          },
          body,
        },
      );
    };

    const activeResponse = await service.handleWebhook(
      endpoint.publicId,
      "slack",
      signedRequest({
        eventId: "Ev-before-pause",
        messageId: "9300.1",
        text: "@maya queued just before pause",
      }),
    );
    expect(activeResponse.status).toBe(200);
    expect(deferred).toHaveLength(1);
    expect(wakeup).not.toHaveBeenCalled();

    await service.configure(endpoint.id, { action: "pause" }, "owner-user");
    const pausedResponse = await service.handleWebhook(
      endpoint.publicId,
      "slack",
      signedRequest({
        eventId: "Ev-during-pause",
        messageId: "9300.2",
        text: "@maya this must stay ignored after resume",
      }),
    );
    expect(pausedResponse.status).toBe(200);
    expect(deferred).toHaveLength(1);

    await service.configure(endpoint.id, { action: "resume" }, "owner-user");
    deferred.shift()?.();
    await service.shutdown();

    const deliveries = await readChatDeliveriesByEndpointId(endpoint.id)
      .orderBy(asc(chatDeliveries.receivedAt));
    expect(deliveries).toHaveLength(1);
    expect(deliveries.map((delivery) => delivery.state)).toEqual(["filtered"]);
    expect(deliveries.map((delivery) => delivery.redactedError)).toEqual([
      "Connection was paused before processing",
    ]);
    expect(deliveries.every((delivery) => delivery.processedAt)).toBe(true);
    expect(await service.get(endpoint.id)).toMatchObject({ status: "active" });
    expect(wakeup).not.toHaveBeenCalled();
    expect(
      await readIssuesByCompanyId(fixture.companyId),
    ).toHaveLength(0);
    expect(
      await readHeartbeatRunsByCompanyId(fixture.companyId),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(chatPublications)
        .where(eq(chatPublications.companyId, fixture.companyId)),
    ).toHaveLength(0);
  });

  it("keeps processing audit truth and rejects stale Slack runtime callbacks across resume", async () => {
    const fixture = await seedCompany();
    const { runtime, service, wakeup } = createService(
      new FakeChatSdkRuntime(),
      fakeSlackFetch() as typeof globalThis.fetch,
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
          botToken: "xoxb-generation-boundary",
          signingSecret: "generation-boundary-secret",
        },
      },
      "owner-user",
    );
    await recordSlackUrlVerification(service, endpoint.publicId, "generation-boundary-secret");
    await service.configure(endpoint.id, { action: "verify" }, "owner-user");
    const staleCallbacks = runtime.configurations.get(endpoint.id)?.callbacks;
    if (!staleCallbacks) throw new Error("Expected endpoint callbacks");
    const [configuredSetup] = await db
      .select({ setup: chatEndpoints.setup })
      .from(chatEndpoints)
      .where(eq(chatEndpoints.id, endpoint.id));
    await db
      .update(chatEndpoints)
      .set({
        status: "active",
        setup: { ...configuredSetup!.setup, step: "complete" },
        activatedAt: new Date(),
      })
      .where(eq(chatEndpoints.id, endpoint.id));
    const thread = makeThread({
      channelId: "C-PAUSE-RACE",
      id: "slack:C-PAUSE-RACE:9400.1",
      name: "pause-race",
    });
    const processingMessage = makeMessage({
      id: "9400.1",
      text: "@maya processing before pause",
      mentioned: true,
    });
    const providerEventId = `${thread.thread.id}:${processingMessage.id}`;
    await db.insert(chatDeliveries).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      providerEventId,
      deduplicationKey: createHash("sha256")
        .update(providerEventId)
        .digest("hex"),
      eventKind: "mention",
      normalizedEvent: {},
      state: "processing",
      attempts: 1,
    });

    await service.configure(endpoint.id, { action: "pause" }, "owner-user");
    await deliverMessage({
      callbacks: staleCallbacks,
      endpointId: endpoint.id,
      thread: thread.thread,
      message: processingMessage,
      trigger: "mention",
    });
    const [processingDuplicate] = await db
      .select()
      .from(chatDeliveries)
      .where(eq(chatDeliveries.providerEventId, providerEventId));
    expect(processingDuplicate.state).toBe("processing");
    expect(processingDuplicate.processedAt).toBeNull();
    expect(
      Number(
        (processingDuplicate.normalizedEvent.deduplication as { duplicateCount?: number } | undefined)?.duplicateCount ?? 0,
      ),
    ).toBe(1);

    await service.configure(endpoint.id, { action: "resume" }, "owner-user");
    const staleMessage = makeMessage({
      id: "9400.2",
      text: "@maya parsed before the pause",
      mentioned: true,
    });
    await deliverMessage({
      callbacks: staleCallbacks,
      endpointId: endpoint.id,
      thread: thread.thread,
      message: staleMessage,
      trigger: "mention",
    });
    await staleCallbacks.onMessageUpdated?.({
      endpointId: endpoint.id,
      provider: "slack",
      thread: thread.thread,
      message: makeMessage({ id: "9400.3", text: "stale edit" }),
    } as never);
    await staleCallbacks.onMessageDeleted?.({
      endpointId: endpoint.id,
      provider: "slack",
      event: {
        threadId: thread.thread.id,
        messageId: "9400.4",
        deletedAt: new Date(),
      },
    } as never);
    await staleCallbacks.onReaction?.({
      endpointId: endpoint.id,
      provider: "slack",
      event: {},
    } as never);
    await staleCallbacks.onSlashCommand?.({
      endpointId: endpoint.id,
      provider: "slack",
      event: {},
    } as never);
    await expect(
      staleCallbacks.onAction!({
        endpointId: endpoint.id,
        provider: "slack",
        event: {},
      } as never),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      staleCallbacks.onModalSubmit!({
        endpointId: endpoint.id,
        provider: "slack",
        event: {
          adapter: {} as never,
          callbackId: "stale-callback",
          raw: {},
          user: {
            userId: "U-STALE-CALLBACK",
            userName: "stale-callback",
            fullName: "Stale Callback",
            isBot: false,
            isMe: false,
            isSystem: false,
          },
          values: {},
          viewId: "stale-view",
        },
      } as never),
    ).resolves.toEqual({ action: "clear" });

    const deliveries = await readChatDeliveriesByEndpointId(endpoint.id)
      .orderBy(asc(chatDeliveries.receivedAt));
    expect(deliveries).toHaveLength(3);
    expect(deliveries[0]).toMatchObject({
      state: "processing",
      processedAt: null,
    });
    expect(deliveries[1]).toMatchObject({
      state: "filtered",
      redactedError: "Connection activation changed before admission",
      processedAt: expect.any(Date),
    });
    expect(deliveries[2]).toMatchObject({
      eventKind: "action",
      state: "filtered",
      redactedError: "External chat modal submission denied by Paperclip",
      processedAt: expect.any(Date),
    });
    expect(JSON.stringify(await service.get(endpoint.id))).not.toContain(
      "runtimeGeneration",
    );
    expect(wakeup).not.toHaveBeenCalled();
    expect(
      await readIssuesByCompanyId(fixture.companyId),
    ).toHaveLength(0);

    const freshCallbacks = runtime.configurations.get(endpoint.id)?.callbacks;
    if (!freshCallbacks) throw new Error("Expected resumed endpoint callbacks");
    const freshThread = makeThread({
      channelId: "C-POST-RESUME",
      id: "slack:C-POST-RESUME:9500.1",
      isDM: true,
      name: "post-resume",
    });
    const freshMessage = makeMessage({
      id: "9500.1",
      text: "@maya accepted after resume",
      mentioned: true,
    });
    await deliverMessage({
      callbacks: freshCallbacks,
      endpointId: endpoint.id,
      thread: freshThread.thread,
      message: freshMessage,
      trigger: "mention",
    });
    await service.processPendingDeliveries();
    await vi.waitFor(() => expect(wakeup).toHaveBeenCalledTimes(1));
    expect(
      await readIssuesByCompanyId(fixture.companyId),
    ).toHaveLength(1);
    await service.shutdown();
  });

  it("recovers the visible receipt exactly once after wake acceptance contention", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service, wakeup } =
      await configuredSlackEndpoint(fixture);
    const first = makeThread({
      channelId: "C-RECEIPT-RETRY",
      id: "slack:C-RECEIPT-RETRY:1000.1",
      name: "receipt-retry",
    });
    const message = makeMessage({
      id: "1000.1",
      text: "@maya acknowledge this after retry",
      mentioned: true,
    });
    let releaseLock!: () => void;
    let lockEntered!: () => void;
    const holdLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      lockEntered = resolve;
    });
    let lockTransaction: Promise<unknown> | undefined;
    first.subscribe.mockImplementationOnce(async () => {
      lockTransaction = db.transaction(async (tx) => {
        await tx
          .select({ id: chatEndpoints.id })
          .from(chatEndpoints)
          .where(eq(chatEndpoints.id, endpoint.id))
          .for("update");
        lockEntered();
        await holdLock;
      });
      await entered;
    });
    try {
      await expect(
        deliverMessage({
          callbacks,
          endpointId: endpoint.id,
          thread: first.thread,
          message,
          trigger: "mention",
        }),
      ).rejects.toMatchObject({ cause: { code: "55P03" } });
      expect(wakeup).not.toHaveBeenCalled();
      expect(runtime.endpoints.get(endpoint.id)?.reactions).toEqual([]);
    } finally {
      releaseLock();
      await lockTransaction;
    }
    await vi.waitFor(
      async () => {
        await service.processPendingDeliveries();
        expect(wakeup).toHaveBeenCalledTimes(1);
        expect(runtime.endpoints.get(endpoint.id)?.reactions).toEqual([
          { threadId: first.thread.id, messageId: message.id, emoji: "eyes" },
        ]);
      },
      { timeout: 10_000 },
    );
    await service.processPendingDeliveries();
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(runtime.endpoints.get(endpoint.id)?.reactions).toHaveLength(1);
    const [delivery] = await readChatDeliveriesByEndpointId(endpoint.id);
    expect(delivery).toMatchObject({ state: "processed" });
    expect(
      await readIssueCommentsByCompanyId(fixture.companyId),
    ).toHaveLength(1);
    await service.shutdown();
  });

  it.each([
    { isDM: true, threaded: true, status: "done", state: "active" },
    { isDM: true, threaded: true, status: "cancelled", state: "active" },
    { isDM: true, threaded: true, status: "in_review", state: "completed" },
    { isDM: false, threaded: true, status: "done", state: "completed" },
    { isDM: true, threaded: false, status: "done", state: "completed" },
  ] as const)(
    "preserves Slack thread history across completion ($isDM, $threaded, $status, $state)",
    async ({ isDM, threaded, status, state }) => {
      const fixture = await seedCompany();
      const { callbacks, endpoint, service, wakeup } = await configuredSlackEndpoint(fixture, { linkedBoardUser: true });
      const channelId = isDM ? "D-HISTORY" : "C-HISTORY";
      const thread = makeThread({
        channelId,
        id: `slack:${channelId}:${threaded ? "1000.1" : ""}`,
        isDM,
      }).thread;
      const send = (id: string, text: string) => deliverMessage({
        callbacks, endpointId: endpoint.id, thread,
        message: makeMessage({ id, text, mentioned: !isDM, userId: "UBOARD" }),
        trigger: isDM ? "direct_message" : "mention",
      });
      await send("1000.1", "Keep this context for my next request");
      const [original] = await readChatConversationsByEndpointId(endpoint.id);
      await db.insert(issueComments).values({
        companyId: fixture.companyId, issueId: original.issueId,
        authorType: "agent", authorAgentId: fixture.assignedAgentId,
        body: "I kept the original request.",
      });
      await db.update(issues).set({ status }).where(eq(issues.id, original.issueId));
      await db.update(chatConversations).set({ state }).where(eq(chatConversations.id, original.id));

      await send("1000.2", "Is it done?");
      await send("1000.2", "Is it done?");
      const conversations = await readChatConversationsByEndpointId(endpoint.id);
      expect(conversations).toHaveLength(threaded ? 1 : 2);
      const generation = threaded ? original.sessionGeneration : original.sessionGeneration + 1;
      const continued = conversations.find(row => row.sessionGeneration === generation)!;
      expect(continued.issueId === original.issueId).toBe(threaded);
      expect(continued.state).toBe("active");
      expect((await issueService(db).getById(continued.issueId))?.status).toBe(status === "in_review" ? "in_review" : "todo");
      const comments = await readIssueCommentsByIssueId(continued.issueId)
        .orderBy(asc(issueComments.createdAt), asc(issueComments.id));
      expect(comments.map(row => row.body)).toEqual(threaded
        ? ["Keep this context for my next request", "I kept the original request.", "Is it done?"]
        : ["Is it done?"]);
      expect(wakeup).toHaveBeenCalledTimes(2);
      const resources = await db.select().from(chatEndpointResources)
        .where(eq(chatEndpointResources.endpointId, endpoint.id));
      expect(resources.find(row => row.providerResourceId === channelId)?.type).toBe(isDM ? "direct_message" : "channel");
      if (isDM) {
        await service.update(endpoint.id, { allowDirectMessages: false });
        await send("1000.3", "This must be rejected");
        expect(wakeup).toHaveBeenCalledTimes(2);
        expect(await readIssueCommentsByIssueId(continued.issueId)).toHaveLength(threaded ? 3 : 1);
      }
    },
  );

  it("keeps separate Slack DM thread roots on separate tasks", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint } = await configuredSlackEndpoint(fixture);
    for (const root of ["1000.1", "1000.2"]) {
      await deliverMessage({
        callbacks, endpointId: endpoint.id,
        thread: makeThread({ channelId: "D-ROOTS", id: `slack:D-ROOTS:${root}`, isDM: true }).thread,
        message: makeMessage({ id: root, text: "A separate request" }),
        trigger: "direct_message",
      });
    }
    const conversations = await readChatConversationsByEndpointId(endpoint.id);
    expect(conversations).toHaveLength(2);
    expect(new Set(conversations.map(row => row.issueId)).size).toBe(2);
    expect(conversations.map(row => row.sessionGeneration)).toEqual([1, 1]);
  });

  it("deduplicates inbound events, keeps one task per thread, and enables newly discovered Slack channels", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service, wakeup } =
      await configuredSlackEndpoint(fixture);
    const serializedEndpointResponses = JSON.stringify({
      detail: await service.get(endpoint.id),
      list: await service.list(fixture.companyId),
    });
    expect(serializedEndpointResponses).not.toContain("xoxb-test-token");
    expect(serializedEndpointResponses).not.toContain("test-signing-secret");
    const first = makeThread({
      channelId: "C-ENGINEERING",
      id: "slack:C-ENGINEERING:1000.1",
      name: "engineering",
    });
    const firstMessage = makeMessage({
      id: "1000.1",
      text: "@maya investigate the deploy",
      mentioned: true,
    });

    const duplicateResults = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        deliverMessage({
          callbacks,
          endpointId: endpoint.id,
          thread: first.thread,
          message: firstMessage,
          trigger: "mention",
        }),
      ),
    );
    // Concurrent duplicate receipts can briefly hold the endpoint while the
    // issue-first wake acceptance checks it with NOWAIT. The direct SDK test
    // callback surfaces that contention; its durable delivery must still drain
    // to exactly one wake rather than requiring every synchronous call to win.
    for (const result of duplicateResults) {
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({ cause: { code: "55P03" } });
      }
    }
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: first.thread,
      message: firstMessage,
      trigger: "mention",
    });
    await vi.waitFor(
      async () => {
        await service.processPendingDeliveries();
        expect(wakeup).toHaveBeenCalledTimes(1);
      },
      { timeout: 10_000 },
    );

    let conversations = await readChatConversationsByEndpointId(endpoint.id);
    let endpointIssues = await readIssuesByCompanyId(fixture.companyId);
    let deliveries = await readChatDeliveriesByEndpointId(endpoint.id);
    let comments = await readIssueCommentsByIssueId(conversations[0].issueId)
      .orderBy(asc(issueComments.createdAt), asc(issueComments.id));
    expect(conversations).toHaveLength(1);
    expect(endpointIssues).toHaveLength(1);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].normalizedEvent).toMatchObject({
      deduplication: {
        duplicateCount: 12,
        lastDuplicateAt: expect.any(String),
      },
    });
    expect(comments.map((comment) => comment.body)).toEqual([
      "@maya investigate the deploy",
    ]);
    expect(runtime.endpoints.get(endpoint.id)?.reactions).toContainEqual({
      threadId: first.thread.id,
      messageId: firstMessage.id,
      emoji: "eyes",
    });
    // Receipt reactions deliberately resolve the current credential-fenced
    // runtime instead of reusing an inbound callback's potentially stale
    // adapter object.
    expect(first.addReaction).not.toHaveBeenCalled();
    expect(first.startTyping).not.toHaveBeenCalled();
    expect(first.subscribe).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledTimes(1);

    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: first.thread,
      message: makeMessage({ id: "1000.2", text: "Here is another detail" }),
      trigger: "subscribed_message",
    });
    conversations = await readChatConversationsByEndpointId(endpoint.id);
    endpointIssues = await readIssuesByCompanyId(fixture.companyId);
    comments = await readIssueCommentsByIssueId(conversations[0].issueId)
      .orderBy(asc(issueComments.createdAt), asc(issueComments.id));
    expect(conversations).toHaveLength(1);
    expect(endpointIssues).toHaveLength(1);
    expect(comments.map((comment) => comment.body)).toEqual([
      "@maya investigate the deploy",
      "Here is another detail",
    ]);

    const second = makeThread({
      channelId: "C-FINANCE",
      id: "slack:C-FINANCE:2000.1",
      name: "finance",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: second.thread,
      message: makeMessage({
        id: "2000.1",
        text: "@maya summarize spend",
        mentioned: true,
      }),
      trigger: "mention",
    });
    const resources = await service.listResources(endpoint.id);
    expect(
      resources.map((resource) => ({
        label: resource.label,
        enabled: resource.enabled,
      })),
    ).toEqual([
      { label: "engineering", enabled: true },
      { label: "finance", enabled: true },
    ]);
    deliveries = await readChatDeliveriesByEndpointId(endpoint.id);
    expect(
      deliveries.find((delivery) => delivery.providerEventId.includes("2000.1"))
        ?.state,
    ).toBe("processed");
    expect(
      await readIssuesByCompanyId(fixture.companyId),
    ).toHaveLength(2);

    const finance = resources.find((resource) => resource.label === "finance");
    if (!finance) throw new Error("Expected discovered finance resource");
    await service.replaceResources(endpoint.id, [
      { id: finance.id, enabled: true },
    ]);
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: second.thread,
      message: makeMessage({
        id: "2000.2",
        text: "@maya summarize spend",
        mentioned: true,
      }),
      trigger: "mention",
    });
    expect(
      await readChatConversationsByEndpointId(endpoint.id),
    ).toHaveLength(2);
    expect(
      await readIssuesByCompanyId(fixture.companyId),
    ).toHaveLength(2);
  });

  it("acknowledges a provider question when the board resolves after callback validation", async () => {
    const fixture = await seedCompany();
    let enterQuestionResolution!: () => void;
    let releaseQuestionResolution!: () => void;
    const questionResolutionEntered = new Promise<void>((resolve) => {
      enterQuestionResolution = resolve;
    });
    const questionResolutionGate = new Promise<void>((resolve) => {
      releaseQuestionResolution = resolve;
    });
    const context = await configuredSlackEndpoint(fixture, {
      questionResolutionPersistBarrier: async () => {
        enterQuestionResolution();
        await questionResolutionGate;
      },
    });
    const { callbacks, endpoint, service } = context;
    if (!callbacks.onAction) throw new Error("Expected Slack action callback");
    const externalUserId = `U-QUESTION-RACE-${randomUUID()}`;
    const channel = makeThread({
      channelId: "C-QUESTION-RACE",
      id: `slack:C-QUESTION-RACE:${randomUUID()}`,
      name: "question-race",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: channel.thread,
      message: makeMessage({
        id: randomUUID(),
        text: "@maya choose during a race",
        mentioned: true,
        userId: externalUserId,
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id);
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
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
    const token = new URL(intent.confirmationUrl).searchParams.get("token");
    if (!token) throw new Error("Question-race identity token was absent");
    await service.confirmIdentityLink(token, "owner-user");

    const interaction = await issueThreadInteractionService(db).create(
      { id: conversation.issueId, companyId: fixture.companyId },
      {
        kind: "ask_user_questions",
        continuationPolicy: "none",
        title: "Race choice",
        payload: {
          version: 1,
          questions: [
            {
              id: "choice",
              prompt: "Choose one",
              selectionMode: "single",
              required: true,
              allowOther: false,
              options: [
                { id: "one", label: "One" },
                { id: "two", label: "Two" },
              ],
            },
          ],
        },
      },
      { agentId: fixture.assignedAgentId },
    );
    await service.processPendingPublications();
    const publication = await db
      .select()
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.endpointId, endpoint.id),
          eq(
            chatPublications.idempotencyKey,
            `interaction:${interaction.id}:${endpoint.id}`,
          ),
        ),
      )
      .then((rows) => rows[0]);
    const action = publication.payload.card?.actions?.find(
      (candidate) => candidate.type === "callback" && candidate.label === "One",
    );
    if (
      !publication.providerMessageId ||
      !action ||
      action.type !== "callback"
    ) {
      throw new Error("Question-race callback was not published");
    }
    const callback = callbacks.onAction({
      endpointId: endpoint.id,
      provider: "slack",
      event: {
        actionId: action.actionId,
        adapter: {} as never,
        messageId: publication.providerMessageId,
        openModal: async () => undefined,
        raw: { type: "block_actions" },
        thread: channel.thread,
        threadId: `slack:C-QUESTION-RACE:${publication.providerMessageId}`,
        user: {
          userId: externalUserId,
          userName: "question-racer",
          fullName: "Question Racer",
          isBot: false,
          isMe: false,
          isSystem: false,
        },
        value: interaction.id,
      },
    });
    await questionResolutionEntered;
    await issueThreadInteractionService(db).answerQuestions(
      { id: conversation.issueId, companyId: fixture.companyId },
      interaction.id,
      { answers: [{ questionId: "choice", optionIds: ["two"] }] },
      { userId: "owner-user" },
    );
    releaseQuestionResolution();
    await expect(callback).resolves.toBeUndefined();
    await expect(
      db
        .select({ status: chatActions.status, result: chatActions.result })
        .from(chatActions)
        .where(eq(chatActions.providerActionId, action.actionId)),
    ).resolves.toEqual([
      {
        status: "expired",
        result: { code: "interaction_resolved_elsewhere" },
      },
    ]);
    await expect(
      db
        .select()
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, fixture.companyId),
            eq(activityLog.action, "issue.thread_interaction_answered"),
            eq(activityLog.entityId, conversation.issueId),
          ),
        ),
    ).resolves.toHaveLength(0);
    await service.shutdown();
  });

  it("cleans only the GitHub final run's receipt and never re-adds it on replay", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredGitHubEndpoint(fixture, {
        scheduleDeferredWork: () => undefined,
      });
    try {
      await db
        .update(chatEndpoints)
        .set({ status: "active" })
        .where(eq(chatEndpoints.id, endpoint.id));
      const thread = makeThread({
        channelId: "github:paperclipai/paperclip",
        id: "github:paperclipai/paperclip:issue:5",
      });
      await deliverLegacyGitHubReceipt({
        callbacks,
        endpointId: endpoint.id,
        provider: "github",
        thread: thread.thread,
        message: makeMessage({
          id: "5603841952",
          text: "@maya answer this fresh request",
          mentioned: true,
        }),
        trigger: "mention",
      }, service);
      const [conversation] = await service.listConversations(endpoint.id);
      const runId = randomUUID();
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
        body: "GITHUB-RECEIPT-FINAL",
      });
      await db.update(heartbeatRuns).set({ resultJson: { presentationDecision: { authorizationReason: "internal_agent_write" } } }).where(eq(heartbeatRuns.id, runId));
      await enqueueChatRunMilestones(db);
      await service.processPendingPublications();
      const [delivery] = await readChatDeliveriesByEndpointId(endpoint.id);
      const [removal] = await readChatActionsByProviderActionId(`receipt_reaction_remove:${delivery.id}`);
      expect(removal).toBeDefined();
      await service.processPendingReceiptReactions(1, removal!.id);
      await service.processPendingReceiptReactions(1, removal!.id);
      expect(runtime.endpoints.get(endpoint.id)?.removedReactions).toEqual([
        { threadId: thread.thread.id, messageId: "5603841952", emoji: "eyes" },
      ]);
      const [add] = await readChatActionsByProviderActionId(`receipt_reaction:${delivery.id}`);
      await db
        .update(chatActions)
        .set({
          status: "failed",
          result: { retryable: true, retryAt: new Date(0).toISOString() },
        })
        .where(eq(chatActions.id, add.id));
      await service.processPendingReceiptReactions(1, add.id);
      expect(runtime.endpoints.get(endpoint.id)?.reactions).toHaveLength(1);
      // This is a legacy connection: its final answer still publishes exactly
      // once while the old eyes receipt is removed and cannot be re-added.
      expect(
        runtime.endpoints
          .get(endpoint.id)
          ?.posts.filter((post) => post.text === "GITHUB-RECEIPT-FINAL"),
      ).toHaveLength(1);
    } finally {
      await retirePublicationFixture(service, endpoint.id);
    }
  });
});
