import { describe, expect, it } from "vitest";
import {
  agencyRoas,
  clientRoas,
  clientLifecycleStatus,
  clientStatusCounts,
  closeRate,
  costPerAcquisition,
  costPerLead,
  ctrPercent,
  IR_METRIC_DEFINITIONS,
  isOwnBrandCode,
  leadToCustomerRate,
  MetricScopeError,
  mrr,
  offerRate,
  OWN_BRANDS,
  resolveCalculationPointer,
  setRate,
  showRate,
  type AgencyAccountScope,
} from "./ir-metrics.js";

// Worked examples and checked answers from the GBrain definitions certified by
// Alex on 2026-11-26 (brain definitions/*.md). These numbers must not drift.
describe("certified worked examples", () => {
  it("show rate: 20 past-dated booked, 6 showed, 6 upcoming = 30.0%", () => {
    expect(showRate({ pastDatedBooked: 20, showed: 6 })).toBe(30);
  });

  it("close rate: 6 showed, 4 offers, 2 sales = 33.3%; offer rate = 66.7%", () => {
    expect(closeRate({ wonDeals: 2, showed: 6 })).toBe(33.3);
    expect(offerRate({ showed: 6, pitched: 4 })).toBe(66.7);
  });

  it("agency ROAS: $6,000 first-30-day cash on $1,200 agency spend = 5.0x (day-45 cash excluded)", () => {
    expect(agencyRoas({ scope: "agency_marketing", first30DayCashUsd: 6000, agencyAdSpendUsd: 1200 })).toBe(5);
  });

  it("client ROAS: ($7,500 CRM won + $1,500 logged client-reported) / $2,000 = 4.5x", () => {
    expect(clientRoas({ scope: "client_fulfillment", crmWonRevenueUsd: 7500 + 1500, adSpendUsd: 2000 })).toBe(4.5);
  });

  it("MRR: $1,500 + $2,000 + $4,500 paid in full over 3 months = $5,000 (paused and setup excluded)", () => {
    expect(
      mrr([
        { status: "active", monthlyFeeUsd: 1500 },
        { status: "active", monthlyFeeUsd: 2000 },
        { status: "active", paidInFull: { totalUsd: 4500, termMonths: 3 } },
        { status: "paused", monthlyFeeUsd: 750 },
      ]),
    ).toBe(5000);
  });

  it("client status failed-payment rule: days 1-14 active (past due), 15 paused, 30 cancelled", () => {
    expect(clientLifecycleStatus("active", 3)).toBe("active");
    expect(clientLifecycleStatus("active", 15)).toBe("paused");
    expect(clientLifecycleStatus("active", 30)).toBe("cancelled");
    expect(clientStatusCounts([{ status: "active", failedPaymentDays: 3 }, { status: "active" }])).toMatchObject({
      active: 2,
      pastDue: 1,
    });
  });
});

describe("ir-metrics rates", () => {
  it("returns null instead of a confident zero when the denominator is missing or zero", () => {
    expect(showRate({ pastDatedBooked: 0, showed: 0 })).toBeNull();
    expect(showRate({ pastDatedBooked: 10, showed: null })).toBeNull();
    expect(closeRate({ wonDeals: 3, showed: 0 })).toBeNull();
    expect(closeRate({ wonDeals: null, showed: 4 })).toBeNull();
  });

  it("keeps a real zero as zero", () => {
    expect(showRate({ pastDatedBooked: 10, showed: 0 })).toBe(0);
    expect(offerRate({ showed: 4, pitched: 0 })).toBe(0);
  });

  it("does not cap rates, so a data problem stays visible", () => {
    expect(closeRate({ wonDeals: 3, showed: 2 })).toBe(150);
    expect(setRate({ newLeads: 10, booked: 12 })).toBe(120);
    expect(leadToCustomerRate({ newLeads: 200, wonDeals: 3 })).toBe(1.5);
  });

  it("computes cost and click metrics with two decimals", () => {
    expect(costPerLead({ spend: 1000, leads: 3 })).toBe(333.33);
    expect(costPerLead({ spend: 1000, leads: 0 })).toBeNull();
    expect(ctrPercent({ clicks: 136, impressions: 3785 })).toBe(3.59);
    expect(costPerAcquisition({ spend: 4500, acquisitions: 2 })).toBe(2250);
  });

  it("refuses client inputs for agency ROAS and agency inputs for client ROAS", () => {
    expect(() =>
      agencyRoas({ scope: "client_fulfillment" as unknown as AgencyAccountScope, first30DayCashUsd: 1, agencyAdSpendUsd: 1 }),
    ).toThrow(MetricScopeError);
    expect(() =>
      clientRoas({ scope: "agency_sales" as unknown as "client_fulfillment", crmWonRevenueUsd: 1, adSpendUsd: 1 }),
    ).toThrow(MetricScopeError);
  });

  it("counts lifecycle from raw statuses", () => {
    expect(
      clientStatusCounts([{ status: "active" }, { status: "Live" }, { status: "paused" }, { status: "canceled" }, { status: "prospect" }]),
    ).toEqual({ active: 2, pastDue: 0, paused: 1, cancelled: 1, other: 1, total: 5 });
    expect(mrr([{ status: "paused", monthlyFeeUsd: 100 }])).toBeNull();
  });
});

describe("ir-metrics registry", () => {
  it("locks the six own brands and keeps Revstead out", () => {
    expect(OWN_BRANDS.map((brand) => brand.code)).toEqual(["IR", "HTL", "SSA", "PSL", "NS", "DYNAMITE"]);
    expect(isOwnBrandCode("HTL")).toBe(true);
    expect(isOwnBrandCode("REVSTEAD")).toBe(false);
  });

  it("resolves GBrain calculation pointers to library functions", () => {
    expect(resolveCalculationPointer("ir-metrics#showRate")).toMatchObject({ kind: "metric", definition: { name: "showRate" } });
    expect(resolveCalculationPointer("none")).toEqual({ kind: "none" });
    expect(resolveCalculationPointer(undefined)).toEqual({ kind: "none" });
    expect(resolveCalculationPointer("ir-metrics#roasMagic")).toEqual({ kind: "missing", pointer: "ir-metrics#roasMagic" });
    expect(resolveCalculationPointer("ir-metrics#constructor")).toMatchObject({ kind: "missing" });
  });

  it("names every function it defines", () => {
    for (const [name, definition] of Object.entries(IR_METRIC_DEFINITIONS)) {
      expect(definition.name).toBe(name);
      expect(definition.definitionSlug).toMatch(/^definitions\//);
    }
  });
});
