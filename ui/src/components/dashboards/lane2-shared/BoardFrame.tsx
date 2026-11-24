import type { ReactNode } from "react";
import type { DashboardBoard } from "@paperclipai/shared";
import { SourceSummary } from "./SourceSummary";

interface BoardFrameProps {
  title: string;
  subtitle: string;
  data: DashboardBoard;
  children: ReactNode;
}

/** Common shell for one board: title, freshness, and the source states. */
export function BoardFrame({ title, subtitle, data, children }: BoardFrameProps) {
  const generatedAt = new Date(data.generatedAt).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  return (
    <div className="space-y-6" data-testid={`dashboard-board-${data.board}`}>
      <header>
        <h1 className="text-2xl font-semibold tracking-normal text-foreground">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
        <p className="mt-1 text-xs text-muted-foreground">Built {generatedAt}</p>
      </header>

      <SourceSummary sources={data.sources} />

      {children}
    </div>
  );
}
