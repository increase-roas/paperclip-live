/**
 * The one canonical Increase ROAS metric library. Formulas follow the GBrain
 * definitions certified by Alex on 2026-11-26 (brain `definitions/*.md`).
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
  { code: "DYNAMITE", slug: "dynamite-lights", name: "Dynamite Lights" },
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

/**
 * Show rate: showed ÷ past-dated booked (scheduled time has passed, not
 * cancelled). Upcoming appointments are not in the denominator. Null when
 * past-dated booked is 0.
 */
export function showRate(input: { pastDatedBooked: Count; showed: Count }): number | null {
  return percent(input.showed, input.pastDatedBooked, false);
}

/** Offer rate (diagnostic): offers made ÷ showed calls, as a percent. */
export function offerRate(input: { showed: Count; pitched: Count }): number | null {
  return percent(input.pitched, input.showed, false);
}

/** Close rate: sales ÷ showed calls in the period, as a percent. */
export function closeRate(input: { wonDeals: Count; showed: Count }): number | null {
  return percent(input.wonDeals, input.showed, false);
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

/** Cash collected at close ÷ won deal value, as a percent (not capped). */
export function cashUpFrontPercent(input: { cashCollectedUsd: Count; wonDealValueUsd: Count }): number | null {
  return percent(input.cashCollectedUsd, input.wonDealValueUsd, false);
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
 * Agency ROAS: cash collected in the first 30 days from clients won through
 * the 3 agency Meta acquisition accounts ÷ spend on those accounts. Only
 * agency-scope inputs are accepted, so client revenue can never inflate it.
 */
export function agencyRoas(input: {
  scope: AgencyAccountScope;
  first30DayCashUsd: Count;
  agencyAdSpendUsd: Count;
}): number | null {
  if (!isAgencyScope(input.scope)) throw new MetricScopeError("agencyRoas", "agency_*", input.scope);
  return perUnit(input.first30DayCashUsd, input.agencyAdSpendUsd);
}

/**
 * Client ROAS: the client's CRM won deals (GHL or Koi, including client-reported
 * jobs only when logged and labeled in the CRM) ÷ that client's ad spend.
 * Fulfillment only.
 */
export function clientRoas(input: {
  scope: "client_fulfillment";
  crmWonRevenueUsd: Count;
  adSpendUsd: Count;
}): number | null {
  if (input.scope !== "client_fulfillment") {
    throw new MetricScopeError("clientRoas", "client_fulfillment", input.scope);
  }
  return perUnit(input.crmWonRevenueUsd, input.adSpendUsd);
}

export type ClientLifecycleStatus = "active" | "paused" | "cancelled" | "other";

const ACTIVE_STATUSES = new Set(["active", "live", "healthy", "onboarding"]);
const PAUSED_STATUSES = new Set(["paused", "on_hold", "on hold", "hold"]);
const CANCELLED_STATUSES = new Set(["cancelled", "canceled", "churned", "inactive", "archived"]);

function rawLifecycleStatus(raw: unknown): ClientLifecycleStatus {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (ACTIVE_STATUSES.has(value)) return "active";
  if (PAUSED_STATUSES.has(value)) return "paused";
  if (CANCELLED_STATUSES.has(value)) return "cancelled";
  return "other";
}

/**
 * Maps a raw client status onto active / paused / cancelled. Failed-payment
 * rule: days 1 to 14 unresolved = Active (Past Due); day 15 = Paused; day 30 =
 * Cancelled. The rule only escalates: it never turns a cancelled client into
 * paused or a paused client into active.
 */
export function clientLifecycleStatus(raw: unknown, failedPaymentDays?: Count): ClientLifecycleStatus {
  const base = rawLifecycleStatus(raw);
  if (base === "cancelled" || !known(failedPaymentDays)) return base;
  if (failedPaymentDays >= 30) return "cancelled";
  if (failedPaymentDays >= 15) return "paused";
  return base;
}

export interface ClientStatusCounts {
  active: number;
  /** Active clients inside the 14-day failed-payment window (also counted in `active`). */
  pastDue: number;
  paused: number;
  cancelled: number;
  other: number;
  total: number;
}

/** Active / paused / cancelled client counts from live client records. */
export function clientStatusCounts(
  clients: ReadonlyArray<{ status: unknown; failedPaymentDays?: Count }>,
): ClientStatusCounts {
  const counts: ClientStatusCounts = { active: 0, pastDue: 0, paused: 0, cancelled: 0, other: 0, total: 0 };
  for (const client of clients) {
    const status = clientLifecycleStatus(client.status, client.failedPaymentDays);
    counts[status] += 1;
    if (status === "active" && known(client.failedPaymentDays) && client.failedPaymentDays >= 1) counts.pastDue += 1;
    counts.total += 1;
  }
  return counts;
}

export interface MrrClient {
  status: unknown;
  failedPaymentDays?: Count;
  /** Recurring monthly fee only: never setup or build fees, one-off sales or client ad spend. */
  monthlyFeeUsd?: Count;
  /** A paid-in-full term (for example 3 months): counts as total ÷ term months in each active month. */
  paidInFull?: { totalUsd: Count; termMonths: Count } | null;
}

/**
 * MRR: the sum of the monthly recurring fees of active clients. A paid-in-full
 * term counts as total ÷ months in each active month; paused clients count $0.
 * Returns null when no active client has a known fee.
 */
export function mrr(clients: ReadonlyArray<MrrClient>): number | null {
  let total = 0;
  let anyKnown = false;
  for (const client of clients) {
    if (clientLifecycleStatus(client.status, client.failedPaymentDays) !== "active") continue;
    const term = client.paidInFull;
    const monthly =
      term && known(term.totalUsd) && known(term.termMonths) && term.termMonths > 0
        ? term.totalUsd / term.termMonths
        : client.monthlyFeeUsd;
    if (!known(monthly)) continue;
    total += monthly;
    anyKnown = true;
  }
  return anyKnown ? round2(total) : null;
}

type Instant = string | number | Date | null | undefined;

function instantMs(value: Instant): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** An inclusive reporting window, in epoch milliseconds. */
export interface MetricWindow {
  startMs: number;
  endMs: number;
}

function inWindow(value: Instant, window: MetricWindow): boolean {
  const ms = instantMs(value);
  return ms !== null && ms >= window.startMs && ms <= window.endMs;
}

const CLEARED_PAYMENT_STATUSES = new Set(["succeeded", "completed", "paid", "cleared", "settled"]);

/**
 * A payment counts as cash only once it has cleared. Used by Revenue, Sale and
 * Renewal so all three read "money in the bank" the same way.
 */
export function isClearedPayment(status: unknown): boolean {
  return typeof status === "string" && CLEARED_PAYMENT_STATUSES.has(status.trim().toLowerCase());
}

export interface CashPayment {
  /** Whose money this is. Agency revenue never accepts client-scope rows. */
  scope: AccountScope;
  amountUsd: Count;
  refundedUsd?: Count;
  status: unknown;
  paidAt: Instant;
}

/**
 * Revenue: cash collected only, money in the bank in the period, never
 * invoiced amounts. Every payment must carry the requested scope, so agency
 * revenue can never absorb client ad spend or client sales (LR-017).
 */
export function revenue(input: {
  scope: AccountScope;
  payments: ReadonlyArray<CashPayment>;
  window: MetricWindow;
}): number {
  let total = 0;
  for (const payment of input.payments) {
    if (payment.scope !== input.scope) throw new MetricScopeError("revenue", input.scope, payment.scope);
    if (!isClearedPayment(payment.status) || !inWindow(payment.paidAt, input.window)) continue;
    if (!known(payment.amountUsd)) continue;
    const refunded = known(payment.refundedUsd) ? payment.refundedUsd : 0;
    total += Math.max(0, payment.amountUsd - refunded);
  }
  return round2(total);
}

/**
 * The Agency ROAS numerator: cleared cash each won client paid within 30 days
 * of being won. Pass it to `agencyRoas` as `first30DayCashUsd`.
 */
export function first30DayCash(
  clients: ReadonlyArray<{ wonAt: Instant; payments: ReadonlyArray<{ amountUsd: Count; paidAt: Instant; status?: unknown }> }>,
): number {
  const dayMs = 24 * 60 * 60 * 1000;
  let total = 0;
  for (const client of clients) {
    const wonMs = instantMs(client.wonAt);
    if (wonMs === null) continue;
    for (const payment of client.payments) {
      if (payment.status !== undefined && !isClearedPayment(payment.status)) continue;
      const paidMs = instantMs(payment.paidAt);
      if (paidMs === null || !known(payment.amountUsd)) continue;
      if (paidMs >= wonMs && paidMs - wonMs <= 30 * dayMs) total += payment.amountUsd;
    }
  }
  return round2(total);
}

/**
 * The Client ROAS numerator: won deals logged in the client's CRM (GHL or
 * Koi). A job the client reports counts only when it is logged in the CRM and
 * labeled 'client-reported'.
 */
export function clientCrmWonRevenue(
  deals: ReadonlyArray<{ amountUsd: Count; loggedInCrm: boolean; clientReported?: boolean; labeledClientReported?: boolean }>,
): number {
  let total = 0;
  for (const deal of deals) {
    if (!deal.loggedInCrm || !known(deal.amountUsd)) continue;
    if (deal.clientReported && !deal.labeledClientReported) continue;
    total += deal.amountUsd;
  }
  return round2(total);
}

export interface LeadCandidate {
  /** Stable person key (CRM contact id, email or phone). Null = cannot dedupe, counted once. */
  personKey: string | null | undefined;
  /** Recruiting and job-applicant contacts are never leads. */
  applicant?: boolean;
}

/** Lead: a new person who gives contact details in the period, once per person, applicants excluded. */
export function countLeads(contacts: ReadonlyArray<LeadCandidate>): number {
  const seen = new Set<string>();
  let anonymous = 0;
  for (const contact of contacts) {
    if (contact.applicant) continue;
    const key = typeof contact.personKey === "string" ? contact.personKey.trim().toLowerCase() : "";
    if (key) seen.add(key);
    else anonymous += 1;
  }
  return seen.size + anonymous;
}

export type AppointmentStatus = "cancelled" | "showed" | "no_show" | "scheduled";

/** Normalises a CRM appointment status. Invalid appointments count as cancelled. */
export function appointmentStatus(raw: unknown): AppointmentStatus {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "cancelled" || value === "canceled" || value === "invalid") return "cancelled";
  if (value === "showed" || value === "show" || value === "attended" || value === "held") return "showed";
  if (value === "noshow" || value === "no_show" || value === "no-show") return "no_show";
  return "scheduled";
}

export interface AppointmentRecord {
  scheduledAt: Instant;
  status: unknown;
  /** The prospect (contact) the appointment belongs to; used by Showed. */
  prospectKey?: string | null;
  /** When the call was actually held, if not at the scheduled time (late or rescheduled). */
  heldAt?: Instant;
}

/**
 * Booked: appointments whose scheduled time has passed (scheduled time <= now)
 * and that were not cancelled. Future appointments are reported as Upcoming,
 * never as Booked.
 */
export function bookedCounts(
  appointments: ReadonlyArray<AppointmentRecord>,
  now: Instant,
): { booked: number; upcoming: number; cancelled: number } {
  const nowMs = instantMs(now) ?? Date.now();
  const counts = { booked: 0, upcoming: 0, cancelled: 0 };
  for (const appointment of appointments) {
    if (appointmentStatus(appointment.status) === "cancelled") {
      counts.cancelled += 1;
      continue;
    }
    const scheduledMs = instantMs(appointment.scheduledAt);
    if (scheduledMs === null) continue;
    if (scheduledMs <= nowMs) counts.booked += 1;
    else counts.upcoming += 1;
  }
  return counts;
}

/**
 * Showed: booked appointments that actually happened. A late or rescheduled
 * call that is held counts in the period it was held, once per prospect.
 */
export function countShowed(appointments: ReadonlyArray<AppointmentRecord>, window: MetricWindow): number {
  const prospects = new Set<string>();
  let anonymous = 0;
  for (const appointment of appointments) {
    if (appointmentStatus(appointment.status) !== "showed") continue;
    if (!inWindow(appointment.heldAt ?? appointment.scheduledAt, window)) continue;
    const key = typeof appointment.prospectKey === "string" ? appointment.prospectKey.trim() : "";
    if (key) prospects.add(key);
    else anonymous += 1;
  }
  return prospects.size + anonymous;
}

/** Sale: a signed agreement WITH its first payment collected. It counts when the first payment clears. */
export function isSale(deal: { signedAt: Instant; firstPaymentClearedAt: Instant }): boolean {
  return instantMs(deal.signedAt) !== null && instantMs(deal.firstPaymentClearedAt) !== null;
}

/** Sales in the period: signed deals whose first payment cleared inside the window. */
export function countSales(
  deals: ReadonlyArray<{ signedAt: Instant; firstPaymentClearedAt: Instant }>,
  window: MetricWindow,
): number {
  return deals.filter((deal) => isSale(deal) && inWindow(deal.firstPaymentClearedAt, window)).length;
}

export type ClientHealth = "green" | "yellow" | "red";

export interface ClientHealthInput {
  status: unknown;
  /** Days a failed payment has gone unresolved; 0 or missing = paid on time. */
  daysPastDue?: Count;
  adsRunning: boolean;
  /** Hours the ads have been stopped or disapproved; only > 24 turns the client red. */
  adsDownHours?: Count;
  /** Percent of the client's lead or booked goal reached. */
  goalAttainmentPercent: Count;
  /** An open frustration in the Customer Service sub-account. */
  openFrustration?: boolean;
  mentionedCancelling?: boolean;
}

/**
 * Client health (Green / Yellow / Red). Red wins over Yellow, Yellow over
 * Green. Returns null when the certified rules cannot place the client (for
 * example goal attainment is unknown and nothing is red or yellow).
 */
export function clientHealth(input: ClientHealthInput): ClientHealth | null {
  const pastDue = known(input.daysPastDue) ? input.daysPastDue : 0;
  const goal = known(input.goalAttainmentPercent) ? input.goalAttainmentPercent : null;
  const adsDown = known(input.adsDownHours) ? input.adsDownHours : 0;
  if ((goal !== null && goal < 50) || adsDown > 24 || pastDue >= 15 || input.mentionedCancelling) return "red";
  if ((goal !== null && goal < 80) || pastDue >= 1 || input.openFrustration) return "yellow";
  const active = clientLifecycleStatus(input.status, pastDue) === "active";
  if (active && input.adsRunning && goal !== null && goal >= 80) return "green";
  return null;
}

/**
 * Renewal: counts only once the next payment or deposit clears. A yes without
 * a cleared payment is an Expected Renewal.
 */
export function renewalCounts(
  termEnds: ReadonlyArray<{ saidYes: boolean; nextPaymentStatus?: unknown }>,
): { renewals: number; expectedRenewals: number; termsEnded: number; renewalRatePercent: number | null } {
  let renewals = 0;
  let expectedRenewals = 0;
  for (const term of termEnds) {
    if (isClearedPayment(term.nextPaymentStatus)) renewals += 1;
    else if (term.saidYes) expectedRenewals += 1;
  }
  return {
    renewals,
    expectedRenewals,
    termsEnded: termEnds.length,
    renewalRatePercent: percent(renewals, termEnds.length, false),
  };
}

/** Service = one deliverable; Package = services sold together at one price; Plan = the package's billing terms. */
export type OfferingKind = "service" | "package" | "plan";
export type PlanBilling = "monthly" | "minimum_term" | "paid_in_full";

/** The words customer-facing scripts use for a package. */
export const CUSTOMER_FACING_PACKAGE_TERMS = ["Package", "Program"] as const;

export interface OfferPackage {
  services: ReadonlyArray<string>;
  plan: { billing: PlanBilling; monthlyPriceUsd: Count; minimumTermMonths?: Count; paidInFullUsd?: Count };
}

/**
 * Plan vs package vs service: the committed value of a package under its plan.
 * Monthly with a minimum term = monthly price × minimum months; paid in full =
 * the lump sum; plain monthly = one month.
 */
export function committedPlanValue(pkg: OfferPackage): { services: number; committedValueUsd: number | null } {
  const plan = pkg.plan;
  let committed: number | null = null;
  if (plan.billing === "paid_in_full") committed = known(plan.paidInFullUsd) ? round2(plan.paidInFullUsd) : null;
  else if (known(plan.monthlyPriceUsd)) {
    const months = plan.billing === "minimum_term" && known(plan.minimumTermMonths) ? plan.minimumTermMonths : 1;
    committed = round2(plan.monthlyPriceUsd * months);
  }
  return { services: new Set(pkg.services).size, committedValueUsd: committed };
}

export type IrPriority = "P1" | "P2" | "P3";

/** How each certified priority maps onto Paperclip issue priorities. */
export const IR_PRIORITY_TO_ISSUE_PRIORITY = { P1: "critical", P2: "high", P3: "medium" } as const;

/** Priority: P1 = losing money or a client, or a live outage; P2 = blocks planned work this week; P3 = everything else. */
export function classifyPriority(input: {
  losingMoney?: boolean;
  losingClient?: boolean;
  liveOutage?: boolean;
  blocksPlannedWorkThisWeek?: boolean;
}): IrPriority {
  if (input.losingMoney || input.losingClient || input.liveOutage) return "P1";
  if (input.blocksPlannedWorkThisWeek) return "P2";
  return "P3";
}

export type ApprovalState = "approved" | "awaiting_log" | "not_approved";

/**
 * Approved: an owner yes from the owner the decision-rights matrix names,
 * counted once it is logged on the Paperclip task with a timestamp and the
 * quote or a link. For DYNAMITE quotes, pass `customerAcceptedQuote`.
 */
export function approvalState(input: {
  ownerYes?: boolean;
  fromMatrixOwner?: boolean;
  loggedOnTask?: { at: Instant; quoteOrLink: string | null | undefined } | null;
  customerAcceptedQuote?: boolean;
}): ApprovalState {
  if (input.customerAcceptedQuote) return "approved";
  if (!input.ownerYes || !input.fromMatrixOwner) return "not_approved";
  const log = input.loggedOnTask;
  const logged = Boolean(log && instantMs(log.at) !== null && log.quoteOrLink && log.quoteOrLink.trim());
  return logged ? "approved" : "awaiting_log";
}

/**
 * Done: the proven fix is live and verified: CI green plus a PASS review on
 * that exact SHA, plus a live real-browser check when the change touches UI.
 */
export function isDone(input: {
  live: boolean;
  ciGreen: boolean;
  exactShaReviewPass: boolean;
  touchesUi: boolean;
  liveBrowserVerified?: boolean;
}): boolean {
  if (!input.live || !input.ciGreen || !input.exactShaReviewPass) return false;
  return !input.touchesUi || input.liveBrowserVerified === true;
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
  | "cashUpFrontPercent"
  | "agencyRoas"
  | "clientRoas"
  | "mrr"
  | "clientStatusCounts"
  | "revenue"
  | "countLeads"
  | "bookedCounts"
  | "countShowed"
  | "countSales"
  | "clientHealth"
  | "renewalCounts"
  | "committedPlanValue"
  | "classifyPriority"
  | "approvalState"
  | "isDone";

export interface IrMetricDefinition {
  name: IrMetricName;
  term: string;
  definitionSlug: string;
  formula: string;
  /** `classification` = a typed classifier (label or yes/no), not a number. */
  unit: "percent" | "usd" | "ratio" | "count" | "classification";
}

/** What each canonical function computes; GBrain definitions point here. */
export const IR_METRIC_DEFINITIONS: Record<IrMetricName, IrMetricDefinition> = {
  showRate: {
    name: "showRate",
    term: "Show rate",
    definitionSlug: "definitions/show-rate",
    formula: "showed ÷ past-dated booked × 100 (upcoming excluded)",
    unit: "percent",
  },
  offerRate: {
    name: "offerRate",
    term: "Offer rate",
    definitionSlug: "definitions/offer-rate",
    formula: "offers made ÷ showed calls × 100 (diagnostic)",
    unit: "percent",
  },
  closeRate: {
    name: "closeRate",
    term: "Close rate",
    definitionSlug: "definitions/close-rate",
    formula: "sales ÷ showed calls × 100",
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
  cashUpFrontPercent: {
    name: "cashUpFrontPercent",
    term: "Cash collected up front",
    definitionSlug: "definitions/cash-up-front",
    formula: "cash collected at close ÷ won deal value × 100",
    unit: "percent",
  },
  agencyRoas: {
    name: "agencyRoas",
    term: "Agency ROAS",
    definitionSlug: "definitions/agency-roas",
    formula: "first-30-day cash from clients won via the 3 agency Meta accounts ÷ their spend",
    unit: "ratio",
  },
  clientRoas: {
    name: "clientRoas",
    term: "Client ROAS",
    definitionSlug: "definitions/client-roas",
    formula: "CRM won deals (GHL/Koi, labeled client-reported jobs only) ÷ client ad spend (fulfillment only)",
    unit: "ratio",
  },
  mrr: {
    name: "mrr",
    term: "Monthly recurring revenue (MRR)",
    definitionSlug: "definitions/mrr",
    formula: "sum of active monthly fees; paid-in-full = total ÷ term months; paused = $0",
    unit: "usd",
  },
  clientStatusCounts: {
    name: "clientStatusCounts",
    term: "Active / paused / cancelled clients",
    definitionSlug: "definitions/client-status",
    formula: "active / paused / cancelled; failed payment: days 1-14 active (past due), 15 paused, 30 cancelled",
    unit: "count",
  },
  revenue: {
    name: "revenue",
    term: "Revenue",
    definitionSlug: "definitions/revenue",
    formula: "cleared cash collected in the period, one scope only (never invoiced, never client money in agency revenue)",
    unit: "usd",
  },
  countLeads: {
    name: "countLeads",
    term: "Lead",
    definitionSlug: "definitions/lead",
    formula: "new people giving contact details in the period, once per person, applicants excluded",
    unit: "count",
  },
  bookedCounts: {
    name: "bookedCounts",
    term: "Booked",
    definitionSlug: "definitions/booked",
    formula: "not-cancelled appointments with scheduled time <= now; future ones = Upcoming",
    unit: "count",
  },
  countShowed: {
    name: "countShowed",
    term: "Showed",
    definitionSlug: "definitions/showed",
    formula: "held appointments in the period they were held (late / rescheduled included), once per prospect",
    unit: "count",
  },
  countSales: {
    name: "countSales",
    term: "Sale",
    definitionSlug: "definitions/sale",
    formula: "signed agreements whose first payment cleared in the period",
    unit: "count",
  },
  clientHealth: {
    name: "clientHealth",
    term: "Client health",
    definitionSlug: "definitions/health",
    formula: "Red: <50% goal, ads down >24h, >=15 days past due or cancel mention; Yellow: 50-79%, 1-14 days past due or open frustration; Green: active, on time, ads running, >=80%",
    unit: "classification",
  },
  renewalCounts: {
    name: "renewalCounts",
    term: "Renewal",
    definitionSlug: "definitions/renewal",
    formula: "next payment cleared = renewal; yes without cleared payment = Expected Renewal",
    unit: "count",
  },
  committedPlanValue: {
    name: "committedPlanValue",
    term: "Plan vs package vs service",
    definitionSlug: "definitions/plan-package-service",
    formula: "service = one deliverable; package = services at one price; plan = billing terms (committed = monthly × minimum months)",
    unit: "classification",
  },
  classifyPriority: {
    name: "classifyPriority",
    term: "Priority",
    definitionSlug: "definitions/priority",
    formula: "P1 = losing money or a client, or live outage; P2 = blocks planned work this week; P3 = everything else",
    unit: "classification",
  },
  approvalState: {
    name: "approvalState",
    term: "Approved",
    definitionSlug: "definitions/approved",
    formula: "matrix owner's yes, logged on the Paperclip task with time and quote/link (DYNAMITE: customer accepted quote)",
    unit: "classification",
  },
  isDone: {
    name: "isDone",
    term: "Done",
    definitionSlug: "definitions/done",
    formula: "live + CI green + exact-SHA PASS review (+ live real-browser check for UI)",
    unit: "classification",
  },
};

/**
 * The single slug → formula-code registry for Alex's 17 certified GBrain
 * definitions. The System Map maps a definition by its slug here, so a
 * definition is linked even before its brain page carries a `calculation:`
 * pointer.
 */
export const IR_CERTIFIED_DEFINITION_FORMULAS = {
  "definitions/mrr": "mrr",
  "definitions/revenue": "revenue",
  "definitions/agency-roas": "agencyRoas",
  "definitions/client-roas": "clientRoas",
  "definitions/lead": "countLeads",
  "definitions/booked": "bookedCounts",
  "definitions/showed": "countShowed",
  "definitions/show-rate": "showRate",
  "definitions/sale": "countSales",
  "definitions/close-rate": "closeRate",
  "definitions/client-status": "clientStatusCounts",
  "definitions/health": "clientHealth",
  "definitions/renewal": "renewalCounts",
  "definitions/plan-package-service": "committedPlanValue",
  "definitions/priority": "classifyPriority",
  "definitions/approved": "approvalState",
  "definitions/done": "isDone",
} as const satisfies Record<string, IrMetricName>;

export type IrCertifiedDefinitionSlug = keyof typeof IR_CERTIFIED_DEFINITION_FORMULAS;

/**
 * Resolves a GBrain `calculation:` pointer (`ir-metrics#showRate`). Returns
 * `none` for an explicit `none`, `missing` when the pointer names no function.
 */
export function resolveCalculationPointer(
  pointer: unknown,
): { kind: "metric"; definition: IrMetricDefinition } | { kind: "none" } | { kind: "missing"; pointer: string } {
  const raw = typeof pointer === "string" ? pointer.trim() : "";
  if (!raw || raw === "none") return { kind: "none" };
  const match = /^ir-metrics#([A-Za-z0-9]+)$/.exec(raw);
  const name = match?.[1];
  if (name && Object.prototype.hasOwnProperty.call(IR_METRIC_DEFINITIONS, name)) {
    return { kind: "metric", definition: IR_METRIC_DEFINITIONS[name as IrMetricName] };
  }
  return { kind: "missing", pointer: raw };
}

function normalizeDefinitionSlug(slug: unknown): string {
  const raw = typeof slug === "string" ? slug.trim().toLowerCase().replace(/\.md$/, "") : "";
  return raw.startsWith("definitions/") ? raw : `definitions/${raw}`;
}

/**
 * How a GBrain definition maps onto this library: by slug through
 * `IR_CERTIFIED_DEFINITION_FORMULAS` first, then by its own `calculation:`
 * pointer. A pointer that names no function is `missing` (broken) even when
 * the slug is registered, so a typo in the brain is never hidden.
 */
export function resolveDefinitionFormula(definition: {
  slug: unknown;
  calculation?: unknown;
}): { kind: "metric"; definition: IrMetricDefinition } | { kind: "none" } | { kind: "missing"; pointer: string } {
  const pointer = resolveCalculationPointer(definition.calculation);
  if (pointer.kind === "missing") return pointer;
  const slug = normalizeDefinitionSlug(definition.slug);
  if (Object.prototype.hasOwnProperty.call(IR_CERTIFIED_DEFINITION_FORMULAS, slug)) {
    const name = IR_CERTIFIED_DEFINITION_FORMULAS[slug as IrCertifiedDefinitionSlug];
    return { kind: "metric", definition: IR_METRIC_DEFINITIONS[name] };
  }
  return pointer;
}
