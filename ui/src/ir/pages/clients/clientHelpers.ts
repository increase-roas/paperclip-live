import type {
  ConnectionStatus,
  SourceKey,
  TenantProfile,
  TenantStoredHealth,
} from "../../api/irOps";

export const CLIENT_REPORT_ORIGIN = "https://dashboard.increaseai.tech";

export const SOURCE_LABELS: Record<SourceKey, string> = {
  ghl: "GoHighLevel",
  calls: "Calls",
  cash: "Cash",
  capacity: "Capacity",
  ga4: "GA4",
  meta: "Meta Ads",
};

const REASON_LABELS: Record<string, string> = {
  missing_configuration: "Missing setup",
  invalid_configuration: "Invalid setup",
  incomplete_read: "Incomplete data returned",
  invalid_profile: "Saved customer profile is invalid",
  ghl_reauth_required: "GHL authorization expired — reconnect the GHL app",
  ghl_auth_rejected: "GHL rejected the connection — reconnect or include this location",
  ghl_endpoint_missing: "GHL does not offer one of the reads this card needs",
  ghl_request_rejected: "GHL rejected this customer's request — check the saved GHL setup",
  ghl_upstream_unavailable: "GHL was unavailable — retry",
  ghl_rate_limited: "GHL rate-limited the check — retry in a few minutes",
  ghl_timeout: "GHL did not answer in time — retry",
  ghl_unexpected_record: "GHL returned a record this card cannot read",
  ghl_date_mismatch: "GHL returned a record outside the requested dates",
  ghl_location_mismatch: "GHL returned a record for a different location — check location ID",
  ghl_calendar_mismatch: "GHL returned an event for a different calendar — check calendar ID",
  ghl_response_too_large: "GHL returned more data than this card accepts",
  ghl_pipeline_mismatch: "No pipeline matches this customer's pipeline name",
  ghl_proposal_stage_missing: "No stage in this pipeline reads as the proposal or pitch stage",
  ghl_proposal_stage_ambiguous: "More than one stage matches this customer's proposal stage",
  ghl_unknown: "GHL returned data this card could not verify — retry, then check saved setup",
  ghl_call_scope_or_access: "Add GHL conversation-message read access, then reconnect",
  ghl_payment_scope_or_access: "Add GHL payment read access, then reconnect",
  meta_token_or_account_access: "Assign this ad account to the agency Meta system user",
  ga4_property_access: "Give the dashboard service account Viewer access to this GA4 property",
  calendar_not_found: "Choose an existing calendar for this customer",
};

export function diagnosticReasonLabel(reason?: string): string {
  if (!reason) return "";
  return REASON_LABELS[reason] ?? reason.replace(/_/g, " ");
}

export function normalizeMetaAccountId(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  return /^\d+$/.test(trimmed) ? `act_${trimmed}` : trimmed;
}

export function currentUtcMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

export function withTenantDefaults(profile: TenantProfile): TenantProfile {
  return {
    ...profile,
    businessType: profile.businessType ?? "hot_tub",
    capacityMode: profile.capacityMode ?? "install",
    financialTracking: profile.financialTracking ?? "ghl",
  };
}

export function buildTenantRequestBody(profile: TenantProfile): Record<string, unknown> {
  return {
    ...(profile.slug ? { slug: profile.slug } : {}),
    displayName: profile.displayName.trim(),
    locationId: profile.ghlLocationId.trim(),
    ghlCalendarId: (profile.ghlCalendarId ?? "").trim(),
    ghlInstallCalendarId: (profile.ghlInstallCalendarId ?? "").trim(),
    metaAdAccountId:
      profile.metaTracking === "not_applicable" ? "" : normalizeMetaAccountId(profile.metaAdAccountId),
    metaTracking: profile.metaTracking ?? "",
    ga4PropertyId: profile.websiteTracking === "not_applicable" ? "" : (profile.ga4PropertyId ?? "").trim(),
    ghlPipelineName: (profile.ghlPipelineName ?? "").trim(),
    ghlProposalStageName: (profile.ghlProposalStageName ?? "").trim(),
    websiteTracking: profile.websiteTracking ?? "",
    businessType: profile.businessType ?? "hot_tub",
    monthlyCashTarget:
      typeof profile.monthlyCashTarget === "number" && Number.isFinite(profile.monthlyCashTarget)
        ? profile.monthlyCashTarget
        : undefined,
    capacityMode: profile.capacityMode ?? "install",
    financialTracking: profile.financialTracking ?? "ghl",
    ...(profile.financialTracking === "manual" && profile.manualFinancials
      ? {
          manualFinancials: {
            month: profile.manualFinancials.month,
            totalSalesUsd: profile.manualFinancials.totalSalesUsd,
            cashCollectedUsd: profile.manualFinancials.cashCollectedUsd,
            totalExpensesUsd: profile.manualFinancials.totalExpensesUsd,
          },
        }
      : {}),
  };
}

export function buildDiagnosticDraftProfile(profile: TenantProfile): TenantProfile {
  return {
    version: 1,
    slug: profile.slug || "connection-test",
    displayName: profile.displayName.trim(),
    ghlLocationId: profile.ghlLocationId.trim(),
    ghlCalendarId: (profile.ghlCalendarId ?? "").trim() || undefined,
    ghlInstallCalendarId: (profile.ghlInstallCalendarId ?? "").trim() || undefined,
    metaAdAccountId:
      profile.metaTracking === "not_applicable"
        ? undefined
        : normalizeMetaAccountId(profile.metaAdAccountId) || undefined,
    metaTracking: profile.metaTracking,
    ga4PropertyId:
      profile.websiteTracking === "not_applicable" ? undefined : (profile.ga4PropertyId ?? "").trim() || undefined,
    ghlPipelineName: (profile.ghlPipelineName ?? "").trim() || undefined,
    ghlProposalStageName: (profile.ghlProposalStageName ?? "").trim() || undefined,
    websiteTracking: profile.websiteTracking,
    businessType: profile.businessType ?? "hot_tub",
    monthlyCashTarget: profile.monthlyCashTarget ?? undefined,
    capacityMode: profile.capacityMode ?? "install",
    financialTracking: profile.financialTracking === "not_applicable" ? "not_applicable" : "ghl",
  };
}

export type ConnectionBadgeState = "connected" | "not_applicable" | "missing";

export function getTenantConnectionBadges(tenant: TenantProfile): {
  ghl: ConnectionBadgeState;
  meta: ConnectionBadgeState;
  ga4: ConnectionBadgeState;
} {
  const ghl: ConnectionBadgeState = tenant.ghlLocationId?.trim() ? "connected" : "missing";
  const meta: ConnectionBadgeState =
    tenant.metaTracking === "not_applicable"
      ? "not_applicable"
      : tenant.metaAdAccountId?.trim()
        ? "connected"
        : "missing";
  const ga4: ConnectionBadgeState =
    tenant.websiteTracking === "not_applicable"
      ? "not_applicable"
      : tenant.ga4PropertyId?.trim()
        ? "connected"
        : "missing";
  return { ghl, meta, ga4 };
}

export interface ClientHealthIssue {
  source: SourceKey;
  label: string;
  status: string;
  reason?: string;
}

export function summarizeStoredHealth(health: TenantStoredHealth | undefined): {
  status: "healthy" | "needs_action" | "stale" | "unknown";
  issues: ClientHealthIssue[];
  lastSyncAt: string | null;
} {
  if (!health) {
    return { status: "unknown", issues: [], lastSyncAt: null };
  }
  const preferredView = health.views["30d"] ?? Object.values(health.views)[0];
  const issues: ClientHealthIssue[] = [];
  if (preferredView?.sources) {
    for (const key of Object.keys(SOURCE_LABELS) as SourceKey[]) {
      const entry = preferredView.sources[key];
      if (!entry) continue;
      if (entry.status === "NEEDS ACTION" || entry.status === "NOT CONNECTED") {
        issues.push({
          source: key,
          label: SOURCE_LABELS[key],
          status: entry.status,
          reason: entry.reason,
        });
      }
    }
  }
  const lastSyncAt = preferredView?.lastSuccessfulSyncAt ?? null;
  if (issues.length > 0) {
    return { status: "needs_action", issues, lastSyncAt };
  }
  if (health.status === "DEGRADED") {
    return { status: "stale", issues, lastSyncAt };
  }
  return { status: "healthy", issues, lastSyncAt };
}

export function formatClientReportUrl(slug: string): string {
  return `${CLIENT_REPORT_ORIGIN}/c/${encodeURIComponent(slug)}`;
}

export function statusBadgeTone(status: ConnectionStatus | string): "ok" | "warn" | "error" | "muted" {
  const upper = status.toUpperCase();
  if (upper === "LIVE" || upper === "FRESH" || upper === "HEALTHY") return "ok";
  if (upper === "NOT APPLICABLE") return "muted";
  if (upper === "NO RECENT DATA" || upper === "STALE" || upper === "REFRESHING") return "warn";
  return "error";
}
