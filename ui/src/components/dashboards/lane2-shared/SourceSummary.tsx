import type { DashboardSource } from "@paperclipai/shared";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface SourceSummaryProps {
  sources: DashboardSource[];
}

/** Why each source is missing, in one place above the tiles. */
export function SourceSummary({ sources }: SourceSummaryProps) {
  return (
    <Card elevation="low" className="gap-3 px-4 py-4 sm:px-5" data-testid="dashboard-sources">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Sources</h2>
      <ul className="space-y-3">
        {sources.map((source) => {
          const connected = source.status === "connected";
          return (
            <li key={source.id}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-foreground">{source.name}</span>
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 text-(length:--text-micro) font-medium uppercase tracking-wide",
                    connected ? "text-(--status-task-done)" : "text-muted-foreground",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "size-1.5 rounded-full",
                      connected ? "bg-(--status-task-done)" : "bg-muted-foreground",
                    )}
                  />
                  {connected ? "Connected" : "Not connected"}
                </span>
                {connected && source.lastSuccessfulSync ? (
                  <span className="text-xs tabular-nums text-muted-foreground">
                    Last successful sync {source.lastSuccessfulSync}
                  </span>
                ) : null}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{source.detail}</p>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
