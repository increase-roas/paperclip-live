/**
 * Provider-area fixtures hoisted out of the two chat-channel describes that
 * had to split into several files. They depend on the base harness for the
 * database and the shared seeding helpers.
 */
import {
  githubChatManagementService,
} from "../../services/chat-github-management.js";
import {
  chatActions,
  chatDeliveries,
  chatEndpoints,
  chatExternalPrincipals,
  chatGitHubReviews,
  chatIdentityLinks,
  chatPublications,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  createHash,
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
  vi,
} from "vitest";
import {
  FakeChatSdkRuntime,
  uniqueDiscordApplicationId,
  fakeDiscordFetch,
  makeThread,
  makeMessage,
} from "./chat-channels-fixture.js";
import {
  githubChatReviewService,
} from "../../services/chat-github-reviews.js";
import {
  githubAutomaticReviewEvent,
} from "../../services/chat-github-events.js";
import {
  githubReviewCheckService,
} from "../../services/chat-github-checks.js";
import {
  createDiscordAdapter,
} from "@chat-adapter/discord";
import {
  createChatSdkEndpointRuntime,
} from "../../services/chat-sdk-runtime.js";
import {
  chatWakeContext,
  configuredGitHubEndpoint,
  createService,
  db,
  deliverMessage,
  qualifySetupRoundTrip,
  readChatConversationsByEndpointId,
  readChatEndpointsById,
  readChatGitHubReviewsByEndpointId,
  recoverDiscordCommands,
  retirePublicationFixture,
  seedCompany,
  signedGitHubWebhookRequest,
} from "./chat-channels-harness.js";
import type { Message } from "chat";

export   async function reviewBotFixture() {
    const fixture = await seedCompany();
    const context = await configuredGitHubEndpoint(fixture, {}, true);
    const endpoint = await context.service.get(context.endpoint.id);
    const [principal] = await db
      .insert(chatExternalPrincipals)
      .values({
        companyId: fixture.companyId,
        provider: "github",
        providerAccountId: endpoint.providerAccountId!,
        externalId: "42",
        kind: "user",
        displayName: "Octocat",
        handle: "octocat",
        isBot: false,
      })
      .returning();
    await db.insert(chatIdentityLinks).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      principalId: principal.id,
      paperclipUserId: "owner-user",
      status: "linked",
      confirmedAt: new Date(),
    });
    const management = githubChatManagementService(db, context.providerFetch);
    const initial = await management.configuration(endpoint.id, "owner-user");
    await management.saveConfiguration(
      endpoint.id,
      {
        expectedRevision: initial.revision,
        configuration: { ...initial.configuration, toolsEnabled: true },
      },
      "owner-user",
    );
    await context.service.update(
      endpoint.id,
      { allowGroupChats: true },
      "owner-user",
    );
    return { ...fixture, ...context, endpoint, principal, management };
  }

export   async function subscribedGitHubFixture(threadId = "github:paperclipai/paperclip:issue:419") {
    const f = await reviewBotFixture();
    const thread = makeThread({ channelId: "paperclipai/paperclip", id: threadId }).thread;
    await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
      trigger: "mention", message: makeMessage({ id: "41901", text: `@${f.endpoint.botUsername} start this thread`, userId: "42", userName: "octocat", mentioned: true }) });
    const [conversation] = await readChatConversationsByEndpointId(f.endpoint.id);
    return { ...f, thread, conversation };
  }

export   async function addPeerGitHubBot(f: Awaited<ReturnType<typeof reviewBotFixture>>) {
    const peer = await f.service.create(f.companyId, { provider: "github", assignedAgentId: f.assignedAgentId, name: "Gonzo" }, "owner-user");
    await db.update(chatEndpoints).set({ botUsername: "gonzo[bot]", status: "active" }).where(eq(chatEndpoints.id, peer.id));
    return peer;
  }

export   async function toolReplyFixture(threadId = "github:paperclipai/paperclip:issue:418", reportOnly = false, findingCategories?: string[]) {
    const f = await reviewBotFixture();
    if (reportOnly || findingCategories) {
      const config = await f.management.configuration(f.endpoint.id, "owner-user");
      await f.management.saveConfiguration(f.endpoint.id, { expectedRevision: config.revision,
        configuration: { ...config.configuration, defaults: { ...config.configuration.defaults, ...(reportOnly ? { ratingThreshold: null } : {}), ...(findingCategories ? { findingCategories } : {}) } },
      }, "owner-user");
    }
    const thread = makeThread({ channelId: "paperclipai/paperclip", id: threadId }).thread;
    await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
      trigger: "mention", message: makeMessage({ id: "41801", text: "Are you there?", userId: "42", userName: "octocat", mentioned: true }) });
    const [conversation] = await readChatConversationsByEndpointId(f.endpoint.id);
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.assignedAgentId,
      status: "running", runtimeMode: "native", contextSnapshot: await chatWakeContext({
        endpointId: f.endpoint.id, issueId: conversation.issueId, provider: "github", providerMessageId: "41801",
      }) }).returning();
    const session = { companyId: f.companyId, agentId: f.assignedAgentId, issueId: conversation.issueId, runId: run.id };
    return { ...f, conversation, run, session };
  }

export   async function publicationRetryFixture(findingCategories?: string[]) {
    const f = await toolReplyFixture("github:paperclipai/paperclip:418", true, findingCategories);
    const head = "b".repeat(40);
    const inline: Array<{ id: number; body: string; html_url: string; user: { login: string } }> = [];
    const checks: Array<{ id: number; external_id: string; app: { id: number }; html_url: string }> = [];
    const writes: Array<{ path: string; method: string }> = [];
    const provider = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/pulls/418")) return Response.json({ number: 418, state: "open", draft: false,
        head: { sha: head }, base: { sha: "a".repeat(40), ref: "master" }, user: { id: 42, login: "octocat", type: "User" }, labels: [] });
      if (url.includes("/files?")) return Response.json([{ filename: "src/math.ts", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new" }]);
      if (url.includes("/pulls/418/comments?")) return Response.json(inline);
      if (url.includes("/check-runs?")) return Response.json({ check_runs: checks });
      if (init?.method === "POST" && url.endsWith("/pulls/418/comments")) {
        writes.push({ path: url, method: init.method });
        const item = { id: 420 + inline.length, body: JSON.parse(String(init.body)).body,
          html_url: "https://github.com/acme/repo/pull/418#discussion_r420", user: { login: f.endpoint.botUsername! } };
        inline.push(item);
        return Response.json(item);
      }
      if (url.includes("/check-runs") && init?.method) {
        writes.push({ path: url, method: init.method });
        const body = JSON.parse(String(init.body));
        const check = checks[0] ?? { id: 419, external_id: body.external_id, app: { id: Number(f.endpoint.botExternalId) }, html_url: "https://github.com/checks/419" };
        if (!checks.length) checks.push(check);
        return Response.json(check);
      }
      return undefined;
    };
    f.setSupplementalProviderFetch(provider);
    const service = githubChatReviewService(db, f.providerFetch);
    await service.execute(f.session, "begin_review", { reviewedCommit: head });
    const assessment = { reviewedCommit: head, score: 3, complete: true, summary: "Advisory review", rationale: "Reviewed the file",
      coverage: { reviewedPaths: ["src/math.ts"], omittedPaths: [], limitations: [] }, findings: [] };
    const action = async () => (await db.select().from(chatActions).where(and(
      eq(chatActions.endpointId, f.endpoint.id), eq(chatActions.kind, "github_review_publication"),
    )))[0];
    return { ...f, service, head, assessment, provider, action, inline, checks, writes };
  }

export   async function reviewCheckWorkerFixture(status: "running" | "failed" = "failed") {
    const f = await toolReplyFixture("github:paperclipai/paperclip:418");
    const config = await f.management.configuration(f.endpoint.id, "owner-user");
    const event = githubAutomaticReviewEvent({ action: "opened", repository: { id: 97531, full_name: "paperclipai/paperclip" }, sender: { id: 42, login: "octocat" },
      pull_request: { number: 418, title: "Review", body: "", draft: false, base: { sha: "a".repeat(40), ref: "master" }, head: { sha: "b".repeat(40) }, user: { id: 42, login: "octocat" }, labels: [] } }, randomUUID())!;
    const [review] = await db.insert(chatGitHubReviews).values({ companyId: f.companyId, endpointId: f.endpoint.id,
      issueId: f.conversation.issueId!, runId: f.run.id, repositoryId: "97531", repository: event.repository, pullNumber: 418, headSha: event.headSha,
      deliveryId: event.deliveryId, configurationRevision: config.revision, policySnapshot: config.configuration.defaults, event }).returning();
    await db.update(heartbeatRuns).set({ status }).where(eq(heartbeatRuns.id, f.run.id));
    const writes: Record<string, unknown>[] = [], requests: string[] = [];
    let remoteHead = event.headSha, unavailable = false;
    f.setSupplementalProviderFetch(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/pulls/418")) { requests.push(url); return Response.json({ head: { sha: remoteHead } }); }
      if (url.includes("/check-runs?")) { requests.push(url); return Response.json({ check_runs: [] }); }
      if (url.endsWith("/check-runs") && init?.method === "POST") {
        requests.push(url);
        if (unavailable) return Response.json({ message: "injected check outage" }, { status: 503 });
        writes.push(JSON.parse(String(init.body)));
        return Response.json({ id: 418, html_url: "https://github.com/checks/418" });
      }
      return undefined;
    });
    const checks = githubReviewCheckService(db, f.providerFetch);
    const [endpoint] = await readChatEndpointsById(f.endpoint.id);
    const action = async () => (await db.select().from(chatActions).where(and(eq(chatActions.endpointId, endpoint.id), eq(chatActions.kind, "github_review_check"))))[0];
    return { ...f, event, review, endpoint, checks, writes, requests, action,
      enqueue: () => checks.enqueue(endpoint, event, true, "authorized"),
      setRemoteHead: (value: string) => { remoteHead = value; }, setUnavailable: (value: boolean) => { unavailable = value; } };
  }

export   async function reviewProjectionFixture(cancelFirst = true) {
    const f = await reviewBotFixture();
    const deliveryId = randomUUID();
    const payload = { action: "synchronize", installation: { id: 2468 },
      repository: { id: 97531, full_name: "paperclipai/paperclip", name: "paperclip", owner: { id: 1357, login: "paperclipai" } },
      sender: { id: 42, login: "octocat" },
      pull_request: { number: 82, title: "Rapid pushes", body: "", draft: false,
        base: { sha: "a".repeat(40), ref: "master" }, head: { sha: "b".repeat(40) },
        user: { id: 42, login: "octocat", type: "User" }, labels: [] } };
    f.setSupplementalProviderFetch(async input => String(input).endsWith("/pulls/82")
      ? Response.json({ ...payload.pull_request, head: { sha: "c".repeat(40) } }) : undefined);
    const checks = githubReviewCheckService(db, f.providerFetch);
    const [endpoint] = await readChatEndpointsById(f.endpoint.id);
    const event = githubAutomaticReviewEvent(payload, deliveryId)!;
    await checks.enqueue(endpoint, event, true, "authorized");
    const action = async () => (await db.select().from(chatActions).where(and(
      eq(chatActions.endpointId, endpoint.id), eq(chatActions.kind, "github_review_check"))))[0];
    if (cancelFirst) await checks.processPending();
    const admit = async () => {
      expect((await f.service.handleWebhook(endpoint.publicId, "github", signedGitHubWebhookRequest({
        event: "pull_request", delivery: deliveryId, payload, webhookSecret: f.webhookSecret,
      }))).status).toBeLessThan(300);
      await expect.poll(async () => (await readChatGitHubReviewsByEndpointId(endpoint.id)).length,
        { timeout: 10_000 }).toBe(1);
      return (await readChatGitHubReviewsByEndpointId(endpoint.id))[0];
    };
    const read = async (id: string) => (await db.select().from(chatGitHubReviews).where(eq(chatGitHubReviews.id, id)))[0];
    return { ...f, endpoint, event, action, checks, admit, read };
  }

export   const guildId = "1457808928258658549";

export   const channelId = "333333333333333333";

export   const externalUserId = "444444444444444419";

export   const rootMessageId = "555555555555555619";

export   const registeredCommandId = "888888888888888819";

export   let interactionSequence = 0n;

export   async function commandFixture(companyId?: string) {
    const fixture = await seedCompany(undefined, companyId);
    const applicationId = uniqueDiscordApplicationId();
    let holdWork = false;
    const queued: Array<() => void> = [];
    const remoteCommands: Array<Record<string, unknown>> = [];
    const registrationCalls: string[] = [];
    const providerFetch: typeof globalThis.fetch = async (input, init) => {
      if (
        [
          `/api/v10/applications/${applicationId}/commands`,
          `/api/v10/applications/${applicationId}/commands/${registeredCommandId}`,
        ].includes(new URL(String(input)).pathname)
      ) {
        const method = init?.method ?? "GET";
        registrationCalls.push(method);
        if (method === "GET") return Response.json(remoteCommands);
        if (method !== "POST" && method !== "PATCH")
          throw new Error("Unexpected fixture command request");
        const definition = JSON.parse(String(init?.body));
        const command = {
          ...definition,
          id: registeredCommandId,
          application_id: applicationId,
          version: "999999999999999919",
        };
        if (method === "PATCH")
          remoteCommands.splice(0, remoteCommands.length, command);
        else remoteCommands.push(command);
        return Response.json(command);
      }
      return fakeDiscordFetch(applicationId)(input);
    };
    const context = createService(new FakeChatSdkRuntime(), providerFetch, {
      scheduleDeferredWork(task) {
        if (holdWork) queued.push(task);
        else setImmediate(task);
      },
    });
    const endpoint = await context.service.create(
      fixture.companyId,
      {
        provider: "discord",
        assignedAgentId: fixture.assignedAgentId,
        name: "Discord command fixture",
      },
      "owner-user",
    );
    const identityAdapter = createDiscordAdapter({
      applicationId,
      botToken: "synthetic-identity-only",
      webhookVerifier: async () => false,
    });
    context.runtime.initializeHook = async (endpointId) => {
      if (endpointId !== endpoint.id) return;
      const current = context.runtime.get(endpointId)!;
      const original = current.thread.bind(current);
      // Real pinned source IDs, with data transport only still mocked.
      current.thread = (threadId) => ({
        ...original(threadId),
        channelId: identityAdapter.channelIdFromThreadId(threadId),
        isDM: threadId.startsWith("discord:@me:"),
      });
    };
    await context.service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: { applicationId, botToken: "discord-secret", guildId },
      },
      "owner-user",
    );
    const initialCallbacks = context.runtime.configurations.get(
      endpoint.id,
    )!.callbacks;
    if (!initialCallbacks.onDiscordRootMentionAdmission)
      throw new Error("Discord root fixture callback unavailable");
    const threadId = `discord:${guildId}:${channelId}:${rootMessageId}`;
    await initialCallbacks.onDiscordRootMentionAdmission({
      endpointId: endpoint.id,
      guildId,
      channelId,
      messageId: rootMessageId,
      message: {
        ...makeMessage({
          id: rootMessageId,
          text: "@maya investigate the command fixture",
          mentioned: true,
          userId: externalUserId,
        }),
        threadId,
      } as Message,
      threadId,
      userId: externalUserId,
    });
    const delivery = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(chatDeliveries.providerEventId, `${threadId}:${rootMessageId}`),
        ),
      )
      .then((rows) => rows[0]);
    if (!delivery) throw new Error("Discord command setup delivery absent");
    await context.service.processPendingDeliveries(25, delivery.id);
    await qualifySetupRoundTrip(context.service, endpoint.id, externalUserId);
    await context.service.test(endpoint.id);
    await context.service.reconcileProviderRuntimes();
    const callbacks = context.runtime.configurations.get(
      endpoint.id,
    )!.callbacks;
    if (!callbacks.onSlashCommand)
      throw new Error("Registered Discord command callback unavailable");
    const [conversation] = await context.service.listConversations(
      endpoint.id,
    );
    if (!conversation) throw new Error("Discord command conversation absent");
    const principal = await db
      .select()
      .from(chatExternalPrincipals)
      .where(
        and(
          eq(chatExternalPrincipals.companyId, fixture.companyId),
          eq(chatExternalPrincipals.provider, "discord"),
          eq(chatExternalPrincipals.providerAccountId, guildId),
          eq(chatExternalPrincipals.externalId, externalUserId),
        ),
      )
      .then((rows) => rows[0]);
    if (!principal) throw new Error("Discord command principal absent");
    const intent = await context.service.createLinkIntent(
      endpoint.id,
      principal.id,
      1800,
    );
    await context.service.confirmIdentityLink(
      new URL(intent.confirmationUrl).searchParams.get("token")!,
      "owner-user",
    );
    const scope = {
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      applicationId,
      guildId,
    };
    expect(
      registrationCalls.filter((method) => method === "POST"),
    ).toHaveLength(1);
    holdWork = true;
    const pinnedRuntimes: Array<
      ReturnType<typeof createChatSdkEndpointRuntime>
    > = [];
    const coldContexts: Array<ReturnType<typeof createService>> = [];
    async function parser(
      configuration = context.runtime.configurations.get(endpoint.id)!,
    ) {
      const pinned = createChatSdkEndpointRuntime({
        ...configuration,
        callbacks: {
          onMessage() {},
          onSlashCommand: configuration.callbacks.onSlashCommand,
        },
        enableDiscordGateway: false,
        logger: "silent",
      });
      pinnedRuntimes.push(pinned);
      await pinned.initialize();
      return pinned.getProviderAdapter() as unknown as {
        handleGatewayInteraction(input: unknown): Promise<void>;
      };
    }
    const adapter = await parser();
    const interaction = (
      command: "status" | "new" | "close",
      overrides: Record<string, unknown> = {},
    ) => ({
      id: (
        ((BigInt(Date.now()) - 1420070400000n) << 22n) +
        interactionSequence++
      ).toString(),
      applicationId,
      commandId: registeredCommandId,
      commandName: "paperclip",
      commandType: 1,
      type: 2,
      version: 1,
      context: 0,
      guildId,
      channelId: rootMessageId,
      channel: { id: rootMessageId, parentId: channelId, type: 11 },
      authorizingIntegrationOwners: { guildId, userId: null },
      user: {
        id: externalUserId,
        username: "operator",
        globalName: "Operator",
        bot: false,
        discriminator: "0",
      },
      options: { data: [{ name: command, type: 1 }] },
      createdTimestamp: Date.now(),
      token: "synthetic-command-interaction-token",
      isChatInputCommand: () => true,
      isModalSubmit: () => false,
      isMessageComponent: () => false,
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      deferred: false,
      replied: false,
      ...overrides,
    });
    const actions = () =>
      db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(chatActions.kind, "discord_native_command"),
          ),
        )
        .orderBy(asc(chatActions.createdAt));
    const publications = () =>
      db
        .select()
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.endpointId, endpoint.id),
            like(chatPublications.idempotencyKey, "control:%"),
          ),
        );
    return {
      ...context,
      fixture,
      endpoint,
      callbacks,
      conversation,
      applicationId,
      principal,
      scope,
      adapter,
      parser,
      interaction,
      actions,
      publications,
      queued,
      registrationCalls,
      async coldUnavailableParser(legacyCopy = false) {
        await context.service.shutdown();
        await db
          .update(chatEndpoints)
          .set({
            capabilities: { ...endpoint.capabilities, slashCommands: false },
          })
          .where(eq(chatEndpoints.id, endpoint.id));
        const registration = await db
          .select()
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, endpoint.id),
              eq(chatActions.kind, "discord_command_registration"),
            ),
          )
          .then((rows) => rows[0]!);
        let priorRegistration = registration.payload.registration;
        if (legacyCopy) {
          const prior = structuredClone(remoteCommands[0]!);
          (prior.options as Array<{ description: string }>)[2]!.description =
            "Close the current Paperclip task";
          remoteCommands[0] = prior;
          const {
            id: _id,
            application_id: _application,
            version: _version,
            ...definition
          } = prior;
          const stored = priorRegistration as {
            receipt: Record<string, unknown>;
          };
          priorRegistration = {
            ...stored,
            receipt: {
              ...stored.receipt,
              definitionDigest: createHash("sha256")
                .update(JSON.stringify(definition))
                .digest("hex"),
            },
          };
        }
        await db
          .update(chatActions)
          .set({
            payload: { registration: priorRegistration },
            result: {
              schema: "paperclip.discord.command-registration-result.v1",
              outcome: legacyCopy ? "registered" : "unavailable",
              retryAt: legacyCopy
                ? new Date(0).toISOString()
                : new Date(Date.now() + 60_000).toISOString(),
            },
          })
          .where(
            and(
              eq(chatActions.endpointId, endpoint.id),
              eq(chatActions.kind, "discord_command_registration"),
            ),
          );
        const cold = createService(new FakeChatSdkRuntime(), providerFetch, {
          scheduleDeferredWork(task) {
            queued.push(task);
          },
        });
        coldContexts.push(cold);
        await cold.service.reconcileProviderRuntimes();
        await recoverDiscordCommands(cold.service);
        return {
          ...cold,
          adapter: await parser(
            cold.runtime.configurations.get(endpoint.id)!,
          ),
        };
      },
      async close() {
        try {
          await Promise.all(
            pinnedRuntimes.map((pinned) => pinned.shutdown()),
          );
        } finally {
          try {
            await Promise.all(
              coldContexts.map((cold) => cold.service.shutdown()),
            );
          } finally {
            await retirePublicationFixture(context.service, endpoint.id);
          }
        }
      },
    };
  }
