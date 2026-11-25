import { describe, expect, it, vi } from "vitest";
import { buildCeoAndReadingOrder, ceoBoardService } from "../ceo-board.js";
import type { PortfolioSnapshotBundle } from "../sales-dashboard-client.js";
import { readWavvSummary } from "../wavv-client.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const pinnedNow = new Date("2026-11-23T12:00:00.000Z");

describe("ceoBoardService & readingOrder", () => {
  it("returns honest not_connected CEO tiles and unknown readingOrder when offline", async () => {
    const svc = ceoBoardService(() => pinnedNow, { adminKey: "" });
    const ceo = await svc.ceoBoard(companyId, "30d");
    expect(ceo.companyId).toBe(companyId);
    expect(ceo.period).toBe("30d");
    expect(ceo.moneyTiles.map((t) => t.id)).toEqual([
      "cash-collected",
      "30-day-cash-multiple",
      "ltgp-cac",
      "gross-margin",
      "churn",
      "cac-payback",
    ]);
    for (const tile of ceo.moneyTiles) {
      expect(tile.value).toEqual({ kind: "not_connected" });
      expect(tile.state).toBe("unknown");
    }

    const ro = await svc.readingOrder(companyId, "30d");
    expect(ro.statuses).toEqual({
      cash: "unknown",
      "cash-multiple": "unknown",
      "ltgp-cac": "unknown",
      "gross-margin": "unknown",
      churn: "unknown",
      "show-rate": "unknown",
      "speed-to-lead": "unknown",
      cac: "unknown",
    });
  });

  it("computes live CEO money tiles and evaluates all Hormozi readingOrder thresholds", () => {
    const bundle: PortfolioSnapshotBundle = {
      observedAt: "2026-11-23T11:30:00.000Z",
      capital: {
        generatedAt: "2026-11-23T11:30:00.000Z",
        view: "30d",
        members: [],
        operating: {
          monthlyLaborUsd: 8000,
          monthlyOverheadUsd: 2000,
          monthlyBurnUsd: 10000,
          runwayMonths: 5,
        },
        owner: {
          slug: "__owner__",
          displayName: "IR / HTL owner",
          syncedAt: "2026-11-23T11:30:00.000Z",
          syncStatus: "success",
          marketing: {
            cashCollectedUsd: 50000,
            salesUsd: 50000,
            expensesUsd: 18000,
            adSpendUsd: 2000,
            cacUsd: 1000,
            netProfitUsd: 32000,
            grossMarginPercent: 0.64,
            grossProfitPerWonDealUsd: 8000,
            cacPaybackDeals: 0.5,
            evidence: { financial: true, marketing: true },
          },
          financialMonth: null,
        },
        clients: [],
      },
      snapshots: null,
      neonAccounts: null,
      neonPipeline: null,
      clients: [
        {
          slug: "paradise-spas",
          displayName: "Paradise Spas",
          observedAt: "2026-11-23T11:30:00.000Z",
          newLeads: 100,
          booked: 40,
          showed: 30,
          pitched: 25,
          wonDeals: 8,
          showRate: 75,
          closeRate: 32,
          pipelineRevenueUsd: 40000,
          cashCollectedUsd: null,
          speedToLeadSeconds: 45,
          spend: 4000,
          impressions: 50000,
          clicks: 1500,
          cpl: 40,
          cac: 500,
          roas: 10,
          costPerHeldAppointment: 133.33,
          zeroLeadDays: 0,
        },
      ],
    };

    const { ceo, readingOrder } = buildCeoAndReadingOrder(companyId, "30d", bundle, pinnedNow);
    const tiles = new Map(ceo.moneyTiles.map((t) => [t.id, t]));

    expect(tiles.get("cash-collected")?.value).toMatchObject({ kind: "live", value: 50000, unit: "usd" });
    expect(tiles.get("cash-collected")?.state).toBe("ok");
    expect(tiles.get("cash-collected")?.href).toBeUndefined();

    // Agency-only: 50000 / (18000 + 2000) = 2.5 (never mixes Paradise Spas' $4,000 client ad spend)
    expect(tiles.get("30-day-cash-multiple")?.value).toMatchObject({ kind: "live", value: 2.5, unit: "ratio" });
    expect(tiles.get("30-day-cash-multiple")?.state).toBe("ok");

    // Agency-only: 8000 / 1000 = 8:1 (never divides by Paradise Spas' $500 client CPA)
    expect(tiles.get("ltgp-cac")?.value).toMatchObject({ kind: "live", value: 8, unit: "ratio" });
    expect(tiles.get("ltgp-cac")?.state).toBe("ok");

    // 0.64 -> 64% >= 50% => ok
    expect(tiles.get("gross-margin")?.value).toMatchObject({ kind: "live", value: 64, unit: "percent" });
    expect(tiles.get("gross-margin")?.state).toBe("ok");

    expect(tiles.get("churn")?.value).toEqual({ kind: "not_connected" });
    expect(tiles.get("churn")?.state).toBe("unknown");
    expect(tiles.get("churn")?.href).toBe("/dashboard/fulfillment");

    expect(tiles.get("cac-payback")?.value).toMatchObject({ kind: "live", value: 0.5, unit: "ratio" });
    expect(tiles.get("cac-payback")?.state).toBe("ok");
    expect(tiles.get("cac-payback")?.href).toBe("/dashboard/marketing");

    // No plural /dashboards/* 404 links anywhere on CEO tiles
    for (const tile of ceo.moneyTiles) {
      if (tile.href) expect(tile.href).toMatch(/^\/dashboard\//);
    }

    expect(readingOrder.statuses).toEqual({
      cash: "ok",
      "cash-multiple": "ok",
      "ltgp-cac": "ok",
      "gross-margin": "ok",
      churn: "unknown",
      "show-rate": "ok",
      "speed-to-lead": "ok",
      cac: "ok",
    });
    expect(readingOrder.metrics["show-rate"]?.displayValue).toBe("75%");
    expect(readingOrder.metrics["speed-to-lead"]?.displayValue).toBe("45s");
    // Reading Order #8 (Marketing) shows client portfolio CPA ($4000 / 8 = $500)
    expect(readingOrder.metrics.cac?.displayValue).toBe("$500");
    // Disconnected churn step is omitted from metrics so ReadingOrderStrip doesn't duplicate "Not connected"
    expect(readingOrder.metrics.churn).toBeUndefined();
  });

  it("flags red thresholds for show-rate < 60%, speed-to-lead > 300s, gross-margin < 50%, cash-multiple < 2", () => {
    const bundle: PortfolioSnapshotBundle = {
      observedAt: "2026-11-23T11:30:00.000Z",
      capital: {
        generatedAt: "2026-11-23T11:30:00.000Z",
        view: "30d",
        members: [],
        operating: null,
        owner: {
          slug: "__owner__",
          displayName: "IR / HTL owner",
          syncedAt: "2026-11-23T11:30:00.000Z",
          syncStatus: "success",
          marketing: {
            cashCollectedUsd: 10000,
            salesUsd: 10000,
            expensesUsd: 6500,
            netProfitUsd: 3500,
            grossMarginPercent: 0.35,
            evidence: { financial: true },
          },
          financialMonth: null,
        },
        clients: [],
      },
      snapshots: null,
      neonAccounts: null,
      neonPipeline: null,
      clients: [
        {
          slug: "sun-pool",
          displayName: "Sun Pool",
          observedAt: "2026-11-23T11:30:00.000Z",
          newLeads: 50,
          booked: 20,
          showed: 10,
          pitched: null,
          wonDeals: 0,
          showRate: 50,
          closeRate: null,
          pipelineRevenueUsd: null,
          cashCollectedUsd: null,
          speedToLeadSeconds: 420,
          spend: 2000,
          impressions: null,
          clicks: null,
          cpl: 40,
          cac: null,
          roas: null,
          costPerHeldAppointment: 200,
          zeroLeadDays: null,
        },
      ],
    };

    const { readingOrder } = buildCeoAndReadingOrder(companyId, "30d", bundle, pinnedNow);
    expect(readingOrder.statuses["cash-multiple"]).toBe("red");
    expect(readingOrder.statuses["gross-margin"]).toBe("red");
    expect(readingOrder.statuses["show-rate"]).toBe("red");
    expect(readingOrder.statuses["speed-to-lead"]).toBe("red");
    expect(readingOrder.statuses.cac).toBe("unknown");
  });

  it("populates agency CEO money tiles from QuickBooks via Gateway without mixing client revenue", () => {
    const emptyOwnerBundle: PortfolioSnapshotBundle = {
      observedAt: "2026-11-25T17:00:00.000Z",
      capital: null,
      snapshots: null,
      neonAccounts: null,
      neonPipeline: null,
      clients: [
        {
          slug: "paradise-spas",
          displayName: "Paradise Spas",
          observedAt: "2026-11-25T17:00:00.000Z",
          newLeads: 50,
          booked: 20,
          showed: 15,
          pitched: 12,
          wonDeals: 4,
          showRate: 75,
          closeRate: 33.3,
          pipelineRevenueUsd: 250000,
          cashCollectedUsd: 250000,
          speedToLeadSeconds: 30,
          spend: 4000,
          impressions: 20000,
          clicks: 500,
          cpl: 80,
          cac: 1000,
          roas: 62.5,
          costPerHeldAppointment: 266.67,
          zeroLeadDays: 0,
        },
      ],
    };

    const { ceo, readingOrder } = buildCeoAndReadingOrder(companyId, "30d", emptyOwnerBundle, pinnedNow, {
      period: "30d",
      startDate: "2026-10-26",
      endDate: "2026-11-25",
      observedAt: "2026-11-25T18:00:00.000Z",
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
      activeCustomerCount: 5,
    });

    const tiles = new Map(ceo.moneyTiles.map((t) => [t.id, t]));
    // Strictly agency QBO $60,000 (never mixes Paradise Spas' $250,000 client cash)
    expect(tiles.get("cash-collected")?.value).toMatchObject({ kind: "live", value: 60000, unit: "usd" });
    expect(tiles.get("cash-collected")?.source).toBe("QuickBooks Online (Gateway)");
    expect(tiles.get("gross-margin")?.value).toMatchObject({ kind: "live", value: 75, unit: "percent" });
    // 60000 / (15000 COGS + 5000 agency ad spend) = 3.0x
    expect(tiles.get("30-day-cash-multiple")?.value).toMatchObject({ kind: "live", value: 3, unit: "ratio" });
    // All-time LTGP:CAC & cohort CAC payback fail closed without verified owner cohort metrics
    expect(tiles.get("ltgp-cac")?.value).toEqual({ kind: "not_connected" });
    expect(tiles.get("cac-payback")?.value).toEqual({ kind: "not_connected" });
    expect(tiles.get("churn")?.value).toEqual({ kind: "not_connected" });
    expect(readingOrder.statuses.cash).toBe("ok");
    expect(readingOrder.statuses["gross-margin"]).toBe("ok");

    // When QBO has COGS but no ad spend line, 30-day cash multiple uses totalExpensesUsd (never fake $0 CAC)
    const noAdRes = buildCeoAndReadingOrder(companyId, "30d", emptyOwnerBundle, pinnedNow, {
      period: "30d",
      startDate: "2026-10-26",
      endDate: "2026-11-25",
      observedAt: "2026-11-25T18:00:00.000Z",
      source: "quickbooks_gateway",
      cashCollectedUsd: 60000,
      accrualRevenueUsd: 60000,
      cogsUsd: 15000,
      grossProfitUsd: 45000,
      grossMarginPercent: 75,
      operatingExpensesUsd: 15000,
      totalExpensesUsd: 30000,
      netProfitUsd: 30000,
      advertisingSpendUsd: null,
      activeCustomerCount: 5,
    });
    const noAdTiles = new Map(noAdRes.ceo.moneyTiles.map((t) => [t.id, t]));
    // 60000 / 30000 totalExpenses = 2.0x (not 60000 / 15000 = 4.0x!)
    expect(noAdTiles.get("30-day-cash-multiple")?.value).toMatchObject({ kind: "live", value: 2, unit: "ratio" });
  });
});

describe("readWavvSummary", () => {
  it("returns null when neither GATEWAY_PAPERCLIP_KEY nor GATEWAY_WAVV_KEY is set", async () => {
    const fetchMock = vi.fn();
    const res = await readWavvSummary("30d", {
      token: "",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(res).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads /api/wavv/captured with User-Agent and aggregates dials, conversations > 60s and talk time", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain("/api/wavv/captured?since=");
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers["user-agent"]).toBe("paperclip-server/1.0");
      expect(headers.authorization).toBe("Bearer paperclip-gw-key");
      return new Response(
        JSON.stringify({
          calls: [
            { id: "c1", direction: "outbound", userId: "setter-1", userName: "Ana", seconds: 90, startedAt: "2026-11-23T10:00:00.000Z" },
            { id: "c2", direction: "outbound", userId: "setter-1", userName: "Ana", seconds: 30, startedAt: "2026-11-23T11:00:00.000Z" },
            { id: "c3", direction: "inbound", userId: "setter-2", userName: "Ben", seconds: 120, startedAt: "2026-11-23T11:15:00.000Z" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const summary = await readWavvSummary("7d", {
      baseUrl: "https://gw.example",
      token: "paperclip-gw-key",
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => pinnedNow,
    });

    expect(summary).not.toBeNull();
    expect(summary?.dials).toBe(2);
    expect(summary?.conversationsOver60s).toBe(2);
    expect(summary?.talkTimeMinutes).toBe(4);
    expect(summary?.observedAt).toBe("2026-11-23T11:15:00.000Z");
    expect(summary?.bySetter).toHaveLength(2);
    expect(summary?.bySetter[0]).toMatchObject({ id: "setter-1", setter: "Ana", dials: 2, conversationsOver60s: 1 });
  });

  it("falls back to /api/wavv/teams + /api/wavv/:team/calls and returns null when 0 calls exist", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes("/api/wavv/captured")) {
        return new Response(JSON.stringify({ calls: [] }), { status: 200 });
      }
      if (target.includes("/api/wavv/teams")) {
        return new Response(JSON.stringify({ teams: ["main"] }), { status: 200 });
      }
      if (target.includes("/api/wavv/main/calls")) {
        return new Response(JSON.stringify({ team: "main", data: [] }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    });

    const summary = await readWavvSummary("30d", {
      baseUrl: "https://gw.example",
      token: "paperclip-gw-key",
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => pinnedNow,
    });

    expect(summary).toBeNull();
  });
});
