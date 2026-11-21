// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentAuthReconnectNotice } from "./AgentAuthReconnectNotice";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
  useNavigate: () => navigate,
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("AgentAuthReconnectNotice", () => {
  it("names the provider and links to the reconnect surface", async () => {
    const onResume = vi.fn();
    await act(async () => root.render(
      <AgentAuthReconnectNotice providerLabel="Claude" reconnectHref="/agents/atlas/runtime" onResume={onResume} />,
    ));
    expect(container.textContent).toContain("Reconnect Claude to continue");
    expect(container.textContent).toContain("Work stopped so runs do not fail in a loop");
    expect(container.querySelector('a[href="/agents/atlas/runtime"]')?.textContent).toBe("Reconnect Claude");
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Resume agent")!.click());
    expect(onResume).toHaveBeenCalledOnce();
  });

  it("shows pending resume state without removing the reconnect path", async () => {
    await act(async () => root.render(
      <AgentAuthReconnectNotice providerLabel="Claude" reconnectHref="/agents/atlas/runtime" onResume={() => {}} resuming />,
    ));
    expect(container.textContent).toContain("Resuming…");
    expect(container.querySelector('a[href="/agents/atlas/runtime"]')).not.toBeNull();
  });
});
