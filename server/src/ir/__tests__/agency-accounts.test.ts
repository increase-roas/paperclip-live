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

// Agency account IDs are configuration (never code defaults); tests supply them the same way.
const AGENCY_ACCOUNT_ENV = {
  META_AGENCY_INCREASE_ROAS_ACCOUNT_ID: "act_1000000000000001",
  META_AGENCY_ALEX_BLOOMFIELD_ACCOUNT_ID: "act_200000000000002",
  META_AGENCY_HOT_TUB_LAUNCH_ACCOUNT_ID: "act_300000000000003",
  GHL_AGENCY_COMPANY_ID: "AgencyCompanyFake001",
  GHL_AGENCY_INCREASE_ROAS_LOCATION_ID: "LocIrMainFake0000001",
  GHL_AGENCY_HOT_TUB_LAUNCH_LOCATION_ID: "LocHtlB2bFake0000002",
  GHL_ALEX_BLOOMFIELD_LOCATION_ID: "LocAlexSsaFake000003",
};

function stubAgencyAccountEnv() {
  for (const [name, value] of Object.entries(AGENCY_ACCOUNT_ENV)) vi.stubEnv(name, value);
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("readAgencyMarketingSummary", () => {
  beforeEach(() => {
    resetAgencyMarketingCache();
    stubAgencyAccountEnv();
  });

  afterEach(() => {
    resetAgencyMarketingCache();
    vi.unstubAllEnvs();
  });

  it("marks an account needs-config when its ad account ID is not configured", async () => {
    vi.stubEnv("META_AGENCY_HOT_TUB_LAUNCH_ACCOUNT_ID", "");
    const fetchMock = vi.fn<typeof fetch>(async () => jsonRes({ data: [] }));
    const summary = await readAgencyMarketingSummary("30d", {
      baseUrl: "https://gw.example",
      token: "agency-config-test",
      fetchImpl: fetchMock,
      now: () => PINNED_NOW,
      bypassCache: true,
    });
    const htl = summary?.accounts.find((account) => account.id === "hot-tub-launch");
    expect(htl?.status).toBe("needs_config");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("300000000000003"))).toBe(false);
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

      if (acct === "act_200000000000002") {
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
      if (acct === "act_300000000000003") {
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
      "act_1000000000000001",
      "act_200000000000002",
      "act_300000000000003",
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

  it("handles Meta pagination, treats missing link_click in populated actions as 0, fails closed on mid-page 500, and skips caching partial transient errors", async () => {
    let callCount = 0;
    let transientFail = true;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      callCount += 1;
      const url = new URL(String(input));
      const acct = url.searchParams.get("adAccountId") ?? "";
      const after = url.searchParams.get("after");

      if (acct === "act_200000000000002") {
        if (!after) {
          return jsonRes({
            data: [
              {
                date_start: "2026-11-24",
                spend: "50.00",
                impressions: "1000",
                clicks: "99",
                // Populated actions array without link_click MUST yield 0 link clicks (not 99 all-clicks)
                actions: [{ action_type: "post_reaction", value: "99" }],
              },
            ],
            next: "cursor-2",
          });
        }
        return jsonRes({
          data: [
            {
              date_start: "2026-11-25",
              spend: "50.00",
              impressions: "1000",
              clicks: "20",
              actions: [
                { action_type: "link_click", value: "20" },
                { action_type: "lead", value: "2" },
              ],
            },
          ],
          next: null,
        });
      }
      if (acct === "act_1000000000000001") {
        // Mid-page 500 failure must fail closed to status: "error"
        if (!after) {
          return jsonRes({
            data: [{ date_start: "2026-11-24", spend: "10", impressions: "100", clicks: "5" }],
            next: "page-2",
          });
        }
        return transientFail ? jsonRes({ error: "upstream_500" }, 500) : jsonRes({ data: [], next: null });
      }
      return jsonRes({ data: [], next: null });
    });

    const first = await readAgencyMarketingSummary("30d", {
      baseUrl: "https://gw.example",
      token: "gw-meta-cache-test",
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => PINNED_NOW,
    });
    expect(first?.liveAccountCount).toBe(2);
    expect(first?.accounts.find((a) => a.id === "increase-roas-b2b")?.status).toBe("error");
    // Individual healthy account still reports exact linkClicks/CTR (0 on page 1 + 20 on page 2 = 20 / 2000 = 1%),
    // while headline totals stay null while increase-roas-b2b is in transient error!
    expect(first?.accounts.find((a) => a.id === "alex-bloomfield-ssa")?.linkClicks).toBe(20);
    expect(first?.accounts.find((a) => a.id === "alex-bloomfield-ssa")?.ctr).toBe(1);
    expect(first?.linkClicks).toBeNull();
    expect(first?.ctr).toBeNull();
    const callsAfterFirst = callCount;

    // Because one account had transient status "error", result MUST NOT have been cached
    transientFail = false;
    const second = await readAgencyMarketingSummary("30d", {
      baseUrl: "https://gw.example",
      token: "gw-meta-cache-test",
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => PINNED_NOW,
    });
    expect(callCount).toBeGreaterThan(callsAfterFirst);
    expect(second?.liveAccountCount).toBe(3);
    // 20 link clicks from alex-bloomfield-ssa + 5 fallback clicks (no actions array) from increase-roas-b2b = 25 / 2100 = 1.19%
    expect(second?.linkClicks).toBe(25);
    expect(second?.ctr).toBe(1.19);
    const callsAfterSecond = callCount;

    // Now all 3 succeeded with zero transient errors -> cached within 5m TTL
    const third = await readAgencyMarketingSummary("30d", {
      baseUrl: "https://gw.example",
      token: "gw-meta-cache-test",
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => new Date(PINNED_NOW.getTime() + 60_000),
    });
    expect(third?.liveAccountCount).toBe(3);
    expect(callCount).toBe(callsAfterSecond);

    // Backward clock or expired TTL (>5m) MUST miss cache
    await readAgencyMarketingSummary("30d", {
      baseUrl: "https://gw.example",
      token: "gw-meta-cache-test",
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => new Date(PINNED_NOW.getTime() + 6 * 60_000),
    });
    expect(callCount).toBeGreaterThan(callsAfterSecond);
  });
});

describe("readAgencySalesSummary", () => {
  beforeEach(() => {
    resetAgencySalesCache();
    stubAgencyAccountEnv();
  });

  it.each([
    { stage: "Showed No Pitch", wonUnavailable: false, offerRate: 0, closeRate: 0 },
    { stage: "Showed Pitched", wonUnavailable: false, offerRate: 100, closeRate: 0 },
    { stage: "Showed Pitched", wonUnavailable: true, offerRate: 100, closeRate: null },
    { stage: null, wonUnavailable: false, offerRate: null, closeRate: null },
  ])("preserves zero rates and unknown metrics for $stage (won unavailable: $wonUnavailable)", async ({ stage, wonUnavailable, offerRate, closeRate }) => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).searchParams.get("path") ?? "";
      if (path === "/opportunities/pipelines") {
        return jsonRes({ pipelines: [{ id: "sales", name: "Agency Sales", stages: [{ id: "stage", name: stage ?? "New" }] }] });
      }
      if (path.startsWith("/opportunities/search")) {
        if (path.includes("status=won") && wonUnavailable) return jsonRes({}, 503);
        return jsonRes({ opportunities: stage && path.includes("status=all")
          ? [{ id: "opp", pipelineId: "sales", pipelineStageId: "stage", status: "open", createdAt: "2026-11-25T00:00:00Z" }]
          : [] });
      }
      if (path.startsWith("/contacts/")) return jsonRes({ contacts: [] });
      if (path === "/calendars/") return jsonRes({ calendars: [{ id: "calendar", name: "Sales" }] });
      if (path.startsWith("/calendars/events")) return jsonRes({ events: stage ? [{ id: "appointment", appointmentStatus: "showed" }] : [] });
      if (path.startsWith("/payments/transactions")) return jsonRes({ data: [] });
      throw new Error(`Unexpected fixture path: ${path}`);
    });
    const summary = await readAgencySalesSummary("30d", {
      gatewayBaseUrl: "https://gw.example",
      gatewayToken: "agency-rate-test",
      alexBloomfieldPitKey: "",
      locationIds: { hotTubLaunchB2b: null },
      fetchImpl: fetchMock,
      now: () => PINNED_NOW,
      bypassCache: true,
    });

    expect(summary).toMatchObject({ offerRate, closeRate });
    expect(summary?.accounts.find((account) => account.id === "increase-roas-main")).toMatchObject({ offerRate, closeRate });
  });

  it("counts certified leads (once per person, applicants excluded) and showed (once per prospect)", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).searchParams.get("path") ?? "";
      if (path === "/opportunities/pipelines") return jsonRes({ pipelines: [] });
      if (path.startsWith("/opportunities/search")) return jsonRes({ opportunities: [] });
      if (path.startsWith("/contacts/")) {
        return jsonRes({
          contacts: [
            { id: "c1", dateAdded: "2026-11-20T00:00:00Z" },
            { id: "c2", dateAdded: "2026-11-21T00:00:00Z" },
            { id: "c3", dateAdded: "2026-11-22T00:00:00Z", tags: ["Job Applicant"] },
          ],
        });
      }
      if (path === "/calendars/") return jsonRes({ calendars: [{ id: "calendar", name: "Sales" }] });
      if (path.startsWith("/calendars/events")) {
        return jsonRes({
          events: [
            { id: "e1", appointmentStatus: "noshow", contactId: "c1", startTime: "2026-11-20T15:00:00Z" },
            { id: "e2", appointmentStatus: "showed", contactId: "c1", startTime: "2026-11-22T15:00:00Z" },
            { id: "e3", appointmentStatus: "showed", contactId: "c1", startTime: "2026-11-23T15:00:00Z" },
            { id: "e4", appointmentStatus: "showed", contactId: "c2", startTime: "2026-11-24T15:00:00Z" },
            { id: "e5", appointmentStatus: "cancelled", contactId: "c2", startTime: "2026-11-24T16:00:00Z" },
          ],
        });
      }
      if (path.startsWith("/payments/transactions")) return jsonRes({ data: [] });
      throw new Error(`Unexpected fixture path: ${path}`);
    });
    const summary = await readAgencySalesSummary("30d", {
      gatewayBaseUrl: "https://gw.example",
      gatewayToken: "agency-certified-test",
      alexBloomfieldPitKey: "",
      locationIds: { hotTubLaunchB2b: null },
      fetchImpl: fetchMock,
      now: () => PINNED_NOW,
      bypassCache: true,
    });
    const main = summary?.accounts.find((account) => account.id === "increase-roas-main");
    expect(main).toMatchObject({ newLeads: 2, booked: 4, showed: 2, noShows: 1, showRate: 50 });
  });

  afterEach(() => {
    resetAgencySalesCache();
    vi.unstubAllEnvs();
  });

  it("marks primary accounts needs-config when the agency company ID is not configured", async () => {
    vi.stubEnv("GHL_AGENCY_COMPANY_ID", "");
    const fetchMock = vi.fn<typeof fetch>(async () => jsonRes({}));
    const summary = await readAgencySalesSummary("30d", {
      gatewayBaseUrl: "https://gw.example",
      gatewayToken: "agency-config-test",
      alexBloomfieldPitKey: "",
      fetchImpl: fetchMock,
      now: () => PINNED_NOW,
      bypassCache: true,
    });
    const irMain = summary?.accounts.find((account) => account.id === "increase-roas-main");
    expect(irMain).toMatchObject({ status: "needs_config", statusLabel: "Needs agency company ID" });
    expect(fetchMock).not.toHaveBeenCalled();
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
      const isIrMain = url.pathname.includes("/LocIrMainFake0000001/");
      const isHtl = url.pathname.includes("/LocHtlB2bFake0000002/");

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
    expect(summary?.booked).toBe(3);
    expect(summary?.showed).toBe(2);
    expect(summary?.noShows).toBe(1);
    expect(summary?.showRate).toBe(66.7);

    const alex = summary?.accounts.find((a) => a.id === "alex-bloomfield-ssa");
    expect(alex?.status).toBe("needs_config");
    expect(alex?.statusLabel).toBe("Needs PIT key / location ID");
    expect(alex?.locationId).toBeNull();
  });

  it("defaults Alex Bloomfield locationId to LocAlexSsaFake000003 when only PIT key is set, excludes recruiting calendars, computes accurate showRate without 100% inflation, and fails closed on partial GHL errors", async () => {
    const requestedUrls: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requestedUrls.push(url);

      // 1. Increase ROAS Main: /opportunities/pipelines fails (500), /payments/transactions fails (403),
      //    /contacts/ fails (500), but calendars succeed with 10 booked / 2 showed / 0 noShows + recruiting calendar!
      if (url.includes("/LocIrMainFake0000001/")) {
        const ghlPath = new URL(url).searchParams.get("path") ?? "";
        if (ghlPath === "/opportunities/pipelines") return jsonRes({ error: "boom" }, 500);
        if (ghlPath.startsWith("/opportunities/search")) {
          // Recruiting opp MUST NOT leak when pipelines failed!
          return jsonRes({
            opportunities: [
              { id: "rec-1", pipelineId: "p-hire", status: "won", monetaryValue: 99999, createdAt: "2026-11-24T00:00:00Z" },
            ],
          });
        }
        if (ghlPath.startsWith("/contacts/")) return jsonRes({ error: "contacts_500" }, 500);
        if (ghlPath === "/calendars/") {
          return jsonRes({
            calendars: [
              { id: "cal-sales", name: "B2B Strategy Call" },
              { id: "cal-hire", name: "Director of Sales Interview Calendar" },
              { id: "cal-careers", name: "Careers Screening" },
            ],
          });
        }
        if (ghlPath.includes("calendarId=cal-sales")) {
          return jsonRes({
            events: [
              { id: "e1", appointmentStatus: "showed" },
              { id: "e2", appointmentStatus: "showed" },
              ...Array.from({ length: 8 }, (_, i) => ({ id: `b-${i}`, appointmentStatus: "confirmed" })),
            ],
          });
        }
        if (ghlPath.includes("calendarId=cal-hire") || ghlPath.includes("calendarId=cal-careers")) {
          throw new Error("recruiting calendars must never be queried");
        }
        if (ghlPath.startsWith("/payments/transactions")) return jsonRes({ error: "forbidden" }, 403);
        return jsonRes({}, 404);
      }

      // 2. Hot Tub Launch B2B: returns 401 auth failure -> needs_config
      if (url.includes("/LocHtlB2bFake0000002/")) {
        return jsonRes({ error: "unauthorized" }, 401);
      }

      // 3. Alex Bloomfield direct PIT: defaults to LocAlexSsaFake000003, subtracts amountRefunded,
      //    ignores string liveMode:"false", and deduplicates contacts across cursor pages.
      if (url.startsWith("https://ghl-direct.example")) {
        expect(url).toContain("LocAlexSsaFake000003");
        if (url.includes("/opportunities/pipelines")) {
          return jsonRes({
            pipelines: [
              {
                id: "p-ssa",
                name: "SSA Sales",
                stages: [
                  { id: "st-book", name: "Call Booked" },
                  { id: "st-ns", name: "No Show" },
                  { id: "st-won", name: "Closed Won" },
                ],
              },
            ],
          });
        }
        if (url.includes("/opportunities/search") && url.includes("status=all")) {
          return jsonRes({
            opportunities: [
              { id: "o1", pipelineId: "p-ssa", pipelineStageId: "st-book", status: "open", createdAt: "2026-11-24T00:00:00Z" },
              { id: "o2", pipelineId: "p-ssa", pipelineStageId: "st-ns", status: "open", createdAt: "2026-11-24T00:00:00Z" },
              { id: "o3", pipelineId: "p-ssa", pipelineStageId: "st-won", status: "won", monetaryValue: 5000, createdAt: "2026-11-24T00:00:00Z", lastStatusChangeAt: "2026-11-25T00:00:00Z" },
            ],
          });
        }
        if (url.includes("/opportunities/search") && url.includes("status=won")) {
          return jsonRes({
            opportunities: [
              { id: "o3", pipelineId: "p-ssa", pipelineStageId: "st-won", status: "won", monetaryValue: 5000, createdAt: "2026-11-24T00:00:00Z", lastStatusChangeAt: "2026-11-25T00:00:00Z" },
            ],
          });
        }
        if (url.includes("/opportunities/search") && url.includes("status=lost")) {
          return jsonRes({ opportunities: [] });
        }
        if (url.includes("/contacts/")) {
          if (!url.includes("startAfterId=c100")) {
            return jsonRes({
              contacts: Array.from({ length: 100 }, (_, i) => ({
                id: `c${i + 1}`,
                dateAdded: "2026-11-24T00:00:00Z",
              })),
              meta: { startAfterId: "c100", startAfter: 1763942400000 },
            });
          }
          // Overlapping c100 MUST be deduplicated; only c101 adds +1 -> total 101
          return jsonRes({
            contacts: [
              { id: "c100", dateAdded: "2026-11-24T00:00:00Z" },
              { id: "c101", dateAdded: "2026-11-24T00:00:00Z" },
            ],
          });
        }
        if (url.includes("/calendars/")) return jsonRes({ calendars: [] });
        if (url.includes("/payments/transactions")) {
          return jsonRes({
            data: [
              { id: "t1", amount: 5000, amountRefunded: 1000, currency: "USD", status: "succeeded", createdAt: "2026-11-25T00:00:00Z", liveMode: true },
              { id: "t2", amount: 9000, currency: "USD", status: "succeeded", createdAt: "2026-11-25T00:00:00Z", liveMode: "false" },
            ],
          });
        }
      }
      return jsonRes({}, 404);
    });

    const summary = await readAgencySalesSummary("30d", {
      gatewayBaseUrl: "https://gw.example",
      gatewayToken: "gw-test",
      ghlDirectOrigin: "https://ghl-direct.example",
      alexBloomfieldPitKey: "pit-default-loc-test",
      // alexBloomfieldLocationId intentionally omitted -> must default to LocAlexSsaFake000003
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => PINNED_NOW,
      bypassCache: true,
    });

    const irMain = summary?.accounts.find((a) => a.id === "increase-roas-main");
    // Fail-closed: pipelines failed so opportunities & won deals MUST be null (recruiting $99,999 NOT leaked!)
    expect(irMain?.status).toBe("live");
    expect(irMain?.activeOpportunities).toBeNull();
    expect(irMain?.wonDeals).toBeNull();
    expect(irMain?.pipelineWonUsd).toBeNull();
    // Contacts 500 & transactions 403 MUST be null (NOT fabricated 0)
    expect(irMain?.newLeads).toBeNull();
    expect(irMain?.cashCollectedUsd).toBeNull();
    // 10 booked, 2 showed, 0 noShows -> 20% show rate (NEVER 100%!)
    expect(irMain?.booked).toBe(10);
    expect(irMain?.showed).toBe(2);
    expect(irMain?.showRate).toBe(20);

    const alex = summary?.accounts.find((a) => a.id === "alex-bloomfield-ssa");
    expect(alex?.status).toBe("live");
    expect(alex?.locationId).toBe("LocAlexSsaFake000003");
    expect(alex?.newLeads).toBe(101);
    // $5000 - $1000 refund = $4000 (string liveMode:"false" ignored)
    expect(alex?.cashCollectedUsd).toBe(4000);
    // Stage fallback invariant: booked (3) >= showed (1) + noShows (1) -> 1/3 = 33.3%
    expect(alex?.booked).toBe(3);
    expect(alex?.showed).toBe(1);
    expect(alex?.noShows).toBe(1);
    expect(alex?.showRate).toBe(33.3);

    // Strict headline completeness: metrics missing on IR Main MUST stay null at headline
    // (never presenting Alex's partial numbers as the agency total or mixing subsets in rates),
    // while booked/showed/noShows/showRate are complete across BOTH live accounts using ONE
    // consistent showed / booked formula: 3 / 13 = 23.1% (never inflated to 75% by 3 / (3 + 1))!
    expect(summary?.newLeads).toBeNull();
    expect(summary?.activeOpportunities).toBeNull();
    expect(summary?.wonDeals).toBeNull();
    expect(summary?.cashCollectedUsd).toBeNull();
    expect(summary?.setRate).toBeNull();
    expect(summary?.leadToCustomerRate).toBeNull();
    expect(summary?.booked).toBe(13);
    expect(summary?.showed).toBe(3);
    expect(summary?.noShows).toBe(1);
    expect(summary?.showRate).toBe(23.1);

    expect(requestedUrls.some((u) => u.includes("cal-hire") || u.includes("cal-careers"))).toBe(false);
  });

  it("isolates cache keys by agencyCompanyId/ghlDirectOrigin, rejects direct PIT 403 as needs_config, and skips caching when any account has transient error", async () => {
    let calls = 0;
    let irMain500 = true;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      calls += 1;
      const url = String(input);
      if (url.startsWith("https://direct-a.example") || url.startsWith("https://direct-b.example")) {
        return jsonRes({ error: "forbidden" }, 403);
      }
      if (url.includes("/LocIrMainFake0000001/") && irMain500) {
        return jsonRes({ error: "gateway_502" }, 502);
      }
      const ghlPath = new URL(url).searchParams.get("path") ?? "";
      if (ghlPath === "/opportunities/pipelines") return jsonRes({ pipelines: [] });
      if (ghlPath.startsWith("/opportunities/search")) return jsonRes({ opportunities: [] });
      if (ghlPath.startsWith("/contacts/")) return jsonRes({ contacts: [] });
      if (ghlPath === "/calendars/") return jsonRes({ calendars: [] });
      if (ghlPath.startsWith("/payments/transactions")) return jsonRes({ data: [] });
      return jsonRes({}, 404);
    });

    const first = await readAgencySalesSummary("30d", {
      gatewayBaseUrl: "https://gw.example",
      gatewayToken: "gw-cache-test",
      agencyCompanyId: "company-A",
      ghlDirectOrigin: "https://direct-a.example",
      alexBloomfieldPitKey: "pit-bad-token",
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => PINNED_NOW,
    });
    expect(first?.accounts.find((a) => a.id === "increase-roas-main")?.status).toBe("error");
    expect(first?.accounts.find((a) => a.id === "alex-bloomfield-ssa")?.status).toBe("needs_config");
    const afterFirst = calls;

    // Transient error on IR Main must NOT be cached
    irMain500 = false;
    await readAgencySalesSummary("30d", {
      gatewayBaseUrl: "https://gw.example",
      gatewayToken: "gw-cache-test",
      agencyCompanyId: "company-A",
      ghlDirectOrigin: "https://direct-a.example",
      alexBloomfieldPitKey: "pit-bad-token",
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => PINNED_NOW,
    });
    expect(calls).toBeGreaterThan(afterFirst);
    const afterSecond = calls;

    // Steady-state needs_config (no "error") IS cached for identical companyId + origin
    await readAgencySalesSummary("30d", {
      gatewayBaseUrl: "https://gw.example",
      gatewayToken: "gw-cache-test",
      agencyCompanyId: "company-A",
      ghlDirectOrigin: "https://direct-a.example",
      alexBloomfieldPitKey: "pit-bad-token",
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => new Date(PINNED_NOW.getTime() + 30_000),
    });
    expect(calls).toBe(afterSecond);

    // Changing agencyCompanyId MUST miss cache
    await readAgencySalesSummary("30d", {
      gatewayBaseUrl: "https://gw.example",
      gatewayToken: "gw-cache-test",
      agencyCompanyId: "company-B",
      ghlDirectOrigin: "https://direct-a.example",
      alexBloomfieldPitKey: "pit-bad-token",
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => new Date(PINNED_NOW.getTime() + 30_000),
    });
    expect(calls).toBeGreaterThan(afterSecond);
    const afterThird = calls;

    // Changing ghlDirectOrigin MUST miss cache
    await readAgencySalesSummary("30d", {
      gatewayBaseUrl: "https://gw.example",
      gatewayToken: "gw-cache-test",
      agencyCompanyId: "company-B",
      ghlDirectOrigin: "https://direct-b.example",
      alexBloomfieldPitKey: "pit-bad-token",
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => new Date(PINNED_NOW.getTime() + 30_000),
    });
    expect(calls).toBeGreaterThan(afterThird);
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
  it("paginates multi-page opportunities and unordered contacts, fails closed on partial calendar failure, and marks truncated accounts as 'Live (partial)'", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/LocIrMainFake0000001/")) {
        const ghlPath = new URL(url).searchParams.get("path") ?? "";
        if (ghlPath === "/opportunities/pipelines") {
          return jsonRes({
            pipelines: [{ id: "p-sales", name: "B2B Sales", stages: [{ id: "s-won", name: "Closed Won" }] }],
          });
        }
        if (ghlPath.startsWith("/opportunities/search")) {
          const parsed = new URL(ghlPath, "https://ghl.local");
          const st = parsed.searchParams.get("status");
          const cursor = parsed.searchParams.get("startAfterId");
          if (st === "all" || st === "won") {
            if (!cursor) {
              return jsonRes({
                opportunities: Array.from({ length: 100 }, (_, i) => ({
                  id: `opp-p1-${i}`,
                  pipelineId: "p-sales",
                  pipelineStageId: "s-won",
                  status: i === 0 ? "won" : "open",
                  monetaryValue: i === 0 ? 4000 : 0,
                  createdAt: "2026-11-24T00:00:00Z",
                  lastStatusChangeAt: "2026-11-24T00:00:00Z",
                })),
                meta: { startAfterId: "opp-p1-99", startAfter: 1763942400000 },
              });
            }
            // Page 2 has a second won deal!
            return jsonRes({
              opportunities: [
                {
                  id: "opp-p2-won",
                  pipelineId: "p-sales",
                  pipelineStageId: "s-won",
                  status: "won",
                  monetaryValue: 6000,
                  createdAt: "2026-11-25T00:00:00Z",
                  lastStatusChangeAt: "2026-11-25T00:00:00Z",
                },
              ],
            });
          }
          return jsonRes({ opportunities: [] });
        }
        if (ghlPath.startsWith("/contacts/")) {
          // Page 1 has an OLD contact (must NOT prematurely stop pagination!) + page 2 has a recent contact
          if (!ghlPath.includes("startAfterId=old-99")) {
            return jsonRes({
              contacts: Array.from({ length: 100 }, (_, i) => ({
                id: `old-${i}`,
                dateAdded: "2025-01-01T00:00:00Z",
              })),
              meta: { startAfterId: "old-99", startAfter: 1735689600000 },
            });
          }
          return jsonRes({
            contacts: [{ id: "recent-page2", dateAdded: "2026-11-25T00:00:00Z" }],
          });
        }
        if (ghlPath === "/calendars/") {
          return jsonRes({
            calendars: [
              { id: "cal-ok", name: "Sales Cal 1" },
              { id: "cal-fail", name: "Sales Cal 2" },
            ],
          });
        }
        if (ghlPath.includes("calendarId=cal-ok")) {
          return jsonRes({ events: [{ id: "e1", appointmentStatus: "showed" }] });
        }
        if (ghlPath.includes("calendarId=cal-fail")) {
          return jsonRes({ error: "calendar_500" }, 500);
        }
        if (ghlPath.startsWith("/payments/transactions")) return jsonRes({ data: [] });
      }
      if (url.includes("/LocHtlB2bFake0000002/")) {
        const ghlPath = new URL(url).searchParams.get("path") ?? "";
        if (ghlPath === "/opportunities/pipelines") return jsonRes({ pipelines: [] });
        if (ghlPath.startsWith("/opportunities/search")) return jsonRes({ opportunities: [] });
        if (ghlPath === "/calendars/") return jsonRes({ calendars: [] });
        if (ghlPath.startsWith("/payments/transactions")) return jsonRes({ data: [] });
        if (ghlPath.startsWith("/contacts/")) {
          // Always return 100 contacts with a fresh cursor -> hits MAX_CONTACT_PAGES cap!
          const parsed = new URL(ghlPath, "https://ghl.local");
          const prev = Number(parsed.searchParams.get("startAfterId") ?? "0");
          const next = prev + 100;
          return jsonRes({
            contacts: Array.from({ length: 100 }, (_, i) => ({
              id: `htl-${prev + i}`,
              dateAdded: "2026-11-24T00:00:00Z",
            })),
            meta: { startAfterId: String(next), startAfter: 1763942400000 },
          });
        }
      }
      return jsonRes({}, 404);
    });

    const summary = await readAgencySalesSummary("30d", {
      gatewayBaseUrl: "https://gw.example",
      gatewayToken: "gw-pagination-test",
      alexBloomfieldPitKey: "",
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => PINNED_NOW,
      bypassCache: true,
    });

    const irMain = summary?.accounts.find((a) => a.id === "increase-roas-main");
    // Multi-page opportunities captured BOTH won deals ($4,000 + $6,000 = $10,000) across 101 opps!
    expect(irMain?.activeOpportunities).toBe(101);
    expect(irMain?.wonDeals).toBe(2);
    expect(irMain?.pipelineWonUsd).toBe(10000);
    // Unordered contacts page 2 was NOT stopped early by page 1's old timestamps!
    expect(irMain?.newLeads).toBe(1);
    // Partial calendar failure (cal-fail 500) failed closed on calendar & marked account Live (partial)
    expect(irMain?.statusLabel).toBe("Live (partial)");

    const htl = summary?.accounts.find((a) => a.id === "hot-tub-launch-b2b");
    // Hitting 10-page contact cap (1,000 contacts) marks account "Live (partial)" instead of "Live"
    expect(htl?.newLeads).toBe(1000);
    expect(htl?.statusLabel).toBe("Live (partial)");
  });

  it("paginates /payments/transactions via offset with deduplication and marks full 10-page transaction cap as 'Live (partial)'", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const ghlPath = new URL(url).searchParams.get("path") ?? "";
      if (ghlPath === "/opportunities/pipelines") return jsonRes({ pipelines: [] });
      if (ghlPath.startsWith("/opportunities/search")) return jsonRes({ opportunities: [] });
      if (ghlPath.startsWith("/contacts/")) return jsonRes({ contacts: [] });
      if (ghlPath === "/calendars/") return jsonRes({ calendars: [] });

      if (url.includes("/LocIrMainFake0000001/") && ghlPath.startsWith("/payments/transactions")) {
        const parsed = new URL(ghlPath, "https://ghl.local");
        const offset = Number(parsed.searchParams.get("offset") ?? "0");
        if (offset === 0) {
          // 50 live USD payments of $100 each ($5,000)
          return jsonRes({
            totalCount: 52,
            data: Array.from({ length: 50 }, (_, i) => ({
              id: `tx-${i + 1}`,
              amount: 100,
              currency: "USD",
              status: "succeeded",
              createdAt: "2026-11-24T00:00:00Z",
              liveMode: true,
            })),
          });
        }
        // Page 2: duplicate tx-50 (must be deduped!) + 2 new payments ($250 + $150 = $400) -> total $5,400
        return jsonRes({
          totalCount: 52,
          data: [
            { id: "tx-50", amount: 100, currency: "USD", status: "succeeded", createdAt: "2026-11-24T00:00:00Z", liveMode: true },
            { id: "tx-51", amount: 250, currency: "USD", status: "succeeded", createdAt: "2026-11-25T00:00:00Z", liveMode: true },
            { id: "tx-52", amount: 150, currency: "USD", status: "succeeded", createdAt: "2026-11-25T00:00:00Z", liveMode: true },
          ],
        });
      }

      if (url.includes("/LocHtlB2bFake0000002/") && ghlPath.startsWith("/payments/transactions")) {
        const parsed = new URL(ghlPath, "https://ghl.local");
        const offset = Number(parsed.searchParams.get("offset") ?? "0");
        // Always returns 50 rows with totalCount=600 -> hits 10-page cap (500 rows) -> truncated!
        return jsonRes({
          totalCount: 600,
          data: Array.from({ length: 50 }, (_, i) => ({
            id: `htl-tx-${offset + i}`,
            amount: 10,
            currency: "USD",
            status: "succeeded",
            createdAt: "2026-11-24T00:00:00Z",
            liveMode: true,
          })),
        });
      }
      return jsonRes({}, 404);
    });

    const summary = await readAgencySalesSummary("30d", {
      gatewayBaseUrl: "https://gw.example",
      gatewayToken: "gw-tx-pagination-test",
      alexBloomfieldPitKey: "",
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => PINNED_NOW,
      bypassCache: true,
    });

    const irMain = summary?.accounts.find((a) => a.id === "increase-roas-main");
    expect(irMain?.cashCollectedUsd).toBe(5400);
    expect(irMain?.statusLabel).toBe("Live");

    const htl = summary?.accounts.find((a) => a.id === "hot-tub-launch-b2b");
    expect(htl?.cashCollectedUsd).toBe(5000);
    expect(htl?.statusLabel).toBe("Live (partial)");

    // HTL hit the 10-page transaction cap -> account row shows 5000 + "Live (partial)",
    // while headline cashCollectedUsd stays null so truncated totals never masquerade as full!
    expect(summary?.cashCollectedUsd).toBeNull();
  });
});

describe("filterClientOnlyPortfolio", () => {
  it("excludes __owner__ so Fulfillment never mixes Increase ROAS agency metrics into client delivery", () => {
    const rows = [
      { slug: "__owner__", displayName: "HTL" },
      { slug: "client-a", displayName: "Client A" },
      { slug: "client-b", displayName: "Client B" },
    ] as MergedClientMetrics[];

    expect(filterClientOnlyPortfolio(rows).map((c) => c.slug)).toEqual([
      "client-a",
      "client-b",
    ]);
  });
});
