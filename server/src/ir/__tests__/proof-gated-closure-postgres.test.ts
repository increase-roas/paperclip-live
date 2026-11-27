import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issueLabels, issues, labels } from "@paperclipai/db";
import type { ProofCheckResult } from "@paperclipai/shared/ir-system-map";
import { setProofSnapshotReaderForTests } from "../proof-gate.js";
import { issueService } from "../../services/issues.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

function snapshot(checks: ProofCheckResult[], stale = false) {
  return async () => ({
    checks,
    freshness: { observedAt: new Date().toISOString(), ageSeconds: stale ? 7200 : 30, stale, thresholdSeconds: 900 },
  });
}

const gateway = (status: ProofCheckResult["status"]): ProofCheckResult => ({
  key: "gateway",
  status,
  detail: status === "pass" ? null : "gateway_health_fail:502",
  observedAt: new Date().toISOString(),
});

describePostgres("proof-gated issue closure", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let restoreReader: (() => void) | null = null;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-ir-proof-gate-");
    db = createDb(database.connectionString);
  }, 30_000);

  afterEach(() => {
    restoreReader?.();
    restoreReader = null;
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await database?.cleanup();
  });

  async function seedIssue(labelNames: string | string[] | null) {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const prefix = `PRF${companyId.slice(0, 5).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Proof gate", issuePrefix: prefix });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Fix gateway health", status: "in_progress", identifier: `${prefix}-1`, issueNumber: 1,
    });
    for (const labelName of typeof labelNames === "string" ? [labelNames] : labelNames ?? []) {
      const labelId = randomUUID();
      await db.insert(labels).values({ id: labelId, companyId, name: labelName, color: "#888888" });
      await db.insert(issueLabels).values({ issueId, labelId, companyId });
    }
    return issueId;
  }

  async function statusOf(issueId: string) {
    return (await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId)))[0]?.status;
  }

  it("refuses closure with 422 while the linked proof check is failing", async () => {
    const issueId = await seedIssue("proof:gateway");
    restoreReader = setProofSnapshotReaderForTests(snapshot([gateway("fail")]));
    await expect(issueService(db).update(issueId, { status: "done" })).rejects.toMatchObject({
      status: 422,
      details: { code: "ir_proof_check_not_passing", requiredProofCheck: "gateway", proofStatus: "fail" },
    });
    expect(await statusOf(issueId)).toBe("in_progress");
  }, 30_000);

  it("refuses closure when the proof check is missing, unreachable or stale", async () => {
    const issueId = await seedIssue("proof:gateway");
    restoreReader = setProofSnapshotReaderForTests(snapshot([]));
    await expect(issueService(db).update(issueId, { status: "done" })).rejects.toMatchObject({ status: 422, details: { proofStatus: "missing" } });
    restoreReader();
    restoreReader = setProofSnapshotReaderForTests(async () => null);
    await expect(issueService(db).update(issueId, { status: "done" })).rejects.toMatchObject({ status: 422, details: { proofStatus: "missing" } });
    restoreReader();
    restoreReader = setProofSnapshotReaderForTests(snapshot([gateway("pass")], true));
    await expect(issueService(db).update(issueId, { status: "done" })).rejects.toMatchObject({ status: 422, details: { proofStatus: "stale" } });
    expect(await statusOf(issueId)).toBe("in_progress");
  }, 30_000);

  it("gates a close that adds the proof label in the same update", async () => {
    const issueId = await seedIssue(null);
    const [issue] = await db.select({ companyId: issues.companyId }).from(issues).where(eq(issues.id, issueId));
    const labelId = randomUUID();
    await db.insert(labels).values({ id: labelId, companyId: issue!.companyId, name: "proof:gateway", color: "#888888" });
    restoreReader = setProofSnapshotReaderForTests(snapshot([gateway("fail")]));
    await expect(issueService(db).update(issueId, { status: "done", labelIds: [labelId] })).rejects.toMatchObject({ status: 422 });
    expect(await statusOf(issueId)).toBe("in_progress");
  }, 30_000);

  it("closes the issue once the linked proof check passes", async () => {
    const issueId = await seedIssue("proof:gateway");
    restoreReader = setProofSnapshotReaderForTests(snapshot([gateway("pass")]));
    const updated = await issueService(db).update(issueId, { status: "done" });
    expect(updated?.status).toBe("done");
    expect(await statusOf(issueId)).toBe("done");
  }, 30_000);

  it.each([
    ["passing first", ["proof:gateway", "proof:db_feeds"]],
    ["failing first", ["proof:db_feeds", "proof:gateway"]],
  ])("refuses closure if any proof label fails (%s)", async (_order, labelNames) => {
    const issueId = await seedIssue(labelNames);
    restoreReader = setProofSnapshotReaderForTests(snapshot([
      gateway("pass"), { ...gateway("fail"), key: "db_feeds" },
    ]));
    await expect(issueService(db).update(issueId, { status: "done" })).rejects.toMatchObject({
      status: 422, details: { requiredProofCheck: "db_feeds", proofStatus: "fail" },
    });
    expect(await statusOf(issueId)).toBe("in_progress");
  }, 30_000);

  it("checks a new proof label as well as an existing passing label", async () => {
    const issueId = await seedIssue("proof:gateway");
    const [issue] = await db.select({ companyId: issues.companyId }).from(issues).where(eq(issues.id, issueId));
    const labelId = randomUUID();
    await db.insert(labels).values({ id: labelId, companyId: issue!.companyId, name: "proof:db_feeds", color: "#888888" });
    restoreReader = setProofSnapshotReaderForTests(snapshot([
      gateway("pass"), { ...gateway("fail"), key: "db_feeds" },
    ]));
    await expect(issueService(db).update(issueId, { status: "done", labelIds: [labelId] })).rejects.toMatchObject({
      status: 422, details: { requiredProofCheck: "db_feeds" },
    });
    expect(await statusOf(issueId)).toBe("in_progress");
  }, 30_000);

  it("closes once every proof label passes", async () => {
    const issueId = await seedIssue(["proof:gateway", "proof:db_feeds"]);
    restoreReader = setProofSnapshotReaderForTests(snapshot([
      gateway("pass"), { ...gateway("pass"), key: "db_feeds" },
    ]));
    expect((await issueService(db).update(issueId, { status: "done" }))?.status).toBe("done");
    expect(await statusOf(issueId)).toBe("done");
  }, 30_000);

  it("never consults proof checks for issues without a proof label or for other transitions", async () => {
    let calls = 0;
    restoreReader = setProofSnapshotReaderForTests(async () => {
      calls += 1;
      return null;
    });
    const plain = await seedIssue(null);
    expect((await issueService(db).update(plain, { status: "done" }))?.status).toBe("done");
    const gated = await seedIssue("proof:gateway");
    expect((await issueService(db).update(gated, { status: "in_review" }))?.status).toBe("in_review");
    expect(calls).toBe(0);
  }, 30_000);
});
