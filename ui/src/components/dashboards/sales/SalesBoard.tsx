import type { DashboardBoard } from "@paperclipai/shared";
import { BoardFrame } from "../lane2-shared/BoardFrame";
import { BoardSections } from "../lane2-shared/BoardSections";
import { DashboardBoardShell } from "../lane2-shared/DashboardBoardShell";

const SUBTITLE =
  "Hormozi's five numbers in the order he reads them: show rate, offer rate, close rate, cash collected up front, units sold. Speed to lead: call within 60 seconds; after 5 minutes, close likelihood drops 80%.";

/** Pure view. Renders only the payload it is given. */
export function SalesBoardView({ data }: { data: DashboardBoard }) {
  return (
    <BoardFrame title="Sales" subtitle={SUBTITLE} data={data}>
      <BoardSections data={data} />
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
