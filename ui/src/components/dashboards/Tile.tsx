import type { ReactNode } from "react";
import { Link } from "@/lib/router";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/timeAgo";

/**
 * Green or red, no amber (DASHBOARD-SPEC.md §1, EOS <15-Number Rule). A tile
 * whose source cannot answer yet says so with `unknown` rather than guessing a
 * colour, and it never shows a number it does not have.
 */
export type TileState = "ok" | "red" | "unknown";

export interface TileProps {
  label: string;
  /** Pre-formatted by the caller; the tile never invents a unit. */
  value: ReactNode;
  /** The period the value covers ("Last 30 days"). */
  periodLabel: string;
  /** The red line this number is judged against, in plain words. */
  redLine?: string;
  state?: TileState;
  /** Where the number came from, shown on every tile. */
  source: string;
  /** When the source was last read. Rendered as "read 2m ago". */
  readAt?: Date | string | number | null;
  note?: ReactNode;
  /** Optional drill-down; the tile keeps its layout inside the link. */
  href?: string;
  testId?: string;
}

const STATE_COPY: Record<TileState, string> = {
  ok: "On target",
  red: "Red line",
  unknown: "No red line",
};

const STATE_CLASS: Record<TileState, string> = {
  ok: "text-(--status-task-done)",
  red: "text-(--status-task-blocked)",
  unknown: "text-muted-foreground",
};

const STATE_DOT_CLASS: Record<TileState, string> = {
  ok: "bg-(--status-task-done)",
  red: "bg-(--status-task-blocked)",
  unknown: "bg-muted-foreground",
};

export function readAtLabel(readAt: Date | string | number | null | undefined): string {
  if (readAt === null || readAt === undefined) return "not read yet";
  const date = new Date(readAt);
  if (Number.isNaN(date.getTime())) return "read time unknown";
  return `read ${timeAgo(date)}`;
}

export function Tile({
  label,
  value,
  periodLabel,
  redLine,
  state = "unknown",
  source,
  readAt,
  note,
  href,
  testId,
}: TileProps) {
  const body = (
    <Card
      elevation="low"
      data-testid={testId}
      data-tile-state={state}
      className={cn("h-full gap-3 px-4 py-4 sm:px-5", href && "transition-colors hover:border-foreground/20")}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <span className={cn("inline-flex shrink-0 items-center gap-1.5 text-(length:--text-micro) font-medium uppercase tracking-wide", STATE_CLASS[state])}>
          <span aria-hidden className={cn("size-1.5 rounded-full", STATE_DOT_CLASS[state])} />
          {STATE_COPY[state]}
        </span>
      </div>

      <div>
        <p className="text-2xl font-semibold tracking-tight tabular-nums text-foreground sm:text-3xl">{value}</p>
        <p className="mt-1 text-xs text-muted-foreground">{periodLabel}</p>
      </div>

      {redLine ? (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground/80">Red line:</span> {redLine}
        </p>
      ) : null}

      {note ? <div className="text-xs text-muted-foreground">{note}</div> : null}

      <div className="mt-auto space-y-0.5 border-t border-border pt-2 text-(length:--text-micro) text-muted-foreground">
        <p>Source: {source}</p>
        <p>{readAtLabel(readAt)}</p>
      </div>
    </Card>
  );

  if (!href) return body;
  return (
    <Link to={href} className="block h-full no-underline text-inherit">
      {body}
    </Link>
  );
}
