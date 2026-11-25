import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../middleware/error-handler.js";
import { gatewayProxyRoutes, type GatewayProxyOptions } from "../gateway-proxy.js";

const ADMIN_ACTOR = {
  type: "board",
  userId: "u-admin",
  source: "session",
  isInstanceAdmin: true,
  companyIds: ["c1"],
} as Express.Request["actor"];

const NON_ADMIN_ACTOR = {
  type: "board",
  userId: "u-member",
  source: "session",
  isInstanceAdmin: false,
  companyIds: ["c1"],
} as Express.Request["actor"];

function makeApp(actor: Express.Request["actor"], opts?: GatewayProxyOptions) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", gatewayProxyRoutes(opts));
  app.use(errorHandler);
  return app;
}

function jsonFetch(body: unknown = { ok: true }, status = 200) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
}

describe("gatewayProxyRoutes", () => {
  it("enforces assertInstanceAdmin on every route", async () => {
    const fetchMock = jsonFetch();
    const nonAdminApp = makeApp(NON_ADMIN_ACTOR, {
      baseUrl: "https://gw.example",
      adminKey: "gw-secret",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect((await request(nonAdminApp).get("/api/gateway/health")).status).toBe(403);
    expect((await request(nonAdminApp).get("/api/gateway/admin/agents")).status).toBe(403);
    expect((await request(nonAdminApp).post("/api/gateway/admin/agents/atlas/new-key").send({})).status).toBe(403);
    expect((await request(nonAdminApp).delete("/api/gateway/admin/scopes/ghl/loc_1")).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();

    const anonApp = makeApp({ type: "none", source: "none" } as Express.Request["actor"], {
      baseUrl: "https://gw.example",
      adminKey: "gw-secret",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect([401, 403]).toContain((await request(anonApp).get("/api/gateway/status")).status);
  });

  it("always sends User-Agent: paperclip-server/1.0 and prefers server-side GATEWAY_ADMIN_KEY", async () => {
    const fetchMock = jsonFetch({ status: "ok" });
    const app = makeApp(ADMIN_ACTOR, {
      baseUrl: "https://gw.example/",
      adminKey: "server-key",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const res = await request(app)
      .get("/api/gateway/admin/agents?limit=25")
      .set("x-gateway-owner-key", "browser-override-ignored");

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gw.example/api/admin/agents?limit=25",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "user-agent": "paperclip-server/1.0",
          authorization: "Bearer server-key",
        }),
      }),
    );
  });

  it("falls back to x-gateway-owner-key only when GATEWAY_ADMIN_KEY is unset", async () => {
    const fetchMock = jsonFetch({ ok: true });
    const app = makeApp(ADMIN_ACTOR, {
      baseUrl: "https://gw.example",
      adminKey: "",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await request(app)
      .get("/api/gateway/admin/roles")
      .set("x-gateway-owner-key", "fallback-owner-key")
      .expect(200);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://gw.example/api/admin/roles",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer fallback-owner-key",
          "user-agent": "paperclip-server/1.0",
        }),
      }),
    );
  });

  it("validates :agent, :integration and :scopeId params strictly", async () => {
    const fetchMock = jsonFetch();
    const app = makeApp(ADMIN_ACTOR, {
      baseUrl: "https://gw.example",
      adminKey: "server-key",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect((await request(app).get("/api/gateway/admin/agents/BAD_CAPS/policy")).status).toBe(400);
    expect((await request(app).put("/api/gateway/admin/agents/1starts-digit").send({})).status).toBe(400);
    expect((await request(app).post("/api/gateway/admin/scopes/INVALID!").send({})).status).toBe(400);
    expect((await request(app).delete("/api/gateway/admin/scopes/ghl/bad%20space")).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("proxies all 17 gateway routes with exact upstream paths and methods", async () => {
    const calls: Array<{ method: string; url: string; body?: string }> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        method: String(init?.method ?? "GET"),
        url: String(url),
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const app = makeApp(ADMIN_ACTOR, {
      baseUrl: "https://gw.example",
      adminKey: "server-key",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await request(app).get("/api/gateway/health").expect(200);
    await request(app).get("/api/gateway/status").expect(200);
    await request(app).get("/api/gateway/providers").expect(200);
    await request(app).get("/api/gateway/admin/health").expect(200);
    await request(app).get("/api/gateway/admin/agents").expect(200);
    await request(app).get("/api/gateway/admin/bots").expect(200);
    await request(app).get("/api/gateway/admin/bots/atlas-bot/summary").expect(200);
    await request(app).get("/api/gateway/admin/roles").expect(200);
    await request(app).get("/api/gateway/admin/agents/atlas-bot/policy").expect(200);
    await request(app).put("/api/gateway/admin/agents/atlas-bot/policy").send({ locations: "*" }).expect(200);
    await request(app).put("/api/gateway/admin/agents/atlas-bot").send({ active: true }).expect(200);
    await request(app).post("/api/gateway/admin/agents/atlas-bot/new-key").send({ role: "reader" }).expect(200);
    await request(app).post("/api/gateway/admin/agents/atlas-bot/keys/rotate").send({}).expect(200);
    await request(app).post("/api/gateway/admin/agents/atlas-bot/keys/revoke").send({ keyId: "k1" }).expect(200);
    await request(app).get("/api/gateway/admin/scopes").expect(200);
    await request(app).post("/api/gateway/admin/scopes/ghl").send({ id: "loc_1" }).expect(200);
    await request(app).delete("/api/gateway/admin/scopes/ghl/loc_1%2Fsub").expect(200);

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://gw.example/health",
      "GET https://gw.example/api/status",
      "GET https://gw.example/api/providers",
      "GET https://gw.example/api/admin/health",
      "GET https://gw.example/api/admin/agents",
      "GET https://gw.example/api/admin/bots",
      "GET https://gw.example/api/admin/bots/atlas-bot/summary",
      "GET https://gw.example/api/admin/roles",
      "GET https://gw.example/api/admin/agents/atlas-bot/policy",
      "PUT https://gw.example/api/admin/agents/atlas-bot/policy",
      "PUT https://gw.example/api/admin/agents/atlas-bot",
      "POST https://gw.example/api/admin/agents/atlas-bot/new-key",
      "POST https://gw.example/api/admin/agents/atlas-bot/keys/rotate",
      "POST https://gw.example/api/admin/agents/atlas-bot/keys/revoke",
      "GET https://gw.example/api/admin/scopes",
      "POST https://gw.example/api/admin/scopes/ghl",
      "DELETE https://gw.example/api/admin/scopes/ghl/loc_1%2Fsub",
    ]);
  });
});
