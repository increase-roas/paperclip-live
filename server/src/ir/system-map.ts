import { Router, type Response } from "express";
import {
  freshnessOf,
  type Freshness,
  type GbrainSkeletonResponse,
  type ProofCheckResult,
  type ProofChecksFeed,
  type ProofChecksResponse,
  type SystemMapResponse,
} from "@paperclipai/shared/ir-system-map";
import { assertInstanceAdmin } from "../routes/authz.js";
import { isProofChecksFeed, isSkeletonFeed, isSystemMapFeed } from "./system-feed-validation.js";

/**
 * Reads the brain-vps `ir-system-feed` (company-ops `tools/ir-system-feed`)
 * over the tailnet. The feed key never leaves the server; every route here is
 * gated to board instance admins (LESSONS #18).
 */
export interface SystemFeedOptions {
  baseUrl?: string;
  key?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

type FeedResult<T> = { ok: true; body: T } | { ok: false; status: number; error: string; code: string };

const DEFAULT_TIMEOUT_MS = 8_000;
const PROOF_CACHE_MS = 60_000;

function resolveConfig(opts?: SystemFeedOptions) {
  const baseUrl = (opts?.baseUrl ?? process.env.IR_SYSTEM_FEED_URL ?? "").trim().replace(/\/+$/, "");
  const key = (opts?.key ?? process.env.IR_SYSTEM_FEED_KEY ?? "").trim();
  return { baseUrl, key };
}

export async function readSystemFeed<T>(
  path: string,
  validate: (value: unknown) => value is T,
  opts?: SystemFeedOptions,
): Promise<FeedResult<T>> {
  const { baseUrl, key } = resolveConfig(opts);
  if (!baseUrl || !key) {
    return { ok: false, status: 503, code: "ir_system_feed_not_configured", error: "The live system feed is not configured on this server." };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await (opts?.fetchImpl ?? fetch)(`${baseUrl}${path}`, {
      headers: { accept: "application/json", authorization: `Bearer ${key}`, "user-agent": "paperclip-server/1.0" },
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status === 503) {
      return { ok: false, status: 503, code: "ir_system_feed_warming_up", error: "The live system feed is still loading. Try again in a minute." };
    }
    if (!response.ok) {
      return { ok: false, status: 502, code: "ir_system_feed_upstream_error", error: `The live system feed answered HTTP ${response.status}.` };
    }
    const body: unknown = await response.json().catch(() => null);
    if (!validate(body)) {
      return { ok: false, status: 502, code: "ir_system_feed_bad_shape", error: "The live system feed returned an unexpected shape." };
    }
    return { ok: true, body };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      status: aborted ? 504 : 502,
      code: aborted ? "ir_system_feed_timeout" : "ir_system_feed_unreachable",
      error: aborted ? "The live system feed timed out." : "Could not reach the live system feed.",
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface ProofCheckSnapshot {
  checks: ProofCheckResult[];
  freshness: Freshness;
}

function proofFreshness(feed: ProofChecksFeed, now: Date): Freshness {
  return freshnessOf(feed.generatedAt, now);
}

let proofCache: { at: number; snapshot: ProofCheckSnapshot } | null = null;
let proofRefresher: ReturnType<typeof setInterval> | null = null;

/** Live proof-check results, cached briefly so issue closure stays fast. Null when unreachable. */
export async function readProofCheckSnapshot(opts?: SystemFeedOptions): Promise<ProofCheckSnapshot | null> {
  const now = opts?.now?.() ?? new Date();
  if (proofCache && now.getTime() - proofCache.at < PROOF_CACHE_MS) return proofCache.snapshot;
  const result = await readSystemFeed("/v1/proof-checks", isProofChecksFeed, { timeoutMs: 5_000, ...opts });
  if (!result.ok) return null;
  const snapshot = { checks: result.body.checks, freshness: proofFreshness(result.body, now) };
  proofCache = { at: now.getTime(), snapshot };
  return snapshot;
}

/**
 * The last proof-check snapshot, without any network call. Issue closure reads
 * this inside its transaction; freshness is re-checked there, so an old cache
 * fails closed.
 */
export function cachedProofCheckSnapshot(): ProofCheckSnapshot | null {
  return proofCache?.snapshot ?? null;
}

/** Keeps the proof-check cache warm (every minute) when the feed is configured. */
export function startProofCheckRefresher(opts?: SystemFeedOptions): void {
  const { baseUrl, key } = resolveConfig(opts);
  if (proofRefresher || !baseUrl || !key) return;
  const refresh = () => {
    void readProofCheckSnapshot(opts).then((snapshot) => {
      if (!snapshot) proofCache = null;
    }).catch(() => { proofCache = null; });
  };
  refresh();
  proofRefresher = setInterval(refresh, PROOF_CACHE_MS);
  proofRefresher.unref?.();
}

export function resetProofCheckCache(): void {
  proofCache = null;
  if (proofRefresher) clearInterval(proofRefresher);
  proofRefresher = null;
}

function sendFailure(res: Response, result: Extract<FeedResult<unknown>, { ok: false }>) {
  res.status(result.status).json({ ok: false, error: result.error, code: result.code });
}

export function systemMapRoutes(opts?: SystemFeedOptions) {
  const router = Router();
  const now = () => opts?.now?.() ?? new Date();

  router.get("/ir/system-map", async (req, res) => {
    assertInstanceAdmin(req);
    const result = await readSystemFeed("/v1/system-map", isSystemMapFeed, opts);
    if (!result.ok) return sendFailure(res, result);
    const body: SystemMapResponse = {
      feed: result.body,
      freshness: freshnessOf(result.body.doctor.observedAt, now()),
    };
    res.setHeader("cache-control", "no-store");
    res.json(body);
  });

  router.get("/ir/system-map/gbrain-skeleton", async (req, res) => {
    assertInstanceAdmin(req);
    const result = await readSystemFeed("/v1/gbrain/skeleton", isSkeletonFeed, opts);
    if (!result.ok) return sendFailure(res, result);
    const body: GbrainSkeletonResponse = { skeleton: result.body, freshness: freshnessOf(result.body.generatedAt, now()) };
    res.setHeader("cache-control", "no-store");
    res.json(body);
  });

  router.get("/ir/proof-checks", async (req, res) => {
    assertInstanceAdmin(req);
    const result = await readSystemFeed("/v1/proof-checks", isProofChecksFeed, opts);
    if (!result.ok) return sendFailure(res, result);
    const body: ProofChecksResponse = { checks: result.body.checks, freshness: proofFreshness(result.body, now()) };
    res.setHeader("cache-control", "no-store");
    res.json(body);
  });

  return router;
}
