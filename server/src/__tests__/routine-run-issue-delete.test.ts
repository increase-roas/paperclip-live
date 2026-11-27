import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issues, routineRuns, routines } from "@paperclipai/db";
import { issueService } from "../services/issues.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)("routine run settlement when its execution issue is deleted", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-routine-run-issue-delete-");
    db = createDb(database.connectionString);
  }, 30_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await database?.cleanup();
  });

  async function seed(runStatus: "issue_created" | "completed") {
    const companyId = randomUUID();
    const routineId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const prefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Routine delete", issuePrefix: prefix });
    await db.insert(routines).values({ id: routineId, companyId, title: "Daily gateway check" });
    await db.insert(routineRuns).values({
      id: runId, companyId, routineId, source: "schedule", status: runStatus,
      completedAt: runStatus === "completed" ? new Date("2026-11-26T12:00:00Z") : null,
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Daily gateway check", status: "todo", identifier: `${prefix}-1`, issueNumber: 1,
      originKind: "routine_execution", originId: routineId, originRunId: runId,
    });
    await db.update(routineRuns).set({ linkedIssueId: issueId }).where(eq(routineRuns.id, runId));
    return { runId, issueId };
  }

  async function run(runId: string) {
    const [row] = await db.select().from(routineRuns).where(eq(routineRuns.id, runId));
    return row;
  }

  it("fails an in-progress routine run instead of leaving it waiting on a deleted issue", async () => {
    const { runId, issueId } = await seed("issue_created");

    expect(await issueService(db).remove(issueId)).toMatchObject({ id: issueId });

    expect(await run(runId)).toMatchObject({
      status: "failed", failureReason: "Execution issue deleted", linkedIssueId: null,
    });
    expect((await run(runId))?.completedAt).toBeInstanceOf(Date);
  }, 30_000);

  it("leaves an already settled routine run untouched", async () => {
    const { runId, issueId } = await seed("completed");
    const before = await run(runId);

    await issueService(db).remove(issueId);

    expect(await run(runId)).toMatchObject({
      status: "completed", failureReason: null, completedAt: before!.completedAt, updatedAt: before!.updatedAt,
    });
  }, 30_000);
});
