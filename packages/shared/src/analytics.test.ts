import { describe, expect, it } from "vitest";

import { createProductAnalytics } from "./analytics.js";

function captureFetch() {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("createProductAnalytics", () => {
  it("is a no-op without a project key", async () => {
    const { calls, fetchImpl } = captureFetch();
    const analytics = createProductAnalytics({ app: "test", fetchImpl });
    analytics.capture("feature_used", { feature: "tasks" });
    await expect(analytics.flush()).resolves.toBe(true);
    expect(analytics.enabled).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("sends named events with an opaque distinct id and redacted properties", async () => {
    const { calls, fetchImpl } = captureFetch();
    const analytics = createProductAnalytics({
      app: "test",
      apiKey: "phc_test",
      host: "https://posthog.invalid",
      distinctId: "user-1",
      batchSize: 10,
      fetchImpl,
      now: () => new Date("2026-01-02T03:04:05Z"),
    });
    analytics.capture("feature_used", { feature: "tasks", token: "secret-value" });
    await expect(analytics.shutdown()).resolves.toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://posthog.invalid/capture/");
    const body = calls[0].body as { api_key: string; batch: Array<Record<string, unknown>> };
    expect(body.api_key).toBe("phc_test");
    expect(body.batch[0]).toMatchObject({
      event: "feature_used",
      timestamp: "2026-01-02T03:04:05.000Z",
      properties: { feature: "tasks", token: "[REDACTED]", distinct_id: "user-1", app: "test" },
    });
  });

  it("identifies a person without sending free-form content", async () => {
    const { calls, fetchImpl } = captureFetch();
    const analytics = createProductAnalytics({ app: "test", apiKey: "phc_test", host: "https://posthog.invalid", fetchImpl });
    analytics.identify("user-2", { plan: "pro", password: "secret" });
    await analytics.flush();

    const body = calls[0].body as { batch: Array<Record<string, unknown>> };
    expect(body.batch[0]).toMatchObject({
      event: "$identify",
      properties: { distinct_id: "user-2", $set: { plan: "pro", password: "[REDACTED]" }, app: "test" },
    });
  });

  it("honors the telemetry opt-out", async () => {
    const previous = process.env.PAPERCLIP_TELEMETRY_DISABLED;
    process.env.PAPERCLIP_TELEMETRY_DISABLED = "1";
    try {
      const { calls, fetchImpl } = captureFetch();
      const analytics = createProductAnalytics({ app: "test", apiKey: "phc_test", fetchImpl });
      analytics.capture("feature_used");
      await analytics.flush();
      expect(analytics.enabled).toBe(false);
      expect(calls).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_TELEMETRY_DISABLED;
      else process.env.PAPERCLIP_TELEMETRY_DISABLED = previous;
    }
  });
});
