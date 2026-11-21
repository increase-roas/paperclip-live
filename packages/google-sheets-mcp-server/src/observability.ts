import {
  CircuitBreaker,
  createErrorTracker,
  createMetricsRegistry,
  createStructuredLogger,
  newTraceContext,
  traceHeaders,
  type TraceContext,
} from "@paperclipai/shared/observability";
import { createProductAnalytics } from "@paperclipai/shared/analytics";

import type { GoogleSheetsClient } from "./google-client.js";

export const sheetsMetrics = createMetricsRegistry();

export const sheetsApiRequests = sheetsMetrics.counter(
  "paperclip_google_sheets_api_requests_total",
  "Google Sheets API calls, by operation and outcome.",
);

export const sheetsApiDuration = sheetsMetrics.histogram(
  "paperclip_google_sheets_api_duration_ms",
  "Google Sheets API call duration in milliseconds.",
);

/**
 * Google quota and outage failures are the main external dependency of this
 * server. The breaker stops hammering the API after repeated transport or 5xx
 * failures and probes again after a short cooldown.
 */
export const sheetsApiCircuit = new CircuitBreaker({
  name: "google-sheets",
  failureThreshold: 8,
  cooldownMs: 10_000,
  successThreshold: 2,
});

export function createSheetsLogger(trace?: TraceContext) {
  return createStructuredLogger({
    service: "paperclip-google-sheets-mcp",
    level: process.env.PAPERCLIP_LOG_LEVEL === "debug" ? "debug" : "info",
    trace,
    sink: (_record, line) => {
      // stdio mode reserves stdout for the MCP protocol.
      process.stderr.write(`${line}\n`);
    },
  });
}

export const sheetsErrorTracker = createErrorTracker({
  service: "paperclip-google-sheets-mcp",
  dsn: process.env.SENTRY_DSN_SHEETS ?? process.env.SENTRY_DSN,
  environment: process.env.PAPERCLIP_ENVIRONMENT,
  release: process.env.SENTRY_RELEASE,
  logger: createSheetsLogger(),
});

export const sheetsProductAnalytics = createProductAnalytics({
  app: "paperclip-google-sheets-mcp",
  apiKey: process.env.PAPERCLIP_POSTHOG_KEY ?? process.env.POSTHOG_API_KEY,
  host: process.env.PAPERCLIP_POSTHOG_HOST ?? process.env.POSTHOG_HOST,
});

function wrapMethod<TArgs extends unknown[], TResult>(
  name: string,
  method: (...args: TArgs) => Promise<TResult>,
): (...args: TArgs) => Promise<TResult> {
  return async (...args: TArgs): Promise<TResult> => {
    const startedAt = Date.now();
    try {
      const result = await sheetsApiCircuit.execute(() => method(...args));
      sheetsApiRequests.inc({ operation: name, outcome: "success" });
      return result;
    } catch (error) {
      sheetsApiRequests.inc({ operation: name, outcome: "error" });
      throw error;
    } finally {
      sheetsApiDuration.observe({ operation: name }, Date.now() - startedAt);
    }
  };
}

/**
 * Wraps every Google client method with the shared breaker and metrics. The
 * wrapper is transparent to callers and to injected test clients.
 */
export function guardGoogleSheetsClient(client: GoogleSheetsClient): GoogleSheetsClient {
  return {
    listSpreadsheets: wrapMethod("listSpreadsheets", client.listSpreadsheets.bind(client)),
    getSpreadsheetInfo: wrapMethod("getSpreadsheetInfo", client.getSpreadsheetInfo.bind(client)),
    readValues: wrapMethod("readValues", client.readValues.bind(client)),
    searchRows: wrapMethod("searchRows", client.searchRows.bind(client)),
    appendRows: wrapMethod("appendRows", client.appendRows.bind(client)),
    updateValues: wrapMethod("updateValues", client.updateValues.bind(client)),
    addSheetTab: wrapMethod("addSheetTab", client.addSheetTab.bind(client)),
    clearValues: wrapMethod("clearValues", client.clearValues.bind(client)),
    deleteRows: wrapMethod("deleteRows", client.deleteRows.bind(client)),
  };
}

export { newTraceContext, traceHeaders };
export type { TraceContext };
