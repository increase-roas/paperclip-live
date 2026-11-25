import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AlertTriangle, Check, CheckCircle2, Copy, KeyRound, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Skeleton } from "@/components/ui/skeleton";
import {
  irOpsApi,
  type McpAuditRecord,
  type McpTokenRecord,
  type TenantProfile,
} from "../../api/irOps";

const MCP_SCOPES = [
  { id: "read", label: "Read dashboards and clients" },
  { id: "diagnostics", label: "Run live provider diagnostics" },
  { id: "refresh", label: "Refresh and retry snapshots" },
] as const;

function formatRelative(value: string | null): string {
  if (!value) return "Never";
  const diff = Date.now() - Date.parse(value);
  if (!Number.isFinite(diff) || diff < 0) return new Date(value).toLocaleString();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function DashboardMcpTokensTab() {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [tokens, setTokens] = useState<McpTokenRecord[]>([]);
  const [audit, setAudit] = useState<McpAuditRecord[]>([]);
  const [clients, setClients] = useState<Array<{ slug: string; displayName: string }>>([]);

  const [name, setName] = useState("Javar");
  const [scopes, setScopes] = useState<string[]>(["read", "diagnostics", "refresh"]);
  const [allClients, setAllClients] = useState(true);
  const [selectedClients, setSelectedClients] = useState<string[]>(["__owner__"]);
  const [expiry, setExpiry] = useState("90");
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<McpTokenRecord | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [tokenRes, tenantRes] = await Promise.all([
        irOpsApi.salesDashboard.getMcpTokens(),
        irOpsApi.salesDashboard.getTenants().catch(() => ({ tenants: [] as TenantProfile[] })),
      ]);
      setTokens(Array.isArray(tokenRes.tokens) ? tokenRes.tokens : []);
      setAudit(Array.isArray(tokenRes.audit) ? tokenRes.audit : []);
      const options = (tenantRes.tenants ?? [])
        .map((t) => ({ slug: t.slug, displayName: t.displayName }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName));
      setClients(options);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load Dashboard MCP tokens.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || scopes.length === 0 || (!allClients && selectedClients.length === 0)) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    setCreatedToken(null);
    try {
      const res = await irOpsApi.salesDashboard.createMcpToken({
        name: name.trim(),
        scopes,
        clients: allClients ? null : selectedClients,
        expiresInDays: expiry === "never" ? null : Number(expiry),
      });
      if (!res.token) throw new Error(res.detail ?? "Token was not returned.");
      setCreatedToken(res.token);
      setNotice("Scoped MCP token created. Copy it now — it is stored only as a hash.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create MCP token.");
    } finally {
      setBusy(false);
    }
  };

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await irOpsApi.salesDashboard.revokeMcpToken(revokeTarget.id);
      setNotice(`Revoked token "${revokeTarget.name}".`);
      setCreatedToken(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke MCP token.");
    } finally {
      setBusy(false);
      setRevokeTarget(null);
    }
  };

  const handleCopy = async () => {
    if (!createdToken) return;
    try {
      await navigator.clipboard.writeText(createdToken);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Copy blocked by browser. Select and copy the token manually.");
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-44 w-full" />
        <Skeleton className="h-44 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {notice && (
        <div
          role="status"
          className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300"
        >
          <CheckCircle2 className="size-4 shrink-0" />
          <span>{notice}</span>
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle className="size-4 shrink-0" />
            <span>{error}</span>
          </div>
          <Button type="button" variant="outline" size="xs" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* Create Token Form */}
        <Card className="lg:col-span-5">
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Create Agent MCP Token</CardTitle>
            <CardDescription className="text-xs">
              Issue a scoped, revocable token for Javar or specialist agents to read the Sales Dashboard MCP endpoint.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleCreate} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="mcp-token-name" className="text-xs">
                  Agent or token name
                </Label>
                <Input
                  id="mcp-token-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={64}
                  placeholder="Javar"
                  required
                />
              </div>

              <div className="space-y-2">
                <Label className="text-xs">Permissions</Label>
                <div className="space-y-2 rounded-md border border-border p-3">
                  {MCP_SCOPES.map((scope) => (
                    <label
                      key={scope.id}
                      className="flex cursor-pointer items-center gap-2 text-xs text-foreground"
                    >
                      <Checkbox
                        checked={scopes.includes(scope.id)}
                        onCheckedChange={(checked) =>
                          setScopes((current) =>
                            checked === true
                              ? [...new Set([...current, scope.id])]
                              : current.filter((item) => item !== scope.id),
                          )
                        }
                      />
                      <span>{scope.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-xs">Client access</Label>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="xs"
                    variant={allClients ? "secondary" : "outline"}
                    onClick={() => setAllClients(true)}
                  >
                    All clients & owner
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant={!allClients ? "secondary" : "outline"}
                    onClick={() => setAllClients(false)}
                  >
                    Selected clients
                  </Button>
                </div>

                {!allClients && (
                  <div className="max-h-40 space-y-1.5 overflow-y-auto rounded-md border border-border p-3">
                    <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground">
                      <Checkbox
                        checked={selectedClients.includes("__owner__")}
                        onCheckedChange={(checked) =>
                          setSelectedClients((current) =>
                            checked === true
                              ? [...new Set([...current, "__owner__"])]
                              : current.filter((s) => s !== "__owner__"),
                          )
                        }
                      />
                      <span>Owner dashboard</span>
                    </label>
                    {clients.map((client) => (
                      <label
                        key={client.slug}
                        className="flex cursor-pointer items-center gap-2 text-xs text-foreground"
                      >
                        <Checkbox
                          checked={selectedClients.includes(client.slug)}
                          onCheckedChange={(checked) =>
                            setSelectedClients((current) =>
                              checked === true
                                ? [...new Set([...current, client.slug])]
                                : current.filter((s) => s !== client.slug),
                            )
                          }
                        />
                        <span>{client.displayName}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="mcp-token-expiry" className="text-xs">
                  Expiry
                </Label>
                <Select value={expiry} onValueChange={setExpiry}>
                  <SelectTrigger id="mcp-token-expiry" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="30">30 days</SelectItem>
                    <SelectItem value="90">90 days</SelectItem>
                    <SelectItem value="365">1 year</SelectItem>
                    <SelectItem value="never">No expiry</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex justify-end pt-1">
                <Button
                  type="submit"
                  size="sm"
                  disabled={busy || scopes.length === 0 || (!allClients && selectedClients.length === 0)}
                >
                  <KeyRound className="size-3.5" />
                  {busy ? "Creating…" : "Create token"}
                </Button>
              </div>
            </form>

            {createdToken && (
              <div className="mt-4 space-y-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3">
                <div className="text-xs font-medium text-emerald-300">
                  Copy this token now — it cannot be shown again
                </div>
                <div className="flex items-center gap-2">
                  <Input readOnly value={createdToken} className="font-mono text-xs" />
                  <Button type="button" variant="outline" size="sm" onClick={() => void handleCopy()}>
                    {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                    {copied ? "Copied" : "Copy"}
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Active Tokens List */}
        <Card className="lg:col-span-7">
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <div>
              <CardTitle className="text-sm font-semibold">
                Issued MCP Tokens ({tokens.length})
              </CardTitle>
              <CardDescription className="text-xs">
                Scoped credentials authorized for the Sales Dashboard MCP server.
              </CardDescription>
            </div>
            <Button type="button" variant="outline" size="xs" onClick={() => void load()}>
              <RefreshCw className="size-3" />
              Refresh
            </Button>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {tokens.length === 0 ? (
              <p className="text-xs text-muted-foreground">No agent MCP tokens issued yet.</p>
            ) : (
              tokens.map((token) => (
                <div
                  key={token.id}
                  className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border p-3"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{token.name}</span>
                      <code className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                        {token.prefix}…
                      </code>
                      {token.revokedAt ? (
                        <Badge variant="outline" className="border-destructive/40 text-destructive font-normal">
                          Revoked
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="border-emerald-500/30 bg-emerald-500/10 text-emerald-400 font-normal"
                        >
                          Active
                        </Badge>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {token.scopes.map((s) => (
                        <Badge key={s} variant="secondary" className="font-mono text-xs font-normal">
                          {s}
                        </Badge>
                      ))}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {token.clients === null
                        ? "All clients & owner"
                        : token.clients
                            .map((slug) =>
                              slug === "__owner__"
                                ? "Owner"
                                : clients.find((c) => c.slug === slug)?.displayName ?? slug,
                            )
                            .join(", ")}
                    </div>
                    <div className="font-mono text-xs text-muted-foreground">
                      Created {new Date(token.createdAt).toLocaleDateString()} · Last used{" "}
                      {formatRelative(token.lastUsedAt)} ·{" "}
                      {token.expiresAt
                        ? `Expires ${new Date(token.expiresAt).toLocaleDateString()}`
                        : "No expiry"}
                    </div>
                  </div>

                  {!token.revokedAt && (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled={busy}
                      onClick={() => setRevokeTarget(token)}
                    >
                      Revoke
                    </Button>
                  )}
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {/* Audit Activity */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Recent Agent MCP Activity</CardTitle>
          <CardDescription className="text-xs">
            Tool, client, outcome, and duration only. Arguments and credentials are never logged.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          {audit.length === 0 ? (
            <div className="px-6 pb-6 text-xs text-muted-foreground">No MCP activity recorded yet.</div>
          ) : (
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-y border-border bg-muted/40 text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Time</th>
                  <th className="px-3 py-2 font-medium">Tool</th>
                  <th className="px-3 py-2 font-medium">Client</th>
                  <th className="px-3 py-2 font-medium">Outcome</th>
                  <th className="px-3 py-2 font-medium">Duration</th>
                  <th className="px-4 py-2 font-medium">Token</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {audit.map((entry, idx) => (
                  <tr key={`${entry.createdAt}-${idx}`} className="hover:bg-accent/25">
                    <td className="px-4 py-2 font-mono text-muted-foreground">
                      {new Date(entry.createdAt).toLocaleString()}
                    </td>
                    <td className="px-3 py-2 font-mono font-medium text-foreground">{entry.tool}</td>
                    <td className="px-3 py-2 text-muted-foreground">{entry.client ?? "—"}</td>
                    <td className="px-3 py-2">
                      <Badge
                        variant="outline"
                        className={
                          entry.outcome === "ok" || entry.outcome === "success"
                            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400 font-normal"
                            : "border-destructive/40 bg-destructive/10 text-destructive font-normal"
                        }
                      >
                        {entry.outcome}
                        {entry.errorCode ? ` · ${entry.errorCode}` : ""}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 font-mono text-muted-foreground">
                      {entry.durationMs}ms
                    </td>
                    <td className="px-4 py-2 text-foreground">{entry.tokenName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <AlertDialog
        open={Boolean(revokeTarget)}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke token "{revokeTarget?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              Agents using this MCP token will immediately lose access to Sales Dashboard tools.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-row items-center justify-between sm:justify-between">
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleRevoke()}>
              Revoke token
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
