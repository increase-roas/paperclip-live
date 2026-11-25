import { useMemo, useState } from "react";
import { AlertTriangle, ExternalLink, Plus, Search, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  irOpsApi,
  type GatewayProviderSummary,
  type GatewayScopeEntry,
  type GatewayScopesCatalogResponse,
  type GatewayStatusResponse,
} from "../../api/irOps";
import { AddScopeDialog } from "./AddScopeDialog";
import { buildNormalizedScopesCatalog } from "./gatewayHelpers";

interface GatewayScopesCatalogProps {
  catalog: GatewayScopesCatalogResponse | null;
  providers: GatewayProviderSummary[];
  status: GatewayStatusResponse | null;
  onRefresh: () => void;
}

function AccessPill({ access }: { access: GatewayScopeEntry["access"] }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "font-normal capitalize",
        access === "read" && "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
        access === "write" && "border-amber-500/30 bg-amber-500/10 text-amber-300",
        access === "both" && "border-violet-500/30 bg-violet-500/10 text-violet-300",
        access === "action" && "border-border bg-muted text-muted-foreground",
      )}
    >
      {access === "both" ? "Read + Write" : access}
    </Badge>
  );
}

function ScopeStatusPill({ status }: { status: GatewayScopeEntry["status"] }) {
  if (status === "granted") {
    return (
      <Badge
        variant="outline"
        className="border-emerald-500/30 bg-emerald-500/10 text-emerald-400 font-normal"
      >
        Granted live
      </Badge>
    );
  }
  if (status === "pending_reauth") {
    return (
      <Badge
        variant="outline"
        className="border-amber-500/30 bg-amber-500/10 text-amber-300 font-normal"
      >
        Pending re-auth
      </Badge>
    );
  }
  if (status === "custom") {
    return (
      <Badge
        variant="outline"
        className="border-violet-500/30 bg-violet-500/10 text-violet-300 font-normal"
      >
        Custom
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="border-border bg-muted/60 text-muted-foreground font-normal">
      Built-in
    </Badge>
  );
}

export function GatewayScopesCatalog({
  catalog,
  providers,
  status,
  onRefresh,
}: GatewayScopesCatalogProps) {
  const normalized = useMemo(
    () => buildNormalizedScopesCatalog(catalog, providers, status),
    [catalog, providers, status],
  );

  const [selectedId, setSelectedId] = useState<string>("ghl");
  const [search, setSearch] = useState("");
  const [accessFilter, setAccessFilter] = useState<"all" | "read" | "write" | "both" | "action">("all");
  const [addOpen, setAddOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const selected = useMemo(
    () =>
      normalized.integrations.find((item) => item.id === selectedId) ??
      normalized.integrations[0] ??
      null,
    [normalized.integrations, selectedId],
  );

  const groupedScopes = useMemo(() => {
    if (!selected) return [];
    const q = search.trim().toLowerCase();
    const filtered = selected.scopes.filter((scope) => {
      if (accessFilter !== "all" && scope.access !== accessFilter) return false;
      if (
        q &&
        !scope.id.toLowerCase().includes(q) &&
        !(scope.group ?? "").toLowerCase().includes(q) &&
        !(scope.description ?? "").toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
    const groups = new Map<string, GatewayScopeEntry[]>();
    for (const scope of filtered) {
      const key = scope.group || "General";
      const existing = groups.get(key) ?? [];
      existing.push(scope);
      groups.set(key, existing);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [selected, search, accessFilter]);

  const handleDeleteCustomScope = async (scope: GatewayScopeEntry) => {
    if (!selected) return;
    setDeletingId(scope.id);
    setFeedback(null);
    try {
      await irOpsApi.gateway.deleteScope(selected.id, scope.id);
      setFeedback({ kind: "ok", text: `Removed custom scope ${scope.id}.` });
      onRefresh();
    } catch (err) {
      setFeedback({
        kind: "error",
        text: err instanceof Error ? err.message : `Could not delete scope ${scope.id}.`,
      });
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-4">
      {normalized.pendingReauthScopes.length > 0 && (
        <Card className="border-amber-500/30 bg-amber-500/5 py-3">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 px-4">
            <div className="flex items-center gap-2 text-xs text-amber-200">
              <AlertTriangle className="size-4 shrink-0 text-amber-300" />
              <span>
                <strong>{normalized.pendingReauthScopes.length}</strong> GoHighLevel scope
                {normalized.pendingReauthScopes.length === 1 ? " is" : "s are"} pending agency
                OAuth re-authorization.
              </span>
            </div>
            <Button type="button" size="xs" asChild>
              <a href={normalized.reauthUrl} target="_blank" rel="noopener noreferrer">
                Re-authorize GHL Agency
                <ExternalLink className="size-3" />
              </a>
            </Button>
          </CardContent>
        </Card>
      )}

      {normalized.synthesizedFallback && (
        <div className="rounded-md border border-border bg-muted/40 px-3.5 py-2 text-xs text-muted-foreground">
          Showing live provider actions and GHL scope status from gateway metadata. Custom scope
          edits activate once the gateway scopes catalog endpoint is online.
        </div>
      )}

      {feedback && (
        <div
          role={feedback.kind === "error" ? "alert" : "status"}
          className={cn(
            "rounded-md border px-3 py-2 text-xs",
            feedback.kind === "error"
              ? "border-destructive/40 bg-destructive/10 text-destructive"
              : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
          )}
        >
          {feedback.text}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* Left Integration Rail */}
        <Card className="gap-0 py-0 lg:col-span-4 xl:col-span-3">
          <CardHeader className="border-b border-border px-4 py-3">
            <CardTitle className="text-sm font-semibold">
              Integrations ({normalized.integrations.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="max-h-144 divide-y divide-border overflow-y-auto px-0">
            {normalized.integrations.map((integration) => {
              const active = selected?.id === integration.id;
              return (
                <button
                  key={integration.id}
                  type="button"
                  onClick={() => setSelectedId(integration.id)}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left text-xs transition-colors",
                    active ? "bg-accent/70 text-foreground" : "text-muted-foreground hover:bg-accent/35 hover:text-foreground",
                  )}
                >
                  <span className="truncate font-medium">{integration.label}</span>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {(integration.pendingCount ?? 0) > 0 && (
                      <Badge
                        variant="outline"
                        className="border-amber-500/30 bg-amber-500/10 px-1.5 py-0 text-xs font-normal text-amber-300"
                      >
                        {integration.pendingCount} pending
                      </Badge>
                    )}
                    <Badge variant="secondary" className="font-mono text-xs font-normal">
                      {integration.totalCount}
                    </Badge>
                  </div>
                </button>
              );
            })}
          </CardContent>
        </Card>

        {/* Main Scope Table */}
        <Card className="gap-0 py-0 lg:col-span-8 xl:col-span-9">
          <CardHeader className="gap-3 border-b border-border px-5 py-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle className="text-sm font-semibold text-foreground">
                  {selected?.label ?? "Scopes"}
                </CardTitle>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {selected?.kind === "ghl"
                    ? `${selected.grantedCount ?? selected.scopes.length} live scopes granted on the GHL Agency connection`
                    : `${selected?.scopes.length ?? 0} cataloged scopes and actions`}
                </p>
              </div>
              {selected && selected.kind !== "gateway_route" && (
                <Button type="button" size="sm" onClick={() => setAddOpen(true)}>
                  <Plus className="size-3.5" />
                  Add scope
                </Button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-56 flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filter scopes by ID or group…"
                  className="h-8 pl-8 text-xs"
                />
              </div>
              <div className="flex items-center gap-1">
                {(["all", "read", "write", "both", "action"] as const).map((level) => (
                  <Button
                    key={level}
                    type="button"
                    size="xs"
                    variant={accessFilter === level ? "secondary" : "ghost"}
                    onClick={() => setAccessFilter(level)}
                  >
                    {level === "all" ? "All" : level === "both" ? "Both" : level}
                  </Button>
                ))}
              </div>
            </div>
          </CardHeader>

          <CardContent className="max-h-144 overflow-y-auto p-0">
            {groupedScopes.length === 0 ? (
              <div className="p-8 text-center text-xs text-muted-foreground">
                No scopes match the current filter.
              </div>
            ) : (
              groupedScopes.map(([groupName, entries]) => (
                <div key={groupName} className="border-b border-border last:border-b-0">
                  <div className="bg-muted/40 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {groupName} ({entries.length})
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-border text-muted-foreground">
                          <th className="px-4 py-2 font-medium">Scope ID</th>
                          <th className="px-3 py-2 font-medium">Access</th>
                          <th className="px-3 py-2 font-medium">Status</th>
                          <th className="px-3 py-2 font-medium">Profile</th>
                          <th className="w-12 px-3 py-2 text-right font-medium" />
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/60">
                        {entries.map((scope) => (
                          <tr key={scope.id} className="hover:bg-accent/25">
                            <td className="px-4 py-2.5">
                              <div className="font-mono text-xs text-foreground">{scope.id}</div>
                              {scope.description && (
                                <div className="mt-0.5 text-xs text-muted-foreground">
                                  {scope.description}
                                </div>
                              )}
                            </td>
                            <td className="px-3 py-2.5">
                              <AccessPill access={scope.access} />
                            </td>
                            <td className="px-3 py-2.5">
                              <ScopeStatusPill status={scope.status} />
                            </td>
                            <td className="px-3 py-2.5">
                              {scope.funnelRequired ? (
                                <Badge variant="secondary" className="text-xs font-normal">
                                  Funnel required
                                </Badge>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </td>
                            <td className="px-3 py-2.5 text-right">
                              {scope.custom && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-xs"
                                  disabled={deletingId === scope.id}
                                  aria-label={`Delete custom scope ${scope.id}`}
                                  onClick={() => void handleDeleteCustomScope(scope)}
                                >
                                  <Trash2 className="size-3.5 text-destructive" />
                                </Button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {selected && (
        <AddScopeDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          integrationId={selected.id}
          integrationLabel={selected.label}
          onAdded={({ addedCount, pendingReauth }) => {
            setFeedback({
              kind: "ok",
              text: pendingReauth
                ? `Added ${addedCount} scope${addedCount === 1 ? "" : "s"}. Re-authorize GHL Agency to activate.`
                : `Added ${addedCount} scope${addedCount === 1 ? "" : "s"} to ${selected.label}.`,
            });
            onRefresh();
          }}
        />
      )}
    </div>
  );
}
