import type { ReactNode } from "react";
import type { DashboardBoard } from "@paperclipai/shared";
import { SourceSummary } from "./SourceSummary";

interface BoardFrameProps {
  title?: string;
  subtitle: string;
  data: DashboardBoard;
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * Common layout frame for Lane 2 operating boards.
 * `DashboardShell` owns the single page `<h1>`; this frame renders the board
 * subtitle, freshness timestamp, optional header actions, and source states.
 */
export function BoardFrame({ subtitle, data, actions, children }: BoardFrameProps) {
  const generatedAt = new Date(data.generatedAt).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  return (
    <div className="space-y-6" data-testid={`dashboard-board-${data.board}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-3xl text-sm text-muted-foreground">{subtitle}</p>
        <div className="flex shrink-0 items-center gap-3">
          {actions}
          <p className="text-xs tabular-nums text-muted-foreground">Updated {generatedAt}</p>
        </div>
      </div>

      <SourceSummary sources={data.sources} />

      {children}
    </div>
  );
}
