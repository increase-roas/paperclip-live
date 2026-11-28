import {
  bookedCounts,
  countShowed,
  type AppointmentRecord,
} from "@paperclipai/shared/ir-metrics";
import { createHash } from "node:crypto";
import type { DashboardPeriod } from "@paperclipai/shared";
import {
  AGENCY_META_ACCOUNTS,
  agencyMetaPeriodRange,
  extractActionValue,
  extractRowLeads,
  isWithinLast7Days,
  normalizeMetaAccountId,
  type RawMetaInsightRow,
} from "./agency-marketing-client.js";
import {
  cleanClientDisplayName,
  deriveClientRatios,
  filterClientOnlyPortfolio,
  isExcludedClientSlug,
  slugifyClientName,
} from "./portfolio-filter.js";
import type {
  MergedClientMetrics,
  PortfolioSnapshotBundle,
} from "./sales-dashboard-client.js";

export interface GatewayFulfillmentClientOptions {
  baseUrl?: string;
  token?: string;
  agencyCompanyId?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  bypassCache?: boolean;
  excludedMetaAccountIds?: readonly string[];
  excludedGhlLocationIds?: readonly string[];
  excludedClientSlugs?: readonly string[];
}

interface RawMetaAdAccount {
  id?: string;
  name?: string;
  account_status?: number;
}

export interface GatewayHealthLocation {
  locationId: string;
  name: string;
  checkedAt?: string | null;
  leads7d: number | null;
  leads30d: number | null;
}

interface RawGhlPipeline {
  id?: string;
  name?: string;
}

interface RawGhlOpportunity {
  id?: string;
  pipelineId?: string;
  status?: string;
  monetaryValue?: number | string;
  createdAt?: string;
  updatedAt?: string;
  lastStatusChangeAt?: string;
}

interface RawGhlCalendar {
  id?: string;
  name?: string;
}

interface RawGhlCalendarEvent {
  startTime?: string | number;
  appointmentStatus?: string;
  status?: string;
  contactId?: string;
}

interface MetaClientInsightRead {
  adAccountId: string;
  rawName: string;
  displayName: string;
  slug: string;
  ok: boolean;
  spend: number;
  impressions: number;
  clicks: number;
  metaLeads: number;
  zeroLeadDays: number;
}

interface ClientGhlEnrichment {
  booked: number | null;
  showed: number | null;
  wonDeals: number | null;
  pipelineRevenueUsd: number | null;
}

interface PeriodWindow {
  startMs: number;
  endMs: number;
}

const DEFAULT_GATEWAY_URL = "https://increase-roas-oauth-gateway.increase-roas.workers.dev";
const DEFAULT_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 5 * 60 * 1_000;
const MAX_CACHE_ENTRIES = 32;
const MAX_ADACCOUNT_PAGES = 5;
const MAX_INSIGHT_PAGES = 3;
const MAX_WON_OPP_PAGES = 2;
const MAX_CALENDARS_PER_CLIENT = 5;
const META_CONCURRENCY = 10;
const GHL_CONCURRENCY = 6;
const USER_AGENT = "paperclip-server/1.0";
const LOCATION_ID_RE = /^[A-Za-z0-9_-]{6,128}$/;
const UNSET_SENTINELS = new Set(["none", "unset", "unconfigured", "null"]);
const RECRUITING_RE = /\b(applicant|applicants|hiring|recruit(?:ing|ment)?|candidate|interview|careers?|job\s+application)\b/i;
const PLACEHOLDER_LOCATION_RE = /^(?:clean\s+account\b|delete\b|garbage\s+bin\b|ai\s+agent\s+test\b|.*\bdemo\s+ai\s+account\b)/i;

const GENERIC_MATCH_TOKENS = new Set([
  "the",
  "and",
  "of",
  "tree",
  "trees",
  "service",
  "services",
  "care",
  "landscaping",
  "landscape",
  "spa",
  "spas",
  "pool",
  "hot",
  "tub",
  "land",
  "management",
  "removal",
  "dumpster",
  "north",
  "dakota",
  "michigan",
  "mi",
  "fl",
  "tx",
  "main",
  "new",
]);

const cache = new Map<string, { at: number; value: PortfolioSnapshotBundle }>();
const inFlight = new Map<string, Promise<PortfolioSnapshotBundle | null>>();

export function resetGatewayFulfillmentCache(): void {
  cache.clear();
  inFlight.clear();
}

function writeCache(key: string, at: number, value: PortfolioSnapshotBundle): void {
  for (const [k, entry] of cache.entries()) {
    const age = at - entry.at;
    if (age < 0 || age >= CACHE_TTL_MS) cache.delete(k);
  }
  cache.delete(key);
  cache.set(key, { at, value });
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseNonNegativeFloat(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function parseNonNegativeInt(raw: unknown): number {
  return Math.round(parseNonNegativeFloat(raw));
}

function finiteNonNegative(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : null;
}

function normalizeLocationId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || UNSET_SENTINELS.has(trimmed.toLowerCase())) return null;
  return LOCATION_ID_RE.test(trimmed) ? trimmed : null;
}

function splitEnvCsv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveExcludedMetaIds(opts: GatewayFulfillmentClientOptions): Set<string> {
  const ids = new Set<string>();
  const rawValues: Array<string | undefined> = [
    ...AGENCY_META_ACCOUNTS.map((spec) => process.env[spec.envVar]),
    ...splitEnvCsv(process.env.FULFILLMENT_EXCLUDED_META_ACCOUNT_IDS),
    ...(opts.excludedMetaAccountIds ?? []),
  ];
  for (const raw of rawValues) {
    const normalized = normalizeMetaAccountId(raw);
    if (normalized) ids.add(normalized);
  }
  return ids;
}

function resolveExcludedGhlLocationIds(opts: GatewayFulfillmentClientOptions): Set<string> {
  const ids = new Set<string>();
  const rawValues: Array<string | undefined> = [
    process.env.GHL_AGENCY_INCREASE_ROAS_LOCATION_ID,
    process.env.GHL_AGENCY_HOT_TUB_LAUNCH_LOCATION_ID,
    process.env.GHL_ALEX_BLOOMFIELD_LOCATION_ID,
    ...splitEnvCsv(process.env.FULFILLMENT_EXCLUDED_GHL_LOCATION_IDS),
    ...(opts.excludedGhlLocationIds ?? []),
  ];
  for (const raw of rawValues) {
    const normalized = normalizeLocationId(raw);
    if (normalized) ids.add(normalized);
  }
  return ids;
}

function buildPeriodWindow(period: DashboardPeriod, now: Date): PeriodWindow {
  const endMs = now.getTime();
  const startDate =
    period === "month"
      ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
      : new Date(endMs - (period === "7d" ? 7 : 30) * 24 * 60 * 60 * 1000);
  return { startMs: startDate.getTime(), endMs };
}

function isTimestampInWindow(raw: string | undefined, win: PeriodWindow): boolean {
  if (!raw) return false;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) && ms >= win.startMs && ms <= win.endMs;
}

async function fetchGatewayJson(
  url: string,
  token: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const init: RequestInit = {
    headers: { authorization: `Bearer ${token}`, accept: "application/json", "user-agent": USER_AGENT },
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  };
  try {
    const res = await fetchImpl(url, init);
    if (!res.ok) return { status: res.status, body: null };
    const parsed: unknown = await res.json();
    return { status: res.status, body: isRecord(parsed) ? parsed : null };
  } catch {
    return { status: 0, body: null };
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const count = Math.min(concurrency, items.length);
  const runners = Array.from({ length: count }, async () => {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      results[idx] = await worker(items[idx]!);
    }
  });
  await Promise.all(runners);
  return results;
}

async function fetchAllMetaAdAccounts(
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ ok: boolean; accounts: RawMetaAdAccount[] }> {
  const accounts: RawMetaAdAccount[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_ADACCOUNT_PAGES; page += 1) {
    const qs = after ? `?after=${encodeURIComponent(after)}` : "";
    const res = await fetchGatewayJson(
      `${baseUrl}/api/meta/adaccounts${qs}`,
      token,
      fetchImpl,
      timeoutMs,
    );
    if (res.status !== 200 || !res.body || !Array.isArray(res.body.data)) {
      return { ok: false, accounts: [] };
    }
    for (const item of res.body.data) {
      if (isRecord(item)) accounts.push(item as RawMetaAdAccount);
    }
    const next = typeof res.body.next === "string" && res.body.next ? res.body.next : null;
    if (!next || next === after) break;
    if (page === MAX_ADACCOUNT_PAGES - 1) return { ok: false, accounts: [] };
    after = next;
  }
  return { ok: true, accounts };
}

async function fetchGatewayHealthLocations(
  baseUrl: string,
  token: string,
  excludedGhlIds: ReadonlySet<string>,
  excludedSlugs: readonly string[] | undefined,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<GatewayHealthLocation[]> {
  const res = await fetchGatewayJson(
    `${baseUrl}/api/health`,
    token,
    fetchImpl,
    timeoutMs,
  );
  if (res.status !== 200 || !res.body || !Array.isArray(res.body.locations)) return [];

  const locations: GatewayHealthLocation[] = [];
  for (const raw of res.body.locations) {
    if (!isRecord(raw)) continue;
    const locationId = normalizeLocationId(typeof raw.locationId === "string" ? raw.locationId : null);
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!locationId || !name) continue;
    if (excludedGhlIds.has(locationId)) continue;
    if (PLACEHOLDER_LOCATION_RE.test(name)) continue;
    const slug = slugifyClientName(name);
    if (slug && isExcludedClientSlug(slug, excludedSlugs)) continue;
    const metrics = isRecord(raw.metrics) ? raw.metrics : null;
    locations.push({
      locationId,
      name,
      checkedAt: typeof raw.checkedAt === "string" ? raw.checkedAt : null,
      leads7d: finiteNonNegative(metrics?.leads7d),
      leads30d: finiteNonNegative(metrics?.leads30d),
    });
  }
  return locations;
}

async function resolveAgencyCompanyId(
  opts: GatewayFulfillmentClientOptions,
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<string> {
  const explicit = (opts.agencyCompanyId ?? process.env.GHL_AGENCY_COMPANY_ID ?? "").trim();
  if (explicit) return explicit;
  const statusRes = await fetchGatewayJson(`${baseUrl}/api/status`, token, fetchImpl, timeoutMs);
  if (statusRes.status === 200 && statusRes.body && typeof statusRes.body.companyId === "string") {
    return statusRes.body.companyId.trim();
  }
  return "";
}

async function readClientMetaInsights(
  adAccountId: string,
  rawName: string,
  range: { since: string; until: string },
  ctx: { baseUrl: string; token: string; fetchImpl: typeof fetch; timeoutMs: number; now: Date },
): Promise<MetaClientInsightRead> {
  const displayName = cleanClientDisplayName(rawName) || adAccountId;
  const slug = slugifyClientName(displayName) || adAccountId.toLowerCase();
  const rows: RawMetaInsightRow[] = [];
  let after: string | null = null;

  for (let page = 0; page < MAX_INSIGHT_PAGES; page += 1) {
    const qs = new URLSearchParams({
      adAccountId,
      level: "account",
      daily: "1",
      since: range.since,
      until: range.until,
    });
    if (after) qs.set("after", after);
    const insightUrl = `${ctx.baseUrl}/api/meta/insights?${qs.toString()}`;
    let res = await fetchGatewayJson(insightUrl, ctx.token, ctx.fetchImpl, ctx.timeoutMs);
    if (res.status === 0 || res.status >= 500) {
      res = await fetchGatewayJson(insightUrl, ctx.token, ctx.fetchImpl, ctx.timeoutMs);
    }
    if (res.status !== 200 || !res.body || !Array.isArray(res.body.data)) {
      return {
        adAccountId,
        rawName,
        displayName,
        slug,
        ok: false,
        spend: 0,
        impressions: 0,
        clicks: 0,
        metaLeads: 0,
        zeroLeadDays: 0,
      };
    }
    rows.push(...(res.body.data as RawMetaInsightRow[]));
    const next = typeof res.body.next === "string" && res.body.next ? res.body.next : null;
    if (!next || next === after) break;
    if (page === MAX_INSIGHT_PAGES - 1) {
      return {
        adAccountId,
        rawName,
        displayName,
        slug,
        ok: false,
        spend: 0,
        impressions: 0,
        clicks: 0,
        metaLeads: 0,
        zeroLeadDays: 0,
      };
    }
    after = next;
  }

  let spend = 0;
  let impressions = 0;
  let clicks = 0;
  let metaLeads = 0;
  let zeroLeadDays = 0;

  for (const row of rows) {
    const rowSpend = parseNonNegativeFloat(row.spend);
    const rowImpressions = parseNonNegativeInt(row.impressions);
    const rowClicks = Array.isArray(row.actions)
      ? (extractActionValue(row.actions, "link_click") ?? 0)
      : parseNonNegativeInt(row.clicks);
    const rowLeads = extractRowLeads(row.actions);

    spend += rowSpend;
    impressions += rowImpressions;
    clicks += rowClicks;
    metaLeads += rowLeads;

    if (isWithinLast7Days(row.date_start, ctx.now) && rowSpend > 100 && rowLeads === 0) {
      zeroLeadDays += 1;
    }
  }

  return {
    adAccountId,
    rawName,
    displayName,
    slug,
    ok: true,
    spend: round2(spend),
    impressions,
    clicks,
    metaLeads,
    zeroLeadDays,
  };
}

function normalizeForMatch(raw: string): string {
  return cleanClientDisplayName(raw)
    .toLowerCase()
    .replace(/\b([a-z])\s*&\s*([a-z])\b/g, "$1$2")
    .replace(/\bl\s+l\s+c\b/g, " ")
    .replace(/\b(llc|inc|corp|company|co|supply|north dakota|michigan|mi|fl|tx|main|new)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function distinctiveTokens(normalized: string): Set<string> {
  return new Set(
    normalized
      .split(" ")
      .filter((token) => token.length >= 2 && !GENERIC_MATCH_TOKENS.has(token)),
  );
}

export function matchGhlHealthLocation(
  clientName: string,
  locations: readonly GatewayHealthLocation[],
  usedLocationIds: ReadonlySet<string> = new Set(),
): GatewayHealthLocation | null {
  const targetNorm = normalizeForMatch(clientName);
  if (!targetNorm) return null;
  const targetTokens = distinctiveTokens(targetNorm);

  let best: GatewayHealthLocation | null = null;
  let bestScore = 0;

  for (const loc of locations) {
    if (usedLocationIds.has(loc.locationId)) continue;
    const locNorm = normalizeForMatch(loc.name);
    if (!locNorm) continue;

    let score = 0;
    if (targetNorm === locNorm) {
      score = 100;
    } else if (
      (targetNorm.includes(locNorm) && (locNorm.includes(" ") || locNorm.length >= 5)) ||
      (locNorm.includes(targetNorm) && (targetNorm.includes(" ") || targetNorm.length >= 5))
    ) {
      score = 85;
    } else if (targetTokens.size > 0) {
      const locTokens = distinctiveTokens(locNorm);
      if (locTokens.size > 0) {
        let overlap = 0;
        for (const tok of targetTokens) {
          if (locTokens.has(tok)) overlap += 1;
        }
        if (overlap > 0) {
          const denom = Math.max(targetTokens.size, locTokens.size);
          score = Math.floor((75 * overlap) / denom);
        }
      }
    }

    if (score < 65) continue;
    const locActivity = loc.leads30d ?? -1;
    const bestActivity = best?.leads30d ?? -1;
    if (score > bestScore || (score === bestScore && locActivity > bestActivity)) {
      bestScore = score;
      best = loc;
    }
  }

  return best;
}

function extractGhlNextCursor(body: Record<string, unknown>): {
  nextId: string | null;
  nextAfter: string | null;
} {
  const meta = isRecord(body.meta) ? body.meta : null;
  const nextId = typeof meta?.startAfterId === "string" && meta.startAfterId ? meta.startAfterId : null;
  const nextAfter =
    meta?.startAfter !== null && meta?.startAfter !== undefined && String(meta.startAfter) !== ""
      ? String(meta.startAfter)
      : null;
  return { nextId, nextAfter };
}

async function readClientGhlMetrics(
  locationId: string,
  companyId: string,
  win: PeriodWindow,
  ctx: { baseUrl: string; token: string; fetchImpl: typeof fetch; timeoutMs: number },
): Promise<ClientGhlEnrichment> {
  const fetchLoc = (ghlPath: string) =>
    fetchGatewayJson(
      `${ctx.baseUrl}/api/location/${encodeURIComponent(locationId)}/readonly` +
        `?companyId=${encodeURIComponent(companyId)}&path=${encodeURIComponent(ghlPath)}`,
      ctx.token,
      ctx.fetchImpl,
      ctx.timeoutMs,
    );

  const [pipelinesRes, calListRes, wonRead] = await Promise.all([
    fetchLoc("/opportunities/pipelines"),
    fetchLoc("/calendars/"),
    (async () => {
      const opportunities: RawGhlOpportunity[] = [];
      let startAfterId: string | null = null;
      let startAfter: string | null = null;
      let truncated = false;
      for (let page = 0; page < MAX_WON_OPP_PAGES; page += 1) {
        const qs = new URLSearchParams({ limit: "100", status: "won" });
        if (startAfterId) qs.set("startAfterId", startAfterId);
        if (startAfter) qs.set("startAfter", startAfter);
        const res = await fetchLoc(`/opportunities/search?${qs.toString()}`);
        if (res.status !== 200 || !res.body) return { ok: false, opportunities: [], truncated: false };
        const list = Array.isArray(res.body.opportunities)
          ? (res.body.opportunities as RawGhlOpportunity[])
          : [];
        opportunities.push(...list);
        if (list.length < 100) break;
        const cursor = extractGhlNextCursor(res.body);
        if (!cursor.nextId || cursor.nextId === startAfterId) break;
        if (page === MAX_WON_OPP_PAGES - 1) {
          truncated = true;
          break;
        }
        startAfterId = cursor.nextId;
        startAfter = cursor.nextAfter;
      }
      return { ok: true, opportunities, truncated };
    })(),
  ]);

  let wonDeals: number | null = null;
  let pipelineRevenueUsd: number | null = null;
  const pipelinesOk =
    pipelinesRes.status === 200 &&
    pipelinesRes.body !== null &&
    Array.isArray(pipelinesRes.body.pipelines);
  if (pipelinesOk && wonRead.ok && !wonRead.truncated) {
    const excludedPipelineIds = new Set<string>();
    for (const pipe of pipelinesRes.body!.pipelines as RawGhlPipeline[]) {
      if (pipe.id && RECRUITING_RE.test(pipe.name ?? "")) excludedPipelineIds.add(pipe.id);
    }
    const seen = new Set<string>();
    let won = 0;
    let rev = 0;
    for (const opp of wonRead.opportunities) {
      if (opp.id) {
        if (seen.has(opp.id)) continue;
        seen.add(opp.id);
      }
      if (opp.pipelineId && excludedPipelineIds.has(opp.pipelineId)) continue;
      const st = String(opp.status ?? "").trim().toLowerCase();
      if (st && st !== "won") continue;
      const statusTs = opp.lastStatusChangeAt ?? opp.updatedAt ?? opp.createdAt;
      if (!isTimestampInWindow(statusTs, win)) continue;
      won += 1;
      rev += parseNonNegativeFloat(opp.monetaryValue);
    }
    wonDeals = won;
    pipelineRevenueUsd = round2(rev);
  }

  let booked: number | null = null;
  let showed: number | null = null;
  if (calListRes.status === 200 && calListRes.body && Array.isArray(calListRes.body.calendars)) {
    const eligible = (calListRes.body.calendars as RawGhlCalendar[]).filter(
      (cal) => typeof cal.id === "string" && cal.id && !RECRUITING_RE.test(cal.name ?? ""),
    );
    if (eligible.length === 0) {
      booked = 0;
      showed = 0;
    } else if (eligible.length <= MAX_CALENDARS_PER_CLIENT) {
      const eventResults = await Promise.all(
        eligible.map((cal) =>
          fetchLoc(
            `/calendars/events?calendarId=${encodeURIComponent(cal.id!)}&startTime=${win.startMs}&endTime=${win.endMs}`,
          ),
        ),
      );
      if (eventResults.every((r) => r.status === 200 && r.body && Array.isArray(r.body.events))) {
        const appointments: AppointmentRecord[] = [];
        for (const r of eventResults) {
          for (const rawEv of r.body!.events as RawGhlCalendarEvent[]) {
            appointments.push({
              scheduledAt: rawEv.startTime ?? win.startMs,
              status: rawEv.appointmentStatus ?? rawEv.status,
              prospectKey: rawEv.contactId ?? null,
            });
          }
        }
        booked = bookedCounts(appointments, win.endMs).booked;
        showed = countShowed(appointments, win);
      }
    }
  }

  return { booked, showed, wonDeals, pipelineRevenueUsd };
}

function selectHealthLeadsForPeriod(
  loc: GatewayHealthLocation | null,
  period: DashboardPeriod,
): number | null {
  if (!loc) return null;
  if (period === "7d") return loc.leads7d;
  if (period === "30d") return loc.leads30d;
  return null;
}

function resolveUniqueSlug(baseSlug: string, adAccountId: string, usedSlugs: Set<string>): string {
  if (!usedSlugs.has(baseSlug)) {
    usedSlugs.add(baseSlug);
    return baseSlug;
  }
  const suffix = adAccountId.replace(/^act_/, "").slice(-6);
  const candidate = `${baseSlug}-${suffix}`;
  usedSlugs.add(candidate);
  return candidate;
}

async function computeGatewayFulfillmentBundle(
  period: DashboardPeriod,
  opts: GatewayFulfillmentClientOptions,
  baseUrl: string,
  token: string,
  now: Date,
): Promise<{ bundle: PortfolioSnapshotBundle | null; cacheable: boolean }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const excludedMetaIds = resolveExcludedMetaIds(opts);
  const excludedGhlIds = resolveExcludedGhlLocationIds(opts);
  const observedAt = now.toISOString();
  const range = agencyMetaPeriodRange(period, now);
  const win = buildPeriodWindow(period, now);

  const [adAccountsRes, healthLocations, companyId] = await Promise.all([
    fetchAllMetaAdAccounts(baseUrl, token, fetchImpl, timeoutMs),
    fetchGatewayHealthLocations(
      baseUrl,
      token,
      excludedGhlIds,
      opts.excludedClientSlugs,
      fetchImpl,
      timeoutMs,
    ),
    resolveAgencyCompanyId(opts, baseUrl, token, fetchImpl, timeoutMs),
  ]);

  if (!adAccountsRes.ok) {
    return { bundle: null, cacheable: false };
  }

  const candidateMeta = adAccountsRes.accounts
    .map((acct) => ({
      id: normalizeMetaAccountId(acct.id),
      rawName: typeof acct.name === "string" ? acct.name.trim() : "",
    }))
    .filter((acct): acct is { id: string; rawName: string } => {
      if (!acct.id) return false;
      if (excludedMetaIds.has(acct.id)) return false;
      const slug = slugifyClientName(acct.rawName);
      if (slug && isExcludedClientSlug(slug, opts.excludedClientSlugs)) return false;
      return true;
    });

  const metaReads = await mapWithConcurrency(
    candidateMeta,
    META_CONCURRENCY,
    (acct) =>
      readClientMetaInsights(acct.id, acct.rawName, range, {
        baseUrl,
        token,
        fetchImpl,
        timeoutMs,
        now,
      }),
  );

  if (metaReads.some((r) => !r.ok)) {
    // Incomplete Meta reads must never silently under-report portfolio spend.
    return { bundle: null, cacheable: false };
  }
  metaReads.sort((a, b) => b.spend - a.spend || a.displayName.localeCompare(b.displayName));

  // Assign GHL locations one-to-one so no GHL sub-account is ever double-counted.
  const usedGhlIds = new Set<string>();
  const paired = metaReads.map((meta) => {
    const matchedLoc = matchGhlHealthLocation(meta.displayName, healthLocations, usedGhlIds);
    if (matchedLoc) usedGhlIds.add(matchedLoc.locationId);
    const healthLeads = selectHealthLeadsForPeriod(matchedLoc, period);
    return { meta, matchedLoc, healthLeads };
  });

  const activePaired = paired.filter(
    ({ meta, healthLeads }) =>
      meta.spend > 0 ||
      meta.impressions > 0 ||
      meta.metaLeads > 0 ||
      (healthLeads !== null && healthLeads > 0),
  );

  const ghlEnrichments =
    companyId && activePaired.some((p) => p.matchedLoc !== null)
      ? await mapWithConcurrency(activePaired, GHL_CONCURRENCY, async ({ matchedLoc }) => {
          if (!matchedLoc) return null;
          return readClientGhlMetrics(matchedLoc.locationId, companyId, win, {
            baseUrl,
            token,
            fetchImpl,
            timeoutMs,
          });
        })
      : activePaired.map(() => null);

  const usedSlugs = new Set<string>();
  const rawClients: MergedClientMetrics[] = activePaired.map((item, idx) => {
    const { meta, healthLeads } = item;
    const ghl = ghlEnrichments[idx] ?? null;
    const newLeads =
      healthLeads !== null && (healthLeads > 0 || meta.metaLeads === 0)
        ? healthLeads
        : meta.metaLeads;

    const entry: MergedClientMetrics = {
      slug: resolveUniqueSlug(meta.slug, meta.adAccountId, usedSlugs),
      displayName: meta.displayName,
      observedAt,
      newLeads,
      booked: ghl?.booked ?? null,
      showed: ghl?.showed ?? null,
      pitched: null,
      wonDeals: ghl?.wonDeals ?? null,
      showRate: null,
      closeRate: null,
      pipelineRevenueUsd: ghl?.pipelineRevenueUsd ?? null,
      cashCollectedUsd: null,
      speedToLeadSeconds: null,
      spend: meta.spend,
      impressions: meta.impressions,
      clicks: meta.clicks,
      cpl: null,
      cac: null,
      roas: null,
      costPerHeldAppointment: null,
      zeroLeadDays: meta.zeroLeadDays,
    };
    deriveClientRatios(entry);
    return entry;
  });

  const clients = filterClientOnlyPortfolio(rawClients, {
    excludedSlugs: opts.excludedClientSlugs,
  }).sort((a, b) => (b.spend ?? -1) - (a.spend ?? -1) || a.displayName.localeCompare(b.displayName));

  if (clients.length === 0) {
    return { bundle: null, cacheable: false };
  }

  return {
    bundle: {
      capital: null,
      snapshots: null,
      neonAccounts: null,
      neonPipeline: null,
      clients,
      observedAt,
    },
    cacheable: true,
  };
}

/**
 * Reads active client portfolio metrics directly from the Increase ROAS OAuth Gateway
 * using `GATEWAY_PAPERCLIP_KEY` (zero extra keys required).
 *
 * Strictly excludes Increase ROAS agency Meta/GHL accounts, own brands, and former/cancelled
 * clients. Fails closed to `null` when no Gateway token is configured or Gateway is unreachable.
 */
export async function readGatewayFulfillmentBundle(
  period: DashboardPeriod = "30d",
  opts: GatewayFulfillmentClientOptions = {},
): Promise<PortfolioSnapshotBundle | null> {
  const token = (
    opts.token !== undefined ? opts.token : (process.env.GATEWAY_PAPERCLIP_KEY ?? "")
  ).trim();
  if (!token) return null;

  const baseUrl = (
    opts.baseUrl ??
    process.env.OAUTH_GATEWAY_URL ??
    process.env.GATEWAY_BASE_URL ??
    DEFAULT_GATEWAY_URL
  )
    .trim()
    .replace(/\/+$/, "");
  const now = (opts.now ?? (() => new Date()))();
  const excludedMetaKey = [...resolveExcludedMetaIds(opts)].sort().join(",");
  const excludedGhlKey = [...resolveExcludedGhlLocationIds(opts)].sort().join(",");
  const excludedSlugKey = [
    ...splitEnvCsv(process.env.FULFILLMENT_EXCLUDED_CLIENT_SLUGS),
    ...(opts.excludedClientSlugs ?? []),
  ]
    .sort()
    .join(",");
  const companyKey = (opts.agencyCompanyId ?? process.env.GHL_AGENCY_COMPANY_ID ?? "").trim();
  const tokenFp = createHash("sha256").update(token).digest("hex").slice(0, 16);
  const cacheKey = `${baseUrl}|${period}|${tokenFp}|${companyKey}|${excludedMetaKey}|${excludedGhlKey}|${excludedSlugKey}`;

  if (!opts.bypassCache) {
    const hit = cache.get(cacheKey);
    if (hit) {
      const age = now.getTime() - hit.at;
      if (age >= 0 && age < CACHE_TTL_MS) return hit.value;
    }
    const existingFlight = inFlight.get(cacheKey);
    if (existingFlight) return existingFlight;
  }

  const run = computeGatewayFulfillmentBundle(period, opts, baseUrl, token, now)
    .then(({ bundle, cacheable }) => {
      if (bundle && cacheable && !opts.bypassCache) {
        writeCache(cacheKey, now.getTime(), bundle);
      }
      return bundle;
    })
    .finally(() => {
      if (!opts.bypassCache) inFlight.delete(cacheKey);
    });

  if (!opts.bypassCache) {
    inFlight.set(cacheKey, run);
  }
  return run;
}
