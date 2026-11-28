import { isDashboardPeriod, type DashboardPeriod } from "@paperclipai/shared";
import { readGatewayFulfillmentBundle } from "./gateway-fulfillment-client.js";
import {
  deriveClientRatios,
  filterClientOnlyPortfolio,
  isExcludedClientSlug,
  type FilterClientOnlyPortfolioOptions,
} from "./portfolio-filter.js";

export {
  filterClientOnlyPortfolio,
  isExcludedClientSlug,
  type FilterClientOnlyPortfolioOptions,
};

const DEFAULT_SALES_DASHBOARD_URL = "https://dashboard.increaseai.tech";
const DEFAULT_TIMEOUT_MS = 6_000;
const USER_AGENT = "paperclip-server/1.0";

export interface SalesDashboardClientOptions {
  baseUrl?: string;
  adminKey?: string;
  gatewayBaseUrl?: string;
  gatewayToken?: string;
  agencyCompanyId?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  bypassCache?: boolean;
}

export interface CapitalMetricsPayload {
  window?: string;
  cashCollectedUsd?: number | null;
  salesUsd?: number | null;
  expensesUsd?: number | null;
  netProfitUsd?: number | null;
  grossMarginPercent?: number | null;
  pipelineRevenueUsd?: number | null;
  adSpendUsd?: number | null;
  newLeads?: number | null;
  wonDeals?: number | null;
  closeRate?: number | null;
  cplUsd?: number | null;
  cacUsd?: number | null;
  grossProfitPerWonDealUsd?: number | null;
  cacPaybackDeals?: number | null;
  monthlyLaborUsd?: number;
  monthlyOverheadUsd?: number;
  monthlyBurnUsd?: number;
  runwayMonths?: number | null;
  evidence?: {
    financial?: boolean;
    marketing?: boolean;
    labor?: boolean;
    cash?: boolean;
    capacity?: boolean;
    target?: boolean;
  };
}

export interface CapitalClientEntry {
  slug: string;
  displayName: string;
  status?: string | null;
  archived?: boolean | null;
  syncedAt: string | null;
  syncStatus: string | null;
  marketing: CapitalMetricsPayload;
  financialMonth: CapitalMetricsPayload | null;
}

export interface CapitalApiPayload {
  generatedAt: string;
  view: string;
  members: Array<{ id?: string; status?: string }>;
  operating: {
    monthlyLaborUsd: number;
    monthlyOverheadUsd: number;
    monthlyBurnUsd: number;
    runwayMonths: number | null;
    cashOnHandUsd?: number | null;
  } | null;
  settings?: {
    cashOnHandUsd?: number | null;
    fixedMonthlyCostUsd?: number | null;
  } | null;
  owner: CapitalClientEntry | null;
  clients: CapitalClientEntry[];
}

export interface SnapshotGhlData {
  newLeads?: number;
  appointmentsBooked?: number;
  showedAppointments?: number;
  pitchedOpportunities?: number;
  wonDeals?: number;
  closeRate?: number | null;
  showRate?: number | null;
  pipelineWonUsd?: number;
  speedToLeadSeconds?: number | null;
}

export interface SnapshotMetaData {
  spend?: number;
  impressions?: number;
  clicks?: number;
  ctr?: number | null;
  zeroLeadDays?: number | null;
}

export interface SnapshotCashData {
  cashCollectedUsd?: number;
}

export interface SnapshotFinancialsData {
  cashCollectedUsd?: number;
  totalSalesUsd?: number;
  totalExpensesUsd?: number;
  netProfitUsd?: number;
}

export interface ParsedClientSnapshot {
  slug: string;
  displayName: string;
  status?: string | null;
  archived?: boolean | null;
  observedAt: string;
  ghl?: SnapshotGhlData;
  meta?: SnapshotMetaData;
  cash?: SnapshotCashData;
  financials?: SnapshotFinancialsData;
}

export interface SnapshotsPayload {
  observedAt: string;
  owner: ParsedClientSnapshot | null;
  clients: ParsedClientSnapshot[];
}

export interface NeonAdsAccountClient {
  clientId: string;
  displayName: string;
  sevenDay: { spend: number | null; leads: number | null; cpl: number | null };
  thirtyDay: { spend: number | null; leads: number | null; cpl: number | null };
  lastDataDay: string | null;
  stale: boolean;
}

export interface NeonAdsAccountsPayload {
  observedAt: string;
  latestDataDay: string | null;
  clients: NeonAdsAccountClient[];
}

export interface NeonAdsPipelineClient {
  clientId: string;
  displayName: string;
  spend: number | null;
  crmLeads: number | null;
  qualified: number | null;
  booked: number | null;
  showed: number | null;
  sold: number | null;
  revenue: number | null;
  costPerCrmLead: number | null;
  costPerBooked: number | null;
  costPerSold: number | null;
  roas: number | null;
}

export interface NeonAdsPipelinePayload {
  observedAt: string;
  period?: DashboardPeriod | null;
  clients: NeonAdsPipelineClient[];
}

export interface MergedClientMetrics {
  slug: string;
  displayName: string;
  status?: string | null;
  archived?: boolean | null;
  observedAt: string | null;
  // Sales (GHL / pipeline)
  newLeads: number | null;
  booked: number | null;
  showed: number | null;
  pitched: number | null;
  wonDeals: number | null;
  showRate: number | null;
  closeRate: number | null;
  pipelineRevenueUsd: number | null;
  cashCollectedUsd: number | null;
  speedToLeadSeconds: number | null;
  // Marketing (Meta / Neon Ads)
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  cpl: number | null;
  cac: number | null;
  roas: number | null;
  costPerHeldAppointment: number | null;
  zeroLeadDays: number | null;
}

export interface PortfolioSnapshotBundle {
  capital: CapitalApiPayload | null;
  snapshots: SnapshotsPayload | null;
  neonAccounts: NeonAdsAccountsPayload | null;
  neonPipeline: NeonAdsPipelinePayload | null;
  clients: MergedClientMetrics[];
  observedAt: string | null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}


function resolveAdminKey(opts?: SalesDashboardClientOptions): string {
  return (
    opts?.adminKey !== undefined
      ? opts.adminKey
      : (process.env.SALES_DASHBOARD_ADMIN_KEY ?? "")
  ).trim();
}

function resolveBaseUrl(opts?: SalesDashboardClientOptions): string {
  return (opts?.baseUrl ?? process.env.SALES_DASHBOARD_BASE_URL ?? DEFAULT_SALES_DASHBOARD_URL)
    .trim()
    .replace(/\/+$/, "");
}

async function fetchSalesDashJson<T>(
  path: string,
  opts?: SalesDashboardClientOptions,
): Promise<T | null> {
  const adminKey = resolveAdminKey(opts);
  if (!adminKey) return null;

  const baseUrl = resolveBaseUrl(opts);
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      headers: {
        authorization: `Bearer ${adminKey}`,
        accept: "application/json",
        "user-agent": USER_AGENT,
      },
      redirect: "manual",
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function extractSummarySection<T>(
  summary: Record<string, unknown> | undefined,
  key: string,
): T | undefined {
  if (!summary) return undefined;
  const section = summary[key];
  if (!section || typeof section !== "object" || Array.isArray(section)) return undefined;
  const record = section as { status?: string; data?: T };
  if (record.status && record.status !== "LIVE") return undefined;
  if (record.data && typeof record.data === "object") return record.data;
  // Support both flat live sections (`{ status: "LIVE", spend: 6470, ... }`)
  // and already-unwrapped snapshot sections.
  return section as T;
}

function parseSnapshotEntry(
  raw: Record<string, unknown>,
  fallbackSlug: string,
  fallbackDisplayName: string,
  fallbackObservedAt: string,
): ParsedClientSnapshot | null {
  const summary =
    (raw.summary && typeof raw.summary === "object"
      ? (raw.summary as Record<string, unknown>)
      : raw.payload && typeof raw.payload === "object"
        ? ((raw.payload as Record<string, unknown>).summary as Record<string, unknown> | undefined)
        : raw.ghl || raw.meta || raw.cash || raw.calls || raw.ga4
          ? raw
          : undefined);
  if (!summary) return null;

  const slug = typeof raw.slug === "string" && raw.slug.trim() ? raw.slug.trim() : fallbackSlug;
  const displayName =
    typeof raw.displayName === "string" && raw.displayName.trim()
      ? raw.displayName.trim()
      : fallbackDisplayName;
  const observedAt =
    (typeof raw.syncedAt === "string" && raw.syncedAt) ||
    (typeof raw.lastSuccessfulSyncAt === "string" && raw.lastSuccessfulSyncAt) ||
    (typeof raw.generatedAt === "string" && raw.generatedAt) ||
    fallbackObservedAt;

  const meta = extractSummarySection<SnapshotMetaData>(summary, "meta");
  const zeroLeadDays7d =
    typeof raw.zeroLeadDays7d === "number" && Number.isFinite(raw.zeroLeadDays7d)
      ? raw.zeroLeadDays7d
      : null;
  const mergedMeta: SnapshotMetaData | undefined =
    meta || zeroLeadDays7d !== null
      ? {
          ...(meta ?? {}),
          ...(meta?.zeroLeadDays === undefined && zeroLeadDays7d !== null
            ? { zeroLeadDays: zeroLeadDays7d }
            : {}),
        }
      : undefined;

  const status = typeof raw.status === "string" && raw.status.trim() ? raw.status.trim() : undefined;
  const archived = typeof raw.archived === "boolean" ? raw.archived : undefined;

  return {
    slug,
    displayName,
    ...(status !== undefined ? { status } : {}),
    ...(archived !== undefined ? { archived } : {}),
    observedAt,
    ghl: extractSummarySection<SnapshotGhlData>(summary, "ghl"),
    meta: mergedMeta,
    cash: extractSummarySection<SnapshotCashData>(summary, "cash"),
    financials: extractSummarySection<SnapshotFinancialsData>(summary, "companyFinancials"),
  };
}

export async function fetchSalesCapital(
  period: DashboardPeriod = "30d",
  opts?: SalesDashboardClientOptions,
): Promise<CapitalApiPayload | null> {
  const body = await fetchSalesDashJson<{
    ok?: boolean;
    generatedAt?: string;
    view?: string;
    members?: Array<{ id?: string; status?: string }>;
    operating?: CapitalApiPayload["operating"];
    settings?: CapitalApiPayload["settings"];
    owner?: CapitalClientEntry;
    clients?: CapitalClientEntry[];
  }>(`/api/pilot/admin/capital?view=${encodeURIComponent(period)}`, opts);

  if (!body || body.ok === false) return null;
  if (!body.owner && !Array.isArray(body.clients) && !body.operating) return null;

  return {
    generatedAt: typeof body.generatedAt === "string" ? body.generatedAt : new Date().toISOString(),
    view: typeof body.view === "string" ? body.view : period,
    members: Array.isArray(body.members) ? body.members : [],
    operating: body.operating ?? null,
    settings: body.settings ?? null,
    owner: body.owner ?? null,
    clients: Array.isArray(body.clients) ? body.clients : [],
  };
}

function parseDeclaredPeriod(raw: unknown): DashboardPeriod | null {
  if (isDashboardPeriod(raw)) return raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const rec = raw as { period?: unknown; view?: unknown; days?: unknown };
    if (isDashboardPeriod(rec.period)) return rec.period;
    if (isDashboardPeriod(rec.view)) return rec.view;
    if (rec.days === 7) return "7d";
    if (rec.days === 30) return "30d";
  }
  return null;
}

export async function fetchSalesSnapshots(
  period: DashboardPeriod = "30d",
  opts?: SalesDashboardClientOptions,
): Promise<SnapshotsPayload | null> {
  // Primary: multi-client admin snapshots endpoint
  const rawMulti = await fetchSalesDashJson<{
    ok?: boolean;
    view?: string;
    generatedAt?: string;
    owner?: Record<string, unknown>;
    clients?: Array<Record<string, unknown>>;
    snapshots?: Array<Record<string, unknown>>;
  }>(`/api/pilot/admin/snapshots?view=${encodeURIComponent(period)}`, opts);

  if (rawMulti && rawMulti.ok !== false && (rawMulti.owner || rawMulti.clients || rawMulti.snapshots)) {
    const multiView = typeof rawMulti.view === "string" ? rawMulti.view.trim() : "";
    if (multiView && multiView !== period) {
      return null;
    }
    const observedAt =
      typeof rawMulti.generatedAt === "string" ? rawMulti.generatedAt : new Date().toISOString();
    const owner = rawMulti.owner
      ? parseSnapshotEntry(rawMulti.owner, "__owner__", "IR / HTL owner", observedAt)
      : null;
    const rawList = Array.isArray(rawMulti.clients)
      ? rawMulti.clients
      : Array.isArray(rawMulti.snapshots)
        ? rawMulti.snapshots
        : [];
    const clients: ParsedClientSnapshot[] = [];
    for (const item of rawList) {
      if (!item || typeof item !== "object") continue;
      const slug = typeof item.slug === "string" ? item.slug : "";
      const parsed = parseSnapshotEntry(
        item,
        slug || `client-${clients.length + 1}`,
        typeof item.displayName === "string" ? item.displayName : slug || "Client",
        observedAt,
      );
      if (parsed) {
        if (parsed.slug === "__owner__" && !owner) {
          clients.push(parsed);
        } else if (parsed.slug !== "__owner__") {
          clients.push(parsed);
        }
      }
    }
    return { observedAt, owner, clients };
  }

  // Graceful fallback: legacy single-tenant /api/pilot/dashboard?view=${period}
  const rawLegacy = await fetchSalesDashJson<Record<string, unknown>>(
    `/api/pilot/dashboard?view=${encodeURIComponent(period)}`,
    opts,
  );
  if (!rawLegacy) return null;
  const legacyView = typeof rawLegacy.view === "string" ? rawLegacy.view.trim() : "";
  if (legacyView && legacyView !== period) return null;
  const fallbackTs =
    (typeof rawLegacy.lastSuccessfulSyncAt === "string" && rawLegacy.lastSuccessfulSyncAt) ||
    (typeof rawLegacy.generatedAt === "string" && rawLegacy.generatedAt) ||
    new Date().toISOString();
  const owner = parseSnapshotEntry(rawLegacy, "__owner__", "IR / HTL owner", fallbackTs);
  if (!owner) return null;
  return { observedAt: owner.observedAt, owner, clients: [] };
}

export async function fetchNeonAdsAccounts(
  opts?: SalesDashboardClientOptions,
): Promise<NeonAdsAccountsPayload | null> {
  const body = await fetchSalesDashJson<{
    ok?: boolean;
    status?: string;
    generatedAt?: string;
    latestDataDay?: string | null;
    clients?: NeonAdsAccountClient[];
  }>("/api/pilot/neon-ads?view=accounts", opts);

  if (!body || body.status !== "LIVE" || !Array.isArray(body.clients)) return null;
  return {
    observedAt: typeof body.generatedAt === "string" ? body.generatedAt : new Date().toISOString(),
    latestDataDay: typeof body.latestDataDay === "string" ? body.latestDataDay : null,
    clients: body.clients,
  };
}

export async function fetchNeonAdsPipeline(
  opts?: SalesDashboardClientOptions,
): Promise<NeonAdsPipelinePayload | null> {
  const body = await fetchSalesDashJson<{
    ok?: boolean;
    status?: string;
    generatedAt?: string;
    period?: unknown;
    window?: unknown;
    clients?: NeonAdsPipelineClient[];
  }>("/api/pilot/neon-ads?view=pipeline", opts);

  if (!body || body.status !== "LIVE" || !Array.isArray(body.clients)) return null;
  const period = parseDeclaredPeriod(body.period) ?? parseDeclaredPeriod(body.window);
  return {
    observedAt: typeof body.generatedAt === "string" ? body.generatedAt : new Date().toISOString(),
    period,
    clients: body.clients,
  };
}

function normalizeRatePercent(raw: number | null | undefined): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (raw > 0 && raw <= 1) return round1(raw * 100);
  return round1(raw);
}

function latestIso(candidates: Array<string | null | undefined>): string | null {
  let bestMs = -1;
  let best: string | null = null;
  for (const ts of candidates) {
    if (!ts) continue;
    const ms = Date.parse(ts);
    if (Number.isFinite(ms) && ms > bestMs) {
      bestMs = ms;
      best = ts;
    }
  }
  return best;
}

function hasAnyClientMetric(client: MergedClientMetrics): boolean {
  return (
    client.newLeads !== null ||
    client.booked !== null ||
    client.showed !== null ||
    client.wonDeals !== null ||
    client.spend !== null ||
    client.cashCollectedUsd !== null ||
    client.pipelineRevenueUsd !== null
  );
}

type ClientMergeIndex = (rawSlug: string, displayName: string) => MergedClientMetrics;

function emptyClientMetrics(rawSlug: string, displayName: string): MergedClientMetrics {
  return {
    slug: rawSlug.trim(),
    displayName: displayName.trim() || rawSlug.trim(),
    observedAt: null,
    newLeads: null,
    booked: null,
    showed: null,
    pitched: null,
    wonDeals: null,
    showRate: null,
    closeRate: null,
    pipelineRevenueUsd: null,
    cashCollectedUsd: null,
    speedToLeadSeconds: null,
    spend: null,
    impressions: null,
    clicks: null,
    cpl: null,
    cac: null,
    roas: null,
    costPerHeldAppointment: null,
    zeroLeadDays: null,
  };
}

function createClientMergeIndex(bySlug: Map<string, MergedClientMetrics>): ClientMergeIndex {
  return (rawSlug, displayName) => {
    const key = rawSlug.trim().toLowerCase();
    const existing = bySlug.get(key);
    if (existing) {
      if (existing.displayName === existing.slug && displayName && displayName !== rawSlug) {
        existing.displayName = displayName;
      }
      return existing;
    }
    const created = emptyClientMetrics(rawSlug, displayName);
    bySlug.set(key, created);
    return created;
  };
}

function applySnapshotGhl(entry: MergedClientMetrics, ghl: SnapshotGhlData): void {
  entry.newLeads = finite(ghl.newLeads) ?? entry.newLeads;
  entry.booked = finite(ghl.appointmentsBooked) ?? entry.booked;
  entry.showed = finite(ghl.showedAppointments) ?? entry.showed;
  entry.pitched = finite(ghl.pitchedOpportunities) ?? entry.pitched;
  entry.wonDeals = finite(ghl.wonDeals) ?? entry.wonDeals;
  entry.showRate = normalizeRatePercent(ghl.showRate) ?? entry.showRate;
  entry.closeRate = normalizeRatePercent(ghl.closeRate) ?? entry.closeRate;
  entry.pipelineRevenueUsd = finite(ghl.pipelineWonUsd) ?? entry.pipelineRevenueUsd;
  entry.speedToLeadSeconds = finite(ghl.speedToLeadSeconds) ?? entry.speedToLeadSeconds;
}

function applySnapshotMeta(entry: MergedClientMetrics, meta: SnapshotMetaData): void {
  entry.spend = finite(meta.spend) ?? entry.spend;
  entry.impressions = finite(meta.impressions) ?? entry.impressions;
  entry.clicks = finite(meta.clicks) ?? entry.clicks;
  entry.zeroLeadDays = finite(meta.zeroLeadDays) ?? entry.zeroLeadDays;
}

/** Per-client full snapshots are the richest GHL + Meta source, so they seed the merge. */
function mergeSnapshots(ensure: ClientMergeIndex, snapshots: SnapshotsPayload | null): void {
  const snapshotEntries: ParsedClientSnapshot[] = [];
  if (snapshots?.clients) snapshotEntries.push(...snapshots.clients);
  if (snapshots?.owner) snapshotEntries.push(snapshots.owner);

  for (const snap of snapshotEntries) {
    const entry = ensure(snap.slug, snap.displayName);
    if (snap.status !== undefined && entry.status === undefined) entry.status = snap.status;
    if (snap.archived !== undefined && entry.archived === undefined) entry.archived = snap.archived;
    entry.observedAt = latestIso([entry.observedAt, snap.observedAt]);
    if (snap.ghl) applySnapshotGhl(entry, snap.ghl);
    if (snap.meta) applySnapshotMeta(entry, snap.meta);
    const cashUsd = finite(snap.financials?.cashCollectedUsd) ?? finite(snap.cash?.cashCollectedUsd);
    if (cashUsd !== null) entry.cashCollectedUsd = cashUsd;
  }
}

function mergeCapital(
  ensure: ClientMergeIndex,
  capital: CapitalApiPayload | null,
  period: DashboardPeriod,
): void {
  if (!capital || capital.view !== period) return;
  const capitalEntries: CapitalClientEntry[] = [];
  if (capital.clients) capitalEntries.push(...capital.clients);
  if (capital.owner) capitalEntries.push(capital.owner);

  for (const cap of capitalEntries) {
    const m = cap.marketing ?? {};
    const metricWindow = typeof m.window === "string" ? m.window.trim() : "";
    if (metricWindow && metricWindow !== period) continue;
    const entry = ensure(cap.slug, cap.displayName);
    if (cap.status !== undefined && entry.status === undefined) entry.status = cap.status;
    if (cap.archived !== undefined && entry.archived === undefined) entry.archived = cap.archived;
    entry.observedAt = latestIso([entry.observedAt, cap.syncedAt, capital.generatedAt]);
    entry.newLeads = entry.newLeads ?? finite(m.newLeads);
    entry.wonDeals = entry.wonDeals ?? finite(m.wonDeals);
    entry.spend = entry.spend ?? finite(m.adSpendUsd);
    entry.cpl = entry.cpl ?? finite(m.cplUsd);
    entry.cac = entry.cac ?? finite(m.cacUsd);
    entry.pipelineRevenueUsd = entry.pipelineRevenueUsd ?? finite(m.pipelineRevenueUsd);
    entry.cashCollectedUsd = entry.cashCollectedUsd ?? finite(m.cashCollectedUsd);
    entry.closeRate = entry.closeRate ?? normalizeRatePercent(m.closeRate);
  }
}

/** A zero from an earlier source is replaced when the Neon window reports a positive value. */
function preferPositiveWindowValue(current: number | null, windowValue: number | null): number | null {
  if (current === null || (current === 0 && (windowValue ?? 0) > 0)) {
    return finite(windowValue) ?? current;
  }
  return current;
}

function selectNeonAccountWindow(
  acct: NeonAdsAccountClient,
  period: DashboardPeriod,
): NeonAdsAccountClient["sevenDay"] | null {
  if (period === "7d") return acct.sevenDay;
  if (period === "30d") return acct.thirtyDay;
  return null;
}

function mergeNeonAccounts(
  ensure: ClientMergeIndex,
  neonAccounts: NeonAdsAccountsPayload | null,
  period: DashboardPeriod,
): void {
  if (!neonAccounts || (period !== "7d" && period !== "30d")) return;
  for (const acct of neonAccounts.clients) {
    const win = selectNeonAccountWindow(acct, period);
    if (!win) continue;
    const spend = finite(win.spend);
    const leads = finite(win.leads);
    const cpl = finite(win.cpl);
    if (spend === null && leads === null && cpl === null) continue;
    const entry = ensure(acct.clientId, acct.displayName);
    entry.observedAt = latestIso([entry.observedAt, neonAccounts.observedAt]);
    entry.spend = preferPositiveWindowValue(entry.spend, spend);
    entry.newLeads = preferPositiveWindowValue(entry.newLeads, leads);
    entry.cpl = entry.cpl ?? cpl;
  }
}

function mergeNeonPipeline(
  ensure: ClientMergeIndex,
  neonPipeline: NeonAdsPipelinePayload | null,
  period: DashboardPeriod,
): void {
  // Never fall back to unscoped or mismatched-period pipeline figures for a windowed dashboard.
  if (!neonPipeline || neonPipeline.period !== period) return;
  for (const pipe of neonPipeline.clients) {
    const entry = ensure(pipe.clientId, pipe.displayName);
    entry.observedAt = latestIso([entry.observedAt, neonPipeline.observedAt]);
    entry.spend = entry.spend ?? finite(pipe.spend);
    entry.newLeads = entry.newLeads ?? finite(pipe.crmLeads);
    entry.booked = entry.booked ?? finite(pipe.booked);
    entry.showed = entry.showed ?? finite(pipe.showed);
    entry.wonDeals = entry.wonDeals ?? finite(pipe.sold);
    entry.pipelineRevenueUsd = entry.pipelineRevenueUsd ?? finite(pipe.revenue);
    entry.cpl = entry.cpl ?? finite(pipe.costPerCrmLead);
    entry.cac = entry.cac ?? finite(pipe.costPerSold);
    entry.roas = entry.roas ?? finite(pipe.roas);
  }
}

/** Named clients sorted by spend desc then display name; `__owner__` always last. */
function compareMergedClients(a: MergedClientMetrics, b: MergedClientMetrics): number {
  if (a.slug === "__owner__" && b.slug !== "__owner__") return 1;
  if (b.slug === "__owner__" && a.slug !== "__owner__") return -1;
  const spendDiff = (b.spend ?? -1) - (a.spend ?? -1);
  if (spendDiff !== 0) return spendDiff;
  return a.displayName.localeCompare(b.displayName);
}

function resolveGatewayToken(opts?: SalesDashboardClientOptions): string {
  return (
    opts?.gatewayToken !== undefined
      ? opts.gatewayToken
      : (process.env.GATEWAY_PAPERCLIP_KEY ?? "")
  ).trim();
}

/**
 * Reads live client portfolio metrics directly from the OAuth Gateway when
 * `GATEWAY_PAPERCLIP_KEY` is configured (zero extra keys required), and falls
 * back to the legacy Sales Dashboard API only when `SALES_DASHBOARD_ADMIN_KEY`
 * is explicitly configured.
 *
 * Every client is keyed strictly by its canonical slug so two clients never collide.
 */
export async function readPortfolioSnapshotBundle(
  period: DashboardPeriod = "30d",
  opts?: SalesDashboardClientOptions,
): Promise<PortfolioSnapshotBundle> {
  const gatewayToken = resolveGatewayToken(opts);
  const adminKey = resolveAdminKey(opts);

  if (gatewayToken) {
    const gatewayBundle = await readGatewayFulfillmentBundle(period, {
      baseUrl: opts?.gatewayBaseUrl,
      token: gatewayToken,
      agencyCompanyId: opts?.agencyCompanyId,
      fetchImpl: opts?.fetchImpl,
      now: opts?.now,
      timeoutMs: opts?.timeoutMs,
      bypassCache: opts?.bypassCache,
    });
    if (gatewayBundle && gatewayBundle.clients.length > 0) {
      if (!adminKey) return gatewayBundle;
      const capital = await fetchSalesCapital(period, opts);
      return {
        ...gatewayBundle,
        capital,
      };
    }
  }

  if (!adminKey) {
    return {
      capital: null,
      snapshots: null,
      neonAccounts: null,
      neonPipeline: null,
      clients: [],
      observedAt: null,
    };
  }

  const supportsNeonAccounts = period === "7d" || period === "30d";
  const [capital, snapshots, neonAccounts, rawNeonPipeline] = await Promise.all([
    fetchSalesCapital(period, opts),
    fetchSalesSnapshots(period, opts),
    supportsNeonAccounts ? fetchNeonAdsAccounts(opts) : Promise.resolve(null),
    fetchNeonAdsPipeline(opts),
  ]);
  const neonPipeline =
    rawNeonPipeline && rawNeonPipeline.period === period ? rawNeonPipeline : null;

  const bySlug = new Map<string, MergedClientMetrics>();
  const ensure = createClientMergeIndex(bySlug);
  mergeSnapshots(ensure, snapshots);
  mergeCapital(ensure, capital, period);
  mergeNeonAccounts(ensure, neonAccounts, period);
  mergeNeonPipeline(ensure, neonPipeline, period);

  const clients: MergedClientMetrics[] = [];
  for (const entry of bySlug.values()) {
    if (!hasAnyClientMetric(entry)) continue;
    deriveClientRatios(entry);
    clients.push(entry);
  }
  clients.sort(compareMergedClients);

  const capitalMatchesPeriod = Boolean(capital && capital.view === period);
  const observedAt = latestIso([
    capitalMatchesPeriod ? capital?.generatedAt : null,
    snapshots?.observedAt,
    neonAccounts?.observedAt,
    neonPipeline?.observedAt,
    ...clients.map((c) => c.observedAt),
  ]);

  return {
    capital,
    snapshots,
    neonAccounts,
    neonPipeline,
    clients,
    observedAt,
  };
}
