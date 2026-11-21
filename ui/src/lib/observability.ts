import {
  CircuitBreaker,
  createMetricsRegistry,
  createStructuredLogger,
  newTraceContext,
  type TraceContext,
} from "@paperclipai/shared/observability";

export const uiMetrics = createMetricsRegistry();

/**
 * Browser-side breaker for the same-origin API. It counts only transport
 * failures (fetch rejections), so ordinary 4xx/5xx responses still reach the
 * caller's error handling.
 */
export const uiApiCircuit = new CircuitBreaker({
  name: "board-api",
  failureThreshold: 10,
  cooldownMs: 5_000,
  successThreshold: 2,
});

export const uiApiRequests = uiMetrics.counter(
  "paperclip_ui_api_requests_total",
  "Same-origin API requests issued by the board UI, by outcome.",
);

export const uiApiDuration = uiMetrics.histogram(
  "paperclip_ui_api_request_duration_ms",
  "Board UI API request duration in milliseconds.",
);

export const uiLogger = createStructuredLogger({
  service: "paperclip-ui",
  level: "warn",
  sink: (_record, line) => {
    console.warn(line);
  },
});

export function startUiTrace(): TraceContext {
  return newTraceContext();
}

export { newTraceContext, traceHeaders, redactText, redactSensitive } from "@paperclipai/shared/observability";
export type { TraceContext };
