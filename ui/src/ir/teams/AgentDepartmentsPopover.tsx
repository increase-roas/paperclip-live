import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Layers } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import {
  buildNextAgentDepartmentsMetadata,
  matchAgentTeams,
  TEAM_HUB_CONFIGS,
  type TeamHubKey,
} from "./teamHubHelpers";

export function AgentDepartmentsPopover({
  agent,
  companyId,
}: {
  agent: Agent;
  companyId: string;
}) {
  const [open, setOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const currentTeams = matchAgentTeams(agent);

  const mutation = useMutation({
    mutationFn: async ({ teamKey, include }: { teamKey: TeamHubKey; include: boolean }) => {
      const current = await agentsApi.getConfiguration(agent.id, companyId);
      const latestTeams = matchAgentTeams({ ...agent, metadata: current.metadata });
      const nextDepartments = include
        ? [...latestTeams, teamKey]
        : latestTeams.filter((entry) => entry !== teamKey);
      return agentsApi.update(
        agent.id,
        {
          metadata: buildNextAgentDepartmentsMetadata(current, nextDepartments),
          expectedConfigurationRevision: current.configurationRevision,
        },
        companyId,
      );
    },
    onSuccess: (updatedAgent) => {
      setErrorMessage(null);
      queryClient.setQueryData<Agent[]>(queryKeys.agents.list(companyId), (prev) =>
        Array.isArray(prev)
          ? prev.map((item) => (item.id === agent.id ? { ...item, ...updatedAgent } : item))
          : prev,
      );
      return queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
    },
    onError: (err) => {
      setErrorMessage(err instanceof Error ? err.message : "Could not update team membership.");
    },
  });

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    setErrorMessage(null);
  };

  const toggleTeam = (teamKey: TeamHubKey) => {
    if (mutation.isPending) return;
    const hasTeam = currentTeams.includes(teamKey);
    if (hasTeam && currentTeams.length <= 1) return;
    mutation.mutate({ teamKey, include: !hasTeam });
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          data-testid={`team-agent-departments-btn-${agent.urlKey}`}
          aria-label={`Manage teams for ${agent.name}`}
        >
          <Layers className="size-3.5" aria-hidden />
          Teams
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60 space-y-2 p-3">
        <div className="space-y-0.5">
          <p className="text-xs font-semibold text-foreground">Department membership</p>
          <p className="text-xs text-muted-foreground">
            One agent record can support multiple Team Hubs.
          </p>
        </div>
        <div className="space-y-1">
          {TEAM_HUB_CONFIGS.map((cfg) => {
            const active = currentTeams.includes(cfg.key);
            const isLast = active && currentTeams.length <= 1;
            return (
              <button
                key={cfg.key}
                type="button"
                aria-pressed={active}
                disabled={mutation.isPending || isLast}
                onClick={() => toggleTeam(cfg.key)}
                data-testid={`team-agent-dept-option-${agent.urlKey}-${cfg.key}`}
                className={cn(
                  "flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs transition-colors",
                  active
                    ? "bg-secondary font-medium text-secondary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  (mutation.isPending || isLast) && "cursor-not-allowed opacity-60",
                )}
              >
                <span>{cfg.label}</span>
                {active ? <Check className="size-3.5" aria-hidden /> : null}
              </button>
            );
          })}
        </div>
        {errorMessage ? (
          <p role="alert" className="text-xs text-destructive">
            {errorMessage}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
