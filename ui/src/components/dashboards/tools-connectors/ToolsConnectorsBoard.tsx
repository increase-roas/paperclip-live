import { useQuery } from "@tanstack/react-query";
import { Plug } from "lucide-react";
import type { DashboardConnectorRow, DashboardToolsConnectorsBoard } from "@paperclipai/shared";
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
  NotConnectedNote,
  StatusBadge,
  formatDateTime,
} from "@/components/dashboards/lane3-shared/BoardPrimitives";

const ATTENTION = new Set(["degraded", "failed", "error", "missing_secret"]);

function healthTone(row: DashboardConnectorRow): "danger" | "warning" | "good" | "default" {
  if (row.health && ATTENTION.has(row.health)) return "danger";
  if (row.status === "error" || row.status === "failed") return "danger";
  if (!row.health || row.health === "unchecked" || row.health === "unknown" || row.status === "draft") {
    return "warning";
  }
  return "good";
}

function expiryCell(row: DashboardConnectorRow): { text: string; tone: "danger" | "warning" | "default" } {
  if (row.expiresAt === null) {
    return { text: "Expiry unknown", tone: "default" };
  }
  const days = row.expiryDaysRemaining;
  const text =
    days === null
      ? formatDateTime(row.expiresAt)
      : `${formatDateTime(row.expiresAt)} · ${days < 0 ? "expired" : `${days.toFixed(days < 10 ? 1 : 0)} days`}`;
  return {
    text,
    tone: days !== null && days <= 14 ? "danger" : days !== null && days <= 30 ? "warning" : "default",
  };
}

export function ToolsConnectorsBoard({ companyId: companyIdProp }: { companyId?: string } = {}) {
  const { selectedCompanyId } = useCompany();
  const companyId = companyIdProp ?? selectedCompanyId;

  const query = useQuery({
    queryKey: ["dashboard-boards", companyId, "tools-connectors"],
    queryFn: () => dashboardBoardsApi.toolsConnectors(companyId!),
    enabled: Boolean(companyId),
  });

  if (!companyId) {
    return <BoardEmpty message="Select a company to see tools and connectors." />;
  }

  return (
    <QueryView query={query} action="load the tools and connectors board">
      {(board: DashboardToolsConnectorsBoard) => (
        <div className="space-y-8">
          <BoardHeader
            title="Tools and connectors"
            description="Every plugin, tool connection, GitHub app and agent adapter Paperclip knows about, with its health, last use and known expiry. Source: v1 spec, not Hormozi — Hormozi has no content on connector health."
            generatedAt={board.generatedAt}
          />

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-5">
            <BoardTile label="Configured" value={board.summary.total} testId="tools-total" />
            <BoardTile
              label="Needs attention"
              value={board.summary.needsAttention}
              detail="Degraded, failed or missing a secret"
              tone={board.summary.needsAttention > 0 ? "danger" : "good"}
              testId="tools-attention"
            />
            <BoardTile
              label="Unchecked"
              value={board.summary.unchecked}
              detail="No health check has run"
              tone={board.summary.unchecked > 0 ? "warning" : "good"}
              testId="tools-unchecked"
            />
            <BoardTile
              label="Expiring within 14 days"
              value={board.summary.expiringWithin14Days}
              tone={board.summary.expiringWithin14Days > 0 ? "danger" : "good"}
              testId="tools-expiring"
            />
            <BoardTile
              label="Expiry unknown"
              value={board.summary.expiryUnknown}
              detail="No expiry field in the source"
              testId="tools-expiry-unknown"
            />
          </div>

          <BoardSection
            title="Connections"
            description="Last successful use is a real tool invocation that succeeded. 'Expiry unknown' means the source reports no expiry; it is not a guess."
          >
            {board.items.length === 0 ? (
              <BoardEmpty message="Paperclip has no plugins, connections or adapters configured for this company." />
            ) : (
              <Card className="gap-0 overflow-x-auto p-0">
                <table className="w-full min-w-max text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-4 py-3 font-medium">Name</th>
                      <th className="px-4 py-3 font-medium">Kind</th>
                      <th className="px-4 py-3 font-medium">Status</th>
                      <th className="px-4 py-3 font-medium">Health</th>
                      <th className="px-4 py-3 font-medium">Last checked</th>
                      <th className="px-4 py-3 font-medium">Last successful use</th>
                      <th className="px-4 py-3 font-medium">Expiry</th>
                    </tr>
                  </thead>
                  <tbody>
                    {board.items.map((row) => {
                      const expiry = expiryCell(row);
                      return (
                        <tr key={row.id} className="border-b border-border/60 last:border-0">
                          <td className="px-4 py-3">
                            <p className="font-medium">{row.name}</p>
                            {row.detail ? <p className="text-xs text-muted-foreground">{row.detail}</p> : null}
                          </td>
                          <td className="px-4 py-3 text-xs text-muted-foreground">{row.kind.replace("_", " ")}</td>
                          <td className="px-4 py-3"><StatusBadge status={row.status} /></td>
                          <td className="px-4 py-3">
                            <div className="space-y-1">
                              <StatusBadge status={row.health ?? "not reported"} tone={healthTone(row)} />
                              {row.healthMessage ? (
                                <p className="max-w-xs text-xs text-muted-foreground">{row.healthMessage}</p>
                              ) : null}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-xs text-muted-foreground">
                            {row.lastCheckAt ? formatDateTime(row.lastCheckAt) : "Never"}
                          </td>
                          <td className="px-4 py-3 text-xs text-muted-foreground">
                            {row.lastSuccessfulUseAt ? formatDateTime(row.lastSuccessfulUseAt) : "No recorded use"}
                          </td>
                          <td
                            className={cn(
                              "px-4 py-3 text-xs",
                              expiry.tone === "danger" && "font-semibold text-destructive",
                              expiry.tone === "warning" && "font-semibold text-amber-600 dark:text-amber-400",
                              expiry.tone === "default" && "text-muted-foreground",
                            )}
                          >
                            {expiry.tone === "danger" ? <Badge variant="destructive">{expiry.text}</Badge> : expiry.text}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </Card>
            )}
          </BoardSection>

          {board.notConnected.map((tile) => <NotConnectedNote key={tile.tile} tile={tile} />)}

          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Plug className="h-3.5 w-3.5" />
            Adapters are the agent runtimes in use; plugins are installed plugin packages; connections are Paperclip tool
            connections. The GitHub app row appears only when a GitHub chat configuration exists.
          </p>
        </div>
      )}
    </QueryView>
  );
}
