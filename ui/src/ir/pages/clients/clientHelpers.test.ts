import { describe, expect, it } from "vitest";
import {
  buildTenantRequestBody,
  formatClientReportUrl,
  getTenantConnectionBadges,
  matchGbrainClient,
  normalizeMetaAccountId,
  partitionClientPortfolio,
  summarizeStoredHealth,
} from "./clientHelpers";

describe("clientHelpers", () => {
  it("marks GA4 as not_applicable rather than missing when websiteTracking is not_applicable", () => {
    const badges = getTenantConnectionBadges({
      slug: "sun-pool",
      displayName: "Sun Pool",
      ghlLocationId: "loc-sunpool",
      metaAdAccountId: "act_12345",
      websiteTracking: "not_applicable",
    });
    expect(badges).toEqual({
      ghl: "connected",
      meta: "connected",
      ga4: "not_applicable",
    });
  });

  it("marks Meta Ads as not_applicable when metaTracking is not_applicable", () => {
    const badges = getTenantConnectionBadges({
      slug: "organic-only",
      displayName: "Organic Only",
      ghlLocationId: "loc-1",
      metaTracking: "not_applicable",
    });
    expect(badges).toEqual({
      ghl: "connected",
      meta: "not_applicable",
      ga4: "missing",
    });
  });

  it("surfaces Capacity needs-action errors from stored health snapshots", () => {
    const summary = summarizeStoredHealth({
      slug: "sun-pool",
      displayName: "Sun Pool",
      status: "DEGRADED",
      views: {
        "30d": {
          freshness: "FRESH",
          syncStatus: "success",
          lastSuccessfulSyncAt: "2026-11-25T12:00:00Z",
          lastAttemptedAt: "2026-11-25T12:00:00Z",
          sources: {
            ghl: { status: "LIVE", lastSuccessfulSyncAt: "2026-11-25T12:00:00Z" },
            capacity: {
              status: "NEEDS ACTION",
              lastSuccessfulSyncAt: null,
              reason: "calendar_not_found",
            },
          },
        },
      },
    });
    expect(summary.status).toBe("needs_action");
    expect(summary.issues).toHaveLength(1);
    expect(summary.issues[0]).toMatchObject({
      source: "capacity",
      label: "Capacity",
      reason: "calendar_not_found",
    });
  });

  it("builds customer-facing /c/<slug> report URLs and normalizes Meta IDs", () => {
    expect(formatClientReportUrl("paradise-spas")).toBe(
      "https://dashboard.increaseai.tech/c/paradise-spas",
    );
    expect(normalizeMetaAccountId("4013508225402510")).toBe("act_4013508225402510");
    expect(normalizeMetaAccountId("act_4013508225402510")).toBe("act_4013508225402510");

    const payload = buildTenantRequestBody({
      slug: "paradise-spas",
      displayName: "Paradise Spas",
      ghlLocationId: "loc-1",
      metaAdAccountId: "123456",
      websiteTracking: "not_applicable",
      ga4PropertyId: "999",
    });
    expect(payload.metaAdAccountId).toBe("act_123456");
    expect(payload.ga4PropertyId).toBe("");
    expect(payload.websiteTracking).toBe("not_applicable");
  });
});

describe("partitionClientPortfolio", () => {
  const gbrain = [
    { slug: "companies/revstead-systems", title: "Revstead Systems", aliases: ["Revstead"], brands: ["SSA"], lifecycle: "active" },
    { slug: "companies/lakeside-spas", title: "Lakeside Spas", aliases: [], brands: ["HTL"], lifecycle: "paused" },
    { slug: "companies/odd", title: "Odd Co", aliases: [], brands: ["REVSTEAD"], lifecycle: null },
  ];

  it("splits live tenants by own brand and lifecycle from GBrain pages", () => {
    const result = partitionClientPortfolio(
      [
        { slug: "revstead", displayName: "Revstead" },
        { slug: "lakeside-spas", displayName: "Lakeside Spas" },
        { slug: "odd-co", displayName: "Odd Co" },
        { slug: "sun-pool", displayName: "Sun Pool" },
      ],
      gbrain,
    );
    expect(result.byBrand.find((row) => row.code === "SSA")?.count).toBe(1);
    expect(result.byBrand.find((row) => row.code === "HTL")?.count).toBe(1);
    expect(result.byBrand.map((row) => row.code)).toEqual(["IR", "HTL", "SSA", "PSL", "NS", "DL"]);
    expect(result.unclassified).toBe(2);
    expect(result.lifecycle).toEqual({ active: 1, paused: 1, cancelled: 0, other: 2, total: 4 });
  });

  it("matches tenants by slug, title or alias", () => {
    expect(matchGbrainClient({ slug: "x", displayName: "Revstead" }, gbrain)?.slug).toBe("companies/revstead-systems");
    expect(matchGbrainClient({ slug: "revstead-systems", displayName: "?" }, gbrain)?.slug).toBe("companies/revstead-systems");
    expect(matchGbrainClient({ slug: "nope", displayName: "Nope" }, gbrain)).toBeNull();
  });
});
