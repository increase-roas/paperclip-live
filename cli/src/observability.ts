import {
  CircuitBreaker,
  createErrorTracker,
  createMetricsRegistry,
  createStructuredLogger,
  type StructuredLogger,
  type TraceContext,
} from "@paperclipai/shared/observability";

export const cliMetrics = createMetricsRegistry();

export const cliApiRequests = cliMetrics.counter(
  "paperclip_cli_api_requests_total",
  "API requests issued by the CLI, by method and outcome.",
);

export const cliApiDuration = cliMetrics.histogram(
  "paperclip_cli_api_request_duration_ms",
  "CLI API request duration in milliseconds.",
);

/**
 * The CLI talks to one API base URL for the length of a command, so a shared
 * breaker per process is the right scope. It counts transport failures only:
 * HTTP error responses still resolve and are not tripped by the breaker.
 */
export const cliApiCircuit = new CircuitBreaker({
  name: "paperclip-api",
  failureThreshold: 10,
  cooldownMs: 5_000,
  successThreshold: 2,
});

function resolveLogLevel(): "debug" | "info" | "warn" | "error" {
  const configured = process.env.PAPERCLIP_LOG_LEVEL?.trim();
  if (configured === "debug" || configured === "info" || configured === "warn" || configured === "error") {
    return configured;
  }
  return "info";
}

export function createCliLogger(trace?: TraceContext): StructuredLogger {
  return createStructuredLogger({
    service: "paperclipai-cli",
    level: resolveLogLevel(),
    trace,
    sink: (_record, line) => {
      process.stderr.write(`${line}\n`);
    },
  });
}

export const cliErrorTracker = createErrorTracker({
  service: "paperclipai-cli",
  dsn: process.env.SENTRY_DSN_CLI ?? process.env.SENTRY_DSN,
  environment: process.env.PAPERCLIP_ENVIRONMENT,
  release: process.env.SENTRY_RELEASE,
  logger: createCliLogger(),
});

export type { TraceContext };
export { newTraceContext, traceHeaders } from "@paperclipai/shared/observability";

if (process.env.PAPERCLIP_METRICS === "1") {
  process.on("exit", () => {
    process.stderr.write(`${JSON.stringify(cliMetrics.snapshot())}\n`);
  });
}
