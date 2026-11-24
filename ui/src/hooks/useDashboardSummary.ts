import { useQuery } from "@tanstack/react-query";
import { dashboardApi } from "@/api/dashboard";
import { useQueryView } from "@/components/QueryView";
import { queryKeys } from "@/lib/queryKeys";
import { usePublishSharedQueryData, useSharedPollingQuery } from "./useSharedPolling";

/**
 * The company dashboard summary, shared across tabs through the polling
 * leader, with its connectivity-aware view state.
 */
export function useDashboardSummary(companyId: string | null | undefined) {
  const queryKey = queryKeys.dashboard(companyId!);
  const shared = useSharedPollingQuery({
    companyId,
    resourceKey: "dashboard",
    queryKey,
    enabled: !!companyId,
  });
  const query = useQuery({
    queryKey,
    queryFn: () => dashboardApi.summary(companyId!),
    enabled: !!companyId,
  });
  const view = useQueryView(query);
  usePublishSharedQueryData(shared, query.data, query.dataUpdatedAt);
  return { query, view };
}
