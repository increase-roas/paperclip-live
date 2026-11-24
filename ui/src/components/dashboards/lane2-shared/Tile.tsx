import type { DashboardSource, DashboardTile } from "@paperclipai/shared";
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

  return (
    <div
      className="flex h-full flex-col rounded-lg border bg-card p-4"
      data-testid={`dashboard-tile-${tile.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-sm font-medium text-foreground">{tile.label}</p>
        <p className="text-xs text-muted-foreground">Owner: {tile.owner}</p>
      </div>

      <div className="mt-3">
        {tile.value.kind === "live" ? (
          <p
            className="text-2xl font-semibold tracking-tight tabular-nums text-foreground"
            data-testid={`dashboard-tile-value-${tile.id}`}
          >
            {formatTileValue(tile.value)}
          </p>
        ) : (
          <NotConnected sources={tileSources} />
        )}
      </div>

      <p className="mt-3 text-xs text-muted-foreground">{tile.definition}</p>
      <p className="mt-1 text-xs text-muted-foreground">Red line: {tile.target}</p>
    </div>
  );
}
