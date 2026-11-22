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

function createApproval(id: string, name: string, createdAt: string): Approval {
  return {
    id,
    companyId: "company-1",
    type: "hire_agent",
    requestedByAgentId: null,
    requestedByUserId: null,
    status: "pending",
    payload: { name },
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
  };
}

function buttonsWithLabel(container: HTMLElement, label: string): HTMLButtonElement[] {
  return (Array.from(container.querySelectorAll("button")) as HTMLButtonElement[]).filter(
    (candidate) => candidate.textContent?.trim() === label,
  );
}

describe("Approvals page per-card pending state", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    api.list.mockReset();
    api.approve.mockReset();
    api.reject.mockReset();
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

  it("keeps the other pending cards actionable while one decision is in flight", async () => {
    const alpha = createApproval("approval-alpha", "Alpha", "2026-11-22T00:00:00.000Z");
    const beta = createApproval("approval-beta", "Beta", "2026-11-21T00:00:00.000Z");
    let resolveApprove: ((approval: Approval) => void) | undefined;
    api.list.mockResolvedValue([alpha, beta]);
    api.approve.mockImplementation(
      () =>
        new Promise<Approval>((resolve) => {
          resolveApprove = resolve;
        }),
    );

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Approvals />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => {
      expect(buttonsWithLabel(container, "Approve")).toHaveLength(2);
    });

    await act(async () => {
      buttonsWithLabel(container, "Approve")[0].click();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(api.approve).toHaveBeenCalledWith("approval-alpha", undefined);
    });

    await act(async () => {
      await vi.waitFor(() => {
        expect(buttonsWithLabel(container, "Approving...")).toHaveLength(1);
      });
    });
    const pendingLabels = buttonsWithLabel(container, "Approving...");
    expect(pendingLabels).toHaveLength(1);
    expect(pendingLabels[0].disabled).toBe(true);

    const stillActionable = buttonsWithLabel(container, "Approve");
    expect(stillActionable).toHaveLength(1);
    expect(stillActionable[0].disabled).toBe(false);
    expect(buttonsWithLabel(container, "Reject").filter((button) => button.disabled)).toHaveLength(1);

    await act(async () => {
      resolveApprove?.(alpha);
      await Promise.resolve();
    });
  });
});
