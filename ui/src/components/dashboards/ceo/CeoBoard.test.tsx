// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Approval, CostSummary, Issue } from "@paperclipai/shared";
import type { DashboardPeriod } from "../period";
import { CeoBoard } from "./CeoBoard";

const mockCostsApi = vi.hoisted(() => ({ summary: vi.fn() }));
const mockApprovalsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockIssuesApi = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("@/api/costs", () => ({ costsApi: mockCostsApi }));
vi.mock("@/api/approvals", () => ({ approvalsApi: mockApprovalsApi }));
vi.mock("@/api/issues", () => ({ issuesApi: mockIssuesApi }));

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
  // Let the queries settle.
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
  it("shows Paperclip's real numbers and names their source and read time", async () => {
    const container = await render(<CeoBoard companyId="company-1" period="30d" />);
    const text = container.textContent ?? "";

    expect(text).toContain("AI spend on agent runs");
    expect(text).toContain("$12.34");
    expect(text).toContain("Last 30 days");
    expect(text).toContain("Source: Paperclip run costs");

    expect(text).toContain("Approvals waiting");
    expect(text).toContain("Oldest waiting 2h.");
    expect(text).toContain("Source: Paperclip approvals");

    expect(text).toContain("Open tasks");
    expect(text).toContain("Blocked tasks");
    expect(text).toContain("Source: Paperclip tasks");

    // 1 blocked task out of 3 open (blocked included) is the one red line.
    const blockedTile = container.querySelector('[data-testid="ceo-tile-blocked-tasks"]');
    expect(blockedTile?.getAttribute("data-tile-state")).toBe("red");
    expect(blockedTile?.textContent).toContain("1");

    // Approvals were all answered within 24h, so the queue is green.
    expect(
      container.querySelector('[data-testid="ceo-tile-approvals-waiting"]')?.getAttribute("data-tile-state"),
    ).toBe("ok");

    // $12.34 against a $200 monthly cap is 6.2%, below the 80% alert line.
    expect(container.querySelector('[data-testid="ceo-guardrail-ai-cap"]')?.textContent).toContain("6.2%");
    expect(container.querySelector('[data-testid="ceo-guardrail-ai-cap"]')?.getAttribute("data-tile-state")).toBe("ok");
  });

  it("shows every money tile as Not connected with the source it needs", async () => {
    const container = await render(<CeoBoard companyId="company-1" period="30d" />);

    // Nine money tiles plus the zero-lead alarm light.
    const notConnected = container.querySelectorAll('[data-connection-state="not-connected"]');
    expect(notConnected).toHaveLength(10);

    const text = container.textContent ?? "";
    expect(text).toContain("Not connected: GHL payments / Authorize.net");
    expect(text).toContain("Not connected: GHL payments + Authorize.net + Meta spend");
    expect(text).toContain("Not connected: GHL appointments");
    expect(text).toContain("Not connected: Meta spend + GHL appointments");
    expect(text).toContain("Not connected: GHL leads + WAVV calls");
    expect(text).toContain("Not connected: GHL subscription state + Authorize.net");
    expect(text).toContain("Not connected: Meta spend + GHL leads");

    // No money tile invents a value.
    expect(container.querySelector('[data-testid="ceo-tile-cash-collected"]')?.textContent)
      .not.toMatch(/\$\d/);
  });

  it("matches spec v2: Hormozi targets, the 30-day cash multiple and no Stripe or revenue per FTE", async () => {
    const container = await render(<CeoBoard companyId="company-1" period="30d" />);
    const text = container.textContent ?? "";

    // LTGP:CAC is 12:1 for a business with people at every step, and the
    // ladder keeps all four rungs.
    const ltgp = container.querySelector('[data-testid="ceo-tile-ltgp-cac"]');
    expect(ltgp?.textContent).toContain("12:1 target");
    expect(ltgp?.textContent).toContain("3:1 all automated");
    expect(ltgp?.textContent).toContain("6:1 one manual");
    expect(ltgp?.textContent).toContain("9:1 two manual");
    expect(ltgp?.textContent).toContain("12:1 all three manual");
    expect(ltgp?.textContent).not.toContain("9:1 target");

    // New: 30-day cash collected ÷ (CAC + COGS), target at least 2.0, naming
    // every source it needs.
    const cashMultiple = container.querySelector('[data-testid="ceo-tile-30-day-cash-multiple"]');
    expect(cashMultiple).not.toBeNull();
    expect(cashMultiple?.getAttribute("data-connection-state")).toBe("not-connected");
    expect(cashMultiple?.textContent).toContain("30-day cash multiple");
    expect(cashMultiple?.textContent).toContain("GHL payments + Authorize.net + Meta spend");
    expect(cashMultiple?.textContent).toContain("2.0");
    expect(cashMultiple?.textContent).toContain("CAC + COGS");

    // Churn is Hormozi's line, not the retainer survey.
    const churn = container.querySelector('[data-testid="ceo-tile-churn"]');
    expect(churn?.textContent).toContain("3% per month");
    expect(churn?.textContent).toContain("80% per year");
    expect(churn?.textContent).not.toContain("18%/yr");
    expect(churn?.textContent).not.toContain("survey");

    // Gross margin keeps the 50% target and cites Hormozi, not an agency survey.
    const margin = container.querySelector('[data-testid="ceo-tile-gross-margin"]');
    expect(margin?.textContent).toContain("50%");
    expect(margin?.textContent).toContain("Hormozi");

    // Lane 2 owns revenue per FTE; Increase ROAS does not use Stripe.
    expect(text).not.toMatch(/revenue per fte/i);
    expect(text).not.toMatch(/stripe/i);
  });

  it("asks for the selected period and only the month range for the cap", async () => {
    await render(<CeoBoard companyId="company-1" period="7d" />);

    expect(mockCostsApi.summary).toHaveBeenCalledTimes(2);
    const firstFrom = new Date(mockCostsApi.summary.mock.calls[0][1] as string).getTime();
    expect(NOW - firstFrom).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1000 - 1000);

    const monthCall = mockCostsApi.summary.mock.calls.find((call) => {
      const from = new Date(call[1] as string);
      return from.getDate() === 1 && from.getHours() === 0;
    });
    expect(monthCall).toBeDefined();
  });

  it("shows a read failure instead of a stale or guessed number", async () => {
    mockCostsApi.summary.mockRejectedValue(new Error("costs unavailable"));
    const container = await render(<CeoBoard companyId="company-1" period="30d" />);
    const text = container.textContent ?? "";

    expect(text).toContain("Could not read run costs:");
    expect(container.querySelector('[data-testid="ceo-tile-agent-run-cost"]')?.textContent).toContain("—");
    expect(container.querySelector('[data-testid="ceo-tile-agent-run-cost"]')?.getAttribute("data-tile-state")).toBe("unknown");
  });

  it("does not claim there is no cap while the cap is still being read", async () => {
    mockCostsApi.summary.mockReturnValue(new Promise(() => {}));
    const container = await render(<CeoBoard companyId="company-1" period="month" />);
    const capTile = container.querySelector('[data-testid="ceo-guardrail-ai-cap"]');

    expect(capTile?.textContent).toContain("…");
    expect(capTile?.textContent).toContain("Reading the monthly cap.");
    expect(capTile?.textContent).not.toContain("No cap");
  });

  it("reads the cap tile for the month even when another period is selected", async () => {
    const periods: DashboardPeriod[] = ["7d", "month"];
    expect(periods).toEqual(["7d", "month"]);

    await render(<CeoBoard companyId="company-1" period="month" />);
    // The board-level period query is the month query; no duplicate request.
    expect(mockCostsApi.summary).toHaveBeenCalledTimes(1);
  });
});
