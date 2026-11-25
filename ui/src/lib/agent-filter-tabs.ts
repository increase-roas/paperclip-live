export const AGENT_FILTER_TABS = ["all", "active", "paused", "error", "builtin"] as const;
export type AgentFilterTab = (typeof AGENT_FILTER_TABS)[number];

export function isAgentFilterTab(value: string): value is AgentFilterTab {
  return (AGENT_FILTER_TABS as readonly string[]).includes(value);
}

// Agents in these states never appear in the agents list — `terminated` is
// hidden like an archived company, and `pending_approval` is a hiring gate that
// lives in the task thread, not an agent run state (PAP-75).
export const HIDDEN_AGENT_STATUSES = new Set(["terminated", "pending_approval"]);

export function agentStatusMatchesFilter(status: string, tab: AgentFilterTab): boolean {
  if (tab === "all") return true;
  if (tab === "active") return status === "active" || status === "running" || status === "idle";
  if (tab === "paused") return status === "paused";
  if (tab === "error") return status === "error";
  return true;
}
