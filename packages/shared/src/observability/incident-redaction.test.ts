import { describe, expect, it } from "vitest";
import { redactIncidentFields, redactIncidentText } from "./incident-redaction.js";
import { redactSensitive } from "./redaction.js";

describe("incident privacy", () => {
  it("covers the shared redactor's sensitive keys plus incident-specific keys", () => {
    const keys = [
      "authorization", "cookie", "set-cookie", "password", "passwd", "secret", "token",
      "access_token", "refresh-token", "api_key", "apikey", "private_key", "private-key", "privateKey",
      "credential", "credentials", "session_id", "session-id", "sessionId", "x-api-key", "client_secret",
    ];
    for (const key of keys) {
      const input = { [key]: "fake-sensitive-value" };
      const result = redactIncidentFields(input);
      expect(result[key], key).toBe("[REDACTED]");
      if (JSON.stringify(redactSensitive(input)).includes("[REDACTED]")) {
        expect(result).toEqual(redactSensitive(input));
      }
      expect(redactIncidentText(`${key}="fake-sensitive-value"`), key).not.toContain("fake-sensitive-value");
      expect(redactIncidentText(`/diagnostic?${key}=fake-sensitive-value&mode=safe`), key)
        .toBe(`/diagnostic?${key}=[REDACTED]&mode=safe`);
    }
  });

  it.each([
    ["/api/invites/fake-token/logo", "/api/invites/:token/logo"],
    ["/invite/fake-token", "/invite/:token"],
    ["/board-claim/fake-token/claim", "/board-claim/:token/claim"],
    ["/api/%69nvites/fake%2Ftoken/skills/index", "/api/invites/:token/skills/index"],
    ["/api/%2569nvites/fake%252Ftoken/onboarding.txt", "/api/invites/:token/onboarding.txt"],
    ["/api/%62oard-claim/fake%2Fclaim-token/claim", "/api/board-claim/:token/claim"],
    ["/api%2Finvites%2Ffake-token/logo", "/api/invites/:token/logo"],
    [String.raw`/api/\u0069nvites/fake\u002ftoken/logo`, "/api/invites/:token/logo"],
    [String.raw`\u002fapi\u002finvites\u002ffake-token`, "/api/invites/:token"],
    ["%2Fapi%2Finvites%2Ffake%2Fpacked-token", "/api/invites/:token"],
    ["/api/invites/:token/skills/:skillName", "/api/invites/:token/skills/:skillName"],
  ])("redacts secret paths inside prose and stacks: %s", (path, expected) => {
    expect(redactIncidentText(path)).toBe(expected);
    expect(redactIncidentText(`Failed GET https://example.test${path}\n    at lookup (app.ts:1:2)`))
      .toBe(`Failed GET https://example.test${expected}\n    at lookup (app.ts:1:2)`);
  });

  it("preserves ordinary diagnostics and existing size/depth bounds", () => {
    expect(redactIncidentText("GET /api/companies/company/issues/issue: database unavailable"))
      .toBe("GET /api/companies/company/issues/issue: database unavailable");
    expect(redactIncidentText("x".repeat(40_000))).toHaveLength(32_768);
    expect(redactIncidentText("x".repeat(40_000), 128)).toHaveLength(128);
    expect(Object.keys(redactIncidentFields(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`field${i}`, i])))))
      .toHaveLength(32);
    expect(redactIncidentFields({ nested: { deeper: { more: { deep: { last: { note: "fake-deep-token" } } } } } }))
      .toEqual({ nested: { deeper: { more: { deep: { last: "[Truncated]" } } } } });
  });
});
