// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanyBotDetail, CompanyBotSummary } from "@paperclipai/shared";
import { Bots } from "./Bots";
import { BotDetail } from "./BotDetail";

const listMock = vi.hoisted(() => vi.fn());
const getMock = vi.hoisted(() => vi.fn());
const params = vi.hoisted(() => ({ botId: "" }));

vi.mock("@/api/bots", () => ({
  botsApi: {
    list: (companyId: string) => listMock(companyId),
    get: (companyId: string, botId: string) => getMock(companyId, botId),
  },
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1", name: "Paperclip" } }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  useParams: () => ({ botId: params.botId }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const researchBot: CompanyBotSummary = {
  id: "agent-1",
  slug: "research-analyst",
  name: "Research Analyst",
  purpose: "Researches accounts and markets with GBrain.",
  kind: "agent",
  registered: true,
  agentId: "agent-1",
  role: "researcher",
  title: "Research Analyst",
  status: "idle",
  adapterType: "hermes_gateway",
  grokBotTwin: true,
  gateway: { keyId: "gk_live_research", policy: "researcher", provider: "increase-roas-oauth-gateway" },
  note: null,
  updatedAt: "2026-11-21T12:00:00.000Z",
};

const funnelCatalogBot: CompanyBotSummary = {
  id: "catalog:funnel-builder",
  slug: "funnel-builder",
  name: "Funnel Builder",
  purpose: null,
  kind: "gateway",
  registered: false,
  agentId: null,
  role: null,
  title: null,
  status: "unregistered",
  adapterType: null,
  grokBotTwin: false,
  gateway: null,
  note: "Runs on the gateway website-builder policy with the full GHL scope set.",
  updatedAt: null,
};

describe("Bots", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    listMock.mockReset();
    getMock.mockReset();
    params.botId = "";
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const flush = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  async function render(element: React.ReactElement) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
    });
    await flush();
  }

  it("splits registered bots from known bots that are not registered yet", async () => {
    listMock.mockResolvedValue({ bots: [researchBot, funnelCatalogBot] });

    await render(<Bots />);

    const registered = container.querySelector('[data-bots-section="registered-bots"]');
    const unregistered = container.querySelector('[data-bots-section="not-registered-yet"]');
    expect(registered?.textContent).toContain("Research Analyst");
    expect(registered?.textContent).toContain("Grok twin");
    expect(registered?.textContent).toContain("gk_live_research");
    expect(registered?.textContent).toContain("researcher");
    expect(unregistered?.textContent).toContain("Funnel Builder");
    expect(unregistered?.textContent).toContain("No agent or gateway key yet.");
  });

  it("filters by gateway key id and policy", async () => {
    listMock.mockResolvedValue({ bots: [researchBot, funnelCatalogBot] });

    await render(<Bots />);
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Search bots"]');
    expect(input).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "website-builder");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();

    expect(container.textContent).not.toContain("Research Analyst");
  });

  it("shows the gateway link, routines, status and activity on a bot page", async () => {
    params.botId = "agent-1";
    const detail: CompanyBotDetail = {
      ...researchBot,
      routines: [
        {
          id: "routine-1",
          title: "Daily ad check",
          status: "active",
          triggers: [
            {
              kind: "schedule",
              cronExpression: "0 7 * * *",
              timezone: "America/New_York",
              enabled: true,
              nextRunAt: "2026-11-22T12:00:00.000Z",
              lastFiredAt: null,
            },
          ],
        },
      ],
      recentActivity: [
        {
          id: "activity-1",
          action: "agent.heartbeat",
          entityType: "agent",
          entityId: "agent-1",
          createdAt: "2026-11-21T12:00:00.000Z",
        },
      ],
    };
    getMock.mockResolvedValue(detail);

    await render(<BotDetail />);

    expect(getMock).toHaveBeenCalledWith("company-1", "agent-1");
    const text = container.textContent ?? "";
    expect(text).toContain("Researches accounts and markets with GBrain.");
    expect(text).toContain("gk_live_research");
    expect(text).toContain("researcher");
    expect(text).toContain("Daily ad check");
    expect(text).toContain("0 7 * * *");
    expect(text).toContain("America/New_York");
    expect(text).toContain("agent.heartbeat");
    expect(text).toContain("Open agent");
  });

  it("explains that an unregistered bot has no agent row or key yet", async () => {
    params.botId = "catalog:funnel-builder";
    getMock.mockResolvedValue({ ...funnelCatalogBot, routines: [], recentActivity: [] });

    await render(<BotDetail />);

    const text = container.textContent ?? "";
    expect(text).toContain("no Paperclip agent row yet");
    expect(text).toContain("No gateway key is linked to this bot yet.");
    expect(text).toContain("No routines assigned.");
    expect(text).toContain("No recorded activity.");
    expect(text).not.toContain("Open agent");
  });
});
