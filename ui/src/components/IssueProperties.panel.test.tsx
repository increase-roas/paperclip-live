// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue, IssueDocument, IssueLabel } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IssueProperties } from "./IssueProperties";

import { queryKeys } from "../lib/queryKeys";
import { ApiError } from "../api/client";

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  adapterModels: vi.fn(),
  runtimeState: vi.fn(),
}));

const mockProjectsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockExecutionWorkspacesApi = vi.hoisted(() => ({
  list: vi.fn(),
  controlRuntimeCommands: vi.fn(),
}));

const mockIssuesApi = vi.hoisted(() => ({
  list: vi.fn(),
  getContextUsage: vi.fn(),
  getDocument: vi.fn(),
  listAcceptedPlanDecompositions: vi.fn(),
  listAttachments: vi.fn(),
  listDocuments: vi.fn(),
  listWorkProducts: vi.fn(),
  listInteractions: vi.fn(),
  listLabels: vi.fn(),
  createLabel: vi.fn(),
  upsertWatchdog: vi.fn(),
  deleteWatchdog: vi.fn(),
  unarchiveFromInbox: vi.fn(),
}));

const mockRoutinesApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

const mockAccessApi = vi.hoisted(() => ({
  listUserDirectory: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

const mockSidebarState = vi.hoisted(() => ({
  isMobile: false,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
  }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => mockSidebarState,
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/projects", () => ({
  projectsApi: mockProjectsApi,
}));

vi.mock("../api/execution-workspaces", () => ({
  executionWorkspacesApi: mockExecutionWorkspacesApi,
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("../api/routines", () => ({
  routinesApi: mockRoutinesApi,
}));

vi.mock("../api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("../api/access", () => ({
  accessApi: mockAccessApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: vi.fn() }),
  useOptionalToastActions: () => ({ pushToast: vi.fn() }),
}));

vi.mock("../hooks/useProjectOrder", () => ({
  useProjectOrder: ({ projects }: { projects: unknown[] }) => ({
    orderedProjects: projects,
  }),
}));

vi.mock("../lib/recent-assignees", () => ({
  getRecentAssigneeIds: () => [],
  getRecentAssigneeSelectionIds: () => [],
  sortAgentsByRecency: (agents: unknown[]) => agents,
  trackRecentAssignee: vi.fn(),
  trackRecentAssigneeUser: vi.fn(),
}));

vi.mock("../lib/assignees", () => ({
  formatAssigneeUserLabel: (userId: string | null | undefined, currentUserId?: string | null, userLabelMap?: Map<string, string>) => {
    if (!userId) return null;
    return userLabelMap?.get(userId) ?? (userId === currentUserId ? "You" : "User");
  },
  formatUserLabel: (userId: string | null | undefined, userLabelMap?: Map<string, string>) => {
    if (!userId) return null;
    return userLabelMap?.get(userId) ?? "User";
  },
}));

vi.mock("./StatusIcon", async importOriginal => ({
  ...await importOriginal<typeof import("./StatusIcon")>(),
  StatusIcon: ({
    status,
    blockerAttention,
    className,
    glyphContainerClassName,
    size,
    commentable,
    reviewActions,
  }: {
    status: string;
    blockerAttention?: Issue["blockerAttention"];
    className?: string;
    glyphContainerClassName?: string;
    size?: string;
    commentable?: boolean;
    reviewActions?: { stageType: "review" | "approval" } | null;
  }) => (
    <span
      className={className}
      data-glyph-container-class={glyphContainerClassName}
      data-testid="status-icon"
      data-size={size}
      data-status-icon-state={blockerAttention?.state}
      data-commentable={commentable || undefined}
      data-review-stage={reviewActions?.stageType}
    >
      {status}
    </span>
  ),
}));

vi.mock("./PriorityIcon", () => ({
  PriorityIcon: ({ priority }: { priority: string }) => <span>{priority}</span>,
}));

vi.mock("./Identity", async importOriginal => ({
  ...await importOriginal<typeof import("./Identity")>(),
  Identity: ({ name, shape }: { name: string; shape?: string }) => <span data-shape={shape ?? "circle"}>{name}</span>,
}));

vi.mock("./AgentIconPicker", () => ({
  AgentIcon: () => null,
}));

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    state: _state,
    disableIssueQuicklook: _disableIssueQuicklook,
    issuePrefetch: _issuePrefetch,
    ...props
  }: { children: ReactNode; to: string; state?: unknown; disableIssueQuicklook?: boolean; issuePrefetch?: unknown } & ComponentProps<"a">) => <a href={to} {...props}>{children}</a>,
  useCaseHref: () => (caseId: string) => `/cases/${caseId}`,
  useLocation: () => ({ hash: "", pathname: "/", search: "", state: null, key: "test" }),
}));

vi.mock("@/components/ui/separator", () => ({
  Separator: () => <hr />,
}));

vi.mock("@/components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/IssueDocumentAnnotations", () => ({
  DocumentAnnotationsCountChip: ({ docKey }: { docKey: string }) => <span data-doc-key={docKey} />,
  IssueDocumentAnnotations: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

if (!globalThis.PointerEvent) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).PointerEvent = MouseEvent;
}

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * Finds the trigger button for a property row by its (sentence-case) label.
 * `PropertyRow` exposes a stable label hook so layout utility changes do not
 * affect tests that need to find the corresponding value slot.
 */
function findRowTrigger(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  const labelSpan = container.querySelector(`[data-property-label="${label}"]`);
  const row = labelSpan?.closest('[data-property-row="true"]');
  return ((row?.querySelector(`button[aria-label="Edit ${label.toLowerCase()}"]`) ?? row?.querySelector("button")) as HTMLButtonElement | null) ?? undefined;
}

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }

  throw lastError;
}

function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Parent issue",
    description: null,
    status: "todo",
    priority: "medium",
    reviewPolicy: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    responsibleUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: "user-1",
    issueNumber: 1,
    identifier: "PAP-1",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    labels: [],
    labelIds: [],
    blockedBy: [],
    blocks: [],
    createdAt: new Date("2026-04-06T12:00:00.000Z"),
    updatedAt: new Date("2026-04-06T12:05:00.000Z"),
    ...overrides,
    workMode: overrides.workMode ?? "standard",
  };
}

function createLabel(overrides: Partial<IssueLabel> = {}): IssueLabel {
  return {
    id: "label-1",
    companyId: "company-1",
    name: "Bug",
    color: "#ef4444",
    createdAt: new Date("2026-04-06T12:00:00.000Z"),
    updatedAt: new Date("2026-04-06T12:00:00.000Z"),
    ...overrides,
  };
}

function createRelation(id: string, identifier: string, title: string, status: Issue["status"] = "todo") {
  return {
    id,
    identifier,
    title,
    status,
    priority: "medium" as const,
    assigneeAgentId: null,
    assigneeUserId: null,
  };
}

function renderPropertiesWithQueryClient(container: HTMLDivElement, props: ComponentProps<typeof IssueProperties>, hiddenSettings: string[] = []) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  queryClient.setQueryData(queryKeys.health, { hiddenSettings });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <IssueProperties {...props} />
      </QueryClientProvider>,
    );
  });
  return { root, queryClient };
}

function renderProperties(container: HTMLDivElement, props: ComponentProps<typeof IssueProperties>) {
  const { root } = renderPropertiesWithQueryClient(container, props);
  return root;
}

describe("IssueProperties panel surface", () => {
  let container: HTMLDivElement;

  it("surfaces saved PR review links even when external objects are unavailable", async () => {
    mockIssuesApi.listWorkProducts.mockResolvedValue([{
      id: "pr-1", type: "pull_request", provider: "github", title: "Update runtime probe",
      url: null, metadata: { url: "https://github.com/example/private-repo/pull/42" },
      status: "ready_for_review", reviewState: "needs_board_review", updatedAt: new Date(),
    }]);
    const root = renderProperties(container, {
      issue: createIssue(), childIssues: [], onUpdate: vi.fn(), inline: true,
      externalObjectsError: true,
    });
    await waitForAssertion(() => {
      const link = container.querySelector('a[href="https://github.com/example/private-repo/pull/42"]');
      expect(link?.textContent).toBe("example/private-repo#42");
      expect(container.textContent).toContain("Review requested");
    });
    act(() => root.unmount());
  });

  it("refreshes PR state when opening Properties over an already loaded task", async () => {
    const saved = {
      id: "pr-1", type: "pull_request", provider: "github", title: "Update runtime probe",
      url: "https://github.com/example/private-repo/pull/42", metadata: {},
      status: "ready_for_review", reviewState: "needs_board_review", updatedAt: new Date(),
    };
    mockIssuesApi.listWorkProducts.mockImplementation(async (_id, options) => [
      options?.refreshPullRequests ? { ...saved, metadata: { state: "merged" } } : saved,
    ]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.issues.workProducts("issue-1"), [{ ...saved, metadata: { state: "merged" } }]);
    const root = createRoot(container);
    act(() => root.render(<QueryClientProvider client={queryClient}>
      <IssueProperties issue={createIssue()} childIssues={[]} onUpdate={vi.fn()} inline />
    </QueryClientProvider>));
    await waitForAssertion(() => {
      expect(mockIssuesApi.listWorkProducts).toHaveBeenCalledWith("issue-1", expect.objectContaining({ refreshPullRequests: true }));
      expect(container.textContent).toContain("merged");
      expect(container.textContent).not.toContain("Review requested");
    });
    act(() => root.unmount());
  });

  it("refreshes PRs on first panel open when the thread uses an identifier cache key", async () => {
    const saved = {
      id: "pr-1", type: "pull_request", title: "Update runtime probe",
      url: "https://github.com/example/private-repo/pull/42", metadata: {},
      status: "ready_for_review", reviewState: "needs_board_review", updatedAt: new Date(),
    };
    mockIssuesApi.listWorkProducts.mockImplementation(async (_id, options) => [
      options?.refreshPullRequests ? { ...saved, metadata: { state: "merged" } } : saved,
    ]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.issues.workProducts("PAP-1"), [{ ...saved, metadata: { state: "merged" } }]);
    const root = createRoot(container);
    act(() => root.render(<QueryClientProvider client={queryClient}>
      <IssueProperties issue={createIssue()} childIssues={[]} onUpdate={vi.fn()} inline />
    </QueryClientProvider>));
    await waitForAssertion(() => {
      expect(container.textContent).toContain("merged");
      expect(container.textContent).not.toContain("Review requested");
    });
    act(() => root.unmount());
  });

  it("shows saved PRs while the first provider refresh is stalled", async () => {
    const saved = {
      id: "pr-1", type: "pull_request", title: "Update runtime probe",
      url: "https://github.com/example/private-repo/pull/42", metadata: {},
      status: "ready_for_review", reviewState: "needs_board_review", updatedAt: new Date(),
    };
    let finishRefresh!: (products: unknown[]) => void;
    const refresh = new Promise<unknown[]>((resolve) => { finishRefresh = resolve; });
    mockIssuesApi.listWorkProducts.mockImplementation(async (_id, options) => options?.refreshPullRequests ? refresh : [saved]);
    const root = renderProperties(container, { issue: createIssue(), childIssues: [], onUpdate: vi.fn(), inline: true });
    await waitForAssertion(() => {
      expect(mockIssuesApi.listWorkProducts).toHaveBeenCalledWith("issue-1", expect.objectContaining({ refreshPullRequests: true }));
      expect(container.querySelector(`a[href="${saved.url}"]`)).not.toBeNull();
      expect(container.textContent).toContain("Review requested");
    });
    finishRefresh([{ ...saved, metadata: { state: "merged" } }]);
    await waitForAssertion(() => {
      expect(container.textContent).toContain("merged");
      expect(container.textContent).not.toContain("Review requested");
    });
    act(() => root.unmount());
  });

  it.each([
    { statusLabel: "Open", statusCategory: "open", liveness: "stale", statusIconKey: "git-pull-request", review: true },
    { statusLabel: "Merged", statusCategory: "succeeded", liveness: "fresh", statusIconKey: "git-merge", review: false },
    { statusLabel: "Not found", statusCategory: "archived", liveness: "stale", statusIconKey: null, review: true },
  ] as const)("combines a saved PR with its $statusLabel provider status and freshness", async (provider) => {
    const canonical = "https://github.com/example/private-repo/pull/42";
    const savedUrl = `${canonical}?diff=split#discussion_r123`;
    mockIssuesApi.listWorkProducts.mockResolvedValue([{
      id: "pr-1", type: "pull_request", title: "Update runtime probe", url: savedUrl,
      metadata: {}, status: "ready_for_review", reviewState: "needs_board_review", updatedAt: new Date(),
    }]);
    const root = renderProperties(container, {
      issue: createIssue(), childIssues: [], onUpdate: vi.fn(), inline: true,
      externalObjects: [{
        pill: { providerKey: "github", objectType: "pull_request", url: canonical, ...provider },
        mentionCount: 1, sourceLabels: ["Comment"],
        group: { object: null, mentions: [], mentionCount: 1, sourceLabels: ["Comment"] },
      }],
    });
    await waitForAssertion(() => {
      const links = container.querySelectorAll('a[href*="/pull/42"]');
      expect(links).toHaveLength(1);
      expect(links[0].getAttribute("href")).toBe(savedUrl);
      const row = links[0].closest("li")!;
      expect(row.textContent).toContain(provider.statusLabel);
      expect(row.querySelector("[data-external-liveness]")?.getAttribute("data-external-liveness")).toBe(provider.liveness);
      expect(row.textContent?.includes("Review requested")).toBe(provider.review);
    });
    act(() => root.unmount());
  });

  beforeEach(() => {
    mockSidebarState.isMobile = false;
    container = document.createElement("div");
    document.body.appendChild(container);
    mockAgentsApi.list.mockResolvedValue([]);
    mockAgentsApi.adapterModels.mockResolvedValue([]);
    mockAgentsApi.runtimeState.mockResolvedValue(null);
    mockRoutinesApi.get.mockReset();
    mockProjectsApi.list.mockResolvedValue([]);
    mockExecutionWorkspacesApi.list.mockResolvedValue([]);
    mockExecutionWorkspacesApi.controlRuntimeCommands.mockReset();
    mockIssuesApi.list.mockResolvedValue([]);
    mockIssuesApi.getContextUsage.mockResolvedValue(null);
    mockIssuesApi.getDocument.mockResolvedValue(null);
    mockIssuesApi.listAcceptedPlanDecompositions.mockResolvedValue([]);
    mockIssuesApi.listAttachments.mockResolvedValue([]);
    mockIssuesApi.listDocuments.mockResolvedValue([]);
    mockIssuesApi.listWorkProducts.mockResolvedValue([]);
    mockIssuesApi.listInteractions.mockResolvedValue([]);
    mockIssuesApi.listLabels.mockResolvedValue([]);
    mockIssuesApi.createLabel.mockResolvedValue(createLabel({
      id: "label-new",
      name: "New label",
      color: "#6366f1",
    }));
    mockIssuesApi.upsertWatchdog.mockResolvedValue({});
    mockIssuesApi.deleteWatchdog.mockResolvedValue({ ok: true });
    mockIssuesApi.unarchiveFromInbox.mockResolvedValue({ ok: true });
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "user-1" } });
    mockAccessApi.listUserDirectory.mockResolvedValue({
      users: [
        {
          principalId: "user-1",
          status: "active",
          user: { id: "user-1", name: "Riley Board", email: "riley@example.com", image: null },
        },
        {
          principalId: "user-2",
          status: "active",
          user: { id: "user-2", name: "Morgan Product", email: "morgan@example.com", image: null },
        },
      ],
    });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableTaskWatchdogs: false,
      enableStreamlinedUi: true,
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it.each([true, false])("reserves the usage-limit row while runtime data loads (inline: %s)", async (inline) => {
    let resolveRuntimeState!: (value: unknown) => void;
    const runtimeState = new Promise<unknown>((resolve) => { resolveRuntimeState = resolve; });
    mockAgentsApi.runtimeState.mockReturnValueOnce(runtimeState);
    const root = renderProperties(container, {
      issue: createIssue({ assigneeAgentId: "agent-1" }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline,
    });

    try {
      const row = container.querySelector('[data-property-label="Usage limit"]')
        ?.closest('[data-property-row="true"]');
      expect(row).toBeTruthy();
      expect(row?.querySelector('[role="status"]')?.getAttribute("aria-label"))
        .toBe("Loading usage limit");
      const nextRow = row?.nextElementSibling;

      await act(async () => {
        resolveRuntimeState({
          stateJson: {
            providerRateLimits: {
              schema: "paperclip.provider.rate_limits.v1",
              provider: "openai",
              observedAt: new Date().toISOString(),
              windows: [{
                id: "primary",
                label: "5-hour window",
                shortLabel: "5h",
                windowMinutes: 300,
                usedPercent: 42,
                resetsAt: null,
                status: "allowed",
              }],
              credits: null,
              limitReached: null,
            },
          },
        });
      });
      await waitForAssertion(() => {
        expect(row?.querySelector('button[aria-label="Provider usage limit: 5h 42%"]')).toBeTruthy();
      });

      expect(container.querySelector('[data-property-label="Usage limit"]')
        ?.closest('[data-property-row="true"]')).toBe(row);
      expect(row?.nextElementSibling).toBe(nextRow);
      expect(row?.querySelector('[role="status"]')).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it.each([null, "user-1"])("does not reserve a usage-limit row without an agent (user: %s)", async (assigneeUserId) => {
    const root = renderProperties(container, {
      issue: createIssue({ assigneeUserId }),
      childIssues: [],
      onUpdate: vi.fn(),
    });
    try {
      await flush();
      expect(container.querySelector('[data-property-label="Usage limit"]')).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it.each(["missing", "forbidden"])("hides the usage-limit placeholder when runtime data is %s", async (outcome) => {
    if (outcome === "forbidden") {
      mockAgentsApi.runtimeState.mockRejectedValueOnce(new ApiError("Forbidden", 403, null));
    }
    const root = renderProperties(container, {
      issue: createIssue({ assigneeAgentId: "agent-1" }),
      childIssues: [],
      onUpdate: vi.fn(),
    });
    try {
      await waitForAssertion(() => {
        expect(container.querySelector('[data-property-label="Usage limit"]')).toBeNull();
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("marks the task-detail property typography and section rhythm", () => {
    const root = renderProperties(container, {
      issue: createIssue(),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });

    const surface = container.querySelector(".task-detail-properties");
    expect(surface).not.toBeNull();
    expect(surface?.classList).toContain("pl-4");
    expect(surface?.querySelectorAll('[data-property-section="true"]').length).toBeGreaterThan(1);
    expect(surface?.querySelector('[data-property-value="true"]')).not.toBeNull();
    const statusVisual = surface?.querySelector(
      '[data-property-label="Status"] + [data-property-value="true"] [data-testid="status-icon"]',
    );
    expect(statusVisual).not.toBeNull();
    expect(statusVisual?.getAttribute("data-size")).toBeNull();
    expect(statusVisual?.getAttribute("data-glyph-container-class")).toContain("size-6");
    expect(surface?.querySelector('[data-property-section="true"] > div')?.classList)
      .toContain("text-muted-foreground/70");
    const projectLabel = surface?.querySelector('[data-property-label="Project"]');
    const labelsLabel = surface?.querySelector('[data-property-label="Labels"]');
    if (!projectLabel || !labelsLabel) throw new Error("Expected Project and Labels rows");
    expect(projectLabel.compareDocumentPosition(labelsLabel) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();

    act(() => root.unmount());
  });

  it("stacks property chips vertically and aligns each label with the first chip", async () => {
    const blockedBy = Array.from({ length: 3 }, (_, index) => (createRelation(`blocker-${index + 1}`, `BLOCK-${index + 1}`, `Blocker ${index + 1}`))) as NonNullable<Issue["blockedBy"]>;
    const blocks = Array.from({ length: 3 }, (_, index) => (createRelation(`blocked-${index + 1}`, `BLOCKED-${index + 1}`, `Blocked task ${index + 1}`))) as NonNullable<Issue["blocks"]>;
    const labels = Array.from({ length: 3 }, (_, index) => createLabel({
      id: `label-${index + 1}`,
      name: `Label ${index + 1}`,
    }));
    const childIssues = Array.from({ length: 3 }, (_, index) => createIssue({
      id: `child-${index + 1}`,
      identifier: `SUB-${index + 1}`,
      title: `Subtask ${index + 1}`,
    }));
    const root = renderProperties(container, {
      issue: createIssue({
        blockedBy,
        blocks,
        labels,
        labelIds: labels.map((label) => label.id),
      }),
      childIssues,
      onUpdate: vi.fn(),
      sidePanelContentOnly: true,
    });
    await flush();

    for (const label of ["Labels", "Blocked by", "Blocking", "Subtasks"]) {
      const labelNode = container.querySelector(`[data-property-label="${label}"]`);
      const row = labelNode?.closest('[data-property-row="true"]');
      const value = row?.querySelector('[data-property-value="true"]');
      expect(row?.classList).toContain("items-start");
      expect(labelNode?.classList).toContain("mt-0.5");
      expect(value?.classList).toContain("flex-col");
      expect(value?.classList).toContain("items-start");
    }

    for (const label of ["Labels", "Blocked by", "Subtasks"]) {
      const trigger = findRowTrigger(container, label);
      const chipStack = label === "Labels"
        ? trigger?.querySelector("div")
        : trigger?.closest('[data-property-value="true"]')?.querySelector(".flex-col");
      expect(chipStack?.classList).toContain("flex-col");
      expect(chipStack?.classList).toContain("items-start");
    }

    const blockingValue = container
      .querySelector('[data-property-label="Blocking"]')
      ?.closest('[data-property-row="true"]')
      ?.querySelector('[data-property-value="true"] > div');
    expect(blockingValue?.classList).toContain("flex-col");

    act(() => root.unmount());
  });

  it("renders the lone Properties header as the active filled tab", async () => {
    const headerSlot = document.createElement("div");
    headerSlot.id = "properties-pane-header-slot";
    document.body.appendChild(headerSlot);

    const root = renderProperties(container, {
      issue: createIssue(),
      childIssues: [],
      onUpdate: vi.fn(),
    });
    await flush();

    const tab = headerSlot.querySelector<HTMLButtonElement>('[role="tab"]');
    expect(tab?.textContent).toBe("Properties");
    expect(tab?.getAttribute("aria-selected")).toBe("true");
    expect(tab?.classList).toContain("bg-muted");
    expect(tab?.classList).toContain("px-3");
    expect(tab?.classList).toContain("inline-flex");

    act(() => root.unmount());
  });

  it("uses the same filled active-tab treatment in a multi-tab pane header", async () => {
    const headerSlot = document.createElement("div");
    headerSlot.id = "properties-pane-header-slot";
    document.body.appendChild(headerSlot);

    const root = renderProperties(container, {
      issue: createIssue(),
      childIssues: [createIssue({ id: "child-1", identifier: "PAP-2", title: "Child task" })],
      onUpdate: vi.fn(),
    });
    await flush();

    const tabs = Array.from(headerSlot.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const propertiesTab = tabs.find((tab) => tab.textContent === "Properties");
    const subtasksTab = tabs.find((tab) => tab.textContent?.includes("Subtasks"));
    const tabItems = Array.from(headerSlot.querySelectorAll<HTMLElement>('[data-slot="task-detail-pane-tab"]'));
    const tabDividers = Array.from(headerSlot.querySelectorAll<HTMLElement>('[data-slot="task-detail-pane-tab-divider"]'));
    const subtasksLabel = subtasksTab?.querySelector<HTMLElement>('[title="Subtasks"]');
    const subtasksCount = Array.from(subtasksTab?.querySelectorAll<HTMLElement>("span") ?? [])
      .find((span) => span.textContent === "1");
    const closeSubtasks = headerSlot.querySelector<HTMLButtonElement>('[aria-label="Close Subtasks tab"]');
    const openClosedTab = headerSlot.querySelector<HTMLButtonElement>('[aria-label="Open closed sidebar tab"]');

    expect(propertiesTab?.getAttribute("data-state")).toBe("active");
    expect(subtasksTab?.getAttribute("data-state")).toBe("inactive");
    expect(tabItems).toHaveLength(2);
    expect(tabDividers).toHaveLength(1);
    expect(tabDividers[0]?.classList).toContain("h-4");
    expect(propertiesTab?.classList).toContain("mx-1.5");
    expect(propertiesTab?.classList).toContain("px-3");
    expect(subtasksTab?.classList).toContain("px-3");
    expect(subtasksTab?.classList).toContain("hover:bg-accent/50");
    expect(subtasksLabel?.classList).toContain("task-detail-pane-tab-label");
    expect(subtasksLabel?.classList).toContain("flex-1");
    expect(subtasksLabel?.classList).toContain("overflow-hidden");
    expect(subtasksLabel?.classList).toContain("whitespace-nowrap");
    expect(subtasksCount?.classList).toContain("group-hover/pane-tab:opacity-0");
    expect(closeSubtasks?.classList).toContain("opacity-0");
    expect(closeSubtasks?.classList).toContain("right-2.5");
    expect(closeSubtasks?.classList).toContain("group-hover/pane-tab:opacity-100");
    expect(openClosedTab?.classList).toContain("size-6");
    expect(openClosedTab?.classList).not.toContain("ml-1");
    expect(openClosedTab?.disabled).toBe(true);
    for (const tab of tabs) {
      expect(tab.classList).toContain("task-detail-pane-tab");
      expect(tab.classList).toContain("h-7");
      expect(tab.classList).toContain("rounded-md");
    }

    await act(async () => {
      subtasksTab?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    });

    expect(propertiesTab?.getAttribute("data-state")).toBe("inactive");
    expect(subtasksTab?.getAttribute("data-state")).toBe("active");

    await act(async () => closeSubtasks?.click());
    expect(headerSlot.querySelector('[role="tab"][data-state="active"]')?.textContent).toBe("Properties");
    expect(headerSlot.textContent).not.toContain("Subtasks");
    expect(openClosedTab?.disabled).toBe(false);

    await act(async () => {
      openClosedTab?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      openClosedTab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    let reopenSubtasks: HTMLElement | undefined;
    await waitForAssertion(() => {
      reopenSubtasks = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'))
        .find((item) => item.textContent === "Subtasks");
      expect(reopenSubtasks).not.toBeUndefined();
    });

    await act(async () => {
      reopenSubtasks?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      reopenSubtasks?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(headerSlot.querySelector('[role="tab"][data-state="active"]')?.textContent).toContain("Subtasks");

    act(() => root.unmount());
  });

  it("restores master's production property styling when Streamlined UI is off", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableTaskWatchdogs: false,
      enableStreamlinedUi: false,
      enableClassicTaskInterface: false,
    });

    const root = renderProperties(container, {
      issue: createIssue(),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await waitForAssertion(() => {
      expect(container.querySelector(".task-detail-properties")).toBeNull();
      expect(container.querySelector('[role="tab"]')).toBeNull();
    });
    expect(container.textContent).toContain("Status");
    expect(container.textContent).toContain("Triage");

    act(() => root.unmount());
  });

  it("restores master's plain Properties pane header when Streamlined UI is off", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableTaskWatchdogs: false,
      enableStreamlinedUi: false,
      enableClassicTaskInterface: false,
    });
    const headerSlot = document.createElement("div");
    headerSlot.id = "properties-pane-header-slot";
    document.body.appendChild(headerSlot);

    const root = renderProperties(container, {
      issue: createIssue(),
      childIssues: [],
      onUpdate: vi.fn(),
    });
    await waitForAssertion(() => {
      expect(headerSlot.textContent).toBe("Properties");
      expect(headerSlot.querySelector('[role="tab"]')).toBeNull();
      expect(container.querySelector(".task-detail-properties")).toBeNull();
    });

    act(() => root.unmount());
  });

  it("does not show a Plan tab for a planning-mode issue without a plan document", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableClassicTaskInterface: false,
    });
    const root = renderProperties(container, {
      issue: createIssue({ workMode: "planning" }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });

    await waitForAssertion(() => {
      expect(Array.from(container.querySelectorAll("button")).some((button) => button.textContent === "Plan")).toBe(false);
      expect(container.textContent).not.toContain("This task is in plan mode but no plan document has been written yet.");
    });

    act(() => root.unmount());
  });

  it("overrides a previously selected pane tab for a document deep link", async () => {
    const planDocument = {
      id: "document-plan",
      companyId: "company-1",
      issueId: "issue-1",
      key: "plan",
      title: "Plan",
      format: "markdown",
      body: "Plan body",
      latestRevisionId: "revision-plan",
      latestRevisionNumber: 1,
      createdByAgentId: null,
      createdByUserId: null,
      updatedByAgentId: null,
      updatedByUserId: null,
      lockedAt: null,
      lockedByAgentId: null,
      lockedByUserId: null,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    } satisfies IssueDocument;
    const artifactDocument = {
      ...planDocument,
      id: "document-evidence",
      key: "qa-evidence",
      title: "QA evidence",
      body: "Evidence body",
      latestRevisionId: "revision-evidence",
    } satisfies IssueDocument;
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableClassicTaskInterface: false,
    });
    mockIssuesApi.getDocument.mockResolvedValue(planDocument);
    mockIssuesApi.listDocuments.mockResolvedValue([planDocument, artifactDocument]);
    Element.prototype.scrollIntoView = vi.fn();

    const props = {
      issue: createIssue(),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    } satisfies ComponentProps<typeof IssueProperties>;
    const { root, queryClient } = renderPropertiesWithQueryClient(container, props);
    await waitForAssertion(() => {
      const planTab = Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Plan");
      expect(planTab?.getAttribute("data-state")).toBe("active");
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueProperties
            {...props}
            documentDeepLink={{ tab: "artifacts", documentKey: "qa-evidence", requestId: 1 }}
          />
        </QueryClientProvider>,
      );
    });

    await waitForAssertion(() => {
      const artifactsTab = Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Artifacts");
      expect(artifactsTab?.getAttribute("data-state")).toBe("active");
      expect(container.querySelector('button[aria-expanded="true"]')).not.toBeNull();
    });
    act(() => root.unmount());
  });

  it("hides the Priority property row while priority UI is off (PAP-411)", async () => {
    const root = renderProperties(container, {
      issue: createIssue({ priority: "high" }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    await waitForAssertion(() => {
      // The Triage section still renders the Status row...
      expect(container.querySelector('[data-property-label="Status"]')).not.toBeNull();
      // ...but the Priority row is gated behind SHOW_TASK_PRIORITY_UI (off).
      expect(container.querySelector('[data-property-label="Priority"]')).toBeNull();
    });

    act(() => root.unmount());
  });
});
