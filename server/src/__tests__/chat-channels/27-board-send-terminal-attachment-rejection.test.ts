import {
  incomingWakeWorkQuery,
} from "../../services/idle-incoming-wake.js";
import {
  createChatRuntime,
} from "../../services/chat-runtime.js";
import {
  createChatSdkRuntime,
} from "../../services/chat-sdk-runtime.js";
import {
  githubChatManagementService,
} from "../../services/chat-github-management.js";
import {
  chatActions,
  chatConversations,
  chatDeliveries,
  chatEndpoints,
  chatGitHubConfigurations,
  chatMessageLinks,
  chatPublications,
  companySecrets,
  heartbeatRuns,
  issueAttachments,
  issueComments,
  issues,
  toolConnections,
} from "@paperclipai/db";
import {
  randomUUID,
} from "node:crypto";
import {
  createServer,
} from "node:http";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  like,
  or,
  sql,
} from "drizzle-orm";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  chatChannelService,
  type ChatChannelService,
} from "../../services/chat-channels.js";
import {
  issueService,
} from "../../services/issues.js";
import {
  issueThreadInteractionService,
} from "../../services/issue-thread-interactions.js";
import {
  questionResponseDeliveryService,
} from "../../services/question-response-delivery.js";
import {
  enqueueChatRunMilestones,
  resolveChatRunPresentationAuthorizationReason,
} from "../../services/chat-run-publications.js";
import {
  FakeChatSdkRuntime,
  makeMessage,
  makeThread,
  routesApp,
  webhookApp,
} from ".././helpers/chat-channels-fixture.js";
import {
  addSelectedChatFinal,
  chatWakeContext,
  configuredSlackEndpoint,
  configuredTeamsEndpoint,
  createService,
  createStorageService,
  db,
  deliverMessage,
  describeChatChannelsSuite,
  fixtureServices,
  qualifySetupRoundTrip,
  readChatConversationsByEndpointId,
  readChatPublicationsByCommentId,
  readChatPublicationsByIdempotencyKey,
  readHeartbeatRunsById,
  readIssuesById,
  readToolConnectionsById,
  registeredIdleProbeState,
  retirePublicationFixture,
  seedCompany,
  configuredGitHubEndpoint,
} from "../helpers/chat-channels-harness.js";
import type { AddressInfo } from "node:net";
import request, {  } from "supertest";

describeChatChannelsSuite("chat channels 27-board-send-terminal-attachment-rejection", () => {
  it("publishes GitHub questions as link-only cards with no executable callback", async () => {
    const fixture = await seedCompany();
    const previousPublicUrl = process.env.PAPERCLIP_PUBLIC_URL;
    process.env.PAPERCLIP_PUBLIC_URL = "https://paperclip.example";
    try {
      const { callbacks, endpoint, runtime, service } =
        await configuredGitHubEndpoint(fixture);
      const thread = makeThread({
        channelId: "paperclipai/paperclip",
        id: "github:paperclipai/paperclip:issue:451",
        name: "paperclipai/paperclip",
      });
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider: "github",
        thread: thread.thread,
        message: makeMessage({
          id: "45101",
          text: "@maya ask me for a release decision",
          mentioned: true,
        }),
        trigger: "mention",
      });
      const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
      const interaction = await issueThreadInteractionService(db).create(
        { id: conversation!.issueId, companyId: fixture.companyId },
        {
          kind: "ask_user_questions",
          payload: {
            version: 1,
            questions: [
              {
                id: "release",
                prompt: "Ship this release?",
                selectionMode: "single",
                required: true,
                allowOther: false,
                options: [
                  { id: "ship", label: "Ship" },
                  { id: "hold", label: "Hold" },
                ],
              },
            ],
          },
        },
        { agentId: fixture.assignedAgentId },
      );
      await service.processPendingPublications();

      const [publication] = await db
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
        );
      expect(publication).toMatchObject({
        state: "published",
        payload: {
          interactionId: interaction.id,
          card: {
            actions: [
              {
                type: "link",
                label: "Open in Paperclip",
                url: `https://paperclip.example/issues/${conversation!.issueId}`,
              },
            ],
          },
        },
      });
      expect(callbacks.onAction).toBeUndefined();
      expect(
        await db
          .select()
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, endpoint.id),
              eq(chatActions.kind, "question_answer"),
            ),
          ),
      ).toHaveLength(0);
      expect(
        JSON.stringify(runtime.endpoints.get(endpoint.id)?.posts),
      ).toContain(`https://paperclip.example/issues/${conversation!.issueId}`);
    } finally {
      if (previousPublicUrl === undefined)
        delete process.env.PAPERCLIP_PUBLIC_URL;
      else process.env.PAPERCLIP_PUBLIC_URL = previousPublicUrl;
    }
  });

  it("keeps a successful GitHub link-question continuation final internal", async () => {
    const fixture = await seedCompany();
    const previousPublicUrl = process.env.PAPERCLIP_PUBLIC_URL;
    process.env.PAPERCLIP_PUBLIC_URL = "https://paperclip.example";
    try {
      const continuationRunId = randomUUID();
      const wakeup = vi.fn(async (agentId, options) => {
        if (options.contextSnapshot?.source !== "issue.interaction.respond") {
          return { accepted: true };
        }
        const [created] = await db
          .insert(heartbeatRuns)
          .values({
            id: continuationRunId,
            companyId: fixture.companyId,
            agentId,
            status: "running",
            contextSnapshot: options.contextSnapshot,
          })
          .onConflictDoNothing()
          .returning();
        return (
          created ??
          readHeartbeatRunsById(continuationRunId)
            .then((rows) => rows[0])
        );
      });
      const { callbacks, endpoint, runtime, service } =
        await configuredGitHubEndpoint(fixture, { wakeup });
      const thread = makeThread({
        channelId: "paperclipai/paperclip",
        id: "github:paperclipai/paperclip:issue:455",
        name: "paperclipai/paperclip",
      });
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider: "github",
        thread: thread.thread,
        message: makeMessage({
          id: "45501",
          text: "@maya ask for and apply the release color",
          mentioned: true,
        }),
        trigger: "mention",
      });
      const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
      if (!conversation) throw new Error("Expected GitHub conversation");
      // Exercise the upgraded reply model after admitting the legacy fixture's
      // root. Legacy connections deliberately continue publishing final prose.
      const config = await githubChatManagementService(db).configuration(endpoint.id, "owner-user");
      await db.insert(chatGitHubConfigurations).values({ companyId: fixture.companyId, endpointId: endpoint.id, configuration: config.configuration, updatedByUserId: "owner-user" });
      const sourceRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: sourceRunId,
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        status: "succeeded",
        contextSnapshot: await chatWakeContext({
          endpointId: endpoint.id,
          issueId: conversation.issueId,
          provider: "github",
          providerMessageId: "45501",
        }),
      });
      const interaction = await issueThreadInteractionService(db).create(
        { id: conversation.issueId, companyId: fixture.companyId },
        {
          kind: "ask_user_questions",
          continuationPolicy: "wake_assignee",
          sourceRunId,
          title: "Choose the release color",
          payload: {
            version: 1,
            questions: [
              {
                id: "color",
                prompt: "Which release color should we use?",
                selectionMode: "single",
                required: true,
                allowOther: false,
                options: [
                  { id: "blue", label: "Blue" },
                  { id: "green", label: "Green" },
                ],
              },
            ],
          },
        },
        { agentId: fixture.assignedAgentId, runId: sourceRunId },
      );
      await service.processPendingPublications();
      const promptPublication = await readChatPublicationsByIdempotencyKey(`interaction:${interaction.id}:${endpoint.id}`)
        .then((rows) => rows[0]);
      expect(promptPublication).toMatchObject({
        state: "published",
        payload: {
          interactionId: interaction.id,
          progressState: "waiting_for_input",
          card: {
            actions: [
              expect.objectContaining({
                label: "Open in Paperclip",
                type: "link",
              }),
            ],
          },
        },
      });

      await issueThreadInteractionService(db).answerQuestions(
        { id: conversation.issueId, companyId: fixture.companyId },
        interaction.id,
        { answers: [{ questionId: "color", optionIds: ["blue"] }] },
        { userId: "owner-user" },
      );
      await questionResponseDeliveryService(db, {
        heartbeat: {
          cancelRun: vi.fn(),
          wakeup,
        } as never,
      }).deliver(interaction.id);
      await service.processPendingPublications();
      await vi.waitFor(() =>
        expect(
          wakeup.mock.calls.some(
            ([, options]) =>
              options.contextSnapshot?.source === "issue.interaction.respond",
          ),
        ).toBe(true),
      );
      await enqueueChatRunMilestones(db);
      await service.processPendingPublications();
      const workingPublication = await readChatPublicationsByIdempotencyKey(`run:${continuationRunId}:working:${endpoint.id}`)
        .then((rows) => rows[0]);
      expect(workingPublication).toBeUndefined();

      await db
        .update(heartbeatRuns)
        .set({ status: "succeeded", updatedAt: new Date() })
        .where(eq(heartbeatRuns.id, continuationRunId));
      const authorizationReason =
        await resolveChatRunPresentationAuthorizationReason(db, {
          companyId: fixture.companyId,
          issueId: conversation.issueId,
          runId: continuationRunId,
        });
      expect(authorizationReason).toBe("internal_agent_write");
      const finalComment = await issueService(db).addComment(
        conversation.issueId,
        "GITHUB-COLOR-Blue",
        { agentId: fixture.assignedAgentId, runId: continuationRunId },
        { authorType: "agent", authorizationReason },
      );
      await service.processPendingPublications();

      const finalPublication = await readChatPublicationsByCommentId(finalComment.id)
        .then((rows) => rows[0]);
      expect(finalPublication).toBeUndefined();
      const providerRuntime = runtime.endpoints.get(endpoint.id);
      expect(providerRuntime?.posts.filter(post => post.text === "GITHUB-COLOR-Blue")).toEqual([]);
      expect(providerRuntime?.edits.filter(edit => edit.text === "GITHUB-COLOR-Blue")).toEqual([]);
      const runPublications = await db
        .select()
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.endpointId, endpoint.id),
            eq(chatPublications.conversationId, conversation.id),
            like(chatPublications.idempotencyKey, `run:${continuationRunId}:%`),
          ),
        );
      expect(runPublications).toEqual([]);
      await service.shutdown();
    } finally {
      if (previousPublicUrl === undefined)
        delete process.env.PAPERCLIP_PUBLIC_URL;
      else process.env.PAPERCLIP_PUBLIC_URL = previousPublicUrl;
    }
  });

  it("returns a failed link-only interaction continuation to its GitHub thread", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service, wakeup } =
      await configuredGitHubEndpoint(fixture);
    const thread = makeThread({
      channelId: "paperclipai/paperclip",
      id: "github:paperclipai/paperclip:issue:454",
      name: "paperclipai/paperclip",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "github",
      thread: thread.thread,
      message: makeMessage({
        id: "45401",
        text: "@maya pause for a release confirmation",
        mentioned: true,
      }),
      trigger: "mention",
    });
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    if (!conversation) throw new Error("Expected GitHub conversation");
    const sourceCommentId = await db
      .select({ commentId: chatMessageLinks.commentId })
      .from(chatMessageLinks)
      .where(
        and(
          eq(chatMessageLinks.conversationId, conversation.id),
          eq(chatMessageLinks.direction, "inbound"),
          isNotNull(chatMessageLinks.commentId),
        ),
      )
      .then((rows) => rows[0]?.commentId ?? null);
    if (!sourceCommentId) throw new Error("Expected GitHub source comment");
    const interaction = await issueThreadInteractionService(db).create(
      { id: conversation.issueId, companyId: fixture.companyId },
      {
        kind: "request_confirmation",
        continuationPolicy: "wake_assignee",
        sourceCommentId,
        payload: { version: 1, prompt: "Ship this release?" },
      },
      { agentId: fixture.assignedAgentId },
    );
    await service.processPendingPublications();
    wakeup.mockClear();

    const issue = await readIssuesById(conversation.issueId)
      .then((rows) => rows[0]);
    if (!issue) throw new Error("Expected GitHub-backed issue");
    await issueThreadInteractionService(db).acceptInteraction(
      issue,
      interaction.id,
      {},
      { userId: "owner-user" },
    );
    await service.processPendingPublications();

    expect(wakeup).toHaveBeenCalledOnce();
    const continuation = wakeup.mock.calls[0]?.[1];
    expect(continuation).toMatchObject({
      contextSnapshot: {
        issueId: conversation.issueId,
        source: "chat:github",
        sourceCommentId,
        wakeCommentId: sourceCommentId,
        wakeCommentIds: [sourceCommentId],
      },
      payload: {
        issueId: conversation.issueId,
        sourceCommentId,
        wakeCommentId: sourceCommentId,
        wakeCommentIds: [sourceCommentId],
      },
    });
    const wakeCommentId = (
      continuation?.contextSnapshot as { wakeCommentId?: string } | undefined
    )?.wakeCommentId;
    if (!wakeCommentId) throw new Error("Expected GitHub wake comment link");
    await expect(
      db
        .select({ commentId: chatMessageLinks.commentId })
        .from(chatMessageLinks)
        .where(
          and(
            eq(chatMessageLinks.conversationId, conversation.id),
            eq(chatMessageLinks.direction, "inbound"),
            eq(chatMessageLinks.commentId, wakeCommentId),
          ),
        ),
    ).resolves.toHaveLength(1);

    const failedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: failedRunId,
      companyId: fixture.companyId,
      agentId: fixture.assignedAgentId,
      status: "failed",
      errorCode: "continuation_failed",
      contextSnapshot: continuation!.contextSnapshot,
    });
    await expect(
      enqueueChatRunMilestones(db, {
        publicBaseUrl: "https://paperclip.example",
      }),
    ).resolves.toBe(1);
    await service.processPendingPublications();

    const failedPublication = await readChatPublicationsByIdempotencyKey(`run:${failedRunId}:failed:${endpoint.id}`)
      .then((rows) => rows[0]);
    expect(failedPublication).toMatchObject({
      conversationId: conversation.id,
      state: "published",
    });
    expect(failedPublication?.payload.text).toContain(
      "stopped before completing this turn",
    );
    expect(
      runtime.endpoints
        .get(endpoint.id)
        ?.posts.some((post) =>
          post.text.includes("stopped before completing this turn"),
        ),
    ).toBe(true);
    await service.shutdown();
  });

  it("publishes explicit Board GitHub attachment fallbacks without provider file bytes", async () => {
    for (const testCase of [
      {
        publicBaseUrl: "https://board.paperclip.example",
        expectedFallback: (issueId: string) =>
          `File saved on the Paperclip task: report.txt. This GitHub App connection cannot upload file bytes into comments. Download it: https://board.paperclip.example/issues/${issueId}`,
      },
      {
        publicBaseUrl: "http://127.0.0.1:3103",
        expectedFallback: () =>
          "File saved on the private Paperclip task: report.txt. This GitHub App connection cannot upload file bytes into comments.",
      },
    ]) {
      const fixture = await seedCompany();
      const storage = createStorageService();
      const { callbacks, endpoint, runtime, service } =
        await configuredGitHubEndpoint(fixture, {
          publicBaseUrl: testCase.publicBaseUrl,
          storage: storage.storage,
        });
      const thread = makeThread({
        channelId: "paperclipai/paperclip",
        id: "github:paperclipai/paperclip:issue:452",
        name: "paperclipai/paperclip",
      });
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider: "github",
        thread: thread.thread,
        message: makeMessage({
          id: "45201",
          text: "@maya create a downloadable report",
          mentioned: true,
        }),
        trigger: "mention",
      });
      const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        status: "succeeded",
        contextSnapshot: await chatWakeContext({
          endpointId: endpoint.id,
          issueId: conversation!.issueId,
          provider: "github",
          providerMessageId: "45201",
        }),
      });
      const _comment = await addSelectedChatFinal({
        agentId: fixture.assignedAgentId,
        body: "The report is ready.",
        companyId: fixture.companyId,
        issueId: conversation!.issueId,
        runId,
      });
      const stored = await storage.storage.putFile({
        companyId: fixture.companyId,
        namespace: `issues/${conversation!.issueId}`,
        originalFilename: "report.txt",
        contentType: "text/plain",
        body: Buffer.from("report contents", "utf8"),
      });
      const attachment = await issueService(db).createAttachment({
        issueId: conversation!.issueId,
        provider: stored.provider,
        objectKey: stored.objectKey,
        contentType: stored.contentType,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        originalFilename: stored.originalFilename,
        createdByAgentId: fixture.assignedAgentId,
        createdByRunId: runId,
      });
      await service.publishBoardMessage(endpoint.id, conversation.id, "The report is ready.", "explicit-report", "owner-user", [attachment.id]);
      await service.processPendingPublications();

      const posts = runtime.endpoints.get(endpoint.id)?.posts ?? [];
      expect(
        posts.some((post) =>
          post.text.includes(testCase.expectedFallback(conversation!.issueId)),
        ),
      ).toBe(true);
      expect(
        posts.every((post) => !post.text.includes("Shared report.txt.")),
      ).toBe(true);
      expect(posts.every((post) => post.files === undefined)).toBe(true);
      expect(storage.storage.getObject).not.toHaveBeenCalled();
      if (testCase.publicBaseUrl.startsWith("http://127.0.0.1")) {
        expect(
          posts.every((post) => !post.text.includes(testCase.publicBaseUrl)),
        ).toBe(true);
      }
      await service.shutdown();
    }
  });

  it("publishes one truthful notice when a selected PNG receives a definite provider rejection", async () => {
    const fixture = await seedCompany();
    const storage = createStorageService();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture, {
        linkedBoardUser: true,
        storage: storage.storage,
      });
    const channel = makeThread({
      channelId: "C-ATTACHMENT-REJECTED",
      id: "slack:C-ATTACHMENT-REJECTED:4521.1",
      name: "attachment-rejected",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: channel.thread,
      message: makeMessage({
        id: "4521.1",
        text: "@maya start an attachment failure test",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id);
    const [conversation] = await service.listConversations(endpoint.id);
    if (!conversation) throw new Error("Expected Slack file conversation");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const stored = await storage.storage.putFile({
      companyId: fixture.companyId,
      namespace: `issues/${conversation.issueId}`,
      originalFilename: "provider-rejected.png",
      contentType: "image/png",
      body: png,
    });
    const attachment = await issueService(db).createAttachment({
      issueId: conversation.issueId,
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByUserId: "owner-user",
    });
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected Slack provider runtime");
    providerRuntime.posts.length = 0;
    let postAttempt = 0;
    providerRuntime.postHook = async () => {
      postAttempt += 1;
      if (postAttempt !== 2) return;
      throw Object.assign(new Error("Slack rejected the PNG upload"), {
        adapter: "slack",
        code: "slack_webapi_platform_error",
        data: { error: "invalid_arguments" },
      });
    };

    const failed = await service.publishBoardMessage(
      endpoint.id,
      conversation.id,
      "The selected PNG should follow.",
      "selected-png-provider-rejection",
      "owner-user",
      [attachment.id],
    );
    providerRuntime.postHook = undefined;

    expect(failed).toMatchObject({ state: "failed" });
    const selectedAttachmentNotice =
      "Paperclip could not send an attachment. The file remains on its Paperclip task for an operator to retry." +
      ` Open task: https://paperclip.example/issues/${conversation.issueId}`;
    const publications = await db
      .select()
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.companyId, fixture.companyId),
          eq(chatPublications.conversationId, conversation.id),
          or(
            eq(chatPublications.commentId, failed.commentId!),
            like(
              chatPublications.idempotencyKey,
              "attachment-failure-notice:%",
            ),
          ),
        ),
      )
      .orderBy(asc(chatPublications.createdAt));
    expect(publications).toEqual([
      expect.objectContaining({
        state: "published",
        payload: { text: "**Owner User (via Paperclip)**\n\nThe selected PNG should follow." },
      }),
      expect.objectContaining({
        id: failed.id,
        state: "failed",
        payload: expect.objectContaining({ attachmentIds: [attachment.id] }),
      }),
      expect.objectContaining({
        commentId: null,
        state: "published",
        payload: {
          text: selectedAttachmentNotice,
        },
      }),
    ]);
    expect(providerRuntime.posts).toEqual([
      {
        threadId: channel.thread.id,
        text: "**Owner User (via Paperclip)**\n\nThe selected PNG should follow.",
      },
      {
        threadId: channel.thread.id,
        text: selectedAttachmentNotice,
      },
    ]);
    expect(storage.storage.getObject).toHaveBeenCalledOnce();
    await service.processPendingPublications();
    expect(providerRuntime.posts).toHaveLength(2);
    await service.shutdown();
  });

  it("preserves the raw webhook request and returns the provider adapter response", async () => {
    const fixture = await seedCompany();
    const { endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture);
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime)
      throw new Error("Expected configured fake provider runtime");
    const payload = JSON.stringify({
      type: "event_callback",
      event_id: "Ev-123",
    });

    // Both requests use one explicitly ready listener, as in the publication
    // status fixture below. Implicit per-request Supertest listeners can reset
    // before Express receives the request under the loaded macOS suite.
    const server = createServer(webhookApp(service));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    try {
      const response = await request(server)
        .post(`/api/chat-webhooks/${endpoint.publicId}/slack`)
        .set("content-type", "application/json")
        .set("x-slack-signature", "v0=test-signature")
        .send(payload)
        .expect(202);

      expect(response.text).toBe("accepted");
      expect(response.headers["x-chat-test"]).toBe("accepted");
      expect(
        providerRuntime.webhookRequest?.headers.get("x-slack-signature"),
      ).toBe("v0=test-signature");
      await expect(providerRuntime.webhookRequest?.text()).resolves.toBe(
        payload,
      );

      await request(server)
        .post(`/api/chat-webhooks/${endpoint.publicId}/irc`)
        .set("content-type", "application/json")
        .send("{}")
        .expect(400);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("retires superseded credentials and clears endpoint-owned secrets on removal", async () => {
    const fixture = await seedCompany();
    const { service } = createService();
    const endpoint = await service.create(
      fixture.companyId,
      {
        provider: "slack",
        assignedAgentId: fixture.assignedAgentId,
      },
      "owner-user",
    );

    await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: { botToken: "xoxb-first", signingSecret: "first-secret" },
      },
      "owner-user",
    );
    const [firstConnection] = await readToolConnectionsById(endpoint.connectionId);
    const firstIds = new Set(
      firstConnection.credentialSecretRefs.map((ref) => ref.secretId),
    );
    expect(firstIds.size).toBe(2);

    await service.configure(
      endpoint.id,
      {
        action: "reconnect",
        credentials: {
          botToken: "xoxb-second",
          signingSecret: "second-secret",
        },
      },
      "owner-user",
    );
    const [rotatedConnection] = await readToolConnectionsById(endpoint.connectionId);
    expect(rotatedConnection.credentialSecretRefs).toHaveLength(2);
    expect(
      rotatedConnection.credentialSecretRefs.every(
        (ref) => !firstIds.has(ref.secretId),
      ),
    ).toBe(true);
    const afterRotation = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.companyId, fixture.companyId));
    expect(afterRotation.map((secret) => secret.id).sort()).toEqual(
      rotatedConnection.credentialSecretRefs.map((ref) => ref.secretId).sort(),
    );

    await service.configure(endpoint.id, { action: "remove" }, "owner-user");
    const [removedConnection] = await readToolConnectionsById(endpoint.connectionId);
    expect(removedConnection.credentialSecretRefs).toEqual([]);
    expect(
      await db
        .select()
        .from(companySecrets)
        .where(eq(companySecrets.companyId, fixture.companyId)),
    ).toHaveLength(0);
  });

  it.each([
    { provider: "github" as const, label: "GitHub" },
    { provider: "microsoft-teams" as const, label: "Microsoft Teams" },
  ])(
    "removes a $label endpoint without deleting its task or audit history",
    async ({ provider }) => {
      const fixture = await seedCompany();
      const configured =
        provider === "github"
          ? await configuredGitHubEndpoint(fixture)
          : await configuredTeamsEndpoint(fixture);
      const { callbacks, endpoint, runtime, service } = configured;
      const thread =
        provider === "github"
          ? makeThread({
              channelId: "paperclipai/paperclip",
              id: "github:paperclipai/paperclip:issue:97",
              name: "paperclipai/paperclip",
            })
          : makeThread({
              channelId: "teams-personal-cleanup",
              id: "teams:personal-cleanup",
              isDM: true,
              name: "Teams cleanup DM",
            });
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider,
        thread: thread.thread,
        message: makeMessage({
          id: `${provider}-cleanup-root`,
          raw:
            provider === "microsoft-teams"
              ? {
                  from: { aadObjectId: "097269c2-77cb-4d6e-9be4-9a6362969699" },
                }
              : undefined,
          text:
            provider === "github"
              ? "@maya preserve this GitHub task"
              : "Preserve this Teams task",
          mentioned: provider === "github",
          userId: provider === "github" ? "97001" : "29:teams-cleanup-user",
        }),
        trigger: provider === "github" ? "mention" : "direct_message",
      });
      const [conversation] = await service.listConversations(endpoint.id);
      expect(conversation).toBeDefined();
      const credentialCount = await db
        .select({ id: companySecrets.id })
        .from(companySecrets)
        .where(eq(companySecrets.companyId, fixture.companyId))
        .then((rows) => rows.length);
      expect(credentialCount).toBe(provider === "github" ? 4 : 3);
      const deliveryCount = await db
        .select({ id: chatDeliveries.id })
        .from(chatDeliveries)
        .where(eq(chatDeliveries.endpointId, endpoint.id))
        .then((rows) => rows.length);
      expect(deliveryCount).toBeGreaterThan(0);

      const endpointBlocksSleep = async () => (await db.execute(sql`
        SELECT EXISTS (${incomingWakeWorkQuery("chat_endpoints")} AND endpoint.id = ${endpoint.id}::uuid) AS blocked`))[0].blocked;
      if (provider === "github") expect(await endpointBlocksSleep()).toBe(true);
      await service.configure(endpoint.id, { action: "remove" }, "owner-user");
      if (provider === "github") expect(await endpointBlocksSleep()).toBe(false);
      else expect(await endpointBlocksSleep()).toBe(true); // No persistent/provider coverage expansion.

      await expect(service.get(endpoint.id)).resolves.toMatchObject({
        status: "archived",
      });
      expect(runtime.endpoints.has(endpoint.id)).toBe(false);
      await expect(
        db
          .select({
            refs: toolConnections.credentialSecretRefs,
            status: toolConnections.status,
          })
          .from(toolConnections)
          .where(eq(toolConnections.id, endpoint.connectionId)),
      ).resolves.toEqual([{ refs: [], status: "archived" }]);
      await expect(
        db
          .select({ id: companySecrets.id })
          .from(companySecrets)
          .where(eq(companySecrets.companyId, fixture.companyId)),
      ).resolves.toHaveLength(0);
      await expect(
        db
          .select({ state: chatConversations.state })
          .from(chatConversations)
          .where(eq(chatConversations.id, conversation!.id)),
      ).resolves.toEqual([{ state: "endpoint_removed" }]);
      await expect(
        db
          .select({ id: issues.id })
          .from(issues)
          .where(eq(issues.id, conversation!.issueId)),
      ).resolves.toHaveLength(1);
      await expect(
        db
          .select({ id: chatDeliveries.id })
          .from(chatDeliveries)
          .where(eq(chatDeliveries.endpointId, endpoint.id)),
      ).resolves.toHaveLength(deliveryCount);
    },
  );

  it.each([
    { name: "SDK", create: createChatSdkRuntime },
    { name: "shared", create: createChatRuntime },
  ])("retains the service idle probe after failed $name retirement and shutdown until owner retry", async ({ create }) => {
    const fixture = await seedCompany();
    const f = await configuredGitHubEndpoint(fixture);
    const registry = create();
    const first = await registry.replaceEndpoint(f.runtime.configurations.get(f.endpoint.id)!);
    const shutdown = vi.spyOn(first, "shutdown")
      .mockRejectedValueOnce(new Error("remove retirement uncertain"))
      .mockRejectedValueOnce(new Error("shutdown retirement uncertain"))
      .mockResolvedValue(undefined);
    const service = chatChannelService(db, { runtime: registry, fetch: f.providerFetch, publicBaseUrl: "https://paperclip.example",
      heartbeat: { wakeup: async () => undefined } });
    fixtureServices.add(service);
    expect(await registeredIdleProbeState()).toBe("none");
    await service.configure(f.endpoint.id, { action: "remove" }, "owner-user");
    expect(registry.get(f.endpoint.id)).toBeNull();
    expect(registry.list()).toEqual([]);
    expect(registry.hasUnsettledLifecycle()).toBe(true);
    const select = vi.spyOn(db, "select"), transaction = vi.spyOn(db, "transaction");
    try {
      expect(await registeredIdleProbeState()).toBe("present");
      expect(select).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled();
    } finally { select.mockRestore(); transaction.mockRestore(); }
    await expect(service.shutdown()).rejects.toThrow("shutdown retirement uncertain");
    expect(await registeredIdleProbeState()).toBe("present");
    await service.shutdown();
    expect(shutdown).toHaveBeenCalledTimes(3);
    expect(registry.hasUnsettledLifecycle()).toBe(false);
    expect(await registeredIdleProbeState()).toBe("none");
  });

  it("retries credential cleanup after archival made a remove partially complete", async () => {
    const fixture = await seedCompany();
    const { endpoint, service } = await configuredSlackEndpoint(fixture);
    await db
      .update(chatEndpoints)
      .set({ status: "archived", archivedAt: new Date() })
      .where(eq(chatEndpoints.id, endpoint.id));
    await db
      .update(toolConnections)
      .set({ status: "archived", enabled: false })
      .where(eq(toolConnections.id, endpoint.connectionId));

    await expect(
      service.configure(endpoint.id, { action: "remove" }, "owner-user"),
    ).resolves.toMatchObject({
      status: "archived",
    });
    const [cleaned] = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));
    expect(cleaned!.refs).toEqual([]);
    await expect(
      db
        .select()
        .from(companySecrets)
        .where(eq(companySecrets.companyId, fixture.companyId)),
    ).resolves.toHaveLength(0);
    await expect(
      service.configure(endpoint.id, { action: "remove" }, "owner-user"),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: "chat_endpoint_already_removed" },
    });
  });

  it("marks provider setup as needing attention when Telegram webhook registration fails", async () => {
    const fixture = await seedCompany();
    const providerFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/getMe")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: { id: 42, username: "maya_e2e_bot", first_name: "Maya" },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (url.endsWith("/getWebhookInfo")) {
        return new Response(JSON.stringify({ ok: true, result: { url: "" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/setWebhook")) {
        return new Response(
          JSON.stringify({ ok: false, description: "webhook unavailable" }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        );
      }
      throw new Error(`Unexpected provider request: ${url}`);
    }) as unknown as typeof globalThis.fetch;
    const { service, runtime } = createService(
      new FakeChatSdkRuntime(),
      providerFetch,
    );
    const endpoint = await service.create(
      fixture.companyId,
      {
        provider: "telegram",
        assignedAgentId: fixture.assignedAgentId,
      },
      "owner-user",
    );

    await expect(
      service.configure(
        endpoint.id,
        {
          action: "configure",
          credentials: { botToken: "telegram-test-token" },
        },
        "owner-user",
      ),
    ).rejects.toMatchObject({ status: 422 });
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "attention",
      healthMessage: "Provider setup needs attention",
      lastError: "Telegram could not register the webhook: webhook unavailable",
    });
    const [connection] = await readToolConnectionsById(endpoint.connectionId);
    expect(connection).toMatchObject({
      healthStatus: "degraded",
      healthMessage: "Provider setup failed",
    });
    expect(runtime.endpoints.has(endpoint.id)).toBe(false);
  });

  it("redacts Telegram bot tokens from provider setup errors and endpoint health", async () => {
    const fixture = await seedCompany();
    const botToken = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
    const providerFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/getMe")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              id: 43,
              username: "redaction_test_bot",
              first_name: "Redaction",
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (url.endsWith("/getWebhookInfo"))
        throw new Error(`network failed for ${url}; token ${botToken}`);
      throw new Error(`Unexpected provider request: ${url}`);
    }) as unknown as typeof globalThis.fetch;
    const { service } = createService(new FakeChatSdkRuntime(), providerFetch);
    const endpoint = await service.create(
      fixture.companyId,
      {
        provider: "telegram",
        assignedAgentId: fixture.assignedAgentId,
      },
      "owner-user",
    );

    let setupError: unknown;
    try {
      await service.configure(
        endpoint.id,
        {
          action: "configure",
          credentials: { botToken },
        },
        "owner-user",
      );
    } catch (error) {
      setupError = error;
    }

    expect(setupError).toMatchObject({
      status: 422,
      details: { code: "chat_provider_setup_failed" },
    });
    const configured = await service.get(endpoint.id);
    const serializedFailure = JSON.stringify({ setupError, configured });
    expect(serializedFailure).not.toContain(botToken);
    expect(serializedFailure).not.toContain(encodeURIComponent(botToken));
    expect(configured).toMatchObject({
      status: "attention",
      healthMessage: "Provider setup needs attention",
      lastError:
        "network failed for https://api.telegram.org/bot***REDACTED***/getWebhookInfo; token ***REDACTED***",
    });
  });

  it("reads the entire publication batch without side effects and rejects foreign bindings", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service, wakeup } =
      await configuredSlackEndpoint(fixture);
    const channel = makeThread({
      channelId: "C-BATCH-STATUS",
      id: "slack:C-BATCH-STATUS:4410.1",
      name: "batch-status",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: channel.thread,
      message: makeMessage({
        id: "4410.1",
        text: "@maya status test",
        mentioned: true,
      }),
      trigger: "mention",
    });
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    const comment = await issueService(db).addComment(
      conversation.issueId,
      "Batch status fixture",
      { userId: "owner-user" },
    );
    const [textPart, filePart] = await db
      .insert(chatPublications)
      .values([
        {
          companyId: fixture.companyId,
          endpointId: endpoint.id,
          conversationId: conversation.id,
          issueId: conversation.issueId,
          commentId: comment.id,
          idempotencyKey: "status-text",
          state: "published",
          payload: { text: "Batch status fixture" },
          providerMessageId: "status-provider-id",
        },
        {
          companyId: fixture.companyId,
          endpointId: endpoint.id,
          conversationId: conversation.id,
          issueId: conversation.issueId,
          commentId: comment.id,
          idempotencyKey: "status-file",
          state: "pending",
          payload: { text: "File fixture" },
        },
      ])
      .returning();
    const app = routesApp(db, fixture.companyId, service);
    const path = `/api/chat-endpoints/${endpoint.id}/conversations/${conversation.id}/publications/${textPart.id}/status`;
    const initialPosts = runtime.endpoints.get(endpoint.id)?.posts.length;
    const initialWakes = wakeup.mock.calls.length;
    for (const state of [
      "pending",
      "streaming",
      "retry",
      "failed",
      "delivery_unknown",
      "cancelled",
      "published",
    ] as const) {
      await db
        .update(chatPublications)
        .set({ state })
        .where(eq(chatPublications.id, filePart.id));
      const response = await request(app).get(path).expect(200);
      expect(response.body).toMatchObject({
        total: 2,
        published: state === "published" ? 2 : 1,
        publication: { state },
      });
      if (state !== "published")
        expect(response.body.publication.id).toBe(filePart.id);
      expect(Object.keys(response.body.publication).sort()).toEqual([
        "attempts",
        "id",
        "nextAttemptAt",
        "providerUrl",
        "publishedAt",
        "redactedError",
        "state",
      ]);
    }
    expect(runtime.endpoints.get(endpoint.id)?.posts.length).toBe(initialPosts);
    expect(wakeup.mock.calls.length).toBe(initialWakes);
    await request(app)
      .get(path.replace(conversation.id, randomUUID()))
      .expect(404);
    await request(app).get(path.replace(textPart.id, randomUUID())).expect(404);
    await request(app)
      .get(path.replace(textPart.id, "invalid-publication"))
      .expect(400);
    const foreign = await seedCompany();
    const foreignEndpoint = await service.create(
      foreign.companyId,
      { provider: "slack", assignedAgentId: foreign.assignedAgentId },
      "owner-user",
    );
    await request(app)
      .get(path.replace(endpoint.id, foreignEndpoint.id))
      .expect(404);
    await request(routesApp(db, foreign.companyId, service))
      .get(path)
      .expect(404);
  });

  it("publishes only explicitly selected board attachments and stays idempotent across retries", async () => {
    const fixture = await seedCompany();
    const storage = createStorageService();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture, {
        linkedBoardUser: true,
        storage: storage.storage,
      });
    const channel = makeThread({
      channelId: "C-BOARD-SEND",
      id: "slack:C-BOARD-SEND:4400.1",
      name: "board-send",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: channel.thread,
      message: makeMessage({
        id: "4400.1",
        text: "@maya start a board-send task",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id);
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    const stored = await storage.storage.putFile({
      companyId: fixture.companyId,
      namespace: `issues/${conversation.issueId}`,
      originalFilename: "selected-result.txt",
      contentType: "text/plain",
      body: Buffer.from("selected result", "utf8"),
    });
    const attachment = await issueService(db).createAttachment({
      issueId: conversation.issueId,
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByUserId: "owner-user",
    });

    const first = await service.publishBoardMessage(
      endpoint.id,
      conversation.id,
      "Visible board update",
      "same-browser-request-1234",
      "owner-user",
      [attachment.id],
    );
    const second = await service.publishBoardMessage(
      endpoint.id,
      conversation.id,
      "Visible board update",
      "same-browser-request-1234",
      "owner-user",
      [attachment.id],
    );

    expect(second.id).toBe(first.id);
    const comments = await db
      .select()
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, conversation.issueId),
          eq(issueComments.body, "Visible board update"),
        ),
      );
    const publications = await readChatPublicationsByCommentId(comments[0].id)
      .orderBy(asc(chatPublications.createdAt));
    expect(comments).toHaveLength(1);
    expect(publications).toHaveLength(2);
    expect(publications).toEqual([
      expect.objectContaining({
        state: "published",
        payload: { text: "**Owner User (via Paperclip)**\n\nVisible board update" },
      }),
      expect.objectContaining({
        id: first.id,
        state: "published",
        payload: expect.objectContaining({ attachmentIds: [attachment.id] }),
      }),
    ]);
    await expect(
      db
        .select({ issueCommentId: issueAttachments.issueCommentId })
        .from(issueAttachments)
        .where(eq(issueAttachments.id, attachment.id)),
    ).resolves.toEqual([{ issueCommentId: comments[0].id }]);
    expect(runtime.endpoints.get(endpoint.id)?.posts).toEqual([
      { threadId: channel.thread.id, text: "**Owner User (via Paperclip)**\n\nVisible board update" },
      {
        threadId: channel.thread.id,
        text: "",
        files: [
          expect.objectContaining({
            filename: "selected-result.txt",
            mimeType: "text/plain",
            data: Buffer.from("selected result", "utf8"),
          }),
        ],
      },
    ]);

    const blockedStored = await storage.storage.putFile({
      companyId: fixture.companyId,
      namespace: `issues/${conversation.issueId}`,
      originalFilename: "blocked-result.txt",
      contentType: "text/plain",
      body: Buffer.from("blocked result", "utf8"),
    });
    const blockedAttachment = await issueService(db).createAttachment({
      issueId: conversation.issueId,
      provider: blockedStored.provider,
      objectKey: blockedStored.objectKey,
      contentType: blockedStored.contentType,
      byteSize: blockedStored.byteSize,
      sha256: blockedStored.sha256,
      originalFilename: blockedStored.originalFilename,
      createdByUserId: "owner-user",
    });
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected Slack runtime");
    providerRuntime.postError = new Error("socket reset after write");
    const blocked = await service.publishBoardMessage(
      endpoint.id,
      conversation.id,
      "Potentially accepted board update",
      "ambiguous-browser-request-1234",
      "owner-user",
      [blockedAttachment.id],
    );
    const blockedRetry = await service.publishBoardMessage(
      endpoint.id,
      conversation.id,
      "Potentially accepted board update",
      "ambiguous-browser-request-1234",
      "owner-user",
      [blockedAttachment.id],
    );
    expect(blockedRetry.id).toBe(blocked.id);
    expect(blocked).toMatchObject({ state: "delivery_unknown" });
    await expect(
      db
        .select({ id: chatPublications.id, state: chatPublications.state })
        .from(chatPublications)
        .where(eq(chatPublications.commentId, blocked.commentId!))
        .orderBy(asc(chatPublications.createdAt)),
    ).resolves.toEqual([
      { id: blocked.id, state: "delivery_unknown" },
      { id: expect.any(String), state: "pending" },
    ]);
  });

  describe("Board send terminal attachment rejection", () => {
    async function rejectionFixture() {
      const company = await seedCompany();
      const storage = createStorageService();
      const context = await configuredSlackEndpoint(company, {
        linkedBoardUser: true,
        storage: storage.storage,
      });
      const channel = makeThread({
        channelId: "C-BOARD-REJECTION",
        id: "slack:C-BOARD-REJECTION:4410.1",
      });
      await deliverMessage({
        callbacks: context.callbacks,
        endpointId: context.endpoint.id,
        thread: channel.thread,
        message: makeMessage({
          id: "4410.1",
          text: "@maya start a rejection test",
          mentioned: true,
        }),
        trigger: "mention",
      });
      await qualifySetupRoundTrip(context.service, context.endpoint.id);
      await context.service.test(context.endpoint.id);
      const [conversation] = await readChatConversationsByEndpointId(context.endpoint.id);
      const stored = await storage.storage.putFile({
        companyId: company.companyId,
        namespace: `issues/${conversation.issueId}`,
        originalFilename: "private-original.txt",
        contentType: "text/plain",
        body: Buffer.from("private original file"),
      });
      const attachment = await issueService(db).createAttachment({
        issueId: conversation.issueId,
        ...stored,
        createdByUserId: "owner-user",
      });
      const owner = await issueService(db).addComment(
        conversation.issueId,
        "Original private attachment owner",
        { userId: "owner-user" },
        { authorType: "user", attachmentIds: [attachment.id] },
      );
      const key = "rejected-browser-send-1234";
      const send = (
        body = "Rejected private message",
        ids = [attachment.id],
        clientKey = key,
      ) =>
        context.service.publishBoardMessage(
          context.endpoint.id,
          conversation.id,
          body,
          clientKey,
          "owner-user",
          ids,
        );
      const receipts = () =>
        db
          .select()
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, context.endpoint.id),
              eq(chatActions.kind, "board_send_rejected"),
            ),
          );
      const publications = () =>
        db
          .select()
          .from(chatPublications)
          .where(
            and(
              eq(chatPublications.conversationId, conversation.id),
              sql`${chatPublications.idempotencyKey} like 'explicit-board:%'`,
            ),
          );
      const initialPosts =
        context.runtime.endpoints.get(context.endpoint.id)?.posts.length ?? 0;
      const details = {
        code: "chat_board_send_attachments_already_bound",
        endpointId: context.endpoint.id,
        conversationId: conversation.id,
        idempotencyKey: key,
        attachmentIds: [attachment.id],
      };
      return {
        ...context,
        conversation,
        attachment,
        owner,
        send,
        receipts,
        publications,
        details,
        initialPosts,
        storage,
      };
    }

    it("keeps the exact rejected key terminal after normal owner-comment deletion and service reconstruction", async () => {
      const fixture = await rejectionFixture();
      let restarted: ChatChannelService | undefined;
      try {
        await expect(fixture.send()).rejects.toMatchObject({ status: 409 });
        await issueService(db).removeComment(fixture.owner.id);
        const [unbound] = await db
          .select()
          .from(issueAttachments)
          .where(eq(issueAttachments.id, fixture.attachment.id));
        expect(unbound.issueCommentId).toBeNull();
        await fixture.service.shutdown();
        restarted = createService(fixture.runtime).service;
        await expect(
          restarted.publishBoardMessage(
            fixture.endpoint.id,
            fixture.conversation.id,
            "Changed retry payload",
            fixture.details.idempotencyKey,
            "owner-user",
            [],
          ),
        ).rejects.toMatchObject({ status: 409, details: fixture.details });
        expect(await fixture.publications()).toEqual([]);
        expect(await fixture.receipts()).toHaveLength(1);
        expect(
          fixture.runtime.endpoints
            .get(fixture.endpoint.id)
            ?.posts.slice(fixture.initialPosts) ?? [],
        ).toEqual([]);
        const comments = await db
          .select()
          .from(issueComments)
          .where(
            and(
              eq(issueComments.issueId, fixture.conversation.issueId),
              inArray(issueComments.body, [
                "Rejected private message",
                "Changed retry payload",
              ]),
            ),
          );
        expect(comments).toEqual([]);
      } finally {
        if (restarted) await restarted.shutdown();
        await retirePublicationFixture(fixture.service, fixture.endpoint.id);
      }
    });

    it("commits one content-free scoped receipt for concurrent rejection and allows only a separately keyed corrected send", async () => {
      const fixture = await rejectionFixture();
      try {
        const results = await Promise.allSettled([
          fixture.send(),
          fixture.send(),
        ]);
        for (const result of results)
          expect(result).toMatchObject({
            status: "rejected",
            reason: { status: 409, details: fixture.details },
          });
        const receipts = await fixture.receipts();
        expect(receipts).toHaveLength(1);
        expect(receipts[0]).toMatchObject({
          companyId: fixture.endpoint.companyId,
          endpointId: fixture.endpoint.id,
          conversationId: fixture.conversation.id,
          status: "processed",
        });
        const serialized = JSON.stringify(receipts);
        for (const secret of [
          "Rejected private message",
          "private-original.txt",
          "private original file",
          fixture.owner.body,
        ])
          expect(serialized).not.toContain(secret);
        expect(await fixture.publications()).toEqual([]);
        const corrected = await fixture.send(
          "Corrected separately keyed send",
          [],
          "corrected-browser-send-1234",
        );
        expect(corrected.state).toBe("published");
        const replay = await fixture.send(
          "Different retry text",
          [fixture.attachment.id],
          "corrected-browser-send-1234",
        );
        expect(replay.id).toBe(corrected.id);
        expect(await fixture.publications()).toHaveLength(1);
        expect(await fixture.receipts()).toHaveLength(1);
        expect(
          fixture.runtime.endpoints
            .get(fixture.endpoint.id)
            ?.posts.slice(fixture.initialPosts),
        ).toEqual([
          {
            threadId: "slack:C-BOARD-REJECTION:4410.1",
            text: "**Owner User (via Paperclip)**\n\nCorrected separately keyed send",
          },
        ]);
      } finally {
        await retirePublicationFixture(fixture.service, fixture.endpoint.id);
      }
    });

    it("returns the exact HTTP rejection with only the bound subset and replays that receipt unchanged", async () => {
      const fixture = await rejectionFixture();
      const app = routesApp(db, fixture.endpoint.companyId, fixture.service);
      const server = createServer(app);
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
          });
        });
        const client = request(
          `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        );
        const stored = await fixture.storage.storage.putFile({
          companyId: fixture.endpoint.companyId,
          namespace: `issues/${fixture.conversation.issueId}`,
          originalFilename: "still-unbound.txt",
          contentType: "text/plain",
          body: Buffer.from("unbound"),
        });
        const unbound = await issueService(db).createAttachment({
          issueId: fixture.conversation.issueId,
          ...stored,
          createdByUserId: "owner-user",
        });
        const path = `/api/chat-endpoints/${fixture.endpoint.id}/conversations/${fixture.conversation.id}/publications`;
        const response = await client
          .post(path)
          .send({
            body: "Rejected private message",
            idempotencyKey: fixture.details.idempotencyKey,
            attachmentIds: [unbound.id, fixture.attachment.id],
          })
          .expect(409);
        expect(response.body.details).toEqual(fixture.details);
        await issueService(db).removeComment(fixture.owner.id);
        const repeated = await client
          .post(path)
          .send({
            body: "Changed retry payload",
            idempotencyKey: fixture.details.idempotencyKey,
            attachmentIds: [unbound.id],
          })
          .expect(409);
        expect(repeated.body.details).toEqual(fixture.details);
        expect(await fixture.publications()).toEqual([]);
        expect(await fixture.receipts()).toHaveLength(1);
        const [unchanged] = await db
          .select()
          .from(issueAttachments)
          .where(eq(issueAttachments.id, unbound.id));
        expect(unchanged.issueCommentId).toBeNull();
        expect(
          fixture.runtime.endpoints
            .get(fixture.endpoint.id)
            ?.posts.slice(fixture.initialPosts),
        ).toEqual([]);
      } finally {
        try {
          await retirePublicationFixture(fixture.service, fixture.endpoint.id);
        } finally {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
            server.closeAllConnections();
          });
        }
      }
    });

    it("does not classify missing attachments as a safe terminal rejection", async () => {
      const fixture = await rejectionFixture();
      try {
        await expect(
          fixture.send("Missing attachment", [randomUUID()]),
        ).rejects.toMatchObject({ status: 422 });
        expect(await fixture.receipts()).toEqual([]);
        expect(await fixture.publications()).toEqual([]);
        const corrected = await fixture.send(
          "Same key after an unclassified failure",
          [],
        );
        expect(corrected.state).toBe("published");
      } finally {
        await retirePublicationFixture(fixture.service, fixture.endpoint.id);
      }
    });
  });
});
