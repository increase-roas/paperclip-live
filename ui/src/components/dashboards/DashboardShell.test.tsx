// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetOnboardingOffers } from "@/lib/onboarding-auto-open";
import { DashboardShell } from "./DashboardShell";

const routerState = vi.hoisted(() => ({
  params: {} as { boardId?: string },
  search: "",
  pathname: "/INC/dashboard/ceo",
  setSearchParams: vi.fn(),
}));

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1" as string | null,
  companies: [{ id: "company-1" }],
}));

const mockOpenOnboarding = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockDashboardBoardsApi = vi.hoisted(() => ({ readingOrder: vi.fn() }));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode } & Record<string, unknown>) => (
    <a href={to} {...props}>{children}</a>
  ),
  Navigate: ({ to }: { to: string }) => <div data-testid="router-navigate" data-to={to} />,
  useParams: () => routerState.params,
  useLocation: () => ({ pathname: routerState.pathname, search: "", hash: "", state: null }),
  useSearchParams: () => [new URLSearchParams(routerState.search), routerState.setSearchParams],
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("@/context/DialogContext", () => ({
  useDialogActions: () => ({ openOnboarding: mockOpenOnboarding }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

vi.mock("@/api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("@/api/dashboardBoards", () => ({ dashboardBoardsApi: mockDashboardBoardsApi }));

vi.mock("./ceo/CeoBoard", () => ({
  CeoBoard: () => <div data-testid="ceo-board-stub" />,
}));

vi.mock("./sales/SalesBoard", () => ({
  SalesBoard: () => <div data-testid="sales-board-stub" />,
}));

vi.mock("./marketing/MarketingBoard", () => ({
  MarketingBoard: () => <div data-testid="marketing-board-stub" />,
}));

vi.mock("./human-employees/HumanEmployeesBoard", () => ({
  HumanEmployeesBoard: () => <div data-testid="human-employees-board-stub" />,
}));

vi.mock("./fulfillment/FulfillmentBoard", () => ({
  FulfillmentBoard: () => <div data-testid="fulfillment-board-stub" />,
}));

vi.mock("./ai-cost/AiCostBoard", () => ({
  AiCostBoard: () => <div data-testid="ai-cost-board-stub" />,
}));

vi.mock("./automation-health/AutomationHealthBoard", () => ({
  AutomationHealthBoard: () => <div data-testid="automation-health-board-stub" />,
}));

vi.mock("./tools-connectors/ToolsConnectorsBoard", () => ({
  ToolsConnectorsBoard: () => <div data-testid="tools-connectors-board-stub" />,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Array<{ root: Root; container: HTMLDivElement }> = [];

async function renderShell() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push({ root, container });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <DashboardShell />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  return container;
}

beforeEach(() => {
  routerState.params = {};
  routerState.search = "";
  routerState.pathname = "/INC/dashboard/ceo";
  resetOnboardingOffers();
  mockAgentsApi.list.mockResolvedValue([{ id: "agent-1", companyId: "company-1", status: "idle", pauseReason: null }]);
  mockDashboardBoardsApi.readingOrder.mockResolvedValue({});
});

afterEach(async () => {
  for (const { root, container } of roots.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("DashboardShell", () => {
  it("renders the eight boards in the spec order and opens the CEO board by default", async () => {
    const container = await renderShell();

    const tabs = Array.from(container.querySelectorAll('[data-testid^="dashboard-tab-"]'));
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "CEO",
      "Sales",
      "Marketing",
      "Fulfillment",
      "AI cost",
      "Automation health",
      "Tools & connectors",
      "Human employees",
    ]);

    expect(container.querySelector('[data-testid="dashboard-tab-ceo"]')?.getAttribute("aria-current")).toBe("page");
    expect(tabs.map((tab) => tab.getAttribute("href"))).toContain("/dashboard/sales");
    expect(container.querySelector('[data-testid="ceo-board-stub"]')).not.toBeNull();
    // Redundant "Paperclip operations" link removed from the tab bar header.
    expect(container.textContent).not.toContain("Paperclip operations");
  });

  it("puts the eight-question reading order strip above the CEO board with live statuses and metrics", async () => {
    mockDashboardBoardsApi.readingOrder.mockResolvedValue({
      statuses: { cash: "ok", "cash-multiple": "red" },
      metrics: { cash: "$48,500", "cash-multiple": "1.4×" },
    });
    const container = await renderShell();
    const strip = container.querySelector('[data-testid="dashboard-reading-order"]');
    const board = container.querySelector('[data-testid="ceo-board-stub"]');

    expect(strip).not.toBeNull();
    expect(board).not.toBeNull();
    if (strip && board) {
      expect(strip.compareDocumentPosition(board) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }

    const steps = Array.from(strip?.querySelectorAll("[data-reading-order-step]") ?? []);
    expect(steps).toHaveLength(8);
    expect(steps[0].getAttribute("data-state")).toBe("ok");
    expect(steps[0].textContent).toContain("$48,500");
    expect(steps[1].getAttribute("data-state")).toBe("red");
    expect(steps[1].getAttribute("data-attention")).toBe("true");
    expect(steps[1].textContent).toContain("1.4×");
    expect(mockDashboardBoardsApi.readingOrder).toHaveBeenCalledWith("company-1", "30d");
  });

  it("hides the reading order strip on the other seven dashboard tabs", async () => {
    for (const boardId of [
      "sales",
      "marketing",
      "fulfillment",
      "ai-cost",
      "automation-health",
      "tools-connectors",
      "human-employees",
    ]) {
      routerState.params = { boardId };
      const container = await renderShell();
      expect(container.querySelector('[data-testid="dashboard-reading-order"]')).toBeNull();
    }
  });

  it("renders registered lane 3 boards inside the shell", async () => {
    routerState.params = { boardId: "fulfillment" };
    const container = await renderShell();

    expect(container.querySelector('[data-testid="dashboard-tab-fulfillment"]')?.getAttribute("aria-current")).toBe("page");
    expect(container.querySelector('[data-testid="fulfillment-board-stub"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="ceo-board-stub"]')).toBeNull();
  });

  it("renders registered lane 2 boards inside the shell", async () => {
    routerState.params = { boardId: "sales" };
    const container = await renderShell();

    expect(container.querySelector('[data-testid="dashboard-tab-sales"]')?.getAttribute("aria-current")).toBe("page");
    expect(container.querySelector('[data-testid="sales-board-stub"]')).not.toBeNull();
  });

  it("sends an unknown board segment back to the CEO board", async () => {
    routerState.params = { boardId: "not-a-board" };
    const container = await renderShell();

    expect(container.querySelector('[data-testid="router-navigate"]')?.getAttribute("data-to")).toBe("/dashboard/ceo");
  });

  it("reads the period from the URL and writes the chosen one back", async () => {
    routerState.search = "period=7d";
    const container = await renderShell();

    expect(container.querySelector('[data-testid="dashboard-period-7d"]')?.getAttribute("aria-pressed")).toBe("true");

    const thirtyDays = container.querySelector('[data-testid="dashboard-period-30d"]') as HTMLButtonElement;
    await act(async () => {
      thirtyDays.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(routerState.setSearchParams).toHaveBeenCalledTimes(1);
    const next = routerState.setSearchParams.mock.calls[0][0] as URLSearchParams;
    expect(next.has("period")).toBe(false); // 30d is the default, so it is omitted
  });

  it("offers onboarding to a company with no agents exactly once", async () => {
    mockAgentsApi.list.mockResolvedValue([]);

    await renderShell();
    await renderShell();

    expect(mockOpenOnboarding).toHaveBeenCalledTimes(1);
    expect(mockOpenOnboarding).toHaveBeenCalledWith({ companyId: "company-1", initialStep: 3 });
  });

  it("sets a breadcrumb trail that names the open board", async () => {
    routerState.params = { boardId: "marketing" };
    await renderShell();

    expect(mockSetBreadcrumbs).toHaveBeenCalledWith([
      { label: "Dashboard", href: "/dashboard" },
      { label: "Marketing" },
    ]);
  });
});
