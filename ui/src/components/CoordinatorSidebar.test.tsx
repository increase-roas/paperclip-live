// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, AttentionFeed, AttentionItem, Project } from "@paperclipai/shared";
import { buildTeamNavigationItems, CoordinatorSidebar, resolveJavarDestination } from "./CoordinatorSidebar";
import { TooltipProvider } from "./ui/tooltip";
import { coordinatorAttentionQueryKey, coordinatorAttentionSummaryQueryKey } from "@/lib/coordinator-attention";
import { queryKeys } from "@/lib/queryKeys";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const fixture = vi.hoisted(() => ({
  attention: vi.fn(),
  summary: vi.fn(),
  openNewIssue: vi.fn(),
  openNewProject: vi.fn(),
  pathname: "/INC/issues",
  collapsed: false,
  userId: "reviewer",
  chats: [] as Array<{ isUnreadForMe: boolean }>,
  projects: [] as Project[],
  agents: [] as Agent[],
}));

vi.mock("@/hooks/useAgentChatNavigation", () => ({
  useAgentChatNavigation: () => ({
    companyId: "company",
    userId: fixture.userId,
    agents: { data: fixture.agents },
    chats: { data: fixture.chats },
    session: { isSuccess: true },
  }),
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company",
    selectedCompany: { id: "company", issuePrefix: "INC", name: "Increase Roas" },
  }),
}));
vi.mock("@/context/DialogContext", () => ({
  useDialogActions: () => ({
    openNewIssue: fixture.openNewIssue,
    openNewProject: fixture.openNewProject,
  }),
}));
vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({
    collapsed: fixture.collapsed,
    peeking: false,
    isMobile: false,
    setSidebarOpen: vi.fn(),
  }),
}));
vi.mock("@/api/attention", () => ({ attentionApi: { list: fixture.attention, summary: fixture.summary } }));
vi.mock("@/api/projects", () => ({ projectsApi: { list: async () => fixture.projects } }));
vi.mock("./SidebarCompanyMenu", () => ({ SidebarCompanyMenu: () => null }));
vi.mock("@/plugins/slots", () => ({
  PluginSlotOutlet: ({ slotTypes }: { slotTypes: string[] }) => (
    <div data-testid={`plugin-slot-${slotTypes.join(",")}`} />
  ),
}));
vi.mock("@/plugins/launchers", () => ({
  PluginLauncherOutlet: ({ placementZones }: { placementZones: string[] }) => (
    <div data-testid={`plugin-launcher-${placementZones.join(",")}`} />
  ),
}));
vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: fixture.pathname, search: "" }),
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
  NavLink: ({ to, children, className, state: _state, end: _end, ...props }: {
    to: string; children: ReactNode; className?: string | ((state: { isActive: boolean }) => string); state?: unknown; end?: boolean;
  }) => <a href={to} className={typeof className === "function" ? className({ isActive: false }) : className} {...props}>{children}</a>,
}));

const pending = (id: string) => ({
  id,
  sourceKind: "issue_thread_interaction",
  subject: { id, kind: "interaction", status: "pending" },
  createdAt: "2026-10-20T12:00:00Z",
  activityAt: "2026-10-20T12:00:00Z",
}) as AttentionItem;

function feed(items: AttentionItem[]): AttentionFeed {
  return {
    companyId: "company",
    generatedAt: "2026-10-27T12:00:00Z",
    totalCount: items.length,
    deskBadgeCount: 0,
    nextCursor: null,
    countsBySourceKind: {} as AttentionFeed["countsBySourceKind"],
    items,
  };
}

function summary(items: AttentionItem[]) {
  const { items: _items, nextCursor: _cursor, ...counts } = feed(items);
  return counts;
}

function makeProject(overrides: Partial<Project> & { id: string; name: string }): Project {
  return {
    companyId: "company",
    urlKey: overrides.name.toLowerCase().replace(/\s+/g, "-"),
    status: "in_progress",
    ...overrides,
  } as Project;
}

let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  fixture.collapsed = false;
  fixture.userId = "reviewer";
  fixture.pathname = "/INC/issues";
  fixture.chats = [];
  fixture.projects = [];
  fixture.agents = [];
  fixture.summary.mockResolvedValue(summary([pending("question"), pending("review")]));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
});

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function renderSidebar() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <CoordinatorSidebar />
        </TooltipProvider>
      </QueryClientProvider>,
    ),
  );
  await flush();
}

const navigation = () => container.querySelector('nav[aria-label="Workspace navigation"]')!;
const decisionLink = () => container.querySelector('a[href="/decisions"]')!;

describe("CEO-grade CoordinatorSidebar navigation", () => {
  it("renders Javar, Inbox, Tasks, Dashboard, TEAMS, and COMPANY in order with zero individual agent names", async () => {
    fixture.agents = [
      { id: "javar-id", companyId: "company", name: "Javar", urlKey: "javar", role: "ceo", status: "idle" } as Agent,
      { id: "ads-id", companyId: "company", name: "Ads checker", urlKey: "ads-checker", role: "general", status: "idle" } as Agent,
      { id: "res-id", companyId: "company", name: "Research", urlKey: "research", role: "researcher", status: "idle" } as Agent,
    ];
    fixture.projects = [
      makeProject({ id: "p-mkt", name: "Marketing", urlKey: "marketing" }),
      makeProject({ id: "p-sales", name: "Sales", urlKey: "sales" }),
      makeProject({ id: "p-ful", name: "Fulfillment", urlKey: "fulfillment" }),
      makeProject({ id: "p-ops", name: "Operations", urlKey: "operations" }),
    ];

    await renderSidebar();

    const links = [...navigation().querySelectorAll<HTMLAnchorElement>("a")];
    expect(links.map(link => link.getAttribute("href"))).toEqual([
      "/chats/javar",
      "/decisions",
      "/issues",
      "/dashboard",
      "/projects/marketing/issues",
      "/projects/sales/issues",
      "/projects/fulfillment/issues",
      "/projects/operations/issues",
      "/agents/all",
      "/routines",
      "/company/settings",
    ]);

    const groupLabels = [...navigation().querySelectorAll('[data-slot="sidebar-group-label"]')].map(el => el.textContent);
    expect(groupLabels).toEqual(["Teams", "Company"]);

    // No individual specialist agent names, no Pinned, no Recents, no More drawer
    expect(navigation().textContent).not.toContain("Ads checker");
    expect(navigation().textContent).not.toContain("Research");
    expect(navigation().textContent).not.toContain("Pinned");
    expect(navigation().textContent).not.toContain("Recents");
    expect(navigation().querySelector('button[aria-label="More workspace pages"]')).toBeNull();

    // Sidebar plugin slots stay mounted right after Dashboard so Sales dashboard remains 1-click accessible
    expect(navigation().querySelector('[data-testid="plugin-slot-sidebar"]')).not.toBeNull();
    expect(navigation().querySelector('[data-testid="plugin-launcher-sidebar"]')).not.toBeNull();
  });

  it("maps TEAMS to matching existing Projects and keeps extra active projects reachable", () => {
    const projects = [
      makeProject({ id: "p1", name: "Marketing", urlKey: "marketing" }),
      makeProject({ id: "p2", name: "Client Portal", urlKey: "client-portal" }),
      makeProject({ id: "p3", name: "Old Archive", urlKey: "old", archivedAt: new Date("2026-01-01") }),
    ];
    const items = buildTeamNavigationItems(projects);
    expect(items.map(i => ({ label: i.label, to: i.to }))).toEqual([
      { label: "Marketing", to: "/projects/marketing/issues" },
      { label: "Sales", to: "/projects" },
      { label: "Fulfillment", to: "/projects" },
      { label: "Operations", to: "/projects" },
      { label: "Client Portal", to: "/projects/client-portal/issues" },
    ]);
  });

  it("resolves Javar destination to Javar, CEO fallback, or /chats", () => {
    expect(resolveJavarDestination([])).toBe("/chats");
    expect(resolveJavarDestination([{ id: "c1", name: "Chief", urlKey: "chief", role: "ceo" } as Agent])).toBe("/chats/chief");
    expect(resolveJavarDestination([
      { id: "c1", name: "Chief", urlKey: "chief", role: "ceo" } as Agent,
      { id: "j1", name: "Javar", urlKey: "javar", role: "general" } as Agent,
    ])).toBe("/chats/javar");
  });

  it("announces unread chat totals on Javar in expanded and collapsed navigation", async () => {
    fixture.chats = [{ isUnreadForMe: true }, { isUnreadForMe: false }, { isUnreadForMe: true }];
    await renderSidebar();
    expect(container.querySelector('a[href="/chats"] [aria-label="2 unread chats"]')).not.toBeNull();
    fixture.collapsed = true;
    await renderSidebar();
    expect(container.querySelector('a[href="/chats"]')?.getAttribute("aria-label")).toBe("Javar, 2 unread chats");
  });

  it.each([false, true])("opens global search from the organization header when collapsed is %s", async collapsed => {
    fixture.collapsed = collapsed;
    await renderSidebar();
    const listener = vi.fn();
    document.addEventListener("keydown", listener);
    try {
      const button = container.querySelector<HTMLButtonElement>('.design-sidebar-brand button[aria-label="Global search"]');
      expect(button).not.toBeNull();
      await act(async () => button!.click());
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ key: "k", metaKey: true }));
    } finally {
      document.removeEventListener("keydown", listener);
    }
  });

  it("opens New task dialog from the Tasks row quick-create button", async () => {
    await renderSidebar();
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="New task"]');
    expect(button).not.toBeNull();
    await act(async () => button!.click());
    expect(fixture.openNewIssue).toHaveBeenCalledOnce();
  });
});

describe("Coordinator Inbox badge", () => {
  it("counts every canonical outstanding decision even when none arrived today", async () => {
    client.setQueryData([...coordinatorAttentionQueryKey("company"), { search: "no match" }], feed([]));
    client.setQueryData([...queryKeys.attention("company"), "history", "recent"], { items: [{ id: "answered-question" }] });
    await renderSidebar();
    expect(fixture.attention).not.toHaveBeenCalled();
    expect(client.getQueryData(coordinatorAttentionQueryKey("company"))).toBeUndefined();
    expect(fixture.summary).toHaveBeenCalledWith("company");
    expect(decisionLink().querySelector('[data-slot="badge"]')?.textContent).toBe("2");
  });

  it("updates after canonical attention refreshes and removes the badge once every decision is resolved", async () => {
    await renderSidebar();
    fixture.summary.mockResolvedValue(summary([pending("review")]));
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.attention("company") }); });
    await flush();
    expect(decisionLink().querySelector('[data-slot="badge"]')?.textContent).toBe("1");
    fixture.summary.mockResolvedValue(summary([]));
    client.setQueryData([...queryKeys.attention("company"), "history", "recent"], { items: [{ id: "answered-question" }, { id: "accepted-review" }] });
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.attention("company") }); });
    await flush();
    expect(decisionLink().querySelector('[data-slot="badge"]')).toBeNull();
    expect(decisionLink().textContent).toBe("Inbox");
  });

  it("announces the full outstanding count when the sidebar is collapsed", async () => {
    fixture.collapsed = true;
    await renderSidebar();
    expect(decisionLink().getAttribute("aria-label")).toBe("Inbox, 2 decisions");
  });
});

describe("Coordinator collection reads", () => {
  it("does not replace a resolved count with an older summary that arrives later", async () => {
    const key = coordinatorAttentionSummaryQueryKey("company");
    client.setQueryDefaults(key, { staleTime: Infinity });
    client.setQueryData(key, { ...summary([pending("old")]), generatedAt: "2026-10-27T12:00:00Z" }, { updatedAt: 20 });
    client.setQueryData(coordinatorAttentionQueryKey("company"), { ...feed([]), generatedAt: "2026-10-27T12:01:00Z" }, { updatedAt: 10 });
    await renderSidebar();
    expect(decisionLink().querySelector('[data-slot="badge"]')).toBeNull();
  });

  it("keeps a newer resolved count when returning to a cached navigation summary", async () => {
    const key = coordinatorAttentionSummaryQueryKey("company");
    client.setQueryDefaults(key, { staleTime: Infinity });
    client.setQueryData(key, summary([pending("old")]), { updatedAt: 1 });
    client.setQueryData(coordinatorAttentionQueryKey("company"), feed([]), { updatedAt: 2 });
    await renderSidebar();
    expect(decisionLink().querySelector('[data-slot="badge"]')).toBeNull();
    expect(fixture.summary).not.toHaveBeenCalled();
    expect(fixture.attention).not.toHaveBeenCalled();
  });
});
