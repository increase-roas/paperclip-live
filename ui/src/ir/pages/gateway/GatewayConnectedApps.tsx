import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Clock,
  ExternalLink,
  KeyRound,
  Link2,
  Plus,
  Search,
  Server,
  Shield,
  Unlink,
  XCircle,
} from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  irOpsApi,
  type GatewayProviderAccount,
  type GatewayProviderSummary,
  type GatewayStatusResponse,
} from "../../api/irOps";
import {
  classifyProviderConnection,
  GATEWAY_OAUTH_START_URL,
  PAPERCLIP_GATEWAY_RETURN_URL,
  type ProviderConnectionStatus,
} from "./gatewayHelpers";
import {
  ConfigureSecretsDialog,
  type ProviderSecretSchema,
} from "./ConfigureSecretsDialog";

interface GatewayConnectedAppsProps {
  providers: GatewayProviderSummary[];
  status: GatewayStatusResponse | null;
  pendingReauthCount: number;
  reauthUrl: string;
  onRefresh: () => void;
}

interface ConnectedAppRow {
  id: string;
  label: string;
  category: string;
  status: ProviderConnectionStatus;
  badgeLabel: "Connected (LIVE)" | "Needs Connect" | "Not Configured";
  authType: "oauth" | "api_key" | "service_account";
  authLabel: "OAuth 2.0" | "API Key" | "Service Account";
  scopeSummary: string;
  accountLabel: string | null;
  accounts: GatewayProviderAccount[];
  multiAccount: boolean;
  canConnect: boolean;
  connectUrl: string | null;
  connectButtonLabel: string;
  disabledTooltip: string | null;
  notes: string;
  isGhl?: boolean;
}

const STATUS_SORT_ORDER: Record<ProviderConnectionStatus, number> = {
  needs_connect: 0,
  live: 1,
  not_configured: 2,
};

function formatScopeSummary(scopeCount: number, actionCount: number): string {
  const parts: string[] = [];
  if (scopeCount > 0) parts.push(`${scopeCount} ${scopeCount === 1 ? "scope" : "scopes"}`);
  if (actionCount > 0) parts.push(`${actionCount} ${actionCount === 1 ? "action" : "actions"}`);
  return parts.length > 0 ? parts.join(" · ") : "Standard API";
}

function StatusBadge({
  status,
  label,
}: {
  status: ProviderConnectionStatus;
  label: string;
}) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1 font-normal",
        status === "live" &&
          "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
        status === "needs_connect" &&
          "border-amber-500/30 bg-amber-500/10 text-amber-300",
        status === "not_configured" &&
          "border-border bg-muted/70 text-muted-foreground",
      )}
    >
      {status === "live" ? (
        <CheckCircle2 className="size-3" />
      ) : status === "needs_connect" ? (
        <Clock className="size-3" />
      ) : (
        <XCircle className="size-3" />
      )}
      {label}
    </Badge>
  );
}

function AuthTypeBadge({
  authType,
  label,
}: {
  authType: "oauth" | "api_key" | "service_account";
  label: string;
}) {
  return (
    <Badge variant="secondary" className="gap-1 font-normal text-xs">
      {authType === "oauth" ? (
        <Link2 className="size-3 text-muted-foreground" />
      ) : authType === "service_account" ? (
        <Server className="size-3 text-muted-foreground" />
      ) : (
        <KeyRound className="size-3 text-muted-foreground" />
      )}
      {label}
    </Badge>
  );
}

export function GatewayConnectedApps({
  providers,
  status,
  pendingReauthCount,
  reauthUrl,
  onRefresh,
}: GatewayConnectedAppsProps) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | ProviderConnectionStatus>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [launchingId, setLaunchingId] = useState<string | null>(null);
  const [disconnectingKey, setDisconnectingKey] = useState<string | null>(null);
  const [pendingDisconnect, setPendingDisconnect] = useState<{
    providerId: string;
    providerLabel: string;
    account: GatewayProviderAccount;
  } | null>(null);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [secretsMeta, setSecretsMeta] = useState<{
    configured: boolean;
    workerName: string;
    providers: Record<string, ProviderSecretSchema>;
  }>({
    configured: false,
    workerName: "increase-roas-oauth-gateway",
    providers: {},
  });
  const [configuringSchema, setConfiguringSchema] = useState<ProviderSecretSchema | null>(null);
  // Own-property lookup so row ids like "constructor" never match Object.prototype.
  const secretSchemaFor = (id: string): ProviderSecretSchema | undefined =>
    Object.hasOwn(secretsMeta.providers, id) ? secretsMeta.providers[id] : undefined;

  useEffect(() => {
    let active = true;
    irOpsApi.gateway
      .getSecretsSchema()
      .then((res) => {
        if (!active || !res?.ok) return;
        setSecretsMeta({
          configured: Boolean(res.configured),
          workerName: res.workerName || "increase-roas-oauth-gateway",
          providers: res.providers ?? {},
        });
      })
      .catch(() => {
        // Older server without secret writer endpoint: keep Configure buttons hidden
      });
    return () => {
      active = false;
    };
  }, []);

  // Clear "Opening…" button state if user returns via browser Back (bfcache)
  useEffect(() => {
    const handlePageShow = () => setLaunchingId(null);
    window.addEventListener("pageshow", handlePageShow);
    return () => window.removeEventListener("pageshow", handlePageShow);
  }, []);

  const allRows = useMemo<ConnectedAppRow[]>(() => {
    const ghlAuthorized = Boolean(status?.agency?.authorized);
    const ghlScopes = status?.agency?.scopeCount ?? 0;
    const ghlLocations = status?.locations?.stored;
    const ghlRow: ConnectedAppRow = {
      id: "ghl",
      label: "GoHighLevel Agency",
      category: "crm",
      status: ghlAuthorized ? "live" : "needs_connect",
      badgeLabel: ghlAuthorized ? "Connected (LIVE)" : "Needs Connect",
      authType: "oauth",
      authLabel: "OAuth 2.0",
      scopeSummary: ghlScopes > 0 ? `${ghlScopes} scopes granted` : "Agency OAuth",
      accountLabel:
        ghlAuthorized && typeof ghlLocations === "number"
          ? `${ghlLocations} sub-accounts synced`
          : ghlAuthorized
            ? "Agency connected"
            : null,
      accounts: [],
      multiAccount: false,
      canConnect: true,
      connectUrl: reauthUrl || GATEWAY_OAUTH_START_URL,
      connectButtonLabel: !ghlAuthorized
        ? "Connect"
        : pendingReauthCount > 0
          ? `Re-authorize (${pendingReauthCount})`
          : "Reconnect",
      disabledTooltip: null,
      notes: "Primary CRM OAuth agency connection powering all sub-account tokens and workflows.",
      isGhl: true,
    };

    const providerRows: ConnectedAppRow[] = providers.map((provider) => {
      const info = classifyProviderConnection(provider);
      const accounts = Array.isArray(provider.accounts) ? provider.accounts : [];
      const multiAccount = provider.multiAccount === true;
      let connectButtonLabel = "Connect";
      if (info.status === "live" && info.authType === "oauth") {
        connectButtonLabel = multiAccount ? "Add mailbox" : "Reconnect";
      }
      const disabledTooltip =
        info.authType === "oauth" && !info.canConnect
          ? provider.disabled
            ? `Provider is disabled (${provider.enableFlag ?? "opt-in flag"}).`
            : `Bind ${provider.label} OAuth client credentials on the Gateway Worker to enable 1-click Connect.`
          : null;

      return {
        id: provider.id,
        label: provider.label,
        category: provider.category || "other",
        status: info.status,
        badgeLabel: info.badgeLabel,
        authType: info.authType,
        authLabel: info.authLabel,
        scopeSummary: formatScopeSummary(info.scopeCount, info.actionCount),
        accountLabel: provider.accountLabel ?? null,
        accounts,
        multiAccount,
        canConnect: info.canConnect,
        connectUrl: info.connectUrl,
        connectButtonLabel,
        disabledTooltip,
        notes: provider.notes ?? "",
      };
    });

    const combined = [ghlRow, ...providerRows];
    combined.sort((a, b) => {
      const rankDiff = STATUS_SORT_ORDER[a.status] - STATUS_SORT_ORDER[b.status];
      if (rankDiff !== 0) return rankDiff;
      if (a.isGhl && !b.isGhl) return -1;
      if (!a.isGhl && b.isGhl) return 1;
      // Within Not Configured, surface OAuth apps awaiting credentials first
      if (a.status === "not_configured") {
        const aOauth = a.authType === "oauth" ? 0 : 1;
        const bOauth = b.authType === "oauth" ? 0 : 1;
        if (aOauth !== bOauth) return aOauth - bOauth;
      }
      return a.label.localeCompare(b.label);
    });
    return combined;
  }, [providers, status, pendingReauthCount, reauthUrl]);

  const counts = useMemo(() => {
    let live = 0;
    let needsConnect = 0;
    let notConfigured = 0;
    for (const row of allRows) {
      if (row.status === "live") live += 1;
      else if (row.status === "needs_connect") needsConnect += 1;
      else notConfigured += 1;
    }
    return { live, needsConnect, notConfigured, total: allRows.length };
  }, [allRows]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const row of allRows) set.add(row.category);
    return [...set].sort();
  }, [allRows]);

  const visibleRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allRows.filter((row) => {
      if (statusFilter !== "all" && row.status !== statusFilter) return false;
      if (categoryFilter !== "all" && row.category !== categoryFilter) return false;
      if (
        q &&
        !row.label.toLowerCase().includes(q) &&
        !row.id.toLowerCase().includes(q) &&
        !row.category.toLowerCase().includes(q) &&
        !(row.accountLabel ?? "").toLowerCase().includes(q) &&
        !row.notes.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [allRows, search, statusFilter, categoryFilter]);

  const handleOAuthConnect = async (row: ConnectedAppRow) => {
    setLaunchingId(row.id);
    setFeedback(null);
    try {
      const res = await irOpsApi.gateway.launchOAuthConnect(row.id, {
        returnTo: PAPERCLIP_GATEWAY_RETURN_URL,
      });
      let parsed: URL | null = null;
      try {
        parsed = res?.launchUrl ? new URL(res.launchUrl) : null;
      } catch {
        parsed = null;
      }
      let expectedOrigin: string | null = null;
      try {
        expectedOrigin = row.connectUrl ? new URL(row.connectUrl).origin : new URL(GATEWAY_OAUTH_START_URL).origin;
      } catch {
        expectedOrigin = null;
      }
      if (
        !parsed ||
        parsed.protocol !== "https:" ||
        !parsed.pathname.startsWith("/oauth/") ||
        (expectedOrigin && parsed.origin !== expectedOrigin)
      ) {
        throw new Error(`Gateway did not return a valid OAuth launch URL for ${row.label}.`);
      }
      window.location.assign(parsed.toString());
    } catch (err) {
      setFeedback({
        kind: "error",
        text:
          err instanceof Error
            ? err.message
            : `Could not start ${row.label} OAuth connection.`,
      });
      setLaunchingId(null);
    }
  };

  const handleDisconnect = async (providerId: string, account: GatewayProviderAccount) => {
    const key = `${providerId}:${account.id}`;
    setDisconnectingKey(key);
    setFeedback(null);
    try {
      await irOpsApi.gateway.disconnectOAuthAccount(providerId, account.id);
      setFeedback({
        kind: "ok",
        text: `Disconnected ${account.label} from ${providerId}.`,
      });
      onRefresh();
    } catch (err) {
      setFeedback({
        kind: "error",
        text:
          err instanceof Error
            ? err.message
            : `Could not disconnect ${account.label}.`,
      });
    } finally {
      setDisconnectingKey(null);
    }
  };

  return (
    <div className="space-y-4">
      {/* Compact KPI Strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="py-3">
          <CardContent className="px-4">
            <p className="text-xs text-muted-foreground">Connected (LIVE)</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-emerald-400">
              {counts.live}
            </p>
          </CardContent>
        </Card>
        <Card className={cn("py-3", counts.needsConnect > 0 && "border-amber-500/30 bg-amber-500/5")}>
          <CardContent className="px-4">
            <p className="text-xs text-muted-foreground">Needs 1-Click Connect</p>
            <p
              className={cn(
                "mt-1 text-2xl font-semibold tabular-nums",
                counts.needsConnect > 0 ? "text-amber-300" : "text-foreground",
              )}
            >
              {counts.needsConnect}
            </p>
          </CardContent>
        </Card>
        <Card className="py-3">
          <CardContent className="px-4">
            <p className="text-xs text-muted-foreground">Not Configured</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-muted-foreground">
              {counts.notConfigured}
            </p>
          </CardContent>
        </Card>
        <Card className="py-3">
          <CardContent className="px-4">
            <p className="text-xs text-muted-foreground">Total Integrations</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
              {counts.total}
            </p>
          </CardContent>
        </Card>
      </div>

      {feedback && (
        <div
          role={feedback.kind === "error" ? "alert" : "status"}
          className={cn(
            "rounded-md border px-3.5 py-2 text-xs",
            feedback.kind === "error"
              ? "border-destructive/40 bg-destructive/10 text-destructive"
              : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
          )}
        >
          {feedback.text}
        </div>
      )}

      {/* Filter Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-56">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter connected apps…"
              className="h-8 pl-8 text-xs"
            />
          </div>

          <div className="flex flex-wrap items-center gap-1">
            {(
              [
                ["all", `All (${counts.total})`],
                ["live", `Connected (${counts.live})`],
                ["needs_connect", `Needs Connect (${counts.needsConnect})`],
                ["not_configured", `Not Configured (${counts.notConfigured})`],
              ] as const
            ).map(([key, label]) => (
              <Button
                key={key}
                type="button"
                size="xs"
                variant={statusFilter === key ? "secondary" : "ghost"}
                onClick={() => setStatusFilter(key)}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <Button
            type="button"
            size="xs"
            variant={categoryFilter === "all" ? "secondary" : "ghost"}
            onClick={() => setCategoryFilter("all")}
          >
            All categories
          </Button>
          {categories.map((cat) => (
            <Button
              key={cat}
              type="button"
              size="xs"
              variant={categoryFilter === cat ? "secondary" : "ghost"}
              onClick={() => setCategoryFilter(cat)}
            >
              {cat}
            </Button>
          ))}
        </div>
      </div>

      {/* Connected Apps Table */}
      <Card className="gap-0 overflow-hidden py-0">
        <CardContent className="overflow-x-auto p-0">
          {visibleRows.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No Gateway integrations match the current filter.
            </div>
          ) : (
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-border bg-muted/50 text-muted-foreground">
                  <th className="min-w-52 px-4 py-2.5 font-semibold text-foreground">App</th>
                  <th className="min-w-36 px-3 py-2.5 font-semibold text-foreground">Status</th>
                  <th className="min-w-32 px-3 py-2.5 font-semibold text-foreground">Auth Type</th>
                  <th className="min-w-32 px-3 py-2.5 font-semibold text-foreground">Scopes / Surface</th>
                  <th className="min-w-44 px-3 py-2.5 font-semibold text-foreground">Account</th>
                  <th className="min-w-36 px-4 py-2.5 text-right font-semibold text-foreground">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {visibleRows.map((row) => (
                  <tr
                    key={row.id}
                    data-testid={`connected-app-row-${row.id}`}
                    className="transition-colors hover:bg-accent/30"
                  >
                    <td className="px-4 py-3 align-top">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-foreground">{row.label}</span>
                        <span className="font-mono text-xs text-muted-foreground">
                          {row.category}
                        </span>
                      </div>
                      {row.notes && (
                        <p className="mt-0.5 max-w-md text-xs text-muted-foreground line-clamp-2">
                          {row.notes}
                        </p>
                      )}
                    </td>

                    <td className="px-3 py-3 align-top">
                      <StatusBadge status={row.status} label={row.badgeLabel} />
                    </td>

                    <td className="px-3 py-3 align-top">
                      <AuthTypeBadge authType={row.authType} label={row.authLabel} />
                    </td>

                    <td className="px-3 py-3 align-top">
                      <span className="font-mono text-xs text-muted-foreground">
                        {row.scopeSummary}
                      </span>
                    </td>

                    <td className="px-3 py-3 align-top">
                      {row.accounts.length > 0 ? (
                        <div className="flex flex-wrap gap-1.5">
                          {row.accounts.map((acct) => {
                            const key = `${row.id}:${acct.id}`;
                            return (
                              <Badge
                                key={acct.id}
                                variant="outline"
                                className="gap-1 border-border bg-muted/50 pr-1 font-mono text-xs font-normal text-foreground"
                              >
                                <span className="max-w-44 truncate">{acct.label}</span>
                                <button
                                  type="button"
                                  disabled={disconnectingKey === key}
                                  aria-label={`Disconnect ${acct.label}`}
                                  title={`Disconnect ${acct.label}`}
                                  onClick={() =>
                                    setPendingDisconnect({
                                      providerId: row.id,
                                      providerLabel: row.label,
                                      account: acct,
                                    })
                                  }
                                  className="ml-0.5 rounded p-0.5 text-muted-foreground hover:bg-destructive/15 hover:text-destructive disabled:opacity-40"
                                >
                                  <Unlink className="size-3" />
                                </button>
                              </Badge>
                            );
                          })}
                        </div>
                      ) : row.accountLabel ? (
                        <span className="font-mono text-xs text-foreground">
                          {row.accountLabel}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>

                    <td className="px-4 py-3 text-right align-top">
                      <div className="inline-flex items-center justify-end gap-1.5">
                        {!row.isGhl && secretSchemaFor(row.id) ? (
                          <Button
                            type="button"
                            size="xs"
                            variant={row.status === "not_configured" ? "default" : "ghost"}
                            onClick={() => setConfiguringSchema(secretSchemaFor(row.id) ?? null)}
                            title={
                              row.status === "live"
                                ? `Rotate ${row.label} key on ${secretsMeta.workerName}`
                                : `Configure ${row.label} credentials on ${secretsMeta.workerName}`
                            }
                          >
                            <KeyRound className="size-3" />
                            {row.status === "live" ? "Key" : "Configure"}
                          </Button>
                        ) : null}

                        {row.isGhl || row.connectUrl ? (
                          row.canConnect && row.connectUrl ? (
                            row.isGhl ? (
                              <Button
                                type="button"
                                size="xs"
                                variant={row.status === "needs_connect" ? "default" : "outline"}
                                asChild
                              >
                                <a
                                  href={row.connectUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  {row.connectButtonLabel}
                                  <ExternalLink className="size-3" />
                                </a>
                              </Button>
                            ) : (
                              <Button
                                type="button"
                                size="xs"
                                variant={row.status === "needs_connect" ? "default" : "outline"}
                                disabled={launchingId === row.id}
                                onClick={() => void handleOAuthConnect(row)}
                              >
                                {row.multiAccount && row.status === "live" ? (
                                  <Plus className="size-3" />
                                ) : null}
                                {launchingId === row.id ? "Opening…" : row.connectButtonLabel}
                                <ExternalLink className="size-3" />
                              </Button>
                            )
                          ) : (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="inline-block" tabIndex={0}>
                                  <Button type="button" size="xs" variant="outline" disabled>
                                    Connect
                                  </Button>
                                </span>
                              </TooltipTrigger>
                              <TooltipContent side="left" className="max-w-xs">
                                {row.disabledTooltip ?? "OAuth credentials not yet bound on Gateway."}
                              </TooltipContent>
                            </Tooltip>
                          )
                        ) : row.status === "live" ? (
                          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                            <Shield className="size-3 text-emerald-400" />
                            Managed on Gateway
                          </span>
                        ) : !secretSchemaFor(row.id) ? (
                          <span className="text-xs text-muted-foreground">
                            Bind key on Gateway
                          </span>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <ConfigureSecretsDialog
        open={configuringSchema !== null}
        schema={configuringSchema}
        workerName={secretsMeta.workerName}
        writerConfigured={secretsMeta.configured}
        onClose={() => setConfiguringSchema(null)}
        onSaved={(providerLabel, updatedKeys) => {
          setFeedback({
            kind: "ok",
            text: `Bound ${updatedKeys.join(", ")} for ${providerLabel} on ${secretsMeta.workerName}.`,
          });
          onRefresh();
        }}
      />

      <AlertDialog
        open={pendingDisconnect !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDisconnect(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Disconnect {pendingDisconnect?.account.label}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This immediately removes the encrypted {pendingDisconnect?.providerLabel} OAuth
              tokens for {pendingDisconnect?.account.label} from your OAuth Gateway. Agents
              using this connection will fail closed until you reconnect.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                const target = pendingDisconnect;
                setPendingDisconnect(null);
                if (target) void handleDisconnect(target.providerId, target.account);
              }}
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
