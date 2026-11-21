import { createMetricsRegistry } from "@paperclipai/shared/observability";
import type { RequestHandler } from "express";

/**
 * Process-wide Prometheus metrics for the API server.
 *
 * Route labels use the matched Express route pattern, never the raw path, so
 * task and company ids do not explode series cardinality. The endpoint is
 * mounted at `/metrics` before the API auth middleware and is expected to be
 * restricted at the network / reverse-proxy layer, like `/api/liveness`.
 */
export const serverMetrics = createMetricsRegistry();

const httpRequests = serverMetrics.counter(
  "paperclip_http_requests_total",
  "HTTP requests handled by the API server, by method, route and status.",
);

const httpDuration = serverMetrics.histogram(
  "paperclip_http_request_duration_ms",
  "HTTP request duration in milliseconds, by method and route.",
);

export const metricsMiddleware: RequestHandler = (req, res, next) => {
  const startedAt = process.hrtime.bigint();
  res.on("finish", () => {
    const route = req.route?.path
      ? `${req.baseUrl}${String(req.route.path)}`
      : req.baseUrl || "unmatched";
    const labels = { method: req.method, route, status: String(res.statusCode) };
    httpRequests.inc(labels);
    httpDuration.observe(
      { method: req.method, route },
      Number(process.hrtime.bigint() - startedAt) / 1_000_000,
    );
  });
  next();
};

export function renderMetrics(): string {
  return serverMetrics.render();
}
