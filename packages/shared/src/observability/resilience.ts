/**
 * Dependency-free resilience helpers for calls to external services.
 *
 * `CircuitBreaker` stops sending traffic to a failing dependency and probes it
 * again after a cooldown. `withRetry` adds bounded exponential backoff with
 * jitter for transient failures.
 */

export type CircuitState = "closed" | "open" | "half-open";

export class CircuitOpenError extends Error {
  readonly code = "CIRCUIT_OPEN";

  constructor(readonly circuitName: string, readonly retryAt: number) {
    super(`Circuit "${circuitName}" is open until ${new Date(retryAt).toISOString()}.`);
    this.name = "CircuitOpenError";
  }
}

export interface CircuitBreakerOptions {
  name: string;
  /** Consecutive failures before the circuit opens. */
  failureThreshold?: number;
  /** Consecutive successes in half-open before the circuit closes. */
  successThreshold?: number;
  /** Time to wait before probing an open circuit. */
  cooldownMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface CircuitSnapshot {
  name: string;
  state: CircuitState;
  failures: number;
  successes: number;
  openedAt: number | null;
}

export class CircuitBreaker {
  private readonly name: string;
  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private state: CircuitState = "closed";
  private failures = 0;
  private successes = 0;
  private openedAt: number | null = null;
  private probing = false;

  constructor(options: CircuitBreakerOptions) {
    this.name = options.name;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.successThreshold = options.successThreshold ?? 2;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.now = options.now ?? Date.now;
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (this.openedAt !== null && this.now() - this.openedAt >= this.cooldownMs) {
        this.state = "half-open";
        this.successes = 0;
      } else {
        throw new CircuitOpenError(this.name, (this.openedAt ?? this.now()) + this.cooldownMs);
      }
    }
    if (this.state === "half-open") {
      if (this.probing) {
        throw new CircuitOpenError(this.name, (this.openedAt ?? this.now()) + this.cooldownMs);
      }
      this.probing = true;
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    } finally {
      this.probing = false;
    }
  }

  snapshot(): CircuitSnapshot {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      openedAt: this.openedAt,
    };
  }

  private onSuccess(): void {
    if (this.state === "half-open") {
      this.successes += 1;
      if (this.successes >= this.successThreshold) this.reset();
      return;
    }
    this.failures = 0;
  }

  private onFailure(): void {
    if (this.state === "half-open") {
      this.trip();
      return;
    }
    this.failures += 1;
    if (this.failures >= this.failureThreshold) this.trip();
  }

  private trip(): void {
    this.state = "open";
    this.openedAt = this.now();
    this.probing = false;
  }

  private reset(): void {
    this.state = "closed";
    this.failures = 0;
    this.successes = 0;
    this.openedAt = null;
  }
}

export interface RetryOptions {
  /** Number of retries after the first attempt. */
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  signal?: AbortSignal;
  /** Return false to stop retrying a specific error. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const retries = options.retries ?? 2;
  const baseDelayMs = options.baseDelayMs ?? 100;
  const maxDelayMs = options.maxDelayMs ?? 2_000;
  const jitterRatio = options.jitterRatio ?? 0.2;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (options.signal?.aborted) throw error;
      if (attempt === retries) break;
      if (options.shouldRetry && !options.shouldRetry(error, attempt)) break;
      const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const jitter = exponential * jitterRatio * (Math.random() * 2 - 1);
      await sleep(Math.max(0, Math.round(exponential + jitter)), options.signal);
    }
  }
  throw lastError;
}
