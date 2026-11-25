import { useQuery } from "@tanstack/react-query";
import type { DashboardBoardId } from "@paperclipai/shared";
import { dashboardBoardsApi } from "@/api/dashboardBoards";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { DEFAULT_DASHBOARD_PERIOD, type DashboardPeriod } from "../period";

/**
 * Reads one board for the selected company and period. The server is the only
 * source of numbers; this hook never derives or fills a value on the client.
 *
 * `companyId` wins when the shell passes one. Lane 1's shell passes the
 * company and period explicitly; the fallback uses the selected company and
 * default 30d period.
 */
export function useDashboardBoard(
  board: DashboardBoardId,
  companyId?: string,
  period: DashboardPeriod = DEFAULT_DASHBOARD_PERIOD,
) {
  const { selectedCompanyId } = useCompany();
  const activeCompanyId = companyId ?? selectedCompanyId;
  const query = useQuery({
    queryKey: [...queryKeys.dashboardBoard(activeCompanyId ?? "none", board), period],
    queryFn: () => dashboardBoardsApi.lane2(activeCompanyId!, board, period),
    enabled: Boolean(activeCompanyId),
    staleTime: 60_000,
  });

  return { companyId: activeCompanyId, ...query };
}
