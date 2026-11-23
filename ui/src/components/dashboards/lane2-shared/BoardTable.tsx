import type { DashboardSource, DashboardTable } from "@paperclipai/shared";
import { NotConnected } from "./NotConnected";

interface BoardTableProps {
  table: DashboardTable;
  sources: DashboardSource[];
}

/**
 * A per-client or per-member table. With no source it still shows the columns
 * and the explicit NotConnected state, so the reader knows what will appear.
 */
export function BoardTable({ table, sources }: BoardTableProps) {
  const tableSources = table.sourceIds
    .map((id) => sources.find((source) => source.id === id))
    .filter((source): source is DashboardSource => Boolean(source));

  return (
    <section
      className="rounded-lg border bg-card"
      data-testid={`dashboard-table-${table.id}`}
    >
      <div className="border-b p-4">
        <h2 className="text-sm font-semibold text-foreground">{table.title}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{table.description}</p>
      </div>
      <div className="overflow-x-auto p-4">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b">
              {table.columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className="whitespace-nowrap py-2 pr-4 text-xs font-medium text-muted-foreground"
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.length === 0 ? (
              <tr>
                <td colSpan={table.columns.length} className="pt-4">
                  <NotConnected sources={tableSources} />
                </td>
              </tr>
            ) : (
              table.rows.map((row) => (
                <tr key={row.id} className="border-b last:border-b-0">
                  {table.columns.map((column) => (
                    <td key={column.key} className="py-2 pr-4 tabular-nums">
                      {row.cells[column.key] ?? "—"}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
