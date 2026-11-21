import { createStructuredLogger, type StructuredLogger } from "./logger.js";
import { redactSensitive } from "./redaction.js";

/**
 * Contextual error tracking for every Paperclip surface.
 *
 * A tracker uses Sentry when `@sentry/node` is installed and a DSN is
 * configured. Otherwise it keeps the same context, stack, tags, user identity
 * and breadcrumbs in the structured error log, so an agent can still trace a
 * failure to a code path. The integration is optional: no package depends on
 * Sentry at build time, and error reporting never changes a command's result.
 */

export type ErrorBreadcrumbLevel = "fatal" | "error" | "warning" | "info" | "debug";

export interface ErrorBreadcrumb {
  category?: string;
  message: string;
  level?: ErrorBreadcrumbLevel;
  data?: Record<string, unknown>;
}

/**
 * Identity attached to captured errors. Prefer the opaque user id and a
 * display username. Do not add email or other personal data unless the surface
 * explicitly needs it.
 */
export interface ErrorUser {
  id?: string;
  username?: string;
}

export interface ErrorContext {
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  user?: ErrorUser;
  breadcrumbs?: ErrorBreadcrumb[];
  fingerprint?: string[];
}

export interface ErrorTrackerOptions {
  service: string;
  dsn?: string;
  environment?: string;
  release?: string;
  logger?: StructuredLogger;
  maxBreadcrumbs?: number;
  now?: () => Date;
}

export interface ErrorTracker {
  /** True when a DSN is configured. The fallback logger is always available. */
  readonly enabled: boolean;
  capture(error: unknown, context?: ErrorContext): void;
  addBreadcrumb(breadcrumb: ErrorBreadcrumb): void;
  setUser(user: ErrorUser | null): void;
  flush(timeoutMs?: number): Promise<boolean>;
}

interface SentryClient {
  init(options: Record<string, unknown>): void;
  captureException(error: unknown, options?: Record<string, unknown>): string;
  addBreadcrumb(breadcrumb: Record<string, unknown>): void;
  setUser(user: Record<string, unknown> | null): void;
  flush(timeout?: number): Promise<boolean>;
}

const SENTRY_MODULE = "@sentry/node";
const DEFAULT_MAX_BREADCRUMBS = 40;

function errorDetails(error: unknown): { name: string; message: string; stack?: string; cause?: unknown } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack, cause: error.cause };
  }
  if (typeof error === "string") return { name: "NonError", message: error };
  try {
    return { name: "NonError", message: JSON.stringify(error) };
  } catch {
    return { name: "NonError", message: String(error) };
  }
}

function safeBreadcrumb(breadcrumb: ErrorBreadcrumb): ErrorBreadcrumb {
  return {
    ...breadcrumb,
    ...(breadcrumb.data ? { data: redactSensitive(breadcrumb.data) as Record<string, unknown> } : {}),
  };
}

function sentryOptions(options: ErrorTrackerOptions): Record<string, unknown> {
  return {
    dsn: options.dsn,
    environment: options.environment,
    release: options.release,
    serverName: options.service,
    // Paperclip already runs a separate OpenTelemetry trace path. This tracker
    // captures errors and context only, and it does not send default PII.
    sendDefaultPii: false,
    tracesSampleRate: 0,
    beforeSend(event: Record<string, unknown>): Record<string, unknown> {
      if (!event || typeof event !== "object") return event;
      if (event.extra) event.extra = redactSensitive(event.extra);
      if (event.contexts) event.contexts = redactSensitive(event.contexts);
      return event;
    },
    beforeBreadcrumb(breadcrumb: Record<string, unknown>): Record<string, unknown> {
      if (breadcrumb?.data) breadcrumb.data = redactSensitive(breadcrumb.data);
      return breadcrumb;
    },
  };
}

async function loadSentry(options: ErrorTrackerOptions): Promise<SentryClient | null> {
  if (!options.dsn) return null;
  try {
    const loaded = (await import(/* @vite-ignore */ SENTRY_MODULE)) as {
      default?: SentryClient;
    } & Partial<SentryClient>;
    const client = (loaded.default ?? loaded) as SentryClient;
    if (typeof client.init !== "function") return null;
    client.init(sentryOptions(options));
    return client;
  } catch {
    // Optional dependency or an unsupported SDK surface. The structured logger
    // remains the source of truth.
    return null;
  }
}

export function createErrorTracker(options: ErrorTrackerOptions): ErrorTracker {
  const logger = options.logger ?? createStructuredLogger({ service: options.service, level: "error" });
  const now = options.now ?? (() => new Date());
  const maxBreadcrumbs = options.maxBreadcrumbs ?? DEFAULT_MAX_BREADCRUMBS;
  const breadcrumbs: ErrorBreadcrumb[] = [];
  let user: ErrorUser | null = null;
  let sentry: SentryClient | null = null;

  const ready = loadSentry(options).then((client) => {
    sentry = client;
    return client !== null;
  });

  const sendBreadcrumb = (breadcrumb: ErrorBreadcrumb) => {
    void ready.then(() => {
      if (!sentry) return;
      try {
        sentry.addBreadcrumb({
          category: breadcrumb.category ?? options.service,
          message: breadcrumb.message,
          level: breadcrumb.level ?? "info",
          ...(breadcrumb.data ? { data: redactSensitive(breadcrumb.data) } : {}),
        });
      } catch {
        // Never let observability break the caller.
      }
    });
  };

  return {
    enabled: Boolean(options.dsn),
    capture(error, context = {}) {
      const details = errorDetails(error);
      const extra = redactSensitive(context.extra ?? {}) as Record<string, unknown>;
      const tags = { service: options.service, ...context.tags };
      const identity = context.user ?? user;
      const normalizedUser = identity
        ? { ...(identity.id ? { id: identity.id } : {}), ...(identity.username ? { username: identity.username } : {}) }
        : undefined;

      logger.error("captured error", {
        error: details.name,
        message: details.message,
        ...(details.stack ? { stack: details.stack } : {}),
        ...(details.cause ? { cause: redactSensitive(details.cause) } : {}),
        tags,
        extra,
        ...(normalizedUser ? { user: normalizedUser } : {}),
        breadcrumbs: breadcrumbs.map(safeBreadcrumb),
        time: now().toISOString(),
      });

      void ready.then(() => {
        if (!sentry) return;
        try {
          sentry.captureException(error, {
            tags,
            extra,
            ...(normalizedUser ? { user: normalizedUser } : {}),
            ...(context.fingerprint ? { fingerprint: context.fingerprint } : {}),
          });
        } catch {
          // Never let observability break the caller.
        }
      });
    },
    addBreadcrumb(breadcrumb) {
      const safe = safeBreadcrumb(breadcrumb);
      breadcrumbs.push(safe);
      if (breadcrumbs.length > maxBreadcrumbs) breadcrumbs.splice(0, breadcrumbs.length - maxBreadcrumbs);
      sendBreadcrumb(safe);
    },
    setUser(nextUser) {
      user = nextUser;
      void ready.then(() => {
        if (!sentry) return;
        try {
          sentry.setUser(nextUser ? { id: nextUser.id, username: nextUser.username } : null);
        } catch {
          // Never let observability break the caller.
        }
      });
    },
    async flush(timeoutMs = 2_000) {
      const available = await ready;
      if (!available || !sentry) return true;
      try {
        return await sentry.flush(timeoutMs);
      } catch {
        return false;
      }
    },
  };
}
