import { Router, type Request, type Response } from "express";
import { assertInstanceAdmin } from "../routes/authz.js";
import { forwardUpstreamJson } from "./upstream-json-forward.js";
import { resetQuickBooksCache } from "./quickbooks-client.js";
import {
  GATEWAY_PROVIDER_SECRETS,
  putCloudflareWorkerSecrets,
  resolveCloudflareSecretConfig,
  validateProviderSecretsPayload,
  type CloudflareSecretWriterOptions,
} from "./gateway-secrets.js";

export interface GatewayProxyOptions {
  baseUrl?: string;
  adminKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  cloudflare?: CloudflareSecretWriterOptions;
}

const DEFAULT_GATEWAY_URL = "https://increase-roas-oauth-gateway.increase-roas.workers.dev";
const DEFAULT_TIMEOUT_MS = 20_000;

const AGENT_PARAM_RE = /^[a-z][a-z0-9_-]{1,31}$/;
const INTEGRATION_PARAM_RE = /^[a-z][a-z0-9_-]{1,40}$/;
const OAUTH_PROVIDER_PARAM_RE = /^(?:quickbooks|gmail|zoom)$/;
const OAUTH_ACCOUNT_PARAM_RE = /^[A-Za-z0-9_.@:+-]{1,200}$/;
const SCOPE_ID_PARAM_RE = /^[A-Za-z0-9_.:/-]{1,120}$/;
const SAFE_QUERY_KEY_RE = /^[A-Za-z0-9_.-]{1,40}$/;
const OWNER_KEY_HEADER_RE = /^[\x21-\x7e]{1,512}$/;

function resolveBaseUrl(opts?: GatewayProxyOptions): string {
  return (opts?.baseUrl ?? process.env.OAUTH_GATEWAY_URL ?? DEFAULT_GATEWAY_URL)
    .trim()
    .replace(/\/+$/, "");
}

function resolveAuthKey(
  req: Request,
  opts?: GatewayProxyOptions,
): { key: string; invalidHeader: boolean } {
  const configured =
    opts?.adminKey !== undefined
      ? opts.adminKey.trim()
      : (process.env.GATEWAY_ADMIN_KEY ?? "").trim();
  if (configured) return { key: configured, invalidHeader: false };

  const headerValue = req.headers["x-gateway-owner-key"];
  const raw =
    typeof headerValue === "string"
      ? headerValue.trim()
      : Array.isArray(headerValue) && typeof headerValue[0] === "string"
        ? headerValue[0].trim()
        : "";
  if (!raw) return { key: "", invalidHeader: false };
  if (!OWNER_KEY_HEADER_RE.test(raw)) return { key: "", invalidHeader: true };
  return { key: raw, invalidHeader: false };
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

function validateScopeId(raw: unknown, res: Response): string | null {
  const value = typeof raw === "string" ? raw : "";
  if (
    !SCOPE_ID_PARAM_RE.test(value) ||
    value === "." ||
    value === ".." ||
    value.includes("..") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("//") ||
    value.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    res.status(400).json({ ok: false, error: "Invalid scopeId parameter." });
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
    const auth = resolveAuthKey(req, opts);
    if (auth.invalidHeader) {
      res.status(400).json({ ok: false, error: "Invalid gateway owner key header." });
      return;
    }
    const authKey = auth.key;
    if (!authKey && upstreamPath.startsWith("/api/admin/")) {
      res.status(503).json({
        ok: false,
        error: "Gateway admin key is not configured on this server.",
      });
      return;
    }
    const qs = forwardQuery ? buildSafeQueryString(req) : "";
    const targetUrl = `${baseUrl}${upstreamPath}${qs}`;

    await forwardUpstreamJson({
      req,
      res,
      fetchImpl,
      targetUrl,
      method,
      bearerToken: authKey,
      timeoutMs,
      timeoutMessage: "Gateway timed out.",
      unreachableMessage: "Could not reach OAuth gateway.",
    });
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
    const scopeId = validateScopeId(req.params.scopeId, res);
    if (!scopeId) return;
    await forward(
      req,
      res,
      `/api/admin/scopes/${encodeURIComponent(integration)}/${encodeURIComponent(scopeId)}`,
      "DELETE",
    );
  });

  router.post("/gateway/admin/oauth/:provider/launch", async (req, res) => {
    assertInstanceAdmin(req);
    const provider = validateParam(
      req.params.provider,
      OAUTH_PROVIDER_PARAM_RE,
      "provider",
      res,
    );
    if (!provider) return;
    if (provider === "quickbooks") resetQuickBooksCache();
    await forward(
      req,
      res,
      `/api/admin/oauth/${encodeURIComponent(provider)}/launch`,
      "POST",
    );
  });

  router.delete("/gateway/admin/oauth/:provider/:accountId", async (req, res) => {
    assertInstanceAdmin(req);
    const provider = validateParam(
      req.params.provider,
      OAUTH_PROVIDER_PARAM_RE,
      "provider",
      res,
    );
    if (!provider) return;
    if (provider === "quickbooks") resetQuickBooksCache();
    const rawAccount = typeof req.params.accountId === "string" ? req.params.accountId : "";
    if (
      !OAUTH_ACCOUNT_PARAM_RE.test(rawAccount) ||
      rawAccount === "." ||
      rawAccount === ".." ||
      rawAccount.includes("..")
    ) {
      res.status(400).json({ ok: false, error: "Invalid accountId parameter." });
      return;
    }
    await forward(
      req,
      res,
      `/api/admin/oauth/${encodeURIComponent(provider)}/${encodeURIComponent(rawAccount)}`,
      "DELETE",
    );
  });

  router.get("/gateway/admin/secrets/schema", (req, res) => {
    assertInstanceAdmin(req);
    const cf = resolveCloudflareSecretConfig(opts?.cloudflare);
    res.json({
      ok: true,
      configured: cf.configured,
      workerName: cf.workerName,
      providers: GATEWAY_PROVIDER_SECRETS,
    });
  });

  router.put("/gateway/admin/secrets/:provider", async (req, res) => {
    assertInstanceAdmin(req);
    const provider = validateParam(
      req.params.provider,
      INTEGRATION_PARAM_RE,
      "provider",
      res,
    );
    if (!provider) return;

    const validated = validateProviderSecretsPayload(
      provider,
      (req.body as { secrets?: unknown } | undefined)?.secrets,
    );
    if (!validated.ok) {
      res.status(400).json({ ok: false, error: validated.error });
      return;
    }

    const result = await putCloudflareWorkerSecrets(validated.entries, {
      ...opts?.cloudflare,
      fetchImpl: opts?.cloudflare?.fetchImpl ?? fetchImpl,
      timeoutMs: opts?.cloudflare?.timeoutMs ?? timeoutMs,
    });
    if (!result.ok) {
      res.status(result.status).json({ ok: false, error: result.error });
      return;
    }

    if (provider === "quickbooks") resetQuickBooksCache();
    res.json({
      ok: true,
      provider,
      updatedKeys: result.updatedKeys,
    });
  });

  return router;
}
