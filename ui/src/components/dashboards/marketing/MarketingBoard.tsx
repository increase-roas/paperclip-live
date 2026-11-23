import type { DashboardBoard } from "@paperclipai/shared";
import { BoardFrame } from "../lane2-shared/BoardFrame";
import { BoardTable } from "../lane2-shared/BoardTable";
import { DashboardBoardShell } from "../lane2-shared/DashboardBoardShell";
import { Tile } from "../lane2-shared/Tile";

const SUBTITLE =
  "Spend, leads and the cost of both, per client. The zero-lead alarm is the one that costs money today.";

/** Pure view. Renders only the payload it is given. */
export function MarketingBoardView({ data }: { data: DashboardBoard }) {
  return (
    <BoardFrame title="Marketing" subtitle={SUBTITLE} data={data}>
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

export function MarketingBoard({ companyId }: { companyId?: string } = {}) {
  return (
    <DashboardBoardShell board="marketing" title="Marketing" companyId={companyId}>
      {(data) => <MarketingBoardView data={data} />}
    </DashboardBoardShell>
  );
}
