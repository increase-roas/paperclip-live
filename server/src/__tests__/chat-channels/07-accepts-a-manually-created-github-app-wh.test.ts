import {
  idleWorkSnapshot,
} from "../../services/task-admission.js";
import {
  createDeliveryWorkCoordinator,
} from "../../services/delivery-work-coordinator.js";
import {
  generateKeyPairSync,
  randomUUID,
} from "node:crypto";
import {
  and,
  asc,
  eq,
  inArray,
} from "drizzle-orm";
import {
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import {
  activityLog,
  authUsers,
  chatActions,
  chatDeliveries,
  chatEndpointLeases,
  chatEndpoints,
  chatExternalPrincipals,
  companyMemberships,
  companySecrets,
  issueComments,
  toolConnections,
} from "@paperclipai/db";
import {
  type ChatChannelService,
} from "../../services/chat-channels.js";
import {
  logActivity,
} from "../../services/activity-log.js";
import {
  FakeChatSdkRuntime,
  fakeDiscordFetch,
  fakeSlackFetch,
  makeMessage,
  makeThread,
  routesApp,
  uniqueDiscordApplicationId,
} from ".././helpers/chat-channels-fixture.js";
import {
  configuredSlackEndpoint,
  createService,
  db,
  deliverMessage,
  describeChatChannelsSuite,
  githubWebhookVerificationResponse,
  qualifySetupRoundTrip,
  readChatConversationsByEndpointId,
  readChatDeliveriesByEndpointId,
  readChatDeliveriesById,
  readChatPublicationsById,
  readToolConnectionsById,
  recordGitHubWebhookVerification,
  seedCompany,
  signedGitHubWebhookRequest,
  configuredGitHubEndpoint,
} from "../helpers/chat-channels-harness.js";
import request, {  } from "supertest";
import type { InternalSetupState } from "../../services/chat-channels/runtime-types.js";

describeChatChannelsSuite("chat channels 07-accepts-a-manually-created-github-app-wh", () => {
  it("accepts a manually created GitHub App when /app lists only selectable webhook events", async () => {
    const fixture = await seedCompany();
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    const providerFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://api.github.com/app") {
        return new Response(
          JSON.stringify({
            id: 991124,
            slug: "maya-selectable-events",
            name: "Maya Selectable Events",
            owner: { login: "paperclipai" },
            permissions: {
              issues: "write",
              metadata: "read",
              pull_requests: "write",
            },
            events: ["issue_comment", "pull_request_review_comment"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === "https://api.github.com/app/installations?per_page=100") {
        return new Response(
          JSON.stringify([
            {
              id: 2468,
              account: {
                id: 1357,
                login: "paperclipai",
                type: "Organization",
              },
              permissions: {
                issues: "write",
                metadata: "read",
                pull_requests: "write",
              },
              suspended_at: null,
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (
        url === "https://api.github.com/app/installations/2468/access_tokens"
      ) {
        return new Response(
          JSON.stringify({ token: "selectable-events-installation-token" }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      if (
        url ===
        "https://api.github.com/installation/repositories?per_page=100&page=1"
      ) {
        return new Response(
          JSON.stringify({
            repositories: [
              {
                id: 97531,
                full_name: "paperclipai/paperclip",
                html_url: "https://github.com/paperclipai/paperclip",
                owner: { id: 1357, login: "paperclipai" },
                private: false,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected provider request: ${url}`);
    }) as typeof globalThis.fetch;
    const { service } = createService(new FakeChatSdkRuntime(), providerFetch);
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "github", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    const { webhookSecret } = await service.generateSetupSecret(
      endpoint.id,
      "owner-user",
    );
    await recordGitHubWebhookVerification(
      service,
      endpoint.publicId,
      webhookSecret,
    );

    await expect(
      service.configure(
        endpoint.id,
        { action: "configure", credentials: { appId: "991124", privateKey } },
        "owner-user",
      ),
    ).resolves.toMatchObject({
      status: "verifying",
      providerAccountId: "paperclipai",
      botExternalId: "991124",
      botUsername: "maya-selectable-events[bot]",
    });
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "paperclipai/paperclip",
        availability: "available",
      }),
    ]);
    await service.shutdown();
  });

  it("rejects over-scoped GitHub Apps while tolerating unavoidable lifecycle events", async () => {
    const fixture = await seedCompany();
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    const { service } = createService(new FakeChatSdkRuntime(), (async (
      input: string | URL | Request,
    ) => {
      if (String(input) !== "https://api.github.com/app") {
        throw new Error(`Unexpected provider request: ${String(input)}`);
      }
      return new Response(
        JSON.stringify({
          id: 991123,
          slug: "maya-over-scoped",
          name: "Maya Over-scoped",
          owner: { login: "paperclipai" },
          permissions: {
            contents: "write",
            issues: "write",
            metadata: "read",
            pull_requests: "write",
          },
          events: [
            "github_app_authorization",
            "installation",
            "installation_repositories",
            "issue_comment",
            "pull_request_review_comment",
            "push",
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof globalThis.fetch);
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "github", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    const { webhookSecret } = await service.generateSetupSecret(
      endpoint.id,
      "owner-user",
    );
    await recordGitHubWebhookVerification(
      service,
      endpoint.publicId,
      webhookSecret,
    );

    await expect(
      service.configure(
        endpoint.id,
        { action: "configure", credentials: { appId: "991123", privateKey } },
        "owner-user",
      ),
    ).rejects.toMatchObject({
      status: 422,
      details: {
        code: "chat_provider_permissions_missing",
        provider: "github",
        missingPermissions: [],
        excessivePermissions: ["contents"],
        missingEvents: [],
        excessiveEvents: ["push"],
      },
    });
    const [connection] = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));
    expect(connection!.refs).toEqual([
      expect.objectContaining({ configPath: "credentials.webhookSecret" }),
    ]);
  });

  it.each(["slack", "discord", "github"] as const)("preserves the public inventory error response for %s", async (provider) => {
    const fixture = await seedCompany();
    let failInventory = false;
    let service: ChatChannelService;
    let endpoint: Awaited<ReturnType<ChatChannelService["create"]>>;
    if (provider === "slack") {
      const successfulFetch = fakeSlackFetch();
      const context = await configuredSlackEndpoint(fixture, {
        fetch: (async (input, init) => {
          if (failInventory && String(input).includes("/conversations.list"))
            throw new Error("inventory fixture outage");
          return successfulFetch(input, init);
        }) as typeof fetch,
      });
      ({ service, endpoint } = context);
    } else if (provider === "discord") {
      const applicationId = uniqueDiscordApplicationId();
      const successfulFetch = fakeDiscordFetch(applicationId);
      const context = createService(new FakeChatSdkRuntime(), (async (input) => {
        if (failInventory && new URL(String(input)).pathname.endsWith("/channels"))
          throw new Error("inventory fixture outage");
        return successfulFetch(input);
      }) as typeof fetch);
      service = context.service;
      endpoint = await service.create(fixture.companyId, {
        provider, assignedAgentId: fixture.assignedAgentId,
      }, "owner-user");
      await service.configure(endpoint.id, {
        action: "configure",
        credentials: { applicationId, botToken: "discord-secret", guildId: "1457808928258658549" },
      }, "owner-user");
    } else {
      const context = await configuredGitHubEndpoint(fixture);
      ({ service, endpoint } = context);
      context.setSupplementalProviderFetch(async (input) => {
        if (failInventory && String(input).includes("/app/installations?"))
          throw new Error("inventory fixture outage");
        return undefined;
      });
    }
    const [before] = await readToolConnectionsById(endpoint.connectionId);
    failInventory = true;
    const response = await request(routesApp(db, fixture.companyId, service))
      .post(`/api/chat-endpoints/${endpoint.id}/setup`)
      .send({ action: "reconnect" });
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      error: expect.stringContaining("inventory fixture outage"),
      details: { code: "chat_provider_inventory_failed" },
    });
    const [after] = await readToolConnectionsById(endpoint.connectionId);
    expect(after.credentialSecretRefs).toEqual(before.credentialSecretRefs);
  });

  it("rejects under-scoped Slack and GitHub apps before saving provider credentials", async () => {
    const fixture = await seedCompany();
    const slack = createService(new FakeChatSdkRuntime(), (async (
      input: string | URL | Request,
    ) => {
      if (String(input) !== "https://slack.com/api/auth.test") {
        throw new Error(`Unexpected provider request: ${String(input)}`);
      }
      return new Response(
        JSON.stringify({
          ok: true,
          team_id: "T-UNDER-SCOPED",
          team: "Under-scoped",
          user_id: "U-UNDER-SCOPED",
          user: "maya-under-scoped",
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-oauth-scopes": "chat:write",
          },
        },
      );
    }) as typeof globalThis.fetch);
    const slackEndpoint = await slack.service.create(
      fixture.companyId,
      { provider: "slack", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await expect(
      slack.service.configure(
        slackEndpoint.id,
        {
          action: "configure",
          credentials: {
            botToken: "xoxb-under-scoped",
            signingSecret: "signing-secret",
          },
        },
        "owner-user",
      ),
    ).rejects.toMatchObject({
      status: 422,
      details: {
        code: "chat_provider_permissions_missing",
        provider: "slack",
      },
    });

    const appId = "991122";
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    const github = createService(new FakeChatSdkRuntime(), (async (
      input: string | URL | Request,
    ) => {
      if (String(input) !== "https://api.github.com/app") {
        throw new Error(`Unexpected provider request: ${String(input)}`);
      }
      return new Response(
        JSON.stringify({
          id: 991122,
          slug: "maya-under-scoped",
          name: "Maya Under-scoped",
          owner: { login: "paperclipai" },
          permissions: {
            issues: "read",
            metadata: "read",
            pull_requests: "write",
          },
          events: ["issue_comment"],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof globalThis.fetch);
    const githubEndpoint = await github.service.create(
      fixture.companyId,
      { provider: "github", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    const { webhookSecret } = await github.service.generateSetupSecret(
      githubEndpoint.id,
      "owner-user",
    );
    await recordGitHubWebhookVerification(
      github.service,
      githubEndpoint.publicId,
      webhookSecret,
    );
    await expect(
      github.service.configure(
        githubEndpoint.id,
        {
          action: "configure",
          credentials: {
            appId,
            privateKey,
          },
        },
        "owner-user",
      ),
    ).rejects.toMatchObject({
      status: 422,
      details: {
        code: "chat_provider_permissions_missing",
        provider: "github",
        missingPermissions: ["issues"],
      },
    });

    const connections = await db
      .select({
        id: toolConnections.id,
        refs: toolConnections.credentialSecretRefs,
      })
      .from(toolConnections)
      .where(
        inArray(toolConnections.id, [
          slackEndpoint.connectionId,
          githubEndpoint.connectionId,
        ]),
      );
    expect(
      connections.find(
        (connection) => connection.id === slackEndpoint.connectionId,
      )?.refs,
    ).toEqual([]);
    expect(
      connections.find(
        (connection) => connection.id === githubEndpoint.connectionId,
      )?.refs,
    ).toEqual([
      expect.objectContaining({ configPath: "credentials.webhookSecret" }),
    ]);
  });

  it("rotates a live GitHub webhook secret fail-closed and reconnects with stored credentials", async () => {
    const fixture = await seedCompany();
    const { endpoint, runtime, service } =
      await configuredGitHubEndpoint(fixture);
    await db
      .update(chatEndpoints)
      .set({ status: "active", setup: { step: "complete" } })
      .where(eq(chatEndpoints.id, endpoint.id));

    const { webhookSecret } = await service.generateSetupSecret(
      endpoint.id,
      "owner-user",
    );
    expect(webhookSecret).toMatch(/^[a-f0-9]{64}$/);
    expect(runtime.endpoints.has(endpoint.id)).toBe(false);
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "attention",
      healthMessage:
        "Update the GitHub webhook secret, then reconnect this App",
      setup: { step: "provider_setup", webhookSecretConfigured: true },
    });
    const [disabledConnection] = await db
      .select({
        status: toolConnections.status,
        enabled: toolConnections.enabled,
        healthStatus: toolConnections.healthStatus,
      })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));
    expect(disabledConnection).toEqual({
      status: "disabled",
      enabled: false,
      healthStatus: "degraded",
    });
    await recordGitHubWebhookVerification(
      service,
      endpoint.publicId,
      webhookSecret,
    );

    const reconnected = await service.configure(
      endpoint.id,
      { action: "reconnect" },
      "owner-user",
    );

    expect(reconnected).toMatchObject({
      status: "verifying",
      setup: { step: "test", webhookSecretConfigured: true },
    });
    expect(
      runtime.configurations.get(endpoint.id)?.providerConfig,
    ).toMatchObject({
      provider: "github",
      credentials: {
        appId: "123456",
        webhookSecret,
      },
    });
    expect(JSON.stringify(reconnected)).not.toContain(webhookSecret);
  });

  it("reveals a rotated GitHub secret despite a later completion-audit failure and makes retry a new rotation", async () => {
    const fixture = await seedCompany();
    let failedAuditAction: string | null = null;
    let failCredentialPersistence = false;
    const setupSecretActivityLogger: typeof logActivity = async (
      database,
      input,
      publications,
    ) => {
      if (failedAuditAction === input.action) {
        failedAuditAction = null;
        throw new Error("simulated setup-secret audit outage");
      }
      return logActivity(database, input, publications);
    };
    const setupSecretCredentialPersistBarrier = async () => {
      if (!failCredentialPersistence) return;
      failCredentialPersistence = false;
      throw new Error("simulated setup-secret credential persistence outage");
    };
    const {
      endpoint,
      runtime,
      service,
      webhookSecret: originalSecret,
    } = await configuredGitHubEndpoint(fixture, {
      setupSecretActivityLogger,
      setupSecretCredentialPersistBarrier,
    });

    failedAuditAction = "chat_endpoint.setup_secret_rotation_started";
    await expect(
      service.generateSetupSecret(endpoint.id, "owner-user"),
    ).rejects.toThrow("simulated setup-secret audit outage");
    expect(runtime.endpoints.has(endpoint.id)).toBe(true);
    await expect(
      githubWebhookVerificationResponse(
        service,
        endpoint.publicId,
        originalSecret,
      ),
    ).resolves.toMatchObject({
      status: 200,
    });

    const [refsBeforePersistenceFailure] = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));
    failCredentialPersistence = true;
    await expect(
      service.generateSetupSecret(endpoint.id, "owner-user"),
    ).rejects.toThrow("simulated setup-secret credential persistence outage");
    const [refsAfterPersistenceFailure] = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));
    expect(refsAfterPersistenceFailure!.refs).toEqual(
      refsBeforePersistenceFailure!.refs,
    );
    expect(runtime.endpoints.has(endpoint.id)).toBe(false);
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "attention",
      healthMessage:
        "Update the GitHub webhook secret, then reconnect this App",
      setup: { step: "provider_setup", webhookSecretConfigured: true },
    });
    await expect(
      githubWebhookVerificationResponse(
        service,
        endpoint.publicId,
        originalSecret,
      ),
    ).resolves.toMatchObject({
      status: 200,
    });

    failedAuditAction = "chat_endpoint.setup_secret_generated";
    const first = await service.generateSetupSecret(endpoint.id, "owner-user");
    expect(first.webhookSecret).toMatch(/^[a-f0-9]{64}$/);
    expect(first.webhookSecret).not.toBe(originalSecret);
    expect(runtime.endpoints.has(endpoint.id)).toBe(false);
    await expect(
      githubWebhookVerificationResponse(
        service,
        endpoint.publicId,
        originalSecret,
      ),
    ).resolves.toMatchObject({
      status: 401,
    });
    await expect(
      githubWebhookVerificationResponse(
        service,
        endpoint.publicId,
        first.webhookSecret,
      ),
    ).resolves.toMatchObject({ status: 200 });
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "attention",
      setup: {
        step: "provider_setup",
        webhookSecretConfigured: true,
      },
    });

    // A caller that lost the successful response may explicitly retry. That
    // retry is another serialized rotation: only the newly returned value is
    // valid, so the caller can converge without reusing hidden plaintext.
    const second = await service.generateSetupSecret(endpoint.id, "owner-user");
    expect(second.webhookSecret).toMatch(/^[a-f0-9]{64}$/);
    expect(second.webhookSecret).not.toBe(first.webhookSecret);
    await expect(
      githubWebhookVerificationResponse(
        service,
        endpoint.publicId,
        first.webhookSecret,
      ),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      githubWebhookVerificationResponse(
        service,
        endpoint.publicId,
        second.webhookSecret,
      ),
    ).resolves.toMatchObject({ status: 200 });

    const auditRows = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.entityId, endpoint.connectionId));
    const started = auditRows.filter(
      (row) => row.action === "chat_endpoint.setup_secret_rotation_started",
    );
    const completed = auditRows.filter(
      (row) => row.action === "chat_endpoint.setup_secret_generated",
    );
    const failed = auditRows.filter(
      (row) => row.action === "chat_endpoint.setup_secret_rotation_failed",
    );
    expect(started).toHaveLength(4);
    expect(completed).toHaveLength(2);
    expect(failed).toHaveLength(1);
    const startedRotationIds = started.map((row) => row.details!.rotationId);
    const terminalRotationIds = new Set(
      [...completed, ...failed].map((row) => row.details!.rotationId),
    );
    expect(
      startedRotationIds.filter(
        (rotationId) => !terminalRotationIds.has(rotationId),
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(auditRows)).not.toContain(first.webhookSecret);
    expect(JSON.stringify(auditRows)).not.toContain(second.webhookSecret);
  });

  it("replaces a pre-connect GitHub webhook secret without inventing a broken existing App", async () => {
    const fixture = await seedCompany();
    const { service } = createService();
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "github", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    const first = await service.generateSetupSecret(endpoint.id, "owner-user");
    await recordGitHubWebhookVerification(
      service,
      endpoint.publicId,
      first.webhookSecret,
    );

    const second = await service.generateSetupSecret(endpoint.id, "owner-user");

    expect(second.webhookSecret).not.toBe(first.webhookSecret);
    await expect(
      githubWebhookVerificationResponse(
        service,
        endpoint.publicId,
        first.webhookSecret,
      ),
    ).resolves.toMatchObject({ status: 401 });
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "draft",
      providerAccountId: null,
      botExternalId: null,
      healthMessage: null,
      setup: {
        step: "provider_setup",
        webhookSecretConfigured: true,
        webhookVerifiedAt: null,
      },
    });
    const [connection] = await db
      .select({
        status: toolConnections.status,
        enabled: toolConnections.enabled,
        healthStatus: toolConnections.healthStatus,
        refs: toolConnections.credentialSecretRefs,
      })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));
    expect(connection).toMatchObject({
      status: "draft",
      enabled: false,
      healthStatus: "unchecked",
      refs: [
        expect.objectContaining({
          configPath: "credentials.webhookSecret",
        }),
      ],
    });

    await recordGitHubWebhookVerification(
      service,
      endpoint.publicId,
      second.webhookSecret,
    );
    const setupActions = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.entityId, endpoint.connectionId));
    const generatedActions = setupActions.filter(
      (item) => item.action === "chat_endpoint.setup_secret_generated",
    );
    expect(generatedActions).toHaveLength(2);
    expect(generatedActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          details: expect.objectContaining({
            rotated: false,
            replacedPrevious: false,
          }),
        }),
        expect.objectContaining({
          details: expect.objectContaining({
            rotated: false,
            replacedPrevious: true,
          }),
        }),
      ]),
    );
    expect(
      setupActions.filter(
        (item) => item.action === "chat_endpoint.webhook_verified",
      ),
    ).toHaveLength(2);
  });

  it("preserves GitHub webhook verification through setup completion and reconnect", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service } =
      await configuredGitHubEndpoint(fixture);
    const setupThread = makeThread({
      channelId: "paperclipai/paperclip",
      id: "github:paperclipai/paperclip:issue:811",
      name: "paperclipai/paperclip",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "github",
      thread: setupThread.thread,
      message: makeMessage({
        id: "github-setup-root-811",
        text: "@maya-paperclip[bot] verify setup state",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id);

    const [reply] = await db.select().from(chatActions).where(and(eq(chatActions.endpointId, endpoint.id), eq(chatActions.kind, "github_review_publication")));
    await db.update(chatActions).set({ status: "processing" }).where(eq(chatActions.id, reply.id));
    await expect(service.test(endpoint.id)).rejects.toThrow("Wait for the Paperclip agent to reply");
    await db.update(chatActions).set({ status: "processed" }).where(eq(chatActions.id, reply.id));
    const activated = await service.test(endpoint.id);
    expect(activated).toMatchObject({
      status: "active",
      setup: {
        step: "complete",
        webhookVerifiedAt: expect.any(String),
      },
    });
    const verifiedAt = activated.setup.webhookVerifiedAt;

    const reconnected = await service.configure(
      endpoint.id,
      { action: "reconnect" },
      "owner-user",
    );
    expect(reconnected).toMatchObject({
      status: "verifying",
      setup: {
        step: "test",
        webhookVerifiedAt: verifiedAt,
      },
    });
    const [stored] = await db
      .select({ setup: chatEndpoints.setup })
      .from(chatEndpoints)
      .where(eq(chatEndpoints.id, endpoint.id));
    expect(stored!.setup).toMatchObject({
      step: "test",
      webhookVerifiedAt: verifiedAt,
      runtimeGeneration: expect.any(Number),
    });
  });

  it("repairs the same GitHub App webhook on reconnect without claiming a fresh signed ping or chat round trip", async () => {
    const fixture = await seedCompany();
    const { endpoint, service, webhookSecret, webhookSyncRequests } =
      await configuredGitHubEndpoint(fixture);
    const before = await service.get(endpoint.id);
    expect(webhookSyncRequests).toHaveLength(0);
    const [storedBefore] = await db
      .select({ setup: chatEndpoints.setup })
      .from(chatEndpoints)
      .where(eq(chatEndpoints.id, endpoint.id));
    const refsBefore = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));
    const repaired = await service.configure(
      endpoint.id,
      { action: "reconnect" },
      "owner-user",
    );
    expect(webhookSyncRequests).toEqual([
      {
        url: before.setup.webhookUrl,
        content_type: "json",
        insecure_ssl: "0",
        secret: webhookSecret,
      },
    ]);
    expect(repaired).toMatchObject({
      id: endpoint.id,
      assignedAgentId: fixture.assignedAgentId,
      botExternalId: before.botExternalId,
      status: "verifying",
      setup: {
        step: "test",
        webhookVerifiedAt: before.setup.webhookVerifiedAt,
      },
    });
    const [storedRepair] = await db
      .select({
        lastEventAt: chatEndpoints.lastEventAt,
        setup: chatEndpoints.setup,
      })
      .from(chatEndpoints)
      .where(eq(chatEndpoints.id, endpoint.id));
    expect(storedRepair?.lastEventAt).toBeNull();
    expect(storedRepair?.setup?.testStartedAt).not.toBe(
      storedBefore?.setup?.testStartedAt,
    );
    expect((storedRepair?.setup as InternalSetupState | undefined)?.runtimeGeneration).toBe(
      Number((storedBefore?.setup as InternalSetupState | undefined)?.runtimeGeneration) + 1,
    );
    await expect(service.test(endpoint.id)).rejects.toMatchObject({
      details: { code: "chat_test_message_missing" },
    });
    expect(
      await db
        .select({ refs: toolConnections.credentialSecretRefs })
        .from(toolConnections)
        .where(eq(toolConnections.id, endpoint.connectionId)),
    ).toEqual(refsBefore);
    const audits = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.entityId, endpoint.connectionId));
    expect(audits).toContainEqual({
      action: "chat_endpoint.webhook_sync_started",
      details: { endpointId: endpoint.id, provider: "github" },
    });
    expect(audits).toContainEqual({
      action: "chat_endpoint.webhook_synced",
      details: { endpointId: endpoint.id, provider: "github" },
    });
    expect(JSON.stringify({ repaired, audits })).not.toContain(webhookSecret);
    await service.configure(endpoint.id, { action: "reconnect" }, "owner-user");
    expect(webhookSyncRequests).toHaveLength(2);
    expect(webhookSyncRequests[1]).toEqual(webhookSyncRequests[0]);
  });

  it.each(["http", "transport", "malformed", "mismatch", "oversized"])(
    "leaves GitHub reconnect unqualified after a %s webhook repair failure",
    async (failure) => {
      const fixture = await seedCompany();
      const {
        endpoint,
        service,
        runtime,
        webhookSecret,
        setWebhookSyncResponse,
      } = await configuredGitHubEndpoint(fixture);
      setWebhookSyncResponse(async () => {
        if (failure === "transport")
          throw new Error(`private provider echo ${webhookSecret}`);
        if (failure === "http")
          return new Response(webhookSecret, { status: 403 });
        if (failure === "oversized") return new Response(" ".repeat(32_769));
        if (failure === "malformed") return new Response(webhookSecret);
        return new Response(
          JSON.stringify({
            url: `https://bad.example/${webhookSecret}`,
            content_type: "json",
            insecure_ssl: "0",
          }),
        );
      });
      await expect(
        service.configure(endpoint.id, { action: "reconnect" }, "owner-user"),
      ).rejects.toMatchObject({
        details: { code: "chat_provider_setup_failed" },
      });
      expect(runtime.endpoints.has(endpoint.id)).toBe(false);
      const failed = await service.get(endpoint.id);
      expect(failed).toMatchObject({ status: "attention" });
      const audits = await db
        .select({ action: activityLog.action, details: activityLog.details })
        .from(activityLog)
        .where(eq(activityLog.entityId, endpoint.connectionId));
      expect(audits.map((row) => row.action)).toContain(
        "chat_endpoint.webhook_sync_started",
      );
      expect(audits.map((row) => row.action)).not.toContain(
        "chat_endpoint.webhook_synced",
      );
      expect(audits.map((row) => row.action)).not.toContain(
        "chat_endpoint.reconnected",
      );
      expect(JSON.stringify({ failed, audits })).not.toContain(webhookSecret);
      await expect(service.test(endpoint.id)).rejects.toMatchObject({
        details: { code: "chat_endpoint_not_testing" },
      });
    },
  );

  it("does not complete GitHub webhook repair or overwrite a new credential lease owner after remote success", async () => {
    const fixture = await seedCompany();
    const {
      endpoint,
      service,
      runtime,
      setWebhookSyncResponse,
      webhookSyncRequests,
    } = await configuredGitHubEndpoint(fixture);
    setWebhookSyncResponse(async () => {
      await db
        .update(chatEndpointLeases)
        .set({ token: randomUUID() })
        .where(
          and(
            eq(chatEndpointLeases.endpointId, endpoint.id),
            eq(chatEndpointLeases.leaseKey, "credentials"),
          ),
        );
      await db
        .update(chatEndpoints)
        .set({ status: "attention", healthMessage: "Winning lease state" })
        .where(eq(chatEndpoints.id, endpoint.id));
      const config = webhookSyncRequests.at(-1)!;
      return new Response(
        JSON.stringify({
          url: config.url,
          content_type: "json",
          insecure_ssl: "0",
        }),
      );
    });
    await expect(
      service.configure(endpoint.id, { action: "reconnect" }, "owner-user"),
    ).rejects.toMatchObject({ code: "CHAT_CREDENTIAL_LEASE_LOST" });
    expect(runtime.endpoints.has(endpoint.id)).toBe(false);
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "attention",
      healthMessage: "Winning lease state",
    });
    const audits = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.entityId, endpoint.connectionId));
    expect(audits.map((row) => row.action)).not.toContain(
      "chat_endpoint.webhook_synced",
    );
    expect(audits.map((row) => row.action)).not.toContain(
      "chat_endpoint.reconnected",
    );
  });

  it("serializes concurrent GitHub setup-secret requests without losing stored credentials", async () => {
    const fixture = await seedCompany();
    const { endpoint, runtime, service } =
      await configuredGitHubEndpoint(fixture);
    const app = routesApp(db, fixture.companyId, service);

    const [first, second] = await Promise.all([
      request(app)
        .post(`/api/chat-endpoints/${endpoint.id}/setup-secret`)
        .send({})
        .expect(201),
      request(app)
        .post(`/api/chat-endpoints/${endpoint.id}/setup-secret`)
        .send({})
        .expect(201),
    ]);
    const rotatedSecrets = [
      first.body.webhookSecret as string,
      second.body.webhookSecret as string,
    ];
    expect(rotatedSecrets[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(rotatedSecrets[1]).toMatch(/^[a-f0-9]{64}$/);
    expect(rotatedSecrets[0]).not.toBe(rotatedSecrets[1]);

    const [connection] = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));
    expect(connection!.refs.map((ref) => ref.configPath).sort()).toEqual([
      "credentials.appId",
      "credentials.installationId",
      "credentials.privateKey",
      "credentials.webhookSecret",
    ]);
    await expect(
      db
        .select()
        .from(activityLog)
        .where(
          and(
            eq(activityLog.entityId, endpoint.connectionId),
            eq(activityLog.action, "chat_endpoint.setup_secret_generated"),
          ),
        ),
    ).resolves.toHaveLength(3);
    await expect(
      db
        .select()
        .from(chatEndpointLeases)
        .where(eq(chatEndpointLeases.endpointId, endpoint.id)),
    ).resolves.toHaveLength(0);

    let currentWebhookSecret: string | null = null;
    for (const candidate of rotatedSecrets) {
      const response = await githubWebhookVerificationResponse(
        service,
        endpoint.publicId,
        candidate,
      );
      if (response.status === 200) currentWebhookSecret = candidate;
    }
    expect(currentWebhookSecret).not.toBeNull();
    await service.configure(endpoint.id, { action: "reconnect" }, "owner-user");
    const providerConfig = runtime.configurations.get(
      endpoint.id,
    )?.providerConfig;
    expect(providerConfig).toMatchObject({
      provider: "github",
      credentials: {
        appId: "123456",
        installationId: 2468,
        privateKey: expect.stringContaining("BEGIN PRIVATE KEY"),
      },
    });
    if (providerConfig?.provider !== "github")
      throw new Error("Expected GitHub provider configuration");
    expect(providerConfig.credentials.webhookSecret).toBe(currentWebhookSecret);
  });

  it("serializes a GitHub secret rotation racing reconnect and preserves the rotated secret", async () => {
    const fixture = await seedCompany();
    const { endpoint, runtime, service } =
      await configuredGitHubEndpoint(fixture);
    const app = routesApp(db, fixture.companyId, service);

    const [rotation, reconnect] = await Promise.all([
      request(app)
        .post(`/api/chat-endpoints/${endpoint.id}/setup-secret`)
        .send({})
        .expect(201),
      request(app)
        .post(`/api/chat-endpoints/${endpoint.id}/setup`)
        .send({ action: "reconnect" }),
    ]);
    expect([200, 409]).toContain(reconnect.status);
    const rotatedSecret = rotation.body.webhookSecret as string;
    expect(rotatedSecret).toMatch(/^[a-f0-9]{64}$/);

    // The final state depends on which request acquired the lease first. A
    // final reconnect must consume the complete, most recent credential set
    // in either ordering.
    await recordGitHubWebhookVerification(
      service,
      endpoint.publicId,
      rotatedSecret,
    );
    await service.configure(endpoint.id, { action: "reconnect" }, "owner-user");
    const providerConfig = runtime.configurations.get(
      endpoint.id,
    )?.providerConfig;
    expect(providerConfig).toMatchObject({
      provider: "github",
      credentials: {
        appId: "123456",
        installationId: 2468,
        privateKey: expect.stringContaining("BEGIN PRIVATE KEY"),
        webhookSecret: rotatedSecret,
      },
    });
    const [connection] = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));
    expect(connection!.refs.map((ref) => ref.configPath).sort()).toEqual([
      "credentials.appId",
      "credentials.installationId",
      "credentials.privateKey",
      "credentials.webhookSecret",
    ]);
    await expect(
      db
        .select()
        .from(chatEndpointLeases)
        .where(eq(chatEndpointLeases.endpointId, endpoint.id)),
    ).resolves.toHaveLength(0);
  });

  it("does not create SDK eyes reactions for accepted GitHub requests", async () => {
    const fixture = await seedCompany();
    let reactionTransportCalls = 0;
    const { callbacks, endpoint, runtime } = await configuredGitHubEndpoint(fixture, {
      receiptReactionTransportBarrier: async () => { reactionTransportCalls += 1; },
    });
    const thread = makeThread({
      channelId: "github:paperclipai/paperclip",
      id: "github:paperclipai/paperclip:issue:909",
      name: "paperclipai/paperclip",
    });
    await deliverMessage({
      callbacks, endpointId: endpoint.id, provider: "github", thread: thread.thread,
      message: makeMessage({ id: "90901", text: "@maya acknowledge this", mentioned: true }),
      trigger: "mention",
    });
    expect(reactionTransportCalls).toBe(0);
    expect(runtime.endpoints.get(endpoint.id)?.reactions).toEqual([]);
    expect(await db.select().from(chatActions).where(and(
      eq(chatActions.endpointId, endpoint.id), eq(chatActions.kind, "receipt_reaction"),
    ))).toEqual([]);
  });

  it("filters a durably admitted GitHub callback when rotation and reconnect supersede its runtime before deferred processing", async () => {
    const fixture = await seedCompany();
    const deferred: Array<() => void> = [];
    const { callbacks, endpoint, runtime, service } =
      await configuredGitHubEndpoint(fixture, {
        deferWebhookProcessing: true,
        scheduleDeferredWork: (task) => deferred.push(task),
      });
    const obsoleteRuntime = runtime.endpoints.get(endpoint.id);
    if (!obsoleteRuntime) throw new Error("Expected initial GitHub runtime");
    const thread = makeThread({
      channelId: "github:paperclipai/paperclip",
      id: "github:paperclipai/paperclip:issue:910",
      name: "paperclipai/paperclip",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "github",
      thread: thread.thread,
      message: makeMessage({
        id: "91001",
        text: "@maya this old callback must not cross the reconnect fence",
        mentioned: true,
      }),
      trigger: "mention",
    });
    expect(deferred).toHaveLength(1);
    const obsoleteDeliveryDrain = deferred[0];
    const [delivery] = await readChatDeliveriesByEndpointId(endpoint.id);
    expect(delivery.normalizedEvent).toMatchObject({
      runtimeContext: {
        credentialFingerprint: expect.any(String),
        generation: expect.any(Number),
      },
    });

    const { webhookSecret } = await service.generateSetupSecret(
      endpoint.id,
      "owner-user",
    );
    await recordGitHubWebhookVerification(
      service,
      endpoint.publicId,
      webhookSecret,
    );
    await service.configure(endpoint.id, { action: "reconnect" }, "owner-user");
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date() })
      .where(eq(chatDeliveries.id, delivery.id));

    await service.processPendingDeliveries(25, delivery.id);

    await expect(
      db
        .select({
          state: chatDeliveries.state,
          error: chatDeliveries.redactedError,
        })
        .from(chatDeliveries)
        .where(eq(chatDeliveries.id, delivery.id)),
    ).resolves.toEqual([
      {
        state: "filtered",
        error: "Connection activation changed before admission",
      },
    ]);
    await expect(
      readChatConversationsByEndpointId(endpoint.id),
    ).resolves.toHaveLength(0);
    expect(obsoleteRuntime.reactions).toEqual([]);
    expect(runtime.endpoints.get(endpoint.id)?.reactions).toEqual([]);
    // The original delivery drain is still queued. Durable ping admission also
    // schedules a worker, even though the scoped setup helper has already
    // processed that exact receipt; neither callback is executed in this race.
    expect(deferred).toHaveLength(2);
    expect(deferred[0]).toBe(obsoleteDeliveryDrain);
  });

  it("does not rotate a GitHub webhook secret when stored credentials cannot be resolved", async () => {
    const fixture = await seedCompany();
    const { endpoint, runtime, service } =
      await configuredGitHubEndpoint(fixture);
    await db
      .update(chatEndpoints)
      .set({ status: "active", setup: { step: "complete" } })
      .where(eq(chatEndpoints.id, endpoint.id));

    const [connectionBefore] = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));
    const appIdRef = connectionBefore!.refs.find(
      (ref) => ref.configPath === "credentials.appId",
    );
    if (!appIdRef) throw new Error("Expected stored GitHub App ID");
    await db
      .update(companySecrets)
      .set({ status: "disabled" })
      .where(eq(companySecrets.id, appIdRef.secretId));

    await expect(
      service.generateSetupSecret(endpoint.id, "owner-user"),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: "secret_inactive" },
    });

    const [connectionAfter] = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));
    expect(connectionAfter!.refs).toEqual(connectionBefore!.refs);
    expect(runtime.endpoints.has(endpoint.id)).toBe(true);
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "active",
      setup: { step: "complete", webhookSecretConfigured: true },
    });
  });

  it("keeps GitHub issues, PR conversations, and inline review threads on distinct tasks", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint } = await configuredGitHubEndpoint(fixture);
    const cases = [
      {
        id: "github:paperclipai/paperclip:issue:51",
        rootId: "51001",
      },
      { id: "github:paperclipai/paperclip:52", rootId: "52001" },
      {
        id: "github:paperclipai/paperclip:52:rc:88001",
        rootId: "88001",
      },
    ];
    for (const item of cases) {
      const thread = makeThread({
        channelId: "github:paperclipai/paperclip",
        id: item.id,
        name: "paperclipai/paperclip",
      });
      const rootDelivery = {
        callbacks,
        endpointId: endpoint.id,
        provider: "github",
        thread: thread.thread,
        message: makeMessage({
          id: item.rootId,
          text: `@maya handle ${item.id}`,
          mentioned: true,
        }),
        trigger: "mention",
      } as const;
      await deliverMessage(rootDelivery);
      if (item === cases[0]) await deliverMessage(rootDelivery);
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider: "github",
        thread: thread.thread,
        message: makeMessage({
          id: `${item.rootId}-reply`,
          text: "Unmentioned follow-up",
        }),
        trigger: "subscribed_message",
      });
    }

    const conversations = await readChatConversationsByEndpointId(endpoint.id);
    expect(conversations).toHaveLength(3);
    expect(new Set(conversations.map((row) => row.issueId)).size).toBe(3);
    expect(conversations.map((row) => row.externalThreadId).sort()).toEqual(
      cases.map((item) => item.id).sort(),
    );
    const deliveries = await readChatDeliveriesByEndpointId(endpoint.id);
    expect(deliveries).toHaveLength(6);
    expect(deliveries.every((row) => row.state === "processed")).toBe(true);
    expect(
      deliveries.find((row) => row.providerEventId.endsWith(":51001")),
    ).toMatchObject({
      normalizedEvent: { deduplication: { duplicateCount: 1 } },
    });
    expect(
      deliveries.filter(
        (row) => row.normalizedEvent.trigger === "subscribed_message",
      ),
    ).toHaveLength(3);
  });

  it("uses GitHub numeric user ids for linked authority and rechecks membership on every follow-up", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } =
      await configuredGitHubEndpoint(fixture);
    await service.update(
      endpoint.id,
      { allowUnlinkedPeople: false },
      "owner-user",
    );
    const githubUserId = "18446744073709551";
    const thread = makeThread({
      channelId: "paperclipai/paperclip",
      id: "github:paperclipai/paperclip:issue:59",
      name: "paperclipai/paperclip",
    });
    const send = (
      id: string,
      text: string,
      trigger: "mention" | "subscribed_message",
    ) =>
      deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider: "github",
        thread: thread.thread,
        message: makeMessage({
          id,
          text,
          mentioned: trigger === "mention",
          userId: githubUserId,
          userName: "octocat-renamable",
        }),
        trigger,
      });

    await send("59001", "@maya attempt before identity linking", "mention");
    await send("59001", "@maya attempt before identity linking", "mention");
    expect(await service.listConversations(endpoint.id)).toEqual([]);
    const [principal] = await db
      .select()
      .from(chatExternalPrincipals)
      .where(
        and(
          eq(chatExternalPrincipals.companyId, fixture.companyId),
          eq(chatExternalPrincipals.provider, "github"),
          eq(chatExternalPrincipals.externalId, githubUserId),
        ),
      );
    expect(principal).toMatchObject({ externalId: githubUserId });
    const [filtered] = await readChatDeliveriesByEndpointId(endpoint.id);
    expect(filtered).toMatchObject({
      state: "filtered",
      redactedError: "External identity must be linked to a Paperclip account",
      normalizedEvent: { deduplication: { duplicateCount: 1 } },
    });

    const linkedUserId = `github-user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({
      id: linkedUserId,
      name: "GitHub Linked User",
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
    const intent = await service.createLinkIntent(
      endpoint.id,
      principal!.id,
      1_800,
    );
    const token = new URL(intent.confirmationUrl).searchParams.get("token");
    if (!token)
      throw new Error("GitHub identity-link confirmation token was absent");
    await service.confirmIdentityLink(token, linkedUserId);

    await send("59002", "@maya authorized GitHub task", "mention");
    const [conversation] = await service.listConversations(endpoint.id);
    expect(conversation).toBeDefined();
    await expect(
      db
        .select({
          authorUserId: issueComments.authorUserId,
          body: issueComments.body,
        })
        .from(issueComments)
        .where(eq(issueComments.issueId, conversation!.issueId)),
    ).resolves.toEqual([
      {
        authorUserId: linkedUserId,
        body: "@maya authorized GitHub task",
      },
    ]);
    expect(wakeup).toHaveBeenCalledTimes(1);

    await db
      .update(companyMemberships)
      .set({ status: "suspended" })
      .where(
        and(
          eq(companyMemberships.companyId, fixture.companyId),
          eq(companyMemberships.principalId, linkedUserId),
        ),
      );
    await send(
      "59003",
      "This follow-up must be rejected now",
      "subscribed_message",
    );
    await expect(
      db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, conversation!.issueId)),
    ).resolves.toEqual([{ body: "@maya authorized GitHub task" }]);
    expect(wakeup).toHaveBeenCalledTimes(1);
    const suspendedDelivery = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(chatDeliveries.providerEventId, `${thread.thread.id}:59003`),
        ),
      )
      .then((rows) => rows[0]);
    expect(suspendedDelivery).toMatchObject({
      state: "filtered",
      redactedError: "Linked Paperclip account is not currently permitted",
    });
  });

  it("reorders same-second GitHub callbacks by comment id before starting the task", async () => {
    const fixture = await seedCompany();
    const deferred: Array<() => void> = [];
    const { callbacks, endpoint, service, wakeup } =
      await configuredGitHubEndpoint(fixture, {
        deferWebhookProcessing: true,
        scheduleDeferredWork: (task) => deferred.push(task),
      });
    const thread = makeThread({
      channelId: "github:paperclipai/paperclip",
      id: "github:paperclipai/paperclip:issue:71",
      name: "paperclipai/paperclip",
    });
    const providerSentAt = new Date("2026-09-05T18:00:00.000Z");
    const laterReply = makeMessage({
      id: "71002",
      text: "unmentioned follow-up delivered first",
    });
    laterReply.metadata.dateSent = providerSentAt;
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "github",
      thread: thread.thread,
      message: laterReply,
      trigger: "unaddressed_message",
    });
    const earlierMention = makeMessage({
      id: "71001",
      text: "@maya start the GitHub task",
      mentioned: true,
    });
    earlierMention.metadata.dateSent = providerSentAt;
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "github",
      thread: thread.thread,
      message: earlierMention,
      trigger: "mention",
    });

    const durable = await readChatDeliveriesByEndpointId(endpoint.id);
    expect(durable).toHaveLength(2);
    expect(durable.every((delivery) => delivery.nextAttemptAt !== null)).toBe(
      true,
    );
    expect(
      new Set(
        durable.map((delivery) => delivery.nextAttemptAt?.getTime() ?? null),
      ).size,
    ).toBe(1);
    expect(deferred).toHaveLength(1);

    // The production reorder window is 750 ms; allow the subsequent database
    // drain to finish on loaded CI instead of sharing the default one-second budget.
    deferred.shift()?.();
    await vi.waitFor(async () => {
      const rows = await readChatConversationsByEndpointId(endpoint.id);
      expect(rows).toHaveLength(1);
    }, { timeout: 10_000 });
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    await vi.waitFor(async () => {
      const rows = await db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, conversation!.issueId))
        .orderBy(asc(issueComments.createdAt), asc(issueComments.id));
      expect(rows.map((row) => row.body)).toEqual([
        "@maya start the GitHub task",
        "unmentioned follow-up delivered first",
      ]);
      expect(wakeup).toHaveBeenCalledTimes(2);
    }, { timeout: 10_000 });
    await service.shutdown();
  });

  it("holds a GitHub follow-up that arrives after the reorder window until its older root mention arrives", async () => {
    const fixture = await seedCompany();
    const deferred: Array<() => void> = [];
    const { callbacks, endpoint, service, wakeup } =
      await configuredGitHubEndpoint(fixture, {
        deferWebhookProcessing: true,
        scheduleDeferredWork: (task) => deferred.push(task),
      });
    const thread = makeThread({
      channelId: "github:paperclipai/paperclip",
      id: "github:paperclipai/paperclip:issue:72",
      name: "paperclipai/paperclip",
    });
    const laterReply = makeMessage({
      id: "72002",
      text: "follow-up delivered well before its root callback",
    });
    laterReply.metadata.dateSent = new Date("2026-09-05T18:00:02.000Z");
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "github",
      thread: thread.thread,
      message: laterReply,
      trigger: "unaddressed_message",
    });
    const [replyDelivery] = await readChatDeliveriesByEndpointId(endpoint.id);
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date() })
      .where(eq(chatDeliveries.id, replyDelivery!.id));

    await service.processPendingDeliveries(25, replyDelivery!.id);

    await expect(
      readChatDeliveriesById(replyDelivery!.id),
    ).resolves.toEqual([
      expect.objectContaining({
        state: "retry",
        attempts: 1,
        redactedError: "Waiting briefly for an earlier root mention",
      }),
    ]);
    await expect(
      readChatConversationsByEndpointId(endpoint.id),
    ).resolves.toHaveLength(0);
    expect(wakeup).not.toHaveBeenCalled();

    const earlierMention = makeMessage({
      id: "72001",
      text: "@maya start the delayed GitHub task",
      mentioned: true,
    });
    earlierMention.metadata.dateSent = new Date("2026-09-05T18:00:01.000Z");
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "github",
      thread: thread.thread,
      message: earlierMention,
      trigger: "mention",
    });
    const mentionDelivery = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(chatDeliveries.providerEventId, `${thread.thread.id}:72001`),
        ),
      )
      .then((rows) => rows[0]);
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date() })
      .where(eq(chatDeliveries.id, mentionDelivery!.id));
    await service.processPendingDeliveries(25, mentionDelivery!.id);

    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    expect(conversation).toBeDefined();
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date() })
      .where(eq(chatDeliveries.id, replyDelivery!.id));
    await service.processPendingDeliveries(25, replyDelivery!.id);

    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, conversation!.issueId))
      .orderBy(asc(issueComments.createdAt), asc(issueComments.id));
    expect(comments.map((comment) => comment.body)).toEqual([
      "@maya start the delayed GitHub task",
      "follow-up delivered well before its root callback",
    ]);
    expect(wakeup).toHaveBeenCalledTimes(2);
    expect(deferred).toHaveLength(1);
    await service.shutdown();
  });

  it("filters a standalone unaddressed GitHub comment after bounded orphan retention", async () => {
    const fixture = await seedCompany();
    const deferred: Array<() => void> = [];
    const { callbacks, endpoint, service, wakeup } =
      await configuredGitHubEndpoint(fixture, {
        deferWebhookProcessing: true,
        scheduleDeferredWork: (task) => deferred.push(task),
      });
    const thread = makeThread({
      channelId: "github:paperclipai/paperclip",
      id: "github:paperclipai/paperclip:issue:73",
      name: "paperclipai/paperclip",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "github",
      thread: thread.thread,
      message: makeMessage({
        id: "73001",
        text: "ordinary comment that never mentions the agent",
      }),
      trigger: "unaddressed_message",
    });
    const [delivery] = await readChatDeliveriesByEndpointId(endpoint.id);
    for (let expectedAttempt = 1; expectedAttempt <= 13; expectedAttempt += 1) {
      await db
        .update(chatDeliveries)
        .set({ nextAttemptAt: new Date() })
        .where(eq(chatDeliveries.id, delivery!.id));
      await service.processPendingDeliveries(25, delivery!.id);
      const current = await readChatDeliveriesById(delivery!.id)
        .then((rows) => rows[0]);
      expect(current).toMatchObject({
        state: expectedAttempt <= 12 ? "retry" : "filtered",
        attempts: expectedAttempt,
      });
    }
    await expect(
      readChatConversationsByEndpointId(endpoint.id),
    ).resolves.toHaveLength(0);
    expect(wakeup).not.toHaveBeenCalled();
    expect(deferred).toHaveLength(1);
    await service.shutdown();
  });

  it("revokes a deleted canonical GitHub installation and recovers the same endpoint after reinstall", async () => {
    const fixture = await seedCompany();
    const context = await configuredGitHubEndpoint(fixture);
    const { callbacks, endpoint, runtime, service, webhookSecret } = context;
    const thread = makeThread({
      channelId: "github:paperclipai/paperclip",
      id: "github:paperclipai/paperclip:issue:61",
      name: "paperclipai/paperclip",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "github",
      thread: thread.thread,
      message: makeMessage({
        id: "61001",
        text: "@maya establish the recoverable thread",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id);
    const recovery = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
    onTestFinished(() => recovery.stop());
    await service.registerGitHubWebhookRecoveryWork(recovery, () => true).ready;
    await expect.poll(() => (recovery.nextWakeAt() ?? 0) - Date.now(), { timeout: 5000 }).toBeGreaterThan(30_000);
    await expect.poll(() => idleWorkSnapshot().active).toBe(0);
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    const credentialRefsBeforeDeletion = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId))
      .then((rows) => rows[0]!.refs);

    context.setInstallationAvailable(false);
    const deleted = await service.handleWebhook(
      endpoint.publicId,
      "github",
      signedGitHubWebhookRequest({
        delivery: "github-installation-deleted",
        event: "installation",
        payload: {
          action: "deleted",
          installation: { id: 2468 },
        },
        webhookSecret,
      }),
    );
    expect(deleted.status).toBe(202);
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "revoked",
      healthMessage: "GitHub App installation was removed",
    });
    await expect.poll(() => recovery.nextWakeAt(), { timeout: 5000 }).toBeNull();
    await expect(
      db
        .select({
          status: toolConnections.status,
          enabled: toolConnections.enabled,
          healthStatus: toolConnections.healthStatus,
          refs: toolConnections.credentialSecretRefs,
        })
        .from(toolConnections)
        .where(eq(toolConnections.id, endpoint.connectionId)),
    ).resolves.toEqual([
      {
        status: "disabled",
        enabled: false,
        healthStatus: "failed",
        refs: credentialRefsBeforeDeletion,
      },
    ]);
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({ availability: "unavailable", enabled: true }),
    ]);
    await expect(service.listConversations(endpoint.id)).resolves.toEqual([
      expect.objectContaining({ id: conversation!.id, state: "unavailable" }),
    ]);
    await expect(
      db
        .select({ state: chatDeliveries.state })
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(
              chatDeliveries.providerEventId,
              "lifecycle:github-installation-deleted",
            ),
          ),
        ),
    ).resolves.toEqual([{ state: "processed" }]);
    expect(runtime.endpoints.has(endpoint.id)).toBe(false);

    context.setInstallationId(8642);
    context.setInstallationAvailable(true);
    await service.handleWebhook(
      endpoint.publicId,
      "github",
      signedGitHubWebhookRequest({
        delivery: "github-installation-recreated",
        event: "installation",
        payload: {
          action: "created",
          installation: { id: 8642 },
        },
        webhookSecret,
      }),
    );
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "active",
      healthMessage: "Connected",
    });
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "paperclipai/paperclip",
        availability: "available",
        enabled: true,
      }),
    ]);
    await expect(service.listConversations(endpoint.id)).resolves.toEqual([
      expect.objectContaining({ id: conversation.id, state: "active" }),
    ]);
    expect(runtime.endpoints.has(endpoint.id)).toBe(false);

    const publication = await service.publishBoardMessage(
      endpoint.id,
      conversation.id,
      "Recovered GitHub response",
      "recovered-github-response",
      "owner-user",
    );
    expect(
      runtime.configurations.get(endpoint.id)?.providerConfig,
    ).toMatchObject({
      provider: "github",
      credentials: { installationId: 8642 },
    });
    await expect(
      readChatPublicationsById(publication!.id),
    ).resolves.toEqual([expect.objectContaining({ state: "published" })]);
  });

  it("fails closed when GitHub App permissions drift before installation recovery", async () => {
    const fixture = await seedCompany();
    const context = await configuredGitHubEndpoint(fixture);
    const { callbacks, endpoint, runtime, service, webhookSecret } = context;
    const thread = makeThread({
      channelId: "github:paperclipai/paperclip",
      id: "github:paperclipai/paperclip:issue:62",
      name: "paperclipai/paperclip",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "github",
      thread: thread.thread,
      message: makeMessage({
        id: "62001",
        text: "@maya establish the permission drift thread",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id);
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);

    await service.handleWebhook(
      endpoint.publicId,
      "github",
      signedGitHubWebhookRequest({
        delivery: "github-installation-suspended-before-drift",
        event: "installation",
        payload: {
          action: "suspend",
          installation: { id: 2468 },
        },
        webhookSecret,
      }),
    );
    context.setAppAccess({
      permissions: {
        issues: "read",
        metadata: "read",
        pull_requests: "write",
      },
    });

    await expect(
      service.handleWebhook(
        endpoint.publicId,
        "github",
        signedGitHubWebhookRequest({
          delivery: "github-installation-unsuspended-with-drift",
          event: "installation",
          payload: {
            action: "unsuspend",
            installation: { id: 2468 },
          },
          webhookSecret,
        }),
      ),
    ).rejects.toMatchObject({
      status: 422,
      details: {
        code: "chat_provider_permissions_missing",
        provider: "github",
        missingPermissions: ["issues"],
      },
    });

    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "attention",
      healthMessage:
        "GitHub App credentials, permissions, events, or identity need attention",
      lastError: expect.stringContaining("issues"),
    });
    const [connection] = await db
      .select({
        status: toolConnections.status,
        enabled: toolConnections.enabled,
        healthStatus: toolConnections.healthStatus,
      })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));
    expect(connection).toEqual({
      status: "disabled",
      enabled: false,
      healthStatus: "degraded",
    });
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({ availability: "unavailable", enabled: true }),
    ]);
    await expect(service.listConversations(endpoint.id)).resolves.toEqual([
      expect.objectContaining({ id: conversation!.id, state: "unavailable" }),
    ]);
    expect(runtime.endpoints.has(endpoint.id)).toBe(false);
    const lifecycleDelivery = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(
            chatDeliveries.providerEventId,
            "lifecycle:github-installation-unsuspended-with-drift",
          ),
        ),
      )
      .then((rows) => rows[0]);
    expect(lifecycleDelivery).toMatchObject({
      state: "retry",
      redactedError: expect.stringContaining("issues"),
    });
  });
});
