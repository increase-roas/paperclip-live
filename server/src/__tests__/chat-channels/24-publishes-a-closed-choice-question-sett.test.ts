import { guardSlackFixtureNetwork } from ".././helpers/slack-cloud/transport.js";
import { activityLog, authUsers, chatActions, chatDeliveries, chatEndpoints, chatExternalPrincipals, chatMessageLinks, chatPublications, chatSdkState, companyMemberships, heartbeatRuns, issueQuestionResponseDeliveries, issueThreadInteractions, subscribeDatabaseWork } from "@paperclipai/db";
import { createChatRuntime } from "../../services/chat-runtime.js";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { chatChannelService, type ChatChannelService } from "../../services/chat-channels.js";
import type { InternalSetupState } from "../../services/chat-channels/runtime-types.js";
import { issueService } from "../../services/issues.js";
import { issueThreadInteractionService } from "../../services/issue-thread-interactions.js";
import { enqueueChatRunMilestones, resolveChatRunPresentationAuthorizationReason } from "../../services/chat-run-publications.js";
import { fakeSlackFetch, makeMessage, makeThread, slackProtocolCapture } from ".././helpers/chat-channels-fixture.js";
import { addSelectedChatFinal, configuredSlackEndpoint, db, deliverMessage, describeChatChannelsSuite, fixtureServices, qualifySetupRoundTrip, readChatConversationsByEndpointId, readChatPublicationsByCommentId, readHeartbeatRunsById, receiptBackedWakeup, retirePublicationFixture, seedCompany } from "../helpers/chat-channels-harness.js";









describeChatChannelsSuite("chat channels 24-publishes-a-closed-choice-question-sett", () => {
  it("publishes a closed-choice question, settles its Slack card, and delivers its exact continuation response", async ({ onTestFinished }) => {
    let receiptWakeObserved = false;
    const fixture = await seedCompany();
    const continuationRunId = randomUUID();
    const resolveNativeQuestion = vi.fn(async () => "not_native" as const);
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture, {
        resolveNativeQuestion,
        questionResolutionPersistBarrier: async () => {
          // Receipt commit must wake projection before the separate answer write.
          expect(receiptWakeObserved).toBe(true);
        },
        wakeup: async (agentId, options) => {
          if (options.contextSnapshot?.source !== "issue.interaction.respond") {
            return { accepted: true };
          }
          const [created] = await db
            .insert(heartbeatRuns)
            .values({
              id: continuationRunId,
              companyId: fixture.companyId,
              agentId,
              status: "succeeded",
              contextSnapshot: options.contextSnapshot,
            })
            .onConflictDoNothing()
            .returning();
          return (
            created ??
            readHeartbeatRunsById(continuationRunId)
              .then((rows) => rows[0])
          );
        },
      });
    if (!callbacks.onAction)
      throw new Error("Slack question action callback was not registered");
    const channel = makeThread({
      channelId: "C-QUESTION",
      id: "slack:C-QUESTION:4500.1",
      name: "questions",
    });
    const externalUserId = `U-QUESTION-${randomUUID()}`;
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: channel.thread,
      message: makeMessage({
        id: "4500.1",
        text: "@maya help me choose a priority",
        mentioned: true,
        userId: externalUserId,
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id);
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    const sourceRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId: fixture.companyId,
      agentId: fixture.assignedAgentId,
      status: "succeeded",
      // The prompt itself is the external causal edge. A same-agent internal
      // run may ask in an already-bound task, and its provider answer must
      // return the continuation to that exact published prompt conversation.
      contextSnapshot: {
        issueId: conversation.issueId,
        taskId: conversation.issueId,
        source: "automation",
      },
    });

    const interaction = await issueThreadInteractionService(db).create(
      {
        id: conversation.issueId,
        companyId: fixture.companyId,
      },
      {
        kind: "ask_user_questions",
        continuationPolicy: "wake_assignee",
        sourceRunId,
        title: "Choose the priority",
        payload: {
          version: 1,
          title: "Choose the priority",
          questions: [
            {
              id: "priority",
              prompt: "Which priority should we use?",
              selectionMode: "single",
              required: true,
              // The shared contract defaults omission to a closed question.
              // Native provider buttons must match that canonical shape.
              options: [
                { id: "high", label: "High" },
                { id: "normal", label: "Normal" },
              ],
            },
          ],
        },
      },
      { agentId: fixture.assignedAgentId, runId: sourceRunId },
    );
    await service.processPendingPublications();
    const publication = await db
      .select()
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.endpointId, endpoint.id),
          eq(chatPublications.issueId, conversation.issueId),
        ),
      )
      .then((rows) =>
        rows.find((row) => row.idempotencyKey.startsWith("interaction:")),
      );
    if (!publication?.providerMessageId)
      throw new Error("Question publication was not delivered");
    expect(publication).toMatchObject({
      state: "published",
      payload: {
        interactionId: interaction.id,
        progressState: "waiting_for_input",
        card: {
          kind: "question",
          title: "Which priority should we use?",
        },
      },
    });
    const callbackActions = publication.payload.card?.actions?.filter(
      (action) => action.type === "callback",
    );
    expect(callbackActions).toHaveLength(2);
    const highAction = callbackActions?.find(
      (action) => action.label === "High",
    );
    if (!highAction || highAction.type !== "callback")
      throw new Error("High-priority callback was not projected");

    const linkedUserId = `question-user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({
      id: linkedUserId,
      name: "Question User",
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
    const token = new URL(intent.confirmationUrl).searchParams.get("token");
    if (!token) throw new Error("Question-user identity token was absent");
    await service.confirmIdentityLink(token, linkedUserId);

    const actionEvent = (
      overrides: Partial<{
        actionId: string;
        messageId: string;
        threadId: string;
        userId: string;
        value: string;
      }> = {},
    ) => ({
      endpointId: endpoint.id,
      provider: "slack" as const,
      event: {
        actionId: overrides.actionId ?? highAction.actionId,
        adapter: {} as never,
        messageId: overrides.messageId ?? publication.providerMessageId!,
        openModal: async () => undefined,
        raw: { type: "block_actions" },
        thread: channel.thread,
        // The pinned Slack adapter uses the clicked Block Kit message ts here,
        // even though the authoritative Paperclip conversation is rooted at
        // the original mention (and a DM root has no ts at all).
        threadId:
          overrides.threadId ??
          `slack:C-QUESTION:${publication.providerMessageId}`,
        user: {
          userId: overrides.userId ?? externalUserId,
          userName: "question-user",
          fullName: "Question User",
          isBot: false,
          isMe: false,
          isSystem: false,
        },
        value: overrides.value ?? interaction.id,
      },
    });

    const unlinkedAction = actionEvent({
      userId: `U-UNLINKED-${randomUUID()}`,
    });
    await callbacks.onAction(unlinkedAction);
    await callbacks.onAction(unlinkedAction);
    await vi.waitFor(() =>
      expect(channel.postEphemeral).toHaveBeenCalledTimes(1),
    );
    expect(channel.postEphemeral).toHaveBeenCalledWith(
      unlinkedAction.event.user.userId,
      "This action is no longer available. Open the linked Paperclip task or ask an operator to link this account.",
      { fallbackToDM: false },
    );
    const deniedSlackActions = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(chatDeliveries.eventKind, "action"),
        ),
      );
    expect(deniedSlackActions).toEqual([
      expect.objectContaining({
        conversationId: null,
        principalId: expect.any(String),
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
    expect(JSON.stringify(deniedSlackActions[0])).not.toContain(
      highAction.actionId,
    );
    expect(JSON.stringify(deniedSlackActions[0])).not.toContain(interaction.id);
    expect(await service.listActivity(endpoint.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: deniedSlackActions[0]!.id,
          kind: "delivery",
          status: "filtered",
          summary: "action ignored",
          detail: "External action denied by Paperclip authorization",
          replayable: false,
        }),
      ]),
    );
    channel.postEphemeral.mockRejectedValueOnce(
      Object.assign(new Error("injected Slack ephemeral failure"), {
        name: "ValidationError",
      }),
    );
    await callbacks.onAction(
      actionEvent({ userId: `U-UNLINKED-FALLBACK-${randomUUID()}` }),
    );
    await vi.waitFor(() =>
      expect(channel.post).toHaveBeenCalledWith(
        "This Paperclip action is no longer available.",
      ),
    );
    expect(channel.postEphemeral).toHaveBeenCalledTimes(2);
    await db
      .update(companyMemberships)
      .set({ membershipRole: "viewer" })
      .where(
        and(
          eq(companyMemberships.companyId, fixture.companyId),
          eq(companyMemberships.principalId, linkedUserId),
        ),
      );
    await callbacks.onAction(actionEvent({ actionId: "pcq:viewer-forbidden" }));
    await db
      .update(companyMemberships)
      .set({ membershipRole: "operator" })
      .where(
        and(
          eq(companyMemberships.companyId, fixture.companyId),
          eq(companyMemberships.principalId, linkedUserId),
        ),
      );

    const otherChannel = makeThread({
      channelId: "C-QUESTION-OTHER",
      id: "slack:C-QUESTION-OTHER:4501.1",
      name: "other-question",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: otherChannel.thread,
      message: makeMessage({
        id: "4501.1",
        text: "@maya a separate task",
        mentioned: true,
        userId: externalUserId,
      }),
      trigger: "mention",
    });
    await callbacks.onAction(actionEvent({ threadId: otherChannel.thread.id }));
    await callbacks.onAction(actionEvent({ messageId: "outbound-forged" }));
    await callbacks.onAction(actionEvent({ actionId: "pcq:forged" }));
    await callbacks.onAction(
      actionEvent({
        threadId: `slack:C-QUESTION:${publication.providerMessageId}-forged-value`,
        value: randomUUID(),
      }),
    );

    // Model the provider accepting the interactive card while Paperclip loses
    // the response before it can persist the provider message binding. The
    // signed callback and opaque issued token must reconcile that ambiguity
    // without requiring a duplicate send or disabling the real button.
    await db
      .delete(chatMessageLinks)
      .where(eq(chatMessageLinks.publicationId, publication.id));
    await db
      .update(chatPublications)
      .set({ state: "delivery_unknown", providerMessageId: null })
      .where(eq(chatPublications.id, publication.id));

    const unsubscribeReceipt = subscribeDatabaseWork(db, "chat-run-milestones", (event, hints) => {
      if (event === "settled" && hints?.has(JSON.stringify({ companyId: fixture.companyId, issueId: conversation.issueId }))) {
        receiptWakeObserved = true;
      }
    });
    onTestFinished(unsubscribeReceipt);
    const providerAcknowledgement = Promise.resolve(callbacks.onAction(actionEvent()));
    await expect(
      Promise.race([
        providerAcknowledgement.then(() => "acknowledged" as const),
        new Promise<"timed_out">((resolve) =>
          setTimeout(() => resolve("timed_out"), 250),
        ),
      ]),
    ).resolves.toBe("acknowledged");
    await providerAcknowledgement;
    expect(resolveNativeQuestion).not.toHaveBeenCalled();
    await expect(
      db
        .select({
          providerMessageId: chatPublications.providerMessageId,
          state: chatPublications.state,
        })
        .from(chatPublications)
        .where(eq(chatPublications.id, publication.id)),
    ).resolves.toEqual([
      {
        providerMessageId: publication.providerMessageId,
        state: "published",
      },
    ]);
    await service.processPendingPublications();
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
        text: "Answered: High.",
        card: {
          kind: "question",
          title: "Which priority should we use?",
          body: "Answered: High.",
        },
      },
    });
    expect(resolutionPublication?.payload.card?.actions ?? []).toHaveLength(0);
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    expect(providerRuntime?.edits).toHaveLength(1);
    expect(providerRuntime?.edits[0]).toMatchObject({
      messageId: publication.providerMessageId,
    });
    expect(providerRuntime?.edits[0]?.text).toContain("Answered: High.");
    expect(providerRuntime?.edits[0]?.text).not.toContain(highAction.actionId);
    expect(channel.postEphemeral).not.toHaveBeenCalledWith(
      externalUserId,
      "Answered: High.",
      {
        fallbackToDM: false,
      },
    );
    const providerEffectsBeforeExactRedelivery = await db
      .select({ id: chatActions.id })
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.kind, "provider_effect"),
        ),
      );
    expect(providerEffectsBeforeExactRedelivery.length).toBeGreaterThan(0);
    // Action callbacks acknowledge after the denial and its provider effect are
    // durable, while the actual ephemeral send runs asynchronously. Drain those
    // already-staged notices before using the transport call count to prove that
    // the exact redelivery below does not send another notice.
    await vi.waitFor(async () => {
      const providerEffects = await db
        .select({ status: chatActions.status })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(chatActions.kind, "provider_effect"),
          ),
        );
      expect(providerEffects).toHaveLength(
        providerEffectsBeforeExactRedelivery.length,
      );
      expect(
        providerEffects.every(({ status }) => status === "processed"),
      ).toBe(true);
    });
    const ephemeralCountBeforeExactRedelivery =
      channel.postEphemeral.mock.calls.length;
    const nativeResolutionCountBeforeExactRedelivery =
      resolveNativeQuestion.mock.calls.length;
    await callbacks.onAction(actionEvent());
    expect(channel.postEphemeral).toHaveBeenCalledTimes(
      ephemeralCountBeforeExactRedelivery,
    );
    expect(resolveNativeQuestion).toHaveBeenCalledTimes(
      nativeResolutionCountBeforeExactRedelivery,
    );
    await expect(
      db
        .select({ id: chatActions.id })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(chatActions.kind, "provider_effect"),
          ),
        ),
    ).resolves.toHaveLength(providerEffectsBeforeExactRedelivery.length);
    const [storedInteraction] = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, interaction.id));
    expect(storedInteraction).toMatchObject({
      status: "answered",
      resolvedByUserId: linkedUserId,
      result: {
        version: 1,
        answers: [{ questionId: "priority", optionIds: ["high"] }],
      },
    });
    expect(
      await db
        .select()
        .from(issueQuestionResponseDeliveries)
        .where(
          eq(issueQuestionResponseDeliveries.interactionId, interaction.id),
        ),
    ).toHaveLength(1);
    const actions = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.kind, "question_answer"),
        ),
      );
    expect(actions).toHaveLength(2);
    expect(
      actions.find((action) => action.status === "processed"),
    ).toMatchObject({
      status: "processed",
      kind: "question_answer",
      payload: {
        publicationId: publication.id,
        interactionId: interaction.id,
        questionId: "priority",
        optionId: "high",
      },
    });
    expect(actions.find((action) => action.status === "expired")).toMatchObject(
      {
        kind: "question_answer",
        result: { code: "interaction_resolved_by_sibling_action" },
      },
    );
    const answeredActivity = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, fixture.companyId),
          eq(activityLog.action, "issue.thread_interaction_answered"),
          eq(activityLog.entityId, conversation.issueId),
        ),
      );
    expect(answeredActivity).toHaveLength(1);
    expect(answeredActivity[0]).toMatchObject({
      actorType: "user",
      actorId: linkedUserId,
      details: {
        source: "external_chat",
        endpointId: endpoint.id,
        publicationId: publication.id,
        interactionId: interaction.id,
      },
    });

    const continuationPresentationAuthorization =
      await resolveChatRunPresentationAuthorizationReason(db, {
        companyId: fixture.companyId,
        issueId: conversation.issueId,
        runId: continuationRunId,
      });
    expect(continuationPresentationAuthorization).toBe(
      "allow_chat_run_presentation",
    );
    const continuationComment = await issueService(db).addComment(
      conversation.issueId,
      "SLACK-COLOR-High",
      { agentId: fixture.assignedAgentId, runId: continuationRunId },
      {
        authorType: "agent",
        // Heartbeat's final-presentation resolver uses this narrow reason for
        // a continuation run that resolves back to this published prompt.
        authorizationReason: continuationPresentationAuthorization,
      },
    );
    await service.processPendingPublications();
    await expect(
      readChatPublicationsByCommentId(continuationComment.id),
    ).resolves.toEqual([
      expect.objectContaining({
        conversationId: conversation.id,
        endpointId: endpoint.id,
        state: "published",
      }),
    ]);
    expect(runtime.endpoints.get(endpoint.id)?.posts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          threadId: channel.thread.id,
          text: "SLACK-COLOR-High",
        }),
      ]),
    );
    await db
      .update(heartbeatRuns)
      .set({
        resultJson: {
          presentationDecision: {
            chosenSource: "final_agent_message",
            commentAction: "create",
            commentId: continuationComment.id,
          },
        },
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, continuationRunId));
    await expect(enqueueChatRunMilestones(db)).resolves.toBe(0);
    await expect(
      db
        .select()
        .from(chatPublications)
        .where(
          like(
            chatPublications.idempotencyKey,
            `run:${continuationRunId}:completed:%`,
          ),
        ),
    ).resolves.toHaveLength(0);
    const unrelatedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: unrelatedRunId,
      companyId: fixture.companyId,
      agentId: fixture.assignedAgentId,
      status: "succeeded",
      contextSnapshot: {
        issueId: conversation.issueId,
        taskId: conversation.issueId,
        interactionId: interaction.id,
        sourceRunId,
        source: "issue.interaction.respond",
      },
    });
    await expect(
      resolveChatRunPresentationAuthorizationReason(db, {
        companyId: fixture.companyId,
        issueId: conversation.issueId,
        runId: unrelatedRunId,
      }),
    ).resolves.toBe("internal_agent_write");
    const unrelatedComment = await issueService(db).addComment(
      conversation.issueId,
      "This unrelated run must remain internal",
      { agentId: fixture.assignedAgentId, runId: unrelatedRunId },
      {
        authorType: "agent",
        authorizationReason: "paperclip_runner_protocol",
      },
    );
    await expect(
      readChatPublicationsByCommentId(unrelatedComment.id),
    ).resolves.toHaveLength(0);

    await db
      .update(issueQuestionResponseDeliveries)
      .set({ status: "delivering", targetRunId: null })
      .where(eq(issueQuestionResponseDeliveries.interactionId, interaction.id));
    const inFlightNativeComment = await issueService(db).addComment(
      conversation.issueId,
      "SLACK-NATIVE-IN-FLIGHT-COLOR-High",
      { agentId: fixture.assignedAgentId, runId: sourceRunId },
      {
        authorType: "agent",
        authorizationReason: "paperclip_runner_protocol",
      },
    );
    await expect(
      readChatPublicationsByCommentId(inFlightNativeComment.id),
    ).resolves.toHaveLength(0);

    await db
      .update(issueQuestionResponseDeliveries)
      .set({ status: "delivered", targetRunId: sourceRunId })
      .where(eq(issueQuestionResponseDeliveries.interactionId, interaction.id));
    const resumedSourceComment = await issueService(db).addComment(
      conversation.issueId,
      "SLACK-RESUMED-SOURCE-COLOR-High",
      { agentId: fixture.assignedAgentId, runId: sourceRunId },
      {
        authorType: "agent",
        authorizationReason: "paperclip_runner_protocol",
      },
    );
    await expect(
      readChatPublicationsByCommentId(resumedSourceComment.id),
    ).resolves.toHaveLength(0);

    const steeredRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: steeredRunId,
      companyId: fixture.companyId,
      agentId: fixture.assignedAgentId,
      status: "succeeded",
      // Direct question-response steering may target an already-running run
      // whose snapshot belongs to another chat turn. The durable delivery
      // receipt below must take precedence over this unrelated chat context.
      contextSnapshot: {
        issueId: conversation.issueId,
        taskId: conversation.issueId,
        endpointId: randomUUID(),
        source: "chat:telegram",
      },
    });
    await db
      .update(issueQuestionResponseDeliveries)
      .set({ status: "delivered", targetRunId: steeredRunId })
      .where(eq(issueQuestionResponseDeliveries.interactionId, interaction.id));
    const steeredComment = await addSelectedChatFinal({
      agentId: fixture.assignedAgentId,
      body: "SLACK-STEERED-COLOR-High",
      companyId: fixture.companyId,
      issueId: conversation.issueId,
      runId: steeredRunId,
    });
    await expect(
      readChatPublicationsByCommentId(steeredComment.id),
    ).resolves.toEqual([
      expect.objectContaining({
        conversationId: conversation.id,
        endpointId: endpoint.id,
      }),
    ]);

    const reassignedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: reassignedRunId,
      companyId: fixture.companyId,
      agentId: fixture.replacementAgentId,
      status: "succeeded",
      contextSnapshot: {
        issueId: conversation.issueId,
        taskId: conversation.issueId,
        interactionId: interaction.id,
        sourceRunId,
        source: "issue.interaction.respond",
      },
    });
    await db
      .update(issueQuestionResponseDeliveries)
      .set({ status: "delivered", targetRunId: reassignedRunId })
      .where(eq(issueQuestionResponseDeliveries.interactionId, interaction.id));
    const reassignedComment = await issueService(db).addComment(
      conversation.issueId,
      "A reassigned agent must not speak through Maya's Slack identity",
      { agentId: fixture.replacementAgentId, runId: reassignedRunId },
      {
        authorType: "agent",
        authorizationReason: "paperclip_runner_protocol",
      },
    );
    await expect(
      readChatPublicationsByCommentId(reassignedComment.id),
    ).resolves.toHaveLength(0);

    const staleNoticeCount = channel.postEphemeral.mock.calls.filter(
      ([userId, text]) =>
        userId === externalUserId &&
        text ===
          "This action is no longer available. Open the linked Paperclip task or ask an operator to link this account.",
    ).length;
    await callbacks.onAction(actionEvent());
    expect(
      channel.postEphemeral.mock.calls.filter(
        ([userId, text]) =>
          userId === externalUserId &&
          text ===
            "This action is no longer available. Open the linked Paperclip task or ask an operator to link this account.",
      ),
    ).toHaveLength(staleNoticeCount);
    expect(
      await db
        .select()
        .from(issueQuestionResponseDeliveries)
        .where(
          eq(issueQuestionResponseDeliveries.interactionId, interaction.id),
        ),
    ).toHaveLength(1);

    await db
      .update(chatPublications)
      .set({ state: "delivery_unknown" })
      .where(eq(chatPublications.id, resolutionPublication.id));
    await service.resolvePublication(
      endpoint.id,
      resolutionPublication.id,
      "retry_anyway",
      linkedUserId,
    );
    await expect(
      db
        .select({ state: chatPublications.state })
        .from(chatPublications)
        .where(eq(chatPublications.id, resolutionPublication.id)),
    ).resolves.toEqual([{ state: "published" }]);

    await db
      .update(chatPublications)
      .set({ state: "delivery_unknown", providerMessageId: null })
      .where(eq(chatPublications.id, publication.id));
    await expect(
      service.resolvePublication(
        endpoint.id,
        publication.id,
        "retry_anyway",
        linkedUserId,
      ),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        code: "chat_terminal_interaction_publication_not_replayable",
      },
    });
    await service.shutdown();
  });

  it.each(slackProtocolCapture ? ["warm", "command-delayed", "action-delayed", "submission-delayed"] as const : ["warm"] as const)("captures signed Slack forwarding protocol with registered owners (%s)", async mode => {
    const network = guardSlackFixtureNetwork({ requirePreload: slackProtocolCapture });
    let configured: Awaited<ReturnType<typeof configuredSlackEndpoint>> | undefined;
    let routedService: ChatChannelService | undefined;
    let actualRuntime: ReturnType<typeof createChatRuntime> | undefined;
    let failure: { error: unknown } | undefined;
    try {
      const fixture = await seedCompany();
      configured = await configuredSlackEndpoint(fixture);
      const { callbacks, endpoint, runtime, service, wakeup } = configured;
      actualRuntime = createChatRuntime();
      const custody: Array<{ lane: string; elapsedMs: number; acknowledgedWithin3s: boolean; originalTimestamp: string | null }> = [];
      const protocol: Array<{ method: string; triggerAgeMs?: number; outcome: string }> = [];
      let triggerCreatedAt = 0;
      const channelId = "C-SIGNED-MODAL";
      const threadTs = "1788.100";
      const externalUserId = `U-MODAL-${randomUUID()}`;
      const channel = makeThread({
        channelId,
        id: `slack:${channelId}:${threadTs}`,
        name: "signed-modal",
      });
      // Existing fixture helpers establish the endpoint, conversation and
      // published question. From block_actions onward, signed envelopes pass
      // through the real adapter/SDK/runtime and unmocked service callbacks.
      // Provider HTTP and the scheduler remain deterministic test boundaries.
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        thread: channel.thread,
        message: makeMessage({
          id: threadTs,
          text: "@maya collect deployment details",
          mentioned: true,
          userId: externalUserId,
        }),
        trigger: "mention",
      });
      await qualifySetupRoundTrip(service, endpoint.id, externalUserId);
      await service.test(endpoint.id);
      const [conversation] = await service.listConversations(endpoint.id);
      if (!conversation) throw new Error("Expected signed modal conversation");
      const [principal] = await db
        .select()
        .from(chatExternalPrincipals)
        .where(
          and(
            eq(chatExternalPrincipals.companyId, fixture.companyId),
            eq(chatExternalPrincipals.provider, "slack"),
            eq(chatExternalPrincipals.externalId, externalUserId),
          ),
        );
      const linkedUserId = `signed-modal-user-${randomUUID()}`;
      const now = new Date();
      await db.insert(authUsers).values({
        id: linkedUserId,
        name: "Modal Operator",
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
        principal.id,
        1_800,
      );
      const identityToken = new URL(intent.confirmationUrl).searchParams.get(
        "token",
      );
      if (!identityToken) throw new Error("Expected modal identity token");
      await service.confirmIdentityLink(identityToken, linkedUserId);
      const interaction = await issueThreadInteractionService(db).create(
        { id: conversation.issueId, companyId: fixture.companyId },
        {
          kind: "ask_user_questions",
          continuationPolicy: "wake_assignee",
          title: "Deployment details",
          payload: {
            version: 1,
            title: "Deployment details",
            submitLabel: "Continue",
            questions: [
              {
                id: "environment",
                prompt: "Where should I deploy?",
                selectionMode: "single",
                required: true,
                allowOther: false,
                options: [
                  { id: "staging", label: "Staging" },
                  { id: "production", label: "Production" },
                ],
              },
              {
                id: "reason",
                prompt: "What should the release note say?",
                selectionMode: "single",
                required: true,
                allowOther: true,
                options: [
                  {
                    id: "__paperclip_text__",
                    label: "Type an answer",
                    freeText: true,
                  },
                ],
              },
            ],
          },
        },
        { agentId: fixture.assignedAgentId },
      );
      runtime.endpoints.get(endpoint.id)!.postResultIds.push("1788.200");
      await service.processPendingPublications();
      const publication = await db
        .select()
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.endpointId, endpoint.id),
            eq(chatPublications.conversationId, conversation.id),
          ),
        )
        .then((rows) =>
          rows.find((row) => row.payload.interactionId === interaction.id),
        );
      const openAction = publication?.payload.card?.actions?.find(
        (action) => action.type === "callback",
      );
      if (!publication?.providerMessageId || openAction?.type !== "callback") {
        throw new Error("Expected published question form action");
      }
      const configuration = runtime.configurations.get(endpoint.id)!;
      if (
        configuration.providerConfig.provider !== "slack" ||
        !callbacks.onModalSubmit
      ) {
        throw new Error("Expected Slack provider and service modal callback");
      }
      const credentials = configuration.providerConfig.credentials;
      type SlackView = {
        callback_id: string;
        private_metadata: string;
        blocks: Array<{
          block_id: string;
          element: {
            type: string;
            action_id: string;
            options?: Array<{ text: { text: string }; value: string }>;
          };
        }>;
      };
      const views: SlackView[] = [];
      const exchangedTriggers = new Set<string>();
      const providerMethods: string[] = [];
      const unexpectedProviderMethods: string[] = [];
      const providerErrors: unknown[] = [];
      const providerTransport = vi.fn(async (config: { url: string; baseURL: string; data: string }) => {
        const target = new URL(config.url, config.baseURL);
        expect(target.hostname).toBe("127.0.0.1");
        const params = new URLSearchParams(config.data);
        const method = target.pathname.split("/").at(-1) ?? "";
        providerMethods.push(method);
        let result: unknown;
        if (method === "conversations.replies") {
          result = {
            ok: true,
            messages: [
              {
                type: "message",
                ts: publication.providerMessageId,
                thread_ts: threadTs,
                channel: channelId,
                user: credentials.botUserId,
                text: "Deployment details",
              },
            ],
          };
        } else if (method === "users.info") {
          result = {
            ok: true,
            user: {
              id: params.get("user"),
              name: "maya",
              real_name: "Maya",
              is_bot: true,
              profile: { display_name: "Maya" },
            },
          };
        } else if (method === "conversations.info") {
          result = { ok: true, channel: { id: channelId, name: "signed-modal", is_im: false } };
        } else if (method === "chat.postEphemeral") {
          result = { ok: true, message_ts: "1788.250" };
        } else if (method === "views.open") {
          const triggerAgeMs = Date.now() - triggerCreatedAt;
          const trigger = params.get("trigger_id")!;
          const expired = triggerAgeMs >= 3_000;
          const reused = exchangedTriggers.has(trigger);
          protocol.push({ method, triggerAgeMs, outcome: expired ? "trigger_expired" : reused ? "trigger_exchanged" : "opened" });
          if (expired || reused) result = { ok: false, error: expired ? "trigger_expired" : "trigger_exchanged" };
          else {
            exchangedTriggers.add(trigger);
            views.push(JSON.parse(params.get("view")!) as SlackView);
            result = { ok: true, view: { id: "V-SIGNED-MODAL" } };
          }
        } else {
          unexpectedProviderMethods.push(method);
          result = { ok: false, error: "unexpected_test_provider_method" };
        }
        return { data: result, status: 200, statusText: "OK", headers: {}, config, request: { path: target.pathname } };
      });
      const onSubmit = vi.fn(callbacks.onModalSubmit);
      const onAction = vi.fn(callbacks.onAction);
      const onCommand = vi.fn(callbacks.onSlashCommand);
      const replace = actualRuntime.replaceEndpoint.bind(actualRuntime);
      vi.spyOn(actualRuntime, "replaceEndpoint").mockImplementation(async input => {
        if (input.providerConfig.provider !== "slack") throw new Error("Unexpected fixture provider");
        onSubmit.mockImplementation(input.callbacks.onModalSubmit!);
        onAction.mockImplementation(input.callbacks.onAction!);
        onCommand.mockImplementation(input.callbacks.onSlashCommand!);
        const value = await replace({ ...input, logger: "silent",
          callbacks: { ...input.callbacks, onModalSubmit: onSubmit, onAction, onSlashCommand: onCommand },
          providerConfig: { ...input.providerConfig,
            credentials: { ...input.providerConfig.credentials, apiUrl: "http://127.0.0.1:1/api/" } } });
        const client = (value.getProviderAdapter() as unknown as { _client: {
          axios: { defaults: { adapter: unknown } }; views: { open(options: unknown): Promise<unknown> };
        } })._client;
        const open = client.views.open.bind(client.views);
        client.views.open = async options => {
          try { return await open(options); } catch (error) { providerErrors.push(error); throw error; }
        };
        client.axios.defaults.adapter = providerTransport;
        return value;
      });
      routedService = chatChannelService(db, { runtime: actualRuntime,
        fetch: fakeSlackFetch() as typeof globalThis.fetch,
        heartbeat: { wakeup: receiptBackedWakeup(wakeup) }, publicBaseUrl: "https://paperclip.example" });
      fixtureServices.add(routedService);
      const callbackUrl = `https://paperclip.example/api/chat-webhooks/${endpoint.publicId}/slack`;
      const forward = async (request: Request, lane: string) => {
        const startedAt = Date.now();
        const originalTimestamp = request.headers.get("x-slack-request-timestamp");
        const originalSignature = request.headers.get("x-slack-signature");
        const originalBody = await request.clone().text();
        if (mode === "command-delayed" && lane === "command" || mode === "action-delayed" && lane === "action" || mode === "submission-delayed" && lane === "invalid_submission")
          await new Promise(resolve => setTimeout(resolve, 3_500));
        const response = await routedService!.handleWebhook(endpoint.publicId, "slack", request);
        const elapsedMs = Date.now() - startedAt;
        custody.push({ lane, elapsedMs, acknowledgedWithin3s: elapsedMs < 3_000, originalTimestamp });
        expect(request.headers.get("x-slack-request-timestamp")).toBe(originalTimestamp);
        expect(request.headers.get("x-slack-signature")).toBe(originalSignature);
        expect(originalSignature).toBe(`v0=${createHmac("sha256", credentials.signingSecret!).update(`v0:${originalTimestamp}:${originalBody}`).digest("hex")}`);
        return response;
      };
      const signed = (payload: unknown) => {
        const body = new URLSearchParams({
          payload: JSON.stringify(payload),
        }).toString();
        const timestamp = String(Math.floor(Date.now() / 1_000));
        const signature = createHmac("sha256", credentials.signingSecret!)
          .update(`v0:${timestamp}:${body}`)
          .digest("hex");
        return new Request(callbackUrl, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-slack-request-timestamp": timestamp,
            "x-slack-signature": `v0=${signature}`,
          },
          body,
        });
      };
      const wireUser = {
        id: externalUserId,
        username: "operator",
        name: "Modal Operator",
      };
      const beforeEvidence = ((await db.select({ setup: chatEndpoints.setup }).from(chatEndpoints).where(eq(chatEndpoints.id, endpoint.id)))[0]!.setup as InternalSetupState).slackCallbackSurfaces;
      const invalidAuth = signed({ type: "block_actions", team: { id: "T-PAPERCLIP" }, user: wireUser, actions: [] });
      invalidAuth.headers.set("x-slack-signature", `v0=${"0".repeat(64)}`);
      expect((await routedService.handleWebhook(endpoint.publicId, "slack", invalidAuth)).status).toBe(401);
      expect(onAction).not.toHaveBeenCalled();
      expect(((await db.select({ setup: chatEndpoints.setup }).from(chatEndpoints).where(eq(chatEndpoints.id, endpoint.id)))[0]!.setup as InternalSetupState).slackCallbackSurfaces).toEqual(beforeEvidence);
      const commandBody = new URLSearchParams({ command: endpoint.setup.command!, text: "", user_id: externalUserId,
        user_name: "operator", channel_id: channelId, team_id: "T-PAPERCLIP", trigger_id: "synthetic-command-trigger" }).toString();
      const commandTimestamp = String(Math.floor(Date.now() / 1_000));
      const commandRequest = new Request(callbackUrl, { method: "POST", headers: {
        "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": commandTimestamp,
        "x-slack-signature": `v0=${createHmac("sha256", credentials.signingSecret!).update(`v0:${commandTimestamp}:${commandBody}`).digest("hex")}`,
      }, body: commandBody });
      const commandResponse = await forward(commandRequest, "command");
      expect(commandResponse.status).toBe(200);
      expect(onCommand).toHaveBeenCalledOnce();
      expect(await db.select().from(chatActions).where(and(eq(chatActions.endpointId, endpoint.id),
        eq(chatActions.kind, "provider_effect"), sql`${chatActions.providerActionId} like 'provider_effect:slash_notice:%'`)))
        .toEqual([expect.objectContaining({ companyId: fixture.companyId, endpointId: endpoint.id,
          payload: expect.objectContaining({ effect: "ephemeral_message", authorizationMode: "safe_notice", userId: externalUserId }) })]);
      expect(custody.find(value => value.lane === "command")!.acknowledgedWithin3s).toBe(mode !== "command-delayed");
      const actionPayload = {
          type: "block_actions",
          team: { id: "T-PAPERCLIP" },
          user: wireUser,
          channel: { id: channelId },
          container: {
            type: "message",
            channel_id: channelId,
            message_ts: publication.providerMessageId,
            thread_ts: threadTs,
          },
          message: { ts: publication.providerMessageId, thread_ts: threadTs },
          actions: [{ action_id: openAction.actionId, value: interaction.id }],
          trigger_id: "synthetic-signed-modal-trigger",
      };
      const actionRequest = signed(actionPayload);
      triggerCreatedAt = Date.now();
      const opened = await forward(actionRequest, "action");
      expect(opened.status).toBe(200);
      if (mode === "action-delayed") {
        expect(protocol).toEqual([{ method: "views.open", triggerAgeMs: expect.any(Number), outcome: "trigger_expired" }]);
        expect(protocol[0]!.triggerAgeMs).toBeGreaterThanOrEqual(3_000);
        expect(views).toHaveLength(0);
        const attempts = await db.select().from(chatActions).where(and(
          eq(chatActions.endpointId, endpoint.id), eq(chatActions.kind, "question_form_open_attempt"),
        ));
        expect(attempts).toEqual([expect.objectContaining({ status: "failed", result: expect.objectContaining({ retryable: false }) })]);
        const pending = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interaction.id));
        expect(pending).toEqual([expect.objectContaining({ status: "pending" })]);
        expect(await db.select().from(issueQuestionResponseDeliveries).where(eq(issueQuestionResponseDeliveries.interactionId, interaction.id))).toEqual([]);
        await forward(signed(actionPayload), "duplicate_action");
        expect(protocol).toHaveLength(1);
        expect(onSubmit).not.toHaveBeenCalled();
        expect(unexpectedProviderMethods).toEqual([]);
        expect(providerErrors).toEqual([expect.objectContaining({ code: "slack_webapi_platform_error", data: expect.objectContaining({ error: "trigger_expired" }) })]);
        await Promise.all(providerTransport.mock.results.map(result => result.value));
        expect(custody.find(value => value.lane === "action")!.acknowledgedWithin3s).toBe(false);
        const observed = (await db.select({ setup: chatEndpoints.setup }).from(chatEndpoints).where(eq(chatEndpoints.id, endpoint.id)))[0]!.setup as InternalSetupState;
        expect(observed.slackCallbackSurfaces?.interactivity?.url).toBe(callbackUrl);
        expect(observed.slackCallbackSurfaces?.slashCommands?.url).toBe(callbackUrl);
        if (process.env.PAPERCLIP_SLACK_PROTOCOL_CAPTURE === "1") console.info(JSON.stringify({ mode, protocol, custody }));
        return;
      }
      expect(protocol[0]).toMatchObject({ method: "views.open", outcome: "opened" });
      expect(protocol[0]!.triggerAgeMs).toBeLessThan(3_000);
      expect(views).toHaveLength(1);
      await forward(signed(actionPayload), "duplicate_action");
      expect(protocol).toHaveLength(1);
      expect(views).toHaveLength(1);
      const view = views[0]!;
      const metadata = JSON.parse(view.private_metadata) as {
        c: string;
        m: string;
      };
      expect(metadata).toEqual({ c: expect.any(String), m: view.callback_id });
      const select = view.blocks.find(
        (block) => block.element?.type === "radio_buttons",
      )!;
      const text = view.blocks.find(
        (block) => block.element?.type === "plain_text_input",
      )!;
      const production = select.element.options!.find(
        (option) => option.text.text === "Production",
      )!;
      expect(production.value).not.toBe("production");
      const submit = (value: string) =>
        signed({
          type: "view_submission",
          team: { id: "T-PAPERCLIP" },
          user: wireUser,
          view: {
            id: "V-SIGNED-MODAL",
            callback_id: view.callback_id,
            private_metadata: view.private_metadata,
            state: {
              values: {
                [select.block_id]: {
                  [select.element.action_id]: {
                    type: "radio_buttons",
                    selected_option: production,
                  },
                },
                [text.block_id]: {
                  [text.element.action_id]: { type: "plain_text_input", value },
                },
              },
            },
          },
        });
      const sdkContextRows = () =>
        db
          .select({ id: chatSdkState.id })
          .from(chatSdkState)
          .where(
            and(
              eq(chatSdkState.companyId, fixture.companyId),
              eq(chatSdkState.endpointId, endpoint.id),
              eq(
                chatSdkState.stateKey,
                `cache:${createHash("sha256").update(`modal-context:slack:${metadata.c}`).digest("hex")}`,
              ),
            ),
          );
      const submissionState = async () => ({
        interactions: await db
          .select()
          .from(issueThreadInteractions)
          .where(eq(issueThreadInteractions.id, interaction.id)),
        tokens: await db
          .select()
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, endpoint.id),
              eq(chatActions.providerActionId, view.callback_id),
            ),
          ),
        deliveries: await db
          .select()
          .from(issueQuestionResponseDeliveries)
          .where(
            eq(issueQuestionResponseDeliveries.interactionId, interaction.id),
          ),
        audits: await db
          .select()
          .from(activityLog)
          .where(
            and(
              eq(activityLog.companyId, fixture.companyId),
              eq(activityLog.entityId, conversation.issueId),
              eq(activityLog.action, "issue.thread_interaction_answered"),
            ),
          ),
      });
      await expect(sdkContextRows()).resolves.toHaveLength(1);
      const before = await submissionState();
      expect(before.interactions).toEqual([
        expect.objectContaining({ status: "pending" }),
      ]);
      expect(before.tokens).toEqual([
        expect.objectContaining({ status: "issued" }),
      ]);
      expect(before.deliveries).toEqual([]);
      expect(before.audits).toEqual([]);
      const wakeupsBefore = wakeup.mock.calls.length;
      const invalidStartedAt = Date.now();
      const invalid = await forward(submit(""), "invalid_submission");
      expect(custody.find(value => value.lane === "invalid_submission")!.acknowledgedWithin3s).toBe(mode !== "submission-delayed");
      if (mode === "submission-delayed") expect(Date.now() - invalidStartedAt).toBeGreaterThanOrEqual(3_500);
      expect(invalid.status).toBe(200);
      expect(await invalid.json()).toEqual({
        response_action: "errors",
        errors: { [text.block_id]: "Enter a response" },
      });
      expect(onSubmit.mock.calls[0]![0].event).toMatchObject({
        relatedThread: { id: conversation.externalThreadId },
        relatedMessage: { id: publication.providerMessageId },
      });
      await expect(sdkContextRows()).resolves.toEqual([]);
      expect(await submissionState()).toEqual(before);
      expect(wakeup).toHaveBeenCalledTimes(wakeupsBefore);

      const setRole = (membershipRole: "viewer" | "operator") =>
        db
          .update(companyMemberships)
          .set({ membershipRole, updatedAt: new Date() })
          .where(
            and(
              eq(companyMemberships.companyId, fixture.companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.principalId, linkedUserId),
            ),
          );
      await setRole("viewer");
      const denied = await forward(submit("Add regional failover"), "current_authority_submission");
      expect(denied.status).toBe(200);
      expect(await denied.json()).toEqual({
        response_action: "errors",
        errors: {
          [select.block_id]:
            "This form is no longer authorized. Close it and open the linked Paperclip task.",
        },
      });
      expect(await submissionState()).toEqual(before);
      expect(wakeup).toHaveBeenCalledTimes(wakeupsBefore);
      const denials = await db
        .select()
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            sql`${chatDeliveries.normalizedEvent}->'modal'->>'code' = 'chat_modal_principal_not_authorized'`,
          ),
        );
      expect(denials).toHaveLength(1);
      expect(denials[0]).toMatchObject({
        state: "filtered",
        conversationId: conversation.id,
      });
      await setRole("operator");
      const corrected = await forward(submit("  Add regional failover  "), "corrected_submission");
      expect(corrected.status).toBe(200);
      expect(await corrected.json()).toEqual({ response_action: "clear" });
      await vi.waitFor(async () => {
        expect(wakeup).toHaveBeenCalledTimes(wakeupsBefore + 1);
        expect((await submissionState()).deliveries).toEqual([
          expect.objectContaining({
            status: "fallback_queued",
            deliveryMode: "wake_fallback",
          }),
        ]);
      });
      expect(wakeup).toHaveBeenLastCalledWith(
        fixture.assignedAgentId,
        expect.objectContaining({
          idempotencyKey: `question-response:${interaction.id}`,
          requestedByActorType: "user",
          requestedByActorId: linkedUserId,
          contextSnapshot: expect.objectContaining({
            issueId: conversation.issueId,
            interactionId: interaction.id,
            source: "issue.interaction.respond",
          }),
        }),
      );
      const accepted = await submissionState();
      expect(accepted.interactions).toEqual([
        expect.objectContaining({
          companyId: fixture.companyId,
          issueId: conversation.issueId,
          status: "answered",
          resolvedByUserId: linkedUserId,
          result: {
            version: 1,
            summaryMarkdown: null,
            answers: [
              { questionId: "environment", optionIds: ["production"] },
              {
                questionId: "reason",
                optionIds: [],
                otherText: "Add regional failover",
              },
            ],
          },
        }),
      ]);
      expect(accepted.tokens).toEqual([
        expect.objectContaining({
          status: "processed",
          conversationId: conversation.id,
          principalId: principal.id,
          result: {
            code: "question_form_answered",
            interactionId: interaction.id,
          },
        }),
      ]);
      expect(accepted.deliveries).toHaveLength(1);
      expect(accepted.audits).toEqual([
        expect.objectContaining({
          actorId: linkedUserId,
          details: expect.objectContaining({
            source: "external_chat_modal",
            endpointId: endpoint.id,
            conversationId: conversation.id,
            publicationId: publication.id,
          }),
        }),
      ]);
      const duplicate = await forward(submit("  Add regional failover  "), "duplicate_submission");
      expect(duplicate.status).toBe(200);
      expect(await duplicate.json()).toEqual({ response_action: "clear" });
      expect(await submissionState()).toEqual(accepted);
      expect(wakeup).toHaveBeenCalledTimes(wakeupsBefore + 1);
      expect(onSubmit).toHaveBeenCalledTimes(4);
      for (const [event] of onSubmit.mock.calls.slice(1)) {
        expect(event).toMatchObject({
          endpointId: endpoint.id,
          provider: "slack",
          event: {
            callbackId: view.callback_id,
            privateMetadata: view.callback_id,
            user: { userId: externalUserId },
          },
        });
        expect(event.event.relatedThread).toBeUndefined();
        expect(event.event.relatedMessage).toBeUndefined();
      }
      await expect(service.listConversations(endpoint.id)).resolves.toEqual([
        expect.objectContaining({
          id: conversation.id,
          issueId: conversation.issueId,
          externalThreadId: channel.thread.id,
        }),
      ]);
      expect(
        providerMethods.filter((method) => method === "views.open"),
      ).toHaveLength(1);
      expect(unexpectedProviderMethods).toEqual([]);
      await Promise.all(providerTransport.mock.results.map(result => result.value));
      expect(providerErrors).toEqual([]);
      const observed = (await db.select({ setup: chatEndpoints.setup }).from(chatEndpoints).where(eq(chatEndpoints.id, endpoint.id)))[0]!.setup as InternalSetupState;
      expect(observed.slackCallbackSurfaces?.interactivity?.url).toBe(callbackUrl);
      expect(observed.slackCallbackSurfaces?.slashCommands?.url).toBe(callbackUrl);
      if (process.env.PAPERCLIP_SLACK_PROTOCOL_CAPTURE === "1") console.info(JSON.stringify({ mode, protocol, custody, invalidSubmission: "errors", correctedSubmission: "clear", answerDeliveries: accepted.deliveries.length }));
    } catch (error) {
      failure = { error };
    } finally {
      const errors: unknown[] = [];
      for (const cleanup of [
        () => routedService?.shutdown(),
        () => actualRuntime?.shutdown(),
        () => configured ? retirePublicationFixture(configured.service, configured.endpoint.id) : undefined,
        () => network.assertQuiet(),
        () => network.restore(),
      ]) {
        try { await cleanup(); } catch (error) { errors.push(error); }
      }
      // Never throw from a finally block: it would replace the original failure.
      if (errors.length) failure = {
        error: new AggregateError([...(failure ? [failure.error] : []), ...errors], "Slack protocol work or cleanup failed"),
      };
    }
    if (failure) throw failure.error;
  });
});
