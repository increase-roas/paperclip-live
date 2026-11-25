import { useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CircleCheck,
  FolderOpen,
  Inbox,
  LayoutDashboard,
  Megaphone,
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
  projectId: string | null;
};

/**
 * Maps existing company Projects onto the CEO-grade TEAMS sidebar section:
 * Marketing, Sales, Fulfillment, Operations first (backed by matching Projects
 * when present, falling back to /projects if not yet created), followed by any
 * additional active projects so nothing in the workspace is orphaned.
 */
export function buildTeamNavigationItems(projects: readonly Project[]): TeamNavigationItem[] {
  const activeProjects = projects.filter(project => !project.archivedAt && project.status !== "cancelled");
  const matchedIds = new Set<string>();

  const canonical: TeamNavigationItem[] = CEO_TEAMS.map(team => {
    const match = activeProjects.find(
      project => project.name.trim().toLowerCase() === team.label.toLowerCase(),
    );
    if (match) {
      matchedIds.add(match.id);
      return {
        key: team.key,
        label: team.label,
        to: `/projects/${projectRouteRef(match)}/issues`,
        icon: team.icon,
        projectId: match.id,
      };
    }
    return {
      key: team.key,
      label: team.label,
      to: "/projects",
      icon: team.icon,
      projectId: null,
    };
  });

  const extra: TeamNavigationItem[] = activeProjects
    .filter(project => !matchedIds.has(project.id))
    .map(project => ({
      key: project.id,
      label: project.name,
      to: `/projects/${projectRouteRef(project)}/issues`,
      icon: FolderOpen,
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
      className="inline-block size-4 shrink-0 rounded-full bg-radial from-violet-300 via-purple-500 to-indigo-700 shadow-[0_0_8px_rgba(168,85,247,0.65)]"
    />
  );
}

/** CEO-grade primary navigation:
 * Top (immediate attention): Javar, Inbox, Tasks, Dashboard (+ Sales dashboard plugin slots).
 * Middle (TEAMS): Marketing, Sales, Fulfillment, Operations backed by existing Projects.
 * Bottom (COMPANY): Agents, Routines, Settings — zero individual agent names in the sidebar. */
export function CoordinatorSidebar({ children }: { children?: ReactNode }) {
  const { companyId, agents, chats } = useAgentChatNavigation();
  const { selectedCompany } = useCompany();
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
  const teamItems = useMemo(() => buildTeamNavigationItems(projects ?? []), [projects]);
  const pluginContext = useMemo(() => ({
    companyId: companyId ?? null,
    companyPrefix: selectedCompany?.issuePrefix ?? null,
  }), [companyId, selectedCompany?.issuePrefix]);

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
              <SidebarNavItem
                className="design-sidebar-item"
                to={javarTo}
                label="Javar"
                iconNode={<JavarOrbIcon />}
                badge={unreadChatCount}
                badgeLabel="unread chats"
              />
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
              headerAction={!rail ? { ariaLabel: "New team", icon: Plus, onClick: openNewProject } : undefined}
            >
              {teamItems.map(team => (
                <SidebarNavItem
                  key={team.key}
                  className="design-sidebar-item"
                  to={team.to}
                  label={team.label}
                  icon={team.icon}
                />
              ))}
            </SidebarSection>

            <SidebarSection label="Company">
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
