/**
 * W3C trace-context helpers shared by every Paperclip surface.
 *
 * A context carries a 16-byte trace id, an 8-byte span id and a request id.
 * `traceHeaders` returns the headers an outbound HTTP client should send so a
 * request can be followed across the API, MCP servers, the CLI and the UI.
 */

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

export interface TraceContext {
  traceId: string;
  spanId: string;
  requestId: string;
  sampled: boolean;
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.getRandomValues) {
    cryptoApi.getRandomValues(buffer);
  } else {
    for (let index = 0; index < buffer.length; index += 1) {
      buffer[index] = Math.floor(Math.random() * 256);
    }
  }
  return [...buffer].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function newTraceContext(options: { sampled?: boolean; requestId?: string } = {}): TraceContext {
  return {
    traceId: randomHex(16),
    spanId: randomHex(8),
    requestId: options.requestId ?? randomHex(8),
    sampled: options.sampled ?? true,
  };
}

export function parseTraceparent(header: string | null | undefined): TraceContext | null {
  if (!header) return null;
  const match = TRACEPARENT.exec(header.trim());
  if (!match) return null;
  const traceId = match[1].toLowerCase();
  const spanId = match[2].toLowerCase();
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return null;
  return {
    traceId,
    spanId,
    requestId: spanId,
    sampled: (Number.parseInt(match[3], 16) & 1) === 1,
  };
}

export function formatTraceparent(context: TraceContext): string {
  return `00-${context.traceId}-${context.spanId}-${context.sampled ? "01" : "00"}`;
}

export function traceHeaders(context: TraceContext): Record<string, string> {
  return {
    traceparent: formatTraceparent(context),
    "x-request-id": context.requestId,
  };
}

/** Continue an inbound request's trace or start a new one. */
export function continueTrace(
  inbound: { traceparent?: string | null; requestId?: string | null } = {},
): TraceContext {
  const parsed = parseTraceparent(inbound.traceparent);
  if (parsed) {
    return {
      ...parsed,
      requestId: inbound.requestId?.trim() || parsed.requestId,
    };
  }
  return newTraceContext({ requestId: inbound.requestId?.trim() || undefined });
}
