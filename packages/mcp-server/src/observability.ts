import {
  CircuitBreaker,
  createMetricsRegistry,
  createStructuredLogger,
  newTraceContext,
  traceHeaders,
  type TraceContext,
} from "@paperclipai/shared/observability";

export const mcpMetrics = createMetricsRegistry();

export const mcpApiRequests = mcpMetrics.counter(
  "paperclip_mcp_api_requests_total",
  "Paperclip API requests issued by the MCP server, by method and outcome.",
);

export const mcpApiDuration = mcpMetrics.histogram(
  "paperclip_mcp_api_request_duration_ms",
  "MCP server API request duration in milliseconds.",
);

export const mcpApiCircuit = new CircuitBreaker({
  name: "paperclip-api",
  failureThreshold: 10,
  cooldownMs: 5_000,
  successThreshold: 2,
});

export function createMcpLogger(trace?: TraceContext) {
  return createStructuredLogger({
    service: "paperclip-mcp-server",
    level: process.env.PAPERCLIP_LOG_LEVEL === "debug" ? "debug" : "info",
    trace,
    sink: (_record, line) => {
      // stdout carries the MCP protocol; diagnostics go to stderr.
      process.stderr.write(`${line}\n`);
    },
  });
}

export { newTraceContext, traceHeaders };
export type { TraceContext };
