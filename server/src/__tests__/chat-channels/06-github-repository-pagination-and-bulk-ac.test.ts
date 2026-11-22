
import {
  initializeRunIdentity,
} from "../../services/run-identity.js";
import {
  generateKeyPairSync,
  randomUUID,
} from "node:crypto";
import {
  and,
  asc,
  eq,
  inArray,
  sql,
} from "drizzle-orm";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  chatActions,
  chatConversations,
  chatDeliveries,
  chatEndpointResources,
  chatEndpoints,
  companyMemberships,
  heartbeatRuns,
  issues,
  principalPermissionGrants,
  projectWorkspaces,
  projects,
  toolConnections,
} from "@paperclipai/db";
import {
  instanceSettingsService,
} from "../../services/instance-settings.js";
import {
  subscribeCompanyLiveEvents,
} from "../../services/live-events.js";
import {
  FakeChatSdkRuntime,
  fakeSlackFetch,
  makeMessage,
  makeThread,
  routesApp,
} from ".././helpers/chat-channels-fixture.js";
import {
  attachFakeGitHubIssueCommentWebhook,
  configuredSlackEndpoint,
  createService,
  db,
  deliverMessage,
  describeChatChannelsSuite,
  readChatConversationsByEndpointId,
  readChatDeliveriesByEndpointId,
  readChatDeliveriesById,
  readIssueCommentsByIssueId,
  recordGitHubWebhookVerification,
  seedCompany,
  signedGitHubWebhookRequest,
  configuredGitHubEndpoint,
} from "../helpers/chat-channels-harness.js";
import request, {  } from "supertest";
import type { ChatSdkMessageTrigger } from "../../services/chat-sdk-runtime.js";

describeChatChannelsSuite("chat channels 06-github-repository-pagination-and-bulk-ac", () => {
  it.each([false, true])("requires at-mentions by default only in Slack channels (DM=%s)", async (isDM) => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } = await configuredSlackEndpoint(fixture, { requireAtMention: true });
    // The returned endpoint is the original creation result, before fixture updates.
    expect(endpoint.requireAtMention).toBe(true);
    expect((await service.get(endpoint.id)).requireAtMention).toBe(true);
    const thread = makeThread({ channelId: isDM ? "D-DEFAULT" : "C-DEFAULT", id: `slack:${isDM ? "D-DEFAULT" : "C-DEFAULT"}:7500.1`, isDM });
    const send = (id: string, mentioned: boolean) => deliverMessage({ callbacks, endpointId: endpoint.id, thread: thread.thread,
      message: makeMessage({ id, text: mentioned ? "@maya start" : "Start", mentioned }), trigger: isDM ? "direct_message" : mentioned ? "mention" : "subscribed_message" });
    await send("7500.1", false);
    expect(wakeup).toHaveBeenCalledTimes(isDM ? 1 : 0);
    await send("7500.2", true);
    expect(wakeup).toHaveBeenCalledTimes(isDM ? 2 : 1);
    await service.update(endpoint.id, { requireAtMention: false });
    await send("7500.3", false);
    expect(wakeup).toHaveBeenCalledTimes(isDM ? 3 : 2);
    const other = await service.create(fixture.companyId, { provider: "github", assignedAgentId: fixture.assignedAgentId });
    expect(other.requireAtMention).toBe(false);
    expect((await service.get(endpoint.id)).requireAtMention).toBe(false);
    await service.shutdown();
  });

  it("preserves running Slack tool authority after Require at-mention is enabled", async () => {
    await instanceSettingsService(db).updateExperimental({ enableChatConnectors: true });
    const { resolveSlackTaskAuthority } = await import("../../services/connectors/slack-authority.js");
    const fixture = await seedCompany();
    const { callbacks, endpoint, service } = await configuredSlackEndpoint(fixture, { linkedBoardUser: true, allowUnlinkedPeople: false });
    const thread = makeThread({ channelId: "D-RUNNING", id: "slack:D-RUNNING:7400.1", isDM: true });
    await deliverMessage({ callbacks, endpointId: endpoint.id, thread: thread.thread,
      message: makeMessage({ id: "7400.1", text: "Read this conversation", userId: "UBOARD" }), trigger: "direct_message" });
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    const [action] = await db.select().from(chatActions).where(and(eq(chatActions.endpointId, endpoint.id), eq(chatActions.kind, "inbound_wakeup")));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: fixture.companyId, agentId: fixture.assignedAgentId,
      status: "running", invocationSource: "assignment", responsibleUserId: "owner-user", contextSnapshot: { issueId: conversation.issueId } });
    await initializeRunIdentity(db, { companyId: fixture.companyId, runId, issueId: conversation.issueId,
      responsibleUserId: "owner-user", messageIds: [String(action.payload.commentId)], cause: "instruction" });
    const binding = { companyId: fixture.companyId, agentId: fixture.assignedAgentId, runId, issueId: conversation.issueId };
    await expect(resolveSlackTaskAuthority(db, binding)).resolves.toMatchObject({ slackUserId: "UBOARD" });
    await service.update(endpoint.id, { requireAtMention: true });
    await expect(resolveSlackTaskAuthority(db, binding)).resolves.toMatchObject({ slackUserId: "UBOARD" });
  });

  it.each([false, true])("applies Slack mention settings to channel replies while exempting DMs (DM=%s)", async (isDM) => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } = await configuredSlackEndpoint(fixture);
    expect((await service.get(endpoint.id)).requireAtMention).toBe(false);
    const thread = makeThread({ channelId: isDM ? "D-MENTION" : "C-MENTION", id: isDM ? "slack:D-MENTION:" : "slack:C-MENTION:7100.1", isDM });
    const send = (id: string, mentioned: boolean, trigger: ChatSdkMessageTrigger = isDM ? "direct_message" : "subscribed_message") =>
      deliverMessage({ callbacks, endpointId: endpoint.id, thread: thread.thread,
        message: makeMessage({ id, text: mentioned ? "@maya continue" : "Continue", mentioned }), trigger });
    // Disabled mode preserves unmentioned DMs and subscribed thread replies.
    await send("7100.1", true, isDM ? "direct_message" : "mention");
    await send("7100.2", false);
    expect(wakeup).toHaveBeenCalledTimes(2);
    expect((await service.update(endpoint.id, { requireAtMention: true })).requireAtMention).toBe(true);
    await send("7100.3", false, "subscribed_message");
    expect(wakeup).toHaveBeenCalledTimes(isDM ? 3 : 2);
    const [filtered] = await db.select().from(chatDeliveries).where(and(
      eq(chatDeliveries.endpointId, endpoint.id), eq(chatDeliveries.state, "filtered")));
    if (isDM) {
      expect(filtered).toBeUndefined();
    } else {
      expect(filtered.redactedError).toBe("Message did not @mention the bot");
      expect(filtered.normalizedEvent).toMatchObject({ filtering: { contentRetained: false } });
      expect(filtered.normalizedEvent).not.toHaveProperty("message.text");
    }
    // Both Slack callback kinds can carry an explicit mention. Retries cannot
    // produce a second wakeup for the same provider message.
    await send("7100.4", true);
    await send("7100.4", true, "mention");
    expect(wakeup).toHaveBeenCalledTimes(isDM ? 4 : 3);
    const conversations = await readChatConversationsByEndpointId(endpoint.id);
    expect(conversations).toHaveLength(1);
    const comments = await readIssueCommentsByIssueId(conversations[0].issueId);
    expect(comments).toHaveLength(isDM ? 4 : 3);
    expect(conversations[0].externalThreadId).toBe(thread.thread.id);
    await service.update(endpoint.id, { requireAtMention: false });
    await send("7100.5", false);
    expect(wakeup).toHaveBeenCalledTimes(isDM ? 5 : 4);
    if (isDM) {
      await service.update(endpoint.id, { requireAtMention: true, allowDirectMessages: false });
      await send("7100.6", false);
      expect(wakeup).toHaveBeenCalledTimes(5);
    }
  });

  it.each([false, true])("rechecks queued Slack channel mentions but exempts DMs before drain (DM=%s)", async (isDM) => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } = await configuredSlackEndpoint(fixture, {
      deferWebhookProcessing: true, scheduleDeferredWork: () => undefined,
    });
    const channelId = isDM ? "D-QUEUED-MENTION" : "C-QUEUED-MENTION";
    const thread = makeThread({ channelId, id: `slack:${channelId}:${isDM ? "" : "7300.1"}`, isDM });
    await deliverMessage({ callbacks, endpointId: endpoint.id, thread: thread.thread,
      message: makeMessage({ id: "7300.1", text: "Start work" }), trigger: isDM ? "direct_message" : "subscribed_message" });
    await service.update(endpoint.id, { requireAtMention: true });
    const [delivery] = await readChatDeliveriesByEndpointId(endpoint.id);
    await db.update(chatDeliveries).set({ nextAttemptAt: new Date(0) }).where(eq(chatDeliveries.id, delivery.id));
    await service.processPendingDeliveries(25, delivery.id);
    expect(wakeup).toHaveBeenCalledTimes(isDM ? 1 : 0);
    expect(await readChatConversationsByEndpointId(endpoint.id)).toHaveLength(isDM ? 1 : 0);
    expect((await readChatDeliveriesById(delivery.id))[0].state).toBe(isDM ? "processed" : "filtered");
  });

  it("snapshots channel workspace defaults on new tasks and preserves them on replies", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service } = await configuredSlackEndpoint(fixture);
    await service.update(endpoint.id, { executionDefaults: { workspace: { kind: "task_directory" } } }, "owner-user");
    const thread = makeThread({ channelId: "C-WORKSPACE", id: "slack:C-WORKSPACE:8100.1", name: "workspace" });
    await deliverMessage({ callbacks, endpointId: endpoint.id, thread: thread.thread,
      message: makeMessage({ id: "8100.1", text: "@maya make a report", mentioned: true }), trigger: "mention" });
    const conversations = () => db.select().from(chatConversations).where(eq(chatConversations.endpointId, endpoint.id)).orderBy(asc(chatConversations.createdAt));
    const [first] = await conversations();
    const [task] = await db.select().from(issues).where(eq(issues.id, first.issueId));
    expect(task.projectId).toBeNull();
    expect(task.workspaceSelection).toEqual({ version: 1, selection: { kind: "task_directory" }, source: "channel" });
    const [resource] = (await service.listResources(endpoint.id)).filter(row => row.providerResourceId === "C-WORKSPACE");
    expect(resource).toBeDefined();
    await service.replaceResources(endpoint.id, [{ id: resource.id, executionDefaults: { workspace: null } }], "owner-user");
    expect((await service.listResources(endpoint.id)).find(row => row.id === resource.id)?.enabled).toBe(resource.enabled);
    await service.update(endpoint.id, { executionDefaults: null }, "owner-user");
    await deliverMessage({ callbacks, endpointId: endpoint.id, thread: thread.thread,
      message: makeMessage({ id: "8100.2", text: "Continue" }), trigger: "subscribed_message" });
    const [unchanged] = await db.select().from(issues).where(eq(issues.id, first.issueId));
    expect(unchanged.workspaceSelection).toEqual(task.workspaceSelection);
    await service.update(endpoint.id, { executionDefaults: { workspace: { kind: "task_directory" } } }, "owner-user");
    const next = makeThread({ channelId: "C-WORKSPACE", id: "slack:C-WORKSPACE:8200.1", name: "workspace" });
    await deliverMessage({ callbacks, endpointId: endpoint.id, thread: next.thread,
      message: makeMessage({ id: "8200.1", text: "@maya another report", mentioned: true }), trigger: "mention" });
    const rows = await conversations();
    expect(rows).toHaveLength(2);
    const [second] = await db.select().from(issues).where(eq(issues.id, rows[1].issueId));
    expect(second.workspaceSelection).toBeNull();
    await expect(service.update(endpoint.id, { executionDefaults: { projectId: randomUUID() } }, "owner-user")).rejects.toMatchObject({ status: 404 });
    expect((await service.get(endpoint.id)).executionDefaults).toEqual({ workspace: { kind: "task_directory" } });
  });

  it("checks both linked sender and agent assignment grants for protected organizational defaults", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } = await configuredSlackEndpoint(fixture, { linkedBoardUser: true });
    const [project] = await db.insert(projects).values({ companyId: fixture.companyId, name: "Protected task project",
      executionWorkspacePolicy: { authorizationPolicy: { assignmentPolicy: { mode: "protected" } } } }).returning();
    const defaults = { projectId: project.id, workspace: { kind: "task_directory" as const } };
    await service.update(endpoint.id, { executionDefaults: defaults }, "owner-user");
    await db.insert(companyMemberships).values({ companyId: fixture.companyId, principalType: "agent",
      principalId: fixture.assignedAgentId, status: "active", membershipRole: "member" });
    const send = async (id: string) => {
      const thread = makeThread({ channelId: "C-ASSIGNMENT", id: `slack:C-ASSIGNMENT:${id}`, name: "assignment" });
      await deliverMessage({ callbacks, endpointId: endpoint.id, thread: thread.thread,
        message: makeMessage({ id, text: "@maya create a report", mentioned: true, userId: "UBOARD" }), trigger: "mention" });
    };
    const tasks = () => db.select().from(issues).where(eq(issues.companyId, fixture.companyId));
    await expect(send("8310.1")).rejects.toMatchObject({ status: 403, message: expect.stringContaining("protected") });
    expect(await tasks()).toHaveLength(0);
    expect(wakeup).not.toHaveBeenCalled();
    const [senderGrant] = await db.insert(principalPermissionGrants).values({ companyId: fixture.companyId,
      principalType: "user", principalId: "owner-user", permissionKey: "tasks:assign_scope",
      scope: { projectId: project.id, assigneeAgentId: fixture.assignedAgentId } }).returning();
    await expect(send("8310.2")).rejects.toMatchObject({ status: 403, message: expect.stringContaining("protected") });
    expect(await tasks()).toHaveLength(0);
    expect(wakeup).not.toHaveBeenCalled();
    await db.insert(principalPermissionGrants).values({ companyId: fixture.companyId,
      principalType: "agent", principalId: fixture.assignedAgentId, permissionKey: "tasks:assign_scope",
      scope: { projectId: project.id, assigneeAgentId: fixture.assignedAgentId } });
    await send("8310.3");
    expect(await tasks()).toEqual([expect.objectContaining({ projectId: project.id,
      assigneeAgentId: fixture.assignedAgentId,
      workspaceSelection: { version: 1, selection: { kind: "task_directory" }, source: "channel" } })]);
    expect(wakeup).toHaveBeenCalledTimes(1);
    await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.id, senderGrant.id));
    await expect(send("8310.4")).rejects.toMatchObject({ status: 403, message: expect.stringContaining("protected") });
    expect(await tasks()).toHaveLength(1);
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(await db.select().from(chatConversations).where(eq(chatConversations.endpointId, endpoint.id))).toHaveLength(1);
  });

  it("checks protected organizational defaults against the assignee locked at creation", async () => {
    const fixture = await seedCompany();
    let endpointId = "";
    const { callbacks, endpoint, service, wakeup } = await configuredSlackEndpoint(fixture, {
      linkedBoardUser: true,
      reachAuthorizationBarrier: async () => {
        await db.update(chatEndpoints).set({ assignedAgentId: fixture.replacementAgentId }).where(eq(chatEndpoints.id, endpointId));
      },
    });
    endpointId = endpoint.id;
    const [project] = await db.insert(projects).values({ companyId: fixture.companyId, name: "Protected reassignment",
      executionWorkspacePolicy: { authorizationPolicy: { assignmentPolicy: { mode: "protected" } } } }).returning();
    await service.update(endpoint.id, { executionDefaults: { projectId: project.id, workspace: { kind: "task_directory" } } }, "owner-user");
    await db.insert(companyMemberships).values({ companyId: fixture.companyId, principalType: "agent",
      principalId: fixture.assignedAgentId, status: "active", membershipRole: "member" });
    await db.insert(principalPermissionGrants).values([
      { companyId: fixture.companyId, principalType: "user", principalId: "owner-user", permissionKey: "tasks:assign_scope",
        scope: { projectId: project.id, assigneeAgentId: fixture.assignedAgentId } },
      { companyId: fixture.companyId, principalType: "agent", principalId: fixture.assignedAgentId, permissionKey: "tasks:assign_scope",
        scope: { projectId: project.id, assigneeAgentId: fixture.assignedAgentId } },
    ]);
    const thread = makeThread({ channelId: "C-REASSIGNED", id: "slack:C-REASSIGNED:8320.1", name: "reassigned" });
    await expect(deliverMessage({ callbacks, endpointId: endpoint.id, thread: thread.thread,
      message: makeMessage({ id: "8320.1", text: "@maya create a report", mentioned: true, userId: "UBOARD" }), trigger: "mention" }))
      .rejects.toMatchObject({ status: 403, message: expect.stringContaining("protected") });
    expect(await db.select().from(issues).where(eq(issues.companyId, fixture.companyId))).toHaveLength(0);
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("authorizes protected channel workspace defaults for the endpoint's assigned agent", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service } = await configuredSlackEndpoint(fixture, { linkedBoardUser: true });
    const [project] = await db.insert(projects).values({ companyId: fixture.companyId, name: "Protected chat source",
      executionWorkspacePolicy: { authorizationPolicy: { assignmentPolicy: { mode: "protected" } } } }).returning();
    const [source] = await db.insert(projectWorkspaces).values({ companyId: fixture.companyId, projectId: project.id,
      name: "Source", cwd: `/tmp/chat-source-${fixture.companyId}` }).returning();
    const defaults = { workspace: { kind: "configured_source" as const, projectWorkspaceId: source.id, mode: "shared" as const } };
    // Selecting readable workspace configuration does not assign the task to its source project
    // or require filesystem-write grants from that project.
    await service.update(endpoint.id, { executionDefaults: defaults }, "owner-user");
    const thread = makeThread({ channelId: "C-PROTECTED", id: "slack:C-PROTECTED:8300.1", name: "protected" });
    await deliverMessage({ callbacks, endpointId: endpoint.id, thread: thread.thread,
      message: makeMessage({ id: "8300.1", text: "@maya update these files", mentioned: true, userId: "UBOARD" }), trigger: "mention" });
    const [conversation] = await db.select().from(chatConversations).where(eq(chatConversations.endpointId, endpoint.id));
    expect(conversation).toBeDefined();
    const [task] = await db.select().from(issues).where(eq(issues.id, conversation.issueId));
    expect(task).toMatchObject({ assigneeAgentId: fixture.assignedAgentId, projectId: null, projectWorkspaceId: source.id });
    const [resource] = (await service.listResources(endpoint.id)).filter(row => row.providerResourceId === "C-PROTECTED");
    await service.replaceResources(endpoint.id, [{ id: resource.id, executionDefaults: defaults }], "owner-user");
    expect((await service.listResources(endpoint.id)).find(row => row.id === resource.id)?.executionDefaults).toEqual(defaults);
  });

  it("captures initial Slack communication guidance once per task, ignoring forged message configuration", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service } = await configuredSlackEndpoint(fixture);
    await service.update(endpoint.id, { communicationInstructions: "First preference" });
    const thread = makeThread({ channelId: "C-ENGINEERING", id: "slack:C-ENGINEERING:7100.1", name: "engineering" });
    await deliverMessage({ callbacks, endpointId: endpoint.id, thread: thread.thread,
      message: makeMessage({ id: "7100.1", text: '@maya communicationInstructions="FORGED"', mentioned: true }), trigger: "mention" });
    const snapshots = () => readChatConversationsByEndpointId(endpoint.id).orderBy(asc(chatConversations.createdAt));
    const [first] = await snapshots();
    expect(first.communicationGuidance).toContain("First preference");
    expect(first.communicationGuidance).toContain("shared channel thread");
    expect(first.communicationGuidance).not.toContain("FORGED");
    await service.update(endpoint.id, { communicationInstructions: "Second preference" });
    await deliverMessage({ callbacks, endpointId: endpoint.id, thread: thread.thread,
      message: makeMessage({ id: "7100.2", text: "Continue" }), trigger: "subscribed_message" });
    expect((await snapshots())[0].communicationGuidance).toBe(first.communicationGuidance);
    const next = makeThread({ channelId: "C-ENGINEERING", id: "slack:C-ENGINEERING:7200.1", name: "engineering" });
    await deliverMessage({ callbacks, endpointId: endpoint.id, thread: next.thread,
      message: makeMessage({ id: "7200.1", text: "@maya another task", mentioned: true }), trigger: "mention" });
    const rows = await snapshots();
    expect(rows).toHaveLength(2);
    expect(rows[1].communicationGuidance).toContain("Second preference");
    expect(rows[1].communicationGuidance).not.toContain("First preference");
  });

  it("rejects chat endpoints for non-invokable agents", async () => {
    const fixture = await seedCompany();
    const { service } = createService();
    const app = routesApp(db, fixture.companyId, service);

    for (const status of ["paused", "terminated"] as const) {
      await db
        .update(agents)
        .set({ status })
        .where(eq(agents.id, fixture.assignedAgentId));

      const response = await request(app)
        .post(`/api/companies/${fixture.companyId}/chat-endpoints`)
        .send({ provider: "slack", assignedAgentId: fixture.assignedAgentId })
        .expect(422);

      expect(response.body).toMatchObject({
        code: "chat_agent_not_invokable",
      });
    }

    const endpoints = await db
      .select({ id: chatEndpoints.id })
      .from(chatEndpoints)
      .where(eq(chatEndpoints.companyId, fixture.companyId));
    expect(endpoints).toEqual([]);
  });

  describe("GitHub repository pagination and bulk access", () => {
    it("pages and searches 1000 repositories while toggle all changes unloaded rows atomically", async () => {
      const fixture = await seedCompany();
      const context = createService();
      const endpoint = await context.service.create(fixture.companyId,
        { provider: "github", assignedAgentId: fixture.assignedAgentId }, "owner-user");
      const foreign = await seedCompany();
      const other = await context.service.create(foreign.companyId,
        { provider: "github", assignedAgentId: foreign.assignedAgentId }, "owner-user");
      const all = await db.insert(chatEndpointResources).values(Array.from({ length: 1000 }, (_, index) => ({
        companyId: fixture.companyId, endpointId: endpoint.id, type: "repository",
        providerResourceId: `acme/repo-${index}`, label: `Acme/Repo-${String(index).padStart(4, "0")}`,
        enabled: true, availability: "available" as const,
      }))).returning();
      const [unavailable, channel, unrelated] = await db.insert(chatEndpointResources).values([
        { companyId: fixture.companyId, endpointId: endpoint.id, type: "repository", providerResourceId: "unavailable", label: "Unavailable", enabled: true, availability: "unavailable" },
        { companyId: fixture.companyId, endpointId: endpoint.id, type: "channel", providerResourceId: "channel", label: "Channel", enabled: true, availability: "available" },
        { companyId: foreign.companyId, endpointId: other.id, type: "repository", providerResourceId: "foreign", label: "Foreign", enabled: true, availability: "available" },
      ]).returning();
      const app = routesApp(db, fixture.companyId, context.service);
      const path = `/api/chat-endpoints/${endpoint.id}/github/repositories`;
      const first = await request(app).get(path).expect(200);
      expect(first.body).toMatchObject({ nextOffset: 20, totalCount: 1001, enabledCount: 1001, availableCount: 1000 });
      expect(first.body.items).toHaveLength(20);
      const second = await request(app).get(path).query({ offset: 20 }).expect(200);
      expect(second.body.items).toHaveLength(20);
      expect(second.body.items.some((row: { id: string }) => first.body.items.some((initial: { id: string }) => initial.id === row.id))).toBe(false);
      const search = await request(app).get(path).query({ search: "repo-0999" }).expect(200);
      expect(search.body.items.map((row: { label: string }) => row.label)).toEqual(["Acme/Repo-0999"]);
      expect(search.body.totalCount).toBe(1001);
      expect((await request(app).get(path).query({ search: "%" }).expect(200)).body.items).toEqual([]);
      await request(app).get(path).query({ limit: 1000 }).expect(400);
      await request(app).get(path).query({ offset: -1 }).expect(400);
      await request(app).put(`${path}/access`).send({ enabled: false, search: "repo-0999" }).expect(400);
      await request(app).put(`${path}/access`).send({ enabled: false }).expect(200);
      const afterOff = await context.service.listGitHubRepositories(endpoint.id, { limit: 20, offset: 0, search: "" });
      expect(afterOff.enabledCount).toBe(0);
      expect((await db.select().from(chatEndpointResources).where(inArray(chatEndpointResources.id, [channel.id, unrelated.id]))).every((row) => row.enabled)).toBe(true);
      const [last] = await db.select().from(chatEndpointResources).where(eq(chatEndpointResources.id, all[999].id));
      expect(last.enabled).toBe(false);
      await request(app).put(`${path}/access`).send({ enabled: true }).expect(200);
      expect((await context.service.listGitHubRepositories(endpoint.id, { limit: 20, offset: 0, search: "" })).enabledCount).toBe(1000);
      expect((await db.select().from(chatEndpointResources).where(eq(chatEndpointResources.id, unavailable.id)))[0].enabled).toBe(false);
      const saved = await context.service.get(endpoint.id);
      expect(saved.setup.github?.repositorySelectionSaved).toBe(true);
      const audits = await db.select().from(activityLog).where(and(eq(activityLog.companyId, fixture.companyId), eq(activityLog.action, "chat_endpoint.resources_updated"))).orderBy(asc(activityLog.createdAt));
      expect(audits).toHaveLength(2);
      expect(audits.every((audit) => audit.actorId === "owner-user")).toBe(true);
      expect((audits[0].details!.changes as unknown[])).toHaveLength(1001);
      expect((audits[1].details!.changes as unknown[])).toHaveLength(1000);
      const crossCompany = routesApp(db, foreign.companyId, context.service);
      expect((await request(crossCompany).get(path)).status).toBeOneOf([403, 404]);
      expect((await request(crossCompany).put(`${path}/access`).send({ enabled: false })).status).toBeOneOf([403, 404]);
      expect(context.wakeup).not.toHaveBeenCalled();
      await context.service.shutdown();
    });
  });

  describe("resource change auditing", () => {
    async function setupResourceAudit() {
      const fixture = await seedCompany();
      const context = createService();
      const endpoint = await context.service.create(
        fixture.companyId,
        {
          provider: "slack",
          assignedAgentId: fixture.assignedAgentId,
        },
        "owner-user",
      );
      const resources = await db
        .insert(chatEndpointResources)
        .values([
          {
            companyId: fixture.companyId,
            endpointId: endpoint.id,
            type: "channel",
            providerResourceId: "C-AUDIT-FIRST",
            label: "private-label-not-for-audit",
            metadata: { credential: "private-resource-metadata" },
            enabled: true,
            availability: "available",
          },
          {
            companyId: fixture.companyId,
            endpointId: endpoint.id,
            type: "channel",
            providerResourceId: "C-AUDIT-SECOND",
            label: "second",
            enabled: false,
            availability: "available",
          },
        ])
        .returning();
      const audits = () =>
        db
          .select()
          .from(activityLog)
          .where(
            and(
              eq(activityLog.companyId, fixture.companyId),
              eq(activityLog.action, "chat_endpoint.resources_updated"),
            ),
          )
          .orderBy(asc(activityLog.createdAt));
      return {
        ...context,
        ...fixture,
        endpoint,
        resources,
        audits,
        app: routesApp(db, fixture.companyId, context.service),
      };
    }

    it("records exact actual changes and authenticated route actor, without resource content", async () => {
      const context = await setupResourceAudit();
      const { app, audits, companyId, endpoint, resources, service, wakeup } =
        context;
      const events: unknown[] = [];
      const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
        if (
          event.type === "activity.logged" &&
          event.payload.action === "chat_endpoint.resources_updated"
        )
          events.push(event.payload);
      });
      try {
        await request(app)
          .put(`/api/chat-endpoints/${endpoint.id}/resources`)
          .send({
            resources: resources.map((resource) => ({
              id: resource.id,
              enabled: false,
            })),
          })
          .expect(200);
        const rows = await audits();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          companyId,
          actorType: "user",
          actorId: "owner-user",
          responsibleUserId: "owner-user",
          entityType: "tool_connection",
          entityId: endpoint.connectionId,
          details: {
            endpointId: endpoint.id,
            provider: "slack",
            changes: [
              {
                resourceId: resources[0]!.id,
                before: { enabled: true },
                after: { enabled: false },
              },
            ],
          },
        });
        expect(rows[0]!.details).toEqual({
          permissionDecision: expect.objectContaining({ operation: "PUT /chat-endpoints/:endpointId/resources" }),
          endpointId: endpoint.id,
          provider: "slack",
          changes: [
            {
              resourceId: resources[0]!.id,
              before: { enabled: true },
              after: { enabled: false },
            },
          ],
        });
        expect(events).toHaveLength(1);
        expect(JSON.stringify(events)).not.toContain("private-");
        await request(app)
          .put(`/api/chat-endpoints/${endpoint.id}/resources`)
          .send({
            resources: [{ id: resources[0]!.id, enabled: true }],
            actorUserId: "spoofed",
          })
          .expect(400);
        await request(app)
          .put(`/api/chat-endpoints/${endpoint.id}/resources`)
          .send({
            resources: resources.map((resource) => ({
              id: resource.id,
              enabled: false,
            })),
          })
          .expect(200);
        await request(app)
          .put(`/api/chat-endpoints/${endpoint.id}/resources`)
          .send({ resources: [] })
          .expect(200);
        expect(await audits()).toHaveLength(1);
        expect(events).toHaveLength(1);
        expect(wakeup).not.toHaveBeenCalled();
      } finally {
        unsubscribe();
        await service.shutdown();
      }
    });
  });

  describe("resource change audit atomicity", () => {
    async function fixtureForAudit(
      overrides: Parameters<typeof createService>[2] = {},
    ) {
      const fixture = await seedCompany();
      const context = createService(undefined, undefined, overrides);
      const endpoint = await context.service.create(
        fixture.companyId,
        {
          provider: "slack",
          assignedAgentId: fixture.assignedAgentId,
        },
        "owner-user",
      );
      const [resource] = await db
        .insert(chatEndpointResources)
        .values({
          companyId: fixture.companyId,
          endpointId: endpoint.id,
          type: "channel",
          providerResourceId: "C-RESOURCE-AUDIT",
          label: "audit",
          availability: "available",
          enabled: true,
        })
        .returning();
      const audits = () =>
        db
          .select()
          .from(activityLog)
          .where(
            and(
              eq(activityLog.companyId, fixture.companyId),
              eq(activityLog.action, "chat_endpoint.resources_updated"),
            ),
          )
          .orderBy(asc(activityLog.createdAt));
      const current = () =>
        db
          .select({ enabled: chatEndpointResources.enabled })
          .from(chatEndpointResources)
          .where(eq(chatEndpointResources.id, resource!.id));
      const events: unknown[] = [];
      const unsubscribe = subscribeCompanyLiveEvents(
        fixture.companyId,
        (event) => {
          if (
            event.type === "activity.logged" &&
            event.payload.action === "chat_endpoint.resources_updated"
          )
            events.push(event.payload);
        },
      );
      return {
        ...context,
        ...fixture,
        endpoint,
        resource: resource!,
        audits,
        current,
        events,
        async cleanup() {
          unsubscribe();
          await context.service.shutdown();
        },
      };
    }

    it("keeps duplicate last-write semantics but audits only net changes", async () => {
      const context = await fixtureForAudit();
      const { service, endpoint, resource, audits, events } = context;
      try {
        await service.replaceResources(
          endpoint.id,
          [
            { id: resource.id, enabled: false },
            { id: resource.id, enabled: true },
          ],
          "owner-user",
        );
        expect(await audits()).toEqual([]);
        expect(events).toEqual([]);
        await service.replaceResources(
          endpoint.id,
          [
            { id: resource.id, enabled: true },
            { id: resource.id, enabled: false },
          ],
          "owner-user",
        );
        expect(await context.current()).toEqual([{ enabled: false }]);
        expect(await audits()).toMatchObject([
          {
            details: {
              changes: [
                {
                  resourceId: resource.id,
                  before: { enabled: true },
                  after: { enabled: false },
                },
              ],
            },
          },
        ]);
        expect(events).toHaveLength(1);
      } finally {
        await context.cleanup();
      }
    });

    it.each(["foreign", "unavailable"] as const)(
      "rolls back the entire %s resource batch without audit or events",
      async (kind) => {
        const context = await fixtureForAudit();
        const foreign = await fixtureForAudit();
        try {
          const [other] = await db
            .insert(chatEndpointResources)
            .values({
              companyId: context.companyId,
              endpointId: context.endpoint.id,
              type: "channel",
              providerResourceId: "C-UNAVAILABLE",
              label: "unavailable",
              availability: "unavailable",
              enabled: false,
            })
            .returning();
          await expect(
            context.service.replaceResources(
              context.endpoint.id,
              [
                { id: context.resource.id, enabled: false },
                ...(kind === "foreign"
                  ? [{ id: foreign.resource.id, enabled: false }]
                  : [
                      { id: other!.id, enabled: true },
                      { id: other!.id, enabled: false },
                    ]),
              ],
              "owner-user",
            ),
          ).rejects.toMatchObject({ status: kind === "foreign" ? 422 : 409 });
          expect(await context.current()).toEqual([{ enabled: true }]);
          expect(await foreign.current()).toEqual([{ enabled: true }]);
          expect(await context.audits()).toEqual([]);
          expect(context.events).toEqual([]);
          expect(foreign.events).toEqual([]);
        } finally {
          await context.cleanup();
          await foreign.cleanup();
        }
      },
    );

    it.each(["audit_insert", "after_audit"] as const)(
      "rolls back resource writes and suppresses events on %s failure",
      async (failureAt) => {
        const context = await fixtureForAudit();
        const failure = new Error(`resource-audit-${failureAt}`);
        const transaction = db.transaction.bind(db);
        let sawAudit = false;
        const transactionSpy = vi
          .spyOn(db, "transaction")
          .mockImplementation((callback, config) =>
            transaction(async (tx) => {
              const insert = tx.insert.bind(tx);
              const insertSpy = vi
                .spyOn(tx, "insert")
                .mockImplementation((table) => {
                  if (table === activityLog && failureAt === "audit_insert") {
                    sawAudit = true;
                    throw failure;
                  }
                  return insert(table);
                });
              try {
                const result = await callback(tx);
                if (failureAt === "after_audit") {
                  const rows = await tx
                    .select()
                    .from(activityLog)
                    .where(
                      and(
                        eq(activityLog.companyId, context.companyId),
                        eq(
                          activityLog.action,
                          "chat_endpoint.resources_updated",
                        ),
                      ),
                    );
                  expect(rows).toHaveLength(1);
                  sawAudit = true;
                  expect(context.events).toEqual([]);
                  throw failure;
                }
                return result;
              } finally {
                insertSpy.mockRestore();
              }
            }, config),
          );
        try {
          await expect(
            context.service.replaceResources(
              context.endpoint.id,
              [{ id: context.resource.id, enabled: false }],
              "owner-user",
            ),
          ).rejects.toBe(failure);
          expect(sawAudit).toBe(true);
          expect(await context.current()).toEqual([{ enabled: true }]);
          expect(await context.audits()).toEqual([]);
          expect(context.events).toEqual([]);
        } finally {
          transactionSpy.mockRestore();
          await context.cleanup();
        }
      },
    );

    it.each(["inside_transaction", "after_commit"] as const)(
      "keeps the audit aligned with commit on lease loss %s",
      async (failureAt) => {
        let renewals = 0;
        const context = await fixtureForAudit({
          credentialMutationLeaseRenewalIntervalMs: 60_000,
          renewCredentialMutationLease: async () =>
            ++renewals !== (failureAt === "inside_transaction" ? 2 : 3),
        });
        try {
          await expect(
            context.service.replaceResources(
              context.endpoint.id,
              [{ id: context.resource.id, enabled: false }],
              "owner-user",
            ),
          ).rejects.toMatchObject({ code: "CHAT_CREDENTIAL_LEASE_LOST" });
          const committed = failureAt === "after_commit";
          expect(await context.current()).toEqual([{ enabled: !committed }]);
          expect(await context.audits()).toHaveLength(committed ? 1 : 0);
          expect(context.events).toHaveLength(committed ? 1 : 0);
          await context.service.replaceResources(
            context.endpoint.id,
            [{ id: context.resource.id, enabled: false }],
            "owner-user",
          );
          expect(await context.audits()).toHaveLength(1);
          expect(context.events).toHaveLength(1);
        } finally {
          await context.cleanup();
        }
      },
    );

    it("reads the actual resource state after the row lock, not a pre-lock snapshot", async () => {
      const context = await fixtureForAudit();
      let ready!: (pid: number) => void;
      const held = new Promise<number>((resolve) => {
        ready = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const transaction = db.transaction(async (tx) => {
        await tx
          .update(chatEndpointResources)
          .set({ enabled: false })
          .where(eq(chatEndpointResources.id, context.resource.id));
        const [row] = (await tx.execute(
          sql`select pg_backend_pid() as pid`,
        )) as unknown as Array<{ pid: number }>;
        ready(row!.pid);
        await gate;
      });
      let mutation: Promise<unknown> | undefined;
      try {
        const pid = await held;
        mutation = context.service.replaceResources(
          context.endpoint.id,
          [{ id: context.resource.id, enabled: false }],
          "owner-user",
        );
        await vi.waitFor(async () => {
          const [row] = (await db.execute(sql`select exists (
            select 1 from pg_stat_activity where datname = current_database()
              and ${pid} = any(pg_blocking_pids(pid))
          ) as blocked`)) as unknown as Array<{ blocked: boolean }>;
          expect(row!.blocked).toBe(true);
        });
        release();
        await Promise.all([transaction, mutation]);
        expect(await context.current()).toEqual([{ enabled: false }]);
        expect(await context.audits()).toEqual([]);
        expect(context.events).toEqual([]);
        await context.service.replaceResources(
          context.endpoint.id,
          [{ id: context.resource.id, enabled: true }],
          "owner-user",
        );
        expect(await context.audits()).toMatchObject([
          {
            details: {
              changes: [
                {
                  resourceId: context.resource.id,
                  before: { enabled: false },
                  after: { enabled: true },
                },
              ],
            },
          },
        ]);
      } finally {
        release();
        await Promise.allSettled([
          transaction,
          ...(mutation ? [mutation] : []),
        ]);
        await context.cleanup();
      }
    });

    it("joins concurrent identical and opposite changes into actual before/after history", async () => {
      const context = await fixtureForAudit();
      try {
        const change = (enabled: boolean) =>
          context.service.replaceResources(
            context.endpoint.id,
            [{ id: context.resource.id, enabled }],
            "owner-user",
          );
        await Promise.all([change(false), change(false)]);
        expect(await context.audits()).toHaveLength(1);
        await Promise.all([change(true), change(false)]);
        const rows = await context.audits();
        expect(rows.length).toBeGreaterThanOrEqual(2);
        let enabled = true;
        for (const row of rows) {
          const changes = row.details!.changes as Array<{
            resourceId: string;
            before: { enabled: boolean };
            after: { enabled: boolean };
          }>;
          expect(changes).toHaveLength(1);
          expect(changes[0]!.resourceId).toBe(context.resource.id);
          expect(changes[0]!.before.enabled).toBe(enabled);
          expect(changes[0]!.after.enabled).toBe(!enabled);
          enabled = !enabled;
        }
        expect(await context.current()).toEqual([{ enabled }]);
        expect(context.events).toHaveLength(rows.length);
        expect(context.wakeup).not.toHaveBeenCalled();
      } finally {
        await context.cleanup();
      }
    });
  });

  it("requires connection-manager authority for chat connector administration", async () => {
    const fixture = await seedCompany();
    const { service } = createService();
    const endpoint = await service.create(
      fixture.companyId,
      {
        provider: "github",
        assignedAgentId: fixture.assignedAgentId,
      },
      "owner-user",
    );
    const memberUserId = `member-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({
      id: memberUserId,
      name: "Ordinary Member",
      email: `${memberUserId}@example.com`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId: fixture.companyId,
      principalType: "user",
      principalId: memberUserId,
      status: "active",
      membershipRole: "member",
    });

    const memberApp = routesApp(db, fixture.companyId, service, memberUserId);
    await request(memberApp)
      .get(`/api/chat-endpoints/${endpoint.id}`)
      .expect(200);
    await request(memberApp)
      .get(`/api/companies/${fixture.companyId}/chat-endpoints`)
      .expect(200);

    const deniedMutations = [
      request(memberApp)
        .put(`/api/chat-endpoints/${endpoint.id}/github/repositories/access`)
        .send({ enabled: false }),
      request(memberApp)
        .post(`/api/companies/${fixture.companyId}/chat-endpoints`)
        .send({ provider: "slack", assignedAgentId: fixture.assignedAgentId }),
      request(memberApp)
        .patch(`/api/chat-endpoints/${endpoint.id}`)
        .send({ allowDirectMessages: true }),
      request(memberApp)
        .post(`/api/chat-endpoints/${endpoint.id}/setup`)
        .send({ action: "pause" }),
      request(memberApp).post(
        `/api/chat-endpoints/${endpoint.id}/setup-secret`,
      ),
      request(memberApp).post(`/api/chat-endpoints/${endpoint.id}/test`),
      request(memberApp)
        .put(`/api/chat-endpoints/${endpoint.id}/resources`)
        .send({ resources: [] }),
      request(memberApp)
        .post(
          `/api/chat-endpoints/${endpoint.id}/principals/${randomUUID()}/link-intent`,
        )
        .send({}),
      request(memberApp).delete(
        `/api/chat-endpoints/${endpoint.id}/principals/${randomUUID()}/link`,
      ),
      request(memberApp).post(
        `/api/chat-endpoints/${endpoint.id}/deliveries/${randomUUID()}/replay`,
      ),
      request(memberApp).post(
        `/api/chat-endpoints/${endpoint.id}/publications/${randomUUID()}/replay`,
      ),
      request(memberApp)
        .post(
          `/api/chat-endpoints/${endpoint.id}/publications/${randomUUID()}/resolve`,
        )
        .send({ action: "cancel" }),
      request(memberApp)
        .post(
          `/api/chat-endpoints/${endpoint.id}/actions/${randomUUID()}/resolve`,
        )
        .send({ action: "cancel" }),
    ];
    for (const mutation of deniedMutations) {
      const response = await mutation.expect(403);
      expect(response.body.error).toContain(
        "Missing permission: tools:manage_connections",
      );
    }

    const managerApp = routesApp(db, fixture.companyId, service);
    await request(managerApp)
      .patch(`/api/chat-endpoints/${endpoint.id}`)
      .send({ allowDirectMessages: true })
      .expect(200)
      .expect(({ body }) => {
        expect(body.allowDirectMessages).toBe(true);
      });
  });

  it("returns not found rather than revealing another company's chat endpoint", async () => {
    const viewerCompany = await seedCompany();
    const ownerCompany = await seedCompany();
    const { service } = createService();
    const endpoint = await service.create(
      ownerCompany.companyId,
      {
        provider: "telegram",
        assignedAgentId: ownerCompany.assignedAgentId,
      },
      "owner-user",
    );
    const app = routesApp(db, viewerCompany.companyId, service);

    await request(app).get(`/api/chat-endpoints/${endpoint.id}`).expect(404);
    await request(app)
      .patch(`/api/chat-endpoints/${endpoint.id}`)
      .send({ allowDirectMessages: true })
      .expect(404);
  });

  it("does not let two live agent connections claim the same native bot or spoof its verified identity", async () => {
    const fixture = await seedCompany();
    const { service } = createService(
      new FakeChatSdkRuntime(),
      fakeSlackFetch("U-ONE-NATIVE-BOT") as typeof globalThis.fetch,
    );
    const first = await service.create(
      fixture.companyId,
      {
        provider: "slack",
        assignedAgentId: fixture.assignedAgentId,
      },
      "owner-user",
    );
    const second = await service.create(
      fixture.companyId,
      {
        provider: "slack",
        assignedAgentId: fixture.replacementAgentId,
      },
      "owner-user",
    );
    await service.configure(
      first.id,
      {
        action: "configure",
        credentials: {
          botToken: "xoxb-first-agent",
          signingSecret: "first-signing-secret",
        },
      },
      "owner-user",
    );
    await expect(
      service.configure(
        second.id,
        {
          action: "configure",
          credentials: {
            botToken: "xoxb-second-agent",
            signingSecret: "second-signing-secret",
          },
        },
        "owner-user",
      ),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        code: "chat_bot_identity_in_use",
        endpointId: first.id,
        assignedAgentId: fixture.assignedAgentId,
      },
    });

    const app = routesApp(db, fixture.companyId, service);
    await request(app)
      .post(`/api/chat-endpoints/${second.id}/setup`)
      .send({
        action: "configure",
        providerAccountId: "T-SPOOFED",
        botExternalId: "U-SPOOFED",
        credentials: {
          botToken: "xoxb-spoof",
          signingSecret: "spoof-signing-secret",
        },
      })
      .expect(400);
  });

  it.each([
    {
      provider: "slack" as const,
      claimedIdentity: {
        providerAccountId: "T-PAPERCLIP",
        botExternalId: "U-CLAIMED-BOT",
        botUsername: "maya-claimed",
      },
      providerFetch: fakeSlackFetch(
        "U-DIFFERENT-BOT",
      ) as typeof globalThis.fetch,
      credentials: {
        botToken: "xoxb-different-bot",
        signingSecret: "different-signing-secret",
      } as Record<string, string>,
    },
    {
      provider: "microsoft-teams" as const,
      claimedIdentity: {
        providerAccountId: "00000000-0000-4000-8000-000000000191",
        botExternalId: "00000000-0000-4000-8000-000000000192",
        botUsername: null,
      },
      providerFetch: (async () =>
        new Response(JSON.stringify({ access_token: "teams-access" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof globalThis.fetch,
      credentials: {
        clientId: "00000000-0000-4000-8000-000000000193",
        tenantId: "00000000-0000-4000-8000-000000000191",
        clientSecret: "different-teams-secret",
      } as Record<string, string>,
    },
  ])(
    "keeps a claimed $provider identity immutable when first setup resumes from attention",
    async ({ provider, claimedIdentity, providerFetch, credentials }) => {
      const fixture = await seedCompany();
      const { service } = createService(
        new FakeChatSdkRuntime(),
        providerFetch,
      );
      const endpoint = await service.create(
        fixture.companyId,
        { provider, assignedAgentId: fixture.assignedAgentId },
        "owner-user",
      );

      // Model a process interruption after the provider identity claim and
      // before credential refs were committed. Retrying the original
      // `configure` request must not be able to replace that identity.
      await db
        .update(chatEndpoints)
        .set({
          status: "attention",
          ...claimedIdentity,
          healthMessage: "Provider setup must be completed",
        })
        .where(eq(chatEndpoints.id, endpoint.id));

      await expect(
        service.configure(
          endpoint.id,
          { action: "configure", credentials },
          "owner-user",
        ),
      ).rejects.toMatchObject({
        status: 409,
        details: { code: "chat_bot_identity_changed" },
      });
      await expect(service.get(endpoint.id)).resolves.toMatchObject({
        status: "attention",
        providerAccountId: claimedIdentity.providerAccountId,
        botExternalId: claimedIdentity.botExternalId,
      });
      await expect(
        db
          .select({ refs: toolConnections.credentialSecretRefs })
          .from(toolConnections)
          .where(eq(toolConnections.id, endpoint.connectionId))
          .then((rows) => rows[0]?.refs ?? []),
      ).resolves.toEqual([]);
      await service.shutdown();
    },
  );

  it("globally fences GitHub App identity across owner transfers without leaking another company", async () => {
    const firstCompany = await seedCompany();
    const secondCompany = await seedCompany();
    const appRegistrationId = 987654321;
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    let inventoryRequestCount = 0;
    let releaseInventory!: () => void;
    const bothInventoriesStarted = new Promise<void>((resolve) => {
      releaseInventory = resolve;
    });
    const providerFetch = (owner: string, installationId: number) =>
      (async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "https://api.github.com/app") {
          return new Response(
            JSON.stringify({
              id: appRegistrationId,
              slug: "shared-paperclip-app",
              name: "Shared Paperclip App",
              owner: { login: owner },
              permissions: {
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
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url === "https://api.github.com/app/installations?per_page=100") {
          inventoryRequestCount += 1;
          if (inventoryRequestCount === 2) releaseInventory();
          await bothInventoriesStarted;
          return new Response(
            JSON.stringify([
              {
                id: installationId,
                account: { id: installationId, login: owner },
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
          url ===
          `https://api.github.com/app/installations/${installationId}/access_tokens`
        ) {
          return new Response(JSON.stringify({ token: "installation-token" }), {
            status: 201,
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url ===
          "https://api.github.com/installation/repositories?per_page=100&page=1"
        ) {
          return new Response(JSON.stringify({ repositories: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`Unexpected provider request: ${url}`);
      }) as typeof globalThis.fetch;
    const first = createService(
      new FakeChatSdkRuntime(),
      providerFetch("original-owner", 8101),
    );
    const second = createService(
      new FakeChatSdkRuntime(),
      providerFetch("transferred-owner", 8102),
    );
    const firstEndpoint = await first.service.create(
      firstCompany.companyId,
      {
        provider: "github",
        assignedAgentId: firstCompany.assignedAgentId,
      },
      "owner-user",
    );
    const secondEndpoint = await second.service.create(
      secondCompany.companyId,
      {
        provider: "github",
        assignedAgentId: secondCompany.assignedAgentId,
      },
      "owner-user",
    );
    for (const [service, endpoint] of [
      [first.service, firstEndpoint],
      [second.service, secondEndpoint],
    ] as const) {
      const { webhookSecret } = await service.generateSetupSecret(
        endpoint.id,
        "owner-user",
      );
      await recordGitHubWebhookVerification(
        service,
        endpoint.publicId,
        webhookSecret,
      );
    }
    const endpoints = [firstEndpoint, secondEndpoint] as const;
    const services = [first.service, second.service] as const;
    const outcomes = await Promise.allSettled(
      services.map((service, index) =>
        service.configure(
          endpoints[index]!.id,
          {
            action: "configure",
            credentials: { appId: "123456", privateKey },
          },
          "owner-user",
        ),
      ),
    );
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    const rejectedIndex = outcomes.findIndex(
      (outcome) => outcome.status === "rejected",
    );
    expect(rejectedIndex).toBeGreaterThanOrEqual(0);
    const conflict = (outcomes[rejectedIndex] as PromiseRejectedResult).reason;
    expect(conflict).toMatchObject({
      status: 409,
      details: {
        code: "chat_bot_identity_in_use",
      },
    });
    expect(conflict).not.toMatchObject({
      details: {
        endpointId: expect.any(String),
        assignedAgentId: expect.any(String),
      },
    });
    await expect(
      db
        .select({ refs: toolConnections.credentialSecretRefs })
        .from(toolConnections)
        .where(eq(toolConnections.id, endpoints[rejectedIndex]!.connectionId))
        .then(
          (rows) => rows[0]?.refs.map((ref) => ref.configPath).sort() ?? [],
        ),
    ).resolves.toEqual(["credentials.webhookSecret"]);
    await first.service.shutdown();
    await second.service.shutdown();
  });

  it("configures a customer-owned GitHub App and only auto-enables the first addressed setup repository", async () => {
    const fixture = await seedCompany();
    const appId = "123456";
    const privateKey = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    let observedIssuer: string | null = null;
    let appRegistrationId = 789;
    const providerFetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url === "https://api.github.com/app") {
          const authorization = new Headers(init?.headers).get("authorization");
          const token = authorization?.replace(/^Bearer\s+/i, "");
          const payload = token?.split(".")[1];
          if (!payload) throw new Error("GitHub App JWT was not sent");
          observedIssuer = String(
            (
              JSON.parse(
                Buffer.from(payload, "base64url").toString("utf8"),
              ) as { iss?: unknown }
            ).iss,
          );
          return new Response(
            JSON.stringify({
              id: appRegistrationId,
              slug: "maya-paperclip",
              name: "Maya Paperclip",
              owner: { login: "paperclipai" },
              permissions: {
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
              ],
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
          return new Response(JSON.stringify({ token: "installation-token" }), {
            status: 201,
            headers: { "content-type": "application/json" },
          });
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
                {
                  id: 97532,
                  full_name: "paperclipai/paperclip-disabled",
                  html_url: "https://github.com/paperclipai/paperclip-disabled",
                  owner: { id: 1357, login: "paperclipai" },
                  private: false,
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`Unexpected provider request: ${url}`);
      },
    ) as unknown as typeof globalThis.fetch;
    const { runtime, service } = createService(
      new FakeChatSdkRuntime(),
      providerFetch,
      { scheduleDeferredWork: () => undefined },
    );
    const endpoint = await service.create(
      fixture.companyId,
      {
        provider: "github",
        assignedAgentId: fixture.assignedAgentId,
      },
      "owner-user",
    );
    const app = routesApp(db, fixture.companyId, service);
    const generatedSecretResponse = await request(app)
      .post(`/api/chat-endpoints/${endpoint.id}/setup-secret`)
      .send({})
      .expect(201);
    const generatedWebhookSecret = generatedSecretResponse.body
      .webhookSecret as string;
    expect(generatedSecretResponse.headers["cache-control"]).toBe("no-store");
    expect(generatedWebhookSecret).toMatch(/^[a-f0-9]{64}$/);
    const endpointAfterGeneration = await request(app)
      .get(`/api/chat-endpoints/${endpoint.id}`)
      .expect(200);
    expect(endpointAfterGeneration.body.setup.webhookSecretConfigured).toBe(
      true,
    );
    expect(JSON.stringify(endpointAfterGeneration.body)).not.toContain(
      generatedWebhookSecret,
    );
    await expect(
      service.configure(
        endpoint.id,
        {
          action: "configure",
          credentials: { appId, privateKey },
        },
        "owner-user",
      ),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: "chat_webhook_not_verified" },
    });
    await recordGitHubWebhookVerification(
      service,
      endpoint.publicId,
      generatedWebhookSecret,
    );

    const configured = await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          appId,
          privateKey,
        },
      },
      "owner-user",
    );

    expect(observedIssuer).toBe(appId);
    expect(configured).toMatchObject({
      status: "verifying",
      providerAccountId: "paperclipai",
      botExternalId: "789",
      botUsername: "maya-paperclip[bot]",
      setup: { step: "test", webhookVerifiedAt: expect.any(String) },
    });
    expect(
      runtime.configurations.get(endpoint.id)?.providerConfig,
    ).toMatchObject({
      provider: "github",
      credentials: {
        appId,
        privateKey,
        installationId: 2468,
        webhookSecret: generatedWebhookSecret,
      },
    });
    const githubConfig = runtime.configurations.get(endpoint.id)?.providerConfig;
    expect(
      githubConfig?.provider ===
        "github" &&
        githubConfig.credentials
          .botUserId,
    ).toBeUndefined();
    appRegistrationId = 790;
    await expect(
      service.configure(
        endpoint.id,
        {
          action: "reconnect",
          credentials: { appId, privateKey },
        },
        "owner-user",
      ),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: "chat_bot_identity_changed" },
    });
    appRegistrationId = 789;
    const [connection] = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));
    expect(connection.refs.map((ref) => ref.configPath).sort()).toEqual([
      "credentials.appId",
      "credentials.installationId",
      "credentials.privateKey",
      "credentials.webhookSecret",
    ]);
    const githubResources = await service.listResources(endpoint.id);
    expect(
      githubResources.map((resource) => ({
        providerResourceId: resource.providerResourceId,
        availability: resource.availability,
        enabled: resource.enabled,
      })),
    ).toEqual([
      {
        providerResourceId: "paperclipai/paperclip",
        availability: "available",
        enabled: false,
      },
      {
        providerResourceId: "paperclipai/paperclip-disabled",
        availability: "available",
        enabled: false,
      },
    ]);
    const githubCallbacks = runtime.configurations.get(endpoint.id)?.callbacks;
    if (!githubCallbacks) throw new Error("Expected GitHub callbacks");
    await deliverMessage({
      callbacks: githubCallbacks,
      endpointId: endpoint.id,
      provider: "github",
      thread: makeThread({
        channelId: "PaperclipAI/Paperclip",
        id: "github:PaperclipAI/Paperclip:issue:17",
        name: "paperclipai/paperclip",
      }).thread,
      message: makeMessage({
        id: "github-root-17",
        text: "@maya triage issue 17",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await expect(
      readChatConversationsByEndpointId(endpoint.id),
    ).resolves.toHaveLength(1);
    expect(
      (await service.listResources(endpoint.id)).map((resource) => ({
        providerResourceId: resource.providerResourceId,
        enabled: resource.enabled,
      })),
    ).toEqual([
      { providerResourceId: "paperclipai/paperclip", enabled: true },
      {
        providerResourceId: "paperclipai/paperclip-disabled",
        enabled: false,
      },
    ]);
    await service.handleWebhook(
      endpoint.publicId,
      "github",
      signedGitHubWebhookRequest({
        delivery: "github-repository-removed",
        event: "installation_repositories",
        payload: {
          action: "removed",
          repositories_added: [],
          repositories_removed: [
            {
              id: 97531,
              full_name: "paperclipai/paperclip",
              html_url: "https://github.com/paperclipai/paperclip",
              owner: { id: 1357, login: "paperclipai" },
            },
          ],
        },
        webhookSecret: generatedWebhookSecret,
      }),
    );
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "paperclipai/paperclip",
        availability: "available",
        enabled: true,
      }),
      expect.objectContaining({
        providerResourceId: "paperclipai/paperclip-disabled",
        availability: "available",
        enabled: false,
      }),
    ]);
    await service.handleWebhook(
      endpoint.publicId,
      "github",
      signedGitHubWebhookRequest({
        delivery: "github-installation-suspended",
        event: "installation",
        payload: {
          action: "suspend",
          installation: { id: 2468 },
        },
        webhookSecret: generatedWebhookSecret,
      }),
    );
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "verifying",
      healthMessage: "Waiting for a test conversation",
    });
    expect(runtime.endpoints.has(endpoint.id)).toBe(true);
  });

  it("admits only an addressed raw GitHub comment as the first setup repository", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service, webhookSecret } =
      await configuredGitHubEndpoint(fixture);
    const [resource] = await service.listResources(endpoint.id);
    await service.replaceResources(endpoint.id, [
      { id: resource!.id, enabled: false },
    ]);
    const endpointRuntime = runtime.endpoints.get(endpoint.id);
    const currentEndpoint = await service.get(endpoint.id);
    if (!endpointRuntime || !currentEndpoint.botUsername)
      throw new Error("Expected configured GitHub runtime identity");
    attachFakeGitHubIssueCommentWebhook({
      botUsername: currentEndpoint.botUsername,
      callbacks,
      endpointId: endpoint.id,
      runtime: endpointRuntime,
    });
    const payload = (body: string, commentId: number, issueNumber: number) => ({
      action: "created",
      installation: { id: 2468 },
      repository: {
        id: 97531,
        full_name: "paperclipai/paperclip",
        name: "paperclip",
        owner: { id: 1357, login: "paperclipai" },
      },
      issue: { number: issueNumber },
      comment: {
        id: commentId,
        body,
        created_at: "2026-09-06T12:00:00Z",
        updated_at: "2026-09-06T12:00:00Z",
        user: { id: 42, login: "octocat" },
      },
      sender: { id: 42, login: "octocat" },
    });
    const unaddressedMarker = `private-unaddressed-${randomUUID()}`;
    const ignored = await service.handleWebhook(
      endpoint.publicId,
      "github",
      signedGitHubWebhookRequest({
        delivery: "github-unaddressed-first-setup",
        event: "issue_comment",
        payload: payload(unaddressedMarker, 17001, 17),
        webhookSecret,
      }),
    );
    expect(ignored.status).toBe(200);
    expect(endpointRuntime.webhookRequest).toBeNull();
    await expect(
      db.execute(
        sql`select id from chat_actions where endpoint_id = ${endpoint.id} and payload::text like ${`%${unaddressedMarker}%`}`,
      ),
    ).resolves.toHaveLength(0);

    const botMention = currentEndpoint.botUsername.replace(/\[bot\]$/i, "");
    const accepted = await service.handleWebhook(
      endpoint.publicId,
      "github",
      signedGitHubWebhookRequest({
        delivery: "github-addressed-first-setup",
        event: "issue_comment",
        payload: payload(`@${botMention} triage issue 18`, 18001, 18),
        webhookSecret,
      }),
    );
    expect(accepted.status).toBe(202);
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "paperclipai/paperclip",
        enabled: true,
      }),
    ]);
    await expect(service.listConversations(endpoint.id)).resolves.toHaveLength(
      1,
    );
  });

  it("retries transient GitHub endpoint lock contention before accepting a wake", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service } =
      await configuredGitHubEndpoint(fixture);
    const current = await service.get(endpoint.id);
    const { thread, subscribe } = makeThread({
      channelId: "paperclipai/paperclip",
      id: "github:paperclipai/paperclip:903",
    });
    let release!: () => void;
    let acquired!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    let transaction: Promise<unknown> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    subscribe.mockImplementationOnce(async () => {
      transaction = db.transaction(async (tx) => {
        await tx
          .select({ id: chatEndpoints.id })
          .from(chatEndpoints)
          .where(eq(chatEndpoints.id, endpoint.id))
          .for("no key update");
        acquired();
        await held;
      });
      await locked;
      timer = setTimeout(release, 250);
      return undefined;
    });
    try {
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider: "github",
        thread,
        trigger: "mention",
        message: makeMessage({
          id: "github-contended-admission",
          userId: "42",
          userName: "octocat",
          mentioned: true,
          text: `@${current.botUsername} review after concurrent ingress`,
        }),
      });
    } finally {
      if (timer) clearTimeout(timer);
      release();
      await transaction;
    }
    expect(subscribe).toHaveBeenCalledTimes(1);
    const deliveries = await readChatDeliveriesByEndpointId(endpoint.id);
    expect(
      deliveries.filter((delivery) => delivery.state === "processed"),
    ).toHaveLength(1);
    const wakes = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.kind, "inbound_wakeup"),
        ),
      );
    expect(wakes).toHaveLength(1);
    expect(wakes[0].status).toBe("processed");
    await expect(service.listConversations(endpoint.id)).resolves.toHaveLength(
      1,
    );
  });

  it("atomically admits only one first GitHub repository under concurrent root mentions", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service, webhookSecret } =
      await configuredGitHubEndpoint(fixture);
    const endpointRuntime = runtime.endpoints.get(endpoint.id);
    const currentEndpoint = await service.get(endpoint.id);
    if (!endpointRuntime || !currentEndpoint.botUsername)
      throw new Error("Expected configured GitHub runtime identity");
    attachFakeGitHubIssueCommentWebhook({
      botUsername: currentEndpoint.botUsername,
      callbacks,
      endpointId: endpoint.id,
      runtime: endpointRuntime,
    });
    const [firstResource] = await service.listResources(endpoint.id);
    await service.replaceResources(endpoint.id, [
      { id: firstResource!.id, enabled: false },
    ]);
    await db.insert(chatEndpointResources).values({
      companyId: endpoint.companyId,
      endpointId: endpoint.id,
      type: "repository",
      providerResourceId: "paperclipai/paperclip-second",
      label: "paperclipai/paperclip-second",
      availability: "available",
      enabled: false,
    });
    const roots = [
      {
        channelId: "paperclipai/paperclip",
        issueNumber: 901,
        messageId: 901001,
        repositoryId: 97531,
      },
      {
        channelId: "paperclipai/paperclip-second",
        issueNumber: 902,
        messageId: 902001,
        repositoryId: 97532,
      },
    ];

    await Promise.all(
      roots.map((root) => {
        const [owner, name] = root.channelId.split("/");
        return service.handleWebhook(
          endpoint.publicId,
          "github",
          signedGitHubWebhookRequest({
            delivery: `github-concurrent-root-${root.issueNumber}`,
            event: "issue_comment",
            payload: {
              action: "created",
              installation: { id: 2468 },
              repository: {
                id: root.repositoryId,
                full_name: root.channelId,
                name,
                owner: { id: 1357, login: owner },
              },
              issue: { number: root.issueNumber },
              comment: {
                id: root.messageId,
                body: `@${currentEndpoint.botUsername} investigate this race`,
                created_at: "2026-09-06T12:00:00Z",
                updated_at: "2026-09-06T12:00:00Z",
                user: { id: 42, login: "octocat" },
              },
              sender: { id: 42, login: "octocat" },
            },
            webhookSecret,
          }),
        );
      }),
    );

    const resources = await service.listResources(endpoint.id);
    expect(resources.filter((resource) => resource.enabled)).toHaveLength(1);
    const conversations = await db
      .select({ issueId: chatConversations.issueId })
      .from(chatConversations)
      .where(eq(chatConversations.endpointId, endpoint.id));
    expect(conversations).toHaveLength(1);
    const [issue] = await db
      .select({ title: issues.title })
      .from(issues)
      .where(eq(issues.id, conversations[0]!.issueId));
    expect(issue?.title).toBe("investigate this race");
  });

  it("rejects caller-controlled GitHub setup secrets and arbitrary credential fields", async () => {
    const fixture = await seedCompany();
    const providerFetch = vi.fn(async () => {
      throw new Error("Credential validation must run before provider access");
    }) as unknown as typeof globalThis.fetch;
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
    const app = routesApp(db, fixture.companyId, service);

    await request(app)
      .post(`/api/chat-endpoints/${endpoint.id}/setup`)
      .send({
        action: "configure",
        credentials: {
          appId: "123456",
          privateKey: "private-key",
          webhookSecret: "caller-controlled-secret",
        },
      })
      .expect(422);
    await expect(
      service.configure(
        endpoint.id,
        {
          action: "configure",
          credentials: {
            appId: "123456",
            privateKey: "private-key",
            installationId: "2468",
            unexpected: "value",
          },
        },
        "owner-user",
      ),
    ).rejects.toMatchObject({
      status: 422,
      details: {
        code: "chat_endpoint_credentials_invalid",
        provider: "github",
        action: "configure",
        unsupportedKeys: ["installationId", "unexpected"],
      },
    });
    expect(providerFetch).not.toHaveBeenCalled();
    const [connection] = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));
    expect(connection!.refs).toEqual([
      expect.objectContaining({ configPath: "credentials.webhookSecret" }),
    ]);
  });
});
