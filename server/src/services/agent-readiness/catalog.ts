import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import {
  agentConfigRevisions,
  agents,
  budgetPolicies,
  companies,
  companySecretBindings,
  companySkills,
  heartbeatRuns,
  issueExecutionDecisions,
  issues,
  nativeRunResults,
  smokeRuns,
  toolConnections,
  toolPolicies,
  type Db,
} from "@paperclipai/db";
import {
  AGENT_READINESS_CHECKS,
  agentReadinessCheck,
  isUuidLike,
  scoreReadinessSubject,
  summarizeAgentReadiness,
  type AgentReadinessAttestation,
  type AgentReadinessCheckDefinition,
  type AgentReadinessCheckStatus,
  type AgentReadinessFinding,
  type AgentReadinessSubjectStatus,
  type AgentReadinessSubjectSummary,
  type AgentReadinessSubjectType,
  type AgentReadinessSummary,
} from "@paperclipai/shared";
import { readPaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import { loadConfig } from "../../config.js";
import { agentEnvironmentTestService } from "../agent-environment-test.js";
import { agentInstructionsService } from "../agent-instructions.js";
import { instanceSettingsService } from "../instance-settings.js";
import {
  evaluateGbrainAttachment,
  findAgentConnectionInstalls,
  findGbrainConnections,
  GBRAIN_MCP_URL,
  readGbrainMarker,
} from "../gbrain.js";
import { hermesHasMcpToolset, hermesToolsets, isHermesAdapter, resolveHermesProfile } from "../hermes-profile.js";
import {
  evaluateNeonAdsAccess,
  evaluateNeonAppDatabase,
  findNeonConnections,
  safeDatabaseName,
  safeHostname,
} from "./neon.js";

const TOOL_ATTENTION_HEALTH = new Set(["degraded", "failed", "error", "missing_secret"]);
const RUNNING_RUN_STATUSES = ["queued", "running"];
const STUCK_RUN_MS = 60 * 60 * 1000;
const STALE_BLOCKED_MS = 14 * 24 * 60 * 60 * 1000;
const SMOKE_RUN_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const REDACTED_VALUE = "***REDACTED***";
/** Metadata key the grok-bot-twin plugin (or its operator) sets on a hired twin. */
const GROK_BOT_TWIN_METADATA_KEY = "grokBotTwin";
/** Bound the instructions scan so a large bundle cannot stall a report. */
const INSTRUCTION_SCAN_MAX_FILES = 50;
const INSTRUCTION_SCAN_MAX_BYTES = 256 * 1024;
/**
 * A credential-looking assignment with a value too long to be a placeholder.
 * Deliberately matches the vocabulary `criticalKeyLike` treats as critical.
 */
const SECRET_IN_INSTRUCTIONS =
  /(api[_-]?key|password|passwd|secret|token|credential|private[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9_+/.-]{12,}/i;

type AgentRow = typeof agents.$inferSelect;
type CompanyRow = typeof companies.$inferSelect;

export interface ReadinessSubject {
  subjectType: AgentReadinessSubjectType;
  subjectId: string;
  name: string;
  provider: string | null;
  /** A Hermes agent hired from the grok-bot-twin plugin. Always false for a company. */
  grokBotTwin: boolean;
  agent: AgentRow | null;
}

export interface AgentReadinessProbeResult {
  status: "pass" | "fail" | "not_checked";
  message: string;
  evidence?: Record<string, unknown>;
}

export type AgentReadinessLiveProbe = (subject: ReadinessSubject) => Promise<AgentReadinessProbeResult>;

export interface AgentReadinessCollectionOptions {
  includeLive: boolean;
  attestations: readonly AgentReadinessAttestation[];
  probe?: AgentReadinessLiveProbe;
  /** Scope a live re-check to one subject so a fix never probes every agent. */
  onlySubject?: { subjectType: AgentReadinessSubjectType; subjectId: string };
}

export interface AgentReadinessCollection {
  subjects: AgentReadinessSubjectSummary[];
  findings: AgentReadinessFinding[];
  summary: AgentReadinessSummary;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function scorable(finding: AgentReadinessFinding) {
  return {
    checkId: finding.checkId,
    level: finding.level,
    kind: finding.kind,
    severity: finding.severity,
    status: finding.status,
  };
}

/**
 * Score findings against the subject list. A mutation that re-evaluates a
 * subject reuses this so a persisted report and a freshly collected one cannot
 * disagree about what a level means.
 */
export function summarizeReadinessCollection(
  subjects: ReadonlyArray<Pick<ReadinessSubject, "subjectType" | "subjectId" | "name" | "provider" | "grokBotTwin">>,
  findings: readonly AgentReadinessFinding[],
): AgentReadinessCollection {
  const subjectSummaries = subjects.map((subject) => {
    const subjectFindings = findings.filter((finding) =>
      finding.subjectType === subject.subjectType && finding.subjectId === subject.subjectId);
    return scoreReadinessSubject(
      // Pass only the summary identity. Spreading the whole subject would copy
      // the agent row (adapterConfig, runtimeConfig, metadata) into the API
      // response and into a stored report.
      {
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        name: subject.name,
        provider: subject.provider,
        grokBotTwin: subject.grokBotTwin === true,
      },
      subjectFindings.map(scorable),
    );
  });
  const summary = summarizeAgentReadiness(subjectSummaries, findings.map(scorable));
  return { subjects: subjectSummaries, findings: [...findings], summary };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A Hermes agent hired from the grok-bot-twin plugin is labelled a bot. */
export function isGrokBotTwin(agent: Pick<AgentRow, "metadata">): boolean {
  return asRecord(agent.metadata)[GROK_BOT_TWIN_METADATA_KEY] === true;
}

/**
 * Readiness covers the company and Hermes-profile agents only. Paperclip's
 * native Dot, Muse and `grok_bot` providers are deliberately out of scope, so
 * those agents are not scored and cannot block a level.
 */
export function readinessSubjectType(
  agent: Pick<AgentRow, "adapterType" | "metadata">,
): "agent" | "bot" | null {
  if (!isHermesAdapter(agent.adapterType)) return null;
  return isGrokBotTwin(agent) ? "bot" : "agent";
}

function plainEnvKeys(config: Record<string, unknown>): string[] {
  const env = asRecord(config.env);
  const keys: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      if (value.trim() && value !== REDACTED_VALUE) keys.push(key);
      continue;
    }
    const binding = asRecord(value);
    const type = typeof binding.type === "string" ? binding.type : null;
    if (type === "plain") {
      const plainValue = typeof binding.value === "string" ? binding.value : "";
      if (plainValue.trim() && plainValue !== REDACTED_VALUE) keys.push(key);
    }
  }
  return keys;
}

function criticalKeyLike(key: string): boolean {
  return /(secret|token|password|passwd|api[_-]?key|credential|private[_-]?key)/i.test(key);
}

function successRate(statuses: readonly string[]): number {
  if (statuses.length === 0) return 0;
  return statuses.filter((status) => status === "succeeded").length / statuses.length;
}

/**
 * Scan every instruction file, not just the entry file. Returns credential
 * files and the files that mention GBrain or Neon, so the memory and ad-data
 * checks can tell a connector from a credential copied into prose.
 * Binary and oversized files are skipped; an unreadable file is left to
 * `instructions.configured` to report.
 */
export interface InstructionScanResult {
  secretFiles: string[];
  gbrainFiles: string[];
  neonFiles: string[];
  secretNeonFiles: string[];
  hindsightFiles: string[];
}

export async function scanInstructionFiles(
  files: ReadonlyArray<{ path: string; binary?: boolean; size: number }>,
  read: (path: string) => Promise<string>,
): Promise<InstructionScanResult> {
  const result: InstructionScanResult = {
    secretFiles: [],
    gbrainFiles: [],
    neonFiles: [],
    secretNeonFiles: [],
    hindsightFiles: [],
  };
  let scanned = 0;
  for (const file of files) {
    if (scanned >= INSTRUCTION_SCAN_MAX_FILES) break;
    if (file.binary || file.size <= 0 || file.size > INSTRUCTION_SCAN_MAX_BYTES) continue;
    scanned += 1;
    // Only an unreadable file is forgiven; a bug in the scan itself must surface.
    let content: string;
    try {
      content = await read(file.path);
    } catch {
      // An unreadable file is already reported by instructions.configured.
      continue;
    }
    const secret = SECRET_IN_INSTRUCTIONS.test(content);
    const gbrain = content.includes(GBRAIN_MCP_URL) || /[^\w]gbrain[^\w]/i.test(content);
    const neon = /mcp\.neon\.tech|neon\.tech|\bneon\b|neon[_-]/i.test(content);
    const hindsight = /hindsight/i.test(content);
    if (secret) result.secretFiles.push(file.path);
    if (gbrain) result.gbrainFiles.push(file.path);
    if (neon) result.neonFiles.push(file.path);
    if (secret && neon) result.secretNeonFiles.push(file.path);
    if (hindsight) result.hindsightFiles.push(file.path);
  }
  return result;
}

export function createAgentReadinessCatalog(db: Db) {
  const instructions = agentInstructionsService(db);
  const instanceSettings = instanceSettingsService(db);

  /** Adapt the bundle reader to the pure scan, which has its own unit test. */
  async function scanBundle(
    agent: AgentRow,
    bundle: Awaited<ReturnType<typeof instructions.getBundle>>,
  ): Promise<InstructionScanResult> {
    return scanInstructionFiles(
      bundle.files,
      async (path) => (await instructions.readFile(agent, path)).content,
    );
  }

  async function listSubjects(companyId: string): Promise<{ company: CompanyRow; subjects: ReadinessSubject[] }> {
    const [company] = await db.select().from(companies).where(eq(companies.id, companyId)).limit(1);
    if (!company) throw new Error("Company not found");
    const agentRows = await db.select().from(agents).where(and(
      eq(agents.companyId, companyId),
      sql`${agents.status} <> 'terminated'`,
    ));
    const readySubjects: ReadinessSubject[] = [{
      subjectType: "company",
      subjectId: companyId,
      name: company.name,
      provider: null,
      grokBotTwin: false,
      agent: null,
    }];
    for (const agent of agentRows) {
      const subjectType = readinessSubjectType(agent);
      if (!subjectType) continue;
      readySubjects.push({
        subjectType,
        subjectId: agent.id,
        name: agent.name,
        provider: subjectType === "bot" ? "grok_bot_twin" : null,
        grokBotTwin: isGrokBotTwin(agent),
        agent,
      });
    }
    return { company, subjects: readySubjects };
  }

  function makeFinding(
    def: AgentReadinessCheckDefinition,
    subject: ReadinessSubject,
    status: AgentReadinessCheckStatus,
    message: string,
    evidence: Record<string, unknown> | null = null,
    checkedAt: string,
  ): AgentReadinessFinding {
    const deepLink = def.deepLink
      ? { ...def.deepLink, path: def.deepLink.path.replace("{agentId}", subject.subjectId) }
      : null;
    return {
      checkId: def.id,
      level: def.level,
      title: def.title,
      description: def.description,
      kind: def.kind,
      severity: def.severity,
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
      subjectName: subject.name,
      provider: subject.provider,
      status,
      message,
      evidence,
      checkedAt,
      fix: def.fix ?? null,
      deepLink,
    };
  }

  async function collectCompany(company: CompanyRow, subject: ReadinessSubject, checkedAt: string): Promise<AgentReadinessFinding[]> {
    const findings: AgentReadinessFinding[] = [];
    const experimental = await instanceSettings.getExperimental();
    const smokeSince = new Date(Date.now() - SMOKE_RUN_LOOKBACK_MS);
    const [smoke] = await db.select({ id: smokeRuns.id, startedAt: smokeRuns.startedAt, status: smokeRuns.status })
      .from(smokeRuns)
      .where(and(eq(smokeRuns.companyId, company.id), gte(smokeRuns.startedAt, smokeSince)))
      .orderBy(desc(smokeRuns.startedAt))
      .limit(1);
    const smokePass = experimental.enableSmokeLab === true && Boolean(smoke);
    findings.push(makeFinding(
      agentReadinessCheck("company.smoke_lab")!,
      subject,
      smokePass ? "pass" : "fail",
      smokePass
        ? "Smoke Lab is enabled and has a run in the last seven days."
        : experimental.enableSmokeLab !== true
          ? "Smoke Lab is not enabled."
          : "Smoke Lab is enabled but has no run in the last seven days.",
      { enabled: experimental.enableSmokeLab === true, lastRunAt: smoke?.startedAt ?? null, lastRunStatus: smoke?.status ?? null },
      checkedAt,
    ));

    const connectionRows = await db.select({ name: toolConnections.name, healthStatus: toolConnections.healthStatus })
      .from(toolConnections)
      .where(and(eq(toolConnections.companyId, company.id), eq(toolConnections.enabled, true)));
    const unhealthy = connectionRows.filter((row) => TOOL_ATTENTION_HEALTH.has(row.healthStatus));
    const unchecked = connectionRows.filter((row) => row.healthStatus === "unchecked" || row.healthStatus === "unknown");
    findings.push(makeFinding(
      agentReadinessCheck("company.tool_health")!,
      subject,
      unhealthy.length ? "fail" : unchecked.length ? "not_checked" : "pass",
      unhealthy.length
        ? `${unhealthy.length} enabled tool connection${unhealthy.length === 1 ? " needs" : "s need"} attention.`
        : unchecked.length
          ? `${unchecked.length} enabled tool connection${unchecked.length === 1 ? " has" : "s have"} not been checked.`
          : "Enabled tool connections are healthy.",
      { enabledConnections: connectionRows.length, unhealthy: unhealthy.map((row) => row.name), unchecked: unchecked.length },
      checkedAt,
    ));

    const [approvalPolicy] = await db.select({ id: toolPolicies.id }).from(toolPolicies).where(and(
      eq(toolPolicies.companyId, company.id),
      eq(toolPolicies.enabled, true),
      eq(toolPolicies.policyType, "require_approval"),
    )).limit(1);
    const approvalPass = Boolean(approvalPolicy) || company.requireBoardApprovalForNewAgents === true;
    findings.push(makeFinding(
      agentReadinessCheck("company.approval_policy")!,
      subject,
      approvalPass ? "pass" : "fail",
      approvalPass
        ? "Risky actions or new agents require approval."
        : "No approval policy is enabled and new agents do not require board approval.",
      { requireApprovalPolicy: Boolean(approvalPolicy), boardApprovalForNewAgents: company.requireBoardApprovalForNewAgents },
      checkedAt,
    ));

    const agentRows = await db.select({ id: agents.id, name: agents.name, adapterConfig: agents.adapterConfig })
      .from(agents)
      .where(and(eq(agents.companyId, company.id), sql`${agents.status} <> 'terminated'`));
    const plainKeys = agentRows.flatMap((row) => plainEnvKeys(asRecord(row.adapterConfig)).map((key) => `${row.name}: ${key}`));
    const [binding] = await db.select({ id: companySecretBindings.id }).from(companySecretBindings)
      .where(eq(companySecretBindings.companyId, company.id)).limit(1);
    findings.push(makeFinding(
      agentReadinessCheck("company.secrets")!,
      subject,
      plainKeys.length ? "fail" : "pass",
      plainKeys.length
        ? `${plainKeys.length} plaintext environment value${plainKeys.length === 1 ? " is" : "s are"} stored on agents.`
        : "No agent stores a plaintext environment value.",
      { agentsWithPlainEnv: plainKeys, hasVaultBindings: Boolean(binding) },
      checkedAt,
    ));

    const gbrainConnections = await findGbrainConnections(db, company.id);
    const gbrainEnabled = gbrainConnections.filter((connection) => connection.enabled);
    const gbrainHealthy = gbrainEnabled.filter((connection) => ["healthy", "ok"].includes(connection.healthStatus ?? ""));
    const gbrainPending = gbrainEnabled.filter((connection) =>
      ["unchecked", "unknown", "not_checked"].includes(connection.healthStatus ?? ""));
    const gbrainStatus = gbrainEnabled.length === 0
      ? "fail"
      : gbrainHealthy.length === gbrainEnabled.length
        ? "pass"
        : gbrainPending.length === gbrainEnabled.length
          ? "not_checked"
          : "fail";
    findings.push(makeFinding(
      agentReadinessCheck("company.gbrain")!,
      subject,
      gbrainStatus,
      gbrainEnabled.length === 0
        ? "No enabled GBrain connector exists for this company."
        : gbrainStatus === "pass"
          ? "The company GBrain connector is enabled and healthy."
          : gbrainStatus === "not_checked"
            ? "The company GBrain connector has not been health-checked yet."
            : "The company GBrain connector needs attention.",
      {
        connections: gbrainConnections.map((connection) => ({
          id: connection.id,
          enabled: connection.enabled,
          healthStatus: connection.healthStatus,
          applicationKey: connection.applicationKey,
        })),
      },
      checkedAt,
    ));

    const runtimeConfig = loadConfig();
    const neonApp = evaluateNeonAppDatabase({
      mode: runtimeConfig.databaseMode,
      databaseUrl: runtimeConfig.databaseUrl,
      migrationUrl: runtimeConfig.databaseMigrationUrl,
      preparedStatements: process.env.DATABASE_PREPARED_STATEMENTS ?? null,
      embeddedPostgresPort: runtimeConfig.embeddedPostgresPort,
    });
    findings.push(makeFinding(
      agentReadinessCheck("company.neon_app_db")!,
      subject,
      neonApp.status,
      neonApp.message,
      neonApp.evidence,
      checkedAt,
    ));
    return findings;
  }

  async function collectAgent(
    subject: ReadinessSubject,
    options: AgentReadinessCollectionOptions,
    checkedAt: string,
  ): Promise<AgentReadinessFinding[]> {
    const agent = subject.agent!;
    const findings: AgentReadinessFinding[] = [];
    const config = asRecord(agent.adapterConfig);
    const metadata = asRecord(agent.metadata);
    const hermes = isHermesAdapter(agent.adapterType);
    const hermesProfile = hermes ? resolveHermesProfile(config) : null;
    const hermesMcp = hermes && hermesHasMcpToolset(config);
    const managedAiConnection = Boolean(asRecord(agent.runtimeConfig).aiConnection);

    const add = (
      checkId: string,
      status: AgentReadinessCheckStatus,
      message: string,
      evidence: Record<string, unknown> | null = null,
    ) => {
      const def = agentReadinessCheck(checkId);
      if (!def || !def.subjects.includes(subject.subjectType)) return;
      findings.push(makeFinding(def, subject, status, message, evidence, checkedAt));
    };

    let entryContent = "";
    let instructionScan: InstructionScanResult = {
      secretFiles: [],
      gbrainFiles: [],
      neonFiles: [],
      secretNeonFiles: [],
      hindsightFiles: [],
    };
    async function collectInstructionsAndRuntime() {
    let bundle: Awaited<ReturnType<typeof instructions.getBundle>> | null = null;
    try {
      bundle = await instructions.getBundle(agent);
      const entry = bundle.files.find((file) => file.isEntryFile);
      if (entry && !entry.binary) entryContent = (await instructions.readFile(agent, entry.path)).content;
    } catch (error) {
      bundle = null;
      entryContent = "";
      instructionScan = {
        secretFiles: [],
        gbrainFiles: [],
        neonFiles: [],
        secretNeonFiles: [],
        hindsightFiles: [],
      };
      add("instructions.configured", "fail", `The instructions bundle could not be read: ${errorMessage(error)}`, null);
    }
    if (bundle) instructionScan = await scanBundle(agent, bundle);
    if (!findings.some((finding) => finding.checkId === "instructions.configured")) {
      const configured = Boolean(bundle?.rootPath) && Boolean(bundle?.files.some((file) => file.isEntryFile && file.size > 0)) && entryContent.trim().length > 0;
      add(
        "instructions.configured",
        configured ? "pass" : "fail",
        configured
          ? `Instructions entry ${bundle?.entryFile ?? "file"} is present and readable.`
          : bundle?.rootPath
            ? `Instructions root is set but ${bundle.entryFile} is missing or empty.`
            : "No instructions bundle is configured.",
        { mode: bundle?.mode ?? null, entryFile: bundle?.entryFile ?? null, fileCount: bundle?.files.length ?? 0, warningCount: bundle?.warnings.length ?? 0 },
      );
    }

    const skillRows = await db.select({ key: companySkills.key }).from(companySkills).where(eq(companySkills.companyId, agent.companyId));
    const skillKeys = new Set(skillRows.map((row) => row.key));
    const desired = readPaperclipSkillSyncPreference(config);
    const missingSkills = desired.desiredSkills.filter((key) => !skillKeys.has(key));
    add(
      "instructions.no_dead_skill_refs",
      missingSkills.length === 0 ? "pass" : "fail",
      missingSkills.length === 0
        ? desired.desiredSkills.length
          ? "All desired skills still exist in the company library."
          : "No desired skill references to check."
        : `${missingSkills.length} desired skill${missingSkills.length === 1 ? " is" : "s are"} missing from the company library.`,
      { desiredSkills: desired.desiredSkills.length, missingSkills },
    );

    add(
      "skills.desired",
      desired.desiredSkills.length > 0 ? "pass" : "fail",
      desired.desiredSkills.length > 0
        ? `${desired.desiredSkills.length} company skill${desired.desiredSkills.length === 1 ? " is" : "s are"} selected.`
        : "No company skills are selected for this agent.",
      { desiredSkills: desired.desiredSkills.length, explicit: desired.explicit },
    );

    const model = typeof config.model === "string" ? config.model.trim() : "";
    const fallback = ["fallbackModel", "backupModel", "modelFallback", "fallbackModels"]
      .map((key) => config[key])
      .find((value) => (typeof value === "string" && value.trim()) || (Array.isArray(value) && value.length > 0));
    const modelConfigured = managedAiConnection
      || (hermes ? Boolean(hermesProfile) : Boolean(agent.adapterType && (model || agent.adapterType === "process")));
    add(
      "model.configured",
      modelConfigured ? "pass" : "fail",
      managedAiConnection
        ? "A managed AI connection supplies the model."
        : hermes
          ? hermesProfile
            ? `Hermes profile ${hermesProfile} supplies the model.`
            : "No Hermes profile is selected to supply the model."
          : agent.adapterType
            ? model
              ? `Adapter ${agent.adapterType} is configured with model ${model}.`
              : `Adapter ${agent.adapterType} is configured; no model is stored.`
            : "No adapter type is configured.",
      { adapterType: agent.adapterType, model: model || null, hermesProfile, managedAiConnection },
    );
    const pinned = hermes ? Boolean(hermesProfile) : Boolean(model && !["auto", "default"].includes(model.toLowerCase()));
    add(
      "model.pinned",
      managedAiConnection ? "skipped" : pinned ? "pass" : "fail",
      managedAiConnection
        ? "A managed AI connection owns the model version."
        : hermes
          ? hermesProfile
            ? `Hermes profile ${hermesProfile} pins the model.`
            : "No Hermes profile is selected to pin the model."
          : model
            ? ["auto", "default"].includes(model.toLowerCase())
              ? `Model ${model} is not pinned to a version.`
              : `Model ${model} is pinned.`
            : "No model is stored to pin.",
      { model: model || null, hermesProfile },
    );
    add(
      "model.backup",
      managedAiConnection ? "skipped" : hermes ? (hermesProfile ? "pass" : "fail") : fallback ? "pass" : "fail",
      managedAiConnection
        ? "A managed AI connection owns model fallback."
        : hermes
          ? hermesProfile
            ? `Hermes profile ${hermesProfile} owns model fallback.`
            : "No Hermes profile is selected to own model fallback."
          : fallback
            ? "A fallback model is configured."
            : "No fallback or backup model is configured.",
      { fallback: typeof fallback === "string" ? fallback : fallback ? "configured" : null, hermesProfile },
    );
    add(
      "runtime.hermes_profile",
      !hermes ? "skipped" : hermesProfile && hermesMcp ? "pass" : "fail",
      hermes
        ? hermesProfile
          ? hermesMcp
            ? `Hermes profile ${hermesProfile} is selected with the mcp toolset.`
            : `Hermes profile ${hermesProfile} does not include the mcp toolset.`
          : "No Hermes profile is selected. Set hermesCommand or -p <profile> in extraArgs."
        : "This check applies to Hermes profiles only.",
      { hermesProfile, toolsets: hermes ? hermesToolsets(config) : [] },
    );
    add(
      "runtime.harness_verified",
      agent.harnessVerifiedAt ? "pass" : "fail",
      agent.harnessVerifiedAt
        ? `Harness verification passed at ${agent.harnessVerifiedAt.toISOString()}.`
        : "No passing harness verification is recorded.",
      { harnessVerifiedAt: agent.harnessVerifiedAt?.toISOString() ?? null, hasDigest: Boolean(agent.harnessVerifiedDigest) },
    );
    const active = !["paused", "terminated", "pending_approval", "preparing"].includes(agent.status) && agent.lifecycleState !== "paused";
    add(
      "runtime.active",
      active ? "pass" : "fail",
      active ? `Agent status is ${agent.status}.` : `Agent is ${agent.status}${agent.pauseReason ? ` (${agent.pauseReason})` : ""}.`,
      { status: agent.status, lifecycleState: agent.lifecycleState, pauseReason: agent.pauseReason },
    );

    const [revision] = await db.select({ id: agentConfigRevisions.id, createdAt: agentConfigRevisions.createdAt })
      .from(agentConfigRevisions)
      .where(and(eq(agentConfigRevisions.companyId, agent.companyId), eq(agentConfigRevisions.agentId, agent.id)))
      .orderBy(desc(agentConfigRevisions.createdAt))
      .limit(1);
    add(
      "runtime.config_revision",
      revision ? "pass" : "fail",
      revision
        ? `A configuration revision was saved at ${revision.createdAt.toISOString()}.`
        : "No configuration revision has been saved.",
      { latestRevisionAt: revision?.createdAt?.toISOString() ?? null },
    );
    }
    await collectInstructionsAndRuntime();

    async function collectTestingChecks() {
    const testIssueId = typeof metadata.readinessTestIssueId === "string" && isUuidLike(metadata.readinessTestIssueId)
      ? metadata.readinessTestIssueId
      : null;
    const [testIssue] = testIssueId
      ? await db.select({
        id: issues.id,
        identifier: issues.identifier,
        status: issues.status,
        executionState: issues.executionState,
      })
        .from(issues)
        .where(and(eq(issues.companyId, agent.companyId), eq(issues.id, testIssueId)))
        .limit(1)
      : [];
    add(
      "tests.task_linked",
      testIssue ? "pass" : "fail",
      testIssue
        ? `Readiness test task ${testIssue.identifier ?? testIssue.id} is linked.`
        : "No readiness test task is linked.",
      { testIssueId: testIssueId ?? null, status: testIssue?.status ?? null },
    );
    if (testIssue) {
      const testRuns = await db.select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        issueCommentStatus: heartbeatRuns.issueCommentStatus,
        resultJson: heartbeatRuns.resultJson,
      })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.companyId, agent.companyId),
          eq(heartbeatRuns.agentId, agent.id),
          eq(heartbeatRuns.issueId, testIssue.id),
        ))
        .orderBy(desc(heartbeatRuns.startedAt))
        .limit(20);
      const rate = successRate(testRuns.map((run) => run.status));
      const enoughRuns = testRuns.length >= 2;
      add(
        "tests.heartbeat_run",
        testRuns.length ? "pass" : "not_checked",
        testRuns.length
          ? `The readiness test task has ${testRuns.length} heartbeat run${testRuns.length === 1 ? "" : "s"}.`
          : "The readiness test task has not run through heartbeat yet.",
        { runCount: testRuns.length },
      );
      add(
        "tests.pass_rate",
        !enoughRuns ? "not_checked" : rate >= 0.8 ? "pass" : "fail",
        enoughRuns
          ? `Readiness test success rate is ${Math.round(rate * 100)}% across ${testRuns.length} runs.`
          : `The readiness test task has ${testRuns.length} run${testRuns.length === 1 ? "" : "s"}; at least two are required.`,
        { runCount: testRuns.length, successRate: rate, statuses: testRuns.map((run) => run.status) },
      );
      const dispositions = testRuns
        .map((run) => asRecord(asRecord(run.resultJson).result).reportedWorkDisposition)
        .filter((value): value is string => typeof value === "string");
      const markedDone = dispositions.includes("done");
      const [rejected] = await db.select({ id: nativeRunResults.id })
        .from(nativeRunResults)
        .where(and(
          eq(nativeRunResults.companyId, agent.companyId),
          eq(nativeRunResults.issueId, testIssue.id),
          sql`${nativeRunResults.rejectionCode} is not null`,
        ))
        .limit(1);
      const reviewDecisions = await db.select({ outcome: issueExecutionDecisions.outcome })
        .from(issueExecutionDecisions)
        .where(and(
          eq(issueExecutionDecisions.companyId, agent.companyId),
          eq(issueExecutionDecisions.issueId, testIssue.id),
          eq(issueExecutionDecisions.stageType, "review"),
        ));
      const approvedInReview = reviewDecisions.some((decision) => decision.outcome === "approved")
        || asRecord(testIssue.executionState).lastDecisionOutcome === "approved";
      const commentSatisfied = testRuns.some((run) => run.issueCommentStatus === "satisfied");
      const reviewedStatus: AgentReadinessCheckStatus = testRuns.length === 0
        ? "not_checked"
        : rejected
          ? "fail"
          : !markedDone
            ? "not_checked"
            : !approvedInReview || !commentSatisfied
              ? "fail"
              : "pass";
      add(
        "tests.reviewed",
        reviewedStatus,
        reviewedStatus === "not_checked"
          ? testRuns.length === 0
            ? "The readiness test task has not run yet."
            : "The readiness test task has not reported done yet."
          : reviewedStatus === "fail"
            ? rejected
              ? "A completion contract rejected the readiness test result."
              : !approvedInReview
                ? "The readiness test task was marked done without an approved review."
                : "The readiness test task was marked done without its required run comment."
            : "The readiness test task was reviewed, approved and commented.",
        {
          markedDone,
          approvedInReview,
          commentSatisfied,
          rejected: Boolean(rejected),
          reviewDecisions: reviewDecisions.map((decision) => decision.outcome),
          dispositions,
        },
      );
    } else {
      add("tests.pass_rate", "not_checked", "No readiness test task is linked.", null);
      add("tests.reviewed", "not_checked", "No readiness test task is linked.", null);
      add("tests.heartbeat_run", "not_checked", "No readiness test task is linked.", null);
    }
    }
    await collectTestingChecks();

    async function collectWorkspaceChecks() {
    let environment: { id: string; name: string; driver: string; status: string } | null = null;
    let environmentOwnerError: string | null = null;
    if (agent.defaultEnvironmentId) {
      try {
        const resolved = await agentEnvironmentTestService(db).assertAdapterTestEnvironmentBinding(
          agent.companyId,
          agent.defaultEnvironmentId,
        );
        environment = resolved
          ? { id: resolved.id, name: resolved.name, driver: resolved.driver, status: resolved.status }
          : null;
      } catch (error) {
        environmentOwnerError = errorMessage(error);
      }
    }
    const environmentResolved = agent.defaultEnvironmentId
      ? Boolean(environment) && !environmentOwnerError
      : true;
    add(
      "workspace.environment",
      environmentResolved ? "pass" : "fail",
      environmentResolved
        ? environment
          ? `Environment ${environment.name} (${environment.driver}) is registered.`
          : "The agent runs on the local host environment."
        : environmentOwnerError ?? "The selected environment no longer exists.",
      { environmentId: agent.defaultEnvironmentId, driver: environment?.driver ?? "local", environmentStatus: environment?.status ?? null },
    );
    const sandboxOk = !environment || environment.driver !== "sandbox" || environment.status === "active";
    add(
      "access.sandbox",
      sandboxOk ? "pass" : "fail",
      environment
        ? environment.driver === "sandbox"
          ? sandboxOk ? `Sandbox environment ${environment.name} is active.` : `Sandbox environment ${environment.name} is ${environment.status}.`
          : `Environment ${environment.name} uses the ${environment.driver} driver.`
        : "No sandbox is selected; the agent runs locally.",
      { driver: environment?.driver ?? "local", status: environment?.status ?? null },
    );
    }
    await collectWorkspaceChecks();

    async function collectRunChecks() {
    const recentRuns = await db.select({ status: heartbeatRuns.status, startedAt: heartbeatRuns.startedAt })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, agent.companyId), eq(heartbeatRuns.agentId, agent.id)))
      .orderBy(desc(heartbeatRuns.startedAt))
      .limit(20);
    const recentRate = successRate(recentRuns.map((run) => run.status));
    add(
      "runs.recent",
      recentRuns.length > 0 && recentRate >= 0.8 ? "pass" : "fail",
      recentRuns.length === 0
        ? "No heartbeat runs are recorded for this agent."
        : `Last ${recentRuns.length} runs succeeded at ${Math.round(recentRate * 100)}%.`,
      { runCount: recentRuns.length, successRate: recentRate, lastRunAt: recentRuns[0]?.startedAt?.toISOString() ?? null },
    );
    const stuckSince = new Date(Date.now() - STUCK_RUN_MS);
    const stuckRows = await db.select({ id: heartbeatRuns.id, startedAt: heartbeatRuns.startedAt })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, agent.companyId),
        eq(heartbeatRuns.agentId, agent.id),
        inArray(heartbeatRuns.status, RUNNING_RUN_STATUSES),
        lt(heartbeatRuns.startedAt, stuckSince),
      ))
      .limit(10);
    add(
      "runs.no_stuck",
      stuckRows.length ? "fail" : "pass",
      stuckRows.length
        ? `${stuckRows.length} run${stuckRows.length === 1 ? " has" : "s have"} been running for more than an hour.`
        : "No run has been running for more than an hour.",
      { stuckRunIds: stuckRows.map((row) => row.id) },
    );
    }
    await collectRunChecks();

    async function collectPermissionChecks() {
    const [budgetPolicy] = await db.select({ id: budgetPolicies.id }).from(budgetPolicies).where(and(
      eq(budgetPolicies.companyId, agent.companyId),
      eq(budgetPolicies.scopeType, "agent"),
      eq(budgetPolicies.scopeId, agent.id),
      eq(budgetPolicies.isActive, true),
    )).limit(1);
    const budgetPass = agent.budgetMonthlyCents > 0 || Boolean(budgetPolicy);
    add(
      "permissions.budget",
      budgetPass ? "pass" : "fail",
      budgetPass ? "A monthly budget or active budget policy is set." : "No monthly budget or active budget policy is set.",
      { monthlyBudgetCents: agent.budgetMonthlyCents, hasBudgetPolicy: Boolean(budgetPolicy) },
    );

    const [agentApprovalPolicy] = await db.select({ id: toolPolicies.id }).from(toolPolicies).where(and(
      eq(toolPolicies.companyId, agent.companyId),
      eq(toolPolicies.enabled, true),
      eq(toolPolicies.policyType, "require_approval"),
    )).limit(1);
    // Board approval for new agents gates hiring, not spend/send/delete.
    const agentApprovalPass = Boolean(agentApprovalPolicy);
    add(
      "permissions.approval_policy",
      agentApprovalPass ? "pass" : "fail",
      agentApprovalPass
        ? "Approval gating is configured for risky actions."
        : "No approval gate is configured for spend, send or delete actions; hire approval does not count.",
      { requireApprovalPolicy: Boolean(agentApprovalPolicy) },
    );
    }
    await collectPermissionChecks();

    async function collectSmokeAndToolChecks() {
    const experimental = await instanceSettings.getExperimental();
    const smokeSince = new Date(Date.now() - SMOKE_RUN_LOOKBACK_MS);
    const [agentSmokeRun] = await db.select({ id: smokeRuns.id }).from(smokeRuns).where(and(
      eq(smokeRuns.companyId, agent.companyId),
      gte(smokeRuns.startedAt, smokeSince),
    )).orderBy(desc(smokeRuns.startedAt)).limit(1);
    const smokeEnabled = experimental.enableSmokeLab === true;
    add(
      "tests.smoke_lab",
      smokeEnabled && agentSmokeRun ? "pass" : "fail",
      smokeEnabled && agentSmokeRun
        ? "Smoke Lab is enabled and has a recent company run."
        : smokeEnabled
          ? "Smoke Lab is enabled but has no run in the last seven days."
          : "Smoke Lab is not enabled.",
      { enabled: smokeEnabled, recentRun: Boolean(agentSmokeRun) },
    );

    const agentConnections = await db.select({ name: toolConnections.name, healthStatus: toolConnections.healthStatus })
      .from(toolConnections)
      .where(and(eq(toolConnections.companyId, agent.companyId), eq(toolConnections.enabled, true)));
    const agentUnhealthy = agentConnections.filter((row) => TOOL_ATTENTION_HEALTH.has(row.healthStatus));
    const agentUnchecked = agentConnections.filter((row) => row.healthStatus === "unchecked" || row.healthStatus === "unknown");
    add(
      "tools.health",
      agentUnhealthy.length ? "fail" : agentUnchecked.length ? "not_checked" : "pass",
      agentUnhealthy.length
        ? `${agentUnhealthy.length} enabled tool connection${agentUnhealthy.length === 1 ? " needs" : "s need"} attention.`
        : agentUnchecked.length
          ? "Some enabled tool connections have not been checked."
          : "Enabled tool connections are healthy.",
      {
        enabledConnections: agentConnections.length,
        unhealthy: agentUnhealthy.map((row) => row.name),
        unchecked: agentUnchecked.length,
      },
    );
    }
    await collectSmokeAndToolChecks();

    async function collectVaultAndIntakeChecks() {
    const plainKeys = plainEnvKeys(config);
    const [secretBinding] = await db.select({ id: companySecretBindings.id }).from(companySecretBindings)
      .where(and(eq(companySecretBindings.companyId, agent.companyId), eq(companySecretBindings.targetId, agent.id)))
      .limit(1);
    const secretsInInstructions = instructionScan.secretFiles.length > 0;
    add(
      "permissions.vault_secrets",
      plainKeys.length || secretsInInstructions ? "fail" : "pass",
      plainKeys.length
        ? `${plainKeys.length} plaintext environment value${plainKeys.length === 1 ? " is" : "s are"} stored in the agent configuration.`
        : secretsInInstructions
          ? `${instructionScan.secretFiles.length} instruction file${instructionScan.secretFiles.length === 1 ? " contains" : "s contain"} a plaintext credential.`
          : "No plaintext environment values or instruction credentials are stored.",
      {
        plainEnvKeys: plainKeys,
        criticalPlainEnvKeys: plainKeys.filter(criticalKeyLike),
        secretBindings: secretBinding ? 1 : 0,
        instructionSecretFiles: instructionScan.secretFiles,
      },
    );

    const [companyAgentCount] = await db.select({ count: sql<number>`count(*)::int` }).from(agents)
      .where(and(eq(agents.companyId, agent.companyId), sql`${agents.status} <> 'terminated'`));
    const leadRole = /(ceo|chief|founder|lead|orchestrat|manager|director)/i.test(`${agent.role} ${agent.title ?? ""}`);
    const managerPass = Boolean(agent.reportsTo) || (companyAgentCount?.count ?? 0) <= 1 || leadRole;
    add(
      "intake.manager",
      managerPass ? "pass" : "fail",
      managerPass
        ? agent.reportsTo ? "A reporting line is set." : "This is the company lead or only agent."
        : "No reporting line is set.",
      { reportsTo: agent.reportsTo, companyAgentCount: companyAgentCount?.count ?? 0, leadRole },
    );
    const role = agent.role?.trim() ?? "";
    const title = agent.title?.trim() ?? "";
    const capabilities = agent.capabilities?.trim() ?? "";
    // "general" is the hire default, not a description of what the agent is good at.
    const described = Boolean(title || capabilities || (role && role !== "general"));
    add(
      "intake.description",
      described ? "pass" : "fail",
      described
        ? "The agent has a role, title or capability summary."
        : 'The role is the default "general" with no title or capabilities.',
      { role: agent.role, title: agent.title, capabilities: agent.capabilities },
    );
    const staleBlockedRows = await db.select({ id: issues.id, identifier: issues.identifier })
      .from(issues)
      .where(and(
        eq(issues.companyId, agent.companyId),
        eq(issues.assigneeAgentId, agent.id),
        eq(issues.status, "blocked"),
        lt(issues.updatedAt, new Date(Date.now() - STALE_BLOCKED_MS)),
      ))
      .limit(20);
    add(
      "intake.no_stale_blocked",
      staleBlockedRows.length ? "fail" : "pass",
      staleBlockedRows.length
        ? `${staleBlockedRows.length} blocked task${staleBlockedRows.length === 1 ? " is" : "s are"} older than 14 days.`
        : "No blocked task is older than 14 days.",
      { staleBlocked: staleBlockedRows.map((row) => row.identifier ?? row.id) },
    );
    }
    await collectVaultAndIntakeChecks();

    async function collectMemoryChecks() {
    const hindsightInInstructions = instructionScan.hindsightFiles.length > 0;
    add(
      "memory.hindsight_removed",
      hindsightInInstructions ? "fail" : "pass",
      hindsightInInstructions
        ? `Hindsight is still referenced in ${instructionScan.hindsightFiles.length} instruction file${instructionScan.hindsightFiles.length === 1 ? "" : "s"}.`
        : "No instruction file references Hindsight.",
      { referencesHindsight: hindsightInInstructions, files: instructionScan.hindsightFiles },
    );

    const gbrainConnections = await findGbrainConnections(db, agent.companyId);
    const installs = await findAgentConnectionInstalls(db, agent.companyId, agent.id);
    const attachment = evaluateGbrainAttachment({
      marker: readGbrainMarker(metadata),
      connections: gbrainConnections,
      agentConnectionIds: installs,
      instructionsMention: instructionScan.gbrainFiles.length > 0,
    });
    add(
      "memory.gbrain_connected",
      attachment.attached ? "pass" : "fail",
      attachment.attached
        ? attachment.connectionId
          ? `GBrain is attached through a connector (${attachment.healthStatus ?? "health unknown"}).`
          : "The Hermes profile configuration names the GBrain MCP server."
        : attachment.markerOnly
          ? "GBrain was recorded at hire, but no connector or Hermes profile MCP entry is attached."
          : "GBrain is not attached to this agent.",
      {
        source: attachment.source,
        connectionId: attachment.connectionId,
        healthStatus: attachment.healthStatus,
        markerOnly: attachment.markerOnly,
        instructionFiles: instructionScan.gbrainFiles,
      },
    );

    const runtimeConfig = loadConfig();
    const neon = evaluateNeonAdsAccess({
      credentials: await findNeonConnections(db, agent.companyId),
      appDatabaseName: safeDatabaseName(runtimeConfig.databaseUrl),
      appDatabaseHost: safeHostname(runtimeConfig.databaseUrl),
      credentialInInstructions: instructionScan.secretNeonFiles.length > 0,
      neonMentionedInInstructions: instructionScan.neonFiles.length > 0,
    });
    add("tools.neon_ads_readonly", neon.status, neon.message, neon.evidence);
    }
    await collectMemoryChecks();

    // Level 12 applies to Hermes twins only; `add` drops these for agents.
    add(
      "bot.hermes_twin",
      isGrokBotTwin(agent) ? "pass" : "fail",
      isGrokBotTwin(agent)
        ? "This agent is tagged as a grok-bot-twin."
        : "This agent is not tagged as a grok-bot-twin.",
      { grokBotTwin: isGrokBotTwin(agent) },
    );
    add(
      "bot.twin_profile",
      hermesProfile && hermesMcp ? "pass" : "fail",
      hermesProfile && hermesMcp
        ? `Hermes profile ${hermesProfile} is selected with the mcp toolset.`
        : "The twin has no Hermes profile with the mcp toolset.",
      { hermesProfile, toolsets: hermesToolsets(config) },
    );

    const liveAllowedForSubject = options.includeLive
      && (!options.onlySubject
        || (options.onlySubject.subjectType === subject.subjectType
          && options.onlySubject.subjectId === subject.subjectId));
    const probe = liveAllowedForSubject
      ? await options.probe?.(subject) ?? {
        status: "not_checked" as const,
        message: "No live probe is configured.",
      }
      : {
        status: "not_checked" as const,
        message: "Live probe not run. Run checks with live probes.",
      };
    add(
      "model.probe",
      managedAiConnection ? "skipped" : probe.status,
      managedAiConnection
        ? "A managed AI connection is verified from the agent page, not by this probe."
        : probe.message,
      probe.evidence ?? null,
    );
    // A twin is checked with the same adapter probe as any Hermes agent.
    add(
      "bot.twin_verified",
      probe.status,
      probe.status === "pass"
        ? "The live probe reached the twin's Hermes profile."
        : probe.message,
      probe.evidence ?? null,
    );
    // The model/adapter probe is not a login probe: it never touches the browser,
    // GHL, Meta or the other logins the rubric asks about. Leave this box
    // not-checked until a real login probe exists, so it cannot pass on the
    // wrong evidence.
    add(
      "access.logins",
      "not_checked",
      "No login probe exists yet. Check this agent's required logins on its own connection page.",
      probe.evidence
        ? { adapterProbeStatus: probe.status, adapterProbe: probe.evidence }
        : { adapterProbeStatus: probe.status },
    );
    return findings;
  }

  async function collect(
    companyId: string,
    options: AgentReadinessCollectionOptions,
  ): Promise<AgentReadinessCollection> {
    const { company, subjects } = await listSubjects(companyId);
    const checkedAt = new Date().toISOString();
    const attestationMap = new Map(
      options.attestations
        .filter((attestation) => attestation.companyId === companyId)
        .map((attestation) => [
          `${attestation.subjectType}:${attestation.subjectId}:${attestation.checkId}`,
          attestation,
        ]),
    );
    const findings: AgentReadinessFinding[] = [];
    for (const subject of subjects) {
      const subjectFindings = subject.subjectType === "company"
        ? await collectCompany(company, subject, checkedAt)
        : await collectAgent(subject, options, checkedAt);
      for (const def of AGENT_READINESS_CHECKS) {
        if (!def.subjects.includes(subject.subjectType)) continue;
        const existing = subjectFindings.find((finding) => finding.checkId === def.id);
        if (existing) {
          findings.push(existing);
          continue;
        }
        const attestation = attestationMap.get(`${subject.subjectType}:${subject.subjectId}:${def.id}`);
        if (def.kind === "manual") {
          // A manual box passes only on a note saying what the person checked.
          // An attestation without one is not a pass, so a legacy empty row
          // cannot turn a level green.
          const attestedNote = attestation?.note?.trim() ?? "";
          findings.push(makeFinding(
            def,
            subject,
            attestedNote ? "pass" : "not_checked",
            attestedNote
              ? `Attested by ${attestation!.attestedByUserId} on ${attestation!.attestedAt}.`
              : attestation
                ? "An attestation was saved without a note. Add what you checked to complete this box."
                : "Not attested yet.",
            attestation
              ? { note: attestation.note, attestedByUserId: attestation.attestedByUserId, attestedAt: attestation.attestedAt }
              : null,
            checkedAt,
          ));
          continue;
        }
        findings.push(makeFinding(
          def,
          subject,
          "not_checked",
          "This check was not evaluated on this subject.",
          null,
          checkedAt,
        ));
      }
    }
    return summarizeReadinessCollection(subjects, findings);
  }

  return { listSubjects, collect };
}

export function readinessSubjectStatusLabel(status: AgentReadinessSubjectStatus): string {
  switch (status) {
    case "ready": return "Ready";
    case "attention": return "Needs attention";
    case "blocked": return "Blocked";
    case "unverified": return "Unverified";
  }
}

export function readinessLevelStatusLabel(status: AgentReadinessSummary["levels"][number]["status"]): string {
  switch (status) {
    case "pass": return "Pass";
    case "fail": return "Fail";
    case "unverified": return "Unverified";
    case "skipped": return "Not applicable";
  }
}

export const readinessFindingAgentId = (finding: AgentReadinessFinding): string | null =>
  finding.subjectType === "agent" || finding.subjectType === "bot" ? finding.subjectId : null;
export const readinessUsesLiveProbe = (finding: AgentReadinessFinding): boolean => finding.kind === "live";
