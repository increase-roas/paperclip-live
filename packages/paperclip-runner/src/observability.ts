/**
 * Structured diagnostics for the reference Runner.
 *
 * The Rust runner owns the production process. This TypeScript module gives the
 * control-plane reference, devtools and browser harnesses one JSON-line logger
 * plus trace, metrics and breaker helpers so diagnostics stay machine-readable.
 */

const REDACTED = "[REDACTED]";
const SECRET_KEY = /^(?:authorization|cookie|password|secret|token|api[_-]?key|credential|private[_-]?key)$/i;

export type RunnerLogLevel = "debug" | "info" | "warn" | "error";

function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`)
      .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED);
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        SECRET_KEY.test(key) ? REDACTED : redact(entry),
      ]),
    );
  }
  return value;
}

export interface RunnerTraceContext {
  traceId: string;
  requestId: string;
}

export function newRunnerTrace(requestId?: string): RunnerTraceContext {
  const buffer = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(buffer);
  const traceId = [...buffer].map((value) => value.toString(16).padStart(2, "0")).join("");
  return { traceId, requestId: requestId ?? traceId.slice(0, 16) };
}

export function runnerTraceHeaders(trace: RunnerTraceContext): Record<string, string> {
  return {
    traceparent: `00-${trace.traceId}-${trace.traceId.slice(0, 16)}-01`,
    "x-request-id": trace.requestId,
  };
}

export function createRunnerLogger(trace?: RunnerTraceContext) {
  const write = (level: RunnerLogLevel, message: string, context?: Record<string, unknown>) => {
    process.stderr.write(
      `${JSON.stringify({
        time: new Date().toISOString(),
        level,
        service: "paperclip-runner",
        ...(trace ? { traceId: trace.traceId, requestId: trace.requestId } : {}),
        message,
        ...(context ? { context: redact(context) } : {}),
      })}\n`,
    );
  };
  return {
    debug: (message: string, context?: Record<string, unknown>) => write("debug", message, context),
    info: (message: string, context?: Record<string, unknown>) => write("info", message, context),
    warn: (message: string, context?: Record<string, unknown>) => write("warn", message, context),
    error: (message: string, context?: Record<string, unknown>) => write("error", message, context),
  };
}

/**
 * Contextual error tracking for Runner CLIs and harnesses.
 *
 * Sentry is optional: the tracker dynamically loads `@sentry/node` when a DSN
 * is configured. The structured runner logger always receives the stack, tags
 * and redacted context.
 */
export interface RunnerErrorTracker {
  capture(error: unknown, context?: Record<string, unknown>): void;
  flush(timeoutMs?: number): Promise<boolean>;
}

export function createRunnerErrorTracker(): RunnerErrorTracker {
  const logger = createRunnerLogger();
  let sentry: {
    captureException?: (error: unknown, options?: Record<string, unknown>) => unknown;
    flush?: (timeout?: number) => Promise<boolean>;
  } | null = null;

  const ready = (async () => {
    const dsn = process.env.SENTRY_DSN_RUNNER ?? process.env.SENTRY_DSN;
    if (!dsn) return;
    try {
      const moduleName = "@sentry/node";
      const loaded = (await import(/* @vite-ignore */ moduleName)) as {
        default?: Record<string, unknown>;
      } & Record<string, unknown>;
      const client = (loaded.default ?? loaded) as {
        init?: (options: Record<string, unknown>) => void;
        captureException?: (error: unknown, options?: Record<string, unknown>) => unknown;
        flush?: (timeout?: number) => Promise<boolean>;
      };
      if (typeof client.init !== "function") return;
      client.init({
        dsn,
        environment: process.env.PAPERCLIP_ENVIRONMENT,
        release: process.env.SENTRY_RELEASE,
        serverName: "paperclip-runner",
        sendDefaultPii: false,
        tracesSampleRate: 0,
      });
      sentry = client;
    } catch {
      // Optional dependency. The structured logger remains the record.
    }
  })();

  return {
    capture(error, context = {}) {
      const name = error instanceof Error ? error.name : "NonError";
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      logger.error("captured error", {
        error: name,
        message,
        ...(stack ? { stack } : {}),
        ...context,
      });
      void ready.then(() => {
        try {
          sentry?.captureException?.(error, {
            tags: { service: "paperclip-runner" },
            extra: context,
          });
        } catch {
          // Never let observability break the caller.
        }
      });
    },
    async flush(timeoutMs = 2_000) {
      await ready;
      try {
        return sentry?.flush ? await sentry.flush(timeoutMs) : true;
      } catch {
        return false;
      }
    },
  };
}

export const runnerErrorTracker = createRunnerErrorTracker();

/**
 * Opt-in product analytics for Runner CLIs and harnesses.
 *
 * Disabled unless `PAPERCLIP_POSTHOG_KEY` (or `POSTHOG_API_KEY`) is set. Only
 * command and tool names leave the process, never prompts, paths, workspace
 * content, provider output, or credentials.
 */
export interface RunnerProductAnalytics {
  readonly enabled: boolean;
  capture(event: string, properties?: Record<string, unknown>): void;
  flush(): Promise<boolean>;
}

export function createRunnerProductAnalytics(): RunnerProductAnalytics {
  const apiKey = process.env.PAPERCLIP_POSTHOG_KEY ?? process.env.POSTHOG_API_KEY;
  const host = (process.env.PAPERCLIP_POSTHOG_HOST ?? "https://us.i.posthog.com").replace(/\/$/, "");
  const enabled =
    Boolean(apiKey) &&
    process.env.PAPERCLIP_TELEMETRY_DISABLED !== "1" &&
    process.env.PAPERCLIP_PRODUCT_ANALYTICS_DISABLED !== "1";
  const queue: Array<{ event: string; properties: Record<string, unknown>; timestamp: string }> = [];
  let flushing: Promise<boolean> | null = null;

  const flush = async (): Promise<boolean> => {
    if (flushing) return flushing;
    const batch = queue.splice(0, queue.length);
    if (!enabled || batch.length === 0) return true;
    flushing = fetch(`${host}/capture/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        batch: batch.map((entry) => ({
          event: entry.event,
          timestamp: entry.timestamp,
          properties: { ...entry.properties, app: "paperclip-runner" },
        })),
      }),
    })
      .then((response) => response.ok)
      .catch(() => false)
      .finally(() => {
        flushing = null;
      });
    return flushing;
  };

  if (enabled) {
    const timer = setInterval(() => {
      void flush();
    }, 15_000);
    timer.unref?.();
  }

  return {
    enabled,
    capture(event, properties = {}) {
      if (!enabled) return;
      queue.push({ event, properties: redact(properties) as Record<string, unknown>, timestamp: new Date().toISOString() });
      if (queue.length >= 20) void flush();
    },
    flush,
  };
}

export const runnerProductAnalytics = createRunnerProductAnalytics();

export class RunnerMetrics {
  private readonly counters = new Map<string, number>();
  private readonly durations = new Map<string, { count: number; totalMs: number }>();

  inc(name: string, labels: Record<string, string> = {}, value = 1): void {
    const key = metricKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }

  observe(name: string, labels: Record<string, string>, durationMs: number): void {
    const key = metricKey(name, labels);
    const current = this.durations.get(key) ?? { count: 0, totalMs: 0 };
    current.count += 1;
    current.totalMs += durationMs;
    this.durations.set(key, current);
  }

  snapshot(): { counters: Record<string, number>; durations: Record<string, { count: number; totalMs: number }> } {
    return {
      counters: Object.fromEntries([...this.counters.entries()].sort()),
      durations: Object.fromEntries([...this.durations.entries()].sort()),
    };
  }
}

function metricKey(name: string, labels: Record<string, string>): string {
  const entries = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right));
  return entries.length ? `${name}{${entries.map(([key, value]) => `${key}="${value}"`).join(",")}}` : name;
}

export const runnerMetrics = new RunnerMetrics();
