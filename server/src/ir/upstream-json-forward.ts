import type { Request, Response } from "express";

export type UpstreamMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const USER_AGENT = "paperclip-server/1.0";

export interface UpstreamJsonForwardRequest {
  req: Request;
  res: Response;
  fetchImpl: typeof fetch;
  targetUrl: string;
  method: UpstreamMethod;
  bearerToken: string;
  timeoutMs: number;
  timeoutMessage: string;
  unreachableMessage: string;
}

function hasJsonBody(body: unknown): body is Record<string, unknown> {
  return Boolean(body) && typeof body === "object" && Object.keys(body as Record<string, unknown>).length > 0;
}

function buildUpstreamInit(
  req: Request,
  method: UpstreamMethod,
  bearerToken: string,
  signal: AbortSignal,
): RequestInit {
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": USER_AGENT,
  };
  if (bearerToken) headers.authorization = `Bearer ${bearerToken}`;
  const init: RequestInit = { method, headers, redirect: "manual", signal };
  if (method === "POST" || method === "PUT" || method === "PATCH") {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(req.body && typeof req.body === "object" ? req.body : {});
  } else if (method === "DELETE" && hasJsonBody(req.body)) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(req.body);
  }
  return init;
}

/**
 * Sends one request to an upstream JSON API and relays its status and body verbatim.
 * Redirects are not followed so a misconfigured upstream cannot bounce the bearer token elsewhere.
 */
export async function forwardUpstreamJson(request: UpstreamJsonForwardRequest): Promise<void> {
  const { req, res, fetchImpl, targetUrl, method, bearerToken, timeoutMs } = request;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const upstream = await fetchImpl(targetUrl, buildUpstreamInit(req, method, bearerToken, controller.signal));
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
      error: aborted ? request.timeoutMessage : request.unreachableMessage,
    });
  } finally {
    clearTimeout(timer);
  }
}
