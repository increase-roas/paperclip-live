import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  matchGhlHealthLocation,
  readGatewayFulfillmentBundle,
  resetGatewayFulfillmentCache,
  type GatewayHealthLocation,
} from "../gateway-fulfillment-client.js";
import { readPortfolioSnapshotBundle } from "../sales-dashboard-client.js";

const PINNED_NOW = new Date("2026-11-27T18:00:00.000Z");

const ENV_KEYS = [
  "GATEWAY_PAPERCLIP_KEY",
  "OAUTH_GATEWAY_URL",
  "GATEWAY_BASE_URL",
  "GHL_AGENCY_COMPANY_ID",
  "GHL_AGENCY_INCREASE_ROAS_LOCATION_ID",
  "GHL_AGENCY_HOT_TUB_LAUNCH_LOCATION_ID",
  "GHL_ALEX_BLOOMFIELD_LOCATION_ID",
  "META_AGENCY_INCREASE_ROAS_ACCOUNT_ID",
  "META_AGENCY_ALEX_BLOOMFIELD_ACCOUNT_ID",
  "META_AGENCY_HOT_TUB_LAUNCH_ACCOUNT_ID",
  "FULFILLMENT_EXCLUDED_META_ACCOUNT_IDS",
  "FULFILLMENT_EXCLUDED_GHL_LOCATION_IDS",
  "FULFILLMENT_EXCLUDED_CLIENT_SLUGS",
  "SALES_DASHBOARD_ADMIN_KEY",
] as const;

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("gateway-fulfillment-client", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    resetGatewayFulfillmentCache();
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    resetGatewayFulfillmentCache();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("fails closed to null with zero requests when GATEWAY_PAPERCLIP_KEY is unset", async () => {
    const fetchMock = vi.fn();
    const res = await readGatewayFulfillmentBundle("30d", {
      token: "",
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => PINNED_NOW,
    });
    expect(res).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads live client portfolio directly from OAuth Gateway using ONLY GATEWAY_PAPERCLIP_KEY, strictly excluding agency accounts, own brands, and former clients", async () => {
    process.env.GATEWAY_PAPERCLIP_KEY = "test-gw";
    process.env.GHL_AGENCY_COMPANY_ID = "CoAgencyFake00000001";
    process.env.META_AGENCY_INCREASE_ROAS_ACCOUNT_ID = "act_100000000000001";
    process.env.META_AGENCY_ALEX_BLOOMFIELD_ACCOUNT_ID = "act_100000000000002";
    process.env.META_AGENCY_HOT_TUB_LAUNCH_ACCOUNT_ID = "act_100000000000003";
    process.env.GHL_AGENCY_INCREASE_ROAS_LOCATION_ID = "LocAgencyMain0000001";
    process.env.GHL_AGENCY_HOT_TUB_LAUNCH_LOCATION_ID = "LocAgencyHtl00000002";
    process.env.FULFILLMENT_EXCLUDED_CLIENT_SLUGS = "retired-acme";

    const requestedUrls: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requestedUrls.push(url);
      expect(init?.redirect).toBe("manual");
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers.authorization).toBe("Bearer test-gw");
      expect(headers["user-agent"]).toBe("paperclip-server/1.0");

      if (url.endsWith("/api/meta/adaccounts")) {
        return jsonRes({
          data: [
            // Agency Meta accounts (must be skipped before insights)
            { id: "act_100000000000001", name: "Increase Roas MAIN", account_status: 1 },
            { id: "act_100000000000002", name: "Alex Bloomfield Personal Brand", account_status: 1 },
            { id: "act_100000000000003", name: "Hot Tub Launch", account_status: 1 },
            // Own brand (must be excluded via OWN_BRANDS)
            { id: "act_100000000000004", name: "Dynamite Lights Michigan", account_status: 1 },
            // Configured former client slug (must be excluded)
            { id: "act_100000000000005", name: "Retired Acme Spas", account_status: 1 },
            // Active paying client #1 (Meta + matched GHL)
            { id: "act_200000000000001", name: "Beacon Tree Care Ad Account", account_status: 1 },
            // Active paying client #2 (paused Meta $0 spend, active GHL leads)
            { id: "act_200000000000002", name: "Summit Pool and Spa Supply Ad Account", account_status: 2 },
            // Dormant account ($0 spend, no GHL leads -> omitted)
            { id: "act_200000000000003", name: "Extra ad account 6", account_status: 3 },
          ],
          next: null,
        });
      }

      if (url.endsWith("/api/health")) {
        return jsonRes({
          checkedLocations: 5,
          locations: [
            { locationId: "LocAgencyMain0000001", name: "Increase Roas MAIN", metrics: { leads7d: 5, leads30d: 14 } },
            { locationId: "LocGarbageTest000001", name: "Clean Account #61", metrics: { leads7d: 2, leads30d: 20 } },
            // Dormant duplicate vs active location for Beacon Tree Care (must pick active one!)
            { locationId: "LocBeaconDormant0001", name: "Beacon Tree Care LLC", metrics: { leads7d: 0, leads30d: 0 } },
            { locationId: "LocBeaconActive00002", name: "IR Beacon Tree Care L L C", metrics: { leads7d: 8, leads30d: 32 } },
            { locationId: "LocSummitActive00003", name: "Summit Pool and Spa Supply", metrics: { leads7d: 3, leads30d: 9 } },
          ],
        });
      }

      if (url.includes("/api/meta/insights")) {
        const parsed = new URL(url);
        const acct = parsed.searchParams.get("adAccountId");
        // Never query insights for agency, own-brand, or excluded former accounts!
        expect(acct).not.toMatch(/^act_10000000000000[1-5]$/);
        if (acct === "act_200000000000001") {
          return jsonRes({
            data: [
              {
                date_start: "2026-11-24",
                spend: "1200.50",
                impressions: "25000",
                clicks: "400",
                actions: [
                  { action_type: "link_click", value: "300" },
                  { action_type: "lead", value: "28" },
                ],
              },
              {
                date_start: "2026-11-26",
                spend: "150.00",
                impressions: "5000",
                clicks: "60",
                actions: [{ action_type: "link_click", value: "50" }],
              },
            ],
            next: null,
          });
        }
        return jsonRes({ data: [], next: null });
      }

      if (url.includes("/api/location/LocBeaconActive00002/readonly")) {
        const ghlPath = new URL(url).searchParams.get("path") ?? "";
        if (ghlPath === "/opportunities/pipelines") {
          return jsonRes({
            pipelines: [
              { id: "pipe-sales", name: "Tree Sales Pipeline" },
              { id: "pipe-hire", name: "Crew Hiring & Applicants" },
            ],
          });
        }
        if (ghlPath.startsWith("/opportunities/search")) {
          return jsonRes({
            opportunities: [
              { id: "opp-1", pipelineId: "pipe-sales", status: "won", monetaryValue: 4500, lastStatusChangeAt: "2026-11-20T12:00:00.000Z" },
              { id: "opp-2", pipelineId: "pipe-sales", status: "won", monetaryValue: 2250, lastStatusChangeAt: "2026-11-22T12:00:00.000Z" },
              // Recruiting pipeline won opp must be excluded!
              { id: "opp-hire", pipelineId: "pipe-hire", status: "won", monetaryValue: 9999, lastStatusChangeAt: "2026-11-22T12:00:00.000Z" },
              // Out-of-window won opp must be excluded!
              { id: "opp-old", pipelineId: "pipe-sales", status: "won", monetaryValue: 8000, lastStatusChangeAt: "2026-09-01T12:00:00.000Z" },
            ],
          });
        }
        if (ghlPath === "/calendars/") {
          return jsonRes({
            calendars: [
              { id: "cal-est", name: "Estimate Visits" },
              { id: "cal-hire", name: "Candidate Interview Calendar" },
            ],
          });
        }
        if (ghlPath.startsWith("/calendars/events")) {
          expect(ghlPath).toContain("calendarId=cal-est");
          return jsonRes({
            events: [
              { startTime: "2026-11-20T14:00:00.000Z", appointmentStatus: "showed", contactId: "c1" },
              { startTime: "2026-11-21T14:00:00.000Z", appointmentStatus: "showed", contactId: "c2" },
              { startTime: "2026-11-22T14:00:00.000Z", appointmentStatus: "noshow", contactId: "c3" },
              { startTime: "2026-11-23T14:00:00.000Z", appointmentStatus: "cancelled", contactId: "c4" },
              // Future appointment must not count in past-dated booked!
              { startTime: "2026-12-05T14:00:00.000Z", appointmentStatus: "confirmed", contactId: "c5" },
            ],
          });
        }
      }

      if (url.includes("/api/location/LocSummitActive00003/readonly")) {
        const ghlPath = new URL(url).searchParams.get("path") ?? "";
        if (ghlPath === "/opportunities/pipelines") return jsonRes({ pipelines: [{ id: "p1", name: "Sales" }] });
        if (ghlPath.startsWith("/opportunities/search")) return jsonRes({ opportunities: [] });
        if (ghlPath === "/calendars/") return jsonRes({ calendars: [] });
      }

      return jsonRes({}, 404);
    });

    // Call through readPortfolioSnapshotBundle with SALES_DASHBOARD_ADMIN_KEY completely unset!
    const bundle = await readPortfolioSnapshotBundle("30d", {
      gatewayBaseUrl: "https://gw.example",
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => PINNED_NOW,
      bypassCache: true,
    });

    // Zero calls to legacy Sales Dashboard host!
    expect(requestedUrls.some((u) => u.includes("dashboard.increaseai.tech"))).toBe(false);
    expect(bundle.observedAt).toBe(PINNED_NOW.toISOString());
    expect(bundle.clients).toHaveLength(2);

    const beacon = bundle.clients.find((c) => c.slug === "beacon-tree-care");
    expect(beacon).toMatchObject({
      displayName: "Beacon Tree Care",
      spend: 1350.5,
      impressions: 30000,
      clicks: 350,
      newLeads: 32,
      booked: 3,
      showed: 2,
      showRate: 66.7,
      wonDeals: 2,
      closeRate: 100,
      pipelineRevenueUsd: 6750,
      zeroLeadDays: 1,
    });

    const summit = bundle.clients.find((c) => c.slug === "summit-pool-and-spa-supply");
    expect(summit).toMatchObject({
      displayName: "Summit Pool and Spa Supply",
      spend: 0,
      impressions: 0,
      clicks: 0,
      newLeads: 9,
      booked: 0,
      showed: 0,
      wonDeals: 0,
      pipelineRevenueUsd: 0,
      zeroLeadDays: 0,
    });
  });

  it("uses Meta leads for month-to-date period and does not bleed 30d health leads into MTD", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/meta/adaccounts")) {
        return jsonRes({ data: [{ id: "act_300000000000001", name: "Acme Spas Ad Account", account_status: 1 }] });
      }
      if (url.endsWith("/api/health")) {
        return jsonRes({
          locations: [{ locationId: "LocAcmeSpas000000001", name: "Acme Spas", metrics: { leads7d: 4, leads30d: 99 } }],
        });
      }
      if (url.includes("/api/meta/insights")) {
        expect(url).toContain("since=2026-11-01");
        expect(url).toContain("until=2026-11-27");
        return jsonRes({
          data: [
            {
              date_start: "2026-11-15",
              spend: "500",
              impressions: "10000",
              actions: [
                { action_type: "link_click", value: "200" },
                { action_type: "lead", value: "10" },
              ],
            },
          ],
        });
      }
      return jsonRes({}, 404);
    });

    const bundle = await readGatewayFulfillmentBundle("month", {
      baseUrl: "https://gw.example",
      token: "test-mtd",
      agencyCompanyId: "",
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => PINNED_NOW,
      bypassCache: true,
    });

    expect(bundle?.clients).toHaveLength(1);
    expect(bundle?.clients[0]).toMatchObject({
      slug: "acme-spas",
      spend: 500,
      newLeads: 10,
      cpl: 50,
    });
  });

  it("caches healthy gateway reads within TTL and deduplicates concurrent in-flight requests, while never negative-caching failures", async () => {
    let calls = 0;
    let shouldFail = true;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      calls += 1;
      if (shouldFail) return jsonRes({ error: "upstream_down" }, 502);
      const url = String(input);
      if (url.endsWith("/api/meta/adaccounts")) {
        return jsonRes({ data: [{ id: "act_400000000000001", name: "Globex Pools", account_status: 1 }] });
      }
      if (url.endsWith("/api/health")) return jsonRes({ locations: [] });
      if (url.endsWith("/api/status")) return jsonRes({ companyId: "" });
      if (url.includes("/api/meta/insights")) {
        return jsonRes({ data: [{ date_start: "2026-11-25", spend: "300", impressions: "5000", actions: [{ action_type: "lead", value: "6" }] }] });
      }
      return jsonRes({}, 404);
    });

    const opts = {
      baseUrl: "https://gw.example",
      token: "test-cache",
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => PINNED_NOW,
    };

    // Failure is never negative-cached
    expect(await readGatewayFulfillmentBundle("7d", opts)).toBeNull();
    shouldFail = false;
    calls = 0;

    // Concurrent requests share one single in-flight roundtrip
    const [a, b] = await Promise.all([
      readGatewayFulfillmentBundle("7d", opts),
      readGatewayFulfillmentBundle("7d", opts),
    ]);
    expect(a?.clients).toHaveLength(1);
    expect(b?.clients).toHaveLength(1);
    const firstRoundCalls = calls;
    expect(firstRoundCalls).toBeGreaterThan(0);

    // Subsequent call within TTL hits memory cache with zero network requests
    const c = await readGatewayFulfillmentBundle("7d", opts);
    expect(c?.clients[0]?.spend).toBe(300);
    expect(calls).toBe(firstRoundCalls);
  });

  it("matches GHL locations deterministically one-to-one with ampersand and L L C normalization", () => {
    const locations: GatewayHealthLocation[] = [
      { locationId: "loc-mb", name: "IR M&B Tree Service and Landscape", leads7d: 5, leads30d: 46 },
      { locationId: "loc-sammy", name: "IR Sammy FL Tree Service", leads7d: 10, leads30d: 39 },
      { locationId: "loc-jp-old", name: "JP Tree LLC", leads7d: 0, leads30d: 0 },
      { locationId: "loc-jp-live", name: "IR JP Tree L L C", leads7d: 5, leads30d: 23 },
    ];

    expect(matchGhlHealthLocation("M&B Tree Service & Landscape LLC Ad Account", locations)?.locationId).toBe("loc-mb");
    expect(matchGhlHealthLocation("Sammy FL Trees", locations)?.locationId).toBe("loc-sammy");
    expect(matchGhlHealthLocation("JP TREE", locations)?.locationId).toBe("loc-jp-live");
    // Already-used location is never double-assigned
    expect(matchGhlHealthLocation("M&B Tree Service & Landscape LLC", locations, new Set(["loc-mb"]))).toBeNull();
  });

  it("fails closed to null when a candidate Meta ad account suffers a persistent transient error so portfolio spend is never silently under-reported", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/meta/adaccounts")) {
        return jsonRes({
          data: [
            { id: "act_500000000000001", name: "Acme Spas", account_status: 1 },
            { id: "act_500000000000002", name: "Globex Pools", account_status: 1 },
          ],
        });
      }
      if (url.endsWith("/api/health")) return jsonRes({ locations: [] });
      if (url.endsWith("/api/status")) return jsonRes({ companyId: "" });
      if (url.includes("adAccountId=act_500000000000001")) {
        return jsonRes({ data: [{ date_start: "2026-11-25", spend: "1000", impressions: "10000", actions: [{ action_type: "lead", value: "20" }] }] });
      }
      if (url.includes("adAccountId=act_500000000000002")) {
        return jsonRes({ error: "meta_upstream_502" }, 502);
      }
      return jsonRes({}, 404);
    });

    const bundle = await readGatewayFulfillmentBundle("30d", {
      baseUrl: "https://gw.example",
      token: "test-fail-closed",
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => PINNED_NOW,
      bypassCache: true,
    });

    expect(bundle).toBeNull();
  });
});
