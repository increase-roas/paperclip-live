// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Approval } from "@paperclipai/shared";
import { ThemeProvider } from "../context/ThemeContext";
import { ApiError } from "@/api/client";
import { ApprovalDetail } from "./ApprovalDetail";

const mockNavigate = vi.hoisted(() => vi.fn());
const mockApprovalsApi = vi.hoisted(() => ({
  get: vi.fn(),
  listComments: vi.fn(),
  listIssues: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  addComment: vi.fn(),
}));
const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  remove: vi.fn(),
}));
const mockSetSelectedCompanyId = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  useParams: () => ({ approvalId: "approval-1" }),
  useNavigate: () => mockNavigate,
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
  Link: ({ children, to }: { children?: ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

vi.mock("../context/CompanyContext", () => {
  const value = {
    selectedCompanyId: "company-1",
    setSelectedCompanyId: mockSetSelectedCompanyId,
  };
  return {
    useCompany: () => value,
    useOptionalCompany: () => value,
  };
});

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

vi.mock("../api/approvals", () => ({ approvalsApi: mockApprovalsApi }));
vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function approval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "request_board_approval",
    requestedByAgentId: null,
    requestedByUserId: null,
    status: "pending",
    payload: { title: "Approve the launch plan", summary: "Ready for review." },
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date("2026-11-21T00:00:00.000Z"),
    updatedAt: new Date("2026-11-21T00:00:00.000Z"),
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitFor(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

describe("ApprovalDetail decision notes", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockNavigate.mockReset();
    mockApprovalsApi.get.mockReset().mockResolvedValue(approval());
    mockApprovalsApi.listComments.mockReset().mockResolvedValue([]);
    mockApprovalsApi.listIssues.mockReset().mockResolvedValue([]);
    mockApprovalsApi.approve.mockReset().mockResolvedValue(approval({ status: "approved" }));
    mockApprovalsApi.reject.mockReset().mockResolvedValue(approval({ status: "rejected" }));
    mockApprovalsApi.requestRevision.mockReset().mockResolvedValue(approval({ status: "revision_requested" }));
    mockApprovalsApi.resubmit.mockReset();
    mockApprovalsApi.addComment.mockReset();
    mockAgentsApi.list.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    container.remove();
  });

  function render() {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <ApprovalDetail />
          </ThemeProvider>
        </QueryClientProvider>,
      );
    });
    return { root, queryClient };
  }

  function noteField() {
    return container.querySelector<HTMLTextAreaElement>("#approval-decision-note");
  }

  function typeNote(value: string) {
    const field = noteField()!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => {
      setter.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function clickButton(label: string) {
    const button = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    expect(button).toBeDefined();
    act(() => button!.click());
  }

  it("sends the entered note with Approve", async () => {
    const { root, queryClient } = render();
    try {
      await waitFor(() => expect(noteField()).not.toBeNull());
      typeNote("Ship it after the Friday check.");
      clickButton("Approve");
      await waitFor(() => expect(mockApprovalsApi.approve).toHaveBeenCalledWith(
        "approval-1",
        "Ship it after the Friday check.",
      ));
    } finally {
      act(() => root.unmount());
      queryClient.clear();
    }
  });

  it.each([
    ["Reject", "reject"],
    ["Request revision", "requestRevision"],
  ] as const)("sends a blank note as undefined with %s", async (label, apiMethod) => {
    const { root, queryClient } = render();
    try {
      await waitFor(() => expect(noteField()).not.toBeNull());
      clickButton(label);
      await waitFor(() => expect(mockApprovalsApi[apiMethod]).toHaveBeenCalledWith("approval-1", undefined));
    } finally {
      act(() => root.unmount());
      queryClient.clear();
    }
  });

  it("shows the recorded decision note on a resolved approval", async () => {
    mockApprovalsApi.get.mockResolvedValue(approval({
      status: "rejected",
      decisionNote: "Needs a smaller first release.",
    }));
    const { root, queryClient } = render();
    try {
      await waitFor(() => expect(container.textContent).toContain("Decision note: Needs a smaller first release."));
      expect(noteField()).toBeNull();
    } finally {
      act(() => root.unmount());
      queryClient.clear();
    }
  });
});

describe("ApprovalDetail load recovery", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockNavigate.mockReset();
    mockApprovalsApi.get.mockReset();
    mockApprovalsApi.listComments.mockReset().mockResolvedValue([]);
    mockApprovalsApi.listIssues.mockResolvedValue([]);
    mockAgentsApi.list.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    container.remove();
  });

  function render() {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <ApprovalDetail />
          </ThemeProvider>
        </QueryClientProvider>,
      );
    });
    return { root, queryClient };
  }

  function findButton(label: string) {
    return [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
  }

  it("offers a retry when the approval fails to load", async () => {
    mockApprovalsApi.get.mockRejectedValue(new ApiError("Server error", 500, { error: "internal" }));
    const { root, queryClient } = render();
    try {
      await waitFor(() => expect(findButton("Retry")).toBeDefined());
      expect(container.textContent).not.toContain("Approval not found");
      expect(container.textContent).toContain("Back to approvals");
    } finally {
      act(() => root.unmount());
      queryClient.clear();
    }
  });

  it("says not found, without a retry, for a missing approval", async () => {
    mockApprovalsApi.get.mockRejectedValue(new ApiError("Not found", 404, { error: "not_found" }));
    const { root, queryClient } = render();
    try {
      await waitFor(() => expect(container.textContent).toContain("Not found"));
      expect(findButton("Retry")).toBeUndefined();
      expect(container.textContent).toContain("Back to approvals");
    } finally {
      act(() => root.unmount());
      queryClient.clear();
    }
  });
});
