import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseQuickBooksProfitAndLoss,
  quickBooksPeriodRange,
  readAgencyQuickBooksFinancials,
  resetQuickBooksCache,
} from "../quickbooks-client.js";

const pinnedNow = new Date("2026-11-25T18:00:00.000Z");

const SAMPLE_PNL_CASH = {
  Header: { ReportName: "ProfitAndLoss", ReportBasis: "Cash" },
  Columns: { Column: [{ ColTitle: "" }, { ColTitle: "Total" }] },
  Rows: {
    Row: [
      {
        type: "Section",
        group: "Income",
        Header: { ColData: [{ value: "Income" }, { value: "" }] },
        Rows: {
          Row: [
            // Agency marketing revenue must NEVER be counted as advertisingSpend!
            { ColData: [{ value: "Marketing Retainers" }, { value: "40000.00" }] },
            { ColData: [{ value: "Paid Ads Management" }, { value: "20000.00" }] },
          ],
        },
        Summary: { ColData: [{ value: "Total Income" }, { value: "60000.00" }] },
      },
      {
        type: "Section",
        group: "COGS",
        Summary: { ColData: [{ value: "Total Cost of Goods Sold" }, { value: "15000.00" }] },
      },
      {
        type: "Section",
        Summary: { ColData: [{ value: "Gross Profit" }, { value: "45000.00" }] },
      },
      {
        type: "Section",
        group: "Expenses",
        Header: { ColData: [{ value: "Expenses" }, { value: "" }] },
        Rows: {
          Row: [
            {
              type: "Section",
              Header: { ColData: [{ value: "Advertising & Marketing" }, { value: "" }] },
              Rows: {
                Row: [
                  { ColData: [{ value: "Advertising" }, { value: "3000.00" }] },
                  { ColData: [{ value: "Meta Ads" }, { value: "2000.00" }] },
                ],
              },
              // Nested sub-account summary must NOT be double-counted on top of leaf rows!
              Summary: { ColData: [{ value: "Total Advertising & Marketing" }, { value: "5000.00" }] },
            },
            { ColData: [{ value: "Software & Hosting" }, { value: "3000.00" }] },
          ],
        },
        Summary: { ColData: [{ value: "Total Expenses" }, { value: "8000.00" }] },
      },
      {
        type: "Section",
        Summary: { ColData: [{ value: "Net Income" }, { value: "37000.00" }] },
      },
    ],
  },
};

describe("quickbooks-client", () => {
  beforeEach(() => {
    resetQuickBooksCache();
  });

  it("computes UTC date bounds for 7d, 30d, and month", () => {
    expect(quickBooksPeriodRange("7d", pinnedNow)).toEqual({
      startDate: "2026-11-19",
      endDate: "2026-11-25",
    });
    expect(quickBooksPeriodRange("30d", pinnedNow)).toEqual({
      startDate: "2026-10-27",
      endDate: "2026-11-25",
    });
    expect(quickBooksPeriodRange("month", pinnedNow)).toEqual({
      startDate: "2026-11-01",
      endDate: "2026-11-25",
    });
  });

  it.each([
    ["7d", "2026-02-23"],
    ["30d", "2026-01-31"],
  ] as const)("requests exactly %s calendar dates including today", async (period, startDate) => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ ok: true, data: SAMPLE_PNL_CASH }), { status: 200 }));
    await readAgencyQuickBooksFinancials(period, {
      baseUrl: "https://gw.example",
      token: "paperclip-test-key",
      fetchImpl: fetchMock,
      now: () => new Date("2026-03-01T00:01:00.000Z"),
      bypassCache: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const [, init] of fetchMock.mock.calls) {
      const body = JSON.parse(String(init?.body));
      if (body.path === "/reports/ProfitAndLoss") {
        expect(body.query).toMatchObject({ start_date: startDate, end_date: "2026-03-01" });
      } else {
        expect(body.query.query).toContain(`TxnDate >= '${startDate}' AND TxnDate <= '2026-03-01'`);
      }
    }
  });

  it("parses QuickBooks ProfitAndLoss across Gateway and Composio envelopes", () => {
    const fromGateway = parseQuickBooksProfitAndLoss({ ok: true, data: SAMPLE_PNL_CASH });
    expect(fromGateway).toEqual({
      totalIncome: 60000,
      cogs: 15000,
      grossProfit: 45000,
      operatingExpenses: 8000,
      netIncome: 37000,
      advertisingSpend: 5000,
    });

    const fromComposio = parseQuickBooksProfitAndLoss({
      ok: true,
      data: { response_data: SAMPLE_PNL_CASH },
    });
    expect(fromComposio).toEqual(fromGateway);
  });

  it("reads native Gateway quickbooks provider first without calling composio fallback", async () => {
    const calledProviders: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (target.includes("/api/providers/quickbooks/call")) {
        calledProviders.push("quickbooks");
        if (body.path === "/reports/ProfitAndLoss") {
          return new Response(JSON.stringify({ ok: true, data: SAMPLE_PNL_CASH }), { status: 200 });
        }
        if (body.path === "/query" && String(body.query?.query).includes("FROM Payment")) {
          return new Response(
            JSON.stringify({
              ok: true,
              data: {
                QueryResponse: {
                  Payment: [
                    { TotalAmt: 30000, CustomerRef: { value: "cust-1" } },
                    { TotalAmt: 30000, CustomerRef: { value: "cust-2" } },
                  ],
                },
              },
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ ok: true, data: { QueryResponse: { Invoice: [] } } }), {
          status: 200,
        });
      }
      calledProviders.push("other");
      return new Response("{}", { status: 503 });
    });

    const res = await readAgencyQuickBooksFinancials("30d", {
      baseUrl: "https://gw.example",
      token: "paperclip-gw-key",
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => pinnedNow,
      bypassCache: true,
    });

    expect(calledProviders.every((p) => p === "quickbooks")).toBe(true);
    expect(res).toMatchObject({
      source: "quickbooks_gateway",
      cashCollectedUsd: 60000,
      accrualRevenueUsd: 60000,
      cogsUsd: 15000,
      grossProfitUsd: 45000,
      grossMarginPercent: 75,
      operatingExpensesUsd: 8000,
      totalExpensesUsd: 23000,
      netProfitUsd: 37000,
      advertisingSpendUsd: 5000,
      activeCustomerCount: 2,
    });
  });

  it("gracefully falls back to Gateway composio bridge when native quickbooks is not connected yet", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes("/api/providers/quickbooks/call")) {
        return new Response(JSON.stringify({ error: "provider_not_connected" }), { status: 503 });
      }
      if (target.includes("/api/providers/composio/call")) {
        return new Response(
          JSON.stringify({ ok: true, data: { response_data: SAMPLE_PNL_CASH } }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    });

    const res = await readAgencyQuickBooksFinancials("30d", {
      baseUrl: "https://gw.example",
      token: "paperclip-gw-key",
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => pinnedNow,
      bypassCache: true,
    });

    expect(res).toMatchObject({
      source: "quickbooks_composio",
      cashCollectedUsd: 60000,
      grossMarginPercent: 75,
    });
  });

  it("keeps gross margin and net profit on a consistent accounting basis and never negative-caches null", async () => {
    const accrualPnl = {
      Header: { ReportName: "ProfitAndLoss", ReportBasis: "Accrual" },
      Columns: { Column: [{ ColTitle: "" }, { ColTitle: "Total" }] },
      Rows: {
        Row: [
          { type: "Section", group: "Income", Summary: { ColData: [{ value: "Total Income" }, { value: "100000.00" }] } },
          { type: "Section", group: "COGS", Summary: { ColData: [{ value: "Total Cost of Goods Sold" }, { value: "20000.00" }] } },
          { type: "Section", Summary: { ColData: [{ value: "Gross Profit" }, { value: "80000.00" }] } },
          { type: "Section", group: "Expenses", Summary: { ColData: [{ value: "Total Expenses" }, { value: "10000.00" }] } },
          { type: "Section", Summary: { ColData: [{ value: "Net Income" }, { value: "70000.00" }] } },
        ],
      },
    };
    let connected = false;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (!connected) return new Response("{}", { status: 503 });
      const target = String(url);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (target.includes("/api/providers/quickbooks/call") && body.path === "/reports/ProfitAndLoss") {
        const method = body.query?.accounting_method;
        return new Response(
          JSON.stringify({ ok: true, data: method === "Accrual" ? accrualPnl : SAMPLE_PNL_CASH }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true, data: { QueryResponse: {} } }), { status: 200 });
    });

    // First call while disconnected returns null (must NOT be cached for 5 minutes)
    expect(
      await readAgencyQuickBooksFinancials("30d", {
        baseUrl: "https://gw.example",
        token: "tok-a",
        fetchImpl: fetchMock as unknown as typeof fetch,
        now: () => pinnedNow,
      }),
    ).toBeNull();

    // Immediately after connecting, next call succeeds with consistent Accrual margin (80%, not 45k/100k = 45%)
    connected = true;
    const live = await readAgencyQuickBooksFinancials("30d", {
      baseUrl: "https://gw.example",
      token: "tok-a",
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => pinnedNow,
    });
    expect(live).toMatchObject({
      cashCollectedUsd: 60000,
      accrualRevenueUsd: 100000,
      cogsUsd: 20000,
      grossProfitUsd: 80000,
      grossMarginPercent: 80,
      netProfitUsd: 70000,
    });
  });

  it("fails closed to null when token is absent or both native quickbooks and composio fail", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 503 }));
    expect(
      await readAgencyQuickBooksFinancials("30d", {
        token: "",
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    expect(
      await readAgencyQuickBooksFinancials("30d", {
        baseUrl: "https://gw.example",
        token: "paperclip-gw-key",
        fetchImpl: fetchMock as unknown as typeof fetch,
        bypassCache: true,
      }),
    ).toBeNull();
  });
});
