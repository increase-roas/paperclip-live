import { useQuery } from "@tanstack/react-query";
import { DollarSign } from "lucide-react";
import type { DashboardAiCostBoard, DashboardAiCostSeat } from "@paperclipai/shared";
import { dashboardBoardsApi } from "@/api/dashboardBoards";
import { QueryView } from "@/components/QueryView";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { useCompany } from "@/context/CompanyContext";
import { cn } from "@/lib/utils";
import {
  BoardEmpty,
  BoardHeader,
  BoardSection,
  BoardTile,
  StatusBadge,
  formatCentsOrDash,
  formatPercentOrDash,
} from "@/components/dashboards/lane3-shared/BoardPrimitives";

function rowTone(seat: DashboardAiCostSeat): "danger" | "warning" | "default" {
  if (seat.utilizationPercent !== null && seat.utilizationPercent >= 100) return "danger";
  if (seat.overEightyPercent) return "warning";
  return "default";
}

function UtilizationBar({ percent }: { percent: number | null }) {
  if (percent === null) {
    return <span className="text-xs text-muted-foreground">No cap</span>;
  }
  const width = Math.max(0, Math.min(100, percent));
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <div
          className={cn(
            "h-full rounded-full",
            percent >= 100 ? "bg-destructive" : percent >= 80 ? "bg-amber-500" : "bg-primary",
          )}
          style={{ width: `${width}%` }}
        />
      </div>
      <span className="text-xs tabular-nums text-muted-foreground">{formatPercentOrDash(percent)}</span>
    </div>
  );
}

export function AiCostBoard({ companyId: companyIdProp }: { companyId?: string } = {}) {
  const { selectedCompanyId } = useCompany();
  const companyId = companyIdProp ?? selectedCompanyId;

  const query = useQuery({
    queryKey: ["dashboard-boards", companyId, "ai-cost"],
    queryFn: () => dashboardBoardsApi.aiCost(companyId!),
    enabled: Boolean(companyId),
  });

  if (!companyId) {
    return <BoardEmpty message="Select a company to see AI cost." />;
  }

  return (
    <QueryView query={query} action="load the AI cost board">
      {(board: DashboardAiCostBoard) => (
        <div className="space-y-8">
          <BoardHeader
            title="AI cost"
            description="Spend per agent seat against its monthly cap, cost per completed task and the providers driving the bill. The six spend tiles are v1 source, not Hormozi; output unit and workflow coverage are the v2 additions."
            generatedAt={board.generatedAt}
          />

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            <BoardTile
              label="Month to date"
              value={formatCentsOrDash(board.company.spendMonthToDateCents)}
              detail={
                board.company.budgetMonthlyCents > 0
                  ? `${formatPercentOrDash(board.company.utilizationPercent)} of ${formatCentsOrDash(board.company.budgetMonthlyCents)} company cap`
                  : "No company monthly cap set"
              }
              tone={
                board.company.utilizationPercent !== null && board.company.utilizationPercent >= 80
                  ? "danger"
                  : "default"
              }
              testId="ai-cost-month"
            />
            <BoardTile
              label="Forecast month end"
              value={formatCentsOrDash(board.company.forecastMonthEndCents)}
              detail={`${formatPercentOrDash(board.company.monthProgressPercent)} through the month`}
              tone={
                board.company.budgetMonthlyCents > 0 &&
                board.company.forecastMonthEndCents > board.company.budgetMonthlyCents * 0.9
                  ? "warning"
                  : "default"
              }
              testId="ai-cost-forecast"
            />
            <BoardTile
              label="Cost per completed task"
              value={formatCentsOrDash(board.costPerCompletedTaskCents)}
              detail={`${board.completedTasksMonth} tasks closed this month`}
              testId="ai-cost-per-task"
            />
            <BoardTile
              label="Seats over 80% of cap"
              value={board.seatsOverEightyPercent}
              detail={
                board.seatsWithoutCap > 0
                  ? `${board.seatsWithoutCap} ${board.seatsWithoutCap === 1 ? "seat has" : "seats have"} no cap`
                  : "Every seat has a cap"
              }
              tone={board.seatsOverEightyPercent > 0 ? "danger" : board.seatsWithoutCap > 0 ? "warning" : "good"}
              testId="ai-cost-over-cap"
            />
          </div>

          <BoardSection
            title="Hormozi numbers (spec v2)"
            description="v2 §8 cites 9q5oj [11:05] for cost per unit of client output and 9q5oj [04:42] for tasks per seat that could be a workflow. Both tiles say Not connected until their source exists."
          >
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <BoardTile
                label="Cost per unit of client output"
                notConnected={board.outputUnit.notConnected ?? undefined}
                value={formatCentsOrDash(board.outputUnit.costPerOutputUnitCents)}
                detail={`${formatCentsOrDash(board.outputUnit.spendMonthToDateCents)} spend ÷ ${
                  board.outputUnit.outputUnitsMonth ?? "—"
                } outputs · target ${board.outputUnit.target} · ${board.outputUnit.cite}`}
                testId="ai-cost-output-unit"
              />
              <BoardTile
                label="Tasks per seat that could be a workflow"
                notConnected={board.workflowCoverage.notConnected ?? undefined}
                value={board.workflowCoverage.automatedPercent === null
                  ? "—"
                  : formatPercentOrDash(board.workflowCoverage.automatedPercent)}
                detail={`${board.workflowCoverage.totalAutomated} automated · ${
                  board.workflowCoverage.listedTasksTotal ?? "—"
                } listed · target ${board.workflowCoverage.target} · ${board.workflowCoverage.cite}`}
                testId="ai-cost-workflow"
              />
            </div>
          </BoardSection>

          <BoardSection
            title="Automated routines per seat"
            description="The real numerator for the workflow tile: active routines owned by each seat. Listed tasks stays Not recorded until a per-seat task inventory exists."
          >
            <Card className="gap-0 overflow-x-auto p-0">
              <table className="w-full min-w-max text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Seat</th>
                    <th className="px-4 py-3 text-right font-medium">Automated routines</th>
                    <th className="px-4 py-3 text-right font-medium">Listed tasks</th>
                    <th className="px-4 py-3 text-right font-medium">Automated share</th>
                  </tr>
                </thead>
                <tbody>
                  {board.workflowCoverage.seats.map((seat) => (
                    <tr key={seat.agentId} className="border-b border-border/60 last:border-0">
                      <td className="px-4 py-3 font-medium">{seat.name}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{seat.automatedTasks}</td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {seat.listedTasks ?? <Badge variant="outline">Not recorded</Badge>}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {seat.automatedPercent === null ? "—" : formatPercentOrDash(seat.automatedPercent)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </BoardSection>

          <BoardSection
            title="Seats"
            description="Today and trailing seven days are spend windows; the cap and month-to-date spend are the budget window."
          >
            <Card className="gap-0 overflow-x-auto p-0">
              <table className="w-full min-w-max text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Seat</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 text-right font-medium">Today</th>
                    <th className="px-4 py-3 text-right font-medium">7 days</th>
                    <th className="px-4 py-3 text-right font-medium">Month</th>
                    <th className="px-4 py-3 text-right font-medium">Cap</th>
                    <th className="px-4 py-3 font-medium">Used</th>
                    <th className="px-4 py-3 text-right font-medium">Tasks</th>
                    <th className="px-4 py-3 text-right font-medium">Cost / task</th>
                  </tr>
                </thead>
                <tbody>
                  {board.seats.map((seat) => (
                    <tr key={seat.agentId} className="border-b border-border/60 last:border-0">
                      <td className="px-4 py-3 font-medium">{seat.name}</td>
                      <td className="px-4 py-3">
                        <StatusBadge
                          status={seat.status}
                          tone={seat.status === "error" ? "danger" : seat.status === "paused" ? "warning" : "default"}
                        />
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">{formatCentsOrDash(seat.spendTodayCents)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{formatCentsOrDash(seat.spend7dCents)}</td>
                      <td
                        className={cn(
                          "px-4 py-3 text-right tabular-nums",
                          rowTone(seat) === "danger" && "font-semibold text-destructive",
                          rowTone(seat) === "warning" && "font-semibold text-amber-600 dark:text-amber-400",
                        )}
                      >
                        {formatCentsOrDash(seat.spendMonthToDateCents)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {seat.budgetMonthlyCents > 0 ? formatCentsOrDash(seat.budgetMonthlyCents) : (
                          <Badge variant="outline">No cap</Badge>
                        )}
                      </td>
                      <td className="px-4 py-3"><UtilizationBar percent={seat.utilizationPercent} /></td>
                      <td className="px-4 py-3 text-right tabular-nums">{seat.completedTasksMonth}</td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {formatCentsOrDash(seat.costPerCompletedTaskCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {board.seats.length === 0 ? (
                <div className="p-6 text-sm text-muted-foreground">No agent seats yet.</div>
              ) : null}
            </Card>
          </BoardSection>

          <BoardSection
            title="Top cost drivers"
            description="Month-to-date spend by provider and model."
          >
            {board.topCostDrivers.length === 0 ? (
              <BoardEmpty message="No cost events this month." />
            ) : (
              <Card className="gap-0 overflow-x-auto p-0">
                <table className="w-full min-w-max text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-4 py-3 font-medium">Provider</th>
                      <th className="px-4 py-3 font-medium">Model</th>
                      <th className="px-4 py-3 text-right font-medium">Month to date</th>
                      <th className="px-4 py-3 text-right font-medium">Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {board.topCostDrivers.map((driver) => (
                      <tr key={`${driver.provider}:${driver.model}`} className="border-b border-border/60 last:border-0">
                        <td className="px-4 py-3 font-medium">{driver.provider}</td>
                        <td className="px-4 py-3 text-muted-foreground">{driver.model}</td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {formatCentsOrDash(driver.spendMonthToDateCents)}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">{formatPercentOrDash(driver.sharePercent)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}
          </BoardSection>

          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <DollarSign className="h-3.5 w-3.5" />
            Cost per completed task = month-to-date spend on the tasks closed this month ÷ tasks closed this month.
          </p>
        </div>
      )}
    </QueryView>
  );
}
