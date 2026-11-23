import type { DashboardBoard } from "@paperclipai/shared";
import { BoardFrame } from "../lane2-shared/BoardFrame";
import { BoardSections } from "../lane2-shared/BoardSections";
import { DashboardBoardShell } from "../lane2-shared/DashboardBoardShell";

const SUBTITLE =
  "Cost to win a customer, judged against LTGP. CPL is a reference, never a target; the zero-lead alarm is the one that costs money today.";

/** Pure view. Renders only the payload it is given. */
export function MarketingBoardView({ data }: { data: DashboardBoard }) {
  return (
    <BoardFrame title="Marketing" subtitle={SUBTITLE} data={data}>
      <BoardSections data={data} />
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
