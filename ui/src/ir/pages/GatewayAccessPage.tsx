import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import {
  IrApiError,
  irOpsApi,
  type GatewayAgentRecord,
  type GatewayBotSummary,
  type GatewayProviderSummary,
  type GatewayRoleTemplate,
  type GatewayScopesCatalogResponse,
  type GatewayStatusResponse,
} from "../api/irOps";
import { AgentPolicySheet } from "./gateway/AgentPolicySheet";
import { DashboardMcpTokensTab } from "./gateway/DashboardMcpTokensTab";
import { GatewayAccessMatrix } from "./gateway/GatewayAccessMatrix";
import { GatewayConnectedApps } from "./gateway/GatewayConnectedApps";
import { GatewayRolesTab } from "./gateway/GatewayRolesTab";
import { GatewayScopesCatalog } from "./gateway/GatewayScopesCatalog";
import {
  buildNormalizedScopesCatalog,
  classifyProviderConnection,
  GATEWAY_OAUTH_START_URL,
} from "./gateway/gatewayHelpers";

type GatewayTabId = "apps" | "matrix" | "scopes" | "mcp" | "roles";

const CONNECTED_PROVIDER_LABELS: Record<string, string> = {
  quickbooks: "QuickBooks Online",
  gmail: "Gmail",
  zoom: "Zoom",
};

export function GatewayAccessPage() {
  const { selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);

  const [healthy, setHealthy] = useState<boolean | null>(null);
  const [statusData, setStatusData] = useState<GatewayStatusResponse | null>(null);
  const [agents, setAgents] = useState<GatewayAgentRecord[]>([]);
  const [bots, setBots] = useState<GatewayBotSummary[]>([]);
  const [roles, setRoles] = useState<GatewayRoleTemplate[]>([]);
  const [providers, setProviders] = useState<GatewayProviderSummary[]>([]);
  const [scopesCatalog, setScopesCatalog] = useState<GatewayScopesCatalogResponse | null>(null);

  const [activeTab, setActiveTab] = useState<GatewayTabId>(() => {
    if (typeof window !== "undefined") {
      const tab = new URLSearchParams(window.location.search).get("tab");
      if (tab === "apps" || tab === "matrix" || tab === "scopes" || tab === "mcp" || tab === "roles") {
        return tab;
      }
    }
    return "apps";
  });
  const [connectedBanner, setConnectedBanner] = useState<string | null>(null);
  const [selectedAgentName, setSelectedAgentName] = useState<string | null>(null);
  const [roleToApply, setRoleToApply] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const connected = url.searchParams.get("connected");
    if (connected) {
      if (Object.hasOwn(CONNECTED_PROVIDER_LABELS, connected)) {
        const label = CONNECTED_PROVIDER_LABELS[connected];
        setConnectedBanner(`${label} is now connected and live on your OAuth Gateway.`);
        setActiveTab("apps");
      }
      url.searchParams.delete("connected");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    }
  }, []);

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/company/settings" },
      { label: "Gateway Access" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const loadAll = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setConfigError(null);

    try {
      const [healthRes, statusRes, agentsRes, botsRes, rolesRes, providersRes, scopesRes] =
        await Promise.allSettled([
          irOpsApi.gateway.getHealth(),
          irOpsApi.gateway.getStatus(),
          irOpsApi.gateway.getAgents(),
          irOpsApi.gateway.getBots(),
          irOpsApi.gateway.getRoles(),
          irOpsApi.gateway.getProviders(),
          irOpsApi.gateway.getScopes(),
        ]);

      if (healthRes.status === "fulfilled") {
        setHealthy(healthRes.value.status === "ok");
      } else {
        setHealthy(false);
      }

      if (statusRes.status === "fulfilled") {
        setStatusData(statusRes.value);
      }

      if (agentsRes.status === "rejected") {
        const err = agentsRes.reason;
        if (err instanceof IrApiError && err.status === 503) {
          setConfigError(
            "Gateway Admin Key is not configured on this Paperclip server. Configure GATEWAY_ADMIN_KEY on the server to manage agent policies.",
          );
        } else {
          setConfigError(
            err instanceof Error
              ? err.message
              : "Could not load Gateway agent permissions from the server proxy.",
          );
        }
        return;
      }

      const agentList = Array.isArray(agentsRes.value.agents) ? agentsRes.value.agents : [];
      setAgents(agentList);

      if (botsRes.status === "fulfilled" && Array.isArray(botsRes.value.bots)) {
        setBots(botsRes.value.bots);
      }

      if (rolesRes.status === "fulfilled" && Array.isArray(rolesRes.value.roles)) {
        setRoles(rolesRes.value.roles);
      } else if (Array.isArray(agentsRes.value.roles)) {
        setRoles(agentsRes.value.roles);
      }

      if (providersRes.status === "fulfilled" && Array.isArray(providersRes.value.providers)) {
        setProviders(providersRes.value.providers);
      }

      if (scopesRes.status === "fulfilled") {
        setScopesCatalog(scopesRes.value);
      } else {
        // Graceful fallback if gateway v169 /admin/scopes is still deploying
        setScopesCatalog(null);
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadAll(false);
  }, [loadAll]);

  const botsByAgent = useMemo(() => {
    const map: Record<string, GatewayBotSummary> = {};
    for (const bot of bots) map[bot.agent] = bot;
    return map;
  }, [bots]);

  const selectedAgent = useMemo(
    () => agents.find((a) => a.agent === selectedAgentName) ?? null,
    [agents, selectedAgentName],
  );

  const normalizedScopes = useMemo(
    () => buildNormalizedScopesCatalog(scopesCatalog, providers, statusData),
    [scopesCatalog, providers, statusData],
  );

  const liveVersion =
    statusData?.version !== undefined && statusData?.version !== null
      ? String(statusData.version).startsWith("v")
        ? String(statusData.version)
        : `v${statusData.version}`
      : null;

  const agencyScopeCount = statusData?.agency?.scopeCount;
  const pendingReauthCount = normalizedScopes.pendingReauthScopes.length;

  const appCounts = useMemo(() => {
    let live = statusData?.agency?.authorized ? 1 : 0;
    let needsConnect = statusData?.agency?.authorized ? 0 : 1;
    for (const p of providers) {
      const c = classifyProviderConnection(p);
      if (c.status === "live") live += 1;
      else if (c.status === "needs_connect") needsConnect += 1;
    }
    return { live, needsConnect, total: providers.length + 1 };
  }, [providers, statusData?.agency?.authorized]);

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5">
      {/* Header Strip — zero external /admin escape hatches */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <ShieldCheck className="size-5 text-muted-foreground" />
            <h1 className="text-xl font-bold tracking-tight text-foreground">Gateway Access</h1>
            {healthy !== null && (
              <Badge
                variant="outline"
                className={cn(
                  "font-normal",
                  healthy
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                    : "border-destructive/40 bg-destructive/10 text-destructive",
                )}
              >
                {healthy
                  ? `Healthy${liveVersion ? ` · ${liveVersion}` : ""}`
                  : "Gateway Unreachable"}
              </Badge>
            )}
            {statusData?.agency?.authorized && (
              <Badge variant="secondary" className="font-normal">
                GHL Agency
                {typeof agencyScopeCount === "number" ? ` · ${agencyScopeCount} scopes granted` : ""}
              </Badge>
            )}
            {pendingReauthCount > 0 && (
              <Badge
                variant="outline"
                className="border-amber-500/30 bg-amber-500/10 text-amber-300 font-normal"
              >
                {pendingReauthCount} pending re-auth
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            Manage connected apps, 1-click OAuth connections, per-agent permissions, scopes, Dashboard MCP tokens, and role presets.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {pendingReauthCount > 0 && (
            <Button type="button" variant="outline" size="sm" asChild>
              <a
                href={normalizedScopes.reauthUrl || GATEWAY_OAUTH_START_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                Re-authorize GHL Agency
                <ExternalLink className="size-3.5" />
              </a>
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loading || refreshing}
            onClick={() => void loadAll(true)}
          >
            <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </header>

      {connectedBanner && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-xs text-emerald-300"
        >
          <span className="inline-flex items-center gap-2">
            <CheckCircle2 className="size-4 shrink-0" />
            {connectedBanner}
          </span>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => setConnectedBanner(null)}
          >
            Dismiss
          </Button>
        </div>
      )}

      {loading ? (
        <div className="space-y-4">
          <Skeleton className="h-10 w-96" />
          <Skeleton className="h-72 w-full" />
        </div>
      ) : configError ? (
        <Card className="border-destructive/40 bg-destructive/5 py-5">
          <CardContent className="flex flex-wrap items-center justify-between gap-4 px-5">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" />
              <div className="space-y-1">
                <p className="text-sm font-semibold text-foreground">
                  Gateway Access Proxy Unavailable
                </p>
                <p className="text-xs text-muted-foreground" role="alert">
                  {configError}
                </p>
              </div>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => void loadAll(false)}>
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as GatewayTabId)}
        >
          <TabsList className="mb-4 rounded-md">
            <TabsTrigger value="apps" className="rounded-sm px-3 text-xs">
              Connected Apps
              <Badge
                variant="outline"
                className={cn(
                  "ml-1.5 px-1.5 py-0 font-mono text-xs font-normal",
                  appCounts.needsConnect > 0
                    ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
                    : "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
                )}
              >
                {appCounts.live}/{appCounts.total}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="matrix" className="rounded-sm px-3 text-xs">
              Access Matrix
            </TabsTrigger>
            <TabsTrigger value="scopes" className="rounded-sm px-3 text-xs">
              Scopes Catalog
              {pendingReauthCount > 0 && (
                <Badge
                  variant="outline"
                  className="ml-1 border-amber-500/30 bg-amber-500/10 px-1.5 py-0 text-xs font-normal text-amber-300"
                >
                  {pendingReauthCount}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="mcp" className="rounded-sm px-3 text-xs">
              Dashboard MCP Tokens
            </TabsTrigger>
            <TabsTrigger value="roles" className="rounded-sm px-3 text-xs">
              Roles & Presets
            </TabsTrigger>
          </TabsList>

          <TabsContent value="apps">
            <GatewayConnectedApps
              providers={providers}
              status={statusData}
              pendingReauthCount={pendingReauthCount}
              reauthUrl={normalizedScopes.reauthUrl || GATEWAY_OAUTH_START_URL}
              onRefresh={() => void loadAll(true)}
            />
          </TabsContent>

          <TabsContent value="matrix">
            <GatewayAccessMatrix
              agents={agents}
              botsByAgent={botsByAgent}
              providers={providers}
              onSelectAgent={(agent) => {
                setRoleToApply(null);
                setSelectedAgentName(agent.agent);
              }}
            />
          </TabsContent>

          <TabsContent value="scopes">
            <GatewayScopesCatalog
              catalog={scopesCatalog}
              providers={providers}
              status={statusData}
              onRefresh={() => void loadAll(true)}
            />
          </TabsContent>

          <TabsContent value="mcp">
            <DashboardMcpTokensTab />
          </TabsContent>

          <TabsContent value="roles">
            <GatewayRolesTab
              roles={roles}
              agents={agents}
              bots={bots}
              onApplyRoleToAgent={(agent, roleId) => {
                setRoleToApply(roleId);
                setSelectedAgentName(agent.agent);
              }}
              onInspectAgent={(agent) => {
                setRoleToApply(null);
                setSelectedAgentName(agent.agent);
              }}
            />
          </TabsContent>
        </Tabs>
      )}

      <AgentPolicySheet
        open={Boolean(selectedAgent)}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedAgentName(null);
            setRoleToApply(null);
          }
        }}
        agent={selectedAgent}
        bot={selectedAgent ? botsByAgent[selectedAgent.agent] : undefined}
        providers={providers}
        roles={roles}
        initialRoleToApply={roleToApply}
        onSaved={() => void loadAll(true)}
      />
    </div>
  );
}
