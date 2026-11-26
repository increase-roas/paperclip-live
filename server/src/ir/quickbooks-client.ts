import { createHash } from "node:crypto";
import type { DashboardPeriod } from "@paperclipai/shared";

export type QuickBooksDataSource = "quickbooks_gateway" | "quickbooks_composio";

export interface AgencyQuickBooksFinancials {
  period: DashboardPeriod;
  startDate: string;
  endDate: string;
  observedAt: string;
  source: QuickBooksDataSource;
  cashCollectedUsd: number | null;
  accrualRevenueUsd: number | null;
  cogsUsd: number | null;
  grossProfitUsd: number | null;
  grossMarginPercent: number | null;
  operatingExpensesUsd: number | null;
  totalExpensesUsd: number | null;
  netProfitUsd: number | null;
  advertisingSpendUsd: number | null;
  activeCustomerCount: number | null;
}

export interface QuickBooksClientOptions {
  baseUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  bypassCache?: boolean;
}

interface ParsedPnlSummary {
  totalIncome: number | null;
  cogs: number | null;
  grossProfit: number | null;
  operatingExpenses: number | null;
  netIncome: number | null;
  advertisingSpend: number | null;
}

const DEFAULT_GATEWAY_URL = "https://increase-roas-oauth-gateway.increase-roas.workers.dev";
const DEFAULT_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 5 * 60 * 1_000;
const USER_AGENT = "paperclip-server/1.0";

const cache = new Map<string, { at: number; value: AgencyQuickBooksFinancials | null }>();

export function resetQuickBooksCache(): void {
  cache.clear();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseMoney(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[$,\s]/g, "").replace(/^\((.*)\)$/, "-$1");
  if (!/^-?\d+(?:\.\d+)?$/.test(cleaned)) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDayUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function quickBooksPeriodRange(
  period: DashboardPeriod,
  now: Date,
): { startDate: string; endDate: string } {
  const endDate = formatDayUtc(now);
  if (period === "month") {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    return { startDate: formatDayUtc(start), endDate };
  }
  const days = period === "7d" ? 7 : 30;
  const start = new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
  return { startDate: formatDayUtc(start), endDate };
}

function findTotalColumnIndex(payload: Record<string, unknown>): number {
  const cols = isRecord(payload.Columns) && Array.isArray(payload.Columns.Column)
    ? payload.Columns.Column
    : [];
  if (cols.length >= 2) {
    for (let i = cols.length - 1; i >= 1; i -= 1) {
      const col = cols[i];
      if (!isRecord(col)) continue;
      const title = typeof col.ColTitle === "string" ? col.ColTitle.trim().toLowerCase() : "";
      if (title === "total" || title === "ytd" || title === "amount") return i;
    }
    return cols.length - 1;
  }
  return 1;
}

type PnlSectionGroup = "income" | "cogs" | "expenses" | "other_expenses" | "other";

function resolveSectionGroup(row: Record<string, unknown>, inherited: PnlSectionGroup): PnlSectionGroup {
  const rawGroup = typeof row.group === "string" ? row.group.trim().toLowerCase() : "";
  if (rawGroup === "income") return "income";
  if (rawGroup === "cogs") return "cogs";
  if (rawGroup === "expenses") return "expenses";
  if (rawGroup === "otherexpenses") return "other_expenses";

  const header = isRecord(row.Header) && Array.isArray(row.Header.ColData) ? row.Header.ColData : [];
  const summary = isRecord(row.Summary) && Array.isArray(row.Summary.ColData) ? row.Summary.ColData : [];
  const headerLabel =
    header.length > 0 && isRecord(header[0]) && typeof header[0].value === "string"
      ? header[0].value.trim().toLowerCase()
      : "";
  const summaryLabel =
    summary.length > 0 && isRecord(summary[0]) && typeof summary[0].value === "string"
      ? summary[0].value.trim().toLowerCase()
      : "";

  if (headerLabel === "income" || summaryLabel === "total income" || summaryLabel === "total revenue") {
    return "income";
  }
  if (
    headerLabel === "cost of goods sold" ||
    summaryLabel === "total cost of goods sold" ||
    summaryLabel === "total cogs"
  ) {
    return "cogs";
  }
  if (headerLabel === "expenses" || summaryLabel === "total expenses") {
    return "expenses";
  }
  if (headerLabel === "other expenses" || summaryLabel === "total other expenses") {
    return "other_expenses";
  }
  return inherited;
}

function readRowPair(
  colData: unknown,
  valueColIndex: number,
): { label: string; value: number } | null {
  if (!Array.isArray(colData) || colData.length < 2 || !isRecord(colData[0])) return null;
  const targetCol = colData[valueColIndex] ?? colData[colData.length - 1];
  if (!isRecord(targetCol)) return null;
  const label = typeof colData[0].value === "string" ? colData[0].value.trim().toLowerCase() : "";
  const amount = parseMoney(targetCol.value);
  if (!label || amount === null) return null;
  return { label, value: amount };
}

function walkPnlRows(
  rowsContainer: unknown,
  valueColIndex: number,
  inheritedGroup: PnlSectionGroup,
  summaries: Array<{ label: string; value: number }>,
  expenseLeafItems: Array<{ label: string; value: number }>,
  depth = 0,
): void {
  if (depth > 24 || !isRecord(rowsContainer)) return;
  const rowList = Array.isArray(rowsContainer.Row) ? rowsContainer.Row : [];
  for (const rawRow of rowList) {
    if (!isRecord(rawRow)) continue;
    const sectionGroup = resolveSectionGroup(rawRow, inheritedGroup);
    const hasNestedRows = isRecord(rawRow.Rows) && Array.isArray(rawRow.Rows.Row);
    const hasSummary = isRecord(rawRow.Summary);

    if (hasSummary) {
      const pair = readRowPair((rawRow.Summary as Record<string, unknown>).ColData, valueColIndex);
      if (pair) summaries.push(pair);
    }

    if (hasNestedRows) {
      walkPnlRows(
        rawRow.Rows,
        valueColIndex,
        sectionGroup,
        summaries,
        expenseLeafItems,
        depth + 1,
      );
      continue;
    }

    // Leaf data row only (never Summary or Header, and strictly inside Expense sections)
    if (!hasSummary && (sectionGroup === "expenses" || sectionGroup === "other_expenses")) {
      const pair = readRowPair(rawRow.ColData, valueColIndex);
      if (pair) expenseLeafItems.push(pair);
    }
  }
}

function findSummaryValue(
  rows: Array<{ label: string; value: number }>,
  labels: string[],
): number | null {
  for (const label of labels) {
    const hit = rows.find((r) => r.label === label);
    if (hit) return hit.value;
  }
  return null;
}

function unwrapQboReportPayload(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) return null;
  if (isRecord(raw.Rows) || isRecord(raw.Header)) return raw;
  // Gateway envelope: { ok, data: { Header, Columns, Rows } }
  if (isRecord(raw.data)) {
    const nested = unwrapQboReportPayload(raw.data);
    if (nested) return nested;
  }
  // Composio envelope: { data: { response_data: { ... } } } or { response_data: { ... } }
  if (isRecord(raw.response_data)) {
    const nested = unwrapQboReportPayload(raw.response_data);
    if (nested) return nested;
  }
  if (isRecord(raw.report)) {
    const nested = unwrapQboReportPayload(raw.report);
    if (nested) return nested;
  }
  return null;
}

export function parseQuickBooksProfitAndLoss(raw: unknown): ParsedPnlSummary | null {
  const payload = unwrapQboReportPayload(raw);
  if (!payload || !isRecord(payload.Rows)) return null;

  const valueColIndex = findTotalColumnIndex(payload);
  const summaries: Array<{ label: string; value: number }> = [];
  const expenseLeafItems: Array<{ label: string; value: number }> = [];
  walkPnlRows(payload.Rows, valueColIndex, "other", summaries, expenseLeafItems);

  const totalIncome = findSummaryValue(summaries, ["total income", "income", "total revenue"]);
  const cogs = findSummaryValue(summaries, ["total cost of goods sold", "total cogs", "cost of goods sold"]);
  const grossProfit = findSummaryValue(summaries, ["gross profit", "total gross profit"]);
  const operatingExpenses = findSummaryValue(summaries, ["total expenses", "expenses"]);
  const netIncome = findSummaryValue(summaries, ["net income", "net operating income", "net profit"]);

  if (totalIncome === null && cogs === null && operatingExpenses === null && netIncome === null) {
    return null;
  }

  let adSum = 0;
  let hasAdLine = false;
  for (const item of expenseLeafItems) {
    if (
      /\b(?:advertis(?:ing|ement)?|marketing|meta ads|facebook ads|google ads|paid ads|ad spend)\b/i.test(
        item.label,
      )
    ) {
      if (item.value > 0) {
        adSum += item.value;
        hasAdLine = true;
      }
    }
  }

  return {
    totalIncome: totalIncome !== null ? round2(totalIncome) : null,
    cogs: cogs !== null ? round2(cogs) : null,
    grossProfit:
      grossProfit !== null
        ? round2(grossProfit)
        : totalIncome !== null && cogs !== null
          ? round2(totalIncome - cogs)
          : null,
    operatingExpenses: operatingExpenses !== null ? round2(operatingExpenses) : null,
    netIncome: netIncome !== null ? round2(netIncome) : null,
    advertisingSpend: hasAdLine ? round2(adSum) : null,
  };
}

function extractQueryEntities(raw: unknown, key: "Payment" | "Invoice"): Array<Record<string, unknown>> {
  if (!isRecord(raw)) return [];
  const inner = isRecord(raw.data) ? raw.data : raw;
  const qr = isRecord(inner.QueryResponse) ? inner.QueryResponse : inner;
  const arr = qr[key];
  if (!Array.isArray(arr)) return [];
  return arr.filter((item): item is Record<string, unknown> => isRecord(item));
}

async function callGatewayProvider(
  baseUrl: string,
  token: string,
  provider: "quickbooks" | "composio",
  payload: Record<string, unknown>,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${baseUrl}/api/providers/${provider}/call`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": USER_AGENT,
      },
      body: JSON.stringify(payload),
      redirect: "manual",
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed: Record<string, unknown> | null = null;
    try {
      const json = text ? JSON.parse(text) : null;
      if (isRecord(json)) parsed = json;
    } catch {
      parsed = null;
    }
    return {
      ok: res.ok && parsed?.ok !== false,
      status: res.status,
      body: parsed,
    };
  } catch {
    return { ok: false, status: 0, body: null };
  } finally {
    clearTimeout(timer);
  }
}

function assembleFinancials(
  period: DashboardPeriod,
  startDate: string,
  endDate: string,
  observedAt: string,
  source: QuickBooksDataSource,
  cashPnl: ParsedPnlSummary | null,
  accrualPnl: ParsedPnlSummary | null,
  payments: Array<Record<string, unknown>>,
  invoices: Array<Record<string, unknown>>,
): AgencyQuickBooksFinancials | null {
  let paymentTotal = 0;
  let hasPayments = false;
  const customerIds = new Set<string>();

  for (const p of payments) {
    const amt = parseMoney(p.TotalAmt);
    if (amt !== null && amt >= 0) {
      paymentTotal += amt;
      hasPayments = true;
    }
    const cust = isRecord(p.CustomerRef) ? p.CustomerRef.value : null;
    if (typeof cust === "string" && cust.trim()) customerIds.add(cust.trim());
  }
  for (const inv of invoices) {
    const cust = isRecord(inv.CustomerRef) ? inv.CustomerRef.value : null;
    if (typeof cust === "string" && cust.trim()) customerIds.add(cust.trim());
  }

  const cashCollectedUsd =
    cashPnl?.totalIncome !== null && cashPnl?.totalIncome !== undefined
      ? cashPnl.totalIncome
      : hasPayments
        ? round2(paymentTotal)
        : null;

  const accrualRevenueUsd =
    accrualPnl?.totalIncome !== null && accrualPnl?.totalIncome !== undefined
      ? accrualPnl.totalIncome
      : cashCollectedUsd;

  const marginPnl = accrualPnl ?? cashPnl;
  if (cashCollectedUsd === null && accrualRevenueUsd === null && !marginPnl) {
    return null;
  }

  // Keep margin, COGS, expenses, and net profit on ONE consistent accounting basis
  // (Accrual when available, else Cash) so gross margin never divides Cash GP by Accrual revenue.
  const revForMargin = marginPnl?.totalIncome ?? null;
  const cogsUsd = marginPnl?.cogs ?? null;
  const operatingExpensesUsd = marginPnl?.operatingExpenses ?? null;
  const totalExpensesUsd =
    cogsUsd !== null || operatingExpensesUsd !== null
      ? round2((cogsUsd ?? 0) + (operatingExpensesUsd ?? 0))
      : null;

  const grossProfitUsd =
    marginPnl?.grossProfit ??
    (revForMargin !== null && cogsUsd !== null ? round2(revForMargin - cogsUsd) : null);

  let grossMarginPercent: number | null = null;
  if (revForMargin !== null && revForMargin > 0) {
    if (grossProfitUsd !== null) {
      grossMarginPercent = round1((grossProfitUsd / revForMargin) * 100);
    } else if (cogsUsd !== null) {
      grossMarginPercent = round1(((revForMargin - cogsUsd) / revForMargin) * 100);
    }
  }

  const netProfitUsd =
    marginPnl?.netIncome ??
    (revForMargin !== null && totalExpensesUsd !== null
      ? round2(revForMargin - totalExpensesUsd)
      : null);

  const advertisingSpendUsd = marginPnl?.advertisingSpend ?? cashPnl?.advertisingSpend ?? null;

  return {
    period,
    startDate,
    endDate,
    observedAt,
    source,
    cashCollectedUsd,
    accrualRevenueUsd,
    cogsUsd,
    grossProfitUsd,
    grossMarginPercent,
    operatingExpensesUsd,
    totalExpensesUsd,
    netProfitUsd,
    advertisingSpendUsd,
    activeCustomerCount: customerIds.size > 0 ? customerIds.size : null,
  };
}

/**
 * Reads agency-level accounting data from QuickBooks Online via the OAuth Gateway.
 *
 * 1. Tries native Gateway `quickbooks` provider first (OAuth 2.0 direct to Intuit).
 * 2. Gracefully falls back to Gateway's `composio` bridge (`QUICKBOOKS_GET_PROFIT_AND_LOSS_REPORT`)
 *    until Alex completes 1-click OAuth Connect on native QuickBooks.
 * 3. Fails closed to `null` when neither is connected so CEO Money tiles never invent fake zeros.
 */
export async function readAgencyQuickBooksFinancials(
  period: DashboardPeriod = "30d",
  opts: QuickBooksClientOptions = {},
): Promise<AgencyQuickBooksFinancials | null> {
  const token = (
    opts.token !== undefined
      ? opts.token
      : (process.env.GATEWAY_PAPERCLIP_KEY ?? process.env.GATEWAY_QUICKBOOKS_KEY ?? "")
  ).trim();
  if (!token) return null;

  const baseUrl = (opts.baseUrl ?? process.env.OAUTH_GATEWAY_URL ?? DEFAULT_GATEWAY_URL)
    .trim()
    .replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = (opts.now ?? (() => new Date()))();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tokenFp = createHash("sha256").update(token).digest("hex").slice(0, 16);
  const cacheKey = `${baseUrl}|${period}|${tokenFp}`;

  if (!opts.bypassCache) {
    const cached = cache.get(cacheKey);
    if (cached && now.getTime() - cached.at < CACHE_TTL_MS) {
      return cached.value;
    }
  }

  const { startDate, endDate } = quickBooksPeriodRange(period, now);
  const observedAt = now.toISOString();

  // 1. Primary: Native QuickBooks Online provider on OAuth Gateway
  const [cashPnlRes, accrualPnlRes, paymentsRes, invoicesRes] = await Promise.all([
    callGatewayProvider(
      baseUrl,
      token,
      "quickbooks",
      {
        method: "GET",
        path: "/reports/ProfitAndLoss",
        action: "reports",
        query: {
          start_date: startDate,
          end_date: endDate,
          accounting_method: "Cash",
          minorversion: "75",
        },
      },
      fetchImpl,
      timeoutMs,
    ),
    callGatewayProvider(
      baseUrl,
      token,
      "quickbooks",
      {
        method: "GET",
        path: "/reports/ProfitAndLoss",
        action: "reports",
        query: {
          start_date: startDate,
          end_date: endDate,
          accounting_method: "Accrual",
          minorversion: "75",
        },
      },
      fetchImpl,
      timeoutMs,
    ),
    callGatewayProvider(
      baseUrl,
      token,
      "quickbooks",
      {
        method: "GET",
        path: "/query",
        action: "query",
        query: {
          query: `SELECT * FROM Payment WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}' MAXRESULTS 500`,
          minorversion: "75",
        },
      },
      fetchImpl,
      timeoutMs,
    ),
    callGatewayProvider(
      baseUrl,
      token,
      "quickbooks",
      {
        method: "GET",
        path: "/query",
        action: "query",
        query: {
          query: `SELECT * FROM Invoice WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}' MAXRESULTS 500`,
          minorversion: "75",
        },
      },
      fetchImpl,
      timeoutMs,
    ),
  ]);

  if (cashPnlRes.ok || accrualPnlRes.ok || paymentsRes.ok) {
    const nativeResult = assembleFinancials(
      period,
      startDate,
      endDate,
      observedAt,
      "quickbooks_gateway",
      cashPnlRes.ok ? parseQuickBooksProfitAndLoss(cashPnlRes.body) : null,
      accrualPnlRes.ok ? parseQuickBooksProfitAndLoss(accrualPnlRes.body) : null,
      paymentsRes.ok ? extractQueryEntities(paymentsRes.body, "Payment") : [],
      invoicesRes.ok ? extractQueryEntities(invoicesRes.body, "Invoice") : [],
    );
    if (nativeResult) {
      if (!opts.bypassCache) cache.set(cacheKey, { at: now.getTime(), value: nativeResult });
      return nativeResult;
    }
  }

  // 2. Graceful fallback: Gateway's Composio bridge until native QuickBooks is connected
  // Auto-discover active QuickBooks connected_account_id + user_id from Composio v3 so
  // project-scoped API keys execute against the connected QuickBooks account cleanly.
  let composioAccountId = (process.env.COMPOSIO_QUICKBOOKS_ACCOUNT_ID ?? "").trim();
  let composioUserId = (process.env.COMPOSIO_QUICKBOOKS_USER_ID ?? "").trim();
  if (!composioAccountId) {
    const accountsRes = await callGatewayProvider(
      baseUrl,
      token,
      "composio",
      {
        method: "GET",
        path: "/connected_accounts",
        action: "accounts",
        query: {
          toolkit_slugs: "quickbooks",
          statuses: "ACTIVE",
        },
      },
      fetchImpl,
      timeoutMs,
    );
    const items =
      accountsRes.ok && isRecord(accountsRes.body?.data) && Array.isArray(accountsRes.body.data.items)
        ? accountsRes.body.data.items
        : [];
    const firstActive = items.find((item) => isRecord(item) && typeof item.id === "string");
    if (isRecord(firstActive)) {
      composioAccountId = typeof firstActive.id === "string" ? firstActive.id.trim() : "";
      if (!composioUserId && typeof firstActive.user_id === "string") {
        composioUserId = firstActive.user_id.trim();
      }
    }
  }

  const composioAuthBody: Record<string, string> = {};
  if (composioAccountId) composioAuthBody.connected_account_id = composioAccountId;
  if (composioUserId) composioAuthBody.user_id = composioUserId;

  const [compCashRes, compAccrualRes] = await Promise.all([
    callGatewayProvider(
      baseUrl,
      token,
      "composio",
      {
        method: "POST",
        path: "/tools/execute/QUICKBOOKS_GET_PROFIT_AND_LOSS_REPORT",
        action: "tools",
        body: {
          ...composioAuthBody,
          arguments: {
            start_date: startDate,
            end_date: endDate,
            accounting_method: "Cash",
          },
        },
      },
      fetchImpl,
      timeoutMs,
    ),
    callGatewayProvider(
      baseUrl,
      token,
      "composio",
      {
        method: "POST",
        path: "/tools/execute/QUICKBOOKS_GET_PROFIT_AND_LOSS_REPORT",
        action: "tools",
        body: {
          ...composioAuthBody,
          arguments: {
            start_date: startDate,
            end_date: endDate,
            accounting_method: "Accrual",
          },
        },
      },
      fetchImpl,
      timeoutMs,
    ),
  ]);

  const fallbackResult = assembleFinancials(
    period,
    startDate,
    endDate,
    observedAt,
    "quickbooks_composio",
    compCashRes.ok ? parseQuickBooksProfitAndLoss(compCashRes.body) : null,
    compAccrualRes.ok ? parseQuickBooksProfitAndLoss(compAccrualRes.body) : null,
    [],
    [],
  );

  // Never negative-cache null for 5m so connecting QuickBooks immediately unlocks CEO tiles.
  if (fallbackResult && !opts.bypassCache) {
    cache.set(cacheKey, { at: now.getTime(), value: fallbackResult });
  }
  return fallbackResult;
}
