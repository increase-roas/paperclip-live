import { describe, expect, it } from "vitest";
import { agentNeedsAuthReconnect, isProviderAuthFailureCode, providerAuthLabel } from "./provider-auth";

describe("provider auth state", () => {
  it.each(["claude_auth_required", "acpx_auth_required", "native_provider_auth_required"])("recognizes %s", code => {
    expect(isProviderAuthFailureCode(code)).toBe(true);
  });

  it.each(["provider_process_exited", "native_provider_model_rejected", "provider_quota", null, undefined])(
    "does not treat %s as provider sign-in",
    code => {
      expect(isProviderAuthFailureCode(code)).toBe(false);
    },
  );

  it.each([
    [{ status: "paused", pauseReason: "auth_required" }, true],
    [{ status: "paused", pauseReason: "manual" }, false],
    [{ status: "idle", pauseReason: "auth_required" }, false],
    [{}, false],
  ] as const)("needs reconnect for %j is %s", (agent, expected) => {
    expect(agentNeedsAuthReconnect(agent)).toBe(expected);
  });

  it.each([
    [{ adapterType: "claude_local" }, "Claude"],
    [{ adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "claude" } }, "Claude"],
    [{ adapterType: "codex_local" }, "Codex"],
    [{ adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "gemini" } }, "Gemini"],
    [{ adapterType: "opencode_local" }, "OpenCode"],
    [{ adapterType: "process" }, "provider"],
  ] as const)("labels %j as %s", (agent, label) => {
    expect(providerAuthLabel(agent)).toBe(label);
  });
});
