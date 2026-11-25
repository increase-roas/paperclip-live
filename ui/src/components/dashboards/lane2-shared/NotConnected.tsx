import type { DashboardSource } from "@paperclipai/shared";

interface NotConnectedProps {
  /** The missing sources, already resolved from the board payload. */
  sources: DashboardSource[];
}

/**
 * The explicit missing state. It never renders a placeholder number: it names
 * each source and states exactly what a person must provide to connect it.
 */
export function NotConnected({ sources }: NotConnectedProps) {
  if (sources.length === 0) {
    return <p className="text-sm text-muted-foreground">No data source is assigned to this number.</p>;
  }

  return (
    <div className="space-y-1.5" data-testid="not-connected">
      <p className="text-sm text-foreground">
        Not connected: {sources.map((source) => source.name).join(", ")}
      </p>
      {sources.map((source) => (
        <p key={source.id} className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground/80">Needed:</span> {source.needed}
        </p>
      ))}
    </div>
  );
}
