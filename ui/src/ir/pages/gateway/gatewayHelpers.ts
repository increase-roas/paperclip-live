import type {
  GatewayAgentRecord,
  GatewayBotSummary,
  GatewayPolicy,
  GatewayProviderSummary,
  GatewayScopeEntry,
  GatewayScopesCatalogResponse,
  GatewayScopesIntegration,
  GatewayStatusResponse,
  GhlPolicyMode,
  ProviderGrantValue,
} from "../../api/irOps";

export const GATEWAY_OAUTH_START_URL =
  "https://increase-roas-oauth-gateway.increase-roas.workers.dev/oauth/start";

export const PAPERCLIP_GATEWAY_RETURN_URL =
  "https://app.increaseai.tech/company/settings/gateway";

export type ProviderConnectionStatus = "live" | "needs_connect" | "not_configured";

export interface ProviderConnectionClassification {
  status: ProviderConnectionStatus;
  badgeLabel: "Connected (LIVE)" | "Needs Connect" | "Not Configured";
  authType: "oauth" | "api_key" | "service_account";
  authLabel: "OAuth 2.0" | "API Key" | "Service Account";
  canConnect: boolean;
  connectUrl: string | null;
  scopeCount: number;
  actionCount: number;
}

const KNOWN_OAUTH_PROVIDER_IDS = new Set([
  "quickbooks",
  "gmail",
  "zoom",
  "google_ads_data_manager",
]);
const KNOWN_SERVICE_ACCOUNT_PROVIDER_IDS = new Set([
  "google_drive",
  "google_drive_upload",
  "google_sheets",
  "google_ads",
  "ga4",
  "ga4_data",
  "gtm",
]);

export function resolveProviderAuthType(
  provider: Pick<GatewayProviderSummary, "id" | "authType">,
): "oauth" | "api_key" | "service_account" {
  if (
    provider.authType === "oauth" ||
    provider.authType === "api_key" ||
    provider.authType === "service_account"
  ) {
    return provider.authType;
  }
  if (KNOWN_OAUTH_PROVIDER_IDS.has(provider.id)) return "oauth";
  if (KNOWN_SERVICE_ACCOUNT_PROVIDER_IDS.has(provider.id)) return "service_account";
  return "api_key";
}

export function formatAuthTypeLabel(
  authType: "oauth" | "api_key" | "service_account",
): "OAuth 2.0" | "API Key" | "Service Account" {
  if (authType === "oauth") return "OAuth 2.0";
  if (authType === "service_account") return "Service Account";
  return "API Key";
}

export function buildGatewayConnectUrl(
  rawConnectUrl: string | null | undefined,
  returnTo: string = PAPERCLIP_GATEWAY_RETURN_URL,
): string | null {
  if (!rawConnectUrl || !rawConnectUrl.trim()) return null;
  try {
    const url = new URL(rawConnectUrl.trim());
    if (url.protocol !== "https:") return null;
    if (returnTo && returnTo.startsWith("https://")) {
      url.searchParams.set("return_to", returnTo);
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function classifyProviderConnection(
  provider: GatewayProviderSummary,
): ProviderConnectionClassification {
  const authType = resolveProviderAuthType(provider);
  const authLabel = formatAuthTypeLabel(authType);
  const isLive =
    provider.connected !== undefined
      ? Boolean(provider.connected)
      : Boolean(provider.enabled && provider.configured);
  const connectUrl = buildGatewayConnectUrl(provider.connectUrl);
  const scopeCount = Array.isArray(provider.oauthScopes) ? provider.oauthScopes.length : 0;
  const actionCount = Array.isArray(provider.actions) ? provider.actions.length : 0;

  if (isLive) {
    return {
      status: "live",
      badgeLabel: "Connected (LIVE)",
      authType,
      authLabel,
      canConnect: Boolean(authType === "oauth" && provider.configured && connectUrl),
      connectUrl,
      scopeCount,
      actionCount,
    };
  }
  if (authType === "oauth" && provider.enabled && provider.configured && connectUrl) {
    return {
      status: "needs_connect",
      badgeLabel: "Needs Connect",
      authType,
      authLabel,
      canConnect: true,
      connectUrl,
      scopeCount,
      actionCount,
    };
  }
  return {
    status: "not_configured",
    badgeLabel: "Not Configured",
    authType,
    authLabel,
    canConnect: false,
    connectUrl,
    scopeCount,
    actionCount,
  };
}

export const ROLE_POLICY_DEFINITIONS: Record<
  string,
  {
    label: string;
    about: string;
    patch: Pick<
      GatewayPolicy,
      | "mode"
      | "allowDelete"
      | "allowOutbound"
      | "allowAgencyWrite"
      | "allowBulk"
      | "allowSpend"
      | "allowBuild"
      | "outboundChannels"
    >;
  }
> = {
  ghl_full: {
    label: "GHL full",
    about:
      "Read, write, text/email/publish, bulk jobs, agency writes and funnel/page building. No deletes, no spending.",
    patch: {
      mode: "write",
      allowDelete: false,
      allowOutbound: true,
      allowAgencyWrite: true,
      allowBulk: true,
      allowSpend: false,
      allowBuild: true,
      outboundChannels: null,
    },
  },
  ghl_write: {
    label: "GHL write (no sending)",
    about: "Read and edit CRM records. Cannot text, email or publish.",
    patch: {
      mode: "write",
      allowDelete: false,
      allowOutbound: false,
      allowAgencyWrite: false,
      allowBulk: false,
      allowSpend: false,
      allowBuild: false,
      outboundChannels: null,
    },
  },
  sms_only: {
    label: "SMS only",
    about: "Read and edit CRM records, and send SMS only (no email, workflows or campaigns).",
    patch: {
      mode: "write",
      allowDelete: false,
      allowOutbound: true,
      allowAgencyWrite: false,
      allowBulk: false,
      allowSpend: false,
      allowBuild: false,
      outboundChannels: ["SMS"],
    },
  },
  drafts_only: {
    label: "Drafts only",
    about: "Read, add notes and save drafts for a human to send.",
    patch: {
      mode: "drafts_only",
      allowDelete: false,
      allowOutbound: false,
      allowAgencyWrite: false,
      allowBulk: false,
      allowSpend: false,
      allowBuild: false,
      outboundChannels: null,
    },
  },
  read_only: {
    label: "Read only",
    about: "Inspect CRM and connected data without mutating any records.",
    patch: {
      mode: "read_only",
      allowDelete: false,
      allowOutbound: false,
      allowAgencyWrite: false,
      allowBulk: false,
      allowSpend: false,
      allowBuild: false,
      outboundChannels: null,
    },
  },
};

/** Fallback checked-in preset expectations for drift detection when /admin/bots omits presetPolicy. */
const FALLBACK_AGENT_PRESET_POLICIES: Record<
  string,
  Pick<GatewayPolicy, "mode" | "allowDelete" | "allowOutbound" | "allowAgencyWrite" | "allowBulk" | "allowSpend" | "allowBuild"> & {
    providers: Record<string, ProviderGrantValue>;
  }
> = {
  "dr-eggbot": {
    mode: "drafts_only",
    allowDelete: false,
    allowOutbound: false,
    allowAgencyWrite: false,
    allowBulk: false,
    allowSpend: false,
    allowBuild: false,
    providers: { google_drive: { capability: "read", actions: ["files", "drives"] } },
  },
  javar: {
    mode: "write",
    allowDelete: false,
    allowOutbound: false,
    allowAgencyWrite: false,
    allowBulk: false,
    allowSpend: false,
    allowBuild: false,
    providers: { wavv: "read" },
  },
  hermes: {
    mode: "write",
    allowDelete: false,
    allowOutbound: false,
    allowAgencyWrite: false,
    allowBulk: false,
    allowSpend: false,
    allowBuild: false,
    providers: { wavv: "read" },
  },
  paperclip: {
    mode: "drafts_only",
    allowDelete: false,
    allowOutbound: false,
    allowAgencyWrite: false,
    allowBulk: false,
    allowSpend: false,
    allowBuild: false,
    providers: { wavv: "read" },
  },
  grokbot: {
    mode: "read_only",
    allowDelete: false,
    allowOutbound: false,
    allowAgencyWrite: false,
    allowBulk: false,
    allowSpend: false,
    allowBuild: false,
    providers: { wavv: "read" },
  },
  "ads-checker": {
    mode: "read_only",
    allowDelete: false,
    allowOutbound: false,
    allowAgencyWrite: false,
    allowBulk: false,
    allowSpend: false,
    allowBuild: false,
    providers: { meta: "read", google_ads: "read", ga4: "read", ga4_data: "read" },
  },
  research: {
    mode: "read_only",
    allowDelete: false,
    allowOutbound: false,
    allowAgencyWrite: false,
    allowBulk: false,
    allowSpend: false,
    allowBuild: false,
    providers: { google_drive: "read", composio: "read" },
  },
  "drive-organizer": {
    mode: "read_only",
    allowDelete: false,
    allowOutbound: false,
    allowAgencyWrite: false,
    allowBulk: false,
    allowSpend: false,
    allowBuild: false,
    providers: { google_drive: { capability: "write", actions: ["files", "drives"] } },
  },
  "workflow-builder": {
    mode: "write",
    allowDelete: false,
    allowOutbound: false,
    allowAgencyWrite: false,
    allowBulk: false,
    allowSpend: false,
    allowBuild: false,
    providers: {},
  },
  kiwi: {
    mode: "read_only",
    allowDelete: false,
    allowOutbound: false,
    allowAgencyWrite: false,
    allowBulk: false,
    allowSpend: false,
    allowBuild: false,
    providers: {},
  },
};

export interface ProviderCapabilityProfile {
  supportsRead: boolean;
  supportsWrite: boolean;
  isReadOnly: boolean;
  isWriteOnly: boolean;
}

const KNOWN_READ_ONLY_PROVIDERS = new Set(["wavv", "ga4_data"]);
const KNOWN_WRITE_ONLY_PROVIDERS = new Set(["google_drive_upload"]);

export function getProviderCapabilityProfile(
  provider: GatewayProviderSummary,
): ProviderCapabilityProfile {
  if (KNOWN_READ_ONLY_PROVIDERS.has(provider.id)) {
    return { supportsRead: true, supportsWrite: false, isReadOnly: true, isWriteOnly: false };
  }
  if (KNOWN_WRITE_ONLY_PROVIDERS.has(provider.id)) {
    return { supportsRead: false, supportsWrite: true, isReadOnly: false, isWriteOnly: true };
  }
  const methods = (provider.methods ?? []).map((m) => m.toUpperCase());
  const hasGet = methods.length === 0 || methods.includes("GET") || methods.includes("HEAD");
  const hasWriteMethod = methods.some((m) => ["POST", "PUT", "PATCH", "DELETE"].includes(m));
  const actionCaps = Object.values(provider.actionCapabilities ?? {});
  const onlyReadActions =
    actionCaps.length > 0 && actionCaps.every((cap) => cap === "read") && !hasWriteMethod;
  const isReadOnly = (methods.length > 0 && hasGet && !hasWriteMethod) || onlyReadActions;
  const isWriteOnly = methods.length > 0 && !hasGet && hasWriteMethod;
  return {
    supportsRead: !isWriteOnly,
    supportsWrite: !isReadOnly,
    isReadOnly,
    isWriteOnly,
  };
}

export function normalizeProviderGrant(grant: ProviderGrantValue | undefined): {
  capability: "none" | "read" | "write";
  actions: string[] | null;
} {
  if (!grant) return { capability: "none", actions: null };
  if (typeof grant === "string") {
    return { capability: grant === "write" ? "write" : "read", actions: null };
  }
  return {
    capability: grant.capability === "write" ? "write" : "read",
    actions: Array.isArray(grant.actions) ? grant.actions : null,
  };
}

export interface ProviderCellDisplay {
  level: "none" | "read" | "read_ro" | "write" | "read_write";
  label: string;
  actionSummary?: string;
}

export function describeProviderGrant(
  grant: ProviderGrantValue | undefined,
  provider: GatewayProviderSummary,
): ProviderCellDisplay {
  const norm = normalizeProviderGrant(grant);
  if (norm.capability === "none") {
    return { level: "none", label: "—" };
  }
  const profile = getProviderCapabilityProfile(provider);
  const totalActions = provider.actions?.length ?? 0;
  const actionSummary =
    norm.actions && totalActions > 0 && norm.actions.length < totalActions
      ? `${norm.actions.length}/${totalActions}`
      : undefined;

  if (profile.isReadOnly) {
    return { level: "read_ro", label: "Read (RO)", actionSummary };
  }
  if (profile.isWriteOnly) {
    return { level: "write", label: "Write", actionSummary };
  }
  if (norm.capability === "write") {
    return { level: "read_write", label: "Read + Write", actionSummary };
  }
  return { level: "read", label: "Read", actionSummary };
}

export function describeGhlPolicy(policy: GatewayPolicy): {
  mode: GhlPolicyMode;
  label: string;
  flags: string[];
} {
  const label =
    policy.mode === "write"
      ? "Read + Write"
      : policy.mode === "drafts_only"
        ? "Drafts"
        : "Read";
  const flags: string[] = [];
  if (policy.allowDelete) flags.push("Del");
  if (policy.allowOutbound) {
    flags.push(
      policy.outboundChannels && policy.outboundChannels.length > 0
        ? `Out:${policy.outboundChannels.join("/")}`
        : "Out",
    );
  }
  if (policy.allowSpend) flags.push("Spend");
  if (policy.allowBuild) flags.push("Build");
  if (policy.allowAgencyWrite) flags.push("Agency");
  if (policy.allowBulk) flags.push("Bulk");
  return { mode: policy.mode, label, flags };
}

export function getAgentStatus(agent: Pick<GatewayAgentRecord, "hasKey" | "enabled">): {
  kind: "active" | "disabled" | "no_key";
  label: string;
} {
  if (!agent.hasKey) return { kind: "no_key", label: "No Key" };
  if (!agent.enabled) return { kind: "disabled", label: "Disabled" };
  return { kind: "active", label: "Key Active" };
}

export function getExpectedPresetPolicy(
  agentName: string,
  bot?: GatewayBotSummary,
): Partial<GatewayPolicy> | null {
  if (bot?.presetPolicy) return bot.presetPolicy;
  if (bot?.preset?.policy) return bot.preset.policy;
  const fallback = FALLBACK_AGENT_PRESET_POLICIES[agentName];
  return fallback ?? null;
}

function stableProviderMap(
  providers: Record<string, ProviderGrantValue> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(providers ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const norm = normalizeProviderGrant(val);
    if (norm.capability === "none") continue;
    const actions = norm.actions ? [...norm.actions].sort().join(",") : "*";
    out[key] = `${norm.capability}:${actions}`;
  }
  return out;
}

export function detectPresetDrift(
  agentName: string,
  policy: GatewayPolicy,
  bot?: GatewayBotSummary,
): { drifted: boolean; reason?: string; presetPolicy: Partial<GatewayPolicy> | null } {
  const presetPolicy = getExpectedPresetPolicy(agentName, bot);
  if (bot?.presetDrift === true) {
    return { drifted: true, reason: "Policy differs from checked-in preset", presetPolicy };
  }
  if (!presetPolicy) {
    return { drifted: false, presetPolicy: null };
  }
  const diffs: string[] = [];
  if (presetPolicy.mode && policy.mode !== presetPolicy.mode) {
    diffs.push(`GHL mode (${policy.mode} vs preset ${presetPolicy.mode})`);
  }
  const boolFlags = [
    "allowDelete",
    "allowOutbound",
    "allowAgencyWrite",
    "allowBulk",
    "allowSpend",
    "allowBuild",
  ] as const;
  for (const flag of boolFlags) {
    if (typeof presetPolicy[flag] === "boolean" && Boolean(policy[flag]) !== presetPolicy[flag]) {
      diffs.push(flag);
    }
  }
  if (presetPolicy.providers) {
    const actualP = JSON.stringify(stableProviderMap(policy.providers));
    const expectedP = JSON.stringify(stableProviderMap(presetPolicy.providers));
    if (actualP !== expectedP) {
      diffs.push("provider grants");
    }
  }
  if (diffs.length === 0) return { drifted: false, presetPolicy };
  return {
    drifted: true,
    reason: `Drifted from preset: ${diffs.join(", ")}`,
    presetPolicy,
  };
}

export function inferScopeAccess(scopeId: string): "read" | "write" | "both" | "action" {
  const lower = scopeId.trim().toLowerCase();
  if (lower.endsWith(".readonly") || lower.endsWith(":read") || lower.endsWith(".read")) {
    return "read";
  }
  if (
    lower.endsWith(".write") ||
    lower.endsWith(".create") ||
    lower.endsWith(".delete") ||
    lower.endsWith(".publish") ||
    lower.endsWith(":write") ||
    lower.includes("mutate") ||
    lower.includes("upload")
  ) {
    return "write";
  }
  if (lower.includes("read") && lower.includes("write")) return "both";
  return "action";
}

export function parseMultiLineScopes(
  raw: string,
): Array<{ id: string; access: "read" | "write" | "both" | "action" }> {
  const seen = new Set<string>();
  const out: Array<{ id: string; access: "read" | "write" | "both" | "action" }> = [];
  const tokens = raw
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    out.push({ id: token, access: inferScopeAccess(token) });
  }
  return out;
}

const BUILTIN_FUNNEL_SCOPES = new Set([
  "locations.readonly",
  "locations.write",
  "locations/customFields.readonly",
  "locations/customFields.write",
  "locations/customValues.readonly",
  "locations/customValues.write",
  "locations/tags.readonly",
  "locations/tags.write",
  "locations/tasks.readonly",
  "locations/tasks.write",
  "locations/templates.readonly",
  "businesses.readonly",
  "businesses.write",
  "users.readonly",
  "users.write",
  "contacts.readonly",
  "contacts.write",
  "calendars.readonly",
  "calendars.write",
  "calendars/events.readonly",
  "calendars/events.write",
  "calendars/groups.readonly",
  "calendars/groups.write",
  "calendars/resources.readonly",
  "calendars/resources.write",
  "opportunities.readonly",
  "opportunities.write",
  "pipelines.readonly",
  "pipelines.write",
  "pipelines.create",
  "workflows.readonly",
  "workflows.write",
  "workflows.delete",
  "workflows.publish",
  "funnels/redirect.readonly",
  "funnels/redirect.write",
  "funnels/page.readonly",
  "funnels/funnel.readonly",
  "funnels/pagecount.readonly",
  "conversations.readonly",
  "conversations.write",
  "conversations/message.readonly",
  "conversations/message.write",
  "conversations/livechat.write",
  "medias.readonly",
  "medias.write",
  "forms.readonly",
  "forms.write",
  "surveys.readonly",
  "links.readonly",
  "links.write",
]);

function ghlScopeGroup(scopeId: string): string {
  const prefix = scopeId.split(/[/.]/)[0] ?? "general";
  return prefix.charAt(0).toUpperCase() + prefix.slice(1);
}

export function buildNormalizedScopesCatalog(
  catalog: GatewayScopesCatalogResponse | null,
  providers: GatewayProviderSummary[],
  status: GatewayStatusResponse | null,
): {
  integrations: GatewayScopesIntegration[];
  pendingReauthScopes: string[];
  reauthUrl: string;
  synthesizedFallback: boolean;
} {
  const reauthUrl = catalog?.reauthUrl || GATEWAY_OAUTH_START_URL;

  if (catalog?.integrations && Array.isArray(catalog.integrations) && catalog.integrations.length > 0) {
    const pending =
      catalog.pendingReauthScopes ??
      catalog.integrations
        .filter((i) => i.id === "ghl")
        .flatMap((i) => i.scopes.filter((s) => s.status === "pending_reauth").map((s) => s.id));
    return {
      integrations: catalog.integrations,
      pendingReauthScopes: pending,
      reauthUrl,
      synthesizedFallback: false,
    };
  }

  // Build from flexible v169 fields OR gracefully synthesize from /api/gateway/providers + /status
  const synthesizedFallback = !catalog;
  const ghlScopes: GatewayScopeEntry[] = [];
  const seenGhl = new Set<string>();

  if (catalog?.ghl?.scopes && Array.isArray(catalog.ghl.scopes)) {
    for (const s of catalog.ghl.scopes) {
      seenGhl.add(s.id);
      ghlScopes.push(s);
    }
  } else {
    const granted = catalog?.ghl?.granted ?? status?.agency?.scopes ?? status?.ghlScopes?.granted ?? [];
    const missing = status?.ghlScopes?.missing ?? [];
    const pendingList = catalog?.ghl?.pendingReauth ?? status?.ghlScopes?.pendingReauth ?? [];
    const requiredSet = new Set(catalog?.ghl?.requiredFunnel ?? [...BUILTIN_FUNNEL_SCOPES]);
    const pendingSet = new Set([...pendingList, ...missing]);

    for (const id of granted) {
      if (seenGhl.has(id)) continue;
      seenGhl.add(id);
      ghlScopes.push({
        id,
        integration: "ghl",
        group: ghlScopeGroup(id),
        access: inferScopeAccess(id),
        status: "granted",
        funnelRequired: requiredSet.has(id),
      });
    }

    for (const rawCustom of catalog?.ghl?.custom ?? []) {
      const id = typeof rawCustom === "string" ? rawCustom : rawCustom.id;
      if (!id || seenGhl.has(id)) continue;
      seenGhl.add(id);
      ghlScopes.push({
        id,
        integration: "ghl",
        group: typeof rawCustom === "string" ? ghlScopeGroup(id) : rawCustom.group ?? ghlScopeGroup(id),
        access:
          typeof rawCustom === "string"
            ? inferScopeAccess(id)
            : ((rawCustom.access as GatewayScopeEntry["access"]) || inferScopeAccess(id)),
        status: pendingSet.has(id) ? "pending_reauth" : "custom",
        custom: true,
        funnelRequired: requiredSet.has(id),
      });
    }

    // Include funnel-profile scopes so the operator always sees missing/required GHL scopes
    for (const id of [...requiredSet, ...pendingSet]) {
      if (seenGhl.has(id)) continue;
      seenGhl.add(id);
      ghlScopes.push({
        id,
        integration: "ghl",
        group: ghlScopeGroup(id),
        access: inferScopeAccess(id),
        status: pendingSet.has(id) ? "pending_reauth" : "granted",
        funnelRequired: requiredSet.has(id),
      });
    }
  }

  ghlScopes.sort((a, b) => a.id.localeCompare(b.id));
  const pendingReauthScopes = ghlScopes
    .filter((s) => s.status === "pending_reauth")
    .map((s) => s.id);

  const ghlTotal = status?.agency?.scopeCount
    ? Math.max(status.agency.scopeCount, ghlScopes.length)
    : ghlScopes.length;

  const integrations: GatewayScopesIntegration[] = [
    {
      id: "ghl",
      label: "GoHighLevel",
      kind: "ghl",
      totalCount: ghlTotal,
      grantedCount: status?.agency?.scopeCount ?? ghlScopes.filter((s) => s.status === "granted").length,
      pendingCount: pendingReauthScopes.length,
      scopes: ghlScopes,
    },
  ];

  for (const provider of providers) {
    const profile = getProviderCapabilityProfile(provider);
    const providerCatalog = catalog?.providers?.[provider.id];
    const scopes: GatewayScopeEntry[] = [];
    if (providerCatalog?.scopes?.length) {
      scopes.push(...providerCatalog.scopes);
    } else {
      const actions = provider.actions ?? [];
      if (actions.length > 0) {
        for (const action of actions) {
          const cap = provider.actionCapabilities?.[action];
          const access: GatewayScopeEntry["access"] =
            cap === "read"
              ? "read"
              : cap === "write"
                ? "write"
                : cap === "both"
                  ? "both"
                  : profile.isReadOnly
                    ? "read"
                    : profile.isWriteOnly
                      ? "write"
                      : "both";
          scopes.push({
            id: `${provider.id}:${action}`,
            integration: provider.id,
            group: provider.category,
            access,
            status: "built_in",
            description: provider.notes,
          });
        }
      } else {
        scopes.push({
          id: `${provider.id}:${profile.isReadOnly ? "read" : profile.isWriteOnly ? "write" : "read_write"}`,
          integration: provider.id,
          group: provider.category,
          access: profile.isReadOnly ? "read" : profile.isWriteOnly ? "write" : "both",
          status: "built_in",
          description: provider.notes,
        });
      }
      if (providerCatalog?.custom?.length) {
        scopes.push(...providerCatalog.custom.map((c) => ({ ...c, custom: true })));
      }
    }

    integrations.push({
      id: provider.id,
      label: provider.label,
      kind: "provider",
      totalCount: scopes.length,
      scopes,
    });
  }

  const routeScopes: GatewayScopeEntry[] =
    catalog?.routes && catalog.routes.length > 0
      ? catalog.routes
      : [
          {
            id: "paperclip-reader",
            integration: "gateway_routes",
            group: "Named Route Scopes",
            access: "read",
            status: "built_in",
            description: "Read GET /api/admin/bots, /api/admin/bots/:agent/summary, and /api/admin/health.",
          },
        ];

  integrations.push({
    id: "gateway_routes",
    label: "Gateway Route Scopes",
    kind: "gateway_route",
    totalCount: routeScopes.length,
    scopes: routeScopes,
  });

  return {
    integrations,
    pendingReauthScopes,
    reauthUrl,
    synthesizedFallback,
  };
}
