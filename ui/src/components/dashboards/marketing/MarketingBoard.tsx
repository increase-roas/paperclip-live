import type { DashboardBoard } from "@paperclipai/shared";
import type { DashboardPeriod } from "../period";
import { BoardFrame } from "../lane2-shared/BoardFrame";
import { BoardSections } from "../lane2-shared/BoardSections";
import { DashboardBoardShell } from "../lane2-shared/DashboardBoardShell";

const SUBTITLE =
  "Increase ROAS agency acquisition only — Increase ROAS B2B, Alex Bloomfield (Start Scale Automate), and Hot Tub Launch. Cost to win an agency client, judged against LTGP. CPL is a reference, never a target; client ad accounts live on Fulfillment.";

/** Pure view. Renders only the payload it is given. */
export function MarketingBoardView({ data }: { data: DashboardBoard }) {
  return (
    <BoardFrame title="Marketing" subtitle={SUBTITLE} data={data}>
      <BoardSections data={data} />
    </BoardFrame>
  );
}

export function MarketingBoard({
  companyId,
  period,
}: { companyId?: string; period?: DashboardPeriod } = {}) {
  return (
    <DashboardBoardShell board="marketing" title="Marketing" companyId={companyId} period={period}>
      {(data) => <MarketingBoardView data={data} />}
    </DashboardBoardShell>
  );
}
