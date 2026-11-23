import type { DashboardBoard } from "@paperclipai/shared";
import { BoardFrame } from "../lane2-shared/BoardFrame";
import { BoardTable } from "../lane2-shared/BoardTable";
import { DashboardBoardShell } from "../lane2-shared/DashboardBoardShell";
import { Tile } from "../lane2-shared/Tile";

const SUBTITLE =
  "Hormozi's five numbers in the order he reads them: show rate, offer rate, close rate, cash collected up front, units sold. Speed to lead: call within 60 seconds; after 5 minutes, close likelihood drops 80%.";

/** Pure view. Renders only the payload it is given. */
export function SalesBoardView({ data }: { data: DashboardBoard }) {
  return (
    <BoardFrame title="Sales" subtitle={SUBTITLE} data={data}>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {data.tiles.map((tile) => (
          <Tile key={tile.id} tile={tile} sources={data.sources} />
        ))}
      </div>

      <div className="space-y-4">
        {data.tables.map((table) => (
          <BoardTable key={table.id} table={table} sources={data.sources} />
        ))}
      </div>
    </BoardFrame>
  );
}

export function SalesBoard({ companyId }: { companyId?: string } = {}) {
  return (
    <DashboardBoardShell board="sales" title="Sales" companyId={companyId}>
      {(data) => <SalesBoardView data={data} />}
    </DashboardBoardShell>
  );
}
