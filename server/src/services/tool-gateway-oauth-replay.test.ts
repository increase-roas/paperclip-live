import { describe, expect, it } from "vitest";
import {
  OAUTH_READ_REPLAY_ENV,
  oauthRefreshReplayEnabled,
  shouldReplayReadAfterOAuthRefresh,
} from "./tool-gateway-oauth-replay.js";

describe("OAuth refresh read replay prototype", () => {
  it("is off unless the environment turns it on", () => {
    expect(oauthRefreshReplayEnabled({})).toBe(false);
    expect(oauthRefreshReplayEnabled({ [OAUTH_READ_REPLAY_ENV]: "0" })).toBe(false);
    expect(oauthRefreshReplayEnabled({ [OAUTH_READ_REPLAY_ENV]: "1" })).toBe(true);
  });

  it("replays only a read call without an MCP session", () => {
    expect(shouldReplayReadAfterOAuthRefresh({ enabled: true, riskLevel: "read", usesMcpSession: false })).toBe(true);
  });

  it("never replays a write, destructive or unknown call", () => {
    for (const riskLevel of ["write", "destructive", "critical", "high", null, undefined]) {
      expect(shouldReplayReadAfterOAuthRefresh({ enabled: true, riskLevel, usesMcpSession: false })).toBe(false);
    }
  });

  it("never replays a session-based call, even when enabled", () => {
    expect(shouldReplayReadAfterOAuthRefresh({ enabled: true, riskLevel: "read", usesMcpSession: true })).toBe(false);
  });

  it("stays off when the flag is off", () => {
    expect(shouldReplayReadAfterOAuthRefresh({ enabled: false, riskLevel: "read", usesMcpSession: false })).toBe(false);
  });
});
