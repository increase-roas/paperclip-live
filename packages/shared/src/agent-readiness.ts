import { z } from "zod";

/**
 * Company-scoped agent and bot readiness rubric.
 *
 * The catalog is intentionally data-only: the server evaluates each check and
 * the UI renders the same definitions. Scoring lives here so the page, the
 * API and tests cannot disagree about what "passing a level" means.
 *
 * Source of truth for the rubric text: doc/agent-readiness/AGENT-READINESS-CHECKLIST.md (v1.4).
 *
 * In-scope subjects are the company, Hermes-profile agents (`hermes_local` /
 * `hermes_gateway`) and Hermes bots hired from the grok-bot-twin plugin. Dot,
 * Muse and Paperclip's native `grok_bot` provider are deliberately out of scope.
 */

export const AGENT_READINESS_LEVELS = [
  { level: 1, name: "Instructions & output" },
  { level: 2, name: "Model & runtime" },
  { level: 3, name: "Testing" },
  { level: 4, name: "Skills & tools" },
  { level: 5, name: "Workspace & access" },
  { level: 6, name: "Run visibility" },
  { level: 7, name: "Permissions & secrets" },
  { level: 8, name: "Task intake & routing" },
  { level: 9, name: "Outcomes & improvement" },
  { level: 10, name: "Memory" },
  { level: 11, name: "Orchestration" },
  { level: 12, name: "Hermes bots (Grok twins)" },
  { level: 13, name: "Company operations" },
] as const;

export type AgentReadinessLevel = (typeof AGENT_READINESS_LEVELS)[number]["level"];
export type AgentReadinessLevelName = (typeof AGENT_READINESS_LEVELS)[number]["name"];

export const AGENT_READINESS_SUBJECT_TYPES = ["agent", "bot", "company"] as const;
export type AgentReadinessSubjectType = (typeof AGENT_READINESS_SUBJECT_TYPES)[number];

export const AGENT_READINESS_CHECK_KINDS = ["auto", "live", "manual"] as const;
export type AgentReadinessCheckKind = (typeof AGENT_READINESS_CHECK_KINDS)[number];

export const AGENT_READINESS_SEVERITIES = ["must_pass", "standard"] as const;
export type AgentReadinessSeverity = (typeof AGENT_READINESS_SEVERITIES)[number];

export const AGENT_READINESS_CHECK_STATUSES = ["pass", "fail", "not_checked", "skipped"] as const;
export type AgentReadinessCheckStatus = (typeof AGENT_READINESS_CHECK_STATUSES)[number];

export const AGENT_READINESS_LEVEL_STATUSES = ["pass", "fail", "unverified", "skipped"] as const;
export type AgentReadinessLevelStatus = (typeof AGENT_READINESS_LEVEL_STATUSES)[number];

export const AGENT_READINESS_SUBJECT_STATUSES = ["ready", "attention", "blocked", "unverified"] as const;
export type AgentReadinessSubjectStatus = (typeof AGENT_READINESS_SUBJECT_STATUSES)[number];

export const AGENT_READINESS_FIX_ACTIONS = [
  "sync_skills",
  "snapshot_config",
  "run_probe",
  "create_test_task",
  "pause_agent",
  "resume_agent",
] as const;
export type AgentReadinessFixAction = (typeof AGENT_READINESS_FIX_ACTIONS)[number];

export interface AgentReadinessFix {
  action: AgentReadinessFixAction;
  label: string;
}

export interface AgentReadinessDeepLink {
  label: string;
  /** Company-relative route. `{agentId}` is replaced for agent subjects. */
  path: string;
}

export interface AgentReadinessCheckDefinition {
  id: string;
  level: AgentReadinessLevel;
  title: string;
  description: string;
  kind: AgentReadinessCheckKind;
  severity: AgentReadinessSeverity;
  subjects: readonly AgentReadinessSubjectType[];
  fix?: AgentReadinessFix;
  deepLink?: AgentReadinessDeepLink;
}

const AGENT_AND_BOT = ["agent", "bot"] as const;

export const AGENT_READINESS_CHECKS: readonly AgentReadinessCheckDefinition[] = [
  // Level 1 — instructions and output
  {
    id: "instructions.configured",
    level: 1,
    title: "Instructions bundle is configured",
    description: "The agent has a readable instructions bundle with a non-empty entry file.",
    kind: "auto",
    severity: "standard",
    subjects: AGENT_AND_BOT,
    deepLink: { label: "Open instructions", path: "/agents/{agentId}/identity" },
  },
  {
    id: "instructions.no_dead_skill_refs",
    level: 1,
    title: "No missing skill references",
    description: "Every desired skill still exists in the company skill library.",
    kind: "auto",
    severity: "standard",
    subjects: AGENT_AND_BOT,
    fix: { action: "sync_skills", label: "Remove missing skills" },
    deepLink: { label: "Open skills", path: "/agents/{agentId}/identity" },
  },
  {
    id: "instructions.no_conflicts",
    level: 1,
    title: "No conflicting instructions across agents",
    description: "A person confirmed that two agents do not carry overlapping or conflicting instructions.",
    kind: "manual",
    severity: "standard",
    subjects: AGENT_AND_BOT,
    deepLink: { label: "Review instructions", path: "/agents/{agentId}/identity" },
  },
  {
    id: "instructions.no_dead_references",
    level: 1,
    title: "No dead references in instructions",
    description: "A person confirmed that instructions name no retired tool, skill or memory system.",
    kind: "manual",
    severity: "standard",
    subjects: AGENT_AND_BOT,
    deepLink: { label: "Review instructions", path: "/agents/{agentId}/identity" },
  },
  {
    id: "instructions.output_format",
    level: 1,
    title: "Output format matches the task type",
    description: "A person confirmed the agent's output shape matches the work it is given.",
    kind: "manual",
    severity: "standard",
    subjects: AGENT_AND_BOT,
    deepLink: { label: "Review instructions", path: "/agents/{agentId}/identity" },
  },

  // Level 2 — model and runtime
  {
    id: "model.probe",
    level: 2,
    title: "Model answers and the adapter works",
    description: "A live environment probe reached the configured model through the selected adapter.",
    kind: "live",
    severity: "must_pass",
    subjects: AGENT_AND_BOT,
    fix: { action: "run_probe", label: "Run live probe" },
    deepLink: { label: "Open runtime", path: "/agents/{agentId}/runtime" },
  },
  {
    id: "model.configured",
    level: 2,
    title: "Model and runtime are configured",
    description: "An adapter is saved with a model, or a Hermes profile supplies one.",
    kind: "auto",
    severity: "must_pass",
    subjects: AGENT_AND_BOT,
    deepLink: { label: "Open runtime", path: "/agents/{agentId}/runtime" },
  },
  {
    id: "model.pinned",
    level: 2,
    title: "Model is pinned",
    description: "The model names a specific version, or a Hermes profile pins one.",
    kind: "auto",
    severity: "standard",
    subjects: AGENT_AND_BOT,
    deepLink: { label: "Open runtime", path: "/agents/{agentId}/runtime" },
  },
  {
    id: "model.backup",
    level: 2,
    title: "Backup model is set",
    description: "A fallback model is saved, or the Hermes profile owns the model choice.",
    kind: "auto",
    severity: "standard",
    subjects: AGENT_AND_BOT,
    deepLink: { label: "Open runtime", path: "/agents/{agentId}/runtime" },
  },
  {
    id: "runtime.hermes_profile",
    level: 2,
    title: "Hermes profile is selected",
    description: "A Hermes profile is selected through the command alias or `-p`, and the toolset includes `mcp`.",
    kind: "auto",
    severity: "must_pass",
    subjects: AGENT_AND_BOT,
    deepLink: { label: "Open runtime", path: "/agents/{agentId}/runtime" },
  },
  {
    id: "runtime.config_revision",
    level: 2,
    title: "Setup is snapshotted",
    description: "At least one saved configuration revision exists so a bad change can be reviewed.",
    kind: "auto",
    severity: "standard",
    subjects: AGENT_AND_BOT,
    fix: { action: "snapshot_config", label: "Snapshot configuration" },
    deepLink: { label: "Open runtime", path: "/agents/{agentId}/runtime" },
  },
  {
    id: "runtime.harness_verified",
    level: 2,
    title: "Harness verification passed",
    description: "The current harness configuration has a recorded passing verification.",
    kind: "auto",
    severity: "standard",
    subjects: AGENT_AND_BOT,
    fix: { action: "run_probe", label: "Run live probe" },
    deepLink: { label: "Open runtime", path: "/agents/{agentId}/runtime" },
  },
  {
    id: "runtime.active",
    level: 2,
    title: "Agent is active",
    description: "The agent is not paused, so heartbeat work can be admitted.",
    kind: "auto",
    severity: "standard",
    subjects: AGENT_AND_BOT,
    fix: { action: "resume_agent", label: "Resume agent" },
    deepLink: { label: "Open agent", path: "/agents/{agentId}" },
  },

  // Level 3 — testing
  {
    id: "tests.task_linked",
    level: 3,
    title: "Readiness test task exists",
    description: "An existing task is reserved as this agent's readiness test.",
    kind: "auto",
    severity: "standard",
    subjects: AGENT_AND_BOT,
    fix: { action: "create_test_task", label: "Create test task" },
  },
  {
    id: "tests.heartbeat_run",
    level: 3,
    title: "Test task ran through heartbeat",
    description: "The readiness test task has at least one heartbeat run, not a manual chat reply.",
    kind: "auto",
    severity: "standard",
    subjects: AGENT_AND_BOT,
    deepLink: { label: "Open runs", path: "/agents/{agentId}/runs" },
  },
  {
    id: "tests.pass_rate",
    level: 3,
    title: "Readiness test passes repeatedly",
    description: "The readiness test task has at least two heartbeat runs and an 80% success rate.",
    kind: "auto",
    severity: "standard",
    subjects: AGENT_AND_BOT,
    deepLink: { label: "Open runs", path: "/agents/{agentId}/runs" },
  },
  {
    id: "tests.reviewed",
    level: 3,
    title: "Test task went through review",
    description: "The test task was approved in review, left its required run comment, and no completion contract rejected it.",
    kind: "auto",
    severity: "standard",
    subjects: AGENT_AND_BOT,
    deepLink: { label: "Open runs", path: "/agents/{agentId}/runs" },
  },
  {
    id: "tests.no_real_clients",
    level: 3,
    title: "Tests never touch real clients, accounts or money",
    description: "A person confirmed that test tasks use fixtures, never live client data or payments.",
    kind: "manual",
    severity: "must_pass",
    subjects: AGENT_AND_BOT,
  },
  {
    id: "tests.smoke_lab",
    level: 3,
    title: "Smoke Lab has a recent run",
    description: "Smoke Lab is enabled and has recorded a company run in the last seven days.",
    kind: "auto",
    severity: "standard",
    subjects: AGENT_AND_BOT,
    deepLink: { label: "Open Smoke Lab", path: "/apps" },
  },

  // Level 4 — skills and tools
  {
    id: "skills.desired",
    level: 4,
    title: "Agent has desired skills",
    description: "At least one company skill is selected for this agent.",
    kind: "auto",
    severity: "standard",
    subjects: AGENT_AND_BOT,
    deepLink: { label: "Open skills", path: "/agents/{agentId}/identity" },
  },
  {
    id: "tools.health",
    level: 4,
    title: "Tool connections are healthy",
    description: "Enabled tool connections this agent can use have no failed or missing-secret health state.",
    kind: "auto",
    severity: "standard",
    subjects: AGENT_AND_BOT,
    deepLink: { label: "Open connectors", path: "/apps" },
  },
  {
    id: "tools.neon_ads_readonly",
    level: 4,
    title: "Neon ads access is read-only",
    description: "Any Neon credential for ad data targets the ads database with a read-only role, never the app database.",
    kind: "auto",
    severity: "standard",
    subjects: AGENT_AND_BOT,
    deepLink: { label: "Open connectors", path: "/apps" },
  },
  {
    id: "skills.tested",
    level: 4,
    title: "Each skill has a test",
    description: "A person confirmed that every skill the agent uses has a tested path.",
    kind: "manual",
    severity: "standard",
    subjects: AGENT_AND_BOT,
  },
  {
    id: "tools.least_privilege",
    level: 4,
    title: "Agent has only the tools it needs",
    description: "A person confirmed the agent's tool grants are the minimum this job needs.",
    kind: "manual",
    severity: "standard",
    subjects: AGENT_AND_BOT,
  },

  // Level 5 — workspace and access
  {
    id: "workspace.environment",
    level: 5,
    title: "Workspace environment resolves",
    description: "The selected environment belongs to this company and exists.",
    kind: "auto",
    severity: "standard",
    subjects: AGENT_AND_BOT,
    deepLink: { label: "Open runtime", path: "/agents/{agentId}/runtime" },
  },
  {
    id: "access.logins",
    level: 5,
    title: "Required logins work",
    description: "A login probe confirmed browser and connector logins. Not checked until a real login probe exists.",
    kind: "live",
    severity: "must_pass",
    subjects: AGENT_AND_BOT,
    fix: { action: "run_probe", label: "Run live probe" },
    deepLink: { label: "Open credentials", path: "/agents/{agentId}/identity" },
  },
  {
    id: "access.sandbox",
    level: 5,
    title: "Sandbox can start",
    description: "A sandbox environment selected by the agent resolves to a runnable environment.",
    kind: "auto",
    severity: "standard",
    subjects: AGENT_AND_BOT,
    deepLink: { label: "Open runtime", path: "/agents/{agentId}/runtime" },
  },
  {
    id: "workspace.setup",
    level: 5,
    title: "New agent setup is one step",
    description: "A person confirmed that creating an agent with this setup needs no undocumented manual steps.",
    kind: "manual",
    severity: "standard",
    subjects: AGENT_AND_BOT,
  },

  // Level 6 — run visibility
  {
    id: "runs.recent",
    level: 6,
    title: "Recent runs are readable",
    description: "The agent has recorded runs and at least 80% of its last 20 runs succeeded.",
    kind: "auto",
    severity: "standard",
    subjects: AGENT_AND_BOT,
    deepLink: { label: "Open runs", path: "/agents/{agentId}/runs" },
  },
  {
    id: "runs.no_stuck",
    level: 6,
    title: "No stuck runs",
    description: "No run has stayed in a running state for more than an hour.",
    kind: "auto",
    severity: "standard",
    subjects: AGENT_AND_BOT,
    fix: { action: "pause_agent", label: "Pause agent" },
    deepLink: { label: "Open runs", path: "/agents/{agentId}/runs" },
  },
  {
    id: "runs.failure_issue",
    level: 6,
    title: "Failures file a task",
    description: "A person confirmed failed runs with an actionable error produce a task with the error and run link.",
    kind: "manual",
    severity: "standard",
    subjects: AGENT_AND_BOT,
  },
  {
    id: "runs.no_secrets",
    level: 6,
    title: "No keys or personal data in logs",
    description: "A person confirmed run logs and activity entries contain no keys or personal data.",
    kind: "manual",
    severity: "standard",
    subjects: AGENT_AND_BOT,
  },

  // Level 7 — permissions and secrets
  {
    id: "permissions.approval_policy",
    level: 7,
    title: "Risky actions need approval",
    description: "An enabled tool policy requires approval for spend, send and delete actions.",
    kind: "auto",
    severity: "must_pass",
    subjects: AGENT_AND_BOT,
    deepLink: { label: "Open approvals", path: "/company/settings" },
  },
  {
    id: "permissions.budget",
    level: 7,
    title: "Budget cap is set",
    description: "The agent has a monthly budget or an active budget policy.",
    kind: "auto",
    severity: "standard",
    subjects: AGENT_AND_BOT,
    deepLink: { label: "Open budget", path: "/agents/{agentId}/budget" },
  },
  {
    id: "permissions.vault_secrets",
    level: 7,
    title: "Secrets come from the vault",
    description: "No plaintext environment value and no credential in any instruction file.",
    kind: "auto",
    severity: "must_pass",
    subjects: AGENT_AND_BOT,
    deepLink: { label: "Open secrets", path: "/company/settings/secrets" },
  },
  {
    id: "permissions.owner",
    level: 7,
    title: "An owner approves changes",
    description: "A person confirmed this agent has a named owner who approves configuration changes.",
    kind: "manual",
    severity: "standard",
    subjects: AGENT_AND_BOT,
  },

  // Level 8 — task intake and routing
  {
    id: "intake.manager",
    level: 8,
    title: "Reporting line is set",
    description: "The agent reports to a manager, is the only agent, or leads the company.",
    kind: "auto",
    severity: "standard",
    subjects: AGENT_AND_BOT,
    deepLink: { label: "Open org chart", path: "/org" },
  },
  {
    id: "intake.description",
    level: 8,
    title: "Role is described",
    description: "The agent has a real role, title or capability summary, not the default \"general\".",
    kind: "auto",
    severity: "standard",
    subjects: AGENT_AND_BOT,
    deepLink: { label: "Open agent", path: "/agents/{agentId}" },
  },
  {
    id: "intake.no_stale_blocked",
    level: 8,
    title: "No stale blocked tasks",
    description: "No task assigned to this agent has stayed blocked for more than 14 days.",
    kind: "auto",
    severity: "standard",
    subjects: AGENT_AND_BOT,
  },
  {
    id: "intake.routing",
    level: 8,
    title: "Routing rules are written",
    description: "A person confirmed that instructions say which kind of task goes to which agent.",
    kind: "manual",
    severity: "standard",
    subjects: AGENT_AND_BOT,
  },
  {
    id: "intake.split",
    level: 8,
    title: "Unclear work is split by owner",
    description: "A person confirmed unclear or cross-team tasks are split into one task per owner.",
    kind: "manual",
    severity: "standard",
    subjects: AGENT_AND_BOT,
  },

  // Level 9 — outcomes and improvement
  {
    id: "outcomes.comparison",
    level: 9,
    title: "Models and prompts can be compared",
    description: "A person confirmed at least one head-to-head comparison has been recorded.",
    kind: "manual",
    severity: "standard",
    subjects: AGENT_AND_BOT,
  },
  {
    id: "outcomes.corrections",
    level: 9,
    title: "The agent learns from corrections",
    description: "A person confirmed corrections become instructions instead of repeating.",
    kind: "manual",
    severity: "standard",
    subjects: AGENT_AND_BOT,
  },
  {
    id: "outcomes.recorded",
    level: 9,
    title: "Before and after a fix is tracked",
    description: "A person confirmed success rate, interventions, cost and time are recorded before and after a fix.",
    kind: "manual",
    severity: "standard",
    subjects: AGENT_AND_BOT,
  },

  // Level 10 — memory
  {
    id: "memory.hindsight_removed",
    level: 10,
    title: "Hindsight is removed from instructions",
    description: "No instruction file references the retired Hindsight memory system.",
    kind: "auto",
    severity: "standard",
    subjects: AGENT_AND_BOT,
    deepLink: { label: "Review instructions", path: "/agents/{agentId}/identity" },
  },
  {
    id: "memory.gbrain_connected",
    level: 10,
    title: "GBrain is attached",
    description: "The agent has the GBrain MCP connector (or its Hermes profile config names the GBrain MCP server).",
    kind: "auto",
    severity: "must_pass",
    subjects: AGENT_AND_BOT,
    deepLink: { label: "Open connectors", path: "/apps" },
  },
  {
    id: "memory.honcho",
    level: 10,
    title: "Honcho is connected and tested",
    description: "A person confirmed Honcho is connected and this agent is set up in it.",
    kind: "manual",
    severity: "standard",
    subjects: AGENT_AND_BOT,
  },
  {
    id: "memory.corrections",
    level: 10,
    title: "Corrections are saved back to memory",
    description: "A person confirmed corrections made in a task are written back to memory.",
    kind: "manual",
    severity: "standard",
    subjects: AGENT_AND_BOT,
  },

  // Level 11 — orchestration
  {
    id: "orchestration.policy",
    level: 11,
    title: "Lead policy is tested",
    description: "A person confirmed the lead delegates worker tasks and keeps priorities, approvals and hiring.",
    kind: "manual",
    severity: "standard",
    subjects: AGENT_AND_BOT,
  },
  {
    id: "orchestration.handoffs",
    level: 11,
    title: "Hand-offs carry objective, owner and acceptance",
    description: "A person confirmed delegated tasks carry objective, owner, output format, sources, boundaries and acceptance criteria.",
    kind: "manual",
    severity: "standard",
    subjects: AGENT_AND_BOT,
  },
  {
    id: "orchestration.follow_through",
    level: 11,
    title: "Lead follows through and reviews",
    description: "A person confirmed the lead waits for wake-ups, checks stale tasks and reviews subtasks before closing the parent.",
    kind: "manual",
    severity: "standard",
    subjects: AGENT_AND_BOT,
  },

  // Level 12 — Hermes bots (Grok twins)
  {
    id: "bot.hermes_twin",
    level: 12,
    title: "Bot is a Hermes twin",
    description: "The agent was hired from the grok-bot-twin plugin and is tagged as a bot in metadata.",
    kind: "auto",
    severity: "standard",
    subjects: ["bot"],
    deepLink: { label: "Open agent", path: "/agents/{agentId}" },
  },
  {
    id: "bot.twin_profile",
    level: 12,
    title: "Twin runs on a Hermes profile",
    description: "The twin's Hermes profile is selected and its toolset includes `mcp`.",
    kind: "auto",
    severity: "standard",
    subjects: ["bot"],
    deepLink: { label: "Open runtime", path: "/agents/{agentId}/runtime" },
  },
  {
    id: "bot.twin_verified",
    level: 12,
    title: "Twin answers",
    description: "A live probe reached the twin's Hermes profile through its adapter.",
    kind: "live",
    severity: "standard",
    subjects: ["bot"],
    fix: { action: "run_probe", label: "Run live probe" },
    deepLink: { label: "Open runtime", path: "/agents/{agentId}/runtime" },
  },
  {
    id: "bot.unmetered",
    level: 12,
    title: "Unmetered provider cost is acknowledged",
    description: "A person acknowledged that the twin's provider usage is billed outside Paperclip.",
    kind: "manual",
    severity: "standard",
    subjects: ["bot"],
    deepLink: { label: "Open runtime", path: "/agents/{agentId}/runtime" },
  },

  // Level 13 — company operations
  {
    id: "company.smoke_lab",
    level: 13,
    title: "Smoke Lab daily routine is on",
    description: "Smoke Lab is enabled and has recorded a recent run for this company.",
    kind: "auto",
    severity: "standard",
    subjects: ["company"],
    deepLink: { label: "Open Smoke Lab", path: "/apps" },
  },
  {
    id: "company.tool_health",
    level: 13,
    title: "Company tool connections are healthy",
    description: "Enabled tool connections have no failed or missing-secret health state.",
    kind: "auto",
    severity: "standard",
    subjects: ["company"],
    deepLink: { label: "Open connectors", path: "/apps" },
  },
  {
    id: "company.approval_policy",
    level: 13,
    title: "Company approval policy is set",
    description: "The company requires approval for risky tool actions or for new agents.",
    kind: "auto",
    severity: "standard",
    subjects: ["company"],
    deepLink: { label: "Open company settings", path: "/company/settings" },
  },
  {
    id: "company.secrets",
    level: 13,
    title: "Company secrets live in the vault",
    description: "No agent in this company stores a plaintext environment value and no instruction file holds a credential.",
    kind: "auto",
    severity: "standard",
    subjects: ["company"],
    deepLink: { label: "Open secrets", path: "/company/settings/secrets" },
  },
  {
    id: "company.gbrain",
    level: 13,
    title: "Company GBrain connector is healthy",
    description: "The company has a GBrain MCP connector and it is enabled and healthy.",
    kind: "auto",
    severity: "must_pass",
    subjects: ["company"],
    deepLink: { label: "Open connectors", path: "/apps" },
  },
  {
    id: "company.neon_app_db",
    level: 13,
    title: "Application database is Neon",
    description: "Paperclip runs on Neon with a direct migration URL and prepared statements disabled.",
    kind: "auto",
    severity: "standard",
    subjects: ["company"],
    deepLink: { label: "Open settings", path: "/company/settings" },
  },
  {
    id: "company.backups",
    level: 13,
    title: "Database and storage backups are verified",
    description: "A person confirmed the company database and storage can be restored.",
    kind: "manual",
    severity: "standard",
    subjects: ["company"],
  },
] as const;

const CHECKS_BY_ID = new Map(AGENT_READINESS_CHECKS.map((check) => [check.id, check]));

export function agentReadinessCheck(checkId: string): AgentReadinessCheckDefinition | null {
  return CHECKS_BY_ID.get(checkId) ?? null;
}

export function agentReadinessLevelName(level: number): string {
  return AGENT_READINESS_LEVELS.find((entry) => entry.level === level)?.name ?? `Level ${level}`;
}

export interface ScorableReadinessCheck {
  checkId?: string;
  level: number;
  kind: AgentReadinessCheckKind;
  severity: AgentReadinessSeverity;
  status: AgentReadinessCheckStatus;
}

export interface AgentReadinessLevelResult {
  level: number;
  name: string;
  status: AgentReadinessLevelStatus;
  passed: number;
  applicable: number;
  passRate: number;
  mustPassFailed: boolean;
  notChecked: number;
}

export interface AgentReadinessSubjectSummary {
  subjectType: AgentReadinessSubjectType;
  subjectId: string;
  name: string;
  provider: string | null;
  status: AgentReadinessSubjectStatus;
  levels: AgentReadinessLevelResult[];
}

export interface AgentReadinessSummary {
  status: AgentReadinessSubjectStatus;
  subjectCounts: Record<AgentReadinessSubjectStatus, number>;
  subjectCount: number;
  levels: AgentReadinessLevelResult[];
  subjects: AgentReadinessSubjectSummary[];
}

export interface AgentReadinessFinding {
  checkId: string;
  level: number;
  title: string;
  description: string;
  kind: AgentReadinessCheckKind;
  severity: AgentReadinessSeverity;
  subjectType: AgentReadinessSubjectType;
  subjectId: string;
  subjectName: string;
  provider: string | null;
  status: AgentReadinessCheckStatus;
  message: string;
  evidence: Record<string, unknown> | null;
  checkedAt: string;
  fix: AgentReadinessFix | null;
  deepLink: AgentReadinessDeepLink | null;
}

export interface AgentReadinessReport {
  id: string | null;
  companyId: string;
  status: "running" | "complete" | "failed";
  includeLive: boolean;
  summary: AgentReadinessSummary;
  findings: AgentReadinessFinding[];
  requestedByUserId: string | null;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface AgentReadinessAttestation {
  id: string;
  companyId: string;
  subjectType: AgentReadinessSubjectType;
  subjectId: string;
  checkId: string;
  note: string | null;
  attestedByUserId: string;
  attestedAt: string;
}

export interface AgentReadinessFixResult {
  applied: boolean;
  action: AgentReadinessFixAction;
  message: string;
  finding: AgentReadinessFinding | null;
  /** The re-evaluated report so the page can refresh without a second request. */
  report: AgentReadinessReport;
}

const PASS_RATE_THRESHOLD = 0.8;

/** A level is cleared at 80%, unless any must-pass check failed. */
export function scoreReadinessLevel(
  level: number,
  checks: readonly ScorableReadinessCheck[],
): AgentReadinessLevelResult {
  const levelChecks = checks.filter((check) => check.level === level && check.status !== "skipped");
  const name = agentReadinessLevelName(level);
  if (levelChecks.length === 0) {
    return {
      level,
      name,
      status: "skipped",
      passed: 0,
      applicable: 0,
      passRate: 1,
      mustPassFailed: false,
      notChecked: 0,
    };
  }
  // Not-checked work is a gap, not a failure: it never counts as a pass, but a
  // person who has not answered a manual box has not failed the level yet. The
  // 80% rate runs over checks that were actually evaluated, and any remaining
  // not-checked box caps the level (and its subject) at Unverified.
  const evaluated = levelChecks.filter((check) => check.status !== "not_checked");
  const passed = evaluated.filter((check) => check.status === "pass").length;
  const mustPassFailed = levelChecks.some(
    (check) => check.severity === "must_pass" && check.status === "fail",
  );
  const notChecked = levelChecks.filter((check) => check.status === "not_checked").length;
  const passRate = evaluated.length === 0 ? 0 : passed / evaluated.length;
  const status: AgentReadinessLevelStatus = mustPassFailed
    || (evaluated.length > 0 && passRate < PASS_RATE_THRESHOLD)
    ? "fail"
    : notChecked > 0 || evaluated.length === 0
      ? "unverified"
      : "pass";
  return { level, name, status, passed, applicable: evaluated.length, passRate, mustPassFailed, notChecked };
}

/** Overall subject status: blocked, attention, unverified, then ready. */
export function scoreReadinessSubjectStatus(
  levels: readonly AgentReadinessLevelResult[],
): AgentReadinessSubjectStatus {
  const active = levels.filter((level) => level.status !== "skipped");
  if (active.some((level) => level.status === "fail" && level.mustPassFailed)) return "blocked";
  if (active.some((level) => level.status === "fail")) return "attention";
  if (active.some((level) => level.status === "unverified")) return "unverified";
  return "ready";
}

export function scoreReadinessSubject(
  subject: Pick<AgentReadinessSubjectSummary, "subjectType" | "subjectId" | "name" | "provider">,
  checks: readonly ScorableReadinessCheck[],
): AgentReadinessSubjectSummary {
  const levels = AGENT_READINESS_LEVELS.map(({ level }) => scoreReadinessLevel(level, checks));
  return {
    ...subject,
    status: scoreReadinessSubjectStatus(levels),
    levels,
  };
}

/** Aggregate the same rubric across every subject for the header level list. */
export function summarizeAgentReadiness(
  subjects: readonly AgentReadinessSubjectSummary[],
  checks: readonly ScorableReadinessCheck[],
): AgentReadinessSummary {
  const subjectCounts: Record<AgentReadinessSubjectStatus, number> = {
    ready: 0,
    attention: 0,
    blocked: 0,
    unverified: 0,
  };
  for (const subject of subjects) subjectCounts[subject.status] += 1;
  return {
    status: scoreReadinessSubjectStatus(AGENT_READINESS_LEVELS.map(({ level }) => scoreReadinessLevel(level, checks))),
    subjectCounts,
    subjectCount: subjects.length,
    levels: AGENT_READINESS_LEVELS.map(({ level }) => scoreReadinessLevel(level, checks)),
    subjects: [...subjects],
  };
}

export const runAgentReadinessReportSchema = z.object({
  includeLive: z.boolean().default(false),
}).strict();

export const agentReadinessFixSchema = z.object({
  reportId: z.string().uuid().nullish(),
  subjectType: z.enum(AGENT_READINESS_SUBJECT_TYPES),
  subjectId: z.string().trim().min(1).max(200),
  checkId: z.string().trim().min(1).max(200),
  action: z.enum(AGENT_READINESS_FIX_ACTIONS),
  confirm: z.literal(true),
}).strict();

export const upsertAgentReadinessAttestationSchema = z.object({
  subjectType: z.enum(AGENT_READINESS_SUBJECT_TYPES),
  subjectId: z.string().trim().min(1).max(200),
  checkId: z.string().trim().min(1).max(200),
  // A manual box passes only on a person's word: the note is what they checked,
  // and an empty attestation would turn an unverified level green silently.
  note: z.string().trim().min(1, "Say what you checked").max(2000),
}).strict().superRefine((value, ctx) => {
  const check = agentReadinessCheck(value.checkId);
  if (!check) {
    ctx.addIssue({ code: "custom", message: "Unknown readiness check", path: ["checkId"] });
    return;
  }
  if (check.kind !== "manual") {
    ctx.addIssue({ code: "custom", message: "Only manual checks can be attested", path: ["checkId"] });
  }
  if (!check.subjects.includes(value.subjectType)) {
    ctx.addIssue({ code: "custom", message: "This check does not apply to that subject", path: ["subjectType"] });
  }
});
