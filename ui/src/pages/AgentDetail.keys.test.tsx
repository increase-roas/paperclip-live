// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ToastProvider } from "../context/ToastContext";
import { KeysTab } from "./AgentDetail";

const listKeys = vi.hoisted(() => vi.fn());
const revokeKey = vi.hoisted(() => vi.fn());

vi.mock("../api/agents", () => ({
  agentsApi: {
    listKeys: (...args: unknown[]) => listKeys(...args),
    revokeKey: (...args: unknown[]) => revokeKey(...args),
    createKey: vi.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).ResizeObserver = (globalThis as any).ResizeObserver ?? ResizeObserverStub;

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

function buttonIn(scope: ParentNode, label: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === label,
  );
}

beforeEach(async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  listKeys.mockReset().mockResolvedValue([
    { id: "key-1", name: "production", scope: { kind: "standard" }, createdAt: new Date("2026-01-01T00:00:00.000Z"), revokedAt: null },
  ]);
  revokeKey.mockReset().mockResolvedValue(undefined);

  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <KeysTab agentId="agent-1" companyId="company-1" />
        </ToastProvider>
      </QueryClientProvider>,
    );
  });
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(container.textContent).toContain("production");
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  document.body.innerHTML = "";
});

it("asks before revoking an API key and sends the confirmed key", async () => {
  const revoke = buttonIn(container, "Revoke");
  expect(revoke).toBeTruthy();

  await act(async () => {
    revoke!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

  expect(revokeKey).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Revoke this API key?");
  expect(document.body.textContent).toContain("production stops working immediately");

  const confirm = buttonIn(document.body, "Revoke key");
  expect(confirm).toBeTruthy();
  await act(async () => {
    confirm!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

  await vi.waitFor(() => expect(revokeKey).toHaveBeenCalledWith("agent-1", "key-1", "company-1"));
});

it("keeps the key when the confirmation is dismissed", async () => {
  await act(async () => {
    buttonIn(container, "Revoke")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  const keep = buttonIn(document.body, "Keep key");
  expect(keep).toBeTruthy();

  await act(async () => {
    keep!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

  expect(revokeKey).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain("Revoke this API key?");
});
