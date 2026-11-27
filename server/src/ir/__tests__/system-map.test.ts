import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proofCheckAllowsClosure, type GbrainSkeletonFeed } from "@paperclipai/shared/ir-system-map";
import { errorHandler } from "../../middleware/error-handler.js";
import {
  cachedProofCheckSnapshot,
  readProofCheckSnapshot,
  resetProofCheckCache,
  startProofCheckRefresher,
  systemMapRoutes,
  type SystemFeedOptions,
} from "../system-map.js";

const NOW = new Date("2026-11-26T18:00:00.000Z");

const ADMIN = { type: "board", userId: "u-admin", source: "session", isInstanceAdmin: true, companyIds: ["c1"] } as Express.Request["actor"];
const MEMBER = { type: "board", userId: "u-member", source: "session", isInstanceAdmin: false, companyIds: ["c1"] } as Express.Request["actor"];
const AGENT = { type: "agent", agentId: "a1", companyId: "c1", source: "agent_key" } as Express.Request["actor"];

const SYSTEM_MAP = {
  feedVersion: "1",
  generatedAt: "2026-11-26T17:58:00Z",
  doctor: {
    observedAt: "2026-11-26T17:58:00Z",
    overallStatus: "yellow",
    anomalies: ["db_feeds:snapshots_fail:401"],
    checks: [{ key: "gateway", status: "green", anomalies: [] }],
    error: null,
  },
  hosts: [{ key: "brain-vps", label: "brain-vps", role: "GBrain", services: ["gbrain_alert"] }],
  services: [{ key: "gbrain_alert", label: "GBrain", host: "brain-vps", status: "ok", detail: "rc=0", latencyMs: null }],
  registers: [{ name: "tools", path: "registers/tools.yaml", entries: 1, updatedAt: "2026-11-26T17:58:00Z" }],
  sources: [{ key: "ir-doctor", label: "Health checks", observedAt: "2026-11-26T17:58:00Z", detail: null }],
};

const SKELETON: GbrainSkeletonFeed = {
  generatedAt: NOW.toISOString(),
  pack: { name: "test", version: "1", identity: null, description: null },
  requiredFieldsVersion: null,
  requiredFolders: [{ prefix: "companies/", fields: ["title"], pages: 1, violations: 0 }],
  totals: { totalPages: 1, typedPages: 1, undeclaredPages: 0, coverage: 1 },
  pageTypes: [{ name: "company", primitive: "entity", pathPrefixes: ["companies/"], aliases: [], count: 1, violationCount: 0 }],
  linkTypes: [{ name: "customer_of", inverse: "customers" }],
  edges: [{ fromType: "company", toType: "brand", count: 1 }],
  lint: { ok: true, errors: [], warningCount: 0 },
  violations: {
    brokenLinks: { count: 0, sample: [] }, missingRequired: { count: 0, sample: [] },
    undeclaredTypes: { count: 0, sample: [] }, invalidBrands: { count: 0, sample: [] },
  },
  definitions: [{ slug: "definitions/show-rate", title: "Show rate", term: "Show rate", brands: ["IR"], calculation: "ir-metrics#showRate", certified: true }],
  brands: [{ slug: "brands/increase-roas", code: "IR", title: "Increase ROAS", company: null }],
  clients: [{ slug: "companies/example", title: "Example", aliases: ["example"], brands: ["IR"] }],
};

function proofFeed(status = "pass", generatedAt = NOW.toISOString()) {
  return { generatedAt, checks: [{ key: "gateway", status, detail: null, observedAt: generatedAt }] };
}

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeApp(actor: Express.Request["actor"], opts: SystemFeedOptions) {
  const app = express();
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", systemMapRoutes({ now: () => NOW, ...opts }));
  app.use(errorHandler);
  return app;
}

afterEach(() => {
  resetProofCheckCache();
  vi.useRealTimers();
});

describe("systemMapRoutes", () => {
  it("is instance-admin only and never calls the feed for members or agents", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const opts = { baseUrl: "https://feed.example", key: "feed-key", fetchImpl };
    expect((await request(makeApp(MEMBER, opts)).get("/api/ir/system-map")).status).toBe(403);
    expect((await request(makeApp(AGENT, opts)).get("/api/ir/system-map/gbrain-skeleton")).status).toBe(403);
    expect((await request(makeApp(AGENT, opts)).get("/api/ir/proof-checks")).status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns 503 with a clear code when the feed is not configured", async () => {
    const res = await request(makeApp(ADMIN, { baseUrl: "", key: "" })).get("/api/ir/system-map");
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("ir_system_feed_not_configured");
  });

  it("proxies the live feed with the server-held key and adds data age", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonRes(SYSTEM_MAP));
    const res = await request(makeApp(ADMIN, { baseUrl: "https://feed.example/", key: "feed-key", fetchImpl })).get("/api/ir/system-map");
    expect(res.status).toBe(200);
    expect(res.body.feed.doctor.overallStatus).toBe("yellow");
    expect(res.body.freshness).toMatchObject({ ageSeconds: 120, stale: false });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://feed.example/v1/system-map");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe("Bearer feed-key");
    expect(JSON.stringify(res.body)).not.toContain("feed-key");
  });

  it("rejects a feed response with an unexpected shape instead of rendering it", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonRes({ ok: true }));
    const res = await request(makeApp(ADMIN, { baseUrl: "https://feed.example", key: "k", fetchImpl })).get("/api/ir/system-map");
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("ir_system_feed_bad_shape");
  });

  it.each([
    ["/api/ir/system-map", { ...SYSTEM_MAP, sources: null }],
    ["/api/ir/system-map", { ...SYSTEM_MAP, hosts: [null] }],
    ["/api/ir/system-map", { ...SYSTEM_MAP, doctor: { ...SYSTEM_MAP.doctor, checks: [{ key: "gateway" }] } }],
    ["/api/ir/system-map/gbrain-skeleton", { pack: {}, pageTypes: [], violations: {}, edges: [] }],
    ["/api/ir/system-map/gbrain-skeleton", { ...SKELETON, clients: [{ slug: "companies/test", title: "Test" }] }],
    ["/api/ir/proof-checks", { generatedAt: NOW.toISOString(), checks: [null] }],
    ["/api/ir/proof-checks", { generatedAt: NOW.toISOString(), checks: [{ key: "gateway", status: "pass" }] }],
  ])("rejects incomplete nested feed data for %s", async (path, body) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonRes(body));
    const res = await request(makeApp(ADMIN, { baseUrl: "https://feed.example", key: "k", fetchImpl })).get(path);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("ir_system_feed_bad_shape");
  });

  it("accepts the complete skeleton contract", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonRes(SKELETON));
    const res = await request(makeApp(ADMIN, { baseUrl: "https://feed.example", key: "k", fetchImpl })).get("/api/ir/system-map/gbrain-skeleton");
    expect(res.status).toBe(200);
    expect(res.body.skeleton).toEqual(SKELETON);
  });

  it("does not let an unrelated stale check block a fresh passing check", async () => {
    const body = proofFeed();
    body.checks.unshift({ key: "db_feeds", status: "fail", detail: null, observedAt: "2026-11-26T12:00:00Z" });
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonRes(body));
    const res = await request(makeApp(ADMIN, { baseUrl: "https://feed.example", key: "k", fetchImpl })).get("/api/ir/proof-checks");
    expect(res.status).toBe(200);
    expect(proofCheckAllowsClosure("gateway", res.body.checks, res.body.freshness, NOW)).toMatchObject({ allowed: true });
    expect(proofCheckAllowsClosure("db_feeds", res.body.checks, res.body.freshness, NOW)).toMatchObject({ allowed: false, status: "stale" });
  });

  it("marks old doctor data stale", async () => {
    const old = { ...SYSTEM_MAP, doctor: { ...SYSTEM_MAP.doctor, observedAt: "2026-11-26T16:00:00Z" } };
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonRes(old));
    const res = await request(makeApp(ADMIN, { baseUrl: "https://feed.example", key: "k", fetchImpl })).get("/api/ir/system-map");
    expect(res.body.freshness).toMatchObject({ ageSeconds: 7200, stale: true });
  });

  it("passes the feed's warming-up and unreachable states through as clear errors", async () => {
    const warming = vi.fn<typeof fetch>(async () => jsonRes({ error: "warming_up" }, 503));
    expect((await request(makeApp(ADMIN, { baseUrl: "https://f", key: "k", fetchImpl: warming })).get("/api/ir/proof-checks")).body.code)
      .toBe("ir_system_feed_warming_up");
    const down = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed");
    });
    const res = await request(makeApp(ADMIN, { baseUrl: "https://f", key: "k", fetchImpl: down })).get("/api/ir/proof-checks");
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("ir_system_feed_unreachable");
  });
});

describe("readProofCheckSnapshot", () => {
  it("caches the live snapshot briefly and returns null when unreachable", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonRes({ generatedAt: "2026-11-26T17:59:00Z", checks: [{ key: "gateway", status: "pass", detail: null, observedAt: "2026-11-26T17:59:00Z" }] }),
    );
    const opts = { baseUrl: "https://feed.example", key: "k", fetchImpl, now: () => NOW };
    const first = await readProofCheckSnapshot(opts);
    await readProofCheckSnapshot(opts);
    expect(first?.checks[0]?.status).toBe("pass");
    expect(first?.freshness.stale).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    resetProofCheckCache();
    expect(await readProofCheckSnapshot({ baseUrl: "", key: "" })).toBeNull();
  });

  it("keeps fresh cached proof available during a refresh and replaces it after the response", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    let finishRefresh!: (value: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonRes(proofFeed()))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishRefresh = resolve; }));
    startProofCheckRefresher({ baseUrl: "https://feed.example", key: "k", fetchImpl });
    await vi.advanceTimersByTimeAsync(0);
    const initial = cachedProofCheckSnapshot();
    expect(initial?.checks[0]?.status).toBe("pass");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(cachedProofCheckSnapshot()).toEqual(initial);
    finishRefresh(jsonRes(proofFeed("fail", new Date().toISOString())));
    await vi.advanceTimersByTimeAsync(0);
    expect(cachedProofCheckSnapshot()?.checks[0]?.status).toBe("fail");
  });

  it("clears cached proof after a failed refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonRes(proofFeed()))
      .mockRejectedValueOnce(new TypeError("fetch failed"));
    startProofCheckRefresher({ baseUrl: "https://feed.example", key: "k", fetchImpl });
    await vi.advanceTimersByTimeAsync(0);
    expect(cachedProofCheckSnapshot()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(cachedProofCheckSnapshot()).toBeNull();
  });
});
