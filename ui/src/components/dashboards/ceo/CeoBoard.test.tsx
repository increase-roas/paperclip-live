// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Approval, CostSummary, Issue } from "@paperclipai/shared";
import type { DashboardCeoBoard } from "@/api/dashboardBoards";
import type { DashboardPeriod } from "../period";
import { CeoBoard } from "./CeoBoard";

const mockCostsApi = vi.hoisted(() => ({ summary: vi.fn() }));
const mockApprovalsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockIssuesApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockDashboardBoardsApi = vi.hoisted(() => ({ ceo: vi.fn() }));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode } & Record<string, unknown>) => (
    <a href={to} {...props}>{children}</a>
  ),
}));
vi.mock("@/api/costs", () => ({ costsApi: mockCostsApi }));
vi.mock("@/api/approvals", () => ({ approvalsApi: mockApprovalsApi }));
vi.mock("@/api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("@/api/dashboardBoards", () => ({ dashboardBoardsApi: mockDashboardBoardsApi }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.now();

function costSummary(overrides: Partial<CostSummary> = {}): CostSummary {
  return {
    eventCount: 10,
    pendingRunCount: 0,
    unpricedEventCount: 0,
    pricingComplete: true,
    companyId: "company-1",
    spendCents: 1234,
    budgetCents: 20000,
    utilizationPercent: 6.17,
    ...overrides,
  };
}

function approval(hoursAgo: number): Approval {
  return {
    id: `approval-${hoursAgo}`,
    createdAt: new Date(NOW - hoursAgo * 60 * 60 * 1000).toISOString(),
  } as unknown as Approval;
}

function issue(status: string): Issue {
  return { status } as unknown as Issue;
}

const roots: Array<{ root: Root; container: HTMLDivElement }> = [];

async function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push({ root, container });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
  });
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  return container;
}

beforeEach(() => {
  mockCostsApi.summary.mockResolvedValue(costSummary());
  mockApprovalsApi.list.mockResolvedValue([approval(2), approval(1), approval(0.5)]);
  mockIssuesApi.list.mockResolvedValue([
    issue("todo"),
    issue("in_progress"),
    issue("blocked"),
    issue("done"),
  ]);
  mockDashboardBoardsApi.ceo.mockRejectedValue(new Error("not mounted yet"));
});

afterEach(async () => {
  for (const { root, container } of roots.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("CeoBoard", () => {
  it("shows 4 clickable live Paperclip tiles without duplicating AI spend", async () => {
    const container = await render(<CeoBoard companyId="company-1" period="30d" />);
    const text = container.textContent ?? "";

    const aiTile = container.querySelector('[data-testid="ceo-tile-ai-spend-cap"]');
    expect(aiTile?.textContent).toContain("AI spend vs monthly cap");
    expect(aiTile?.textContent).toContain("$12.34");
    expect(aiTile?.textContent).toContain("$200.00");
    expect(aiTile?.textContent).toContain("6.2%");
    expect(aiTile?.getAttribute("data-tile-state")).toBe("ok");
    expect(aiTile?.closest("a")?.getAttribute("href")).toBe("/dashboard/ai-cost");

    // No duplicate AI spend tile or separate Guardrails section.
    expect(text).not.toContain("AI spend on agent runs");
    expect(text).not.toContain("Guardrails");

    const approvalsTile = container.querySelector('[data-testid="ceo-tile-approvals-waiting"]');
    expect(approvalsTile?.getAttribute("data-tile-state")).toBe("ok");
    expect(approvalsTile?.textContent).toContain("Oldest waiting 2h.");
    expect(approvalsTile?.closest("a")?.getAttribute("href")).toBe("/decisions");

    const openTile = container.querySelector('[data-testid="ceo-tile-open-tasks"]');
    expect(openTile?.closest("a")?.getAttribute("href")).toBe("/issues");

    const blockedTile = container.querySelector('[data-testid="ceo-tile-blocked-tasks"]');
    expect(blockedTile?.getAttribute("data-tile-state")).toBe("red");
    expect(blockedTile?.textContent).toContain("1");
    expect(blockedTile?.closest("a")?.getAttribute("href")).toBe("/issues?view=needs_attention");
  });

  it("shows strictly the 6 core CEO money tiles with clear agency billing next steps and zero Sales/Marketing duplicates", async () => {
    const container = await render(<CeoBoard companyId="company-1" period="30d" />);

    const notConnected = container.querySelectorAll('[data-connection-state="not-connected"]');
    expect(notConnected).toHaveLength(6);

    const text = container.textContent ?? "";
    expect(text).toContain("Money (6 core CEO metrics)");
    expect(text).toContain("QuickBooks Online");
    expect(text).toContain("Authorize.net");
    expect(text).toContain("Paperclip Secrets");

    // Sales & Marketing metrics are removed from CEO.
    expect(text).not.toContain("Cost per held appointment");
    expect(text).not.toContain("Show rate");
    expect(text).not.toContain("Speed to lead");
    expect(text).not.toContain("Ad spend with zero leads");

    // Churn links to Fulfillment.
    const churnTile = container.querySelector('[data-testid="ceo-tile-churn"]');
    expect(churnTile?.closest("a")?.getAttribute("href")).toBe("/dashboard/fulfillment");

    // No money tile invents a value when not connected.
    expect(container.querySelector('[data-testid="ceo-tile-cash-collected"]')?.textContent)
      .not.toMatch(/\$\d/);
  });

  it("renders live money tiles returned by GET /dashboards/ceo", async () => {
    const payload: DashboardCeoBoard = {
      companyId: "company-1",
      period: "30d",
      generatedAt: "2026-11-25T12:00:00.000Z",
      moneyTiles: [
        {
          id: "cash-collected",
          label: "Cash collected, last 30 days",
          source: "Agency QuickBooks Online",
          needs: "QBO OAuth token",
          target: "Cover COGS + CAC",
          state: "ok",
          value: {
            kind: "live",
            value: 48500,
            unit: "usd",
            observedAt: "2026-11-25T11:55:00.000Z",
          },
        },
      ],
    };
    mockDashboardBoardsApi.ceo.mockResolvedValue(payload);

    const container = await render(<CeoBoard companyId="company-1" period="30d" />);
    const cashTile = container.querySelector('[data-testid="ceo-tile-cash-collected"]');
    expect(cashTile?.getAttribute("data-tile-state")).toBe("ok");
    expect(cashTile?.textContent).toContain("$48,500");
    expect(cashTile?.textContent).toContain("Source: Agency QuickBooks Online");

    // Remaining 5 tiles stay honestly Not connected.
    expect(container.querySelectorAll('[data-connection-state="not-connected"]')).toHaveLength(5);
    expect(mockDashboardBoardsApi.ceo).toHaveBeenCalledWith("company-1", "30d");
  });

  it("matches spec v2 Hormozi targets without Stripe or revenue per FTE", async () => {
    const container = await render(<CeoBoard companyId="company-1" period="30d" />);
    const text = container.textContent ?? "";

    const ltgp = container.querySelector('[data-testid="ceo-tile-ltgp-cac"]');
    expect(ltgp?.textContent).toContain("12:1 target");
    expect(ltgp?.textContent).toContain("3:1 all automated");
    expect(ltgp?.textContent).toContain("6:1 one manual");
    expect(ltgp?.textContent).toContain("9:1 two manual");
    expect(ltgp?.textContent).toContain("12:1 all three manual");

    const cashMultiple = container.querySelector('[data-testid="ceo-tile-30-day-cash-multiple"]');
    expect(cashMultiple?.textContent).toContain("2.0");

    const churn = container.querySelector('[data-testid="ceo-tile-churn"]');
    expect(churn?.textContent).toContain("3% per month");
    expect(churn?.textContent).toContain("80% per year");

    const margin = container.querySelector('[data-testid="ceo-tile-gross-margin"]');
    expect(margin?.textContent).toContain("50%");
    expect(margin?.textContent).toContain("Hormozi");

    expect(text).not.toMatch(/revenue per fte/i);
    expect(text).not.toMatch(/stripe/i);
  });

  it("shows a read failure instead of a stale or guessed number", async () => {
    mockCostsApi.summary.mockRejectedValue(new Error("costs unavailable"));
    const container = await render(<CeoBoard companyId="company-1" period="30d" />);

    const aiTile = container.querySelector('[data-testid="ceo-tile-ai-spend-cap"]');
    expect(aiTile?.textContent).toContain("Could not read the monthly cap:");
    expect(aiTile?.textContent).toContain("—");
    expect(aiTile?.getAttribute("data-tile-state")).toBe("unknown");
  });

  it("does not claim there is no cap while the cap is still being read", async () => {
    mockCostsApi.summary.mockReturnValue(new Promise(() => {}));
    const container = await render(<CeoBoard companyId="company-1" period="month" />);
    const capTile = container.querySelector('[data-testid="ceo-tile-ai-spend-cap"]');

    expect(capTile?.textContent).toContain("…");
    expect(capTile?.textContent).toContain("Reading the monthly cap.");
    expect(capTile?.textContent).not.toContain("No cap");
  });

  it("reads the monthly cap once and passes period to the CEO board endpoint", async () => {
    const periods: DashboardPeriod[] = ["7d", "month"];
    expect(periods).toEqual(["7d", "month"]);

    await render(<CeoBoard companyId="company-1" period="7d" />);
    expect(mockCostsApi.summary).toHaveBeenCalledTimes(1);
    expect(mockDashboardBoardsApi.ceo).toHaveBeenCalledWith("company-1", "7d");
  });
});
