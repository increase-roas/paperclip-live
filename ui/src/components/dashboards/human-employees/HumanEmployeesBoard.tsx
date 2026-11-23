import type { DashboardBoard } from "@paperclipai/shared";
import { BoardFrame } from "../lane2-shared/BoardFrame";
import { BoardTable } from "../lane2-shared/BoardTable";
import { DashboardBoardShell } from "../lane2-shared/DashboardBoardShell";
import { Tile } from "../lane2-shared/Tile";

const SUBTITLE =
  "One self-chosen number per seat, and how many metrics each seat can name for their own job. One row per person: role, rate, duties and status.";

/** Pure view. Renders only the payload it is given. */
export function HumanEmployeesBoardView({ data }: { data: DashboardBoard }) {
  return (
    <BoardFrame title="Human employees" subtitle={SUBTITLE} data={data}>
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

export function HumanEmployeesBoard({ companyId }: { companyId?: string } = {}) {
  return (
    <DashboardBoardShell board="human-employees" title="Human employees" companyId={companyId}>
      {(data) => <HumanEmployeesBoardView data={data} />}
    </DashboardBoardShell>
  );
}
