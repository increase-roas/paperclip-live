import { describe, expect, it, vi } from "vitest";
import { readPortfolioSnapshotBundle } from "../sales-dashboard-client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("readPortfolioSnapshotBundle period isolation", () => {
  it("never mixes 30-day Neon accounts or unscoped pipeline data into month-to-date when month data is missing", async () => {
    const requestedUrls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes("/api/pilot/admin/capital?view=month")) {
        return jsonResponse({
          ok: true,
          generatedAt: "2026-11-25T12:00:00.000Z",
          view: "month",
          owner: null,
          clients: [],
        });
      }
      if (url.includes("/api/pilot/admin/snapshots?view=month")) {
        return jsonResponse({
          ok: true,
          view: "month",
          generatedAt: "2026-11-25T12:00:00.000Z",
          owner: null,
          clients: [],
        });
      }
      if (url.includes("/api/pilot/neon-ads?view=accounts")) {
        return jsonResponse({
          ok: true,
          status: "LIVE",
          generatedAt: "2026-11-25T12:00:00.000Z",
          clients: [
            {
              clientId: "paradise-spas",
              displayName: "Paradise Spas",
              sevenDay: { spend: 1400, leads: 20, cpl: 70 },
              thirtyDay: { spend: 6400, leads: 110, cpl: 58.18 },
              lastDataDay: "2026-11-24",
              stale: false,
            },
          ],
        });
      }
      if (url.includes("/api/pilot/neon-ads?view=pipeline")) {
        // Live upstream /api/pilot/neon-ads?view=pipeline is an unscoped attribution view (no period/window).
        return jsonResponse({
          ok: true,
          status: "LIVE",
          generatedAt: "2026-11-25T12:00:00.000Z",
          clients: [
            {
              clientId: "paradise-spas",
              displayName: "Paradise Spas",
              spend: 6400,
              crmLeads: 110,
              qualified: 50,
              booked: 35,
              showed: 28,
              sold: 7,
              revenue: 42000,
              costPerCrmLead: 58.18,
              costPerBooked: 182.86,
              costPerSold: 914.29,
              roas: 6.56,
            },
          ],
        });
      }
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch;

    const bundle = await readPortfolioSnapshotBundle("month", {
      baseUrl: "https://dash.example",
      adminKey: "test-key",
      fetchImpl,
    });

    expect(requestedUrls.some((u) => u.includes("/api/pilot/neon-ads?view=accounts"))).toBe(false);
    expect(bundle.neonAccounts).toBeNull();
    expect(bundle.neonPipeline).toBeNull();
    expect(bundle.clients).toEqual([]);
  });

  it("preserves genuine $0 month-to-date snapshot figures instead of replacing them with 30-day figures", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/pilot/admin/snapshots?view=month")) {
        return jsonResponse({
          ok: true,
          view: "month",
          generatedAt: "2026-11-01T08:00:00.000Z",
          clients: [
            {
              slug: "paradise-spas",
              displayName: "Paradise Spas",
              syncedAt: "2026-11-01T08:00:00.000Z",
              ghl: { status: "LIVE", newLeads: 0, appointmentsBooked: 0, showedAppointments: 0, wonDeals: 0 },
              meta: { status: "LIVE", spend: 0, impressions: 0, clicks: 0 },
            },
          ],
        });
      }
      if (url.includes("/api/pilot/admin/capital?view=month")) {
        return jsonResponse({ ok: false }, 404);
      }
      if (url.includes("/api/pilot/neon-ads?view=pipeline")) {
        return jsonResponse({
          ok: true,
          status: "LIVE",
          period: "30d",
          generatedAt: "2026-11-01T08:00:00.000Z",
          clients: [
            {
              clientId: "paradise-spas",
              displayName: "Paradise Spas",
              spend: 9999,
              crmLeads: 200,
              qualified: 100,
              booked: 60,
              showed: 45,
              sold: 10,
              revenue: 80000,
              costPerCrmLead: 50,
              costPerBooked: 166.65,
              costPerSold: 999.9,
              roas: 8,
            },
          ],
        });
      }
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch;

    const bundle = await readPortfolioSnapshotBundle("month", {
      baseUrl: "https://dash.example",
      adminKey: "test-key",
      fetchImpl,
    });

    expect(bundle.clients).toHaveLength(1);
    expect(bundle.clients[0]).toMatchObject({
      slug: "paradise-spas",
      spend: 0,
      newLeads: 0,
      wonDeals: 0,
      pipelineRevenueUsd: null,
    });
  });

  it("rejects 30-day capital fallback and unscoped pipeline data when 7d is selected", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/pilot/admin/capital?view=7d")) {
        // Matches real upstream behavior: /api/pilot/admin/capital?view=7d falls back to view: "30d"
        return jsonResponse({
          ok: true,
          generatedAt: "2026-11-25T12:00:00.000Z",
          view: "30d",
          owner: null,
          clients: [
            {
              slug: "paradise-spas",
              displayName: "Paradise Spas",
              syncedAt: "2026-11-25T12:00:00.000Z",
              syncStatus: "success",
              marketing: { window: "30d", adSpendUsd: 6400, newLeads: 110, wonDeals: 7 },
              financialMonth: null,
            },
          ],
        });
      }
      if (url.includes("/api/pilot/admin/snapshots?view=7d")) {
        return jsonResponse({ ok: true, view: "7d", generatedAt: "2026-11-25T12:00:00.000Z", clients: [] });
      }
      if (url.includes("/api/pilot/neon-ads?view=accounts")) {
        return jsonResponse({
          ok: true,
          status: "LIVE",
          generatedAt: "2026-11-25T12:00:00.000Z",
          clients: [
            {
              clientId: "paradise-spas",
              displayName: "Paradise Spas",
              sevenDay: { spend: 1250, leads: 25, cpl: 50 },
              thirtyDay: { spend: 6400, leads: 110, cpl: 58.18 },
              lastDataDay: "2026-11-24",
              stale: false,
            },
          ],
        });
      }
      if (url.includes("/api/pilot/neon-ads?view=pipeline")) {
        return jsonResponse({
          ok: true,
          status: "LIVE",
          generatedAt: "2026-11-25T12:00:00.000Z",
          clients: [
            {
              clientId: "paradise-spas",
              displayName: "Paradise Spas",
              spend: 6400,
              crmLeads: 110,
              qualified: 40,
              booked: 30,
              showed: 20,
              sold: 7,
              revenue: 42000,
              costPerCrmLead: 58.18,
              costPerBooked: 213.33,
              costPerSold: 914.29,
              roas: 6.56,
            },
          ],
        });
      }
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch;

    const bundle = await readPortfolioSnapshotBundle("7d", {
      baseUrl: "https://dash.example",
      adminKey: "test-key",
      fetchImpl,
    });

    expect(bundle.clients).toHaveLength(1);
    expect(bundle.clients[0]).toMatchObject({
      slug: "paradise-spas",
      spend: 1250,
      newLeads: 25,
      cpl: 50,
      // Neither 30d capital nor unscoped pipeline leaked booked/showed/wonDeals into 7d.
      booked: null,
      showed: null,
      wonDeals: null,
      pipelineRevenueUsd: null,
    });
  });

  it("uses pipeline fallback when upstream explicitly declares a matching period and rejects mismatched snapshots", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/pilot/admin/capital?view=month")) {
        return jsonResponse({ ok: false }, 404);
      }
      if (url.includes("/api/pilot/admin/snapshots?view=month")) {
        // Mismatched snapshot view must be ignored.
        return jsonResponse({
          ok: true,
          view: "30d",
          generatedAt: "2026-11-25T12:00:00.000Z",
          clients: [
            {
              slug: "wrong-period-client",
              displayName: "Wrong Period Client",
              syncedAt: "2026-11-25T12:00:00.000Z",
              meta: { status: "LIVE", spend: 9999 },
            },
          ],
        });
      }
      if (url.includes("/api/pilot/neon-ads?view=pipeline")) {
        return jsonResponse({
          ok: true,
          status: "LIVE",
          period: "month",
          generatedAt: "2026-11-25T12:00:00.000Z",
          clients: [
            {
              clientId: "sun-pool",
              displayName: "Sun Pool",
              spend: 1800,
              crmLeads: 36,
              qualified: 18,
              booked: 12,
              showed: 9,
              sold: 3,
              revenue: 21000,
              costPerCrmLead: 50,
              costPerBooked: 150,
              costPerSold: 600,
              roas: 11.67,
            },
          ],
        });
      }
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch;

    const bundle = await readPortfolioSnapshotBundle("month", {
      baseUrl: "https://dash.example",
      adminKey: "test-key",
      fetchImpl,
    });

    expect(bundle.snapshots).toBeNull();
    expect(bundle.neonPipeline?.period).toBe("month");
    expect(bundle.clients).toHaveLength(1);
    expect(bundle.clients[0]).toMatchObject({
      slug: "sun-pool",
      spend: 1800,
      newLeads: 36,
      booked: 12,
      showed: 9,
      wonDeals: 3,
      pipelineRevenueUsd: 21000,
    });
  });
});
