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

const companyState = vi.hoisted(() => ({ selectedCompanyId: "company-1" as string | null }));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: companyState.selectedCompanyId }),
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

function createApproval(): Approval {
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
  };
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!button) throw new Error(`Button "${label}" not found`);
  return button as HTMLButtonElement;
}

function typeInto(element: HTMLTextAreaElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  setValue?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Approvals page decision notes", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    api.list.mockReset().mockResolvedValue([createApproval()]);
    api.approve.mockReset().mockResolvedValue(createApproval());
    api.reject.mockReset().mockResolvedValue(createApproval());
    api.agentsList.mockReset().mockResolvedValue([]);
    api.navigate.mockReset();
    companyState.selectedCompanyId = "company-1";
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
    await vi.waitFor(() => {
      expect(findButton(container, "Approve")).toBeTruthy();
    });
  }

  it("sends a list decision note with approve", async () => {
    await renderPage();

    act(() => findButton(container, "Add note").click());
    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();
    act(() => typeInto(textarea as HTMLTextAreaElement, "Hire after onboarding review"));
    await act(async () => {
      findButton(container, "Approve").click();
      await Promise.resolve();
    });

    await act(async () => {
      await vi.waitFor(() => {
        expect(api.approve).toHaveBeenCalledWith("approval-1", "Hire after onboarding review");
      });
    });
  });

  it("names the empty pending queue and its purpose", async () => {
    api.list.mockResolvedValue([]);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Approvals />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain("No pending approvals");
    });
    expect(container.textContent).toContain("Approvals appear here when an agent needs a decision from you.");
  });

  it("asks for an organization instead of rendering an empty page", async () => {
    companyState.selectedCompanyId = null;
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Approvals />
        </QueryClientProvider>,
      );
    });
    expect(container.textContent).toContain("Select an organization");
    expect(container.textContent).toContain("Choose an organization to see the approvals that need a decision.");
  });

  it("sends a list decision note with reject", async () => {
    await renderPage();

    act(() => findButton(container, "Add note").click());
    const textarea = container.querySelector("textarea");
    act(() => typeInto(textarea as HTMLTextAreaElement, "Revisit after the launch"));
    await act(async () => {
      findButton(container, "Reject").click();
      await Promise.resolve();
    });
    await act(async () => {
      findButton(container, "Confirm reject").click();
      await Promise.resolve();
    });

    await act(async () => {
      await vi.waitFor(() => {
        expect(api.reject).toHaveBeenCalledWith("approval-1", "Revisit after the launch");
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });
});
