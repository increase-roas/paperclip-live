import type { DashboardPeriod } from "@paperclipai/shared";

export interface WavvSetterStats {
  id: string;
  setter: string;
  dials: number;
  talkTimeMinutes: number;
  conversationsOver60s: number;
}

export interface WavvSummary {
  observedAt: string;
  dials: number;
  conversationsOver60s: number;
  talkTimeMinutes: number;
  bySetter: WavvSetterStats[];
}

export interface WavvClientOptions {
  baseUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}

const DEFAULT_GATEWAY_URL = "https://increase-roas-oauth-gateway.increase-roas.workers.dev";
const DEFAULT_TIMEOUT_MS = 6_000;
const USER_AGENT = "paperclip-server/1.0";
const MAX_TEAMS_FALLBACK = 5;

interface RawWavvCall {
  id?: string;
  team?: string;
  direction?: string;
  userId?: string;
  setter_user_id?: string;
  userName?: string;
  setterName?: string;
  seconds?: number;
  duration?: number;
  duration_seconds?: number;
  startedAt?: string;
  started_at?: string;
}

function periodStartIso(period: DashboardPeriod, now: Date): string {
  if (period === "month") {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  }
  const days = period === "7d" ? 7 : 30;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function safeDurationSeconds(call: RawWavvCall): number {
  const raw = call.seconds ?? call.duration ?? call.duration_seconds ?? 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function isOutboundCall(call: RawWavvCall): boolean {
  if (!call.direction) return true;
  return call.direction.trim().toLowerCase() !== "inbound";
}

function summarizeCalls(calls: RawWavvCall[], now: Date): WavvSummary | null {
  if (calls.length === 0) return null;

  let dials = 0;
  let conversationsOver60s = 0;
  let totalTalkSeconds = 0;
  let latestMs = 0;
  let latestIso: string | null = null;

  const setters = new Map<
    string,
    { id: string; setter: string; dials: number; talkSeconds: number; conversationsOver60s: number }
  >();

  for (const call of calls) {
    const durationSec = safeDurationSeconds(call);
    const outbound = isOutboundCall(call);
    const over60 = durationSec > 60;

    if (outbound) dials += 1;
    if (over60) conversationsOver60s += 1;
    totalTalkSeconds += durationSec;

    const startedRaw = call.startedAt ?? call.started_at;
    if (typeof startedRaw === "string" && startedRaw) {
      const parsedMs = Date.parse(startedRaw);
      if (Number.isFinite(parsedMs) && parsedMs > latestMs) {
        latestMs = parsedMs;
        latestIso = new Date(parsedMs).toISOString();
      }
    }

    const setterId = String(call.userId ?? call.setter_user_id ?? call.team ?? "unassigned");
    const setterName = String(
      call.userName ?? call.setterName ?? call.userId ?? call.setter_user_id ?? call.team ?? "Unassigned",
    );
    const entry = setters.get(setterId) ?? {
      id: setterId,
      setter: setterName,
      dials: 0,
      talkSeconds: 0,
      conversationsOver60s: 0,
    };
    if (outbound) entry.dials += 1;
    if (over60) entry.conversationsOver60s += 1;
    entry.talkSeconds += durationSec;
    setters.set(setterId, entry);
  }

  return {
    observedAt: latestIso ?? now.toISOString(),
    dials,
    conversationsOver60s,
    talkTimeMinutes: Math.round((totalTalkSeconds / 60) * 10) / 10,
    bySetter: [...setters.values()]
      .sort((a, b) => b.dials - a.dials || b.talkSeconds - a.talkSeconds)
      .map((entry) => ({
        id: entry.id,
        setter: entry.setter,
        dials: entry.dials,
        talkTimeMinutes: Math.round((entry.talkSeconds / 60) * 10) / 10,
        conversationsOver60s: entry.conversationsOver60s,
      })),
  };
}

async function fetchGatewayJson<T>(
  url: string,
  token: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "user-agent": USER_AGENT,
      },
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

/**
 * Reads live WAVV dialer call activity through the Increase ROAS OAuth Gateway.
 *
 * Uses `process.env.GATEWAY_PAPERCLIP_KEY` (with fallback to `process.env.GATEWAY_WAVV_KEY`).
 * Reads D1-captured calls via `GET /api/wavv/captured` first (zero upstream WAVV quota),
 * then falls back to `GET /api/wavv/teams` + `GET /api/wavv/:team/calls` when needed.
 *
 * Fails closed to `null` when unconfigured, unreachable, or when no real WAVV call data
 * is returned so the Sales board never invents `Dials: 0`.
 */
export async function readWavvSummary(
  period: DashboardPeriod = "30d",
  opts: WavvClientOptions = {},
): Promise<WavvSummary | null> {
  const token = (
    opts.token !== undefined
      ? opts.token
      : (process.env.GATEWAY_PAPERCLIP_KEY ?? process.env.GATEWAY_WAVV_KEY ?? "")
  ).trim();
  if (!token) return null;

  const baseUrl = (opts.baseUrl ?? process.env.OAUTH_GATEWAY_URL ?? DEFAULT_GATEWAY_URL)
    .trim()
    .replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = (opts.now ?? (() => new Date()))();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sinceIso = periodStartIso(period, now);

  // 1. Prefer gateway D1-captured webhook calls (fast, no upstream WAVV quota)
  const captured = await fetchGatewayJson<{ calls?: RawWavvCall[] }>(
    `${baseUrl}/api/wavv/captured?since=${encodeURIComponent(sinceIso)}&limit=1000`,
    token,
    fetchImpl,
    timeoutMs,
  );
  if (captured && Array.isArray(captured.calls) && captured.calls.length > 0) {
    return summarizeCalls(captured.calls, now);
  }

  // 2. Fall back to live WAVV team call reads through /api/wavv/teams + /api/wavv/:team/calls
  const teamsPayload = await fetchGatewayJson<{ teams?: string[] }>(
    `${baseUrl}/api/wavv/teams`,
    token,
    fetchImpl,
    timeoutMs,
  );
  const teams = Array.isArray(teamsPayload?.teams)
    ? teamsPayload.teams.filter((t): t is string => typeof t === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(t)).slice(0, MAX_TEAMS_FALLBACK)
    : [];
  if (teams.length === 0) return null;

  const perTeamResults = await Promise.all(
    teams.map((team) =>
      fetchGatewayJson<{ team?: string; data?: RawWavvCall[] }>(
        `${baseUrl}/api/wavv/${encodeURIComponent(team)}/calls?startedAfter=${encodeURIComponent(sinceIso)}&limit=200`,
        token,
        fetchImpl,
        timeoutMs,
      ),
    ),
  );

  const combined: RawWavvCall[] = [];
  for (const res of perTeamResults) {
    if (res && Array.isArray(res.data)) {
      for (const call of res.data) {
        combined.push({ ...call, team: call.team ?? res.team });
      }
    }
  }

  return summarizeCalls(combined, now);
}
