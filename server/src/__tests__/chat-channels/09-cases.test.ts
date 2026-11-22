import {
  chatHistoryActionBlocks,
} from ".././helpers/chat-history-proof.js";
import {
  registerChatActionWork,
} from "../../services/chat-action-work.js";
import {
  createDeliveryWorkCoordinator,
} from "../../services/delivery-work-coordinator.js";
import {
  DELIVERY_QUEUES,
  subscribeDeliveryWork,
} from "../../services/delivery-work-notifications.js";
import {
  randomUUID,
} from "node:crypto";
import {
  and,
  eq,
  or,
  sql,
} from "drizzle-orm";
import {
  expect,
  it,
  vi,
} from "vitest";
import {
  chatActions,
  chatDeliveries,
  chatEndpointLeases,
  chatEndpoints,
  issueComments,
  issues,
  toolConnections,
} from "@paperclipai/db";
import {
  FakeChatSdkRuntime,
  fakeDiscordFetch,
  makeMessage,
  makeThread,
  uniqueDiscordApplicationId,
} from ".././helpers/chat-channels-fixture.js";
import {
  attachFakeGitHubIssueCommentWebhook,
  configuredDiscordEndpoint,
  createService,
  db,
  deliverMessage,
  describeChatChannelsSuite,
  qualifySetupRoundTrip,
  readChatActionsById,
  readChatConversationsByEndpointId,
  readChatDeliveriesByEndpointId,
  readChatEndpointsById,
  retirePublicationFixture,
  seedCompany,
  signedGitHubWebhookRequest,
  configuredGitHubEndpoint,
} from "../helpers/chat-channels-harness.js";
import {
  githubPreIngressRecoveryFixture,
} from "../helpers/chat-channels-endpoint-fixtures.js";

describeChatChannelsSuite("chat channels 09-cases", () => {
  it.each(["successful sibling", "edited comment", "disabled repository"])(
    "rejects automatic pre-ingress GitHub recovery after %s",
    async (change) => {
      const context = await githubPreIngressRecoveryFixture();
      try {
        if (change === "successful sibling")
          context.setDeliveries([
            {
              ...context.original,
              id: "9007199254740994",
              redelivery: true,
              status_code: 202,
              delivered_at: new Date(Date.now() - 15_000).toISOString(),
            },
            context.original,
          ]);
        if (change === "edited comment")
          context.setCanonicalComment({
            body: "edited after the original callback",
          });
        if (change === "disabled repository") {
          const resources = await context.service.listResources(
            context.endpoint.id,
          );
          await context.service.replaceResources(
            context.endpoint.id,
            resources.map((resource) => ({ id: resource.id, enabled: false })),
          );
        }
        await context.makeScanDue();
        await context.service.processFailedGitHubWebhookDeliveries(
          5,
          context.endpoint.id,
        );
        expect(context.posts).toEqual([]);
        if (change === "edited comment") {
          expect(await context.receipt()).toMatchObject({
            status: "cancelled",
            result: { attempts: 0, code: "source_changed_or_unavailable" },
          });
          expect(await chatHistoryActionBlocks(db, (await context.receipt())!.id)).toBe(false);
        } else expect(await context.receipt()).toBeUndefined();
        expect(context.wakeup).not.toHaveBeenCalled();
      } finally {
        await retirePublicationFixture(context.service, context.endpoint.id);
      }
    },
  );

  it.each(["truncated history", "ordering drift"])(
    "fails closed on automatic pre-ingress GitHub recovery with %s",
    async (mode) => {
      const context = await githubPreIngressRecoveryFixture();
      try {
        if (mode === "truncated history") context.setHistoryHasMore(true);
        else
          context.setDeliveries([
            context.original,
            {
              ...context.original,
              id: "9007199254740994",
              guid: randomUUID(),
              delivered_at: new Date(Date.now() - 15_000).toISOString(),
            },
          ]);
        await context.makeScanDue();
        await context.service.processFailedGitHubWebhookDeliveries(
          5,
          context.endpoint.id,
        );
        expect(context.posts).toEqual([]);
        expect(await context.receipt()).toBeUndefined();
        expect((await context.checkpoint()).value).toMatchObject({
          outcome:
            mode === "truncated history"
              ? "history_limit_reached"
              : "scan_failed",
        });
        expect(
          context.requests.filter(
            (request) => request.pathname === "/app/hook/deliveries",
          ),
        ).toHaveLength(mode === "truncated history" ? 3 : 1);
      } finally {
        await retirePublicationFixture(context.service, context.endpoint.id);
      }
    },
  );

  it("stops automatic pre-ingress GitHub pagination at the epoch floor without adopting older failures", async () => {
    const context = await githubPreIngressRecoveryFixture();
    try {
      context.setHistoryHasMore(true);
      context.setDeliveries([
        context.original,
        {
          ...context.original,
          id: "9007199254740994",
          guid: randomUUID(),
          delivered_at: new Date(Date.now() - 180_000).toISOString(),
        },
      ]);
      await context.makeScanDue();
      await context.service.processFailedGitHubWebhookDeliveries(
        5,
        context.endpoint.id,
      );
      expect(context.posts).toHaveLength(1);
      expect(
        context.requests.filter(
          (request) => request.pathname === "/app/hook/deliveries",
        ),
      ).toHaveLength(1);
    } finally {
      await retirePublicationFixture(context.service, context.endpoint.id);
    }
  });

  it.each(["issue", "pull request", "sender", "action"])(
    "rejects a signed automatic GitHub callback whose original %s identity changed",
    async (field) => {
      const context = await githubPreIngressRecoveryFixture(
        field === "pull request"
          ? "pull_request_review_comment"
          : "issue_comment",
      );
      try {
        await context.makeScanDue();
        await context.service.processFailedGitHubWebhookDeliveries(
          5,
          context.endpoint.id,
        );
        expect(context.posts).toHaveLength(1);
        const changed = {
          ...context.payload,
          ...(field === "issue" ? { issue: { id: 9290, number: 92 } } : {}),
          ...(field === "pull request"
            ? { pull_request: { id: 9290, number: 92 } }
            : {}),
          ...(field === "sender"
            ? { sender: { id: 99, login: "different-user", type: "User" } }
            : {}),
          ...(field === "action" ? { action: "edited" } : {}),
        };
        expect(
          (await context.callback(context.webhookSecret, changed)).status,
        ).toBe(200);
        expect(await context.ingress()).toBeUndefined();
        expect(context.wakeup).not.toHaveBeenCalled();
      } finally {
        await retirePublicationFixture(context.service, context.endpoint.id);
      }
    },
  );

  it("rechecks canonical content before processing an automatically recovered GitHub callback", async () => {
    const context = await githubPreIngressRecoveryFixture();
    try {
      await context.makeScanDue();
      await context.service.processFailedGitHubWebhookDeliveries(
        5,
        context.endpoint.id,
      );
      expect(context.posts).toHaveLength(1);
      await context.callback();
      const staged = await context.ingress();
      expect(staged).toMatchObject({ status: "received" });
      context.setCanonicalComment({
        body: "changed after successful callback staging",
      });
      await context.service.processPendingGitHubWebhookIngress(1, staged!.id);
      expect(await context.ingress()).toMatchObject({
        status: "cancelled",
        result: { code: "github_webhook_recovery_source_changed" },
        payload: { redacted: true },
      });
      expect(context.wakeup).not.toHaveBeenCalled();
      expect(
        await db
          .select({ id: issues.id })
          .from(issues)
          .where(eq(issues.companyId, context.fixture.companyId)),
      ).toEqual([]);
    } finally {
      await retirePublicationFixture(context.service, context.endpoint.id);
    }
  });

  it("denies a stale automatic GitHub callback after pause and reconnect even with the still-current HMAC secret", async () => {
    const context = await githubPreIngressRecoveryFixture();
    try {
      await context.makeScanDue();
      await context.service.processFailedGitHubWebhookDeliveries(
        5,
        context.endpoint.id,
      );
      const receipt = await context.receipt();
      expect(receipt).toBeDefined();
      await context.service.configure(
        context.endpoint.id,
        { action: "pause" },
        "owner-user",
      );
      expect((await context.callback()).status).toBe(200);
      expect(await context.ingress()).toBeUndefined();
      await context.service.configure(
        context.endpoint.id,
        { action: "reconnect" },
        "owner-user",
      );
      expect((await context.callback()).status).toBe(200);
      expect(await context.ingress()).toBeUndefined();
      expect(await context.receipt()).toEqual(receipt);
      expect(context.wakeup).not.toHaveBeenCalled();
    } finally {
      await retirePublicationFixture(context.service, context.endpoint.id);
    }
  });

  it("never re-arms a failed local GitHub receipt when an automatic redelivery races the original callback", async () => {
    const context = await githubPreIngressRecoveryFixture();
    try {
      await context.makeScanDue();
      await context.service.processFailedGitHubWebhookDeliveries(
        5,
        context.endpoint.id,
      );
      expect(context.posts).toHaveLength(1);
      await context.callback();
      const ingress = await context.ingress();
      context.providerRuntime.webhookHook = undefined;
      context.providerRuntime.webhookResponse = new Response(
        "invalid provider content",
        { status: 400 },
      );
      await context.service.processPendingGitHubWebhookIngress(1, ingress!.id);
      const failed = await context.ingress();
      expect(failed).toMatchObject({
        status: "failed",
        result: { attempts: 1, retryable: false },
      });
      context.providerRuntime.webhookResponse = new Response(null, {
        status: 202,
      });
      await context.callback();
      expect(await context.ingress()).toEqual(failed);
      await context.makeScanDue();
      await context.service.processFailedGitHubWebhookDeliveries(
        5,
        context.endpoint.id,
      );
      expect(context.posts).toHaveLength(1);
    } finally {
      await retirePublicationFixture(context.service, context.endpoint.id);
    }
  });

  it("never stores a GitHub webhook body before its signature is authenticated", async () => {
    const fixture = await seedCompany();
    const { endpoint, service, webhookSecret } =
      await configuredGitHubEndpoint(fixture);
    const delivery = `github-invalid-${randomUUID()}`;
    const marker = `must-not-persist-${randomUUID()}`;
    const signed = signedGitHubWebhookRequest({
      delivery,
      event: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 2468 },
        repository: {
          id: 97531,
          full_name: "paperclipai/paperclip",
          name: "paperclip",
          owner: { id: 1357, login: "paperclipai" },
        },
        issue: { number: 91 },
        comment: { id: 9191, body: marker },
        sender: { id: 42, login: "octocat" },
      },
      webhookSecret,
    });
    const headers = new Headers(signed.headers);
    headers.set("x-hub-signature-256", "sha256=invalid");
    const response = await service.handleWebhook(
      endpoint.publicId,
      "github",
      new Request(signed, { headers }),
    );

    expect(response.status).toBe(401);
    await expect(
      db
        .select({ id: chatActions.id })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(
              chatActions.providerActionId,
              `github_webhook_ingress:${delivery}`,
            ),
          ),
        ),
    ).resolves.toEqual([]);
    await expect(
      db.execute(
        sql`select id from chat_actions where endpoint_id = ${endpoint.id} and payload::text like ${`%${marker}%`}`,
      ),
    ).resolves.toHaveLength(0);
    await service.shutdown();
  });

  it("records one content-free GitHub receipt for a disabled repository without admitting work", async () => {
    const fixture = await seedCompany();
    const { endpoint, runtime, service, webhookSecret, wakeup } =
      await configuredGitHubEndpoint(fixture);
    await db
      .update(chatEndpoints)
      .set({ status: "active" })
      .where(eq(chatEndpoints.id, endpoint.id));
    const resources = await service.listResources(endpoint.id);
    await service.replaceResources(endpoint.id, [
      { id: resources[0]!.id, enabled: false },
    ]);
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected GitHub provider runtime");
    providerRuntime.webhookRequest = null;
    const delivery = `github-disabled-${randomUUID()}`;
    const marker = `private-disabled-body-${randomUUID()}`;
    const makeRequest = () =>
      signedGitHubWebhookRequest({
        delivery,
        event: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 2468 },
          repository: {
            id: 97531,
            full_name: "paperclipai/paperclip",
            name: "paperclip",
            owner: { id: 1357, login: "paperclipai" },
          },
          issue: { number: 91, body: marker },
          comment: { id: 9191, body: marker },
          sender: { id: 42, login: "private-disabled-author" },
        },
        webhookSecret,
      });
    const invalid = makeRequest();
    invalid.headers.set("x-hub-signature-256", "sha256=invalid");
    expect(
      (await service.handleWebhook(endpoint.publicId, "github", invalid))
        .status,
    ).toBe(401);
    await expect(
      readChatDeliveriesByEndpointId(endpoint.id),
    ).resolves.toEqual([]);

    const responses = await Promise.all(
      [1, 2, 3].map(() =>
        service.handleWebhook(endpoint.publicId, "github", makeRequest()),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([
      200, 200, 200,
    ]);
    const rows = await readChatDeliveriesByEndpointId(endpoint.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      state: "filtered",
      eventKind: "message",
      conversationId: null,
      principalId: null,
      redactedError: "Destination is not enabled in Paperclip",
      normalizedEvent: {
        kind: "message",
        filtering: {
          contentRetained: false,
          reason: "destination_not_enabled",
          resourceId: resources[0]!.id,
        },
      },
    });
    expect(JSON.stringify(rows)).not.toContain(marker);
    expect(JSON.stringify(rows)).not.toContain("private-disabled-author");
    expect(Object.keys(rows[0]!.normalizedEvent).sort()).toEqual([
      "filtering",
      "kind",
      "providerEventId",
    ]);
    expect(providerRuntime.webhookRequest).toBeNull();
    expect(wakeup).not.toHaveBeenCalled();
    await expect(service.listConversations(endpoint.id)).resolves.toEqual([]);
    await expect(service.listActivity(endpoint.id)).resolves.toContainEqual(
      expect.objectContaining({
        id: rows[0]!.id,
        status: "filtered",
        summary: "message ignored",
        detail: "Destination is not enabled in Paperclip",
        replayable: false,
      }),
    );
    await expect(
      db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(
              chatActions.providerActionId,
              `github_webhook_ingress:${delivery}`,
            ),
          ),
        ),
    ).resolves.toEqual([]);

    await service.replaceResources(endpoint.id, [
      { id: resources[0]!.id, enabled: true },
    ]);
    await service.processPendingDeliveries();
    expect(
      wakeup.mock.calls.some(
        ([, options]) =>
          options?.durableChatRequest?.companyId === fixture.companyId,
      ),
    ).toBe(false);
    expect(providerRuntime.webhookRequest).toBeNull();
    await service.shutdown();
  });

  it("does not retain signed GitHub events outside the configured App event set", async () => {
    const fixture = await seedCompany();
    const { endpoint, runtime, service, webhookSecret } =
      await configuredGitHubEndpoint(fixture);
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected GitHub provider runtime");
    providerRuntime.webhookRequest = null;
    const delivery = `github-unsupported-${randomUUID()}`;
    const marker = `unsupported-body-${randomUUID()}`;
    const response = await service.handleWebhook(
      endpoint.publicId,
      "github",
      signedGitHubWebhookRequest({
        delivery,
        event: "issues",
        payload: {
          action: "opened",
          installation: { id: 2468 },
          issue: { body: marker },
        },
        webhookSecret,
      }),
    );

    expect(response.status).toBe(200);
    expect(providerRuntime.webhookRequest).toBeNull();
    await expect(
      db
        .select({ id: chatActions.id })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(chatActions.kind, "github_webhook_ingress"),
            sql`${chatActions.payload}::text like ${`%${marker}%`}`,
          ),
        ),
    ).resolves.toEqual([]);
    await service.shutdown();
  });

  it("drains accepted GitHub webhooks from commit wakes and durable retry deadlines", async () => {
    const fixture = await seedCompany();
    const { endpoint, runtime, service, webhookSecret } = await configuredGitHubEndpoint(fixture, {
      deferWebhookProcessing: true, scheduleDeferredWork: () => undefined,
    });
    const providerRuntime = runtime.endpoints.get(endpoint.id)!;
    let attempts = 0;
    providerRuntime.webhookHook = async () => {
      providerRuntime.webhookResponse = new Response("result", { status: ++attempts === 1 ? 503 : 202 });
    };
    const delivery = randomUUID();
    const send = () => service.handleWebhook(endpoint.publicId, "github", signedGitHubWebhookRequest({
      delivery, event: "installation_repositories", payload: { action: "added", installation: { id: 2468 } }, webhookSecret,
    }));
    const onError = vi.fn();
    let coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError });
    const receipt = () => db.select().from(chatActions).where(and(eq(chatActions.endpointId, endpoint.id),
      eq(chatActions.providerActionId, `github_webhook_ingress:${delivery}`))).then(rows => rows[0]);
    try {
      await registerChatActionWork(coordinator, service, () => true).ready;
      expect((await send()).status).toBe(202);
      await expect.poll(async () => (await receipt())?.status, { timeout: 10_000 }).toBe("processed");
      expect(attempts).toBe(2);
      expect((await receipt())?.result).toMatchObject({ attempts: 2, httpStatus: 202 });
      // A duplicate callback wakes the lane but cannot repeat a settled effect.
      await send();
      await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBeNull(), { timeout: 10_000 });
      expect(attempts).toBe(2);
      await coordinator.stop();
      // Work committed while no worker exists is recovered by the next startup.
      const restartDelivery = randomUUID();
      await service.handleWebhook(endpoint.publicId, "github", signedGitHubWebhookRequest({
        delivery: restartDelivery, event: "installation_repositories",
        payload: { action: "added", installation: { id: 2468 } }, webhookSecret,
      }));
      expect(attempts).toBe(2);
      coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError });
      await registerChatActionWork(coordinator, service, () => true).ready;
      await expect.poll(() => attempts, { timeout: 10_000 }).toBe(3);
      expect(onError).not.toHaveBeenCalled();
    } finally { await coordinator.stop(); }
  });

  it("safely re-arms an exact terminal GitHub delivery after an operator redelivery", async () => {
    const fixture = await seedCompany();
    const { endpoint, runtime, service, webhookSecret } =
      await configuredGitHubEndpoint(fixture);
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected GitHub provider runtime");
    providerRuntime.webhookResponse = new Response("bad payload", {
      status: 400,
    });
    const webhookHook = vi.fn(async () => undefined);
    providerRuntime.webhookHook = webhookHook;
    const delivery = `github-terminal-${randomUUID()}`;
    const makeRequest = () =>
      signedGitHubWebhookRequest({
        delivery,
        event: "installation_repositories",
        payload: { action: "added", installation: { id: 2468 } },
        webhookSecret,
      });

    const first = await service.handleWebhook(
      endpoint.publicId,
      "github",
      makeRequest(),
    );
    expect(first.status).toBe(400);
    const terminal = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpoint.id),
          eq(
            chatActions.providerActionId,
            `github_webhook_ingress:${delivery}`,
          ),
        ),
      )
      .then((rows) => rows[0]);
    expect(terminal).toMatchObject({
      status: "failed",
      result: expect.objectContaining({
        attempts: 1,
        httpStatus: 400,
        retryable: false,
      }),
      payload: expect.objectContaining({ redacted: true }),
    });
    expect(webhookHook).toHaveBeenCalledTimes(1);
    await expect(service.listActivity(endpoint.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: terminal!.id,
          kind: "action",
          actionType: "github_webhook_ingress",
          status: "failed",
          summary: "GitHub webhook could not be processed",
          detail: expect.stringContaining(delivery),
          replayable: false,
        }),
      ]),
    );

    const conflictingDuplicate = await service.handleWebhook(
      endpoint.publicId,
      "github",
      signedGitHubWebhookRequest({
        delivery,
        event: "installation_repositories",
        payload: {
          action: "removed",
          installation: { id: 2468 },
          marker: "different authenticated body",
        },
        webhookSecret,
      }),
    );
    expect(conflictingDuplicate.status).toBe(202);
    expect(webhookHook).toHaveBeenCalledTimes(1);
    await expect(
      readChatActionsById(terminal!.id)
        .then((rows) => rows[0]),
    ).resolves.toMatchObject({
      status: "failed",
      result: expect.objectContaining({
        attempts: 1,
        httpStatus: 400,
        retryable: false,
      }),
      payload: expect.objectContaining({ redacted: true }),
    });

    providerRuntime.webhookResponse = new Response("accepted", { status: 202 });
    const recovered = await service.handleWebhook(
      endpoint.publicId,
      "github",
      makeRequest(),
    );
    expect(recovered.status).toBe(202);
    expect(webhookHook).toHaveBeenCalledTimes(2);
    await expect(
      readChatActionsById(terminal!.id)
        .then((rows) => rows[0]),
    ).resolves.toMatchObject({
      status: "processed",
      result: expect.objectContaining({ attempts: 2, httpStatus: 202 }),
      payload: expect.objectContaining({ redacted: true }),
    });

    const processedDuplicate = await service.handleWebhook(
      endpoint.publicId,
      "github",
      makeRequest(),
    );
    expect(processedDuplicate.status).toBe(202);
    expect(webhookHook).toHaveBeenCalledTimes(2);
    await service.shutdown();
  });

  it("cancels staged GitHub ingress when same-secret pause and resume wins at the replay barrier", async () => {
    let armed = false;
    let release!: () => void;
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const context = await githubPreIngressRecoveryFixture(
      "issue_comment",
      async () => {
        if (armed) {
          entered();
          await barrier;
        }
      },
    );
    let worker:
      | ReturnType<typeof context.service.processPendingGitHubWebhookIngress>
      | undefined;
    const sdkDispatch = vi.fn();
    try {
      const [record] = await readChatEndpointsById(context.endpoint.id);
      await db
        .update(chatEndpoints)
        .set({ setup: { ...record!.setup, step: "complete" } })
        .where(eq(chatEndpoints.id, context.endpoint.id));
      const refs = () =>
        db
          .select({ refs: toolConnections.credentialSecretRefs })
          .from(toolConnections)
          .where(eq(toolConnections.id, record!.connectionId))
          .then((rows) => rows[0]!.refs);
      const originalRefs = await refs();
      const botUsername = (await context.service.get(context.endpoint.id))
        .botUsername!;
      const wireRuntime = async () => {
        const runtime = context.runtime.endpoints.get(context.endpoint.id)!;
        const callbacks = context.runtime.configurations.get(
          context.endpoint.id,
        )!.callbacks;
        attachFakeGitHubIssueCommentWebhook({
          botUsername,
          callbacks,
          endpointId: context.endpoint.id,
          runtime,
        });
        const dispatch = runtime.webhookHook!;
        runtime.webhookHook = async (request) => {
          sdkDispatch();
          await dispatch(request);
        };
      };
      context.runtime.initializeHook = wireRuntime;
      await wireRuntime();
      armed = true;
      expect((await context.callback()).status).toBe(202);
      const staged = await context.ingress();
      expect(staged).toMatchObject({ status: "received" });
      worker = context.service.processPendingGitHubWebhookIngress(
        1,
        staged!.id,
      );
      await reached;
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
      expect(await refs()).toEqual(originalRefs);
      expect(await context.service.get(context.endpoint.id)).toMatchObject({
        status: "active",
      });
      release();
      await worker;
      expect(await context.ingress()).toMatchObject({
        status: "cancelled",
        payload: { redacted: true },
        result: { code: "github_webhook_ingress_runtime_superseded" },
      });
      expect((await context.ingress())!.payload).not.toHaveProperty("body");
      expect(await chatHistoryActionBlocks(db, (await context.ingress())!.id)).toBe(false);
      expect(sdkDispatch).not.toHaveBeenCalled();
      expect(
        await db
          .select({ id: chatDeliveries.id })
          .from(chatDeliveries)
          .where(eq(chatDeliveries.endpointId, context.endpoint.id)),
      ).toEqual([]);
      expect(
        await db
          .select({ id: issueComments.id })
          .from(issueComments)
          .where(eq(issueComments.companyId, context.fixture.companyId)),
      ).toEqual([]);
      expect(context.wakeup).not.toHaveBeenCalled();
    } finally {
      release();
      await worker?.catch(() => undefined);
      await retirePublicationFixture(context.service, context.endpoint.id);
    }
  });

  it("cancels staged GitHub ingress when a minimal recovery tombstone arrives before processing", async () => {
    const context = await githubPreIngressRecoveryFixture();
    try {
      expect((await context.callback()).status).toBe(202);
      const staged = await context.ingress();
      const window = (await context.checkpoint()).value as Record<
        string,
        unknown
      >;
      await db.insert(chatActions).values({
        companyId: context.fixture.companyId,
        endpointId: context.endpoint.id,
        kind: "github_webhook_recovery",
        providerActionId: `github_webhook_recovery:${context.guid}`,
        status: "cancelled",
        payload: {
          ...window,
          original: { id: context.deliveryId, guid: context.guid },
        },
        result: { attempts: 0, code: "source_changed_or_unavailable" },
      });
      context.requests.length = 0;
      await context.service.processPendingGitHubWebhookIngress(1, staged!.id);
      const cancelled = await context.ingress();
      expect(cancelled).toMatchObject({
        status: "cancelled",
        payload: { redacted: true },
        result: { code: "github_webhook_recovery_source_changed" },
      });
      expect(cancelled!.payload).not.toHaveProperty("body");
      expect(await chatHistoryActionBlocks(db, cancelled!.id)).toBe(false);
      expect(cancelled!.result?.retryable).not.toBe(true);
      expect(context.requests).toEqual([]);
      expect(
        await db
          .select({ id: chatDeliveries.id })
          .from(chatDeliveries)
          .where(eq(chatDeliveries.endpointId, context.endpoint.id)),
      ).toEqual([]);
      expect(context.wakeup).not.toHaveBeenCalled();
      expect(
        await context.service.processPendingGitHubWebhookIngress(1, staged!.id),
      ).toBe(0);
    } finally {
      await retirePublicationFixture(context.service, context.endpoint.id);
    }
  });

  it("cancels and redacts GitHub ingress when rotation wins before replay authentication", async () => {
    const fixture = await seedCompany();
    const configured = await configuredGitHubEndpoint(fixture);
    let releaseReplay!: () => void;
    let markReplayReady!: () => void;
    const replayReady = new Promise<void>((resolve) => {
      markReplayReady = resolve;
    });
    const replayRelease = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    const receiver = createService(new FakeChatSdkRuntime(), undefined, {
      githubWebhookReplayBarrier: async () => {
        markReplayReady();
        await replayRelease;
      },
    }).service;
    const delivery = `github-stale-generation-${randomUUID()}`;
    const marker = `stale-body-${randomUUID()}`;
    const pendingResponse = receiver.handleWebhook(
      configured.endpoint.publicId,
      "github",
      signedGitHubWebhookRequest({
        delivery,
        event: "installation_repositories",
        payload: {
          action: "opened",
          installation: { id: 2468 },
          marker,
        },
        webhookSecret: configured.webhookSecret,
      }),
    );
    await replayReady;
    const action = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, configured.endpoint.id),
          eq(
            chatActions.providerActionId,
            `github_webhook_ingress:${delivery}`,
          ),
        ),
      )
      .then((rows) => rows[0]!);

    await configured.service.generateSetupSecret(
      configured.endpoint.id,
      "owner-user",
    );
    releaseReplay();
    await expect(pendingResponse).resolves.toMatchObject({ status: 202 });
    const cancelled = await readChatActionsById(action.id)
      .then((rows) => rows[0]);
    expect(cancelled).toMatchObject({
      status: "cancelled",
      result: expect.objectContaining({
        code: "github_webhook_ingress_runtime_superseded",
      }),
      payload: expect.objectContaining({ redacted: true }),
    });
    expect(cancelled?.payload).not.toHaveProperty("body");
    await receiver.shutdown();
    await configured.service.shutdown();
  });

  it("preserves the GitHub resource, task, and conversation across repository rename and transfer", async () => {
    const fixture = await seedCompany();
    const context = await configuredGitHubEndpoint(fixture);
    const { callbacks, endpoint, service, webhookSecret } = context;
    const originalResource = (await service.listResources(endpoint.id))[0]!;
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "github",
      thread: makeThread({
        channelId: "PaperclipAI/Paperclip",
        id: "github:PaperclipAI/Paperclip:issue:77",
        name: "PaperclipAI/Paperclip",
      }).thread,
      message: makeMessage({
        id: "github-rename-root",
        text: "@maya keep this task through repository moves",
        mentioned: true,
      }),
      trigger: "mention",
    });
    const originalConversation = await readChatConversationsByEndpointId(endpoint.id)
      .then((rows) => rows[0]!);

    const renamedRepository = {
      id: 97531,
      full_name: "paperclipai/paperclip-renamed",
      html_url: "https://github.com/paperclipai/paperclip-renamed",
      owner: { id: 1357, login: "paperclipai" },
      private: false,
    };
    context.setRepositories([renamedRepository]);
    await service.handleWebhook(
      endpoint.publicId,
      "github",
      signedGitHubWebhookRequest({
        delivery: "github-repository-renamed-inventory",
        event: "installation_repositories",
        payload: {
          action: "added",
          installation: { id: 2468 },
          repositories_added: [renamedRepository],
          repositories_removed: [],
        },
        webhookSecret,
      }),
    );
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        id: originalResource.id,
        providerResourceId: "paperclipai/paperclip-renamed",
        enabled: true,
        metadata: expect.objectContaining({ providerRepositoryId: "97531" }),
      }),
    ]);

    const transferredRepository = {
      ...renamedRepository,
      full_name: "new-owner/paperclip-renamed",
      html_url: "https://github.com/new-owner/paperclip-renamed",
      owner: { id: 24680, login: "new-owner" },
    };
    // installation_repositories is a canonical inventory-refresh signal. Keep
    // the provider fixture consistent with the transfer carried by the event.
    context.setRepositories([transferredRepository]);
    await service.handleWebhook(
      endpoint.publicId,
      "github",
      signedGitHubWebhookRequest({
        delivery: "github-repository-transferred-webhook",
        event: "installation_repositories",
        payload: {
          action: "opened",
          installation: { id: 2468 },
          repository: transferredRepository,
        },
        webhookSecret,
      }),
    );

    const [migratedConversation] = await readChatConversationsByEndpointId(endpoint.id);
    expect(migratedConversation).toMatchObject({
      id: originalConversation.id,
      issueId: originalConversation.issueId,
      resourceId: originalResource.id,
      externalConversationId: "new-owner/paperclip-renamed",
      externalThreadId: "github:new-owner/paperclip-renamed:issue:77",
      providerUrl:
        "https://github.com/new-owner/paperclip-renamed/issues/77#issuecomment-github-rename-root",
    });

    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "github",
      thread: makeThread({
        channelId: "new-owner/paperclip-renamed",
        id: "github:new-owner/paperclip-renamed:issue:77",
        name: "new-owner/paperclip-renamed",
      }).thread,
      message: makeMessage({
        id: "github-transfer-followup",
        text: "a follow-up after the transfer",
      }),
      trigger: "subscribed_message",
    });

    await expect(
      readChatConversationsByEndpointId(endpoint.id),
    ).resolves.toEqual([
      expect.objectContaining({
        id: originalConversation.id,
        issueId: originalConversation.issueId,
      }),
    ]);
    await expect(
      db
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.companyId, fixture.companyId)),
    ).resolves.toHaveLength(1);
  });

  it("configures a customer-owned Microsoft Teams bot with the entered credentials", async () => {
    const fixture = await seedCompany();
    const clientId = "00000000-0000-4000-8000-000000000001";
    const tenantId = "00000000-0000-4000-8000-000000000002";
    const clientSecret = "teams-client-secret";
    let observedTokenRequest: URLSearchParams | null = null;
    const providerFetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        expect(url).toBe(
          `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
        );
        expect(init?.method).toBe("POST");
        observedTokenRequest = new URLSearchParams(String(init?.body));
        return new Response(JSON.stringify({ access_token: "teams-access" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    ) as unknown as typeof globalThis.fetch;
    const { runtime, service } = createService(
      new FakeChatSdkRuntime(),
      providerFetch,
    );
    const endpoint = await service.create(
      fixture.companyId,
      {
        provider: "microsoft-teams",
        assignedAgentId: fixture.assignedAgentId,
      },
      "owner-user",
    );

    const configured = await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: { clientId, tenantId, clientSecret },
      },
      "owner-user",
    );

    expect(Object.fromEntries(observedTokenRequest ?? [])).toEqual({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
      scope: "https://api.botframework.com/.default",
    });
    expect(configured).toMatchObject({
      status: "verifying",
      providerAccountId: tenantId,
      botExternalId: clientId,
      allowGroupChats: false,
      capabilities: {
        nativeStreaming: false,
        messageEdits: true,
        messageDeletes: true,
      },
      setup: { step: "test" },
    });
    expect(
      runtime.configurations.get(endpoint.id)?.providerConfig,
    ).toMatchObject({
      provider: "microsoft-teams",
      credentials: {
        appId: clientId,
        appPassword: clientSecret,
        appTenantId: tenantId,
        appType: "SingleTenant",
      },
    });
  });

  it("globally fences one Microsoft Bot application across tenants", async () => {
    const firstCompany = await seedCompany();
    const secondCompany = await seedCompany();
    const clientId = "00000000-0000-4000-8000-000000000091";
    const providerFetch = (async () =>
      new Response(JSON.stringify({ access_token: "teams-access" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    let claimCount = 0;
    let releaseClaims!: () => void;
    const bothClaimsReady = new Promise<void>((resolve) => {
      releaseClaims = resolve;
    });
    const claimBarrier = async () => {
      claimCount += 1;
      if (claimCount === 2) releaseClaims();
      await bothClaimsReady;
    };
    const first = createService(new FakeChatSdkRuntime(), providerFetch, {
      nativeBotIdentityClaimBarrier: claimBarrier,
    });
    const second = createService(new FakeChatSdkRuntime(), providerFetch, {
      nativeBotIdentityClaimBarrier: claimBarrier,
    });
    const firstEndpoint = await first.service.create(
      firstCompany.companyId,
      {
        provider: "microsoft-teams",
        assignedAgentId: firstCompany.assignedAgentId,
      },
      "owner-user",
    );
    const secondEndpoint = await second.service.create(
      secondCompany.companyId,
      {
        provider: "microsoft-teams",
        assignedAgentId: secondCompany.assignedAgentId,
      },
      "owner-user",
    );
    const endpoints = [firstEndpoint, secondEndpoint] as const;
    const services = [first.service, second.service] as const;
    const tenantIds = [
      "00000000-0000-4000-8000-000000000092",
      "00000000-0000-4000-8000-000000000093",
    ] as const;
    const outcomes = await Promise.allSettled(
      services.map((service, index) =>
        service.configure(
          endpoints[index]!.id,
          {
            action: "configure",
            credentials: {
              clientId,
              tenantId: tenantIds[index]!,
              clientSecret: `teams-secret-${index}`,
            },
          },
          "owner-user",
        ),
      ),
    );
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    const rejectedIndex = outcomes.findIndex(
      (outcome) => outcome.status === "rejected",
    );
    expect(rejectedIndex).toBeGreaterThanOrEqual(0);
    const conflict = (outcomes[rejectedIndex] as PromiseRejectedResult).reason;
    expect(conflict).toMatchObject({
      status: 409,
      details: { code: "chat_bot_identity_in_use" },
    });
    expect(conflict).not.toMatchObject({
      details: {
        endpointId: expect.any(String),
        assignedAgentId: expect.any(String),
      },
    });
    await expect(
      db
        .select({ refs: toolConnections.credentialSecretRefs })
        .from(toolConnections)
        .where(eq(toolConnections.id, endpoints[rejectedIndex]!.connectionId))
        .then((rows) => rows[0]?.refs ?? []),
    ).resolves.toEqual([]);
    await first.service.shutdown();
    await second.service.shutdown();
  });

  it("rehydrates one Discord Gateway owner on startup and hands off cleanly across replicas", async () => {
    const fixture = await seedCompany();
    const applicationId = uniqueDiscordApplicationId();
    const guildId = "1457808928258658549";
    const providerFetch = fakeDiscordFetch(
      applicationId,
      guildId,
    ) as typeof globalThis.fetch;
    const ownerRuntime = new FakeChatSdkRuntime();
    const owner = createService(ownerRuntime, providerFetch);
    const endpoint = await owner.service.create(
      fixture.companyId,
      { provider: "discord", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await owner.service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          applicationId,
          botToken: "discord-secret",
          guildId,
        },
      },
      "owner-user",
    );
    expect(
      ownerRuntime.configurations.get(endpoint.id)?.enableDiscordGateway,
    ).toBe(true);

    const standbyRuntime = new FakeChatSdkRuntime();
    const standby = createService(standbyRuntime, providerFetch);
    await expect(standby.service.reconcileProviderRuntimes()).resolves.toEqual({
      eligible: 1,
      local: 0,
      ownedElsewhere: 1,
      failed: 0,
    });
    expect(standbyRuntime.endpoints.has(endpoint.id)).toBe(false);
    await expect(
      db
        .select({ token: chatEndpointLeases.token })
        .from(chatEndpointLeases)
        .where(
          and(
            eq(chatEndpointLeases.endpointId, endpoint.id),
            eq(chatEndpointLeases.leaseKey, "discord_gateway_runtime"),
          ),
        ),
    ).resolves.toHaveLength(1);

    const firstRuntime = ownerRuntime.endpoints.get(endpoint.id);
    await owner.service.shutdown();
    expect(firstRuntime?.shutdown).toHaveBeenCalledOnce();
    const reconciled = await standby.service.reconcileProviderRuntimes();
    // Earlier integration cases intentionally leave durable active endpoints
    // behind in this shared database. A fresh standby must recover all
    // currently unowned Discord gateways, including this test's endpoint.
    expect(reconciled).toMatchObject({ ownedElsewhere: 0, failed: 0 });
    expect(reconciled.local).toBe(reconciled.eligible);
    expect(reconciled.local).toBeGreaterThanOrEqual(1);
    expect(
      standbyRuntime.configurations.get(endpoint.id)?.enableDiscordGateway,
    ).toBe(true);
    await standby.service.shutdown();
    await expect(
      db
        .select({ token: chatEndpointLeases.token })
        .from(chatEndpointLeases)
        .where(eq(chatEndpointLeases.endpointId, endpoint.id)),
    ).resolves.toEqual([]);
  });

  it("recovers buffered Discord messages and reactions after an unreclaimed host-pause lease expiry", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service, wakeup } =
      await configuredDiscordEndpoint(fixture, {
        discordGatewayLeaseRenewalIntervalMs: 60_000,
        discordGatewayLeaseTtlMs: 200,
      });
    const ownedRuntime = runtime.endpoints.get(endpoint.id);
    if (!ownedRuntime)
      throw new Error("Expected Discord Gateway owner runtime");
    const [leaseBeforePause] = await db
      .select({ token: chatEndpointLeases.token })
      .from(chatEndpointLeases)
      .where(
        and(
          eq(chatEndpointLeases.endpointId, endpoint.id),
          eq(chatEndpointLeases.leaseKey, "discord_gateway_runtime"),
        ),
      );
    if (!leaseBeforePause) throw new Error("Expected Discord Gateway lease");

    await new Promise((resolve) => setTimeout(resolve, 250));
    const messageId = "555555555555555601";
    const channel = makeThread({
      channelId: "333333333333333333",
      id: `discord:1457808928258658549:333333333333333333:${messageId}`,
      name: "discord-host-pause",
    });
    const message = makeMessage({
      id: messageId,
      mentioned: true,
      text: "@maya retain this buffered Discord turn",
      userId: "444444444444444444",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "discord",
      thread: channel.thread,
      message,
      trigger: "mention",
    });

    await expect(
      db
        .select({ state: chatDeliveries.state })
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(
              chatDeliveries.providerEventId,
              `${channel.thread.id}:${messageId}`,
            ),
          ),
        ),
    ).resolves.toHaveLength(1);
    expect(runtime.endpoints.get(endpoint.id)).toBe(ownedRuntime);
    expect(ownedRuntime.shutdown).not.toHaveBeenCalled();
    await expect(
      db
        .select({ token: chatEndpointLeases.token })
        .from(chatEndpointLeases)
        .where(
          and(
            eq(chatEndpointLeases.endpointId, endpoint.id),
            eq(chatEndpointLeases.leaseKey, "discord_gateway_runtime"),
          ),
        ),
    ).resolves.toEqual([{ token: leaseBeforePause.token }]);

    await qualifySetupRoundTrip(service, endpoint.id, message.author.userId);
    await service.test(endpoint.id);
    if (!callbacks.onReaction) {
      throw new Error("Expected Discord reaction callback");
    }
    const commentCountBefore = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.companyId, fixture.companyId))
      .then((rows) => rows.length);
    const wakeupCountBefore = wakeup.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 250));
    const emoji = {
      name: "thumbsup",
      toJSON: () => "👍",
      toString: () => "👍",
    };
    const reaction = {
      endpointId: endpoint.id,
      provider: "discord" as const,
      event: {
        adapter: {} as never,
        added: true,
        emoji,
        message,
        messageId,
        raw: {
          channel_id: "333333333333333333",
          emoji: { id: null, name: "👍" },
          gateway_dispatch: {
            eventType: "MESSAGE_REACTION_ADD",
            sequence: 801,
            sessionFingerprint: "c".repeat(24),
            shardId: 0,
          },
          guild_id: "1457808928258658549",
          message_id: messageId,
          user_id: message.author.userId,
        },
        rawEmoji: "👍",
        thread: channel.thread,
        threadId: channel.thread.id,
        user: message.author,
      },
    };
    await callbacks.onReaction(reaction);
    await callbacks.onReaction(reaction);

    await expect(
      db
        .select({ state: chatDeliveries.state })
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(chatDeliveries.eventKind, "reaction_added"),
            sql`${chatDeliveries.normalizedEvent}->'message'->>'providerMessageId' = ${messageId}`,
          ),
        ),
    ).resolves.toEqual([{ state: "processed" }]);
    expect(
      await db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(eq(issueComments.companyId, fixture.companyId))
        .then((rows) => rows.length),
    ).toBe(commentCountBefore);
    expect(wakeup).toHaveBeenCalledTimes(wakeupCountBefore);
    expect(runtime.endpoints.get(endpoint.id)).toBe(ownedRuntime);
    expect(ownedRuntime.shutdown).not.toHaveBeenCalled();
    await service.shutdown();
  });

  it("stops a Discord Gateway on lease loss and lets a standby take over", async () => {
    const fixture = await seedCompany();
    const applicationId = uniqueDiscordApplicationId();
    const guildId = "1457808928258658549";
    const providerFetch = fakeDiscordFetch(
      applicationId,
      guildId,
    ) as typeof globalThis.fetch;
    const ownerRuntime = new FakeChatSdkRuntime();
    const owner = createService(ownerRuntime, providerFetch, {
      discordGatewayLeaseRenewalIntervalMs: 60_000,
      discordGatewayLeaseTtlMs: 200,
    });
    const endpoint = await owner.service.create(
      fixture.companyId,
      { provider: "discord", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await owner.service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          applicationId,
          botToken: "discord-secret",
          guildId,
        },
      },
      "owner-user",
    );
    const staleRuntime = ownerRuntime.endpoints.get(endpoint.id);
    const staleAdmission = ownerRuntime.configurations.get(endpoint.id)
      ?.callbacks.onDiscordRootMentionAdmission;
    const staleCallbacks = ownerRuntime.configurations.get(
      endpoint.id,
    )?.callbacks;
    if (!staleAdmission || !staleCallbacks)
      throw new Error("Expected Discord admission callbacks");

    const standbyRuntime = new FakeChatSdkRuntime();
    const standby = createService(standbyRuntime, providerFetch);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const reconciled = await standby.service.reconcileProviderRuntimes();
    expect(reconciled).toMatchObject({ ownedElsewhere: 0, failed: 0 });
    expect(reconciled.local).toBe(reconciled.eligible);
    expect(reconciled.local).toBeGreaterThanOrEqual(1);
    expect(
      standbyRuntime.configurations.get(endpoint.id)?.enableDiscordGateway,
    ).toBe(true);
    await expect(
      staleAdmission({
        channelId: "333333333333333333",
        endpointId: endpoint.id,
        guildId,
        messageId: "555555555555555555",
        threadId: `discord:${guildId}:333333333333333333:555555555555555555`,
        userId: "444444444444444444",
      }),
    ).resolves.toBe(false);
    expect(staleRuntime?.shutdown).toHaveBeenCalledOnce();

    const freshCallbacks = standbyRuntime.configurations.get(
      endpoint.id,
    )?.callbacks;
    if (!freshCallbacks)
      throw new Error("Expected standby Discord admission callbacks");
    const messageId = "555555555555555602";
    const channel = makeThread({
      channelId: "333333333333333333",
      id: `discord:${guildId}:333333333333333333:${messageId}`,
      name: "discord-standby-takeover",
    });
    const message = makeMessage({
      id: messageId,
      mentioned: true,
      text: "@maya accept this once after Gateway takeover",
      userId: "444444444444444444",
    });
    await deliverMessage({
      callbacks: staleCallbacks,
      endpointId: endpoint.id,
      provider: "discord",
      thread: channel.thread,
      message,
      trigger: "mention",
    });
    await deliverMessage({
      callbacks: freshCallbacks,
      endpointId: endpoint.id,
      provider: "discord",
      thread: channel.thread,
      message,
      trigger: "mention",
    });
    await expect(
      db
        .select({ id: chatDeliveries.id })
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(
              chatDeliveries.providerEventId,
              `${channel.thread.id}:${messageId}`,
            ),
          ),
        ),
    ).resolves.toHaveLength(1);
    await Promise.all([owner.service.shutdown(), standby.service.shutdown()]);
  });

  it("fences message and reaction callbacks that resume after Discord Gateway takeover", async () => {
    const fixture = await seedCompany();
    const applicationId = uniqueDiscordApplicationId();
    const guildId = "1457808928258658549";
    const channelId = "333333333333333334";
    let holdOldCallbacks = false;
    let releaseOldCallbacks!: () => void;
    let messageAdmissionEntered!: () => void;
    let reactionAdmissionEntered!: () => void;
    const oldCallbacksReleased = new Promise<void>((resolve) => {
      releaseOldCallbacks = resolve;
    });
    const messageAdmissionReached = new Promise<void>((resolve) => {
      messageAdmissionEntered = resolve;
    });
    const reactionAdmissionReached = new Promise<void>((resolve) => {
      reactionAdmissionEntered = resolve;
    });
    const providerFetch = fakeDiscordFetch(
      applicationId,
      guildId,
    ) as typeof globalThis.fetch;
    const ownerRuntime = new FakeChatSdkRuntime();
    const owner = createService(ownerRuntime, providerFetch, {
      discordGatewayLeaseRenewalIntervalMs: 60_000,
      discordGatewayLeaseTtlMs: 200,
      discordGatewayMessageAdmissionBarrier: async () => {
        if (!holdOldCallbacks) return;
        messageAdmissionEntered();
        await oldCallbacksReleased;
      },
      reactionLinkPreflightBarrier: async () => {
        if (!holdOldCallbacks) return;
        reactionAdmissionEntered();
        await oldCallbacksReleased;
      },
    });
    const endpoint = await owner.service.create(
      fixture.companyId,
      { provider: "discord", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await owner.service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          applicationId,
          botToken: "discord-secret",
          guildId,
        },
      },
      "owner-user",
    );
    const rootMessageId = "555555555555555603";
    const channel = makeThread({
      channelId,
      id: `discord:${guildId}:${channelId}:${rootMessageId}`,
      name: "discord-callback-takeover",
    });
    const rootMessage = makeMessage({
      id: rootMessageId,
      mentioned: true,
      text: "@maya establish the takeover fixture",
      userId: "444444444444444445",
    });
    const setupCallbacks = ownerRuntime.configurations.get(
      endpoint.id,
    )?.callbacks;
    if (!setupCallbacks) throw new Error("Expected owner Discord callbacks");
    await deliverMessage({
      callbacks: setupCallbacks,
      endpointId: endpoint.id,
      provider: "discord",
      thread: channel.thread,
      message: rootMessage,
      trigger: "mention",
    });
    await qualifySetupRoundTrip(
      owner.service,
      endpoint.id,
      rootMessage.author.userId,
    );
    await owner.service.test(endpoint.id);
    const staleRuntime = ownerRuntime.endpoints.get(endpoint.id);
    const staleCallbacks = ownerRuntime.configurations.get(
      endpoint.id,
    )?.callbacks;
    if (!staleRuntime || !staleCallbacks?.onReaction) {
      throw new Error("Expected active owner Discord callbacks");
    }
    const [leaseBeforeTakeover] = await db
      .select({ token: chatEndpointLeases.token })
      .from(chatEndpointLeases)
      .where(
        and(
          eq(chatEndpointLeases.endpointId, endpoint.id),
          eq(chatEndpointLeases.leaseKey, "discord_gateway_runtime"),
        ),
      );
    if (!leaseBeforeTakeover) throw new Error("Expected owner Gateway lease");

    const messageId = "555555555555555604";
    const bufferedMessage = makeMessage({
      id: messageId,
      text: "continue this once after takeover",
      userId: rootMessage.author.userId,
    });
    const emoji = {
      name: "thumbsup",
      toJSON: () => "👍",
      toString: () => "👍",
    };
    const reaction = {
      endpointId: endpoint.id,
      provider: "discord" as const,
      event: {
        adapter: {} as never,
        added: true,
        emoji,
        message: rootMessage,
        messageId: rootMessageId,
        raw: {
          channel_id: channelId,
          emoji: { id: null, name: "👍" },
          gateway_dispatch: {
            eventType: "MESSAGE_REACTION_ADD",
            sequence: 802,
            sessionFingerprint: "d".repeat(24),
            shardId: 0,
          },
          guild_id: guildId,
          message_id: rootMessageId,
          user_id: rootMessage.author.userId,
        },
        rawEmoji: "👍",
        thread: channel.thread,
        threadId: channel.thread.id,
        user: rootMessage.author,
      },
    };
    const commentCountBefore = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.companyId, fixture.companyId))
      .then((rows) => rows.length);
    const wakeupCountBefore = owner.wakeup.mock.calls.length;
    holdOldCallbacks = true;
    const staleMessage = deliverMessage({
      callbacks: staleCallbacks,
      endpointId: endpoint.id,
      provider: "discord",
      thread: channel.thread,
      message: bufferedMessage,
      trigger: "subscribed_message",
    });
    const staleReaction = staleCallbacks.onReaction(reaction);
    await Promise.all([messageAdmissionReached, reactionAdmissionReached]);

    const standbyRuntime = new FakeChatSdkRuntime();
    const standby = createService(standbyRuntime, providerFetch);
    try {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const reconciled = await standby.service.reconcileProviderRuntimes();
      expect(reconciled).toMatchObject({ ownedElsewhere: 0, failed: 0 });
      const freshCallbacks = standbyRuntime.configurations.get(
        endpoint.id,
      )?.callbacks;
      if (!freshCallbacks?.onReaction) {
        throw new Error("Expected standby Discord callbacks");
      }
      const [leaseAfterTakeover] = await db
        .select({ token: chatEndpointLeases.token })
        .from(chatEndpointLeases)
        .where(
          and(
            eq(chatEndpointLeases.endpointId, endpoint.id),
            eq(chatEndpointLeases.leaseKey, "discord_gateway_runtime"),
          ),
        );
      expect(leaseAfterTakeover?.token).toBeTruthy();
      expect(leaseAfterTakeover?.token).not.toBe(leaseBeforeTakeover.token);

      releaseOldCallbacks();
      await Promise.all([staleMessage, staleReaction]);
      await expect(
        db
          .select({ id: chatDeliveries.id })
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, endpoint.id),
              or(
                eq(
                  chatDeliveries.providerEventId,
                  `${channel.thread.id}:${messageId}`,
                ),
                and(
                  eq(chatDeliveries.eventKind, "reaction_added"),
                  sql`${chatDeliveries.normalizedEvent}->'message'->>'providerMessageId' = ${rootMessageId}`,
                ),
              ),
            ),
          ),
      ).resolves.toEqual([]);
      await vi.waitFor(() => {
        expect(staleRuntime.shutdown).toHaveBeenCalledOnce();
      });

      await deliverMessage({
        callbacks: freshCallbacks,
        endpointId: endpoint.id,
        provider: "discord",
        thread: channel.thread,
        message: bufferedMessage,
        trigger: "subscribed_message",
      });
      await freshCallbacks.onReaction(reaction);
      await deliverMessage({
        callbacks: freshCallbacks,
        endpointId: endpoint.id,
        provider: "discord",
        thread: channel.thread,
        message: bufferedMessage,
        trigger: "subscribed_message",
      });
      await freshCallbacks.onReaction(reaction);

      await expect(
        db
          .select({ state: chatDeliveries.state })
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, endpoint.id),
              eq(
                chatDeliveries.providerEventId,
                `${channel.thread.id}:${messageId}`,
              ),
            ),
          ),
      ).resolves.toEqual([{ state: "processed" }]);
      await expect(
        db
          .select({ state: chatDeliveries.state })
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, endpoint.id),
              eq(chatDeliveries.eventKind, "reaction_added"),
              sql`${chatDeliveries.normalizedEvent}->'message'->>'providerMessageId' = ${rootMessageId}`,
            ),
          ),
      ).resolves.toEqual([{ state: "processed" }]);
      expect(
        await db
          .select({ id: issueComments.id })
          .from(issueComments)
          .where(eq(issueComments.companyId, fixture.companyId))
          .then((rows) => rows.length),
      ).toBe(commentCountBefore + 1);
      expect(owner.wakeup).toHaveBeenCalledTimes(wakeupCountBefore);
      expect(standby.wakeup).toHaveBeenCalledOnce();
    } finally {
      releaseOldCallbacks();
      await Promise.allSettled([staleMessage, staleReaction]);
      await Promise.allSettled([
        owner.service.shutdown(),
        standby.service.shutdown(),
      ]);
    }
  });

  it("releases Discord ownership when runtime construction fails", async () => {
    const fixture = await seedCompany();
    const applicationId = uniqueDiscordApplicationId();
    const runtime = new FakeChatSdkRuntime();
    runtime.initializeHook = async () => {
      throw new Error("constructor failed");
    };
    const { service } = createService(
      runtime,
      fakeDiscordFetch(applicationId) as typeof globalThis.fetch,
    );
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "discord", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await expect(
      service.configure(
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
      ),
    ).rejects.toThrow("constructor failed");
    await expect(
      db
        .select({ token: chatEndpointLeases.token })
        .from(chatEndpointLeases)
        .where(eq(chatEndpointLeases.endpointId, endpoint.id)),
    ).resolves.toEqual([]);
    await service.shutdown();
  });

  it("serializes Discord Gateway health events and recovers transient guild outages", async () => {
    const fixture = await seedCompany();
    const applicationId = uniqueDiscordApplicationId();
    let releaseDisconnect!: () => void;
    let disconnectEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      disconnectEntered = resolve;
    });
    const disconnectBarrier = new Promise<void>((resolve) => {
      releaseDisconnect = resolve;
    });
    const runtime = new FakeChatSdkRuntime();
    const context = createService(
      runtime,
      fakeDiscordFetch(applicationId) as typeof globalThis.fetch,
      {
        discordGatewayEventBarrier: async (callback) => {
          if (callback.event.type !== "disconnected") return;
          disconnectEntered();
          await disconnectBarrier;
        },
      },
    );
    const endpoint = await context.service.create(
      fixture.companyId,
      { provider: "discord", assignedAgentId: fixture.assignedAgentId },
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
    const setup = await db
      .select({ setup: chatEndpoints.setup })
      .from(chatEndpoints)
      .where(eq(chatEndpoints.id, endpoint.id))
      .then((rows) => rows[0]!.setup);
    await db
      .update(chatEndpoints)
      .set({ status: "active", setup: { ...setup, step: "complete" } })
      .where(eq(chatEndpoints.id, endpoint.id));
    const onGatewayEvent = runtime.configurations.get(endpoint.id)?.callbacks
      .onDiscordGatewayEvent;
    if (!onGatewayEvent) throw new Error("Expected Discord Gateway callback");

    const recovered = vi.fn();
    const unsubscribe = subscribeDeliveryWork(db, DELIVERY_QUEUES.chatPublications, recovered);
    const disconnect = Promise.resolve(
      onGatewayEvent({
        endpointId: endpoint.id,
        provider: "discord",
        sequence: 1,
        event: { type: "disconnected", fatal: false, code: 1001 },
      }),
    );
    await entered;
    let recoveryFinished = false;
    const recovery = Promise.resolve(
      onGatewayEvent({
        endpointId: endpoint.id,
        provider: "discord",
        sequence: 2,
        event: { type: "ready" },
      }),
    ).then(() => {
      recoveryFinished = true;
    });
    await Promise.resolve();
    expect(recoveryFinished).toBe(false);
    releaseDisconnect();
    try {
      await Promise.all([disconnect, recovery]);
      expect(recovered).toHaveBeenCalled();
    } finally { unsubscribe(); }
    await expect(context.service.get(endpoint.id)).resolves.toMatchObject({
      status: "active",
      healthMessage: "Connected",
    });

    await onGatewayEvent({
      endpointId: endpoint.id,
      provider: "discord",
      sequence: 3,
      event: {
        type: "guild_unavailable",
        guildId: "1457808928258658549",
      },
    });
    await expect(context.service.get(endpoint.id)).resolves.toMatchObject({
      status: "active",
      healthMessage: expect.stringContaining("temporarily unavailable"),
    });
    await onGatewayEvent({
      endpointId: endpoint.id,
      provider: "discord",
      sequence: 4,
      event: {
        type: "guild_available",
        guildId: "1457808928258658549",
      },
    });
    await expect(context.service.get(endpoint.id)).resolves.toMatchObject({
      status: "active",
      healthMessage: "Connected",
    });
    await context.service.shutdown();
  });
});
