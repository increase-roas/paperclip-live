import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../middleware/error-handler.js";
import {
  salesDashboardProxyRoutes,
  type SalesDashboardProxyOptions,
} from "../sales-dashboard-proxy.js";

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

function makeApp(actor: Express.Request["actor"], opts?: SalesDashboardProxyOptions) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", salesDashboardProxyRoutes(opts));
  app.use(errorHandler);
  return app;
}

describe("salesDashboardProxyRoutes", () => {
  it("never exposes GET /api/sales-dashboard/admin-key", async () => {
    const app = makeApp(ADMIN_ACTOR, {
      baseUrl: "https://dash.example",
      adminKey: "super-secret-admin-key",
    });
    const res = await request(app).get("/api/sales-dashboard/admin-key");
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain("super-secret-admin-key");
  });

  it("enforces assertInstanceAdmin and returns 503 when admin key is unset", async () => {
    const fetchMock = vi.fn();
    const nonAdmin = makeApp(NON_ADMIN_ACTOR, {
      baseUrl: "https://dash.example",
      adminKey: "secret",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect((await request(nonAdmin).get("/api/sales-dashboard/tenants")).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();

    const unconfigured = makeApp(ADMIN_ACTOR, {
      baseUrl: "https://dash.example",
      adminKey: "",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect((await request(unconfigured).get("/api/sales-dashboard/tenants")).status).toBe(503);
  });

  it("preserves allowlisted query params, strips unknown ones, and defaults view=30d on capital/snapshots", async () => {
    const calls: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        method: String(init?.method ?? "GET"),
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const app = makeApp(ADMIN_ACTOR, {
      baseUrl: "https://dash.example/",
      adminKey: "dash-secret",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await request(app).get("/api/sales-dashboard/capital").expect(200);
    await request(app).get("/api/sales-dashboard/capital?view=month&evil=1").expect(200);
    await request(app).get("/api/sales-dashboard/snapshots").expect(200);
    await request(app)
      .get("/api/sales-dashboard/neon-ads?view=accounts&days=14&clientId=paradise-spas&secret=dropme")
      .expect(200);

    expect(calls.map((c) => c.url)).toEqual([
      "https://dash.example/api/pilot/admin/capital?view=30d",
      "https://dash.example/api/pilot/admin/capital?view=month",
      "https://dash.example/api/pilot/admin/snapshots?view=30d",
      "https://dash.example/api/pilot/neon-ads?view=accounts&days=14&clientId=paradise-spas",
    ]);
    for (const c of calls) {
      expect(c.headers.authorization).toBe("Bearer dash-secret");
      expect(c.headers["user-agent"]).toBe("paperclip-server/1.0");
    }
  });

  it("proxies all required methods and routes", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(url)}`);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const app = makeApp(ADMIN_ACTOR, {
      baseUrl: "https://dash.example",
      adminKey: "dash-secret",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await request(app).get("/api/sales-dashboard/tenants").expect(200);
    await request(app).post("/api/sales-dashboard/tenants").send({ slug: "acme" }).expect(200);
    await request(app).put("/api/sales-dashboard/tenants").send({ slug: "acme" }).expect(200);
    await request(app).patch("/api/sales-dashboard/tenants").send({ slug: "acme" }).expect(200);
    await request(app).get("/api/sales-dashboard/diagnostic?slug=acme").expect(200);
    await request(app).post("/api/sales-dashboard/diagnostic").send({ slug: "acme" }).expect(200);
    await request(app).get("/api/sales-dashboard/discovery?provider=ghl").expect(200);
    await request(app).get("/api/sales-dashboard/accounting?slug=acme").expect(200);
    await request(app).post("/api/sales-dashboard/accounting").send({}).expect(200);
    await request(app).delete("/api/sales-dashboard/accounting?id=1").expect(200);
    await request(app).get("/api/sales-dashboard/team").expect(200);
    await request(app).post("/api/sales-dashboard/team").send({ name: "Sam" }).expect(200);
    await request(app).put("/api/sales-dashboard/team").send({ id: "1" }).expect(200);
    await request(app).delete("/api/sales-dashboard/team?id=1").expect(200);
    await request(app).put("/api/sales-dashboard/team/settings").send({ fixedMonthlyCostUsd: 2000 }).expect(200);
    await request(app).get("/api/sales-dashboard/mcp-tokens").expect(200);
    await request(app).post("/api/sales-dashboard/mcp-tokens").send({ name: "bot" }).expect(200);
    await request(app).delete("/api/sales-dashboard/mcp-tokens?id=tok1").expect(200);
    await request(app).post("/api/sales-dashboard/sync").send({ slug: "acme" }).expect(200);

    expect(calls).toEqual([
      "GET https://dash.example/api/pilot/admin/tenants",
      "POST https://dash.example/api/pilot/admin/tenants",
      "PUT https://dash.example/api/pilot/admin/tenants",
      "PATCH https://dash.example/api/pilot/admin/tenants",
      "GET https://dash.example/api/pilot/admin/diagnostic?slug=acme",
      "POST https://dash.example/api/pilot/admin/diagnostic",
      "GET https://dash.example/api/pilot/admin/discovery?provider=ghl",
      "GET https://dash.example/api/pilot/admin/accounting?slug=acme",
      "POST https://dash.example/api/pilot/admin/accounting",
      "DELETE https://dash.example/api/pilot/admin/accounting?id=1",
      "GET https://dash.example/api/pilot/admin/team",
      "POST https://dash.example/api/pilot/admin/team",
      "PUT https://dash.example/api/pilot/admin/team",
      "DELETE https://dash.example/api/pilot/admin/team?id=1",
      "PUT https://dash.example/api/pilot/admin/team/settings",
      "GET https://dash.example/api/pilot/admin/mcp-tokens",
      "POST https://dash.example/api/pilot/admin/mcp-tokens",
      "DELETE https://dash.example/api/pilot/admin/mcp-tokens?id=tok1",
      "POST https://dash.example/api/pilot/admin/sync",
    ]);
  });
});
