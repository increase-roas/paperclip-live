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
