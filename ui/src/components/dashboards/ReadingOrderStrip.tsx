import { Link } from "@/lib/router";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { ReadingOrderMetric, ReadingOrderMetricMap } from "@/api/dashboardBoards";
import {
  READING_ORDER_STEPS,
  firstAttentionStepId,
  stepStatus,
  type ReadingOrderStatusMap,
} from "./reading-order";
import type { TileState } from "./Tile";

const STATE_COPY: Record<TileState, string> = {
  ok: "Green",
  red: "Red",
  unknown: "Grey",
};

const STATE_TEXT_CLASS: Record<TileState, string> = {
  ok: "text-(--status-task-done)",
  red: "text-(--status-task-blocked)",
  unknown: "text-muted-foreground",
};

const STATE_DOT_CLASS: Record<TileState, string> = {
  ok: "bg-(--status-task-done)",
  red: "bg-(--status-task-blocked)",
  unknown: "bg-muted-foreground",
};

function formatStepMetric(metric: string | ReadingOrderMetric | null | undefined): string | null {
  if (metric === null || metric === undefined) return null;
  if (typeof metric === "string") {
    const trimmed = metric.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  const displayValue = metric.displayValue?.trim();
  if (displayValue) return displayValue;
  const formatted = metric.formatted?.trim();
  if (formatted) return formatted;
  if (typeof metric.value === "number" && Number.isFinite(metric.value)) {
    return String(metric.value);
  }
  if (typeof metric.value === "string" && metric.value.trim().length > 0) {
    return metric.value.trim();
  }
  return null;
}

export interface ReadingOrderStripProps {
  /**
   * Live status per question. Steps without a status render grey, which is the
   * honest answer while their source is not connected. The strip still works
   * with every step grey: the first one is highlighted as the place to start.
   */
  statuses?: ReadingOrderStatusMap;
  /** Optional formatted live metric per step, rendered when connected. */
  metrics?: ReadingOrderMetricMap;
  testId?: string;
}

/**
 * Spec v2 §1 — the headline deliverable: eight questions, read top to bottom,
 * stop at the first red. A grey question is not a pass; it is a number whose
 * source is not connected yet, so the first grey is also where the reader
 * stops.
 */
export function ReadingOrderStrip({
  statuses = {},
  metrics = {},
  testId = "dashboard-reading-order",
}: ReadingOrderStripProps) {
  const attentionId = firstAttentionStepId(statuses);
  const allGreen = attentionId === null;
  const attentionIsUnknown = attentionId !== null && stepStatus(statuses, attentionId) === "unknown";

  return (
    <Card elevation="low" data-testid={testId} className="gap-3 px-4 py-4 sm:px-5">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Read in this order
        </h2>
        <p className="text-xs text-muted-foreground">
          Top to bottom. Stop at the first red. Grey means no source is connected yet.
        </p>
      </div>

      <ol className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {READING_ORDER_STEPS.map((step, index) => {
          const state = stepStatus(statuses, step.id);
          const attention = step.id === attentionId;
          const liveValue = formatStepMetric(metrics[step.id]);
          return (
            <li
              key={step.id}
              data-reading-order-step={step.id}
              data-question={step.question}
              data-state={state}
              data-attention={attention ? "true" : undefined}
              aria-current={attention ? "step" : undefined}
              className={cn(
                "rounded-md border transition-colors hover:border-foreground/30 hover:bg-accent/40",
                attention ? "border-foreground/40 bg-muted/60" : "border-border",
                attention && state === "red" && "border-(--status-task-blocked)",
              )}
            >
              <Link
                to={step.href}
                className="flex h-full flex-col rounded-md px-3 py-2 text-inherit no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-(length:--text-micro) font-medium tabular-nums text-muted-foreground">
                    {index + 1}
                  </span>
                  <span
                    className={cn(
                      "inline-flex items-center gap-1.5 text-(length:--text-micro) font-medium uppercase tracking-wide",
                      STATE_TEXT_CLASS[state],
                    )}
                  >
                    <span aria-hidden className={cn("size-1.5 rounded-full", STATE_DOT_CLASS[state])} />
                    {STATE_COPY[state]}
                  </span>
                </div>
                <p className="mt-1 text-sm font-medium text-foreground">{step.question}</p>
                {liveValue ? (
                  <p
                    className="mt-1 text-base font-semibold tabular-nums tracking-tight text-foreground"
                    data-reading-order-metric={step.id}
                  >
                    {liveValue}
                  </p>
                ) : null}
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {step.number} · {step.board}
                </p>
                {attention ? (
                  <p className={cn("mt-auto pt-1 text-(length:--text-micro) font-medium", STATE_TEXT_CLASS[state])}>
                    {state === "unknown"
                      ? "Start here: no source connected"
                      : "Stop here: below its red line"}
                  </p>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ol>

      <p className="text-xs text-muted-foreground" data-testid="dashboard-reading-order-summary">
        {allGreen
          ? "All eight green. Read the constraint, not the list."
          : attentionIsUnknown
            ? "The first unanswered question is the first number to connect."
            : "Stop at the first red and fix that number before reading on."}
      </p>
    </Card>
  );
}
