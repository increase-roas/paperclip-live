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

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function validateWorkflowPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (
    !trimmed ||
    trimmed.length > 256 ||
    trimmed.includes("..") ||
    trimmed.startsWith("/") ||
    trimmed.endsWith("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("//") ||
    hasControlChar(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

type ExistingWorkflowLookup =
  | { kind: "missing" }
  | { kind: "exists"; existingPath: string }
  | { kind: "auth_error" }
  | { kind: "timeout" }
  | { kind: "upstream_error" };

async function lookupExistingWorkflow(
  opts: HermesTalkVoiceRouteOptions | undefined,
  candidatePath: string,
): Promise<ExistingWorkflowLookup> {
  const { upstreamUrl, sessionToken, fetchImpl } = readConfig(opts);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const upstream = await fetchImpl(`${upstreamUrl}/api/plugins/hermes-talk/workflows`, {
      method: "GET",
      headers: {
        "x-hermes-session-token": sessionToken,
        accept: "application/json",
      },
      redirect: "manual",
      signal: controller.signal,
    });
    if (upstream.status === 401 || upstream.status === 403) {
      return { kind: "auth_error" };
    }
    if (!upstream.ok) {
      return { kind: "upstream_error" };
    }
    let parsed: { workflows?: unknown };
    try {
      parsed = (await upstream.json()) as { workflows?: unknown };
    } catch {
      return { kind: "upstream_error" };
    }
    if (!Array.isArray(parsed?.workflows)) {
      return { kind: "upstream_error" };
    }
    const targetLower = candidatePath.toLowerCase();
    for (const item of parsed.workflows) {
      if (item && typeof item === "object" && typeof (item as { path?: unknown }).path === "string") {
        const existingPath = ((item as { path: string }).path).trim();
        if (existingPath.toLowerCase() === targetLower) {
          return { kind: "exists", existingPath };
        }
      }
    }
    return { kind: "missing" };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return { kind: aborted ? "timeout" : "upstream_error" };
  } finally {
    clearTimeout(timer);
  }
}

async function forwardToHermesTalk(
  req: Request,
  res: Response,
  opts: HermesTalkVoiceRouteOptions | undefined,
  upstreamPath: string,
  method: "GET" | "POST",
  timeoutMs: number,
  bodyOverride?: Record<string, unknown>,
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
    const init: RequestInit = {
      method,
      headers,
      redirect: "manual",
      signal: controller.signal,
    };
    if (method === "POST") {
      headers["content-type"] = "application/json";
      const payload =
        bodyOverride ?? (req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {});
      init.body = JSON.stringify(payload);
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
  const pendingCreatePaths = new Set<string>();

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
    const rawPath = typeof req.query.path === "string" ? req.query.path.trim() : "";
    if (rawPath && !validateWorkflowPath(rawPath)) {
      res.status(400).json({ ok: false, error: "Invalid workflow path." });
      return;
    }
    const qs = rawPath ? `?path=${encodeURIComponent(rawPath)}` : "";
    await forwardToHermesTalk(req, res, opts, `/workflows/read${qs}`, "GET", DEFAULT_TIMEOUT_MS);
  });

  router.post("/voice/hermes-talk/workflows/save", async (req, res) => {
    assertInstanceAdmin(req);
    const body =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : null;
    if (!body) {
      res.status(400).json({ ok: false, error: "Invalid workflow save payload." });
      return;
    }

    const normalizedPath = validateWorkflowPath(body.path);
    if (!normalizedPath) {
      res.status(400).json({ ok: false, error: "Invalid workflow path." });
      return;
    }
    if (typeof body.content !== "string") {
      res.status(400).json({ ok: false, error: "Workflow content must be a string." });
      return;
    }
    if (body.mode !== undefined && body.mode !== "create" && body.mode !== "update") {
      res.status(400).json({ ok: false, error: 'Invalid workflow save mode. Expected "create" or "update".' });
      return;
    }
    if (body.overwrite !== undefined && typeof body.overwrite !== "boolean") {
      res.status(400).json({ ok: false, error: "Invalid overwrite flag." });
      return;
    }

    const isExplicitUpdate = body.mode === "update" && body.overwrite !== false;
    const upstreamPayload = { path: normalizedPath, content: body.content };

    if (isExplicitUpdate) {
      await forwardToHermesTalk(req, res, opts, "/workflows/save", "POST", TOOL_TIMEOUT_MS, upstreamPayload);
      return;
    }

    const { upstreamUrl, sessionToken } = readConfig(opts);
    if (!upstreamUrl || !sessionToken) {
      res.status(503).json({
        ok: false,
        configured: false,
        error: "Hermes Talk voice bridge is not configured on this Paperclip server.",
      });
      return;
    }

    const lockKey = normalizedPath.toLowerCase();
    if (pendingCreatePaths.has(lockKey)) {
      res.status(409).json({
        ok: false,
        error: "workflow_already_exists",
        detail: `A playbook creation is already in progress for "${normalizedPath}".`,
      });
      return;
    }

    pendingCreatePaths.add(lockKey);
    try {
      const lookup = await lookupExistingWorkflow(opts, normalizedPath);
      if (lookup.kind === "exists") {
        res.status(409).json({
          ok: false,
          error: "workflow_already_exists",
          detail: `A playbook already exists at "${lookup.existingPath}". Choose a different name or edit the existing playbook.`,
        });
        return;
      }
      if (lookup.kind === "auth_error") {
        res.status(502).json({
          ok: false,
          error: "Hermes Talk voice bridge authentication is misconfigured.",
        });
        return;
      }
      if (lookup.kind === "timeout") {
        res.status(504).json({
          ok: false,
          error: "Hermes Talk voice server timed out.",
        });
        return;
      }
      if (lookup.kind === "upstream_error") {
        res.status(502).json({
          ok: false,
          error: "Could not verify existing workflow playbooks before creating.",
        });
        return;
      }
      await forwardToHermesTalk(req, res, opts, "/workflows/save", "POST", TOOL_TIMEOUT_MS, upstreamPayload);
    } finally {
      pendingCreatePaths.delete(lockKey);
    }
  });

  return router;
}
