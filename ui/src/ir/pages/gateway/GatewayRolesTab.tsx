import { useMemo, useState } from "react";
import { AlertTriangle, Shield, SlidersHorizontal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type {
  GatewayAgentRecord,
  GatewayBotSummary,
  GatewayRoleTemplate,
} from "../../api/irOps";
import {
  describeGhlPolicy,
  detectPresetDrift,
  getAgentStatus,
  ROLE_POLICY_DEFINITIONS,
} from "./gatewayHelpers";
import { GatewayAgentStatusBadge } from "./GatewayAgentStatusBadge";

interface GatewayRolesTabProps {
  roles: GatewayRoleTemplate[];
  agents: GatewayAgentRecord[];
  bots: GatewayBotSummary[];
  onApplyRoleToAgent: (agent: GatewayAgentRecord, roleId: string) => void;
  onInspectAgent: (agent: GatewayAgentRecord) => void;
}

export function GatewayRolesTab({
  roles,
  agents,
  bots,
  onApplyRoleToAgent,
  onInspectAgent,
}: GatewayRolesTabProps) {
  const [targetAgentByRole, setTargetAgentByRole] = useState<Record<string, string>>({});

  const effectiveRoles = useMemo<GatewayRoleTemplate[]>(() => {
    if (roles.length > 0) return roles;
    return Object.entries(ROLE_POLICY_DEFINITIONS).map(([id, def]) => ({
      id,
      label: def.label,
      about: def.about,
    }));
  }, [roles]);

  const agentsByName = useMemo(() => {
    const map = new Map<string, GatewayAgentRecord>();
    for (const a of agents) map.set(a.agent, a);
    return map;
  }, [agents]);

  const presetBots = useMemo(() => {
    const list = bots.filter((b) => Boolean(b.preset));
    if (list.length > 0) return list;
    // Fallback if /admin/bots is empty: show known agents from /admin/agents
    return agents.map<GatewayBotSummary>((a) => ({
      agent: a.agent,
      name: a.agent,
      preset: null,
      enabled: a.enabled,
      hasKey: a.hasKey,
      key: { present: a.hasKey, algorithm: null, fingerprint: null, createdAt: null, rotatedAt: null, updatedAt: null },
      providers: a.policy.providers,
      grantedProviders: Object.keys(a.policy.providers ?? {}),
      policy: a.policy,
      usage: { lastUsedAt: null },
    }));
  }, [bots, agents]);

  const defaultTargetAgent = agents[0]?.agent ?? "";

  return (
    <div className="space-y-6">
      {/* Section 1: 5 Gateway Role Templates */}
      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            Gateway Role Templates ({effectiveRoles.length})
          </h2>
          <p className="text-xs text-muted-foreground">
            Reusable GoHighLevel permission profiles. Apply a template to any agent to preview and save inside the policy sheet.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {effectiveRoles.map((role) => {
            const def = ROLE_POLICY_DEFINITIONS[role.id];
            const selectedAgentName = targetAgentByRole[role.id] ?? defaultTargetAgent;
            const targetRecord = agentsByName.get(selectedAgentName);
            const flagBadges = def
              ? describeGhlPolicy({
                  ...def.patch,
                  locations: "*",
                  providers: {},
                })
              : null;

            return (
              <Card key={role.id} className="flex flex-col justify-between gap-4 py-4">
                <CardHeader className="gap-1.5 px-4 py-0">
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="flex items-center gap-1.5 text-sm font-semibold">
                      <Shield className="size-3.5 text-muted-foreground" />
                      {role.label}
                    </CardTitle>
                    <Badge variant="secondary" className="font-mono text-xs font-normal">
                      {role.id}
                    </Badge>
                  </div>
                  <CardDescription className="text-xs leading-relaxed">
                    {role.about}
                  </CardDescription>
                </CardHeader>

                <CardContent className="space-y-3 px-4 py-0">
                  {flagBadges && (
                    <div className="flex flex-wrap gap-1.5">
                      <Badge
                        variant="outline"
                        className={cn(
                          "font-normal",
                          flagBadges.mode === "write" &&
                            "border-violet-500/35 bg-violet-500/15 text-violet-200",
                          flagBadges.mode === "drafts_only" &&
                            "border-amber-500/30 bg-amber-500/10 text-amber-300",
                          flagBadges.mode === "read_only" &&
                            "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
                        )}
                      >
                        {flagBadges.label}
                      </Badge>
                      {flagBadges.flags.map((flag) => (
                        <Badge
                          key={flag}
                          variant="secondary"
                          className="font-mono text-xs font-normal"
                        >
                          {flag}
                        </Badge>
                      ))}
                    </div>
                  )}

                  {agents.length > 0 && (
                    <div className="flex items-center gap-2 pt-1">
                      <Select
                        value={selectedAgentName}
                        onValueChange={(value) =>
                          setTargetAgentByRole((prev) => ({ ...prev, [role.id]: value }))
                        }
                      >
                        <SelectTrigger className="h-8 flex-1 text-xs">
                          <SelectValue placeholder="Choose agent…" />
                        </SelectTrigger>
                        <SelectContent>
                          {agents.map((a) => (
                            <SelectItem key={a.agent} value={a.agent}>
                              {a.agent}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={!targetRecord}
                        onClick={() => {
                          if (targetRecord) onApplyRoleToAgent(targetRecord, role.id);
                        }}
                      >
                        Apply
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>

      {/* Section 2: Checked-in Agent Presets */}
      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            Agent Presets ({presetBots.length})
          </h2>
          <p className="text-xs text-muted-foreground">
            Checked-in baseline policies per specialist agent. Open any agent to inspect live drift or reset to its baseline preset in one click.
          </p>
        </div>

        <Card className="gap-0 overflow-hidden py-0">
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-muted-foreground">
                  <th className="px-4 py-2.5 font-medium">Agent</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="px-3 py-2.5 font-medium">GHL Mode</th>
                  <th className="px-3 py-2.5 font-medium">Providers</th>
                  <th className="px-3 py-2.5 font-medium">Preset Purpose</th>
                  <th className="px-4 py-2.5 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {presetBots.map((bot) => {
                  const record: GatewayAgentRecord = agentsByName.get(bot.agent) ?? {
                    agent: bot.agent,
                    hasKey: bot.hasKey,
                    enabled: bot.enabled,
                    opRef: null,
                    policy: bot.policy,
                  };
                  const status = getAgentStatus(record);
                  const ghl = describeGhlPolicy(record.policy);
                  const drift = detectPresetDrift(bot.agent, record.policy, bot);

                  return (
                    <tr key={bot.agent} className="hover:bg-accent/25">
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono font-semibold text-foreground">
                            {bot.agent}
                          </span>
                          {drift.drifted && (
                            <Badge
                              variant="outline"
                              className="gap-1 border-amber-500/30 bg-amber-500/10 px-1.5 py-0 text-xs font-normal text-amber-300"
                            >
                              <AlertTriangle className="size-3" />
                              Drifted
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <GatewayAgentStatusBadge status={status} />
                      </td>
                      <td className="px-3 py-2.5">
                        <Badge variant="outline" className="font-normal">
                          {ghl.label}
                        </Badge>
                      </td>
                      <td className="px-3 py-2.5 font-mono text-muted-foreground">
                        {bot.grantedProviders.length > 0
                          ? `${bot.grantedProviders.length} granted`
                          : "GHL only"}
                      </td>
                      <td className="max-w-md px-3 py-2.5 text-muted-foreground">
                        {bot.preset?.description ?? "—"}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          onClick={() => onInspectAgent(record)}
                        >
                          <SlidersHorizontal className="size-3" />
                          {drift.drifted ? "Review & Reset" : "Configure"}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
