import { useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BookOpen,
  Building2,
  CircleCheck,
  FolderOpen,
  Inbox,
  LayoutDashboard,
  Megaphone,
  Mic,
  Package,
  Plus,
  Repeat,
  Search,
  Settings,
  SlidersHorizontal,
  TrendingUp,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { Agent, Project } from "@paperclipai/shared";
import { useCoordinatorAttentionCount } from "@/hooks/useCoordinatorAttentionCount";
import { projectsApi } from "@/api/projects";
import { useAgentChatNavigation } from "@/hooks/useAgentChatNavigation";
import { useCompany } from "@/context/CompanyContext";
import { useDialogActions } from "@/context/DialogContext";
import { useSidebar } from "@/context/SidebarContext";
import { useOptionalJavarVoice } from "@/ir/voice/JavarVoiceContext";
import { isTeamHubActive, teamHubHref } from "@/ir/teams/teamHubHelpers";
import { useLocation } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { agentRouteRef, cn, projectRouteRef } from "@/lib/utils";
import { PluginSlotOutlet } from "@/plugins/slots";
import { PluginLauncherOutlet } from "@/plugins/launchers";
import { SidebarCompanyMenu } from "./SidebarCompanyMenu";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarSection } from "./SidebarSection";
import { TruncatedTextMarqueeProvider } from "./TruncatedText";
import { FlyoutAppearanceProvider } from "./ui/flyout";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

export const CEO_TEAMS = [
  { key: "marketing", label: "Marketing", icon: Megaphone },
  { key: "sales", label: "Sales", icon: TrendingUp },
  { key: "fulfillment", label: "Fulfillment", icon: Package },
  { key: "operations", label: "Operations", icon: SlidersHorizontal },
] as const;

export type TeamNavigationItem = {
  key: string;
  label: string;
  to: string;
  icon: LucideIcon;
  kind: "team" | "project";
  projectId: string | null;
};

/**
 * Builds the CEO-grade TEAMS sidebar section:
 * 1. Canonical department hubs (Marketing, Sales, Fulfillment, Operations)
 *    routed directly to `/<prefix>/teams/<key>` so each department has its own
 *    native hub and exact active highlight.
 * 2. Standalone active projects grouped cleanly below without colliding with
 *    the four department hubs.
 */
export function buildTeamNavigationItems(
  projects: readonly Project[],
  companyPrefix?: string | null,
): TeamNavigationItem[] {
  const activeProjects = projects.filter(project => !project.archivedAt && project.status !== "cancelled");
  const canonicalLabels = new Set(CEO_TEAMS.map(team => team.label.toLowerCase()));

  const canonical: TeamNavigationItem[] = CEO_TEAMS.map(team => ({
    key: team.key,
    label: team.label,
    to: teamHubHref(companyPrefix, team.key),
    icon: team.icon,
    kind: "team",
    projectId: null,
  }));

  const extra: TeamNavigationItem[] = activeProjects
    .filter(project => !canonicalLabels.has(project.name.trim().toLowerCase()))
    .map(project => ({
      key: project.id,
      label: project.name,
      to: `/projects/${projectRouteRef(project)}/issues`,
      icon: FolderOpen,
      kind: "project",
      projectId: project.id,
    }));

  return [...canonical, ...extra];
}

export function resolveJavarDestination(agents: readonly Agent[]): string {
  const javar = agents.find(agent => agent.name.trim().toLowerCase() === "javar")
    ?? agents.find(agent => agent.role === "ceo");
  return javar ? `/chats/${encodeURIComponent(agentRouteRef(javar))}` : "/chats";
}

function JavarOrbIcon() {
  return (
    <span
      aria-hidden="true"
      className="ir-javar-orb inline-block size-4 shrink-0 rounded-full bg-radial from-violet-300 via-purple-500 to-indigo-700"
    />
  );
}

/** CEO-grade primary navigation:
 * Top (immediate attention): Javar (with inline voice mic), Inbox, Tasks, Dashboard (+ sidebar plugin slots).
 * Middle (TEAMS): Marketing, Sales, Fulfillment, Operations native Team Hubs, plus standalone Projects below.
 * Bottom (COMPANY): Clients, Workflows, Agents, Routines, Settings. */
export function CoordinatorSidebar({ children }: { children?: ReactNode }) {
  const { companyId, agents, chats } = useAgentChatNavigation();
  const { selectedCompany } = useCompany();
  const location = useLocation();
  const voice = useOptionalJavarVoice();
  const unreadChatCount = chats.data?.filter(chat => chat.isUnreadForMe).length ?? 0;
  const { collapsed, peeking } = useSidebar();
  const rail = collapsed && !peeking;
  const { openNewIssue, openNewProject } = useDialogActions();
  const attentionCount = useCoordinatorAttentionCount(companyId);
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(companyId!),
    queryFn: () => projectsApi.list(companyId!),
    enabled: !!companyId,
  });

  const javarTo = useMemo(() => resolveJavarDestination(agents.data ?? []), [agents.data]);
  const companyPrefix = selectedCompany?.issuePrefix?.trim().toUpperCase() ?? null;
  const teamItems = useMemo(
    () => buildTeamNavigationItems(projects ?? [], companyPrefix),
    [projects, companyPrefix],
  );
  const departmentItems = useMemo(
    () => teamItems.filter(item => item.kind === "team"),
    [teamItems],
  );
  const standaloneProjectItems = useMemo(
    () => teamItems.filter(item => item.kind === "project"),
    [teamItems],
  );
  const clientsTo = companyPrefix ? `/${companyPrefix}/clients` : "/clients";
  const workflowsTo = companyPrefix ? `/${companyPrefix}/workflows` : "/workflows";
  const pluginContext = useMemo(() => ({
    companyId: companyId ?? null,
    companyPrefix: selectedCompany?.issuePrefix ?? null,
  }), [companyId, selectedCompany?.issuePrefix]);

  const voiceLive = Boolean(voice?.connected);
  const voiceLabel = voiceLive ? "End voice call with Javar" : "Talk to Javar";

  return (
    <FlyoutAppearanceProvider>
      <TruncatedTextMarqueeProvider>
        <aside className="coordinator-sidebar design-sidebar w-full">
          <div className="design-sidebar-brand" data-collapsed={rail || undefined}>
            <SidebarCompanyMenu showChevron={false} />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="design-sidebar-search"
                  aria-label="Global search"
                  onClick={() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }))}
                >
                  <Search aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">Search tasks, agents, projects</TooltipContent>
            </Tooltip>
          </div>

          <nav className="design-sidebar-navigation" aria-label="Workspace navigation">
            <div className="design-sidebar-primary">
              <div className="group/javar-voice relative">
                <SidebarNavItem
                  className={cn("design-sidebar-item", !rail && "pr-9")}
                  to={javarTo}
                  label="Javar"
                  iconNode={<JavarOrbIcon />}
                  badge={unreadChatCount}
                  badgeLabel="unread chats"
                />
                {!rail && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label={voiceLabel}
                        aria-pressed={voiceLive}
                        title={voiceLabel}
                        onClick={() => voice?.toggleCall()}
                        className={cn(
                          "absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1 transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring",
                          voiceLive
                            ? "text-ring opacity-100"
                            : "text-muted-foreground opacity-75 group-hover/javar-voice:opacity-100 group-focus-within/javar-voice:opacity-100",
                        )}
                      >
                        <span className="relative flex items-center justify-center">
                          <Mic className="size-3.5" aria-hidden="true" />
                          {voiceLive && (
                            <span
                              aria-hidden="true"
                              className="absolute -right-1 -top-1 flex size-2"
                            >
                              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ring opacity-75" />
                              <span className="relative inline-flex size-2 rounded-full bg-ring" />
                            </span>
                          )}
                        </span>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      {voiceLive ? "Live voice active — click to end" : "Talk to Javar"}
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
              <SidebarNavItem
                className="design-sidebar-item"
                to="/decisions"
                label="Inbox"
                icon={Inbox}
                badge={attentionCount}
                badgeLabel="decisions"
              />
              <div className="group/coordinator-new relative">
                <SidebarNavItem
                  to="/issues"
                  label="Tasks"
                  icon={CircleCheck}
                  className={cn("design-sidebar-item", !rail && "pr-9")}
                />
                {!rail && (
                  <button
                    type="button"
                    aria-label="New task"
                    title="New task"
                    onClick={() => openNewIssue()}
                    className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity group-hover/coordinator-new:opacity-100 group-focus-within/coordinator-new:opacity-100 pointer-coarse:opacity-100 hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Plus className="size-4" />
                  </button>
                )}
              </div>
              <SidebarNavItem
                className="design-sidebar-item"
                to="/dashboard"
                label="Dashboard"
                icon={LayoutDashboard}
              />
              <PluginSlotOutlet
                slotTypes={["sidebar"]}
                context={pluginContext}
                className="flex flex-col gap-0.5"
                itemClassName="design-sidebar-item"
                missingBehavior="placeholder"
              />
              <PluginLauncherOutlet
                placementZones={["sidebar"]}
                context={pluginContext}
                className="flex flex-col gap-0.5"
                itemClassName="design-sidebar-item"
              />
            </div>

            <SidebarSection
              label="Teams"
              headerAction={!rail ? { ariaLabel: "New project", icon: Plus, onClick: openNewProject } : undefined}
            >
              {departmentItems.map(team => (
                <SidebarNavItem
                  key={team.key}
                  className="design-sidebar-item"
                  to={team.to}
                  label={team.label}
                  icon={team.icon}
                  end
                  active={isTeamHubActive(location.pathname, team.key)}
                />
              ))}
              {standaloneProjectItems.length > 0 ? (
                <>
                  {!rail ? (
                    <div className="mx-3 my-1 h-px bg-border/50" aria-hidden="true" />
                  ) : null}
                  {standaloneProjectItems.map(project => (
                    <SidebarNavItem
                      key={project.key}
                      className="design-sidebar-item"
                      to={project.to}
                      label={project.label}
                      icon={project.icon}
                    />
                  ))}
                </>
              ) : null}
            </SidebarSection>

            <SidebarSection label="Company">
              <SidebarNavItem
                className="design-sidebar-item"
                to={clientsTo}
                label="Clients"
                icon={Building2}
              />
              <SidebarNavItem
                className="design-sidebar-item"
                to={workflowsTo}
                label="Workflows"
                icon={BookOpen}
              />
              <SidebarNavItem
                className="design-sidebar-item"
                to="/agents/all"
                label="Agents"
                icon={Users}
              />
              <SidebarNavItem
                className="design-sidebar-item"
                to="/routines"
                label="Routines"
                icon={Repeat}
              />
              <SidebarNavItem
                className="design-sidebar-item"
                to="/company/settings"
                label="Settings"
                icon={Settings}
              />
            </SidebarSection>

            {children}
          </nav>
        </aside>
      </TruncatedTextMarqueeProvider>
    </FlyoutAppearanceProvider>
  );
}
