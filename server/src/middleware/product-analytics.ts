import type { NextFunction, Request, Response } from "express";

import { serverProductAnalytics } from "../product-analytics.js";

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SKIP_PATHS = new Set(["/metrics", "/api/health", "/api/ready", "/api/liveness"]);

/** Replace ids with stable placeholders so analytics receives route shapes. */
export function analyticsRouteTemplate(path: string): string {
  return path
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "/:id")
    .replace(/\/[A-Z][A-Z0-9]+-\d+/g, "/:task")
    .replace(/\/\d+/g, "/:n")
    .slice(0, 200);
}

/**
 * Record mutation route usage as a product event.
 *
 * Read requests are excluded because they dominate traffic and reveal no
 * intent. The event carries only the method, the matched route template, the
 * status and the duration. It never reads the body, query, params or user.
 */
export function productAnalyticsMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!serverProductAnalytics.enabled || !MUTATION_METHODS.has(req.method)) {
    next();
    return;
  }
  const startedAt = process.hrtime.bigint();
  res.on("finish", () => {
    try {
      const rawPath = `${req.baseUrl ?? ""}${req.route?.path ?? ""}`;
      if (!rawPath || SKIP_PATHS.has(rawPath)) return;
      serverProductAnalytics.capture("api_mutation", {
        method: req.method,
        route: analyticsRouteTemplate(rawPath),
        status: res.statusCode,
        duration_ms: Number(process.hrtime.bigint() - startedAt) / 1e6,
      });
    } catch {
      // Analytics must never affect the response.
    }
  });
  next();
}
