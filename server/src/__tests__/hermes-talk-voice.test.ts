import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { hermesTalkVoiceRoutes, type HermesTalkVoiceRouteOptions } from "../routes/hermes-talk-voice.js";

function makeApp(actor: Express.Request["actor"], opts?: HermesTalkVoiceRouteOptions) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", hermesTalkVoiceRoutes(opts));
  app.use(errorHandler);
  return app;
}

describe("hermesTalkVoiceRoutes", () => {
  it("rejects unauthenticated requests with 401/403", async () => {
    const app = makeApp({ type: "none" } as Express.Request["actor"], {
      upstreamUrl: "https://brain.example:9119",
      sessionToken: "secret-tok",
    });
    const res = await request(app).get("/api/voice/hermes-talk/status");
    expect([401, 403]).toContain(res.status);
  });

  it("rejects agent/bot API keys with 403", async () => {
    const app = makeApp({ type: "agent", agentId: "a1", companyId: "c1" } as Express.Request["actor"], {
      upstreamUrl: "https://brain.example:9119",
      sessionToken: "secret-tok",
    });
    const res = await request(app).post("/api/voice/hermes-talk/session").send({});
    expect(res.status).toBe(403);
  });

  it("rejects non-admin board members with 403", async () => {
    const app = makeApp(
      {
        type: "board",
        userId: "u2",
        source: "session",
        isInstanceAdmin: false,
        companyIds: ["c1"],
      } as Express.Request["actor"],
      {
        upstreamUrl: "https://brain.example:9119",
        sessionToken: "secret-tok",
      },
    );
    const res = await request(app).post("/api/voice/hermes-talk/session").send({});
    expect(res.status).toBe(403);
  });

  it("returns 503 cleanly when upstream env vars are unset", async () => {
    const app = makeApp(
      { type: "board", userId: "u1", source: "local_implicit" } as Express.Request["actor"],
      { upstreamUrl: "", sessionToken: "" },
    );
    const res = await request(app).get("/api/voice/hermes-talk/status");
    expect(res.status).toBe(503);
    expect(res.body.configured).toBe(false);
  });

  it("proxies board user calls with x-hermes-session-token and never leaks the token", async () => {
    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://brain.example:9119/api/plugins/hermes-talk/session");
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers["x-hermes-session-token"]).toBe("super-secret-token");
      return new Response(JSON.stringify({ ok: true, clientSecret: "ek_test", offerUrl: "https://api.openai.com/v1/realtime/calls" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const app = makeApp(
      { type: "board", userId: "u1", source: "session", isInstanceAdmin: true, companyIds: ["c1"] } as Express.Request["actor"],
      { upstreamUrl: "https://brain.example:9119/", sessionToken: "super-secret-token", fetchImpl: mockFetch as unknown as typeof fetch },
    );
    const res = await request(app).post("/api/voice/hermes-talk/session").send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.clientSecret).toBe("ek_test");
    expect(JSON.stringify(res.body)).not.toContain("super-secret-token");
  });

  it("maps upstream 401/403 authentication errors to 502 so the UI does not treat them as session expiry", async () => {
    const mockFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    });

    const app = makeApp(
      { type: "board", userId: "u1", source: "session", isInstanceAdmin: true, companyIds: ["c1"] } as Express.Request["actor"],
      { upstreamUrl: "https://brain.example:9119", sessionToken: "wrong-token", fetchImpl: mockFetch as unknown as typeof fetch },
    );
    const res = await request(app).get("/api/voice/hermes-talk/status");
    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain("Hermes Talk voice bridge authentication is misconfigured.");
  });

  it("forwards POST /api/voice/hermes-talk/journal for instance admin", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, written: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const app = makeApp(
      { type: "board", userId: "u1", source: "session", isInstanceAdmin: true, companyIds: ["c1"] } as Express.Request["actor"],
      { upstreamUrl: "https://brain.example:9119", sessionToken: "secret-tok", fetchImpl: fetchMock as unknown as typeof fetch },
    );
    const body = { call_id: "call_0123456789abcdef0123456789abcdef", events: [{ kind: "user", seq: 1, text: "hello" }] };
    const res = await request(app).post("/api/voice/hermes-talk/journal").send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, written: 1 });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://brain.example:9119/api/plugins/hermes-talk/journal",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("forwards GET /api/voice/hermes-talk/workflows for instance admin", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, workflows: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const app = makeApp(
      { type: "board", userId: "u1", source: "session", isInstanceAdmin: true, companyIds: ["c1"] } as Express.Request["actor"],
      { upstreamUrl: "https://brain.example:9119", sessionToken: "secret-tok", fetchImpl: fetchMock as unknown as typeof fetch },
    );
    const res = await request(app).get("/api/voice/hermes-talk/workflows");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, workflows: [] });
  });

  it("does not expose /api/sales-dashboard/admin-key or gateway routes on hermesTalkVoiceRoutes", async () => {
    const admin = makeApp(
      { type: "board", userId: "u1", source: "session", isInstanceAdmin: true, companyIds: ["c1"] } as Express.Request["actor"],
    );
    expect((await request(admin).get("/api/sales-dashboard/admin-key")).status).toBe(404);
    expect((await request(admin).get("/api/gateway/health")).status).toBe(404);
  });

  it("rejects duplicate SOP creation (exact and case-insensitive) with 409 and never calls upstream save", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe("https://brain.example:9119/api/plugins/hermes-talk/workflows");
      return new Response(
        JSON.stringify({
          ok: true,
          workflows: [
            { path: "ads-checker/audit-meta-spend.md", profile: "ads-checker", title: "Audit Meta Spend", updatedAt: 1 },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const app = makeApp(
      { type: "board", userId: "u1", source: "session", isInstanceAdmin: true, companyIds: ["c1"] } as Express.Request["actor"],
      { upstreamUrl: "https://brain.example:9119", sessionToken: "secret-tok", fetchImpl: fetchMock as unknown as typeof fetch },
    );

    const exactRes = await request(app)
      .post("/api/voice/hermes-talk/workflows/save")
      .send({ path: "ads-checker/audit-meta-spend.md", content: "# Overwrite", mode: "create" });
    expect(exactRes.status).toBe(409);
    expect(exactRes.body.error).toBe("workflow_already_exists");

    const caseRes = await request(app)
      .post("/api/voice/hermes-talk/workflows/save")
      .send({ path: "Ads-Checker/AUDIT-META-SPEND.md", content: "# Overwrite", mode: "create" });
    expect(caseRes.status).toBe(409);
    expect(caseRes.body.error).toBe("workflow_already_exists");

    // Default save without explicit mode: "update" also refuses overwrites (fail closed).
    const defaultRes = await request(app)
      .post("/api/voice/hermes-talk/workflows/save")
      .send({ path: "ads-checker/audit-meta-spend.md", content: "# Overwrite" });
    expect(defaultRes.status).toBe(409);
    expect(defaultRes.body.error).toBe("workflow_already_exists");

    // Upstream save was never called for any rejected create/overwrite attempt.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toBe("https://brain.example:9119/api/plugins/hermes-talk/workflows");
    }
  });

  it("allows creating a brand-new SOP playbook and strips internal mode before forwarding upstream", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/workflows")) {
        return new Response(
          JSON.stringify({
            ok: true,
            workflows: [
              { path: "general/existing.md", profile: "general", title: "Existing", updatedAt: 1 },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      expect(target).toBe("https://brain.example:9119/api/plugins/hermes-talk/workflows/save");
      expect(JSON.parse(String(init?.body))).toEqual({
        path: "general/brand-new.md",
        content: "# Brand New",
      });
      return new Response(JSON.stringify({ ok: true, path: "general/brand-new.md" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const app = makeApp(
      { type: "board", userId: "u1", source: "session", isInstanceAdmin: true, companyIds: ["c1"] } as Express.Request["actor"],
      { upstreamUrl: "https://brain.example:9119", sessionToken: "secret-tok", fetchImpl: fetchMock as unknown as typeof fetch },
    );

    const res = await request(app)
      .post("/api/voice/hermes-talk/workflows/save")
      .send({ path: "general/brand-new.md", content: "# Brand New", mode: "create" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, path: "general/brand-new.md" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("allows modifying an existing SOP playbook only when explicit mode: update is supplied", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://brain.example:9119/api/plugins/hermes-talk/workflows/save");
      expect(JSON.parse(String(init?.body))).toEqual({
        path: "general/existing.md",
        content: "# Updated",
      });
      return new Response(JSON.stringify({ ok: true, path: "general/existing.md" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const app = makeApp(
      { type: "board", userId: "u1", source: "session", isInstanceAdmin: true, companyIds: ["c1"] } as Express.Request["actor"],
      { upstreamUrl: "https://brain.example:9119", sessionToken: "secret-tok", fetchImpl: fetchMock as unknown as typeof fetch },
    );

    const res = await request(app)
      .post("/api/voice/hermes-talk/workflows/save")
      .send({ path: "general/existing.md", content: "# Updated", mode: "update" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, path: "general/existing.md" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed on create when upstream workflow existence check fails and rejects invalid paths", async () => {
    const fetchMock = vi.fn(async () => new Response("upstream down", { status: 500 }));
    const app = makeApp(
      { type: "board", userId: "u1", source: "session", isInstanceAdmin: true, companyIds: ["c1"] } as Express.Request["actor"],
      { upstreamUrl: "https://brain.example:9119", sessionToken: "secret-tok", fetchImpl: fetchMock as unknown as typeof fetch },
    );

    const badPath = await request(app)
      .post("/api/voice/hermes-talk/workflows/save")
      .send({ path: "../escape.md", content: "# Nope", mode: "create" });
    expect(badPath.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();

    const failedCheck = await request(app)
      .post("/api/voice/hermes-talk/workflows/save")
      .send({ path: "general/new-sop.md", content: "# New", mode: "create" });
    expect(failedCheck.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
