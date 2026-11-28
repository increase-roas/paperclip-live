import {
  appointmentStatus,
  bookedCounts,
  closeRate,
  countLeads,
  countShowed,
  isClearedPayment,
  leadToCustomerRate,
  offerRate,
  setRate,
  showRate,
  type AppointmentRecord,
  type LeadCandidate,
} from "@paperclipai/shared/ir-metrics";
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
  tags?: unknown;
}

interface RawGhlCalendar {
  id?: string;
  name?: string;
}

interface RawGhlCalendarEvent {
  id?: string;
  appointmentStatus?: string;
  status?: string;
  startTime?: string | number;
  contactId?: string;
}

interface RawGhlTransaction {
  id?: string;
  amount?: number | string;
  amountRefunded?: number | string;
  currency?: string;
  status?: string;
  createdAt?: string;
  liveMode?: boolean | string;
}

interface PeriodWindow {
  startMs: number;
  endMs: number;
  startDay: string;
  endDay: string;
}

type LocationFetcher = (ghlPath: string) => Promise<{ status: number; body: Record<string, unknown> | null }>;

const DEFAULT_GATEWAY_URL = "https://increase-roas-oauth-gateway.increase-roas.workers.dev";
const DEFAULT_GHL_ORIGIN = "https://services.leadconnectorhq.com";
// Agency GHL IDs are configuration, never code: GHL_AGENCY_COMPANY_ID,
// GHL_AGENCY_INCREASE_ROAS_LOCATION_ID, GHL_AGENCY_HOT_TUB_LAUNCH_LOCATION_ID and
// GHL_ALEX_BLOOMFIELD_LOCATION_ID (register: brain/ops/agency-vs-client-accounts.md).
const DEFAULT_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 5 * 60 * 1_000;
const MAX_CACHE_ENTRIES = 64;
const MAX_CALENDARS_PER_LOCATION = 40;
const MAX_CONTACT_PAGES = 10;
const MAX_OPP_PAGES = 10;
const MAX_TX_PAGES = 10;
const TX_PAGE_LIMIT = 50;
const USER_AGENT = "paperclip-server/1.0";
const LOCATION_ID_RE = /^[A-Za-z0-9_-]{6,128}$/;
const UNSET_SENTINELS = new Set(["none", "unset", "unconfigured", "null"]);

/** Exclude recruiting/hiring pipelines and interview calendars from B2B sales metrics. */
const RECRUITING_RE = /\b(applicant|applicants|hiring|recruit(?:ing|ment)?|candidate|interview|careers?|job\s+application)\b/i;
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

function setCachedSummary(key: string, at: number, value: AgencySalesSummary): void {
  for (const [entryKey, entry] of cache.entries()) {
    const age = at - entry.at;
    if (age < 0 || age >= CACHE_TTL_MS) {
      cache.delete(entryKey);
    }
  }
  cache.delete(key);
  cache.set(key, { at, value });
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
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

function extractGhlNextCursor(body: Record<string, unknown>): {
  nextId: string | null;
  nextAfter: string | null;
} {
  const meta = isRecord(body.meta) ? body.meta : null;
  let nextId = typeof meta?.startAfterId === "string" && meta.startAfterId ? meta.startAfterId : null;
  let nextAfter =
    meta?.startAfter !== null && meta?.startAfter !== undefined && String(meta.startAfter) !== ""
      ? String(meta.startAfter)
      : null;

  if (!nextId && typeof meta?.nextPageUrl === "string" && meta.nextPageUrl) {
    try {
      const parsed = new URL(meta.nextPageUrl);
      const urlId = parsed.searchParams.get("startAfterId");
      const urlAfter = parsed.searchParams.get("startAfter");
      if (urlId) nextId = urlId;
      if (urlAfter) nextAfter = urlAfter;
    } catch {
      // Ignore malformed nextPageUrl values.
    }
  }
  return { nextId, nextAfter };
}

function isApplicantContact(contact: RawGhlContact): boolean {
  const tags = Array.isArray(contact.tags) ? contact.tags : [];
  return tags.some((tag) => typeof tag === "string" && RECRUITING_RE.test(tag));
}

function formatGhlDateParam(isoDay: string): string {
  const [yyyy, mm, dd] = isoDay.split("-");
  return yyyy && mm && dd ? `${mm}-${dd}-${yyyy}` : isoDay;
}

async function countRecentContacts(
  fetcher: LocationFetcher,
  win: PeriodWindow,
): Promise<{ ok: boolean; status: number; count: number; truncated: boolean }> {
  // Certified Lead (definitions/lead): once per person, applicants excluded.
  const candidates: LeadCandidate[] = [];
  let startAfterId: string | null = null;
  let startAfter: string | null = null;
  let firstStatus = 0;
  let truncated = false;
  let sawInWindow = false;

  for (let page = 0; page < MAX_CONTACT_PAGES; page += 1) {
    const qs = new URLSearchParams({ limit: "100" });
    if (startAfterId) qs.set("startAfterId", startAfterId);
    if (startAfter) qs.set("startAfter", startAfter);
    const res = await fetcher(`/contacts/?${qs.toString()}`);
    if (page === 0) firstStatus = res.status;
    if (res.status !== 200 || !res.body) {
      return { ok: false, status: res.status, count: 0, truncated: false };
    }
    const contacts = Array.isArray(res.body.contacts) ? (res.body.contacts as RawGhlContact[]) : [];
    if (contacts.length === 0) break;

    let allBeforeWindow = true;
    let prevMs: number | null = null;
    let strictlyDescending = false;
    let nonIncreasing = true;
    for (const c of contacts) {
      const ms = c.dateAdded ? Date.parse(c.dateAdded) : NaN;
      if (Number.isFinite(ms)) {
        if (prevMs !== null) {
          if (ms > prevMs) nonIncreasing = false;
          if (ms < prevMs) strictlyDescending = true;
        }
        prevMs = ms;
        if (ms >= win.startMs) {
          allBeforeWindow = false;
          if (ms <= win.endMs) {
            sawInWindow = true;
            candidates.push({ personKey: c.id, applicant: isApplicantContact(c) });
          }
        }
      } else {
        allBeforeWindow = false;
      }
    }

    if (allBeforeWindow && (sawInWindow || (nonIncreasing && strictlyDescending))) {
      break;
    }

    if (contacts.length < 100) break;
    const { nextId, nextAfter } = extractGhlNextCursor(res.body);
    if (!nextId || nextId === startAfterId) break;
    if (page === MAX_CONTACT_PAGES - 1) {
      truncated = true;
      break;
    }
    startAfterId = nextId;
    startAfter = nextAfter;
  }

  return { ok: firstStatus === 200, status: firstStatus, count: countLeads(candidates), truncated };
}

async function fetchOpportunityPages(
  fetcher: LocationFetcher,
  statusFilter: "all" | "won" | "lost",
  win?: PeriodWindow,
): Promise<{ ok: boolean; status: number; pages: Record<string, unknown>[]; truncated: boolean }> {
  const pages: Record<string, unknown>[] = [];
  let startAfterId: string | null = null;
  let startAfter: string | null = null;
  let firstStatus = 0;
  let truncated = false;

  for (let page = 0; page < MAX_OPP_PAGES; page += 1) {
    const qs = new URLSearchParams({ limit: "100", status: statusFilter });
    if (statusFilter === "all" && win) {
      qs.set("date", formatGhlDateParam(win.startDay));
      qs.set("endDate", formatGhlDateParam(win.endDay));
    }
    if (startAfterId) qs.set("startAfterId", startAfterId);
    if (startAfter) qs.set("startAfter", startAfter);
    const res = await fetcher(`/opportunities/search?${qs.toString()}`);
    if (page === 0) firstStatus = res.status;
    if (res.status !== 200 || !res.body) {
      return { ok: false, status: res.status, pages: [], truncated: false };
    }
    pages.push(res.body);
    const list = Array.isArray(res.body.opportunities) ? res.body.opportunities : [];
    if (list.length < 100) break;
    const { nextId, nextAfter } = extractGhlNextCursor(res.body);
    if (!nextId || nextId === startAfterId) break;
    if (page === MAX_OPP_PAGES - 1) {
      truncated = true;
      break;
    }
    startAfterId = nextId;
    startAfter = nextAfter;
  }

  return { ok: firstStatus === 200, status: firstStatus, pages, truncated };
}

async function readCalendarOutcomes(
  fetcher: LocationFetcher,
  win: PeriodWindow,
): Promise<{ ok: boolean; booked: number; showed: number; noShows: number; truncated: boolean }> {
  const listRes = await fetcher("/calendars/");
  if (listRes.status !== 200 || !listRes.body) {
    return { ok: false, booked: 0, showed: 0, noShows: 0, truncated: false };
  }
  const eligibleCalendars = (
    Array.isArray(listRes.body.calendars) ? (listRes.body.calendars as RawGhlCalendar[]) : []
  ).filter((cal) => typeof cal.id === "string" && cal.id && !RECRUITING_RE.test(cal.name ?? ""));
  const truncated = eligibleCalendars.length > MAX_CALENDARS_PER_LOCATION;
  const calendars = eligibleCalendars.slice(0, MAX_CALENDARS_PER_LOCATION);

  if (calendars.length === 0) {
    return { ok: true, booked: 0, showed: 0, noShows: 0, truncated: false };
  }

  // The request window ends now, so every returned event is past-dated; an
  // event without a start time falls back to the window start.
  const appointments: AppointmentRecord[] = [];
  for (let i = 0; i < calendars.length; i += 5) {
    const batch = calendars.slice(i, i + 5);
    const results = await Promise.all(
      batch.map((cal) =>
        fetcher(
          `/calendars/events?calendarId=${encodeURIComponent(cal.id!)}&startTime=${win.startMs}&endTime=${win.endMs}`,
        ),
      ),
    );
    for (const res of results) {
      if (res.status !== 200 || !res.body || !Array.isArray(res.body.events)) {
        return { ok: false, booked: 0, showed: 0, noShows: 0, truncated: false };
      }
      for (const rawEv of res.body.events as RawGhlCalendarEvent[]) {
        appointments.push({
          scheduledAt: rawEv.startTime ?? win.startMs,
          status: rawEv.appointmentStatus ?? rawEv.status,
          prospectKey: rawEv.contactId ?? null,
        });
      }
    }
  }

  // Certified Booked and Showed (definitions/booked, definitions/showed).
  const booked = bookedCounts(appointments, win.endMs).booked;
  const showed = countShowed(appointments, win);
  const noShows = appointments.filter((appointment) => appointmentStatus(appointment.status) === "no_show").length;
  return { ok: true, booked, showed, noShows, truncated };
}

interface SummarizedSalesOpportunities {
  activeOpportunities: number | null;
  wonDeals: number | null;
  lostDeals: number | null;
  pipelineWonUsd: number | null;
  stageBooked: number | null;
  stageShowed: number | null;
  stageNoShows: number | null;
  stagePitched: number | null;
}

function summarizeSalesOpportunities(
  pipelines: readonly RawGhlPipeline[],
  pages: {
    allPages: readonly Record<string, unknown>[] | null;
    wonPages: readonly Record<string, unknown>[] | null;
    lostPages: readonly Record<string, unknown>[] | null;
  },
  win: PeriodWindow,
): SummarizedSalesOpportunities {
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

  const hasAll = pages.allPages !== null;
  const hasWon = pages.wonPages !== null;
  const hasLost = pages.lostPages !== null;

  const deduped = new Map<string, RawGhlOpportunity>();
  for (const group of [pages.allPages, pages.wonPages, pages.lostPages]) {
    if (!group) continue;
    for (const body of group) {
      const list = Array.isArray(body.opportunities) ? (body.opportunities as RawGhlOpportunity[]) : [];
      for (const opp of list) {
        if (opp.id) deduped.set(opp.id, opp);
      }
    }
  }

  let activeOpportunities = 0;
  let wonDeals = 0;
  let lostDeals = 0;
  let pipelineWonUsd = 0;
  let stageBooked = 0;
  let stageShowed = 0;
  let stageNoShows = 0;
  let stagePitched = 0;

  for (const opp of deduped.values()) {
    if (opp.pipelineId && excludedPipelineIds.has(opp.pipelineId)) continue;
    const status = String(opp.status ?? "").trim().toLowerCase();
    const statusTs = opp.lastStatusChangeAt ?? opp.updatedAt ?? opp.createdAt;
    const inPeriodActivity = isTimestampInWindow(opp.createdAt, win) || isTimestampInWindow(opp.updatedAt, win);
    const inPeriodStatus = isTimestampInWindow(statusTs, win);
    const isWonInPeriod = status === "won" && inPeriodStatus;

    if (hasAll && inPeriodActivity) {
      activeOpportunities += 1;
      const stageName = opp.pipelineStageId ? (stageNameById.get(opp.pipelineStageId) ?? "") : "";
      const isNoShow = NO_SHOW_STAGE_RE.test(stageName);
      const isLostStage = LOST_STAGE_RE.test(stageName);
      const oppShowed = !isNoShow && !isLostStage && (SHOWED_STAGE_RE.test(stageName) || isWonInPeriod);
      const oppPitched =
        !isNoShow &&
        !NO_PITCH_STAGE_RE.test(stageName) &&
        !isLostStage &&
        (PITCHED_STAGE_RE.test(stageName) || isWonInPeriod);
      const oppBooked = BOOKED_STAGE_RE.test(stageName) || oppShowed || oppPitched || isNoShow;

      if (oppBooked) stageBooked += 1;
      if (oppShowed) stageShowed += 1;
      if (isNoShow) stageNoShows += 1;
      if (oppPitched) stagePitched += 1;
    }

    if (hasWon && isWonInPeriod) {
      wonDeals += 1;
      pipelineWonUsd += parseMoney(opp.monetaryValue);
    } else if (hasLost && status === "lost" && inPeriodStatus) {
      lostDeals += 1;
    }
  }

  const finalStagePitched = hasAll ? (hasWon ? Math.max(stagePitched, wonDeals) : stagePitched) : null;
  const finalStageShowed = hasAll ? (hasWon ? Math.max(stageShowed, wonDeals) : stageShowed) : null;
  const finalStageNoShows = hasAll ? stageNoShows : null;
  const finalStageBooked =
    hasAll && finalStageShowed !== null && finalStageNoShows !== null
      ? Math.max(stageBooked, finalStageShowed + finalStageNoShows)
      : null;

  return {
    activeOpportunities: hasAll ? activeOpportunities : null,
    wonDeals: hasWon ? wonDeals : null,
    lostDeals: hasLost ? lostDeals : null,
    pipelineWonUsd: hasWon ? round2(pipelineWonUsd) : null,
    stageBooked: finalStageBooked,
    stageShowed: finalStageShowed,
    stageNoShows: finalStageNoShows,
    stagePitched: finalStagePitched,
  };
}

async function fetchWindowTransactions(
  fetcher: LocationFetcher,
  win: PeriodWindow,
): Promise<{ ok: boolean; status: number; totalUsd: number | null; truncated: boolean }> {
  const seenIds = new Set<string>();
  let total = 0;
  let firstStatus = 0;
  let truncated = false;

  for (let page = 0; page < MAX_TX_PAGES; page += 1) {
    const offset = page * TX_PAGE_LIMIT;
    const qs = new URLSearchParams({
      limit: String(TX_PAGE_LIMIT),
      paymentMode: "live",
      startAt: win.startDay,
      endAt: win.endDay,
    });
    if (offset > 0) qs.set("offset", String(offset));
    const res = await fetcher(`/payments/transactions?${qs.toString()}`);
    if (page === 0) firstStatus = res.status;
    if (res.status !== 200 || !res.body || !Array.isArray(res.body.data)) {
      return { ok: false, status: res.status, totalUsd: null, truncated: false };
    }

    const pageRows = res.body.data as RawGhlTransaction[];
    for (const rawTx of pageRows) {
      if (typeof rawTx.id === "string" && rawTx.id) {
        if (seenIds.has(rawTx.id)) continue;
        seenIds.add(rawTx.id);
      }
      if (rawTx.liveMode === false || String(rawTx.liveMode ?? "").trim().toLowerCase() === "false") {
        continue;
      }
      const currency = typeof rawTx.currency === "string" ? rawTx.currency.trim().toUpperCase() : "USD";
      if (currency && currency !== "USD") continue;
      const st = String(rawTx.status ?? "").trim().toLowerCase();
      if (st && !isClearedPayment(st)) continue;
      if (!isTimestampInWindow(rawTx.createdAt, win)) continue;
      const amount = parseMoney(rawTx.amount);
      const refunded = parseMoney(rawTx.amountRefunded);
      total += Math.max(0, amount - refunded);
    }

    if (pageRows.length < TX_PAGE_LIMIT) break;
    const totalCount =
      typeof res.body.totalCount === "number" && Number.isFinite(res.body.totalCount)
        ? res.body.totalCount
        : null;
    if (totalCount !== null && offset + pageRows.length >= totalCount) break;
    if (page === MAX_TX_PAGES - 1) {
      truncated = true;
      break;
    }
  }

  return { ok: firstStatus === 200, status: firstStatus, totalUsd: round2(total), truncated };
}

function computeRates(m: {
  booked: number | null;
  showed: number | null;
  noShows: number | null;
  pitched: number | null;
  wonDeals: number | null;
  lostDeals: number | null;
}) {
  // Certified formulas (ir-metrics). `booked` here counts only non-cancelled
  // events scheduled inside [period start, now], i.e. past-dated booked.
  return {
    showRate: showRate({ pastDatedBooked: m.booked, showed: m.showed }),
    offerRate: offerRate(m),
    closeRate: closeRate({ wonDeals: m.wonDeals, showed: m.showed }),
  };
}

interface AccountTruncationFlags {
  contacts: boolean;
  oppsAll: boolean;
  oppsWon: boolean;
  oppsLost: boolean;
  outcomes: boolean;
  transactions: boolean;
}

interface SingleAccountRead {
  metrics: AgencySalesAccountMetrics;
  truncated: AccountTruncationFlags;
}

const NO_TRUNCATION: AccountTruncationFlags = {
  contacts: false,
  oppsAll: false,
  oppsWon: false,
  oppsLost: false,
  outcomes: false,
  transactions: false,
};

async function readSingleGhlAccount(
  spec: { id: string; displayName: string; locationId: string; authMode: "gateway" | "pit" },
  fetcher: LocationFetcher,
  win: PeriodWindow,
  observedAt: string,
): Promise<SingleAccountRead> {
  const [pipelinesRes, oppsAllRes, oppsWonRes, oppsLostRes, contactsRes, calRes, txRes] = await Promise.all([
    fetcher("/opportunities/pipelines"),
    fetchOpportunityPages(fetcher, "all", win),
    fetchOpportunityPages(fetcher, "won"),
    fetchOpportunityPages(fetcher, "lost"),
    countRecentContacts(fetcher, win),
    readCalendarOutcomes(fetcher, win),
    fetchWindowTransactions(fetcher, win),
  ]);

  const pipelinesOk =
    pipelinesRes.status === 200 && pipelinesRes.body !== null && Array.isArray(pipelinesRes.body.pipelines);
  const anyUsable = pipelinesOk || contactsRes.ok || calRes.ok;
  if (!anyUsable) {
    const statuses = [
      pipelinesRes.status,
      oppsAllRes.status,
      oppsWonRes.status,
      oppsLostRes.status,
      contactsRes.status,
      txRes.status,
    ];
    const authFailed = statuses.some((s) => s === 400 || s === 401 || s === 403 || s === 404);
    return {
      metrics: emptyAccount(
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
      ),
      truncated: NO_TRUNCATION,
    };
  }

  // Fail closed on recruiting pipeline exclusion: only read opportunities when
  // /opportunities/pipelines succeeded so recruiting pipelines can never leak in.
  const opps: SummarizedSalesOpportunities | null = pipelinesOk
    ? summarizeSalesOpportunities(
        pipelinesRes.body!.pipelines as RawGhlPipeline[],
        {
          allPages: oppsAllRes.ok ? oppsAllRes.pages : null,
          wonPages: oppsWonRes.ok ? oppsWonRes.pages : null,
          lostPages: oppsLostRes.ok ? oppsLostRes.pages : null,
        },
        win,
      )
    : null;

  // Keep booked, showed, and noShows sourced consistently from either calendars
  // or opportunity stages — never mix calendar booked with stage showed.
  let booked: number | null = null;
  let showed: number | null = null;
  let noShows: number | null = null;
  let outcomesTruncated = false;
  if (calRes.ok && calRes.booked > 0) {
    booked = calRes.booked;
    showed = calRes.showed;
    noShows = calRes.noShows;
    outcomesTruncated = calRes.truncated;
  } else if (opps && opps.stageBooked !== null) {
    booked = opps.stageBooked;
    showed = opps.stageShowed;
    noShows = opps.stageNoShows;
    outcomesTruncated = oppsAllRes.truncated || oppsWonRes.truncated;
  } else if (calRes.ok) {
    booked = 0;
    showed = 0;
    noShows = 0;
    outcomesTruncated = calRes.truncated;
  }

  const pitched = opps ? opps.stagePitched : null;
  const wonDeals = opps ? opps.wonDeals : null;
  const lostDeals = opps ? opps.lostDeals : null;
  const pipelineWonUsd = opps ? opps.pipelineWonUsd : null;
  const activeOpportunities = opps ? opps.activeOpportunities : null;
  const cashCollectedUsd = txRes.ok ? txRes.totalUsd : null;
  const rates = computeRates({
    booked,
    showed,
    noShows,
    pitched,
    wonDeals,
    lostDeals,
  });

  const isPartial =
    contactsRes.truncated ||
    oppsAllRes.truncated ||
    oppsWonRes.truncated ||
    oppsLostRes.truncated ||
    calRes.truncated ||
    txRes.truncated ||
    !pipelinesOk ||
    !oppsAllRes.ok ||
    !oppsWonRes.ok ||
    !oppsLostRes.ok ||
    !contactsRes.ok ||
    !calRes.ok ||
    !txRes.ok;

  return {
    metrics: {
      id: spec.id,
      displayName: spec.displayName,
      locationId: spec.locationId,
      authMode: spec.authMode,
      status: "live",
      statusLabel: isPartial ? "Live (partial)" : "Live",
      observedAt,
      newLeads: contactsRes.ok ? contactsRes.count : null,
      activeOpportunities,
      booked,
      showed,
      noShows,
      pitched,
      wonDeals,
      lostDeals,
      pipelineWonUsd,
      cashCollectedUsd,
      showRate: rates.showRate,
      offerRate: rates.offerRate,
      closeRate: rates.closeRate,
    },
    truncated: {
      contacts: contactsRes.truncated,
      oppsAll: oppsAllRes.truncated,
      oppsWon: oppsWonRes.truncated,
      oppsLost: oppsLostRes.truncated,
      outcomes: outcomesTruncated,
      transactions: txRes.truncated,
    },
  };
}

function sumCompleteLiveMetric(
  live: readonly SingleAccountRead[],
  pick: (account: AgencySalesAccountMetrics) => number | null,
  isTruncated: (flags: AccountTruncationFlags) => boolean,
): number | null {
  let total = 0;
  for (const entry of live) {
    if (isTruncated(entry.truncated)) return null;
    const val = pick(entry.metrics);
    if (val === null) return null;
    total += val;
  }
  return total;
}

function summarizeAgencySales(
  period: DashboardPeriod,
  observedAt: string,
  reads: readonly SingleAccountRead[],
): AgencySalesSummary {
  const accounts = reads.map((r) => r.metrics);
  const live = reads.filter((r) => r.metrics.status === "live");
  const hasTransientError = reads.some((r) => r.metrics.status === "error");
  if (live.length === 0 || hasTransientError) {
    return {
      period,
      observedAt,
      liveAccountCount: live.length,
      totalAccountCount: accounts.length,
      hasGhl: live.length > 0,
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

  // Require every live account to supply an untruncated metric before publishing
  // a headline total or derived rate — partial/truncated totals never masquerade
  // as full agency sums, and numerators/denominators always share the exact same
  // complete account set.
  const newLeads = sumCompleteLiveMetric(live, (a) => a.newLeads, (t) => t.contacts);
  const activeOpportunities = sumCompleteLiveMetric(live, (a) => a.activeOpportunities, (t) => t.oppsAll);
  const booked = sumCompleteLiveMetric(live, (a) => a.booked, (t) => t.outcomes);
  const showed = sumCompleteLiveMetric(live, (a) => a.showed, (t) => t.outcomes);
  const noShows = sumCompleteLiveMetric(live, (a) => a.noShows, (t) => t.outcomes);
  const pitched = sumCompleteLiveMetric(live, (a) => a.pitched, (t) => t.oppsAll || t.oppsWon);
  const wonDeals = sumCompleteLiveMetric(live, (a) => a.wonDeals, (t) => t.oppsWon);
  const lostDeals = sumCompleteLiveMetric(live, (a) => a.lostDeals, (t) => t.oppsLost);
  const rawPipelineWonUsd = sumCompleteLiveMetric(live, (a) => a.pipelineWonUsd, (t) => t.oppsWon);
  const rawCashCollectedUsd = sumCompleteLiveMetric(live, (a) => a.cashCollectedUsd, (t) => t.transactions);
  const rates = computeRates({
    booked,
    showed,
    noShows,
    pitched,
    wonDeals,
    lostDeals,
  });

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
    pipelineWonUsd: rawPipelineWonUsd !== null ? round2(rawPipelineWonUsd) : null,
    cashCollectedUsd: rawCashCollectedUsd !== null ? round2(rawCashCollectedUsd) : null,
    showRate: rates.showRate,
    offerRate: rates.offerRate,
    closeRate: rates.closeRate,
    setRate: setRate({ newLeads, booked }),
    leadToCustomerRate: leadToCustomerRate({ newLeads, wonDeals }),
    accounts,
  };
}

function resolvePrimaryLocationId(
  key: "increaseRoasMain" | "hotTubLaunchB2b",
  envVar: string,
  opts: AgencySalesClientOptions,
): string | null {
  if (opts.locationIds && Object.prototype.hasOwnProperty.call(opts.locationIds, key)) {
    return normalizeLocationId(opts.locationIds[key]);
  }
  return normalizeLocationId(process.env[envVar]);
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
  const alexLocationId =
    opts.alexBloomfieldLocationId !== undefined
      ? normalizeLocationId(opts.alexBloomfieldLocationId)
      : process.env.GHL_ALEX_BLOOMFIELD_LOCATION_ID !== undefined
        ? normalizeLocationId(process.env.GHL_ALEX_BLOOMFIELD_LOCATION_ID)
        : null;

  if (!gatewayToken && !alexPitKey) return null;

  const gatewayBaseUrl = (opts.gatewayBaseUrl ?? process.env.OAUTH_GATEWAY_URL ?? DEFAULT_GATEWAY_URL)
    .trim()
    .replace(/\/+$/, "");
  const ghlOrigin = (opts.ghlDirectOrigin ?? DEFAULT_GHL_ORIGIN).trim().replace(/\/+$/, "");
  const companyId = (opts.agencyCompanyId ?? process.env.GHL_AGENCY_COMPANY_ID ?? "").trim();
  const irMainLoc = resolvePrimaryLocationId(
    "increaseRoasMain",
    "GHL_AGENCY_INCREASE_ROAS_LOCATION_ID",
    opts,
  );
  const htlLoc = resolvePrimaryLocationId(
    "hotTubLaunchB2b",
    "GHL_AGENCY_HOT_TUB_LAUNCH_LOCATION_ID",
    opts,
  );

  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = (opts.now ?? (() => new Date()))();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fp = createHash("sha256")
    .update(
      `${gatewayToken}|${companyId}|${ghlOrigin}|${alexPitKey}|${alexLocationId ?? ""}|${irMainLoc ?? ""}|${htlLoc ?? ""}`,
    )
    .digest("hex")
    .slice(0, 16);
  const cacheKey = `${gatewayBaseUrl}|${period}|${fp}`;

  if (!opts.bypassCache) {
    const hit = cache.get(cacheKey);
    if (hit) {
      const age = now.getTime() - hit.at;
      if (age >= 0 && age < CACHE_TTL_MS) return hit.value;
    }
  }

  const win = buildPeriodWindow(period, now);
  const observedAt = now.toISOString();

  const tasks: Array<Promise<SingleAccountRead>> = [
    gatewayToken && companyId && irMainLoc
      ? readSingleGhlAccount(
          { id: "increase-roas-main", displayName: "Increase ROAS Main", locationId: irMainLoc, authMode: "gateway" },
          createGatewayLocationFetcher(gatewayBaseUrl, gatewayToken, companyId, irMainLoc, fetchImpl, timeoutMs),
          win,
          observedAt,
        )
      : Promise.resolve({
          metrics: emptyAccount(
            "increase-roas-main",
            "Increase ROAS Main",
            irMainLoc,
            "gateway",
            "needs_config",
            !irMainLoc ? "Needs location ID" : !companyId ? "Needs agency company ID" : "Needs gateway token",
          ),
          truncated: NO_TRUNCATION,
        }),
    gatewayToken && companyId && htlLoc
      ? readSingleGhlAccount(
          { id: "hot-tub-launch-b2b", displayName: "Hot Tub Launch B2B", locationId: htlLoc, authMode: "gateway" },
          createGatewayLocationFetcher(gatewayBaseUrl, gatewayToken, companyId, htlLoc, fetchImpl, timeoutMs),
          win,
          observedAt,
        )
      : Promise.resolve({
          metrics: emptyAccount(
            "hot-tub-launch-b2b",
            "Hot Tub Launch B2B",
            htlLoc,
            "gateway",
            "needs_config",
            !htlLoc ? "Needs location ID" : !companyId ? "Needs agency company ID" : "Needs gateway token",
          ),
          truncated: NO_TRUNCATION,
        }),
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
      : Promise.resolve({
          metrics: emptyAccount(
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
          truncated: NO_TRUNCATION,
        }),
  ];

  const reads = await Promise.all(tasks);
  const summary = summarizeAgencySales(period, observedAt, reads);

  const hasDegradedAccount = summary.accounts.some(
    (a) => a.status === "error" || a.statusLabel === "Live (partial)",
  );
  if (summary.liveAccountCount > 0 && !hasDegradedAccount && !opts.bypassCache) {
    setCachedSummary(cacheKey, now.getTime(), summary);
  }
  return summary;
}
