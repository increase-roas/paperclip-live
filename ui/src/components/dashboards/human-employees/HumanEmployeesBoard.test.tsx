// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DashboardBoard } from "@paperclipai/shared";
import { HumanEmployeesBoardView } from "./HumanEmployeesBoard";

const board: DashboardBoard = {
  board: "human-employees",
  companyId: "11111111-1111-4111-8111-111111111111",
  generatedAt: "2026-11-23T12:00:00.000Z",
  sources: [
    {
      id: "team_capital",
      name: "Team & capital API",
      status: "not_connected",
      detail:
        "The roster is table agency_team behind dashboard.increaseai.tech's admin API.",
      needed:
        "A read-only service credential for dashboard.increaseai.tech that can GET /api/pilot/admin/team.",
      lastSuccessfulSync: null,
    },
  ],
  tiles: [
    {
      id: "one-number-per-seat",
      label: "One number per seat",
      definition:
        "Each seat's single self-chosen number that predicts their result.",
      owner: "Alex",
      target: "Every seat has one, and the person can defend it",
      sourceIds: ["team_capital"],
      value: { kind: "not_connected" },
    },
    {
      id: "metrics-a-seat-can-name",
      label: "Metrics a seat can name",
      definition: "How many numbers that person can describe their own job with.",
      owner: "Alex",
      target: "More is better; one or two means they cannot drive the outcome",
      sourceIds: ["team_capital"],
      value: { kind: "not_connected" },
    },
    {
      id: "revenue-per-fte",
      label: "Revenue per FTE",
      definition: "Revenue ÷ full-time equivalents.",
      owner: "Alex",
      target: "Direction only, not a target",
      sourceIds: ["team_capital"],
      value: { kind: "not_connected" },
    },
    {
      id: "seats-without-judged-on-number",
      label: "Seats without a judged-on number",
      definition: "Active seats whose performance criterion is empty or reads NOT SET.",
      owner: "Alex",
      target: "v1 source, not Hormozi — zero",
      sourceIds: ["team_capital"],
      value: { kind: "not_connected" },
    },
  ],
  tables: [
    {
      id: "team-roster",
      title: "Team roster",
      description: "One row per person, keyed by team-member id.",
      scope: "member",
      sourceIds: ["team_capital"],
      columns: [
        { key: "name", label: "Name" },
        { key: "role", label: "Role" },
        { key: "rateType", label: "Rate type" },
        { key: "rate", label: "Rate" },
        { key: "hours", label: "Hours" },
        { key: "duties", label: "Duties" },
        { key: "judgedOn", label: "Judged on" },
        { key: "status", label: "Status" },
      ],
      rows: [],
    },
  ],
};

describe("HumanEmployeesBoardView", () => {
  it("names the Team & capital API as the missing source", () => {
    const html = renderToStaticMarkup(<HumanEmployeesBoardView data={board} />);
    expect(html).toContain("Not connected: Team &amp; capital API");
    expect(html).toContain(
      "A read-only service credential for dashboard.increaseai.tech",
    );
    expect(html).toContain("agency_team");
  });

  it("lays out one row per person with rate, duties and the judged-on number", () => {
    const html = renderToStaticMarkup(<HumanEmployeesBoardView data={board} />);
    for (const label of [
      "Name",
      "Role",
      "Rate type",
      "Rate",
      "Hours",
      "Duties",
      "Judged on",
      "Status",
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("Team roster");
  });

  it("renders no number while the roster cannot be read", () => {
    const html = renderToStaticMarkup(<HumanEmployeesBoardView data={board} />);
    expect(html).not.toContain("dashboard-tile-value-");
    expect(html).toContain("Revenue per FTE");
  });

  it("starts with one number per seat and the metrics a seat can name", () => {
    const html = renderToStaticMarkup(<HumanEmployeesBoardView data={board} />);
    const first = html.indexOf("One number per seat");
    const second = html.indexOf("Metrics a seat can name");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThan(first);
    expect(html).toContain("self-chosen number");
  });

  it("treats revenue per FTE as direction only, not a target", () => {
    const html = renderToStaticMarkup(<HumanEmployeesBoardView data={board} />);
    expect(html).toContain("Direction only, not a target");
  });

  it("carries no Leila-sourced numbers, which the corpus cannot verify", () => {
    const html = renderToStaticMarkup(<HumanEmployeesBoardView data={board} />);
    expect(html).not.toMatch(/day-90|day 90|underperformer|Leila/i);
  });

  it("does not pretend an empty roster means zero employees", () => {
    const html = renderToStaticMarkup(<HumanEmployeesBoardView data={board} />);
    expect(html).not.toContain(">0<");
    expect(html).toContain("Not connected");
  });
});
