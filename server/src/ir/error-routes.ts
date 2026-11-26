import { json, Router, type Request, type RequestHandler } from "express";
import { z } from "zod";
import { forbidden } from "../errors.js";
import { trustedBoardMutationOrigin } from "../middleware/board-mutation-guard.js";
import { assertInstanceAdmin } from "../routes/authz.js";
import { queryErrorLog, recordClientError } from "./error-log.js";

const CLIENT_PATH = "/ir/errors/client";
const CLIENT_BODY_LIMIT = 16 * 1024;
const WINDOW_MS = 60_000;
const MAX_REPORTS = 30;

const severity = z.enum(["error", "fatal"]);
const clientReport = z.strictObject({
  message: z.string().trim().min(1).max(2048),
  severity: severity.default("error"),
  stack: z.string().max(8192).optional(),
  route: z.string().max(1024).startsWith("/").optional(),
  componentStack: z.string().max(4096).optional(),
  release: z.string().max(128).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

const search = z.object({
  q: z.string().trim().max(1024).optional(),
  source: z.enum(["server", "client"]).optional(),
  severity: severity.optional(),
  since: z.iso.datetime({ offset: true }).optional(),
  limit: z.string().regex(/^\d{1,9}$/).transform(Number).refine((value) => value >= 1).optional(),
});

export function isClientErrorPost(req: Request): boolean {
  return req.method === "POST" && req.path.toLowerCase().replace(/\/$/, "") === `/api${CLIENT_PATH}`;
}

function allowClientReports(): RequestHandler {
  const buckets = new Map<string, { count: number; expiresAt: number }>();
  return (req, res, next) => {
    const actor = req.actor;
    const fetchSite = req.get("sec-fetch-site");
    if (
      actor?.type !== "board"
      || (actor.source !== "session" && actor.source !== "local_implicit")
      || (fetchSite && fetchSite !== "same-origin")
      || !trustedBoardMutationOrigin(req)
    ) {
      res.status(403).json({ error: "Same-origin board session required" });
      return;
    }

    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.expiresAt > now) break;
      buckets.delete(key);
    }
    const keys = [
      `ip:${req.ip ?? req.socket.remoteAddress ?? "unknown"}`,
      `session:${actor.sessionId ?? actor.userId}`,
    ];
    if (buckets.size >= 10_000 || keys.some((key) => (buckets.get(key)?.count ?? 0) >= MAX_REPORTS)) {
      res.set("Retry-After", "60").status(429).json({ error: "Too many error reports" });
      return;
    }
    for (const key of keys) {
      const bucket = buckets.get(key) ?? { count: 0, expiresAt: now + WINDOW_MS };
      bucket.count++;
      buckets.set(key, bucket);
    }
    next();
  };
}

const parseJson = json({ limit: CLIENT_BODY_LIMIT, inflate: false });
const parseClientBody: RequestHandler = (req, res, next) => {
  if (!req.is("application/json")) {
    res.status(415).json({ error: "Expected application/json" });
    return;
  }
  parseJson(req, res, (error?: { status?: number }) => {
    if (!error) {
      next();
      return;
    }
    const status = error.status === 413 || error.status === 415 ? error.status : 400;
    res.status(status).json({ error: "Invalid error report body" });
  });
};

export function errorRoutes() {
  const router = Router();
  router.get("/ir/errors", async (req, res) => {
    assertInstanceAdmin(req);
    if (!req.actor.isInstanceAdmin) throw forbidden("Instance admin access required");
    const filters = search.safeParse(req.query);
    if (!filters.success) {
      res.status(400).json({ error: "Invalid error search filters" });
      return;
    }
    res.set("Cache-Control", "no-store").json(await queryErrorLog(filters.data));
  });

  router.post(CLIENT_PATH, allowClientReports(), parseClientBody, async (req, res) => {
    const body: unknown = req.body;
    req.body = undefined;
    const report = clientReport.safeParse(body);
    if (!report.success) {
      res.status(400).json({ error: "Invalid client error report" });
      return;
    }
    try {
      const { id } = await recordClientError({
        ...report.data,
        userAgent: req.get("user-agent"),
      });
      res.status(202).json({ ok: true, id });
    } catch {
      res.status(503).json({ error: "Error log unavailable" });
    }
  });
  return router;
}
