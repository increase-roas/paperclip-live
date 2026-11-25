import { PlugZap } from "lucide-react";
import type { DashboardSource, DashboardTile } from "@paperclipai/shared";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatTileValue } from "./formatTileValue";
import { NotConnected } from "./NotConnected";

interface TileProps {
  tile: DashboardTile;
  sources: DashboardSource[];
}

/**
 * One number with its owner and red line. A tile shows either the live value
 * or the NotConnected state; there is no neutral placeholder.
 */
export function Tile({ tile, sources }: TileProps) {
  const tileSources = tile.sourceIds
    .map((id) => sources.find((source) => source.id === id))
    .filter((source): source is DashboardSource => Boolean(source));
  const isLive = tile.value.kind === "live";

  return (
    <Card
      elevation="low"
      className={cn("h-full gap-3 px-4 py-4 sm:px-5", !isLive && "border-dashed")}
      data-testid={`dashboard-tile-${tile.id}`}
      data-connection-state={isLive ? "connected" : "not-connected"}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-foreground">{tile.label}</p>
        {isLive ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 text-(length:--text-micro) font-medium uppercase tracking-wide text-(--status-task-done)">
            <span aria-hidden className="size-1.5 rounded-full bg-(--status-task-done)" />
            Live
          </span>
        ) : (
          <span className="inline-flex shrink-0 items-center gap-1.5 text-(length:--text-micro) font-medium uppercase tracking-wide text-muted-foreground">
            <PlugZap aria-hidden className="size-3" />
            Not connected
          </span>
        )}
      </div>

      <div>
        {tile.value.kind === "live" ? (
          <p
            className="text-2xl font-semibold tracking-tight tabular-nums text-foreground sm:text-3xl"
            data-testid={`dashboard-tile-value-${tile.id}`}
          >
            {formatTileValue(tile.value)}
          </p>
        ) : (
          <NotConnected sources={tileSources} />
        )}
      </div>

      <p className="text-xs text-muted-foreground">{tile.definition}</p>

      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground/80">Red line:</span> {tile.target}
      </p>

      <div className="mt-auto border-t border-border pt-2 text-(length:--text-micro) text-muted-foreground">
        <p>Owner: {tile.owner}</p>
      </div>
    </Card>
  );
}
