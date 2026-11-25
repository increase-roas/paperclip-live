import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  KeyRound,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { cn } from "@/lib/utils";
import { copyTextToClipboard } from "@/lib/clipboard";
import {
  irOpsApi,
  type GatewayAgentRecord,
  type GatewayBotSummary,
  type GatewayPolicy,
  type GatewayProviderSummary,
  type GatewayRoleTemplate,
  type GhlPolicyMode,
  type ProviderGrantValue,
} from "../../api/irOps";
import {
  detectPresetDrift,
  getAgentStatus,
  getProviderCapabilityProfile,
  normalizeProviderGrant,
  ROLE_POLICY_DEFINITIONS,
} from "./gatewayHelpers";

interface AgentPolicySheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: GatewayAgentRecord | null;
  bot?: GatewayBotSummary;
  providers: GatewayProviderSummary[];
  roles: GatewayRoleTemplate[];
  initialRoleToApply?: string | null;
  onSaved: () => void;
}

const GHL_GUARDRAILS: Array<{
  key: keyof Pick<
    GatewayPolicy,
    "allowDelete" | "allowOutbound" | "allowAgencyWrite" | "allowBulk" | "allowSpend" | "allowBuild"
  >;
  label: string;
  description: string;
}> = [
  {
    key: "allowDelete",
    label: "Allow deletes",
    description: "Permit HTTP DELETE requests against HighLevel records.",
  },
  {
    key: "allowOutbound",
    label: "Allow outbound messages",
    description: "Permit sending SMS, email, or publishing external messages.",
  },
  {
    key: "allowAgencyWrite",
    label: "Allow agency writes",
    description: "Permit agency-level sub-account, user, SaaS, and snapshot mutations.",
  },
  {
    key: "allowBulk",
    label: "Allow bulk writes",
    description: "Permit multi-record bulk write jobs.",
  },
  {
    key: "allowSpend",
    label: "Allow spend",
    description: "Permit purchasing phone numbers, billing charges, or SaaS plan changes.",
  },
  {
    key: "allowBuild",
    label: "Allow Command build",
    description: "Permit GHL Command funnel and page builder mutations.",
  },
];

function clonePolicy(policy: GatewayPolicy): GatewayPolicy {
  return {
    ...policy,
    locations: Array.isArray(policy.locations) ? [...policy.locations] : "*",
    outboundChannels: Array.isArray(policy.outboundChannels) ? [...policy.outboundChannels] : null,
    providers: Object.fromEntries(
      Object.entries(policy.providers ?? {}).map(([k, v]) => [
        k,
        typeof v === "string"
          ? v
          : {
              ...v,
              ...(Array.isArray(v.actions) ? { actions: [...v.actions] } : {}),
            },
      ]),
    ),
    secrets: Array.isArray(policy.secrets) ? [...policy.secrets] : [],
    scopes: Array.isArray(policy.scopes) ? [...policy.scopes] : [],
  };
}

export function AgentPolicySheet({
  open,
  onOpenChange,
  agent,
  bot,
  providers,
  roles,
  initialRoleToApply,
  onSaved,
}: AgentPolicySheetProps) {
  const [draft, setDraft] = useState<GatewayPolicy | null>(null);
  const [enabledDraft, setEnabledDraft] = useState(false);
  const [locationsMode, setLocationsMode] = useState<"all" | "scoped">("all");
  const [locationsText, setLocationsText] = useState("");
  const [providerSearch, setProviderSearch] = useState("");
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(() => new Set());
  const [selectedRoleTemplate, setSelectedRoleTemplate] = useState<string>("");

  const [saving, setSaving] = useState(false);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [keyBusy, setKeyBusy] = useState(false);
  const [issuedKey, setIssuedKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const latestAgentRef = useRef<GatewayAgentRecord | null>(agent);
  latestAgentRef.current = agent;
  const agentKey = agent?.agent ?? null;

  useEffect(() => {
    const currentAgent = latestAgentRef.current;
    if (!currentAgent || !open) return;
    let initial = clonePolicy(currentAgent.policy);
    if (initialRoleToApply && ROLE_POLICY_DEFINITIONS[initialRoleToApply]) {
      initial = { ...initial, ...ROLE_POLICY_DEFINITIONS[initialRoleToApply].patch };
    }
    setDraft(initial);
    setEnabledDraft(currentAgent.enabled);
    if (initial.locations === "*") {
      setLocationsMode("all");
      setLocationsText("");
    } else {
      setLocationsMode("scoped");
      setLocationsText(initial.locations.join(", "));
    }
    setSelectedRoleTemplate(initialRoleToApply ?? currentAgent.policy.role ?? "");
    setIssuedKey(null);
    setError(null);
    setNotice(
      initialRoleToApply && ROLE_POLICY_DEFINITIONS[initialRoleToApply]
        ? `Loaded "${ROLE_POLICY_DEFINITIONS[initialRoleToApply].label}" template — review and click Save policy.`
        : null,
    );
    setExpandedProviders(new Set());
  }, [open, agentKey, initialRoleToApply]);

  const drift = useMemo(() => {
    if (!agent || !draft) return { drifted: false, presetPolicy: null };
    return detectPresetDrift(agent.agent, draft, bot);
  }, [agent, draft, bot]);

  const filteredProviders = useMemo(() => {
    const q = providerSearch.trim().toLowerCase();
    return providers.filter((p) => {
      if (!q) return true;
      return (
        p.id.toLowerCase().includes(q) ||
        p.label.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q)
      );
    });
  }, [providers, providerSearch]);

  if (!agent || !draft) return null;

  const status = getAgentStatus({ hasKey: agent.hasKey, enabled: enabledDraft });

  const applyRoleTemplate = (roleId: string) => {
    const def = ROLE_POLICY_DEFINITIONS[roleId];
    if (!def) return;
    setSelectedRoleTemplate(roleId);
    setDraft((prev) => (prev ? { ...prev, ...def.patch } : prev));
    setNotice(`Applied "${def.label}" GHL template to draft. Click Save policy to commit.`);
    setError(null);
  };

  const resetToPreset = () => {
    if (!drift.presetPolicy) return;
    setDraft((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        mode: drift.presetPolicy?.mode ?? "read_only",
        allowDelete: Boolean(drift.presetPolicy?.allowDelete),
        allowOutbound: Boolean(drift.presetPolicy?.allowOutbound),
        allowAgencyWrite: Boolean(drift.presetPolicy?.allowAgencyWrite),
        allowBulk: Boolean(drift.presetPolicy?.allowBulk),
        allowSpend: Boolean(drift.presetPolicy?.allowSpend),
        allowBuild: Boolean(drift.presetPolicy?.allowBuild),
        outboundChannels: drift.presetPolicy?.outboundChannels ?? null,
        locations: drift.presetPolicy?.locations ?? "*",
        providers: drift.presetPolicy?.providers
          ? { ...drift.presetPolicy.providers }
          : prev.providers,
      };
    });
    setLocationsMode("all");
    setLocationsText("");
    setNotice("Reset draft to agent's checked-in preset. Click Save policy to commit.");
    setError(null);
  };

  const extractExtraGrantFields = (
    grant: ProviderGrantValue | undefined,
  ): Partial<Extract<ProviderGrantValue, object>> => {
    if (!grant || typeof grant !== "object") return {};
    return {
      ...(Array.isArray(grant.hooks) ? { hooks: [...grant.hooks] } : {}),
      ...(Array.isArray(grant.resources) ? { resources: [...grant.resources] } : {}),
      ...(Array.isArray(grant.teams) ? { teams: [...grant.teams] } : {}),
    };
  };

  const setProviderCapability = (provider: GatewayProviderSummary, cap: "none" | "read" | "write") => {
    setDraft((prev) => {
      if (!prev) return prev;
      const nextProviders: Record<string, ProviderGrantValue> = { ...prev.providers };
      if (cap === "none") {
        delete nextProviders[provider.id];
      } else {
        const prevGrant = nextProviders[provider.id];
        const extra = extractExtraGrantFields(prevGrant);
        const existing = normalizeProviderGrant(prevGrant);
        const hasExtra = Object.keys(extra).length > 0;
        if ((existing.actions && existing.actions.length > 0) || hasExtra) {
          nextProviders[provider.id] = {
            ...extra,
            capability: cap,
            ...(existing.actions && existing.actions.length > 0
              ? { actions: existing.actions }
              : {}),
          };
        } else {
          nextProviders[provider.id] = cap;
        }
      }
      return { ...prev, providers: nextProviders };
    });
  };

  const toggleProviderAction = (provider: GatewayProviderSummary, actionId: string, checked: boolean) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const allActions = provider.actions ?? [];
      const prevGrant = prev.providers[provider.id];
      const extra = extractExtraGrantFields(prevGrant);
      const hasExtra = Object.keys(extra).length > 0;
      const current = normalizeProviderGrant(prevGrant);
      const cap = current.capability === "none" ? "read" : current.capability;
      const baseSet = new Set(current.actions ?? allActions);
      if (checked) baseSet.add(actionId);
      else baseSet.delete(actionId);
      const nextList = allActions.filter((a) => baseSet.has(a));
      const nextProviders: Record<string, ProviderGrantValue> = { ...prev.providers };
      if (nextList.length === 0) {
        delete nextProviders[provider.id];
      } else if (nextList.length === allActions.length) {
        nextProviders[provider.id] = hasExtra ? { ...extra, capability: cap } : cap;
      } else {
        nextProviders[provider.id] = { ...extra, capability: cap, actions: nextList };
      }
      return { ...prev, providers: nextProviders };
    });
  };

  const handleSavePolicy = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const locations: "*" | string[] =
        locationsMode === "all"
          ? "*"
          : locationsText
              .split(/[\s,]+/)
              .map((s) => s.trim())
              .filter(Boolean);

      const patch: Partial<GatewayPolicy> = {
        mode: draft.mode,
        allowDelete: draft.allowDelete,
        allowOutbound: draft.allowOutbound,
        allowAgencyWrite: draft.allowAgencyWrite,
        allowBulk: draft.allowBulk,
        allowSpend: draft.allowSpend,
        allowBuild: draft.allowBuild,
        outboundChannels: draft.outboundChannels ?? null,
        locations,
        providers: draft.providers,
        ...(Array.isArray(draft.secrets) ? { secrets: draft.secrets } : {}),
        ...(Array.isArray(draft.scopes) ? { scopes: draft.scopes } : {}),
        ...(typeof draft.admin === "boolean" ? { admin: draft.admin } : {}),
      };
      await irOpsApi.gateway.updateAgentPolicy(agent.agent, patch);
      setNotice("Policy updated live — no key rotation required.");
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save agent policy.");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleEnabled = async (nextEnabled: boolean) => {
    setToggleBusy(true);
    setError(null);
    setNotice(null);
    try {
      await irOpsApi.gateway.upsertAgent(agent.agent, { enabled: nextEnabled });
      setEnabledDraft(nextEnabled);
      setNotice(nextEnabled ? `Enabled ${agent.agent}.` : `Disabled ${agent.agent}.`);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update agent status.");
    } finally {
      setToggleBusy(false);
    }
  };

  const handleIssueOrRotateKey = async () => {
    setKeyBusy(true);
    setError(null);
    setNotice(null);
    setIssuedKey(null);
    try {
      const res = agent.hasKey
        ? await irOpsApi.gateway.rotateAgentKey(agent.agent)
        : await irOpsApi.gateway.createAgentKey(agent.agent, {
            replace: true,
            policy: draft,
          });
      const token = res.key ?? res.token ?? res.apiKey;
      if (token) setIssuedKey(String(token));
      setNotice(
        agent.hasKey
          ? "Key rotated. Copy the new key now — it is shown once."
          : "Key issued. Copy it now — it is shown once.",
      );
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not issue or rotate key.");
    } finally {
      setKeyBusy(false);
    }
  };

  const handleRevokeKey = async () => {
    setKeyBusy(true);
    setError(null);
    setNotice(null);
    try {
      await irOpsApi.gateway.revokeAgentKey(agent.agent);
      setIssuedKey(null);
      setNotice(`Revoked gateway key for ${agent.agent}.`);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke key.");
    } finally {
      setKeyBusy(false);
      setRevokeOpen(false);
    }
  };

  const handleCopyKey = async () => {
    if (!issuedKey) return;
    try {
      await copyTextToClipboard(issuedKey);
      setCopiedKey(true);
      window.setTimeout(() => setCopiedKey(false), 2000);
    } catch {
      setError("Copy blocked by browser. Select the key and copy manually.");
    }
  };

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl"
        >
          <SheetHeader className="border-b border-border px-5 py-4">
            <div className="flex flex-wrap items-center gap-2 pr-6">
              <SheetTitle className="font-mono text-base">{agent.agent}</SheetTitle>
              <Badge
                variant="outline"
                className={cn(
                  "font-normal",
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
              {bot?.key.fingerprint && (
                <Badge variant="secondary" className="font-mono text-xs font-normal">
                  sha256:{bot.key.fingerprint}
                </Badge>
              )}
            </div>
            <SheetDescription className="text-xs">
              {bot?.preset?.description ??
                "Edit live HighLevel and provider permissions. Policy changes apply immediately without rotating keys."}
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
            {drift.drifted && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="size-4 shrink-0 text-amber-300" />
                  <span>{drift.reason ?? "Live policy differs from this agent's preset."}</span>
                </div>
                {drift.presetPolicy && (
                  <Button type="button" variant="outline" size="xs" onClick={resetToPreset}>
                    <RotateCcw className="size-3" />
                    Reset to preset
                  </Button>
                )}
              </div>
            )}

            {notice && (
              <div
                role="status"
                className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300"
              >
                <ShieldCheck className="size-4 shrink-0" />
                <span>{notice}</span>
              </div>
            )}

            {error && (
              <div
                role="alert"
                className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              >
                <ShieldAlert className="size-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {/* One-click Role Template / Preset Strip */}
            <section className="space-y-2 rounded-lg border border-border bg-muted/30 p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Quick Role & Preset Templates
                </span>
                {drift.presetPolicy && (
                  <Button type="button" variant="ghost" size="xs" onClick={resetToPreset}>
                    <RotateCcw className="size-3" />
                    Reset to agent preset
                  </Button>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Select value={selectedRoleTemplate} onValueChange={applyRoleTemplate}>
                  <SelectTrigger className="h-8 flex-1 text-xs">
                    <SelectValue placeholder="Apply a Gateway role template…" />
                  </SelectTrigger>
                  <SelectContent>
                    {(roles.length > 0
                      ? roles
                      : Object.entries(ROLE_POLICY_DEFINITIONS).map(([id, def]) => ({
                          id,
                          label: def.label,
                          about: def.about,
                        }))
                    ).map((role) => (
                      <SelectItem key={role.id} value={role.id}>
                        {role.label} ({role.id})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </section>

            {/* GoHighLevel Policy */}
            <section className="space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                GoHighLevel Access
              </h3>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="policy-ghl-mode" className="text-xs">
                    GHL mode
                  </Label>
                  <Select
                    value={draft.mode}
                    onValueChange={(v) =>
                      setDraft((prev) => (prev ? { ...prev, mode: v as GhlPolicyMode } : prev))
                    }
                  >
                    <SelectTrigger id="policy-ghl-mode" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="read_only">Read only</SelectItem>
                      <SelectItem value="drafts_only">Drafts only</SelectItem>
                      <SelectItem value="write">Read + Write</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="policy-locations-mode" className="text-xs">
                    Sub-account locations
                  </Label>
                  <Select
                    value={locationsMode}
                    onValueChange={(v) => setLocationsMode(v as "all" | "scoped")}
                  >
                    <SelectTrigger id="policy-locations-mode" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All locations (*)</SelectItem>
                      <SelectItem value="scoped">Specific location IDs</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {locationsMode === "scoped" && (
                <div className="space-y-1.5">
                  <Label htmlFor="policy-locations-input" className="text-xs">
                    Allowed GHL Location IDs (comma separated)
                  </Label>
                  <Input
                    id="policy-locations-input"
                    className="font-mono text-xs"
                    value={locationsText}
                    onChange={(e) => setLocationsText(e.target.value)}
                    placeholder="loc_abc123, loc_def456"
                  />
                </div>
              )}

              <div className="divide-y divide-border rounded-lg border border-border">
                {GHL_GUARDRAILS.map((guardrail) => (
                  <div
                    key={guardrail.key}
                    className="flex items-center justify-between gap-3 px-3.5 py-2.5"
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-foreground">{guardrail.label}</div>
                      <div className="text-xs text-muted-foreground">{guardrail.description}</div>
                    </div>
                    <ToggleSwitch
                      aria-label={guardrail.label}
                      checked={Boolean(draft[guardrail.key])}
                      onCheckedChange={(checked) =>
                        setDraft((prev) => (prev ? { ...prev, [guardrail.key]: checked } : prev))
                      }
                    />
                  </div>
                ))}
              </div>
            </section>

            <Separator />

            {/* Per-Provider Accordion */}
            <section className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Provider Permissions ({Object.keys(draft.providers ?? {}).length} granted)
                </h3>
                <Input
                  value={providerSearch}
                  onChange={(e) => setProviderSearch(e.target.value)}
                  placeholder="Filter providers…"
                  className="h-7 w-44 text-xs"
                />
              </div>

              <div className="divide-y divide-border rounded-lg border border-border">
                {filteredProviders.map((provider) => {
                  const profile = getProviderCapabilityProfile(provider);
                  const grant = normalizeProviderGrant(draft.providers[provider.id]);
                  const actions = provider.actions ?? [];
                  const hasActions = actions.length > 0;
                  const expanded = expandedProviders.has(provider.id);
                  const selectedActions = grant.actions ?? actions;

                  return (
                    <div key={provider.id} className="px-3.5 py-2.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            if (!hasActions) return;
                            setExpandedProviders((prev) => {
                              const next = new Set(prev);
                              if (next.has(provider.id)) next.delete(provider.id);
                              else next.add(provider.id);
                              return next;
                            });
                          }}
                          className={cn(
                            "flex min-w-0 flex-1 items-center gap-2 text-left",
                            !hasActions && "cursor-default",
                          )}
                        >
                          {hasActions ? (
                            expanded ? (
                              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                            )
                          ) : (
                            <span className="inline-block size-3.5 shrink-0" />
                          )}
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate text-xs font-medium text-foreground">
                                {provider.label}
                              </span>
                              {profile.isReadOnly && (
                                <Badge variant="outline" className="px-1 py-0 text-xs font-normal text-muted-foreground">
                                  RO
                                </Badge>
                              )}
                              {profile.isWriteOnly && (
                                <Badge variant="outline" className="px-1 py-0 text-xs font-normal text-muted-foreground">
                                  WO
                                </Badge>
                              )}
                              {grant.capability !== "none" && hasActions && (
                                <Badge variant="secondary" className="px-1.5 py-0 font-mono text-xs font-normal">
                                  {selectedActions.length}/{actions.length}
                                </Badge>
                              )}
                            </div>
                            <div className="font-mono text-xs text-muted-foreground">
                              {provider.id} · {provider.category}
                            </div>
                          </div>
                        </button>

                        <Select
                          value={grant.capability}
                          onValueChange={(v) =>
                            setProviderCapability(provider, v as "none" | "read" | "write")
                          }
                        >
                          <SelectTrigger className="h-7 w-32 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">None</SelectItem>
                            {profile.supportsRead && (
                              <SelectItem value="read">
                                {profile.isReadOnly ? "Read (RO)" : "Read"}
                              </SelectItem>
                            )}
                            {profile.supportsWrite && (
                              <SelectItem value="write">
                                {profile.isWriteOnly ? "Write" : "Read + Write"}
                              </SelectItem>
                            )}
                          </SelectContent>
                        </Select>
                      </div>

                      {hasActions && expanded && grant.capability !== "none" && (
                        <div className="mt-2.5 grid grid-cols-2 gap-2 rounded-md bg-muted/40 p-2.5 sm:grid-cols-3">
                          {actions.map((actionId) => {
                            const checked = selectedActions.includes(actionId);
                            const actionCap = provider.actionCapabilities?.[actionId];
                            return (
                              <label
                                key={actionId}
                                className="flex cursor-pointer items-center gap-2 text-xs text-foreground"
                              >
                                <Checkbox
                                  checked={checked}
                                  onCheckedChange={(val) =>
                                    toggleProviderAction(provider, actionId, val === true)
                                  }
                                />
                                <span className="truncate font-mono">{actionId}</span>
                                {actionCap && (
                                  <span className="text-muted-foreground">({actionCap})</span>
                                )}
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>

            <Separator />

            {/* Key & Enablement Lifecycle */}
            <section className="space-y-3 rounded-lg border border-border p-3.5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-xs font-semibold text-foreground">Key enabled</h3>
                  <p className="text-xs text-muted-foreground">
                    Temporarily disable or re-enable this agent's gateway key without deleting its policy.
                  </p>
                </div>
                <ToggleSwitch
                  aria-label="Enable agent key"
                  disabled={!agent.hasKey || toggleBusy}
                  checked={enabledDraft}
                  onCheckedChange={(next) => void handleToggleEnabled(next)}
                />
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={keyBusy}
                  onClick={() => void handleIssueOrRotateKey()}
                >
                  <KeyRound className="size-3.5" />
                  {keyBusy ? "Working…" : agent.hasKey ? "Rotate key" : "Issue key"}
                </Button>
                {agent.hasKey && (
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={keyBusy}
                    onClick={() => setRevokeOpen(true)}
                  >
                    Revoke key
                  </Button>
                )}
              </div>

              {issuedKey && (
                <div className="space-y-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3">
                  <div className="text-xs font-medium text-emerald-300">
                    New gateway key (copy now — shown once)
                  </div>
                  <div className="flex items-center gap-2">
                    <Input readOnly value={issuedKey} className="font-mono text-xs" />
                    <Button type="button" variant="outline" size="sm" onClick={() => void handleCopyKey()}>
                      {copiedKey ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                      {copiedKey ? "Copied" : "Copy"}
                    </Button>
                  </div>
                </div>
              )}
            </section>
          </div>

          {/* DESIGN.md Footer Rule: Cancel left, Save policy right */}
          <SheetFooter className="flex-row items-center justify-between border-t border-border px-5 py-3.5 sm:justify-between">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" disabled={saving} onClick={() => void handleSavePolicy()}>
              {saving ? "Saving…" : "Save policy"}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <AlertDialog open={revokeOpen} onOpenChange={setRevokeOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke key for {agent.agent}?</AlertDialogTitle>
            <AlertDialogDescription>
              This immediately invalidates the active gateway key for {agent.agent}. Its saved policy
              remains intact if you issue a replacement key later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-row items-center justify-between sm:justify-between">
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleRevokeKey()}>
              Revoke key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
