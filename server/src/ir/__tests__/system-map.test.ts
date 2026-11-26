import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../middleware/error-handler.js";
import {
  readProofCheckSnapshot,
  resetProofCheckCache,
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
  registers: [],
  sources: [],
};

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

afterEach(() => resetProofCheckCache());

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
});
