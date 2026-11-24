import type { DashboardBoard } from "@paperclipai/shared";
import { BoardTable } from "./BoardTable";
import { Tile } from "./Tile";

/** The tile grid and the tables of one board payload, in payload order. */
export function BoardSections({ data }: { data: DashboardBoard }) {
  return (
    <>
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
    </>
  );
}
