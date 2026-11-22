// @vitest-environment jsdom

import { act, type AnchorHTMLAttributes } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Approval } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Approvals } from "./Approvals";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  agentsList: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("../api/approvals", () => ({
  approvalsApi: {
    list: api.list,
    approve: api.approve,
    reject: api.reject,
  },
}));

vi.mock("../api/agents", () => ({
  agentsApi: { list: api.agentsList },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../components/PageTabBar", () => ({
  PageTabBar: () => null,
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => api.navigate,
  useLocation: () => ({ pathname: "/approvals/pending", search: "", hash: "" }),
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "hire_agent",
    requestedByAgentId: null,
    requestedByUserId: null,
    status: "pending",
    payload: { name: "Scout" },
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date("2026-11-21T00:00:00.000Z"),
    updatedAt: new Date("2026-11-21T00:00:00.000Z"),
    ...overrides,
  };
}

function queryButton(container: HTMLElement, label: string): HTMLButtonElement | null {
  return (Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined) ?? null;
}

async function waitForButton(container: HTMLElement, label: string): Promise<HTMLButtonElement> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 3_000) {
    const button = queryButton(container, label);
    if (button) return button;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`Button "${label}" not found`);
}

describe("Approvals list quick decisions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    api.list.mockReset().mockResolvedValue([createApproval()]);
    api.approve.mockReset().mockResolvedValue(createApproval({ status: "approved" }));
    api.reject.mockReset().mockResolvedValue(createApproval({ status: "rejected" }));
    api.agentsList.mockReset().mockResolvedValue([]);
    api.navigate.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    container.remove();
  });

  async function renderPage() {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Approvals />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("approves in place without opening the detail page", async () => {
    await renderPage();

    await act(async () => {
      (await waitForButton(container, "Approve")).click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(api.approve).toHaveBeenCalledWith("approval-1", undefined);
    expect(api.navigate).not.toHaveBeenCalled();
  });

  it("requires a second click before rejecting", async () => {
    await renderPage();

    await act(async () => {
      (await waitForButton(container, "Reject")).click();
    });

    expect(api.reject).not.toHaveBeenCalled();
    expect(queryButton(container, "Confirm reject")).not.toBeNull();
    expect(queryButton(container, "Reject")).toBeNull();

    await act(async () => {
      (await waitForButton(container, "Confirm reject")).click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(api.reject).toHaveBeenCalledTimes(1);
    expect(api.reject).toHaveBeenCalledWith("approval-1", undefined);
    expect(api.navigate).not.toHaveBeenCalled();
  });

  it("disarms the reject confirmation without deciding", async () => {
    await renderPage();

    await act(async () => {
      (await waitForButton(container, "Reject")).click();
    });
    await act(async () => {
      (await waitForButton(container, "Cancel")).click();
    });

    expect(api.reject).not.toHaveBeenCalled();
    expect(queryButton(container, "Confirm reject")).toBeNull();
    expect(queryButton(container, "Reject")).not.toBeNull();
  });

  it("disarms the reject confirmation when the operator approves instead", async () => {
    await renderPage();

    await act(async () => {
      (await waitForButton(container, "Reject")).click();
    });
    await act(async () => {
      (await waitForButton(container, "Approve")).click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(api.approve).toHaveBeenCalledWith("approval-1", undefined);
    expect(api.reject).not.toHaveBeenCalled();
    expect(queryButton(container, "Confirm reject")).toBeNull();
  });
});
