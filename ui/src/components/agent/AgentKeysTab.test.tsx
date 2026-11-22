// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ToastProvider } from "../../context/ToastContext";
import { AgentKeysTab } from "./AgentKeysTab";

const listKeys = vi.hoisted(() => vi.fn());
const revokeKey = vi.hoisted(() => vi.fn());

vi.mock("@/api/agents", () => ({
  agentsApi: {
    listKeys: (...args: unknown[]) => listKeys(...args),
    revokeKey: (...args: unknown[]) => revokeKey(...args),
    createKey: vi.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).ResizeObserver = (globalThis as any).ResizeObserver ?? ResizeObserverStub;

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

function buttonIn(scope: ParentNode, label: string) {
  return [...scope.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === label);
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
          <AgentKeysTab agentId="agent-1" companyId="company-1" confirmRevoke={false} />
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

it("revokes immediately when confirmation is off, which is the production variant", async () => {
  await act(async () => {
    buttonIn(container, "Revoke")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await vi.waitFor(() => expect(revokeKey).toHaveBeenCalledWith("agent-1", "key-1", "company-1"));
  expect(document.body.textContent).not.toContain("Revoke this API key?");
});
