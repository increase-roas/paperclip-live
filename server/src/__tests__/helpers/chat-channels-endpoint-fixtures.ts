/**
 * Endpoint and webhook fixtures for the chat-channel suites. They build on the
 * base harness (database, seeding, services).
 */
import {

} from "../../services/chat-github-management.js";
import {

} from "../../services/chat-github-tools.js";
import {
  agentWakeupRequests,
  authUsers,
  chatActions,
  chatConversations,
  chatDeliveries,
  chatEndpointResources,
  chatEndpoints,
  chatExternalPrincipals,
  chatIdentityLinks,
  chatMessageLinks,
  chatPublications,
  chatSdkState,
  companyMemberships,
  completionContracts,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
  nativeRunResults,
} from "@paperclipai/db";
import {
  issueThreadInteractionService,
} from "../../services/issue-thread-interactions.js";
import {
  TELEGRAM_CALLBACK_DATA_LIMIT_BYTES,
  telegramChatSdkCallbackData,
} from "../../services/chat-interaction-publications.js";
import {
  randomUUID,
} from "node:crypto";
import {
  and,
  eq,
  inArray,
  sql,
} from "drizzle-orm";
import {
  expect,
  vi,
} from "vitest";
import {

} from "@paperclipai/shared";
import {
  chatChannelService,
  type ChatChannelServiceOptions,
  type ChatChannelService,
} from "../../services/chat-channels.js";
import {
  createTeamsAdapter,
} from "@chat-adapter/teams";
import {
  issueService,
} from "../../services/issues.js";
import {

} from "../../services/chat-github-attachments.js";
import {
  finalizeNativeRun,
} from "../../services/native-runtime/native-run-finalizer.js";
import {
  PaperclipControlPlanePort,
} from "../../services/native-runtime/paperclip-control-plane-port.js";
import {
  FakeEndpointRuntime,
  FakeChatSdkRuntime,
  fakeSlackFetch,
  makeThread,
  makeMessage,
} from "./chat-channels-fixture.js";
import {
  attachFakeGitHubIssueCommentWebhook,
  configuredGitHubEndpoint,
  configuredSlackEndpoint,
  configuredTelegramEndpoint,
  createService,
  createStorageService,
  db,
  deliverMessage,
  qualifySetupRoundTrip,
  readAgentWakeupRequestsById,
  readChatConversationsByEndpointId,
  readChatConversationsById,
  readHeartbeatRunsById,
  readIssuesById,
  receiptBackedWakeup,
  seedCompany,
  signedGitHubWebhookRequest,
} from "./chat-channels-harness.js";
import type { ChatSdkRuntime } from "../../services/chat-sdk-runtime.js";
import type {
  PrpStructuredRunResult,
  PrpTerminalState,
} from "../../vendor/paperclip-runner/index.js";

  export async function committedNativeReviewPublicationFixture(label: string) {
    const fixture = await seedCompany();
    const storage = createStorageService();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture, { storage: storage.storage });
    const providerMessageId = `review-transport-${label}-${randomUUID()}`;
    const channel = makeThread({
      channelId: `C-REVIEW-${label.toUpperCase()}`,
      id: `slack:C-REVIEW-${label.toUpperCase()}:${Date.now()}.1`,
      name: `review-${label}`,
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: channel.thread,
      message: makeMessage({
        id: providerMessageId,
        text: "@maya return the exact response and files, then wait",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id);
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    if (!conversation)
      throw new Error("Expected review transport conversation");
    const inbound = await db
      .select({
        commentId: chatMessageLinks.commentId,
        principalId: chatDeliveries.principalId,
      })
      .from(chatMessageLinks)
      .innerJoin(
        chatDeliveries,
        eq(chatDeliveries.id, chatMessageLinks.deliveryId),
      )
      .where(
        and(
          eq(chatMessageLinks.endpointId, endpoint.id),
          eq(chatMessageLinks.conversationId, conversation.id),
          eq(chatMessageLinks.providerMessageId, providerMessageId),
          eq(chatMessageLinks.direction, "inbound"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!inbound?.commentId || !inbound.principalId) {
      throw new Error("Expected exact inbound requester lineage");
    }
    await db
      .insert(chatIdentityLinks)
      .values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        principalId: inbound.principalId,
        paperclipUserId: "owner-user",
        status: "linked",
        confirmedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [chatIdentityLinks.endpointId, chatIdentityLinks.principalId],
        set: {
          paperclipUserId: "owner-user",
          status: "linked",
          confirmedAt: new Date(),
          revokedAt: null,
          updatedAt: new Date(),
        },
      });

    const issueId = conversation.issueId;
    const runId = randomUUID();
    const sessionId = randomUUID();
    const runnerInstanceId = randomUUID();
    const contractId = randomUUID();
    const contractSha256 = `review-transport-${randomUUID()}`;
    const contextSnapshot = {
      issueId,
      source: "chat:slack",
      wakeCommentId: inbound.commentId,
      wakeCommentIds: [inbound.commentId],
      paperclipHarnessCheckedOut: true,
      paperclipWake: {
        reason: "External chat message received",
        externalChatProvider: "slack",
        checkedOutByHarness: true,
        issue: { id: issueId, workMode: "standard" },
        commentIds: [inbound.commentId],
      },
    };
    await db.insert(completionContracts).values({
      id: contractId,
      companyId: fixture.companyId,
      issueId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "phase6-v3",
      risk: "low",
      completionAuthority: "agent_claim_policy",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: {
        revision: "review-transport-v1",
        objective: "Return the exact requested response and files",
        criteria: [{ id: "response", requirement: "Return the response" }],
      },
      canonicalSha256: contractSha256,
      createdByActorType: "system",
      createdByActorId: "test",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: fixture.companyId,
      agentId: fixture.assignedAgentId,
      status: "running",
      runtimeMode: "native",
      nativeIssueId: issueId,
      nativeSessionId: sessionId,
      runnerInstanceId,
      completionContractId: contractId,
      completionContractSha256: contractSha256,
      contextSnapshot,
    });
    await db
      .update(issues)
      .set({
        status: "in_progress",
        assigneeAgentId: fixture.assignedAgentId,
        executionRunId: runId,
      })
      .where(eq(issues.id, issueId));
    const port = new PaperclipControlPlanePort(db, {
      companyId: fixture.companyId,
      issueId,
      runId,
      agentId: fixture.assignedAgentId,
      sessionId,
      completionContractId: contractId,
      completionContractSha256: contractSha256,
      sourceInstanceId: runnerInstanceId,
      controlPlaneSourceInstanceId: `review-transport-${runId}`,
    });
    await port.openRun({
      identity: {
        companyId: fixture.companyId,
        issueId,
        runId,
        agentId: fixture.assignedAgentId,
        sessionId,
      },
      backendKind: "mock",
      sourceInstanceId: runnerInstanceId,
    });
    const responseResult: PrpStructuredRunResult = {
      schema: "paperclip.run_result.v1",
      reportedWorkDisposition: "yielded",
      summary: "The exact response and files are prepared. I will wait.",
      completionClaim: {
        contractRevision: "review-transport-v1",
        objectiveSatisfied: true,
        criteria: [
          {
            criterionId: "response",
            status: "satisfied",
            evidenceRefs: [],
          },
        ],
        remainingWork: [],
      },
      evidence: [],
      verification: [],
      attentionRequests: [],
      artifacts: [],
      continuation: {
        kind: "response_wake",
        summary: "Wait for the next authorized Slack message.",
        idempotencyKey: `review-transport-wait:${conversation.id}`,
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
    await port.completeRun({
      result: responseResult,
      terminal,
      callerResultId: `review-response-${runId}`,
    });
    await db
      .update(heartbeatRuns)
      .set({ resultJson: { nativeResult: responseResult } })
      .where(eq(heartbeatRuns.id, runId));

    const [accepted] = await db
      .select()
      .from(nativeRunResults)
      .where(eq(nativeRunResults.runId, runId));
    if (!accepted) throw new Error("Expected accepted native result");
    const reviewRunId = randomUUID();
    const reviewSessionId = randomUUID();
    const reviewRunnerInstanceId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: reviewRunId,
      companyId: fixture.companyId,
      agentId: fixture.assignedAgentId,
      status: "running",
      runtimeMode: "native",
      nativeIssueId: issueId,
      nativeSessionId: reviewSessionId,
      runnerInstanceId: reviewRunnerInstanceId,
      completionContractId: contractId,
      completionContractSha256: contractSha256,
      contextSnapshot: {},
      createdAt: new Date(Date.now() - 60_000),
    });
    await db
      .update(issues)
      .set({ executionRunId: reviewRunId })
      .where(eq(issues.id, issueId));
    const reviewPort = new PaperclipControlPlanePort(db, {
      companyId: fixture.companyId,
      issueId,
      runId: reviewRunId,
      agentId: fixture.assignedAgentId,
      sessionId: reviewSessionId,
      completionContractId: contractId,
      completionContractSha256: contractSha256,
      sourceInstanceId: reviewRunnerInstanceId,
      controlPlaneSourceInstanceId: `review-gate-${reviewRunId}`,
    });
    await reviewPort.openRun({
      identity: {
        companyId: fixture.companyId,
        issueId,
        runId: reviewRunId,
        agentId: fixture.assignedAgentId,
        sessionId: reviewSessionId,
      },
      backendKind: "mock",
      sourceInstanceId: reviewRunnerInstanceId,
    });
    const reviewResult = {
      ...(accepted.resultJson.result as PrpStructuredRunResult),
      reportedWorkDisposition: "needs_review" as const,
      attentionRequests: [{ kind: "review" as const, ownerClass: "human" as const, summary: "Approve the prepared response and selected files." }],
    };
    delete reviewResult.continuation;
    await reviewPort.completeRun({
      result: reviewResult,
      terminal: {
        ...(accepted.resultJson.terminal as PrpTerminalState),
        reportedWorkDisposition: "needs_review",
      },
      callerResultId: `review-gate-${reviewRunId}`,
    });
    await finalizeNativeRun({
      db,
      runId: reviewRunId,
      workspaceFinalizeStatus: "succeeded",
      projectRunStatus: true,
    });
    const [gate] = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.sourceRunId, reviewRunId));
    if (!gate) throw new Error("Expected genuine native completion review");
    expect(gate).toMatchObject({
      kind: "request_confirmation",
      status: "pending",
      effectiveResolverPolicy: "human_only",
      createdByAgentId: null,
      createdByUserId: null,
    });
    await db
      .update(issues)
      .set({ executionRunId: runId })
      .where(eq(issues.id, issueId));
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot,
        startedAt: new Date(gate.createdAt.getTime() + 1),
      })
      .where(eq(heartbeatRuns.id, runId));

    const selection = await issueService(db).addComment(
      issueId,
      "Prepared the exact requested files for this response.",
      { agentId: fixture.assignedAgentId, runId },
      { authorizationReason: "paperclip_runner_protocol" },
    );
    const attachments = [];
    for (const [originalFilename, contentType, body] of [
      ["review-note.txt", "text/plain", Buffer.from("review note", "utf8")],
      ["review-image.png", "image/png", Buffer.from("review image", "utf8")],
    ] as const) {
      const stored = await storage.storage.putFile({
        companyId: fixture.companyId,
        namespace: `issues/${issueId}`,
        originalFilename,
        contentType,
        body,
      });
      attachments.push(
        await issueService(db).createAttachment({
          issueId,
          issueCommentId: selection.id,
          provider: stored.provider,
          objectKey: stored.objectKey,
          contentType: stored.contentType,
          byteSize: stored.byteSize,
          sha256: stored.sha256,
          originalFilename: stored.originalFilename,
          createdByAgentId: fixture.assignedAgentId,
          createdByRunId: runId,
        }),
      );
    }
    await finalizeNativeRun({
      db,
      runId,
      workspaceFinalizeStatus: "succeeded",
      projectRunStatus: true,
    });
    const [committedRun] = await readHeartbeatRunsById(runId);
    expect(committedRun).toMatchObject({
      status: "succeeded",
      resultJson: {
        finalizationPhase: "committed",
        finalizationReasonCode: "governed_response_waiting",
        externalChatReviewPresentation: {
          runId,
          gateId: gate.id,
        },
      },
    });
    const publications = await db
      .select()
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.issueId, issueId),
          eq(chatPublications.state, "pending"),
        ),
      );
    expect(publications).toHaveLength(3);
    expect(publications).toEqual(
      expect.arrayContaining(
        attachments.map((attachment) =>
          expect.objectContaining({
            commentId: selection.id,
            idempotencyKey: `attachment:${attachment.id}:${endpoint.id}`,
            payload: expect.objectContaining({
              attachmentIds: [attachment.id],
            }),
          }),
        ),
      ),
    );
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected Slack provider runtime");
    providerRuntime.posts.length = 0;
    providerRuntime.edits.length = 0;
    providerRuntime.slackFilePublicationAttempts = 0;
    providerRuntime.slackFileReceiptLookups.length = 0;
    return {
      attachments,
      conversation,
      endpoint,
      fixture,
      gate,
      providerRuntime,
      publications,
      runId,
      service,
    };
  }

  export async function teamsFileAuthorityFixture(
    settings: { linkedRecipient?: boolean; separateSponsor?: boolean } = {},
  ) {
    const { installTeamsFileConsentHook } =
      await import("../../services/chat-teams-file-consent.js");
    type ConsentCard = ReturnType<
      typeof import("../../services/chat-teams-file-consent.js").buildTeamsFileConsentCard
    >;
    type FileCard = ReturnType<
      typeof import("../../services/chat-teams-file-consent.js").buildTeamsUploadedFileCard
    >;
    const fixture = await seedCompany();
    const storage = createStorageService();
    const bytes = Buffer.from("Exact original Teams file bytes.\n", "utf8");
    const consentCards: Array<{ threadId: string; card: ConsentCard }> = [];
    const fileCards: Array<{ threadId: string; card: FileCard }> = [];
    const controls: {
      beforeConsentReceipt?: () => Promise<void>;
      beforeFileInfoReceipt?: () => Promise<void>;
    } = {};
    const handlers = new Map<
      string,
      (context: { activity: unknown }) => Promise<{ status: number }>
    >();
    const runtime = new FakeChatSdkRuntime();
    const replace = runtime.replaceEndpoint.bind(runtime);
    vi.spyOn(runtime, "replaceEndpoint").mockImplementation(async (options) => {
      const instance = await replace(options);
      const thread = instance.thread.bind(instance);
      vi.spyOn(instance, "thread").mockImplementation((id) => ({
        ...thread(id),
        isDM: true,
      }));
      Object.assign(instance, {
        sendTeamsFileConsentCard: async (
          threadId: string,
          card: ConsentCard,
        ) => {
          consentCards.push({ threadId, card });
          await controls.beforeConsentReceipt?.();
          return { id: `native-consent-${consentCards.length}` };
        },
        sendTeamsUploadedFileCard: async (threadId: string, card: FileCard) => {
          fileCards.push({ threadId, card });
          await controls.beforeFileInfoReceipt?.();
          return { id: `native-file-${fileCards.length}` };
        },
      });
      if (
        options.providerConfig.provider === "microsoft-teams" &&
        options.callbacks.onTeamsFileConsent
      ) {
        handlers.clear();
        installTeamsFileConsentHook(
          { on: (name, callback) => handlers.set(name, callback) },
          {
            companyId: options.companyId,
            endpointId: options.endpointId,
            tenantId: String(options.providerConfig.credentials.appTenantId),
            botAppId: String(options.providerConfig.credentials.appId),
            onConsent: async (event) =>
              options.callbacks.onTeamsFileConsent!({
                endpointId: options.endpointId,
                provider: "microsoft-teams",
                event,
              }),
          },
        );
      }
      return instance;
    });
    const uploadRequest = vi.fn<
      NonNullable<ChatChannelServiceOptions["teamsFileUploadRequest"]>
    >(async () =>
      Response.json(
        {
          id: "teams-drive-item-1",
          name: "authority-report.txt",
          size: bytes.length,
        },
        { status: 201 },
      ),
    );
    const wakeup = vi.fn<ChatChannelServiceOptions["heartbeat"]["wakeup"]>(
      async () => ({ accepted: true }),
    );
    const cancelRun = vi.fn(async () => ({ status: "cancelled" }));
    const service = chatChannelService(db, {
      fetch: async () =>
        Response.json({ access_token: "synthetic-teams-access" }),
      runtime: runtime as unknown as ChatSdkRuntime,
      heartbeat: { wakeup: receiptBackedWakeup(wakeup), cancelRun },
      storage: storage.storage,
      publicBaseUrl: "https://paperclip.example",
      teamsFileUploadRequest: uploadRequest,
      scheduleDeferredWork: () => undefined,
    });
    const endpoint = await service.create(
      fixture.companyId,
      {
        provider: "microsoft-teams",
        assignedAgentId: fixture.assignedAgentId,
        name: "Teams native file authority",
      },
      "owner-user",
    );
    const tenantId = randomUUID();
    const botAppId = randomUUID();
    await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          clientId: botAppId,
          tenantId,
          clientSecret: "synthetic-file-secret",
        },
      },
      "owner-user",
    );
    const aadObjectId = randomUUID();
    const recipientUserId = `teams-linked-${randomUUID()}`;
    const sponsorUserId = settings.separateSponsor
      ? `teams-sponsor-${randomUUID()}`
      : "owner-user";
    for (const userId of [
      settings.linkedRecipient ? recipientUserId : null,
      settings.separateSponsor ? sponsorUserId : null,
    ]) {
      if (!userId) continue;
      await db.insert(authUsers).values({
        id: userId,
        name: "Teams authority member",
        email: `${userId}@example.com`,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.insert(companyMemberships).values({
        companyId: fixture.companyId,
        principalType: "user",
        principalId: userId,
        status: "active",
        membershipRole: "operator",
      });
    }
    if (settings.separateSponsor)
      await db
        .update(chatEndpoints)
        .set({ sponsorUserId })
        .where(eq(chatEndpoints.id, endpoint.id));
    if (settings.linkedRecipient) {
      const [principal] = await db
        .insert(chatExternalPrincipals)
        .values({
          companyId: fixture.companyId,
          provider: "microsoft-teams",
          providerAccountId: tenantId,
          externalId: aadObjectId,
          kind: "user",
          isBot: false,
        })
        .returning();
      await db.insert(chatIdentityLinks).values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        principalId: principal!.id,
        paperclipUserId: recipientUserId,
        status: "linked",
        confirmedAt: new Date(),
      });
    }
    const providerUserId = `29:file-author-${randomUUID()}`;
    const providerConversationId = `a:file-authority-${randomUUID()}`;
    const adapter = createTeamsAdapter({
      appId: botAppId,
      appPassword: "unused-parser-only",
      appTenantId: tenantId,
      appType: "SingleTenant",
    });
    const raw = {
      id: `file-source-${randomUUID()}`,
      type: "message",
      channelId: "msteams",
      timestamp: new Date().toISOString(),
      serviceUrl: "https://smba.trafficmanager.net/amer/",
      from: { id: providerUserId, aadObjectId, name: "File recipient" },
      recipient: { id: `28:${botAppId}` },
      conversation: {
        id: providerConversationId,
        conversationType: "personal",
        tenantId,
      },
      channelData: { tenant: { id: tenantId } },
      text: "Use only my exact original personal conversation.",
    };
    const message = adapter.parseMessage(raw);
    const sourceThread = makeThread({
      id: message.threadId,
      channelId: message.threadId,
      isDM: true,
      name: "Native personal file",
    });
    const deliver = async (activity = raw) => {
      const callbacks = runtime.configurations.get(endpoint.id)!.callbacks;
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider: "microsoft-teams",
        thread: sourceThread.thread,
        message: adapter.parseMessage(activity),
        trigger: "direct_message",
      });
    };
    await deliver();
    await qualifySetupRoundTrip(service, endpoint.id, aadObjectId);
    await service.test(endpoint.id);
    await service.processPendingPublications();
    const [sourceDelivery] = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          sql`${chatDeliveries.normalizedEvent}->'message'->>'providerMessageId' = ${raw.id}`,
        ),
      );
    const [conversation] = await readChatConversationsById(sourceDelivery!.conversationId!);
    const [issue] = await readIssuesById(conversation!.issueId);
    const [sourceAction] = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.deliveryId, sourceDelivery!.id),
          eq(chatActions.kind, "inbound_wakeup"),
        ),
      );
    expect(sourceDelivery).toMatchObject({
      state: "processed",
      normalizedEvent: {
        teamsPersonalRecipient: {
          aadObjectId,
          providerUserId,
          providerConversationId,
        },
      },
    });
    expect(sourceAction).toMatchObject({ status: "processed" });
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "active",
    });
    const createFile = async () => {
      const stored = await storage.storage.putFile({
        companyId: fixture.companyId,
        namespace: `issues/${issue!.id}`,
        originalFilename: "authority-report.txt",
        contentType: "text/plain",
        body: bytes,
      });
      return issueService(db).createAttachment({
        issueId: issue!.id,
        ...stored,
        createdByUserId: "owner-user",
      });
    };
    const dispatchConsent = async (
      action: "accept" | "decline" = "accept",
      patch: Record<string, unknown> = {},
      retainedHandler?: (context: {
        activity: unknown;
      }) => Promise<{ status: number }>,
    ) => {
      const card = consentCards.at(-1)?.card;
      if (!card)
        throw new Error("Expected real service consent card before callback");
      const activity = {
        id: `consent-response-${randomUUID()}`,
        type: "invoke",
        name: "fileConsent/invoke",
        channelId: "msteams",
        from: raw.from,
        recipient: raw.recipient,
        conversation: raw.conversation,
        channelData: raw.channelData,
        replyToId: `native-consent-${consentCards.length}`,
        value: {
          type: "fileUpload",
          action,
          context:
            action === "accept"
              ? card.content.acceptContext
              : card.content.declineContext,
          ...(action === "accept"
            ? {
                uploadInfo: {
                  name: card.name,
                  fileType: "txt",
                  uniqueId: "teams-drive-item-1",
                  uploadUrl:
                    "https://fixture.sharepoint.com/upload?secret=PRIVATE-UPLOAD-CANARY",
                  contentUrl:
                    "https://fixture.sharepoint.com/personal/authority-report.txt",
                },
              }
            : {}),
        },
        ...patch,
      };
      const handler = retainedHandler ?? handlers.get(`file.consent.${action}`);
      if (!handler)
        throw new Error("Expected registered service consent callback");
      return handler({ activity });
    };
    return {
      fixture,
      storage,
      bytes,
      runtime,
      service,
      endpoint,
      tenantId,
      botAppId,
      aadObjectId,
      providerUserId,
      providerConversationId,
      adapter,
      raw,
      message,
      sourceThread,
      sourceDelivery: sourceDelivery!,
      sourceAction: sourceAction!,
      conversation: conversation!,
      issue: issue!,
      consentCards,
      fileCards,
      uploadRequest,
      wakeup,
      cancelRun,
      createFile,
      deliver,
      dispatchConsent,
      controls,
      handlers,
      recipientUserId,
      sponsorUserId,
    };
  }


  export async function githubPreIngressRecoveryFixture(
    event: "issue_comment" | "pull_request_review_comment" = "issue_comment",
    replayBarrier?: ChatChannelServiceOptions["githubWebhookReplayBarrier"],
  ) {
    const fixture = await seedCompany();
    const deferred: Array<() => void> = [];
    const configured = await configuredGitHubEndpoint(
      fixture,
      {
        deferWebhookProcessing: true,
        githubWebhookReplayBarrier: replayBarrier,
        scheduleDeferredWork: (task) => deferred.push(task),
      },
      true,
    );
    const { service, endpoint, runtime, callbacks } = configured;
    // Setup admission is covered separately. Recovery is intentionally only
    // eligible for an active endpoint with an explicitly enabled repository.
    await db
      .update(chatEndpoints)
      .set({ status: "active" })
      .where(eq(chatEndpoints.id, endpoint.id));
    const current = await service.get(endpoint.id);
    const providerRuntime = runtime.endpoints.get(endpoint.id)!;
    attachFakeGitHubIssueCommentWebhook({
      botUsername: current.botUsername!,
      callbacks,
      endpointId: endpoint.id,
      runtime: providerRuntime,
    });
    const guid = randomUUID();
    const deliveryId = "9007199254740993";
    const webhookUrl = `https://paperclip.example/api/chat-webhooks/${endpoint.publicId}/github`;
    const createdAt = new Date(Date.now() - 30_000).toISOString();
    const body = `@${current.botUsername} recover the original request ${randomUUID()}`;
    const comment = {
      id: 9191,
      body,
      created_at: createdAt,
      updated_at: createdAt,
      user: { id: 42, login: "octocat", type: "User" },
      ...(event === "issue_comment"
        ? {
            issue_url:
              "https://api.github.com/repos/paperclipai/paperclip/issues/91",
          }
        : {
            pull_request_url:
              "https://api.github.com/repos/paperclipai/paperclip/pulls/91",
          }),
    };
    const payload = {
      action: "created",
      installation: { id: 2468 },
      repository: {
        id: 97531,
        full_name: "paperclipai/paperclip",
        name: "paperclip",
        owner: { id: 1357, login: "paperclipai" },
      },
      ...(event === "issue_comment"
        ? { issue: { id: 9190, number: 91 } }
        : { pull_request: { id: 9190, number: 91 } }),
      comment,
      sender: { id: 42, login: "octocat", type: "User" },
    };
    const original = {
      id: deliveryId,
      guid,
      delivered_at: createdAt,
      redelivery: false,
      status_code: 502 as number | null,
      event,
      action: "created",
      installation_id: 2468,
      repository_id: 97531,
      throttled_at: null as string | null,
    };
    let deliveries = [original];
    const extraDetails = new Map<
      string,
      { summary: typeof original; payload: unknown }
    >();
    let historyHasMore = false;
    let historyPage = 0;
    let canonicalComment = { ...comment };
    let beforeList: (() => Promise<void>) | undefined;
    let beforePost: (() => Promise<void>) | undefined;
    const requests: Array<{ method: string; pathname: string }> = [];
    const posts: string[] = [];
    const commentPath = `/repos/paperclipai/paperclip/${event === "issue_comment" ? "issues" : "pulls"}/comments/9191`;
    // Emit the actual unsafe JSON numeric literal, not a string-only mock.
    const json = (value: unknown) =>
      new Response(
        JSON.stringify(value).replaceAll(`"${deliveryId}"`, deliveryId),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    configured.setSupplementalProviderFetch(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const isRecovery =
        url.pathname.startsWith("/app/hook/") ||
        url.pathname === commentPath ||
        url.pathname === "/installation/token";
      if (!isRecovery) return undefined;
      requests.push({ method, pathname: url.pathname });
      if (url.pathname === "/app/hook/config" && method === "GET") {
        return json({
          url: webhookUrl,
          content_type: "json",
          insecure_ssl: "0",
        });
      }
      if (url.pathname === "/app/hook/deliveries") {
        await beforeList?.();
        const response = json(deliveries);
        if (historyHasMore)
          response.headers.set(
            "link",
            `<https://api.github.com/app/hook/deliveries?per_page=100&cursor=page${++historyPage}>; rel="next"`,
          );
        return response;
      }
      if (url.pathname === `/app/hook/deliveries/${deliveryId}`) {
        return json({
          ...original,
          url: webhookUrl,
          request: {
            headers: { authorization: "private-provider-header-canary" },
            payload,
          },
          response: { payload: "private-proxy-body-canary" },
        });
      }
      const extra = extraDetails.get(
        url.pathname.replace(/^\/app\/hook\/deliveries\//, ""),
      );
      if (extra)
        return json({
          ...extra.summary,
          url: webhookUrl,
          request: { payload: extra.payload },
        });
      if (
        url.pathname === `/app/hook/deliveries/${deliveryId}/attempts` &&
        method === "POST"
      ) {
        posts.push(url.pathname);
        await beforePost?.();
        return new Response(null, { status: 202 });
      }
      if (url.pathname === commentPath) return json(canonicalComment);
      if (url.pathname === "/installation/token" && method === "DELETE")
        return new Response(null, { status: 204 });
      return undefined;
    });
    const checkpoint = () =>
      db
        .select()
        .from(chatSdkState)
        .where(
          and(
            eq(chatSdkState.endpointId, endpoint.id),
            eq(chatSdkState.stateKey, "paperclip:github-webhook-recovery:v1"),
          ),
        )
        .then((rows) => rows[0]!);
    const makeScanDue = async (includeOriginal = true) => {
      const state = await checkpoint();
      await db
        .update(chatSdkState)
        .set({
          value: {
            ...(state.value as Record<string, unknown>),
            ...(includeOriginal
              ? { floor: new Date(Date.now() - 120_000).toISOString() }
              : {}),
            nextScanAt: new Date(Date.now() - 1_000).toISOString(),
          },
        })
        .where(eq(chatSdkState.id, state.id));
    };
    const ingress = () =>
      db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(chatActions.providerActionId, `github_webhook_ingress:${guid}`),
          ),
        )
        .then((rows) => rows[0]);
    const receipt = () =>
      db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(chatActions.providerActionId, `github_webhook_recovery:${guid}`),
          ),
        )
        .then((rows) => rows[0]);
    const callback = (
      webhookSecret = configured.webhookSecret,
      incomingPayload: unknown = payload,
    ) =>
      service.handleWebhook(
        endpoint.publicId,
        "github",
        signedGitHubWebhookRequest({
          delivery: guid,
          event,
          payload: incomingPayload,
          webhookSecret,
          url: webhookUrl,
        }),
      );
    const initializedAt = Date.now();
    await service.processFailedGitHubWebhookDeliveries(5, endpoint.id);
    expect(requests).toEqual([]);
    const initial = (await checkpoint()).value as Record<string, unknown>;
    expect(initial).toMatchObject({
      appId: current.botExternalId,
      webhookUrl,
      generation: expect.any(Number),
    });
    expect(Date.parse(String(initial.floor))).toBeGreaterThanOrEqual(
      initializedAt,
    );
    expect(Date.parse(String(initial.nextScanAt))).toBeGreaterThanOrEqual(
      initializedAt + 60_000,
    );
    return {
      ...configured,
      fixture,
      body,
      guid,
      deliveryId,
      original,
      payload,
      providerRuntime,
      requests,
      posts,
      checkpoint,
      makeScanDue,
      ingress,
      receipt,
      callback,
      deferred,
      setDeliveries(value: typeof deliveries) {
        deliveries = value;
      },
      setDetail(summary: typeof original, incomingPayload: unknown) {
        extraDetails.set(summary.id, { summary, payload: incomingPayload });
      },
      setHistoryHasMore(value: boolean) {
        historyHasMore = value;
      },
      setCanonicalComment(value: Partial<typeof comment>) {
        canonicalComment = { ...canonicalComment, ...value };
      },
      setBeforeList(value: typeof beforeList) {
        beforeList = value;
      },
      setBeforePost(value: typeof beforePost) {
        beforePost = value;
      },
    };
  }

export async function telegramConfirmationRecoveryFixture(decision: "accept" | "reject" = "accept") {
  const fixture = await seedCompany();
  let injectSettlementCrash = true;
  const settlementBarrier = vi.fn(async () => {
    if (!injectSettlementCrash) return;
    injectSettlementCrash = false;
    throw new Error(
      "injected post-interaction confirmation settlement crash",
    );
  });
  const { callbacks, endpoint, service, wakeup } =
    await configuredTelegramEndpoint(fixture, {
      confirmationResolutionPersistBarrier: settlementBarrier,
    });
  if (!callbacks.onAction)
    throw new Error("Telegram action callback was not registered");
  const externalUserId = "771234568";
  const dm = makeThread({
    channelId: externalUserId,
    id: `telegram:${externalUserId}`,
    isDM: true,
    name: "Telegram confirmation DM",
  });
  await deliverMessage({
    callbacks,
    endpointId: endpoint.id,
    provider: "telegram",
    thread: dm.thread,
    message: makeMessage({
      id: `${externalUserId}:1`,
      text: "Prepare a release confirmation",
      userId: externalUserId,
    }),
    trigger: "direct_message",
  });
  await qualifySetupRoundTrip(service, endpoint.id, externalUserId);
  await service.test(endpoint.id);
  const [conversation] = await service.listConversations(endpoint.id);
  if (!conversation)
    throw new Error("Expected Telegram confirmation conversation");

  const linkedUserId = `telegram-confirmation-user-${randomUUID()}`;
  const now = new Date();
  await db.insert(authUsers).values({
    id: linkedUserId,
    name: "Telegram Confirmation User",
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
    .where(
      and(
        eq(chatExternalPrincipals.companyId, fixture.companyId),
        eq(chatExternalPrincipals.provider, "telegram"),
        eq(chatExternalPrincipals.externalId, externalUserId),
      ),
    )
    .then((rows) => rows[0]);
  if (!principal) throw new Error("Expected Telegram confirmation principal");
  const linkIntent = await service.createLinkIntent(
    endpoint.id,
    principal.id,
    1_800,
  );
  const linkToken = new URL(linkIntent.confirmationUrl).searchParams.get(
    "token",
  );
  if (!linkToken) throw new Error("Telegram identity token was absent");
  await service.confirmIdentityLink(linkToken, linkedUserId);

  const interaction = await issueThreadInteractionService(db).create(
    {
      id: conversation.issueId,
      companyId: fixture.companyId,
    },
    {
      kind: "request_confirmation",
      continuationPolicy: "wake_assignee",
      title: "Release check",
      payload: {
        version: 1,
        prompt: "Proceed with Telegram production qualification?",
        acceptLabel: "Proceed",
        rejectLabel: "Stop",
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
  expect(publication).toMatchObject({
    state: "published",
    payload: {
      interactionId: interaction.id,
      card: {
        kind: "confirmation",
        title: "Proceed with Telegram production qualification?",
        actions: [
          expect.objectContaining({
            type: "callback",
            label: "Proceed",
            style: "primary",
          }),
          expect.objectContaining({
            type: "callback",
            label: "Stop",
            style: "danger",
          }),
        ],
      },
    },
  });
  if (!publication.providerMessageId)
    throw new Error("Telegram confirmation was not delivered");
  const confirmationActions = await db
    .select()
    .from(chatActions)
    .where(
      and(
        eq(chatActions.endpointId, endpoint.id),
        eq(chatActions.kind, "confirmation_response"),
      ),
    );
  expect(confirmationActions).toHaveLength(2);
  expect(
    confirmationActions.every(
      (action) =>
        action.providerActionId.startsWith("pcq:") &&
        Buffer.byteLength(
          telegramChatSdkCallbackData(action.providerActionId),
          "utf8",
        ) <= TELEGRAM_CALLBACK_DATA_LIMIT_BYTES,
    ),
  ).toBe(true);
  const acceptAction = confirmationActions.find(
    (action) => action.payload.decision === decision,
  );
  if (!acceptAction)
    throw new Error("Telegram accept action was not persisted");

  wakeup.mockClear();
  const actionEvent = {
    endpointId: endpoint.id,
    provider: "telegram" as const,
    event: {
      actionId: acceptAction.providerActionId,
      adapter: {} as never,
      messageId: publication.providerMessageId,
      openModal: async () => undefined,
      raw: {
        id: `callback-${randomUUID()}`,
        data: telegramChatSdkCallbackData(acceptAction.providerActionId),
        from: { id: Number(externalUserId), first_name: "Telegram User" },
      },
      thread: dm.thread,
      threadId: dm.thread.id,
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
  };
  return { fixture, callbacks, onAction: callbacks.onAction, endpoint, service, wakeup, settlementBarrier, dm, conversation, linkedUserId, principal, interaction, publication, acceptAction, actionEvent };
}

export async function deferredChatQueueFixture(admissionFails = false, beforeAdmission?: (service: ChatChannelService) => Promise<void>, linkedBoardUser = false) {
  const fixture = await seedCompany();
  let ownerId: string | null = null;
  const configured = await configuredSlackEndpoint(fixture, {
    linkedBoardUser,
    wakeup: async (agentId, opts) => {
      if (admissionFails)
        throw new Error("PRIVATE admission failure token=do-not-publish");
      const request = opts.durableChatRequest!;
      await db.transaction(async (tx) => {
        await request.authorize(
          tx as unknown as Parameters<typeof request.authorize>[0],
        );
        const [owner] = ownerId
          ? await tx
              .select()
              .from(agentWakeupRequests)
              .where(eq(agentWakeupRequests.id, ownerId))
          : [];
        const existingContext = owner?.payload?._paperclipWakeContext as
          Record<string, unknown> | undefined;
        const commentIds = [
          ...(Array.isArray(existingContext?.wakeCommentIds)
            ? existingContext.wakeCommentIds
            : []),
          request.commentId,
        ];
        const payload = {
          ...opts.payload,
          _paperclipWakeContext: {
            ...opts.contextSnapshot,
            wakeCommentIds: commentIds,
          },
        };
        if (owner)
          await tx
            .update(agentWakeupRequests)
            .set({ payload, coalescedCount: owner.coalescedCount + 1 })
            .where(eq(agentWakeupRequests.id, owner.id));
        await tx.insert(agentWakeupRequests).values({
          id: request.id,
          companyId: fixture.companyId,
          agentId,
          source: "assignment",
          reason: "issue_execution_deferred",
          status: owner ? "coalesced" : "deferred_issue_execution",
          payload: owner
            ? { ...opts.payload, coalescedIntoWakeupRequestId: owner.id }
            : payload,
          requestedByActorType: request.requestedByActorType,
          requestedByActorId: request.requestedByActorId,
          requestedAt: request.requestedAt,
          idempotencyKey: request.idempotencyKey,
        });
        ownerId ??= request.id;
      });
      return { accepted: true };
    },
  });
  const thread = makeThread({
    channelId: "CDEFERREDNOTICE",
    id: "slack:CDEFERREDNOTICE:1999000.1",
  });
  const send = async (id = "1999000.1") =>
    deliverMessage({
      callbacks: configured.callbacks,
      endpointId: configured.endpoint.id,
      thread: thread.thread,
      message: makeMessage({
        id,
        text: "@maya exact queued request",
        userId: linkedBoardUser ? "UBOARD" : undefined,
        mentioned: id === "1999000.1",
      }),
      trigger: id === "1999000.1" ? "mention" : "subscribed_message",
    });
  await beforeAdmission?.(configured.service);
  await send();
  const [conversation] = await readChatConversationsByEndpointId(configured.endpoint.id);
  const [action] = await db
    .select()
    .from(chatActions)
    .where(
      and(
        eq(chatActions.endpointId, configured.endpoint.id),
        eq(chatActions.kind, "inbound_wakeup"),
      ),
    );
  const promote = async () => {
    const [owner] = await readAgentWakeupRequestsById(ownerId!);
    const runId = randomUUID();
    const contextSnapshot = owner.payload!._paperclipWakeContext as Record<
      string,
      unknown
    >;
    await db.transaction(async (tx) => {
      await tx.insert(heartbeatRuns).values({
        id: runId,
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        status: "running",
        runtimeMode: "native",
        wakeupRequestId: owner.id,
        contextSnapshot,
      });
      await tx
        .update(agentWakeupRequests)
        .set({ runId, status: "claimed" })
        .where(eq(agentWakeupRequests.id, owner.id));
    });
    return runId;
  };
  return {
    ...configured,
    action,
    conversation,
    fixture,
    promote,
    send,
    thread,
  };
}

export async function publicationLaneFixture(count: number) {
  const fixture = await seedCompany();
  const storage = createStorageService();
  const runtime = new FakeChatSdkRuntime();
  const providerFetch = (input: string | URL | Request, init?: RequestInit) =>
    fakeSlackFetch(
      `U-LANE-${new Headers(init?.headers).get("authorization")}`,
    )(input, init);
  const { service } = createService(runtime, providerFetch as typeof fetch, {
    storage: storage.storage,
  });
  const lanes: Array<{
    endpoint: Awaited<ReturnType<typeof service.create>>;
    conversation: typeof chatConversations.$inferSelect;
    providerRuntime: FakeEndpointRuntime;
  }> = [];
  for (let index = 0; index < count; index += 1) {
    const endpoint = await service.create(
      fixture.companyId,
      {
        provider: "slack",
        assignedAgentId: fixture.assignedAgentId,
      },
      "owner-user",
    );
    await service.update(endpoint.id, { allowUnlinkedPeople: true }, "owner-user");
    await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          botToken: `xoxb-lane-${endpoint.id}`,
          signingSecret: `signing-${endpoint.id}`,
        },
      },
      "owner-user",
    );
    await db
      .update(chatEndpoints)
      .set({ status: "active" })
      .where(eq(chatEndpoints.id, endpoint.id));
    const channelId = `C${endpoint.id.replaceAll("-", "").toUpperCase()}`;
    await db.insert(chatEndpointResources).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      type: "channel",
      providerResourceId: channelId,
      label: "publication-lane",
      availability: "available",
      enabled: true,
    });
    const callbacks = runtime.configurations.get(endpoint.id)?.callbacks;
    if (!callbacks) throw new Error("Expected publication lane runtime");
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: makeThread({
        channelId,
        id: `slack:${channelId}:5000.1`,
        name: "publication-lane",
      }).thread,
      message: makeMessage({
        id: "5000.1",
        text: "@maya publication lane",
        mentioned: true,
      }),
      trigger: "mention",
    });
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!conversation || !providerRuntime)
      throw new Error("Expected publication lane conversation");
    lanes.push({ endpoint, conversation, providerRuntime });
  }
  const enqueue = async (
    index: number,
    text: string,
    offset = index,
    payload?: typeof chatPublications.$inferInsert.payload,
  ) => {
    const { endpoint, conversation } = lanes[index]!;
    const [publication] = await db
      .insert(chatPublications)
      .values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: conversation.id,
        issueId: conversation.issueId,
        idempotencyKey: `lane:${randomUUID()}`,
        payload: payload ?? { text },
        state: "pending",
        createdAt: new Date(Date.UTC(2000, 0, 1) + offset),
      })
      .returning();
    return publication!;
  };
  const cleanup = async () => {
    await service.shutdown();
    await db
      .update(chatEndpoints)
      .set({ status: "paused" })
      .where(
        inArray(
          chatEndpoints.id,
          lanes.map(({ endpoint }) => endpoint.id),
        ),
      );
  };
  return { ...fixture, storage, runtime, service, lanes, enqueue, cleanup };
}
