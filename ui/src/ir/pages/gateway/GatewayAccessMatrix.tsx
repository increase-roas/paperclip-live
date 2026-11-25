import { useMemo, useState } from "react";
import { AlertTriangle, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type {
  GatewayAgentRecord,
  GatewayBotSummary,
  GatewayProviderSummary,
} from "../../api/irOps";
import {
  describeGhlPolicy,
  describeProviderGrant,
  detectPresetDrift,
  getAgentStatus,
} from "./gatewayHelpers";

interface GatewayAccessMatrixProps {
  agents: GatewayAgentRecord[];
  botsByAgent: Record<string, GatewayBotSummary>;
  providers: GatewayProviderSummary[];
  onSelectAgent: (agent: GatewayAgentRecord) => void;
}

export function GatewayAccessMatrix({
  agents,
  botsByAgent,
  providers,
  onSelectAgent,
}: GatewayAccessMatrixProps) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [showInactive, setShowInactive] = useState(false);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const p of providers) {
      if (p.category) set.add(p.category);
    }
    return [...set].sort();
  }, [providers]);

  const visibleProviders = useMemo(
    () =>
      category === "all" ? providers : providers.filter((provider) => provider.category === category),
    [providers, category],
  );

  const activeKeyedCount = useMemo(
    () => agents.filter((a) => a.hasKey && a.enabled).length,
    [agents],
  );

  const visibleAgents = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = agents.filter((a) => {
      if (!showInactive && !(a.hasKey && a.enabled)) return false;
      if (q && !a.agent.toLowerCase().includes(q)) return false;
      return true;
    });
    return [...filtered].sort((a, b) => {
      const aActive = a.hasKey && a.enabled ? 0 : a.hasKey ? 1 : 2;
      const bActive = b.hasKey && b.enabled ? 0 : b.hasKey ? 1 : 2;
      if (aActive !== bActive) return aActive - bActive;
      return a.agent.localeCompare(b.agent);
    });
  }, [agents, search, showInactive]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-56">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter agents…"
              className="h-8 pl-8 text-xs"
            />
          </div>

          <div className="flex flex-wrap items-center gap-1">
            <Button
              type="button"
              size="xs"
              variant={category === "all" ? "secondary" : "ghost"}
              onClick={() => setCategory("all")}
            >
              All ({providers.length + 1})
            </Button>
            {categories.map((cat) => (
              <Button
                key={cat}
                type="button"
                size="xs"
                variant={category === cat ? "secondary" : "ghost"}
                onClick={() => setCategory(cat)}
              >
                {cat}
              </Button>
            ))}
          </div>
        </div>

        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <ToggleSwitch
            aria-label="Show inactive or keyless agents"
            checked={showInactive}
            onCheckedChange={setShowInactive}
          />
          <span>
            Show inactive / keyless agents ({activeKeyedCount} active / {agents.length} total)
          </span>
        </label>
      </div>

      <Card className="gap-0 overflow-hidden py-0">
        <CardContent className="overflow-x-auto p-0">
          {visibleAgents.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              {agents.length === 0
                ? "No agents returned from the OAuth Gateway."
                : "No agents match the active filter. Toggle inactive agents to see preset-only entries."}
            </div>
          ) : (
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-border bg-muted/50 text-muted-foreground">
                  <th className="sticky left-0 z-20 min-w-52 border-r border-border bg-muted px-4 py-2.5 font-semibold text-foreground">
                    Agent
                  </th>
                  <th className="min-w-36 border-r border-border px-3 py-2.5 font-semibold text-foreground">
                    GoHighLevel
                  </th>
                  {visibleProviders.map((provider) => (
                    <th
                      key={provider.id}
                      className="min-w-28 border-r border-border/60 px-3 py-2.5 font-medium last:border-r-0"
                    >
                      <div className="truncate text-foreground">{provider.label}</div>
                      <div className="truncate font-mono text-xs font-normal text-muted-foreground">
                        {provider.category}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {visibleAgents.map((agent) => {
                  const status = getAgentStatus(agent);
                  const bot = botsByAgent[agent.agent];
                  const drift = detectPresetDrift(agent.agent, agent.policy, bot);
                  const ghl = describeGhlPolicy(agent.policy);

                  return (
                    <tr
                      key={agent.agent}
                      onClick={() => onSelectAgent(agent)}
                      className="group cursor-pointer transition-colors hover:bg-accent/40"
                    >
                      {/* Sticky Agent Column */}
                      <td className="sticky left-0 z-10 border-r border-border bg-card px-4 py-2.5 group-hover:bg-accent">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-mono text-xs font-semibold text-foreground">
                            {agent.agent}
                          </span>
                          {drift.drifted && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span
                                  aria-label="Preset drift detected"
                                  className="inline-flex shrink-0 items-center text-amber-300"
                                >
                                  <AlertTriangle className="size-3.5" />
                                </span>
                              </TooltipTrigger>
                              <TooltipContent side="right">
                                {drift.reason ?? "Policy differs from preset"}
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                        <div className="mt-1 flex items-center gap-1.5">
                          <Badge
                            variant="outline"
                            className={cn(
                              "px-1.5 py-0 text-xs font-normal",
                              status.kind === "active" &&
                                "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
                              status.kind === "disabled" &&
                                "border-destructive/40 bg-destructive/10 text-destructive",
                              status.kind === "no_key" &&
                                "border-border bg-muted text-muted-foreground",
                            )}
                          >
                            {status.label}
                          </Badge>
                          {agent.policy.role && (
                            <span className="font-mono text-xs text-muted-foreground">
                              {agent.policy.role}
                            </span>
                          )}
                        </div>
                      </td>

                      {/* GoHighLevel Column */}
                      <td className="border-r border-border px-3 py-2.5 align-top">
                        <div className="flex flex-col gap-1">
                          <Badge
                            variant="outline"
                            className={cn(
                              "w-fit font-normal",
                              ghl.mode === "write" &&
                                "border-violet-500/35 bg-violet-500/15 text-violet-200",
                              ghl.mode === "drafts_only" &&
                                "border-amber-500/30 bg-amber-500/10 text-amber-300",
                              ghl.mode === "read_only" &&
                                "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
                            )}
                          >
                            {ghl.label}
                          </Badge>
                          {ghl.flags.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {ghl.flags.map((flag) => (
                                <Badge
                                  key={flag}
                                  variant="secondary"
                                  className="px-1 py-0 font-mono text-xs font-normal"
                                >
                                  {flag}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </div>
                      </td>

                      {/* Provider Columns */}
                      {visibleProviders.map((provider) => {
                        const cell = describeProviderGrant(
                          agent.policy.providers?.[provider.id],
                          provider,
                        );
                        return (
                          <td
                            key={provider.id}
                            className="border-r border-border/60 px-3 py-2.5 align-top last:border-r-0"
                          >
                            {cell.level === "none" ? (
                              <span className="text-muted-foreground">—</span>
                            ) : (
                              <div className="flex flex-col gap-1">
                                <Badge
                                  variant="outline"
                                  className={cn(
                                    "w-fit font-normal",
                                    (cell.level === "read" || cell.level === "read_ro") &&
                                      "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
                                    cell.level === "write" &&
                                      "border-amber-500/30 bg-amber-500/10 text-amber-300",
                                    cell.level === "read_write" &&
                                      "border-violet-500/35 bg-violet-500/15 text-violet-200",
                                  )}
                                >
                                  {cell.label}
                                </Badge>
                                {cell.actionSummary && (
                                  <span className="font-mono text-xs text-muted-foreground">
                                    {cell.actionSummary} actions
                                  </span>
                                )}
                              </div>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
