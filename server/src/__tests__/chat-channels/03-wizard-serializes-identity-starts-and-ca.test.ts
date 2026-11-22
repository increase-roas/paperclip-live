import {
  registerGitHubReviewProjectionWork,
} from "../../services/chat-channels/github/review-projection-work.js";
import {
  retainGitHubReviewReceipt,
} from "../../services/chat-channels/github/task-preparation.js";
import {
  agentWakeupRequests,
  agents,
  chatActions,
  chatConversations,
  chatDeliveries,
  chatEndpointLeases,
  chatEndpointResources,
  chatEndpoints,
  chatGitHubRegistrations,
  chatGitHubReviews,
  chatIdentityLinks,
  chatMessageLinks,
  companies,
  companyMemberships,
  companySkills,
  heartbeatRuns,
  issueComments,
  issues,
  subscribeDatabaseWork,
  toolCatalogEntries,
  toolConnections,
} from "@paperclipai/db";
import {
  idleWorkSnapshot,
} from "../../services/task-admission.js";
import {
  reconcileTaskChatRetryReceipts,
  requestTaskRetry,
} from "../../services/task-retry.js";
import {
  taskInterruptionPresentation,
} from "../../services/task-interruption-presentation.js";
import {
  withQueuedCommentIdsInWakePayload,
} from "../../services/issue-queued-comment-queue.js";
import {
  createDeliveryWorkCoordinator,
} from "../../services/delivery-work-coordinator.js";
import {
  DELIVERY_QUEUES,
} from "../../services/delivery-work-notifications.js";
import {
  GitHubPublicationLeaseLost,
  withGitHubPublicationLease,
} from "../../services/chat-github-publication-lease.js";
import {
  secretService,
} from "../../services/secrets.js";
import {
  githubChatWizardService,
} from "../../services/chat-github-wizard.js";
import {
  dispatchGitHubBotCloudEvent,
  registerGitHubBotCloudSetupPoller,
} from "../../services/chat-github-cloud-ingress.js";
import {
  githubChatManagementService,
} from "../../services/chat-github-management.js";
import {
  githubChatReviewService,
} from "../../services/chat-github-reviews.js";
import {
  resolveGitHubReviewInstructions,
} from "../../services/chat-channels/github/review-instructions.js";
import {
  githubReviewCheckService,
} from "../../services/chat-github-checks.js";
import {
  githubAutomaticReviewEvent,
} from "../../services/chat-github-events.js";
import {
  resolveGitHubOperationCredentials,
} from "../../services/github-operation-credentials.js";
import {
  initializeRunIdentity,
} from "../../services/run-identity.js";
import {

} from "../../services/cloud-runtime-identity.js";
import {
  createHmac,
  randomUUID,
} from "node:crypto";
import {
  and,
  eq,
  ne,
  sql,
} from "drizzle-orm";
import {
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import {
  issueService,
} from "../../services/issues.js";
import {
  heartbeatService,
} from "../../services/heartbeat.js";
import {
  buildPaperclipWakePayload,
  resolveRunScopedMentionedSkillKeys,
} from "../../services/heartbeat/run-preparation.js";
import {
  FakeChatSdkRuntime,
  fakeSlackFetch,
  makeMessage,
  makeThread,
  wizardStoreApp,
} from ".././helpers/chat-channels-fixture.js";
import {
  createService,
  db,
  deliverMessage,
  describeChatChannelsSuite,
  readAgentWakeupRequestsById,
  readChatConversationsByEndpointId,
  readChatConversationsById,
  readChatDeliveriesByEndpointId,
  readChatEndpointsById,
  readChatGitHubRegistrationsByEndpointId,
  readChatGitHubReviewsByEndpointId,
  readHeartbeatRunsById,
  readIssueCommentsByIssueId,
  readIssuesById,
  readToolConnectionsById,
  seedCompany,
  signedGitHubWebhookRequest,
  configuredGitHubEndpoint,
} from "../helpers/chat-channels-harness.js";
import {
  reviewBotFixture,
  reviewCheckWorkerFixture,
  reviewProjectionFixture,
  toolReplyFixture,
} from "../helpers/chat-channels-provider-fixtures.js";
import type { Db } from "@paperclipai/db";
import * as cloudRuntimeIdentity from "../../services/cloud-runtime-identity.js";

describeChatChannelsSuite("chat channels 03-wizard-serializes-identity-starts-and-ca", () => {
    it("wizard serializes identity starts and callbacks without overwriting PKCE or handoff state", async () => {
      const f = await seedCompany();
      const context = await configuredGitHubEndpoint(f, {}, true);
      const connectedAppId = (await context.service.get(context.endpoint.id))
        .botExternalId;
      const vault = secretService(db);
      const [connection] = await readToolConnectionsById(context.endpoint.connectionId);
      const refs = [...connection!.credentialSecretRefs];
      for (const key of ["clientId", "clientSecret"]) {
        const secret = await vault.create(f.companyId, {
          name: `wizard-${key}-${randomUUID()}`,
          provider: "local_encrypted",
          value: `test-${key}`,
        });
        await vault.createBinding({
          companyId: f.companyId,
          secretId: secret.id,
          targetType: "tool_connection",
          targetId: connection!.id,
          configPath: `credentials.${key}`,
        });
        refs.push({
          configPath: `credentials.${key}`,
          secretId: secret.id,
          versionSelector: "latest",
        });
      }
      await db
        .update(toolConnections)
        .set({ credentialSecretRefs: refs })
        .where(eq(toolConnections.id, connection!.id));
      await db
        .insert(chatGitHubRegistrations)
        .values({
          companyId: f.companyId,
          endpointId: context.endpoint.id,
          userId: "owner-user",
          stateHash: randomUUID(),
          trustedOrigin: "https://reviews.example.test",
          status: "completed",
          expiresAt: new Date(Date.now() + 60_000),
          handoff: {
            cloudId: "",
            returnState: "preserve-return",
            redemptionId: "preserve-receipt",
            webhookSecretHash: "preserve-hash",
          },
        });
      let entered!: () => void,
        release!: () => void,
        callbackEntered!: () => void,
        callbackRelease!: () => void;
      const storing = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const storeGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const exchanging = new Promise<void>((resolve) => {
        callbackEntered = resolve;
      });
      const exchangeGate = new Promise<void>((resolve) => {
        callbackRelease = resolve;
      });
      let writes = 0,
        verifier = "",
        verifierSecretId = "";
      const wizard = githubChatWizardService(db, {
        origin: () => "https://reviews.example.test",
        connector: () => null,
        startDirect: context.service.startGitHubRegistration,
        storeApp: wizardStoreApp(context.service),
        storeCredentials: async (_id, _user, values) => {
          if (++writes === 1) {
            entered();
            await storeGate;
          }
          verifier = values.identityCodeVerifier!;
          if (verifierSecretId) {
            await vault.rotate(verifierSecretId, { value: verifier });
            return;
          }
          const secret = await vault.create(f.companyId, {
            name: `wizard-verifier-${randomUUID()}`,
            provider: "local_encrypted",
            value: verifier,
          });
          verifierSecretId = secret.id;
          await vault.createBinding({
            companyId: f.companyId,
            secretId: secret.id,
            targetType: "tool_connection",
            targetId: connection!.id,
            configPath: "credentials.identityCodeVerifier",
          });
          await db
            .update(toolConnections)
            .set({
              credentialSecretRefs: [
                ...refs,
                {
                  configPath: "credentials.identityCodeVerifier",
                  secretId: secret.id,
                  versionSelector: "latest",
                },
              ],
            })
            .where(eq(toolConnections.id, connection!.id));
        },
        fetch: (async (input, init) => {
          if (String(input).endsWith("/access_token")) {
            expect(JSON.parse(String(init?.body)).code_verifier).toBe(verifier);
            callbackEntered();
            await exchangeGate;
            return Response.json({ access_token: "transient" });
          }
          if (String(input).endsWith("/user"))
            return Response.json({
              id: 1357,
              login: "octocat",
              avatar_url: "https://example.test/avatar",
            });
          if (String(input).includes("/user/installations?"))
            return Response.json({
              installations: [{ id: 2468, app_id: Number(connectedAppId) }],
            });
          throw new Error(`Unexpected identity request ${String(input)}`);
        }) as typeof fetch,
        refreshRepositories: context.service.refreshGitHubRepositories,
        resources: context.service.listResources,
        replaceResources: context.service.replaceResources,
        configure: async () => {},
        finish: async () => {},
      });
      const first = wizard.startIdentity(context.endpoint.id, "owner-user");
      await Promise.race([
        storing,
        first.then(() => {
          throw new Error("Expected a paused vault write");
        }),
      ]);
      await expect(
        wizard.startIdentity(context.endpoint.id, "owner-user"),
      ).rejects.toThrow("in progress");
      release();
      const authorization = await first,
        state = new URL(authorization.authorizationUrl).searchParams.get("state")!;
      const callback = wizard.identityCallback(state, "code");
      await Promise.race([
        exchanging,
        callback.then(() => {
          throw new Error("Expected a paused OAuth exchange");
        }),
      ]);
      await expect(
        wizard.startIdentity(context.endpoint.id, "owner-user"),
      ).rejects.toThrow("in progress");
      callbackRelease();
      await callback;
      const [session] = await readChatGitHubRegistrationsByEndpointId(context.endpoint.id);
      expect(session!.handoff).toMatchObject({
        returnState: "preserve-return",
        redemptionId: "preserve-receipt",
        webhookSecretHash: "preserve-hash",
        identity: { githubUserId: "1357", login: "octocat" },
      });
      expect(session!.handoff?.identityStateHash).toBeUndefined();
      expect(session!.handoff?.identityLeaseId).toBeUndefined();
      expect(writes).toBe(2);
    });

    it.each(["manifest", "existing"] as const)("imports initial GitHub access for a %s App without a second picker and leaves later additions disabled", async (method) => {
      const f = await seedCompany();
      const context = await configuredGitHubEndpoint(f, {}, true, method === "manifest", method === "existing");
      const current = await context.service.get(context.endpoint.id);
      expect(current.setup.github?.initialRepositoryImportPending).toBe(true);
      const registrations = await readChatGitHubRegistrationsByEndpointId(current.id);
      expect(registrations).toHaveLength(method === "manifest" ? 1 : 0);
      await db.update(chatGitHubRegistrations).set({ status: "completed" })
        .where(eq(chatGitHubRegistrations.endpointId, current.id));
      const result = await context.service.githubWizard.advance(
        current.id,
        "owner-user",
      );
      expect(result.state).toBe("identity");
      expect(
        (await context.service.listResources(current.id)).map(
          (resource) => resource.enabled,
        ),
      ).toEqual([true]);
      expect(
        (
          await githubChatManagementService(
            db,
            context.providerFetch,
          ).configuration(current.id, "owner-user")
        ).configuration,
      ).toMatchObject({
        toolsEnabled: true,
        defaults: { invocation: "mentions_only", events: [] },
      });
      context.setRepositories([
        {
          id: 97531,
          full_name: "paperclipai/paperclip",
          html_url: "https://github.com/paperclipai/paperclip",
          owner: { id: 1357, login: "paperclipai" },
          private: false,
        },
        {
          id: 97532,
          full_name: "paperclipai/later",
          html_url: "https://github.com/paperclipai/later",
          owner: { id: 1357, login: "paperclipai" },
          private: true,
        },
      ]);
      await context.service.refreshGitHubRepositories(current.id, "owner-user");
      const later = (await context.service.listResources(current.id)).find(
        (resource) => resource.label === "paperclipai/later",
      );
      expect(later?.enabled).toBe(false);
      await context.service.githubWizard.advance(current.id, "owner-user");
      expect(
        (await context.service.listResources(current.id)).find(
          (resource) => resource.id === later!.id,
        )?.enabled,
      ).toBe(false);
    });

    it("manual App credential retry imports repositories after an interrupted vault write", async () => {
      const f = await seedCompany();
      const context = await configuredGitHubEndpoint(f, {}, true, false, true, true);
      await context.service.githubWizard.advance(context.endpoint.id, "owner-user");
      expect((await context.service.listResources(context.endpoint.id)).map(resource => resource.enabled)).toEqual([true]);
      expect((await githubChatManagementService(db, context.providerFetch).configuration(context.endpoint.id, "owner-user")).configuration.toolsEnabled).toBe(true);
      expect((await context.service.get(context.endpoint.id)).setup.github).toMatchObject({ initialRepositoriesImported: true, initialSetupPending: false });
    });

    it("manual App setup resumes tool initialization after an interrupted repository import", async () => {
      const f = await seedCompany();
      const context = await configuredGitHubEndpoint(f, {}, true, false, true);
      const wizard = githubChatWizardService(db, {
        origin: () => "https://reviews.example.test",
        fetch: context.providerFetch,
        startDirect: context.service.startGitHubRegistration,
        storeApp: wizardStoreApp(context.service),
        storeCredentials: async () => {},
        refreshRepositories: context.service.refreshGitHubRepositories,
        resources: context.service.listResources,
        replaceResources: async (...args) => {
          await context.service.replaceResources(...args);
          throw new Error("Interrupted after repository import");
        },
        configure: async () => {},
        finish: async () => {},
      });
      await expect(wizard.advance(context.endpoint.id, "owner-user")).rejects.toThrow("Interrupted after repository import");
      expect((await context.service.get(context.endpoint.id)).setup.github).toMatchObject({ initialSetupPending: true, initialRepositoryImportPending: false });
      await context.service.githubWizard.advance(context.endpoint.id, "owner-user");
      expect((await githubChatManagementService(db, context.providerFetch).configuration(context.endpoint.id, "owner-user")).configuration.toolsEnabled).toBe(true);
      expect((await context.service.get(context.endpoint.id)).setup.github).toMatchObject({ initialRepositoriesImported: true, initialSetupPending: false });
    });

    it("manual App setup preserves explicitly disabled repositories and tools", async () => {
      const f = await seedCompany();
      const context = await configuredGitHubEndpoint(f, {}, true, false, true);
      const management = githubChatManagementService(db, context.providerFetch);
      const saved = await management.configuration(context.endpoint.id, "owner-user");
      await management.saveConfiguration(context.endpoint.id, {
        expectedRevision: saved.revision,
        configuration: { ...saved.configuration, toolsEnabled: false },
      }, "owner-user");
      await context.service.replaceResources(context.endpoint.id, [], "owner-user");
      await context.service.githubWizard.advance(context.endpoint.id, "owner-user");
      expect((await context.service.listResources(context.endpoint.id)).every(resource => !resource.enabled)).toBe(true);
      expect(await management.configuration(context.endpoint.id, "owner-user")).toMatchObject({ revision: 1, configuration: { toolsEnabled: false } });
    });

    it.each([
      ["active", "current", "enabled"], ["active", "foreign", "enabled"], ["active", "invalid_signature", "enabled"], ["active", "missing_installation", "enabled"],
      ["attention", "current", "enabled"], ["attention", "foreign", "enabled"], ["attention", "invalid_signature", "enabled"], ["attention", "missing_installation", "enabled"],
      ["attention", "current", "disabled"], ["attention", "current", "unavailable"],
    ] as const)("verifies a repaired GitHub webhook in %s only from a %s installation delivery with %s repository", async (status, kind, resourceState) => {
      const f = await reviewBotFixture();
      const [endpoint] = await readChatEndpointsById(f.endpoint.id);
      if (resourceState !== "enabled") {
        await db.update(chatEndpointResources).set(resourceState === "disabled" ? { enabled: false } : { availability: "unavailable" }).where(eq(chatEndpointResources.endpointId, endpoint.id));
      }
      if (status === "attention") await db.update(toolConnections).set({ status: "disabled", enabled: false }).where(eq(toolConnections.id, endpoint.connectionId));
      const resourcesBefore = await f.service.listResources(endpoint.id);
      const conversationsBefore = await readChatConversationsByEndpointId(endpoint.id);
      const actionsBefore = await db.select().from(chatActions).where(eq(chatActions.endpointId, endpoint.id));
      f.wakeup.mockClear();
      await db.update(chatEndpoints).set({ status, setup: { ...endpoint.setup, webhookVerifiedAt: null } }).where(eq(chatEndpoints.id, endpoint.id));
      const response = await f.service.handleWebhook(endpoint.publicId, "github", signedGitHubWebhookRequest({
        event: "issue_comment", delivery: randomUUID(), webhookSecret: kind === "invalid_signature" ? "wrong-secret" : f.webhookSecret,
        payload: { action: "created", ...(kind === "missing_installation" ? {} : { installation: { id: kind === "foreign" ? 9999 : 2468 } }),
          repository: { id: 97531, full_name: "paperclipai/paperclip", owner: { id: 1357, login: "paperclipai" } },
          issue: { number: 418 }, comment: { id: 41801, body: status === "attention" ? `@${endpoint.botUsername} please review` : "Ordinary comment", user: { id: 42, login: "octocat" } }, sender: { id: 42, login: "octocat" } },
      }));
      if (kind === "invalid_signature") expect(response.status).toBe(401);
      else expect(response.status).toBeLessThan(300);
      const current = await f.service.get(endpoint.id);
      if (kind === "current") expect(current.setup.webhookVerifiedAt).toEqual(expect.any(String));
      else expect(current.setup.webhookVerifiedAt).toBeNull();
      if (status === "attention") {
        expect(current.status).toBe("attention");
        expect(await f.service.listResources(endpoint.id)).toEqual(resourcesBefore);
        expect(await readChatConversationsByEndpointId(endpoint.id)).toEqual(conversationsBefore);
        expect(await db.select().from(chatActions).where(eq(chatActions.endpointId, endpoint.id))).toEqual(actionsBefore);
        expect(f.wakeup).not.toHaveBeenCalled();
        if (kind === "current") {
          expect(current.setup.step).toBe("provider_setup");
          await f.service.handleWebhook(endpoint.publicId, "github", signedGitHubWebhookRequest({
            event: "installation_repositories", delivery: randomUUID(), webhookSecret: f.webhookSecret,
            payload: { action: "added", installation: { id: 2468 }, repositories_added: [], repositories_removed: [] },
          }));
          expect((await f.service.get(endpoint.id)).status).toBe("attention");
          expect((await readToolConnectionsById(endpoint.connectionId))[0]).toMatchObject({ status: "disabled", enabled: false });
          expect(f.wakeup).not.toHaveBeenCalled();
          const configured = await f.service.configure(endpoint.id, { action: "reconnect" }, "owner-user");
          expect(configured.status).toBe("verifying");
        }
      }
    });

    it("stack rejects forged raw gateway deliveries without changing verification or waking an agent", async () => {
      const f = await reviewBotFixture();
      await db
        .update(chatEndpoints)
        .set({
          setup: {
            ...f.endpoint.setup,
            webhookVerifiedAt: null,
            github: { stage: "verify", cloudRegistrationId: "registration-a" },
          },
        })
        .where(eq(chatEndpoints.id, f.endpoint.id));
      const body = JSON.stringify({ zen: "forged-ping" });
      const event = {
        id: "transport-event",
        provider: "github" as const,
        event: "gateway_delivery",
        action: null,
        installationId: null,
        repositoryId: null,
        createdAt: new Date().toISOString(),
        bindingIds: ["github-app:registration-a"],
        payload: {
          githubApp: {
            registrationId: "registration-a",
            rawBody: Buffer.from(body).toString("base64"),
            headers: {
              "x-github-event": "ping",
              "x-github-delivery": "provider-delivery",
              "x-hub-signature-256": `sha256=${createHmac("sha256", "wrong-secret").update(body).digest("hex")}`,
            },
          },
        },
      };
      const [connection] = await readToolConnectionsById(f.endpoint.connectionId);
      await db.update(toolConnections).set({credentialSecretRefs: connection.credentialSecretRefs.filter(ref => ref.configPath !== "credentials.webhookSecret")}).where(eq(toolConnections.id, connection.id));
      await expect(dispatchGitHubBotCloudEvent(db, event)).rejects.toThrow("credentials are not ready");
      await db.update(toolConnections).set({credentialSecretRefs: connection.credentialSecretRefs}).where(eq(toolConnections.id, connection.id));
      expect(await dispatchGitHubBotCloudEvent(db, event)).toBe(true);
      expect(
        (await f.service.get(f.endpoint.id)).setup.webhookVerifiedAt,
      ).toBeNull();
      expect(f.wakeup).not.toHaveBeenCalled();
      const poll = vi.fn(async () => { await dispatchGitHubBotCloudEvent(db, event); });
      const unregister = registerGitHubBotCloudSetupPoller(db, poll);
      try {
        const waiting = await f.service.githubWizard.advance(f.endpoint.id, "owner-user");
        expect(waiting.state).toBe("verify");
        expect(poll).toHaveBeenCalledOnce();
        expect((await f.service.get(f.endpoint.id)).setup.webhookVerifiedAt).toBeNull();
        event.payload.githubApp.headers["x-hub-signature-256"] =
          `sha256=${createHmac("sha256", f.webhookSecret).update(body).digest("hex")}`;
        const ready = await f.service.githubWizard.advance(f.endpoint.id, "owner-user");
        expect(ready.state).not.toBe("verify");
        expect((await f.service.get(f.endpoint.id)).setup.webhookVerifiedAt).toBeTruthy();
        expect(f.wakeup).not.toHaveBeenCalled();
        await f.service.githubWizard.advance(f.endpoint.id, "owner-user");
        expect(poll).toHaveBeenCalledTimes(2);
      } finally { unregister(); }
    });

    it("legacy name-only registration preserves an explicit empty repository selection", async () => {
      const fixture = await seedCompany();
      const { service } = createService(new FakeChatSdkRuntime(), fakeSlackFetch(), {
        publicBaseUrl: "https://reviews.example.test",
      });
      const bot = await service.create(fixture.companyId, {
        provider: "github", assignedAgentId: fixture.assignedAgentId,
      }, "owner-user");
      await service.replaceResources(bot.id, [], "owner-user");
      await service.startGitHubRegistration(bot.id, "owner-user", "Maya");
      const current = await service.get(bot.id);
      expect(current.setup.github?.repositorySelectionSaved).toBe(true);
      expect(current.setup.github?.initialRepositoryImportPending).not.toBe(true);
    });

    it("uses the manifest state parameter and rejects expired, reused, and wrong-origin registrations", async () => {
      const fixture = await seedCompany();
      const { service } = createService(
        new FakeChatSdkRuntime(),
        fakeSlackFetch(),
        { publicBaseUrl: "https://reviews.example.test" },
      );
      const endpoint = await service.create(
        fixture.companyId,
        { provider: "github", assignedAgentId: fixture.assignedAgentId },
        "owner-user",
      );
      const registration = await service.startGitHubRegistration(
        endpoint.id,
        "owner-user",
        "Paperclip Review QA",
      );
      expect(registration.manifest.redirect_url).toBe(
        "https://reviews.example.test/api/chat-github/manifest/callback",
      );
      const state = new URL(registration.registrationUrl).searchParams.get(
        "state",
      )!;
      expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const moved = createService(new FakeChatSdkRuntime(), fakeSlackFetch(), {
        publicBaseUrl: "https://different.example.test",
      });
      await expect(
        moved.service.completeGitHubRegistration(state, "code"),
      ).rejects.toThrow("expired or was already used");
      const [pending] = await readChatGitHubRegistrationsByEndpointId(endpoint.id);
      expect(pending.status).toBe("pending");
      await db
        .update(chatGitHubRegistrations)
        .set({ expiresAt: new Date(0) })
        .where(eq(chatGitHubRegistrations.id, pending.id));
      await expect(
        service.completeGitHubRegistration(state, "code"),
      ).rejects.toThrow("expired or was already used");
      await db
        .update(chatGitHubRegistrations)
        .set({ expiresAt: new Date(Date.now() + 60000), status: "completed" })
        .where(eq(chatGitHubRegistrations.id, pending.id));
      await expect(
        service.completeGitHubRegistration(state, "code"),
      ).rejects.toThrow("expired or was already used");
    });

    it("checks live repository permission and reports a revoked installation selection", async () => {
      const f = await reviewBotFixture();
      const permissions = {
        contents: "read",
        issues: "write",
        metadata: "read",
        pull_requests: "write",
        checks: "write",
      };
      f.setAppAccess({
        permissions,
        events: ["issue_comment", "pull_request_review_comment", "pull_request"],
      });
      let revoked = false;
      f.setSupplementalProviderFetch(async (input, init) => {
        if (String(input).endsWith("/app/installations/2468"))
          return Response.json({ permissions, suspended_at: null });
        if (String(input).endsWith("/access_tokens")) {
          expect(JSON.parse(String(init?.body)).repository_ids).toEqual([97531]);
          return revoked
            ? new Response("", { status: 403 })
            : Response.json({ token: "test-installation-token" });
        }
        return undefined;
      });
      const verified = await f.management.verification(f.endpoint.id);
      expect(
        verified.checks.find((check) => check.key === "repositories")?.ok,
      ).toBe(true);
      revoked = true;
      const denied = await f.management.verification(f.endpoint.id);
      expect(denied.ready).toBe(false);
      expect(
        denied.checks.find((check) => check.key === "repositories"),
      ).toMatchObject({
        ok: false,
        detail: expect.stringContaining("Restore installation access"),
      });
    });

    it.each([86, 501])("verifies %i enabled repositories in bounded token batches", async (count) => {
      const f = await reviewBotFixture();
      const permissions = { contents: "read", issues: "write", metadata: "read", pull_requests: "write", checks: "write" };
      f.setAppAccess({ permissions, events: ["pull_request", "issue_comment", "pull_request_review_comment"] });
      const [first] = await db.select().from(chatEndpointResources)
        .where(eq(chatEndpointResources.endpointId, f.endpoint.id));
      const ids = [Number(first.metadata!.providerRepositoryId)];
      await db.insert(chatEndpointResources).values(Array.from({ length: count - 1 }, (_, index) => {
        const repositoryId = 100_000 + index;
        ids.push(repositoryId);
        return { ...first, id: randomUUID(), providerResourceId: `paperclipai/repo-${index}`,
          label: `paperclipai/repo-${index}`, enabled: true, availability: "available" as const,
          metadata: { ...first.metadata, providerRepositoryId: repositoryId } };
      }));
      // A saved narrower selection must never be included just because it is
      // present in the installation inventory.
      await db.insert(chatEndpointResources).values({ ...first, id: randomUUID(),
        providerResourceId: "paperclipai/disabled", label: "paperclipai/disabled", enabled: false,
        metadata: { ...first.metadata, providerRepositoryId: 999_999 } });
      const batches: number[][] = [];
      let revoked = false;
      f.setSupplementalProviderFetch(async (input, init) => {
        if (String(input).endsWith("/app/installations/2468"))
          return Response.json({ permissions, suspended_at: null });
        if (String(input).endsWith("/access_tokens")) {
          const body = JSON.parse(String(init?.body));
          expect(body.permissions).toEqual(permissions);
          expect(body.repository_ids.length).toBeGreaterThan(0);
          expect(body.repository_ids.length).toBeLessThanOrEqual(500);
          batches.push(body.repository_ids);
          return revoked ? new Response("", { status: 403 }) : Response.json({ token: "test-installation-token" });
        }
        return undefined;
      });
      const verified = await f.management.verification(f.endpoint.id);
      expect(verified.checks.find((check) => check.key === "repositories")?.ok).toBe(true);
      expect(batches).toHaveLength(Math.ceil(count / 500));
      expect(batches.flat().sort((a, b) => a - b)).toEqual(ids.sort((a, b) => a - b));
      revoked = true;
      const denied = await f.management.verification(f.endpoint.id);
      expect(denied.connectionReady).toBe(false);
      expect(denied.checks.find((check) => check.key === "repositories")?.ok).toBe(false);
    });

    it("requires every essential GitHub tool and rejects Contents write during verification", async () => {
      const f = await reviewBotFixture();
      let contents = "read";
      const permissions = {
        contents: "read",
        issues: "write",
        metadata: "read",
        pull_requests: "write",
        checks: "write",
      };
      f.setAppAccess({
        permissions,
        events: [
          "issue_comment",
          "pull_request_review_comment",
          "pull_request",
        ],
      });
      f.setSupplementalProviderFetch(async (input) =>
        String(input).endsWith("/app/installations/2468")
          ? Response.json({
              permissions: { ...permissions, contents },
              suspended_at: null,
            })
          : undefined,
      );
      const tools = () =>
        f.management
          .verification(f.endpoint.id)
          .then((result) =>
            result.checks.find((check) => check.key === "tools"),
          );
      expect(await tools()).toMatchObject({ ok: true });
      for (const toolName of [
        "read_pull_request",
        "read_file",
        "comment",
        "begin_review",
        "submit_review",
      ]) {
        await db
          .update(toolCatalogEntries)
          .set({ status: "quarantined" })
          .where(
            and(
              eq(toolCatalogEntries.connectionId, f.endpoint.connectionId),
              eq(toolCatalogEntries.toolName, toolName),
            ),
          );
        expect(await tools()).toMatchObject({
          ok: false,
          detail: expect.stringContaining("Repair tool policy"),
        });
        await db
          .update(toolCatalogEntries)
          .set({ status: "active" })
          .where(
            and(
              eq(toolCatalogEntries.connectionId, f.endpoint.connectionId),
              eq(toolCatalogEntries.toolName, toolName),
            ),
          );
      }
      contents = "write";
      expect(
        (await f.management.verification(f.endpoint.id)).checks.find(
          (check) => check.key === "permissions",
        ),
      ).toMatchObject({ ok: false });
    });

    it("keeps GitHub publication I/O outside transactions and fences an expired owner's receipt", async () => {
      const f = await reviewBotFixture();
      const scope = {
        companyId: f.companyId,
        endpointId: f.endpoint.id,
        repositoryId: "97531",
        number: 9876,
      };
      let releaseFirst!: () => void;
      let firstEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        firstEntered = resolve;
      });
      const transport = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const fetcher = vi.fn(async () => {
        firstEntered();
        await transport;
        return Response.json({ ok: true });
      }) as unknown as typeof fetch;
      const staleCommit = vi.fn();
      const first = withGitHubPublicationLease(
        db,
        scope,
        fetcher,
        async (lease) => {
          await lease.fetch("https://api.github.com/test");
          await lease.commit(async () => {
            staleCommit();
          });
        },
      ).catch((error) => error);
      await entered;
      // Another connection can lock this row while provider I/O is pending.
      await db.transaction(async (tx) => {
        await tx
          .select()
          .from(chatEndpointLeases)
          .where(eq(chatEndpointLeases.endpointId, f.endpoint.id))
          .for("update", { noWait: true });
      });
      const blocked = vi.fn();
      await withGitHubPublicationLease(db, scope, fetcher, async () => {
        blocked();
      });
      expect(blocked).not.toHaveBeenCalled();
      await db
        .update(chatEndpointLeases)
        .set({ expiresAt: new Date(0) })
        .where(eq(chatEndpointLeases.endpointId, f.endpoint.id));
      let releaseSecond!: () => void;
      let secondEntered!: () => void;
      const secondReady = new Promise<void>((resolve) => {
        secondEntered = resolve;
      });
      const secondHold = new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
      const second = withGitHubPublicationLease(
        db,
        scope,
        fetcher,
        async (lease) => {
          secondEntered();
          await secondHold;
          await lease.commit(async (tx) => {
            await tx
              .select()
              .from(chatEndpoints)
              .where(eq(chatEndpoints.id, f.endpoint.id));
          });
        },
      );
      await secondReady;
      const [newOwner] = await db
        .select()
        .from(chatEndpointLeases)
        .where(eq(chatEndpointLeases.endpointId, f.endpoint.id));
      releaseFirst();
      expect(await first).toBeInstanceOf(GitHubPublicationLeaseLost);
      expect(staleCommit).not.toHaveBeenCalled();
      expect(
        (
          await db
            .select()
            .from(chatEndpointLeases)
            .where(eq(chatEndpointLeases.id, newOwner.id))
        )[0]?.token,
      ).toBe(newOwner.token);
      releaseSecond();
      await second;
      expect(
        await db
          .select()
          .from(chatEndpointLeases)
          .where(eq(chatEndpointLeases.endpointId, f.endpoint.id)),
      ).toHaveLength(0);
    });

    it("wakes GitHub milestone identity restoration only after outer commit and stays quiet on reconfirmation", async () => {
      const f = await reviewBotFixture();
      await f.service.revokeLink(f.endpoint.id, f.principal.id);
      const verified = { githubUserId: "42", login: "octocat" };
      const events: string[] = [];
      const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.chatRunMilestones, (event, scopes) => {
        if ([...scopes ?? []].some(scope => JSON.parse(scope).companyId === f.companyId)) events.push(event);
      });
      const link = () => db.select().from(chatIdentityLinks).where(and(
        eq(chatIdentityLinks.endpointId, f.endpoint.id), eq(chatIdentityLinks.principalId, f.principal.id),
      )).then(rows => rows[0]);
      try {
        await expect(db.transaction(async tx => {
          await githubChatManagementService(tx as unknown as typeof db, f.providerFetch)
            .linkObservedIdentity(f.endpoint.id, "owner-user", verified);
          expect(events).toEqual(["intent"]);
          expect((await link()).status).toBe("revoked");
          throw new Error("rollback identity restoration");
        })).rejects.toThrow("rollback identity restoration");
        expect((await link()).status).toBe("revoked");
        events.length = 0;
        await db.transaction(async tx => {
          await githubChatManagementService(tx as unknown as typeof db, f.providerFetch)
            .linkObservedIdentity(f.endpoint.id, "owner-user", verified);
          expect(events).toEqual(["intent"]);
          expect((await link()).status).toBe("revoked");
        });
        expect(events).toEqual(["intent", "settled"]);
        expect((await link()).status).toBe("linked");
        events.length = 0;
        await f.management.linkObservedIdentity(f.endpoint.id, "owner-user", verified);
        expect(events).toEqual([]);
      } finally { unsubscribe(); }
    });

    it("wakes milestone authority only when GitHub guest settings change, after outer commit", async () => {
      const f = await reviewBotFixture();
      const initial = await f.management.configuration(f.endpoint.id, "owner-user");
      const configuration = { ...initial.configuration, people: [{
        kind: "guest" as const, githubUserId: "84", login: "contributor",
        sponsorUserId: "owner-user", permissionProfile: "restricted" as const, automaticReviews: false,
      }] };
      const events: string[] = [];
      const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.chatRunMilestones, (event, scopes) => {
        if ([...scopes ?? []].some(scope => JSON.parse(scope).companyId === f.companyId)) events.push(event);
      });
      try {
        await db.transaction(async tx => {
          await githubChatManagementService(tx as unknown as typeof db, f.providerFetch)
            .saveConfiguration(f.endpoint.id, { expectedRevision: initial.revision, configuration }, "owner-user");
          expect(events).toEqual(["intent"]);
          expect((await f.service.get(f.endpoint.id)).allowUnlinkedPeople).toBe(false);
        });
        expect(events).toEqual(["intent", "settled"]);
        expect((await f.service.get(f.endpoint.id)).allowUnlinkedPeople).toBe(true);
        events.length = 0;
        const current = await f.management.configuration(f.endpoint.id, "owner-user");
        await f.management.saveConfiguration(f.endpoint.id, { expectedRevision: current.revision, configuration }, "owner-user");
        expect(events).toEqual([]);
      } finally { unsubscribe(); }
    });

    it("scopes guest tasks and rechecks their sponsor before every bot tool", async () => {
      const f = await reviewBotFixture();
      const initial = await f.management.configuration(
        f.endpoint.id,
        "owner-user",
      );
      await f.management.saveConfiguration(
        f.endpoint.id,
        {
          expectedRevision: initial.revision,
          configuration: {
            ...initial.configuration,
            people: [
              {
                kind: "guest",
                githubUserId: "84",
                login: "contributor",
                sponsorUserId: "owner-user",
                permissionProfile: "restricted",
                automaticReviews: false,
              },
            ],
          },
        },
        "owner-user",
      );
      const thread = makeThread({
        channelId: "paperclipai/paperclip",
        id: "github:paperclipai/paperclip:94",
        name: "Guest review",
      }).thread;
      await deliverMessage({
        callbacks: f.callbacks,
        endpointId: f.endpoint.id,
        provider: "github",
        thread,
        trigger: "mention",
        message: makeMessage({
          id: "guest-review-request",
          text: "Please review this PR",
          userId: "84",
          userName: "contributor",
          mentioned: true,
        }),
      });
      const [link] = await db
        .select()
        .from(chatMessageLinks)
        .where(
          and(
            eq(chatMessageLinks.endpointId, f.endpoint.id),
            eq(chatMessageLinks.direction, "inbound"),
          ),
        );
      expect(link).toBeDefined();
      const [conversation] = await readChatConversationsById(link.conversationId);
      const [task] = await readIssuesById(conversation.issueId);
      expect(task.sourceTrust?.preset).toBe("low_trust_review");
      expect(task.executionPolicy?.authorizationPolicy).toMatchObject({
        trustBoundary: {
          companyId: f.companyId,
          rootIssueId: task.id,
          allowedAgentIds: [f.assignedAgentId],
        },
      });
      const [run] = await db
        .insert(heartbeatRuns)
        .values({
          companyId: f.companyId,
          agentId: f.assignedAgentId,
          invocationSource: "assignment",
          status: "running",
          contextSnapshot: { issueId: task.id, wakeCommentId: link.commentId },
        })
        .returning();
      await initializeRunIdentity(db, { companyId: f.companyId, runId: run.id, issueId: task.id, responsibleUserId: "owner-user", cause: "issue_responsible_user" });
      const exported = await resolveGitHubOperationCredentials(db, { companyId: f.companyId, agentId: f.assignedAgentId, runId: run.id });
      expect(exported.status).toBe("unavailable");
      expect(exported.env).toEqual({});
      await db
        .update(companyMemberships)
        .set({ status: "inactive" })
        .where(
          and(
            eq(companyMemberships.companyId, f.companyId),
            eq(companyMemberships.principalId, "owner-user"),
          ),
        );
      await expect(
        githubChatReviewService(db, f.providerFetch).execute(
          {
            companyId: f.companyId,
            agentId: f.assignedAgentId,
            issueId: task.id,
            runId: run.id,
          },
          "read_pull_request",
          { section: "metadata" },
        ),
      ).rejects.toThrow("no longer authorized");
    });

    it.each(["issues", "pull_request", "issue_comment", "pull_request_review_comment", "pull_request_review"])(
      "admits signed %s mentions with automation off, deduplicates and retains manual task authority", async (event) => {
        const f = await reviewBotFixture();
        const saved = await f.management.configuration(f.endpoint.id, "owner-user");
        await f.management.saveConfiguration(f.endpoint.id, { expectedRevision: saved.revision, configuration: { ...saved.configuration, defaults: { ...saved.configuration.defaults, invocation: "mentions_only", events: [], issueOpened: false }, repositories: { ...saved.configuration.repositories, "97531": { instructions: "Use repository-specific guidance" } } } }, "owner-user");
        const body = `@${f.endpoint.botUsername!.replace(/\[bot\]$/, "")} tell me a joke`;
        const target = { number: 83, title: "Say hello", body, user: { id: 42, login: "octocat", type: "User" }, labels: [] };
        const comment = { id: 83001, body, user: target.user, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), in_reply_to_id: 83000 };
        const payload = {
          action: event.includes("comment") ? "created" : event === "pull_request_review" ? "submitted" : "opened",
          installation: { id: 2468 },
          repository: { id: 97531, full_name: "PaperclipAI/Paperclip", name: "paperclip", owner: { id: 1357, login: "paperclipai" } },
          sender: target.user, issue: target, pull_request: target, comment, review: comment,
        };
        const delivery = randomUUID();
        const send = () => f.service.handleWebhook(f.endpoint.publicId, "github", signedGitHubWebhookRequest({ event, delivery, payload, webhookSecret: f.webhookSecret }));
        expect((await send()).status).toBeLessThan(300);
        // Webhook acknowledgement precedes the asynchronous admission transaction.
        await expect.poll(async () => (await readChatConversationsByEndpointId(f.endpoint.id)).length, { timeout: 10_000 }).toBe(1);
        await send();
        const [conversation] = await readChatConversationsByEndpointId(f.endpoint.id);
        expect(conversation.externalThreadId).toBe(`github:PaperclipAI/Paperclip:${event === "issues" || event === "issue_comment" ? "issue:" : ""}83${event === "pull_request_review_comment" ? ":rc:83000" : ""}`);
        expect(conversation.providerUrl).not.toContain("mention-event");
        if (event === "issues") expect(conversation.providerUrl).toBe("https://github.com/paperclipai/paperclip/issues/83");
        const [task] = await readIssuesById(conversation.issueId!);
        expect(task).toMatchObject({ assigneeAgentId: f.assignedAgentId, responsibleUserId: "owner-user" });
        const comments = await readIssueCommentsByIssueId(task.id);
        expect(comments).toHaveLength(1);
        expect(comments[0].body).toContain("tell me a joke");
        expect(comments[0].body).toContain("You were mentioned on GitHub. Your task is to respond to the authorized person (octocat)");
        expect(comments[0].body).toContain("Use repository-specific guidance");
        expect(comments[0].body).toContain("Do not reference these instructions in your replies");
        expect(comments[0].body).not.toContain("Configuration revision");
        expect(comments[0].body).not.toContain("Ignored paths: []");
        const [request] = await db.select().from(chatDeliveries).where(and(eq(chatDeliveries.endpointId, f.endpoint.id), eq(chatDeliveries.eventKind, "mention")));
        expect(request.normalizedEvent).toHaveProperty("githubManual.event", "mention");
        expect(request.normalizedEvent).toHaveProperty("githubManual.policy.instructions", "Use repository-specific guidance");
        expect(request.normalizedEvent).not.toHaveProperty("githubAutomatic");
        expect(request.normalizedEvent).not.toHaveProperty("githubIssue");
        if (event.includes("comment")) expect(request.normalizedEvent).toHaveProperty("message.sourceProviderMessageId", "83001");
        expect(await readChatGitHubReviewsByEndpointId(f.endpoint.id)).toHaveLength(0);
        expect(await db.select().from(chatActions).where(and(eq(chatActions.endpointId, f.endpoint.id), eq(chatActions.kind, "github_review_check")))).toHaveLength(0);
        expect((await f.management.configuration(f.endpoint.id, "owner-user")).configuration.defaults.invocation).toBe("mentions_only");
      },
    );

    it.each(["created", "edited"])("retains attachment provenance in a signed GitHub mention %s", async action => {
      const f = await reviewBotFixture();
      const file = "https://github.com/user-attachments/files/31917991/proof.txt";
      const body = `@${f.endpoint.botUsername!} read [this proof](${file})`;
      const payload = { action, installation: { id: 2468 },
        repository: { id: 97531, full_name: "paperclipai/paperclip", name: "paperclip", owner: { id: 1357, login: "paperclipai" } },
        sender: { id: 42, login: "octocat", type: "User" }, issue: { number: 83, body: "", title: "Proof", user: { id: 42, login: "octocat" } },
        comment: { id: 83001, body, user: { id: 42, login: "octocat" }, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
        ...(action === "edited" ? { changes: { body: { from: "No mention" } } } : {}) };
      await f.service.handleWebhook(f.endpoint.publicId, "github", signedGitHubWebhookRequest({ event: "issue_comment", delivery: randomUUID(), payload, webhookSecret: f.webhookSecret }));
      await expect.poll(async () => (await db.select().from(chatDeliveries).where(and(eq(chatDeliveries.endpointId, f.endpoint.id), eq(chatDeliveries.eventKind, "mention")))).length).toBe(1);
      const [request] = await db.select().from(chatDeliveries).where(and(eq(chatDeliveries.endpointId, f.endpoint.id), eq(chatDeliveries.eventKind, "mention")));
      expect(request.normalizedEvent).toHaveProperty("message.sourceProviderMessageId", "83001");
      expect(request.normalizedEvent).toHaveProperty("message.attachments.0.recovery.locator.sourceMessageId", "83001");
      expect(request.normalizedEvent).toHaveProperty("message.attachments.0.recovery.locator.url", file);
    });

    it("authorizes description edits as the editor, never inheriting the original author's access", async () => {
      const f = await reviewBotFixture();
      const body = `@${f.endpoint.botUsername!} help`;
      const payload = {
        action: "edited", installation: { id: 2468 },
        repository: { id: 97531, full_name: "paperclipai/paperclip", name: "paperclip", owner: { id: 1357, login: "paperclipai" } },
        sender: { id: 77, login: "unlinked-editor", type: "User" },
        issue: { number: 84, title: "Say hello", body, user: { id: 42, login: "octocat", type: "User" }, labels: [] },
        changes: { body: { from: "No mention" } },
      };
      const send = (content = payload) => f.service.handleWebhook(f.endpoint.publicId, "github", signedGitHubWebhookRequest({ event: "issues", delivery: randomUUID(), payload: content, webhookSecret: f.webhookSecret }));
      await send();
      expect(await readChatConversationsByEndpointId(f.endpoint.id)).toHaveLength(0);
      expect(f.wakeup).not.toHaveBeenCalled();
      const allowed = { ...payload, sender: { id: 42, login: "octocat", type: "User" }, issue: { ...payload.issue, user: payload.sender } };
      await send(allowed);
      // A transient `chat_endpoints` row lock defers admission with a retry
      // floor of 1000 ms (`chat-channels/inbound/wakeups.ts`), so allow one
      // deferred retry instead of the 1000 ms poll default.
      await expect.poll(async () => (await readChatConversationsByEndpointId(f.endpoint.id)).length, { timeout: 10_000 }).toBe(1);
      const [conversation] = await readChatConversationsByEndpointId(f.endpoint.id);
      const comments = await readIssueCommentsByIssueId(conversation.issueId!);
      expect(comments).toHaveLength(1);
      await send({ ...allowed, changes: { body: { from: body } } });
      expect(await readIssueCommentsByIssueId(conversation.issueId!)).toHaveLength(1);
      await db.update(chatIdentityLinks).set({ status: "revoked" }).where(eq(chatIdentityLinks.principalId, f.principal.id));
      await send({ ...allowed, issue: { ...allowed.issue, number: 85 } });
      expect(await readChatConversationsByEndpointId(f.endpoint.id)).toHaveLength(1);
      expect(await f.service.listActivity(f.endpoint.id)).toEqual(expect.arrayContaining([expect.objectContaining({ status: "filtered" })]));
    });

    it.each(["issue_comment", "pull_request_review_comment"])("admits a newly mentioned %s edit while preserving its lifecycle record", async (event) => {
      const f = await reviewBotFixture();
      const target = { number: 83, title: "Say hello", body: "Description", user: { id: 42, login: "octocat", type: "User" } };
      const payload = {
        action: "edited", installation: { id: 2468 },
        repository: { id: 97531, full_name: "paperclipai/paperclip", name: "paperclip", owner: { id: 1357, login: "paperclipai" } },
        sender: target.user, issue: target, pull_request: target,
        comment: { id: 83001, body: `@${f.endpoint.botUsername!} help`, user: target.user, updated_at: new Date().toISOString() },
        changes: { body: { from: "No mention" } },
      };
      await f.service.handleWebhook(f.endpoint.publicId, "github", signedGitHubWebhookRequest({ event, delivery: randomUUID(), payload, webhookSecret: f.webhookSecret }));
      await expect.poll(async () => (await readChatConversationsByEndpointId(f.endpoint.id)).length, { timeout: 10_000 }).toBe(1);
      const deliveries = await readChatDeliveriesByEndpointId(f.endpoint.id);
      expect(deliveries).toEqual(expect.arrayContaining([
        expect.objectContaining({ eventKind: "message_updated" }),
        expect.objectContaining({ eventKind: "mention", normalizedEvent: expect.objectContaining({ githubManual: expect.objectContaining({ event: "mention" }) }) }),
      ]));
      const request = deliveries.find(delivery => delivery.eventKind === "mention")!;
      expect(request.normalizedEvent).toHaveProperty("message.sourceProviderMessageId", "83001");
      await f.service.handleWebhook(f.endpoint.publicId, "github", signedGitHubWebhookRequest({ event, delivery: randomUUID(),
        payload: { ...payload, action: "deleted" }, webhookSecret: f.webhookSecret }));
      await expect.poll(async () => (await db.select().from(chatDeliveries).where(and(eq(chatDeliveries.endpointId, f.endpoint.id), eq(chatDeliveries.eventKind, "message_deleted"))))
        .some(deletion => (deletion.normalizedEvent.message as { targetProviderEventId?: string }).targetProviderEventId === request.providerEventId)).toBe(true);
    });

    it("records automatic policy skips without retaining provider content, and refuses mentions in disabled repositories", async () => {
      const f = await reviewBotFixture();
      const saved = await f.management.configuration(f.endpoint.id, "owner-user");
      await f.management.saveConfiguration(f.endpoint.id, { expectedRevision: saved.revision, configuration: { ...saved.configuration, defaults: { ...saved.configuration.defaults, invocation: "mentions_only" } } }, "owner-user");
      const payload = {
        action: "opened", installation: { id: 2468 },
        repository: { id: 97531, full_name: "paperclipai/paperclip", name: "paperclip", owner: { id: 1357, login: "paperclipai" } },
        sender: { id: 42, login: "octocat" },
        issue: { number: 86, title: "Private title", body: "Private body", user: { id: 42, login: "octocat", type: "User" }, labels: [] },
      };
      const delivery = randomUUID();
      const send = (content = payload, guid = delivery) => f.service.handleWebhook(f.endpoint.publicId, "github", signedGitHubWebhookRequest({ event: "issues", delivery: guid, payload: content, webhookSecret: f.webhookSecret }));
      await send(); await send();
      const activity = await f.service.listActivity(f.endpoint.id);
      expect(activity.filter(row => row.status === "filtered")).toHaveLength(1);
      expect(activity).toEqual(expect.arrayContaining([expect.objectContaining({ detail: expect.stringContaining("runs only when mentioned") })]));
      const [ignored] = await readChatDeliveriesByEndpointId(f.endpoint.id);
      expect(JSON.stringify(ignored.normalizedEvent)).not.toContain("Private");
      expect(ignored.normalizedEvent).toHaveProperty("filtering.contentRetained", false);
      await db.update(chatEndpointResources).set({ enabled: false }).where(eq(chatEndpointResources.endpointId, f.endpoint.id));
      await send({ ...payload, issue: { ...payload.issue, body: `@${f.endpoint.botUsername!} help` } }, randomUUID());
      expect(await readChatConversationsByEndpointId(f.endpoint.id)).toHaveLength(0);
      expect(f.wakeup).not.toHaveBeenCalled();
    });

    it("admits opt-in signed issue events without PR checks, deduplicates them and rechecks revoked policy", async () => {
      const f = await reviewBotFixture();
      const { buildSkillMentionHref } = await import("@paperclipai/shared");
      const [skill] = await db.insert(companySkills).values({
        companyId: f.companyId, key: `company/${f.companyId}/automatic-playbook`,
        slug: "automatic-playbook", name: "Automatic playbook", markdown: "# Automatic playbook",
      }).returning();
      const instruction = `Use [/automatic-playbook](${buildSkillMentionHref(skill.id, skill.slug)}).`;
      const payload = {
        action: "opened", installation: { id: 2468 },
        repository: { id: 97531, full_name: "paperclipai/paperclip", name: "paperclip", owner: { id: 1357, login: "paperclipai" } },
        sender: { id: 77, login: "maintainer" },
        issue: { number: 83, title: "Say hello", body: "Untrusted issue body", user: { id: 42, login: "octocat", type: "User" }, labels: [] },
      };
      const send = (delivery = randomUUID(), content = payload) => f.service.handleWebhook(f.endpoint.publicId, "github", signedGitHubWebhookRequest({
        event: "issues", delivery, payload: content, webhookSecret: f.webhookSecret,
      }));
      expect((await send()).status).toBeLessThan(300);
      expect(await readChatConversationsByEndpointId(f.endpoint.id)).toHaveLength(0);
      const saved = await f.management.configuration(f.endpoint.id, "owner-user");
      await f.management.saveConfiguration(f.endpoint.id, {
        expectedRevision: saved.revision,
        configuration: { ...saved.configuration, defaults: { ...saved.configuration.defaults, instructions: instruction, issueOpened: true, issueOpenedInstructions: "Reply with an ASCII animal." } },
      }, "owner-user");
      const delivery = randomUUID();
      expect((await send(delivery)).status).toBeLessThan(300);
      await expect.poll(async () => (await readChatConversationsByEndpointId(f.endpoint.id)).length, { timeout: 10000 }).toBe(1);
      await send(delivery);
      const [conversation] = await readChatConversationsByEndpointId(f.endpoint.id);
      const [task] = await readIssuesById(conversation.issueId!);
      expect(task).toMatchObject({ title: "GitHub issue #83: Say hello", assigneeAgentId: f.assignedAgentId, responsibleUserId: "owner-user", originKind: "chat_channel" });
      expect(conversation.providerUrl).toBe("https://github.com/paperclipai/paperclip/issues/83");
      const comments = await readIssueCommentsByIssueId(task.id);
      expect(comments).toHaveLength(1);
      expect(comments[0].body).toContain(instruction);
      expect(comments[0].body).toContain("Read the SKILL.md");
      expect(await resolveRunScopedMentionedSkillKeys({ db, companyId: f.companyId, issueId: task.id, commentIds: [comments[0].id] })).toEqual([skill.key]);
      expect(comments[0].body).toContain("Reply with an ASCII animal.");
      expect(comments[0].body).toContain("Untrusted GitHub issue context");
      expect(await readChatGitHubReviewsByEndpointId(f.endpoint.id)).toHaveLength(0);
      expect(await db.select().from(chatActions).where(and(eq(chatActions.endpointId, f.endpoint.id), eq(chatActions.kind, "github_review_check")))).toHaveLength(0);
      const [run] = await db.insert(heartbeatRuns).values({
        companyId: f.companyId, agentId: f.assignedAgentId, invocationSource: "assignment", status: "running",
        contextSnapshot: { issueId: task.id, wakeCommentId: comments[0].id },
      }).returning();
      const current = await f.management.configuration(f.endpoint.id, "owner-user");
      await f.management.saveConfiguration(f.endpoint.id, {
        expectedRevision: current.revision,
        configuration: { ...current.configuration, defaults: { ...current.configuration.defaults, issueOpened: false } },
      }, "owner-user");
      await expect(githubChatReviewService(db, f.providerFetch).execute({ companyId: f.companyId, agentId: f.assignedAgentId, issueId: task.id, runId: run.id }, "comment", {
        body: "Late reply", idempotencyKey: "revoked-issue",
      })).rejects.toThrow("Automatic GitHub task authority is no longer available");
    });

    it("does not admit an unlinked issue author through the linked webhook sender", async () => {
      const f = await reviewBotFixture();
      const saved = await f.management.configuration(f.endpoint.id, "owner-user");
      await f.management.saveConfiguration(f.endpoint.id, {
        expectedRevision: saved.revision,
        configuration: { ...saved.configuration, defaults: { ...saved.configuration.defaults, issueOpened: true } },
      }, "owner-user");
      expect((await f.service.handleWebhook(f.endpoint.publicId, "github", signedGitHubWebhookRequest({
        event: "issues", delivery: randomUUID(), webhookSecret: f.webhookSecret,
        payload: {
          action: "opened", installation: { id: 2468 },
          repository: { id: 97531, full_name: "paperclipai/paperclip", name: "paperclip", owner: { id: 1357, login: "paperclipai" } },
          sender: { id: 42, login: "octocat" },
          issue: { number: 84, title: "No authority", body: "", user: { id: 999, login: "unknown", type: "User" }, labels: [] },
        },
      }))).status).toBeLessThan(300);
      expect(await readChatConversationsByEndpointId(f.endpoint.id)).toHaveLength(0);
      expect(await readChatGitHubReviewsByEndpointId(f.endpoint.id)).toHaveLength(0);
    });

    it("offers Retry for a saved automatic PR event after a successful older review", async () => {
      const f = await reviewBotFixture();
      const payload = {
        action: "opened", installation: { id: 2468 },
        repository: { id: 97531, full_name: "paperclipai/paperclip", name: "paperclip", owner: { id: 1357, login: "paperclipai" } },
        sender: { id: 77, login: "maintainer" },
        pull_request: { number: 81, title: "Review successive heads", body: "", draft: false,
          base: { sha: "a".repeat(40), ref: "master" }, head: { sha: "b".repeat(40) },
          user: { id: 42, login: "octocat", type: "User" }, labels: [] },
      };
      const send = async (event: typeof payload) => {
        await f.service.handleWebhook(f.endpoint.publicId, "github", signedGitHubWebhookRequest({
          event: "pull_request", delivery: randomUUID(), payload: event, webhookSecret: f.webhookSecret,
        }));
        await f.service.processPendingDeliveries();
      };
      await send(payload);
      await expect.poll(async () => {
        await f.service.processPendingDeliveries();
        return (await readChatConversationsByEndpointId(f.endpoint.id)).length;
      }, { timeout: 10_000 }).toBe(1);
      const [conversation] = await readChatConversationsByEndpointId(f.endpoint.id);
      const [task] = await readIssuesById(conversation.issueId!);
      const [original] = await db.select().from(chatActions).where(and(
        eq(chatActions.conversationId, conversation.id), eq(chatActions.kind, "inbound_wakeup")));
      await expect.poll(async () => (await readAgentWakeupRequestsById(original.id)).length).toBe(1);
      const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.assignedAgentId,
        issueId: task.id, status: "succeeded", finishedAt: new Date(), wakeupRequestId: original.id,
        contextSnapshot: { issueId: task.id, taskKey: task.identifier, source: "chat:github", wakeCommentIds: [original.payload.commentId] },
      }).returning();
      await db.update(agentWakeupRequests).set({ status: "completed", runId: run.id }).where(eq(agentWakeupRequests.id, original.id));
      await send({ ...payload, action: "synchronize", pull_request: { ...payload.pull_request, head: { sha: "c".repeat(40) } } });
      await expect.poll(async () => {
        await f.service.processPendingDeliveries();
        return (await db.select().from(chatActions).where(and(
          eq(chatActions.conversationId, conversation.id), eq(chatActions.kind, "inbound_wakeup")))).length;
      }).toBe(2);
      const [pending] = await db.select().from(chatActions).where(and(
        eq(chatActions.conversationId, conversation.id), eq(chatActions.kind, "inbound_wakeup"), ne(chatActions.id, original.id)));
      await expect.poll(async () => (await readAgentWakeupRequestsById(pending.id)).length).toBe(1);
      const [receipt] = await readAgentWakeupRequestsById(pending.id);
      await db.update(agentWakeupRequests).set({ status: "deferred_issue_execution", runId: null,
        payload: withQueuedCommentIdsInWakePayload(receipt.payload, [String(pending.payload.commentId)]),
        requestedAt: new Date(Date.now() - 60_000) }).where(eq(agentWakeupRequests.id, pending.id));
      expect(receipt.requestedByActorType).toBe("user");
      await db.update(issues).set({ status: "blocked", executionRunId: null }).where(eq(issues.id, task.id));
      expect(await taskInterruptionPresentation(db, { ...task, status: "blocked" }))
        .toMatchObject({ state: "failed", canRetry: true, intentId: pending.id, observedRunId: run.id });
      await db.update(agents).set({ status: "running", runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } })
        .where(eq(agents.id, f.assignedAgentId));
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.assignedAgentId, status: "running", startedAt: new Date() });
      f.wakeup.mockImplementation(heartbeatService(db).wakeup);
      const retry = await requestTaskRetry({ db, companyId: f.companyId, issueId: task.id, actorId: "owner-user",
        actorSource: "cloud_tenant", observedRunId: run.id, idempotencyKey: randomUUID(), prepareChatRetry: f.service.prepareFailedChatRunRetry });
      await reconcileTaskChatRetryReceipts(db, { companyId: f.companyId });
      const [resumed] = await readAgentWakeupRequestsById(pending.id);
      expect(resumed.runId).toBeTruthy();
      expect((await readHeartbeatRunsById(resumed.runId!))[0]).toMatchObject({ status: "queued", retryOfRunId: null,
        contextSnapshot: { wakeCommentIds: [pending.payload.commentId] } });
      expect((await readAgentWakeupRequestsById(retry.requestId!))[0]).toMatchObject({ status: "coalesced", runId: resumed.runId });
    });

    it("admits signed PR events into an ordinary assigned task and deduplicates delivery", async () => {
      const f = await reviewBotFixture();
      const { buildSkillMentionHref } = await import("@paperclipai/shared");
      const [skill] = await db.insert(companySkills).values({
        companyId: f.companyId, key: `company/${f.companyId}/automatic-playbook`,
        slug: "automatic-playbook", name: "Automatic playbook", markdown: "# Automatic playbook",
      }).returning();
      const instruction = `Use [/automatic-playbook](${buildSkillMentionHref(skill.id, skill.slug)}).`;
      const saved = await f.management.configuration(f.endpoint.id, "owner-user");
      await f.management.saveConfiguration(f.endpoint.id, { expectedRevision: saved.revision, configuration: {
        ...saved.configuration, defaults: { ...saved.configuration.defaults, instructions: instruction },
      } }, "owner-user");
      const delivery = randomUUID();
      const payload = {
        action: "opened",
        installation: { id: 2468 },
        repository: {
          id: 97531,
          full_name: "paperclipai/paperclip",
          name: "paperclip",
          owner: { id: 1357, login: "paperclipai" },
        },
        sender: { id: 77, login: "maintainer" },
        pull_request: {
          number: 81,
          title: "Check review routing",
          body: "Untrusted PR body",
          draft: false,
          base: { sha: "a".repeat(40), ref: "master" },
          head: { sha: "b".repeat(40) },
          user: { id: 42, login: "octocat", type: "User" },
          labels: [],
        },
      };
      const send = () =>
        f.service.handleWebhook(
          f.endpoint.publicId,
          "github",
          signedGitHubWebhookRequest({
            event: "pull_request",
            delivery,
            payload,
            webhookSecret: f.webhookSecret,
          }),
        );
      expect((await send()).status).toBeLessThan(300);
      await expect
        .poll(
          async () =>
            (
              await readChatGitHubReviewsByEndpointId(f.endpoint.id)
            ).length,
          { timeout: 10000 },
        )
        .toBe(1);
      await send();
      const reviews = await readChatGitHubReviewsByEndpointId(f.endpoint.id);
      expect(reviews).toHaveLength(1);
      const [task] = await readIssuesById(reviews[0].issueId);
      expect(task).toMatchObject({
        title: "PR #81: Check review routing",
        assigneeAgentId: f.assignedAgentId,
        responsibleUserId: "owner-user",
        originKind: "chat_channel",
      });
      const [conversation] = await db.select().from(chatConversations).where(eq(chatConversations.issueId, task.id));
      expect(conversation.providerUrl).toBe("https://github.com/paperclipai/paperclip/pull/81");
      expect(reviews[0].event.sender.id).toBe("77");
      expect(reviews[0].event.author.id).toBe("42");
      expect(reviews[0].policySnapshot.ratingThreshold).toBe(5);
      const comments = await readIssueCommentsByIssueId(task.id);
      expect(comments[0].body).not.toContain(instruction);
      expect(comments[0].body).not.toContain("Untrusted PR body");
      const configArgs = { db, companyId: f.companyId, agentId: f.assignedAgentId, issueId: task.id, commentIds: [comments[0].id] };
      const configs = await resolveGitHubReviewInstructions(configArgs);
      expect(configs).toHaveLength(1);
      expect(configs[0].instructions).toContain(instruction);
      expect(configs[0].instructions).toContain("Read the SKILL.md");
      expect(await resolveGitHubReviewInstructions({ ...configArgs, companyId: randomUUID() })).toEqual([]);
      expect(await resolveGitHubReviewInstructions({ ...configArgs, issueId: randomUUID() })).toEqual([]);
      expect(await resolveGitHubReviewInstructions({ ...configArgs, agentId: randomUUID() })).toEqual([]);
      expect(await resolveGitHubReviewInstructions({ ...configArgs, commentIds: [randomUUID()] })).toEqual([]);
      const changed = await f.management.configuration(f.endpoint.id, "owner-user");
      await f.management.saveConfiguration(f.endpoint.id, { expectedRevision: changed.revision, configuration: {
        ...changed.configuration, defaults: { ...changed.configuration.defaults, instructions: "UPDATED_REVIEW_POLICY" },
      } }, "owner-user");
      // Queued older requests retain their admitted configuration after an edit.
      expect(await resolveGitHubReviewInstructions(configArgs)).toEqual(configs);
      await f.service.handleWebhook(f.endpoint.publicId, "github", signedGitHubWebhookRequest({
        event: "pull_request", delivery: randomUUID(), webhookSecret: f.webhookSecret,
        payload: { ...payload, action: "synchronize", before: payload.pull_request.head.sha,
          pull_request: { ...payload.pull_request, head: { sha: "c".repeat(40) } } },
      }));
      await expect.poll(async () => {
        await f.service.processPendingDeliveries();
        return (await readIssueCommentsByIssueId(task.id)).length;
      }, { timeout: 10000 }).toBe(2);
      const updatedComments = await readIssueCommentsByIssueId(task.id);
      const newComment = updatedComments.find((row) => row.id !== comments[0].id)!;
      await expect.poll(async () => (await resolveGitHubReviewInstructions({ ...configArgs, commentIds: [newComment.id] })).length).toBe(1);
      const updatedConfigs = await resolveGitHubReviewInstructions({ ...configArgs, commentIds: [newComment.id] });
      expect(updatedConfigs).toHaveLength(1);
      expect(updatedConfigs[0].instructions).toContain("UPDATED_REVIEW_POLICY");
      expect(updatedConfigs[0].key).not.toBe(configs[0].key);
      expect(await resolveGitHubReviewInstructions({ ...configArgs, commentIds: [comments[0].id] })).toEqual(configs);
      expect(await resolveGitHubReviewInstructions({ ...configArgs, commentIds: [comments[0].id, newComment.id] })).toEqual(updatedConfigs);
      expect(await resolveGitHubReviewInstructions({ ...configArgs, commentIds: [newComment.id, comments[0].id] })).toEqual(configs);
      const manualMarker = "Explain this review without starting a new assessment";
      const manualThread = makeThread({ channelId: "paperclipai/paperclip", id: "github:paperclipai/paperclip:81" }).thread;
      await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread: manualThread,
        trigger: "mention", message: makeMessage({ id: "81001", text: `@${f.endpoint.botUsername} ${manualMarker}`,
          userId: "42", userName: "octocat", mentioned: true }) });
      const manualComment = (await readIssueCommentsByIssueId(task.id)).find((row) => row.body.includes(manualMarker))!;
      // A discussion between automatic reviews must not reset the retained key.
      expect(await resolveGitHubReviewInstructions({ ...configArgs, commentIds: [manualComment.id] })).toEqual(updatedConfigs);
      expect(await resolveGitHubReviewInstructions({ ...configArgs, commentIds: [newComment.id] })).toEqual(updatedConfigs);
      expect(await resolveRunScopedMentionedSkillKeys({ db, companyId: f.companyId, issueId: task.id, commentIds: [comments[0].id] })).toEqual([skill.key]);
      expect(comments[0].body).toContain("untrusted provider data");
      expect(comments[0].authorUserId).toBe("owner-user");
      expect(comments[0].metadata?.sourceChannel).toBe("github");
      const inbox = await issueService(db).list(f.companyId, { touchedByUserId: "owner-user" });
      expect(inbox.map((issue) => issue.id)).not.toContain(task.id);
      const [run] = await db.insert(heartbeatRuns).values({
        companyId: f.companyId,
        agentId: f.assignedAgentId,
        invocationSource: "assignment",
        status: "running",
        contextSnapshot: { issueId: task.id, wakeCommentId: comments[0].id },
      }).returning();
      const wakeArgs = { db, companyId: f.companyId, agentId: f.assignedAgentId, runId: run.id,
        contextSnapshot: { issueId: task.id, wakeCommentId: comments[0].id, wakeCommentIds: [comments[0].id], source: "chat:github",
          wakeReason: "External chat message received", paperclipHarnessCheckedOut: true } };
      const wake = await buildPaperclipWakePayload(wakeArgs);
      expect(wake?.githubReviewConfigurations).toEqual(configs);
      const { renderPaperclipWakePrompt } = await import("@paperclipai/adapter-utils/server-utils");
      const prompt = renderPaperclipWakePrompt(wake);
      expect(prompt.split(instruction)).toHaveLength(2);
      expect(prompt).not.toContain("Untrusted PR body");
      const unbound = await buildPaperclipWakePayload({ ...wakeArgs, contextSnapshot: { ...wakeArgs.contextSnapshot, paperclipHarnessCheckedOut: false } });
      expect(unbound?.externalChatProvider).toBeNull();
      expect(renderPaperclipWakePrompt(unbound)).not.toContain("## External chat response contract");
      const [boardComment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: task.id,
        authorUserId: "owner-user", authorType: "user", body: "Continue the review" }).returning();
      const boardFollowup = await buildPaperclipWakePayload({ ...wakeArgs,
        contextSnapshot: { issueId: task.id, wakeCommentIds: [boardComment.id], wakeReason: "issue_commented" } });
      expect(boardFollowup?.externalChatProvider).toBeNull();
      expect(boardFollowup?.githubReviewConfigurations).toEqual(updatedConfigs);
      expect(renderPaperclipWakePrompt(boardFollowup)).toContain("UPDATED_REVIEW_POLICY");
      f.setSupplementalProviderFetch(async (input) => String(input).endsWith("/pulls/81")
        ? Response.json({ ...payload.pull_request, head: { sha: "c".repeat(40) } })
        : undefined);
      await expect(githubChatReviewService(db, f.providerFetch).execute({
        companyId: f.companyId,
        agentId: f.assignedAgentId,
        issueId: task.id,
        runId: run.id,
      }, "read_pull_request", { section: "metadata" })).rejects.toThrow("older pull request head");
    });

    it("keeps GitHub review check history quiet and wakes from the real enqueue producer", async () => {
      const f = await reviewCheckWorkerFixture();
      const errors: unknown[] = [];
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
      try {
        await f.checks.registerCheckWork(coordinator, () => true).ready;
        await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }),
          { timeout: 5000 }).toEqual({ active: 0, next: null });
        await f.enqueue();
        await expect.poll(async () => (await f.action())?.status, { timeout: 5000 }).toBe("processed");
        await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }),
          { timeout: 5000 }).toEqual({ active: 0, next: null });
        expect(f.writes).toEqual([expect.objectContaining({ status: "completed" })]);
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
        const reads = vi.spyOn(db, "select"), transactions = vi.spyOn(db, "transaction");
        onTestFinished(() => { reads.mockRestore(); transactions.mockRestore(); });
        const count = f.requests.length;
        await vi.advanceTimersByTimeAsync(120_000);
        expect(reads).not.toHaveBeenCalled(); expect(transactions).not.toHaveBeenCalled();
        expect(f.requests).toHaveLength(count);
        reads.mockRestore(); transactions.mockRestore();
        expect(errors).toEqual([]);
      } finally { await coordinator.stop(); vi.useRealTimers(); }
    });

    it("defers GitHub review check enqueue until outer commit and discards rollback", async () => {
      const f = await reviewCheckWorkerFixture();
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
      const enqueue = (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) =>
        githubReviewCheckService(tx as unknown as Db, f.providerFetch).enqueue(f.endpoint, f.event, true, "authorized");
      try {
        await f.checks.registerCheckWork(coordinator, () => true).ready;
        await expect(db.transaction(async tx => { await enqueue(tx); throw new Error("rollback check"); })).rejects.toThrow("rollback check");
        expect(await f.action()).toBeUndefined(); expect(f.writes).toEqual([]);
        let entered!: () => void, release!: () => void;
        const ready = new Promise<void>(resolve => { entered = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
        const pending = db.transaction(async tx => { await enqueue(tx); entered(); await hold; });
        try { await ready; expect(f.writes).toEqual([]); } finally { release(); await pending; }
        await expect.poll(async () => (await f.action())?.status, { timeout: 5000 }).toBe("processed");
        expect(f.writes).toHaveLength(1);
      } finally { await coordinator.stop(); }
    });

    it("recovers a missed GitHub head webhook only while a review check remains unresolved", async () => {
      const f = await reviewCheckWorkerFixture("running");
      await f.enqueue();
      const errors: unknown[] = [];
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
      try {
        await f.checks.registerCheckWork(coordinator, () => true).ready;
        await expect.poll(() => f.writes.length, { timeout: 5000 }).toBe(1);
        expect(f.writes[0].status).toBe("in_progress");
        const saved = await f.action();
        expect(Date.parse(String(saved.result?.retryAt))).toBeGreaterThan(Date.now());
        f.setRemoteHead("c".repeat(40));
        await vi.advanceTimersByTimeAsync(6000);
        await expect.poll(async () => (await f.action()).status, { timeout: 5000 }).toBe("cancelled");
        await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }),
          { timeout: 5000 }).toEqual({ active: 0, next: null });
        expect((await db.select().from(chatGitHubReviews).where(eq(chatGitHubReviews.id, f.review.id)))[0].state).toBe("superseded");
        const reads = vi.spyOn(db, "select"), count = f.requests.length;
        onTestFinished(() => reads.mockRestore());
        await vi.advanceTimersByTimeAsync(120_000);
        expect(reads).not.toHaveBeenCalled(); expect(f.requests).toHaveLength(count); reads.mockRestore();
        expect(f.writes).toHaveLength(1); expect(errors).toEqual([]);
      } finally { await coordinator.stop(); vi.useRealTimers(); }
    });

    it.each(["restart", "drain", "standby"] as const)("retains GitHub review check work across %s", async mode => {
      const f = await reviewCheckWorkerFixture();
      let canRun = true;
      const errors: unknown[] = [];
      let coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => canRun,
        canReconcile: () => mode !== "standby" || canRun, onError: error => errors.push(error) });
      let worker = f.checks.registerCheckWork(coordinator, () => canRun);
      try {
        await worker.ready;
        if (mode === "restart") await coordinator.stop(); else canRun = false;
        await f.enqueue(); expect(f.writes).toEqual([]);
        if (mode === "restart") {
          coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
          worker = f.checks.registerCheckWork(coordinator, () => true); await worker.ready;
        } else { canRun = true; worker.wake(); }
        await expect.poll(async () => (await f.action())?.status, { timeout: 5000 }).toBe("processed");
        await expect.poll(() => coordinator.nextWakeAt(), { timeout: 5000 }).toBeNull();
        expect(f.writes).toHaveLength(1); expect(errors).toEqual([]);
      } finally { await coordinator.stop(); }
    });

    it("retains the saved GitHub review check retry through restart without an early provider call", async () => {
      const f = await reviewCheckWorkerFixture();
      f.setUnavailable(true); await f.enqueue(); await f.checks.processPending();
      const failed = await f.action();
      expect(failed).toMatchObject({ status: "failed", result: { attempts: 1, retryable: true } });
      const future = new Date(Date.now() + 60_000).toISOString();
      await db.update(chatActions).set({ result: { ...failed.result, retryAt: future } }).where(eq(chatActions.id, failed.id));
      f.setUnavailable(false);
      const errors: unknown[] = [];
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
      try {
        const count = f.requests.length;
        await f.checks.registerCheckWork(coordinator, () => true).ready;
        expect(coordinator.nextWakeAt()).toBe(Date.parse(future)); expect(f.requests).toHaveLength(count);
        await vi.advanceTimersByTimeAsync(61_000);
        await expect.poll(async () => (await f.action()).status, { timeout: 5000 }).toBe("processed");
        expect(f.writes).toHaveLength(1); expect(errors).toEqual([]);
      } finally { await coordinator.stop(); vi.useRealTimers(); }
    });

    it("waits for and wakes from the actual GitHub review check publication lease", async () => {
      const f = await reviewCheckWorkerFixture();
      const errors: unknown[] = [];
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
      let entered!: () => void, release!: () => void;
      const ready = new Promise<void>(resolve => { entered = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
      let lease: Promise<unknown> | undefined;
      try {
        await f.checks.registerCheckWork(coordinator, () => true).ready;
        lease = withGitHubPublicationLease(db, { companyId: f.companyId, endpointId: f.endpoint.id, repositoryId: "97531", number: 418 }, f.providerFetch,
          async () => { entered(); await hold; });
        await ready; await f.enqueue();
        await expect.poll(() => coordinator.nextWakeAt(), { timeout: 5000 }).not.toBeNull();
        expect(f.writes).toEqual([]); release(); await lease;
        await expect.poll(async () => (await f.action())?.status, { timeout: 5000 }).toBe("processed");
        expect(f.writes).toHaveLength(1); expect(errors).toEqual([]);
      } finally { release(); await lease; await coordinator.stop(); }
    });

    it("wakes a GitHub review check from committed run identity before its future head deadline", async () => {
      const f = await reviewCheckWorkerFixture("running");
      await f.enqueue(); await f.checks.processPending();
      const action = await f.action(), future = new Date(Date.now() + 60_000).toISOString();
      await db.update(chatActions).set({ result: { ...action.result, retryAt: future } }).where(eq(chatActions.id, action.id));
      const errors: unknown[] = [];
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
      try {
        await f.checks.registerCheckWork(coordinator, () => true).ready;
        expect(coordinator.nextWakeAt()).toBe(Date.parse(future));
        const change = async (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => {
          await tx.update(heartbeatRuns).set({ status: "failed", updatedAt: new Date() }).where(eq(heartbeatRuns.id, f.run.id));
          await initializeRunIdentity(tx as unknown as Db, { companyId: f.companyId, runId: f.run.id, issueId: f.conversation.issueId!,
            responsibleUserId: "owner-user", messageIds: [String(f.run.contextSnapshot?.wakeCommentId)], cause: "instruction" });
        };
        await expect(db.transaction(async tx => { await change(tx); throw new Error("rollback run check"); })).rejects.toThrow("rollback run check");
        expect(f.writes).toHaveLength(1);
        await db.transaction(change);
        await expect.poll(async () => (await f.action()).status, { timeout: 5000 }).toBe("processed");
        expect(f.writes).toHaveLength(2); expect(f.writes[1].status).toBe("completed");
        expect(Date.now()).toBeLessThan(Date.parse(future)); expect(errors).toEqual([]);
      } finally { await coordinator.stop(); }
    });

    it("finds a GitHub review check after a full page of revoked work and ignores settled history", async () => {
      const f = await reviewCheckWorkerFixture();
      await f.enqueue(); const original = await f.action();
      const pageKey = randomUUID().replaceAll("-", "").slice(0, 9);
      const prefix = Array.from({ length: 101 }, (_, index) => ({ ...original,
        id: `00000000-0000-4000-8000-${pageKey}${String(index + 1).padStart(3, "0")}`,
        providerActionId: `revoked-check-${index}`, payload: { ...original.payload, runtimeGeneration: -1 } }));
      await db.insert(chatActions).values(prefix);
      await db.insert(chatActions).values(Array.from({ length: 101 }, (_, index) => ({ ...original,
        id: randomUUID(), providerActionId: `settled-check-${index}`, status: "processed" })));
      const errors: unknown[] = [];
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
      try {
        await f.checks.registerCheckWork(coordinator, () => true).ready;
        await expect.poll(async () => (await db.select().from(chatActions).where(and(eq(chatActions.id, original.id))))[0].status,
          { timeout: 15_000 }).toBe("processed");
        await expect.poll(() => coordinator.nextWakeAt(), { timeout: 15_000 }).toBeNull();
        expect(f.writes).toHaveLength(1);
        const cancelled = await db.select().from(chatActions).where(and(eq(chatActions.endpointId, f.endpoint.id), eq(chatActions.status, "cancelled")));
        expect(cancelled).toHaveLength(101); expect(errors).toEqual([]);
      } finally { await coordinator.stop(); }
    });

    it("stops GitHub review check HTTP after shutdown admission and recovers its durable action", async () => {
      const f = await reviewCheckWorkerFixture();
      await f.enqueue();
      let entered!: () => void, release!: () => void;
      const ready = new Promise<void>(resolve => { entered = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
      const guardedProvider: typeof fetch = async (input, init) => {
        if (String(input).endsWith("/pulls/418")) { entered(); await hold; }
        return f.providerFetch(input, init);
      };
      const errors: unknown[] = [];
      let coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
      try {
        const starting = githubReviewCheckService(db, guardedProvider).registerCheckWork(coordinator, () => true).ready;
        await ready;
        const stopped = coordinator.stop(); release(); await stopped; await starting;
        expect(f.writes).toEqual([]); expect((await f.action()).status).toBe("received");
        coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
        await f.checks.registerCheckWork(coordinator, () => true).ready;
        await expect.poll(async () => (await f.action()).status, { timeout: 5000 }).toBe("processed");
        expect(f.writes).toHaveLength(1); expect(errors).toEqual([]);
      } finally { release(); await coordinator.stop(); }
    });

    it("wakes stale GitHub review projection repair from real admission and leaves settled history quiet", async () => {
      const f = await reviewProjectionFixture();
      const errors: unknown[] = [];
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
      try {
        await registerGitHubReviewProjectionWork(db, coordinator, () => true).ready;
        await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }), { timeout: 5000 })
          .toEqual({ active: 0, next: null });
        const review = await f.admit();
        await expect.poll(async () => (await f.read(review.id)).state, { timeout: 5000 }).toBe("superseded");
        await f.service.shutdown();
        const [manual] = await db.insert(chatGitHubReviews).values({ ...review, id: randomUUID(),
          deliveryId: "run:" + randomUUID() + ":" + review.headSha, state: "queued" }).returning();
        await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }), { timeout: 5000 })
          .toEqual({ active: 0, next: null });
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
        const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "update");
        try {
          await vi.advanceTimersByTimeAsync(120_000);
          expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
        } finally { reads.mockRestore(); writes.mockRestore(); vi.useRealTimers(); }
        expect((await f.read(manual.id)).state).toBe("queued"); expect(errors).toEqual([]);
      } finally { await coordinator.stop(); vi.useRealTimers(); }
    });

    it("wakes stale GitHub review projection repair when cancellation commits after the review is admitted", async () => {
      const f = await reviewProjectionFixture(false);
      let entered!: () => void, release!: () => void;
      const enteredHead = new Promise<void>(resolve => { entered = resolve; });
      const hold = new Promise<void>(resolve => { release = resolve; });
      const provider: typeof fetch = async (input, init) => {
        if (String(input).endsWith("/pulls/82")) { entered(); await hold; }
        return f.providerFetch(input, init);
      };
      const errors: unknown[] = [];
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
      let dispatch: Promise<unknown> | undefined;
      try {
        await registerGitHubReviewProjectionWork(db, coordinator, () => true).ready;
        dispatch = githubReviewCheckService(db, provider).processPending();
        await enteredHead;
        const review = await f.admit();
        expect((await f.read(review.id)).state).toBe("queued");
        release(); await dispatch;
        await expect.poll(async () => (await f.read(review.id)).state, { timeout: 5000 }).toBe("superseded");
        expect((await f.action()).result).toMatchObject({ code: "stale_head" }); expect(errors).toEqual([]);
      } finally { release(); await dispatch; await coordinator.stop(); }
    });

    it("holds stale GitHub review projection receipt repair until the outer commit and discards rollback", async () => {
      const f = await reviewProjectionFixture();
      const review = await f.admit(); await f.service.shutdown();
      await db.delete(chatGitHubReviews).where(eq(chatGitHubReviews.id, review.id));
      const receipt = (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => retainGitHubReviewReceipt(tx, f.endpoint,
        review.issueId, review.deliveryId, { context: review.event, revision: review.configurationRevision, policy: review.policySnapshot });
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
      let release!: () => void;
      let pending: Promise<unknown> | undefined;
      try {
        await registerGitHubReviewProjectionWork(db, coordinator, () => true).ready;
        await expect(db.transaction(async tx => { await tx.transaction(receipt); throw new Error("rollback projection receipt"); }))
          .rejects.toThrow("rollback projection receipt");
        expect(await readChatGitHubReviewsByEndpointId(f.endpoint.id)).toEqual([]);
        let entered!: () => void;
        const held = new Promise<void>(resolve => { entered = resolve; });
        const wait = new Promise<void>(resolve => { release = resolve; });
        pending = db.transaction(async tx => { await tx.transaction(receipt); entered(); await wait; });
        await held;
        expect(await readChatGitHubReviewsByEndpointId(f.endpoint.id)).toEqual([]);
        release(); await pending;
        await expect.poll(async () => (await readChatGitHubReviewsByEndpointId(f.endpoint.id))[0]?.state, { timeout: 5000 }).toBe("superseded");
      } finally { release?.(); await pending; await coordinator.stop(); }
    });

    it.each(["restart", "drain", "standby"] as const)("recovers stale GitHub review projection through %s", async mode => {
      const f = await reviewProjectionFixture();
      let canRun = mode === "restart";
      const errors: unknown[] = [];
      let coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => canRun,
        canReconcile: () => mode !== "standby" || canRun, onError: error => errors.push(error) });
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      try {
        await registerGitHubReviewProjectionWork(db, coordinator, () => canRun).ready;
        if (mode === "restart") await coordinator.stop();
        const review = await f.admit(); await f.service.shutdown();
        await vi.advanceTimersByTimeAsync(60_000);
        await vi.waitFor(() => {
          if (mode === "standby") expect(idleWorkSnapshot().active).toBeGreaterThan(0);
          else expect(idleWorkSnapshot().active).toBe(0);
        });
        expect((await f.read(review.id)).state).toBe("queued");
        const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "update");
        try { await vi.advanceTimersByTimeAsync(60_000); expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); }
        finally { reads.mockRestore(); writes.mockRestore(); }
        canRun = true;
        if (mode === "restart") {
          coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
          await registerGitHubReviewProjectionWork(db, coordinator, () => true).ready;
        }
        await vi.advanceTimersByTimeAsync(30_000);
        await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(10); expect((await f.read(review.id)).state).toBe("superseded"); });
        expect(errors).toEqual([]);
      } finally { await coordinator.stop(); vi.useRealTimers(); }
    });

    it("retains failed stale GitHub review projection repair across drain without passive SQL", async () => {
      const f = await reviewProjectionFixture(); const review = await f.admit(); await f.service.shutdown();
      let canRun = true;
      const errors: unknown[] = [];
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => canRun, canReconcile: () => true, onError: error => errors.push(error) });
      const failure = new Error("projection write unavailable");
      const update = vi.spyOn(db, "update").mockImplementationOnce(() => { throw failure; });
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      try {
        await registerGitHubReviewProjectionWork(db, coordinator, () => canRun).ready;
        expect(errors).toHaveLength(1); expect((await f.read(review.id)).state).toBe("queued");
        canRun = false; update.mockRestore();
        await vi.advanceTimersByTimeAsync(30_000); await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0));
        const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "update");
        try { await vi.advanceTimersByTimeAsync(60_000); expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); }
        finally { reads.mockRestore(); writes.mockRestore(); }
        canRun = true; await vi.advanceTimersByTimeAsync(30_000);
        await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(10); expect((await f.read(review.id)).state).toBe("superseded"); });
        expect(errors).toHaveLength(1);
      } finally { update.mockRestore(); await coordinator.stop(); vi.useRealTimers(); }
    });

    it.each([false, true])("rechecks assessment ownership after stale GitHub review projection selection waits for a row lock (shutdown: %s)", async shutdown => {
      const f = await reviewProjectionFixture(); const review = await f.admit(); await f.service.shutdown();
      const assessment: NonNullable<typeof review.assessment> = { reviewedCommit: review.headSha, score: 4, complete: true,
        summary: "Reviewed", rationale: "Covered changes", coverage: { reviewedPaths: ["src/a.ts"], omittedPaths: [], limitations: [] }, findings: [] };
      let locked!: () => void, release!: () => void;
      const ready = new Promise<void>(resolve => { locked = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
      const pending = db.transaction(async tx => {
        await tx.select().from(chatGitHubReviews).where(eq(chatGitHubReviews.id, review.id)).for("update");
        locked(); await held;
        await tx.update(chatGitHubReviews).set({ assessment }).where(eq(chatGitHubReviews.id, review.id));
      });
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
      const updates = vi.spyOn(db, "update");
      try {
        await ready;
        const starting = registerGitHubReviewProjectionWork(db, coordinator, () => true).ready;
        await expect.poll(() => updates.mock.calls.length, { timeout: 5000 }).toBe(1);
        await expect.poll(async () => {
          const rows = await db.execute<{ waiting: boolean }>(sql`select exists (
            select 1 from pg_stat_activity where datname = current_database()
              and wait_event_type = 'Lock' and query like 'update %chat_github_reviews%') as waiting`);
          return rows[0].waiting;
        }, { timeout: 5000 }).toBe(true);
        let stopped = false;
        const stopping = shutdown ? coordinator.stop().then(() => { stopped = true; }) : undefined;
        await Promise.resolve(); expect(stopped).toBe(false);
        release(); await pending; await starting; await stopping;
        expect(await f.read(review.id)).toMatchObject({ state: "queued", assessment });
        expect(coordinator.nextWakeAt()).toBeNull();
      } finally { release(); await pending; await coordinator.stop(); updates.mockRestore(); }
    });

    it("drains more than one page of stale GitHub review projections without touching manual history", async () => {
      const f = await reviewProjectionFixture(); const review = await f.admit(); await f.service.shutdown();
      const [delivery] = await db.select().from(chatDeliveries).where(eq(chatDeliveries.id, review.deliveryId));
      const action = await f.action();
      const extra = Array.from({ length: 105 }, () => ({ id: randomUUID(), receipt: randomUUID() }));
      await db.insert(chatDeliveries).values(extra.map(item => ({ ...delivery, id: item.id, providerEventId: item.receipt,
        deduplicationKey: item.receipt, normalizedEvent: { ...delivery.normalizedEvent,
          githubAutomatic: { context: { ...review.event, deliveryId: item.receipt }, revision: review.configurationRevision, policy: review.policySnapshot } } })));
      await db.insert(chatActions).values(extra.map(item => ({ ...action, id: randomUUID(), providerActionId: "github-check:" + item.receipt,
        payload: { ...action.payload, event: { ...review.event, deliveryId: item.receipt } } })));
      await db.insert(chatGitHubReviews).values(extra.map(item => ({ ...review, id: randomUUID(), deliveryId: item.id })));
      await db.insert(chatGitHubReviews).values(extra.map(item => ({ ...review, id: randomUUID(), deliveryId: "run:" + item.id + ":" + review.headSha })));
      const errors: unknown[] = [];
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      try {
        await registerGitHubReviewProjectionWork(db, coordinator, () => true).ready;
        await vi.waitFor(async () => {
          await vi.advanceTimersByTimeAsync(1000);
          const rows = await readChatGitHubReviewsByEndpointId(f.endpoint.id);
          expect(rows.filter(row => row.state === "superseded")).toHaveLength(106);
          expect(rows.filter(row => row.state === "queued")).toHaveLength(105);
          expect(idleWorkSnapshot().active).toBe(0); expect(coordinator.nextWakeAt()).toBeNull();
        }, { timeout: 10_000 });
        expect(errors).toEqual([]);
      } finally { await coordinator.stop(); vi.useRealTimers(); }
    });

    it("supersedes a late review projection after its check already rejected the old head", async () => {
      const f = await reviewBotFixture();
      const deliveryId = randomUUID();
      const payload = {
        action: "synchronize",
        installation: { id: 2468 },
        repository: { id: 97531, full_name: "paperclipai/paperclip", name: "paperclip", owner: { id: 1357, login: "paperclipai" } },
        sender: { id: 42, login: "octocat" },
        pull_request: {
          number: 82, title: "Rapid pushes", body: "", draft: false,
          base: { sha: "a".repeat(40), ref: "master" },
          head: { sha: "b".repeat(40) },
          user: { id: 42, login: "octocat", type: "User" }, labels: [],
        },
      };
      f.setSupplementalProviderFetch(async (input) => String(input).endsWith("/pulls/82")
        ? Response.json({ ...payload.pull_request, head: { sha: "c".repeat(40) } })
        : undefined);
      const checks = githubReviewCheckService(db, f.providerFetch);
      const [activeEndpoint] = await readChatEndpointsById(f.endpoint.id);
      await checks.enqueue(activeEndpoint, githubAutomaticReviewEvent(payload, deliveryId)!, true, "authorized");
      await checks.processPending();
      const [action] = await db.select().from(chatActions).where(and(
        eq(chatActions.endpointId, f.endpoint.id), eq(chatActions.kind, "github_review_check"),
      ));
      expect(action).toMatchObject({ status: "cancelled", result: { code: "stale_head" } });
      expect((await f.service.handleWebhook(f.endpoint.publicId, "github", signedGitHubWebhookRequest({
        event: "pull_request", delivery: deliveryId, payload, webhookSecret: f.webhookSecret,
      }))).status).toBeLessThan(300);
      await expect.poll(async () => (await readChatGitHubReviewsByEndpointId(f.endpoint.id)).length, { timeout: 10000 }).toBe(1);
      const [late] = await readChatGitHubReviewsByEndpointId(f.endpoint.id);
      const [unrelated] = await db.insert(chatGitHubReviews).values({
        companyId: late.companyId, endpointId: late.endpointId, issueId: late.issueId,
        repositoryId: late.repositoryId, repository: late.repository, pullNumber: late.pullNumber,
        headSha: late.headSha, deliveryId: randomUUID(), configurationRevision: late.configurationRevision,
        policySnapshot: late.policySnapshot, event: late.event, state: "queued",
      }).returning();
      await checks.processPending();
      expect((await db.select().from(chatGitHubReviews).where(eq(chatGitHubReviews.id, late.id)))[0].state).toBe("superseded");
      expect((await db.select().from(chatGitHubReviews).where(eq(chatGitHubReviews.id, unrelated.id)))[0].state).toBe("queued");
    });

    it("links a gated GitHub check to the current vanity review page before a task exists", async () => {
      const publicOrigin = vi.spyOn(cloudRuntimeIdentity, "runtimePublicOrigin").mockReturnValue("https://current-vanity.example");
      onTestFinished(() => publicOrigin.mockRestore());
      const f = await reviewBotFixture();
      const [company] = await db.select().from(companies).where(eq(companies.id, f.companyId));
      const head = "b".repeat(40);
      const event = githubAutomaticReviewEvent({
        action: "opened", installation: { id: 2468 },
        repository: { id: 97531, full_name: "paperclipai/paperclip", name: "paperclip", owner: { id: 1357, login: "paperclipai" } },
        sender: { id: 42, login: "octocat" },
        pull_request: {
          number: 83, title: "Manual review required", body: "", draft: false,
          base: { sha: "a".repeat(40), ref: "master" }, head: { sha: head },
          user: { id: 42, login: "octocat", type: "User" }, labels: [],
        },
      }, randomUUID())!;
      const writes: Record<string, unknown>[] = [];
      f.setSupplementalProviderFetch(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/pulls/83")) return Response.json({ head: { sha: head } });
        if (url.includes("/check-runs?")) return Response.json({ check_runs: [] });
        if (url.endsWith("/check-runs") && init?.method === "POST") {
          writes.push(JSON.parse(String(init.body)));
          return Response.json({ id: 83, html_url: "https://github.com/checks/83" });
        }
        return undefined;
      });
      const checks = githubReviewCheckService(db, f.providerFetch);
      const [activeEndpoint] = await readChatEndpointsById(f.endpoint.id);
      await checks.enqueue(activeEndpoint, event, false, "manual_required");
      await checks.processPending();
      expect(writes).toEqual([expect.objectContaining({
        status: "completed", conclusion: "action_required", head_sha: head,
        details_url: `https://current-vanity.example/${company.issuePrefix}/apps/chat/${f.endpoint.id}/reviews`,
      })]);
      expect(await readChatGitHubReviewsByEndpointId(f.endpoint.id)).toHaveLength(0);
    });

    it.each(["succeeded", "failed", "cancelled"] as const)("keeps a report-only GitHub check neutral after a %s run without an assessment", async status => {
      const f = await toolReplyFixture("github:paperclipai/paperclip:418");
      const config = await f.management.configuration(f.endpoint.id, "owner-user");
      await f.management.saveConfiguration(f.endpoint.id, { expectedRevision: config.revision,
        configuration: { ...config.configuration, defaults: { ...config.configuration.defaults, ratingThreshold: null } },
      }, "owner-user");
      const event = githubAutomaticReviewEvent({ action: "opened", repository: { id: 97531, full_name: "paperclipai/paperclip" }, sender: { id: 42, login: "octocat" },
        pull_request: { number: 418, title: "Review", body: "", draft: false, base: { sha: "a".repeat(40), ref: "master" }, head: { sha: "b".repeat(40) }, user: { id: 42, login: "octocat" }, labels: [] } }, randomUUID())!;
      const [review] = await db.insert(chatGitHubReviews).values({ companyId: f.companyId, endpointId: f.endpoint.id,
        issueId: f.conversation.issueId!, runId: f.run.id, repositoryId: "97531", repository: event.repository, pullNumber: 418, headSha: event.headSha,
        deliveryId: event.deliveryId, configurationRevision: config.revision + 1, policySnapshot: { ...config.configuration.defaults, ratingThreshold: null }, event }).returning();
      await db.update(heartbeatRuns).set({ status }).where(eq(heartbeatRuns.id, f.run.id));
      const writes: Record<string, unknown>[] = [];
      f.setSupplementalProviderFetch(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/pulls/418")) return Response.json({ head: { sha: event.headSha } });
        if (url.includes("/check-runs?")) return Response.json({ check_runs: [] });
        if (url.endsWith("/check-runs") && init?.method === "POST") {
          writes.push(JSON.parse(String(init.body)));
          return Response.json({ id: 418, html_url: "https://github.com/checks/418" });
        }
        return undefined;
      });
      const checks = githubReviewCheckService(db, f.providerFetch);
      const [endpoint] = await readChatEndpointsById(f.endpoint.id);
      await checks.enqueue(endpoint, event, true, "authorized");
      await checks.processPending();
      expect(writes).toEqual([expect.objectContaining({ status: "completed", conclusion: "neutral" })]);
      expect(writes[0].output).toMatchObject({ title: status === "succeeded" ? "Agent finished without a complete assessment" : "Review execution did not complete" });
      expect((await db.select().from(chatGitHubReviews).where(eq(chatGitHubReviews.id, review.id)))[0].conclusion).toBe("neutral");
    });
});
