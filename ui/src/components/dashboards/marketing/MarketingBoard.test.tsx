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
      id: "ad-spend",
      label: "Ad spend",
      definition: "Spend in the period, per client.",
      owner: "Media buyer",
      target: "0.95–1.05 of planned pacing green",
      sourceIds: ["meta_ads"],
      value: { kind: "not_connected" },
    },
    {
      id: "cost-per-lead",
      label: "Cost per lead",
      definition: "Spend ÷ new leads.",
      owner: "Media buyer",
      target: "Red at 2× the client's 90-day median",
      sourceIds: ["meta_ads", "ghl"],
      value: { kind: "not_connected" },
    },
    {
      id: "spend-with-zero-leads",
      label: "Spend with zero leads",
      definition: "Client-days in the last 7 with spend over $100 and no new lead.",
      owner: "Media buyer",
      target: "Zero client-days",
      sourceIds: ["meta_ads", "ghl"],
      value: { kind: "not_connected" },
    },
  ],
  tables: [
    {
      id: "marketing-by-client",
      title: "Marketing per client",
      description: "One row per client, keyed by client id.",
      scope: "client",
      sourceIds: ["meta_ads", "ghl"],
      columns: [
        { key: "client", label: "Client" },
        { key: "spend", label: "Spend" },
        { key: "leads", label: "Leads" },
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

  it("shows spend, leads, cost per lead, cost per held appointment and the zero-lead alarm", () => {
    const html = renderToStaticMarkup(<MarketingBoardView data={board} />);
    expect(html).toContain("Ad spend");
    expect(html).toContain("Cost per lead");
    expect(html).toContain("Spend with zero leads");
    expect(html).toContain("Zero client-days");
    expect(html).toContain("Marketing per client");
    expect(html).toContain("Cost per held appointment");
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
});
