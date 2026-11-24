import type { ReactNode } from "react";
import { AlertTriangle, PlugZap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { DashboardNotConnectedTile } from "@paperclipai/shared";

/**
 * Minimal lane-local tile and section primitives. Lane 1 owns the shared shell;
 * these exist so every Lane 3 board renders a real value or an explicit
 * "Not connected" state without waiting on the shared components.
 */

const toneClasses = {
  default: "text-foreground",
  good: "text-emerald-600 dark:text-emerald-400",
  warning: "text-amber-600 dark:text-amber-400",
  danger: "text-destructive",
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
    <Card className="gap-2 p-4" data-testid={testId}>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      {notConnected ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <PlugZap className="h-4 w-4 shrink-0 text-muted-foreground" />
            <p className="text-sm font-semibold text-muted-foreground">
              Not connected: {notConnected.source}
            </p>
          </div>
          <p className="text-xs text-muted-foreground">{notConnected.reason}</p>
          <p className="text-xs text-muted-foreground/80">Needed: {notConnected.needed}</p>
        </div>
      ) : (
        <>
          <p className={cn("text-2xl font-semibold tabular-nums tracking-tight", toneClasses[tone])}>
            {value ?? "—"}
          </p>
          {detail ? <div className="text-xs text-muted-foreground">{detail}</div> : null}
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
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          {description ? <p className="mt-1 text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function BoardHeader({
  title,
  description,
  generatedAt,
}: {
  title: string;
  description: string;
  generatedAt: string;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-2">
      <div>
        <h1 className="text-lg font-semibold text-foreground">{title}</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>
      </div>
      <p className="text-xs text-muted-foreground">Updated {formatDateTime(generatedAt)}</p>
    </div>
  );
}

export function StatusBadge({ status, tone }: { status: string; tone?: BoardTileTone }) {
  const variant = tone === "danger" ? "destructive" : tone === "warning" ? "outline" : "secondary";
  return <Badge variant={variant}>{status}</Badge>;
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
    <div className="flex gap-2 rounded-lg border border-border bg-muted/40 p-3">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-xs font-semibold text-foreground">Not connected: {tile.source}</p>
        <p className="text-xs text-muted-foreground">{tile.reason}</p>
        <p className="text-xs text-muted-foreground/80">Needed: {tile.needed}</p>
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
