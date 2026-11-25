import { Router, type Request, type Response } from "express";
import { assertInstanceAdmin } from "../routes/authz.js";

export interface GatewayProxyOptions {
  baseUrl?: string;
  adminKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_GATEWAY_URL = "https://increase-roas-oauth-gateway.increase-roas.workers.dev";
const DEFAULT_TIMEOUT_MS = 20_000;
const USER_AGENT = "paperclip-server/1.0";

const AGENT_PARAM_RE = /^[a-z][a-z0-9_-]{1,31}$/;
const INTEGRATION_PARAM_RE = /^[a-z][a-z0-9_-]{1,40}$/;
const SCOPE_ID_PARAM_RE = /^[A-Za-z0-9_.:\/-]{1,120}$/;
const SAFE_QUERY_KEY_RE = /^[A-Za-z0-9_.-]{1,40}$/;

function resolveBaseUrl(opts?: GatewayProxyOptions): string {
  return (opts?.baseUrl ?? process.env.OAUTH_GATEWAY_URL ?? DEFAULT_GATEWAY_URL)
    .trim()
    .replace(/\/+$/, "");
}

function resolveAuthKey(req: Request, opts?: GatewayProxyOptions): string {
  const configured =
    opts?.adminKey !== undefined
      ? opts.adminKey.trim()
      : (process.env.GATEWAY_ADMIN_KEY ?? "").trim();
  if (configured) return configured;

  const headerValue = req.headers["x-gateway-owner-key"];
  if (typeof headerValue === "string") return headerValue.trim();
  if (Array.isArray(headerValue) && typeof headerValue[0] === "string") {
    return headerValue[0].trim();
  }
  return "";
}

function buildSafeQueryString(req: Request): string {
  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(req.query)) {
    if (!SAFE_QUERY_KEY_RE.test(key)) continue;
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (typeof raw === "string") {
      if (raw.length <= 256) params.append(key, raw);
    } else if (Array.isArray(raw)) {
      for (const item of raw) {
        if (typeof item === "string" && item.length <= 256) {
          params.append(key, item);
        }
      }
    }
  }
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}

function validateParam(
  raw: unknown,
  pattern: RegExp,
  name: string,
  res: Response,
): string | null {
  const value = typeof raw === "string" ? raw : "";
  if (!pattern.test(value)) {
    res.status(400).json({ ok: false, error: `Invalid ${name} parameter.` });
    return null;
  }
  return value;
}

export function gatewayProxyRoutes(opts?: GatewayProxyOptions) {
  const router = Router();
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts?.fetchImpl ?? fetch;

  async function forward(
    req: Request,
    res: Response,
    upstreamPath: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    forwardQuery = true,
  ) {
    assertInstanceAdmin(req);

    const baseUrl = resolveBaseUrl(opts);
    const authKey = resolveAuthKey(req, opts);
    const qs = forwardQuery ? buildSafeQueryString(req) : "";
    const targetUrl = `${baseUrl}${upstreamPath}${qs}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {
        accept: "application/json",
        "user-agent": USER_AGENT,
      };
      if (authKey) {
        headers.authorization = `Bearer ${authKey}`;
      }
      const init: RequestInit = { method, headers, signal: controller.signal };
      if (method === "POST" || method === "PUT") {
        headers["content-type"] = "application/json";
        init.body = JSON.stringify(
          req.body && typeof req.body === "object" ? req.body : {},
        );
      } else if (
        method === "DELETE" &&
        req.body &&
        typeof req.body === "object" &&
        Object.keys(req.body as Record<string, unknown>).length > 0
      ) {
        headers["content-type"] = "application/json";
        init.body = JSON.stringify(req.body);
      }

      const upstream = await fetchImpl(targetUrl, init);
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
        error: aborted ? "Gateway timed out." : "Could not reach OAuth gateway.",
      });
    } finally {
      clearTimeout(timer);
    }
  }

  router.get("/gateway/health", async (req, res) => {
    await forward(req, res, "/health", "GET");
  });

  router.get("/gateway/status", async (req, res) => {
    await forward(req, res, "/api/status", "GET");
  });

  router.get("/gateway/providers", async (req, res) => {
    await forward(req, res, "/api/providers", "GET");
  });

  router.get("/gateway/admin/health", async (req, res) => {
    await forward(req, res, "/api/admin/health", "GET");
  });

  router.get("/gateway/admin/agents", async (req, res) => {
    await forward(req, res, "/api/admin/agents", "GET");
  });

  router.get("/gateway/admin/bots", async (req, res) => {
    await forward(req, res, "/api/admin/bots", "GET");
  });

  router.get("/gateway/admin/bots/:agent/summary", async (req, res) => {
    assertInstanceAdmin(req);
    const agent = validateParam(req.params.agent, AGENT_PARAM_RE, "agent", res);
    if (!agent) return;
    await forward(req, res, `/api/admin/bots/${encodeURIComponent(agent)}/summary`, "GET");
  });

  router.get("/gateway/admin/roles", async (req, res) => {
    await forward(req, res, "/api/admin/roles", "GET");
  });

  router.get("/gateway/admin/agents/:agent/policy", async (req, res) => {
    assertInstanceAdmin(req);
    const agent = validateParam(req.params.agent, AGENT_PARAM_RE, "agent", res);
    if (!agent) return;
    await forward(req, res, `/api/admin/agents/${encodeURIComponent(agent)}/policy`, "GET");
  });

  router.put("/gateway/admin/agents/:agent/policy", async (req, res) => {
    assertInstanceAdmin(req);
    const agent = validateParam(req.params.agent, AGENT_PARAM_RE, "agent", res);
    if (!agent) return;
    await forward(req, res, `/api/admin/agents/${encodeURIComponent(agent)}/policy`, "PUT");
  });

  router.put("/gateway/admin/agents/:agent", async (req, res) => {
    assertInstanceAdmin(req);
    const agent = validateParam(req.params.agent, AGENT_PARAM_RE, "agent", res);
    if (!agent) return;
    await forward(req, res, `/api/admin/agents/${encodeURIComponent(agent)}`, "PUT");
  });

  router.post("/gateway/admin/agents/:agent/new-key", async (req, res) => {
    assertInstanceAdmin(req);
    const agent = validateParam(req.params.agent, AGENT_PARAM_RE, "agent", res);
    if (!agent) return;
    await forward(req, res, `/api/admin/agents/${encodeURIComponent(agent)}/new-key`, "POST");
  });

  router.post("/gateway/admin/agents/:agent/keys/rotate", async (req, res) => {
    assertInstanceAdmin(req);
    const agent = validateParam(req.params.agent, AGENT_PARAM_RE, "agent", res);
    if (!agent) return;
    await forward(req, res, `/api/admin/agents/${encodeURIComponent(agent)}/keys/rotate`, "POST");
  });

  router.post("/gateway/admin/agents/:agent/keys/revoke", async (req, res) => {
    assertInstanceAdmin(req);
    const agent = validateParam(req.params.agent, AGENT_PARAM_RE, "agent", res);
    if (!agent) return;
    await forward(req, res, `/api/admin/agents/${encodeURIComponent(agent)}/keys/revoke`, "POST");
  });

  router.get("/gateway/admin/scopes", async (req, res) => {
    await forward(req, res, "/api/admin/scopes", "GET");
  });

  router.post("/gateway/admin/scopes/:integration", async (req, res) => {
    assertInstanceAdmin(req);
    const integration = validateParam(
      req.params.integration,
      INTEGRATION_PARAM_RE,
      "integration",
      res,
    );
    if (!integration) return;
    await forward(
      req,
      res,
      `/api/admin/scopes/${encodeURIComponent(integration)}`,
      "POST",
    );
  });

  router.delete("/gateway/admin/scopes/:integration/:scopeId", async (req, res) => {
    assertInstanceAdmin(req);
    const integration = validateParam(
      req.params.integration,
      INTEGRATION_PARAM_RE,
      "integration",
      res,
    );
    if (!integration) return;
    const scopeId = validateParam(req.params.scopeId, SCOPE_ID_PARAM_RE, "scopeId", res);
    if (!scopeId) return;
    await forward(
      req,
      res,
      `/api/admin/scopes/${encodeURIComponent(integration)}/${encodeURIComponent(scopeId)}`,
      "DELETE",
    );
  });

  return router;
}
