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
