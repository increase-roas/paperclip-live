import type { DashboardBoard } from "@paperclipai/shared";
import { BoardFrame } from "../lane2-shared/BoardFrame";
import { BoardSections } from "../lane2-shared/BoardSections";
import { DashboardBoardShell } from "../lane2-shared/DashboardBoardShell";

const SUBTITLE =
  "One self-chosen number per seat, and how many metrics each seat can name for their own job. One row per person: role, rate, duties and status.";

/** Pure view. Renders only the payload it is given. */
export function HumanEmployeesBoardView({ data }: { data: DashboardBoard }) {
  return (
    <BoardFrame title="Human employees" subtitle={SUBTITLE} data={data}>
      <BoardSections data={data} />
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
