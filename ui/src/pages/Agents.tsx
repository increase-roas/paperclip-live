import { OrgChartNotices } from "@/components/OrgChartNotices";
import { PrimaryAgentIndicator } from "@/components/primary-agent/PrimaryAgentPresentation";
import { AgentBulkRoster } from "@/components/agents/AgentBulkRoster";
import { AgentChatPin, useAgentChatPins } from "@/components/AgentChatPin";
import { useAgentChatEnabled } from "../hooks/useAgentChatEnabled";
import { useState, useEffect, useMemo, lazy, Suspense } from "react";
import { Link, useNavigate, useLocation } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { agentsApi, type OrgNode } from "../api/agents";
import { builtInAgentsApi, type BuiltInAgentState } from "../api/builtInAgents";
import { environmentsApi } from "../api/environments";
import { heartbeatsApi } from "../api/heartbeats";
import { instanceSettingsApi } from "../api/instanceSettings";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useSidebar } from "../context/SidebarContext";
import { useStreamlinedUiEnabled } from "../hooks/useStreamlinedUiEnabled";
import { queryKeys } from "../lib/queryKeys";
import { AgentStatusBadge, AgentStatusCapsule } from "../components/StatusBadge";
import { EntityRow } from "../components/EntityRow";
import { BuiltInLifecycleChip } from "../components/BuiltInAgentBadges";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { QueryErrorState, useQueryView } from "../components/QueryView";
import { OrgChart } from "./OrgChart";
import { relativeTime, cn, agentRouteRef, agentUrl } from "../lib/utils";
import { AgentsToolbar } from "../components/AgentsToolbar";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Tooltip as TooltipPrimitive } from "radix-ui";
import { AlertTriangle, Bot, MessagesSquare } from "lucide-react";
import {
  AGENT_ROLE_LABELS,
  legacyAgentAppearance,
  resolveAgentAppearance,
  type Agent,
  type AgentAvatarSize,
  type Environment,
} from "@paperclipai/shared";
import { agentAvatarUrl } from "@/lib/agent-avatar-url";
import { deriveInitials } from "@/components/Identity";
import { useAvatarInitials } from "@/components/ui/avatar-initials";
import { usePublishSharedQueryData, useSharedPollingQuery } from "../hooks/useSharedPolling";
import {
  loadingEnvironmentDescriptor,
  localEnvironmentDescriptor,
  resolveAgentEnvironment,
  type EnvironmentDescriptor,
} from "../lib/agent-environment-descriptor";

const roleLabels = AGENT_ROLE_LABELS as Record<string, string>;

export function formatAgentSubtitle(role: string, title?: string | null): string {
  const roleLabel = (roleLabels[role] ?? role).trim();
  const cleanTitle = title?.trim() ?? "";
  if (!cleanTitle) return roleLabel;
  if (cleanTitle.toLowerCase() === roleLabel.toLowerCase()) return roleLabel;
  return `${roleLabel} - ${cleanTitle}`;
}

function RosterAgentAvatar({
  agent,
  size,
}: {
  agent: { id?: string; name?: string; appearance?: Agent["appearance"] };
  size: AgentAvatarSize;
}) {
  const identity = resolveAgentAppearance(agent.appearance, agent.id);
  const fallbackIdentity = legacyAgentAppearance(agent.id ?? agent.name ?? "agent");
  const primarySrc = agentAvatarUrl(identity, size, 1, "rest", false);
  const fallbackSrc = identity.customAvatarAssetId
    ? agentAvatarUrl(fallbackIdentity, size, 1, "rest", false)
    : null;
  const [stage, setStage] = useState<"primary" | "fallback" | "initials">("primary");
  const initials = useAvatarInitials(deriveInitials(agent.name ?? "Agent"));

  useEffect(() => {
    setStage("primary");
  }, [primarySrc]);

  const activeSrc = stage === "primary" ? primarySrc : stage === "fallback" ? fallbackSrc : null;
  const activeIdentity = stage === "primary" ? identity : fallbackIdentity;
  const sizeClass = size === 24 ? "size-6" : "size-8";

  return (
    <span
      data-slot="agent-avatar"
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted/60 align-middle ring-1 ring-border/60",
        sizeClass,
      )}
      aria-hidden
    >
      {stage === "initials" || !activeSrc ? (
        <span className="text-xs font-medium text-foreground">{initials}</span>
      ) : (
        <img
          src={activeSrc}
          srcSet={
            activeIdentity.customAvatarAssetId
              ? undefined
              : `${agentAvatarUrl(activeIdentity, size, 2, "rest", false)} 2x`
          }
          alt=""
          width={size}
          height={size}
          decoding="async"
          loading="eager"
          className="size-full object-contain"
          onError={() => {
            if (stage === "primary" && fallbackSrc && fallbackSrc !== primarySrc) {
              setStage("fallback");
            } else {
              setStage("initials");
            }
          }}
        />
      )}
    </span>
  );
}

// Lazy-loaded so the roster page doesn't statically pull in the full
// AgentConfigForm module graph (the modal reuses its adapter/model pickers).
const ConfigureBuiltInAgentModal = lazy(() =>
  import("../components/ConfigureBuiltInAgentModal").then((m) => ({
    default: m.ConfigureBuiltInAgentModal,
  })),
);

import {
  agentStatusMatchesFilter as matchesFilter,
  HIDDEN_AGENT_STATUSES,
  isAgentFilterTab as isFilterTab,
  type AgentFilterTab as FilterTab,
} from "../lib/agent-filter-tabs";
export { AGENT_FILTER_TABS } from "../lib/agent-filter-tabs";

function matchesSearch(agent: Pick<Agent, "name" | "role" | "title">, query: string): boolean {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const text = [agent.name, agent.role, roleLabels[agent.role], agent.title].filter(Boolean).join(" ").toLocaleLowerCase();
  return words.every(word => text.includes(word));
}

export function filterAgents(agents: Agent[], tab: FilterTab, builtInAgentIds: Set<string>, query = ""): Agent[] {
  return agents
    .filter((a) => {
      if (HIDDEN_AGENT_STATUSES.has(a.status) || !matchesSearch(a, query)) return false;
      // The `builtin` filter keys on the built-in marker, not agent status.
      if (tab === "builtin") return builtInAgentIds.has(a.id);
      return matchesFilter(a.status, tab);
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function filterOrgTree(nodes: OrgNode[], tab: FilterTab, builtInAgentIds: Set<string>, matchingIds?: Set<string>): OrgNode[] {
  return nodes
    .reduce<OrgNode[]>((acc, node) => {
      const filteredReports = filterOrgTree(node.reports, tab, builtInAgentIds, matchingIds);
      // Hidden agents (terminated / pending_approval) never render as a row, but
      // any visible reports are promoted so the tree doesn't lose live agents.
      if (HIDDEN_AGENT_STATUSES.has(node.status)) {
        acc.push(...filteredReports);
        return acc;
      }
      const nodeMatches = tab === "builtin"
        ? builtInAgentIds.has(node.id)
        : matchesFilter(node.status, tab);
      if ((nodeMatches && (!matchingIds || matchingIds.has(node.id))) || filteredReports.length > 0) {
        acc.push({ ...node, reports: filteredReports });
      }
      return acc;
    }, [])
    .sort((a, b) => a.name.localeCompare(b.name));
}

export type AgentsView = "list" | "org";

export function Agents({ initialView = "list" }: { initialView?: AgentsView } = {}) {
  const agentChatPins = useAgentChatPins();
  const [query, setQuery] = useState("");
  const agentChat = useAgentChatEnabled();
  const { selectedCompanyId } = useCompany();
  const { openNewAgent } = useDialogActions();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const location = useLocation();
  const { isMobile } = useSidebar();
  const { enabled: streamlinedUiEnabled } = useStreamlinedUiEnabled();
  const pathSegment = location.pathname.split("/").pop() ?? "all";
  const requestedTab: FilterTab = isFilterTab(pathSegment) ? pathSegment : "all";
  const [view, setView] = useState<AgentsView>(() => streamlinedUiEnabled ? initialView : "org");
  const forceListView = !streamlinedUiEnabled && isMobile;
  const effectiveView: AgentsView = forceListView ? "list" : view;

  useEffect(() => {
    setView(streamlinedUiEnabled ? initialView : "org");
  }, [initialView, streamlinedUiEnabled]);

  const { data: instanceSettings } = useQuery({
    queryKey: queryKeys.instance.settings,
    queryFn: () => instanceSettingsApi.get(),
    enabled: !!selectedCompanyId,
  });
  const builtInAgentsEnabled = instanceSettings?.experimental.enableBuiltInAgents === true;
  const tab: FilterTab = "all";
  const { data: builtInAgents } = useQuery({
    queryKey: queryKeys.builtInAgents.list(selectedCompanyId!),
    queryFn: () => builtInAgentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && builtInAgentsEnabled,
  });
  const builtInByAgentId = useMemo(() => {
    const map = new Map<string, BuiltInAgentState>();
    if (!builtInAgentsEnabled) return map;
    for (const entry of builtInAgents ?? []) {
      if (entry.agentId) map.set(entry.agentId, entry);
    }
    return map;
  }, [builtInAgents, builtInAgentsEnabled]);
  const builtInAgentIds = useMemo(() => new Set(builtInByAgentId.keys()), [builtInByAgentId]);
  const [configureState, setConfigureState] = useState<BuiltInAgentState | null>(null);

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: agents, isLoading } = agentsQuery;
  const agentsView = useQueryView(agentsQuery);

  const {
    data: orgTree,
    error: orgTreeError,
    isLoading: orgTreeLoading,
    isFetching: orgTreeFetching,
    refetch: refetchOrgTree,
  } = useQuery({
    queryKey: queryKeys.org(selectedCompanyId!),
    queryFn: () => agentsApi.org(selectedCompanyId!),
    enabled: !!selectedCompanyId && effectiveView === "org",
  });

  const environmentsEnabled = instanceSettings?.experimental.enableEnvironments === true;

  const { data: environments } = useQuery({
    queryKey: queryKeys.environments.list(selectedCompanyId!),
    queryFn: () => environmentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && environmentsEnabled,
  });

  const { data: environmentCapabilities } = useQuery({
    queryKey: queryKeys.environments.capabilities(selectedCompanyId!),
    queryFn: () => environmentsApi.capabilities(selectedCompanyId!),
    enabled: !!selectedCompanyId && environmentsEnabled,
  });

  const runsQueryKey = [...queryKeys.liveRuns(selectedCompanyId!), "agents-page"] as const;
  const sharedRuns = useSharedPollingQuery({
    companyId: selectedCompanyId,
    resourceKey: "live-runs:agents-page",
    queryKey: runsQueryKey,
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
    leaderOnly: true,
  });
  const { data: runs, dataUpdatedAt: runsUpdatedAt } = useQuery({
    queryKey: runsQueryKey,
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: sharedRuns.enabled,
    refetchInterval: sharedRuns.refetchInterval,
  });
  usePublishSharedQueryData(sharedRuns, runs, runsUpdatedAt);

  // Map agentId -> first live run + live run count
  const liveRunByAgent = useMemo(() => {
    const map = new Map<string, { runId: string; liveCount: number }>();
    for (const r of runs ?? []) {
      if (r.status !== "running" && r.status !== "queued") continue;
      const existing = map.get(r.agentId);
      if (existing) {
        existing.liveCount += 1;
        continue;
      }
      map.set(r.agentId, { runId: r.id, liveCount: 1 });
    }
    return map;
  }, [runs]);

  const environmentsById = useMemo(() => {
    const map = new Map<string, Environment>();
    for (const environment of environments ?? []) map.set(environment.id, environment);
    return map;
  }, [environments]);

  const environmentByAgentId = useMemo(() => {
    const map = new Map<string, EnvironmentDescriptor>();
    for (const agent of agents ?? []) {
      map.set(
        agent.id,
        resolveAgentEnvironment(
          agent,
          environmentsById,
          instanceSettings?.defaultEnvironmentId ?? null,
          environmentCapabilities,
        ),
      );
    }
    return map;
  }, [agents, environmentsById, environmentCapabilities, instanceSettings?.defaultEnvironmentId]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Agents" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    if (requestedTab !== "all") {
      navigate("/agents/all", { replace: true });
    }
  }, [navigate, requestedTab]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Bot} message="Select an organization to view agents." />;
  }

  // Keep a loaded list on screen through a failed refetch; only a real
  // failure, or an outage before the first load, replaces the page.
  if (isLoading || agentsView.kind === "reconnecting") {
    return <PageSkeleton variant="list" />;
  }
  if (agentsView.kind === "error") {
    return (
      <QueryErrorState
        size="page"
        error={agentsView.error}
        action="load agents"
        onRetry={agentsView.retry}
        retrying={agentsView.isFetching}
      />
    );
  }

  const filtered = filterAgents(agents ?? [], tab, builtInAgentIds, query);
  const filteredOrg = filterOrgTree(orgTree ?? [], tab, builtInAgentIds, query.trim() ? new Set(filtered.map(agent => agent.id)) : undefined);
  const environmentDataLoading = environmentsEnabled && environments === undefined;
  const showEnvironmentColumn = environmentsEnabled && (environments === undefined || environments.length > 1);
  const resolveRenderedEnvironment = (agentId: string) => (
    environmentDataLoading
      ? loadingEnvironmentDescriptor
      : environmentByAgentId.get(agentId) ?? localEnvironmentDescriptor
  );

  const renderAgentRow = (agent: Agent) => {
    const hasInvalidOrgChain = agent.orgChainHealth?.status === "invalid_org_chain";
    const builtInState = builtInByAgentId.get(agent.id);
    const showBuiltInLifecycle = builtInState?.status === "needs_setup" || builtInState?.status === "pending_approval";
    // Keep lifecycle controls with the metadata only when the content area
    // has enough room; the sidebar can leave less space than the viewport suggests.
    const builtInCluster = builtInState && showBuiltInLifecycle ? (
      <>
        <BuiltInLifecycleChip status={builtInState.status} />
        {builtInState.status === "needs_setup" && (
          <span
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            <Button
              size="xs"
              variant="outline"
              onClick={() => setConfigureState(builtInState)}
            >
              Set up
            </Button>
          </span>
        )}
      </>
    ) : null;
    return (
      <div key={agent.id} className="agent-pin-row agent-roster-pin-row group/agent-pin relative">
      <EntityRow
        title={agent.name}
        titleAccessory={<PrimaryAgentIndicator agentId={agent.id} companyId={agent.companyId} />}
        titleClassName="agent-pin-text flex-1"
        titleTextClassName="truncate"
        subtitleClassName="truncate"
        subtitle={formatAgentSubtitle(agent.role, agent.title)}
        to={agentUrl(agent)}
        className="agent-roster-identity group py-3 group-hover/agent-pin:bg-accent/50 group-focus-within/agent-pin:bg-accent/50"
        leading={
          <span className="relative inline-flex items-center">
            <RosterAgentAvatar agent={agent} size={32} />
            {hasInvalidOrgChain ? (
              <AlertTriangle
                className="ml-1.5 h-3.5 w-3.5 shrink-0 text-(--status-task-icon-todo)"
                aria-label="Invalid reporting chain"
              />
            ) : null}
          </span>
        }
        secondaryRowClassName={cn("pl-11", !builtInCluster && !showEnvironmentColumn && !agent.lastHeartbeatAt && "sm:hidden")}
        secondaryRow={(agent.status === "paused" || builtInCluster || showEnvironmentColumn || agent.lastHeartbeatAt) && (
          <div className="flex flex-wrap items-center gap-2">
            {builtInCluster}
            {showEnvironmentColumn && <span className="text-xs text-muted-foreground" title={resolveRenderedEnvironment(agent.id).title}>
              {resolveRenderedEnvironment(agent.id).label} · {resolveRenderedEnvironment(agent.id).detail}
            </span>}
            {agent.lastHeartbeatAt && <span className="text-xs text-muted-foreground" title="Last heartbeat">{relativeTime(agent.lastHeartbeatAt)}</span>}
          </div>
        )}
      />
      <AgentChatPin agent={agent} pins={agentChatPins} />
      </div>
    );
  };

  const renderAgentStatus = (agent: Agent) => (
    <div className="flex items-center gap-3">
      {liveRunByAgent.has(agent.id) && (
        <LiveRunIndicator
          agentRef={agentRouteRef(agent)}
          runId={liveRunByAgent.get(agent.id)!.runId}
          liveCount={liveRunByAgent.get(agent.id)!.liveCount}
        />
      )}
      <AgentStatusBadge status={agent.status} />
    </div>
  );

  return (
    <div className={cn(
      "flex flex-col gap-4 @container",
      effectiveView === "org" && "h-full min-h-0",
    )}>
      <AgentsToolbar query={query} onQueryChange={setQuery} view={effectiveView} onViewChange={setView}
        hideViewToggle={forceListView} onNewAgent={openNewAgent} />

      <div className={cn("min-h-0 space-y-4", effectiveView === "org" && "flex flex-1 flex-col")}>

      {agents && agents.length === 0 && (
        <EmptyState
          icon={Bot}
          message="Create your first agent to get started."
          action="New Agent"
          onAction={openNewAgent}
        />
      )}

      {/* List view */}
      {effectiveView === "list" && agents && agents.length > 0 && (
        <AgentBulkRoster key={selectedCompanyId} companyId={selectedCompanyId}
          agents={agents.filter(agent => !HIDDEN_AGENT_STATUSES.has(agent.status))}
          visibleAgents={filtered} renderAgent={renderAgentRow} renderStatus={renderAgentStatus}
          renderChat={agentChat.enabled ? agent => (
            // Use Radix's standard hover delay, isolated from the app's instant provider.
            <TooltipPrimitive.Provider skipDelayDuration={0}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/agent-row:opacity-100 focus-visible:opacity-100"
                    aria-label={`Chat with ${agent.name}`}
                    onClick={() => navigate(`/chats/${agentRouteRef(agent)}`)}
                  >
                    <MessagesSquare className="size-3.5" aria-hidden />
                    Chat
                  </button>
                </TooltipTrigger>
                <TooltipContent>chat with this agent</TooltipContent>
              </Tooltip>
            </TooltipPrimitive.Provider>
          ) : undefined} />
      )}



      {/* Org chart view */}
      <OrgChartNotices
        view={effectiveView} loading={orgTreeLoading} hasTree={Boolean(orgTree)} error={orgTreeError}
        fetching={orgTreeFetching} onRetry={() => void refetchOrgTree()} onSwitchToList={() => setView("list")}
      />

      {effectiveView === "org" && filteredOrg.length > 0 && (
        <OrgChart embedded orgTree={filteredOrg} agents={agents ?? []} />
      )}

      {effectiveView === "org" && orgTree && orgTree.length > 0 && filteredOrg.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          No agents match your search and selected status.
        </p>
      )}

      {effectiveView === "org" && orgTree && orgTree.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          No organizational hierarchy defined.
        </p>
      )}
      {configureState && selectedCompanyId && (
        <Suspense fallback={null}>
          <ConfigureBuiltInAgentModal
            companyId={selectedCompanyId}
            state={configureState}
            open={configureState !== null}
            onOpenChange={(open) => {
              if (!open) setConfigureState(null);
            }}
          />
        </Suspense>
      )}
      </div>
    </div>
  );
}

function LiveRunIndicator({
  agentRef,
  runId,
  liveCount,
}: {
  agentRef: string;
  runId: string;
  liveCount: number;
}) {
  return (
    <Link
      to={`/agents/${agentRef}/runs/${runId}`}
      className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-blue-500/10 hover:bg-blue-500/20 transition-colors no-underline"
      onClick={(e) => e.stopPropagation()}
    >
      <span className="relative flex h-2 w-2">
        <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
      </span>
      <span className="text-(length:--text-micro) font-medium text-blue-600 dark:text-blue-400">
        Live{liveCount > 1 ? ` (${liveCount})` : ""}
      </span>
    </Link>
  );
}
