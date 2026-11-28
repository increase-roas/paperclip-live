import {
  clientLifecycleStatus,
  clientRoas,
  closeRate,
  costPerAcquisition,
  costPerLead,
  OWN_BRANDS,
  showRate,
} from "@paperclipai/shared/ir-metrics";

export interface ClientPortfolioFilterTarget {
  slug: string;
  displayName?: string | null;
  status?: string | null;
  archived?: boolean | null;
}

export interface FilterClientOnlyPortfolioOptions {
  excludedSlugs?: readonly string[];
}

export interface ClientRatioTarget {
  slug: string;
  spend: number | null;
  newLeads: number | null;
  booked: number | null;
  showed: number | null;
  wonDeals: number | null;
  pipelineRevenueUsd: number | null;
  showRate: number | null;
  closeRate: number | null;
  cpl: number | null;
  cac: number | null;
  roas: number | null;
  costPerHeldAppointment: number | null;
}

const OWN_BRAND_SLUGS: readonly string[] = [
  ...OWN_BRANDS.map((brand) => brand.slug),
  "alex-bloomfield",
];

/**
 * Former/excluded client slugs are configuration, never hardcoded client names:
 * set comma-separated slugs via `FULFILLMENT_EXCLUDED_CLIENT_SLUGS` (or `opts.excludedSlugs`).
 */

export function cleanClientDisplayName(raw: string): string {
  return raw
    .trim()
    .replace(/^(?:ir|htl)\s*[-:]?\s+/i, "")
    .replace(/\s+-\s+\d{6,}$/i, "")
    .replace(/\s*\(owned by[^)]*\)/gi, "")
    .replace(/\s+ad\s+account$/i, "")
    .replace(/(?:\u2705|\u2714|\uFE0F)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function slugifyClientName(raw: string): string {
  const cleaned = cleanClientDisplayName(raw);
  return cleaned
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseEnvSlugList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function matchesSlugOrPrefix(candidate: string, excluded: string): boolean {
  return candidate === excluded || candidate.startsWith(`${excluded}-`);
}

export function isOwnBrandSlug(rawSlug: string): boolean {
  const slug = rawSlug.trim().toLowerCase();
  if (!slug) return false;
  return OWN_BRAND_SLUGS.some((brandSlug) => matchesSlugOrPrefix(slug, brandSlug));
}

export function isExcludedClientStatus(status: unknown, archived?: unknown): boolean {
  if (archived === true) return true;
  if (typeof status !== "string") return false;
  const normalized = status.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === "former") return true;
  return clientLifecycleStatus(normalized) === "cancelled";
}

export function isExcludedClientSlug(
  rawSlug: string,
  extraExcludedSlugs?: readonly string[],
): boolean {
  const slug = rawSlug.trim().toLowerCase();
  if (!slug) return false;
  if (slug === "__owner__") return true;
  if (isOwnBrandSlug(slug)) return true;

  const excluded = [
    ...parseEnvSlugList(process.env.FULFILLMENT_EXCLUDED_CLIENT_SLUGS),
    ...(extraExcludedSlugs ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean),
  ];
  return excluded.some((entry) => matchesSlugOrPrefix(slug, entry));
}

/**
 * Excludes the agency `__owner__` entry, Increase ROAS own brands, and former/cancelled/archived
 * clients so Fulfillment and CEO portfolio totals strictly own active client accounts only.
 */
export function filterClientOnlyPortfolio<T extends ClientPortfolioFilterTarget>(
  clients: readonly T[],
  opts?: FilterClientOnlyPortfolioOptions,
): T[] {
  return clients.filter((client) => {
    if (isExcludedClientStatus(client.status, client.archived)) return false;
    if (isExcludedClientSlug(client.slug, opts?.excludedSlugs)) return false;
    if (client.displayName) {
      const nameSlug = slugifyClientName(client.displayName);
      if (nameSlug && isExcludedClientSlug(nameSlug, opts?.excludedSlugs)) return false;
    }
    return true;
  });
}

export function deriveClientRatios(entry: ClientRatioTarget): void {
  // Upstream `booked` must be past-dated (definitions/booked).
  entry.showRate ??= showRate({ pastDatedBooked: entry.booked, showed: entry.showed });
  entry.closeRate ??= closeRate({ wonDeals: entry.wonDeals, showed: entry.showed });
  entry.cpl ??= costPerLead({ spend: entry.spend, leads: entry.newLeads });
  entry.cac ??= costPerAcquisition({ spend: entry.spend, acquisitions: entry.wonDeals });
  // Agency ROAS needs first-30-day cash per client won through agency ads,
  // which the snapshot does not carry, so the owner row is never derived here.
  if (entry.slug !== "__owner__") {
    entry.roas ??= clientRoas({
      scope: "client_fulfillment",
      crmWonRevenueUsd: entry.pipelineRevenueUsd,
      adSpendUsd: entry.spend,
    });
  }
  entry.costPerHeldAppointment ??= costPerAcquisition({ spend: entry.spend, acquisitions: entry.showed });
}
