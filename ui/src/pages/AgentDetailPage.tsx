import { useEffect } from "react";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useQuery } from "@tanstack/react-query";
import { useParams, Link, useNavigate } from "@/lib/router";
import { agentsApi } from "@/api/agents";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { PluginSlotMount, usePluginSlots } from "@/plugins/slots";
import { EmptyState } from "@/components/EmptyState";
import { QueryErrorState, QueryPlaceholder } from "@/components/QueryView";
import { Puzzle } from "lucide-react";
import { AgentDetail } from "./AgentDetail";

export function AgentDetailPage() {
  const { tab } = useParams<{ tab?: string }>();
  return tab?.startsWith("plugin:") ? <AgentPluginDetail /> : <AgentDetail />;
}

function AgentPluginDetail() {
  const { agentId = "", companyPrefix, tab } = useParams<{ agentId: string; companyPrefix?: string; tab: string }>();
  const { companies, selectedCompanyId } = useCompany();
  const navigate = useNavigate();
  const companyId = companies.find(company => company.issuePrefix.toUpperCase() === companyPrefix?.toUpperCase())?.id ?? selectedCompanyId;
  const agentQuery = useQuery({
    queryKey: [...queryKeys.agents.detail(agentId), companyId ?? null],
    queryFn: () => agentsApi.get(agentId, companyId ?? undefined),
    enabled: Boolean(agentId && companyId),
  });
  const { data: agent, isLoading, error, isFetching } = agentQuery;
  const { slots, isLoading: slotsLoading, errorMessage } = usePluginSlots({ slotTypes: ["detailTab"], entityType: "agent", companyId: agent?.companyId, enabled: Boolean(agent) });
  const slot = slots.find(item => `plugin:${item.pluginKey}:${item.id}` === tab);
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => {
    setBreadcrumbs([
      { label: "Agents", href: "/agents" },
      { label: agent?.name ?? agentId, href: `/agents/${encodeURIComponent(agentId)}/overview` },
      { label: slot?.displayName ?? "Plugin view" },
    ]);
  }, [setBreadcrumbs, agent?.name, agentId, slot?.displayName]);
  if (error) {
    return (
      <QueryErrorState
        size="page"
        error={error}
        action="load this agent view"
        onRetry={() => void agentQuery.refetch()}
        retrying={isFetching}
      />
    );
  }
  if (!agent || isLoading || slotsLoading) {
    return <QueryPlaceholder size="page" label="Loading agent view" />;
  }
  return <div className="mx-auto max-w-5xl space-y-4">
    <Link to={`/agents/${encodeURIComponent(agentId)}/overview`} className="text-sm text-muted-foreground">{agent.name}</Link>
    {slot ? <PluginSlotMount slot={slot} context={{ companyId: agent.companyId, companyPrefix: companyPrefix ?? null, entityId: agent.id, entityType: "agent" }} missingBehavior="placeholder" />
      : <EmptyState
          icon={Puzzle}
          title="Agent view unavailable"
          message={errorMessage ? "The plugin views could not load. Try again from the agent overview." : "This plugin view is unavailable. It may have been removed."}
          action="Back to overview"
          onAction={() => navigate(`/agents/${encodeURIComponent(agentId)}/overview`)}
          hideActionIcon
        />}
  </div>;
}
