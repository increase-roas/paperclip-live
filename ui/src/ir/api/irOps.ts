// Typed IR Ops API client.
// Talks strictly to Paperclip's server-side authenticated proxies (/api/sales-dashboard/*,
// /api/gateway/*, /api/voice/hermes-talk/*). Zero raw keys or browser-side key prompts.

export class IrApiError extends Error {
  status: number;
  code?: string;
  hint?: string;

  constructor(message: string, status: number, code?: string, hint?: string) {
    super(message);
    this.name = "IrApiError";
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

async function irFetch<T>(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = 25_000, headers: initHeaders, ...rest } = init;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(initHeaders as Record<string, string> | undefined),
    };
    if (rest.body !== undefined && !headers["content-type"] && !headers["Content-Type"]) {
      headers["content-type"] = "application/json";
    }
    const res = await fetch(path, {
      ...rest,
      credentials: "include",
      headers,
      signal: controller.signal,
    });
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try {
      data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      data = { error: text.slice(0, 200) };
    }
    if (!res.ok) {
      const message = String(
        data.detail ||
          data.message ||
          data.hint ||
          data.error ||
          `Request failed (${res.status})`,
      );
      throw new IrApiError(
        message,
        res.status,
        typeof data.error === "string" ? data.error : undefined,
        typeof data.hint === "string" ? data.hint : undefined,
      );
    }
    return data as T;
  } catch (err) {
    if (err instanceof IrApiError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new IrApiError("Request timed out.", 504, "timeout");
    }
    throw new IrApiError(
      err instanceof Error ? err.message : "Network request failed.",
      0,
      "network_error",
    );
  } finally {
    window.clearTimeout(timer);
  }
}

// ── Sales Dashboard Types ───────────────────────────────────────────────────

export interface ManualFinancials {
  month: string;
  totalSalesUsd: number;
  cashCollectedUsd: number;
  totalExpensesUsd: number;
  updatedAt?: string;
}

export interface TenantProfile {
  version?: 1;
  slug: string;
  displayName: string;
  ghlLocationId: string;
  ghlCalendarId?: string;
  ghlInstallCalendarId?: string;
  metaAdAccountId?: string;
  metaTracking?: "not_applicable";
  ga4PropertyId?: string;
  ghlPipelineName?: string;
  ghlProposalStageName?: string;
  websiteTracking?: "not_applicable";
  businessType?: "hot_tub" | "tree_service" | "other";
  monthlyCashTarget?: number | null;
  capacityMode?: "install" | "estimate" | "not_applicable";
  financialTracking?: "ghl" | "manual" | "quickbooks" | "not_applicable";
  manualFinancials?: ManualFinancials;
}

export type ConnectionStatus = "LIVE" | "NO RECENT DATA" | "NOT CONNECTED" | "NOT APPLICABLE";
export type SourceKey = "ghl" | "calls" | "cash" | "capacity" | "ga4" | "meta";

export interface TenantDiagnostic {
  slug: string;
  displayName: string;
  lastTestedAt: string;
  reasons: Partial<Record<SourceKey, string>>;
  ghl: ConnectionStatus;
  calls: ConnectionStatus;
  cash: ConnectionStatus;
  capacity: ConnectionStatus;
  ga4: ConnectionStatus;
  meta: ConnectionStatus;
}

export interface StoredSourceHealth {
  status: string;
  lastSuccessfulSyncAt: string | null;
  reason?: string;
}

export interface StoredViewHealth {
  freshness: "FRESH" | "REFRESHING" | "STALE" | "MISSING";
  syncStatus: string;
  lastSuccessfulSyncAt: string | null;
  lastAttemptedAt: string | null;
  sources: Partial<Record<SourceKey, StoredSourceHealth>>;
}

export interface TenantStoredHealth {
  slug: string;
  displayName: string;
  status: "HEALTHY" | "DEGRADED";
  views: Record<string, StoredViewHealth>;
}

export interface GhlLocationChoice {
  id: string;
  name: string;
  tokenResolved?: boolean;
  detailsAvailable?: boolean;
}

export interface GhlResourceChoices {
  calendars: Array<{ id: string; name: string }>;
  pipelines: Array<{ id: string; name: string; stages: Array<{ id: string; name: string }> }>;
}

export interface MetaChoice {
  id: string;
  name: string;
  currency: string;
  selectable: boolean;
  issue: "inactive" | "non_usd" | null;
}

export interface Ga4Choice {
  id: string;
  name: string;
  accountName: string;
}

export interface AccountingStatus {
  configured: boolean;
  connected: boolean;
  connectedAt: string | null;
  updatedAt: string | null;
}

export interface McpTokenRecord {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  clients: string[] | null;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface McpAuditRecord {
  tool: string;
  client: string | null;
  outcome: string;
  errorCode: string | null;
  durationMs: number;
  createdAt: string;
  tokenName: string;
}

export interface SyncJobRecord {
  slug: string;
  view: string;
  status: string;
  lastSuccessfulSyncAt: string | null;
}

// ── Gateway Types ───────────────────────────────────────────────────────────

export type GhlPolicyMode = "read_only" | "drafts_only" | "write";

export type ProviderGrantValue =
  | "read"
  | "write"
  | {
      capability: "read" | "write";
      actions?: string[];
      hooks?: string[];
      resources?: string[];
      teams?: string[];
    };

export interface GatewayPolicy {
  mode: GhlPolicyMode;
  role?: string | null;
  allowDelete: boolean;
  allowOutbound: boolean;
  allowAgencyWrite: boolean;
  allowBulk: boolean;
  allowSpend: boolean;
  allowBuild: boolean;
  outboundChannels?: string[] | null;
  locations: "*" | string[];
  providers: Record<string, ProviderGrantValue>;
  secrets?: string[];
  scopes?: string[];
  admin?: boolean;
}

export interface GatewayRoleTemplate {
  id: string;
  label: string;
  about: string;
}

export interface GatewayAgentRecord {
  agent: string;
  hasKey: boolean;
  enabled: boolean;
  opRef: string | null;
  policy: GatewayPolicy;
}

export interface GatewayBotSummary {
  agent: string;
  name: string;
  preset: { name: string; description: string; policy?: GatewayPolicy } | null;
  enabled: boolean;
  hasKey: boolean;
  key: {
    present: boolean;
    algorithm: string | null;
    fingerprint: string | null;
    createdAt: string | null;
    rotatedAt: string | null;
    updatedAt: string | null;
  };
  providers: Record<string, ProviderGrantValue>;
  grantedProviders: string[];
  policy: GatewayPolicy;
  usage: {
    last24h?: { requests?: number; errors?: number; writes?: number };
    last7d?: { requests?: number; errors?: number; writes?: number };
    lastUsedAt: string | null;
  };
  audit?: Array<{
    id?: string | number;
    at?: string;
    method?: string;
    path?: string;
    status?: number;
    ok?: boolean;
  }>;
  presetDrift?: boolean;
  presetPolicy?: GatewayPolicy;
}

export interface GatewayProviderAccount {
  id: string;
  label: string;
  realmId?: string;
  connectedAt?: string | null;
}

export interface GatewayProviderSummary {
  id: string;
  label: string;
  category: string;
  capability?: string;
  configured: boolean;
  connected?: boolean;
  authType?: "oauth" | "api_key" | "service_account";
  connectUrl?: string | null;
  accountLabel?: string | null;
  multiAccount?: boolean;
  accounts?: GatewayProviderAccount[];
  enabled: boolean;
  disabled?: boolean;
  enableFlag?: string;
  methods?: string[];
  oauthScopes?: string[];
  effectiveModes?: { canRead: boolean; canWrite: boolean };
  actions?: string[];
  actionCapabilities?: Record<string, "read" | "write" | "both">;
  allowedActions?: string[];
  resourceScoped?: boolean;
  teamScoped?: boolean;
  binary?: boolean;
  optIn?: boolean;
  notes?: string;
}

export interface GatewayStatusResponse {
  version?: string | number;
  versionId?: string | null;
  versionTag?: string | null;
  companyId?: string;
  agency?: {
    authorized: boolean;
    accessExpiresInSeconds?: number;
    scopeCount?: number;
    refreshedAt?: string;
    scopes?: string[];
  };
  locations?: {
    stored: number;
    withLiveToken: number;
    installedAtHighLevel: number | { error: string } | null;
  };
  ghlScopes?: {
    requiredCount: number;
    missing: string[];
    granted?: string[];
    pendingReauth?: string[];
  };
}

export interface GatewayAdminHealthResponse {
  ok: boolean;
  checkedAt?: string;
  version?: string | null;
  legacyMode?: string;
  d1?: { ok: boolean; latencyMs?: number; error?: string };
  providers?: Array<{ id: string; label: string; category: string; enabled: boolean; configured: boolean }>;
  warnings?: Array<{ code: string; severity: string; provider: string | null }>;
}

export interface GatewayScopeEntry {
  id: string;
  integration: string;
  group?: string;
  access: "read" | "write" | "action" | "both";
  status: "granted" | "pending_reauth" | "custom" | "built_in";
  funnelRequired?: boolean;
  custom?: boolean;
  description?: string;
}

export interface GatewayScopesIntegration {
  id: string;
  label: string;
  kind: "ghl" | "provider" | "gateway_route";
  totalCount: number;
  grantedCount?: number;
  pendingCount?: number;
  scopes: GatewayScopeEntry[];
}

export interface GatewayScopesCatalogResponse {
  ok?: boolean;
  pendingReauthScopes?: string[];
  reauthUrl?: string;
  integrations?: GatewayScopesIntegration[];
  // Alternate flexible payload shapes from gateway v169
  ghl?: {
    granted?: string[];
    custom?: Array<string | { id: string; access?: string; group?: string; description?: string }>;
    pendingReauth?: string[];
    requiredFunnel?: string[];
    scopes?: GatewayScopeEntry[];
  };
  providers?: Record<string, { label?: string; scopes?: GatewayScopeEntry[]; custom?: GatewayScopeEntry[] }>;
  routes?: GatewayScopeEntry[];
}

// ── Workflows & Voice Types ─────────────────────────────────────────────────

export interface WorkflowItem {
  path: string;
  profile: string;
  title: string;
  updatedAt: number;
}

export interface VoiceStatusResponse {
  ok?: boolean;
  configured?: boolean;
  source?: string;
  model?: string;
  voice?: string;
  detail?: string;
}

export interface VoiceSessionResponse {
  ok?: boolean;
  clientSecret?: string;
  offerUrl?: string;
  model?: string;
  voice?: string;
  journal?: { callId?: string } | null;
}

export interface VoiceRunRecord {
  runId?: number;
  status?: string;
  kind?: string;
  output?: string;
}

// ── API Namespaces ──────────────────────────────────────────────────────────

export const irOpsApi = {
  salesDashboard: {
    getTenants: () =>
      irFetch<{ ok?: boolean; scope?: "owner" | "location"; locationId?: string; tenants: TenantProfile[] }>(
        "/api/sales-dashboard/tenants",
      ),
    createTenant: (body: Record<string, unknown>) =>
      irFetch<{ ok?: boolean; slug?: string; tenant?: TenantProfile; customMenuUrl?: string }>(
        "/api/sales-dashboard/tenants",
        { method: "POST", body: JSON.stringify(body) },
      ),
    updateTenant: (body: Record<string, unknown>) =>
      irFetch<{ ok?: boolean; slug?: string; tenant?: TenantProfile; customMenuUrl?: string }>(
        "/api/sales-dashboard/tenants",
        { method: "PUT", body: JSON.stringify(body) },
      ),
    generateMenuLink: (slug: string, revokeExisting = false) =>
      irFetch<{ ok?: boolean; customMenuUrl?: string }>("/api/sales-dashboard/tenants", {
        method: "PATCH",
        body: JSON.stringify({ slug, ...(revokeExisting ? { revokeExisting: true } : {}) }),
      }),
    getDiagnosticHealth: (slugs?: string[]) => {
      const params = new URLSearchParams({ mode: "health" });
      for (const s of slugs ?? []) params.append("slug", s);
      return irFetch<{ ok?: boolean; generatedAt?: string; tenants: TenantStoredHealth[] }>(
        `/api/sales-dashboard/diagnostic?${params.toString()}`,
      );
    },
    getDiagnosticList: () =>
      irFetch<{ ok?: boolean; tenants: Array<{ slug: string; displayName: string; valid: boolean }> }>(
        "/api/sales-dashboard/diagnostic?mode=list",
      ),
    runDiagnosticForSlugs: (slugs: string[]) => {
      const params = new URLSearchParams();
      for (const s of slugs) params.append("slug", s);
      return irFetch<{ ok?: boolean; tenants: TenantDiagnostic[] }>(
        `/api/sales-dashboard/diagnostic?${params.toString()}`,
        { timeoutMs: 45_000 },
      );
    },
    testDraftDiagnostic: (profile: TenantProfile) =>
      irFetch<{ ok?: boolean; tenant: TenantDiagnostic }>("/api/sales-dashboard/diagnostic", {
        method: "POST",
        body: JSON.stringify({ profile }),
        timeoutMs: 45_000,
      }),
    discoverGhlLocations: (offset = 0, limit = 25) =>
      irFetch<{ locations?: GhlLocationChoice[]; nextOffset?: number | null }>(
        `/api/sales-dashboard/discovery?provider=ghl&offset=${offset}&limit=${limit}`,
      ),
    discoverGhlResources: (locationId: string) =>
      irFetch<Partial<GhlResourceChoices>>(
        `/api/sales-dashboard/discovery?provider=ghl&locationId=${encodeURIComponent(locationId)}`,
      ),
    discoverMetaAccounts: () =>
      irFetch<{ accounts?: MetaChoice[] }>("/api/sales-dashboard/discovery?provider=meta"),
    discoverGa4Properties: () =>
      irFetch<{ properties?: Ga4Choice[] }>("/api/sales-dashboard/discovery?provider=ga4"),
    getAccounting: (slug: string) =>
      irFetch<{ ok?: boolean; status?: AccountingStatus }>(
        `/api/sales-dashboard/accounting?slug=${encodeURIComponent(slug)}`,
      ),
    connectAccounting: (slug: string) =>
      irFetch<{ ok?: boolean; authorizeUrl?: string }>("/api/sales-dashboard/accounting", {
        method: "POST",
        body: JSON.stringify({ slug }),
      }),
    disconnectAccounting: (slug: string) =>
      irFetch<{ ok?: boolean }>(`/api/sales-dashboard/accounting?slug=${encodeURIComponent(slug)}`, {
        method: "DELETE",
      }),
    getCapital: (view = "30d") =>
      irFetch<Record<string, unknown>>(`/api/sales-dashboard/capital?view=${encodeURIComponent(view)}`),
    getSnapshots: (slug?: string) =>
      irFetch<Record<string, unknown>>(
        slug ? `/api/sales-dashboard/snapshots?slug=${encodeURIComponent(slug)}` : "/api/sales-dashboard/snapshots",
      ),
    getTeam: () => irFetch<Record<string, unknown>>("/api/sales-dashboard/team"),
    getTeamSettings: () => irFetch<Record<string, unknown>>("/api/sales-dashboard/team/settings"),
    getMcpTokens: () =>
      irFetch<{ ok?: boolean; tokens: McpTokenRecord[]; audit: McpAuditRecord[] }>(
        "/api/sales-dashboard/mcp-tokens",
      ),
    createMcpToken: (body: {
      name: string;
      scopes: string[];
      clients: string[] | null;
      expiresInDays: number | null;
    }) =>
      irFetch<{ ok?: boolean; token?: string; detail?: string }>("/api/sales-dashboard/mcp-tokens", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    revokeMcpToken: (id: string) =>
      irFetch<{ ok?: boolean }>(`/api/sales-dashboard/mcp-tokens?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    getNeonAds: (query = "") =>
      irFetch<Record<string, unknown>>(`/api/sales-dashboard/neon-ads${query ? `?${query}` : ""}`),
    getSyncStatus: () =>
      irFetch<{ jobs?: SyncJobRecord[] }>("/api/sales-dashboard/sync"),
    triggerSync: (body: { slug?: string; all?: boolean } = {}) =>
      irFetch<{ ok?: boolean; synced?: number; message?: string }>("/api/sales-dashboard/sync", {
        method: "POST",
        body: JSON.stringify(body),
        timeoutMs: 60_000,
      }),
  },

  gateway: {
    getHealth: () => irFetch<{ status?: string }>("/api/gateway/health"),
    getStatus: () => irFetch<GatewayStatusResponse>("/api/gateway/status"),
    getProviders: () => irFetch<{ providers: GatewayProviderSummary[] }>("/api/gateway/providers"),
    getAdminHealth: () => irFetch<GatewayAdminHealthResponse>("/api/gateway/admin/health"),
    getAgents: () =>
      irFetch<{ legacyMode?: string; roles?: GatewayRoleTemplate[]; agents: GatewayAgentRecord[] }>(
        "/api/gateway/admin/agents",
      ),
    getBots: () =>
      irFetch<{ generatedAt?: string; count?: number; bots: GatewayBotSummary[] }>("/api/gateway/admin/bots"),
    getBotSummary: (agent: string, audit = 20) =>
      irFetch<GatewayBotSummary>(
        `/api/gateway/admin/bots/${encodeURIComponent(agent)}/summary?audit=${audit}`,
      ),
    getRoles: () => irFetch<{ roles: GatewayRoleTemplate[] }>("/api/gateway/admin/roles"),
    getAgentPolicy: (agent: string) =>
      irFetch<{ agent?: string; policy: GatewayPolicy }>(
        `/api/gateway/admin/agents/${encodeURIComponent(agent)}/policy`,
      ),
    updateAgentPolicy: (agent: string, policy: Partial<GatewayPolicy>) =>
      irFetch<{ agent: string; policy: GatewayPolicy }>(
        `/api/gateway/admin/agents/${encodeURIComponent(agent)}/policy`,
        { method: "PUT", body: JSON.stringify({ policy }) },
      ),
    upsertAgent: (
      agent: string,
      body: { enabled?: boolean; role?: string; policy?: Partial<GatewayPolicy>; opRef?: string },
    ) =>
      irFetch<{ agent: string; enabled: boolean; policy: GatewayPolicy }>(
        `/api/gateway/admin/agents/${encodeURIComponent(agent)}`,
        { method: "PUT", body: JSON.stringify(body) },
      ),
    createAgentKey: (
      agent: string,
      body: { role?: string; replace?: boolean; locations?: "*" | string[]; policy?: Partial<GatewayPolicy> },
    ) =>
      irFetch<{ agent: string; key?: string; token?: string; apiKey?: string; policy?: GatewayPolicy }>(
        `/api/gateway/admin/agents/${encodeURIComponent(agent)}/new-key`,
        { method: "POST", body: JSON.stringify(body) },
      ),
    rotateAgentKey: (agent: string) =>
      irFetch<{ agent: string; key?: string; token?: string; apiKey?: string }>(
        `/api/gateway/admin/agents/${encodeURIComponent(agent)}/keys/rotate`,
        { method: "POST", body: JSON.stringify({}) },
      ),
    revokeAgentKey: (agent: string) =>
      irFetch<{ ok?: boolean; agent?: string }>(
        `/api/gateway/admin/agents/${encodeURIComponent(agent)}/keys/revoke`,
        { method: "POST", body: JSON.stringify({}) },
      ),
    getScopes: () => irFetch<GatewayScopesCatalogResponse>("/api/gateway/admin/scopes"),
    addScopes: (
      integration: string,
      body: { scopes: Array<{ id: string; access?: string; group?: string; description?: string }> },
    ) =>
      irFetch<{ ok?: boolean; added?: number; pendingReauth?: boolean }>(
        `/api/gateway/admin/scopes/${encodeURIComponent(integration)}`,
        { method: "POST", body: JSON.stringify(body) },
      ),
    deleteScope: (integration: string, scopeId: string) =>
      irFetch<{ ok?: boolean }>(
        `/api/gateway/admin/scopes/${encodeURIComponent(integration)}/${encodeURIComponent(scopeId)}`,
        { method: "DELETE" },
      ),
    launchOAuthConnect: (provider: string, body: { returnTo?: string; loginHint?: string } = {}) =>
      irFetch<{ ok?: boolean; provider?: string; launchUrl: string; expiresInSeconds?: number }>(
        `/api/gateway/admin/oauth/${encodeURIComponent(provider)}/launch`,
        { method: "POST", body: JSON.stringify(body) },
      ),
    disconnectOAuthAccount: (provider: string, accountId: string) =>
      irFetch<{ ok?: boolean; provider?: string; accountId?: string }>(
        `/api/gateway/admin/oauth/${encodeURIComponent(provider)}/${encodeURIComponent(accountId)}`,
        { method: "DELETE" },
      ),
  },

  workflows: {
    list: () => irFetch<{ ok?: boolean; workflows: WorkflowItem[] }>("/api/voice/hermes-talk/workflows"),
    read: (path: string) =>
      irFetch<{ ok?: boolean; path?: string; content: string }>(
        `/api/voice/hermes-talk/workflows/read?path=${encodeURIComponent(path)}`,
      ),
    save: (path: string, content: string) =>
      irFetch<{ ok?: boolean; path?: string }>("/api/voice/hermes-talk/workflows/save", {
        method: "POST",
        body: JSON.stringify({ path, content }),
        timeoutMs: 95_000,
      }),
  },

  voice: {
    getStatus: () => irFetch<VoiceStatusResponse>("/api/voice/hermes-talk/status", { timeoutMs: 10_000 }),
    createSession: () =>
      irFetch<VoiceSessionResponse>("/api/voice/hermes-talk/session", {
        method: "POST",
        body: JSON.stringify({}),
        timeoutMs: 20_000,
      }),
    runTool: (name: string, args: Record<string, unknown>) =>
      irFetch<{ ok?: boolean; output?: string }>("/api/voice/hermes-talk/tool", {
        method: "POST",
        body: JSON.stringify({ name, arguments: args }),
        timeoutMs: 90_000,
      }),
    getRuns: () => irFetch<{ runs?: VoiceRunRecord[] }>("/api/voice/hermes-talk/runs", { timeoutMs: 12_000 }),
    postJournal: (callId: string, events: Array<Record<string, unknown>>) =>
      irFetch<Record<string, unknown>>("/api/voice/hermes-talk/journal", {
        method: "POST",
        body: JSON.stringify({ call_id: callId, events }),
        timeoutMs: 8_000,
      }),
  },
};
