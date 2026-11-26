import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readAgencyMarketingSummary,
  resetAgencyMarketingCache,
} from "../agency-marketing-client.js";
import {
  readAgencySalesSummary,
  resetAgencySalesCache,
} from "../agency-sales-client.js";
import { filterClientOnlyPortfolio, type MergedClientMetrics } from "../sales-dashboard-client.js";

const PINNED_NOW = new Date("2026-11-26T06:00:00.000Z");

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("readAgencyMarketingSummary", () => {
  beforeEach(() => {
    resetAgencyMarketingCache();
  });

  afterEach(() => {
    resetAgencyMarketingCache();
  });

  it("fails closed to null when no Gateway token is configured", async () => {
    const fetchMock = vi.fn();
    const res = await readAgencyMarketingSummary("30d", {
      token: "",
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => PINNED_NOW,
    });
    expect(res).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads the 3 Increase ROAS agency Meta ad accounts, deduplicates Meta lead actions, and surfaces 'Needs account ID / key' for inaccessible accounts", async () => {
    const requestedAccounts: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers["user-agent"]).toBe("paperclip-server/1.0");
      expect(headers.authorization).toBe("Bearer gw-paperclip-test");

      const acct = url.searchParams.get("adAccountId") ?? "";
      requestedAccounts.push(acct);

      if (acct === "act_735997837915750") {
        // Real Meta shape: lead + onsite_web_lead + offsite_conversion.fb_pixel_lead all report the SAME 7 leads.
        return jsonRes({
          data: [
            {
              date_start: "2026-11-24",
              spend: "110.62",
              impressions: "3785",
              clicks: "372",
              actions: [
                { action_type: "link_click", value: "136" },
                { action_type: "lead", value: "7" },
                { action_type: "onsite_web_lead", value: "7" },
                { action_type: "offsite_conversion.fb_pixel_lead", value: "7" },
              ],
            },
            {
              date_start: "2026-11-25",
              spend: "120.00",
              impressions: "1000",
              clicks: "40",
              actions: [{ action_type: "link_click", value: "20" }],
            },
          ],
          next: null,
        });
      }
      if (acct === "act_931652032962948") {
        // Connected account with $0 spend in window
        return jsonRes({ data: [], next: null });
      }
      return jsonRes({ error: "policy_provider_resource_blocked" }, 403);
    });

    const summary = await readAgencyMarketingSummary("30d", {
      baseUrl: "https://gw.example",
      token: "gw-paperclip-test",
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => PINNED_NOW,
      bypassCache: true,
    });

    expect(summary).not.toBeNull();
    expect(requestedAccounts).toEqual([
      "act_1751702711685898",
      "act_735997837915750",
      "act_931652032962948",
    ]);
    expect(summary?.hasMeta).toBe(true);
    expect(summary?.liveAccountCount).toBe(2);
    expect(summary?.totalAccountCount).toBe(3);

    // Deduplicated leads: 7 (not 21), spend: 230.62, link clicks: 156 / 4785 = 3.26%, zero-lead days: 1
    expect(summary?.spend).toBe(230.62);
    expect(summary?.leads).toBe(7);
    expect(summary?.ctr).toBe(3.26);
    expect(summary?.cpl).toBe(32.95);
    expect(summary?.zeroLeadDays).toBe(1);

    const irB2b = summary?.accounts.find((a) => a.id === "increase-roas-b2b");
    expect(irB2b?.status).toBe("needs_config");
    expect(irB2b?.statusLabel).toBe("Needs account ID / key");
    expect(irB2b?.spend).toBeNull();

    const htl = summary?.accounts.find((a) => a.id === "hot-tub-launch");
    expect(htl?.status).toBe("live");
    expect(htl?.statusLabel).toBe("Live · $0 spend");
    expect(htl?.spend).toBe(0);
  });
});

describe("readAgencySalesSummary", () => {
  beforeEach(() => {
    resetAgencySalesCache();
  });

  afterEach(() => {
    resetAgencySalesCache();
  });

  it("fails closed to null when neither Gateway token nor Alex Bloomfield PIT key is configured", async () => {
    const fetchMock = vi.fn();
    const res = await readAgencySalesSummary("30d", {
      gatewayToken: "",
      alexBloomfieldPitKey: "",
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => PINNED_NOW,
    });
    expect(res).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads Increase ROAS Main + Hot Tub Launch B2B via Gateway, excludes recruiting pipelines, and marks Alex Bloomfield as awaiting PIT key", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const ghlPath = url.searchParams.get("path") ?? "";
      const isIrMain = url.pathname.includes("/Sr90yJUmFoBTgBQuejtU/");
      const isHtl = url.pathname.includes("/AG47jEV5rVUrGLt5FlKO/");

      if (ghlPath === "/opportunities/pipelines") {
        return jsonRes({
          pipelines: isIrMain
            ? [
                { id: "p-hire", name: "Director of Sales Applicants", stages: [{ id: "s-app", name: "New Application" }] },
                { id: "p-sales", name: "02. B2B ADS", stages: [{ id: "s-won", name: "CLOSED" }] },
              ]
            : [
                {
                  id: "p-htl",
                  name: "B2B-HTL | Sales Pipeline",
                  stages: [
                    { id: "s-new", name: "01 / New" },
                    { id: "s-booked", name: "03 / Booked" },
                    { id: "s-pitch", name: "04 / Showed-Pitched" },
                  ],
                },
              ],
        });
      }
      if (ghlPath.startsWith("/opportunities/search")) {
        if (isIrMain && ghlPath.includes("status=all")) {
          return jsonRes({
            opportunities: [
              // Must be excluded (recruiting pipeline!)
              { id: "opp-hire", pipelineId: "p-hire", pipelineStageId: "s-app", status: "open", createdAt: "2026-11-24T04:00:00Z" },
              // Real B2B deal
              { id: "opp-sales", pipelineId: "p-sales", pipelineStageId: "s-won", status: "won", monetaryValue: 6000, createdAt: "2026-11-20T04:00:00Z", lastStatusChangeAt: "2026-11-22T04:00:00Z" },
            ],
          });
        }
        if (isHtl && ghlPath.includes("status=all")) {
          return jsonRes({
            opportunities: [
              { id: "opp-htl-1", pipelineId: "p-htl", pipelineStageId: "s-pitch", status: "open", monetaryValue: 4500, createdAt: "2026-11-21T04:00:00Z" },
            ],
          });
        }
        return jsonRes({ opportunities: [] });
      }
      if (ghlPath.startsWith("/contacts/")) {
        return jsonRes({
          contacts: isIrMain
            ? [
                { id: "c1", dateAdded: "2026-11-24T00:00:00Z" },
                { id: "c2", dateAdded: "2026-11-20T00:00:00Z" },
                { id: "c-old", dateAdded: "2026-09-01T00:00:00Z" },
              ]
            : [
                { id: "h1", dateAdded: "2026-11-21T00:00:00Z" },
                { id: "h2", dateAdded: "2026-11-18T00:00:00Z" },
                { id: "h3", dateAdded: "2026-11-15T00:00:00Z" },
              ],
        });
      }
      if (ghlPath === "/calendars/") {
        return jsonRes({
          calendars: isHtl ? [{ id: "cal-1", name: "HTL Closing Calendar" }] : [],
        });
      }
      if (ghlPath.startsWith("/calendars/events")) {
        return jsonRes({
          events: [
            { id: "e1", appointmentStatus: "showed" },
            { id: "e2", appointmentStatus: "noshow" },
          ],
        });
      }
      if (ghlPath.startsWith("/payments/transactions")) {
        return jsonRes({
          data: isIrMain
            ? [
                { id: "tx1", amount: 3000, currency: "USD", status: "succeeded", createdAt: "2026-11-22T05:00:00Z", liveMode: true },
              ]
            : [],
        });
      }
      return jsonRes({}, 404);
    });

    const summary = await readAgencySalesSummary("30d", {
      gatewayBaseUrl: "https://gw.example",
      gatewayToken: "gw-paperclip-test",
      alexBloomfieldPitKey: "",
      alexBloomfieldLocationId: "",
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => PINNED_NOW,
      bypassCache: true,
    });

    expect(summary).not.toBeNull();
    expect(summary?.liveAccountCount).toBe(2);
    expect(summary?.totalAccountCount).toBe(3);
    // 2 IR Main recent contacts + 3 HTL B2B recent contacts (old Sep contact excluded)
    expect(summary?.newLeads).toBe(5);
    // 1 IR Main B2B opp + 1 HTL B2B opp (Director of Sales Applicant excluded!)
    expect(summary?.activeOpportunities).toBe(2);
    expect(summary?.wonDeals).toBe(1);
    expect(summary?.pipelineWonUsd).toBe(6000);
    expect(summary?.cashCollectedUsd).toBe(3000);
    // 2 calendar events on HTL (1 showed, 1 noshow) + 1 won/booked on IR Main
    expect(summary?.booked).toBe(2);
    expect(summary?.showed).toBe(2);

    const alex = summary?.accounts.find((a) => a.id === "alex-bloomfield-ssa");
    expect(alex?.status).toBe("needs_config");
    expect(alex?.statusLabel).toBe("Needs PIT key / location ID");
    expect(alex?.locationId).toBeNull();
  });

  it("lights up Alex Bloomfield live via direct PIT key + location ID with zero code changes", async () => {
    const directCalls: Array<{ url: string; auth: string | undefined; version: string | undefined }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (url.startsWith("https://ghl-direct.example")) {
        directCalls.push({ url, auth: headers.authorization, version: headers.version });
        if (url.includes("/opportunities/pipelines")) {
          return jsonRes({ pipelines: [{ id: "p-ssa", name: "SSA Sales", stages: [{ id: "s1", name: "Closed Won" }] }] });
        }
        if (url.includes("/opportunities/search") && url.includes("status=all")) {
          expect(url).toContain("location_id=AlexLoc123456");
          expect(url).not.toContain("locationId=");
          return jsonRes({
            opportunities: [
              { id: "ssa-1", pipelineId: "p-ssa", pipelineStageId: "s1", status: "won", monetaryValue: 5000, createdAt: "2026-11-23T00:00:00Z", lastStatusChangeAt: "2026-11-24T00:00:00Z" },
            ],
          });
        }
        if (url.includes("/contacts/")) {
          return jsonRes({ contacts: [{ id: "c-ssa", dateAdded: "2026-11-23T00:00:00Z" }] });
        }
        if (url.includes("/calendars/")) return jsonRes({ calendars: [] });
        return jsonRes({ data: [], opportunities: [] });
      }
      return jsonRes({}, 404);
    });

    const summary = await readAgencySalesSummary("30d", {
      gatewayToken: "",
      ghlDirectOrigin: "https://ghl-direct.example",
      alexBloomfieldPitKey: "pit-test-token-value",
      alexBloomfieldLocationId: "AlexLoc123456",
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => PINNED_NOW,
      bypassCache: true,
    });

    expect(summary).not.toBeNull();
    expect(directCalls.length).toBeGreaterThan(0);
    expect(directCalls.every((c) => c.auth === "Bearer pit-test-token-value")).toBe(true);
    expect(directCalls.every((c) => c.version === "2021-07-28")).toBe(true);
    expect(summary?.liveAccountCount).toBe(1);
    expect(summary?.newLeads).toBe(1);
    expect(summary?.wonDeals).toBe(1);

    const alex = summary?.accounts.find((a) => a.id === "alex-bloomfield-ssa");
    expect(alex?.status).toBe("live");
    expect(alex?.locationId).toBe("AlexLoc123456");
    expect(alex?.wonDeals).toBe(1);
  });
});

describe("filterClientOnlyPortfolio", () => {
  it("excludes __owner__ so Fulfillment never mixes Increase ROAS agency metrics into client delivery", () => {
    const rows = [
      { slug: "__owner__", displayName: "HTL" },
      { slug: "paradise-spas", displayName: "Paradise Spas" },
      { slug: "sun-pool", displayName: "Sun Pool" },
    ] as MergedClientMetrics[];

    expect(filterClientOnlyPortfolio(rows).map((c) => c.slug)).toEqual([
      "paradise-spas",
      "sun-pool",
    ]);
  });
});
