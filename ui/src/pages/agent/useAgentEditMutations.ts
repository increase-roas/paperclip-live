import { useMutation, type QueryClient } from "@tanstack/react-query";
import { agentsApi, type AgentPermissionUpdate } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";
import { invalidateBotViewsForAgent } from "@/lib/invalidate-bot-views";

/**
 * Icon and permission edits shared by the current agent page and the production
 * variant. Both refresh the same detail/list queries after a change.
 */
export function useAgentEditMutations({
  queryClient,
  routeAgentRef,
  agentLookupRef,
  resolvedCompanyId,
  setActionError,
}: {
  queryClient: QueryClient;
  routeAgentRef: string;
  agentLookupRef: string;
  resolvedCompanyId: string | null | undefined;
  setActionError: (message: string | null) => void;
}) {
  const invalidateAgent = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(routeAgentRef) });
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentLookupRef) });
    if (resolvedCompanyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(resolvedCompanyId) });
    }
    invalidateBotViewsForAgent(queryClient, resolvedCompanyId, agentLookupRef);
  };

  const updateIcon = useMutation({
    mutationFn: (icon: string) => agentsApi.update(agentLookupRef, { icon }, resolvedCompanyId ?? undefined),
    onSuccess: invalidateAgent,
  });

  const updatePermissions = useMutation({
    mutationFn: (permissions: AgentPermissionUpdate) =>
      agentsApi.updatePermissions(agentLookupRef, permissions, resolvedCompanyId ?? undefined),
    onSuccess: () => {
      setActionError(null);
      invalidateAgent();
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to update permissions");
    },
  });

  return { updateIcon, updatePermissions };
}
