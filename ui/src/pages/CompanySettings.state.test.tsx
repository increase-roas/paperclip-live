// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySettings } from "./CompanySettings";

const state = vi.hoisted(() => ({
  loading: false,
  error: null as Error | null,
  selectedCompany: null as { id: string; name: string; issuePrefix: string } | null,
  retryCompanies: vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [],
    selectedCompany: state.selectedCompany,
    selectedCompanyId: "company-1",
    setSelectedCompanyId: vi.fn(),
    loading: state.loading,
    error: state.error,
    retryCompanies: state.retryCompanies,
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../context/ToastContext", () => ({
  useOptionalToastActions: () => ({ pushToast: vi.fn() }),
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("CompanySettings query states", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    state.loading = false;
    state.error = null;
    state.selectedCompany = null;
    state.retryCompanies.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    container.remove();
  });

  function renderPage() {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanySettings />
        </QueryClientProvider>,
      );
    });
  }

  it("shows a skeleton while the company list is loading", () => {
    state.loading = true;
    renderPage();

    expect(container.querySelectorAll("[data-slot='skeleton']").length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain("No organization selected");
  });

  it("names the failed organization load and offers a retry", () => {
    state.error = new Error("upstream unavailable");
    renderPage();

    expect(container.querySelector("[role='alert']")?.textContent).toContain("Couldn't load organization settings");
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Retry");
    expect(retry).toBeTruthy();

    act(() => retry!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(state.retryCompanies).toHaveBeenCalledTimes(1);
  });

  it("explains how to choose an organization instead of showing a bare sentence", () => {
    renderPage();

    expect(container.textContent).toContain("No organization selected");
    expect(container.textContent).toContain("Select an organization from the switcher above to edit its settings.");
  });
});
