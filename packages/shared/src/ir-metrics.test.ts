import { describe, expect, it } from "vitest";
import {
  agencyRoas,
  clientRoas,
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

describe("ir-metrics rates", () => {
  it("computes show rate as held ÷ booked, capped at 100, and null without data", () => {
    expect(showRate({ booked: 40, showed: 29 })).toBe(72.5);
    expect(showRate({ booked: 3, showed: 5 })).toBe(100);
    expect(showRate({ booked: 0, showed: 0 })).toBeNull();
    expect(showRate({ booked: 10, showed: null })).toBeNull();
  });

  it("keeps a real zero as zero", () => {
    expect(showRate({ booked: 10, showed: 0 })).toBe(0);
    expect(offerRate({ showed: 4, pitched: 0 })).toBe(0);
  });

  it("uses won + lost first, then offers, then appointments held for close rate", () => {
    expect(closeRate({ wonDeals: 3, lostDeals: 1, pitched: 10, showed: 20 })).toBe(75);
    expect(closeRate({ wonDeals: 3, lostDeals: null, pitched: 10, showed: 20 })).toBe(30);
    expect(closeRate({ wonDeals: 3, pitched: 0, showed: 20 })).toBe(15);
    expect(closeRate({ wonDeals: 3 })).toBeNull();
    expect(closeRate({ wonDeals: null, lostDeals: 2 })).toBeNull();
  });

  it("does not cap funnel conversion rates", () => {
    expect(setRate({ newLeads: 10, booked: 12 })).toBe(120);
    expect(leadToCustomerRate({ newLeads: 200, wonDeals: 3 })).toBe(1.5);
  });

  it("computes cost and click metrics with two decimals", () => {
    expect(costPerLead({ spend: 1000, leads: 3 })).toBe(333.33);
    expect(costPerLead({ spend: 1000, leads: 0 })).toBeNull();
    expect(ctrPercent({ clicks: 136, impressions: 3785 })).toBe(3.59);
    expect(costPerAcquisition({ spend: 4500, acquisitions: 2 })).toBe(2250);
  });
});

describe("ir-metrics agency vs client boundary", () => {
  it("computes ROAS only for the matching scope", () => {
    expect(agencyRoas({ scope: "agency_marketing", revenueUsd: 12000, adSpendUsd: 3000 })).toBe(4);
    expect(clientRoas({ scope: "client_fulfillment", revenueUsd: 5000, adSpendUsd: 2000 })).toBe(2.5);
  });

  it("refuses client inputs for agency ROAS and agency inputs for client ROAS", () => {
    expect(() =>
      agencyRoas({ scope: "client_fulfillment" as unknown as AgencyAccountScope, revenueUsd: 1, adSpendUsd: 1 }),
    ).toThrow(MetricScopeError);
    expect(() =>
      clientRoas({ scope: "agency_sales" as unknown as "client_fulfillment", revenueUsd: 1, adSpendUsd: 1 }),
    ).toThrow(MetricScopeError);
  });
});

describe("ir-metrics client portfolio", () => {
  const clients = [
    { status: "active", monthlyRetainerUsd: 2500 },
    { status: "Live", monthlyRetainerUsd: 1500 },
    { status: "paused", monthlyRetainerUsd: 999 },
    { status: "canceled", monthlyRetainerUsd: 3000 },
    { status: "prospect", monthlyRetainerUsd: null },
  ];

  it("counts active, paused and cancelled clients from live records", () => {
    expect(clientStatusCounts(clients)).toEqual({ active: 2, paused: 1, cancelled: 1, other: 1, total: 5 });
    expect(clientStatusCounts([])).toEqual({ active: 0, paused: 0, cancelled: 0, other: 0, total: 0 });
  });

  it("sums MRR from active clients only, and is null when none is known", () => {
    expect(mrr(clients)).toBe(4000);
    expect(mrr([{ status: "paused", monthlyRetainerUsd: 100 }])).toBeNull();
  });
});

describe("ir-metrics registry", () => {
  it("locks the six own brands and keeps Revstead out", () => {
    expect(OWN_BRANDS.map((brand) => brand.code)).toEqual(["IR", "HTL", "SSA", "PSL", "NS", "DL"]);
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
