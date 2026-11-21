import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import {
  agentConfigRevisions,
  agentReadinessAttestations,
  agentReadinessReports,
  agents,
  companies,
  companySkills,
  issues,
  type Db,
} from "@paperclipai/db";
import {
  agentReadinessCheck,
  type AgentReadinessAttestation,
  type AgentReadinessFinding,
  type AgentReadinessFixAction,
  type AgentReadinessFixResult,
  type AgentReadinessReport,
  type AgentReadinessSubjectType,
  type AgentReadinessSummary,
} from "@paperclipai/shared";
import { readPaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import { badRequest, conflict, notFound, unprocessable } from "../../errors.js";
import { requireServerAdapter } from "../../adapters/index.js";
import { agentEnvironmentTestService } from "../agent-environment-test.js";
import { createAgentLifecycle } from "../agent-lifecycle.js";
import { secretService } from "../secrets.js";
import { agentService } from "../agents.js";
import { issueService } from "../issues.js";
import { logActivity } from "../activity-log.js";
import type { PluginWorkerManager } from "../plugin-worker-manager.js";
import {
  createAgentReadinessCatalog,
  summarizeReadinessCollection,
  type AgentReadinessCollection,
  type AgentReadinessLiveProbe,
  type AgentReadinessProbeResult,
  type ReadinessSubject,
} from "./catalog.js";

const READINESS_RUNNING_UNIQUE_CODE = "23505";
const LIVE_PROBE_TIMEOUT_MS = 30_000;
const SNAPSHOT_IDEMPOTENCY_MS = 5 * 60 * 1000;
/**
 * A report that has been "running" longer than this is treated as abandoned and
 * expired before the next run. Live probes are bounded per agent, but sandbox
 * provisioning is not, so this is deliberately generous.
 */
const RUNNING_REPORT_STALE_MS = 30 * 60 * 1000;

type ReportRow = typeof agentReadinessReports.$inferSelect;

export interface AgentReadinessActor {
  actorType: "user" | "agent" | "system";
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
  agentApiKeyId?: string | null;
}

export interface AgentReadinessServiceOptions {
  pluginWorkerManager?: PluginWorkerManager;
  /** Test seam. Production always uses the adapter and broker probes. */
  liveProbe?: AgentReadinessLiveProbe;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown; cause?: { code?: unknown } } | null)?.code
    ?? (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return code === READINESS_RUNNING_UNIQUE_CODE;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Live probe timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function probeEvidence(result: { checks?: Array<{ code: string; level: string; message: string }> }): Record<string, unknown> {
  const checks = result.checks ?? [];
  return {
    checks: checks.slice(0, 12).map((check) => ({ code: check.code, level: check.level, message: check.message })),
    errorCount: checks.filter((check) => check.level === "error").length,
    warnCount: checks.filter((check) => check.level === "warn").length,
  };
}

function createDefaultLiveProbe(db: Db, pluginWorkerManager?: PluginWorkerManager): AgentReadinessLiveProbe {
  const tests = agentEnvironmentTestService(db, pluginWorkerManager);
  return async (subject: ReadinessSubject): Promise<AgentReadinessProbeResult> => {
    const agent = subject.agent;
    if (!agent) return { status: "not_checked", message: "The company subject has no live probe." };
    if (asRecord(agent.runtimeConfig).aiConnection) {
      return {
        status: "not_checked",
        message: "This agent uses a managed AI connection. Run its harness test from the agent page for a live model probe.",
        evidence: { managedAiConnection: true },
      };
    }
    let resolvedConfig: Record<string, unknown>;
    try {
      const [company] = await db.select({ defaultResponsibleUserId: companies.defaultResponsibleUserId })
        .from(companies).where(eq(companies.id, agent.companyId)).limit(1);
      resolvedConfig = (await secretService(db).resolveAdapterConfigForRuntime(
        agent.companyId,
        agent.adapterConfig,
        {
          consumerType: "system",
          consumerId: "agent-readiness",
          actorType: "system",
          actorId: "agent-readiness",
          responsibleUserId: company?.defaultResponsibleUserId ?? agent.createdByUserId ?? null,
        },
        { adapterType: agent.adapterType },
      )).config;
    } catch (error) {
      return {
        status: "fail",
        message: `The live probe could not resolve stored credentials: ${errorMessage(error)}`,
        evidence: { adapterType: agent.adapterType },
      };
    }
    try {
      const environmentId = await tests.resolveAdapterTestEnvironmentId(agent.companyId, agent.defaultEnvironmentId, false);
      const target = await tests.resolveAdapterTestExecutionContext({
        companyId: agent.companyId,
        agentId: agent.id,
        adapterType: agent.adapterType,
        environmentId,
      });
      const blocking = target.fallbackChecks.find((check) => check.level === "error");
      if (blocking) {
        return {
          status: "fail",
          message: blocking.message,
          evidence: { environment: target.environmentName, fallbackChecks: target.fallbackChecks },
        };
      }
        const adapter = requireServerAdapter(agent.adapterType);
        const probePromise = adapter.testEnvironment({
          companyId: agent.companyId,
          adapterType: agent.adapterType,
          config: resolvedConfig,
          executionTarget: target.executionTarget,
          environmentName: target.environmentName,
        });
        // `withTimeout` does not cancel the adapter call. Keep its rejection from
        // surfacing as unhandled while we race it.
        probePromise.catch(() => undefined);
        try {
          const result = await withTimeout(probePromise, LIVE_PROBE_TIMEOUT_MS);
          return {
            status: result.status === "pass" ? "pass" : "fail",
            message: result.status === "pass"
              ? `The ${agent.adapterType} environment probe passed.`
              : result.checks.find((check) => check.level === "error")?.message
                ?? `The ${agent.adapterType} environment probe returned ${result.status}.`,
            evidence: { adapterType: agent.adapterType, environment: target.environmentName, ...probeEvidence(result) },
          };
        } finally {
          // Never release the lease while the timed-out probe is still using the
          // environment; wait for it to settle first.
          await probePromise.catch(() => undefined);
          await target.release("released");
        }
    } catch (error) {
      return {
        status: "fail",
        message: `The live probe failed: ${errorMessage(error)}`,
        evidence: { adapterType: agent.adapterType },
      };
    }
  };
}

function toReport(row: ReportRow, findings: AgentReadinessFinding[], summary: AgentReadinessSummary): AgentReadinessReport {
  return {
    id: row.id,
    companyId: row.companyId,
    status: row.status,
    includeLive: row.includeLive,
    summary,
    findings,
    requestedByUserId: row.requestedByUserId,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    error: row.error,
  };
}

function emptySummary(): AgentReadinessSummary {
  return {
    status: "unverified",
    subjectCounts: { ready: 0, attention: 0, blocked: 0, unverified: 0 },
    subjectCount: 0,
    levels: [],
    subjects: [],
  };
}

export function agentReadinessService(db: Db, options: AgentReadinessServiceOptions = {}) {
  const catalog = createAgentReadinessCatalog(db);
  const probe = options.liveProbe ?? createDefaultLiveProbe(db, options.pluginWorkerManager);

  async function loadAttestations(companyId: string): Promise<AgentReadinessAttestation[]> {
    const rows = await db.select().from(agentReadinessAttestations)
      .where(eq(agentReadinessAttestations.companyId, companyId))
      .orderBy(desc(agentReadinessAttestations.attestedAt));
    return rows.map((row) => ({
      id: row.id,
      companyId: row.companyId,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      checkId: row.checkId,
      note: row.note,
      attestedByUserId: row.attestedByUserId,
      attestedAt: row.attestedAt.toISOString(),
    }));
  }

  async function collect(
    companyId: string,
    includeLive: boolean,
    onlySubject?: { subjectType: AgentReadinessSubjectType; subjectId: string },
  ): Promise<AgentReadinessCollection> {
    return catalog.collect(companyId, {
      includeLive,
      attestations: await loadAttestations(companyId),
      probe,
      onlySubject,
    });
  }

  async function latestCompleteRow(companyId: string): Promise<ReportRow | null> {
    const [row] = await db.select().from(agentReadinessReports).where(and(
      eq(agentReadinessReports.companyId, companyId),
      eq(agentReadinessReports.status, "complete"),
    )).orderBy(desc(agentReadinessReports.completedAt)).limit(1);
    return row ?? null;
  }

  async function latestComplete(companyId: string): Promise<AgentReadinessReport | null> {
    const row = await latestCompleteRow(companyId);
    if (!row) return null;
    const summary = asRecord(row.summary) as unknown as AgentReadinessSummary;
    return toReport(row, row.findings, summary?.subjects ? summary : emptySummary());
  }

  function hasEvaluatedLiveFinding(findings: readonly AgentReadinessFinding[]): boolean {
    return findings.some((finding) =>
      finding.kind === "live" && (finding.status === "pass" || finding.status === "fail"));
  }

  /**
   * Carry the last live probe results into a static re-evaluation. Attesting or
   * fixing a check must not erase live results the operator just paid for.
   */
  function carryLiveFindings(
    collection: AgentReadinessCollection,
    previous: readonly AgentReadinessFinding[],
  ): AgentReadinessCollection {
    const prior = new Map(
      previous
        .filter((finding) => finding.kind === "live" && (finding.status === "pass" || finding.status === "fail"))
        .map((finding) => [`${finding.subjectType}:${finding.subjectId}:${finding.checkId}`, finding]),
    );
    if (prior.size === 0) return collection;
    let carried = 0;
    const findings = collection.findings.map((finding) => {
      if (finding.kind !== "live" || finding.status !== "not_checked") return finding;
      const previousFinding = prior.get(`${finding.subjectType}:${finding.subjectId}:${finding.checkId}`);
      if (!previousFinding) return finding;
      carried += 1;
      return previousFinding;
    });
    if (carried === 0) return collection;
    return summarizeReadinessCollection(collection.subjects, findings);
  }

  /**
   * Save a re-evaluated report so a reload shows the same state an operator just
   * saw. The current complete report is updated in place, so it stays the newest
   * and last-live results keep their order.
   */
  async function saveReport(
    companyId: string,
    collection: AgentReadinessCollection,
    options: { includeLive: boolean; requestedByUserId: string | null },
  ): Promise<AgentReadinessReport> {
    const current = await latestCompleteRow(companyId);
    if (current) {
      const [updated] = await db.update(agentReadinessReports).set({
        status: "complete",
        includeLive: options.includeLive,
        summary: collection.summary,
        findings: collection.findings,
        completedAt: new Date(),
        error: null,
      }).where(eq(agentReadinessReports.id, current.id)).returning();
      if (!updated) throw new Error("The readiness report disappeared before it was saved");
      return toReport(updated, updated.findings, collection.summary);
    }
    const [inserted] = await db.insert(agentReadinessReports).values({
      companyId,
      status: "complete",
      includeLive: options.includeLive,
      summary: collection.summary,
      findings: collection.findings,
      requestedByUserId: options.requestedByUserId,
      completedAt: new Date(),
    }).returning();
    if (!inserted) throw new Error("Failed to save the readiness report");
    return toReport(inserted, inserted.findings, collection.summary);
  }

  /**
   * A process that dies between starting a report and finishing it leaves a
   * "running" row that the unique index reads as an active run forever. Expire
   * those before starting a new one.
   */
  async function expireStaleRunningReports(companyId: string): Promise<void> {
    await db.update(agentReadinessReports).set({
      status: "failed",
      error: "The previous readiness report did not finish and was expired.",
      completedAt: new Date(),
    }).where(and(
      eq(agentReadinessReports.companyId, companyId),
      eq(agentReadinessReports.status, "running"),
      lt(agentReadinessReports.startedAt, new Date(Date.now() - RUNNING_REPORT_STALE_MS)),
    ));
  }

  async function getOrBuild(companyId: string): Promise<AgentReadinessReport> {
    const report = await latestComplete(companyId);
    if (report) return report;
    const collection = await collect(companyId, false);
    return {
      id: null,
      companyId,
      status: "complete",
      includeLive: false,
      summary: collection.summary,
      findings: collection.findings,
      requestedByUserId: null,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      error: null,
    };
  }

  async function runReport(
    companyId: string,
    input: { includeLive: boolean; requestedByUserId: string | null },
  ): Promise<AgentReadinessReport> {
    await expireStaleRunningReports(companyId);
    let row: ReportRow;
    try {
      [row] = await db.insert(agentReadinessReports).values({
        companyId,
        status: "running",
        includeLive: input.includeLive,
        requestedByUserId: input.requestedByUserId,
      }).returning();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict("A readiness report is already running for this company.");
      }
      throw error;
    }
    if (!row) throw new Error("Failed to start the readiness report");
    try {
      const collection = await collect(companyId, input.includeLive);
      const [complete] = await db.update(agentReadinessReports).set({
        status: "complete",
        summary: collection.summary,
        findings: collection.findings,
        completedAt: new Date(),
      }).where(eq(agentReadinessReports.id, row.id)).returning();
      if (!complete) throw new Error("The readiness report disappeared before it completed");
      return toReport(complete, complete.findings, collection.summary);
    } catch (error) {
      await db.update(agentReadinessReports).set({
        status: "failed",
        error: errorMessage(error),
        completedAt: new Date(),
      }).where(eq(agentReadinessReports.id, row.id)).catch(() => undefined);
      throw error;
    }
  }

  async function findSubject(companyId: string, subjectType: AgentReadinessSubjectType, subjectId: string): Promise<ReadinessSubject> {
    const { subjects } = await catalog.listSubjects(companyId);
    const subject = subjects.find((entry) => entry.subjectType === subjectType && entry.subjectId === subjectId);
    if (!subject) throw notFound("Readiness subject not found");
    return subject;
  }

  async function agentRowForFix(companyId: string, subjectId: string) {
    const [agent] = await db.select().from(agents).where(and(
      eq(agents.companyId, companyId),
      eq(agents.id, subjectId),
    )).limit(1);
    if (!agent) throw notFound("Agent not found");
    return agent;
  }

  async function snapshotConfig(companyId: string, agentId: string, actor: AgentReadinessActor): Promise<string> {
    const agent = await agentRowForFix(companyId, agentId);
    const since = new Date(Date.now() - SNAPSHOT_IDEMPOTENCY_MS);
    const [recent] = await db.select({ id: agentConfigRevisions.id }).from(agentConfigRevisions).where(and(
      eq(agentConfigRevisions.companyId, companyId),
      eq(agentConfigRevisions.agentId, agentId),
      eq(agentConfigRevisions.source, "readiness"),
      gte(agentConfigRevisions.createdAt, since),
    )).limit(1);
    if (recent) return "A configuration snapshot was already saved in the last five minutes.";
    await db.insert(agentConfigRevisions).values({
      companyId,
      agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      createdByAgentId: actor.actorType === "agent" ? actor.agentId ?? null : null,
      source: "readiness",
      changedKeys: [],
      beforeConfig: asRecord(agent.adapterConfig),
      afterConfig: asRecord(agent.adapterConfig),
    });
    return "Saved a configuration snapshot.";
  }

  async function syncSkills(companyId: string, agentId: string, actor: AgentReadinessActor): Promise<string> {
    return db.transaction(async (tx) => {
    // Serialize with other readiness fixes and Runtime-page edits for this agent.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`agent-readiness:${companyId}:${agentId}`}))`);
    const [agent] = await tx.select().from(agents).where(and(
      eq(agents.companyId, companyId),
      eq(agents.id, agentId),
    )).for("update");
    if (!agent) throw notFound("Agent not found");
    const config = asRecord(agent.adapterConfig);
    const preference = readPaperclipSkillSyncPreference(config);
    const skillRows = await tx.select({ key: companySkills.key }).from(companySkills).where(eq(companySkills.companyId, companyId));
    const known = new Set(skillRows.map((row) => row.key));
    const missing = preference.desiredSkills.filter((key) => !known.has(key));
    if (missing.length === 0) return "All desired skills still exist in the company library.";
    const missingSet = new Set(missing);
    const sync = asRecord(config.paperclipSkillSync);
    const nextSync: Record<string, unknown> = { ...sync };
    if (Array.isArray(sync.desiredSkills)) {
      nextSync.desiredSkills = sync.desiredSkills.filter((entry) => {
        if (typeof entry === "string") return !missingSet.has(entry.trim());
        const key = asRecord(entry).key;
        return !(typeof key === "string" && missingSet.has(key));
      });
    }
    if (Array.isArray(sync.desiredSkillEntries)) {
      nextSync.desiredSkillEntries = sync.desiredSkillEntries.filter((entry) => {
        const key = asRecord(entry).key;
        return !(typeof key === "string" && missingSet.has(key));
      });
    }
    await agentService(tx as unknown as Db).update(agent.id, {
      adapterConfig: { ...config, paperclipSkillSync: nextSync },
    }, {
      recordRevision: {
        createdByAgentId: actor.actorType === "agent" ? actor.agentId ?? null : null,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
        source: "readiness",
      },
    });
    return `Removed ${missing.length} missing skill reference${missing.length === 1 ? "" : "s"}.`;
    });
  }

  async function createTestTask(companyId: string, agentId: string): Promise<string> {
    return db.transaction(async (tx) => {
      // Serialize concurrent fix clicks for this agent so two requests cannot each
      // create a test task and leave one orphaned.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`agent-readiness:${companyId}:${agentId}`}))`);
      const [agent] = await tx.select().from(agents).where(and(
        eq(agents.companyId, companyId),
        eq(agents.id, agentId),
      )).for("update");
      if (!agent) throw notFound("Agent not found");
      const metadata = asRecord(agent.metadata);
      const existingId = typeof metadata.readinessTestIssueId === "string" ? metadata.readinessTestIssueId : null;
      if (existingId) {
        const [existing] = await tx.select({ id: issues.id }).from(issues).where(and(
          eq(issues.companyId, companyId),
          eq(issues.id, existingId),
        )).limit(1);
        if (existing) return "A readiness test task is already linked.";
      }
      const issue = await issueService(tx as unknown as Db).create(companyId, {
        title: `Readiness test: ${agent.name}`,
        description: [
          `Expected result: ${agent.name} completes this task and the recorded result is checked by someone other than the agent.`,
          "",
          "Run this task at least twice with realistic work before recording a pass. Do not use real clients, accounts or money.",
        ].join("\n"),
        status: "backlog",
        assigneeAgentId: agent.id,
      });
      await agentService(tx as unknown as Db).update(agent.id, {
        metadata: { ...metadata, readinessTestIssueId: issue.id },
      }, { recordRevision: { source: "readiness" } });
      return `Created readiness test task ${issue.identifier ?? issue.id}.`;
    });
  }

  async function applyFix(input: {
    companyId: string;
    reportId?: string | null;
    subjectType: AgentReadinessSubjectType;
    subjectId: string;
    checkId: string;
    action: AgentReadinessFixAction;
    confirm: true;
    actor: AgentReadinessActor;
  }): Promise<AgentReadinessFixResult> {
    if (input.confirm !== true) throw badRequest("Confirm the fix before applying it.");
    if (input.reportId) {
      const [report] = await db.select({ companyId: agentReadinessReports.companyId })
        .from(agentReadinessReports)
        .where(eq(agentReadinessReports.id, input.reportId))
        .limit(1);
      if (!report || report.companyId !== input.companyId) throw notFound("Readiness report not found");
    }
    const definition = agentReadinessCheck(input.checkId);
    if (!definition) throw badRequest("Unknown readiness check");
    if (!definition.subjects.includes(input.subjectType)) throw badRequest("This check does not apply to that subject");
    if (!definition.fix || definition.fix.action !== input.action) {
      throw badRequest("This fix is not available for that check");
    }
    await findSubject(input.companyId, input.subjectType, input.subjectId);
    if (input.action !== "run_probe" && input.subjectType === "company") {
      throw badRequest("Company-wide checks are fixed from their settings pages.");
    }
    let message: string;
    switch (input.action) {
      case "sync_skills":
        message = await syncSkills(input.companyId, input.subjectId, input.actor);
        break;
      case "snapshot_config":
        message = await snapshotConfig(input.companyId, input.subjectId, input.actor);
        break;
      case "create_test_task":
        message = await createTestTask(input.companyId, input.subjectId);
        break;
      case "pause_agent": {
        const agent = await agentRowForFix(input.companyId, input.subjectId);
        await createAgentLifecycle(db).pauseAgent(agent.id);
        message = "Paused the agent. Resume it when the stuck work is cleared.";
        break;
      }
      case "resume_agent": {
        const agent = await agentRowForFix(input.companyId, input.subjectId);
        await createAgentLifecycle(db).resumeAgent(agent.id);
        message = "Resumed the agent.";
        break;
      }
      case "run_probe": {
        // The re-evaluation below performs the single probe for this subject;
        // probing here as well would boot a sandbox twice.
        message = "Ran the live probe.";
        break;
      }
      default:
        throw unprocessable("Unsupported readiness fix action");
    }
    await logActivity(db, {
      companyId: input.companyId,
      actorType: input.actor.actorType,
      actorId: input.actor.actorId,
      agentId: input.actor.agentId ?? null,
      runId: input.actor.runId ?? null,
      agentApiKeyId: input.actor.agentApiKeyId ?? null,
      action: "agent_readiness.fix_applied",
      entityType: input.subjectType,
      entityId: input.subjectId,
      details: { checkId: input.checkId, action: input.action, message },
    });
    const includeLive = input.action === "run_probe";
    const previous = await latestCompleteRow(input.companyId);
    const collection = carryLiveFindings(
      await collect(input.companyId, includeLive, {
        subjectType: input.subjectType,
        subjectId: input.subjectId,
      }),
      previous?.findings ?? [],
    );
    const report = await saveReport(input.companyId, collection, {
      includeLive: includeLive || hasEvaluatedLiveFinding(collection.findings),
      requestedByUserId: input.actor.actorType === "user" ? input.actor.actorId : null,
    });
    const finding = report.findings.find((entry) =>
      entry.subjectType === input.subjectType
      && entry.subjectId === input.subjectId
      && entry.checkId === input.checkId) ?? null;
    return {
      applied: true,
      action: input.action,
      // For a probe, report the re-evaluated finding's message rather than the
      // pre-probe placeholder.
      message: input.action === "run_probe" ? finding?.message ?? message : message,
      finding,
      report,
    };
  }

  async function attest(input: {
    companyId: string;
    subjectType: AgentReadinessSubjectType;
    subjectId: string;
    checkId: string;
    note: string;
    userId: string;
  }): Promise<{
    attestation: AgentReadinessAttestation;
    finding: AgentReadinessFinding | null;
    report: AgentReadinessReport;
  }> {
    const definition = agentReadinessCheck(input.checkId);
    if (!definition) throw badRequest("Unknown readiness check");
    if (definition.kind !== "manual") throw badRequest("Only manual checks can be attested");
    if (!definition.subjects.includes(input.subjectType)) throw badRequest("This check does not apply to that subject");
    const note = input.note?.trim() ?? "";
    if (!note) throw badRequest("Say what you checked before attesting.");
    const subject = await findSubject(input.companyId, input.subjectType, input.subjectId);
    const [row] = await db.insert(agentReadinessAttestations).values({
      companyId: input.companyId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      checkId: input.checkId,
      note,
      attestedByUserId: input.userId,
      attestedAt: new Date(),
    }).onConflictDoUpdate({
      target: [
        agentReadinessAttestations.companyId,
        agentReadinessAttestations.subjectType,
        agentReadinessAttestations.subjectId,
        agentReadinessAttestations.checkId,
      ],
      set: {
        note,
        attestedByUserId: input.userId,
        attestedAt: new Date(),
      },
    }).returning();
    if (!row) throw new Error("Failed to save the readiness attestation");
    await logActivity(db, {
      companyId: input.companyId,
      actorType: "user",
      actorId: input.userId,
      action: "agent_readiness.attested",
      entityType: input.subjectType,
      entityId: input.subjectId,
      details: { checkId: input.checkId, hasNote: true },
    });
    const previous = await latestCompleteRow(input.companyId);
    const collection = carryLiveFindings(
      await collect(input.companyId, false, {
        subjectType: input.subjectType,
        subjectId: input.subjectId,
      }),
      previous?.findings ?? [],
    );
    // Saving the re-evaluated report is what makes the attestation survive a
    // reload: GET serves the stored report, not this response.
    const report = await saveReport(input.companyId, collection, {
      includeLive: hasEvaluatedLiveFinding(collection.findings),
      requestedByUserId: input.userId,
    });
    const finding = report.findings.find((entry) =>
      entry.subjectType === input.subjectType
      && entry.subjectId === subject.subjectId
      && entry.checkId === input.checkId) ?? null;
    return {
      report,
      attestation: {
        id: row.id,
        companyId: row.companyId,
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        checkId: row.checkId,
        note: row.note,
        attestedByUserId: row.attestedByUserId,
        attestedAt: row.attestedAt.toISOString(),
      },
      finding,
    };
  }

  return { getOrBuild, runReport, applyFix, attest, latestComplete };
}
