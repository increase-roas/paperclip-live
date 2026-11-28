import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  forwardUpstreamJson,
  type UpstreamJsonForwardRequest,
  type UpstreamMethod,
} from "../upstream-json-forward.js";

type ForwardOverrides = Partial<Omit<UpstreamJsonForwardRequest, "req" | "res" | "fetchImpl">>;

function makeApp(fetchImpl: typeof fetch, overrides: ForwardOverrides = {}) {
  const app = express();
  app.use(express.json());
  app.all("/forward", async (req, res) => {
    await forwardUpstreamJson({
      req,
      res,
      fetchImpl,
      targetUrl: "https://upstream.example/api/admin/thing",
      method: req.method as UpstreamMethod,
      bearerToken: "server-held-key",
      timeoutMs: 1_000,
      timeoutMessage: "Upstream timed out.",
      unreachableMessage: "Could not reach upstream.",
      ...overrides,
    });
  });
  return app;
}

function jsonResponse(text: string, init: ResponseInit = {}) {
  return new Response(text, { status: 200, headers: { "content-type": "application/json" }, ...init });
}

function sentInit(fetchMock: Mock<typeof fetch>, call = 0): RequestInit {
  return fetchMock.mock.calls[call]?.[1] ?? {};
}

function sentHeaders(init: RequestInit) {
  return init.headers as Record<string, string>;
}

const servers: http.Server[] = [];

async function listen(handler: http.RequestListener) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

describe("forwardUpstreamJson", () => {
  it("sends the server-held key and body, then relays the upstream status and body unchanged", async () => {
    const upstreamText = '{"ok": false,  "error": "scope not allowed"}';
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(upstreamText, { status: 422 }));

    const res = await request(makeApp(fetchMock)).post("/forward").send({ name: "Demo Agency" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://upstream.example/api/admin/thing");
    const init = sentInit(fetchMock);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(sentHeaders(init)).toEqual({
      accept: "application/json",
      "user-agent": "paperclip-server/1.0",
      authorization: "Bearer server-held-key",
      "content-type": "application/json",
    });
    expect(init.body).toBe('{"name":"Demo Agency"}');

    expect(res.status).toBe(422);
    expect(res.text).toBe(upstreamText);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
  });

  it("returns an upstream redirect as-is without following it or passing on its Location or cookies", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse('{"moved":true}', {
        status: 302,
        headers: {
          location: "https://elsewhere.example/steal",
          "set-cookie": "upstream_session=abc; Path=/",
          "content-type": "text/html",
        },
      }),
    );

    const res = await request(makeApp(fetchMock)).get("/forward").redirects(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(302);
    expect(res.text).toBe('{"moved":true}');
    expect(res.headers.location).toBeUndefined();
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
  });

  it("sends an empty JSON object when POST, PUT or PATCH arrive without a body", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse("{}"));
    const app = makeApp(fetchMock);

    await request(app).post("/forward").expect(200);
    await request(app).put("/forward").expect(200);
    await request(app).patch("/forward").expect(200);

    expect(fetchMock.mock.calls.map((_, i) => sentInit(fetchMock, i).method)).toEqual(["POST", "PUT", "PATCH"]);
    for (let i = 0; i < 3; i += 1) {
      expect(sentInit(fetchMock, i).body).toBe("{}");
      expect(sentHeaders(sentInit(fetchMock, i))["content-type"]).toBe("application/json");
    }
  });

  it("sends no body on GET, and on DELETE only when one was given", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse("{}"));
    const app = makeApp(fetchMock);

    await request(app).get("/forward").expect(200);
    await request(app).delete("/forward").expect(200);
    await request(app).delete("/forward").send({}).expect(200);
    await request(app).delete("/forward").send({ id: "tok_1" }).expect(200);

    for (let i = 0; i < 3; i += 1) {
      expect(sentInit(fetchMock, i).body).toBeUndefined();
      expect(sentHeaders(sentInit(fetchMock, i))["content-type"]).toBeUndefined();
    }
    expect(sentInit(fetchMock, 3).body).toBe('{"id":"tok_1"}');
    expect(sentHeaders(sentInit(fetchMock, 3))["content-type"]).toBe("application/json");
  });

  it("leaves out the Authorization header when no key is set", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse("{}"));

    await request(makeApp(fetchMock, { bearerToken: "" })).get("/forward").expect(200);

    expect(sentHeaders(sentInit(fetchMock))).not.toHaveProperty("authorization");
  });

  it("returns 504 with the timeout message when the upstream never answers", async () => {
    const baseUrl = await listen(() => {
      // Never respond.
    });

    const res = await request(makeApp(fetch, { targetUrl: `${baseUrl}/slow`, timeoutMs: 50 })).get("/forward");

    expect(res.status).toBe(504);
    expect(res.body).toEqual({ ok: false, error: "Upstream timed out." });
  });

  it("returns 504 when the upstream sends headers but stalls the body", async () => {
    const baseUrl = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"partial":');
    });

    const res = await request(makeApp(fetch, { targetUrl: `${baseUrl}/stall`, timeoutMs: 50 })).get("/forward");

    expect(res.status).toBe(504);
    expect(res.body).toEqual({ ok: false, error: "Upstream timed out." });
  });

  it("returns 502 with the unreachable message and hides the network error details", async () => {
    const baseUrl = await listen(() => undefined);
    const server = servers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const res = await request(makeApp(fetch, { targetUrl: `${baseUrl}/gone` })).get("/forward");

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ ok: false, error: "Could not reach upstream." });
    expect(res.text).not.toContain("127.0.0.1");
  });

  it("returns 502 when the upstream body breaks mid-read", async () => {
    const brokenBody = new ReadableStream({
      start(controller) {
        controller.error(new Error("socket hang up"));
      },
    });
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(brokenBody, { status: 200 }));

    const res = await request(makeApp(fetchMock)).get("/forward");

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ ok: false, error: "Could not reach upstream." });
  });

  it("clears the timeout once the upstream answers", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse('{"ok":true}'));

    await request(makeApp(fetchMock, { timeoutMs: 20 })).get("/forward").expect(200);
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(sentInit(fetchMock).signal?.aborted).toBe(false);
  });
});
