import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowRight,
  Bot,
  CircleCheck,
  ExternalLink,
  Megaphone,
  MessageSquare,
  Package,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  TrendingUp,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { Agent, Issue, Project } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { dashboardApi } from "@/api/dashboard";
import { dashboardBoardsApi } from "@/api/dashboardBoards";
import { issuesApi } from "@/api/issues";
import { projectsApi } from "@/api/projects";
import { AgentAvatar } from "@/components/AgentAvatar";
import { EmptyState } from "@/components/EmptyState";
import { AgentStatusBadge } from "@/components/StatusBadge";
import { StatusIcon } from "@/components/StatusIcon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useDialogActions } from "@/context/DialogContext";
import { queryKeys } from "@/lib/queryKeys";
import { Link, Navigate, useActiveCompanyPrefix, useParams } from "@/lib/router";
import { taskStatusIconProps } from "@/lib/task-status-presentation";
import { timeAgo } from "@/lib/timeAgo";
import { agentRouteRef, agentUrl, cn } from "@/lib/utils";
import {
  buildAgentCurrentTaskMap,
  extractHumanMembersForTeam,
  filterAgentsForTeam,
  filterTeamActiveTasks,
  findMatchingTeamProject,
  formatTeamAgentSubtitle,
  getTeamHubConfig,
  isTeamCapitalDisconnected,
  OPEN_TASK_STATUS_FILTER,
  selectFulfillmentKpis,
  selectMarketingKpis,
  selectOperationsKpis,
  selectSalesKpis,
  teamHubHref,
  type HeadlineKpi,
  type HumanTeamMemberRow,
  type TeamHubKey,
} from "./teamHubHelpers";

const TEAM_ICONS: Record<TeamHubKey, LucideIcon> = {
  marketing: Megaphone,
  sales: TrendingUp,
  fulfillment: Package,
  operations: SlidersHorizontal,
};

const EMPTY_AGENTS: readonly Agent[] = [];
const EMPTY_ISSUES: readonly Issue[] = [];
const EMPTY_PROJECTS: readonly Project[] = [];
const MAX_VISIBLE_TASKS = 12;
const BOARD_STALE_TIME_MS = 60_000;

function SectionErrorCard({
  message,
  onRetry,
  retrying,
  testId,
}: {
  message: string;
  onRetry: () => void;
  retrying: boolean;
  testId?: string;
}) {
  return (
    <Card
      elevation="low"
      role="alert"
      data-testid={testId}
      className="flex-row flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm text-muted-foreground"
    >
      <div className="flex min-w-0 items-center gap-2">
        <AlertCircle className="size-4 shrink-0 text-destructive" aria-hidden />
        <span>{message}</span>
      </div>
      <Button
        type="button"
        variant="outline"
        size="xs"
        onClick={onRetry}
        disabled={retrying}
      >
        <RefreshCw className={cn("size-3.5", retrying && "animate-spin")} aria-hidden />
        {retrying ? "Retrying…" : "Retry"}
      </Button>
    </Card>
  );
}

function HeadlineKpiStrip({
  kpis,
  isLoading,
  hasError,
  retrying,
  onRetry,
}: {
  kpis: readonly HeadlineKpi[];
  isLoading: boolean;
  hasError: boolean;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <section
      aria-label="Team headline metrics"
      data-testid="team-hub-kpi-strip"
    >
      {isLoading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <Card key={index} elevation="low" className="gap-2 px-4 py-4">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-7 w-28" />
              <Skeleton className="h-3 w-36" />
            </Card>
          ))}
        </div>
      ) : hasError || kpis.length === 0 ? (
        <SectionErrorCard
          message="Live department metrics could not be loaded. Open the full dashboard for source details."
          onRetry={onRetry}
          retrying={retrying}
          testId="team-hub-kpi-error"
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {kpis.map((kpi) => (
            <Card key={kpi.id} elevation="low" className="gap-1.5 px-4 py-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {kpi.label}
              </p>
              <p
                className={cn(
                  "text-2xl font-semibold tabular-nums tracking-tight",
                  kpi.tone === "muted"
                    ? "text-muted-foreground"
                    : kpi.tone === "warning"
                      ? "text-amber-700 dark:text-amber-300"
                      : "text-foreground",
                )}
              >
                {kpi.value}
              </p>
              <p className="text-xs text-muted-foreground">{kpi.detail}</p>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}

function TeamAgentsPanel({
  teamLabel,
  agents,
  currentTaskByAgentId,
  isLoading,
  hasError,
  retrying,
  onRetry,
}: {
  teamLabel: string;
  agents: readonly Agent[];
  currentTaskByAgentId: ReadonlyMap<string, Issue>;
  isLoading: boolean;
  hasError: boolean;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <section
      aria-label="AI Agents on this team"
      data-testid="team-hub-agents"
      className="min-w-0 space-y-3 xl:col-span-7"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            AI Agents
          </h2>
          {!hasError ? (
            <Badge variant="secondary" className="font-mono text-xs tabular-nums">
              {agents.length}
            </Badge>
          ) : null}
        </div>
        <Button variant="outline" size="xs" asChild>
          <Link to="/agents/new">
            <Plus className="size-3.5" aria-hidden />
            Add agent
          </Link>
        </Button>
      </div>

      {isLoading ? (
        <Card elevation="low" className="gap-3 p-4">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </Card>
      ) : hasError ? (
        <SectionErrorCard
          message={`Could not load AI agents for ${teamLabel}.`}
          onRetry={onRetry}
          retrying={retrying}
          testId="team-hub-agents-error"
        />
      ) : agents.length === 0 ? (
        <Card elevation="low" className="items-start gap-3 border-dashed p-5">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Bot className="size-4 text-muted-foreground" aria-hidden />
            <span>No AI agents assigned to {teamLabel} yet</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Create a specialist agent with a {teamLabel.toLowerCase()} role or title, or set{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
              metadata.department = &quot;{teamLabel.toLowerCase()}&quot;
            </code>{" "}
            via the API to route them into this hub.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" asChild>
              <Link to="/agents/new">
                <Plus className="size-3.5" aria-hidden />
                Add agent
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link to="/agents/all">Browse all agents</Link>
            </Button>
          </div>
        </Card>
      ) : (
        <Card elevation="low" className="gap-0 divide-y divide-border overflow-hidden p-0">
          {agents.map((agent) => {
            const currentTask = currentTaskByAgentId.get(agent.id) ?? null;
            const subtitle = formatTeamAgentSubtitle(agent.role, agent.title);
            return (
              <div
                key={agent.id}
                data-testid={`team-agent-row-${agent.urlKey}`}
                className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <AgentAvatar
                    agent={agent}
                    size={32}
                    className="mt-0.5 rounded-full bg-muted/60 ring-1 ring-border/60"
                  />
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        to={agentUrl(agent)}
                        className="truncate text-sm font-medium text-foreground no-underline hover:underline"
                      >
                        {agent.name}
                      </Link>
                      <AgentStatusBadge status={agent.status} />
                    </div>
                    <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
                    {currentTask ? (
                      <Link
                        to={`/issues/${currentTask.identifier ?? currentTask.id}`}
                        title={currentTask.title}
                        className="inline-flex max-w-full items-center gap-1.5 text-xs text-foreground/90 no-underline hover:text-foreground hover:underline"
                      >
                        <StatusIcon {...taskStatusIconProps(currentTask)} />
                        <span className="shrink-0 font-mono text-muted-foreground">
                          {currentTask.identifier ?? currentTask.id.slice(0, 8)}
                        </span>
                        <span className="truncate">{currentTask.title}</span>
                      </Link>
                    ) : (
                      <p className="text-xs text-muted-foreground/80">No active task</p>
                    )}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1.5 self-end sm:self-center">
                  <Button variant="ghost" size="xs" asChild>
                    <Link
                      to={`/chats/${encodeURIComponent(agentRouteRef(agent))}`}
                      aria-label={`Chat with ${agent.name}`}
                    >
                      <MessageSquare className="size-3.5" aria-hidden />
                      Chat
                    </Link>
                  </Button>
                  <Button variant="outline" size="xs" asChild>
                    <Link
                      to={agentUrl(agent)}
                      aria-label={`Inspect ${agent.name}`}
                    >
                      <ExternalLink className="size-3.5" aria-hidden />
                      Inspect
                    </Link>
                  </Button>
                </div>
              </div>
            );
          })}
        </Card>
      )}
    </section>
  );
}

function TeamTasksPanel({
  teamLabel,
  tasks,
  agentsById,
  isLoading,
  hasError,
  retrying,
  onRetry,
  onNewTask,
}: {
  teamLabel: string;
  tasks: readonly Issue[];
  agentsById: ReadonlyMap<string, Agent>;
  isLoading: boolean;
  hasError: boolean;
  retrying: boolean;
  onRetry: () => void;
  onNewTask: () => void;
}) {
  const visibleTasks = tasks.slice(0, MAX_VISIBLE_TASKS);
  const isTruncated = tasks.length > MAX_VISIBLE_TASKS;

  return (
    <section
      aria-label="Active tasks for this team"
      data-testid="team-hub-tasks"
      className="min-w-0 space-y-3 xl:col-span-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Active Tasks
          </h2>
          {!hasError ? (
            <Badge variant="secondary" className="font-mono text-xs tabular-nums">
              {tasks.length}
            </Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="xs" asChild>
            <Link to="/issues">All tasks</Link>
          </Button>
          <Button
            type="button"
            size="xs"
            onClick={onNewTask}
            data-testid="team-hub-new-task"
          >
            <Plus className="size-3.5" aria-hidden />
            New task
          </Button>
        </div>
      </div>

      {isLoading ? (
        <Card elevation="low" className="gap-3 p-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </Card>
      ) : hasError ? (
        <SectionErrorCard
          message={`Could not load active tasks for ${teamLabel}.`}
          onRetry={onRetry}
          retrying={retrying}
          testId="team-hub-tasks-error"
        />
      ) : tasks.length === 0 ? (
        <Card elevation="low" className="items-start gap-3 border-dashed p-5">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <CircleCheck className="size-4 text-muted-foreground" aria-hidden />
            <span>No open {teamLabel.toLowerCase()} tasks</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Create a task tagged for {teamLabel} to queue work for this department.
          </p>
          <Button type="button" variant="outline" size="sm" onClick={onNewTask}>
            <Plus className="size-3.5" aria-hidden />
            New {teamLabel} task
          </Button>
        </Card>
      ) : (
        <Card elevation="low" className="gap-0 divide-y divide-border overflow-hidden p-0">
          {visibleTasks.map((task) => {
            const assignee = task.assigneeAgentId ? agentsById.get(task.assigneeAgentId) : undefined;
            return (
              <Link
                key={task.id}
                to={`/issues/${task.identifier ?? task.id}`}
                data-testid={`team-task-row-${task.identifier ?? task.id}`}
                className="flex items-start gap-2.5 px-4 py-3 text-sm text-inherit no-underline transition-colors hover:bg-accent/50"
              >
                <span className="mt-0.5 flex shrink-0 items-center">
                  <StatusIcon {...taskStatusIconProps(task)} />
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-medium text-foreground" title={task.title}>
                      {task.title}
                    </span>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      {task.identifier ?? task.id.slice(0, 8)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span className="truncate">
                      {assignee ? assignee.name : "Unassigned"}
                    </span>
                    <span className="shrink-0">{timeAgo(task.updatedAt)}</span>
                  </div>
                </div>
              </Link>
            );
          })}
          {isTruncated ? (
            <div
              data-testid="team-hub-tasks-truncated"
              className="flex items-center justify-between gap-2 bg-muted/30 px-4 py-2.5 text-xs text-muted-foreground"
            >
              <span>
                Showing {MAX_VISIBLE_TASKS} of {tasks.length} open tasks
              </span>
              <Link
                to="/issues"
                className="font-medium text-foreground no-underline hover:underline"
              >
                View all tasks
              </Link>
            </div>
          ) : null}
        </Card>
      )}
    </section>
  );
}

function HumanMemberStatusBadge({ member }: { member: HumanTeamMemberRow }) {
  if (member.isOwner) {
    return (
      <Badge variant="outline" className="border-border bg-muted/60 font-normal text-muted-foreground">
        owner
      </Badge>
    );
  }
  const active = member.status.toLowerCase() === "active";
  return (
    <Badge
      variant="outline"
      className={cn(
        "font-normal",
        active
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
          : "border-border bg-muted/60 text-muted-foreground",
      )}
    >
      {member.status}
    </Badge>
  );
}

function HumanTeamSection({
  teamLabel,
  members,
  isLoading,
  hasError,
  isDisconnected,
  retrying,
  onRetry,
}: {
  teamLabel: string;
  members: readonly HumanTeamMemberRow[];
  isLoading: boolean;
  hasError: boolean;
  isDisconnected: boolean;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <section
      aria-label="Human team members"
      data-testid="team-hub-humans"
      className="space-y-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Human Team Members
          </h2>
          {!hasError && !isDisconnected ? (
            <Badge variant="secondary" className="font-mono text-xs tabular-nums">
              {members.length}
            </Badge>
          ) : null}
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link to="/dashboard/human-employees" data-testid="manage-team-capital-link">
            <SlidersHorizontal className="size-3.5" aria-hidden />
            Manage team &amp; capital
          </Link>
        </Button>
      </div>

      {isLoading ? (
        <Card elevation="low" className="gap-3 p-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </Card>
      ) : hasError ? (
        <SectionErrorCard
          message="Human team roster could not be loaded. Open Manage team & capital to view full roster details."
          onRetry={onRetry}
          retrying={retrying}
          testId="team-hub-humans-error"
        />
      ) : isDisconnected && members.length === 0 ? (
        <Card
          elevation="low"
          data-testid="team-hub-humans-disconnected"
          className="items-start gap-2 border-dashed p-5"
        >
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Users className="size-4 text-muted-foreground" aria-hidden />
            <span>Team &amp; capital roster is not connected</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Open Manage team &amp; capital to inspect the Team &amp; capital connection or admin access.
          </p>
        </Card>
      ) : members.length === 0 ? (
        <Card elevation="low" className="items-start gap-2 border-dashed p-5">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Users className="size-4 text-muted-foreground" aria-hidden />
            <span>No human seats mapped to {teamLabel} yet</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Update team roles and judged-on KPIs in Team &amp; capital to assign seats here.
          </p>
        </Card>
      ) : (
        <Card elevation="low" className="gap-0 overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th scope="col" className="px-4 py-3 font-medium">Member</th>
                <th scope="col" className="px-4 py-3 font-medium">Role</th>
                <th scope="col" className="px-4 py-3 font-medium">Judged-on KPI</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr
                  key={member.id}
                  data-testid={`team-human-row-${member.id}`}
                  className="border-b border-border/60 last:border-0"
                >
                  <td className="px-4 py-3 font-medium text-foreground">{member.name}</td>
                  <td className="px-4 py-3 text-muted-foreground">{member.role}</td>
                  <td className="px-4 py-3">
                    {member.judgedOnMissing ? (
                      <Badge
                        variant="outline"
                        className="border-amber-500/30 bg-amber-500/10 font-normal text-amber-700 dark:text-amber-300"
                      >
                        KPI not set
                      </Badge>
                    ) : (
                      <span
                        className={cn(
                          member.isOwner ? "text-muted-foreground" : "text-foreground",
                        )}
                      >
                        {member.judgedOn}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <HumanMemberStatusBadge member={member} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </section>
  );
}

function useDepartmentKpis(companyId: string | null, teamKey: TeamHubKey) {
  const keyCompany = companyId ?? "none";

  const marketingQuery = useQuery({
    queryKey: [...queryKeys.dashboardBoard(keyCompany, "marketing"), "30d"],
    queryFn: () => dashboardBoardsApi.lane2(companyId!, "marketing", "30d"),
    enabled: Boolean(companyId) && teamKey === "marketing",
    staleTime: BOARD_STALE_TIME_MS,
  });

  const salesQuery = useQuery({
    queryKey: [...queryKeys.dashboardBoard(keyCompany, "sales"), "30d"],
    queryFn: () => dashboardBoardsApi.lane2(companyId!, "sales", "30d"),
    enabled: Boolean(companyId) && teamKey === "sales",
    staleTime: BOARD_STALE_TIME_MS,
  });

  const fulfillmentQuery = useQuery({
    queryKey: ["dashboard-boards", companyId, "fulfillment"],
    queryFn: () => dashboardBoardsApi.fulfillment(companyId!),
    enabled: Boolean(companyId) && teamKey === "fulfillment",
    staleTime: BOARD_STALE_TIME_MS,
  });

  const operationsQuery = useQuery({
    queryKey: queryKeys.dashboard(companyId ?? ""),
    queryFn: () => dashboardApi.summary(companyId!),
    enabled: Boolean(companyId) && teamKey === "operations",
    staleTime: BOARD_STALE_TIME_MS,
  });

  if (teamKey === "marketing") {
    return {
      kpis: selectMarketingKpis(marketingQuery.data),
      isLoading: marketingQuery.isLoading,
      hasError: marketingQuery.isError && !marketingQuery.data,
      retrying: marketingQuery.isFetching,
      retry: () => void marketingQuery.refetch(),
    };
  }
  if (teamKey === "sales") {
    return {
      kpis: selectSalesKpis(salesQuery.data),
      isLoading: salesQuery.isLoading,
      hasError: salesQuery.isError && !salesQuery.data,
      retrying: salesQuery.isFetching,
      retry: () => void salesQuery.refetch(),
    };
  }
  if (teamKey === "fulfillment") {
    return {
      kpis: selectFulfillmentKpis(fulfillmentQuery.data),
      isLoading: fulfillmentQuery.isLoading,
      hasError: fulfillmentQuery.isError && !fulfillmentQuery.data,
      retrying: fulfillmentQuery.isFetching,
      retry: () => void fulfillmentQuery.refetch(),
    };
  }
  return {
    kpis: selectOperationsKpis(operationsQuery.data),
    isLoading: operationsQuery.isLoading,
    hasError: operationsQuery.isError && !operationsQuery.data,
    retrying: operationsQuery.isFetching,
    retry: () => void operationsQuery.refetch(),
  };
}

export function TeamHubPage() {
  const { teamKey: rawTeamKey } = useParams<{ teamKey?: string }>();
  const companyPrefix = useActiveCompanyPrefix();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { openNewIssue } = useDialogActions();

  const team = getTeamHubConfig(rawTeamKey);

  useEffect(() => {
    if (!team) return;
    setBreadcrumbs([{ label: "Teams" }, { label: team.label }]);
  }, [setBreadcrumbs, team]);

  const activeTeamKey: TeamHubKey = team?.key ?? "marketing";
  const kpiState = useDepartmentKpis(team ? selectedCompanyId : null, activeTeamKey);

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? ""),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId && team),
  });

  const issuesQuery = useQuery({
    queryKey: [...queryKeys.issues.list(selectedCompanyId ?? ""), "open"],
    queryFn: () => issuesApi.listAll(selectedCompanyId!, { status: OPEN_TASK_STATUS_FILTER }),
    enabled: Boolean(selectedCompanyId && team),
  });

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId ?? ""),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId && team),
  });

  const humansQuery = useQuery({
    queryKey: [...queryKeys.dashboardBoard(selectedCompanyId ?? "none", "human-employees"), "30d"],
    queryFn: () => dashboardBoardsApi.lane2(selectedCompanyId!, "human-employees", "30d"),
    enabled: Boolean(selectedCompanyId && team),
    staleTime: BOARD_STALE_TIME_MS,
  });

  const agents = agentsQuery.data ?? EMPTY_AGENTS;
  const issues = issuesQuery.data ?? EMPTY_ISSUES;
  const projects = projectsQuery.data ?? EMPTY_PROJECTS;

  const agentsById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const currentTaskByAgentId = useMemo(() => buildAgentCurrentTaskMap(issues), [issues]);
  const teamAgents = useMemo(
    () => (team ? filterAgentsForTeam(agents, team.key) : EMPTY_AGENTS),
    [agents, team],
  );
  const teamTasks = useMemo(
    () => (team ? filterTeamActiveTasks(issues, team.key, projects, agents) : EMPTY_ISSUES),
    [issues, team, projects, agents],
  );
  const humanMembers = useMemo(
    () => (team ? extractHumanMembersForTeam(humansQuery.data, team.key) : []),
    [humansQuery.data, team],
  );
  const humansDisconnected = useMemo(
    () => isTeamCapitalDisconnected(humansQuery.data),
    [humansQuery.data],
  );
  const matchingProject = useMemo(
    () => (team ? findMatchingTeamProject(projects, team.key) : null),
    [projects, team],
  );

  if (!team) {
    return <Navigate to={teamHubHref(companyPrefix, "marketing")} replace />;
  }

  if (!selectedCompanyId) {
    return <EmptyState icon={Users} message="Select an organization to view this team hub." />;
  }

  const TeamIcon = TEAM_ICONS[team.key];

  const handleNewTask = () => {
    openNewIssue({
      title: `[${team.label}] `,
      ...(matchingProject ? { projectId: matchingProject.id } : {}),
    });
  };

  return (
    <div className="space-y-6" data-testid={`team-hub-${team.key}`}>
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-4">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50 text-foreground">
              <TeamIcon className="size-4" aria-hidden />
            </span>
            <h1 className="text-2xl font-semibold tracking-normal text-foreground">
              {team.label}
            </h1>
          </div>
          <p className="text-sm text-muted-foreground">{team.description}</p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link to={team.dashboardHref} data-testid="team-hub-open-dashboard">
            {team.dashboardLabel}
            <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        </Button>
      </header>

      <HeadlineKpiStrip
        kpis={kpiState.kpis}
        isLoading={kpiState.isLoading}
        hasError={kpiState.hasError}
        retrying={kpiState.retrying}
        onRetry={kpiState.retry}
      />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
        <TeamAgentsPanel
          teamLabel={team.label}
          agents={teamAgents}
          currentTaskByAgentId={currentTaskByAgentId}
          isLoading={agentsQuery.isLoading}
          hasError={agentsQuery.isError && !agentsQuery.data}
          retrying={agentsQuery.isFetching}
          onRetry={() => void agentsQuery.refetch()}
        />
        <TeamTasksPanel
          teamLabel={team.label}
          tasks={teamTasks}
          agentsById={agentsById}
          isLoading={issuesQuery.isLoading}
          hasError={issuesQuery.isError && !issuesQuery.data}
          retrying={issuesQuery.isFetching}
          onRetry={() => void issuesQuery.refetch()}
          onNewTask={handleNewTask}
        />
      </div>

      <HumanTeamSection
        teamLabel={team.label}
        members={humanMembers}
        isLoading={humansQuery.isLoading}
        hasError={humansQuery.isError && !humansQuery.data}
        isDisconnected={humansDisconnected}
        retrying={humansQuery.isFetching}
        onRetry={() => void humansQuery.refetch()}
      />
    </div>
  );
}
