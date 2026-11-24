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

  return router;
}
