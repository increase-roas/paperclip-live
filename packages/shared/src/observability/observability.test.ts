import { describe, expect, it } from "vitest";

import { createStructuredLogger } from "./logger.js";
import { createMetricsRegistry } from "./metrics.js";
import { redactSensitive, redactText } from "./redaction.js";
import { CircuitBreaker, CircuitOpenError, withRetry } from "./resilience.js";
import { continueTrace, formatTraceparent, newTraceContext, parseTraceparent, traceHeaders } from "./trace.js";

describe("redaction", () => {
  it("redacts secrets by key and by value shape", () => {
    const result = redactSensitive({
      authorization: "Bearer abc",
      nested: { apiKey: "sk_live_1234567890", safe: "hello" },
      message: "token=super-secret-value and Bearer abcdefghijkl",
      pem: ["-----BEGIN", "PRIVATE KEY-----", "secret", "-----END", "PRIVATE KEY-----"].join(" "),
    });

    expect(result).toMatchObject({
      authorization: "[REDACTED]",
      nested: { apiKey: "[REDACTED]", safe: "hello" },
    });
    expect((result as { message: string }).message).not.toContain("super-secret-value");
    expect((result as { message: string }).message).not.toContain("abcdefghijkl");
    expect((result as { pem: string }).pem).toBe("[REDACTED]");
  });

  it("keeps ordinary text intact", () => {
    expect(redactText("the server started on port 3100")).toBe("the server started on port 3100");
  });
});

describe("structured logger", () => {
  it("emits JSON lines with trace context and redacted fields", () => {
    const lines: string[] = [];
    const trace = newTraceContext();
    const logger = createStructuredLogger({
      service: "unit-test",
      trace,
      sink: (_record, line) => lines.push(line),
    });

    logger.info("request finished", { token: "secret-token", status: 200 });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as {
      service: string;
      message: string;
      traceId: string;
      context: Record<string, unknown>;
    };
    expect(parsed.service).toBe("unit-test");
    expect(parsed.traceId).toBe(trace.traceId);
    expect(parsed.context.token).toBe("[REDACTED]");
    expect(parsed.context.status).toBe(200);
  });

  it("respects the level threshold and child context", () => {
    const lines: string[] = [];
    const logger = createStructuredLogger({
      service: "unit-test",
      level: "warn",
      sink: (_record, line) => lines.push(line),
    }).child({ component: "worker" });

    logger.debug("hidden");
    logger.warn("visible");

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      level: "warn",
      context: { component: "worker" },
    });
  });
});

describe("trace context", () => {
  it("round-trips traceparent and exposes request headers", () => {
    const context = newTraceContext({ sampled: true });
    const parsed = parseTraceparent(formatTraceparent(context));

    expect(parsed).toMatchObject({
      traceId: context.traceId,
      spanId: context.spanId,
      sampled: true,
    });
    expect(traceHeaders(context)).toEqual({
      traceparent: formatTraceparent(context),
      "x-request-id": context.requestId,
    });
  });

  it("continues an inbound trace and ignores invalid headers", () => {
    const context = newTraceContext();
    expect(continueTrace({ traceparent: formatTraceparent(context), requestId: "req-1" })).toMatchObject({
      traceId: context.traceId,
      requestId: "req-1",
    });
    expect(parseTraceparent("not-a-traceparent")).toBeNull();
    expect(parseTraceparent("00-00000000000000000000000000000000-0000000000000000-01")).toBeNull();
  });
});

describe("metrics registry", () => {
  it("renders counters, gauges and histograms", () => {
    const metrics = createMetricsRegistry();
    const requests = metrics.counter("paperclip_http_requests_total", "HTTP requests");
    const queue = metrics.gauge("paperclip_queue_depth", "Queued work");
    const latency = metrics.histogram("paperclip_request_duration_ms", "Request latency", [10, 20]);

    requests.inc({ method: "GET", status: 200 });
    requests.inc({ method: "GET", status: 200 });
    queue.set({ queue: "default" }, 3);
    latency.observe({ route: "/api/health" }, 15);
    latency.observe({ route: "/api/health" }, 25);

    const rendered = metrics.render();
    expect(rendered).toContain(
      'paperclip_http_requests_total{method="GET",status="200"} 2',
    );
    expect(rendered).toContain('paperclip_queue_depth{queue="default"} 3');
    expect(rendered).toContain(
      'paperclip_request_duration_ms_bucket{le="10",route="/api/health"} 0',
    );
    expect(rendered).toContain(
      'paperclip_request_duration_ms_bucket{le="20",route="/api/health"} 1',
    );
    expect(rendered).toContain(
      'paperclip_request_duration_ms_bucket{le="+Inf",route="/api/health"} 2',
    );
    expect(metrics.snapshot()).toHaveLength(3);
  });
});

describe("circuit breaker", () => {
  it("opens after the failure threshold and closes after a successful probe", async () => {
    let now = 0;
    const breaker = new CircuitBreaker({
      name: "provider",
      failureThreshold: 2,
      successThreshold: 1,
      cooldownMs: 1_000,
      now: () => now,
    });
    const fail = () => Promise.reject(new Error("provider down"));

    await expect(breaker.execute(fail)).rejects.toThrow("provider down");
    await expect(breaker.execute(fail)).rejects.toThrow("provider down");
    expect(breaker.snapshot().state).toBe("open");

    await expect(breaker.execute(() => Promise.resolve("blocked"))).rejects.toBeInstanceOf(
      CircuitOpenError,
    );

    now = 1_001;
    await expect(breaker.execute(() => Promise.resolve("recovered"))).resolves.toBe("recovered");
    expect(breaker.snapshot().state).toBe("closed");
  });

  it("re-opens when a half-open probe fails", async () => {
    let now = 0;
    const breaker = new CircuitBreaker({
      name: "provider",
      failureThreshold: 1,
      successThreshold: 1,
      cooldownMs: 100,
      now: () => now,
    });

    await expect(breaker.execute(() => Promise.reject(new Error("down")))).rejects.toThrow("down");
    expect(breaker.snapshot().state).toBe("open");
    now = 101;
    await expect(breaker.execute(() => Promise.reject(new Error("still down")))).rejects.toThrow(
      "still down",
    );
    expect(breaker.snapshot().state).toBe("open");
  });
});

describe("withRetry", () => {
  it("retries transient failures and returns the success", async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("transient");
        return "ok";
      },
      { retries: 3, baseDelayMs: 0, sleep: async () => {} },
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("stops when shouldRetry returns false", async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw new Error("permanent");
        },
        { retries: 5, baseDelayMs: 0, shouldRetry: () => false, sleep: async () => {} },
      ),
    ).rejects.toThrow("permanent");
    expect(attempts).toBe(1);
  });
});
