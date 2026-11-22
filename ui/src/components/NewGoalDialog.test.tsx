// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NewGoalDialog } from "./NewGoalDialog";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

if (!globalThis.ResizeObserver) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({
    newGoalOpen: true,
    newGoalDefaults: {},
    closeNewGoal: vi.fn(),
  }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip", issuePrefix: "PAP" },
  }),
}));

vi.mock("../api/goals", () => ({
  goalsApi: {
    list: vi.fn(async () => []),
    create: vi.fn(),
  },
}));

vi.mock("../api/assets", () => ({
  assetsApi: { uploadImage: vi.fn() },
}));

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  flushSync(() => root.unmount());
  queryClient.clear();
  container.remove();
});

async function flush() {
  flushSync(() => {});
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => {});
}

it("gives the goal dialog an accessible name and labels its icon controls", async () => {
  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <NewGoalDialog />
      </QueryClientProvider>,
    );
  });
  await flush();

  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  const title = dialog.querySelector<HTMLElement>('[data-slot="dialog-title"]');
  expect(title?.textContent?.trim()).toBe("New goal");
  expect(dialog.getAttribute("aria-labelledby")).toBe(title?.id);

  expect(dialog.querySelector<HTMLInputElement>('input[aria-label="Goal title"]')).not.toBeNull();
  expect(dialog.querySelector('button[aria-label="Expand goal editor"]')).not.toBeNull();
  expect(dialog.querySelector('button[aria-label="Close goal editor"]')).not.toBeNull();
});
