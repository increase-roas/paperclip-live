import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "./queryKeys";

/**
 * Mark the Bot views stale after an agent changes.
 *
 * A bot page is a server-side projection of an agent: its name, title, status,
 * routines and gateway link all come from the agent row. An agent edit that
 * invalidated only the agent queries left an open Bots roster showing the old
 * name and status until its 30-second stale window ran out.
 */
export function invalidateBotViewsForAgent(
  queryClient: QueryClient,
  companyId: string | null | undefined,
  agentId?: string | null,
) {
  if (!companyId) return;
  queryClient.invalidateQueries({ queryKey: queryKeys.bots.list(companyId) });
  if (agentId) {
    queryClient.invalidateQueries({ queryKey: queryKeys.bots.detail(companyId, agentId) });
  }
}
