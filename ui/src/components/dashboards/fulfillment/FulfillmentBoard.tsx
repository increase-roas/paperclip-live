import { useQuery } from "@tanstack/react-query";
import { Users } from "lucide-react";
import type { DashboardFulfillmentBoard } from "@paperclipai/shared";
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
  formatHoursOrDash,
} from "@/components/dashboards/lane3-shared/BoardPrimitives";

export function FulfillmentBoard({ companyId: companyIdProp }: { companyId?: string } = {}) {
  const { selectedCompanyId } = useCompany();
  const companyId = companyIdProp ?? selectedCompanyId;

  const query = useQuery({
    queryKey: ["dashboard-boards", companyId, "fulfillment"],
    queryFn: () => dashboardBoardsApi.fulfillment(companyId!),
    enabled: Boolean(companyId),
  });

  if (!companyId) {
    return <BoardEmpty message="Select a company to see fulfillment." />;
  }

  return (
    <QueryView query={query} action="load the fulfillment board">
      {(board: DashboardFulfillmentBoard) => (
        <div className="space-y-8">
          <BoardHeader
            title="Fulfillment"
            description="Hormozi's retention questions first (spec v2), then the v1 operating detail: open client work, onboarding and support requests from Paperclip tasks. A client is a Paperclip project; anything without a project is counted as unassigned."
            generatedAt={board.generatedAt}
          />

          <BoardSection
            title="Retention (Hormozi)"
            description="Churn, sale-to-onboarding time, early backout and reviews by day 30. A tile with no real source says which source is missing instead of showing a guess."
          >
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
              <BoardTile
                label="Churn, monthly"
                notConnected={board.retention.churnMonthly.notConnected ?? undefined}
                value={board.retention.churnMonthly.value ?? "—"}
                detail={`Target ${board.retention.churnMonthly.target} · ${board.retention.churnMonthly.cite}`}
                testId="fulfillment-churn"
              />
              <BoardTile
                label="Sale to onboarding"
                notConnected={board.retention.saleToOnboarding.notConnected ?? undefined}
                value={board.retention.saleToOnboarding.value ?? "—"}
                detail={`Days · target ${board.retention.saleToOnboarding.target} · ${board.retention.saleToOnboarding.cite}`}
                testId="fulfillment-sale-onboarding"
              />
              <BoardTile
                label="Early backout (24/48/72h)"
                notConnected={board.retention.earlyBackout.notConnected ?? undefined}
                value={
                  board.retention.earlyBackout.windows
                    .map((window) => `${window.hours}h ${window.valuePercent === null ? "—" : `${window.valuePercent}%`}`)
                    .join(" · ")
                }
                detail={`Target ${board.retention.earlyBackout.target} · ${board.retention.earlyBackout.cite}`}
                testId="fulfillment-early-backout"
              />
              <BoardTile
                label="Review by day 30"
                notConnected={board.retention.reviewByDay30.notConnected ?? undefined}
                value={board.retention.reviewByDay30.value ?? "—"}
                detail={`Target ${board.retention.reviewByDay30.target} · ${board.retention.reviewByDay30.cite}`}
                testId="fulfillment-review-30"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              These four are Hormozi's retention numbers. The open-task, onboarding and support detail below is
              v1 source, not Hormozi.
            </p>
          </BoardSection>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            <BoardTile
              label="Open client tasks"
              value={board.openClientTasks.total}
              detail={`${board.clients.length} ${board.clients.length === 1 ? "client" : "clients"} with open work`}
              testId="fulfillment-open-tasks"
            />
            <BoardTile
              label="Unassigned open tasks"
              value={board.openClientTasks.unassigned}
              detail="Open tasks with no project, so no client"
              tone={board.openClientTasks.unassigned > 0 ? "warning" : "good"}
              testId="fulfillment-unassigned"
            />
            <BoardTile
              label="Open onboarding steps"
              value={board.onboarding.openSteps}
              detail="Label or project name matches onboarding"
              testId="fulfillment-onboarding"
            />
            <BoardTile
              label="Support requests waiting"
              {...(board.support.unavailable
                ? { value: undefined, notConnected: board.support.unavailable }
                : {
                  value: board.support.waiting,
                  detail: `Oldest ${formatHoursOrDash(board.support.oldestAgeHours)}`,
                  tone: (board.support.oldestAgeHours ?? 0) > 24 ? ("danger" as const) : ("default" as const),
                })}
              testId="fulfillment-support"
            />
          </div>

          <BoardSection
            title="Open client tasks by client"
            description="A project is the client boundary. Only open tasks from real Paperclip projects are grouped here."
          >
            {board.clients.length === 0 ? (
              <BoardEmpty message="No open tasks are attached to a project." />
            ) : (
              <Card className="gap-0 overflow-x-auto p-0">
                <table className="w-full min-w-max text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-4 py-3 font-medium">Client</th>
                      <th className="px-4 py-3 text-right font-medium">Open</th>
                      <th className="px-4 py-3 text-right font-medium">Blocked</th>
                      <th className="px-4 py-3 text-right font-medium">Oldest open</th>
                    </tr>
                  </thead>
                  <tbody>
                    {board.clients.map((client) => (
                      <tr key={client.clientKey} className="border-b border-border/60 last:border-0">
                        <td className="px-4 py-3 font-medium">{client.clientName}</td>
                        <td className="px-4 py-3 text-right tabular-nums">{client.openTasks}</td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {client.blockedTasks > 0 ? (
                            <Badge variant="destructive">{client.blockedTasks}</Badge>
                          ) : (
                            client.blockedTasks
                          )}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {formatHoursOrDash(client.oldestOpenAgeHours)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}
          </BoardSection>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <BoardSection
              title="Onboarding"
              description="Open tasks whose project name or label mentions onboarding."
            >
              {board.onboarding.items.length === 0 ? (
                <BoardEmpty message="No open onboarding tasks found." />
              ) : (
                <Card className="gap-0 p-0">
                  <ul className="divide-y divide-border">
                    {board.onboarding.items.map((task) => (
                      <li key={task.id} className="flex items-start justify-between gap-3 px-4 py-3">
                        <div>
                          <p className="text-sm font-medium">{task.identifier ?? task.title}</p>
                          <p className="text-xs text-muted-foreground">
                            {task.clientName ?? "No client"} · open {formatHoursOrDash(task.ageHours)}
                          </p>
                        </div>
                        <StatusBadge status={task.status} />
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
              {board.onboarding.overdue ? <NotConnectedNote tile={board.onboarding.overdue} /> : null}
            </BoardSection>

            <BoardSection
              title="Support requests"
              description={
                board.support.matchedLabels.length > 0
                  ? `Waiting on labels: ${board.support.matchedLabels.join(", ")}.`
                  : "No support label is configured."
              }
            >
              {board.support.unavailable ? (
                <NotConnectedNote tile={board.support.unavailable} />
              ) : board.support.items.length === 0 ? (
                <BoardEmpty message="No open support requests." />
              ) : (
                <Card className="gap-0 p-0">
                  <ul className="divide-y divide-border">
                    {board.support.items.map((task) => (
                      <li key={task.id} className="flex items-start justify-between gap-3 px-4 py-3">
                        <div>
                          <p className="text-sm font-medium">{task.identifier ?? task.title}</p>
                          <p className="text-xs text-muted-foreground">
                            {task.clientName ?? "No client"} · waiting {formatHoursOrDash(task.ageHours)}
                          </p>
                        </div>
                        <Badge variant={task.ageHours > 24 ? "destructive" : "outline"}>
                          {formatHoursOrDash(task.ageHours)}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
            </BoardSection>
          </div>

          <div className="space-y-2">
            {board.notConnected
              .filter((tile) => tile.tile !== "onboarding-overdue" && tile.tile !== "support-requests")
              .map((tile) => <NotConnectedNote key={tile.tile} tile={tile} />)}
          </div>

          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Users className="h-3.5 w-3.5" />
            Ages are time since the task was created, not time past a due date; Paperclip tasks do not carry due dates.
          </p>
        </div>
      )}
    </QueryView>
  );
}
