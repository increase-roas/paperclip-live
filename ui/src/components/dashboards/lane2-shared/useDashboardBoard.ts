import { useQuery } from "@tanstack/react-query";
import type { DashboardBoardId } from "@paperclipai/shared";
import { dashboardLane2BoardsApi } from "@/api/dashboardLane2Boards";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Reads one board for the selected company. The server is the only source of
 * numbers; this hook never derives or fills a value on the client.
 *
 * `companyId` wins when the shell passes one. Lane 1's shell passes the
 * company explicitly; the registry fallback uses the selected company.
 */
export function useDashboardBoard(board: DashboardBoardId, companyId?: string) {
  const { selectedCompanyId } = useCompany();
  const activeCompanyId = companyId ?? selectedCompanyId;
  const query = useQuery({
    queryKey: queryKeys.dashboardBoard(activeCompanyId ?? "none", board),
    queryFn: () => dashboardLane2BoardsApi.get(activeCompanyId!, board),
    enabled: Boolean(activeCompanyId),
    staleTime: 60_000,
  });

  return { companyId: activeCompanyId, ...query };
}
