import { Button } from "@/components/ui/button";
import { describeError } from "@/api/errors";

/** Retry panel shared by the agent list and its production variant. */
export function OrgChartErrorPanel({
  error,
  retrying,
  onRetry,
  onSwitchToList,
}: {
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
  onSwitchToList: () => void;
}) {
  return (
    <div role="alert" className="mx-auto max-w-md space-y-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-center">
      <p className="text-sm font-medium text-foreground">Could not load the org chart.</p>
      <p className="text-xs text-muted-foreground">
        {describeError(error, { action: "load the org chart" }).body}
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button size="sm" onClick={onRetry} disabled={retrying}>
          {retrying ? "Retrying…" : "Retry"}
        </Button>
        <Button size="sm" variant="outline" onClick={onSwitchToList}>
          Switch to list
        </Button>
      </div>
    </div>
  );
}
