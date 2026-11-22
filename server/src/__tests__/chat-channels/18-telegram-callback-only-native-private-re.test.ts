import {
  githubChatManagementService,
} from "../../services/chat-github-management.js";
import {
  agents,
  authUsers,
  chatActions,
  chatConversations,
  chatEndpointResources,
  chatEndpoints,
  chatExternalPrincipals,
  chatGitHubConfigurations,
  chatIdentityLinks,
  chatMessageLinks,
  chatPublications,
  companies,
  companyMemberships,
  heartbeatRuns,
  issueComments,
  issues,
  toolConnections,
} from "@paperclipai/db";
import {
  randomUUID,
} from "node:crypto";
import {
  and,
  eq,
  like,
} from "drizzle-orm";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  isPaperclipExternalChatTurn,
} from "@paperclipai/adapter-utils/server-utils";
import {
  createChatSdkEndpointRuntime,
} from "../../services/chat-sdk-runtime.js";
import {
  issueService,
} from "../../services/issues.js";
import {
  enqueueChatRunMilestones,
  resolveChatRunPresentationAuthorizationReason,
} from "../../services/chat-run-publications.js";
import {
  heartbeatService,
  resolveExternalChatWakeProvider,
} from "../../services/heartbeat.js";
import {
  registerServerAdapter,
  unregisterServerAdapter,
} from "../../adapters/index.js";
import {
  FakeChatSdkRuntime,
  fakeSlackFetch,
  fakeTelegramFetch,
  makeMessage,
  makeThread,
} from ".././helpers/chat-channels-fixture.js";
import {
  addSelectedChatFinal,
  chatWakeContext,
  configuredSlackEndpoint,
  configuredTelegramEndpoint,
  createService,
  db,
  deliverMessage,
  describeChatChannelsSuite,
  qualifySetupRoundTrip,
  readChatConversationsByEndpointId,
  readChatDeliveriesByEndpointId,
  readChatEndpointsById,
  readChatPublicationsByCommentId,
  readChatPublicationsByEndpointId,
  readChatPublicationsById,
  readIssuesByCompanyId,
  readIssuesById,
  recordSlackUrlVerification,
  retirePublicationFixture,
  seedCompany,
  configuredGitHubEndpoint,
} from "../helpers/chat-channels-harness.js";
import type { InternalSetupState } from "../../services/chat-channels/runtime-types.js";

describeChatChannelsSuite("chat channels 18-telegram-callback-only-native-private-re", () => {
  it("keeps one Paperclip account mapping for the same provider principal across endpoints", async () => {
    const fixture = await seedCompany();
    const firstContext = createService(
      new FakeChatSdkRuntime(),
      fakeSlackFetch("U-BOT-IDENTITY-A") as typeof globalThis.fetch,
    );
    const secondContext = createService(
      new FakeChatSdkRuntime(),
      fakeSlackFetch("U-BOT-IDENTITY-B") as typeof globalThis.fetch,
    );
    const first = await firstContext.service.create(
      fixture.companyId,
      {
        provider: "slack",
        assignedAgentId: fixture.assignedAgentId,
      },
      "owner-user",
    );
    const second = await secondContext.service.create(
      fixture.companyId,
      {
        provider: "slack",
        assignedAgentId: fixture.replacementAgentId,
      },
      "owner-user",
    );
    for (const [context, endpoint, suffix] of [
      [firstContext, first, "a"],
      [secondContext, second, "b"],
    ] as const) {
      await context.service.configure(
        endpoint.id,
        {
          action: "configure",
          credentials: {
            botToken: `xoxb-identity-${suffix}`,
            signingSecret: `identity-secret-${suffix}`,
          },
        },
        "owner-user",
      );
      await recordSlackUrlVerification(context.service, endpoint.publicId, `identity-secret-${suffix}`);
      await context.service.configure(
        endpoint.id,
        { action: "verify" },
        "owner-user",
      );
      const callbacks = context.runtime.configurations.get(
        endpoint.id,
      )?.callbacks;
      if (!callbacks) throw new Error("Expected endpoint callbacks");
      const thread = makeThread({
        channelId: `C-IDENTITY-${suffix.toUpperCase()}`,
        id: `slack:C-IDENTITY-${suffix.toUpperCase()}:1`,
        name: `identity-${suffix}`,
      });
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        thread: thread.thread,
        message: makeMessage({
          id: `identity-${suffix}`,
          text: `@bot identify ${suffix}`,
          mentioned: true,
          userId: "U-SHARED-HUMAN",
        }),
        trigger: "mention",
      });
    }

    const now = new Date();
    await db.insert(authUsers).values([
      {
        id: "paperclip-user-a",
        name: "Paperclip User A",
        email: `identity-a-${fixture.companyId}@example.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "paperclip-user-b",
        name: "Paperclip User B",
        email: `identity-b-${fixture.companyId}@example.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(companyMemberships).values([
      {
        companyId: fixture.companyId,
        principalType: "user",
        principalId: "paperclip-user-a",
        status: "active",
        membershipRole: "operator",
      },
      {
        companyId: fixture.companyId,
        principalType: "user",
        principalId: "paperclip-user-b",
        status: "active",
        membershipRole: "operator",
      },
    ]);
    const principal = await db
      .select()
      .from(chatExternalPrincipals)
      .where(eq(chatExternalPrincipals.externalId, "U-SHARED-HUMAN"))
      .then((rows) => rows[0]);
    const firstIntent = await firstContext.service.createLinkIntent(
      first.id,
      principal.id,
      1_800,
    );
    const firstToken = new URL(firstIntent.confirmationUrl).searchParams.get(
      "token",
    );
    if (!firstToken) throw new Error("First identity token was absent");
    await firstContext.service.confirmIdentityLink(
      firstToken,
      "paperclip-user-a",
    );

    const secondIntent = await secondContext.service.createLinkIntent(
      second.id,
      principal.id,
      1_800,
    );
    const secondToken = new URL(secondIntent.confirmationUrl).searchParams.get(
      "token",
    );
    if (!secondToken) throw new Error("Second identity token was absent");
    await expect(
      secondContext.service.confirmIdentityLink(
        secondToken,
        "paperclip-user-b",
      ),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: "chat_identity_link_conflict" },
    });
  });

  it("publishes only the safe projection once and locks reassignment of a bound task", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture);
    const channel = makeThread({
      channelId: "C-SAFE",
      id: "slack:C-SAFE:4000.1",
      name: "safe-output",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: channel.thread,
      message: makeMessage({
        id: "4000.1",
        text: "@maya give me the public result",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id);
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    const comment = await issueService(db).addComment(
      conversation.issueId,
      "Visible answer. <analysis>never expose this reasoning</analysis>",
      { userId: "owner-user" },
      { authorType: "user" },
    );

    const first = await service.publishComment(
      endpoint.id,
      conversation.id,
      comment.id,
    );
    const second = await service.publishComment(
      endpoint.id,
      conversation.id,
      comment.id,
    );
    expect(first.id).toBe(second.id);
    // Both calls return the same durable row after the synchronous delivery
    // attempt; callers never observe a stale pre-send snapshot.
    expect(first.state).toBe("published");
    expect(second.state).toBe("published");
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    expect(providerRuntime?.posts).toEqual([
      { threadId: channel.thread.id, text: "Visible answer." },
    ]);
    const publications = await readChatPublicationsByEndpointId(endpoint.id);
    const links = await db
      .select()
      .from(chatMessageLinks)
      .where(eq(chatMessageLinks.endpointId, endpoint.id));
    const explicitPublications = publications.filter(
      (publication) => publication.commentId === comment.id,
    );
    expect(explicitPublications).toHaveLength(1);
    expect(explicitPublications[0]).toMatchObject({
      state: "published",
      providerMessageId: expect.stringMatching(/^outbound-\d+$/),
    });
    expect(
      links.filter(
        (link) => link.direction === "inbound" || link.commentId === comment.id,
      ),
    ).toHaveLength(3);
    expect(
      links.find(
        (link) =>
          link.direction === "outbound" && link.commentId === comment.id,
      )?.providerMessageId,
    ).toBe(explicitPublications[0]?.providerMessageId);

    await expect(
      issueService(db).update(conversation.issueId, {
        assigneeAgentId: fixture.replacementAgentId,
        actorUserId: "owner-user",
      }),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        code: "chat_binding_agent_locked",
        conversationId: conversation.id,
      },
    });
    const [boundIssue] = await readIssuesById(conversation.issueId);
    expect(boundIssue.assigneeAgentId).toBe(fixture.assignedAgentId);

    await service.configure(endpoint.id, { action: "remove" }, "owner-user");
    await expect(
      issueService(db).update(conversation.issueId, {
        assigneeAgentId: fixture.replacementAgentId,
        actorUserId: "owner-user",
      }),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        code: "chat_binding_agent_locked",
        conversationId: conversation.id,
      },
    });
    await expect(
      service.getIssueBinding(conversation.issueId),
    ).resolves.toMatchObject({
      endpointId: endpoint.id,
      conversationId: conversation.id,
      assignedAgentLocked: true,
    });
  });

  it("keeps external-continuation lifecycle comments internal and publishes only the selected final", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture);
    const channel = makeThread({
      channelId: "C-CONTINUATION-FINAL",
      id: "slack:C-CONTINUATION-FINAL:4005.1",
      name: "continuation-final",
    });
    const providerMessageId = "4005.1";
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: channel.thread,
      message: makeMessage({
        id: providerMessageId,
        text: "@maya return the exact continuation result",
        mentioned: true,
      }),
      trigger: "mention",
    });
    const conversation = await db
      .select()
      .from(chatConversations)
      .where(
        and(
          eq(chatConversations.endpointId, endpoint.id),
          eq(chatConversations.externalThreadId, channel.thread.id),
        ),
      )
      .then((rows) => rows[0]);
    if (!conversation) throw new Error("Expected Slack conversation");

    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: fixture.companyId,
      agentId: fixture.assignedAgentId,
      status: "succeeded",
      contextSnapshot: {
        ...(await chatWakeContext({
          endpointId: endpoint.id,
          issueId: conversation.issueId,
          provider: "slack",
          providerMessageId,
        })),
        externalChatContinuation: true,
        paperclipWake: { externalInteractionContinuation: true },
      },
    });

    const lifecycleComment = await issueService(db).addComment(
      conversation.issueId,
      "Answer received for the interaction. Closing issue.",
      { agentId: fixture.assignedAgentId, runId },
      {
        authorType: "agent",
        authorizationReason: "paperclip_runner_protocol",
      },
    );
    await expect(
      db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.id, lifecycleComment.id)),
    ).resolves.toEqual([
      { body: "Answer received for the interaction. Closing issue." },
    ]);
    await expect(
      readChatPublicationsByCommentId(lifecycleComment.id),
    ).resolves.toHaveLength(0);

    // A continuation agent may write its final prose before the heartbeat
    // presentation resolver selects the identical adapter response. That
    // first write is intentionally internal; resolving the same text must
    // upgrade the one durable comment instead of falling through to a generic
    // "completed this turn" provider milestone.
    const provisionalFinalComment = await issueService(db).addComment(
      conversation.issueId,
      "SLACK-CONTINUATION-Onyx",
      { agentId: fixture.assignedAgentId, runId },
      { authorType: "agent", authorizationReason: "allow_self" },
    );
    await expect(
      readChatPublicationsByCommentId(provisionalFinalComment.id),
    ).resolves.toHaveLength(0);

    const authorizationReason =
      await resolveChatRunPresentationAuthorizationReason(db, {
        companyId: fixture.companyId,
        issueId: conversation.issueId,
        runId,
      });
    expect(authorizationReason).toBe("allow_chat_run_presentation");
    const finalComment = await issueService(db).addComment(
      conversation.issueId,
      "SLACK-CONTINUATION-Onyx",
      { agentId: fixture.assignedAgentId, runId },
      { authorType: "agent", authorizationReason },
    );
    expect(finalComment.id).toBe(provisionalFinalComment.id);
    await expect(
      db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.issueId, conversation.issueId),
            eq(issueComments.createdByRunId, runId),
            eq(issueComments.body, "SLACK-CONTINUATION-Onyx"),
          ),
        ),
    ).resolves.toHaveLength(1);
    await expect(
      db
        .select({ metadata: issueComments.metadata })
        .from(issueComments)
        .where(eq(issueComments.id, finalComment.id)),
    ).resolves.toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({
          authorizationReason: "allow_chat_run_presentation",
        }),
      }),
    ]);
    await expect(
      db
        .select({ state: chatPublications.state })
        .from(chatPublications)
        .where(eq(chatPublications.commentId, finalComment.id)),
    ).resolves.toEqual([{ state: "pending" }]);

    await service.processPendingPublications();
    await expect(
      db
        .select({ state: chatPublications.state })
        .from(chatPublications)
        .where(eq(chatPublications.commentId, finalComment.id)),
    ).resolves.toEqual([{ state: "published" }]);
    const posts = runtime.endpoints.get(endpoint.id)?.posts ?? [];
    expect(posts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          threadId: channel.thread.id,
          text: "SLACK-CONTINUATION-Onyx",
        }),
      ]),
    );
    expect(JSON.stringify(posts)).not.toContain("Answer received");
  });

  it("keeps root-chat bookkeeping comments internal and publishes only the selected final", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture);
    const channel = makeThread({
      channelId: "C-ROOT-FINAL",
      id: "slack:C-ROOT-FINAL:4006.1",
      name: "root-final",
    });
    const providerMessageId = "4006.1";
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: channel.thread,
      message: makeMessage({
        id: providerMessageId,
        text: "@maya return only ROOT-CHAT-FINAL",
        mentioned: true,
      }),
      trigger: "mention",
    });
    const conversation = await db
      .select()
      .from(chatConversations)
      .where(
        and(
          eq(chatConversations.endpointId, endpoint.id),
          eq(chatConversations.externalThreadId, channel.thread.id),
        ),
      )
      .then((rows) => rows[0]);
    if (!conversation) throw new Error("Expected Slack conversation");

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
        providerMessageId,
      }),
    });

    const bookkeepingComment = await issueService(db).addComment(
      conversation.issueId,
      "Acknowledged the latest comment; it changes my next action.",
      { agentId: fixture.assignedAgentId, runId },
      {
        authorType: "agent",
        authorizationReason: "paperclip_runner_protocol",
      },
    );
    await expect(
      readChatPublicationsByCommentId(bookkeepingComment.id),
    ).resolves.toHaveLength(0);

    const authorizationReason =
      await resolveChatRunPresentationAuthorizationReason(db, {
        companyId: fixture.companyId,
        issueId: conversation.issueId,
        runId,
      });
    expect(authorizationReason).toBe("allow_chat_run_presentation");
    const finalComment = await issueService(db).addComment(
      conversation.issueId,
      "ROOT-CHAT-FINAL",
      { agentId: fixture.assignedAgentId, runId },
      { authorType: "agent", authorizationReason },
    );
    await service.processPendingPublications(1_000);

    await expect(
      db
        .select({ state: chatPublications.state })
        .from(chatPublications)
        .where(eq(chatPublications.commentId, finalComment.id)),
    ).resolves.toEqual([{ state: "published" }]);
    const posts = runtime.endpoints.get(endpoint.id)?.posts ?? [];
    expect(
      posts.filter(
        (post) =>
          post.threadId === channel.thread.id &&
          post.text === "ROOT-CHAT-FINAL",
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(posts)).not.toContain("Acknowledged");
  });

  it("materializes direct external-chat finals once and accepts the next turn without agent bookkeeping writes", async () => {
    const fixture = await seedCompany();
    const adapterType = `chat-shortcut-test-${randomUUID()}`;
    const directFinals = ["SHORTCUT-FIRST", "SHORTCUT-SECOND"];
    const execute = vi.fn(async (_input: unknown) => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: directFinals[execute.mock.calls.length - 1]!,
      provider: "test",
      model: "test-model",
    }));
    registerServerAdapter({
      type: adapterType,
      supportsLocalAgentJwt: false,
      execute,
      testEnvironment: async () => ({
        adapterType,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });

    const heartbeat = heartbeatService(db);
    try {
      await db
        .update(companies)
        .set({ defaultResponsibleUserId: "owner-user" })
        .where(eq(companies.id, fixture.companyId));
      await db
        .update(agents)
        .set({
          adapterType,
          runtimeConfig: {
            heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
          },
        })
        .where(eq(agents.id, fixture.assignedAgentId));

      const { callbacks, endpoint, runtime, service } =
        await configuredSlackEndpoint(fixture, {
          wakeup: heartbeat.wakeup,
        });
      const configuredEndpoint = await service.get(endpoint.id);
      const [principal] = await db
        .insert(chatExternalPrincipals)
        .values({
          companyId: fixture.companyId,
          provider: "slack",
          providerAccountId: configuredEndpoint.providerAccountId!,
          externalId: "U-SHORTCUT-LINKED",
          kind: "user",
          displayName: "Linked Chat User",
        })
        .returning();
      await db.insert(chatIdentityLinks).values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        principalId: principal!.id,
        paperclipUserId: "owner-user",
        status: "linked",
        confirmedAt: new Date(),
      });

      const channel = makeThread({
        channelId: "C-SHORTCUT",
        id: "slack:C-SHORTCUT:shortcut-root",
        name: "shortcut",
      });
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        thread: channel.thread,
        message: makeMessage({
          id: "shortcut-root",
          text: "@maya answer the first self-contained question",
          mentioned: true,
          userId: "U-SHORTCUT-LINKED",
        }),
        trigger: "mention",
      });
      await heartbeat.drainActiveRunExecutions();

      const [conversation] = await db
        .select()
        .from(chatConversations)
        .where(
          and(
            eq(chatConversations.endpointId, endpoint.id),
            eq(chatConversations.externalThreadId, channel.thread.id),
          ),
        );
      expect(conversation).toBeDefined();
      const firstRun = await db
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, fixture.companyId),
            eq(heartbeatRuns.agentId, fixture.assignedAgentId),
          ),
        )
        .then((rows) => rows.find((row) => row.status === "succeeded"));
      expect(firstRun).toBeDefined();
      const firstAdapterInput = execute.mock.calls[0]?.[0] as
        { context?: { paperclipWake?: unknown } } | undefined;
      expect(
        isPaperclipExternalChatTurn(firstAdapterInput?.context?.paperclipWake),
      ).toBe(true);
      const [firstInboundLink] = await db
        .select({ commentId: chatMessageLinks.commentId })
        .from(chatMessageLinks)
        .where(
          and(
            eq(chatMessageLinks.endpointId, endpoint.id),
            eq(chatMessageLinks.providerMessageId, "shortcut-root"),
            eq(chatMessageLinks.direction, "inbound"),
          ),
        );
      const trustedWakeContext = {
        source: "chat:slack",
        wakeCommentIds: [firstInboundLink!.commentId!],
        paperclipHarnessCheckedOut: true,
      };
      await expect(
        resolveExternalChatWakeProvider({
          db,
          companyId: fixture.companyId,
          agentId: fixture.assignedAgentId,
          issueId: conversation!.issueId,
          contextSnapshot: trustedWakeContext,
        }),
      ).resolves.toBe("slack");
      await expect(
        resolveExternalChatWakeProvider({
          db,
          companyId: fixture.companyId,
          agentId: fixture.assignedAgentId,
          issueId: conversation!.issueId,
          contextSnapshot: {
            ...trustedWakeContext,
            source: "chat:slack:recovery",
          },
        }),
      ).resolves.toBe("slack");
      await expect(
        resolveExternalChatWakeProvider({
          db,
          companyId: fixture.companyId,
          agentId: fixture.assignedAgentId,
          issueId: conversation!.issueId,
          contextSnapshot: {
            ...trustedWakeContext,
            source: "chat:slack:recovery:unexpected",
          },
        }),
      ).resolves.toBeNull();
      await expect(
        resolveExternalChatWakeProvider({
          db,
          companyId: fixture.companyId,
          agentId: fixture.replacementAgentId,
          issueId: conversation!.issueId,
          contextSnapshot: trustedWakeContext,
        }),
      ).resolves.toBeNull();
      await expect(
        resolveExternalChatWakeProvider({
          db,
          companyId: fixture.companyId,
          agentId: fixture.assignedAgentId,
          issueId: conversation!.issueId,
          contextSnapshot: {
            ...trustedWakeContext,
            source: "automation",
          },
        }),
      ).resolves.toBeNull();
      await expect(
        resolveExternalChatWakeProvider({
          db,
          companyId: randomUUID(),
          agentId: fixture.assignedAgentId,
          issueId: conversation!.issueId,
          contextSnapshot: trustedWakeContext,
        }),
      ).resolves.toBeNull();
      await expect(
        resolveExternalChatWakeProvider({
          db,
          companyId: fixture.companyId,
          agentId: fixture.assignedAgentId,
          issueId: randomUUID(),
          contextSnapshot: trustedWakeContext,
        }),
      ).resolves.toBeNull();
      await expect(
        resolveExternalChatWakeProvider({
          db,
          companyId: fixture.companyId,
          agentId: fixture.assignedAgentId,
          issueId: conversation!.issueId,
          contextSnapshot: {
            ...trustedWakeContext,
            paperclipHarnessCheckedOut: false,
          },
        }),
      ).resolves.toBeNull();
      await expect(
        resolveExternalChatWakeProvider({
          db,
          companyId: fixture.companyId,
          agentId: fixture.assignedAgentId,
          issueId: conversation!.issueId,
          contextSnapshot: {
            ...trustedWakeContext,
            source: "chat:discord",
          },
        }),
      ).resolves.toBeNull();

      const [internalComment] = await db
        .insert(issueComments)
        .values({
          companyId: fixture.companyId,
          issueId: conversation!.issueId,
          authorType: "user",
          authorUserId: "owner-user",
          body: "Internal board note, not external chat input.",
        })
        .returning();
      await db.insert(chatMessageLinks).values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: conversation!.id,
        commentId: internalComment!.id,
        providerMessageId: "shortcut-outbound-only",
        direction: "outbound",
      });
      await expect(
        resolveExternalChatWakeProvider({
          db,
          companyId: fixture.companyId,
          agentId: fixture.assignedAgentId,
          issueId: conversation!.issueId,
          contextSnapshot: {
            ...trustedWakeContext,
            wakeCommentIds: [firstInboundLink!.commentId!, internalComment!.id],
          },
        }),
      ).resolves.toBeNull();
      await expect(
        resolveExternalChatWakeProvider({
          db,
          companyId: fixture.companyId,
          agentId: fixture.assignedAgentId,
          issueId: conversation!.issueId,
          contextSnapshot: {
            ...trustedWakeContext,
            wakeCommentIds: [internalComment!.id],
          },
        }),
      ).resolves.toBeNull();
      const firstFinal = await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.createdByRunId, firstRun!.id));
      expect(firstFinal).toHaveLength(1);
      expect(firstFinal[0]).toMatchObject({
        issueId: conversation!.issueId,
        body: "SHORTCUT-FIRST",
        metadata: expect.objectContaining({
          authorizationReason: "allow_chat_run_presentation",
        }),
      });
      await expect(
        readChatPublicationsByCommentId(firstFinal[0]!.id),
      ).resolves.toHaveLength(1);
      await service.processPendingPublications(1_000);

      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        thread: channel.thread,
        message: makeMessage({
          id: "shortcut-followup",
          text: "answer the second self-contained question",
          userId: "U-SHORTCUT-LINKED",
        }),
        trigger: "subscribed_message",
      });
      await heartbeat.drainActiveRunExecutions();

      const runs = await db
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, fixture.companyId),
            eq(heartbeatRuns.agentId, fixture.assignedAgentId),
          ),
        );
      const succeededRuns = runs.filter((row) => row.status === "succeeded");
      expect(succeededRuns).toHaveLength(2);
      const secondRun = succeededRuns.find((row) => row.id !== firstRun!.id);
      expect(secondRun).toBeDefined();
      const secondAdapterInput = execute.mock.calls[1]?.[0] as
        { context?: { paperclipWake?: unknown } } | undefined;
      expect(
        isPaperclipExternalChatTurn(secondAdapterInput?.context?.paperclipWake),
      ).toBe(true);
      const secondFinal = await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.createdByRunId, secondRun!.id));
      expect(secondFinal).toHaveLength(1);
      expect(secondFinal[0]).toMatchObject({
        issueId: conversation!.issueId,
        body: "SHORTCUT-SECOND",
        metadata: expect.objectContaining({
          authorizationReason: "allow_chat_run_presentation",
        }),
      });
      await service.processPendingPublications(1_000);

      expect(execute).toHaveBeenCalledTimes(2);
      expect(
        (runtime.endpoints.get(endpoint.id)?.posts ?? []).filter(
          (post) =>
            post.threadId === channel.thread.id &&
            directFinals.includes(post.text),
        ),
      ).toEqual([
        expect.objectContaining({ text: "SHORTCUT-FIRST" }),
        expect.objectContaining({ text: "SHORTCUT-SECOND" }),
      ]);
      const providerFacingComments = await db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.issueId, conversation!.issueId),
            eq(issueComments.authorType, "agent"),
          ),
        );
      expect(providerFacingComments).toHaveLength(2);
      expect(providerFacingComments).toEqual(
        expect.arrayContaining([
          { body: "SHORTCUT-FIRST" },
          { body: "SHORTCUT-SECOND" },
        ]),
      );
    } finally {
      await heartbeat.drainActiveRunExecutions();
      unregisterServerAdapter(adapterType);
    }
  });

  it("suppresses persisted GitHub queued, progress and completion comments on replay", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } = await configuredGitHubEndpoint(fixture);
    const thread = makeThread({ channelId: "github:paperclipai/paperclip", id: "github:paperclipai/paperclip:issue:417" });
    await deliverMessage({ callbacks, endpointId: endpoint.id, provider: "github", thread: thread.thread,
      message: makeMessage({ id: "41701", text: "@maya produce one quiet response", mentioned: true }), trigger: "mention" });
    const config = await githubChatManagementService(db).configuration(endpoint.id, "owner-user");
    await db.insert(chatGitHubConfigurations).values({ companyId: fixture.companyId, endpointId: endpoint.id, configuration: config.configuration, updatedByUserId: "owner-user" });
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    const [run] = await db.insert(heartbeatRuns).values({ companyId: fixture.companyId, agentId: fixture.assignedAgentId,
      status: "succeeded", contextSnapshot: await chatWakeContext({ endpointId: endpoint.id, issueId: conversation.issueId,
        provider: "github", providerMessageId: "41701" }) }).returning();
    for (const progressState of ["queued", "working", "waiting_for_input", "completed"] as const) {
      await db.insert(chatPublications).values({ companyId: fixture.companyId, endpointId: endpoint.id,
        conversationId: conversation.id, issueId: conversation.issueId,
        idempotencyKey: `run:${run.id}:${progressState}:${endpoint.id}`,
        payload: { text: `Maya ${progressState}`, progressState }, state: "pending" });
    }
    const [legacyFinal] = await db.insert(issueComments).values({ companyId: fixture.companyId, issueId: conversation.issueId,
      authorType: "agent", authorAgentId: fixture.assignedAgentId, body: "Legacy runner final prose", createdByRunId: run.id,
      metadata: { version: 1, authorizationReason: "allow_chat_run_presentation", sections: [] } }).returning();
    await db.insert(chatPublications).values({ companyId: fixture.companyId, endpointId: endpoint.id, conversationId: conversation.id,
      issueId: conversation.issueId, commentId: legacyFinal.id, idempotencyKey: `comment:${legacyFinal.id}:${endpoint.id}`,
      payload: { text: legacyFinal.body }, state: "pending" });
    await service.processPendingPublications(); await service.processPendingPublications();
    const provider = runtime.endpoints.get(endpoint.id);
    expect(provider?.posts).toEqual([]); expect(provider?.edits).toEqual([]);
    const rows = await db.select().from(chatPublications).where(eq(chatPublications.conversationId, conversation.id));
    expect(rows).toHaveLength(5); expect(rows.every(row => row.state === "cancelled" && row.providerMessageId === null)).toBe(true);
    const [removal] = await db.select().from(chatActions).where(and(eq(chatActions.endpointId, endpoint.id),
      like(chatActions.providerActionId, "receipt_reaction_remove:%")));
    expect(removal).toBeDefined();
    await service.processPendingReceiptReactions(1, removal.id);
    expect(provider?.removedReactions).toEqual([{ threadId: thread.thread.id, messageId: "41701", emoji: "eyes" }]);
  });

  it("preserves automatic final replies for legacy GitHub connections without saved review configuration", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } = await configuredGitHubEndpoint(fixture);
    const thread = makeThread({ channelId: "github:paperclipai/paperclip", id: "github:paperclipai/paperclip:issue:417" });
    await deliverMessage({ callbacks, endpointId: endpoint.id, provider: "github", thread: thread.thread,
      message: makeMessage({ id: "41701", text: "@maya answer", mentioned: true }), trigger: "mention" });
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    const [run] = await db.insert(heartbeatRuns).values({ companyId: fixture.companyId, agentId: fixture.assignedAgentId,
      status: "succeeded", contextSnapshot: await chatWakeContext({ endpointId: endpoint.id, issueId: conversation.issueId, provider: "github", providerMessageId: "41701" }) }).returning();
    await expect(resolveChatRunPresentationAuthorizationReason(db, { companyId: fixture.companyId, issueId: conversation.issueId, runId: run.id })).resolves.toBe("allow_chat_run_presentation");
    await addSelectedChatFinal({ companyId: fixture.companyId, issueId: conversation.issueId, agentId: fixture.assignedAgentId, runId: run.id, body: "Legacy answer survives upgrade" });
    await enqueueChatRunMilestones(db);
    await service.processPendingPublications();
    expect(runtime.endpoints.get(endpoint.id)?.posts.some(post => JSON.stringify(post).includes("Legacy answer survives upgrade"))).toBe(true);
  });

  describe("Telegram callback-only native private responses", () => {
    async function nativePrivateFixture(linked = false, privateChat = false) {
      const fixture = await seedCompany();
      const botId = Number.parseInt(
        randomUUID().replaceAll("-", "").slice(0, 12),
        16,
      );
      const scheduled: Array<() => void> = [];
      const context = createService(
        new FakeChatSdkRuntime(),
        fakeTelegramFetch(botId) as typeof fetch,
        {
          scheduleDeferredWork: (task) => {
            scheduled.push(task);
          },
        },
      );
      const endpoint = await context.service.create(
        fixture.companyId,
        {
          provider: "telegram",
          assignedAgentId: fixture.assignedAgentId,
          name: "Native private callback fixture",
        },
        "owner-user",
      );
      await context.service.configure(
        endpoint.id,
        {
          action: "configure",
          credentials: { botToken: `${botId}:synthetic-private-token` },
        },
        "owner-user",
      );
      await db
        .update(chatEndpoints)
        .set({ status: "active" })
        .where(eq(chatEndpoints.id, endpoint.id));
      const chatId = privateChat ? 456 : -100123;
      await db.insert(chatEndpointResources).values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        type: "group",
        providerResourceId: String(chatId),
        label: "Private callback source",
        enabled: true,
      });
      if (linked) {
        const [stored] = await readChatEndpointsById(endpoint.id);
        const [principal] = await db
          .insert(chatExternalPrincipals)
          .values({
            companyId: fixture.companyId,
            provider: "telegram",
            providerAccountId: stored.providerAccountId!,
            externalId: "456",
            kind: "user",
            isBot: false,
          })
          .returning();
        await db.insert(chatIdentityLinks).values({
          companyId: fixture.companyId,
          endpointId: endpoint.id,
          principalId: principal.id,
          status: "linked",
          paperclipUserId: "owner-user",
          confirmedAt: new Date(),
        });
      }
      const providerRequests: Array<{
        method: string;
        body: Record<string, unknown>;
      }> = [];
      let responseMode: "accepted" | "missing_receipt" | "rate_limited" =
        "accepted";
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (input, init) => {
        const method = new URL(String(input)).pathname.split("/").at(-1)!;
        if (method === "getMe")
          return Response.json({
            ok: true,
            result: {
              id: botId,
              is_bot: true,
              first_name: "Synthetic",
              username: `paperclip_${botId}_bot`,
            },
          });
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<
          string,
          unknown
        >;
        providerRequests.push({ method, body });
        if (method === "answerCallbackQuery")
          return Response.json({ ok: true, result: true });
        if (method !== "sendMessage")
          throw new Error("Unexpected synthetic Telegram request");
        if (responseMode === "missing_receipt")
          return Response.json({ ok: true, result: true });
        if (responseMode === "rate_limited")
          return Response.json(
            { ok: false, error_code: 429, parameters: { retry_after: 20 } },
            { status: 429 },
          );
        if (privateChat)
          return Response.json({
            ok: true,
            result: {
              message_id: 908,
              chat: { id: Number(body.chat_id), type: "private" },
              from: { id: botId, is_bot: true },
            },
          });
        const parameters = body.ephemeral_message_parameters as {
          receiver_user_id: number;
        };
        return Response.json({
          ok: true,
          result: {
            message_id: 0,
            ephemeral_message_id: 908,
            chat: { id: Number(body.chat_id), type: "supergroup" },
            from: { id: botId, is_bot: true },
            receiver_user: { id: parameters.receiver_user_id, is_bot: false },
          },
        });
      });
      let pinned: ReturnType<typeof createChatSdkEndpointRuntime>;
      const install = (runtime: FakeChatSdkRuntime) => {
        const configuration = runtime.configurations.get(endpoint.id)!;
        pinned = createChatSdkEndpointRuntime({
          ...configuration,
          logger: "silent",
        });
        Object.assign(runtime.endpoints.get(endpoint.id)!, {
          handleWebhook: (...args: Parameters<typeof pinned.handleWebhook>) =>
            pinned.handleWebhook(...args),
          sendTelegramCallbackNotice: (
            ...args: Parameters<typeof pinned.sendTelegramCallbackNotice>
          ) => pinned.sendTelegramCallbackNotice(...args),
        });
      };
      install(context.runtime);
      const payload = (
        callbackId = "native-private-callback-1",
        actorId = 456,
        sourceChatId = chatId,
      ) => ({
        update_id: 901,
        callback_query: {
          id: callbackId,
          from: { id: actorId, is_bot: false, first_name: "Synthetic actor" },
          chat_instance: "synthetic-instance",
          data: "pcq:unavailable",
          message: {
            message_id: 71,
            date: Math.floor(Date.now() / 1000),
            chat: {
              id: sourceChatId,
              type: privateChat ? "private" : "supergroup",
              title: "Source",
            },
            from: { id: botId, is_bot: true, first_name: "Synthetic" },
            text: "Choose an option",
          },
        },
      });
      const deliver = async (update = payload()) => {
        const configuration = context.runtime.configurations.get(endpoint.id)!;
        if (configuration.providerConfig.provider !== "telegram")
          throw new Error("Expected Telegram configuration");
        return context.service.handleWebhook(
          endpoint.publicId,
          "telegram",
          new Request("https://paperclip.example/synthetic-telegram-webhook", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-telegram-bot-api-secret-token":
                configuration.providerConfig.credentials.secretToken,
            },
            body: JSON.stringify(update),
          }),
        );
      };
      const actions = () =>
        db
          .select()
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, endpoint.id),
              eq(chatActions.kind, "provider_effect"),
            ),
          );
      const deliveries = () =>
        readChatDeliveriesByEndpointId(endpoint.id);
      let resumed: ReturnType<typeof createService> | undefined;
      return {
        ...context,
        fixture,
        endpoint,
        scheduled,
        providerRequests,
        payload,
        deliver,
        actions,
        deliveries,
        setResponseMode(mode: typeof responseMode) {
          responseMode = mode;
        },
        async restart() {
          await pinned.shutdown();
          await context.service.shutdown();
          const resumedRuntime = new FakeChatSdkRuntime();
          const replace = resumedRuntime.replaceEndpoint.bind(resumedRuntime);
          resumedRuntime.replaceEndpoint = async (options) => {
            const instance = await replace(options);
            install(resumedRuntime);
            return instance;
          };
          resumed = createService(
            resumedRuntime,
            fakeTelegramFetch(botId) as typeof fetch,
            {
              scheduleDeferredWork: (task) => {
                scheduled.push(task);
              },
            },
          );
          return resumed;
        },
        async close() {
          try {
            await pinned.shutdown();
          } finally {
            try {
              await retirePublicationFixture(
                resumed?.service ?? context.service,
                endpoint.id,
              );
            } finally {
              globalThis.fetch = originalFetch;
            }
          }
        },
      };
    }

    it("records an authenticated denial before its recipient-bound send and deduplicates the exact callback", async () => {
      const context = await nativePrivateFixture();
      try {
        expect((await context.deliver()).status).toBe(200);
        expect(
          context.providerRequests.filter(
            (request) => request.method === "sendMessage",
          ),
        ).toHaveLength(0);
        const [delivery] = await context.deliveries();
        const [effect] = await context.actions();
        expect(delivery).toMatchObject({
          state: "filtered",
          normalizedEvent: {
            telegramCallback: {
              callbackId: "native-private-callback-1",
              receiverUserId: "456",
            },
          },
        });
        expect(effect).toMatchObject({
          status: "received",
          payload: {
            effect: "telegram_callback_notice",
            settleDelivery: false,
          },
        });
        expect(context.scheduled).toHaveLength(1);
        context.scheduled.shift()!();
        await expect
          .poll(async () => (await context.actions())[0]?.status)
          .toBe("processed");
        expect(await context.actions()).toEqual([
          expect.objectContaining({
            status: "processed",
            result: expect.objectContaining({
              code: "telegram_ephemeral_api_accepted",
            }),
          }),
        ]);
        expect(
          context.providerRequests.filter(
            (request) => request.method === "sendMessage",
          ),
        ).toEqual([
          {
            method: "sendMessage",
            body: {
              chat_id: "-100123",
              text: "This Paperclip action is no longer available. Open the linked task or ask an operator to link this account.",
              ephemeral_message_parameters: {
                receiver_user_id: 456,
                callback_query_id: "native-private-callback-1",
              },
            },
          },
        ]);
        const after = await context.actions();
        expect((await context.deliver()).status).toBe(200);
        expect(await context.deliveries()).toEqual([delivery]);
        expect(await context.actions()).toEqual(after);
        expect(context.scheduled).toHaveLength(0);
        expect(
          context.runtime.endpoints.get(context.endpoint.id)!.posts,
        ).toHaveLength(0);
        expect(context.wakeup).not.toHaveBeenCalled();
        expect(
          await readChatPublicationsByEndpointId(context.endpoint.id),
        ).toEqual([]);
      } finally {
        await context.close();
      }
    });

    it.each(["actor", "chat", "data"])(
      "does not rebind a retained callback denial to another %s",
      async (changed) => {
        const context = await nativePrivateFixture();
        try {
          expect((await context.deliver()).status).toBe(200);
          const before = await context.deliveries();
          const effects = await context.actions();
          const update = context.payload();
          if (changed === "actor") update.callback_query.from.id = 457;
          if (changed === "chat")
            update.callback_query.message.chat.id = -100124;
          if (changed === "data") update.callback_query.data = "pcq:other";
          expect((await context.deliver(update)).status).toBe(200);
          expect(await context.deliveries()).toEqual(before);
          expect(await context.actions()).toEqual(effects);
          expect(context.scheduled).toHaveLength(1);
          await context.service.processPendingProviderEffects();
          expect((await context.actions())[0]).toMatchObject({
            status: "processed",
          });
          expect(
            context.providerRequests.filter(
              (entry) => entry.method === "sendMessage",
            ),
          ).toEqual([
            expect.objectContaining({
              body: expect.objectContaining({
                chat_id: "-100123",
                ephemeral_message_parameters: {
                  receiver_user_id: 456,
                  callback_query_id: "native-private-callback-1",
                },
              }),
            }),
          ]);
        } finally {
          await context.close();
        }
      },
    );

    it.each(["expired", "reach", "actor", "generation", "credentials"])(
      "cancels a queued private callback notice after %s changes without public fallback",
      async (change) => {
        const context = await nativePrivateFixture(true);
        let clock: ReturnType<typeof vi.spyOn> | undefined;
        try {
          expect((await context.deliver()).status).toBe(200);
          const [before] = await context.actions();
          expect(before.status).toBe("received");
          if (change === "expired") {
            const receipt = before.payload.telegramCallback as {
              deadlineAtMs: number;
            };
            clock = vi.spyOn(Date, "now").mockReturnValue(receipt.deadlineAtMs);
            expect((await context.deliver()).status).toBe(200);
            expect((await context.actions())[0].payload).toEqual(
              before.payload,
            );
          } else if (change === "reach") {
            await db
              .update(chatEndpointResources)
              .set({ enabled: false })
              .where(eq(chatEndpointResources.endpointId, context.endpoint.id));
          } else if (change === "actor") {
            await context.service.revokeLink(
              context.endpoint.id,
              before.principalId!,
            );
          } else if (change === "generation") {
            const [endpoint] = await readChatEndpointsById(context.endpoint.id);
            await db
              .update(chatEndpoints)
              .set({
                setup: {
                  ...endpoint.setup,
                  runtimeGeneration:
                    Number((endpoint.setup as InternalSetupState).runtimeGeneration) + 1,
                } as InternalSetupState,
              })
              .where(eq(chatEndpoints.id, context.endpoint.id));
          } else {
            await db
              .update(toolConnections)
              .set({ credentialSecretRefs: [] })
              .where(eq(toolConnections.id, context.endpoint.connectionId));
          }
          await context.service.processPendingProviderEffects();
          expect((await context.actions())[0]).toMatchObject({
            status: "cancelled",
            result: { code: "provider_effect_no_longer_authorized" },
          });
          expect(
            context.providerRequests.filter(
              (entry) => entry.method === "sendMessage",
            ),
          ).toHaveLength(0);
          expect(
            context.runtime.endpoints.get(context.endpoint.id)?.posts ?? [],
          ).toHaveLength(0);
          expect(context.wakeup).not.toHaveBeenCalled();
        } finally {
          clock?.mockRestore();
          await context.close();
        }
      },
    );

    it.each([false, true])(
      "retains the original private callback deadline across restart (expired=%s)",
      async (expired) => {
        const context = await nativePrivateFixture();
        let clock: ReturnType<typeof vi.spyOn> | undefined;
        try {
          expect((await context.deliver()).status).toBe(200);
          const [before] = await context.actions();
          const receipt = before.payload.telegramCallback as {
            deadlineAtMs: number;
          };
          const resumed = await context.restart();
          if (expired)
            clock = vi.spyOn(Date, "now").mockReturnValue(receipt.deadlineAtMs);
          await resumed.service.processPendingProviderEffects();
          expect((await context.actions())[0]).toMatchObject({
            status: expired ? "cancelled" : "processed",
            payload: before.payload,
          });
          expect(
            context.providerRequests.filter(
              (entry) => entry.method === "sendMessage",
            ),
          ).toHaveLength(expired ? 0 : 1);
          expect(resumed.wakeup).not.toHaveBeenCalled();
        } finally {
          clock?.mockRestore();
          await context.close();
        }
      },
    );

    it("quarantines missing private acceptance receipts and never retries them publicly", async () => {
      const context = await nativePrivateFixture();
      try {
        context.setResponseMode("missing_receipt");
        expect((await context.deliver()).status).toBe(200);
        await context.service.processPendingProviderEffects();
        expect((await context.actions())[0]).toMatchObject({
          status: "delivery_unknown",
        });
        await context.service.processPendingProviderEffects();
        expect((await context.deliver()).status).toBe(200);
        expect(
          context.providerRequests.filter(
            (entry) => entry.method === "sendMessage",
          ),
        ).toHaveLength(1);
        expect(
          context.runtime.endpoints.get(context.endpoint.id)!.posts,
        ).toHaveLength(0);
      } finally {
        await context.close();
      }
    });

    it("preserves an authenticated exact-actor DM denial without native ephemeral or public fallback", async () => {
      const context = await nativePrivateFixture(false, true);
      try {
        expect((await context.deliver()).status).toBe(200);
        expect(await context.actions()).toHaveLength(1);
        await context.service.processPendingProviderEffects();
        expect((await context.actions())[0]).toMatchObject({
          status: "processed",
          result: { code: "telegram_private_api_accepted" },
        });
        expect(
          context.providerRequests.filter(
            (entry) => entry.method === "sendMessage",
          ),
        ).toEqual([
          {
            method: "sendMessage",
            body: {
              chat_id: "456",
              text: "This Paperclip action is no longer available. Open the linked task or ask an operator to link this account.",
            },
          },
        ]);
        expect(
          context.runtime.endpoints.get(context.endpoint.id)!.posts,
        ).toHaveLength(0);
      } finally {
        await context.close();
      }
    });

    it("does not treat another actor's private chat as a reply destination", async () => {
      const context = await nativePrivateFixture(false, true);
      try {
        expect(
          (await context.deliver(context.payload("dm-cross-actor", 457)))
            .status,
        ).toBe(200);
        expect(await context.actions()).toEqual([]);
        expect(await context.deliveries()).toEqual([
          expect.objectContaining({ state: "filtered" }),
        ]);
        expect(
          context.providerRequests.filter(
            (entry) => entry.method === "sendMessage",
          ),
        ).toHaveLength(0);
      } finally {
        await context.close();
      }
    });

    it("does not refresh the callback deadline after service runtime-readiness waits", async () => {
      const context = await nativePrivateFixture();
      const enteredAt = Date.now();
      let now = enteredAt;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      const get = context.runtime.get.bind(context.runtime);
      const readiness = vi
        .spyOn(context.runtime, "get")
        .mockImplementation((endpointId) => {
          now = enteredAt + 16_000;
          return get(endpointId);
        });
      try {
        expect((await context.deliver()).status).toBe(200);
        expect(readiness).toHaveBeenCalled();
        expect((await context.deliveries())[0]).toMatchObject({
          normalizedEvent: {
            telegramCallback: {
              receivedAtMs: enteredAt,
              deadlineAtMs: enteredAt + 15_000,
            },
          },
        });
        expect(await context.actions()).toEqual([]);
        expect(
          context.providerRequests.filter(
            (entry) => entry.method === "sendMessage",
          ),
        ).toHaveLength(0);
      } finally {
        readiness.mockRestore();
        clock.mockRestore();
        await context.close();
      }
    });

    it.each([false, true])(
      "retains an exact-actor DM proof across restart (expired=%s)",
      async (expired) => {
        const context = await nativePrivateFixture(false, true);
        let clock: ReturnType<typeof vi.spyOn> | undefined;
        try {
          expect((await context.deliver()).status).toBe(200);
          const [before] = await context.actions();
          const resumed = await context.restart();
          if (expired)
            clock = vi
              .spyOn(Date, "now")
              .mockReturnValue(
                (before.payload.telegramCallback as { deadlineAtMs: number })
                  .deadlineAtMs,
              );
          await resumed.service.processPendingProviderEffects();
          expect((await context.actions())[0]).toMatchObject({
            status: expired ? "cancelled" : "processed",
            payload: before.payload,
          });
          expect(
            context.providerRequests.filter(
              (entry) => entry.method === "sendMessage",
            ),
          ).toHaveLength(expired ? 0 : 1);
        } finally {
          clock?.mockRestore();
          await context.close();
        }
      },
    );
  });

  it("coalesces Telegram status and final output into one run-scoped provider message", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredTelegramEndpoint(fixture);
    if (!callbacks.onSlashCommand) {
      throw new Error("Telegram slash command callback was not registered");
    }
    const chatId = "77118899";
    const thread = makeThread({
      channelId: chatId,
      id: `telegram:${chatId}`,
      isDM: true,
      name: "Telegram status ordering",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: thread.thread,
      message: makeMessage({
        id: `${chatId}:901`,
        raw: { message_id: 901 },
        text: "Return one delayed answer",
        userId: chatId,
      }),
      trigger: "direct_message",
    });
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    await db
      .update(issues)
      .set({ status: "in_progress", updatedAt: new Date() })
      .where(eq(issues.id, conversation.issueId));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: fixture.companyId,
      agentId: fixture.assignedAgentId,
      status: "running",
      contextSnapshot: await chatWakeContext({
        endpointId: endpoint.id,
        issueId: conversation.issueId,
        provider: "telegram",
        providerMessageId: `${chatId}:901`,
      }),
    });
    await db.insert(chatPublications).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      conversationId: conversation.id,
      issueId: conversation.issueId,
      idempotencyKey: `run:${runId}:working:${endpoint.id}`,
      payload: { text: "Maya is working…", progressState: "working" },
      state: "pending",
    });
    await service.processPendingPublications();

    await callbacks.onSlashCommand({
      endpointId: endpoint.id,
      provider: "telegram",
      event: {
        channel: {
          id: thread.thread.id,
          name: "Telegram status ordering",
          isDM: true,
          post: vi.fn(),
        } as never,
        command: "/status",
        text: "",
        user: {
          userId: chatId,
          userName: "telegram-status-user",
          fullName: "Telegram Status User",
          isBot: false,
          isMe: false,
          isSystem: false,
        },
        raw: {
          message_id: 902,
          date: Math.floor(Date.now() / 1_000),
          chat: { id: Number(chatId), type: "private" },
          from: { id: Number(chatId), is_bot: false },
          text: "/status",
          entities: [{ offset: 0, length: 7, type: "bot_command" }],
        },
        adapter: {} as never,
        openModal: async () => undefined,
      },
    });
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    expect(providerRuntime?.posts.map((post) => post.text)).toEqual([
      "Maya is working…",
    ]);
    const statusPublication = (
      await readChatPublicationsByEndpointId(endpoint.id)
    ).find((publication) =>
      publication.idempotencyKey.startsWith("control:status:"),
    );
    expect(statusPublication).toMatchObject({
      conversationId: conversation.id,
      state: "pending",
      payload: { text: expect.stringMatching(/— in_progress$/) },
    });

    // Sample again at send time so a status waiting behind an older provider
    // operation cannot report a state Paperclip has already left.
    await db
      .update(issues)
      .set({ status: "done", completedAt: new Date(), updatedAt: new Date() })
      .where(eq(issues.id, conversation.issueId));
    await service.processPendingPublications();
    expect(providerRuntime?.posts.map((post) => post.text)).toEqual([
      "Maya is working…",
    ]);
    expect(providerRuntime?.edits).toEqual([
      {
        threadId: thread.thread.id,
        messageId: "outbound-1",
        text: expect.stringMatching(/— done$/),
      },
    ]);

    await addSelectedChatFinal({
      agentId: fixture.assignedAgentId,
      body: "telegram-status-race-final",
      companyId: fixture.companyId,
      issueId: conversation.issueId,
      runId,
    });
    await service.processPendingPublications();

    // Both updates own the run's existing provider message. Applying the edit
    // log yields one terminal message with no stale working/status sibling.
    expect(providerRuntime?.posts.map((post) => post.text)).toEqual([
      "Maya is working…",
    ]);
    expect(providerRuntime?.edits).toEqual([
      {
        threadId: thread.thread.id,
        messageId: "outbound-1",
        text: expect.stringMatching(/— done$/),
      },
      {
        threadId: thread.thread.id,
        messageId: "outbound-1",
        text: "telegram-status-race-final",
      },
    ]);
    const renderedTelegramMessages = new Map(
      providerRuntime!.posts.map((post, index) => [
        `outbound-${index + 1}`,
        post.text,
      ]),
    );
    for (const edit of providerRuntime!.edits)
      renderedTelegramMessages.set(edit.messageId, edit.text);
    expect([...renderedTelegramMessages.values()]).toEqual([
      "telegram-status-race-final",
    ]);
    const publishedStatus = await readChatPublicationsById(statusPublication!.id)
      .then((rows) => rows[0]);
    expect(publishedStatus).toMatchObject({
      state: "published",
      payload: { text: expect.stringMatching(/— done$/) },
      providerMessageId: "outbound-1",
    });
    await service.shutdown();
  });

  it("publishes the old final before /new and suppresses later output from the completed generation", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredTelegramEndpoint(fixture);
    if (!callbacks.onSlashCommand) {
      throw new Error("Telegram slash command callback was not registered");
    }
    const chatId = "77118898";
    const thread = makeThread({
      channelId: chatId,
      id: `telegram:${chatId}`,
      isDM: true,
      name: "Telegram generation ordering",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: thread.thread,
      message: makeMessage({
        id: `${chatId}:910`,
        raw: { message_id: 910, date: 1_788_622_910 },
        text: "Finish the old generation before starting another",
        userId: chatId,
      }),
      trigger: "direct_message",
    });
    await qualifySetupRoundTrip(service, endpoint.id, chatId);
    await service.test(endpoint.id);
    const [oldConversation] = await service.listConversations(endpoint.id);
    const oldRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: oldRunId,
      companyId: fixture.companyId,
      agentId: fixture.assignedAgentId,
      status: "succeeded",
      contextSnapshot: await chatWakeContext({
        endpointId: endpoint.id,
        issueId: oldConversation.issueId,
        provider: "telegram",
        providerMessageId: `${chatId}:910`,
      }),
    });
    await addSelectedChatFinal({
      agentId: fixture.assignedAgentId,
      body: "old-generation-final",
      companyId: fixture.companyId,
      issueId: oldConversation.issueId,
      runId: oldRunId,
    });

    const newEvent = {
      endpointId: endpoint.id,
      provider: "telegram" as const,
      event: {
        channel: {
          id: thread.thread.id,
          name: "Telegram generation ordering",
          isDM: true,
        } as never,
        command: "/new",
        text: "",
        user: {
          userId: chatId,
          userName: "telegram-generation-user",
          fullName: "Telegram Generation User",
          isBot: false,
          isMe: false,
          isSystem: false,
        },
        raw: {
          message_id: 911,
          date: 1_788_622_911,
          chat: { id: Number(chatId), type: "private" },
          from: { id: Number(chatId), is_bot: false },
          text: "/new",
          entities: [{ offset: 0, length: 4, type: "bot_command" }],
        },
        adapter: {} as never,
        openModal: async () => undefined,
      },
    };
    await callbacks.onSlashCommand(newEvent);
    expect(runtime.endpoints.get(endpoint.id)?.posts).toEqual([]);
    await expect(service.listConversations(endpoint.id)).resolves.toEqual([
      expect.objectContaining({ id: oldConversation.id, state: "active" }),
    ]);

    await service.processPendingPublications();
    expect(
      runtime.endpoints.get(endpoint.id)?.posts.map((post) => post.text),
    ).toEqual([
      "old-generation-final",
      "Send your request to start a new Paperclip task.",
    ]);
    await expect(service.listConversations(endpoint.id)).resolves.toEqual([
      expect.objectContaining({ id: oldConversation.id, state: "completed" }),
    ]);

    const lateOldFinal = await issueService(db).addComment(
      oldConversation.issueId,
      "late-old-generation-final-stays-in-paperclip",
      { agentId: fixture.assignedAgentId, runId: oldRunId },
      { authorType: "agent", authorizationReason: "paperclip_runner_protocol" },
    );
    await expect(
      db
        .select({ id: chatPublications.id })
        .from(chatPublications)
        .where(eq(chatPublications.commentId, lateOldFinal.id)),
    ).resolves.toEqual([]);

    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: thread.thread,
      message: makeMessage({
        id: `${chatId}:912`,
        raw: { message_id: 912, date: 1_788_622_912 },
        text: "Start the new generation",
        userId: chatId,
      }),
      trigger: "direct_message",
    });
    const conversations = await service.listConversations(endpoint.id);
    const newConversation = conversations.find(
      (conversation) => conversation.id !== oldConversation.id,
    );
    if (!newConversation) throw new Error("Expected a new chat generation");
    expect(newConversation.sessionGeneration).toBe(
      oldConversation.sessionGeneration + 1,
    );
    const newRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: newRunId,
      companyId: fixture.companyId,
      agentId: fixture.assignedAgentId,
      status: "succeeded",
      contextSnapshot: await chatWakeContext({
        endpointId: endpoint.id,
        issueId: newConversation.issueId,
        provider: "telegram",
        providerMessageId: `${chatId}:912`,
      }),
    });
    await addSelectedChatFinal({
      agentId: fixture.assignedAgentId,
      body: "new-generation-final",
      companyId: fixture.companyId,
      issueId: newConversation.issueId,
      runId: newRunId,
    });
    await service.processPendingPublications();

    expect(
      runtime.endpoints.get(endpoint.id)?.posts.map((post) => post.text),
    ).toEqual([
      "old-generation-final",
      "Send your request to start a new Paperclip task.",
      "new-generation-final",
    ]);
    expect(
      await readIssuesByCompanyId(fixture.companyId),
    ).toHaveLength(2);
  });
});
