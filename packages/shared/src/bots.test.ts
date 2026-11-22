import { describe, expect, it } from "vitest";
import {
  agentGatewayLinkFromConfig,
  catalogGatewayLink,
  gatewayPolicyFromBaseUrl,
  KNOWN_GATEWAY_BOTS,
  readBotMetadata,
} from "./bots.js";

describe("gateway policy from a Hermes gateway URL", () => {
  it("reads the policy segment from a profile URL", () => {
    expect(
      gatewayPolicyFromBaseUrl(
        "https://srv2155332.tailde26a1.ts.net:8443/p/ads-checker",
      ),
    ).toEqual({
      policy: "ads-checker",
      provider: "srv2155332.tailde26a1.ts.net:8443",
    });
  });

  it("ignores a trailing slash and a deeper path", () => {
    expect(
      gatewayPolicyFromBaseUrl("https://example.test/p/website-builder/")
        ?.policy,
    ).toBe("website-builder");
    expect(
      gatewayPolicyFromBaseUrl("https://example.test/p/research/v1/chat")
        ?.policy,
    ).toBe("research");
  });

  it("decodes an encoded policy name", () => {
    expect(
      gatewayPolicyFromBaseUrl("https://example.test/p/ads%2Dchecker")?.policy,
    ).toBe("ads-checker");
  });

  it("returns null when the URL carries no profile segment", () => {
    expect(gatewayPolicyFromBaseUrl("https://example.test")).toBeNull();
    expect(gatewayPolicyFromBaseUrl("https://example.test/v1/chat")).toBeNull();
    expect(gatewayPolicyFromBaseUrl("https://example.test/p/")).toBeNull();
  });

  it("returns null for values that are not a usable URL", () => {
    expect(gatewayPolicyFromBaseUrl(null)).toBeNull();
    expect(gatewayPolicyFromBaseUrl(undefined)).toBeNull();
    expect(gatewayPolicyFromBaseUrl("")).toBeNull();
    expect(
      gatewayPolicyFromBaseUrl(
        "srv2155332.tailde26a1.ts.net:8443/p/ads-checker",
      ),
    ).toBeNull();
    expect(
      gatewayPolicyFromBaseUrl({ apiBaseUrl: "https://example.test/p/x" }),
    ).toBeNull();
  });
});

describe("gateway link from agent adapter config", () => {
  it("derives a policy-only link for a Hermes gateway agent", () => {
    expect(
      agentGatewayLinkFromConfig({
        adapterType: "hermes_gateway",
        adapterConfig: {
          apiBaseUrl:
            "https://srv2155332.tailde26a1.ts.net:8443/p/website-builder",
        },
      }),
    ).toEqual({
      keyId: null,
      policy: "website-builder",
      provider: "srv2155332.tailde26a1.ts.net:8443",
      source: "agent_config",
    });
  });

  it("never reads a key from the adapter config", () => {
    const link = agentGatewayLinkFromConfig({
      adapterType: "hermes_gateway",
      adapterConfig: {
        apiBaseUrl: "https://example.test/p/research",
        apiKey: {
          type: "secret_ref",
          secretId: "a214b0d8-91c0-4cc2-8405-000000000000",
        },
      },
    });
    expect(link?.keyId).toBeNull();
    expect(Object.keys(link ?? {})).not.toContain("apiKey");
  });

  it("ignores other adapters and agents without a profile URL", () => {
    expect(
      agentGatewayLinkFromConfig({
        adapterType: "codex_local",
        adapterConfig: { apiBaseUrl: "https://example.test/p/research" },
      }),
    ).toBeNull();
    expect(
      agentGatewayLinkFromConfig({
        adapterType: "hermes_gateway",
        adapterConfig: {},
      }),
    ).toBeNull();
    expect(
      agentGatewayLinkFromConfig({
        adapterType: "hermes_gateway",
        adapterConfig: null,
      }),
    ).toBeNull();
  });
});

describe("bot metadata gateway links", () => {
  it("marks a fully recorded link as metadata-sourced", () => {
    expect(
      readBotMetadata({
        bot: {
          purpose: "Researches accounts.",
          gateway: {
            keyId: "gk_live_research",
            policy: "researcher",
            provider: "increase-roas-oauth-gateway",
          },
        },
      }).gateway,
    ).toEqual({
      keyId: "gk_live_research",
      policy: "researcher",
      provider: "increase-roas-oauth-gateway",
      source: "metadata",
    });
  });

  it("still drops a half-filled gateway block", () => {
    expect(
      readBotMetadata({ bot: { gateway: { keyId: "gk_live_only" } } }).gateway,
    ).toBeNull();
    expect(
      readBotMetadata({ bot: { gateway: { policy: "researcher" } } }).gateway,
    ).toBeNull();
  });
});

describe("catalog gateway link", () => {
  it("names the policy preset every known bot ships with and never a key id", () => {
    for (const known of KNOWN_GATEWAY_BOTS) {
      expect(known.policy, `${known.name} should name its gateway preset`).toBe(known.slug);
      expect(catalogGatewayLink(known)).toEqual({
        keyId: null,
        policy: known.slug,
        provider: "gateway",
        source: "catalog_preset",
      });
    }
  });

  it("returns no link when a bot has no preset, so the page keeps its honest empty state", () => {
    expect(catalogGatewayLink({ slug: "unpreset-bot", policy: null })).toBeNull();
    expect(catalogGatewayLink({ slug: "unpreset-bot" })).toBeNull();
  });
});
