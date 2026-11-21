import { redactSensitive } from "./observability/redaction.js";

/**
 * Opt-in product analytics bridge.
 *
 * Paperclip's first-party telemetry answers "does this build work?"; product
 * analytics answers "is this feature used?". This module forwards explicit
 * product events to PostHog over its capture API. It is disabled unless an
 * operator supplies a project key, and it inherits the existing telemetry
 * opt-out. No automatic capture, page contents, URLs, prompts, or user content
 * are sent; callers name each event and its properties.
 */

export interface ProductAnalyticsOptions {
  /** PostHog project API key. Without it the client is a no-op. */
  apiKey?: string;
  /** PostHog ingestion host. Defaults to https://us.i.posthog.com. */
  host?: string;
  /** Stable application name, for example "paperclip-ui". */
  app: string;
  /** Optional opaque person id. Never an email or display name. */
  distinctId?: string;
  enabled?: boolean;
  batchSize?: number;
  flushIntervalMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface ProductAnalytics {
  readonly enabled: boolean;
  capture(event: string, properties?: Record<string, unknown>): void;
  identify(distinctId: string, properties?: Record<string, unknown>): void;
  flush(): Promise<boolean>;
  shutdown(): Promise<boolean>;
}

interface CapturedEvent {
  event: string;
  properties: Record<string, unknown>;
  timestamp: string;
}

const DEFAULT_HOST = "https://us.i.posthog.com";

function analyticsDisabled(env?: Record<string, string | undefined>): boolean {
  const source = env ?? (typeof process !== "undefined" ? process.env : {});
  return source.PAPERCLIP_TELEMETRY_DISABLED === "1" || source.PAPERCLIP_PRODUCT_ANALYTICS_DISABLED === "1";
}

export function createProductAnalytics(options: ProductAnalyticsOptions): ProductAnalytics {
  const enabled = Boolean(options.apiKey) && options.enabled !== false && !analyticsDisabled();
  const host = (options.host ?? DEFAULT_HOST).replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const batchSize = Math.max(1, options.batchSize ?? 20);
  const flushIntervalMs = Math.max(1_000, options.flushIntervalMs ?? 15_000);
  const queue: CapturedEvent[] = [];
  let distinctId = options.distinctId;
  let timer: ReturnType<typeof setInterval> | null = null;
  let flushing: Promise<boolean> | null = null;

  const send = async (events: CapturedEvent[]): Promise<boolean> => {
    if (!events.length || !enabled || !fetchImpl) return true;
    try {
      const response = await fetchImpl(`${host}/capture/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: options.apiKey,
          batch: events.map((entry) => ({
            event: entry.event,
            properties: {
              ...entry.properties,
              distinct_id: distinctId ?? "anonymous",
              app: options.app,
            },
            timestamp: entry.timestamp,
          })),
        }),
      });
      return response.ok;
    } catch {
      // Analytics must never break product behavior.
      return false;
    }
  };

  const flush = async (): Promise<boolean> => {
    if (flushing) return flushing;
    const pending = queue.splice(0, queue.length);
    flushing = send(pending).finally(() => {
      flushing = null;
    });
    return flushing;
  };

  const schedule = () => {
    if (timer || !enabled) return;
    timer = setInterval(() => {
      void flush();
    }, flushIntervalMs);
    // Do not keep a CLI or test process alive only for analytics.
    timer.unref?.();
  };

  if (enabled) schedule();

  return {
    enabled,
    capture(event, properties = {}) {
      if (!enabled) return;
      queue.push({
        event,
        properties: redactSensitive(properties) as Record<string, unknown>,
        timestamp: now().toISOString(),
      });
      if (queue.length >= batchSize) void flush();
    },
    identify(nextDistinctId, properties = {}) {
      distinctId = nextDistinctId;
      if (!enabled) return;
      queue.push({
        event: "$identify",
        properties: {
          distinct_id: nextDistinctId,
          $set: redactSensitive(properties),
          app: options.app,
        },
        timestamp: now().toISOString(),
      });
      if (queue.length >= batchSize) void flush();
    },
    flush,
    async shutdown() {
      if (timer) clearInterval(timer);
      timer = null;
      return flush();
    },
  };
}
