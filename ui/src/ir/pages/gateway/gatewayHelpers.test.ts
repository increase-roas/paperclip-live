import { describe, expect, it } from "vitest";
import type { GatewayPolicy, GatewayProviderSummary } from "../../api/irOps";
import {
  buildGatewayConnectUrl,
  buildNormalizedScopesCatalog,
  classifyProviderConnection,
  describeGhlPolicy,
  describeProviderGrant,
  detectPresetDrift,
  getAgentStatus,
  parseMultiLineScopes,
} from "./gatewayHelpers";

const basePolicy: GatewayPolicy = {
  mode: "read_only",
  allowDelete: false,
  allowOutbound: false,
  allowAgencyWrite: false,
  allowBulk: false,
  allowSpend: false,
  allowBuild: false,
  locations: "*",
  providers: {},
};

const wavvProvider: GatewayProviderSummary = {
  id: "wavv",
  label: "WAVV",
  category: "dialer",
  configured: true,
  enabled: true,
  methods: ["GET"],
};

const driveUploadProvider: GatewayProviderSummary = {
  id: "google_drive_upload",
  label: "Google Drive Upload",
  category: "google",
  configured: true,
  enabled: true,
  methods: ["POST"],
  actions: ["upload"],
};

const githubProvider: GatewayProviderSummary = {
  id: "github",
  label: "GitHub",
  category: "dev",
  configured: true,
  enabled: true,
  methods: ["GET", "POST", "PUT", "PATCH"],
  actions: ["repos", "contents", "pulls"],
};

describe("gatewayHelpers", () => {
  it("renders exact provider cell labels for read-only, write-only, and scoped write grants", () => {
    expect(describeProviderGrant(undefined, githubProvider)).toEqual({ level: "none", label: "—" });
    expect(describeProviderGrant("read", wavvProvider)).toEqual({
      level: "read_ro",
      label: "Read (RO)",
      actionSummary: undefined,
    });
    expect(describeProviderGrant("write", driveUploadProvider)).toEqual({
      level: "write",
      label: "Write",
      actionSummary: undefined,
    });
    expect(
      describeProviderGrant({ capability: "write", actions: ["repos", "contents"] }, githubProvider),
    ).toEqual({
      level: "read_write",
      label: "Read + Write",
      actionSummary: "2/3",
    });
  });

  it("extracts GHL mode and elevated guardrail badges", () => {
    const info = describeGhlPolicy({
      ...basePolicy,
      mode: "write",
      allowOutbound: true,
      outboundChannels: ["SMS"],
      allowBuild: true,
      allowAgencyWrite: true,
    });
    expect(info.label).toBe("Read + Write");
    expect(info.flags).toEqual(["Out:SMS", "Build", "Agency"]);
  });

  it("distinguishes Key Active, Disabled, and No Key accurately", () => {
    expect(getAgentStatus({ hasKey: true, enabled: true })).toEqual({
      kind: "active",
      label: "Key Active",
    });
    expect(getAgentStatus({ hasKey: true, enabled: false })).toEqual({
      kind: "disabled",
      label: "Disabled",
    });
    expect(getAgentStatus({ hasKey: false, enabled: false })).toEqual({
      kind: "no_key",
      label: "No Key",
    });
  });

  it("detects preset drift for dr-eggbot when live policy differs from its preset", () => {
    const drifted = detectPresetDrift("dr-eggbot", {
      ...basePolicy,
      mode: "write",
      providers: { github: "write" },
    });
    expect(drifted.drifted).toBe(true);
    expect(drifted.reason).toContain("GHL mode");

    const clean = detectPresetDrift("dr-eggbot", {
      ...basePolicy,
      mode: "drafts_only",
      providers: { google_drive: { capability: "read", actions: ["files", "drives"] } },
    });
    expect(clean.drifted).toBe(false);
  });

  it("parses multi-line GHL scopes and infers read/write access", () => {
    const parsed = parseMultiLineScopes("contacts.readonly\ncontacts.write  contacts.readonly\nopportunities.write");
    expect(parsed).toEqual([
      { id: "contacts.readonly", access: "read" },
      { id: "contacts.write", access: "write" },
      { id: "opportunities.write", access: "write" },
    ]);
  });

  it("gracefully synthesizes the scopes catalog when /admin/scopes is unavailable", () => {
    const normalized = buildNormalizedScopesCatalog(
      null,
      [wavvProvider, githubProvider],
      {
        version: "168",
        agency: { authorized: true, scopeCount: 196 },
        ghlScopes: { requiredCount: 51, missing: ["workflows.publish"] },
      },
    );
    expect(normalized.synthesizedFallback).toBe(true);
    expect(normalized.pendingReauthScopes).toEqual(["workflows.publish"]);
    expect(normalized.integrations.map((i) => i.id)).toEqual([
      "ghl",
      "wavv",
      "github",
      "gateway_routes",
    ]);
    expect(normalized.integrations[0]?.totalCount).toBe(196);
  });

  it("classifies Connected (LIVE), Needs Connect, and Not Configured providers cleanly", () => {
    const qboNeedsConnect = classifyProviderConnection({
      id: "quickbooks",
      label: "QuickBooks Online",
      category: "accounting",
      configured: true,
      connected: false,
      authType: "oauth",
      connectUrl: "https://increase-roas-oauth-gateway.increase-roas.workers.dev/oauth/quickbooks/start",
      enabled: true,
      oauthScopes: ["com.intuit.quickbooks.accounting"],
      actions: ["reports", "query", "payments", "invoices", "accounts"],
    });
    expect(qboNeedsConnect.status).toBe("needs_connect");
    expect(qboNeedsConnect.badgeLabel).toBe("Needs Connect");
    expect(qboNeedsConnect.authLabel).toBe("OAuth 2.0");
    expect(qboNeedsConnect.canConnect).toBe(true);
    expect(qboNeedsConnect.connectUrl).toContain("return_to=https%3A%2F%2Fapp.increaseai.tech%2Fcompany%2Fsettings%2Fgateway");

    const tsLive = classifyProviderConnection({
      id: "tailscale",
      label: "Tailscale",
      category: "infra",
      configured: true,
      connected: true,
      authType: "api_key",
      connectUrl: null,
      enabled: true,
      actions: ["devices", "keys"],
    });
    expect(tsLive.status).toBe("live");
    expect(tsLive.badgeLabel).toBe("Connected (LIVE)");
    expect(tsLive.authLabel).toBe("API Key");
    expect(tsLive.canConnect).toBe(false);

    const ffUnconfigured = classifyProviderConnection({
      id: "fireflies",
      label: "Fireflies",
      category: "meetings",
      configured: false,
      connected: false,
      authType: "api_key",
      connectUrl: null,
      enabled: true,
    });
    expect(ffUnconfigured.status).toBe("not_configured");
    expect(ffUnconfigured.badgeLabel).toBe("Not Configured");

    expect(buildGatewayConnectUrl("javascript:alert(1)")).toBeNull();
  });
});
