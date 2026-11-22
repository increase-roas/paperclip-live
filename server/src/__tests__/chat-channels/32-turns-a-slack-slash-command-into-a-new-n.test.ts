import { DELIVERY_QUEUES, subscribeDeliveryWork } from "../../services/delivery-work-notifications.js";
import { randomUUID } from "node:crypto";
import request, {  } from "supertest";
import { and, asc, eq, inArray, like } from "drizzle-orm";
import { expect, it, onTestFinished, vi } from "vitest";
import { activityLog, agents, chatActions, chatConversations, chatDeliveries, chatEndpointResources, chatEndpoints, chatExternalPrincipals, chatIdentityLinks, chatPublications, companyMemberships, issueComments, issues } from "@paperclipai/db";
import type { Thread } from "chat";
import { FakeChatSdkRuntime, makeMessage, makeThread, routesApp } from ".././helpers/chat-channels-fixture.js";
import { configuredSlackEndpoint, createService, db, deliverMessage, describeChatChannelsSuite, readChatConversationsByEndpointId, readIssueCommentsByIssueId, readIssuesByCompanyId, seedCompany } from "../helpers/chat-channels-harness.js";







describeChatChannelsSuite("chat channels 32-turns-a-slack-slash-command-into-a-new-n", () => {
  it("turns a Slack slash command into a new native thread and one Paperclip task", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture);
    const command = endpoint.setup.command;
    if (!command) throw new Error("Slack endpoint did not expose its command");
    await db
      .update(agents)
      .set({ name: "Maya Renamed After Slack Registration" })
      .where(eq(agents.id, fixture.assignedAgentId));
    expect((await service.get(endpoint.id)).setup.command).toBe(command);
    if (!callbacks.onSlashCommand)
      throw new Error("Slack slash command callback was not registered");
    await db.insert(chatEndpointResources).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      type: "channel",
      providerResourceId: "C-COMMANDS",
      label: "commands",
      availability: "available",
      enabled: true,
    });
    const starterThreadId = "slack:C-COMMANDS:outbound-1";
    const post = vi.fn(async () => ({
      id: "6000.1",
      // The real Chat SDK channel wrapper returns its channel id here. The
      // Slack message timestamp above is the native thread root.
      threadId: "slack:C-COMMANDS",
    }));
    const postEphemeral = vi.fn(async () => ({
      id: "ephemeral-6000",
      threadId: starterThreadId,
    }));
    await callbacks.onSlashCommand({
      endpointId: endpoint.id,
      provider: "slack",
      event: {
        channel: {
          id: "C-COMMANDS",
          name: "commands",
          isDM: false,
          post,
          postEphemeral,
        } as never,
        command,
        text: "investigate the command path",
        triggerId: "trigger-6000",
        user: {
          userId: "U-COMMANDER",
          userName: "commander",
          fullName: "Command User",
          isBot: false,
          isMe: false,
          isSystem: false,
        },
        raw: { trigger_id: "trigger-6000" },
        adapter: {} as never,
        openModal: async () => undefined,
      },
    });

    await vi.waitFor(() =>
      expect(runtime.endpoints.get(endpoint.id)?.posts).toContainEqual({
        threadId: "slack:C-COMMANDS:",
        text: "Starting a task…",
      }),
    );
    expect(post).not.toHaveBeenCalled();
    await vi.waitFor(async () =>
      expect(await service.listConversations(endpoint.id)).toHaveLength(1),
    );
    const [conversation] = await service.listConversations(endpoint.id);
    expect(conversation).toMatchObject({
      externalThreadId: starterThreadId,
      state: "active",
    });
    const comments = await readIssueCommentsByIssueId(conversation.issueId);
    expect(comments.map((comment) => comment.body)).toEqual([
      "investigate the command path",
    ]);
    expect(runtime.endpoints.get(endpoint.id)?.reactions).toEqual([]);
    await vi.waitFor(async () => {
      expect(
        await db
          .select({
            state: chatDeliveries.state,
            redactedError: chatDeliveries.redactedError,
            normalizedEvent: chatDeliveries.normalizedEvent,
          })
          .from(chatDeliveries)
          .where(eq(chatDeliveries.endpointId, endpoint.id)),
      ).toEqual([
        {
          state: "processed",
          redactedError: null,
          normalizedEvent: expect.objectContaining({
            acknowledgement: { receiptReactionSupported: false },
            message: expect.objectContaining({
              text: "investigate the command path",
            }),
          }),
        },
      ]);
    });
  });

  it("admits concurrent and retried Slack slash commands only once", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service, wakeup } =
      await configuredSlackEndpoint(fixture);
    const command = endpoint.setup.command;
    if (!command) throw new Error("Slack endpoint did not expose its command");
    if (!callbacks.onSlashCommand)
      throw new Error("Slack slash command callback was not registered");
    await db.insert(chatEndpointResources).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      type: "channel",
      providerResourceId: "C-COMMAND-RETRY",
      label: "command-retry",
      availability: "available",
      enabled: true,
    });
    const starterThreadId = "slack:C-COMMAND-RETRY:outbound-1";
    let releasePost!: () => void;
    const post = vi.fn();
    const postEphemeral = vi.fn(async () => ({
      id: "ephemeral-6001",
      threadId: starterThreadId,
    }));
    const slashEvent = {
      endpointId: endpoint.id,
      provider: "slack" as const,
      event: {
        channel: {
          id: "C-COMMAND-RETRY",
          name: "command-retry",
          isDM: false,
          post,
          postEphemeral,
        } as never,
        command,
        text: "investigate one retried command",
        triggerId: "trigger-6001",
        user: {
          userId: "U-COMMAND-RETRY",
          userName: "command-retry",
          fullName: "Command Retry User",
          isBot: false,
          isMe: false,
          isSystem: false,
        },
        raw: { trigger_id: "trigger-6001" },
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
    const first = callbacks.onSlashCommand(slashEvent);
    await expect(
      Promise.race([
        Promise.resolve(first).then(() => "acknowledged" as const),
        new Promise<"timed_out">((resolve) =>
          setTimeout(() => resolve("timed_out"), 250),
        ),
      ]),
    ).resolves.toBe("acknowledged");
    await vi.waitFor(() => expect(postEntered).toHaveBeenCalledTimes(1));
    const concurrentRetry = callbacks.onSlashCommand(slashEvent);
    releasePost();
    await Promise.all([first, concurrentRetry]);
    providerRuntime.postHook = undefined;

    // A later provider retry resumes from the durable root binding. The
    // synthetic inbound ledger then proves that the task mutation already ran.
    await callbacks.onSlashCommand(slashEvent);

    expect(post).not.toHaveBeenCalled();
    expect(providerRuntime.posts).toEqual([
      {
        threadId: "slack:C-COMMAND-RETRY:",
        text: "Starting a task…",
      },
    ]);
    await vi.waitFor(() => expect(wakeup).toHaveBeenCalledTimes(1));
    const conversations = await service.listConversations(endpoint.id);
    expect(conversations).toEqual([
      expect.objectContaining({
        externalThreadId: starterThreadId,
        state: "active",
      }),
    ]);
    await expect(
      db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, conversations[0]!.issueId)),
    ).resolves.toEqual([{ body: "investigate one retried command" }]);
    // The wake callback runs before slash admission commits its terminal
    // receipt. Observe that exact durable receipt before simulating an
    // operator resolution, rather than racing the final admission write.
    const [action] = await vi.waitFor(async () => {
      const actions = await db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(chatActions.kind, "slash_task_start"),
          ),
        );
      expect(actions).toEqual([
        expect.objectContaining({
          kind: "slash_task_start",
          status: "processed",
          result: expect.objectContaining({
            threadId: starterThreadId,
            providerMessageId: "outbound-1",
          }),
        }),
      ]);
      return actions;
    });

    await db
      .update(chatActions)
      .set({
        status: "delivery_unknown",
        result: { code: "slash_task_delivery_unknown" },
      })
      .where(eq(chatActions.id, action!.id));
    expect(await service.listActivity(endpoint.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: action!.id,
          kind: "action",
          status: "delivery_unknown",
          summary: "Slack slash-command task start delivery unknown",
          detail: expect.stringContaining("will not replay it automatically"),
          replayable: false,
          resolutionActions: ["retry_anyway", "cancel"],
        }),
      ]),
    );
  });

  it("releases authorization row locks before a Slack slash starter waits on provider I/O", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture, {
        scheduleDeferredWork: () => undefined,
      });
    if (!callbacks.onSlashCommand || !endpoint.setup.command) {
      throw new Error("Slack slash command setup was incomplete");
    }
    const [resource] = await db
      .insert(chatEndpointResources)
      .values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        type: "channel",
        providerResourceId: "C-COMMAND-LOCK-PROBE",
        label: "command-lock-probe",
        availability: "available",
        enabled: true,
      })
      .returning();
    await callbacks.onSlashCommand({
      endpointId: endpoint.id,
      provider: "slack",
      event: {
        channel: {
          id: "C-COMMAND-LOCK-PROBE",
          name: "command-lock-probe",
          isDM: false,
          post: vi.fn(),
          postEphemeral: vi.fn(),
        } as never,
        command: endpoint.setup.command,
        text: "prove provider latency does not hold database locks",
        triggerId: "trigger-command-lock-probe",
        user: {
          userId: "U-COMMAND-LOCK-PROBE",
          userName: "command-lock-probe",
          fullName: "Command Lock Probe",
          isBot: false,
          isMe: false,
          isSystem: false,
        },
        raw: { trigger_id: "trigger-command-lock-probe" },
        adapter: {} as never,
        openModal: async () => undefined,
      },
    });

    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected Slack provider runtime");
    let releasePost!: () => void;
    const postEntered = vi.fn();
    providerRuntime.postHook = async () => {
      postEntered();
      await new Promise<void>((resolve) => {
        releasePost = resolve;
      });
    };
    const processing = service.processPendingDeliveries(1_000);
    await vi.waitFor(() => expect(postEntered).toHaveBeenCalledTimes(1));

    const resourceUpdate = db
      .update(chatEndpointResources)
      .set({ enabled: false, updatedAt: new Date() })
      .where(eq(chatEndpointResources.id, resource!.id))
      .returning({ id: chatEndpointResources.id })
      .then(() => "updated" as const);
    const updateOutcome = await Promise.race([
      resourceUpdate,
      new Promise<"timed_out">((resolve) =>
        setTimeout(() => resolve("timed_out"), 500),
      ),
    ]);
    releasePost();
    await processing;
    await resourceUpdate;
    providerRuntime.postHook = undefined;
    // The worker snapshots its inbound batch before running action outboxes.
    // The confirmed Slack root is admitted with the normal short reorder
    // window. This fixture disables deferred scheduling, so make that durable
    // delivery ready before a second explicit pass drains it without another
    // provider call.
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(chatDeliveries.state, "received"),
        ),
      );
    await service.processPendingDeliveries(1_000);

    expect(updateOutcome).toBe("updated");
    expect(providerRuntime.posts).toEqual([
      {
        threadId: "slack:C-COMMAND-LOCK-PROBE:",
        text: "Starting a task…",
      },
    ]);
    // Provider transport owns only its short authorization snapshot. The
    // resource update completed while Slack was in flight, so the later
    // Paperclip task mutation must honor the now-disabled destination.
    await expect(service.listConversations(endpoint.id)).resolves.toEqual([]);
    await expect(
      db
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.companyId, fixture.companyId)),
    ).resolves.toEqual([]);
    await expect(
      db
        .select({
          normalizedEvent: chatDeliveries.normalizedEvent,
          principalId: chatDeliveries.principalId,
          redactedError: chatDeliveries.redactedError,
        })
        .from(chatDeliveries)
        .where(eq(chatDeliveries.endpointId, endpoint.id)),
    ).resolves.toEqual([
      {
        normalizedEvent: expect.objectContaining({
          filtering: { contentRetained: false },
          message: expect.objectContaining({
            providerMessageId: expect.any(String),
          }),
        }),
        principalId: null,
        redactedError: "Destination is not enabled in Paperclip",
      },
    ]);
    await expect(
      db
        .select({ enabled: chatEndpointResources.enabled })
        .from(chatEndpointResources)
        .where(eq(chatEndpointResources.id, resource!.id)),
    ).resolves.toEqual([{ enabled: false }]);
    await expect(
      db
        .select({ status: chatActions.status })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(chatActions.kind, "slash_task_start"),
          ),
        ),
    ).resolves.toEqual([{ status: "processed" }]);
    await service.shutdown();
  });

  it("parks provider-confirmed Slack admissions on paused endpoints without starving active work", async () => {
    const pausedFixture = await seedCompany();
    const activeFixture = await seedCompany();
    const paused = await configuredSlackEndpoint(pausedFixture, {
      scheduleDeferredWork: () => undefined,
    });
    const active = await configuredSlackEndpoint(activeFixture, {
      scheduleDeferredWork: () => undefined,
    });
    const pausedEndpoint = await paused.service.get(paused.endpoint.id);
    const activeEndpoint = await active.service.get(active.endpoint.id);
    if (
      !pausedEndpoint.providerAccountId ||
      !pausedEndpoint.setup.command ||
      !activeEndpoint.providerAccountId ||
      !activeEndpoint.setup.command
    ) {
      throw new Error("Slack endpoint setup was incomplete");
    }
    await db
      .update(chatEndpoints)
      .set({ status: "paused", updatedAt: new Date() })
      .where(eq(chatEndpoints.id, paused.endpoint.id));
    const [pausedResource, activeResource] = await db
      .insert(chatEndpointResources)
      .values([
        {
          companyId: pausedFixture.companyId,
          endpointId: paused.endpoint.id,
          type: "channel" as const,
          providerResourceId: "C-PAUSED-CONFIRMED-STARTER",
          label: "paused-confirmed-starter",
          availability: "available" as const,
          enabled: true,
        },
        {
          companyId: activeFixture.companyId,
          endpointId: active.endpoint.id,
          type: "channel" as const,
          providerResourceId: "C-ACTIVE-CONFIRMED-STARTER",
          label: "active-confirmed-starter",
          availability: "available" as const,
          enabled: true,
        },
      ])
      .returning();
    const [pausedPrincipal, activePrincipal] = await db
      .insert(chatExternalPrincipals)
      .values([
        {
          companyId: pausedFixture.companyId,
          provider: "slack" as const,
          providerAccountId: pausedEndpoint.providerAccountId,
          externalId: "U-PAUSED-CONFIRMED-STARTER",
          kind: "user" as const,
          displayName: "Paused Confirmed Starter",
          handle: "paused-confirmed-starter",
          isBot: false,
        },
        {
          companyId: activeFixture.companyId,
          provider: "slack" as const,
          providerAccountId: activeEndpoint.providerAccountId,
          externalId: "U-ACTIVE-CONFIRMED-STARTER",
          kind: "user" as const,
          displayName: "Active Confirmed Starter",
          handle: "active-confirmed-starter",
          isBot: false,
        },
      ])
      .returning();
    const createdAt = new Date("2026-09-06T15:00:00.000Z");
    const [pausedAction, activeAction] = await db
      .insert(chatActions)
      .values([
        {
          companyId: pausedFixture.companyId,
          endpointId: paused.endpoint.id,
          principalId: pausedPrincipal!.id,
          kind: "slash_task_start" as const,
          providerActionId: `slash_task:${randomUUID()}`,
          payload: {
            version: 1,
            channelId: pausedResource!.providerResourceId,
            command: pausedEndpoint.setup.command,
            syntheticMessageId: randomUUID(),
            taskText: "keep this confirmed admission parked",
          },
          status: "provider_confirmed" as const,
          result: {
            threadId: `slack:${pausedResource!.providerResourceId}:6270.1`,
            providerMessageId: "6270.1",
          },
          createdAt,
        },
        {
          companyId: activeFixture.companyId,
          endpointId: active.endpoint.id,
          principalId: activePrincipal!.id,
          kind: "slash_task_start" as const,
          providerActionId: `slash_task:${randomUUID()}`,
          payload: {
            version: 1,
            channelId: activeResource!.providerResourceId,
            command: activeEndpoint.setup.command,
            syntheticMessageId: randomUUID(),
            taskText: "admit this active task despite the older parked row",
          },
          status: "provider_confirmed" as const,
          result: {
            threadId: `slack:${activeResource!.providerResourceId}:6270.2`,
            providerMessageId: "6270.2",
          },
          createdAt: new Date(createdAt.getTime() + 1),
        },
      ])
      .returning();

    await active.service.processPendingDeliveries(1);
    const [activeDelivery] = await db
      .select({ id: chatDeliveries.id })
      .from(chatDeliveries)
      .where(eq(chatDeliveries.endpointId, active.endpoint.id));
    if (!activeDelivery)
      throw new Error("Expected active Slack admission delivery");
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: null, updatedAt: new Date() })
      .where(eq(chatDeliveries.id, activeDelivery.id));
    await active.service.processPendingDeliveries(1, activeDelivery.id);

    await expect(
      db
        .select({ id: chatActions.id, status: chatActions.status })
        .from(chatActions)
        .where(inArray(chatActions.id, [pausedAction!.id, activeAction!.id]))
        .orderBy(asc(chatActions.createdAt)),
    ).resolves.toEqual([
      { id: pausedAction!.id, status: "provider_confirmed" },
      { id: activeAction!.id, status: "processed" },
    ]);
    await expect(
      paused.service.listConversations(paused.endpoint.id),
    ).resolves.toEqual([]);
    await expect(
      active.service.listConversations(active.endpoint.id),
    ).resolves.toEqual([
      expect.objectContaining({
        externalThreadId: `slack:${activeResource!.providerResourceId}:6270.2`,
      }),
    ]);
    await db
      .update(chatActions)
      .set({
        status: "cancelled",
        result: { code: "test_fixture_complete" },
        updatedAt: new Date(),
      })
      .where(eq(chatActions.id, pausedAction!.id));
    await paused.service.shutdown();
    await active.service.shutdown();
  });

  it("reconciles a provider-confirmed Slack starter into one task without replaying Slack", async () => {
    const fixture = await seedCompany();
    const { endpoint, runtime, service, wakeup } =
      await configuredSlackEndpoint(fixture);
    const configured = await service.get(endpoint.id);
    if (!configured.providerAccountId) {
      throw new Error("Slack endpoint did not expose its provider account");
    }
    const command = configured.setup.command;
    if (!command) throw new Error("Slack endpoint did not expose its command");
    const [resource] = await db
      .insert(chatEndpointResources)
      .values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        type: "channel",
        providerResourceId: "C-CONFIRMED-STARTER",
        label: "confirmed-starter",
        availability: "available",
        enabled: true,
      })
      .returning();
    const [principal] = await db
      .insert(chatExternalPrincipals)
      .values({
        companyId: fixture.companyId,
        provider: "slack",
        providerAccountId: configured.providerAccountId,
        externalId: "U-CONFIRMED-STARTER",
        kind: "user",
        displayName: "Confirmed Starter User",
        handle: "confirmed-starter",
        isBot: false,
      })
      .returning();
    const syntheticMessageId = `confirmed-starter-${randomUUID()}`;
    const starterThreadId = "slack:C-CONFIRMED-STARTER:6200.1";
    const [action] = await db
      .insert(chatActions)
      .values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        principalId: principal!.id,
        kind: "slash_task_start",
        providerActionId: `slash_task:${randomUUID()}`,
        payload: {
          version: 1,
          channelId: "C-CONFIRMED-STARTER",
          command,
          syntheticMessageId,
          taskText: "admit this already-confirmed starter exactly once",
        },
        status: "provider_confirmed",
        result: {
          threadId: starterThreadId,
          providerMessageId: "6200.1",
        },
      })
      .returning();

    // This row models the crash window after Slack returned the root timestamp
    // but before the original callback could durably admit the Paperclip task.
    await service.processPendingDeliveries(1_000);
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(chatDeliveries.endpointId, endpoint.id));
    await service.processPendingDeliveries(1_000);

    expect(runtime.endpoints.get(endpoint.id)?.posts).toEqual([]);
    expect(wakeup).toHaveBeenCalledTimes(1);
    await expect(
      db
        .select({ status: chatActions.status, result: chatActions.result })
        .from(chatActions)
        .where(eq(chatActions.id, action!.id)),
    ).resolves.toEqual([
      {
        status: "processed",
        result: {
          threadId: starterThreadId,
          providerMessageId: "6200.1",
        },
      },
    ]);
    const conversations = await service.listConversations(endpoint.id);
    expect(conversations).toEqual([
      expect.objectContaining({
        resourceId: resource!.id,
        externalThreadId: starterThreadId,
        state: "active",
      }),
    ]);
    await expect(
      db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, conversations[0]!.issueId)),
    ).resolves.toEqual([
      { body: "admit this already-confirmed starter exactly once" },
    ]);
    await expect(
      db
        .select({ state: chatDeliveries.state })
        .from(chatDeliveries)
        .where(eq(chatDeliveries.endpointId, endpoint.id)),
    ).resolves.toEqual([{ state: "processed" }]);
  });

  it("fences a reclaimed Slack task admission from the obsolete worker's settlement", async () => {
    const fixture = await seedCompany();
    let claimCount = 0;
    let markFirstClaimed!: () => void;
    let markSecondClaimed!: () => void;
    let releaseFirstClaim!: () => void;
    let releaseSecondClaim!: () => void;
    const firstClaimed = new Promise<void>((resolve) => {
      markFirstClaimed = resolve;
    });
    const secondClaimed = new Promise<void>((resolve) => {
      markSecondClaimed = resolve;
    });
    const firstClaimHold = new Promise<void>((resolve) => {
      releaseFirstClaim = resolve;
    });
    const secondClaimHold = new Promise<void>((resolve) => {
      releaseSecondClaim = resolve;
    });
    const { endpoint, service } = await configuredSlackEndpoint(fixture, {
      scheduleDeferredWork: () => undefined,
      slackTaskAdmissionClaimBarrier: async () => {
        claimCount += 1;
        if (claimCount === 1) {
          markFirstClaimed();
          await firstClaimHold;
        } else if (claimCount === 2) {
          markSecondClaimed();
          await secondClaimHold;
        }
      },
    });
    const configured = await service.get(endpoint.id);
    if (!configured.providerAccountId || !configured.setup.command) {
      throw new Error("Slack endpoint setup was incomplete");
    }
    await db.insert(chatEndpointResources).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      type: "channel",
      providerResourceId: "C-RECLAIMED-ADMISSION",
      label: "reclaimed-admission",
      availability: "available",
      enabled: true,
    });
    const [principal] = await db
      .insert(chatExternalPrincipals)
      .values({
        companyId: fixture.companyId,
        provider: "slack",
        providerAccountId: configured.providerAccountId,
        externalId: "U-RECLAIMED-ADMISSION",
        kind: "user",
        displayName: "Reclaimed Admission User",
        handle: "reclaimed-admission",
        isBot: false,
      })
      .returning();
    const syntheticMessageId = `reclaimed-admission-${randomUUID()}`;
    const starterThreadId = "slack:C-RECLAIMED-ADMISSION:6250.1";
    const [action] = await db
      .insert(chatActions)
      .values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        principalId: null,
        kind: "slash_task_start",
        providerActionId: `slash_task:${randomUUID()}`,
        payload: {
          version: 1,
          channelId: "C-RECLAIMED-ADMISSION",
          command: configured.setup.command,
          syntheticMessageId,
          taskText: "admit this reclaimed Slack task exactly once",
        },
        status: "provider_confirmed",
        result: {
          threadId: starterThreadId,
          providerMessageId: "6250.1",
        },
      })
      .returning();

    const obsoleteWorker = service.processPendingDeliveries();
    await firstClaimed;
    await db
      .update(chatActions)
      .set({ principalId: principal!.id, updatedAt: new Date(0) })
      .where(eq(chatActions.id, action!.id));
    const successorWorker = service.processPendingDeliveries();
    await secondClaimed;

    releaseFirstClaim();
    await obsoleteWorker;
    await expect(
      db
        .select({ status: chatActions.status })
        .from(chatActions)
        .where(eq(chatActions.id, action!.id)),
    ).resolves.toEqual([{ status: "admitting" }]);

    releaseSecondClaim();
    await successorWorker;
    await expect(
      db
        .select({ result: chatActions.result, status: chatActions.status })
        .from(chatActions)
        .where(eq(chatActions.id, action!.id)),
    ).resolves.toEqual([
      {
        result: {
          threadId: starterThreadId,
          providerMessageId: "6250.1",
        },
        status: "processed",
      },
    ]);
    await expect(
      db
        .select({ providerEventId: chatDeliveries.providerEventId })
        .from(chatDeliveries)
        .where(eq(chatDeliveries.endpointId, endpoint.id)),
    ).resolves.toEqual([
      { providerEventId: `${starterThreadId}:${syntheticMessageId}` },
    ]);

    // Admission creates a durable inbound receipt after this worker's delivery
    // batch was selected. Drain it with its own fixture before another test's
    // global worker observes that otherwise-valid pending message.
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: null, updatedAt: new Date() })
      .where(eq(chatDeliveries.endpointId, endpoint.id));
    await service.processPendingDeliveries(1_000);
    await expect(
      db
        .select({ state: chatDeliveries.state })
        .from(chatDeliveries)
        .where(eq(chatDeliveries.endpointId, endpoint.id)),
    ).resolves.toEqual([{ state: "processed" }]);
  });

  it.each([
    "link_revoked",
    "viewer",
    "resource_disabled",
  ] as const)(
    "rechecks linked authority and channel reach before admitting a provider-confirmed Slack task (%s)",
    async (authorizationChange) => {
      const fixture = await seedCompany();
      const { endpoint, runtime, service, wakeup } =
        await configuredSlackEndpoint(fixture, {
          allowUnlinkedPeople: false,
          scheduleDeferredWork: () => undefined,
        });
      const configured = await service.get(endpoint.id);
      if (!configured.providerAccountId || !configured.setup.command) {
        throw new Error("Slack endpoint setup was incomplete");
      }
      const externalPrincipalId = `U-CONFIRMED-AUTH-${authorizationChange}`;
      const [resource] = await db
        .insert(chatEndpointResources)
        .values({
          companyId: fixture.companyId,
          endpointId: endpoint.id,
          type: "channel",
          providerResourceId: `C-CONFIRMED-AUTH-${authorizationChange}`,
          label: `confirmed-auth-${authorizationChange}`,
          availability: "available",
          enabled: true,
        })
        .returning();
      const [principal] = await db
        .insert(chatExternalPrincipals)
        .values({
          companyId: fixture.companyId,
          provider: "slack",
          providerAccountId: configured.providerAccountId,
          externalId: externalPrincipalId,
          kind: "user",
          displayName: "Confirmed Slack User",
          handle: "confirmed-slack-user",
          isBot: false,
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
      const syntheticMessageId = `confirmed-auth-${authorizationChange}-${randomUUID()}`;
      const starterThreadId = `slack:${resource!.providerResourceId}:6260.1`;
      const [action] = await db
        .insert(chatActions)
        .values({
          companyId: fixture.companyId,
          endpointId: endpoint.id,
          principalId: principal!.id,
          kind: "slash_task_start",
          providerActionId: `slash_task:${randomUUID()}`,
          payload: {
            version: 1,
            channelId: resource!.providerResourceId,
            command: configured.setup.command,
            syntheticMessageId,
            taskText: `must-not-create-${authorizationChange}`,
          },
          status: "provider_confirmed",
          result: {
            authorizedUserId: "owner-user",
            threadId: starterThreadId,
            providerMessageId: "6260.1",
          },
        })
        .returning();

      if (authorizationChange === "link_revoked") {
        await db
          .update(chatIdentityLinks)
          .set({
            paperclipUserId: null,
            status: "revoked",
            revokedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(chatIdentityLinks.principalId, principal!.id));
      } else if (authorizationChange === "viewer") {
        await db
          .update(companyMemberships)
          .set({ membershipRole: "viewer", updatedAt: new Date() })
          .where(
            and(
              eq(companyMemberships.companyId, fixture.companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.principalId, "owner-user"),
            ),
          );
      } else {
        await db
          .update(chatEndpointResources)
          .set({ enabled: false, updatedAt: new Date() })
          .where(eq(chatEndpointResources.id, resource!.id));
      }

      await service.processPendingDeliveries(1_000);
      await db
        .update(chatDeliveries)
        .set({ nextAttemptAt: null, updatedAt: new Date() })
        .where(eq(chatDeliveries.endpointId, endpoint.id));
      await service.processPendingDeliveries(1_000);

      expect(runtime.endpoints.get(endpoint.id)?.posts).toEqual([]);
      expect(wakeup).not.toHaveBeenCalled();
      await expect(service.listConversations(endpoint.id)).resolves.toEqual([]);
      await expect(
        db
          .select({ id: issues.id })
          .from(issues)
          .where(eq(issues.companyId, fixture.companyId)),
      ).resolves.toEqual([]);
      await expect(
        db
          .select({ status: chatActions.status })
          .from(chatActions)
          .where(eq(chatActions.id, action!.id)),
      ).resolves.toEqual([{ status: "processed" }]);
      const [delivery] = await db
        .select({
          normalizedEvent: chatDeliveries.normalizedEvent,
          principalId: chatDeliveries.principalId,
          redactedError: chatDeliveries.redactedError,
          state: chatDeliveries.state,
        })
        .from(chatDeliveries)
        .where(eq(chatDeliveries.endpointId, endpoint.id));
      expect(delivery).toMatchObject({
        normalizedEvent: {
          filtering: { contentRetained: false },
          message: { providerMessageId: syntheticMessageId },
        },
        principalId: null,
        redactedError:
          authorizationChange === "resource_disabled"
            ? "Destination is not enabled in Paperclip"
            : authorizationChange === "viewer"
              ? "Linked Paperclip account is not currently permitted"
              : "External identity must be linked to a Paperclip account",
        state: "filtered",
      });
      expect(JSON.stringify(delivery?.normalizedEvent)).not.toContain(
        `must-not-create-${authorizationChange}`,
      );
      await service.shutdown();
    },
  );

  it("recovers a provider-confirmed Slack starter after restart but rechecks revoked reach", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service, wakeup } =
      await configuredSlackEndpoint(fixture, {
        // Keep the synthetic inbound delivery queued so the test can discard
        // every process-local callback object before a replacement service
        // reconstructs it from the durable ledger.
        deferWebhookProcessing: true,
        scheduleDeferredWork: () => undefined,
      });
    const configured = await service.get(endpoint.id);
    if (!configured.providerAccountId || !configured.setup.command) {
      throw new Error("Slack endpoint setup was incomplete");
    }
    const [resource] = await db
      .insert(chatEndpointResources)
      .values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        type: "channel",
        providerResourceId: "C-QUEUED-STARTER",
        label: "queued-starter",
        availability: "available",
        enabled: true,
      })
      .returning();
    const [principal] = await db
      .insert(chatExternalPrincipals)
      .values({
        companyId: fixture.companyId,
        provider: "slack",
        providerAccountId: configured.providerAccountId,
        externalId: "U-QUEUED-STARTER",
        kind: "user",
        displayName: "Queued Starter User",
        handle: "queued-starter",
        isBot: false,
      })
      .returning();
    const providerMessageId = randomUUID();
    const syntheticMessageId = randomUUID();
    const confirmedThreadId = `slack:C-QUEUED-STARTER:${providerMessageId}`;
    const [action] = await db
      .insert(chatActions)
      .values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        principalId: principal!.id,
        kind: "slash_task_start",
        providerActionId: `slash_task:${randomUUID()}`,
        payload: {
          version: 1,
          channelId: "C-QUEUED-STARTER",
          command: configured.setup.command,
          syntheticMessageId,
          taskText: "recover this safely queued slash task",
        },
        status: "provider_confirmed",
        result: {
          attemptCount: 1,
          authorizedUserId: null,
          providerMessageId,
          threadId: confirmedThreadId,
        },
      })
      .returning();

    // Seed the exact crash boundary deterministically: Slack has confirmed the
    // starter and Paperclip has durably normalized it, but no delivery drain
    // has begun. A global reconciliation sweep intentionally runs action and
    // delivery lanes concurrently, so using it to create this fixture made
    // the pre-shutdown assertion depend on query scheduling under load.
    const endpointRuntime = runtime.endpoints.get(endpoint.id);
    if (!endpointRuntime) throw new Error("Slack runtime was unavailable");
    await callbacks.onMessage({
      endpointId: endpoint.id,
      provider: "slack",
      thread: endpointRuntime.thread(confirmedThreadId) as unknown as Thread,
      message: makeMessage({
        id: syntheticMessageId,
        text: "recover this safely queued slash task",
        userId: "U-QUEUED-STARTER",
      }),
      trigger: "mention",
    });
    const [normalizedStarter] = await db
      .select({
        id: chatDeliveries.id,
        normalizedEvent: chatDeliveries.normalizedEvent,
      })
      .from(chatDeliveries)
      .where(eq(chatDeliveries.endpointId, endpoint.id));
    if (!normalizedStarter) {
      throw new Error("Expected normalized Slack starter delivery");
    }
    await db
      .update(chatDeliveries)
      .set({
        normalizedEvent: {
          ...(normalizedStarter.normalizedEvent as Record<string, unknown>),
          admission: { origin: "provider_confirmed_action" },
          acknowledgement: { receiptReactionSupported: false },
        },
      })
      .where(eq(chatDeliveries.id, normalizedStarter.id));

    expect(action).toMatchObject({
      status: "provider_confirmed",
      result: { providerMessageId, threadId: confirmedThreadId },
    });
    const [stagedDelivery] = await db
      .select({
        normalizedEvent: chatDeliveries.normalizedEvent,
        state: chatDeliveries.state,
      })
      .from(chatDeliveries)
      .where(eq(chatDeliveries.endpointId, endpoint.id));
    expect(stagedDelivery?.state).toBe("received");
    expect(stagedDelivery?.normalizedEvent).not.toHaveProperty(
      "admissionAuthorization",
    );
    expect(stagedDelivery?.normalizedEvent).toMatchObject({
      admission: { origin: "provider_confirmed_action" },
    });
    if (!stagedDelivery) throw new Error("Expected staged Slack delivery");
    // Simulate a row written by a pre-upgrade worker. Recovery must ignore the
    // historical authorization decision, while recognizing its presence as a
    // restrictive action-origin marker that cannot reactivate setup reach.
    const { admission: _currentAdmission, ...legacyNormalizedEvent } =
      stagedDelivery.normalizedEvent as Record<string, unknown>;
    await db
      .update(chatDeliveries)
      .set({
        normalizedEvent: {
          ...legacyNormalizedEvent,
          admissionAuthorization: {
            version: 1,
            authorizedUserId: null,
          },
        },
        updatedAt: new Date(),
      })
      .where(eq(chatDeliveries.endpointId, endpoint.id));
    expect(wakeup).not.toHaveBeenCalled();

    await service.shutdown();
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date(0), updatedAt: new Date() })
      .where(eq(chatDeliveries.endpointId, endpoint.id));
    await db
      .update(chatEndpoints)
      .set({ allowUnlinkedPeople: false, updatedAt: new Date() })
      .where(eq(chatEndpoints.id, endpoint.id));
    await db
      .update(chatEndpointResources)
      .set({ enabled: false, updatedAt: new Date() })
      .where(eq(chatEndpointResources.id, resource!.id));
    const recoveredRuntime = new FakeChatSdkRuntime();
    const { service: recoveredService, wakeup: recoveredWakeup } =
      createService(recoveredRuntime);
    await recoveredService.processPendingDeliveries(1_000);

    // Slack already accepted the starter, so recovery must never post it again.
    // Task admission is a distinct Paperclip mutation and must still honor the
    // destination and identity policy that is current after restart.
    expect(recoveredRuntime.endpoints.get(endpoint.id)?.posts).toEqual([]);
    expect(recoveredWakeup).not.toHaveBeenCalled();
    await expect(
      db
        .select({ status: chatActions.status })
        .from(chatActions)
        .where(eq(chatActions.id, action!.id)),
    ).resolves.toEqual([{ status: "processed" }]);
    await expect(
      recoveredService.listConversations(endpoint.id),
    ).resolves.toEqual([]);
    await expect(
      db
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.companyId, fixture.companyId)),
    ).resolves.toEqual([]);
    await expect(
      db
        .select({
          normalizedEvent: chatDeliveries.normalizedEvent,
          principalId: chatDeliveries.principalId,
          redactedError: chatDeliveries.redactedError,
          state: chatDeliveries.state,
        })
        .from(chatDeliveries)
        .where(eq(chatDeliveries.endpointId, endpoint.id)),
    ).resolves.toEqual([
      expect.objectContaining({
        normalizedEvent: expect.objectContaining({
          filtering: { contentRetained: false },
        }),
        principalId: null,
        redactedError: "Destination is not enabled in Paperclip",
        state: "filtered",
      }),
    ]);
    await recoveredService.shutdown();
  });

  it("cancels a queued Slack slash start when channel reach is revoked before transport", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture, {
        // Model a process disappearing after the durable callback receipt but
        // before its deferred transport worker starts.
        scheduleDeferredWork: () => undefined,
      });
    if (!callbacks.onSlashCommand || !endpoint.setup.command) {
      throw new Error("Slack slash command setup was incomplete");
    }
    const [resource] = await db
      .insert(chatEndpointResources)
      .values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        type: "channel",
        providerResourceId: "C-QUEUED-REVOKE",
        label: "queued-revoke",
        availability: "available",
        enabled: true,
      })
      .returning();
    await callbacks.onSlashCommand({
      endpointId: endpoint.id,
      provider: "slack",
      event: {
        channel: {
          id: "C-QUEUED-REVOKE",
          name: "queued-revoke",
          isDM: false,
          post: vi.fn(),
          postEphemeral: vi.fn(),
        } as never,
        command: endpoint.setup.command,
        text: "must not escape after reach is revoked",
        triggerId: "trigger-queued-revoke",
        user: {
          userId: "U-QUEUED-REVOKE",
          userName: "queued-revoke",
          fullName: "Queued Revoke User",
          isBot: false,
          isMe: false,
          isSystem: false,
        },
        raw: { trigger_id: "trigger-queued-revoke" },
        adapter: {} as never,
        openModal: async () => undefined,
      },
    });
    await expect(
      db
        .select({ status: chatActions.status })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(chatActions.kind, "slash_task_start"),
          ),
        ),
    ).resolves.toEqual([{ status: "queued" }]);

    await service.replaceResources(endpoint.id, [
      { id: resource!.id, enabled: false },
    ]);
    await service.processPendingDeliveries();

    expect(runtime.endpoints.get(endpoint.id)?.posts).toEqual([]);
    await expect(
      db
        .select({ status: chatActions.status, result: chatActions.result })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(chatActions.kind, "slash_task_start"),
          ),
        ),
    ).resolves.toEqual([
      {
        status: "cancelled",
        result: {
          code: "slash_task_no_longer_authorized",
          attemptCount: 1,
        },
      },
    ]);
    await expect(service.listConversations(endpoint.id)).resolves.toEqual([]);
  });

  it("honors Slack slash-start rate-limit backoff without hammering transport", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture, {
        scheduleDeferredWork: () => undefined,
      });
    if (!callbacks.onSlashCommand || !endpoint.setup.command) {
      throw new Error("Slack slash command setup was incomplete");
    }
    await db.insert(chatEndpointResources).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      type: "channel",
      providerResourceId: "C-QUEUED-RATE-LIMIT",
      label: "queued-rate-limit",
      availability: "available",
      enabled: true,
    });
    await callbacks.onSlashCommand({
      endpointId: endpoint.id,
      provider: "slack",
      event: {
        channel: {
          id: "C-QUEUED-RATE-LIMIT",
          name: "queued-rate-limit",
          isDM: false,
          post: vi.fn(),
          postEphemeral: vi.fn(),
        } as never,
        command: endpoint.setup.command,
        text: "respect the provider retry window",
        triggerId: "trigger-queued-rate-limit",
        user: {
          userId: "U-QUEUED-RATE-LIMIT",
          userName: "queued-rate-limit",
          fullName: "Queued Rate Limit User",
          isBot: false,
          isMe: false,
          isSystem: false,
        },
        raw: { trigger_id: "trigger-queued-rate-limit" },
        adapter: {} as never,
        openModal: async () => undefined,
      },
    });
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected Slack provider runtime");
    const transportAttempts = vi.fn(() => Date.now());
    providerRuntime.postHook = async () => {
      transportAttempts();
    };
    providerRuntime.postError = Object.assign(new Error("Slack rate limited"), {
      name: "RateLimitError",
      retryAfter: 30,
    });

    await service.processPendingDeliveries();
    expect(transportAttempts).toHaveBeenCalledTimes(1);
    const recoveryFinishedAt = Date.now();
    const [deferred] = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.kind, "slash_task_start"),
        ),
      );
    expect(deferred).toMatchObject({
      status: "queued",
      result: {
        code: "slash_task_retry",
        retryable: true,
        attemptCount: 1,
        retryAt: expect.any(String),
      },
    });
    // Anchor the 30-second provider delay to the transport attempt. Other
    // recovery work and the database read must not consume assertion slack.
    const retryAt = new Date(String(deferred!.result?.retryAt)).getTime();
    const attemptedAt = transportAttempts.mock.results[0]!.value;
    expect(retryAt).toBeGreaterThanOrEqual(attemptedAt + 30_000);
    expect(retryAt).toBeLessThanOrEqual(recoveryFinishedAt + 30_000);

    await service.processPendingDeliveries();
    expect(transportAttempts).toHaveBeenCalledTimes(1);
    await db
      .update(chatActions)
      .set({
        result: {
          ...deferred!.result,
          retryAt: new Date(0).toISOString(),
        },
        updatedAt: new Date(),
      })
      .where(eq(chatActions.id, deferred!.id));
    providerRuntime.postError = null;
    await service.processPendingDeliveries();

    expect(transportAttempts).toHaveBeenCalledTimes(2);
    expect(providerRuntime.posts).toEqual([
      {
        threadId: "slack:C-QUEUED-RATE-LIMIT:",
        text: "Starting a task…",
      },
    ]);
    await expect(
      db
        .select({ status: chatActions.status })
        .from(chatActions)
        .where(eq(chatActions.id, deferred!.id)),
    ).resolves.toEqual([{ status: "processed" }]);
  });

  it("recovers an ambiguous Slack slash-task start only after an audited explicit retry", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture);
    const workWake = vi.fn();
    const stopWorkObserver = subscribeDeliveryWork(db, DELIVERY_QUEUES.chatTaskStarts, workWake);
    onTestFinished(() => { stopWorkObserver(); expect(workWake).toHaveBeenCalled(); });
    const command = endpoint.setup.command;
    if (!command) throw new Error("Slack endpoint did not expose its command");
    if (!callbacks.onSlashCommand) {
      throw new Error("Slack slash command callback was not registered");
    }
    await db.insert(chatEndpointResources).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      type: "channel",
      providerResourceId: "C-COMMAND-RECOVERY",
      label: "command-recovery",
      availability: "available",
      enabled: true,
    });
    const post = vi.fn();
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected Slack provider runtime");
    providerRuntime.postError = new Error("socket reset after write");
    await callbacks.onSlashCommand({
      endpointId: endpoint.id,
      provider: "slack",
      event: {
        channel: {
          id: "C-COMMAND-RECOVERY",
          name: "command-recovery",
          isDM: false,
          post,
          postEphemeral: vi.fn(),
        } as never,
        command,
        text: "recover this ambiguous command exactly once",
        triggerId: "trigger-command-recovery",
        user: {
          userId: "U-COMMAND-RECOVERY",
          userName: "command-recovery",
          fullName: "Command Recovery User",
          isBot: false,
          isMe: false,
          isSystem: false,
        },
        raw: { trigger_id: "trigger-command-recovery" },
        adapter: {} as never,
        openModal: async () => undefined,
      },
    });
    await vi.waitFor(async () =>
      expect(
        await db
          .select({ status: chatActions.status })
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, endpoint.id),
              eq(chatActions.kind, "slash_task_start"),
            ),
          ),
      ).toEqual([{ status: "delivery_unknown" }]),
    );
    expect(post).not.toHaveBeenCalled();
    await vi.waitFor(async () =>
      expect(
        await db
          .select({ status: chatActions.status })
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, endpoint.id),
              eq(chatActions.kind, "slash_task_start"),
            ),
          ),
      ).toEqual([{ status: "delivery_unknown" }]),
    );

    const [action] = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.kind, "slash_task_start"),
        ),
      );
    expect(action).toMatchObject({
      kind: "slash_task_start",
      status: "delivery_unknown",
      payload: {
        channelId: "C-COMMAND-RECOVERY",
        taskText: "recover this ambiguous command exactly once",
        syntheticMessageId: expect.any(String),
      },
    });
    expect(await service.listActivity(endpoint.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: action!.id,
          kind: "action",
          status: "delivery_unknown",
          replayable: false,
          resolutionActions: ["retry_anyway", "cancel"],
        }),
      ]),
    );

    const app = routesApp(db, fixture.companyId, service);
    providerRuntime.postError = null;
    let releaseRetryPost!: () => void;
    const retryPostEntered = vi.fn();
    providerRuntime.postHook = async () => {
      retryPostEntered();
      await new Promise<void>((resolve) => {
        releaseRetryPost = resolve;
      });
    };
    const firstRetry = request(app)
      .post(`/api/chat-endpoints/${endpoint.id}/actions/${action!.id}/resolve`)
      .send({ action: "retry_anyway" })
      .then((response) => response);
    await vi.waitFor(() => expect(retryPostEntered).toHaveBeenCalledTimes(1));
    const concurrentRetry = request(app)
      .post(`/api/chat-endpoints/${endpoint.id}/actions/${action!.id}/resolve`)
      .send({ action: "retry_anyway" })
      .then((response) => response);
    releaseRetryPost();
    const retryResponses = await Promise.all([firstRetry, concurrentRetry]);
    expect(retryResponses.map((response) => response.status).sort()).toEqual([
      204, 409,
    ]);
    providerRuntime.postHook = undefined;

    expect(runtime.endpoints.get(endpoint.id)?.posts).toEqual([
      {
        threadId: "slack:C-COMMAND-RECOVERY:",
        text: "Starting a task…",
      },
    ]);
    const conversations = await service.listConversations(endpoint.id);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.externalThreadId).toBe(
      "slack:C-COMMAND-RECOVERY:outbound-1",
    );
    await expect(
      db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, conversations[0]!.issueId)),
    ).resolves.toEqual([
      { body: "recover this ambiguous command exactly once" },
    ]);
    await expect(
      db
        .select({ status: chatActions.status, result: chatActions.result })
        .from(chatActions)
        .where(eq(chatActions.id, action!.id)),
    ).resolves.toEqual([
      {
        status: "processed",
        result: expect.objectContaining({ authorizedUserId: null }),
      },
    ]);
    const [delivery] = await db
      .select({ normalizedEvent: chatDeliveries.normalizedEvent })
      .from(chatDeliveries)
      .where(eq(chatDeliveries.endpointId, endpoint.id));
    expect(delivery?.normalizedEvent).not.toHaveProperty(
      "admissionAuthorization",
    );
    await expect(
      db
        .select({ action: activityLog.action, actorId: activityLog.actorId })
        .from(activityLog)
        .where(eq(activityLog.entityId, action!.id)),
    ).resolves.toEqual(
      expect.arrayContaining([
        {
          action: "chat.slack_command_retry_anyway",
          actorId: "owner-user",
        },
      ]),
    );

    expect(runtime.endpoints.get(endpoint.id)?.posts).toHaveLength(1);

    const [cancelAction] = await db
      .insert(chatActions)
      .values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        kind: "slash_task_start",
        providerActionId: `slash_task:cancel-${randomUUID()}`,
        payload: {},
        status: "received",
        updatedAt: new Date(Date.now() - 2 * 60_000),
      })
      .returning();
    expect(await service.listActivity(endpoint.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: cancelAction!.id,
          kind: "action",
          status: "delivery_unknown",
          resolutionActions: ["cancel"],
        }),
      ]),
    );
    await expect(
      db
        .select({ status: chatActions.status })
        .from(chatActions)
        .where(eq(chatActions.id, cancelAction!.id)),
    ).resolves.toEqual([{ status: "received" }]);
    await request(app)
      .post(
        `/api/chat-endpoints/${endpoint.id}/actions/${cancelAction!.id}/resolve`,
      )
      .send({ action: "mark_delivered" })
      .expect(409);
    await request(app)
      .post(
        `/api/chat-endpoints/${endpoint.id}/actions/${cancelAction!.id}/resolve`,
      )
      .send({ action: "cancel" })
      .expect(204);
    await expect(
      db
        .select({ status: chatActions.status })
        .from(chatActions)
        .where(eq(chatActions.id, cancelAction!.id)),
    ).resolves.toEqual([{ status: "cancelled" }]);
    await expect(
      db
        .select({ action: activityLog.action, actorId: activityLog.actorId })
        .from(activityLog)
        .where(eq(activityLog.entityId, cancelAction!.id)),
    ).resolves.toEqual([
      { action: "chat.slack_command_cancel", actorId: "owner-user" },
    ]);
  });

  it.each([
    { control: "new", status: "todo", state: "active" },
    { control: "close", status: "todo", state: "active" },
    { control: "new", status: "done", state: "active" },
    { control: "close", status: "cancelled", state: "active" },
    { control: "new", status: "done", state: "completed" },
    { control: "close", status: "cancelled", state: "completed" },
  ] as const)("binds Slack DM slash controls to the latest task ($control, $status, $state)", async ({ control, status, state }) => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture);
    const command = endpoint.setup.command;
    if (!command) throw new Error("Slack endpoint did not expose its command");
    if (!callbacks.onSlashCommand) {
      throw new Error("Slack slash command callback was not registered");
    }
    const starterThreadId = "slack:D09SLASHTASK:outbound-1";
    const post = vi.fn(async () => ({
      id: "6100.1",
      threadId: starterThreadId,
    }));
    const slashChannel = {
      id: "slack:D09SLASHTASK",
      name: "direct message",
      isDM: false,
      post,
      postEphemeral: vi.fn(),
    } as never;
    const invoke = async (text: string) =>
      callbacks.onSlashCommand!({
        endpointId: endpoint.id,
        provider: "slack",
        event: {
          channel: slashChannel,
          command,
          text,
          triggerId: `trigger-dm-slash-${text}-${randomUUID()}`,
          user: {
            userId: "U-DM-SLASH-TASK",
            userName: "dm-slash-task",
            fullName: "DM Slash Task User",
            isBot: false,
            isMe: false,
            isSystem: false,
          },
          raw: { command, text },
          adapter: {} as never,
          openModal: async () => undefined,
        },
      });

    await invoke("Start a task from this DM slash command");
    await vi.waitFor(() =>
      expect(runtime.endpoints.get(endpoint.id)?.posts).toContainEqual({
        threadId: "slack:D09SLASHTASK:",
        text: "Starting a task…",
      }),
    );
    expect(post).not.toHaveBeenCalled();
    await vi.waitFor(async () =>
      expect(await service.listConversations(endpoint.id)).toHaveLength(1),
    );
    const [conversation] = await service.listConversations(endpoint.id);
    expect(conversation.externalThreadId).toBe(starterThreadId);
    await db.update(issues).set({ status }).where(eq(issues.id, conversation.issueId));
    await db.update(chatConversations).set({ state }).where(eq(chatConversations.id, conversation.id));

    await invoke("status");
    await service.processPendingPublications();
    expect(runtime.endpoints.get(endpoint.id)?.posts.at(-1)).toMatchObject({
      threadId: starterThreadId,
      text: expect.stringMatching(new RegExp(`— ${status}$`)),
    });
    await invoke(control);
    await expect(readChatConversationsByEndpointId(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        externalThreadId: starterThreadId,
        state,
      }),
    ]);
    await service.processPendingPublications();
    expect(await service.listConversations(endpoint.id)).toEqual([
      expect.objectContaining({
        externalThreadId: starterThreadId,
        state: "completed",
      }),
    ]);
    const [completion] = await db.select().from(chatPublications).where(and(
      eq(chatPublications.conversationId, conversation.id),
      like(chatPublications.idempotencyKey, `control:${control}:%`),
    ));
    expect(completion?.state).toBe("published");
    expect(await readIssuesByCompanyId(fixture.companyId)).toHaveLength(1);
    const providerTime = Date.now();
    const providerTimestamp = `${Math.floor(providerTime / 1_000)}.${String((providerTime % 1_000) * 1_000).padStart(6, "0")}`;
    await deliverMessage({
      callbacks, endpointId: endpoint.id,
      thread: makeThread({ channelId: "D09SLASHTASK", id: starterThreadId, isDM: true }).thread,
      message: makeMessage({ id: providerTimestamp, raw: { ts: providerTimestamp }, text: "An explicitly requested new task", userId: "U-DM-SLASH-TASK" }),
      trigger: "direct_message",
    });
    const conversations = await service.listConversations(endpoint.id);
    expect(conversations).toHaveLength(2);
    expect(conversations.find(row => row.state === "active")).toMatchObject({
      externalThreadId: starterThreadId, sessionGeneration: 2,
    });
    expect(await readIssuesByCompanyId(fixture.companyId)).toHaveLength(2);
  });
});
