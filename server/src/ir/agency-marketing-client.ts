import { createHash } from "node:crypto";
import type { DashboardPeriod } from "@paperclipai/shared";

export type AgencyAccountStatus = "live" | "needs_config" | "error";

export interface AgencyMetaAccountMetrics {
  id: string;
  displayName: string;
  adAccountId: string | null;
  status: AgencyAccountStatus;
  statusLabel: string;
  observedAt: string | null;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  linkClicks: number | null;
  leads: number | null;
  ctr: number | null;
  cpl: number | null;
  zeroLeadDays: number | null;
}

export interface AgencyMarketingSummary {
  period: DashboardPeriod;
  since: string;
  until: string;
  observedAt: string;
  liveAccountCount: number;
  totalAccountCount: number;
  hasMeta: boolean;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  linkClicks: number | null;
  leads: number | null;
  ctr: number | null;
  cpl: number | null;
  zeroLeadDays: number | null;
  accounts: AgencyMetaAccountMetrics[];
}

export interface AgencyMarketingClientOptions {
  baseUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  bypassCache?: boolean;
  accountIds?: Partial<Record<"increaseRoas" | "alexBloomfield" | "hotTubLaunch", string | null>>;
}

interface AgencyMetaAccountSpec {
  id: string;
  key: "increaseRoas" | "alexBloomfield" | "hotTubLaunch";
  displayName: string;
  envVar: string;
  defaultAccountId: string;
}

interface RawMetaAction {
  action_type?: string;
  value?: string | number;
}

interface RawMetaInsightRow {
  spend?: string | number;
  impressions?: string | number;
  clicks?: string | number;
  actions?: RawMetaAction[];
  date_start?: string;
  date_stop?: string;
}

const DEFAULT_GATEWAY_URL = "https://increase-roas-oauth-gateway.increase-roas.workers.dev";
const DEFAULT_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 5 * 60 * 1_000;
const MAX_INSIGHT_PAGES = 3;
const USER_AGENT = "paperclip-server/1.0";
const ACCOUNT_ID_RE = /^(?:act_)?(\d{3,30})$/;
const UNSET_SENTINELS = new Set(["none", "unset", "unconfigured", "null"]);

/**
 * Canonical Increase ROAS B2B acquisition Meta ad accounts.
 * Confirmed by Alex (2026-11-26) and verified live via OAuth Gateway `/api/meta/adaccounts`.
 * Strictly agency acquisition ONLY — client ad accounts live on Fulfillment.
 */
export const AGENCY_META_ACCOUNTS: readonly AgencyMetaAccountSpec[] = [
  {
    id: "increase-roas-b2b",
    key: "increaseRoas",
    displayName: "Increase ROAS B2B",
    envVar: "META_AGENCY_INCREASE_ROAS_ACCOUNT_ID",
    defaultAccountId: "act_1751702711685898",
  },
  {
    id: "alex-bloomfield-ssa",
    key: "alexBloomfield",
    displayName: "Alex Bloomfield (Start Scale Automate)",
    envVar: "META_AGENCY_ALEX_BLOOMFIELD_ACCOUNT_ID",
    defaultAccountId: "act_735997837915750",
  },
  {
    id: "hot-tub-launch",
    key: "hotTubLaunch",
    displayName: "Hot Tub Launch",
    envVar: "META_AGENCY_HOT_TUB_LAUNCH_ACCOUNT_ID",
    defaultAccountId: "act_931652032962948",
  },
];

/** Priority order avoids double-counting overlapping Meta lead pixel action types. */
const LEAD_ACTION_PRIORITY = [
  "lead",
  "onsite_web_lead",
  "offsite_conversion.fb_pixel_lead",
  "omni_lead",
  "onsite_conversion.lead_grouped",
] as const;

const MAX_MARKETING_CACHE_ENTRIES = 64;
const cache = new Map<string, { at: number; value: AgencyMarketingSummary }>();

export function resetAgencyMarketingCache(): void {
  cache.clear();
}

function writeMarketingCache(key: string, nowMs: number, value: AgencyMarketingSummary): void {
  cache.delete(key);
  cache.set(key, { at: nowMs, value });
  for (const [k, entry] of cache) {
    if (nowMs < entry.at || nowMs - entry.at >= CACHE_TTL_MS || cache.size > MAX_MARKETING_CACHE_ENTRIES) {
      if (k !== key) cache.delete(k);
    }
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatDayUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function agencyMetaPeriodRange(
  period: DashboardPeriod,
  now: Date,
): { since: string; until: string } {
  const until = formatDayUtc(now);
  if (period === "month") {
    return {
      since: formatDayUtc(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))),
      until,
    };
  }
  const days = period === "7d" ? 7 : 30;
  return {
    since: formatDayUtc(new Date(now.getTime() - days * 24 * 60 * 60 * 1000)),
    until,
  };
}

function normalizeMetaAccountId(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (!trimmed || UNSET_SENTINELS.has(trimmed.toLowerCase())) return null;
  const match = trimmed.match(ACCOUNT_ID_RE);
  if (!match) return null;
  return `act_${match[1]}`;
}

function resolveAccountId(
  spec: AgencyMetaAccountSpec,
  opts: AgencyMarketingClientOptions,
): string | null {
  if (opts.accountIds && Object.prototype.hasOwnProperty.call(opts.accountIds, spec.key)) {
    return normalizeMetaAccountId(opts.accountIds[spec.key]);
  }
  const fromEnv = process.env[spec.envVar];
  if (fromEnv !== undefined) {
    return normalizeMetaAccountId(fromEnv);
  }
  return spec.defaultAccountId;
}

function parseNonNegativeFloat(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function parseNonNegativeInt(raw: unknown): number {
  return Math.round(parseNonNegativeFloat(raw));
}

function extractActionValue(actions: readonly RawMetaAction[] | undefined, actionType: string): number | null {
  if (!Array.isArray(actions)) return null;
  let total = 0;
  let found = false;
  for (const item of actions) {
    if (item?.action_type === actionType) {
      total += parseNonNegativeFloat(item.value);
      found = true;
    }
  }
  return found ? Math.round(total) : null;
}

function extractRowLeads(actions: readonly RawMetaAction[] | undefined): number {
  for (const actionType of LEAD_ACTION_PRIORITY) {
    const val = extractActionValue(actions, actionType);
    if (val !== null) return val;
  }
  return 0;
}

function isWithinLast7Days(dayStr: string | undefined, now: Date): boolean {
  if (!dayStr || !/^\d{4}-\d{2}-\d{2}$/.test(dayStr)) return false;
  const cutoff = formatDayUtc(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000));
  return dayStr >= cutoff;
}

function needsConfigAccount(spec: AgencyMetaAccountSpec, adAccountId: string | null): AgencyMetaAccountMetrics {
  return {
    id: spec.id,
    displayName: spec.displayName,
    adAccountId,
    status: "needs_config",
    statusLabel: "Needs account ID / key",
    observedAt: null,
    spend: null,
    impressions: null,
    clicks: null,
    linkClicks: null,
    leads: null,
    ctr: null,
    cpl: null,
    zeroLeadDays: null,
  };
}

function errorAccount(spec: AgencyMetaAccountSpec, adAccountId: string): AgencyMetaAccountMetrics {
  return {
    id: spec.id,
    displayName: spec.displayName,
    adAccountId,
    status: "error",
    statusLabel: "Temporarily unreachable",
    observedAt: null,
    spend: null,
    impressions: null,
    clicks: null,
    linkClicks: null,
    leads: null,
    ctr: null,
    cpl: null,
    zeroLeadDays: null,
  };
}

async function fetchGatewayInsightsPage(
  url: string,
  token: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ status: number; data: RawMetaInsightRow[]; next: string | null }> {
  try {
    const res = await fetchImpl(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "user-agent": USER_AGENT,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { status: res.status, data: [], next: null };
    const body = (await res.json()) as { data?: unknown; next?: unknown };
    const rows = Array.isArray(body?.data) ? (body.data as RawMetaInsightRow[]) : [];
    const next = typeof body?.next === "string" && body.next ? body.next : null;
    return { status: res.status, data: rows, next };
  } catch {
    return { status: 0, data: [], next: null };
  }
}

async function readSingleAgencyMetaAccount(
  spec: AgencyMetaAccountSpec,
  adAccountId: string | null,
  range: { since: string; until: string },
  ctx: { baseUrl: string; token: string; fetchImpl: typeof fetch; timeoutMs: number; now: Date; observedAt: string },
): Promise<AgencyMetaAccountMetrics> {
  if (!adAccountId) return needsConfigAccount(spec, null);

  const rows: RawMetaInsightRow[] = [];
  let after: string | null = null;
  let truncated = false;
  for (let page = 0; page < MAX_INSIGHT_PAGES; page += 1) {
    const qs = new URLSearchParams({
      adAccountId,
      level: "account",
      daily: "1",
      since: range.since,
      until: range.until,
    });
    if (after) qs.set("after", after);
    const res = await fetchGatewayInsightsPage(
      `${ctx.baseUrl}/api/meta/insights?${qs.toString()}`,
      ctx.token,
      ctx.fetchImpl,
      ctx.timeoutMs,
    );
    if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404) {
      return needsConfigAccount(spec, adAccountId);
    }
    if (res.status !== 200) {
      return errorAccount(spec, adAccountId);
    }
    rows.push(...res.data);
    if (!res.next || res.next === after) break;
    if (page === MAX_INSIGHT_PAGES - 1) {
      truncated = true;
      break;
    }
    after = res.next;
  }

  let spend = 0;
  let impressions = 0;
  let clicks = 0;
  let linkClicks = 0;
  let leads = 0;
  let zeroLeadDays = 0;

  for (const row of rows) {
    const rowSpend = parseNonNegativeFloat(row.spend);
    const rowImpressions = parseNonNegativeInt(row.impressions);
    const rowClicks = parseNonNegativeInt(row.clicks);
    const rowLinkClicks = Array.isArray(row.actions)
      ? (extractActionValue(row.actions, "link_click") ?? 0)
      : rowClicks;
    const rowLeads = extractRowLeads(row.actions);

    spend += rowSpend;
    impressions += rowImpressions;
    clicks += rowClicks;
    linkClicks += rowLinkClicks;
    leads += rowLeads;

    if (isWithinLast7Days(row.date_start, ctx.now) && rowSpend > 100 && rowLeads === 0) {
      zeroLeadDays += 1;
    }
  }

  const roundedSpend = round2(spend);
  const ctr = impressions > 0 ? round2((linkClicks / impressions) * 100) : null;
  const cpl = leads > 0 ? round2(roundedSpend / leads) : null;

  return {
    id: spec.id,
    displayName: spec.displayName,
    adAccountId,
    status: "live",
    statusLabel: truncated ? "Live (partial)" : roundedSpend > 0 || leads > 0 ? "Live" : "Live · $0 spend",
    observedAt: ctx.observedAt,
    spend: roundedSpend,
    impressions,
    clicks,
    linkClicks,
    leads,
    ctr,
    cpl,
    zeroLeadDays,
  };
}

function summarizeAgencyMeta(
  period: DashboardPeriod,
  range: { since: string; until: string },
  observedAt: string,
  accounts: AgencyMetaAccountMetrics[],
): AgencyMarketingSummary {
  const liveAccounts = accounts.filter((a) => a.status === "live");
  const hasDegraded = accounts.some((a) => a.status === "error" || a.statusLabel === "Live (partial)");
  if (liveAccounts.length === 0 || hasDegraded) {
    return {
      period,
      since: range.since,
      until: range.until,
      observedAt,
      liveAccountCount: liveAccounts.length,
      totalAccountCount: accounts.length,
      hasMeta: liveAccounts.length > 0,
      spend: null,
      impressions: null,
      clicks: null,
      linkClicks: null,
      leads: null,
      ctr: null,
      cpl: null,
      zeroLeadDays: null,
      accounts,
    };
  }

  let spend = 0;
  let impressions = 0;
  let clicks = 0;
  let linkClicks = 0;
  let leads = 0;
  let zeroLeadDays = 0;
  for (const acct of liveAccounts) {
    spend += acct.spend ?? 0;
    impressions += acct.impressions ?? 0;
    clicks += acct.clicks ?? 0;
    linkClicks += acct.linkClicks ?? 0;
    leads += acct.leads ?? 0;
    zeroLeadDays += acct.zeroLeadDays ?? 0;
  }

  const roundedSpend = round2(spend);
  return {
    period,
    since: range.since,
    until: range.until,
    observedAt,
    liveAccountCount: liveAccounts.length,
    totalAccountCount: accounts.length,
    hasMeta: true,
    spend: roundedSpend,
    impressions,
    clicks,
    linkClicks,
    leads,
    ctr: impressions > 0 ? round2((linkClicks / impressions) * 100) : null,
    cpl: leads > 0 ? round2(roundedSpend / leads) : null,
    zeroLeadDays,
    accounts,
  };
}

/**
 * Reads Increase ROAS's own 3 B2B acquisition Meta ad accounts through the OAuth Gateway.
 * Fails closed to `null` when no Gateway token is configured.
 */
export async function readAgencyMarketingSummary(
  period: DashboardPeriod = "30d",
  opts: AgencyMarketingClientOptions = {},
): Promise<AgencyMarketingSummary | null> {
  const token = (
    opts.token !== undefined
      ? opts.token
      : (process.env.GATEWAY_PAPERCLIP_KEY ?? process.env.GATEWAY_META_KEY ?? "")
  ).trim();
  if (!token) return null;

  const baseUrl = (opts.baseUrl ?? process.env.OAUTH_GATEWAY_URL ?? DEFAULT_GATEWAY_URL)
    .trim()
    .replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = (opts.now ?? (() => new Date()))();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const resolvedIds = AGENCY_META_ACCOUNTS.map((spec) => resolveAccountId(spec, opts));
  const tokenFp = createHash("sha256").update(token).digest("hex").slice(0, 16);
  const cacheKey = `${baseUrl}|${period}|${tokenFp}|${resolvedIds.join(",")}`;

  if (!opts.bypassCache) {
    const hit = cache.get(cacheKey);
    if (hit) {
      const age = now.getTime() - hit.at;
      if (age >= 0 && age < CACHE_TTL_MS) {
        return hit.value;
      }
    }
  }

  const range = agencyMetaPeriodRange(period, now);
  const observedAt = now.toISOString();
  const ctx = { baseUrl, token, fetchImpl, timeoutMs, now, observedAt };

  const accounts = await Promise.all(
    AGENCY_META_ACCOUNTS.map((spec, idx) => readSingleAgencyMetaAccount(spec, resolvedIds[idx] ?? null, range, ctx)),
  );
  const summary = summarizeAgencyMeta(period, range, observedAt, accounts);

  // Never negative-cache when 0 accounts succeeded or any account hit a transient error or truncation.
  const hasDegradedAccount = summary.accounts.some(
    (a) => a.status === "error" || a.statusLabel === "Live (partial)",
  );
  if (summary.liveAccountCount > 0 && !hasDegradedAccount && !opts.bypassCache) {
    writeMarketingCache(cacheKey, now.getTime(), summary);
  }
  return summary;
}
