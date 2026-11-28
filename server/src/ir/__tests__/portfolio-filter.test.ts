import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanClientDisplayName,
  deriveClientRatios,
  filterClientOnlyPortfolio,
  isExcludedClientSlug,
  isExcludedClientStatus,
  isOwnBrandSlug,
  slugifyClientName,
  type ClientRatioTarget,
} from "../portfolio-filter.js";

const ENV_KEY = "FULFILLMENT_EXCLUDED_CLIENT_SLUGS";
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
});

describe("cleanClientDisplayName", () => {
  it.each([
    ["  IR - Acme Spas  ", "Acme Spas"],
    ["HTL: Acme Spas", "Acme Spas"],
    ["htl Acme Spas", "Acme Spas"],
    ["Acme Spas - 1234567890", "Acme Spas"],
    ["Acme Spas (owned by Some Agency)", "Acme Spas"],
    ["Acme Spas Ad Account", "Acme Spas"],
    ["✅ Acme   Spas", "Acme Spas"],
  ])("cleans %j to %j", (raw, expected) => {
    expect(cleanClientDisplayName(raw)).toBe(expected);
  });

  it("keeps names that only start with the letters of a brand code", () => {
    expect(cleanClientDisplayName("Iris Pools")).toBe("Iris Pools");
    expect(cleanClientDisplayName("HTLX Spas")).toBe("HTLX Spas");
  });

  it("keeps short trailing numbers that are part of the name", () => {
    expect(cleanClientDisplayName("Acme Spas - 2024")).toBe("Acme Spas - 2024");
  });
});

describe("slugifyClientName", () => {
  it("slugifies the cleaned name", () => {
    expect(slugifyClientName("IR - Acme Spas & Pools - 1234567890")).toBe("acme-spas-pools");
    expect(slugifyClientName("  Globex, Inc.  ")).toBe("globex-inc");
  });

  it("returns an empty slug when nothing is left after cleaning", () => {
    expect(slugifyClientName("  ")).toBe("");
    expect(slugifyClientName("✅")).toBe("");
  });
});

describe("isOwnBrandSlug", () => {
  it("matches own brand slugs exactly and as hyphenated prefixes, ignoring case and spaces", () => {
    expect(isOwnBrandSlug("increase-roas")).toBe(true);
    expect(isOwnBrandSlug(" Hot-Tub-Launch ")).toBe(true);
    expect(isOwnBrandSlug("hot-tub-launch-b2b")).toBe(true);
    expect(isOwnBrandSlug("powersports-launch")).toBe(true);
  });

  it("does not match client slugs that only share a brand's leading letters", () => {
    expect(isOwnBrandSlug("increase-roasters")).toBe(false);
    expect(isOwnBrandSlug("hot-tub-launchpad")).toBe(false);
    expect(isOwnBrandSlug("acme-hot-tub-launch")).toBe(false);
    expect(isOwnBrandSlug("")).toBe(false);
  });
});

describe("isExcludedClientStatus", () => {
  it.each(["former", " Former ", "cancelled", "canceled", "churned", "inactive", "archived"])(
    "excludes status %j",
    (status) => {
      expect(isExcludedClientStatus(status)).toBe(true);
    },
  );

  it.each(["active", "paused", "on hold", "onboarding", "trial", "", null, undefined, 3])(
    "keeps status %j in the portfolio",
    (status) => {
      expect(isExcludedClientStatus(status)).toBe(false);
    },
  );

  it("excludes only a boolean true archived flag", () => {
    expect(isExcludedClientStatus("active", true)).toBe(true);
    expect(isExcludedClientStatus("active", "true")).toBe(false);
    expect(isExcludedClientStatus("active", false)).toBe(false);
  });
});

describe("isExcludedClientSlug", () => {
  it("excludes the agency owner entry and own brands", () => {
    expect(isExcludedClientSlug("__owner__")).toBe(true);
    expect(isExcludedClientSlug(" __OWNER__ ")).toBe(true);
    expect(isExcludedClientSlug("natural-sanitation")).toBe(true);
  });

  it("keeps active client slugs and ignores empty slugs", () => {
    expect(isExcludedClientSlug("acme-spas")).toBe(false);
    expect(isExcludedClientSlug("   ")).toBe(false);
  });

  it("parses the env list with spaces, mixed case and empty entries", () => {
    process.env[ENV_KEY] = " Retired-North-Spa , ,old-pools ";
    expect(isExcludedClientSlug("retired-north-spa")).toBe(true);
    expect(isExcludedClientSlug("old-pools")).toBe(true);
    expect(isExcludedClientSlug("acme-spas")).toBe(false);
  });

  it("excludes hyphenated children of an excluded slug but not look-alike slugs", () => {
    expect(isExcludedClientSlug("old-pools-east", ["old-pools"])).toBe(true);
    expect(isExcludedClientSlug("old-poolside", ["old-pools"])).toBe(false);
    expect(isExcludedClientSlug("acme-old-pools", ["old-pools"])).toBe(false);
  });

  it("normalises option entries and skips blank ones", () => {
    expect(isExcludedClientSlug("old-pools", [" OLD-POOLS "])).toBe(true);
    expect(isExcludedClientSlug("acme-spas", ["", "  "])).toBe(false);
  });

  it("combines env and option exclusions", () => {
    process.env[ENV_KEY] = "retired-north-spa";
    expect(isExcludedClientSlug("retired-north-spa", ["old-pools"])).toBe(true);
    expect(isExcludedClientSlug("old-pools", ["old-pools"])).toBe(true);
  });
});

describe("filterClientOnlyPortfolio", () => {
  it("excludes a row by its display name even when the slug is an ad account id", () => {
    const rows = [
      { slug: "act_111", displayName: "Increase ROAS Ad Account" },
      { slug: "act_222", displayName: "HTL - Hot Tub Launch - 1234567890" },
      { slug: "act_333", displayName: "IR - Old Pools" },
      { slug: "act_444", displayName: "IR - Acme Spas" },
    ];
    expect(filterClientOnlyPortfolio(rows, { excludedSlugs: ["old-pools"] }).map((c) => c.slug)).toEqual([
      "act_444",
    ]);
  });

  it("keeps paused clients and rows with no status or display name", () => {
    const rows = [
      { slug: "acme-spas", status: "paused" },
      { slug: "globex-pools", status: null, displayName: null },
      { slug: "initech-tubs", displayName: "" },
    ];
    expect(filterClientOnlyPortfolio(rows).map((c) => c.slug)).toEqual([
      "acme-spas",
      "globex-pools",
      "initech-tubs",
    ]);
  });

  it("returns the same objects in order without changing the input", () => {
    const keep = { slug: "acme-spas", spend: 100 };
    const drop = { slug: "__owner__", spend: 900 };
    const rows = [keep, drop];
    const result = filterClientOnlyPortfolio(rows);
    expect(result).toEqual([keep]);
    expect(result[0]).toBe(keep);
    expect(rows).toEqual([keep, drop]);
  });
});

function ratioEntry(overrides: Partial<ClientRatioTarget> = {}): ClientRatioTarget {
  return {
    slug: "acme-spas",
    spend: null,
    newLeads: null,
    booked: null,
    showed: null,
    wonDeals: null,
    pipelineRevenueUsd: null,
    showRate: null,
    closeRate: null,
    cpl: null,
    cac: null,
    roas: null,
    costPerHeldAppointment: null,
    ...overrides,
  };
}

describe("deriveClientRatios", () => {
  it("derives every ratio from raw counts", () => {
    const entry = ratioEntry({
      spend: 1000,
      newLeads: 40,
      booked: 20,
      showed: 10,
      wonDeals: 4,
      pipelineRevenueUsd: 12000,
    });
    deriveClientRatios(entry);
    expect(entry).toMatchObject({
      showRate: 50,
      closeRate: 40,
      cpl: 25,
      cac: 250,
      roas: 12,
      costPerHeldAppointment: 100,
    });
  });

  it("never overwrites upstream ratios, including zeros", () => {
    const entry = ratioEntry({
      spend: 1000,
      newLeads: 40,
      booked: 20,
      showed: 10,
      wonDeals: 4,
      pipelineRevenueUsd: 12000,
      showRate: 61.5,
      closeRate: 0,
      cpl: 0,
      cac: 199,
      roas: 0,
      costPerHeldAppointment: 77,
    });
    deriveClientRatios(entry);
    expect(entry).toMatchObject({
      showRate: 61.5,
      closeRate: 0,
      cpl: 0,
      cac: 199,
      roas: 0,
      costPerHeldAppointment: 77,
    });
  });

  it("never derives ROAS for the agency owner row", () => {
    const entry = ratioEntry({ slug: "__owner__", spend: 1000, newLeads: 40, pipelineRevenueUsd: 12000 });
    deriveClientRatios(entry);
    expect(entry.roas).toBeNull();
    expect(entry.cpl).toBe(25);
  });

  it("leaves ratios empty when inputs are missing or denominators are zero", () => {
    const empty = ratioEntry();
    deriveClientRatios(empty);
    expect(empty).toEqual(ratioEntry());

    const zeros = ratioEntry({
      spend: 500,
      newLeads: 0,
      booked: 0,
      showed: 0,
      wonDeals: 0,
      pipelineRevenueUsd: 3000,
    });
    deriveClientRatios(zeros);
    expect(zeros).toMatchObject({
      showRate: null,
      closeRate: null,
      cpl: null,
      cac: null,
      roas: 6,
      costPerHeldAppointment: null,
    });

    const noSpend = ratioEntry({ spend: 0, pipelineRevenueUsd: 3000 });
    deriveClientRatios(noSpend);
    expect(noSpend.roas).toBeNull();
  });
});
