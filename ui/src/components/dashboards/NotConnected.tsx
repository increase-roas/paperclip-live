import { PlugZap } from "lucide-react";
import { Link } from "@/lib/router";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export interface NotConnectedProps {
  label: string;
  /** The exact system the number needs, e.g. "GHL appointments". */
  source: string;
  /** What has to exist before this tile can show a real value. */
  needs: string;
  /** The red line the tile will be judged against once it is wired. */
  target?: string;
  /** The period the tile will report once it is wired. */
  periodLabel?: string;
  /** Optional drill-down link to the owning board. */
  href?: string;
  testId?: string;
}

/**
 * The honest alternative to a made-up number.
 *
 * DASHBOARD-SPEC.md §11 lists the pipes that do not exist yet. Until one of
 * them lands, a tile names the source it is waiting on, says what is needed,
 * and shows no value at all.
 */
export function NotConnected({
  label,
  source,
  needs,
  target,
  periodLabel,
  href,
  testId,
}: NotConnectedProps) {
  const body = (
    <Card
      elevation="low"
      data-testid={testId}
      data-connection-state="not-connected"
      className={cn(
        "h-full gap-3 border-dashed px-4 py-4 sm:px-5",
        href && "transition-colors hover:border-foreground/30",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <span className="inline-flex shrink-0 items-center gap-1.5 text-(length:--text-micro) font-medium uppercase tracking-wide text-muted-foreground">
          <PlugZap aria-hidden className="size-3" />
          Not connected
        </span>
      </div>

      <p className="text-sm text-foreground">Not connected: {source}</p>

      {periodLabel ? <p className="text-xs text-muted-foreground">{periodLabel}</p> : null}

      <p className="text-xs text-muted-foreground">{needs}</p>

      {target ? (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground/80">Red line:</span> {target}
        </p>
      ) : null}

      <p className="mt-auto border-t border-border pt-2 text-(length:--text-micro) text-muted-foreground">
        No number is shown until this source is wired.
      </p>
    </Card>
  );

  if (!href) return body;
  return (
    <Link to={href} className="block h-full no-underline text-inherit">
      {body}
    </Link>
  );
}
