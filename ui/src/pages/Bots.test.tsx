// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KNOWN_GATEWAY_BOTS } from "@paperclipai/shared";
import type { CompanyBotDetail, CompanyBotSummary } from "@paperclipai/shared";
import { catalogGatewayLink } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import { Bots } from "./Bots";
import { BotDetail } from "./BotDetail";

const listMock = vi.hoisted(() => vi.fn());
const getMock = vi.hoisted(() => vi.fn());
const gatewaySummaryMock = vi.hoisted(() => vi.fn());
const registrationMock = vi.hoisted(() => vi.fn());
const setBreadcrumbsMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());
const params = vi.hoisted(() => ({ botId: "" }));

vi.mock("@/api/bots", () => ({
  botsApi: {
    list: (companyId: string) => listMock(companyId),
    get: (companyId: string, botId: string) => getMock(companyId, botId),
    gateway: vi.fn(),
    gatewaySummary: (companyId: string, botId: string) => gatewaySummaryMock(companyId, botId),
    registration: (companyId: string) => registrationMock(companyId),
  },
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1", name: "Paperclip" } }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  useParams: () => ({ botId: params.botId }),
  useNavigate: () => navigateMock,
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
  gateway: {
    keyId: "gk_live_research",
    policy: "researcher",
    provider: "increase-roas-oauth-gateway",
    source: "metadata",
  },
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

/**
 * The roster entry the server derives for a known gateway bot that has no
 * agent row yet. `<BotDetail>` must render every one of them, so the fixtures
 * come from the shipped catalog rather than a hand-written pair.
 */
function catalogFixture(known: (typeof KNOWN_GATEWAY_BOTS)[number]): CompanyBotSummary {
  return {
    id: `catalog:${known.slug}`,
    slug: known.slug,
    name: known.name,
    purpose: known.purpose,
    kind: "gateway",
    registered: false,
    agentId: null,
    role: null,
    title: null,
    status: "unregistered",
    adapterType: null,
    grokBotTwin: false,
    gateway: catalogGatewayLink(known),
    note: known.note,
    updatedAt: null,
  };
}

describe("Bots", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    listMock.mockReset();
    getMock.mockReset();
    gatewaySummaryMock.mockReset();
    registrationMock.mockReset();
    registrationMock.mockResolvedValue({ companyId: "company-1", companyName: "Paperclip", entries: [], creates: 0, skips: 0 });
    gatewaySummaryMock.mockResolvedValue({
      connected: false,
      state: "disabled",
      message: "Gateway bot pages are off. Set PAPERCLIP_GATEWAY_BOTS_ENABLED=true to read them.",
    });
    setBreadcrumbsMock.mockReset();
    navigateMock.mockReset();
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

  it("sets a Bots breadcrumb so the mobile header keeps its title and menu", async () => {
    listMock.mockResolvedValue({ bots: [] });

    await render(<Bots />);

    expect(setBreadcrumbsMock).toHaveBeenCalledWith([{ label: "Bots" }]);
  });

  it("sets a bot breadcrumb with a link back to the roster", async () => {
    params.botId = "agent-1";
    getMock.mockResolvedValue({ ...researchBot, routines: [], recentActivity: [] });

    await render(<BotDetail />);

    expect(setBreadcrumbsMock).toHaveBeenCalledWith([
      { label: "Bots", href: "/bots" },
      { label: "Research Analyst" },
    ]);
  });

  it("shows the live gateway fingerprint, policy and usage when the gateway answers", async () => {
    params.botId = "agent-1";
    getMock.mockResolvedValue({ ...researchBot, routines: [], recentActivity: [] });
    gatewaySummaryMock.mockResolvedValue({
      connected: true,
      summary: {
        agent: "research-analyst",
        name: "research-analyst",
        preset: { name: "researcher", description: "Researches accounts." },
        enabled: true,
        hasKey: true,
        key: {
          present: true,
          algorithm: "sha256",
          fingerprint: "sha256:4b1d9c2e7a01",
          createdAt: "2026-11-18T14:02:11.000Z",
          rotatedAt: "2026-11-21T09:30:00.000Z",
          updatedAt: "2026-11-21T09:30:00.000Z",
        },
        providers: { ghl: "read" },
        grantedProviders: ["ghl"],
        policy: {
          mode: "drafts_only",
          allowDelete: false,
          allowOutbound: true,
          allowAgencyWrite: false,
          allowBulk: false,
          allowSpend: false,
          allowBuild: false,
          outboundChannels: ["slack"],
          locations: "*",
          secrets: ["ghl-token"],
          admin: false,
          role: "researcher",
        },
        usage: {
          last24h: { requests: 42, errors: 1 },
          last7d: { requests: 310, errors: 4 },
          lastUsedAt: "2026-11-22T05:10:58.000Z",
        },
        audit: [
          {
            id: 9182,
            at: "2026-11-22T05:10:58.000Z",
            method: "POST",
            path: "/contacts/abc123def456/notes",
            status: 201,
            ok: true,
            tokenType: "location",
            source: "rest",
            undoOf: null,
            undoneBy: null,
          },
        ],
        generatedAt: "2026-11-22T05:12:00.000Z",
      },
    });

    await render(<BotDetail />);
    const text = container.textContent ?? "";

    expect(text).toContain("Live gateway");
    expect(text).toContain("sha256:4b1d9c2e7a01");
    expect(text).toContain("drafts_only");
    expect(text).toContain("outbound");
    expect(text).not.toContain("delete");
    expect(text).toContain("ghl-token");
    expect(text).toContain("POST /contacts/abc123def456/notes");
    expect(gatewaySummaryMock).toHaveBeenCalledWith("company-1", "agent-1");
  });

  it("explains a gateway that is off without hiding the rest of the bot page", async () => {
    params.botId = "agent-1";
    getMock.mockResolvedValue({ ...researchBot, routines: [], recentActivity: [] });

    await render(<BotDetail />);
    const text = container.textContent ?? "";

    expect(text).toContain("Gateway not connected");
    expect(text).toContain("PAPERCLIP_GATEWAY_BOTS_ENABLED");
    expect(text).toContain("gk_live_research");
    expect(text).toContain("What it does");
  });

  it("shows a policy read from the agent's gateway URL with the key id called out as missing", async () => {
    params.botId = "agent-1";
    getMock.mockResolvedValue({
      ...researchBot,
      gateway: {
        keyId: null,
        policy: "ads-checker",
        provider: "srv2155332.tailde26a1.ts.net:8443",
        source: "agent_config",
      },
      routines: [],
      recentActivity: [],
    });

    await render(<BotDetail />);
    const text = container.textContent ?? "";

    expect(text).toContain("ads-checker");
    expect(text).toContain("Key id not recorded");
    expect(text).toContain("read from this agent's gateway URL");
  });

  it("previews the registration plan with the apply action disabled", async () => {
    registrationMock.mockResolvedValue({
      companyId: "company-1",
      companyName: "Paperclip",
      creates: 1,
      skips: 1,
      entries: [
        {
          slug: "funnel-builder",
          name: "Funnel Builder",
          action: "create",
          reason: "No agent row yet; this bot already has a known purpose.",
          agent: {
            name: "Funnel Builder",
            role: "general",
            title: "Funnel Builder",
            adapterType: "hermes_gateway",
            status: "paused",
            metadata: { agentKind: "bot", bot: { purpose: "Builds funnels.", transport: "hermes_gateway" } },
          },
        },
        {
          slug: "kiwi",
          name: "Kiwi",
          action: "skip",
          reason: "An agent named like kiwi already exists in this company.",
          agent: null,
        },
      ],
    });
    listMock.mockResolvedValue({ bots: [funnelCatalogBot], suggestedAgents: [] });

    await render(<Bots />);

    const section = container.querySelector("[data-bots-registration-plan]");
    expect(section?.textContent).toContain("Registration plan");
    expect(section?.textContent).toContain("1 to create, 1 skipped");
    expect(section?.textContent).toContain("Would create");
    expect(section?.textContent).toContain("Funnel Builder");
    expect(section?.textContent).toContain("Skipped");
    expect(section?.textContent).toContain("pnpm bots:register -- --apply");
    const apply = [...(section?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.includes("Apply registration"));
    expect(apply?.disabled).toBe(true);
    expect(registrationMock).toHaveBeenCalledWith("company-1");
  });

  it("hides the registration plan when there is nothing to plan", async () => {
    listMock.mockResolvedValue({ bots: [researchBot], suggestedAgents: [] });

    await render(<Bots />);

    expect(container.querySelector("[data-bots-registration-plan]")).toBeNull();
  });

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
    expect(unregistered?.textContent).toContain("Runs on the gateway website-builder policy");
    expect(unregistered?.textContent).toContain("Not registered");
  });

  it("finds a known bot by the note that describes its work", async () => {
    const driveOrganizer = KNOWN_GATEWAY_BOTS.find((bot) => bot.slug === "drive-organizer")!;
    listMock.mockResolvedValue({ bots: [catalogFixture(driveOrganizer), researchBot] });

    await render(<Bots />);
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Search bots"]');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "shared drive");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain("Drive Organizer");
    expect(container.textContent).not.toContain("Research Analyst");
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
          source: "activity",
        },
        {
          id: "run-1",
          action: "run.succeeded",
          entityType: "heartbeat_run",
          entityId: "run-1",
          createdAt: "2026-11-21T11:00:00.000Z",
          source: "run",
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
    expect(text).toContain("run.succeeded");
    expect(text).toContain("Run");
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

  it("lists Hermes agents that are not tagged as bots", async () => {
    listMock.mockResolvedValue({
      bots: [researchBot],
      suggestedAgents: [
        { agentId: "agent-9", name: "Hermes Untagged", status: "idle", adapterType: "hermes_gateway", reason: "untagged" },
      ],
    });

    await render(<Bots />);

    const suggestions = container.querySelector("[data-bots-suggestions]");
    expect(suggestions?.textContent).toContain("Hermes Untagged");
    expect(suggestions?.textContent).toContain("grokBotTwin");
    const link = [...(suggestions?.querySelectorAll("a") ?? [])].find((anchor) => anchor.textContent?.includes("Hermes Untagged"));
    expect(link?.getAttribute("href")).toBe("/bots/agent-9");
  });

  it("renders the page of a Hermes agent that is not tagged as a bot", async () => {
    params.botId = "agent-9";
    getMock.mockResolvedValue({
      id: "agent-9",
      slug: "hermes-untagged",
      name: "Hermes Untagged",
      purpose: null,
      kind: "agent",
      registered: true,
      agentId: "agent-9",
      role: "general",
      title: "Research Analyst",
      status: "idle",
      adapterType: "hermes_gateway",
      grokBotTwin: false,
      taggedAsBot: false,
      gateway: null,
      note: "Runs on the Hermes gateway but has no bot metadata yet.",
      updatedAt: "2026-11-22T12:00:00.000Z",
      routines: [
        {
          id: "routine-1",
          title: "Morning research",
          status: "active",
          triggers: [
            {
              kind: "schedule",
              cronExpression: "0 8 * * *",
              timezone: "America/New_York",
              enabled: true,
              nextRunAt: "2026-11-23T13:00:00.000Z",
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
          entityId: "agent-9",
          createdAt: "2026-11-22T12:00:00.000Z",
          source: "activity",
        },
      ],
    });

    await render(<BotDetail />);
    const text = container.textContent ?? "";

    expect(text).toContain("Not tagged as a bot");
    expect(text).toContain("no bot metadata");
    expect(text).toContain("Morning research");
    expect(text).toContain("0 8 * * *");
    expect(text).toContain("agent.heartbeat");
    const agentLink = [...container.querySelectorAll("a")].find((anchor) => anchor.textContent?.includes("Open agent"));
    expect(agentLink?.getAttribute("href")).toBe("/agents/agent-9");
  });

  it("shows the catalog purpose for a known bot that has one", async () => {
    params.botId = "catalog:funnel-builder";
    getMock.mockResolvedValue({
      ...funnelCatalogBot,
      purpose: "Builds and maintains funnels and landing pages through the gateway website-builder policy.",
      routines: [],
      recentActivity: [],
    });

    await render(<BotDetail />);
    expect(container.textContent).toContain("Builds and maintains funnels and landing pages");
  });

  it("renders a readable line in every section for a bot with no data yet", async () => {
    params.botId = "catalog:kiwi";
    getMock.mockResolvedValue({ ...funnelCatalogBot, slug: "kiwi", name: "Kiwi", id: "catalog:kiwi", purpose: null, note: null, routines: [], recentActivity: [] });

    await render(<BotDetail />);
    const text = container.textContent ?? "";

    for (const heading of ["What it does", "Gateway key and policy", "Routines and schedules", "Status", "Recent activity"]) {
      expect(text, `${heading} section`).toContain(heading);
    }
    expect(text).toContain("No purpose recorded yet");
    expect(text).toContain("No gateway key is linked to this bot yet.");
    expect(text).toContain("No routines assigned.");
    expect(text).toContain("No agent row yet, so there is no live status to report.");
    expect(text).toContain("No recorded activity.");
  });

  it("tells an unregistered bot exactly which metadata fields to fill in", async () => {
    params.botId = "catalog:funnel-builder";
    getMock.mockResolvedValue({ ...funnelCatalogBot, routines: [], recentActivity: [] });

    await render(<BotDetail />);

    const text = container.textContent ?? "";
    expect(text).toContain("How to register");
    expect(text).toContain("grokBotTwin");
    expect(text).toContain("agentKind");
    expect(text).toContain("bot.gateway.keyId");
    expect(text).toContain("bot.gateway.policy");
    const link = [...container.querySelectorAll("a")].find((anchor) => anchor.textContent?.includes("Create the bot agent"));
    expect(link?.getAttribute("href")).toBe("/agents/new");
  });

  it("points a registered bot without a key at its agent page", async () => {
    params.botId = "agent-1";
    const { gateway: _gateway, ...withoutGateway } = researchBot;
    getMock.mockResolvedValue({ ...withoutGateway, gateway: null, routines: [], recentActivity: [] });

    await render(<BotDetail />);

    const text = container.textContent ?? "";
    expect(text).toContain("Link a gateway key");
    expect(text).toContain("bot.gateway.keyId");
    const link = [...container.querySelectorAll("a")].find((anchor) => anchor.textContent?.includes("Open the agent to add the key"));
    expect(link?.getAttribute("href")).toBe("/agents/agent-1");
  });

  it("gives every known gateway bot its own roster link", async () => {
    listMock.mockResolvedValue({ bots: KNOWN_GATEWAY_BOTS.map(catalogFixture) });

    await render(<Bots />);

    for (const known of KNOWN_GATEWAY_BOTS) {
      const link = [...container.querySelectorAll("a")].find(
        (anchor) => anchor.getAttribute("href") === `/bots/catalog:${known.slug}`,
      );
      expect(link, `${known.name} should link to its own page`).toBeTruthy();
      expect(link?.textContent).toContain(known.name);
    }
  });

  it("names the gateway policy a catalog bot ships with and says the key id is missing", async () => {
    const driveOrganizer = KNOWN_GATEWAY_BOTS.find((known) => known.slug === "drive-organizer")!;
    params.botId = "catalog:drive-organizer";
    getMock.mockResolvedValue({ ...catalogFixture(driveOrganizer), routines: [], recentActivity: [] });

    await render(<BotDetail />);

    expect(container.textContent).toContain("Gateway key and policy");
    expect(container.textContent).toContain("drive-organizer");
    expect(container.textContent).toContain("Key id not recorded");
    expect(container.textContent).toContain("Policy from the gateway preset this bot ships with");
  });

  it("renders the five bot sections on every known gateway bot page", async () => {
    for (const known of KNOWN_GATEWAY_BOTS) {
      params.botId = `catalog:${known.slug}`;
      getMock.mockResolvedValue({
        ...catalogFixture(known),
        routines: [],
        recentActivity: [],
      });

      await render(<BotDetail />);

      expect(getMock).toHaveBeenLastCalledWith("company-1", `catalog:${known.slug}`);
      const text = container.textContent ?? "";
      expect(text, `${known.name} page`).toContain(known.name);
      expect(text).toContain("What it does");
      expect(text).toContain("Gateway key and policy");
      expect(text).toContain("Routines and schedules");
      expect(text).toContain("Status");
      expect(text).toContain("Recent activity");
      expect(text).toContain(known.note);
      // The page names the gateway preset the bot ships with, and still says the
      // key id is missing (the gateway only keeps a hash of the key).
      expect(text).toContain(known.slug);
      expect(text).toContain("Key id not recorded");
      expect(text).toContain("No routines assigned.");
      expect(text).toContain("No recorded activity.");
    }
  });

  it("recovers a failed bot roster with a retry and readable copy", async () => {
    listMock
      .mockRejectedValueOnce(new ApiError("Service unavailable", 503, null))
      .mockResolvedValueOnce({ bots: [researchBot], suggestedAgents: [] });

    await render(<Bots />);

    expect(container.textContent).toContain("Connection interrupted");
    expect(container.textContent).not.toContain("Service unavailable");
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Retry");
    expect(retry).toBeTruthy();

    await act(async () => {
      retry!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(listMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Research Analyst");
  });

  it("says a bot is missing instead of offering a retry that cannot succeed", async () => {
    params.botId = "missing-bot";
    getMock.mockRejectedValue(new ApiError("Not found", 404, null));

    await render(<BotDetail />);

    expect(container.textContent).toContain("Bot not found");
    expect([...container.querySelectorAll("button")].map((button) => button.textContent).join(" ")).not.toContain("Retry");
  });

  it("keeps a retry for a bot detail outage and hides the raw server message", async () => {
    params.botId = "agent-1";
    getMock
      .mockRejectedValueOnce(new ApiError("Service unavailable", 503, null))
      .mockResolvedValueOnce({ ...researchBot, routines: [], recentActivity: [] });

    await render(<BotDetail />);

    expect(container.textContent).toContain("Connection interrupted");
    expect(container.textContent).not.toContain("Service unavailable");
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Retry");
    expect(retry).toBeTruthy();

    await act(async () => {
      retry!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(getMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Research Analyst");
  });

  it("gives every bot page section a real heading with operator-readable status", async () => {
    params.botId = "catalog:funnel-builder";
    getMock.mockResolvedValue({ ...funnelCatalogBot, routines: [], recentActivity: [] });

    await render(<BotDetail />);

    const headings = [...container.querySelectorAll("h2")].map((heading) => heading.textContent);
    expect(headings).toEqual([
      "How to register",
      "What it does",
      "Gateway key and policy",
      "Routines and schedules",
      "Status",
      "Recent activity",
    ]);
    expect(container.textContent).toContain("Not registered");
    expect(container.textContent).not.toMatch(/\bunregistered\b/);
  });

  it("writes routine times as readable time elements instead of 'Never'", async () => {
    params.botId = "agent-1";
    getMock.mockResolvedValue({
      ...researchBot,
      routines: [
        {
          id: "routine-1",
          title: "Weekly review",
          status: "active",
          triggers: [
            { kind: "schedule", cronExpression: "0 9 * * 1", timezone: null, enabled: false, nextRunAt: null, lastFiredAt: null },
          ],
        },
      ],
      recentActivity: [],
    });

    await render(<BotDetail />);

    const text = container.textContent ?? "";
    expect(text).toContain("no next run");
    expect(text).not.toContain("next Never");
    expect(text).toContain("Weekly review");
  });

  it("marks the bot's status for assistive technology", async () => {
    params.botId = "agent-1";
    getMock.mockResolvedValue({ ...researchBot, routines: [], recentActivity: [] });

    await render(<BotDetail />);

    const statusLabels = [...container.querySelectorAll(".sr-only")].map((node) => node.textContent);
    expect(statusLabels).toContain("Status:");
  });

  it("tells a registered bot what to do when routines and activity are empty", async () => {
    params.botId = "agent-1";
    getMock.mockResolvedValue({ ...researchBot, routines: [], recentActivity: [] });

    await render(<BotDetail />);

    const text = container.textContent ?? "";
    expect(text).toContain("Assign a routine to schedule this bot's work.");
    expect(text).toContain("Runs and agent actions will appear here.");
  });

  it("offers a way back to the roster from a missing bot", async () => {
    params.botId = "missing-bot";
    getMock.mockRejectedValue(new ApiError("Not found", 404, null));

    await render(<BotDetail />);

    const open = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Open Bots");
    expect(open).toBeTruthy();
    await act(async () => {
      open!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigateMock).toHaveBeenCalledWith("/bots");
  });

  it("shows guidance instead of a blank roster when the company has no bots", async () => {
    listMock.mockResolvedValue({ bots: [], suggestedAgents: [] });

    await render(<Bots />);

    expect(container.textContent).toContain("No bots yet");
    expect(container.textContent).toContain("Tag an agent as a bot");
    const open = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Open agents");
    expect(open).toBeTruthy();
    await act(async () => {
      open!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigateMock).toHaveBeenCalledWith("/agents/all");
  });

  it("clears an empty search from the no-match state", async () => {
    listMock.mockResolvedValue({ bots: [researchBot], suggestedAgents: [] });

    await render(<Bots />);
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Search bots"]');
    expect(input).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "nothing-matches");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain("No bots match");
    const clear = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Show all bots");
    expect(clear).toBeTruthy();
    await act(async () => {
      clear!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain("Research Analyst");
  });

  it("announces how many bots the roster shows", async () => {
    listMock.mockResolvedValue({ bots: [researchBot, funnelCatalogBot], suggestedAgents: [] });

    await render(<Bots />);

    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toContain("2 bots.");
  });

  it("reserves the roster with a skeleton while the bots load", async () => {
    let resolveList: (value: { bots: CompanyBotSummary[]; suggestedAgents: [] }) => void = () => {};
    listMock.mockReturnValue(new Promise((resolve) => { resolveList = resolve; }));

    await render(<Bots />);

    const placeholder = container.querySelector('[role="status"][aria-busy="true"]');
    expect(placeholder, "the roster should own a busy placeholder while it loads").toBeTruthy();
    expect(placeholder!.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(3);
    expect(container.querySelector(".animate-spin")).toBeNull();
    expect(container.textContent).not.toContain("Loading bots…");

    await act(async () => {
      resolveList({ bots: [researchBot], suggestedAgents: [] });
    });
    await flush();

    expect(container.textContent).toContain("Research Analyst");
  });

  it("reserves the bot page with a skeleton while the bot loads", async () => {
    params.botId = "agent-1";
    let resolveGet: (value: CompanyBotDetail) => void = () => {};
    getMock.mockReturnValue(new Promise((resolve) => { resolveGet = resolve; }));

    await render(<BotDetail />);

    const placeholder = container.querySelector('[role="status"][aria-busy="true"]');
    expect(placeholder, "the bot page should own a busy placeholder while it loads").toBeTruthy();
    expect(placeholder!.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(3);
    expect(container.querySelector(".animate-spin")).toBeNull();
    expect(container.textContent).not.toContain("Loading bot…");

    await act(async () => {
      resolveGet({ ...researchBot, routines: [], recentActivity: [] });
    });
    await flush();

    expect(container.textContent).toContain("What it does");
  });
});
