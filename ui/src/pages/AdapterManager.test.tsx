// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdapterManager } from "./AdapterManager";

const listMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/adapters", () => ({
  adaptersApi: {
    list: () => listMock(),
  },
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip" },
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: vi.fn() }),
}));

async function flushReact() {
  for (let index = 0; index < 3; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("AdapterManager", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    if (root) flushSync(() => root?.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  function render() {
    root = createRoot(container);
    flushSync(() => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <AdapterManager />
        </QueryClientProvider>,
      );
    });
  }

  it("shows the load failure and retries instead of claiming no adapters are installed", async () => {
    listMock.mockRejectedValueOnce(new Error("adapters unavailable"));
    render();
    await flushReact();

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Couldn't load adapters");
    expect(alert?.textContent).toContain("Retry");
    expect(container.textContent).not.toContain("No external adapters installed");

    listMock.mockResolvedValue([]);
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Retry"));
    flushSync(() => retry?.click());
    await flushReact();

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("External Adapters");
    expect(container.textContent).toContain("Built-in Adapters");
  });
});
