import http from "node:http";
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
    expect((await request(nonAdminApp).post("/api/gateway/admin/oauth/quickbooks/launch").send({})).status).toBe(403);
    expect((await request(nonAdminApp).delete("/api/gateway/admin/oauth/gmail/alex%40increaseroas.com")).status).toBe(403);
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

  it("returns 503 for admin routes when GATEWAY_ADMIN_KEY is unset and no fallback key is provided", async () => {
    const fetchMock = jsonFetch({ ok: true });
    const app = makeApp(ADMIN_ACTOR, {
      baseUrl: "https://gw.example",
      adminKey: "",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const res = await request(app).get("/api/gateway/admin/agents");
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();

    // Malformed header (space / non-token chars) rejected with 400
    const badHeader = await request(app)
      .get("/api/gateway/admin/agents")
      .set("x-gateway-owner-key", "bad key with spaces");
    expect(badHeader.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates :agent, :integration and :scopeId params strictly including dot-segment traversal", async () => {
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
    // Dot-segment / boundary slash traversal regressions
    expect((await request(app).delete("/api/gateway/admin/scopes/ghl/a%2F..%2Fb")).status).toBe(400);
    expect((await request(app).delete("/api/gateway/admin/scopes/ghl/%2Fleading")).status).toBe(400);
    expect((await request(app).delete("/api/gateway/admin/scopes/ghl/trailing%2F")).status).toBe(400);
    expect((await request(app).delete("/api/gateway/admin/scopes/ghl/a%2F%2Fb")).status).toBe(400);

    // Raw HTTP wire test (no client-side path normalization, like curl --path-as-is)
    const server = app.listen(0);
    try {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const sendRawDelete = (rawPath: string) =>
        new Promise<number>((resolve, reject) => {
          const req = http.request(
            { host: "127.0.0.1", port, method: "DELETE", path: rawPath },
            (res) => {
              res.resume();
              resolve(res.statusCode ?? 0);
            },
          );
          req.on("error", reject);
          req.end();
        });
      expect(await sendRawDelete("/api/gateway/admin/scopes/ghl/%2e")).toBe(400);
      expect(await sendRawDelete("/api/gateway/admin/scopes/ghl/%2e%2e")).toBe(400);
      expect(await sendRawDelete("/api/gateway/admin/scopes/ghl/..")).toBe(400);
      expect(await sendRawDelete("/api/gateway/admin/oauth/gmail/%2e")).toBe(400);
      expect(await sendRawDelete("/api/gateway/admin/oauth/gmail/%2e%2e")).toBe(400);
      expect(await sendRawDelete("/api/gateway/admin/oauth/gmail/..")).toBe(400);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(fetchMock).not.toHaveBeenCalled();

    // Legitimate GHL scope containing an internal slash must still pass
    expect(
      (await request(app).delete("/api/gateway/admin/scopes/ghl/locations%2FcustomFields.readonly")).status,
    ).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gw.example/api/admin/scopes/ghl/locations%2FcustomFields.readonly",
      expect.objectContaining({ method: "DELETE", redirect: "manual" }),
    );
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
    await request(app)
      .post("/api/gateway/admin/oauth/quickbooks/launch")
      .send({ returnTo: "https://app.increaseai.tech/company/settings/gateway" })
      .expect(200);
    await request(app)
      .delete("/api/gateway/admin/oauth/gmail/alex%40increaseroas.com")
      .expect(200);

    // Reject unsupported OAuth provider or traversal accountId
    await request(app).post("/api/gateway/admin/oauth/unknown/launch").send({}).expect(400);
    await request(app).delete("/api/gateway/admin/oauth/unknown/a@b.com").expect(400);
    await request(app).delete("/api/gateway/admin/oauth/gmail/a..b").expect(400);
    await request(app).delete("/api/gateway/admin/oauth/gmail/a%2Fb").expect(400);

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
      "POST https://gw.example/api/admin/oauth/quickbooks/launch",
      "DELETE https://gw.example/api/admin/oauth/gmail/alex%40increaseroas.com",
    ]);
  });

  it("enforces admin auth, validates allowlist, and writes encrypted secrets to Cloudflare API", async () => {
    const cfCalls: Array<{ url: string; method: string; auth: string | null; body: unknown }> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      cfCalls.push({
        url: String(url),
        method: init?.method ?? "GET",
        auth: headers.get("authorization"),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(JSON.stringify({ success: true, result: { name: "ok" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    // Non-admin rejected with 403
    const nonAdminApp = makeApp(NON_ADMIN_ACTOR, {
      cloudflare: {
        apiToken: "cf-token",
        accountId: "acc-123",
        workerName: "increase-roas-oauth-gateway",
        fetchImpl: fetchMock as unknown as typeof fetch,
      },
    });
    expect((await request(nonAdminApp).get("/api/gateway/admin/secrets/schema")).status).toBe(403);
    expect(
      (
        await request(nonAdminApp)
          .put("/api/gateway/admin/secrets/fireflies")
          .send({ secrets: { FIREFLIES_API_KEY: "ff-secret-123" } })
      ).status,
    ).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();

    // Unconfigured token returns configured=false and 503 on PUT
    const unconfiguredApp = makeApp(ADMIN_ACTOR, {
      baseUrl: "https://gw.example/",
      cloudflare: {
        apiToken: "",
        accountId: "acc-123",
        workerName: "increase-roas-oauth-gateway",
        fetchImpl: fetchMock as unknown as typeof fetch,
      },
    });
    const schemaUnconf = await request(unconfiguredApp)
      .get("/api/gateway/admin/secrets/schema")
      .expect(200);
    expect(schemaUnconf.body.configured).toBe(false);
    expect(schemaUnconf.body.providers.quickbooks.fields.map((f: { key: string }) => f.key)).toEqual([
      "QBO_CLIENT_ID",
      "QBO_CLIENT_SECRET",
    ]);
    expect(schemaUnconf.body.providers.quickbooks.redirectUri).toBe(
      "https://gw.example/oauth/quickbooks/callback",
    );
    expect(schemaUnconf.body.providers.quickbooks.redirectPath).toBeUndefined();
    expect(schemaUnconf.body.providers.stripe).toBeUndefined();
    await request(unconfiguredApp)
      .put("/api/gateway/admin/secrets/fireflies")
      .send({ secrets: { FIREFLIES_API_KEY: "ff-secret-123" } })
      .expect(503);

    // Configured admin app validates allowlist and pushes to Cloudflare
    const adminApp = makeApp(ADMIN_ACTOR, {
      cloudflare: {
        apiToken: "cf-token",
        accountId: "acc-123",
        workerName: "increase-roas-oauth-gateway",
        fetchImpl: fetchMock as unknown as typeof fetch,
      },
    });

    // Reject unknown provider, disallowed key, empty value, and control chars
    await request(adminApp)
      .put("/api/gateway/admin/secrets/unknown_provider")
      .send({ secrets: { FOO: "bar" } })
      .expect(400);
    await request(adminApp)
      .put("/api/gateway/admin/secrets/fireflies")
      .send({ secrets: { ARBITRARY_KEY: "bar" } })
      .expect(400);
    await request(adminApp)
      .put("/api/gateway/admin/secrets/fireflies")
      .send({ secrets: { FIREFLIES_API_KEY: "   " } })
      .expect(400);
    await request(adminApp)
      .put("/api/gateway/admin/secrets/fireflies")
      .send({ secrets: { FIREFLIES_API_KEY: "bad\nvalue" } })
      .expect(400);
    await request(adminApp)
      .put("/api/gateway/admin/secrets/constructor")
      .send({ secrets: { FOO: "bar" } })
      .expect(400);

    // Valid PUT binds both QuickBooks secrets and never echoes raw values
    const okRes = await request(adminApp)
      .put("/api/gateway/admin/secrets/quickbooks")
      .send({
        secrets: {
          QBO_CLIENT_ID: "qb-id-supersecret",
          QBO_CLIENT_SECRET: "qb-sec-supersecret",
        },
      })
      .expect(200);

    expect(okRes.body).toEqual({
      ok: true,
      provider: "quickbooks",
      updatedKeys: ["QBO_CLIENT_ID", "QBO_CLIENT_SECRET"],
    });
    expect(JSON.stringify(okRes.body)).not.toContain("supersecret");
    expect(cfCalls).toEqual([
      {
        url: "https://api.cloudflare.com/client/v4/accounts/acc-123/workers/scripts/increase-roas-oauth-gateway/secrets",
        method: "PUT",
        auth: "Bearer cf-token",
        body: { name: "QBO_CLIENT_ID", text: "qb-id-supersecret", type: "secret_text" },
      },
      {
        url: "https://api.cloudflare.com/client/v4/accounts/acc-123/workers/scripts/increase-roas-oauth-gateway/secrets",
        method: "PUT",
        auth: "Bearer cf-token",
        body: { name: "QBO_CLIENT_SECRET", text: "qb-sec-supersecret", type: "secret_text" },
      },
    ]);
  });

  it("reports keys already written when Cloudflare rejects a later key", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? new Response(JSON.stringify({ success: true }), { status: 200 })
        : new Response(JSON.stringify({ errors: [{ message: "Authentication error" }] }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
    });
    const app = makeApp(ADMIN_ACTOR, {
      cloudflare: {
        apiToken: "cf-token",
        accountId: "acc-123",
        workerName: "increase-roas-oauth-gateway",
        fetchImpl: fetchMock as unknown as typeof fetch,
      },
    });
    const res = await request(app)
      .put("/api/gateway/admin/secrets/quickbooks")
      .send({ secrets: { QBO_CLIENT_ID: "id-value", QBO_CLIENT_SECRET: "secret-value" } })
      .expect(502);
    expect(res.body).toEqual({
      ok: false,
      error: "Cloudflare rejected QBO_CLIENT_SECRET: Authentication error",
      updatedKeys: ["QBO_CLIENT_ID"],
    });
  });
});
