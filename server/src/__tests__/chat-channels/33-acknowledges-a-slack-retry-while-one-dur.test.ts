import { registerChatActionWork } from "../../services/chat-action-work.js";
import { createDeliveryWorkCoordinator } from "../../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "../../services/delivery-work-notifications.js";
import { randomUUID } from "node:crypto";
import request, {  } from "supertest";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { expect, it, onTestFinished, vi } from "vitest";
import { activityLog, chatActions, chatConversations, chatDeliveries, chatEndpointResources, chatEndpoints, chatPublications, issueComments, issues } from "@paperclipai/db";
import { chatChannelService } from "../../services/chat-channels.js";
import { makeMessage, makeThread, routesApp } from ".././helpers/chat-channels-fixture.js";
import { configuredSlackEndpoint, configuredTelegramEndpoint, db, deliverMessage, describeChatChannelsSuite, qualifySetupRoundTrip, readChatConversationsByEndpointId, readChatDeliveriesByEndpointId, readChatPublicationsByEndpointId, readIssueCommentsByCompanyId, readIssuesByCompanyId, receiptBackedWakeup, retirePublicationFixture, seedCompany } from "../helpers/chat-channels-harness.js";








describeChatChannelsSuite("chat channels 33-acknowledges-a-slack-retry-while-one-dur", () => {
  it("acknowledges a Slack retry while one durable worker owns the unrecorded command root", async () => {
    const fixture = await seedCompany();
    const scheduledWork: Array<() => void> = [];
    const { callbacks, endpoint, runtime, service, wakeup } =
      await configuredSlackEndpoint(fixture, {
        // Transport and Paperclip admission are separate durable phases.
        // Run transport explicitly, then hold the delivery drain until reach
        // revocation has committed instead of racing their query scheduling.
        deferWebhookProcessing: true,
        scheduleDeferredWork: (task) => scheduledWork.push(task),
      });
    const command = endpoint.setup.command;
    if (!command) throw new Error("Slack endpoint did not expose its command");
    if (!callbacks.onSlashCommand) {
      throw new Error("Slack slash command callback was not registered");
    }
    const [resource] = await db
      .insert(chatEndpointResources)
      .values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        type: "channel",
        providerResourceId: "C-COMMAND-ORPHAN",
        label: "command-orphan",
        availability: "available",
        enabled: true,
      })
      .returning();
    let releasePost!: () => void;
    const post = vi.fn();
    const slashEvent = {
      endpointId: endpoint.id,
      provider: "slack" as const,
      event: {
        channel: {
          id: "C-COMMAND-ORPHAN",
          name: "command-orphan",
          isDM: false,
          post,
          postEphemeral: vi.fn(async () => ({
            id: "unexpected-ephemeral",
            threadId: "slack:C-COMMAND-ORPHAN:root",
          })),
        } as never,
        command,
        text: "do not acknowledge an unrecorded root",
        triggerId: "trigger-command-orphan",
        user: {
          userId: "U-COMMAND-ORPHAN",
          userName: "command-orphan",
          fullName: "Command Orphan User",
          isBot: false,
          isMe: false,
          isSystem: false,
        },
        raw: { trigger_id: "trigger-command-orphan" },
        adapter: {} as never,
        openModal: async () => undefined,
      },
    };

    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected Slack provider runtime");
    const postEntered = vi.fn();
    providerRuntime.postHook = async () => {
      postEntered();
      await new Promise<void>((resolve) => {
        releasePost = resolve;
      });
    };
    const owner = callbacks.onSlashCommand(slashEvent);
    await owner;
    expect(scheduledWork).toHaveLength(1);
    scheduledWork.shift()!();
    await vi.waitFor(() => expect(postEntered).toHaveBeenCalledTimes(1));
    await expect(
      Promise.race([
        Promise.resolve(callbacks
          .onSlashCommand(slashEvent))
          .then(() => "acknowledged" as const),
        new Promise<"timed_out">((resolve) =>
          setTimeout(() => resolve("timed_out"), 250),
        ),
      ]),
    ).resolves.toBe("acknowledged");
    // The duplicate's worker must converge on the resolving action without
    // starting a second provider root while the first request remains held.
    expect(scheduledWork).toHaveLength(1);
    scheduledWork.shift()!();

    const taskStart = await db
      .select({
        id: chatActions.id,
        principalId: chatActions.principalId,
        status: chatActions.status,
      })
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.kind, "slash_task_start"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    expect(taskStart).toMatchObject({ status: "resolving" });
    if (!taskStart?.principalId) {
      throw new Error("Expected the claimed Slack task-start principal");
    }
    const authorizationLockProbe = db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`chat-identity:${fixture.companyId}:${taskStart.principalId}`}, 0))`,
      );
      return "authorization-lock-released" as const;
    });
    const lockOutcome = await Promise.race([
      authorizationLockProbe,
      new Promise<"authorization-lock-held">((resolve) =>
        setTimeout(() => resolve("authorization-lock-held"), 500),
      ),
    ]);
    if (lockOutcome !== "authorization-lock-released") {
      releasePost();
      await owner;
      await authorizationLockProbe;
    }
    expect(lockOutcome).toBe("authorization-lock-released");

    let revocationSettled = false;
    const revokeReach = service
      .replaceResources(endpoint.id, [{ id: resource!.id, enabled: false }])
      .then(() => {
        revocationSettled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(revocationSettled).toBe(false);
    await expect(
      db
        .select({ enabled: chatEndpointResources.enabled })
        .from(chatEndpointResources)
        .where(eq(chatEndpointResources.id, resource!.id)),
    ).resolves.toEqual([{ enabled: true }]);
    expect(postEntered).toHaveBeenCalledTimes(1);
    releasePost();
    await revokeReach;
    expect(revocationSettled).toBe(true);
    providerRuntime.postHook = undefined;
    expect(post).not.toHaveBeenCalled();
    await vi.waitFor(async () => {
      const [action] = await db
        .select({ status: chatActions.status })
        .from(chatActions)
        .where(eq(chatActions.id, taskStart.id));
      expect(action?.status).toBe("processed");
    });
    const [stagedDelivery] = await readChatDeliveriesByEndpointId(endpoint.id);
    expect(stagedDelivery).toMatchObject({ state: "received" });
    if (!stagedDelivery)
      throw new Error("Expected the durable Slack starter receipt");
    expect(stagedDelivery.normalizedEvent).toMatchObject({
      admission: { origin: "provider_confirmed_action" },
    });
    expect(wakeup).not.toHaveBeenCalled();
    await expect(service.listConversations(endpoint.id)).resolves.toEqual([]);
    await expect(
      db
        .select({ enabled: chatEndpointResources.enabled })
        .from(chatEndpointResources)
        .where(eq(chatEndpointResources.id, resource!.id)),
    ).resolves.toEqual([{ enabled: false }]);

    // Expire only this receipt's reorder window, then drain after revocation.
    // Provider acceptance is not a grant to create a Paperclip task later.
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(chatDeliveries.id, stagedDelivery.id));
    await service.processPendingDeliveries(1, stagedDelivery.id);
    await expect(
      db
        .select({
          state: chatDeliveries.state,
          principalId: chatDeliveries.principalId,
          redactedError: chatDeliveries.redactedError,
          normalizedEvent: chatDeliveries.normalizedEvent,
        })
        .from(chatDeliveries)
        .where(eq(chatDeliveries.id, stagedDelivery.id)),
    ).resolves.toEqual([
      expect.objectContaining({
        state: "filtered",
        principalId: null,
        redactedError: "Destination is not enabled in Paperclip",
        normalizedEvent: expect.objectContaining({
          filtering: { contentRetained: false },
        }),
      }),
    ]);
    const [filteredDelivery] = await db
      .select({ normalizedEvent: chatDeliveries.normalizedEvent })
      .from(chatDeliveries)
      .where(eq(chatDeliveries.id, stagedDelivery.id));
    expect(JSON.stringify(filteredDelivery?.normalizedEvent)).not.toContain(
      slashEvent.event.text,
    );
    await expect(service.listConversations(endpoint.id)).resolves.toEqual([]);
    await expect(
      db
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.companyId, fixture.companyId)),
    ).resolves.toEqual([]);
    expect(wakeup).not.toHaveBeenCalled();
    expect(providerRuntime.posts).toEqual([
      {
        threadId: "slack:C-COMMAND-ORPHAN:",
        text: "Starting a task…",
      },
    ]);
    await service.shutdown();
  });

  it("treats D-prefixed Slack status, new, and close callbacks as DM task controls even when the SDK flag is false", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture);
    if (!callbacks.onSlashCommand) {
      throw new Error("Slack slash command callback was not registered");
    }
    const dm = makeThread({
      channelId: "D09CONTROLS",
      id: "slack:D09CONTROLS:",
      isDM: true,
      name: "direct message",
    });
    const firstProviderTimestamp = `${Math.floor(Date.now() / 1_000) - 5}.000001`;
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: dm.thread,
      message: makeMessage({
        id: firstProviderTimestamp,
        raw: { ts: firstProviderTimestamp },
        text: "Start the first DM task",
        userId: "U-DM-CONTROLS",
      }),
      trigger: "direct_message",
    });
    await qualifySetupRoundTrip(service, endpoint.id, "U-DM-CONTROLS");
    await service.test(endpoint.id);
    const command = endpoint.setup.command;
    if (!command) throw new Error("Slack endpoint did not expose its command");
    const post = vi.fn(async () => ({
      id: "unexpected-control-root",
      threadId: dm.thread.id,
    }));
    const postEphemeral = vi.fn(async () => ({
      id: "unexpected-control-ephemeral",
      threadId: dm.thread.id,
    }));
    const slashChannel = {
      id: "slack:D09CONTROLS",
      name: "direct message",
      // Match the real Slack SDK slash callback observed during qualification:
      // the signed provider id is a DM even though this convenience flag is
      // false.
      isDM: false,
      post,
      postEphemeral,
    } as never;
    const invokeControl = async (control: "status" | "new" | "close") => {
      const reactionCount =
        runtime.endpoints.get(endpoint.id)?.reactions.length ?? 0;
      await callbacks.onSlashCommand!({
        endpointId: endpoint.id,
        provider: "slack",
        event: {
          channel: slashChannel,
          command,
          text: control,
          triggerId: `trigger-${control}-${randomUUID()}`,
          user: {
            userId: "U-DM-CONTROLS",
            userName: "dm-controller",
            fullName: "DM Controller",
            isBot: false,
            isMe: false,
            isSystem: false,
          },
          raw: { command, text: control },
          adapter: {} as never,
          openModal: async () => undefined,
        },
      });
      expect(runtime.endpoints.get(endpoint.id)?.reactions).toHaveLength(
        reactionCount,
      );
    };
    const controlPostOffset =
      runtime.endpoints.get(endpoint.id)?.posts.length ?? 0;
    const issuesBeforeStatus = await readIssuesByCompanyId(fixture.companyId);
    const firstIssue = issuesBeforeStatus.find(
      (issue) => issue.title === "Start the first DM task",
    );
    if (!firstIssue) throw new Error("First Slack DM task was not created");
    await db
      .update(chatConversations)
      .set({ providerUrl: null })
      .where(eq(chatConversations.endpointId, endpoint.id));
    await expect(service.listConversations(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        externalUrl:
          "https://slack.com/app_redirect?channel=D09CONTROLS&team=T-PAPERCLIP",
      }),
    ]);
    await invokeControl("status");
    expect(
      await readIssuesByCompanyId(fixture.companyId),
    ).toHaveLength(issuesBeforeStatus.length);
    await service.processPendingPublications();
    expect(runtime.endpoints.get(endpoint.id)?.posts.at(-1)?.text).toMatch(
      /— todo$/,
    );

    await invokeControl("new");
    expect(
      await readIssuesByCompanyId(fixture.companyId),
    ).toHaveLength(issuesBeforeStatus.length);
    await expect(service.listConversations(endpoint.id)).resolves.toEqual([
      expect.objectContaining({ state: "active" }),
    ]);
    await service.processPendingPublications();
    await expect(service.listConversations(endpoint.id)).resolves.toEqual([
      expect.objectContaining({ state: "completed" }),
    ]);

    const secondProviderTime = Date.now();
    const secondProviderTimestamp = `${Math.floor(secondProviderTime / 1_000)}.${String((secondProviderTime % 1_000) * 1_000).padStart(6, "0")}`;
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: dm.thread,
      message: makeMessage({
        id: secondProviderTimestamp,
        raw: { ts: secondProviderTimestamp },
        text: "Start the second DM task",
        userId: "U-DM-CONTROLS",
      }),
      trigger: "direct_message",
    });
    const issuesBeforeClose = await readIssuesByCompanyId(fixture.companyId);
    expect(issuesBeforeClose).toHaveLength(issuesBeforeStatus.length + 1);
    await invokeControl("close");
    expect(
      await readIssuesByCompanyId(fixture.companyId),
    ).toHaveLength(issuesBeforeClose.length);
    expect(
      (await service.listConversations(endpoint.id)).map(
        (conversation) => conversation.state,
      ),
    ).toContain("active");
    await service.processPendingPublications();
    expect(
      (await service.listConversations(endpoint.id)).map(
        (conversation) => conversation.state,
      ),
    ).toEqual(["completed", "completed"]);
    expect(
      await db
        .select({ id: issues.id, status: issues.status })
        .from(issues)
        .where(eq(issues.companyId, fixture.companyId))
        .orderBy(asc(issues.id)),
    ).toEqual(
      issuesBeforeClose
        .map(({ id, status }) => ({ id, status }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    );
    const controlAuthorizations = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.kind, "task_control_authorization"),
        ),
      );
    expect(controlAuthorizations).toHaveLength(3);
    expect(
      controlAuthorizations.map((authorization) => ({
        kind: authorization.kind,
        status: authorization.status,
      })),
    ).toEqual([
      { kind: "task_control_authorization", status: "processed" },
      { kind: "task_control_authorization", status: "processed" },
      { kind: "task_control_authorization", status: "processed" },
    ]);
    expect(
      runtime.endpoints
        .get(endpoint.id)
        ?.posts.slice(controlPostOffset)
        .map((providerPost) => ({
          threadId: providerPost.threadId,
          text: providerPost.text,
        })),
    ).toEqual([
      {
        threadId: dm.thread.id,
        text: `${firstIssue.identifier}: Start the first DM task — todo`,
      },
      {
        threadId: dm.thread.id,
        text: "Send your request to start a new Paperclip task.",
      },
      {
        threadId: dm.thread.id,
        text: "This chat conversation is closed. Send another message to start a new task.",
      },
    ]);
    expect(
      (
        await readChatPublicationsByEndpointId(endpoint.id)
          .orderBy(asc(chatPublications.createdAt), asc(chatPublications.id))
      )
        .filter((publication) =>
          publication.idempotencyKey.startsWith("control:"),
        )
        .map((publication) => publication.idempotencyKey.split(":")[1]),
    ).toEqual(["status", "new", "close"]);
    expect(post).not.toHaveBeenCalled();
    expect(postEphemeral).not.toHaveBeenCalled();
    // Each slash control asserted above that it added no reaction. The second
    // real DM task message is still free to receive its normal acknowledgement.
    const controlDeliveries = (
      await readChatDeliveriesByEndpointId(endpoint.id)
    ).filter((delivery) => {
      const normalized = delivery.normalizedEvent as {
        message?: { text?: unknown };
      };
      return ["/status", "/new", "/close"].includes(
        String(normalized.message?.text),
      );
    });
    expect(controlDeliveries).toHaveLength(3);
    expect(controlDeliveries).toEqual(
      expect.arrayContaining(
        ["/status", "/new", "/close"].map((text) =>
          expect.objectContaining({
            state: "processed",
            redactedError: null,
            normalizedEvent: expect.objectContaining({
              acknowledgement: { receiptReactionSupported: false },
              message: expect.objectContaining({ text }),
            }),
          }),
        ),
      ),
    );
  });

  it("delivers queued provider notices from commit wakes without the deferred fast path", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, runtime } =
      await configuredSlackEndpoint(fixture, { scheduleDeferredWork: () => undefined });
    if (!callbacks.onSlashCommand) {
      throw new Error("Slack slash command callback was not registered");
    }
    await db.insert(chatEndpointResources).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      type: "channel",
      providerResourceId: "C-CONTROL-GUIDANCE",
      label: "control-guidance",
      availability: "available",
      enabled: true,
    });
    const command = endpoint.setup.command;
    if (!command) throw new Error("Slack endpoint did not expose its command");
    const post = vi.fn(async () => ({
      id: "unexpected-channel-control-post",
      threadId: "slack:C-CONTROL-GUIDANCE:root",
    }));
    const postEphemeral = vi.fn(async () => ({
      id: "channel-control-guidance",
      threadId: "slack:C-CONTROL-GUIDANCE:root",
    }));
    const providerRuntime = runtime.endpoints.get(endpoint.id)!;
    vi.spyOn(providerRuntime, "thread").mockReturnValue({ post, postEphemeral } as never);
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: () => undefined });
    onTestFinished(async () => { await coordinator.stop(); });
    await registerChatActionWork(coordinator, service, () => true).ready;
    for (const control of ["status"] as const) {
      await callbacks.onSlashCommand({
        endpointId: endpoint.id,
        provider: "slack",
        event: {
          channel: {
            id: "slack:C-CONTROL-GUIDANCE",
            name: "control-guidance",
            isDM: false,
            post,
            postEphemeral,
          } as never,
          command,
          text: control,
          triggerId: `channel-control-${control}`,
          user: {
            userId: "U-CHANNEL-CONTROLLER",
            userName: "channel-controller",
            fullName: "Channel Controller",
            isBot: false,
            isMe: false,
            isSystem: false,
          },
          raw: { command, text: control },
          adapter: {} as never,
          openModal: async () => undefined,
        },
      });
    }
    await expect.poll(async () => db.select({ status: chatActions.status }).from(chatActions)
      .where(and(eq(chatActions.endpointId, endpoint.id), eq(chatActions.kind, "provider_effect"))),
      { timeout: 10_000 }).toEqual([{ status: "processed" }]);
    expect(postEphemeral).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
    expect(await service.nextChatActionAt("provider_effect")).toBeNull();
    await coordinator.stop();
  });

  it("returns ephemeral guidance for exact Slack controls in channels without creating tasks or actions", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service } =
      await configuredSlackEndpoint(fixture);
    if (!callbacks.onSlashCommand) {
      throw new Error("Slack slash command callback was not registered");
    }
    await db.insert(chatEndpointResources).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      type: "channel",
      providerResourceId: "C-CONTROL-GUIDANCE",
      label: "control-guidance",
      availability: "available",
      enabled: true,
    });
    const command = endpoint.setup.command;
    if (!command) throw new Error("Slack endpoint did not expose its command");
    const post = vi.fn(async () => ({
      id: "unexpected-channel-control-post",
      threadId: "slack:C-CONTROL-GUIDANCE:root",
    }));
    const postEphemeral = vi.fn(async (_user?: unknown, _message?: unknown, _options?: unknown) => ({
      id: "channel-control-guidance",
      threadId: "slack:C-CONTROL-GUIDANCE:root",
    }));
    for (const control of ["status", "new", "close"] as const) {
      await callbacks.onSlashCommand({
        endpointId: endpoint.id,
        provider: "slack",
        event: {
          channel: {
            id: "slack:C-CONTROL-GUIDANCE",
            name: "control-guidance",
            isDM: false,
            post,
            postEphemeral,
          } as never,
          command,
          text: control,
          triggerId: `channel-control-${control}`,
          user: {
            userId: "U-CHANNEL-CONTROLLER",
            userName: "channel-controller",
            fullName: "Channel Controller",
            isBot: false,
            isMe: false,
            isSystem: false,
          },
          raw: { command, text: control },
          adapter: {} as never,
          openModal: async () => undefined,
        },
      });
    }
    expect(post).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(postEphemeral).toHaveBeenCalledTimes(3));
    for (const call of postEphemeral.mock.calls) {
      expect(call[1]).toBe(
        "Use status, new, and close in a direct message with this agent. In a channel, open the Paperclip task from its Slack thread.",
      );
      expect(call[2]).toEqual({ fallbackToDM: false });
    }
    expect(await service.listConversations(endpoint.id)).toEqual([]);
    expect(
      await readIssuesByCompanyId(fixture.companyId),
    ).toHaveLength(0);
    // The ephemeral post is observable before its provider_effect row
    // settles, so under suite load the third row can still be
    // mid-settlement when the mock resolves (drew a not-yet-processed row
    // in CI on 2026-09-10). Wait for the bookkeeping, bounded, like the
    // durable-receipt paths above do.
    await vi.waitFor(async () => {
      expect(
        await db
          .select()
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, endpoint.id),
              eq(chatActions.kind, "provider_effect"),
            ),
          ),
      ).toEqual([
        expect.objectContaining({ kind: "provider_effect", status: "processed" }),
        expect.objectContaining({ kind: "provider_effect", status: "processed" }),
        expect.objectContaining({ kind: "provider_effect", status: "processed" }),
      ]);
    });
  });

  it("keeps Telegram start and unknown commands as terse guidance without creating work", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service, wakeup } =
      await configuredTelegramEndpoint(fixture);
    if (!callbacks.onSlashCommand) {
      throw new Error("Telegram slash command callback was not registered");
    }
    const channel = {
      id: "telegram:77112233",
      name: "Telegram direct message",
      isDM: true,
    } as never;
    const invoke = async (command: string, text: string, messageId: number) => {
      await callbacks.onSlashCommand!({
        endpointId: endpoint.id,
        provider: "telegram",
        event: {
          channel,
          command,
          text,
          user: {
            userId: "77112233",
            userName: "telegram-user",
            fullName: "Telegram User",
            isBot: false,
            isMe: false,
            isSystem: false,
          },
          raw: {
            message_id: messageId,
            date: 1_788_620_500 + messageId,
            chat: { id: 77112233, type: "private" },
            from: { id: 77112233, is_bot: false },
            text: `${command} ${text}`.trim(),
            entities: [
              { offset: 0, length: command.length, type: "bot_command" },
            ],
          },
          adapter: {} as never,
          openModal: async () => undefined,
        },
      });
    };
    await invoke("/start", "ignored payload", 501);
    await invoke("/danger", "create an administrator action", 502);

    expect(
      runtime.endpoints.get(endpoint.id)?.posts.map((post) => post.text),
    ).toEqual([
      expect.stringMatching(
        /^Send a direct message to start work with Maya\. In a group, use \/task@paperclip_\d+_bot followed by your request\./,
      ),
      expect.stringMatching(
        /^Available commands: \/task@paperclip_\d+_bot followed by your request, \/status, \/new, and \/close\.$/,
      ),
    ]);
    expect(wakeup).not.toHaveBeenCalled();
    expect(await service.listConversations(endpoint.id)).toEqual([]);
    expect(
      await readIssuesByCompanyId(fixture.companyId),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(chatActions.kind, "provider_effect"),
          ),
        ),
    ).toEqual([
      expect.objectContaining({ kind: "provider_effect", status: "processed" }),
      expect.objectContaining({ kind: "provider_effect", status: "processed" }),
    ]);
    const deliveries = await readChatDeliveriesByEndpointId(endpoint.id);
    expect(deliveries).toHaveLength(2);
    expect(deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerEventId: "telegram:77112233:77112233:501",
          state: "processed",
          conversationId: null,
        }),
        expect.objectContaining({
          providerEventId: "telegram:77112233:77112233:502",
          state: "processed",
          conversationId: null,
        }),
      ]),
    );
  });

  it("does not commit a Telegram close control when its provider reply is definitively rejected", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredTelegramEndpoint(fixture);
    if (!callbacks.onSlashCommand) {
      throw new Error("Telegram slash command callback was not registered");
    }
    const dm = makeThread({
      channelId: "78112233",
      id: "telegram:78112233",
      isDM: true,
      name: "Telegram direct message",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: dm.thread,
      message: makeMessage({
        id: "78112233:1",
        raw: { message_id: 1 },
        text: "Start a task before close",
        userId: "78112233",
      }),
      trigger: "direct_message",
    });
    await qualifySetupRoundTrip(service, endpoint.id, "78112233");
    await service.test(endpoint.id);
    await db
      .update(chatConversations)
      .set({ state: "completed", updatedAt: new Date() })
      .where(eq(chatConversations.endpointId, endpoint.id));
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected Telegram runtime");
    providerRuntime.postError = Object.assign(
      new Error("Telegram rejected the control reply"),
      {
        name: "ValidationError",
        code: "VALIDATION_ERROR",
      },
    );
    const closeEvent = {
      endpointId: endpoint.id,
      provider: "telegram" as const,
      event: {
        channel: {
          id: "telegram:78112233",
          name: "Telegram direct message",
          isDM: true,
        } as never,
        command: "/close",
        text: "",
        user: {
          userId: "78112233",
          userName: "telegram-user",
          fullName: "Telegram User",
          isBot: false,
          isMe: false,
          isSystem: false,
        },
        raw: {
          message_id: 800,
          date: 1_788_622_800,
          chat: { id: 78112233, type: "private" },
          from: { id: 78112233, is_bot: false },
          text: "/close",
          entities: [{ offset: 0, length: 6, type: "bot_command" }],
        },
        adapter: {} as never,
        openModal: async () => undefined,
      },
    };

    await expect(callbacks.onSlashCommand(closeEvent)).rejects.toThrow(
      "Telegram rejected the control reply",
    );
    await expect(service.listConversations(endpoint.id)).resolves.toEqual([
      expect.objectContaining({ state: "completed" }),
    ]);
    await expect(
      db
        .select({ status: chatActions.status })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(chatActions.kind, "provider_effect"),
          ),
        ),
    ).resolves.toEqual([{ status: "failed" }]);
    await expect(
      db
        .select({ state: chatDeliveries.state })
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(
              chatDeliveries.providerEventId,
              "telegram:78112233:78112233:800",
            ),
          ),
        ),
    ).resolves.toEqual([{ state: "failed" }]);
    expect(providerRuntime.posts).toHaveLength(0);

    await expect(callbacks.onSlashCommand(closeEvent)).resolves.toBeUndefined();
    expect(providerRuntime.posts).toHaveLength(0);
    await expect(service.listConversations(endpoint.id)).resolves.toEqual([
      expect.objectContaining({ state: "completed" }),
    ]);
  });

  it("quarantines a Telegram control when the reply lands but its state commit crashes", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredTelegramEndpoint(fixture);
    if (!callbacks.onSlashCommand) {
      throw new Error("Telegram slash command callback was not registered");
    }
    const dm = makeThread({
      channelId: "79112233",
      id: "telegram:79112233",
      isDM: true,
      name: "Telegram direct message",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: dm.thread,
      message: makeMessage({
        id: "79112233:1",
        raw: { message_id: 1 },
        text: "Start a task before ambiguous close",
        userId: "79112233",
      }),
      trigger: "direct_message",
    });
    await qualifySetupRoundTrip(service, endpoint.id, "79112233");
    await service.test(endpoint.id);
    await db
      .update(chatConversations)
      .set({ state: "completed", updatedAt: new Date() })
      .where(eq(chatConversations.endpointId, endpoint.id));
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected Telegram runtime");
    const closeEvent = {
      endpointId: endpoint.id,
      provider: "telegram" as const,
      event: {
        channel: {
          id: "telegram:79112233",
          name: "Telegram direct message",
          isDM: true,
        } as never,
        command: "/close",
        text: "",
        user: {
          userId: "79112233",
          userName: "telegram-user",
          fullName: "Telegram User",
          isBot: false,
          isMe: false,
          isSystem: false,
        },
        raw: {
          message_id: 801,
          date: 1_788_622_801,
          chat: { id: 79112233, type: "private" },
          from: { id: 79112233, is_bot: false },
          text: "/close",
          entities: [{ offset: 0, length: 6, type: "bot_command" }],
        },
        adapter: {} as never,
        openModal: async () => undefined,
      },
    };
    const originalTransaction = db.transaction.bind(db);
    let injectedCrash = false;
    const transactionSpy = vi
      .spyOn(db, "transaction")
      .mockImplementation((async (
        ...args: Parameters<typeof originalTransaction>
      ) => {
        const [callback, config] = args;
        return originalTransaction(async (tx) => {
          const result = await callback(tx);
          if (!injectedCrash && providerRuntime.posts.length === 1) {
            injectedCrash = true;
            throw new Error("injected provider-effect commit crash");
          }
          return result;
        }, config);
      }) as typeof db.transaction);
    try {
      await expect(callbacks.onSlashCommand(closeEvent)).rejects.toThrow(
        "injected provider-effect commit crash",
      );
    } finally {
      transactionSpy.mockRestore();
    }

    expect(injectedCrash).toBe(true);
    expect(providerRuntime.posts).toHaveLength(1);
    await expect(service.listConversations(endpoint.id)).resolves.toEqual([
      expect.objectContaining({ state: "completed" }),
    ]);
    await expect(
      db
        .select({ status: chatActions.status })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(chatActions.kind, "provider_effect"),
          ),
        ),
    ).resolves.toEqual([{ status: "delivery_unknown" }]);
    await expect(
      db
        .select({ state: chatDeliveries.state })
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(
              chatDeliveries.providerEventId,
              "telegram:79112233:79112233:801",
            ),
          ),
        ),
    ).resolves.toEqual([{ state: "failed" }]);

    await expect(callbacks.onSlashCommand(closeEvent)).resolves.toBeUndefined();
    await service.processPendingProviderEffects();
    expect(providerRuntime.posts).toHaveLength(1);
    await expect(service.listConversations(endpoint.id)).resolves.toEqual([
      expect.objectContaining({ state: "completed" }),
    ]);
  });

  it("resolves ambiguous provider effects explicitly and never lets terminal failures starve reconciliation", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredTelegramEndpoint(fixture);
    const workWake = vi.fn();
    const stopWorkObserver = subscribeDeliveryWork(db, DELIVERY_QUEUES.chatProviderEffects, workWake);
    onTestFinished(() => { stopWorkObserver(); expect(workWake).toHaveBeenCalled(); });
    if (!callbacks.onSlashCommand) {
      throw new Error("Telegram slash command callback was not registered");
    }
    const dm = makeThread({
      channelId: "71112233",
      id: "telegram:71112233",
      isDM: true,
      name: "Telegram direct message",
    });

    await callbacks.onSlashCommand({
      endpointId: endpoint.id,
      provider: "telegram",
      event: {
        channel: dm.thread as never,
        command: "/start",
        text: "",
        user: {
          userId: "71112233",
          userName: "telegram-user",
          fullName: "Telegram User",
          isBot: false,
          isMe: false,
          isSystem: false,
        },
        raw: {
          message_id: 901,
          date: 1_788_622_901,
          chat: { id: 71112233, type: "private" },
          from: { id: 71112233, is_bot: false },
          text: "/start",
          entities: [{ offset: 0, length: 6, type: "bot_command" }],
        },
        adapter: {} as never,
        openModal: async () => undefined,
      },
    });
    const seedEffect = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.kind, "provider_effect"),
        ),
      )
      .then((rows) => rows[0]);
    if (!seedEffect) throw new Error("Expected a provider-effect fixture");

    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: dm.thread,
      message: makeMessage({
        id: "71112233:902",
        raw: { message_id: 902 },
        text: "Create a task for provider-effect recovery",
        userId: "71112233",
      }),
      trigger: "direct_message",
    });
    await qualifySetupRoundTrip(service, endpoint.id, "71112233");
    await service.test(endpoint.id);
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    if (!conversation) throw new Error("Expected a bound conversation");
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected Telegram runtime");
    const initialPostCount = providerRuntime.posts.length;
    const app = routesApp(db, fixture.companyId, service);

    const insertAmbiguousEffect = async (suffix: string, text: string) => {
      const [delivery] = await db
        .insert(chatDeliveries)
        .values({
          companyId: fixture.companyId,
          endpointId: endpoint.id,
          conversationId: conversation.id,
          providerEventId: `provider-effect-resolution:${suffix}`,
          deduplicationKey: `provider-effect-resolution:${suffix}`,
          eventKind: "message",
          normalizedEvent: {},
          state: "failed",
          redactedError: "Provider response is unconfirmed",
        })
        .returning();
      const [action] = await db
        .insert(chatActions)
        .values({
          companyId: fixture.companyId,
          endpointId: endpoint.id,
          deliveryId: delivery!.id,
          conversationId: conversation.id,
          principalId: seedEffect.principalId,
          kind: "provider_effect",
          providerActionId: `provider_effect:resolution:${suffix}`,
          payload: {
            ...seedEffect.payload,
            text,
            settleDelivery: true,
            completeConversationId: conversation.id,
          },
          status: "delivery_unknown",
          result: {
            code: "provider_effect_delivery_unknown",
            attempts: 1,
            retryable: false,
          },
        })
        .returning();
      return { action: action!, delivery: delivery! };
    };

    const marked = await insertAmbiguousEffect("mark", "Close after mark");
    const activity = await service.listActivity(endpoint.id);
    expect(activity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: marked.action.id,
          kind: "action",
          actionType: "provider_effect",
          status: "delivery_unknown",
          replayable: false,
          resolutionActions: ["mark_delivered", "retry_anyway", "cancel"],
        }),
        expect.objectContaining({
          id: marked.delivery.id,
          kind: "delivery",
          status: "failed",
          replayable: false,
        }),
      ]),
    );
    await request(app)
      .post(
        `/api/chat-endpoints/${endpoint.id}/deliveries/${marked.delivery.id}/replay`,
      )
      .send({})
      .expect(409);
    await request(app)
      .post(
        `/api/chat-endpoints/${endpoint.id}/actions/${marked.action.id}/resolve`,
      )
      .send({ action: "mark_delivered" })
      .expect(204);
    await expect(
      db
        .select({ status: chatActions.status })
        .from(chatActions)
        .where(eq(chatActions.id, marked.action.id)),
    ).resolves.toEqual([{ status: "processed" }]);
    await expect(
      db
        .select({ state: chatDeliveries.state })
        .from(chatDeliveries)
        .where(eq(chatDeliveries.id, marked.delivery.id)),
    ).resolves.toEqual([{ state: "processed" }]);
    await expect(
      db
        .select({ state: chatConversations.state })
        .from(chatConversations)
        .where(eq(chatConversations.id, conversation.id)),
    ).resolves.toEqual([{ state: "completed" }]);
    expect(providerRuntime.posts).toHaveLength(initialPostCount);

    await db
      .update(chatConversations)
      .set({ state: "active", updatedAt: new Date() })
      .where(eq(chatConversations.id, conversation.id));
    const retried = await insertAmbiguousEffect("retry", "Close after retry");
    const retryResponses = await Promise.all([
      request(app)
        .post(
          `/api/chat-endpoints/${endpoint.id}/actions/${retried.action.id}/resolve`,
        )
        .send({ action: "retry_anyway" }),
      request(app)
        .post(
          `/api/chat-endpoints/${endpoint.id}/actions/${retried.action.id}/resolve`,
        )
        .send({ action: "retry_anyway" }),
    ]);
    expect(retryResponses.map((response) => response.status).sort()).toEqual([
      204, 409,
    ]);
    expect(providerRuntime.posts).toHaveLength(initialPostCount + 1);
    await expect(
      db
        .select({ status: chatActions.status })
        .from(chatActions)
        .where(eq(chatActions.id, retried.action.id)),
    ).resolves.toEqual([{ status: "processed" }]);
    await expect(
      db
        .select({ state: chatDeliveries.state })
        .from(chatDeliveries)
        .where(eq(chatDeliveries.id, retried.delivery.id)),
    ).resolves.toEqual([{ state: "processed" }]);

    await db
      .update(chatConversations)
      .set({ state: "active", updatedAt: new Date() })
      .where(eq(chatConversations.id, conversation.id));
    const cancelled = await insertAmbiguousEffect(
      "cancel",
      "Do not send this reply",
    );
    await request(app)
      .post(
        `/api/chat-endpoints/${endpoint.id}/actions/${cancelled.action.id}/resolve`,
      )
      .send({ action: "cancel" })
      .expect(204);
    await expect(
      db
        .select({ status: chatActions.status })
        .from(chatActions)
        .where(eq(chatActions.id, cancelled.action.id)),
    ).resolves.toEqual([{ status: "cancelled" }]);
    await expect(
      db
        .select({ state: chatDeliveries.state })
        .from(chatDeliveries)
        .where(eq(chatDeliveries.id, cancelled.delivery.id)),
    ).resolves.toEqual([{ state: "filtered" }]);
    await expect(
      db
        .select({ state: chatConversations.state })
        .from(chatConversations)
        .where(eq(chatConversations.id, conversation.id)),
    ).resolves.toEqual([{ state: "active" }]);
    expect(providerRuntime.posts).toHaveLength(initialPostCount + 1);

    const terminalCreatedAt = new Date("2026-01-01T00:00:00.000Z");
    await db.insert(chatActions).values(
      Array.from({ length: 25 }, (_, index) => ({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        kind: "provider_effect",
        providerActionId: `provider_effect:terminal:${randomUUID()}`,
        payload: seedEffect.payload,
        status: "failed",
        result: { retryable: false },
        createdAt: new Date(terminalCreatedAt.getTime() + index),
        updatedAt: terminalCreatedAt,
      })),
    );
    const [actionable] = await db
      .insert(chatActions)
      .values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        principalId: seedEffect.principalId,
        kind: "provider_effect",
        providerActionId: `provider_effect:actionable:${randomUUID()}`,
        payload: {
          ...seedEffect.payload,
          text: "This newer actionable effect must not starve",
          settleDelivery: false,
          completeConversationId: undefined,
        },
        status: "received",
      })
      .returning();
    await service.processPendingProviderEffects(1);
    await expect(
      db
        .select({ status: chatActions.status })
        .from(chatActions)
        .where(eq(chatActions.id, actionable!.id)),
    ).resolves.toEqual([{ status: "processed" }]);

    await expect(
      db
        .select({ action: activityLog.action, actorId: activityLog.actorId })
        .from(activityLog)
        .where(
          inArray(activityLog.entityId, [
            marked.action.id,
            retried.action.id,
            cancelled.action.id,
          ]),
        ),
    ).resolves.toEqual(
      expect.arrayContaining([
        {
          action: "chat.provider_effect_mark_delivered",
          actorId: "owner-user",
        },
        {
          action: "chat.provider_effect_retry_anyway",
          actorId: "owner-user",
        },
        {
          action: "chat.provider_effect_cancel",
          actorId: "owner-user",
        },
      ]),
    );
  });

  it("acknowledges a denied Slack action before its durable notice completes and deduplicates redelivery", async () => {
    const scheduled: Array<() => void> = [];
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture, {
        scheduleDeferredWork: (task) => scheduled.push(task),
      });
    if (!callbacks.onAction) {
      throw new Error("Slack action callback was not registered");
    }
    const channel = makeThread({
      channelId: "C-DENIAL-OUTBOX",
      id: "slack:C-DENIAL-OUTBOX:9000.1",
      name: "denial-outbox",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: channel.thread,
      message: makeMessage({
        id: "9000.1",
        text: "@maya create a denial fixture",
        mentioned: true,
        userId: "U-DENIAL-OUTBOX",
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id, "U-DENIAL-OUTBOX");
    await service.test(endpoint.id);
    // Setup publishes its own final and schedules exact-source eyes cleanup.
    // Settle and identify that work before measuring the denied-action queue.
    const setupRemovals = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.kind, "receipt_reaction"),
          sql`${chatActions.payload}->>'operation' = 'remove'`,
        ),
      );
    expect(setupRemovals).toHaveLength(1);
    const setupRemoval = setupRemovals[0]!;
    expect(setupRemoval).toMatchObject({
      providerActionId: `receipt_reaction_remove:${setupRemoval.deliveryId}`,
      status: "received",
      payload: {
        operation: "remove",
        reaction: "eyes",
        threadId: channel.thread.id,
        messageId: expect.stringMatching(/^setup-follow-up-/),
      },
    });
    expect(scheduled).toHaveLength(1);
    expect(channel.postEphemeral).not.toHaveBeenCalled();
    scheduled.shift()!();
    await vi.waitFor(async () => {
      const removal = await db
        .select({ status: chatActions.status })
        .from(chatActions)
        .where(eq(chatActions.id, setupRemoval.id));
      expect(removal).toEqual([{ status: "processed" }]);
    });
    const providerRuntime = runtime.endpoints.get(endpoint.id)!;
    expect(providerRuntime.removedReactions).toEqual([
      {
        threadId: channel.thread.id,
        messageId: setupRemoval.payload.messageId,
        emoji: "eyes",
      },
    ]);
    expect(scheduled).toHaveLength(0);
    expect(channel.postEphemeral).not.toHaveBeenCalled();
    let releaseNotice!: () => void;
    const noticeRelease = new Promise<void>((resolve) => {
      releaseNotice = resolve;
    });
    channel.postEphemeral.mockImplementation(async () => {
      await noticeRelease;
      return {
        id: "ephemeral-denial-outbox",
        threadId: channel.thread.id,
        usedFallback: false,
      };
    });
    const deniedAction = {
      endpointId: endpoint.id,
      provider: "slack" as const,
      event: {
        actionId: "pcq:unissued-denial-outbox",
        adapter: {} as never,
        messageId: "outbound-unissued",
        openModal: async () => undefined,
        raw: { type: "block_actions" },
        thread: channel.thread,
        threadId: channel.thread.id,
        user: {
          userId: "U-DENIAL-OUTBOX",
          userName: "denial-user",
          fullName: "Denial User",
          isBot: false,
          isMe: false,
          isSystem: false,
        },
        value: "unissued",
      },
    };

    await expect(callbacks.onAction(deniedAction)).resolves.toBeUndefined();
    expect(channel.postEphemeral).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);
    scheduled.shift()!();
    await vi.waitFor(() =>
      expect(channel.postEphemeral).toHaveBeenCalledTimes(1),
    );
    await expect(callbacks.onAction(deniedAction)).resolves.toBeUndefined();
    expect(scheduled).toHaveLength(0);
    expect(channel.postEphemeral).toHaveBeenCalledTimes(1);
    expect(providerRuntime.removedReactions).toHaveLength(1);

    releaseNotice();
    await retirePublicationFixture(service, endpoint.id);
    await expect(
      db
        .select({ kind: chatActions.kind, status: chatActions.status })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(chatActions.kind, "provider_effect"),
          ),
        ),
    ).resolves.toEqual([
      expect.objectContaining({ kind: "provider_effect", status: "processed" }),
    ]);
    await expect(
      db
        .select({ state: chatDeliveries.state })
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(chatDeliveries.eventKind, "action"),
          ),
        ),
    ).resolves.toEqual([{ state: "filtered" }]);
  });

  it("queues Telegram guidance on the durable publication FIFO when a task is active", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service, wakeup } =
      await configuredTelegramEndpoint(fixture);
    if (!callbacks.onSlashCommand) {
      throw new Error("Telegram slash command callback was not registered");
    }
    const directMessage = makeThread({
      channelId: "77112233",
      id: "telegram:77112233",
      isDM: true,
      name: "Telegram direct message",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: directMessage.thread,
      message: makeMessage({
        id: "77112233:700",
        raw: {
          message_id: 700,
          date: 1_788_621_200,
          chat: { id: 77112233, type: "private" },
        },
        text: "investigate the durable guidance lane",
        userId: "77112233",
      }),
      trigger: "direct_message",
    });
    const slashEvent = {
      endpointId: endpoint.id,
      provider: "telegram" as const,
      event: {
        channel: {
          id: "telegram:77112233",
          name: "Telegram direct message",
          isDM: true,
        } as never,
        command: "/start",
        text: "",
        user: {
          userId: "77112233",
          userName: "telegram-user",
          fullName: "Telegram User",
          isBot: false,
          isMe: false,
          isSystem: false,
        },
        raw: {
          message_id: 701,
          date: 1_788_621_201,
          chat: { id: 77112233, type: "private" },
          from: { id: 77112233, is_bot: false },
          text: "/start",
          entities: [{ offset: 0, length: 6, type: "bot_command" }],
        },
        adapter: {} as never,
        openModal: async () => undefined,
      },
    };
    await callbacks.onSlashCommand(slashEvent);
    await callbacks.onSlashCommand(slashEvent);

    expect(runtime.endpoints.get(endpoint.id)?.posts).toEqual([]);
    const publicationsBeforeDrain = await readChatPublicationsByEndpointId(endpoint.id);
    expect(publicationsBeforeDrain).toEqual([
      expect.objectContaining({
        state: "pending",
        idempotencyKey: expect.stringMatching(/^control:guidance:/),
        payload: expect.objectContaining({
          text: expect.stringMatching(
            /^Send a direct message to start work with Maya\. In a group, use \/task@paperclip_\d+_bot followed by your request\./,
          ),
        }),
      }),
    ]);

    await service.processPendingPublications();
    await service.processPendingPublications();
    expect(
      runtime.endpoints.get(endpoint.id)?.posts.map((post) => post.text),
    ).toEqual([
      expect.stringMatching(
        /^Send a direct message to start work with Maya\. In a group, use \/task@paperclip_\d+_bot followed by your request\./,
      ),
    ]);
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(
      await readIssuesByCompanyId(fixture.companyId),
    ).toHaveLength(1);
    expect(
      await readIssueCommentsByCompanyId(fixture.companyId),
    ).toHaveLength(1);
  });

  it("durably deduplicates Telegram guidance webhook retries and filters disabled DMs", async () => {
    const fixture = await seedCompany();
    const botToken = "887766:telegram-guidance-webhook-test";
    const botId = 887766;
    const apiCalls: Array<{ body: string; method: string }> = [];
    const wakeup = vi.fn(async () => ({ accepted: true }));
    let webhookSecret = "";
    let nextProviderMessageId = 9_000;
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
                username: "paperclip_guidance_test_bot",
                first_name: "Paperclip Guidance Test",
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
        if (method === "sendMessage") {
          const payload = JSON.parse(body) as {
            chat_id?: string;
            message_thread_id?: number;
            text?: string;
          };
          nextProviderMessageId += 1;
          return new Response(
            JSON.stringify({
              ok: true,
              result: {
                message_id: nextProviderMessageId,
                date: Math.floor(Date.now() / 1_000),
                chat: {
                  id: Number(payload.chat_id),
                  type: "private",
                  first_name: "Telegram User",
                },
                text: payload.text,
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (method === "sendChatAction" || method === "setMessageReaction") {
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`Unexpected Telegram API call: ${method}`);
      },
    ) as typeof globalThis.fetch;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = telegramFetch;
    const service = chatChannelService(db, {
      fetch: telegramFetch,
      heartbeat: { wakeup: receiptBackedWakeup(wakeup) },
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

      const providerRequest = (input: {
        command: string;
        messageId: number;
        updateId: number;
      }) =>
        new Request(
          `https://paperclip.example/api/chat-webhooks/${endpoint.publicId}/telegram`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-telegram-bot-api-secret-token": webhookSecret,
            },
            body: JSON.stringify({
              update_id: input.updateId,
              message: {
                message_id: input.messageId,
                date: 1_788_620_500 + input.messageId,
                chat: {
                  id: 417200359,
                  type: "private",
                  first_name: "Telegram User",
                },
                from: {
                  id: 417200359,
                  is_bot: false,
                  first_name: "Telegram User",
                  username: "telegram-user",
                },
                text: input.command,
                entities: [
                  {
                    offset: 0,
                    length: input.command.length,
                    type: "bot_command",
                  },
                ],
              },
            }),
          },
        );
      const deliverTwice = async (input: {
        command: string;
        messageId: number;
        updateId: number;
      }) => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const response = await service.handleWebhook(
            endpoint.publicId,
            "telegram",
            providerRequest(input),
          );
          expect(response.status).toBe(200);
          await expect(response.text()).resolves.toBe("OK");
        }
      };

      await deliverTwice({ command: "/start", messageId: 601, updateId: 7601 });
      await deliverTwice({
        command: "/danger",
        messageId: 602,
        updateId: 7602,
      });
      expect(
        apiCalls
          .filter(({ method }) => method === "sendMessage")
          .map(({ body }) => (JSON.parse(body) as { text?: string }).text),
      ).toEqual([
        "Send a direct message to start work with Maya. In a group, use /task@paperclip_guidance_test_bot followed by your request. Use /status, /new, or /close to manage the active task in this chat.",
        "Available commands: /task@paperclip_guidance_test_bot followed by your request, /status, /new, and /close.",
      ]);

      await service.update(
        endpoint.id,
        { allowDirectMessages: false },
        "owner-user",
      );
      await deliverTwice({ command: "/start", messageId: 603, updateId: 7603 });
      expect(
        apiCalls.filter(({ method }) => method === "sendMessage"),
      ).toHaveLength(2);

      const deliveries = await readChatDeliveriesByEndpointId(endpoint.id);
      expect(deliveries).toHaveLength(3);
      for (const messageId of [601, 602]) {
        expect(deliveries).toContainEqual(
          expect.objectContaining({
            providerEventId: `telegram:417200359:417200359:${messageId}`,
            state: "processed",
            attempts: 1,
            conversationId: null,
            normalizedEvent: expect.objectContaining({
              deduplication: expect.objectContaining({ duplicateCount: 1 }),
            }),
          }),
        );
      }
      expect(deliveries).toContainEqual(
        expect.objectContaining({
          providerEventId: "telegram:417200359:417200359:603",
          state: "filtered",
          attempts: 0,
          conversationId: null,
          redactedError: "Destination is not enabled in Paperclip",
          normalizedEvent: expect.objectContaining({
            deduplication: expect.objectContaining({ duplicateCount: 1 }),
          }),
        }),
      );
      expect(await service.listConversations(endpoint.id)).toEqual([]);
      expect(
        await readIssuesByCompanyId(fixture.companyId),
      ).toHaveLength(0);
      expect(wakeup).not.toHaveBeenCalled();
    } finally {
      await service.shutdown();
      globalThis.fetch = previousFetch;
    }
  });

  it("consumes Telegram forum-topic controls without remapping or waking the topic task", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service, wakeup } =
      await configuredTelegramEndpoint(fixture);
    if (!callbacks.onSlashCommand) {
      throw new Error("Telegram slash command callback was not registered");
    }
    const chatId = "-10077112233";
    const topicId = 77;
    const topicThreadId = `telegram:${chatId}:${topicId}`;
    await db.insert(chatEndpointResources).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      type: "chat",
      providerResourceId: chatId,
      label: "Production forum",
      availability: "available",
      enabled: true,
    });
    const topic = makeThread({
      channelId: chatId,
      id: topicThreadId,
      name: "Production forum",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: topic.thread,
      message: makeMessage({
        id: `${chatId}:200`,
        raw: {
          message_id: 200,
          message_thread_id: topicId,
          chat: { id: Number(chatId), type: "supergroup" },
        },
        text: "@maya investigate the forum alert",
        mentioned: true,
        userId: "77112233",
      }),
      trigger: "mention",
    });
    expect(wakeup).toHaveBeenCalledTimes(1);
    const [initialConversation] = await service.listConversations(endpoint.id);
    if (!initialConversation) throw new Error("Expected topic conversation");
    const invoke = async (
      command: "/status" | "/new" | "/close",
      messageId: number,
    ) => {
      await callbacks.onSlashCommand!({
        endpointId: endpoint.id,
        provider: "telegram",
        event: {
          channel: {
            id: topicThreadId,
            name: "Production forum topic",
            isDM: false,
            post: vi.fn(),
          } as never,
          command,
          text: "",
          user: {
            userId: "77112233",
            userName: "telegram-forum-user",
            fullName: "Telegram Forum User",
            isBot: false,
            isMe: false,
            isSystem: false,
          },
          raw: {
            message_id: messageId,
            message_thread_id: topicId,
            date: 1_788_620_500 + messageId,
            chat: { id: Number(chatId), type: "supergroup" },
            from: { id: 77112233, is_bot: false },
            text: command,
            entities: [
              { offset: 0, length: command.length, type: "bot_command" },
            ],
          },
          adapter: {} as never,
          openModal: async () => undefined,
        },
      });
    };

    await invoke("/status", 201);
    await service.processPendingPublications();
    await invoke("/new", 202);
    await service.processPendingPublications();
    await expect(service.listConversations(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        id: initialConversation.id,
        issueId: initialConversation.issueId,
        state: "active",
      }),
    ]);
    await invoke("/close", 203);
    await service.processPendingPublications();

    const conversations = await service.listConversations(endpoint.id);
    expect(conversations).toEqual([
      expect.objectContaining({
        id: initialConversation.id,
        issueId: initialConversation.issueId,
        state: "completed",
      }),
    ]);
    expect(
      await readIssuesByCompanyId(fixture.companyId),
    ).toHaveLength(1);
    expect(
      await db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, initialConversation.issueId)),
    ).toEqual([{ body: "@maya investigate the forum alert" }]);
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(
      runtime.endpoints.get(endpoint.id)?.posts.map((post) => post.text),
    ).toEqual([
      expect.stringMatching(/— todo$/),
      expect.stringContaining(
        "Open a new Telegram forum topic to start a new Paperclip task.",
      ),
      "This chat conversation is closed. A later message here will continue the same Paperclip task.",
    ]);
  });
});
