/**
 * Dependency-free observability for the standalone broker.
 *
 * The broker is published as a self-contained package and cannot assume the
 * workspace is installed, so this module keeps a small JSON logger, metrics
 * registry, trace id helper and a synchronous circuit breaker locally.
 */

const REDACTED = "[REDACTED]";
const SECRET_KEY = /^(?:authorization|cookie|password|secret|token|api[_-]?key|credential)$/i;

export type BrokerLogLevel = "debug" | "info" | "warn" | "error";

function scrubString(value: string): string {
  return value
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED);
}

function safeJson(value: unknown): string {
  return JSON.stringify(value, (key, entry) => {
    if (SECRET_KEY.test(key)) return REDACTED;
    return typeof entry === "string" ? scrubString(entry) : entry;
  });
}

export function newRequestId(): string {
  const buffer = new Uint8Array(8);
  globalThis.crypto?.getRandomValues?.(buffer);
  return [...buffer].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function createBrokerLogger(service = "paperclip-tailscale-https-broker") {
  const emit = (level: BrokerLogLevel, message: string, context?: Record<string, unknown>) => {
    const record = {
      time: new Date().toISOString(),
      level,
      service,
      message,
      ...(context ? { context } : {}),
    };
    process.stderr.write(`${safeJson(record)}\n`);
  };
  return {
    debug: (message: string, context?: Record<string, unknown>) => emit("debug", message, context),
    info: (message: string, context?: Record<string, unknown>) => emit("info", message, context),
    warn: (message: string, context?: Record<string, unknown>) => emit("warn", message, context),
    error: (message: string, context?: Record<string, unknown>) => emit("error", message, context),
  };
}

/**
 * Contextual error tracking for the standalone broker.
 *
 * Uses Sentry when `@sentry/node` is installed and `SENTRY_DSN_BROKER` (or
 * `SENTRY_DSN`) is set. The structured logger always receives the stack, tags
 * and context, so an operator can trace a failure without Sentry.
 */
export interface BrokerErrorTracker {
  capture(error: unknown, context?: Record<string, unknown>): void;
  flush(timeoutMs?: number): Promise<boolean>;
}

export function createBrokerErrorTracker(): BrokerErrorTracker {
  const logger = createBrokerLogger();
  let sentry: {
    captureException?: (error: unknown, options?: Record<string, unknown>) => unknown;
    flush?: (timeout?: number) => Promise<boolean>;
  } | null = null;

  const ready = (async () => {
    const dsn = process.env.SENTRY_DSN_BROKER ?? process.env.SENTRY_DSN;
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
        serverName: "paperclip-tailscale-https-broker",
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
            tags: { service: "paperclip-tailscale-https-broker" },
            extra: context,
          });
        } catch {
          // Never let observability break the broker.
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

export const brokerErrorTracker = createBrokerErrorTracker();

/**
 * Opt-in product analytics for the standalone broker.
 *
 * Disabled unless `PAPERCLIP_POSTHOG_KEY` (or `POSTHOG_API_KEY`) is set. Only
 * operation names and outcomes leave the process, never paths, ports, peer
 * ids, lease handles, or CLI output.
 */
export interface BrokerProductAnalytics {
  readonly enabled: boolean;
  capture(event: string, properties?: Record<string, unknown>): void;
  flush(): Promise<boolean>;
}

export function createBrokerProductAnalytics(): BrokerProductAnalytics {
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
          properties: { ...entry.properties, app: "paperclip-tailscale-https-broker" },
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
      // Round-trip through the broker's key-aware scrubber.
      const redacted = JSON.parse(safeJson(properties)) as Record<string, unknown>;
      queue.push({ event, properties: redacted, timestamp: new Date().toISOString() });
      if (queue.length >= 20) void flush();
    },
    flush,
  };
}

export const brokerProductAnalytics = createBrokerProductAnalytics();

export class BrokerMetrics {
  private readonly counters = new Map<string, number>();

  inc(name: string, labels: Record<string, string> = {}, value = 1): void {
    const key = `${name}${Object.keys(labels).length ? `{${Object.entries(labels).sort().map(([k, v]) => `${k}="${v}"`).join(",")}}` : ""}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries([...this.counters.entries()].sort(([left], [right]) => left.localeCompare(right)));
  }

  render(): string {
    return `${[...this.counters.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `# TYPE ${key.split("{")[0]} counter\n${key} ${value}`)
      .join("\n")}\n`;
  }
}

export const brokerMetrics = new BrokerMetrics();

export type BreakerState = "closed" | "open" | "half-open";

/**
 * Synchronous breaker for the spawned Tailscale CLI. It keeps a hard dependency
 * failure from turning every request into another timed-out process spawn.
 */
export class SyncCircuitBreaker {
  private state: BreakerState = "closed";
  private failures = 0;
  private openedAt: number | null = null;

  constructor(
    readonly name: string,
    private readonly failureThreshold = 5,
    private readonly cooldownMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  allow(): boolean {
    if (this.state === "closed") return true;
    if (this.state === "open" && this.openedAt !== null && this.now() - this.openedAt >= this.cooldownMs) {
      this.state = "half-open";
      return true;
    }
    return this.state === "half-open";
  }

  recordSuccess(): void {
    this.state = "closed";
    this.failures = 0;
    this.openedAt = null;
  }

  recordFailure(): void {
    if (this.state === "half-open") {
      this.trip();
      return;
    }
    this.failures += 1;
    if (this.failures >= this.failureThreshold) this.trip();
  }

  snapshot(): { name: string; state: BreakerState; failures: number; openedAt: number | null } {
    return { name: this.name, state: this.state, failures: this.failures, openedAt: this.openedAt };
  }

  private trip(): void {
    this.state = "open";
    this.openedAt = this.now();
  }
}

export const brokerTailscaleCircuit = new SyncCircuitBreaker("tailscale-cli");
