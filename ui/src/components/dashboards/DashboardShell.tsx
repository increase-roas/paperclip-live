import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { LayoutDashboard } from "lucide-react";
import { Link, Navigate, useLocation, useParams, useSearchParams } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useDialogActions } from "@/context/DialogContext";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";
import { claimOnboardingOffer, dashboardOnboardingOptions } from "@/lib/onboarding-auto-open";
import { onboardingDraftStorage } from "@/lib/onboarding-state";
import { shouldRouteAgentlessCompanyToOnboarding } from "@/lib/onboarding-route";
import { EmptyState } from "@/components/EmptyState";
import { cn } from "@/lib/utils";
import { BoardPlaceholder } from "./BoardPlaceholder";
import { PeriodPicker } from "./PeriodPicker";
import { ReadingOrderStrip } from "./ReadingOrderStrip";
import { DEFAULT_DASHBOARD_PERIOD, parseDashboardPeriod, type DashboardPeriod } from "./period";
import {
  DASHBOARD_BOARD_ORDER,
  DEFAULT_DASHBOARD_BOARD_ID,
  dashboardBoardMeta,
  registeredDashboard,
} from "./registry";

/**
 * The INC dashboard shell: one route per board (`/INC/dashboard/ceo`), a tab
 * bar in the spec's order, and a shared period picker.
 *
 * A tab whose lane has not registered a component renders "Being built".
 * Anything genuinely useful from the old single dashboard page moved to
 * `/dashboard/operations`, linked from the header below.
 */
export function DashboardShell() {
  const { selectedCompanyId, companies } = useCompany();
  const { openOnboarding } = useDialogActions();
  const location = useLocation();
  const { boardId: boardIdParam } = useParams<{ boardId?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { setBreadcrumbs } = useBreadcrumbs();

  const period = parseDashboardPeriod(searchParams.get("period"));
  const boardId = boardIdParam ?? DEFAULT_DASHBOARD_BOARD_ID;
  const boardMeta = dashboardBoardMeta(boardId);
  const board = registeredDashboard(boardId);

  // Auto-offer onboarding to a company with no agents. This lived on the old
  // dashboard page; the shell is now where a new company lands, so the offer
  // moved with it. See `shouldRouteAgentlessCompanyToOnboarding` for why the
  // loaded/refreshing guards are required.
  const { data: agents, isFetching: agentsRefreshing } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const onboardingOptions = selectedCompanyId
    ? dashboardOnboardingOptions(selectedCompanyId, agents, onboardingDraftStorage.read())
    : null;
  const onboardingInitialStep = onboardingOptions?.initialStep;
  const shouldOpenOnboarding = shouldRouteAgentlessCompanyToOnboarding({
    pathname: location.pathname,
    agentsLoaded: agents !== undefined,
    agentsRefreshing,
    agentCount: onboardingOptions ? 0 : agents?.length ?? 0,
  });
  useEffect(() => {
    if (!shouldOpenOnboarding || !selectedCompanyId || !onboardingInitialStep) return;
    if (!claimOnboardingOffer(selectedCompanyId)) return;
    openOnboarding({ companyId: selectedCompanyId, initialStep: onboardingInitialStep });
  }, [shouldOpenOnboarding, selectedCompanyId, onboardingInitialStep, openOnboarding]);

  const boardTitle = boardMeta?.title ?? null;
  useEffect(() => {
    setBreadcrumbs(
      boardTitle
        ? [{ label: "Dashboard", href: "/dashboard" }, { label: boardTitle }]
        : [{ label: "Dashboard" }],
    );
  }, [setBreadcrumbs, boardTitle]);

  const setPeriod = (next: DashboardPeriod) => {
    const nextParams = new URLSearchParams(searchParams);
    if (next === DEFAULT_DASHBOARD_PERIOD) nextParams.delete("period");
    else nextParams.set("period", next);
    setSearchParams(nextParams);
  };

  const hrefForBoard = (id: string) => {
    const query = searchParams.toString();
    return `/dashboard/${id}${query ? `?${query}` : ""}`;
  };

  if (!selectedCompanyId) {
    if (companies.length === 0) {
      return (
        <EmptyState
          icon={LayoutDashboard}
          message="Welcome to Paperclip. Set up your first organization and agent to get started."
          action="Get Started"
          onAction={openOnboarding}
        />
      );
    }
    return (
      <EmptyState icon={LayoutDashboard} message="Create or select an organization to view the dashboard." />
    );
  }

  // An unknown tab is a stale link, not a board: send it to the default board.
  if (!boardMeta) {
    return <Navigate to={`/dashboard/${DEFAULT_DASHBOARD_BOARD_ID}`} replace />;
  }

  const BoardComponent = board?.component;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 border-b border-border pb-3 sm:flex-row sm:items-center sm:justify-between">
        <nav aria-label="Dashboards" className="-mx-1 flex gap-1 overflow-x-auto px-1">
          {DASHBOARD_BOARD_ORDER.map((tab) => {
            const active = tab.id === boardId;
            return (
              <Link
                key={tab.id}
                to={hrefForBoard(tab.id)}
                aria-current={active ? "page" : undefined}
                data-testid={`dashboard-tab-${tab.id}`}
                className={cn(
                  "shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium no-underline transition-colors",
                  active
                    ? "bg-secondary text-secondary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                )}
              >
                {tab.title}
              </Link>
            );
          })}
        </nav>
        <div className="flex items-center gap-3">
          <Link
            to="/dashboard/operations"
            className="shrink-0 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            Paperclip operations
          </Link>
          {board ? <PeriodPicker value={period} onChange={setPeriod} /> : null}
        </div>
      </div>

      <div>
        <h1 className="text-2xl font-semibold tracking-normal text-foreground">{boardMeta.title}</h1>
        {boardId === DEFAULT_DASHBOARD_BOARD_ID ? (
          <p className="mt-1 text-sm text-muted-foreground">
            Read the eight questions below in order. Every number carries its red line and the time it was read.
          </p>
        ) : null}
      </div>

      <ReadingOrderStrip />

      {BoardComponent && board ? (
        <BoardComponent companyId={selectedCompanyId} period={period} />
      ) : (
        <BoardPlaceholder title={boardMeta.title} />
      )}
    </div>
  );
}
