import { appendFile, mkdtemp, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../errors.js";
import { resolveDefaultLogsDir } from "../../home-paths.js";
import { errorHandler } from "../../middleware/error-handler.js";
import { queryErrorLog, recordClientError, recordServerError, redactErrorRecord } from "../error-log.js";
import { errorRoutes, isClientErrorPost } from "../error-routes.js";

const admin = {
  type: "board",
  source: "session",
  userId: "admin",
  sessionId: "test-admin-session",
  isInstanceAdmin: true,
} satisfies Express.Request["actor"];

function setup(actor: Express.Request["actor"] = admin) {
  const app = express();
  app.set("trust proxy", "loopback");
  const json = express.json();
  app.use((req, res, next) => isClientErrorPost(req) ? next() : json(req, res, next));
  app.use((req, _res, next) => {
    req.actor = { ...actor, sessionId: req.get("x-test-session") ?? actor.sessionId };
    next();
  });
  app.use("/api", errorRoutes());
  app.get("/typed-error", () => { throw new HttpError(503, "Unreachable upstream"); });
  app.get("/unexpected-error", () => { throw new Error("Unexpected failure"); });
  app.get("/client-error", () => { throw new HttpError(409, "Conflict"); });
  app.use(errorHandler);
  return request(app);
}

const clientPath = "/api/ir/errors/client";
const browserHeaders = { origin: "http://localhost:3100", "sec-fetch-site": "same-origin" };

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "paperclip-ir-errors-"));
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
  vi.stubEnv("IR_ERROR_INCIDENT_WEBHOOK_URL", "");
  vi.stubEnv("IR_ERROR_INCIDENT_WEBHOOK_TOKEN", "");
  vi.stubEnv("SENTRY_DSN", "");
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("IR error storage", () => {
  it("scrubs named, prefixed, encoded and nested secrets before any sink", () => {
    const testCredentials = ["sk-", "gho_", "ghp_", "ops_", "op_"].map((prefix) => prefix + "fakeValue");
    const record = redactErrorRecord({
      source: "server",
      severity: "error",
      message: `Failed with Bearer ${testCredentials.join(" ")}`,
      stack: 'Error\nAuthorization: Basic header-value\nCookie: a=cookie-value; b=other-cookie\n{"x-api-key":"named value", "token": ["array-value"]}',
      route: "/fail?%70assword=query%20value%26continued&mode=sample",
      meta: { nested: [{ secret: { unsafe: "nested-value" }, open: "keep me" }], password: true },
    });
    const serialized = JSON.stringify(record);
    for (const secret of [
      ...testCredentials, "header-value", "cookie-value", "other-cookie", "named value",
      "array-value", "query", "continued", "nested-value",
    ]) {
      expect(serialized.includes(secret)).toBe(false);
    }
    expect(record.meta?.nested).toEqual([{ secret: "[REDACTED]", open: "keep me" }]);
    expect(record.route).toContain("mode=sample");
    expect(record.message).toContain("[REDACTED]");
  });

  it("persists entries and counts matches across the requested filters", async () => {
    const first = await recordClientError({ severity: "error", message: "Widget failed", route: "/board" });
    const second = await recordClientError({ severity: "fatal", message: "Renderer failed", stack: "Widget.render" });
    recordServerError({ severity: "error", message: "SERVER ERROR", route: "/widgets" });
    const path = join(home, "instances", "default", "logs", "ir-errors.jsonl");
    const result = await queryErrorLog({ q: "WIDGET", limit: 2 });
    expect(result).toMatchObject({ total: 3, sentryEnabled: false });
    expect(result.items.map(({ message }) => message)).toEqual(["SERVER ERROR", "Renderer failed"]);
    expect(await queryErrorLog({ source: "client", severity: "fatal", since: first.ts })).toMatchObject({
      total: 1, items: [{ id: second.id }],
    });
    expect((await queryErrorLog({ since: "2099-01-01T00:00:00Z" })).items).toEqual([]);
    expect((await queryErrorLog({ q: second.fingerprint })).total).toBe(1);
    expect((await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line).source))
      .toEqual(["client", "client", "server"]);
  });

  it("rotates at 10 MiB and reads the three retained backups newest first", async () => {
    const path = join(resolveDefaultLogsDir(), "ir-errors.jsonl");
    for (let index = 0; index < 5; index++) {
      await recordClientError({ severity: "error", message: `Entry ${index}` });
      if (index < 4) await truncate(path, 10 * 1024 * 1024);
    }
    expect((await readdir(resolveDefaultLogsDir())).sort())
      .toEqual(["ir-errors.jsonl", "ir-errors.jsonl.1", "ir-errors.jsonl.2", "ir-errors.jsonl.3"]);
    const { items, total } = await queryErrorLog({ limit: 3 });
    expect(total).toBe(4);
    expect(items.map(({ message }) => message)).toEqual(["Entry 4", "Entry 3", "Entry 2"]);
  });

  it("preserves new records after an interrupted append", async () => {
    await recordClientError({ severity: "error", message: "First complete" });
    await appendFile(join(resolveDefaultLogsDir(), "ir-errors.jsonl"), '{"incomplete":');
    await recordClientError({ severity: "error", message: "Second complete" });
    const { items, total } = await queryErrorLog();
    expect(total).toBe(2);
    expect(items.map(({ message }) => message)).toEqual(["Second complete", "First complete"]);
  });

  it("relays one sanitized summary and persists while the webhook is unresolved", async () => {
    vi.stubEnv("IR_ERROR_INCIDENT_WEBHOOK_URL", "https://incidents.example.test");
    vi.stubEnv("IR_ERROR_INCIDENT_WEBHOOK_TOKEN", ["test", "value"].join("-"));
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetch);
    await recordClientError({ severity: "fatal", message: "Failed: token=one", componentStack: "private frame" });
    await recordClientError({ severity: "fatal", message: "Failed: token=two" });
    expect((await queryErrorLog()).total).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("https://incidents.example.test", expect.objectContaining({
      method: "POST",
      headers: { "content-type": "application/json", authorization: ["Bearer", "test-value"].join(" ") },
      signal: expect.any(AbortSignal),
      body: expect.stringContaining("Failed: token=[REDACTED]"),
    }));
    expect(fetch.mock.calls[0]?.[1]?.body).not.toContain("private frame");
  });
});

describe("IR error API", () => {
  it("captures thrown server errors and skips expected 4xx responses", async () => {
    const app = setup();
    await app.get("/typed-error?secret=ignored").expect(503);
    await app.get("/unexpected-error").expect(500, { error: "Internal server error" });
    await app.get("/client-error").expect(409);
    const { body } = await app.get("/api/ir/errors?source=server&q=error&limit=5000").expect(200);
    expect(body.total).toBe(2);
    expect(body.items).toMatchObject([
      { statusCode: 500, route: "/unexpected-error", method: "GET" },
      { statusCode: 503, route: "/typed-error", method: "GET" },
    ]);
  });

  it("permits only board instance admins to read and sends a boolean for Sentry", async () => {
    const agent = { type: "agent", source: "agent_key", agentId: "agent", companyId: "company" } as const;
    await setup(agent).get("/api/ir/errors").expect(403);
    await setup({ ...admin, isInstanceAdmin: false }).get("/api/ir/errors").expect(403);
    await setup({ ...admin, source: "local_implicit", isInstanceAdmin: false }).get("/api/ir/errors").expect(403);
    await setup({ type: "none", source: "none" }).get("/api/ir/errors").expect(403);
    await setup().get("/api/ir/errors?since=yesterday").expect(400);
    vi.stubEnv("SENTRY_DSN", "configured-for-test");
    const response = await setup().get("/api/ir/errors").expect(200, { items: [], total: 0, sentryEnabled: true });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("requires a same-origin board session and validates reports within 16 KiB", async () => {
    const app = setup();
    const report = { message: "Client crashed", route: "/board?token=private", meta: { token: "private" } };
    await app.post(clientPath).send(report).expect(403);
    await app.post(clientPath).set({ origin: "https://other.example", "sec-fetch-site": "cross-site" }).send(report).expect(403);
    await setup({ ...admin, source: "board_key" }).post(clientPath).set(browserHeaders).send(report).expect(403);
    await app.post(clientPath).set(browserHeaders).send({ message: " " }).expect(400);
    await app.post(clientPath).set(browserHeaders).type("json").send("{").expect(400);
    await app.post(clientPath).set(browserHeaders).send({ message: "Error", meta: { large: "é".repeat(8192) } }).expect(413);
    const { body } = await app.post(`${clientPath.toUpperCase()}/`).set(browserHeaders).send(report).expect(202);
    expect(body).toMatchObject({ ok: true, id: expect.any(String) });
    expect(await queryErrorLog()).toMatchObject({
      total: 1,
      items: [{ id: body.id, route: "/board", source: "client", meta: { token: "[REDACTED]" } }],
    });
  });

  it("limits each session and IP to 30 submissions per minute", async () => {
    const app = setup();
    for (let index = 0; index < 30; index++) {
      await app.post(clientPath).set(browserHeaders).send({ message: "" }).expect(400);
    }
    await app.post(clientPath).set(browserHeaders).set("x-forwarded-for", "192.0.2.1").send({ message: "Test" }).expect(429);
    const retry = await app.post(clientPath).set(browserHeaders).set("x-test-session", "new-session").send({ message: "Test" }).expect(429);
    expect(retry.headers["retry-after"]).toBe("60");
  });

  it("keeps HTTP error responses working when the log cannot be written", async () => {
    const brokenHome = join(home, "file");
    await writeFile(brokenHome, "");
    vi.stubEnv("PAPERCLIP_HOME", brokenHome);
    const app = setup();
    await app.get("/unexpected-error").expect(500, { error: "Internal server error" });
    await app.post(clientPath).set(browserHeaders).send({ message: "Browser failed" }).expect(503);
  });
});
