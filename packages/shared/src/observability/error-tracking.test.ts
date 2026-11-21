import { describe, expect, it } from "vitest";

import { createErrorTracker } from "./error-tracking.js";
import { createStructuredLogger, type StructuredLogRecord } from "./logger.js";

function captureLogger() {
  const records: StructuredLogRecord[] = [];
  const logger = createStructuredLogger({
    service: "error-tracking-test",
    sink: (record) => records.push(record),
  });
  return { logger, records };
}

describe("createErrorTracker", () => {
  it("captures an error with its stack, tags and redacted context without a DSN", async () => {
    const { logger, records } = captureLogger();
    const tracker = createErrorTracker({ service: "error-tracking-test", logger });

    tracker.capture(new Error("boom"), {
      tags: { operation: "checkout" },
      extra: { authorization: "Bearer super-secret-token", resource: "task-1" },
    });

    await expect(tracker.flush(10)).resolves.toBe(true);
    const record = records.at(-1);
    expect(record?.level).toBe("error");
    expect(record?.message).toBe("captured error");
    expect(record?.context).toMatchObject({
      error: "Error",
      message: "boom",
      tags: { service: "error-tracking-test", operation: "checkout" },
      extra: { authorization: "[REDACTED]", resource: "task-1" },
    });
    expect(String(record?.context?.stack)).toContain("boom");
  });

  it("keeps breadcrumbs bounded and redacts their data", async () => {
    const { logger, records } = captureLogger();
    const tracker = createErrorTracker({ service: "error-tracking-test", logger, maxBreadcrumbs: 2 });

    tracker.addBreadcrumb({ message: "first", data: { token: "secret-token" } });
    tracker.addBreadcrumb({ message: "second" });
    tracker.addBreadcrumb({ message: "third" });
    tracker.capture(new Error("after breadcrumbs"));

    await tracker.flush(10);
    const breadcrumbs = records.at(-1)?.context?.breadcrumbs as Array<Record<string, unknown>>;
    expect(breadcrumbs).toHaveLength(2);
    expect(breadcrumbs.map((entry) => entry.message)).toEqual(["second", "third"]);
    expect(JSON.stringify(records.at(-1))).not.toContain("secret-token");
  });

  it("attaches an opaque user identity", async () => {
    const { logger, records } = captureLogger();
    const tracker = createErrorTracker({ service: "error-tracking-test", logger });
    tracker.setUser({ id: "user-1", username: "operator" });
    tracker.capture(new Error("with user"));
    await tracker.flush(10);

    expect(records.at(-1)?.context?.user).toEqual({ id: "user-1", username: "operator" });
  });

  it("reports disabled when no DSN is configured", () => {
    const { logger } = captureLogger();
    const tracker = createErrorTracker({ service: "error-tracking-test", logger });
    expect(tracker.enabled).toBe(false);
  });
});
