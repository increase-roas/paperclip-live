/**
 * The one canonical Increase ROAS metric library.
 *
 * Every dashboard, report and agent computes these numbers through the
 * functions below, never inline. GBrain `definitions/<slug>.md` pages point at
 * a function here with `calculation: ir-metrics#<fn>`; the System Map checks
 * that every pointer resolves to an entry in `IR_METRIC_DEFINITIONS`.
 *
 * All functions return `null` when an input is missing or the denominator is
 * not positive, so a missing source never renders as a confident zero.
 */

export const IR_METRICS_VERSION = "1.0.0";

/** The six own brands (owner-locked). Revstead Systems is a client, not a brand. */
export const OWN_BRANDS = [
  { code: "IR", slug: "increase-roas", name: "Increase ROAS" },
  { code: "HTL", slug: "hot-tub-launch", name: "Hot Tub Launch" },
  { code: "SSA", slug: "start-scale-automate", name: "Start Scale Automate" },
  { code: "PSL", slug: "powersports-launch", name: "Powersports Launch" },
  { code: "NS", slug: "natural-sanitation", name: "Natural Sanitation" },
  { code: "DL", slug: "dynamite-lights", name: "Dynamite Lights" },
] as const;

export type OwnBrandCode = (typeof OWN_BRANDS)[number]["code"];

export function isOwnBrandCode(value: unknown): value is OwnBrandCode {
  return typeof value === "string" && OWN_BRANDS.some((brand) => brand.code === value);
}

/**
 * Where a number came from. Agency scopes read only the agency's own accounts
 * (`__owner__`); `client_fulfillment` reads client delivery accounts.
 */
export type AgencyAccountScope = "agency_marketing" | "agency_sales" | "agency_finance";
export type AccountScope = AgencyAccountScope | "client_fulfillment";

export function isAgencyScope(scope: unknown): scope is AgencyAccountScope {
  return scope === "agency_marketing" || scope === "agency_sales" || scope === "agency_finance";
}

export class MetricScopeError extends Error {
  constructor(metric: string, expected: string, received: unknown) {
    super(`${metric} needs ${expected} inputs, got ${String(received)}`);
    this.name = "MetricScopeError";
  }
}

type Count = number | null | undefined;

function known(value: Count): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function percent(numerator: Count, denominator: Count, cap = true): number | null {
  if (!known(numerator) || !known(denominator) || denominator <= 0) return null;
  const value = (numerator / denominator) * 100;
  return round1(cap ? Math.min(100, value) : value);
}

function perUnit(total: Count, units: Count): number | null {
  if (!known(total) || !known(units) || units <= 0) return null;
  return round2(total / units);
}

/** Appointments held ÷ appointments booked, as a percent (capped at 100). */
export function showRate(input: { booked: Count; showed: Count }): number | null {
  return percent(input.showed, input.booked);
}

/** Offers or proposals made ÷ appointments held, as a percent (capped at 100). */
export function offerRate(input: { showed: Count; pitched: Count }): number | null {
  return percent(input.pitched, input.showed);
}

/**
 * Deals won ÷ decided deals, as a percent. Uses the best denominator the
 * source has: won + lost, then offers made, then appointments held.
 */
export function closeRate(input: {
  wonDeals: Count;
  lostDeals?: Count;
  pitched?: Count;
  showed?: Count;
}): number | null {
  const { wonDeals, lostDeals, pitched, showed } = input;
  if (!known(wonDeals)) return null;
  if (known(lostDeals) && wonDeals + lostDeals > 0) return percent(wonDeals, wonDeals + lostDeals);
  if (known(pitched) && pitched > 0) return percent(wonDeals, pitched);
  if (known(showed) && showed > 0) return percent(wonDeals, showed);
  return null;
}

/** Appointments booked ÷ new leads, as a percent (not capped). */
export function setRate(input: { newLeads: Count; booked: Count }): number | null {
  return percent(input.booked, input.newLeads, false);
}

/** Deals won ÷ new leads, as a percent (not capped). */
export function leadToCustomerRate(input: { newLeads: Count; wonDeals: Count }): number | null {
  return percent(input.wonDeals, input.newLeads, false);
}

/** Ad spend ÷ leads, in dollars. */
export function costPerLead(input: { spend: Count; leads: Count }): number | null {
  return perUnit(input.spend, input.leads);
}

/** Clicks ÷ impressions, as a percent with two decimals (not capped). */
export function ctrPercent(input: { clicks: Count; impressions: Count }): number | null {
  if (!known(input.clicks) || !known(input.impressions) || input.impressions <= 0) return null;
  return round2((input.clicks / input.impressions) * 100);
}

/** Spend ÷ acquisitions (won deals, held appointments, …), in dollars. */
export function costPerAcquisition(input: { spend: Count; acquisitions: Count }): number | null {
  return perUnit(input.spend, input.acquisitions);
}

/**
 * Agency ROAS: agency revenue ÷ agency acquisition ad spend. Only agency-scope
 * inputs are accepted, so client revenue can never inflate the agency number.
 */
export function agencyRoas(input: {
  scope: AgencyAccountScope;
  revenueUsd: Count;
  adSpendUsd: Count;
}): number | null {
  if (!isAgencyScope(input.scope)) throw new MetricScopeError("agencyRoas", "agency_*", input.scope);
  return perUnit(input.revenueUsd, input.adSpendUsd);
}

/** Client ROAS: client revenue ÷ client ad spend. Only client-fulfillment inputs are accepted. */
export function clientRoas(input: {
  scope: "client_fulfillment";
  revenueUsd: Count;
  adSpendUsd: Count;
}): number | null {
  if (input.scope !== "client_fulfillment") {
    throw new MetricScopeError("clientRoas", "client_fulfillment", input.scope);
  }
  return perUnit(input.revenueUsd, input.adSpendUsd);
}

export type ClientLifecycleStatus = "active" | "paused" | "cancelled" | "other";

const ACTIVE_STATUSES = new Set(["active", "live", "healthy", "onboarding"]);
const PAUSED_STATUSES = new Set(["paused", "on_hold", "on hold", "hold"]);
const CANCELLED_STATUSES = new Set(["cancelled", "canceled", "churned", "inactive", "archived"]);

/** Maps a raw client status string onto active / paused / cancelled. */
export function clientLifecycleStatus(raw: unknown): ClientLifecycleStatus {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (ACTIVE_STATUSES.has(value)) return "active";
  if (PAUSED_STATUSES.has(value)) return "paused";
  if (CANCELLED_STATUSES.has(value)) return "cancelled";
  return "other";
}

export interface ClientStatusCounts {
  active: number;
  paused: number;
  cancelled: number;
  other: number;
  total: number;
}

/** Active / paused / cancelled client counts from live client records. */
export function clientStatusCounts(clients: ReadonlyArray<{ status: unknown }>): ClientStatusCounts {
  const counts: ClientStatusCounts = { active: 0, paused: 0, cancelled: 0, other: 0, total: 0 };
  for (const client of clients) {
    counts[clientLifecycleStatus(client.status)] += 1;
    counts.total += 1;
  }
  return counts;
}

/**
 * Monthly recurring revenue: the sum of monthly retainers of active clients.
 * Returns null when no active client has a known retainer.
 */
export function mrr(clients: ReadonlyArray<{ status: unknown; monthlyRetainerUsd: Count }>): number | null {
  let total = 0;
  let anyKnown = false;
  for (const client of clients) {
    if (clientLifecycleStatus(client.status) !== "active" || !known(client.monthlyRetainerUsd)) continue;
    total += client.monthlyRetainerUsd;
    anyKnown = true;
  }
  return anyKnown ? round2(total) : null;
}

export type IrMetricName =
  | "showRate"
  | "offerRate"
  | "closeRate"
  | "setRate"
  | "leadToCustomerRate"
  | "costPerLead"
  | "ctrPercent"
  | "costPerAcquisition"
  | "agencyRoas"
  | "clientRoas"
  | "mrr"
  | "clientStatusCounts";

export interface IrMetricDefinition {
  name: IrMetricName;
  term: string;
  definitionSlug: string;
  formula: string;
  unit: "percent" | "usd" | "ratio" | "count";
}

/** What each canonical function computes; GBrain definitions point here. */
export const IR_METRIC_DEFINITIONS: Record<IrMetricName, IrMetricDefinition> = {
  showRate: {
    name: "showRate",
    term: "Show rate",
    definitionSlug: "definitions/show-rate",
    formula: "appointments held ÷ appointments booked × 100 (capped at 100)",
    unit: "percent",
  },
  offerRate: {
    name: "offerRate",
    term: "Offer rate",
    definitionSlug: "definitions/offer-rate",
    formula: "offers made ÷ appointments held × 100 (capped at 100)",
    unit: "percent",
  },
  closeRate: {
    name: "closeRate",
    term: "Close rate",
    definitionSlug: "definitions/close-rate",
    formula: "deals won ÷ (won + lost); else ÷ offers made; else ÷ appointments held; × 100",
    unit: "percent",
  },
  setRate: {
    name: "setRate",
    term: "Set rate",
    definitionSlug: "definitions/set-rate",
    formula: "appointments booked ÷ new leads × 100",
    unit: "percent",
  },
  leadToCustomerRate: {
    name: "leadToCustomerRate",
    term: "Lead-to-customer rate",
    definitionSlug: "definitions/lead-to-customer-rate",
    formula: "deals won ÷ new leads × 100",
    unit: "percent",
  },
  costPerLead: {
    name: "costPerLead",
    term: "Cost per lead (CPL)",
    definitionSlug: "definitions/cpl",
    formula: "ad spend ÷ leads",
    unit: "usd",
  },
  ctrPercent: {
    name: "ctrPercent",
    term: "Click-through rate (CTR)",
    definitionSlug: "definitions/ctr",
    formula: "clicks ÷ impressions × 100",
    unit: "percent",
  },
  costPerAcquisition: {
    name: "costPerAcquisition",
    term: "Cost per acquisition (CAC)",
    definitionSlug: "definitions/cac",
    formula: "ad spend ÷ acquisitions (won deals or held appointments)",
    unit: "usd",
  },
  agencyRoas: {
    name: "agencyRoas",
    term: "Agency ROAS",
    definitionSlug: "definitions/agency-vs-client-roas",
    formula: "agency revenue ÷ agency acquisition ad spend (agency_* scope only)",
    unit: "ratio",
  },
  clientRoas: {
    name: "clientRoas",
    term: "Client ROAS",
    definitionSlug: "definitions/agency-vs-client-roas",
    formula: "client revenue ÷ client ad spend (client_fulfillment scope only)",
    unit: "ratio",
  },
  mrr: {
    name: "mrr",
    term: "Monthly recurring revenue (MRR)",
    definitionSlug: "definitions/mrr",
    formula: "sum of monthly retainers of active clients",
    unit: "usd",
  },
  clientStatusCounts: {
    name: "clientStatusCounts",
    term: "Active / paused / cancelled clients",
    definitionSlug: "definitions/active-paused-cancelled",
    formula: "count of live client records by lifecycle status",
    unit: "count",
  },
};

/**
 * Resolves a GBrain `calculation:` pointer (`ir-metrics#showRate`). Returns
 * `none` for an explicit `none`, `missing` when the pointer names no function.
 */
export function resolveCalculationPointer(
  pointer: unknown,
): { kind: "metric"; definition: IrMetricDefinition } | { kind: "none" } | { kind: "missing"; pointer: string } {
  const raw = typeof pointer === "string" ? pointer.trim() : "";
  if (!raw || raw === "none") return { kind: "none" };
  const match = /^ir-metrics#([A-Za-z]+)$/.exec(raw);
  const name = match?.[1];
  if (name && Object.prototype.hasOwnProperty.call(IR_METRIC_DEFINITIONS, name)) {
    return { kind: "metric", definition: IR_METRIC_DEFINITIONS[name as IrMetricName] };
  }
  return { kind: "missing", pointer: raw };
}
