import { AlertTriangle, Loader2, RotateCw, ShieldOff } from "lucide-react";
import type { ExecutionBlocker } from "@paperclipai/shared";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

function causeLabel(cause: string) {
  return cause.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

/**
 * Names the real execution hold on the task and gives the board one action
 * that clears a provably-safe hold and resumes the task. Unknown outcomes stay
 * behind the evidence-based reconciliation card; this surface never guesses.
 */
export function ExecutionHoldNotice({
  hold,
  canClearHold,
  onClearHold,
  clearHoldPending = false,
  onRetry,
  retryPending = false,
  error = null,
  className,
}: {
  hold: ExecutionBlocker | null | undefined;
  canClearHold: boolean;
  onClearHold: () => void;
  clearHoldPending?: boolean;
  onRetry?: () => void;
  retryPending?: boolean;
  error?: string | null;
  className?: string;
}) {
  if (!hold || hold.workspaceRepairRequired) return null;
  const isHold = Boolean(hold.recoveryActionId)
    || hold.cause === "legacy_execution_requires_reconciliation"
    || hold.cause === "execution_owner_active";
  if (!isHold) return null;
  const showClear = canClearHold && Boolean(hold.recoveryActionId);
  const showRetry = Boolean(onRetry) && hold.canRetry === true;

  return (
    <section
      role="status"
      aria-label="Execution hold"
      data-testid="execution-hold-notice"
      data-hold-cause={hold.cause}
      className={cn(
        "rounded-md border border-amber-300/70 bg-amber-50/90 px-3 py-2.5 text-sm text-amber-950 shadow-sm dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100",
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" aria-hidden />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="space-y-0.5">
            <p className="font-medium leading-5">This task is on an execution hold.</p>
            <p className="text-xs font-medium uppercase tracking-wide text-amber-900/80 dark:text-amber-100/80">
              {causeLabel(hold.cause)}
            </p>
            <p className="leading-5">{hold.nextAction}</p>
            {hold.runError ? (
              <p className="text-xs leading-5 text-amber-900/80 dark:text-amber-100/80">
                Recorded stop reason: {hold.runError}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {showRetry ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={retryPending}
                onClick={onRetry}
                data-testid="execution-hold-retry"
              >
                {retryPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <RotateCw className="h-3.5 w-3.5" aria-hidden />
                )}
                Retry
              </Button>
            ) : null}
            {showClear ? (
              <Button
                type="button"
                size="sm"
                disabled={clearHoldPending}
                onClick={onClearHold}
                title="Clear a hold whose recorded run never started, then resume the task"
                data-testid="execution-hold-clear"
              >
                {clearHoldPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <ShieldOff className="h-3.5 w-3.5" aria-hidden />
                )}
                Clear hold &amp; retry
              </Button>
            ) : null}
            {!showClear && !showRetry ? (
              <p className="text-xs text-amber-900/80 dark:text-amber-100/80">
                Review the run evidence in the recovery card before continuing.
              </p>
            ) : null}
          </div>
          {error ? (
            <p role="alert" className="text-xs font-medium text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
