import type { ReactNode } from "react";
import { LayoutDashboard } from "lucide-react";
import type { DashboardBoardId } from "@paperclipai/shared";
import type { DashboardBoardWithMeta } from "@/api/dashboardBoards";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/EmptyState";
import type { DashboardPeriod } from "../period";
import { useDashboardBoard } from "./useDashboardBoard";

interface DashboardBoardShellProps {
  board: DashboardBoardId;
  title: string;
  /** Supplied by the dashboard shell. Falls back to the selected company. */
  companyId?: string;
  /** Supplied by the dashboard shell (`7d` / `30d` / `month`). */
  period?: DashboardPeriod;
  children: (data: DashboardBoardWithMeta, refetch: () => Promise<unknown>) => ReactNode;
}

/**
 * Company selection, loading and failure states around a board. The board
 * itself renders only from a loaded payload, so it cannot draw a number while
 * the read is pending or failed.
 */
export function DashboardBoardShell({
  board,
  title,
  companyId,
  period,
  children,
}: DashboardBoardShellProps) {
  const { companyId: activeCompanyId, data, isLoading, error, refetch } = useDashboardBoard(
    board,
    companyId,
    period,
  );

  if (!activeCompanyId) {
    return (
      <EmptyState
        icon={LayoutDashboard}
        message={`Select an organization to view the ${title} board.`}
      />
    );
  }

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading the {title} board…</p>;
  }

  if (error && !data) {
    return (
      <Card elevation="low" className="gap-3 px-4 py-4 sm:px-5">
        <p className="text-sm font-medium text-foreground">
          Could not load the {title} board.
        </p>
        <p className="text-xs text-muted-foreground">
          {error instanceof Error ? error.message : "The request failed."}
        </p>
        <div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void refetch();
            }}
          >
            Retry
          </Button>
        </div>
      </Card>
    );
  }

  if (!data) return null;

  // A failed refresh keeps the last loaded board on screen and says so,
  // instead of replacing readable numbers with an error page.
  return (
    <>
      {error ? (
        <p className="mb-3 text-xs text-muted-foreground">
          Showing the last loaded board. Refresh failed:{" "}
          {error instanceof Error ? error.message : "unknown error"}.
        </p>
      ) : null}
      {children(data, () => refetch())}
    </>
  );
}
