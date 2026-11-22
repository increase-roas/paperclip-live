import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_ADMIN_KEY_ENV,
  GATEWAY_ADMIN_URL_ENV,
  GATEWAY_BOTS_FLAG_ENV,
  createGatewayBotsClient,
  gatewayBotsEnabled,
  gatewayBotNameIsValid,
  normalizeGatewayBotSummary,
} from "./gateway-bots.js";

const OWNER_KEY = "owner-key-do-not-print-1234";
const BASE_ENV = {
  [GATEWAY_BOTS_FLAG_ENV]: "true",
  [GATEWAY_ADMIN_URL_ENV]: "https://gateway.test/",
  [GATEWAY_ADMIN_KEY_ENV]: OWNER_KEY,
} as NodeJS.ProcessEnv;

const summaryBody = {
  agent: "funnel-builder",
  name: "funnel-builder",
  preset: { name: "funnel-builder", description: "Builds funnels." },
  enabled: true,
  hasKey: true,
  key: {
    present: true,
    algorithm: "sha256",
    fingerprint: "sha256:4b1d9c2e7a01",
    createdAt: "2026-11-18T14:02:11.000Z",
    rotatedAt: "2026-11-21T09:30:00.000Z",
    updatedAt: "2026-11-21T09:30:00.000Z",
    // A gateway bug must not leak a hash through the normalizer.
    hash: "f".repeat(64),
  },
  providers: { ghl: "write" },
  grantedProviders: ["ghl"],
  policy: {
    mode: "drafts_only",
    allowDelete: false,
    allowOutbound: true,
    allowAgencyWrite: false,
    allowBulk: false,
    allowSpend: false,
    allowBuild: false,
    outboundChannels: ["slack"],
    locations: "*",
    secrets: ["ghl-token"],
    admin: false,
    role: "website-builder",
  },
  usage: {
    last24h: { requests: 42, errors: 1 },
    last7d: { requests: 310, errors: 4 },
    lastUsedAt: "2026-11-22T05:10:58.000Z",
  },
  audit: [
    {
      id: 9182,
      at: "2026-11-22T05:10:58.000Z",
      method: "POST",
      path: "/contacts/abc123def456/notes",
      status: 201,
      ok: true,
      tokenType: "location",
      source: "rest",
      undoOf: null,
      undoneBy: null,
      request: { secret: "body" },
    },
  ],
  generatedAt: "2026-11-22T05:12:00.000Z",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("gateway bots flag", () => {
  it("is off unless explicitly enabled", () => {
    expect(gatewayBotsEnabled({})).toBe(false);
    expect(gatewayBotsEnabled({ [GATEWAY_BOTS_FLAG_ENV]: "" })).toBe(false);
    expect(gatewayBotsEnabled({ [GATEWAY_BOTS_FLAG_ENV]: "0" })).toBe(false);
    expect(gatewayBotsEnabled({ [GATEWAY_BOTS_FLAG_ENV]: "false" })).toBe(false);
    expect(gatewayBotsEnabled({ [GATEWAY_BOTS_FLAG_ENV]: "true" })).toBe(true);
    expect(gatewayBotsEnabled({ [GATEWAY_BOTS_FLAG_ENV]: "1" })).toBe(true);
  });

  it("makes no request while the flag is off", async () => {
    const fetchImpl = vi.fn();
    const client = createGatewayBotsClient({ env: {}, fetchImpl });
    await expect(client.list()).resolves.toMatchObject({ connected: false, state: "disabled" });
    await expect(client.summary("funnel-builder")).resolves.toMatchObject({ connected: false, state: "disabled" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports missing server credentials without a request", async () => {
    const fetchImpl = vi.fn();
    const client = createGatewayBotsClient({
      env: { [GATEWAY_BOTS_FLAG_ENV]: "true" },
      fetchImpl,
    });
    const result = await client.list();
    expect(result).toMatchObject({ connected: false, state: "not_configured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts only gateway bot names", () => {
    expect(gatewayBotNameIsValid("funnel-builder")).toBe(true);
    expect(gatewayBotNameIsValid("dr_eggbot")).toBe(true);
    expect(gatewayBotNameIsValid("alex-owner")).toBe(false);
    expect(gatewayBotNameIsValid("UPPER")).toBe(false);
    expect(gatewayBotNameIsValid("../etc")).toBe(false);
    expect(gatewayBotNameIsValid("")).toBe(false);
  });
});

describe("gateway bots client", () => {
  it("sends the owner key from the environment and never returns it", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ generatedAt: "2026-11-22T05:12:00.000Z", count: 1, bots: [summaryBody] }));
    const client = createGatewayBotsClient({ env: BASE_ENV, fetchImpl });
    const result = await client.list();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://gateway.test/api/admin/bots");
    expect((init as RequestInit).headers).toMatchObject({ authorization: `Bearer ${OWNER_KEY}` });

    expect(result.connected).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(OWNER_KEY);
    expect(serialized).not.toContain("f".repeat(64));
    expect(serialized).not.toContain("\"request\"");
  });

  it("normalizes a summary and drops unknown fields", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(summaryBody));
    const client = createGatewayBotsClient({ env: BASE_ENV, fetchImpl });
    const result = await client.summary("funnel-builder");
    if (!result.connected) throw new Error("expected a connected result");

    expect(fetchImpl.mock.calls[0]![0]).toBe("https://gateway.test/api/admin/bots/funnel-builder/summary");
    expect(result.summary).toMatchObject({
      agent: "funnel-builder",
      enabled: true,
      key: { fingerprint: "sha256:4b1d9c2e7a01", rotatedAt: "2026-11-21T09:30:00.000Z" },
      policy: { mode: "drafts_only", allowOutbound: true, role: "website-builder", secrets: ["ghl-token"] },
      usage: { last24h: { requests: 42, errors: 1 }, last7d: { requests: 310, errors: 4 } },
    });
    expect(result.summary.audit).toHaveLength(1);
    expect(result.summary.audit[0]).not.toHaveProperty("request");
    expect(Object.keys(result.summary.key)).toEqual([
      "present",
      "algorithm",
      "fingerprint",
      "createdAt",
      "rotatedAt",
      "updatedAt",
    ]);
  });

  it("refuses an invalid agent name before reading", async () => {
    const fetchImpl = vi.fn();
    const client = createGatewayBotsClient({ env: BASE_ENV, fetchImpl });
    const result = await client.summary("Alex Owner");
    expect(result).toMatchObject({ connected: false, state: "error" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps gateway refusals to states the page can explain", async () => {
    const cases: Array<[number, string]> = [
      [401, "unauthorized"],
      [403, "unauthorized"],
      [429, "rate_limited"],
      [500, "error"],
    ];
    for (const [status, state] of cases) {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: "x" }, status));
      const client = createGatewayBotsClient({ env: BASE_ENV, fetchImpl });
      await expect(client.list()).resolves.toMatchObject({ connected: false, state });
    }
  });

  it("reports an unreachable gateway without throwing", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED https://gateway.test"));
    const client = createGatewayBotsClient({ env: BASE_ENV, fetchImpl });
    const result = await client.list();
    expect(result).toMatchObject({ connected: false, state: "unreachable" });
    expect(JSON.stringify(result)).not.toContain(OWNER_KEY);
  });

  it("reports a non-JSON body as an error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("<html>nope</html>", { status: 200 }));
    const client = createGatewayBotsClient({ env: BASE_ENV, fetchImpl });
    await expect(client.list()).resolves.toMatchObject({ connected: false, state: "error" });
  });
});

describe("normalizeGatewayBotSummary", () => {
  it("returns null without an agent name", () => {
    expect(normalizeGatewayBotSummary({})).toBeNull();
    expect(normalizeGatewayBotSummary(null)).toBeNull();
  });

  it("fills defaults for a bot with no key row", () => {
    const summary = normalizeGatewayBotSummary({ agent: "kiwi" });
    expect(summary).toMatchObject({
      agent: "kiwi",
      name: "kiwi",
      enabled: false,
      hasKey: false,
      key: { present: false, fingerprint: null },
      grantedProviders: [],
      usage: { last24h: { requests: 0, errors: 0 }, lastUsedAt: null },
      audit: [],
      preset: null,
    });
  });
});
