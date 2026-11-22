// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HeartbeatRun } from "@paperclipai/shared";
import { AgentRecentRunUsagePanel } from "./AgentRecentRunUsagePanel";

const state = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/api/heartbeats", () => ({ heartbeatsApi: { list: state.list } }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}));

function run(overrides: Partial<HeartbeatRun>): HeartbeatRun {
  return {
    id: "run-1",
    companyId: "company-1",
    agentId: "agent-1",
    status: "succeeded",
    createdAt: new Date(Date.now() - 60_000),
    costUsd: 0,
    usageJson: { inputTokens: 100, outputTokens: 20, totalTokens: 120, billingType: "subscription" },
    resultJson: null,
    ...overrides,
  } as HeartbeatRun;
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

async function render() {
  await act(async () => {
    root.render(<QueryClientProvider client={client}><AgentRecentRunUsagePanel agentId="agent-1" agentName="Atlas" companyId="company-1" /></QueryClientProvider>);
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.list.mockResolvedValue([
    run({ id: "run-new", createdAt: new Date(Date.now() - 60_000) }),
    run({ id: "run-old", createdAt: new Date(Date.now() - 86_400_000), costUsd: 0.05,
      usageJson: { inputTokens: 10, cachedInputTokens: 5, outputTokens: 1, totalTokens: 16, billingType: "api" } }),
    run({ id: "run-unpriced", createdAt: new Date(Date.now() - 172_800_000), costUsd: null, usageJson: { costStatus: "unpriced" } }),
    run({ id: "run-stale", createdAt: new Date(Date.now() - 8 * 86_400_000) }),
  ]);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
});

describe("AgentRecentRunUsagePanel", () => {
  it("shows the seven-day totals, per-run tokens, and cost state", async () => {
    await render();
    expect(container.textContent).toContain("Recent runs · last 7 days");
    expect(container.textContent).toContain("3 runs");
    expect(container.textContent).toContain("136");
    expect(container.textContent).toContain("in 10 (+5 cached) · out 1");
    expect(container.textContent).toContain("Included");
    expect(container.textContent).toContain("Unpriced");
    expect(container.textContent).not.toContain("run-stale");
    expect(container.querySelector('a[href="/agents/agent-1/runs/run-new"]')).not.toBeNull();
  });

  it("shows an empty state when the window has no runs", async () => {
    state.list.mockResolvedValue([]);
    await render();
    expect(container.textContent).toContain("No runs for Atlas in the last 7 days.");
  });
});
