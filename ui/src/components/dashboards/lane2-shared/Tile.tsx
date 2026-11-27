import { CircleDashed, PlugZap, Unplug } from "lucide-react";
import { reconcileTileValue, type DashboardSource, type DashboardTile, type DashboardTileValueKind } from "@paperclipai/shared";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatTileValue } from "./formatTileValue";
import { NotConnected } from "./NotConnected";

interface TileProps {
  tile: DashboardTile;
  sources: DashboardSource[];
}

const BADGE: Record<Exclude<DashboardTileValueKind, "live">, { label: string; Icon: typeof PlugZap }> = {
  not_connected: { label: "Not connected", Icon: PlugZap },
  no_data: { label: "No data yet", Icon: CircleDashed },
  not_mapped: { label: "Not mapped yet", Icon: Unplug },
};

/**
 * One number with its owner and red line. A tile shows the live value, or
 * says honestly why it has none: its source is not connected (and what is
 * needed), the connected source has no data yet, or the series is not mapped.
 */
export function Tile({ tile, sources }: TileProps) {
  const tileSources = tile.sourceIds
    .map((id) => sources.find((source) => source.id === id))
    .filter((source): source is DashboardSource => Boolean(source));
  // The same source invariant the server applies, so a stale payload can
  // never show "Not connected" under a connected source.
  const value = reconcileTileValue(tile.value, tile.sourceIds, sources);
  const isLive = value.kind === "live";
  const badge = value.kind === "live" ? null : BADGE[value.kind];

  return (
    <Card
      elevation="low"
      className={cn("h-full gap-3 px-4 py-4 sm:px-5", value.kind === "not_connected" && "border-dashed")}
      data-testid={`dashboard-tile-${tile.id}`}
      data-connection-state={value.kind === "not_connected" ? "not-connected" : "connected"}
      data-tile-value={value.kind}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-foreground">{tile.label}</p>
        {isLive ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 text-(length:--text-micro) font-medium uppercase tracking-wide text-(--status-task-done)">
            <span aria-hidden className="size-1.5 rounded-full bg-(--status-task-done)" />
            Live
          </span>
        ) : badge ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 text-(length:--text-micro) font-medium uppercase tracking-wide text-muted-foreground">
            <badge.Icon aria-hidden className="size-3" />
            {badge.label}
          </span>
        ) : null}
      </div>

      <div>
        {value.kind === "live" ? (
          <p
            className="text-2xl font-semibold tracking-tight tabular-nums text-foreground sm:text-3xl"
            data-testid={`dashboard-tile-value-${tile.id}`}
          >
            {formatTileValue(value)}
          </p>
        ) : value.kind === "not_connected" ? (
          <NotConnected sources={tileSources.filter((source) => source.status !== "connected")} />
        ) : (
          <div className="space-y-1.5" data-testid={`dashboard-tile-${value.kind}`}>
            <p className="text-sm text-foreground">
              {value.kind === "no_data" ? "No data yet" : "Not mapped yet"}
            </p>
            <p className="text-xs text-muted-foreground">
              {value.kind === "no_data" ? value.reason : value.missing}
            </p>
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground/80">Source connected:</span>{" "}
              {tileSources.map((source) => source.name).join(", ")}
            </p>
          </div>
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
