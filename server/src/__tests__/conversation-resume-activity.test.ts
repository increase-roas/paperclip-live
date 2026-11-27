import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, chatConversations, chatEndpoints, companies, createDb,
  issueComments, issues, toolApplications, toolConnections,
} from "@paperclipai/db";
import { publishActivity, type ActivityPublication } from "../services/activity-log.js";
import { resumeExternalConversation } from "../services/slack-conversation-state.js";
import { issueService } from "../services/issues.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("conversation resume activity commit boundary", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-conversation-resume-");
    db = createDb(database.connectionString);
  }, 30000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await database?.cleanup();
  });
  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const applicationId = randomUUID(), connectionId = randomUUID(), endpointId = randomUUID();
    const conversationId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Activity fixture", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", role: "general", adapterType: "codex_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Waiting conversation", status: "in_review", assigneeAgentId: agentId, originKind: "chat_channel" });
    await db.insert(toolApplications).values({ id: applicationId, companyId, name: "Slack", type: "chat" });
    await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "Slack", uid: connectionId, transport: "chat_sdk", connectionPurpose: "channel" });
    await db.insert(chatEndpoints).values({ id: endpointId, companyId, connectionId, provider: "slack", publicId: endpointId, assignedAgentId: agentId, status: "active" });
    await db.insert(chatConversations).values({ id: conversationId, companyId, endpointId, issueId, externalConversationId: "channel", externalThreadId: "thread", externalLabel: "#test", state: "waiting" });
    const state = async () => ({
      issue: (await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId)))[0]?.status,
      conversation: (await db.select({ state: chatConversations.state }).from(chatConversations).where(eq(chatConversations.id, conversationId)))[0]?.state,
      comments: (await db.select({ id: issueComments.id }).from(issueComments).where(eq(issueComments.issueId, issueId))).length,
      activities: (await db.select({ id: activityLog.id }).from(activityLog).where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.updated")))).length,
    });
    const observations: Array<ReturnType<typeof state>> = [];
    const unsubscribe = subscribeCompanyLiveEvents(companyId, event => {
      const details = event.payload.details as Record<string, unknown> | undefined;
      if (event.type === "activity.logged" && details?.source === "external_conversation_resumed") observations.push(state());
    });
    return { companyId, issueId, state, observations, unsubscribe };
  }

  it.each(["standalone", "caller", "scoped", "linked inbound"] as const)("publishes once after a successful %s commit with durable rows", async path => {
    const f = await fixture();
    const publications: ActivityPublication[] = [];
    try {
      if (path === "standalone") {
        await issueService(db).addComment(f.issueId, "Continue", { userId: "local-board" });
      } else {
        await db.transaction(async tx => {
          const svc = issueService(path === "scoped" ? tx as unknown as typeof db : db);
          await svc.addComment(f.issueId, "Continue", { userId: "local-board" }, { postCommitActivityPublications: publications }, tx);
          // Linked-user inbound adds a human comment before its explicit resume.
          if (path === "linked inbound") await resumeExternalConversation(tx as unknown as typeof db, f.companyId, f.issueId, publications);
          expect(publications).toHaveLength(1);
          expect(f.observations).toHaveLength(0);
        });
        expect(f.observations).toHaveLength(0);
        publications.forEach(publishActivity);
      }
      expect(await f.state()).toEqual({ issue: "todo", conversation: "active", comments: 1, activities: 1 });
      expect(await Promise.all(f.observations)).toEqual([{ issue: "todo", conversation: "active", comments: 1, activities: 1 }]);
    } finally { f.unsubscribe(); }
  });

  it.each(["standalone", "caller", "scoped", "linked inbound"] as const)("does not publish after a failed %s commit", async path => {
    const f = await fixture();
    const publications: ActivityPublication[] = [];
    const fail = () => { throw new Error("controlled failure before commit"); };
    const transaction = db.transaction.bind(db);
    try {
      const append = async () => {
        if (path === "standalone") {
          vi.spyOn(db, "transaction").mockImplementationOnce((callback, config) => transaction(async tx => {
            await callback(tx);
            return fail();
          }, config));
          await issueService(db).addComment(f.issueId, "Continue", { userId: "local-board" });
        } else {
          await db.transaction(async tx => {
            const svc = issueService(path === "scoped" ? tx as unknown as typeof db : db);
            await svc.addComment(f.issueId, "Continue", { userId: "local-board" }, { postCommitActivityPublications: publications }, tx);
            if (path === "linked inbound") await resumeExternalConversation(tx as unknown as typeof db, f.companyId, f.issueId, publications);
            fail();
          });
          publications.forEach(publishActivity);
        }
      };
      await expect(append()).rejects.toThrow("controlled failure before commit");
      expect(await f.state()).toEqual({ issue: "in_review", conversation: "waiting", comments: 0, activities: 0 });
      expect(f.observations).toHaveLength(0);
    } finally { vi.restoreAllMocks(); f.unsubscribe(); }
  });
});
