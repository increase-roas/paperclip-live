import type { DashboardSource } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";

interface SourceSummaryProps {
  sources: DashboardSource[];
}

/** Why each source is missing, in one place above the tiles. */
export function SourceSummary({ sources }: SourceSummaryProps) {
  return (
    <section className="rounded-lg border bg-card p-4" data-testid="dashboard-sources">
      <h2 className="text-sm font-semibold text-foreground">Sources</h2>
      <ul className="mt-3 space-y-3">
        {sources.map((source) => (
          <li key={source.id}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-foreground">{source.name}</span>
              <Badge variant="outline">
                {source.status === "connected" ? "Connected" : "Not connected"}
              </Badge>
              {source.status === "connected" && source.lastSuccessfulSync ? (
                <span className="text-xs text-muted-foreground">
                  Last successful sync {source.lastSuccessfulSync}
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{source.detail}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
