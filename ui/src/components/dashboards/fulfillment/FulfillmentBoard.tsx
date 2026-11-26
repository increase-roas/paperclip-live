import { useQuery } from "@tanstack/react-query";
import { Users } from "lucide-react";
import type {
  DashboardFulfillmentBoard,
  DashboardFulfillmentClientDelivery,
  DashboardFulfillmentWavvDelivery,
  DashboardPeriod,
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
  formatHoursOrDash,
  formatPercentOrDash,
} from "@/components/dashboards/lane3-shared/BoardPrimitives";

function formatUsdOrDash(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return "—";
  return amount.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatIntOrDash(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return Math.round(value).toLocaleString("en-US");
}

function formatMinutesOrDash(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return "—";
  return `${minutes.toLocaleString("en-US", { maximumFractionDigits: 1 })} min`;
}

function ClientDeliverySection({ delivery }: { delivery: DashboardFulfillmentClientDelivery }) {
  const missing = delivery.notConnected ?? undefined;

  return (
    <BoardSection
      title="Client ad & lead delivery"
      description="All client ad accounts and client GHL sub-accounts only. Increase ROAS's own acquisition accounts live on Marketing."
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <BoardTile
          label="Client ad spend"
          notConnected={delivery.adSpendUsd === null ? missing : undefined}
          value={formatUsdOrDash(delivery.adSpendUsd)}
          detail={`${delivery.accounts.length} active client ${delivery.accounts.length === 1 ? "account" : "accounts"}`}
          testId="fulfillment-client-ad-spend"
        />
        <BoardTile
          label="Client new leads"
          notConnected={delivery.newLeads === null ? missing : undefined}
          value={formatIntOrDash(delivery.newLeads)}
          detail="Client portfolio GHL + Meta leads"
          testId="fulfillment-client-new-leads"
        />
        <BoardTile
          label="Client cost per lead"
          notConnected={delivery.costPerLeadUsd === null ? missing : undefined}
          value={formatUsdOrDash(delivery.costPerLeadUsd)}
          detail="Reference only · client spend ÷ leads"
          testId="fulfillment-client-cpl"
        />
        <BoardTile
          label="Client CTR"
          notConnected={delivery.ctrPercent === null ? missing : undefined}
          value={formatPercentOrDash(delivery.ctrPercent)}
          detail="Link clicks ÷ impressions · client Meta"
          testId="fulfillment-client-ctr"
        />
      </div>

      {delivery.accounts.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <BoardTile
            label="Client appointments booked"
            value={formatIntOrDash(delivery.appointmentsBooked)}
            detail="Client GHL calendars & snapshots"
            testId="fulfillment-client-booked"
          />
          <BoardTile
            label="Client appointments held"
            value={formatIntOrDash(delivery.appointmentsShowed)}
            detail={
              delivery.showRatePercent !== null
                ? `Show rate ${formatPercentOrDash(delivery.showRatePercent)}`
                : "Held appointments across clients"
            }
            testId="fulfillment-client-held"
          />
          <BoardTile
            label="Client jobs sold"
            value={formatIntOrDash(delivery.wonDeals)}
            detail={
              delivery.closeRatePercent !== null
                ? `Close rate ${formatPercentOrDash(delivery.closeRatePercent)}`
                : "Closed client deals in period"
            }
            testId="fulfillment-client-won"
          />
          <BoardTile
            label="Zero-lead client-days"
            value={formatIntOrDash(delivery.zeroLeadDays)}
            detail="Last 7d with >$100 spend & 0 leads"
            tone={
              delivery.zeroLeadDays === null
                ? "default"
                : delivery.zeroLeadDays > 0
                  ? "warning"
                  : "good"
            }
            testId="fulfillment-client-zero-lead-days"
          />
        </div>
      ) : null}

      {delivery.accounts.length > 0 ? (
        <Card elevation="low" className="gap-0 overflow-x-auto p-0" data-testid="fulfillment-client-delivery-table">
          <table className="w-full min-w-max text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th scope="col" className="px-4 py-3 font-medium">Client</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">Ad spend</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">New leads</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">CPL</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">CTR</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">Booked</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">Held</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">Show rate</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">Jobs sold</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">Zero-lead days</th>
              </tr>
            </thead>
            <tbody>
              {delivery.accounts.map((row) => (
                <tr key={row.slug} className="border-b border-border/60 last:border-0">
                  <td className="px-4 py-3 font-medium">{row.displayName}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatUsdOrDash(row.spend)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatIntOrDash(row.newLeads)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatUsdOrDash(row.cpl)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatPercentOrDash(row.ctr)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatIntOrDash(row.booked)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatIntOrDash(row.showed)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatPercentOrDash(row.showRate)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatIntOrDash(row.wonDeals)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {row.zeroLeadDays !== null && row.zeroLeadDays > 0 ? (
                      <Badge variant="destructive">{row.zeroLeadDays}</Badge>
                    ) : (
                      formatIntOrDash(row.zeroLeadDays)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
    </BoardSection>
  );
}

function ClientWavvSection({ wavv }: { wavv: DashboardFulfillmentWavvDelivery }) {
  const missing = wavv.notConnected ?? undefined;

  return (
    <BoardSection
      title="Client appointment setting (WAVV)"
      description="Outbound setter dialer activity supporting client lead follow-up and appointment booking."
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <BoardTile
          label="WAVV dials"
          notConnected={wavv.dials === null ? missing : undefined}
          value={formatIntOrDash(wavv.dials)}
          detail="Outbound call attempts in period"
          testId="fulfillment-wavv-dials"
        />
        <BoardTile
          label="Conversations > 60 s"
          notConnected={wavv.conversationsOver60s === null ? missing : undefined}
          value={formatIntOrDash(wavv.conversationsOver60s)}
          detail="Connected calls longer than 60 s"
          testId="fulfillment-wavv-conversations"
        />
        <BoardTile
          label="Talk time"
          notConnected={wavv.talkTimeMinutes === null ? missing : undefined}
          value={formatMinutesOrDash(wavv.talkTimeMinutes)}
          detail="Total connected setter talk time"
          testId="fulfillment-wavv-talk-time"
        />
      </div>

      {wavv.bySetter.length > 0 ? (
        <Card elevation="low" className="gap-0 overflow-x-auto p-0" data-testid="fulfillment-wavv-scoreboard">
          <table className="w-full min-w-max text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th scope="col" className="px-4 py-3 font-medium">Setter</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">Dials</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">Conversations &gt; 60 s</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">Talk time (min)</th>
              </tr>
            </thead>
            <tbody>
              {wavv.bySetter.map((setter) => (
                <tr key={setter.id} className="border-b border-border/60 last:border-0">
                  <td className="px-4 py-3 font-medium">{setter.setter}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatIntOrDash(setter.dials)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {formatIntOrDash(setter.conversationsOver60s)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {Number.isFinite(setter.talkTimeMinutes)
                      ? setter.talkTimeMinutes.toLocaleString("en-US", { maximumFractionDigits: 1 })
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
    </BoardSection>
  );
}

export function FulfillmentBoard({
  companyId: companyIdProp,
  period = "30d",
}: { companyId?: string; period?: DashboardPeriod } = {}) {
  const { selectedCompanyId } = useCompany();
  const companyId = companyIdProp ?? selectedCompanyId;

  const query = useQuery({
    queryKey: ["dashboard-boards", companyId, "fulfillment", period],
    queryFn: () => dashboardBoardsApi.fulfillment(companyId!, period),
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
            description="Client delivery across all client ad accounts, client GHL sub-accounts, WAVV outbound setting, Hormozi's retention questions, and Paperclip client tasks. Increase ROAS's own acquisition and sales live on Marketing and Sales."
            generatedAt={board.generatedAt}
          />

          {board.clientDelivery ? <ClientDeliverySection delivery={board.clientDelivery} /> : null}
          {board.wavvDelivery ? <ClientWavvSection wavv={board.wavvDelivery} /> : null}

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
              <Card elevation="low" className="gap-0 overflow-x-auto p-0">
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
                <Card elevation="low" className="gap-0 p-0">
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
                <Card elevation="low" className="gap-0 p-0">
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
