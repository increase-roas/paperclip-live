import type { ReactNode } from "react";
import { AlertTriangle, PlugZap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { DashboardNotConnectedTile } from "@paperclipai/shared";

/**
 * Unified operating-board primitives aligned with `dashboards/Tile.tsx`,
 * `dashboards/NotConnected.tsx`, and semantic status tokens from `index.css`.
 */

const toneClasses = {
  default: "text-foreground",
  good: "text-(--status-task-done)",
  warning: "text-(--status-task-icon-todo)",
  danger: "text-(--status-task-blocked)",
} as const;

const toneDotClasses = {
  default: "bg-muted-foreground",
  good: "bg-(--status-task-done)",
  warning: "bg-(--status-task-todo)",
  danger: "bg-(--status-task-blocked)",
} as const;

const toneLabels = {
  default: "Live",
  good: "Healthy",
  warning: "Attention",
  danger: "Red line",
} as const;

export type BoardTileTone = keyof typeof toneClasses;

export function BoardTile({
  label,
  value,
  detail,
  tone = "default",
  notConnected,
  testId,
}: {
  label: string;
  value?: ReactNode;
  detail?: ReactNode;
  tone?: BoardTileTone;
  notConnected?: DashboardNotConnectedTile;
  testId?: string;
}) {
  return (
    <Card
      elevation="low"
      className={cn("h-full gap-3 px-4 py-4 sm:px-5", notConnected && "border-dashed")}
      data-testid={testId}
      data-connection-state={notConnected ? "not-connected" : "connected"}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {notConnected ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 text-(length:--text-micro) font-medium uppercase tracking-wide text-muted-foreground">
            <PlugZap aria-hidden className="size-3" />
            Not connected
          </span>
        ) : (
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 text-(length:--text-micro) font-medium uppercase tracking-wide",
              tone === "default" ? "text-muted-foreground" : toneClasses[tone],
            )}
          >
            <span aria-hidden className={cn("size-1.5 rounded-full", toneDotClasses[tone])} />
            {toneLabels[tone]}
          </span>
        )}
      </div>

      {notConnected ? (
        <div className="space-y-1.5">
          <p className="text-sm text-foreground">
            Not connected: {notConnected.source}
          </p>
          <p className="text-xs text-muted-foreground">{notConnected.reason}</p>
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground/80">Needed:</span> {notConnected.needed}
          </p>
        </div>
      ) : (
        <>
          <p
            className={cn(
              "text-2xl font-semibold tabular-nums tracking-tight sm:text-3xl",
              toneClasses[tone],
            )}
          >
            {value ?? "—"}
          </p>
          {detail ? <div className="mt-auto text-xs text-muted-foreground">{detail}</div> : null}
        </>
      )}
    </Card>
  );
}

export function BoardSection({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {title}
          </h2>
          {description ? <p className="mt-1 text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

/**
 * Concise board subheader aligned beneath `DashboardShell`'s single page `<h1>`.
 */
export function BoardHeader({
  description,
  generatedAt,
  actions,
}: {
  title?: string;
  description: string;
  generatedAt: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <p className="max-w-3xl text-sm text-muted-foreground">{description}</p>
      <div className="flex shrink-0 items-center gap-3">
        {actions}
        <p className="text-xs tabular-nums text-muted-foreground">Updated {formatDateTime(generatedAt)}</p>
      </div>
    </div>
  );
}

export function StatusBadge({ status, tone }: { status: string; tone?: BoardTileTone }) {
  if (tone === "danger") {
    return <Badge variant="destructive">{status}</Badge>;
  }
  if (tone === "good") {
    return (
      <Badge variant="outline" className="border-(--status-task-done)/40 text-(--status-task-done)">
        {status}
      </Badge>
    );
  }
  if (tone === "warning") {
    return (
      <Badge variant="outline" className="border-(--status-task-todo)/40 text-(--status-task-icon-todo)">
        {status}
      </Badge>
    );
  }
  return <Badge variant="secondary">{status}</Badge>;
}

export function BoardEmpty({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
      {message}
    </div>
  );
}

export function NotConnectedNote({ tile }: { tile: DashboardNotConnectedTile }) {
  return (
    <div className="flex gap-2 rounded-lg border border-dashed border-border bg-muted/40 p-3">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-xs font-semibold text-foreground">Not connected: {tile.source}</p>
        <p className="text-xs text-muted-foreground">{tile.reason}</p>
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground/80">Needed:</span> {tile.needed}
        </p>
      </div>
    </div>
  );
}

export function formatCentsOrDash(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatPercentOrDash(percent: number | null | undefined): string {
  if (percent === null || percent === undefined) return "—";
  return `${percent.toFixed(percent >= 100 ? 0 : 1)}%`;
}

export function formatHoursOrDash(hours: number | null | undefined): string {
  if (hours === null || hours === undefined) return "—";
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}
