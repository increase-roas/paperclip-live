import { createHash } from "node:crypto";
import type { DashboardPeriod } from "@paperclipai/shared";

export type AgencyGhlAccountStatus = "live" | "needs_config" | "error";

export interface AgencySalesAccountMetrics {
  id: string;
  displayName: string;
  locationId: string | null;
  authMode: "gateway" | "pit";
  status: AgencyGhlAccountStatus;
  statusLabel: string;
  observedAt: string | null;
  newLeads: number | null;
  activeOpportunities: number | null;
  booked: number | null;
  showed: number | null;
  noShows: number | null;
  pitched: number | null;
  wonDeals: number | null;
  lostDeals: number | null;
  pipelineWonUsd: number | null;
  cashCollectedUsd: number | null;
  showRate: number | null;
  offerRate: number | null;
  closeRate: number | null;
}

export interface AgencySalesSummary {
  period: DashboardPeriod;
  observedAt: string;
  liveAccountCount: number;
  totalAccountCount: number;
  hasGhl: boolean;
  newLeads: number | null;
  activeOpportunities: number | null;
  booked: number | null;
  showed: number | null;
  noShows: number | null;
  pitched: number | null;
  wonDeals: number | null;
  lostDeals: number | null;
  pipelineWonUsd: number | null;
  cashCollectedUsd: number | null;
  showRate: number | null;
  offerRate: number | null;
  closeRate: number | null;
  setRate: number | null;
  leadToCustomerRate: number | null;
  accounts: AgencySalesAccountMetrics[];
}

export interface AgencySalesClientOptions {
  gatewayBaseUrl?: string;
  gatewayToken?: string;
  agencyCompanyId?: string;
  ghlDirectOrigin?: string;
  alexBloomfieldPitKey?: string;
  alexBloomfieldLocationId?: string;
  locationIds?: Partial<Record<"increaseRoasMain" | "hotTubLaunchB2b", string | null>>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  bypassCache?: boolean;
}

interface RawGhlPipelineStage {
  id?: string;
  name?: string;
}

interface RawGhlPipeline {
  id?: string;
  name?: string;
  stages?: RawGhlPipelineStage[];
}

interface RawGhlOpportunity {
  id?: string;
  pipelineId?: string;
  pipelineStageId?: string;
  status?: string;
  monetaryValue?: number | string;
  createdAt?: string;
  updatedAt?: string;
  lastStatusChangeAt?: string;
}

interface RawGhlContact {
  id?: string;
  dateAdded?: string;
}

interface RawGhlCalendar {
  id?: string;
  name?: string;
}

interface RawGhlCalendarEvent {
  id?: string;
  appointmentStatus?: string;
  status?: string;
}

interface RawGhlTransaction {
  id?: string;
  amount?: number | string;
  currency?: string;
  status?: string;
  createdAt?: string;
  liveMode?: boolean;
}

interface PeriodWindow {
  startMs: number;
  endMs: number;
  startDay: string;
  endDay: string;
}

type LocationFetcher = (ghlPath: string, apiVersion?: string) => Promise<{ status: number; body: Record<string, unknown> | null }>;

const DEFAULT_GATEWAY_URL = "https://increase-roas-oauth-gateway.increase-roas.workers.dev";
const DEFAULT_GHL_ORIGIN = "https://services.leadconnectorhq.com";
const DEFAULT_AGENCY_COMPANY_ID = "uVK13CFqZs9TOBENvXSH";
const DEFAULT_INCREASE_ROAS_MAIN_LOCATION_ID = "Sr90yJUmFoBTgBQuejtU";
const DEFAULT_HOT_TUB_LAUNCH_B2B_LOCATION_ID = "AG47jEV5rVUrGLt5FlKO";
const DEFAULT_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 5 * 60 * 1_000;
const MAX_CALENDARS_PER_LOCATION = 10;
const MAX_CONTACT_PAGES = 3;
const USER_AGENT = "paperclip-server/1.0";
const LOCATION_ID_RE = /^[A-Za-z0-9_-]{6,128}$/;
const UNSET_SENTINELS = new Set(["none", "unset", "unconfigured", "null"]);

/** Exclude recruiting/hiring pipelines and interview calendars from B2B sales metrics. */
const RECRUITING_RE = /\b(applicant|applicants|hiring|recruit(?:ing|ment)?|candidate|interview|career|job\s+application)\b/i;
const NO_SHOW_STAGE_RE = /\b(no[\s-]*show|n\/s)\b/i;
const NO_PITCH_STAGE_RE = /\bno[\s-]*pitch\b/i;
const LOST_STAGE_RE = /\b(lost|dq|disqualified|not\s+interested|bad\s+number|bad\s+fit)\b/i;
const BOOKED_STAGE_RE = /\b(booked|s\/c\s+booked|call\s+booked|demo\s+booked|audit\s+booked|strategy\s+call)\b/i;
const SHOWED_STAGE_RE = /\b(showed|call\s+completed|pitch(?:ed)?|proposal|contract\s+sent|offer|deposit|won|sold|closed)\b/i;
const PITCHED_STAGE_RE = /\b(pitch(?:ed)?|proposal|contract\s+sent|offer|deposit|close\s+call|post\s+pitch|won|sold|closed)\b/i;

const cache = new Map<string, { at: number; value: AgencySalesSummary }>();

export function resetAgencySalesCache(): void {
  cache.clear();
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeLocationId(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (!trimmed || UNSET_SENTINELS.has(trimmed.toLowerCase())) return null;
  return LOCATION_ID_RE.test(trimmed) ? trimmed : null;
}

function buildPeriodWindow(period: DashboardPeriod, now: Date): PeriodWindow {
  const endMs = now.getTime();
  const startDate =
    period === "month"
      ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
      : new Date(endMs - (period === "7d" ? 7 : 30) * 24 * 60 * 60 * 1000);
  return {
    startMs: startDate.getTime(),
    endMs,
    startDay: startDate.toISOString().slice(0, 10),
    endDay: now.toISOString().slice(0, 10),
  };
}

function isTimestampInWindow(raw: string | undefined, win: PeriodWindow): boolean {
  if (!raw) return false;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) && ms >= win.startMs && ms <= win.endMs;
}

function parseMoney(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function fetchJsonRecord(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers,
      redirect: "manual",
      signal: controller.signal,
    });
    if (!res.ok) return { status: res.status, body: null };
    const parsed = (await res.json()) as unknown;
    return { status: res.status, body: isRecord(parsed) ? parsed : null };
  } catch {
    return { status: 0, body: null };
  } finally {
    clearTimeout(timer);
  }
}

function createGatewayLocationFetcher(
  gatewayBaseUrl: string,
  gatewayToken: string,
  companyId: string,
  locationId: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): LocationFetcher {
  return (ghlPath) => {
    const url =
      `${gatewayBaseUrl}/api/location/${encodeURIComponent(locationId)}/readonly` +
      `?companyId=${encodeURIComponent(companyId)}&path=${encodeURIComponent(ghlPath)}`;
    return fetchJsonRecord(
      url,
      {
        authorization: `Bearer ${gatewayToken}`,
        accept: "application/json",
        "user-agent": USER_AGENT,
      },
      fetchImpl,
      timeoutMs,
    );
  };
}

function createDirectPitLocationFetcher(
  ghlOrigin: string,
  pitKey: string,
  locationId: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): LocationFetcher {
  return (ghlPath) => {
    const target = new URL(ghlPath, ghlOrigin);
    if (target.pathname.startsWith("/payments/transactions")) {
      target.searchParams.set("altId", locationId);
      target.searchParams.set("altType", "location");
      target.searchParams.set("locationId", locationId);
    } else if (target.pathname.startsWith("/opportunities/search")) {
      target.searchParams.set("location_id", locationId);
      target.searchParams.delete("locationId");
    } else if (!target.searchParams.has("locationId")) {
      target.searchParams.set("locationId", locationId);
    }
    return fetchJsonRecord(
      target.toString(),
      {
        authorization: `Bearer ${pitKey}`,
        version: "2021-07-28",
        accept: "application/json",
        "user-agent": USER_AGENT,
      },
      fetchImpl,
      timeoutMs,
    );
  };
}

function emptyAccount(
  id: string,
  displayName: string,
  locationId: string | null,
  authMode: "gateway" | "pit",
  status: AgencyGhlAccountStatus,
  statusLabel: string,
): AgencySalesAccountMetrics {
  return {
    id,
    displayName,
    locationId,
    authMode,
    status,
    statusLabel,
    observedAt: null,
    newLeads: null,
    activeOpportunities: null,
    booked: null,
    showed: null,
    noShows: null,
    pitched: null,
    wonDeals: null,
    lostDeals: null,
    pipelineWonUsd: null,
    cashCollectedUsd: null,
    showRate: null,
    offerRate: null,
    closeRate: null,
  };
}

async function countRecentContacts(
  fetcher: LocationFetcher,
  win: PeriodWindow,
): Promise<{ status: number; count: number }> {
  let count = 0;
  let startAfterId: string | null = null;
  let startAfter: string | null = null;
  let firstStatus = 0;

  for (let page = 0; page < MAX_CONTACT_PAGES; page += 1) {
    const qs = new URLSearchParams({ limit: "100" });
    if (startAfterId) qs.set("startAfterId", startAfterId);
    if (startAfter) qs.set("startAfter", startAfter);
    const res = await fetcher(`/contacts/?${qs.toString()}`, "2021-07-28");
    if (page === 0) firstStatus = res.status;
    if (res.status !== 200 || !res.body) break;
    const contacts = Array.isArray(res.body.contacts) ? (res.body.contacts as RawGhlContact[]) : [];
    if (contacts.length === 0) break;

    let oldestInPageMs = Infinity;
    for (const c of contacts) {
      if (isTimestampInWindow(c.dateAdded, win)) count += 1;
      const ms = c.dateAdded ? Date.parse(c.dateAdded) : NaN;
      if (Number.isFinite(ms) && ms < oldestInPageMs) oldestInPageMs = ms;
    }

    if (contacts.length < 100 || oldestInPageMs < win.startMs) break;
    const meta = isRecord(res.body.meta) ? res.body.meta : null;
    const nextId = typeof meta?.startAfterId === "string" ? meta.startAfterId : null;
    const nextCursor =
      meta?.startAfter !== null && meta?.startAfter !== undefined ? String(meta.startAfter) : null;
    if (!nextId || nextId === startAfterId) break;
    startAfterId = nextId;
    startAfter = nextCursor;
  }

  return { status: firstStatus, count };
}

async function readCalendarOutcomes(
  fetcher: LocationFetcher,
  win: PeriodWindow,
): Promise<{ booked: number; showed: number; noShows: number; hasCalendarData: boolean }> {
  const listRes = await fetcher("/calendars/", "v3");
  if (listRes.status !== 200 || !listRes.body) {
    return { booked: 0, showed: 0, noShows: 0, hasCalendarData: false };
  }
  const calendars = (Array.isArray(listRes.body.calendars) ? (listRes.body.calendars as RawGhlCalendar[]) : [])
    .filter((cal) => typeof cal.id === "string" && cal.id && !RECRUITING_RE.test(cal.name ?? ""))
    .slice(0, MAX_CALENDARS_PER_LOCATION);

  if (calendars.length === 0) {
    return { booked: 0, showed: 0, noShows: 0, hasCalendarData: true };
  }

  let booked = 0;
  let showed = 0;
  let noShows = 0;

  for (let i = 0; i < calendars.length; i += 5) {
    const batch = calendars.slice(i, i + 5);
    const results = await Promise.all(
      batch.map((cal) =>
        fetcher(
          `/calendars/events?calendarId=${encodeURIComponent(cal.id!)}&startTime=${win.startMs}&endTime=${win.endMs}`,
          "v3",
        ),
      ),
    );
    for (const res of results) {
      if (res.status !== 200 || !res.body || !Array.isArray(res.body.events)) continue;
      for (const rawEv of res.body.events as RawGhlCalendarEvent[]) {
        const st = String(rawEv.appointmentStatus ?? rawEv.status ?? "").trim().toLowerCase();
        if (st === "cancelled" || st === "canceled" || st === "invalid") continue;
        booked += 1;
        if (st === "showed") showed += 1;
        else if (st === "noshow" || st === "no_show" || st === "no-show") noShows += 1;
      }
    }
  }

  return { booked, showed, noShows, hasCalendarData: true };
}

function summarizeSalesOpportunities(
  pipelines: readonly RawGhlPipeline[],
  oppPages: ReadonlyArray<Record<string, unknown> | null>,
  win: PeriodWindow,
) {
  const excludedPipelineIds = new Set<string>();
  const stageNameById = new Map<string, string>();
  for (const pipe of pipelines) {
    if (pipe.id && RECRUITING_RE.test(pipe.name ?? "")) {
      excludedPipelineIds.add(pipe.id);
    }
    for (const stage of pipe.stages ?? []) {
      if (stage.id) stageNameById.set(stage.id, stage.name ?? "");
    }
  }

  const deduped = new Map<string, RawGhlOpportunity>();
  for (const body of oppPages) {
    const list = body && Array.isArray(body.opportunities) ? (body.opportunities as RawGhlOpportunity[]) : [];
    for (const opp of list) {
      if (opp.id) deduped.set(opp.id, opp);
    }
  }

  let activeOpportunities = 0;
  let wonDeals = 0;
  let lostDeals = 0;
  let pipelineWonUsd = 0;
  let stageBooked = 0;
  let stageShowed = 0;
  let stagePitched = 0;

  for (const opp of deduped.values()) {
    if (opp.pipelineId && excludedPipelineIds.has(opp.pipelineId)) continue;
    const status = String(opp.status ?? "").trim().toLowerCase();
    const statusTs = opp.lastStatusChangeAt ?? opp.updatedAt ?? opp.createdAt;
    const inPeriodActivity = isTimestampInWindow(opp.createdAt, win) || isTimestampInWindow(opp.updatedAt, win);
    const inPeriodStatus = isTimestampInWindow(statusTs, win);

    if (inPeriodActivity) {
      activeOpportunities += 1;
      const stageName = opp.pipelineStageId ? (stageNameById.get(opp.pipelineStageId) ?? "") : "";
      const isNoShow = NO_SHOW_STAGE_RE.test(stageName);
      const isLostStage = LOST_STAGE_RE.test(stageName);
      if (!isNoShow && BOOKED_STAGE_RE.test(stageName)) stageBooked += 1;
      if (!isNoShow && !isLostStage && SHOWED_STAGE_RE.test(stageName)) stageShowed += 1;
      if (!NO_PITCH_STAGE_RE.test(stageName) && !isLostStage && PITCHED_STAGE_RE.test(stageName)) {
        stagePitched += 1;
      }
    }

    if (status === "won" && inPeriodStatus) {
      wonDeals += 1;
      pipelineWonUsd += parseMoney(opp.monetaryValue);
    } else if (status === "lost" && inPeriodStatus) {
      lostDeals += 1;
    }
  }

  return {
    activeOpportunities,
    wonDeals,
    lostDeals,
    pipelineWonUsd: round2(pipelineWonUsd),
    stageBooked,
    stageShowed,
    stagePitched: Math.max(stagePitched, wonDeals),
  };
}

function sumWindowTransactions(body: Record<string, unknown> | null, win: PeriodWindow): number {
  if (!body || !Array.isArray(body.data)) return 0;
  let total = 0;
  for (const rawTx of body.data as RawGhlTransaction[]) {
    if (rawTx.liveMode === false) continue;
    const currency = typeof rawTx.currency === "string" ? rawTx.currency.trim().toUpperCase() : "USD";
    if (currency && currency !== "USD") continue;
    const st = String(rawTx.status ?? "").trim().toLowerCase();
    if (st && st !== "succeeded" && st !== "completed" && st !== "paid") continue;
    if (!isTimestampInWindow(rawTx.createdAt, win)) continue;
    total += parseMoney(rawTx.amount);
  }
  return round2(total);
}

function computeRates(m: {
  booked: number;
  showed: number;
  noShows: number;
  pitched: number;
  wonDeals: number;
  lostDeals: number;
}) {
  const showRate =
    m.showed + m.noShows > 0
      ? round1((m.showed / (m.showed + m.noShows)) * 100)
      : m.booked > 0
        ? round1((m.showed / m.booked) * 100)
        : null;
  const offerRate =
    m.showed > 0 && m.pitched > 0 ? round1(Math.min(100, (m.pitched / m.showed) * 100)) : null;
  const closeRate =
    m.wonDeals + m.lostDeals > 0
      ? round1((m.wonDeals / (m.wonDeals + m.lostDeals)) * 100)
      : m.pitched > 0 && m.wonDeals > 0
        ? round1((m.wonDeals / m.pitched) * 100)
        : m.showed > 0 && m.wonDeals > 0
          ? round1((m.wonDeals / m.showed) * 100)
          : null;
  return { showRate, offerRate, closeRate };
}

async function readSingleGhlAccount(
  spec: { id: string; displayName: string; locationId: string; authMode: "gateway" | "pit" },
  fetcher: LocationFetcher,
  win: PeriodWindow,
  observedAt: string,
): Promise<AgencySalesAccountMetrics> {
  const [pipelinesRes, oppsAllRes, oppsWonRes, oppsLostRes, contactsRes, calRes, txRes] = await Promise.all([
    fetcher("/opportunities/pipelines", "v3"),
    fetcher("/opportunities/search?limit=100&status=all", "v3"),
    fetcher("/opportunities/search?limit=100&status=won", "v3"),
    fetcher("/opportunities/search?limit=100&status=lost", "v3"),
    countRecentContacts(fetcher, win),
    readCalendarOutcomes(fetcher, win),
    fetcher(`/payments/transactions?limit=50&paymentMode=live&startAt=${win.startDay}&endAt=${win.endDay}`, "v3"),
  ]);

  const statuses = [pipelinesRes.status, oppsAllRes.status, contactsRes.status];
  const anyOk = statuses.some((s) => s === 200);
  if (!anyOk) {
    const authFailed = statuses.some((s) => s === 400 || s === 401 || s === 403 || s === 404);
    return emptyAccount(
      spec.id,
      spec.displayName,
      spec.locationId,
      spec.authMode,
      authFailed ? "needs_config" : "error",
      authFailed
        ? spec.authMode === "pit"
          ? "Needs PIT key / location ID"
          : "Needs gateway GHL access"
        : "Temporarily unreachable",
    );
  }

  const pipelines =
    pipelinesRes.status === 200 && pipelinesRes.body && Array.isArray(pipelinesRes.body.pipelines)
      ? (pipelinesRes.body.pipelines as RawGhlPipeline[])
      : [];
  const opps = summarizeSalesOpportunities(
    pipelines,
    [oppsAllRes.body, oppsWonRes.body, oppsLostRes.body],
    win,
  );

  const booked = calRes.booked > 0 ? calRes.booked : opps.stageBooked;
  const showed = calRes.showed > 0 ? calRes.showed : opps.stageShowed;
  const noShows = calRes.noShows;
  const pitched = opps.stagePitched;
  const cashCollectedUsd = sumWindowTransactions(txRes.body, win);
  const rates = computeRates({
    booked,
    showed,
    noShows,
    pitched,
    wonDeals: opps.wonDeals,
    lostDeals: opps.lostDeals,
  });

  return {
    id: spec.id,
    displayName: spec.displayName,
    locationId: spec.locationId,
    authMode: spec.authMode,
    status: "live",
    statusLabel: "Live",
    observedAt,
    newLeads: contactsRes.status === 200 ? contactsRes.count : 0,
    activeOpportunities: opps.activeOpportunities,
    booked,
    showed,
    noShows,
    pitched,
    wonDeals: opps.wonDeals,
    lostDeals: opps.lostDeals,
    pipelineWonUsd: opps.pipelineWonUsd,
    cashCollectedUsd,
    showRate: rates.showRate,
    offerRate: rates.offerRate,
    closeRate: rates.closeRate,
  };
}

function summarizeAgencySales(
  period: DashboardPeriod,
  observedAt: string,
  accounts: AgencySalesAccountMetrics[],
): AgencySalesSummary {
  const live = accounts.filter((a) => a.status === "live");
  if (live.length === 0) {
    return {
      period,
      observedAt,
      liveAccountCount: 0,
      totalAccountCount: accounts.length,
      hasGhl: false,
      newLeads: null,
      activeOpportunities: null,
      booked: null,
      showed: null,
      noShows: null,
      pitched: null,
      wonDeals: null,
      lostDeals: null,
      pipelineWonUsd: null,
      cashCollectedUsd: null,
      showRate: null,
      offerRate: null,
      closeRate: null,
      setRate: null,
      leadToCustomerRate: null,
      accounts,
    };
  }

  let newLeads = 0;
  let activeOpportunities = 0;
  let booked = 0;
  let showed = 0;
  let noShows = 0;
  let pitched = 0;
  let wonDeals = 0;
  let lostDeals = 0;
  let pipelineWonUsd = 0;
  let cashCollectedUsd = 0;

  for (const a of live) {
    newLeads += a.newLeads ?? 0;
    activeOpportunities += a.activeOpportunities ?? 0;
    booked += a.booked ?? 0;
    showed += a.showed ?? 0;
    noShows += a.noShows ?? 0;
    pitched += a.pitched ?? 0;
    wonDeals += a.wonDeals ?? 0;
    lostDeals += a.lostDeals ?? 0;
    pipelineWonUsd += a.pipelineWonUsd ?? 0;
    cashCollectedUsd += a.cashCollectedUsd ?? 0;
  }

  const rates = computeRates({ booked, showed, noShows, pitched, wonDeals, lostDeals });
  return {
    period,
    observedAt,
    liveAccountCount: live.length,
    totalAccountCount: accounts.length,
    hasGhl: true,
    newLeads,
    activeOpportunities,
    booked,
    showed,
    noShows,
    pitched,
    wonDeals,
    lostDeals,
    pipelineWonUsd: round2(pipelineWonUsd),
    cashCollectedUsd: round2(cashCollectedUsd),
    showRate: rates.showRate,
    offerRate: rates.offerRate,
    closeRate: rates.closeRate,
    setRate: newLeads > 0 ? round1((booked / newLeads) * 100) : null,
    leadToCustomerRate: newLeads > 0 ? round1((wonDeals / newLeads) * 100) : null,
    accounts,
  };
}

function resolvePrimaryLocationId(
  key: "increaseRoasMain" | "hotTubLaunchB2b",
  envVar: string,
  fallback: string,
  opts: AgencySalesClientOptions,
): string | null {
  if (opts.locationIds && Object.prototype.hasOwnProperty.call(opts.locationIds, key)) {
    return normalizeLocationId(opts.locationIds[key]);
  }
  const fromEnv = process.env[envVar];
  if (fromEnv !== undefined) return normalizeLocationId(fromEnv);
  return fallback;
}

/**
 * Reads Increase ROAS's own 3 agency GHL sales sub-accounts ONLY:
 * 1. Increase ROAS Main (primary agency via OAuth Gateway)
 * 2. Hot Tub Launch B2B (primary agency via OAuth Gateway)
 * 3. Alex Bloomfield / Start Scale Automate (separate GHL agency via optional
 *    GHL_ALEX_BLOOMFIELD_PIT_KEY + GHL_ALEX_BLOOMFIELD_LOCATION_ID)
 *
 * Fails closed to `null` when neither the OAuth Gateway token nor Alex Bloomfield's
 * PIT key is configured.
 */
export async function readAgencySalesSummary(
  period: DashboardPeriod = "30d",
  opts: AgencySalesClientOptions = {},
): Promise<AgencySalesSummary | null> {
  const gatewayToken = (
    opts.gatewayToken !== undefined
      ? opts.gatewayToken
      : (process.env.GATEWAY_PAPERCLIP_KEY ?? process.env.GATEWAY_GHL_KEY ?? "")
  ).trim();
  const alexPitKey = (
    opts.alexBloomfieldPitKey !== undefined
      ? opts.alexBloomfieldPitKey
      : (process.env.GHL_ALEX_BLOOMFIELD_PIT_KEY ?? "")
  ).trim();
  const alexLocationId = normalizeLocationId(
    opts.alexBloomfieldLocationId !== undefined
      ? opts.alexBloomfieldLocationId
      : process.env.GHL_ALEX_BLOOMFIELD_LOCATION_ID,
  );

  if (!gatewayToken && !alexPitKey) return null;

  const gatewayBaseUrl = (opts.gatewayBaseUrl ?? process.env.OAUTH_GATEWAY_URL ?? DEFAULT_GATEWAY_URL)
    .trim()
    .replace(/\/+$/, "");
  const ghlOrigin = (opts.ghlDirectOrigin ?? DEFAULT_GHL_ORIGIN).trim().replace(/\/+$/, "");
  const companyId = (opts.agencyCompanyId ?? process.env.GHL_AGENCY_COMPANY_ID ?? DEFAULT_AGENCY_COMPANY_ID).trim();
  const irMainLoc = resolvePrimaryLocationId(
    "increaseRoasMain",
    "GHL_AGENCY_INCREASE_ROAS_LOCATION_ID",
    DEFAULT_INCREASE_ROAS_MAIN_LOCATION_ID,
    opts,
  );
  const htlLoc = resolvePrimaryLocationId(
    "hotTubLaunchB2b",
    "GHL_AGENCY_HOT_TUB_LAUNCH_LOCATION_ID",
    DEFAULT_HOT_TUB_LAUNCH_B2B_LOCATION_ID,
    opts,
  );

  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = (opts.now ?? (() => new Date()))();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fp = createHash("sha256")
    .update(`${gatewayToken}|${alexPitKey}|${alexLocationId ?? ""}|${irMainLoc ?? ""}|${htlLoc ?? ""}`)
    .digest("hex")
    .slice(0, 16);
  const cacheKey = `${gatewayBaseUrl}|${period}|${fp}`;

  if (!opts.bypassCache) {
    const hit = cache.get(cacheKey);
    if (hit && now.getTime() - hit.at < CACHE_TTL_MS) return hit.value;
  }

  const win = buildPeriodWindow(period, now);
  const observedAt = now.toISOString();

  const tasks: Array<Promise<AgencySalesAccountMetrics>> = [
    gatewayToken && irMainLoc
      ? readSingleGhlAccount(
          { id: "increase-roas-main", displayName: "Increase ROAS Main", locationId: irMainLoc, authMode: "gateway" },
          createGatewayLocationFetcher(gatewayBaseUrl, gatewayToken, companyId, irMainLoc, fetchImpl, timeoutMs),
          win,
          observedAt,
        )
      : Promise.resolve(
          emptyAccount(
            "increase-roas-main",
            "Increase ROAS Main",
            irMainLoc,
            "gateway",
            "needs_config",
            irMainLoc ? "Needs gateway token" : "Needs location ID",
          ),
        ),
    gatewayToken && htlLoc
      ? readSingleGhlAccount(
          { id: "hot-tub-launch-b2b", displayName: "Hot Tub Launch B2B", locationId: htlLoc, authMode: "gateway" },
          createGatewayLocationFetcher(gatewayBaseUrl, gatewayToken, companyId, htlLoc, fetchImpl, timeoutMs),
          win,
          observedAt,
        )
      : Promise.resolve(
          emptyAccount(
            "hot-tub-launch-b2b",
            "Hot Tub Launch B2B",
            htlLoc,
            "gateway",
            "needs_config",
            htlLoc ? "Needs gateway token" : "Needs location ID",
          ),
        ),
    alexPitKey && alexLocationId
      ? readSingleGhlAccount(
          {
            id: "alex-bloomfield-ssa",
            displayName: "Alex Bloomfield (Start Scale Automate)",
            locationId: alexLocationId,
            authMode: "pit",
          },
          createDirectPitLocationFetcher(ghlOrigin, alexPitKey, alexLocationId, fetchImpl, timeoutMs),
          win,
          observedAt,
        )
      : Promise.resolve(
          emptyAccount(
            "alex-bloomfield-ssa",
            "Alex Bloomfield (Start Scale Automate)",
            alexLocationId,
            "pit",
            "needs_config",
            alexPitKey
              ? "Needs GHL_ALEX_BLOOMFIELD_LOCATION_ID"
              : alexLocationId
                ? "Needs GHL_ALEX_BLOOMFIELD_PIT_KEY"
                : "Needs PIT key / location ID",
          ),
        ),
  ];

  const accounts = await Promise.all(tasks);
  const summary = summarizeAgencySales(period, observedAt, accounts);

  if (summary.liveAccountCount > 0 && !opts.bypassCache) {
    cache.set(cacheKey, { at: now.getTime(), value: summary });
  }
  return summary;
}
