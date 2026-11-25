import type {
  Agent,
  DashboardBoard,
  DashboardFulfillmentBoard,
  DashboardSummary,
  Issue,
  Project,
} from "@paperclipai/shared";
import { AGENT_ROLE_LABELS } from "@paperclipai/shared";
import type { DashboardBoardWithMeta } from "@/api/dashboardBoards";
import { formatTileValue } from "@/components/dashboards/lane2-shared/formatTileValue";
import { formatCents } from "@/lib/utils";

export type TeamHubKey = "marketing" | "sales" | "fulfillment" | "operations";

export const OPEN_TASK_STATUS_FILTER = "backlog,todo,in_progress,in_review,blocked";

export interface TeamHubConfig {
  key: TeamHubKey;
  label: string;
  description: string;
  dashboardHref: string;
  dashboardLabel: string;
}

export interface HeadlineKpi {
  id: string;
  label: string;
  value: string;
  detail: string;
  tone?: "default" | "warning" | "muted";
}

export interface HumanTeamMemberRow {
  id: string;
  name: string;
  role: string;
  status: string;
  duties: string;
  judgedOn: string;
  judgedOnMissing: boolean;
  isOwner: boolean;
}

export const TEAM_HUB_CONFIGS: readonly TeamHubConfig[] = [
  {
    key: "marketing",
    label: "Marketing",
    description: "Ad spend, lead flow, creative production, and campaign audits across client accounts.",
    dashboardHref: "/dashboard/marketing",
    dashboardLabel: "Open full Marketing Dashboard",
  },
  {
    key: "sales",
    label: "Sales",
    description: "Outbound dialing, appointment setting, call follow-ups, and pipeline conversion.",
    dashboardHref: "/dashboard/sales",
    dashboardLabel: "Open full Sales Dashboard",
  },
  {
    key: "fulfillment",
    label: "Fulfillment",
    description: "Client onboarding, account delivery, retention, websites, funnels, and client support.",
    dashboardHref: "/dashboard/fulfillment",
    dashboardLabel: "Open full Fulfillment Dashboard",
  },
  {
    key: "operations",
    label: "Operations",
    description: "Executive orchestration, engineering, QA review, runtime spend, and board approvals.",
    dashboardHref: "/dashboard/operations",
    dashboardLabel: "Open full Operations Dashboard",
  },
] as const;

const TEAM_CONFIG_BY_KEY = new Map<string, TeamHubConfig>(
  TEAM_HUB_CONFIGS.map((config) => [config.key, config]),
);

const TEAM_ALIAS_MAP: Record<string, TeamHubKey> = {
  marketing: "marketing",
  growth: "marketing",
  ads: "marketing",
  media: "marketing",
  creative: "marketing",
  sales: "sales",
  setter: "sales",
  setters: "sales",
  outbound: "sales",
  fulfillment: "fulfillment",
  delivery: "fulfillment",
  onboarding: "fulfillment",
  support: "fulfillment",
  csm: "fulfillment",
  "client-success": "fulfillment",
  "customer-success": "fulfillment",
  operations: "operations",
  ops: "operations",
  engineering: "operations",
  executive: "operations",
  admin: "operations",
};

const AGENT_SALES_RE =
  /\b(sales|setter|closer|outbound|outreach|pipeline|dialer|wavv|sdr|bdr)\b/i;
const AGENT_FULFILLMENT_RE =
  /\b(fulfillment|client[\s-]+success|customer[\s-]+success|client[\s-]+support|support[\s-]+desk|csm|onboarding|web[\s-]+builder|website[\s-]+builder|funnel[\s-]+builder|funnel|account[\s-]+manager|retention)\b/i;
const AGENT_MARKETING_RE =
  /\b(marketing|media[\s-]+buy\w*|paid[\s-]+media|ad[\s-]+ops|meta[\s-]+ads?(?:[\s-]+manager)?|google[\s-]+ads?(?:[\s-]+manager)?|ads?[\s-]+auditor|ads?[\s-]+checker|ad[\s-]+creative|video[\s-]+editor|copywriter|creative|seo|social[\s-]+media|content|growth(?:[\s-]+lead)?|research[\s-]+analyst|researcher|cmo)\b/i;
const AGENT_OPS_RE =
  /\b(ceo|cto|coo|cfo|javar|operations|ops|repo[\s-]+engineer|engineer|reviewer|qa|devops|upkeep|scribe|security|finance|legal|admin)\b/i;

const HUMAN_SALES_RE =
  /\b(setter|closer|sales|sdr|bdr|outbound|appointment[\s-]+setter)\b/i;
const HUMAN_FULFILLMENT_RE =
  /\b(fulfillment|csm|customer[\s-]+success|customer[\s-]+calls|client[\s-]+success|client[\s-]+support|support|onboarding|account[\s-]+manager|delivery|web[\s-]+builder|funnel[\s-]+builder)\b/i;
const HUMAN_MARKETING_RE =
  /\b(media[\s-]+buy\w*|paid[\s-]+media|video[\s-]+editor|ad[\s-]+creative|ads?[\s-]+manager|ads?[\s-]+specialist|creative|copywriter|seo|marketing|social[\s-]+media|designer)\b/i;
const HUMAN_OPS_RE =
  /\b(owner|partner|founder|ceo|coo|cfo|cto|operations|ops|admin|finance|bookkeeper|accountant|engineer|hr|executive)\b/i;

const ISSUE_SALES_RE =
  /\b(sales|setter|closer|wavv|dialer|outbound|call[\s-]+script|eod[\s-]+survey|pipeline)\b/i;
const ISSUE_MARKETING_RE =
  /\b(marketing|meta[\s-]+ads?|google[\s-]+ads?|ads?[\s-]+audit|ad[\s-]+account|ad[\s-]+spend|media[\s-]+buy\w*|pixel|capi|conversion[\s-]+tracking|cpl|cac|roas|ctr|creative|video[\s-]+ad|campaign)\b/i;
const ISSUE_FULFILLMENT_RE =
  /\b(fulfillment|onboarding|client[\s-]+support|customer[\s-]+success|churn|retention|landing[\s-]+page|funnel)\b/i;
const ISSUE_OPS_RE =
  /\b(operations|paperclip|ci\b|deploy|gateway|vps|cron|heartbeat|infra|pr\b|(?:security|code|infra|repo|ci)[\s-]+audit)\b/i;

const PROJECT_FULFILLMENT_RE =
  /\b(fulfillment|onboarding|client[\s-]+support|customer[\s-]+success|retention|delivery)\b/i;
const PROJECT_SALES_RE = /\b(sales|setter|outbound|pipeline|dialer|wavv)\b/i;
const PROJECT_MARKETING_RE = /\b(marketing|ads?|media[\s-]+buy\w*|creative|campaign|growth)\b/i;
const PROJECT_OPS_RE = /\b(operations|ops|infra|engineering|platform)\b/i;

const OPEN_TASK_STATUS_ORDER: Record<string, number> = {
  in_progress: 0,
  in_review: 1,
  blocked: 2,
  todo: 3,
  backlog: 4,
};

const AGENT_STATUS_ORDER: Record<string, number> = {
  running: 0,
  active: 1,
  idle: 2,
  pending_approval: 3,
  paused: 4,
  error: 5,
};

const AGENT_ROLE_LABEL_MAP = AGENT_ROLE_LABELS as Record<string, string>;

export function getTeamHubConfig(key: string | undefined): TeamHubConfig | null {
  if (!key) return null;
  return TEAM_CONFIG_BY_KEY.get(key.trim().toLowerCase()) ?? null;
}

export function teamHubHref(companyPrefix: string | null | undefined, teamKey: TeamHubKey): string {
  const cleanPrefix = companyPrefix?.trim().toUpperCase();
  return cleanPrefix ? `/${cleanPrefix}/teams/${teamKey}` : `/teams/${teamKey}`;
}

export function isTeamHubActive(pathname: string, teamKey: string): boolean {
  const cleanPath = pathname.replace(/\/+$/, "").toLowerCase();
  const match = cleanPath.match(/^(?:\/[^/]+)?\/teams\/([^/]+)$/);
  return match?.[1] === teamKey.trim().toLowerCase();
}

export function normalizeTeamAlias(raw: string | null | undefined): TeamHubKey | null {
  if (!raw) return null;
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/^(?:team|dept|department):\s*/, "")
    .replace(/[\s_]+/g, "-");
  return TEAM_ALIAS_MAP[cleaned] ?? null;
}

function collectMetadataTeamKeys(metadata: Record<string, unknown> | null | undefined): TeamHubKey[] {
  if (!metadata) return [];
  const found = new Set<TeamHubKey>();
  const candidates: unknown[] = [
    metadata.department,
    metadata.team,
    metadata.departments,
    metadata.teams,
    metadata.tags,
  ];
  for (const item of candidates) {
    if (typeof item === "string") {
      const normalized = normalizeTeamAlias(item);
      if (normalized) found.add(normalized);
    } else if (Array.isArray(item)) {
      for (const entry of item) {
        if (typeof entry !== "string") continue;
        const normalized = normalizeTeamAlias(entry);
        if (normalized) found.add(normalized);
      }
    }
  }
  return [...found];
}

function classifyAgentText(text: string): TeamHubKey | null {
  if (!text.trim()) return null;
  if (AGENT_SALES_RE.test(text)) return "sales";
  if (AGENT_FULFILLMENT_RE.test(text)) return "fulfillment";
  if (AGENT_MARKETING_RE.test(text)) return "marketing";
  if (AGENT_OPS_RE.test(text)) return "operations";
  return null;
}

function classifyAgentRole(role: string): TeamHubKey | null {
  switch (role) {
    case "cmo":
    case "researcher":
    case "designer":
      return "marketing";
    case "ceo":
    case "cto":
    case "cfo":
    case "engineer":
    case "qa":
    case "devops":
    case "security":
    case "pm":
      return "operations";
    default:
      return null;
  }
}

export function matchAgentTeams(agent: Agent): TeamHubKey[] {
  const explicit = collectMetadataTeamKeys(agent.metadata);
  if (explicit.length > 0) return explicit;

  const identityText = [agent.name, agent.urlKey, agent.title ?? ""].join(" ");
  const fromIdentity = classifyAgentText(identityText);
  if (fromIdentity) return [fromIdentity];

  const fromRole = classifyAgentRole(agent.role);
  if (fromRole) return [fromRole];

  const fromCapabilities = classifyAgentText(agent.capabilities ?? "");
  return fromCapabilities ? [fromCapabilities] : [];
}

export function filterAgentsForTeam(agents: readonly Agent[], teamKey: TeamHubKey): Agent[] {
  return agents
    .filter((agent) => agent.status !== "terminated" && matchAgentTeams(agent).includes(teamKey))
    .sort((a, b) => {
      const rankDiff = (AGENT_STATUS_ORDER[a.status] ?? 9) - (AGENT_STATUS_ORDER[b.status] ?? 9);
      if (rankDiff !== 0) return rankDiff;
      return a.name.localeCompare(b.name);
    });
}

export function formatTeamAgentSubtitle(role: string, title?: string | null): string {
  const roleLabel = (AGENT_ROLE_LABEL_MAP[role] ?? role).trim();
  const cleanTitle = title?.trim() ?? "";
  if (!cleanTitle) return roleLabel;
  if (cleanTitle.toLowerCase() === roleLabel.toLowerCase()) return roleLabel;
  return `${roleLabel} · ${cleanTitle}`;
}

export function isOpenTask(issue: Issue): boolean {
  return issue.status !== "done" && issue.status !== "cancelled";
}

function taskTimestamp(issue: Issue): number {
  const parsed = new Date(issue.updatedAt).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function isHigherPriorityTask(
  candidateRank: number,
  candidateTs: number,
  currentRank: number,
  currentTs: number,
): boolean {
  if (candidateRank !== currentRank) return candidateRank < currentRank;
  return candidateTs > currentTs;
}

/**
 * Single O(issues) pass building a lookup map from agent ID to its highest-priority
 * open task (in_progress -> in_review -> blocked -> todo -> backlog, tie-broken by
 * most recently updated). Avoids O(agents * issues) sorting during render.
 */
export function buildAgentCurrentTaskMap(issues: readonly Issue[]): Map<string, Issue> {
  const bestByAgent = new Map<string, { issue: Issue; rank: number; ts: number }>();
  for (const issue of issues) {
    if (!issue.assigneeAgentId || !isOpenTask(issue)) continue;
    const rank = OPEN_TASK_STATUS_ORDER[issue.status] ?? 9;
    const ts = taskTimestamp(issue);
    const existing = bestByAgent.get(issue.assigneeAgentId);
    if (!existing || isHigherPriorityTask(rank, ts, existing.rank, existing.ts)) {
      bestByAgent.set(issue.assigneeAgentId, { issue, rank, ts });
    }
  }
  const result = new Map<string, Issue>();
  for (const [agentId, entry] of bestByAgent) {
    result.set(agentId, entry.issue);
  }
  return result;
}

function matchTitleTag(title: string): TeamHubKey | null {
  const bracketMatch = title.match(/^\s*\[([^\]]+)\]/);
  if (!bracketMatch?.[1]) return null;
  return normalizeTeamAlias(bracketMatch[1]);
}

function classifyProjectTeam(name: string | null | undefined): TeamHubKey | null {
  if (!name?.trim()) return null;
  const exact = normalizeTeamAlias(name);
  if (exact) return exact;
  if (PROJECT_FULFILLMENT_RE.test(name)) return "fulfillment";
  if (PROJECT_SALES_RE.test(name)) return "sales";
  if (PROJECT_MARKETING_RE.test(name)) return "marketing";
  if (PROJECT_OPS_RE.test(name)) return "operations";
  return null;
}

function classifyIssueTitle(title: string): TeamHubKey | null {
  if (ISSUE_SALES_RE.test(title)) return "sales";
  if (ISSUE_MARKETING_RE.test(title)) return "marketing";
  if (ISSUE_FULFILLMENT_RE.test(title)) return "fulfillment";
  if (ISSUE_OPS_RE.test(title)) return "operations";
  return null;
}

export function matchIssueTeams(
  issue: Issue,
  projectsById: ReadonlyMap<string, Project>,
  agentsById: ReadonlyMap<string, Agent>,
): TeamHubKey[] {
  const fromBracket = matchTitleTag(issue.title);
  if (fromBracket) return [fromBracket];

  if (issue.projectId) {
    const project = projectsById.get(issue.projectId);
    const fromProject = classifyProjectTeam(project?.name);
    if (fromProject) return [fromProject];
  }

  const labelTeams = new Set<TeamHubKey>();
  for (const label of issue.labels ?? []) {
    const fromLabel = normalizeTeamAlias(label.name);
    if (fromLabel) labelTeams.add(fromLabel);
  }
  if (labelTeams.size > 0) return [...labelTeams];

  const assignee = issue.assigneeAgentId ? agentsById.get(issue.assigneeAgentId) : undefined;
  const assigneeTeams = assignee && assignee.role !== "ceo" ? matchAgentTeams(assignee) : [];
  if (assigneeTeams.length === 1) return assigneeTeams;

  const fromTitle = classifyIssueTitle(issue.title);
  if (fromTitle) return [fromTitle];

  if (assigneeTeams.length > 1) return assigneeTeams;
  if (assignee?.role === "ceo") return ["operations"];
  return [];
}

export function filterTeamActiveTasks(
  issues: readonly Issue[],
  teamKey: TeamHubKey,
  projects: readonly Project[],
  agents: readonly Agent[],
): Issue[] {
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const decorated: Array<{ issue: Issue; rank: number; ts: number }> = [];
  for (const issue of issues) {
    if (!isOpenTask(issue)) continue;
    if (!matchIssueTeams(issue, projectsById, agentsById).includes(teamKey)) continue;
    decorated.push({
      issue,
      rank: OPEN_TASK_STATUS_ORDER[issue.status] ?? 9,
      ts: taskTimestamp(issue),
    });
  }
  decorated.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : b.ts - a.ts));
  return decorated.map((entry) => entry.issue);
}

export function findMatchingTeamProject(
  projects: readonly Project[],
  teamKey: TeamHubKey,
): Project | null {
  const config = getTeamHubConfig(teamKey);
  if (!config) return null;
  const target = config.label.toLowerCase();
  return (
    projects.find(
      (project) =>
        !project.archivedAt &&
        project.status !== "cancelled" &&
        project.name.trim().toLowerCase() === target,
    ) ?? null
  );
}

export function isMissingJudgedOn(value: string | null | undefined): boolean {
  if (!value) return true;
  const trimmed = value.trim();
  if (!trimmed) return true;
  return /^NOT SET\b/i.test(trimmed);
}

function classifyHumanText(text: string): TeamHubKey | null {
  if (!text.trim()) return null;
  if (HUMAN_SALES_RE.test(text)) return "sales";
  if (HUMAN_FULFILLMENT_RE.test(text)) return "fulfillment";
  if (HUMAN_MARKETING_RE.test(text)) return "marketing";
  if (HUMAN_OPS_RE.test(text)) return "operations";
  return null;
}

export function matchHumanTeam(role: string, duties: string): TeamHubKey | null {
  return classifyHumanText(role) ?? classifyHumanText(duties);
}

export function isTeamCapitalDisconnected(board: DashboardBoardWithMeta | undefined): boolean {
  if (!board) return false;
  const source = board.sources.find((item) => item.id === "team_capital");
  return Boolean(source && source.status !== "connected");
}

function readRawHumanMembers(board: DashboardBoardWithMeta | undefined): HumanTeamMemberRow[] {
  if (!board) return [];
  const rosterTable = board.tables.find((table) => table.id === "team-roster");
  if (rosterTable && rosterTable.rows.length > 0) {
    return rosterTable.rows.map((row) => {
      const role = String(row.cells.role ?? "");
      const judgedOn = String(row.cells.judgedOn ?? "");
      const status = String(row.cells.status ?? "active");
      return {
        id: row.id,
        name: String(row.cells.name ?? ""),
        role,
        status,
        duties: String(row.cells.duties ?? ""),
        judgedOn,
        judgedOnMissing: isMissingJudgedOn(judgedOn),
        isOwner: /\bowner\b/i.test(role) || /not tracked \(owner\)/i.test(judgedOn),
      };
    });
  }

  if (Array.isArray(board.meta?.members) && board.meta.members.length > 0) {
    return board.meta.members.map((member) => {
      const judgedOn = member.performanceCriteria ?? "";
      return {
        id: member.id,
        name: member.name,
        role: member.role,
        status: member.status,
        duties: member.responsibilities ?? "",
        judgedOn,
        judgedOnMissing: isMissingJudgedOn(judgedOn),
        isOwner: /\bowner\b/i.test(member.role) || /not tracked \(owner\)/i.test(judgedOn),
      };
    });
  }

  return [];
}

export function extractHumanMembersForTeam(
  board: DashboardBoardWithMeta | undefined,
  teamKey: TeamHubKey,
): HumanTeamMemberRow[] {
  return readRawHumanMembers(board)
    .filter((member) => matchHumanTeam(member.role, member.duties) === teamKey)
    .sort((a, b) => {
      const aActive = a.status.toLowerCase() === "active" ? 0 : 1;
      const bActive = b.status.toLowerCase() === "active" ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      return a.name.localeCompare(b.name);
    });
}

function pickLane2Kpis(
  board: DashboardBoard | undefined,
  specs: ReadonlyArray<{ id: string; label: string; detail: string }>,
): HeadlineKpi[] {
  if (!board) return [];
  const byId = new Map(board.tiles.map((tile) => [tile.id, tile]));
  return specs.map((spec) => {
    const tile = byId.get(spec.id);
    if (tile?.value.kind === "live") {
      return {
        id: spec.id,
        label: tile.label || spec.label,
        value: formatTileValue(tile.value),
        detail: spec.detail,
        tone: "default",
      };
    }
    return {
      id: spec.id,
      label: tile?.label || spec.label,
      value: "—",
      detail: "Awaiting live source",
      tone: "muted",
    };
  });
}

export function selectMarketingKpis(board: DashboardBoard | undefined): HeadlineKpi[] {
  return pickLane2Kpis(board, [
    { id: "ad-spend", label: "Ad spend", detail: "Last 30 days · Meta portfolio" },
    { id: "new-leads", label: "New leads", detail: "Last 30 days · GHL portfolio" },
    { id: "cost-per-lead", label: "Cost per lead", detail: "Reference only · last 30 days" },
    { id: "ctr", label: "CTR", detail: "Link clicks ÷ impressions" },
  ]);
}

export function selectSalesKpis(board: DashboardBoard | undefined): HeadlineKpi[] {
  return pickLane2Kpis(board, [
    { id: "dials", label: "Dials", detail: "Last 30 days · WAVV outbound" },
    { id: "conversations-over-60s", label: "Conversations > 60 s", detail: "Connected calls over 60 s" },
    { id: "talk-time", label: "Talk time", detail: "Connected talk time · 30d" },
    { id: "units-sold", label: "Units sold", detail: "Closed jobs · last 30 days" },
  ]);
}

export function selectFulfillmentKpis(board: DashboardFulfillmentBoard | undefined): HeadlineKpi[] {
  if (!board) return [];
  const churn = board.retention.churnMonthly;
  const fourthCard: HeadlineKpi =
    typeof churn.value === "number" && Number.isFinite(churn.value)
      ? {
          id: "churn-monthly",
          label: "Churn, monthly",
          value: `${churn.value}%`,
          detail: `Target ${churn.target}`,
          tone: churn.value >= 3 ? "warning" : "default",
        }
      : {
          id: "unassigned-open-tasks",
          label: "Unassigned open tasks",
          value: String(board.openClientTasks.unassigned),
          detail: "Open tasks without a client project",
          tone: board.openClientTasks.unassigned > 0 ? "warning" : "default",
        };

  return [
    {
      id: "open-client-tasks",
      label: "Open client tasks",
      value: String(board.openClientTasks.total),
      detail: "Open work attached to client projects",
      tone: "default",
    },
    {
      id: "clients-with-open-work",
      label: "Clients with open work",
      value: String(board.clients.length),
      detail: "Active client projects with open tasks",
      tone: "default",
    },
    {
      id: "open-onboarding-steps",
      label: "Open onboarding steps",
      value: String(board.onboarding.openSteps),
      detail: "Onboarding projects & labeled tasks",
      tone: "default",
    },
    fourthCard,
  ];
}

export function selectOperationsKpis(summary: DashboardSummary | undefined): HeadlineKpi[] {
  if (!summary) return [];
  const enabledAgents =
    summary.agents.active +
    summary.agents.running +
    summary.agents.paused +
    summary.agents.error;
  const pendingApprovals = summary.pendingApprovals + summary.budgets.pendingApprovals;

  return [
    {
      id: "agents-enabled",
      label: "Agents enabled",
      value: String(enabledAgents),
      detail: `${summary.agents.running} running · ${summary.agents.error} errors`,
      tone: summary.agents.error > 0 ? "warning" : "default",
    },
    {
      id: "tasks-in-progress",
      label: "Tasks in progress",
      value: String(summary.tasks.inProgress),
      detail: `${summary.tasks.open} open · ${summary.tasks.blocked} blocked`,
      tone: summary.tasks.blocked > 0 ? "warning" : "default",
    },
    {
      id: "month-spend",
      label: "Month AI spend",
      value: formatCents(summary.costs.monthSpendCents),
      detail:
        summary.costs.monthBudgetCents > 0
          ? `${summary.costs.monthUtilizationPercent}% of ${formatCents(summary.costs.monthBudgetCents)} budget`
          : "Unlimited budget",
      tone: summary.costs.monthUtilizationPercent >= 90 ? "warning" : "default",
    },
    {
      id: "pending-approvals",
      label: "Pending approvals",
      value: String(pendingApprovals),
      detail:
        summary.budgets.pendingApprovals > 0
          ? `${summary.budgets.pendingApprovals} budget overrides awaiting review`
          : "Awaiting board review",
      tone: pendingApprovals > 0 ? "warning" : "default",
    },
  ];
}
