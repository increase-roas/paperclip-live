import { Router, type Request, type Response } from "express";
import { assertInstanceAdmin } from "../routes/authz.js";

export interface SalesDashboardProxyOptions {
  baseUrl?: string;
  adminKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_SALES_DASHBOARD_URL = "https://dashboard.increaseai.tech";
const DEFAULT_TIMEOUT_MS = 20_000;
const USER_AGENT = "paperclip-server/1.0";

const ALLOWED_QUERY_PARAMS = new Set([
  "view",
  "slug",
  "mode",
  "provider",
  "locationId",
  "offset",
  "limit",
  "q",
  "id",
  "clientId",
  "days",
]);

function resolveBaseUrl(opts?: SalesDashboardProxyOptions): string {
  return (opts?.baseUrl ?? process.env.SALES_DASHBOARD_BASE_URL ?? DEFAULT_SALES_DASHBOARD_URL)
    .trim()
    .replace(/\/+$/, "");
}

function resolveAdminKey(opts?: SalesDashboardProxyOptions): string {
  return (
    opts?.adminKey !== undefined
      ? opts.adminKey
      : (process.env.SALES_DASHBOARD_ADMIN_KEY ?? "")
  ).trim();
}

function buildAllowlistedQueryString(
  req: Request,
  defaults?: Record<string, string>,
): string {
  const params = new URLSearchParams();
  if (defaults) {
    for (const [k, v] of Object.entries(defaults)) {
      if (ALLOWED_QUERY_PARAMS.has(k)) params.set(k, v);
    }
  }
  for (const [key, raw] of Object.entries(req.query)) {
    if (!ALLOWED_QUERY_PARAMS.has(key)) continue;
    if (typeof raw === "string") {
      if (raw.length <= 256) params.set(key, raw);
    } else if (Array.isArray(raw)) {
      const valid = raw.filter(
        (item): item is string => typeof item === "string" && item.length <= 256,
      );
      if (valid.length > 0) {
        params.delete(key);
        for (const item of valid) {
          params.append(key, item);
        }
      }
    }
  }
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}

export function salesDashboardProxyRoutes(opts?: SalesDashboardProxyOptions) {
  const router = Router();
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts?.fetchImpl ?? fetch;

  async function forward(
    req: Request,
    res: Response,
    upstreamPath: string,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    defaultQuery?: Record<string, string>,
  ) {
    assertInstanceAdmin(req);

    const adminKey = resolveAdminKey(opts);
    if (!adminKey) {
      res.status(503).json({
        ok: false,
        error: "Sales dashboard admin key is not configured.",
      });
      return;
    }

    const baseUrl = resolveBaseUrl(opts);
    const qs = buildAllowlistedQueryString(req, defaultQuery);
    const targetUrl = `${baseUrl}${upstreamPath}${qs}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {
        authorization: `Bearer ${adminKey}`,
        accept: "application/json",
        "user-agent": USER_AGENT,
      };
      const init: RequestInit = {
        method,
        headers,
        redirect: "manual",
        signal: controller.signal,
      };
      if (method === "POST" || method === "PUT" || method === "PATCH") {
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
        error: aborted
          ? "Sales dashboard timed out."
          : "Could not reach Sales dashboard.",
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // Tenants
  router.get("/sales-dashboard/tenants", async (req, res) => {
    await forward(req, res, "/api/pilot/admin/tenants", "GET");
  });
  router.post("/sales-dashboard/tenants", async (req, res) => {
    await forward(req, res, "/api/pilot/admin/tenants", "POST");
  });
  router.put("/sales-dashboard/tenants", async (req, res) => {
    await forward(req, res, "/api/pilot/admin/tenants", "PUT");
  });
  router.patch("/sales-dashboard/tenants", async (req, res) => {
    await forward(req, res, "/api/pilot/admin/tenants", "PATCH");
  });

  // Diagnostic
  router.get("/sales-dashboard/diagnostic", async (req, res) => {
    await forward(req, res, "/api/pilot/admin/diagnostic", "GET");
  });
  router.post("/sales-dashboard/diagnostic", async (req, res) => {
    await forward(req, res, "/api/pilot/admin/diagnostic", "POST");
  });

  // Discovery
  router.get("/sales-dashboard/discovery", async (req, res) => {
    await forward(req, res, "/api/pilot/admin/discovery", "GET");
  });

  // Accounting
  router.get("/sales-dashboard/accounting", async (req, res) => {
    await forward(req, res, "/api/pilot/admin/accounting", "GET");
  });
  router.post("/sales-dashboard/accounting", async (req, res) => {
    await forward(req, res, "/api/pilot/admin/accounting", "POST");
  });
  router.delete("/sales-dashboard/accounting", async (req, res) => {
    await forward(req, res, "/api/pilot/admin/accounting", "DELETE");
  });

  // Capital & Snapshots (default view=30d)
  router.get("/sales-dashboard/capital", async (req, res) => {
    await forward(req, res, "/api/pilot/admin/capital", "GET", { view: "30d" });
  });
  router.get("/sales-dashboard/snapshots", async (req, res) => {
    await forward(req, res, "/api/pilot/admin/snapshots", "GET", { view: "30d" });
  });

  // Team & Settings
  router.get("/sales-dashboard/team", async (req, res) => {
    await forward(req, res, "/api/pilot/admin/team", "GET");
  });
  router.post("/sales-dashboard/team", async (req, res) => {
    await forward(req, res, "/api/pilot/admin/team", "POST");
  });
  router.put("/sales-dashboard/team", async (req, res) => {
    await forward(req, res, "/api/pilot/admin/team", "PUT");
  });
  router.delete("/sales-dashboard/team", async (req, res) => {
    await forward(req, res, "/api/pilot/admin/team", "DELETE");
  });
  router.get("/sales-dashboard/team/settings", async (req, res) => {
    await forward(req, res, "/api/pilot/admin/team/settings", "GET");
  });
  router.put("/sales-dashboard/team/settings", async (req, res) => {
    await forward(req, res, "/api/pilot/admin/team/settings", "PUT");
  });

  // MCP Tokens
  router.get("/sales-dashboard/mcp-tokens", async (req, res) => {
    await forward(req, res, "/api/pilot/admin/mcp-tokens", "GET");
  });
  router.post("/sales-dashboard/mcp-tokens", async (req, res) => {
    await forward(req, res, "/api/pilot/admin/mcp-tokens", "POST");
  });
  router.delete("/sales-dashboard/mcp-tokens", async (req, res) => {
    await forward(req, res, "/api/pilot/admin/mcp-tokens", "DELETE");
  });

  // Neon Ads & Sync
  router.get("/sales-dashboard/neon-ads", async (req, res) => {
    await forward(req, res, "/api/pilot/neon-ads", "GET");
  });
  router.get("/sales-dashboard/sync", async (req, res) => {
    await forward(req, res, "/api/pilot/admin/sync", "GET");
  });
  router.post("/sales-dashboard/sync", async (req, res) => {
    await forward(req, res, "/api/pilot/admin/sync", "POST");
  });

  return router;
}
