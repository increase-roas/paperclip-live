import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let reporter: typeof import("./errorReporter");
let target: EventTarget;
const send = vi.fn<typeof fetch>();

beforeEach(async () => {
  target = new EventTarget();
  vi.resetModules();
  vi.useFakeTimers();
  send.mockReset().mockResolvedValue(new Response(null, { status: 202 }));
  vi.stubGlobal("fetch", send);
  vi.stubGlobal("window", {
    location: { pathname: "/board", search: "?token=raw", hash: "#private" },
    addEventListener: target.addEventListener.bind(target),
  });
  reporter = await import("./errorReporter");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("browser error reporting", () => {
  it("deduplicates reports by fingerprint for one minute", () => {
    const error = new Error("Page failed");
    reporter.reportClientError(error);
    vi.advanceTimersByTime(59_999);
    reporter.reportClientError(error, { componentStack: "Frame" });
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    reporter.reportClientError(error);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("ignores ResizeObserver loop noise", () => {
    reporter.reportClientError(new Error("ResizeObserver loop limit exceeded"));
    reporter.reportClientError("ResizeObserver loop completed with undelivered notifications.");
    expect(send).not.toHaveBeenCalled();
  });

  it("sanitizes messages and stacks before sending a keepalive request", () => {
    const error = new Error('Bad credential {"x-api-key":"sample value"}');
    error.stack = "Error\n at /asset.js?token=do-not-send";
    reporter.reportClientError(error, { severity: "fatal", componentStack: "Component Authorization: Basic private" });
    expect(send).toHaveBeenCalledWith("/api/ir/errors/client", expect.objectContaining({
      credentials: "include",
      keepalive: true,
      method: "POST",
    }));
    const body = String(send.mock.calls[0]?.[1]?.body);
    expect(JSON.parse(body)).toMatchObject({ severity: "fatal", route: "/board" });
    expect(body).toContain("[REDACTED]");
    for (const value of ["sample value", "do-not-send", "Basic private", "token=raw", "#private"]) {
      expect(body.includes(value)).toBe(false);
    }
  });

  it("installs one pair of listeners and swallows network failures", async () => {
    send.mockRejectedValueOnce(new Error("Offline"));
    reporter.installErrorReporter();
    reporter.installErrorReporter();
    target.dispatchEvent(Object.assign(new Event("error"), { message: "Page failed" }));
    target.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: "Rejected" }));
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(2);
  });
});
