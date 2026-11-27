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
  approvalState,
  bookedCounts,
  classifyPriority,
  clientCrmWonRevenue,
  clientHealth,
  committedPlanValue,
  countLeads,
  countSales,
  countShowed,
  CUSTOMER_FACING_PACKAGE_TERMS,
  first30DayCash,
  IR_CERTIFIED_DEFINITION_FORMULAS,
  IR_PRIORITY_TO_ISSUE_PRIORITY,
  isDone,
  renewalCounts,
  resolveDefinitionFormula,
  revenue,
  type AgencyAccountScope,
  type CashPayment,
} from "./ir-metrics.js";
import { ISSUE_PRIORITIES } from "./constants.js";

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
    expect(clientLifecycleStatus("cancelled", 3)).toBe("cancelled");
    expect(clientLifecycleStatus("paused", 3)).toBe("paused");
    expect(clientLifecycleStatus("paused", 20)).toBe("paused");
    expect(clientLifecycleStatus("paused", 30)).toBe("cancelled");
    expect(clientLifecycleStatus("cancelled", 20)).toBe("cancelled");
    expect(clientStatusCounts([{ status: "active", failedPaymentDays: 3 }, { status: "active" }])).toMatchObject({
      active: 2,
      pastDue: 1,
    });
    expect(
      clientStatusCounts([
        { status: "cancelled", failedPaymentDays: 3 },
        { status: "paused", failedPaymentDays: 3 },
      ]),
    ).toMatchObject({ active: 0, pastDue: 0, paused: 1, cancelled: 1 });
  });

  it("MRR never counts a cancelled or paused client because of a failed-payment day count", () => {
    expect(mrr([{ status: "cancelled", failedPaymentDays: 3, monthlyFeeUsd: 1000 }])).toBeNull();
    expect(
      mrr([
        { status: "active", failedPaymentDays: 3, monthlyFeeUsd: 1500 },
        { status: "paused", failedPaymentDays: 3, monthlyFeeUsd: 750 },
        { status: "cancelled", failedPaymentDays: 3, monthlyFeeUsd: 1000 },
      ]),
    ).toBe(1500);
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

const DAY = 24 * 60 * 60 * 1000;
const MONTH = { startMs: Date.UTC(2026, 10, 1), endMs: Date.UTC(2026, 10, 30, 23, 59, 59) };
const inMonth = (day: number) => new Date(Date.UTC(2026, 10, day, 12)).toISOString();

// The remaining certified definitions (brain definitions/*.md, 2026-11-26),
// one worked example each, checked answer verbatim.
describe("certified worked examples: every one of the 17 definitions", () => {
  it("agency ROAS from payments: $6,000 inside 30 days, $2,000 on day 45 excluded = 5.0x", () => {
    const wonAt = inMonth(1);
    const cash = first30DayCash([
      {
        wonAt,
        payments: [
          { amountUsd: 6000, paidAt: new Date(Date.parse(wonAt) + 10 * DAY).toISOString(), status: "succeeded" },
          { amountUsd: 2000, paidAt: new Date(Date.parse(wonAt) + 45 * DAY).toISOString(), status: "succeeded" },
        ],
      },
    ]);
    expect(cash).toBe(6000);
    expect(agencyRoas({ scope: "agency_marketing", first30DayCashUsd: cash, agencyAdSpendUsd: 1200 })).toBe(5);
  });

  it("client ROAS from CRM deals: the unlogged $3,000 job is excluded = 4.5x", () => {
    const won = clientCrmWonRevenue([
      { amountUsd: 7500, loggedInCrm: true },
      { amountUsd: 1500, loggedInCrm: true, clientReported: true, labeledClientReported: true },
      { amountUsd: 3000, loggedInCrm: false, clientReported: true },
      { amountUsd: 900, loggedInCrm: true, clientReported: true, labeledClientReported: false },
    ]);
    expect(won).toBe(9000);
    expect(clientRoas({ scope: "client_fulfillment", crmWonRevenueUsd: won, adSpendUsd: 2000 })).toBe(4.5);
  });

  it("revenue: $4,250 retainers + $3,000 setup collected = $7,250 (invoice balance and client ad spend excluded)", () => {
    const payments: CashPayment[] = [
      { scope: "agency_finance", amountUsd: 4250, status: "succeeded", paidAt: inMonth(5) },
      { scope: "agency_finance", amountUsd: 3000, status: "paid", paidAt: inMonth(9) },
      { scope: "agency_finance", amountUsd: 1750, status: "open", paidAt: null },
    ];
    expect(revenue({ scope: "agency_finance", payments, window: MONTH })).toBe(7250);
    expect(() =>
      revenue({
        scope: "agency_finance",
        payments: [...payments, { scope: "client_fulfillment", amountUsd: 1500, status: "paid", paidAt: inMonth(9) }],
        window: MONTH,
      }),
    ).toThrow(MetricScopeError);
  });

  it("lead: 40 form fills - 5 repeats - 3 applicants = 32; CPL = $20.00", () => {
    const fills = [
      ...Array.from({ length: 32 }, (_, i) => ({ personKey: `person-${i}` })),
      ...Array.from({ length: 5 }, (_, i) => ({ personKey: `PERSON-${i}` })),
      ...Array.from({ length: 3 }, (_, i) => ({ personKey: `applicant-${i}`, applicant: true })),
    ];
    expect(fills).toHaveLength(40);
    const leads = countLeads(fills);
    expect(leads).toBe(32);
    expect(costPerLead({ spend: 640, leads })).toBe(20);
  });

  it("booked: 30 set - 4 cancelled - 6 future = 20 booked; Upcoming = 6", () => {
    const now = inMonth(20);
    const appointments = [
      ...Array.from({ length: 20 }, (_, i) => ({ scheduledAt: inMonth(1 + (i % 19)), status: "confirmed" })),
      ...Array.from({ length: 4 }, () => ({ scheduledAt: inMonth(3), status: "cancelled" })),
      ...Array.from({ length: 6 }, () => ({ scheduledAt: inMonth(25), status: "confirmed" })),
    ];
    expect(appointments).toHaveLength(30);
    expect(bookedCounts(appointments, now)).toEqual({ booked: 20, upcoming: 6, cancelled: 4 });
  });

  it("showed: 5 held on time + 1 late, rescheduled and held = 6 (the rescheduled prospect counts once)", () => {
    const appointments = [
      ...Array.from({ length: 5 }, (_, i) => ({ scheduledAt: inMonth(2 + i), status: "showed", prospectKey: `p-${i}` })),
      { scheduledAt: inMonth(10), status: "noshow", prospectKey: "p-late" },
      { scheduledAt: inMonth(12), status: "showed", prospectKey: "p-late", heldAt: inMonth(14) },
      { scheduledAt: inMonth(13), status: "showed", prospectKey: "p-late" },
    ];
    expect(countShowed(appointments, MONTH)).toBe(6);
  });

  it("sale: 3 sign, 2 pay this month, 1 pays next month = 2 sales this month", () => {
    const deals = [
      { signedAt: inMonth(3), firstPaymentClearedAt: inMonth(4) },
      { signedAt: inMonth(8), firstPaymentClearedAt: inMonth(9) },
      { signedAt: inMonth(28), firstPaymentClearedAt: new Date(Date.UTC(2026, 11, 2)).toISOString() },
    ];
    expect(countSales(deals, MONTH)).toBe(2);
    expect(countSales([{ signedAt: inMonth(3), firstPaymentClearedAt: null }], MONTH)).toBe(0);
  });

  it("client health: A 85% = Green; B 70% = Yellow; C 90% but ads disapproved 30h = Red", () => {
    const base = { status: "active", daysPastDue: 0, adsRunning: true };
    expect(clientHealth({ ...base, goalAttainmentPercent: 85 })).toBe("green");
    expect(clientHealth({ ...base, goalAttainmentPercent: 70 })).toBe("yellow");
    expect(clientHealth({ ...base, adsRunning: false, adsDownHours: 30, goalAttainmentPercent: 90 })).toBe("red");
    expect(clientHealth({ ...base, goalAttainmentPercent: 90, daysPastDue: 3 })).toBe("yellow");
    expect(clientHealth({ ...base, goalAttainmentPercent: 90, daysPastDue: 15 })).toBe("red");
    expect(clientHealth({ ...base, goalAttainmentPercent: 95, openFrustration: true })).toBe("yellow");
    expect(clientHealth({ ...base, goalAttainmentPercent: 95, mentionedCancelling: true })).toBe("red");
    expect(clientHealth({ ...base, goalAttainmentPercent: 40 })).toBe("red");
    expect(clientHealth({ ...base, goalAttainmentPercent: null })).toBeNull();
  });

  it("renewal: 12 terms end, 10 say yes, 9 clear = 9 renewals, 1 Expected Renewal, 75%", () => {
    const terms = [
      ...Array.from({ length: 9 }, () => ({ saidYes: true, nextPaymentStatus: "succeeded" })),
      { saidYes: true, nextPaymentStatus: "pending" },
      ...Array.from({ length: 2 }, () => ({ saidYes: false })),
    ];
    expect(renewalCounts(terms)).toEqual({ renewals: 9, expectedRenewals: 1, termsEnded: 12, renewalRatePercent: 75 });
  });

  it("plan vs package vs service: ads + CRM build at $2,000/month, 3-month minimum = 2 services, $6,000 committed", () => {
    expect(
      committedPlanValue({
        services: ["Meta ads management", "CRM build"],
        plan: { billing: "minimum_term", monthlyPriceUsd: 2000, minimumTermMonths: 3 },
      }),
    ).toEqual({ services: 2, committedValueUsd: 6000 });
    expect(CUSTOMER_FACING_PACKAGE_TERMS).toEqual(["Package", "Program"]);
  });

  it("priority: ads stopped = P1; dashboard bug blocking this week's report = P2; typo = P3", () => {
    expect(classifyPriority({ losingMoney: true })).toBe("P1");
    expect(classifyPriority({ blocksPlannedWorkThisWeek: true })).toBe("P2");
    expect(classifyPriority({})).toBe("P3");
    for (const priority of Object.values(IR_PRIORITY_TO_ISSUE_PRIORITY)) {
      expect(ISSUE_PRIORITIES).toContain(priority);
    }
  });

  it("approved: Manny's Telegram yes counts once logged on the task; before that it is not yet approved", () => {
    const yes = { ownerYes: true, fromMatrixOwner: true };
    expect(approvalState({ ...yes, loggedOnTask: { at: inMonth(4), quoteOrLink: "\"yes, buy it\"" } })).toBe("approved");
    expect(approvalState({ ...yes, loggedOnTask: null })).toBe("awaiting_log");
    expect(approvalState({ ownerYes: true, fromMatrixOwner: false, loggedOnTask: { at: inMonth(4), quoteOrLink: "x" } })).toBe(
      "not_approved",
    );
    expect(approvalState({ customerAcceptedQuote: true })).toBe("approved");
  });

  it("done: merged UI PR with green CI and exact-SHA PASS is not done until the live browser check passes", () => {
    const shipped = { live: true, ciGreen: true, exactShaReviewPass: true, touchesUi: true };
    expect(isDone(shipped)).toBe(false);
    expect(isDone({ ...shipped, liveBrowserVerified: true })).toBe(true);
    expect(isDone({ ...shipped, touchesUi: false })).toBe(true);
    expect(isDone({ ...shipped, exactShaReviewPass: false, liveBrowserVerified: true })).toBe(false);
  });
});

const CERTIFIED_SLUGS = [
  "agency-roas", "approved", "booked", "client-roas", "client-status", "close-rate", "done", "health", "lead",
  "mrr", "plan-package-service", "priority", "renewal", "revenue", "sale", "show-rate", "showed",
];

describe("certified definition registry", () => {
  it("maps all 17 certified GBrain definitions to a library function", () => {
    expect(Object.keys(IR_CERTIFIED_DEFINITION_FORMULAS).sort()).toEqual(CERTIFIED_SLUGS.map((slug) => `definitions/${slug}`));
    for (const [slug, name] of Object.entries(IR_CERTIFIED_DEFINITION_FORMULAS)) {
      expect(IR_METRIC_DEFINITIONS[name].definitionSlug).toBe(slug);
    }
  });

  it("links a definition by slug even when its brain page still says calculation: none", () => {
    for (const slug of CERTIFIED_SLUGS) {
      expect(resolveDefinitionFormula({ slug: `definitions/${slug}`, calculation: "none" }).kind).toBe("metric");
      expect(resolveDefinitionFormula({ slug, calculation: undefined }).kind).toBe("metric");
    }
    expect(resolveDefinitionFormula({ slug: "definitions/lead", calculation: "none" })).toMatchObject({
      definition: { name: "countLeads" },
    });
  });

  it("still reports a broken pointer and leaves unknown slugs undefined", () => {
    expect(resolveDefinitionFormula({ slug: "definitions/lead", calculation: "ir-metrics#leadz" })).toEqual({
      kind: "missing",
      pointer: "ir-metrics#leadz",
    });
    expect(resolveDefinitionFormula({ slug: "definitions/churn", calculation: "none" })).toEqual({ kind: "none" });
    expect(resolveDefinitionFormula({ slug: "definitions/cpl", calculation: "ir-metrics#costPerLead" })).toMatchObject({
      kind: "metric",
      definition: { name: "costPerLead" },
    });
  });
});
