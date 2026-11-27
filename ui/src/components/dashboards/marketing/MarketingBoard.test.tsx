// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DashboardBoard } from "@paperclipai/shared";
import { MarketingBoardView } from "./MarketingBoard";

const board: DashboardBoard = {
  board: "marketing",
  companyId: "11111111-1111-4111-8111-111111111111",
  generatedAt: "2026-11-23T12:00:00.000Z",
  sources: [
    {
      id: "meta_ads",
      name: "Meta Marketing API",
      status: "not_connected",
      detail: "Paperclip has no server-side Meta Ads read connector.",
      needed: "A Meta system-user token with ads_read on the agency ad account.",
      lastSuccessfulSync: null,
    },
    {
      id: "ghl",
      name: "GoHighLevel (GHL)",
      status: "not_connected",
      detail: "Paperclip has no GHL client.",
      needed: "A GHL private-integration token, read-only.",
      lastSuccessfulSync: null,
    },
  ],
  tiles: [
    {
      id: "cac-per-client",
      label: "CAC per client",
      definition: "All-in cost to win one customer: (media + sales + software) ÷ new customers.",
      owner: "Media buyer",
      target: "Judge against LTGP, never against CPL",
      sourceIds: ["meta_ads", "ghl"],
      value: { kind: "not_connected" },
    },
    {
      id: "creative-budget-split",
      label: "Creative budget split",
      definition: "Share of ad budget: proven core ad, adjacent variations and new ideas.",
      owner: "Media buyer",
      target: "70 / 20 / 10 (core / adjacent / new)",
      sourceIds: ["meta_ads"],
      value: { kind: "not_connected" },
    },
    {
      id: "ad-spend",
      label: "Ad spend",
      definition: "Spend in the period, per client.",
      owner: "Media buyer",
      target: "v1 source, not Hormozi — 0.95–1.05 of planned pacing green",
      sourceIds: ["meta_ads"],
      value: { kind: "not_connected" },
    },
    {
      id: "ctr",
      label: "CTR",
      definition: "Link clicks ÷ impressions.",
      owner: "Media buyer",
      target: "1% → 4% is a 4× front-end gain; judge against the client's own baseline",
      sourceIds: ["meta_ads"],
      value: { kind: "not_connected" },
    },
    {
      id: "cost-per-lead",
      label: "Cost per lead",
      definition: "Spend ÷ new leads.",
      owner: "Media buyer",
      target: "Reference only, never a target",
      sourceIds: ["meta_ads", "ghl"],
      value: { kind: "not_connected" },
    },
    {
      id: "spend-with-zero-leads",
      label: "Spend with zero leads",
      definition: "Client-days in the last 7 with spend over $100 and no new lead.",
      owner: "Media buyer",
      target: "v1 source, not Hormozi — zero client-days",
      sourceIds: ["meta_ads", "ghl"],
      value: { kind: "not_connected" },
    },
  ],
  tables: [
    {
      id: "marketing-by-client",
      title: "Marketing per client",
      description: "One row per client, keyed by client id. ROAS is the drill-down under CAC.",
      scope: "client",
      sourceIds: ["meta_ads", "ghl"],
      columns: [
        { key: "client", label: "Client" },
        { key: "spend", label: "Spend" },
        { key: "leads", label: "Leads" },
        { key: "newCustomers", label: "New customers" },
        { key: "cac", label: "CAC" },
        { key: "roas", label: "ROAS (drill-down)" },
        { key: "costPerLead", label: "Cost per lead" },
        { key: "costPerHeldAppointment", label: "Cost per held appointment" },
      ],
      rows: [],
    },
  ],
};

describe("MarketingBoardView", () => {
  it("names both sources for a number that needs both", () => {
    const html = renderToStaticMarkup(<MarketingBoardView data={board} />);
    expect(html).toContain("Not connected: Meta Marketing API, GoHighLevel (GHL)");
    expect(html).toContain("Not connected: Meta Marketing API");
  });

  it("puts CAC first, makes CPL a reference and shows the creative split and CTR", () => {
    const html = renderToStaticMarkup(<MarketingBoardView data={board} />);
    expect(html).toContain("CAC per client");
    expect(html).toContain("Judge against LTGP, never against CPL");
    expect(html).toContain("70 / 20 / 10 (core / adjacent / new)");
    expect(html).toContain("Link clicks ÷ impressions");
    expect(html).toContain("4× front-end gain");
    expect(html).toContain("Reference only, never a target");
    expect(html).toContain("ROAS (drill-down)");
    expect(html.indexOf("CAC per client")).toBeLessThan(html.indexOf("Cost per lead"));
  });

  it("drops the $42.95 industry benchmark and the learning-limited tile", () => {
    const html = renderToStaticMarkup(<MarketingBoardView data={board} />);
    expect(html).not.toContain("42.95");
    expect(html).not.toContain("Learning-limited");
    expect(html).toContain("CPL is a reference");
  });

  it("renders no numeric value and no zero in place of a missing number", () => {
    const html = renderToStaticMarkup(<MarketingBoardView data={board} />);
    expect(html).not.toContain("dashboard-tile-value-");
    expect(html).not.toContain(">0<");
    expect(html).not.toContain("$0");
  });

  it("says what is needed for the Meta read and the GHL read", () => {
    const html = renderToStaticMarkup(<MarketingBoardView data={board} />);
    expect(html).toContain("A Meta system-user token with ads_read");
    expect(html).toContain("A GHL private-integration token");
    expect(html).toContain("Paperclip has no server-side Meta Ads read connector.");
  });

  it("never says Not connected under a connected source, and names why a number is missing", () => {
    const connected: DashboardBoard = {
      ...board,
      sources: board.sources.map((source) => ({ ...source, status: "connected" as const })),
      tiles: board.tiles.map((tile, index) => ({
        ...tile,
        value:
          index === 0
            ? { kind: "no_data" as const, reason: "Spend $128.03 · Clients won 0 — no new agency clients won in this period yet." }
            : index === 1
              ? { kind: "not_mapped" as const, missing: "Agency ads are not tagged core / adjacent / new yet." }
              : // A stale payload that still says not_connected is reconciled too.
                { kind: "not_connected" as const },
      })),
    };
    const html = renderToStaticMarkup(<MarketingBoardView data={connected} />);
    expect(html).not.toContain("Not connected: ");
    expect(html).not.toContain("Needed:");
    expect(html).toContain("No data yet");
    expect(html).toContain("Clients won 0");
    expect(html).toContain("Not mapped yet");
    expect(html).toContain("not tagged core / adjacent / new");
    expect(html).not.toContain('data-connection-state="not-connected"');
  });

  it("lists only the disconnected source's needed key when one of two sources is connected", () => {
    const half: DashboardBoard = {
      ...board,
      sources: board.sources.map((source) =>
        source.id === "meta_ads" ? { ...source, status: "connected" as const } : source,
      ),
    };
    const html = renderToStaticMarkup(<MarketingBoardView data={half} />);
    expect(html).toContain("Not connected: GoHighLevel (GHL)");
    expect(html).not.toContain("Not connected: Meta Marketing API");
  });
});
