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
});
