import { describe, expect, it, vi } from "vitest";
import { logger } from "../middleware/logger.js";
import { toolCallFailure } from "../routes/tool-call-failure.js";

describe("tool call failure response", () => {
  it("keeps a stopped worker's own message, because the caller can start it", () => {
    expect(toolCallFailure(new Error('worker for plugin "abc" is not running'))).toEqual({
      status: 502,
      body: { error: 'worker for plugin "abc" is not running' },
    });
  });

  // Regression: both plugin tool routes answered an unexpected failure with
  // err.message, so a caller saw SQL text, a filesystem path or a provider URL.
  it("keeps an unexpected failure out of the response and logs it", () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
    const failure = toolCallFailure(new Error("ENOENT: /root/.paperclip/company-secrets/master.key"));
    expect(failure).toEqual({
      status: 500,
      body: { error: "The tool call could not complete. Try again, then check the server log." },
    });
    expect(JSON.stringify(failure.body)).not.toContain("master.key");
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "plugin tool call failed unexpectedly",
    );
    error.mockRestore();
  });

  it("treats an error that merely mentions a worker as unexpected", () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
    expect(toolCallFailure(new Error("worker log path missing"))).toMatchObject({ status: 500 });
    error.mockRestore();
  });
});
