import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import type {
  DashboardAutomationHealthBoard,
  DashboardAutomationSeat,
} from "@paperclipai/shared";
import { dashboardBoardsApi } from "@/api/dashboardBoards";
import { QueryView } from "@/components/QueryView";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { useCompany } from "@/context/CompanyContext";
import {
  BoardEmpty,
  BoardHeader,
  BoardSection,
  BoardTile,
  NotConnectedNote,
  StatusBadge,
  formatDateTime,
  formatHoursOrDash,
  formatPercentOrDash,
} from "@/components/dashboards/lane3-shared/BoardPrimitives";

function seatStatusTone(seat: DashboardAutomationSeat): "danger" | "warning" | "default" | "good" {
  if (seat.status === "error") return "danger";
  if (seat.status === "paused") return "warning";
  if (seat.status === "running") return "good";
  return "default";
}

function HeartbeatCell({ seat }: { seat: DashboardAutomationSeat }) {
  if (!seat.heartbeatEnabled) {
    return <Badge variant="outline">Off</Badge>;
  }
  return (
    <div className="space-y-1">
      <Badge variant="secondary">On</Badge>
      <p className="text-xs text-muted-foreground">
        {seat.heartbeatIntervalSec !== null && seat.heartbeatIntervalSec > 0
          ? `Every ${Math.round(seat.heartbeatIntervalSec / 60)}m`
          : "No interval"}
      </p>
    </div>
  );
}

export function AutomationHealthBoard({ companyId: companyIdProp }: { companyId?: string } = {}) {
  const { selectedCompanyId } = useCompany();
  const companyId = companyIdProp ?? selectedCompanyId;

  const query = useQuery({
    queryKey: ["dashboard-boards", companyId, "automation-health"],
    queryFn: () => dashboardBoardsApi.automationHealth(companyId!),
    enabled: Boolean(companyId),
  });

  if (!companyId) {
    return <BoardEmpty message="Select a company to see automation health." />;
  }

  return (
    <QueryView query={query} action="load the automation health board">
      {(board: DashboardAutomationHealthBoard) => {
        const failures24h = board.seats.reduce(
          (sum, seat) => sum + seat.failedRuns24h + seat.timedOutRuns24h,
          0,
        );
        return (
          <div className="space-y-8">
            <BoardHeader
              title="Automation health"
              description="Whether the company is running without a human: agent status, failures, routines, blocked work, approval queue and the server itself."
              generatedAt={board.generatedAt}
            />

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
              <BoardTile
                label="Seats running"
                value={`${board.seatSummary.running} / ${board.seatSummary.total}`}
                detail={`${board.seatSummary.idle} idle · ${board.seatSummary.paused} paused`}
                testId="automation-seats"
              />
              <BoardTile
                label="Failed or timed-out runs, 24h"
                value={failures24h}
                detail={`${board.seatSummary.error} ${board.seatSummary.error === 1 ? "seat" : "seats"} in error`}
                tone={failures24h > 0 || board.seatSummary.error > 0 ? "danger" : "good"}
                testId="automation-failures"
              />
              <BoardTile
                label="Routine success rate, 7d"
                value={
                  board.routines.successRate7d === null
                    ? "—"
                    : formatPercentOrDash(board.routines.successRate7d)
                }
                detail={`${board.routines.completed7d} of ${board.routines.runs7d} runs completed`}
                tone={
                  board.routines.successRate7d === null
                    ? "default"
                    : board.routines.successRate7d < 80
                      ? "danger"
                      : "good"
                }
                testId="automation-routines"
              />
              <BoardTile
                label="Blocked for more than 24h"
                value={board.blockedTasks.count}
                detail={`Oldest ${formatHoursOrDash(board.blockedTasks.oldestAgeHours)}`}
                tone={board.blockedTasks.count > 0 ? "danger" : "good"}
                testId="automation-blocked"
              />
              <BoardTile
                label="Approvals waiting"
                value={board.approvals.pendingCount}
                detail={`Oldest waiting ${formatHoursOrDash(board.approvals.oldestAgeHours)}`}
                tone={
                  board.approvals.pendingCount > 0 && (board.approvals.oldestAgeHours ?? 0) > 24
                    ? "danger"
                    : board.approvals.pendingCount > 0
                      ? "warning"
                      : "good"
                }
                testId="automation-approvals"
              />
              <BoardTile
                label="Server"
                value={board.server.status === "ok" ? "Healthy" : "Degraded"}
                detail={
                  board.server.commit
                    ? `${board.server.version ?? "version unknown"} · ${board.server.commit.slice(0, 8)}`
                    : board.server.version ?? "Commit unknown"
                }
                tone={board.server.status === "ok" ? "good" : "danger"}
                testId="automation-server"
              />
              <BoardTile
                label="Database backup"
                {...(board.server.backup
                  ? {
                    value: board.server.backup.status === "ok" ? "OK" : "Warning",
                    detail: `Latest ${formatHoursOrDash(board.server.backup.ageHours)} old · limit ${board.server.backup.maxAgeHours ?? "—"}h`,
                    tone: board.server.backup.status === "ok" ? ("good" as const) : ("danger" as const),
                  }
                  : {
                    value: undefined,
                    notConnected: {
                      tile: "database-backup",
                      source: "Database backup",
                      reason: "Backup health is not enabled on this instance.",
                      needed: "Set the database backup directory and max age in the server config.",
                    },
                  })}
                testId="automation-backup"
              />
              <BoardTile
                label="Active routines"
                value={board.routines.active}
                detail={`${board.routines.total} ${board.routines.total === 1 ? "routine" : "routines"} configured`}
                testId="automation-active-routines"
              />
            </div>

            <BoardSection
              title="Agent seats"
              description="Heartbeat is the scheduler switch in the seat's runtime config. Failure counts are heartbeat runs, not routine runs."
            >
              <Card className="gap-0 overflow-x-auto p-0">
                <table className="w-full min-w-max text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-4 py-3 font-medium">Seat</th>
                      <th className="px-4 py-3 font-medium">Status</th>
                      <th className="px-4 py-3 font-medium">Heartbeat</th>
                      <th className="px-4 py-3 font-medium">Last run</th>
                      <th className="px-4 py-3 text-right font-medium">Failed 24h</th>
                      <th className="px-4 py-3 text-right font-medium">Timed out 24h</th>
                    </tr>
                  </thead>
                  <tbody>
                    {board.seats.map((seat) => (
                      <tr key={seat.agentId} className="border-b border-border/60 last:border-0">
                        <td className="px-4 py-3 font-medium">{seat.name}</td>
                        <td className="px-4 py-3">
                          <div className="space-y-1">
                            <StatusBadge status={seat.status} tone={seatStatusTone(seat)} />
                            {seat.errorReason ? (
                              <p className="max-w-xs text-xs text-destructive">{seat.errorReason}</p>
                            ) : null}
                          </div>
                        </td>
                        <td className="px-4 py-3"><HeartbeatCell seat={seat} /></td>
                        <td className="px-4 py-3">
                          {seat.lastRunAt ? (
                            <div className="space-y-1">
                              <p className="text-xs text-muted-foreground">{formatDateTime(seat.lastRunAt)}</p>
                              <StatusBadge
                                status={seat.lastRunStatus ?? "unknown"}
                                tone={
                                  seat.lastRunStatus === "failed" || seat.lastRunStatus === "timed_out"
                                    ? "danger"
                                    : "default"
                                }
                              />
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">No runs</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">{seat.failedRuns24h}</td>
                        <td className="px-4 py-3 text-right tabular-nums">{seat.timedOutRuns24h}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {board.seats.length === 0 ? (
                  <div className="p-6 text-sm text-muted-foreground">No agent seats yet.</div>
                ) : null}
              </Card>
            </BoardSection>

            <BoardSection title="Routines" description="Last result and seven-day success rate per scheduled job.">
              {board.routines.items.length === 0 ? (
                <BoardEmpty message="No routines configured. Nothing is on a schedule yet." />
              ) : (
                <Card className="gap-0 overflow-x-auto p-0">
                  <table className="w-full min-w-max text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="px-4 py-3 font-medium">Routine</th>
                        <th className="px-4 py-3 font-medium">Owner</th>
                        <th className="px-4 py-3 font-medium">Status</th>
                        <th className="px-4 py-3 font-medium">Last run</th>
                        <th className="px-4 py-3 font-medium">Last result</th>
                        <th className="px-4 py-3 text-right font-medium">7d success</th>
                      </tr>
                    </thead>
                    <tbody>
                      {board.routines.items.map((routine) => (
                        <tr key={routine.routineId} className="border-b border-border/60 last:border-0">
                          <td className="px-4 py-3 font-medium">{routine.title}</td>
                          <td className="px-4 py-3 text-muted-foreground">{routine.assigneeName ?? "Unassigned"}</td>
                          <td className="px-4 py-3"><StatusBadge status={routine.status} /></td>
                          <td className="px-4 py-3 text-xs text-muted-foreground">
                            {routine.lastRunAt ? formatDateTime(routine.lastRunAt) : "Never"}
                          </td>
                          <td className="px-4 py-3">
                            <StatusBadge
                              status={routine.lastRunResult ?? "No runs"}
                              tone={routine.lastRunStatus === "failed" ? "danger" : "default"}
                            />
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums">
                            {routine.successRate7d === null
                              ? "—"
                              : `${formatPercentOrDash(routine.successRate7d)} (${routine.completed7d}/${routine.runs7d})`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>
              )}
            </BoardSection>

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
              <BoardSection title="Blocked more than 24h" description="Any ticket over a day blocked escalates to the CEO seat.">
                {board.blockedTasks.items.length === 0 ? (
                  <BoardEmpty message="No task has been blocked longer than 24 hours." />
                ) : (
                  <Card className="gap-0 p-0">
                    <ul className="divide-y divide-border">
                      {board.blockedTasks.items.map((task) => (
                        <li key={task.id} className="flex items-start justify-between gap-3 px-4 py-3">
                          <div>
                            <p className="text-sm font-medium">{task.identifier ?? task.title}</p>
                            <p className="text-xs text-muted-foreground">
                              {task.projectName ?? "No project"} · blocked {formatHoursOrDash(task.ageHours)} ago
                            </p>
                          </div>
                          <Badge variant="destructive">{formatHoursOrDash(task.ageHours)}</Badge>
                        </li>
                      ))}
                    </ul>
                  </Card>
                )}
              </BoardSection>

              <BoardSection title="Approvals waiting" description="Oldest pending approval first; the queue is what stops agent work.">
                {board.approvals.items.length === 0 ? (
                  <BoardEmpty message="No approvals waiting." />
                ) : (
                  <Card className="gap-0 p-0">
                    <ul className="divide-y divide-border">
                      {board.approvals.items.map((approval) => (
                        <li key={approval.id} className="flex items-start justify-between gap-3 px-4 py-3">
                          <div>
                            <p className="text-sm font-medium">{approval.type}</p>
                            <p className="text-xs text-muted-foreground">
                              Requested {formatDateTime(approval.createdAt)}
                            </p>
                          </div>
                          <Badge variant={approval.ageHours > 24 ? "destructive" : "outline"}>
                            {formatHoursOrDash(approval.ageHours)}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  </Card>
                )}
              </BoardSection>
            </div>

            {board.server.backup && board.server.backup.warnings.length > 0 ? (
              <NotConnectedNote
                tile={{
                  tile: "backup-warning",
                  source: "Database backup",
                  reason: board.server.backup.warnings.join(" "),
                  needed: "Check the backup job and the failure marker.",
                }}
              />
            ) : null}

            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Activity className="h-3.5 w-3.5" />
              Routine success rate counts completed ÷ all routine runs that reached the queue in the last seven days.
            </p>
          </div>
        );
      }}
    </QueryView>
  );
}
