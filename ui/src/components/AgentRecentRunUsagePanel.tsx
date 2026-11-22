import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, Coins, DollarSign } from "lucide-react";
import { heartbeatsApi } from "@/api/heartbeats";
import { EmptyState } from "@/components/EmptyState";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { StatusBadge } from "@/components/StatusBadge";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { recentAgentRunUsage } from "@/lib/agent-run-usage";
import { formatCents, formatTokens, relativeTime } from "@/lib/utils";

const RUN_LIMIT = 200;
const DISPLAY_LIMIT = 20;

/** Last seven days of recorded per-run tokens and cost for one agent. */
export function AgentRecentRunUsagePanel({ agentId, agentName, companyId }: {
  agentId: string;
  agentName: string;
  companyId: string;
}) {
  const runs = useQuery({
    queryKey: [...queryKeys.heartbeats(companyId, agentId), "usage-7d"],
    queryFn: () => heartbeatsApi.list(companyId, agentId, RUN_LIMIT, { summary: true }),
    refetchInterval: 30_000,
  });
  const view = useQueryView(runs);
  const usage = useMemo(() => recentAgentRunUsage(runs.data, Date.now(), 7, DISPLAY_LIMIT), [runs.data]);
  return (
    <section aria-labelledby="agent-run-usage-heading" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 id="agent-run-usage-heading" className="text-sm font-medium text-foreground">Recent runs · last 7 days</h3>
          <p className="text-xs text-muted-foreground">Tokens and cost recorded for each run. Subscription runs show as included.</p>
        </div>
        {view.kind === "ready" || view.kind === "stale" ? (
          <span className="text-xs text-muted-foreground">{usage.runCount} {usage.runCount === 1 ? "run" : "runs"}</span>
        ) : null}
      </div>
      {view.kind === "loading" || view.kind === "reconnecting" ? (
        <p role="status" className="text-sm text-muted-foreground">Loading recent runs…</p>
      ) : view.kind === "error" ? (
        <QueryErrorState size="inline" error={view.error} action="load recent runs" onRetry={view.retry} retrying={view.isFetching} />
      ) : usage.runCount === 0 ? (
        <EmptyState icon={Activity} message={`No runs for ${agentName} in the last 7 days.`} />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-border p-3">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><Coins className="size-3.5" aria-hidden />Tokens</div>
              <div className="mt-1 font-mono text-lg tabular-nums text-foreground">{formatTokens(usage.totalTokens)}</div>
              <div className="text-xs text-muted-foreground">
                in {formatTokens(usage.inputTokens)}{usage.cachedInputTokens > 0 ? ` (+${formatTokens(usage.cachedInputTokens)} cached)` : ""} · out {formatTokens(usage.outputTokens)}
              </div>
            </div>
            <div className="rounded-lg border border-border p-3">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><DollarSign className="size-3.5" aria-hidden />Cost</div>
              <div className="mt-1 font-mono text-lg tabular-nums text-foreground">{formatCents(usage.reportedCostCents)}</div>
              <div className="text-xs text-muted-foreground">
                {usage.reportedCostRuns} of {usage.runCount} runs with a reported cost
              </div>
            </div>
            <div className="rounded-lg border border-border p-3">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><Activity className="size-3.5" aria-hidden />Runs</div>
              <div className="mt-1 font-mono text-lg tabular-nums text-foreground">{usage.runCount}</div>
              <div className="text-xs text-muted-foreground">Latest {Math.min(usage.runCount, DISPLAY_LIMIT)} listed below</div>
            </div>
          </div>
          <ul className="divide-y divide-border rounded-lg border border-border" aria-label="Recent run usage">
            {usage.rows.map((row) => (
              <li key={row.id}>
                <Link
                  to={`/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(row.id)}`}
                  className="flex flex-col gap-2 px-4 py-3 text-inherit no-underline transition-colors hover:bg-muted/50 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <StatusBadge status={row.status} />
                    <span className="font-mono text-xs text-muted-foreground">{row.id.slice(0, 8)}</span>
                    <span className="text-xs text-muted-foreground">{relativeTime(row.createdAt)}</span>
                  </div>
                  <div className="text-xs tabular-nums text-muted-foreground sm:text-right">
                    <div className="text-foreground">
                      {row.hasUsage
                        ? <>in {formatTokens(row.inputTokens)}{row.cachedInputTokens > 0 ? ` (+${formatTokens(row.cachedInputTokens)} cached)` : ""} · out {formatTokens(row.outputTokens)}</>
                        : "Tokens not reported"}
                    </div>
                    <div>
                      {row.costKind === "reported" ? formatCents(row.costCents ?? 0)
                        : row.costKind === "included" ? "Included"
                          : row.costKind === "unpriced" ? "Unpriced"
                            : "Cost not reported"}
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          {usage.runCount > usage.rows.length ? (
            <p className="text-xs text-muted-foreground">
              Showing the latest {usage.rows.length} of {usage.runCount} runs from the last 7 days.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
