import type { Db } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import type { MergedClientMetrics, PortfolioSnapshotBundle } from "../ir/sales-dashboard-client.js";
import { dashboardFulfillmentService } from "./dashboard-fulfillment.js";

function queryResult<T>(rows: T[]) {
  const result = Promise.resolve(rows);
  return Object.assign(result, {
    from: () => result,
    leftJoin: () => result,
    where: () => result,
    orderBy: () => result,
  });
}

function boardForProjects(projectIds: Array<string | null>) {
  const now = new Date("2026-11-26T00:00:00Z");
  const rows = projectIds.map((projectId, index) => ({
    id: `task-${index}`,
    identifier: `INC-${index + 1}`,
    title: "Client work",
    status: "todo",
    projectId,
    projectName: projectId ? "Same client name" : null,
    createdAt: now,
  }));
  const db = {
    select: vi.fn()
      .mockReturnValueOnce(queryResult([]))
      .mockReturnValueOnce(queryResult(rows))
      .mockReturnValueOnce(queryResult([])),
  };
  return dashboardFulfillmentService(db as unknown as Db).board("company-1", now);
}

describe("dashboardFulfillmentService client counts", () => {
  it("counts all distinct client projects before truncation, excluding unassigned tasks", async () => {
    const board = await boardForProjects([
      ...Array.from({ length: 11 }, (_, index) => `client-${index}`),
      "client-0",
      null,
    ]);

    expect(board.clientsWithOpenWork).toBe(11);
    expect(board.clients).toHaveLength(10);
    expect(board.openClientTasks).toEqual({ total: 12, unassigned: 1 });
    expect(board.clients[0]).toMatchObject({ clientKey: "client-0", openTasks: 2 });
  });

  it("returns zero for an empty roster or only unassigned work", async () => {
    expect((await boardForProjects([])).clientsWithOpenWork).toBe(0);
    const board = await boardForProjects([null]);
    expect(board.clientsWithOpenWork).toBe(0);
    expect(board.clients).toEqual([]);
    expect(board.openClientTasks).toEqual({ total: 0, unassigned: 1 });
  });
});

const now = new Date("2026-11-26T12:00:00.000Z");

function client(slug: string, overrides: Partial<MergedClientMetrics> = {}): MergedClientMetrics {
  return {
    slug,
    displayName: slug,
    observedAt: now.toISOString(),
    spend: null,
    newLeads: null,
    impressions: null,
    clicks: null,
    booked: null,
    showed: null,
    pitched: null,
    wonDeals: null,
    showRate: null,
    closeRate: null,
    pipelineRevenueUsd: null,
    cashCollectedUsd: null,
    speedToLeadSeconds: null,
    cpl: null,
    cac: null,
    roas: null,
    costPerHeldAppointment: null,
    zeroLeadDays: null,
    ...overrides,
  };
}

function service(clients: MergedClientMetrics[], observedAt: string | null = now.toISOString()) {
  const db = { select: vi.fn(() => queryResult([])) } as unknown as Db;
  const portfolioReader = vi.fn(async (): Promise<PortfolioSnapshotBundle> => ({
    capital: null,
    snapshots: null,
    neonAccounts: null,
    neonPipeline: null,
    clients,
    observedAt,
  }));
  const wavvReader = vi.fn(async () => null);
  return { ...dashboardFulfillmentService(db, { portfolioReader, wavvReader }), portfolioReader, wavvReader };
}

describe("dashboardFulfillmentService client delivery", () => {
  it("does not combine complementary missing client metrics into portfolio totals or rates", async () => {
    const clients = [
      client("client-a", { spend: 1000, impressions: 1000, booked: 10, pitched: 5, zeroLeadDays: 0 }),
      client("client-b", { newLeads: 100, clicks: 200, showed: 20, wonDeals: 10 }),
    ];
    const board = await service(clients).board("company-1", now, { boardViewer: true });

    expect(board.clientDelivery).toMatchObject({
      adSpendUsd: null,
      newLeads: null,
      costPerLeadUsd: null,
      ctrPercent: null,
      appointmentsBooked: null,
      appointmentsShowed: null,
      showRatePercent: null,
      wonDeals: null,
      closeRatePercent: null,
      zeroLeadDays: null,
    });
    expect(board.clientDelivery!.accounts).toMatchObject([
      { slug: "client-a", spend: 1000, newLeads: null, booked: 10, showed: null, zeroLeadDays: 0 },
      { slug: "client-b", spend: null, newLeads: 100, booked: null, showed: 20, zeroLeadDays: null },
    ]);
  });

  it("computes weighted rates across complete client populations and excludes the agency", async () => {
    const reader = service([
      client("client-a", { spend: 100, newLeads: 10, impressions: 1000, clicks: 10, booked: 10, showed: 5, pitched: 4, wonDeals: 1, zeroLeadDays: 0 }),
      client("client-b", { spend: 900, newLeads: 30, impressions: 9000, clicks: 180, booked: 30, showed: 25, pitched: 16, wonDeals: 9, zeroLeadDays: 2 }),
      client("__owner__"),
    ]);
    const board = await reader.board("company-1", now, { period: "7d", boardViewer: true });

    expect(reader.portfolioReader).toHaveBeenCalledWith("7d");
    expect(board.clientDelivery).toMatchObject({
      period: "7d",
      adSpendUsd: 1000,
      newLeads: 40,
      costPerLeadUsd: 25,
      ctrPercent: 1.9,
      appointmentsBooked: 40,
      appointmentsShowed: 30,
      showRatePercent: 75,
      wonDeals: 10,
      // Certified close rate: sales ÷ showed = 10 / 30.
      closeRatePercent: 33.3,
      zeroLeadDays: 2,
    });
    expect(board.clientDelivery!.accounts).toHaveLength(2);
  });

  it("excludes former, cancelled, and archived client rows from Fulfillment totals and account table", async () => {
    const reader = service([
      client("acme-spas", { spend: 500, newLeads: 10, impressions: 5000, clicks: 100, booked: 5, showed: 4, wonDeals: 2, zeroLeadDays: 0 }),
      client("retired-spas", { status: "former", spend: 9000, newLeads: 90, impressions: 90000, clicks: 900, booked: 40, showed: 30, wonDeals: 10, zeroLeadDays: 3 }),
      client("archived-pools", { archived: true, spend: 4000, newLeads: 40, impressions: 40000, clicks: 400, booked: 20, showed: 15, wonDeals: 5, zeroLeadDays: 1 }),
    ]);
    const board = await reader.board("company-1", now, { period: "30d", boardViewer: true });

    expect(board.clientDelivery).toMatchObject({
      adSpendUsd: 500,
      newLeads: 10,
      costPerLeadUsd: 50,
      appointmentsBooked: 5,
      appointmentsShowed: 4,
      wonDeals: 2,
      zeroLeadDays: 0,
      notConnected: null,
    });
    expect(board.clientDelivery!.accounts.map((a) => a.slug)).toEqual(["acme-spas"]);
  });

  it("uses the complete held population when pitched counts are incomplete", async () => {
    const board = await service([
      client("client-a", { showed: 10, pitched: 2, wonDeals: 2 }),
      client("client-b", { showed: 30, wonDeals: 6 }),
    ]).board("company-1", now, { boardViewer: true });

    expect(board.clientDelivery!.closeRatePercent).toBe(20);
  });

  it("retains known zero totals and returns null for zero denominators", async () => {
    const zero = { spend: 0, newLeads: 0, impressions: 0, clicks: 0, booked: 0, showed: 0, pitched: 0, wonDeals: 0, zeroLeadDays: 0 };
    const board = await service([client("client-a", zero), client("client-b", zero)])
      .board("company-1", now, { boardViewer: true });

    expect(board.clientDelivery).toMatchObject({
      adSpendUsd: 0, newLeads: 0, appointmentsBooked: 0, appointmentsShowed: 0, wonDeals: 0, zeroLeadDays: 0,
      costPerLeadUsd: null, ctrPercent: null, showRatePercent: null, closeRatePercent: null,
    });
  });

  it("retains zero numerators in computable rates", async () => {
    const board = await service([client("client-a", {
      spend: 0, newLeads: 10, impressions: 1000, clicks: 0, booked: 10, showed: 0, pitched: 5, wonDeals: 0,
    })]).board("company-1", now, { boardViewer: true });

    // Close rate is sales ÷ showed, so 0 showed means no close rate (not 0%).
    expect(board.clientDelivery).toMatchObject({ costPerLeadUsd: 0, ctrPercent: 0, showRatePercent: 0, closeRatePercent: null });
  });

  it("preserves single-client fallback rates when counts cannot be computed", async () => {
    const board = await service([client("client-a", { showRate: 88, closeRate: 45 })])
      .board("company-1", now, { boardViewer: true });

    expect(board.clientDelivery).toMatchObject({ showRatePercent: 88, closeRatePercent: 45 });
  });

  it("prefers computable single-client rates over fallback rates", async () => {
    const board = await service([client("client-a", {
      booked: 10, showed: 8, pitched: 4, wonDeals: 1, showRate: 99, closeRate: 99,
    })]).board("company-1", now, { boardViewer: true });

    expect(board.clientDelivery).toMatchObject({ showRatePercent: 80, closeRatePercent: 12.5 });
  });

  it.each([
    { label: "empty portfolio", clients: [] },
    { label: "agency only", clients: [client("__owner__")] },
  ])("returns no portfolio figures for $label", async ({ clients }) => {
    const board = await service(clients).board("company-1", now, { boardViewer: true });

    expect(board.clientDelivery).toMatchObject({ adSpendUsd: null, newLeads: null, costPerLeadUsd: null, ctrPercent: null, accounts: [] });
    expect(board.clientDelivery!.notConnected).not.toBeNull();
  });

  it("does not read instance feeds for a viewer without permission", async () => {
    const reader = service([client("client-a", { spend: 100 })]);
    const board = await reader.board("company-1", now);

    expect(reader.portfolioReader).not.toHaveBeenCalled();
    expect(reader.wavvReader).not.toHaveBeenCalled();
    expect(board.clientDelivery!.accounts).toEqual([]);
    expect(board.clientDelivery!.adSpendUsd).toBeNull();
  });
});
