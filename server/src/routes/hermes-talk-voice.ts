import { Router, type Request, type Response } from "express";
import { assertInstanceAdmin } from "./authz.js";

export interface HermesTalkVoiceRouteOptions {
  upstreamUrl?: string;
  sessionToken?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const TOOL_TIMEOUT_MS = 95_000;

function readConfig(opts?: HermesTalkVoiceRouteOptions) {
  const upstreamUrl = (opts?.upstreamUrl ?? process.env.HERMES_TALK_UPSTREAM_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
  const sessionToken = (opts?.sessionToken ?? process.env.HERMES_TALK_SESSION_TOKEN ?? "").trim();
  const fetchImpl = opts?.fetchImpl ?? fetch;
  return { upstreamUrl, sessionToken, fetchImpl };
}

async function forwardToHermesTalk(
  req: Request,
  res: Response,
  opts: HermesTalkVoiceRouteOptions | undefined,
  upstreamPath: string,
  method: "GET" | "POST",
  timeoutMs: number,
) {
  assertInstanceAdmin(req);
  const { upstreamUrl, sessionToken, fetchImpl } = readConfig(opts);
  if (!upstreamUrl || !sessionToken) {
    res.status(503).json({
      ok: false,
      configured: false,
      error: "Hermes Talk voice bridge is not configured on this Paperclip server.",
    });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      "x-hermes-session-token": sessionToken,
      accept: "application/json",
    };
    const init: RequestInit = { method, headers, signal: controller.signal };
    if (method === "POST") {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(req.body && typeof req.body === "object" ? req.body : {});
    }

    const upstream = await fetchImpl(`${upstreamUrl}/api/plugins/hermes-talk${upstreamPath}`, init);
    if (upstream.status === 401 || upstream.status === 403) {
      res.status(502).json({
        ok: false,
        error: "Hermes Talk voice bridge authentication is misconfigured.",
      });
      return;
    }

    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.send(text);
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    res.status(aborted ? 504 : 502).json({
      ok: false,
      error: aborted
        ? "Hermes Talk voice server timed out."
        : "Could not reach the Hermes Talk voice server.",
    });
  } finally {
    clearTimeout(timer);
  }
}

export function hermesTalkVoiceRoutes(opts?: HermesTalkVoiceRouteOptions) {
  const router = Router();

  router.get("/voice/hermes-talk/status", async (req, res) => {
    await forwardToHermesTalk(req, res, opts, "/status", "GET", DEFAULT_TIMEOUT_MS);
  });

  router.post("/voice/hermes-talk/session", async (req, res) => {
    await forwardToHermesTalk(req, res, opts, "/session", "POST", DEFAULT_TIMEOUT_MS);
  });

  router.post("/voice/hermes-talk/tool", async (req, res) => {
    await forwardToHermesTalk(req, res, opts, "/tool", "POST", TOOL_TIMEOUT_MS);
  });

  router.get("/voice/hermes-talk/runs", async (req, res) => {
    await forwardToHermesTalk(req, res, opts, "/runs", "GET", DEFAULT_TIMEOUT_MS);
  });

  router.post("/voice/hermes-talk/journal", async (req, res) => {
    await forwardToHermesTalk(req, res, opts, "/journal", "POST", DEFAULT_TIMEOUT_MS);
  });

  router.get("/voice/hermes-talk/workflows", async (req, res) => {
    await forwardToHermesTalk(req, res, opts, "/workflows", "GET", DEFAULT_TIMEOUT_MS);
  });

  router.get("/voice/hermes-talk/workflows/read", async (req, res) => {
    const rawPath = typeof req.query.path === "string" ? req.query.path : "";
    const qs = rawPath ? `?path=${encodeURIComponent(rawPath)}` : "";
    await forwardToHermesTalk(req, res, opts, `/workflows/read${qs}`, "GET", DEFAULT_TIMEOUT_MS);
  });

  router.post("/voice/hermes-talk/workflows/save", async (req, res) => {
    await forwardToHermesTalk(req, res, opts, "/workflows/save", "POST", TOOL_TIMEOUT_MS);
  });

  const SALES_DASH_BASE = (process.env.SALES_DASHBOARD_BASE_URL ?? "https://dashboard.increaseai.tech").trim().replace(/\/+$/, "");

  async function forwardToSalesDash(req: Request, res: Response, sdPath: string, method: "GET" | "POST") {
    assertInstanceAdmin(req);
    const adminKey = (process.env.SALES_DASHBOARD_ADMIN_KEY ?? "").trim();
    if (!adminKey) {
      res.status(503).json({ ok: false, error: "Sales dashboard admin key is not configured." });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${adminKey}`, accept: "application/json" };
      const init: RequestInit = { method, headers, signal: controller.signal };
      if (method === "POST") {
        headers["content-type"] = "application/json";
        init.body = JSON.stringify(req.body && typeof req.body === "object" ? req.body : {});
      }
      const upstream = await (opts?.fetchImpl ?? fetch)(`${SALES_DASH_BASE}${sdPath}`, init);
      const text = await upstream.text();
      res.status(upstream.status);
      res.setHeader("cache-control", "no-store");
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.send(text);
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      res.status(aborted ? 504 : 502).json({ ok: false, error: aborted ? "Sales dashboard timed out." : "Could not reach Sales dashboard." });
    } finally {
      clearTimeout(timer);
    }
  }

  router.get("/sales-dashboard/tenants", async (req, res) => { await forwardToSalesDash(req, res, "/api/pilot/admin/tenants", "GET"); });
  router.get("/sales-dashboard/capital", async (req, res) => { await forwardToSalesDash(req, res, "/api/pilot/admin/capital?view=30d", "GET"); });
  router.post("/sales-dashboard/sync", async (req, res) => { await forwardToSalesDash(req, res, "/api/pilot/admin/sync", "POST"); });

  router.get("/sales-dashboard/admin-key", async (req, res) => {
    assertInstanceAdmin(req);
    const adminKey = (process.env.SALES_DASHBOARD_ADMIN_KEY ?? "").trim();
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    if (!adminKey) {
      res.status(503).json({ ok: false, configured: false, error: "Sales dashboard admin key is not configured." });
      return;
    }
    res.status(200).json({ ok: true, adminKey });
  });

  const GATEWAY_BASE = (process.env.OAUTH_GATEWAY_URL ?? "https://increase-roas-oauth-gateway.increase-roas.workers.dev").trim().replace(/\/+$/, "");

  async function forwardToGateway(req: Request, res: Response, gwPath: string, method: "GET" | "POST") {
    assertInstanceAdmin(req);
    const ownerKey = String(req.headers["x-gateway-owner-key"] ?? process.env.GATEWAY_ADMIN_KEY ?? "").trim();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (ownerKey) headers.authorization = `Bearer ${ownerKey}`;
      const init: RequestInit = { method, headers, signal: controller.signal };
      if (method === "POST") {
        headers["content-type"] = "application/json";
        init.body = JSON.stringify(req.body && typeof req.body === "object" ? req.body : {});
      }
      const upstream = await (opts?.fetchImpl ?? fetch)(`${GATEWAY_BASE}${gwPath}`, init);
      const text = await upstream.text();
      res.status(upstream.status);
      res.setHeader("cache-control", "no-store");
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.send(text);
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      res.status(aborted ? 504 : 502).json({ ok: false, error: aborted ? "Gateway timed out." : "Could not reach OAuth gateway." });
    } finally {
      clearTimeout(timer);
    }
  }

  router.get("/gateway/health", async (req, res) => { await forwardToGateway(req, res, "/health", "GET"); });
  router.get("/gateway/providers", async (req, res) => { await forwardToGateway(req, res, "/api/providers", "GET"); });
  router.get("/gateway/admin/agents", async (req, res) => { await forwardToGateway(req, res, "/api/admin/agents", "GET"); });
  router.get("/gateway/admin/roles", async (req, res) => { await forwardToGateway(req, res, "/api/admin/roles", "GET"); });
  router.post("/gateway/admin/agents/:agent/new-key", async (req, res) => {
    const agent = encodeURIComponent(String(req.params.agent ?? ""));
    await forwardToGateway(req, res, `/api/admin/agents/${agent}/new-key`, "POST");
  });

  return router;
}
