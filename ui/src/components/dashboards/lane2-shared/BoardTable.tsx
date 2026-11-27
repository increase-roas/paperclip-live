import type { DashboardSource, DashboardTable } from "@paperclipai/shared";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { NotConnected } from "./NotConnected";

interface BoardTableProps {
  table: DashboardTable;
  sources: DashboardSource[];
}

const WRAP_COLUMN_KEYS = new Set(["duties", "judgedOn", "responsibilities", "performanceCriteria"]);

/**
 * A per-client or per-member table. With no source it still shows the columns
 * and either the NotConnected state (a source is disconnected) or an honest
 * empty state (every source is connected but returned no rows).
 */
export function BoardTable({ table, sources }: BoardTableProps) {
  const tableSources = table.sourceIds
    .map((id) => sources.find((source) => source.id === id))
    .filter((source): source is DashboardSource => Boolean(source));
  const disconnected = tableSources.filter((source) => source.status !== "connected");

  return (
    <Card
      elevation="low"
      className="gap-0 overflow-hidden p-0"
      data-testid={`dashboard-table-${table.id}`}
    >
      <div className="border-b border-border px-4 py-3.5 sm:px-5">
        <h2 className="text-sm font-semibold text-foreground">{table.title}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{table.description}</p>
      </div>
      <div className="w-full overflow-x-auto">
        <table className="w-full min-w-max text-left text-sm">
          <thead>
            <tr className="border-b border-border">
              {table.columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className="whitespace-nowrap px-3 py-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground first:pl-4 last:pr-4 sm:first:pl-5 sm:last:pr-5"
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.length === 0 ? (
              <tr>
                <td colSpan={table.columns.length} className="px-4 py-4 sm:px-5">
                  {disconnected.length > 0 || tableSources.length === 0 ? (
                    <NotConnected sources={disconnected} />
                  ) : (
                    <p className="text-sm text-muted-foreground" data-testid="dashboard-table-no-data">
                      No data yet: {tableSources.map((source) => source.name).join(", ")} returned no rows for this period.
                    </p>
                  )}
                </td>
              </tr>
            ) : (
              table.rows.map((row) => (
                <tr key={row.id} className="border-b border-border/60 last:border-b-0">
                  {table.columns.map((column) => {
                    const value = row.cells[column.key];
                    const allowWrap = WRAP_COLUMN_KEYS.has(column.key);
                    return (
                      <td
                        key={column.key}
                        className={cn(
                          "px-3 py-2.5 tabular-nums first:pl-4 last:pr-4 sm:first:pl-5 sm:last:pr-5",
                          allowWrap ? "max-w-xs whitespace-normal" : "whitespace-nowrap",
                        )}
                      >
                        {value ?? "—"}
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
