import { createHash, randomUUID } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { activityLog, authUsers, chatActions, chatConversations, chatDeliveries, chatEndpoints, chatExternalPrincipals, chatIdentityLinks, chatMessageLinks, chatPublications, companyMemberships, heartbeatRuns, issueComments, issueQuestionResponseDeliveries, issueThreadInteractions } from "@paperclipai/db";
import { chatChannelService } from "../../services/chat-channels.js";
import { issueService } from "../../services/issues.js";
import { issueThreadInteractionService } from "../../services/issue-thread-interactions.js";
import * as chatQuestionForms from "../../services/chat-question-forms.js";
import {  } from "../../services/chat-question-forms.js";
import { telegramChatSdkCallbackData } from "../../services/chat-interaction-publications.js";
import { enqueueChatRunMilestones, resolveChatRunPresentationAuthorizationReason } from "../../services/chat-run-publications.js";
import { FakeChatSdkRuntime, makeMessage, makeThread } from ".././helpers/chat-channels-fixture.js";
import { chatWakeContext, configuredSlackEndpoint, configuredTelegramEndpoint, createService, db, deliverMessage, describeChatChannelsSuite, qualifySetupRoundTrip, readChatConversationsByEndpointId, readChatPublicationsByCommentId, readChatPublicationsByIdempotencyKey, receiptBackedWakeup, seedCompany } from "../helpers/chat-channels-harness.js";









describeChatChannelsSuite("chat channels 25-cases", () => {
  it.each([
    { provider: "slack" as const, label: "Slack" },
    { provider: "microsoft-teams" as const, label: "Microsoft Teams" },
  ])(
    "round-trips a $label question modal and durably acknowledges denied or replayed tokens",
    async ({ provider }) => {
      const fixture = await seedCompany();
      let pauseNextFormOpen = false;
      let releaseFormOpenAuthorization!: () => void;
      let signalFormOpenAuthorization!: () => void;
      const formOpenAuthorizationEntered = new Promise<void>((resolve) => {
        signalFormOpenAuthorization = resolve;
      });
      const formOpenAuthorizationReleased = new Promise<void>((resolve) => {
        releaseFormOpenAuthorization = resolve;
      });
      const questionFormOpenAuthorizationBarrier = async () => {
        if (!pauseNextFormOpen) return;
        signalFormOpenAuthorization();
        await formOpenAuthorizationReleased;
      };
      const context =
        provider === "slack"
          ? await configuredSlackEndpoint(fixture, {
              questionFormOpenAuthorizationBarrier,
            })
          : await (async () => {
              const created = createService(
                new FakeChatSdkRuntime(),
                (async () =>
                  new Response(
                    JSON.stringify({ access_token: "teams-modal-access" }),
                    {
                      status: 200,
                      headers: { "content-type": "application/json" },
                    },
                  )) as typeof globalThis.fetch,
                {
                  questionFormOpenAuthorizationBarrier,
                },
              );
              const endpoint = await created.service.create(
                fixture.companyId,
                {
                  provider: "microsoft-teams",
                  assignedAgentId: fixture.assignedAgentId,
                },
                "owner-user",
              );
              await created.service.configure(
                endpoint.id,
                {
                  action: "configure",
                  credentials: {
                    clientId: "00000000-0000-4000-8000-000000000311",
                    tenantId: "00000000-0000-4000-8000-000000000322",
                    clientSecret: "teams-modal-secret",
                  },
                },
                "owner-user",
              );
              const callbacks = created.runtime.configurations.get(
                endpoint.id,
              )?.callbacks;
              if (!callbacks) throw new Error("Expected Teams modal callbacks");
              return { ...created, endpoint, callbacks };
            })();
      const { callbacks, endpoint, runtime, service } = context;
      if (!callbacks.onAction || !callbacks.onModalSubmit) {
        throw new Error("Expected question action and modal callbacks");
      }
      const teamsEndpointRuntime =
        provider === "microsoft-teams"
          ? runtime.endpoints.get(endpoint.id)
          : null;
      if (provider === "microsoft-teams" && !teamsEndpointRuntime) {
        throw new Error("Expected Teams endpoint runtime");
      }
      const teamsRouteCount = () =>
        teamsEndpointRuntime?.recordedMicrosoftTeamsRoutes.length ?? 0;
      const externalUserId = `${provider}-modal-user-${randomUUID()}`;
      const teamsConversationId = "19:modal-conversation@thread.tacv2";
      const teamsServiceUrl = "https://smba.trafficmanager.net/amer/";
      const channel =
        provider === "slack"
          ? makeThread({
              channelId: "C-MODAL-ROUNDTRIP",
              id: `slack:C-MODAL-ROUNDTRIP:${randomUUID()}`,
              name: "modal-roundtrip",
            })
          : makeThread({
              channelId: `teams:${Buffer.from(teamsConversationId).toString("base64url")}:${Buffer.from(teamsServiceUrl).toString("base64url")}`,
              id: `teams:${Buffer.from(`${teamsConversationId};messageid=modal-root`).toString("base64url")}:${Buffer.from(teamsServiceUrl).toString("base64url")}`,
              name: "modal-roundtrip",
            });
      const callbackThread =
        provider === "microsoft-teams"
          ? {
              ...channel.thread,
              channelId: `teams:${Buffer.from(teamsConversationId).toString("base64url")}`,
              id: `teams:${Buffer.from(`${teamsConversationId};messageid=modal-root`).toString("base64url")}`,
            }
          : channel.thread;
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider,
        thread: channel.thread,
        message: makeMessage({
          id: `modal-root-${randomUUID()}`,
          text: "@maya collect the deployment details",
          mentioned: true,
          userId: externalUserId,
        }),
        trigger: "mention",
      });
      await qualifySetupRoundTrip(service, endpoint.id, externalUserId);
      await service.test(endpoint.id);
      const [conversation] = await readChatConversationsByEndpointId(endpoint.id);

      const linkedUserId = `modal-paperclip-user-${randomUUID()}`;
      const now = new Date();
      await db.insert(authUsers).values({
        id: linkedUserId,
        name: "Modal User",
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
            eq(chatExternalPrincipals.provider, provider),
            eq(chatExternalPrincipals.externalId, externalUserId),
          ),
        )
        .then((rows) => rows[0]);
      const intent = await service.createLinkIntent(
        endpoint.id,
        principal.id,
        1_800,
      );
      const identityToken = new URL(intent.confirmationUrl).searchParams.get(
        "token",
      );
      if (!identityToken) throw new Error("Modal identity token was absent");
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
          rows.find((row) => row.payload.interactionId === interaction.id),
        );
      if (!publication?.providerMessageId) {
        throw new Error("Question form publication was not delivered");
      }
      const openAction = publication.payload.card?.actions?.find(
        (action) => action.type === "callback",
      );
      if (!openAction || openAction.type !== "callback") {
        throw new Error("Question form opener was not projected");
      }
      const modalUser = {
        userId: externalUserId,
        userName: "modal-user",
        fullName: "Modal User",
        isBot: false,
        isMe: false,
        isSystem: false,
      };
      const actionEvent = (actionId: string) => ({
        endpointId: endpoint.id,
        provider,
        event: {
          actionId,
          adapter: {} as never,
          messageId: publication.providerMessageId!,
          openModal: vi.fn(async (_modal?: unknown) => ({ viewId: "modal-view" })),
          raw:
            provider === "microsoft-teams"
              ? { serviceUrl: teamsServiceUrl }
              : {},
          thread: channel.thread,
          threadId: callbackThread.id,
          triggerId: `modal-trigger-${randomUUID()}`,
          user: modalUser,
          value: interaction.id,
        },
      });
      const routeCountBeforeDeniedOpen = teamsRouteCount();
      await callbacks.onAction(
        actionEvent(`pcf:${"A".repeat(22)}`) as Parameters<
          NonNullable<typeof callbacks.onAction>
        >[0],
      );
      await vi.waitFor(() =>
        expect(channel.postEphemeral).toHaveBeenCalledWith(
          modalUser.userId,
          "This action is no longer available. Open the linked Paperclip task or ask an operator to link this account.",
          { fallbackToDM: false },
        ),
      );
      expect(teamsRouteCount()).toBe(routeCountBeforeDeniedOpen);

      if (provider === "microsoft-teams") {
        pauseNextFormOpen = true;
        const racedOpen = actionEvent(openAction.actionId);
        const opening = callbacks.onAction(
          racedOpen as Parameters<NonNullable<typeof callbacks.onAction>>[0],
        );
        await formOpenAuthorizationEntered;
        await db
          .update(companyMemberships)
          .set({ membershipRole: "viewer", updatedAt: new Date() })
          .where(
            and(
              eq(companyMemberships.companyId, fixture.companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.principalId, linkedUserId),
            ),
          );
        releaseFormOpenAuthorization();
        await opening;
        expect(racedOpen.event.openModal).not.toHaveBeenCalled();
        expect(teamsRouteCount()).toBe(routeCountBeforeDeniedOpen);
        await db
          .update(companyMemberships)
          .set({ membershipRole: "operator", updatedAt: new Date() })
          .where(
            and(
              eq(companyMemberships.companyId, fixture.companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.principalId, linkedUserId),
            ),
          );
        pauseNextFormOpen = false;
      }

      if (provider === "slack") {
        const lockProbeOpen = actionEvent(openAction.actionId);
        let releaseProviderOpen!: () => void;
        const providerOpenEntered = vi.fn();
        lockProbeOpen.event.openModal = vi.fn(async () => {
          providerOpenEntered();
          await new Promise<void>((resolve) => {
            releaseProviderOpen = resolve;
          });
          return { viewId: "modal-lock-probe" };
        });
        const opening = callbacks.onAction(
          lockProbeOpen as Parameters<
            NonNullable<typeof callbacks.onAction>
          >[0],
        );
        await vi.waitFor(() =>
          expect(providerOpenEntered).toHaveBeenCalledTimes(1),
        );
        const membershipUpdate = db
          .update(companyMemberships)
          .set({ membershipRole: "viewer", updatedAt: new Date() })
          .where(
            and(
              eq(companyMemberships.companyId, fixture.companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.principalId, linkedUserId),
            ),
          )
          .returning({ id: companyMemberships.id })
          .then(() => "updated" as const);
        const updateOutcome = await Promise.race([
          membershipUpdate,
          new Promise<"timed_out">((resolve) =>
            setTimeout(() => resolve("timed_out"), 500),
          ),
        ]);
        releaseProviderOpen();
        await opening;
        await membershipUpdate;
        expect(updateOutcome).toBe("updated");
        expect(lockProbeOpen.event.openModal).toHaveBeenCalledTimes(1);
        await db
          .update(companyMemberships)
          .set({ membershipRole: "operator", updatedAt: new Date() })
          .where(
            and(
              eq(companyMemberships.companyId, fixture.companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.principalId, linkedUserId),
            ),
          );

        const failedOpen = actionEvent(openAction.actionId);
        failedOpen.event.openModal = vi.fn(async () => {
          throw Object.assign(new Error("Slack Web API rejected modal"), {
            code: "slack_webapi_platform_error",
            data: { error: "missing_scope", ok: false },
          });
        });
        await callbacks.onAction(
          failedOpen as Parameters<NonNullable<typeof callbacks.onAction>>[0],
        );
        await callbacks.onAction(
          failedOpen as Parameters<NonNullable<typeof callbacks.onAction>>[0],
        );
        expect(failedOpen.event.openModal).toHaveBeenCalledTimes(1);
        await vi.waitFor(() =>
          expect(channel.postEphemeral).toHaveBeenCalledWith(
            modalUser.userId,
            "Paperclip could not open this form. Try the action again or open the linked Paperclip task.",
            { fallbackToDM: false },
          ),
        );
        const modalOpenFailures = await db
          .select()
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, endpoint.id),
              sql`${chatDeliveries.normalizedEvent}->'modal'->>'phase' = 'open'`,
            ),
          );
        expect(modalOpenFailures).toEqual([
          expect.objectContaining({
            state: "filtered",
            attempts: 1,
            redactedError: expect.stringContaining(
              "Provider modal open failed",
            ),
            normalizedEvent: expect.objectContaining({
              modal: {
                phase: "open",
                outcome: "failed",
                disposition: "failed",
              },
            }),
          }),
        ]);
        expect(JSON.stringify(modalOpenFailures)).not.toContain(
          failedOpen.event.triggerId,
        );
      }

      const validOpen = actionEvent(openAction.actionId);
      await callbacks.onAction(
        validOpen as Parameters<NonNullable<typeof callbacks.onAction>>[0],
      );
      expect(validOpen.event.openModal).toHaveBeenCalledTimes(1);
      expect(teamsRouteCount()).toBeGreaterThanOrEqual(
        routeCountBeforeDeniedOpen + (provider === "microsoft-teams" ? 1 : 0),
      );
      const routeCountAfterValidOpen = teamsRouteCount();
      const modal = validOpen.event.openModal.mock.calls[0]?.[0] as {
        callbackId: string;
        children: Array<{
          id: string;
          options?: Array<{ label: string; value: string }>;
          type: string;
        }>;
        privateMetadata?: string;
      };
      const selectField = modal.children.find(
        (child) => child.type === (provider === "slack" ? "radio_select" : "select"),
      );
      const textField = modal.children.find(
        (child) => child.type === "text_input",
      );
      const productionValue = selectField?.options?.find(
        (option) => option.label === "Production",
      )?.value;
      if (!selectField || !textField || !productionValue) {
        throw new Error("Question modal fields were incomplete");
      }
      const modalEvent = (callbackId: string) => ({
        endpointId: endpoint.id,
        provider,
        event: {
          adapter: {} as never,
          callbackId,
          ...(provider === "slack"
            ? { privateMetadata: modal.privateMetadata }
            : {}),
          raw:
            provider === "microsoft-teams"
              ? { serviceUrl: teamsServiceUrl }
              : {},
          relatedMessage: { id: publication.providerMessageId } as never,
          relatedThread: callbackThread,
          user: modalUser,
          values: {
            [selectField.id]: productionValue,
            [textField.id]: "Add regional failover",
          },
          viewId: "modal-view",
        },
      });
      const forgedSubmit = modalEvent(`pcfs:${"A".repeat(22)}`);
      await expect(
        callbacks.onModalSubmit(
          forgedSubmit as Parameters<
            NonNullable<typeof callbacks.onModalSubmit>
          >[0],
        ),
      ).resolves.toEqual({ action: "clear" });
      await expect(
        callbacks.onModalSubmit(
          forgedSubmit as Parameters<
            NonNullable<typeof callbacks.onModalSubmit>
          >[0],
        ),
      ).resolves.toEqual({ action: "clear" });
      await expect(
        db
          .select({ id: chatDeliveries.id })
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, endpoint.id),
              sql`${chatDeliveries.normalizedEvent}->'modal'->>'code' = 'chat_modal_token_not_current'`,
            ),
          ),
      ).resolves.toHaveLength(1);
      expect(teamsRouteCount()).toBe(routeCountAfterValidOpen);

      const validSubmit = modalEvent(modal.callbackId);
      const invalidSubmit = {
        ...validSubmit,
        event: {
          ...validSubmit.event,
          values: { ...validSubmit.event.values, [textField.id]: "" },
        },
      };
      const wakeupsBeforeInvalidForm = context.wakeup.mock.calls.length;
      const invalidFormResponse = await callbacks.onModalSubmit(
        invalidSubmit as Parameters<
          NonNullable<typeof callbacks.onModalSubmit>
        >[0],
      );
      if (provider === "microsoft-teams") {
        expect(invalidFormResponse).toMatchObject({
          action: "update",
          modal: {
            callbackId: modal.callbackId,
            privateMetadata: modal.callbackId,
            children: expect.arrayContaining([
              expect.objectContaining({
                type: "select",
                id: selectField.id,
                initialOption: productionValue,
              }),
              expect.objectContaining({
                type: "text_input",
                id: textField.id,
                initialValue: "",
              }),
              expect.objectContaining({
                type: "text",
                content: "What should the release note say?: Enter a response",
              }),
            ]),
          },
        });
      } else {
        expect(invalidFormResponse).toEqual({
          action: "errors",
          errors: { [textField.id]: "Enter a response" },
        });
      }
      expect(context.wakeup).toHaveBeenCalledTimes(wakeupsBeforeInvalidForm);
      await expect(
        db
          .select({ status: issueThreadInteractions.status })
          .from(issueThreadInteractions)
          .where(eq(issueThreadInteractions.id, interaction.id)),
      ).resolves.toEqual([{ status: "pending" }]);
      await expect(
        db
          .select({ status: chatActions.status })
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, endpoint.id),
              eq(chatActions.providerActionId, modal.callbackId),
            ),
          ),
      ).resolves.toEqual([{ status: "issued" }]);
      await expect(
        db
          .select({ id: issueQuestionResponseDeliveries.id })
          .from(issueQuestionResponseDeliveries)
          .where(
            eq(issueQuestionResponseDeliveries.interactionId, interaction.id),
          ),
      ).resolves.toEqual([]);
      await expect(
        db
          .select({ id: activityLog.id })
          .from(activityLog)
          .where(
            and(
              eq(activityLog.companyId, fixture.companyId),
              eq(activityLog.entityId, conversation.issueId),
              eq(activityLog.action, "issue.thread_interaction_answered"),
            ),
          ),
      ).resolves.toEqual([]);
      await db
        .update(companyMemberships)
        .set({ membershipRole: "viewer", updatedAt: new Date() })
        .where(
          and(
            eq(companyMemberships.companyId, fixture.companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, linkedUserId),
          ),
        );
      const deniedSubmitResponse = {
        action: "errors",
        errors: {
          [selectField.id]:
            "This form is no longer authorized. Close it and open the linked Paperclip task.",
        },
      };
      await expect(
        callbacks.onModalSubmit(
          validSubmit as Parameters<
            NonNullable<typeof callbacks.onModalSubmit>
          >[0],
        ),
      ).resolves.toEqual(deniedSubmitResponse);
      await expect(
        callbacks.onModalSubmit(
          validSubmit as Parameters<
            NonNullable<typeof callbacks.onModalSubmit>
          >[0],
        ),
      ).resolves.toEqual(deniedSubmitResponse);
      await expect(
        db
          .select({ id: chatDeliveries.id })
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, endpoint.id),
              sql`${chatDeliveries.normalizedEvent}->'modal'->>'code' = 'chat_modal_principal_not_authorized'`,
            ),
          ),
      ).resolves.toHaveLength(1);
      expect(teamsRouteCount()).toBe(routeCountAfterValidOpen);
      await db
        .update(companyMemberships)
        .set({ membershipRole: "operator", updatedAt: new Date() })
        .where(
          and(
            eq(companyMemberships.companyId, fixture.companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, linkedUserId),
          ),
        );

      // Both callbacks load the issued token. Hold the duplicate until the
      // first callback commits its answer, exercising stale preflight state
      // rather than relying on database latency to produce the race.
      const originalLoadToken =
        chatQuestionForms.loadChatQuestionFormSubmissionToken;
      let issuedReplayToken: Awaited<ReturnType<typeof originalLoadToken>> =
        null;
      let tokenLoads = 0;
      let releaseFirstSubmit!: () => void;
      let releaseReplaySubmit!: () => void;
      const firstSubmitReleased = new Promise<void>((resolve) => {
        releaseFirstSubmit = resolve;
      });
      const replaySubmitReleased = new Promise<void>((resolve) => {
        releaseReplaySubmit = resolve;
      });
      const tokenLoadSpy = vi
        .spyOn(chatQuestionForms, "loadChatQuestionFormSubmissionToken")
        .mockImplementation(async (...args) => {
          const loaded = await originalLoadToken(...args);
          if (args[1].callbackId === modal.callbackId && tokenLoads < 2) {
            const ordinal = ++tokenLoads;
            expect(loaded?.status).toBe("issued");
            issuedReplayToken = loaded;
            await (ordinal === 1 ? firstSubmitReleased : replaySubmitReleased);
          }
          return loaded;
        });
      const firstSubmit = callbacks.onModalSubmit(
        validSubmit as Parameters<
          NonNullable<typeof callbacks.onModalSubmit>
        >[0],
      );
      const replaySubmit = callbacks.onModalSubmit(
        validSubmit as Parameters<
          NonNullable<typeof callbacks.onModalSubmit>
        >[0],
      );
      // Observe rejections immediately; finally joins both callbacks even when
      // the red assertion fails, so no held callback can leak into another test.
      const submissionsSettled = Promise.allSettled([
        firstSubmit,
        replaySubmit,
      ]);
      try {
        await vi.waitFor(() => expect(tokenLoads).toBe(2));
        releaseFirstSubmit();
        await vi.waitFor(async () => {
          const [current] = await db
            .select({ status: issueThreadInteractions.status })
            .from(issueThreadInteractions)
            .where(eq(issueThreadInteractions.id, interaction.id));
          expect(current?.status).toBe("answered");
        });
        releaseReplaySubmit();
        await expect(Promise.all([firstSubmit, replaySubmit])).resolves.toEqual(
          [{ action: "clear" }, { action: "clear" }],
        );
      } finally {
        releaseFirstSubmit();
        releaseReplaySubmit();
        await submissionsSettled;
        tokenLoadSpy.mockRestore();
      }
      expect(teamsRouteCount()).toBeGreaterThanOrEqual(
        routeCountAfterValidOpen + (provider === "microsoft-teams" ? 1 : 0),
      );
      await vi.waitFor(
        async () => {
          // The publication worker intentionally drains a bounded global batch.
          // A full-suite database can contain more than 25 older eligible rows,
          // so keep advancing FIFO until this interaction's resolution owns the
          // existing provider-message link.
          await service.processPendingPublications();
          const linked = await db
            .select({ publicationId: chatMessageLinks.publicationId })
            .from(chatMessageLinks)
            .where(
              and(
                eq(chatMessageLinks.endpointId, endpoint.id),
                eq(chatMessageLinks.conversationId, conversation.id),
                eq(
                  chatMessageLinks.providerMessageId,
                  publication.providerMessageId!,
                ),
              ),
            );
          expect(linked).toHaveLength(1);
          expect(linked[0]?.publicationId).not.toBe(publication.id);
          const resolutionState = linked[0]?.publicationId
            ? await db
                .select({ state: chatPublications.state })
                .from(chatPublications)
                .where(eq(chatPublications.id, linked[0].publicationId))
                .then((rows) => rows[0]?.state ?? null)
            : null;
          expect(resolutionState).toBe("published");
        },
        { timeout: 5_000 },
      );
      const [answered] = await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, interaction.id));
      expect(answered).toMatchObject({
        status: "answered",
        resolvedByUserId: linkedUserId,
        result: {
          version: 1,
          answers: [
            { questionId: "environment", optionIds: ["production"] },
            {
              questionId: "reason",
              optionIds: [],
              otherText: "Add regional failover",
            },
          ],
        },
      });
      await expect(
        callbacks.onModalSubmit(
          validSubmit as Parameters<
            NonNullable<typeof callbacks.onModalSubmit>
          >[0],
        ),
      ).resolves.toEqual({ action: "clear" });
      if (!issuedReplayToken) throw new Error("Expected captured issued token");
      const staleReplay = async () => {
        const staleLoadSpy = vi
          .spyOn(chatQuestionForms, "loadChatQuestionFormSubmissionToken")
          .mockResolvedValueOnce(issuedReplayToken);
        try {
          return await callbacks.onModalSubmit!(
            validSubmit as Parameters<
              NonNullable<typeof callbacks.onModalSubmit>
            >[0],
          );
        } finally {
          staleLoadSpy.mockRestore();
        }
      };
      const [processedToken] = await db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(chatActions.providerActionId, modal.callbackId),
          ),
        );
      expect(processedToken?.status).toBe("processed");
      // A terminal interaction alone cannot authorize stale-token recovery.
      // The exact processed receipt and its original resolving user must match.
      await db
        .update(chatActions)
        .set({
          result: {
            code: "question_form_answered",
            interactionId: randomUUID(),
          },
        })
        .where(eq(chatActions.id, processedToken.id));
      await expect(staleReplay()).resolves.toEqual(deniedSubmitResponse);
      await db
        .update(chatActions)
        .set({ result: processedToken.result })
        .where(eq(chatActions.id, processedToken.id));
      await db
        .update(companyMemberships)
        .set({ membershipRole: "viewer" })
        .where(
          and(
            eq(companyMemberships.companyId, fixture.companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, linkedUserId),
          ),
        );
      await expect(staleReplay()).resolves.toEqual(deniedSubmitResponse);
      await db
        .update(companyMemberships)
        .set({ membershipRole: "operator" })
        .where(
          and(
            eq(companyMemberships.companyId, fixture.companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, linkedUserId),
          ),
        );
      await db
        .update(chatIdentityLinks)
        .set({ status: "revoked" })
        .where(
          and(
            eq(chatIdentityLinks.endpointId, endpoint.id),
            eq(chatIdentityLinks.principalId, principal.id),
          ),
        );
      await expect(staleReplay()).resolves.toEqual(deniedSubmitResponse);
      await db
        .update(chatIdentityLinks)
        .set({ status: "linked" })
        .where(
          and(
            eq(chatIdentityLinks.endpointId, endpoint.id),
            eq(chatIdentityLinks.principalId, principal.id),
          ),
        );
      const relinkedUserId = `modal-relinked-user-${randomUUID()}`;
      await db.insert(authUsers).values({
        id: relinkedUserId,
        name: "Different Modal User",
        email: `${relinkedUserId}@example.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(companyMemberships).values({
        companyId: fixture.companyId,
        principalType: "user",
        principalId: relinkedUserId,
        status: "active",
        membershipRole: "operator",
      });
      await db
        .update(chatIdentityLinks)
        .set({ paperclipUserId: relinkedUserId })
        .where(
          and(
            eq(chatIdentityLinks.endpointId, endpoint.id),
            eq(chatIdentityLinks.principalId, principal.id),
          ),
        );
      await expect(staleReplay()).resolves.toEqual(deniedSubmitResponse);
      await expect(
        callbacks.onModalSubmit(
          validSubmit as Parameters<
            NonNullable<typeof callbacks.onModalSubmit>
          >[0],
        ),
      ).resolves.toEqual(deniedSubmitResponse);
      await db
        .update(chatIdentityLinks)
        .set({ paperclipUserId: linkedUserId })
        .where(
          and(
            eq(chatIdentityLinks.endpointId, endpoint.id),
            eq(chatIdentityLinks.principalId, principal.id),
          ),
        );
      await expect(staleReplay()).resolves.toEqual({ action: "clear" });
      expect(
        await db
          .select()
          .from(issueQuestionResponseDeliveries)
          .where(
            eq(issueQuestionResponseDeliveries.interactionId, interaction.id),
          ),
      ).toHaveLength(1);
      expect(await service.listActivity(endpoint.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "delivery",
            status: "filtered",
            detail: "External chat modal submission denied by Paperclip",
            replayable: false,
          }),
        ]),
      );
    },
  );

  it("keeps a chat-origin run presentation internal when its external question owns the reply", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture);
    const channel = makeThread({
      channelId: "C-PRESENTATION-QUESTION",
      id: "slack:C-PRESENTATION-QUESTION:4700.1",
      name: "presentation-question",
    });
    const providerMessageId = "4700.1";
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: channel.thread,
      message: makeMessage({
        id: providerMessageId,
        text: "@maya ask me before choosing",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id);
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

    const sourceRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId: fixture.companyId,
      agentId: fixture.assignedAgentId,
      status: "running",
      contextSnapshot: await chatWakeContext({
        endpointId: endpoint.id,
        issueId: conversation.issueId,
        provider: "slack",
        providerMessageId,
      }),
      resultJson: {
        presentationDecision: {
          chosenSource: "final_agent_message",
          commentAction: "create",
        },
      },
    });
    await db.insert(chatPublications).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      conversationId: conversation.id,
      issueId: conversation.issueId,
      idempotencyKey: `run:${sourceRunId}:working:${endpoint.id}`,
      payload: { text: "Maya is working…", progressState: "working" },
      state: "pending",
    });
    await service.processPendingPublications();
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected Slack provider runtime");
    const workingPublication = await readChatPublicationsByIdempotencyKey(`run:${sourceRunId}:working:${endpoint.id}`)
      .then((rows) => rows[0]);
    if (!workingPublication?.providerMessageId) {
      throw new Error("Expected Slack working publication");
    }
    expect(workingPublication).toMatchObject({
      state: "published",
      providerMessageId: expect.any(String),
    });
    const interaction = await issueThreadInteractionService(db).create(
      { id: conversation.issueId, companyId: fixture.companyId },
      {
        kind: "ask_user_questions",
        continuationPolicy: "wake_assignee",
        sourceRunId,
        title: "Choose a color",
        payload: {
          version: 1,
          title: "Choose a color",
          questions: [
            {
              id: "color",
              prompt: "Which color should we use?",
              selectionMode: "single",
              required: true,
              options: [
                { id: "red", label: "Red" },
                { id: "blue", label: "Blue" },
              ],
            },
          ],
        },
      },
      { agentId: fixture.assignedAgentId, runId: sourceRunId },
    );

    // The native interaction owns this run's provider-visible response slot as
    // soon as its prompt is queued. A protocol-authored waiting summary from
    // the same still-running source must remain an internal task comment; if it
    // were also queued, publication ordering could replace the prompt with the
    // summary before the provider action becomes usable.
    await expect(
      db
        .select({ state: chatPublications.state })
        .from(chatPublications)
        .where(
          eq(
            chatPublications.idempotencyKey,
            `interaction:${interaction.id}:${endpoint.id}`,
          ),
        ),
    ).resolves.toEqual([{ state: "pending" }]);
    const protocolWaitingSummary = await issueService(db).addComment(
      conversation.issueId,
      "I need your answer before I can continue.",
      { agentId: fixture.assignedAgentId, runId: sourceRunId },
      {
        authorType: "agent",
        authorizationReason: "paperclip_runner_protocol",
      },
    );
    await expect(
      readChatPublicationsByCommentId(protocolWaitingSummary.id),
    ).resolves.toHaveLength(0);

    const sourcePresentationAuthorization =
      await resolveChatRunPresentationAuthorizationReason(db, {
        companyId: fixture.companyId,
        issueId: conversation.issueId,
        runId: sourceRunId,
      });
    expect(sourcePresentationAuthorization).toBe("internal_agent_write");
    const internalPresentation = await issueService(db).addComment(
      conversation.issueId,
      "Internal interaction summary: continuationPolicy wake_assignee",
      { agentId: fixture.assignedAgentId, runId: sourceRunId },
      {
        authorType: "agent",
        authorizationReason: sourcePresentationAuthorization,
      },
    );
    await expect(
      db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.id, internalPresentation.id)),
    ).resolves.toEqual([
      {
        body: "Internal interaction summary: continuationPolicy wake_assignee",
      },
    ]);
    await expect(
      readChatPublicationsByCommentId(internalPresentation.id),
    ).resolves.toHaveLength(0);

    // External answer isolation cancels the parked source run before starting
    // its dedicated continuation. That technical handoff must not turn into a
    // provider-visible "stopped" message beside the still-actionable prompt.
    await db
      .update(heartbeatRuns)
      .set({
        status: "cancelled",
        errorCode: "external_chat_continuation",
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, sourceRunId));

    await enqueueChatRunMilestones(db);
    await expect(
      db
        .select()
        .from(chatPublications)
        .where(
          like(
            chatPublications.idempotencyKey,
            `run:${sourceRunId}:completed:%`,
          ),
        ),
    ).resolves.toHaveLength(0);
    await expect(
      db
        .select()
        .from(chatPublications)
        .where(
          like(chatPublications.idempotencyKey, `run:${sourceRunId}:failed:%`),
        ),
    ).resolves.toHaveLength(0);
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", errorCode: null, updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, sourceRunId));
    const postCountBeforePrompt = providerRuntime.posts.length;
    await service.processPendingPublications();
    const originalPrompt = await readChatPublicationsByIdempotencyKey(`interaction:${interaction.id}:${endpoint.id}`)
      .then((rows) => rows[0]);
    expect(originalPrompt).toMatchObject({
      state: "published",
      providerMessageId: workingPublication.providerMessageId,
      payload: {
        interactionId: interaction.id,
        progressState: "waiting_for_input",
        card: { kind: "question", title: "Which color should we use?" },
      },
    });
    expect(providerRuntime.posts).toHaveLength(postCountBeforePrompt);
    expect(providerRuntime.edits.at(-1)).toMatchObject({
      threadId: channel.thread.id,
      messageId: workingPublication.providerMessageId,
      text: expect.stringContaining("Which color should we use?"),
    });
    await expect(
      db
        .select({ publicationId: chatMessageLinks.publicationId })
        .from(chatMessageLinks)
        .where(
          and(
            eq(chatMessageLinks.endpointId, endpoint.id),
            eq(chatMessageLinks.conversationId, conversation.id),
            eq(
              chatMessageLinks.providerMessageId,
              workingPublication.providerMessageId,
            ),
          ),
        ),
    ).resolves.toEqual([{ publicationId: originalPrompt.id }]);
    const renderedProviderMessages = new Map([
      [workingPublication.providerMessageId, providerRuntime.posts[0]?.text],
    ]);
    for (const edit of providerRuntime.edits) {
      renderedProviderMessages.set(edit.messageId, edit.text);
    }
    const renderedText = JSON.stringify([...renderedProviderMessages.values()]);
    expect(renderedText).toContain("Which color should we use?");
    expect(renderedText).not.toContain("Maya is working");
    expect(renderedText).not.toContain("continuationPolicy");

    // A fast provider answer can settle the interaction before heartbeat's
    // presentation pass. The already provider-visible original prompt still
    // consumes the source run's external final, while the separate continuation
    // run remains eligible to publish its actual answer.
    await db
      .update(issueThreadInteractions)
      .set({
        status: "answered",
        result: {
          version: 1,
          answers: [{ questionId: "color", optionIds: ["red"] }],
        },
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(issueThreadInteractions.id, interaction.id));
    await expect(
      resolveChatRunPresentationAuthorizationReason(db, {
        companyId: fixture.companyId,
        issueId: conversation.issueId,
        runId: sourceRunId,
      }),
    ).resolves.toBe("internal_agent_write");

    const continuationRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: continuationRunId,
      companyId: fixture.companyId,
      agentId: fixture.assignedAgentId,
      status: "succeeded",
      contextSnapshot: {
        issueId: conversation.issueId,
        taskId: conversation.issueId,
        source: "issue.interaction.respond",
        interactionId: interaction.id,
        sourceRunId,
      },
    });
    await db.insert(issueQuestionResponseDeliveries).values({
      companyId: fixture.companyId,
      issueId: conversation.issueId,
      interactionId: interaction.id,
      sourceRunId,
      targetRunId: continuationRunId,
      correlationId: `chat-presentation-question:${interaction.id}`,
      payloadSha256: createHash("sha256").update(interaction.id).digest("hex"),
      status: "delivered",
      deliveryMode: "steered",
    });
    const continuationAuthorization =
      await resolveChatRunPresentationAuthorizationReason(db, {
        companyId: fixture.companyId,
        issueId: conversation.issueId,
        runId: continuationRunId,
      });
    expect(continuationAuthorization).toBe("allow_chat_run_presentation");
    const continuationComment = await issueService(db).addComment(
      conversation.issueId,
      "COLOR-CONTINUATION-Red",
      { agentId: fixture.assignedAgentId, runId: continuationRunId },
      {
        authorType: "agent",
        authorizationReason: continuationAuthorization,
      },
    );
    await service.processPendingPublications();
    await expect(
      db
        .select({ state: chatPublications.state })
        .from(chatPublications)
        .where(eq(chatPublications.commentId, continuationComment.id)),
    ).resolves.toEqual([{ state: "published" }]);
    expect(JSON.stringify(providerRuntime.posts)).toContain(
      "COLOR-CONTINUATION-Red",
    );
    await service.shutdown();
  });

  it("replaces Telegram queued progress with its native confirmation and rejects late working progress", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredTelegramEndpoint(fixture);
    const externalUserId = "771234599";
    const dm = makeThread({
      channelId: externalUserId,
      id: `telegram:${externalUserId}`,
      isDM: true,
      name: "Telegram interaction presentation",
    });
    const providerMessageId = `${externalUserId}:1`;
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: dm.thread,
      message: makeMessage({
        id: providerMessageId,
        text: "Ask before publishing the release",
        userId: externalUserId,
      }),
      trigger: "direct_message",
    });
    await qualifySetupRoundTrip(service, endpoint.id, externalUserId);
    await service.test(endpoint.id);
    const conversation = await db
      .select()
      .from(chatConversations)
      .where(
        and(
          eq(chatConversations.endpointId, endpoint.id),
          eq(chatConversations.externalThreadId, dm.thread.id),
        ),
      )
      .then((rows) => rows[0]);
    if (!conversation) throw new Error("Expected Telegram conversation");

    const sourceRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId: fixture.companyId,
      agentId: fixture.assignedAgentId,
      status: "running",
      contextSnapshot: await chatWakeContext({
        endpointId: endpoint.id,
        issueId: conversation.issueId,
        provider: "telegram",
        providerMessageId,
      }),
      resultJson: {
        presentationDecision: {
          chosenSource: "final_agent_message",
          commentAction: "create",
        },
      },
    });
    await db.insert(chatPublications).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      conversationId: conversation.id,
      issueId: conversation.issueId,
      idempotencyKey: `run:${sourceRunId}:queued:${endpoint.id}`,
      payload: { text: "Maya is queued.", progressState: "queued" },
      state: "pending",
    });
    await service.processPendingPublications();
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected Telegram provider runtime");
    const queuedPublication = await readChatPublicationsByIdempotencyKey(`run:${sourceRunId}:queued:${endpoint.id}`)
      .then((rows) => rows[0]);
    if (!queuedPublication?.providerMessageId) {
      throw new Error("Expected Telegram queued publication");
    }

    const interaction = await issueThreadInteractionService(db).create(
      { id: conversation.issueId, companyId: fixture.companyId },
      {
        kind: "request_confirmation",
        continuationPolicy: "wake_assignee",
        sourceRunId,
        title: "Release check",
        payload: {
          version: 1,
          prompt: "Publish the release now?",
          acceptLabel: "Publish",
          rejectLabel: "Wait",
        },
      },
      { agentId: fixture.assignedAgentId, runId: sourceRunId },
    );
    const authorization = await resolveChatRunPresentationAuthorizationReason(
      db,
      {
        companyId: fixture.companyId,
        issueId: conversation.issueId,
        runId: sourceRunId,
      },
    );
    expect(authorization).toBe("internal_agent_write");
    const internalPresentation = await issueService(db).addComment(
      conversation.issueId,
      "Internal Telegram confirmation summary",
      { agentId: fixture.assignedAgentId, runId: sourceRunId },
      { authorType: "agent", authorizationReason: authorization },
    );
    await expect(
      db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.id, internalPresentation.id)),
    ).resolves.toEqual([{ body: "Internal Telegram confirmation summary" }]);
    await expect(
      readChatPublicationsByCommentId(internalPresentation.id),
    ).resolves.toHaveLength(0);
    await enqueueChatRunMilestones(db);
    await expect(
      db
        .select()
        .from(chatPublications)
        .where(
          like(
            chatPublications.idempotencyKey,
            `run:${sourceRunId}:completed:%`,
          ),
        ),
    ).resolves.toHaveLength(0);

    const postCountBeforePrompt = providerRuntime.posts.length;
    await service.processPendingPublications();
    const promptPublication = await readChatPublicationsByIdempotencyKey(`interaction:${interaction.id}:${endpoint.id}`)
      .then((rows) => rows[0]);
    expect(promptPublication).toMatchObject({
      state: "published",
      providerMessageId: queuedPublication.providerMessageId,
      payload: {
        interactionId: interaction.id,
        progressState: "waiting_for_input",
        card: { kind: "confirmation", title: "Publish the release now?" },
      },
    });
    expect(providerRuntime.posts).toHaveLength(postCountBeforePrompt);
    expect(providerRuntime.edits.at(-1)).toMatchObject({
      threadId: dm.thread.id,
      messageId: queuedPublication.providerMessageId,
      text: expect.stringContaining("Publish the release now?"),
    });
    await expect(
      db
        .select({ publicationId: chatMessageLinks.publicationId })
        .from(chatMessageLinks)
        .where(
          and(
            eq(chatMessageLinks.endpointId, endpoint.id),
            eq(chatMessageLinks.conversationId, conversation.id),
            eq(
              chatMessageLinks.providerMessageId,
              queuedPublication.providerMessageId,
            ),
          ),
        ),
    ).resolves.toEqual([{ publicationId: promptPublication.id }]);
    const renderedProviderMessages = new Map([
      [queuedPublication.providerMessageId, providerRuntime.posts[0]?.text],
    ]);
    for (const edit of providerRuntime.edits) {
      renderedProviderMessages.set(edit.messageId, edit.text);
    }
    const renderedText = JSON.stringify([...renderedProviderMessages.values()]);
    expect(renderedText).toContain("Publish the release now?");
    expect(renderedText).not.toContain("Maya is queued");
    expect(renderedText).not.toContain(
      "Internal Telegram confirmation summary",
    );

    const editsBeforeLateWorking = providerRuntime.edits.length;
    const postsBeforeLateWorking = providerRuntime.posts.length;
    // The milestone scan above raced a still-running source behind its newly
    // queued interaction. Drain that actual late placeholder rather than
    // inserting a duplicate fixture row.
    await service.processPendingPublications();
    await expect(
      db
        .select({
          attempts: chatPublications.attempts,
          redactedError: chatPublications.redactedError,
          state: chatPublications.state,
        })
        .from(chatPublications)
        .where(
          eq(
            chatPublications.idempotencyKey,
            `run:${sourceRunId}:working:${endpoint.id}`,
          ),
        ),
    ).resolves.toEqual([
      {
        attempts: 0,
        redactedError:
          "Run progress was superseded by its provider interaction",
        state: "cancelled",
      },
    ]);
    expect(providerRuntime.posts).toHaveLength(postsBeforeLateWorking);
    expect(providerRuntime.edits).toHaveLength(editsBeforeLateWorking);
    await expect(
      db
        .select({ publicationId: chatMessageLinks.publicationId })
        .from(chatMessageLinks)
        .where(
          and(
            eq(chatMessageLinks.endpointId, endpoint.id),
            eq(chatMessageLinks.conversationId, conversation.id),
            eq(
              chatMessageLinks.providerMessageId,
              queuedPublication.providerMessageId,
            ),
          ),
        ),
    ).resolves.toEqual([{ publicationId: promptPublication.id }]);
    await service.shutdown();
  });

  it("acknowledges denied Telegram actions after one durable, payload-free notice", async () => {
    const fixture = await seedCompany();
    const botId = Number.parseInt(
      fixture.companyId.replaceAll("-", "").slice(0, 12),
      16,
    );
    const botToken = `${botId}:telegram-denial-webhook-test`;
    const apiCalls: Array<{ body: string; method: string }> = [];
    let webhookSecret = "";
    const telegramFetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const method = new URL(String(input)).pathname.split("/").at(-1) ?? "";
        const body = typeof init?.body === "string" ? init.body : "";
        apiCalls.push({ body, method });
        if (method === "getMe") {
          return new Response(
            JSON.stringify({
              ok: true,
              result: {
                id: botId,
                username: "paperclip_denial_test_bot",
                first_name: "Paperclip Denial Test",
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (method === "getWebhookInfo") {
          return new Response(
            JSON.stringify({ ok: true, result: { url: "" } }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        if (method === "setWebhook") {
          webhookSecret = String(
            (JSON.parse(body) as { secret_token?: unknown }).secret_token ?? "",
          );
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (method === "setMyCommands") {
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (method === "answerCallbackQuery") {
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (method === "sendMessage") {
          return new Response(
            JSON.stringify({
              ok: true,
              result: {
                message_id: 9001,
                from: { id: botId, is_bot: true },
                date: Math.floor(Date.now() / 1_000),
                chat: {
                  id: 417200359,
                  type: "private",
                  first_name: "Telegram User",
                },
                text: "This Paperclip action is no longer available.",
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`Unexpected Telegram API call: ${method}`);
      },
    ) as typeof globalThis.fetch;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = telegramFetch;
    const service = chatChannelService(db, {
      fetch: telegramFetch,
      heartbeat: {
        wakeup: receiptBackedWakeup(vi.fn(async () => ({ accepted: true }))),
      },
      publicBaseUrl: "https://paperclip.example",
    });
    try {
      const endpoint = await service.create(
        fixture.companyId,
        { provider: "telegram", assignedAgentId: fixture.assignedAgentId },
        "owner-user",
      );
      await service.configure(
        endpoint.id,
        { action: "configure", credentials: { botToken } },
        "owner-user",
      );
      expect(webhookSecret).not.toBe("");
      await db
        .update(chatEndpoints)
        .set({ status: "active" })
        .where(eq(chatEndpoints.id, endpoint.id));

      const actionId = "pcq:telegram-webhook-secret-token";
      const callbackData = telegramChatSdkCallbackData(actionId);
      const providerRequest = (
        updateId: number,
        callbackId: string,
        data = callbackData,
      ) =>
        new Request(
          `https://paperclip.example/api/chat-webhooks/${endpoint.publicId}/telegram`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-telegram-bot-api-secret-token": webhookSecret,
            },
            body: JSON.stringify({
              update_id: updateId,
              callback_query: {
                id: callbackId,
                data,
                from: {
                  id: 417200359,
                  is_bot: false,
                  first_name: "Telegram User",
                  username: "telegram-user",
                },
                message: {
                  message_id: 444,
                  from: { id: botId, is_bot: true },
                  date: Math.floor(Date.now() / 1_000),
                  chat: {
                    id: 417200359,
                    type: "private",
                    first_name: "Telegram User",
                  },
                  text: "Choose a priority",
                },
              },
            }),
          },
        );

      const first = await service.handleWebhook(
        endpoint.publicId,
        "telegram",
        providerRequest(7001, "denied-callback-1"),
      );
      expect(first.status).toBe(200);
      await expect(first.text()).resolves.toBe("OK");

      const providerRetry = await service.handleWebhook(
        endpoint.publicId,
        "telegram",
        providerRequest(7001, "denied-callback-1"),
      );
      expect(providerRetry.status).toBe(200);
      await expect(providerRetry.text()).resolves.toBe("OK");
      await vi.waitFor(() => {
        expect(
          apiCalls.filter(({ method }) => method === "sendMessage"),
        ).toHaveLength(1);
      });
      await vi.waitFor(async () => {
        const effects = await db
          .select({ status: chatActions.status })
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, endpoint.id),
              eq(chatActions.kind, "provider_effect"),
            ),
          );
        expect(effects).toEqual([{ status: "processed" }]);
      });

      const unrecordedActionId = "pcq:durable-denial-insert-failure";
      const unrecordedCallbackData =
        telegramChatSdkCallbackData(unrecordedActionId);
      const transactionSpy = vi
        .spyOn(db, "transaction")
        .mockRejectedValueOnce(
          new Error("injected denied-action persistence failure"),
        );
      let unrecorded: Response;
      try {
        unrecorded = await service.handleWebhook(
          endpoint.publicId,
          "telegram",
          providerRequest(
            7003,
            "denied-callback-persistence-failure",
            unrecordedCallbackData,
          ),
        );
      } finally {
        transactionSpy.mockRestore();
      }
      expect(unrecorded.status).toBe(503);
      expect(unrecorded.headers.get("retry-after")).toBe("1");

      const notices = apiCalls.filter(({ method }) => method === "sendMessage");
      expect(notices).toHaveLength(1);
      expect(JSON.parse(notices[0]!.body)).toMatchObject({
        chat_id: "417200359",
        text: "This Paperclip action is no longer available. Open the linked task or ask an operator to link this account.",
      });
      expect(notices[0]!.body).not.toContain(actionId);
      expect(notices[0]!.body).not.toContain(callbackData);
      expect(notices[0]!.body).not.toContain(unrecordedActionId);
      expect(notices[0]!.body).not.toContain(unrecordedCallbackData);
      expect(notices[0]!.body).not.toContain(webhookSecret);

      const denials = await db
        .select()
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(chatDeliveries.eventKind, "action"),
          ),
        );
      expect(denials).toHaveLength(1);
      expect(denials[0]).toMatchObject({
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
      });
      const serializedDenial = JSON.stringify(denials[0]);
      expect(serializedDenial).not.toContain(actionId);
      expect(serializedDenial).not.toContain(callbackData);
      expect(serializedDenial).not.toContain(webhookSecret);
    } finally {
      await service.shutdown();
      globalThis.fetch = previousFetch;
    }
  });
});
