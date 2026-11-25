import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { LayoutDashboard } from "lucide-react";
import { Link, Navigate, useParams, useSearchParams } from "@/lib/router";
import { dashboardBoardsApi } from "@/api/dashboardBoards";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useDialogActions } from "@/context/DialogContext";
import { useAgentlessOnboardingOffer } from "@/hooks/useAgentlessOnboardingOffer";
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

export interface DashboardTabBarProps {
  activeBoardId?: string | null;
  searchQuery?: string;
  period?: DashboardPeriod;
  onPeriodChange?: (period: DashboardPeriod) => void;
}

/**
 * Shared compact tab bar for the eight operating dashboards (and `/dashboard/operations`).
 * Wraps cleanly so all eight tabs and the period picker stay fully readable with
 * zero clipped labels and no horizontal scrollbar on narrower desktop widths.
 */
export function DashboardTabBar({
  activeBoardId,
  searchQuery = "",
  period,
  onPeriodChange,
}: DashboardTabBarProps) {
  const hrefForBoard = (id: string) =>
    `/dashboard/${id}${searchQuery ? `?${searchQuery}` : ""}`;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
      <nav aria-label="Dashboards" className="flex flex-wrap items-center gap-1">
        {DASHBOARD_BOARD_ORDER.map((tab) => {
          const active = tab.id === activeBoardId;
          return (
            <Link
              key={tab.id}
              to={hrefForBoard(tab.id)}
              aria-current={active ? "page" : undefined}
              data-testid={`dashboard-tab-${tab.id}`}
              className={cn(
                "whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium no-underline transition-colors sm:text-sm",
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
      {period && onPeriodChange ? (
        <div className="shrink-0">
          <PeriodPicker value={period} onChange={onPeriodChange} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The INC dashboard shell: one route per board (`/INC/dashboard/ceo`), a tab
 * bar in the spec's order, and a shared period picker.
 *
 * A tab whose lane has not registered a component renders "Being built".
 */
export function DashboardShell() {
  const { selectedCompanyId, companies } = useCompany();
  const { openOnboarding } = useDialogActions();
  const { boardId: boardIdParam } = useParams<{ boardId?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { setBreadcrumbs } = useBreadcrumbs();

  const period = parseDashboardPeriod(searchParams.get("period"));
  const boardId = boardIdParam ?? DEFAULT_DASHBOARD_BOARD_ID;
  const boardMeta = dashboardBoardMeta(boardId);
  const board = registeredDashboard(boardId);
  const isCeoBoard = boardId === DEFAULT_DASHBOARD_BOARD_ID;

  // The shell is where a new company lands, so it carries the onboarding offer
  // that lived on the old single dashboard page.
  useAgentlessOnboardingOffer(selectedCompanyId);

  const readingOrderQuery = useQuery({
    queryKey: ["dashboard-boards", selectedCompanyId, "reading-order", period],
    queryFn: async () => {
      try {
        return await dashboardBoardsApi.readingOrder(selectedCompanyId!, period);
      } catch {
        return {};
      }
    },
    enabled: Boolean(selectedCompanyId) && isCeoBoard,
    retry: false,
    staleTime: 60_000,
  });

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
  const readingOrderStatuses =
    readingOrderQuery.data?.statuses ?? readingOrderQuery.data?.readingOrder ?? {};
  const readingOrderMetrics =
    readingOrderQuery.data?.metrics ?? readingOrderQuery.data?.readingOrderMetrics;

  return (
    <div className="space-y-5">
      <DashboardTabBar
        activeBoardId={boardId}
        searchQuery={searchParams.toString()}
        period={board ? period : undefined}
        onPeriodChange={board ? setPeriod : undefined}
      />

      <div>
        <h1 className="text-2xl font-semibold tracking-normal text-foreground">{boardMeta.title}</h1>
        {isCeoBoard ? (
          <p className="mt-1 text-sm text-muted-foreground">
            Read the eight questions below in order. Every number carries its red line and the time it was read.
          </p>
        ) : null}
      </div>

      {isCeoBoard ? (
        <ReadingOrderStrip
          statuses={readingOrderStatuses}
          metrics={readingOrderMetrics}
        />
      ) : null}

      {BoardComponent && board ? (
        <BoardComponent companyId={selectedCompanyId} period={period} />
      ) : (
        <BoardPlaceholder title={boardMeta.title} />
      )}
    </div>
  );
}
