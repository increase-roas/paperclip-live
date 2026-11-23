// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DashboardBoard, DashboardSource } from "@paperclipai/shared";
import { SalesBoardView } from "./SalesBoard";

const companyId = "11111111-1111-4111-8111-111111111111";

const ghl: DashboardSource = {
  id: "ghl",
  name: "GoHighLevel (GHL)",
  status: "not_connected",
  detail: "Paperclip has no GHL client.",
  needed: "A GHL private-integration token, read-only.",
  lastSuccessfulSync: null,
};

const wavv: DashboardSource = {
  id: "wavv",
  name: "WAVV",
  status: "not_connected",
  detail: "No WAVV ingestion exists in Paperclip.",
  needed: "A WAVV API key for calls, conversations and talk time.",
  lastSuccessfulSync: null,
};

function board(overrides: Partial<DashboardBoard> = {}): DashboardBoard {
  return {
    board: "sales",
    companyId,
    generatedAt: "2026-11-23T12:00:00.000Z",
    sources: [ghl, wavv],
    tiles: [
      {
        id: "speed-to-lead",
        label: "Speed to lead",
        definition: "Median seconds from a new lead to the first outbound call attempt.",
        owner: "Sales manager",
        target: "< 60 seconds green; > 5 minutes red",
        sourceIds: ["ghl", "wavv"],
        value: { kind: "not_connected" },
      },
      {
        id: "show-rate",
        label: "Show rate",
        definition: "Appointments held ÷ appointments booked.",
        owner: "Setters",
        target: "70–80% healthy; < 60% red",
        sourceIds: ["ghl"],
        value: { kind: "not_connected" },
      },
    ],
    tables: [
      {
        id: "sales-by-business",
        title: "Appointments set per business",
        description: "One row per client.",
        scope: "client",
        sourceIds: ["ghl"],
        columns: [
          { key: "client", label: "Client" },
          { key: "appointmentsSet", label: "Appointments set" },
          { key: "showRate", label: "Show rate" },
        ],
        rows: [],
      },
    ],
    ...overrides,
  };
}

describe("SalesBoardView", () => {
  it("renders every tile with its owner, red line and missing sources", () => {
    const html = renderToStaticMarkup(<SalesBoardView data={board()} />);

    expect(html).toContain("Speed to lead");
    expect(html).toContain("Show rate");
    expect(html).toContain("Owner: Sales manager");
    expect(html).toContain("Red line: &lt; 60 seconds green");
    expect(html).toContain("Not connected: GoHighLevel (GHL), WAVV");
    expect(html).toContain("Not connected: GoHighLevel (GHL)");
    expect(html).toContain("Needed:");
    expect(html).toContain("A WAVV API key");
  });

  it("never renders a value while a source is missing", () => {
    const html = renderToStaticMarkup(<SalesBoardView data={board()} />);
    expect(html).not.toContain("dashboard-tile-value-");
    expect(html).not.toMatch(/\$\d/);
  });

  it("shows the per-business and per-setter shape even with no rows", () => {
    const html = renderToStaticMarkup(<SalesBoardView data={board()} />);
    expect(html).toContain("Appointments set per business");
    expect(html).toContain("Appointments set");
    expect(html).toContain("Show rate");
    expect(html).toContain("One row per client.");
  });

  it("says why each source is missing, above the tiles", () => {
    const html = renderToStaticMarkup(<SalesBoardView data={board()} />);
    expect(html).toContain("Sources");
    expect(html).toContain("Paperclip has no GHL client.");
    expect(html).toContain("No WAVV ingestion exists in Paperclip.");
    expect(html).toContain("Not connected");
  });

  it("renders a live reading, with its unit, when a source reports", () => {
    const live = board({
      tiles: [
        {
          id: "speed-to-lead",
          label: "Speed to lead",
          definition: "Median seconds.",
          owner: "Sales manager",
          target: "< 60 seconds green",
          sourceIds: ["ghl", "wavv"],
          value: {
            kind: "live",
            value: 42,
            unit: "seconds",
            observedAt: "2026-11-23T11:55:00.000Z",
          },
        },
      ],
    });
    const html = renderToStaticMarkup(<SalesBoardView data={live} />);
    expect(html).toContain("dashboard-tile-value-speed-to-lead");
    expect(html).toContain("42 s");
  });
});
