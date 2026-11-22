// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ExecutionWorkspace, Issue, IssueLabel, Project, WorkspaceRuntimeService } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLastProjectId } from "../lib/recent-projects";
import { IssueProperties } from "./IssueProperties";
import { applyOptimisticIssueFieldUpdate } from "../lib/optimistic-issue-comments";
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

function createRuntimeService(overrides: Partial<WorkspaceRuntimeService> = {}): WorkspaceRuntimeService {
  return {
    id: "service-1",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: "workspace-main",
    executionWorkspaceId: "workspace-1",
    issueId: "issue-1",
    scopeType: "execution_workspace",
    scopeId: "workspace-1",
    serviceName: "web",
    status: "running",
    lifecycle: "shared",
    reuseKey: null,
    command: "pnpm dev",
    cwd: "/tmp/paperclip",
    port: 62475,
    url: "http://127.0.0.1:62475",
    provider: "local_process",
    providerRef: null,
    ownerAgentId: null,
    startedByRunId: null,
    lastUsedAt: new Date("2026-04-06T12:03:00.000Z"),
    startedAt: new Date("2026-04-06T12:02:00.000Z"),
    stoppedAt: null,
    stopPolicy: null,
    healthStatus: "healthy",
    createdAt: new Date("2026-04-06T12:02:00.000Z"),
    updatedAt: new Date("2026-04-06T12:03:00.000Z"),
    ...overrides,
  };
}

function createExecutionWorkspace(overrides: Partial<ExecutionWorkspace> = {}): ExecutionWorkspace {
  return {
    id: "workspace-1",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: "workspace-main",
    sourceIssueId: "issue-1",
    mode: "isolated_workspace",
    strategyType: "git_worktree",
    name: "PAP-1 workspace",
    status: "active",
    deliveryState: "unknown",
    cwd: "/tmp/paperclip/PAP-1",
    repoUrl: null,
    baseRef: "master",
    branchName: "pap-1-workspace",
    providerType: "git_worktree",
    providerRef: "/tmp/paperclip/PAP-1",
    derivedFromExecutionWorkspaceId: null,
    lastUsedAt: new Date("2026-04-06T12:04:00.000Z"),
    openedAt: new Date("2026-04-06T12:01:00.000Z"),
    closedAt: null,
    cleanupEligibleAt: null,
    cleanupReason: null,
    config: null,
    metadata: null,
    runtimeServices: [createRuntimeService()],
    createdAt: new Date("2026-04-06T12:01:00.000Z"),
    updatedAt: new Date("2026-04-06T12:04:00.000Z"),
    ...overrides,
  };
}

function createProject(overrides: Partial<Project> = {}): Project {
  const primaryWorkspace = {
    id: "workspace-main",
    companyId: "company-1",
    projectId: "project-1",
    name: "Main",
    sourceType: "local_path" as const,
    cwd: "/tmp/paperclip",
    repoUrl: null,
    repoRef: null,
    defaultRef: "master",
    visibility: "default" as const,
    setupCommand: null,
    cleanupCommand: null,
    remoteProvider: null,
    remoteWorkspaceRef: null,
    sharedWorkspaceKey: null,
    metadata: null,
    runtimeConfig: null,
    isPrimary: true,
    runtimeServices: [],
    createdAt: new Date("2026-04-06T12:00:00.000Z"),
    updatedAt: new Date("2026-04-06T12:00:00.000Z"),
  };
  return {
    id: "project-1",
    companyId: "company-1",
    urlKey: "project-1",
    goalId: null,
    goalIds: [],
    goals: [],
    name: "Project",
    description: null,
    status: "in_progress",
    leadAgentId: null,
    targetDate: null,
    color: "#6366f1",
    icon: null,
    env: null,
    pauseReason: null,
    pausedAt: null,
    executionWorkspacePolicy: null,
    codebase: {
      workspaceId: "workspace-main",
      repoUrl: null,
      repoRef: null,
      defaultRef: "master",
      repoName: null,
      localFolder: "/tmp/paperclip",
      managedFolder: "/tmp/paperclip",
      effectiveLocalFolder: "/tmp/paperclip",
      origin: "local_folder",
    },
    workspaces: [primaryWorkspace],
    primaryWorkspace,
    archivedAt: null,
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

describe("IssueProperties provenance, relationships and project properties", () => {
  let container: HTMLDivElement;

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

  it("shows assignee and originating without responsible wording", async () => {
    mockAgentsApi.list.mockResolvedValue([{ id: "agent-1", name: "CodexCoder", status: "active", adapterType: "codex_local" }]);
    const root = renderProperties(container, {
      issue: createIssue({
        assigneeAgentId: "agent-1",
        createdByUserId: "user-1",
        responsibleUserId: "user-2",
      }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Assignee");
      expect(container.textContent).toContain("CodexCoder");
      expect(container.textContent).toContain("Originating");
      expect(container.textContent).toContain("Riley Board");
      expect(container.textContent).not.toContain("Morgan Product");
      expect(container.textContent).not.toContain("Responsible");
      expect(container.textContent).not.toContain("Kicked off by");
      expect(container.textContent).not.toContain("Created by");
      expect(container.querySelector('[title="CodexCoder"] [data-slot="agent-avatar"] img')?.getAttribute("src")).toContain("/api/agent-avatars/cap-v1/");
    });

    act(() => root.unmount());
  });

  it("shows originating without merged responsible wording when responsible is derived from the creator", async () => {
    const root = renderProperties(container, {
      issue: createIssue({
        createdByUserId: "user-1",
        responsibleUserId: null,
      }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Originating");
      expect(container.textContent).toContain("Riley Board");
      expect(container.textContent).not.toContain("Kicked off by");
      expect(container.textContent).not.toContain("Kicked off by · responsible");
      expect(container.textContent).not.toContain("(auto)");
      expect(container.textContent).not.toContain("Created by");
    });

    act(() => root.unmount());
  });

  it("shows originating agent without responsible wording", async () => {
    mockAgentsApi.list.mockResolvedValue([{ id: "agent-1", name: "CodexCoder", status: "active", adapterType: "codex_local" }]);
    const root = renderProperties(container, {
      issue: createIssue({
        createdByAgentId: "agent-1",
        createdByUserId: null,
        responsibleUserId: null,
      }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Originating");
      expect(container.textContent).toContain("CodexCoder");
      expect(container.textContent).toContain("Assignee");
      expect(container.textContent).toContain("Unassigned");
      expect(container.textContent).not.toContain("Responsible");
      expect(container.textContent).not.toContain("Kicked off by");
      expect(container.querySelector('[title="CodexCoder"] [data-slot="agent-avatar"] img')?.getAttribute("src")).toContain("/api/agent-avatars/cap-v1/");
    });

    act(() => root.unmount());
  });

  it("attributes an agent-created issue to the transitive responsible user with a via affordance", async () => {
    mockAgentsApi.list.mockResolvedValue([{ id: "agent-1", name: "CodexCoder", status: "active", adapterType: "codex_local" }]);
    const root = renderProperties(container, {
      issue: createIssue({
        createdByAgentId: "agent-1",
        createdByUserId: null,
        responsibleUserId: "user-2",
      }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Originating");
      expect(container.textContent).toContain("Morgan Product");
      expect(container.textContent).toContain("via CodexCoder");
      expect(container.textContent).not.toContain("Responsible");
      expect(container.textContent).not.toContain("Kicked off by");
    });

    act(() => root.unmount());
  });

  it("shows originating responsible user for a routine execution with no creator", async () => {
    const root = renderProperties(container, {
      issue: createIssue({
        createdByAgentId: null,
        createdByUserId: null,
        responsibleUserId: "user-2",
      }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Originating");
      expect(container.textContent).toContain("Morgan Product");
      expect(container.textContent).not.toContain("via ");
    });

    act(() => root.unmount());
  });

  it("links a routine-created task back to its source routine under Relationships", async () => {
    mockRoutinesApi.get.mockResolvedValue({ id: "routine-1", title: "Nightly triage" });
    const root = renderProperties(container, {
      issue: createIssue({ originKind: "routine_execution", originId: "routine-1" }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });

    await waitForAssertion(() => {
      const row = container
        .querySelector('[data-property-label="Routine"]')
        ?.closest('[data-property-row="true"]');
      const link = row?.querySelector("a");
      expect(link?.getAttribute("href")).toBe("/routines/routine-1");
      expect(link?.textContent).toContain("Nightly triage");
    });
    expect(mockRoutinesApi.get).toHaveBeenCalledWith("routine-1");

    act(() => root.unmount());
  });

  it("omits the Routine row while the source routine is still loading", async () => {
    mockRoutinesApi.get.mockReturnValue(new Promise(() => {}));
    const root = renderProperties(container, {
      issue: createIssue({ originKind: "routine_execution", originId: "routine-1" }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    expect(mockRoutinesApi.get).toHaveBeenCalledWith("routine-1");
    expect(container.querySelector('[data-property-label="Routine"]')).toBeNull();

    act(() => root.unmount());
  });

  it("omits the Routine row when the source routine no longer exists", async () => {
    mockRoutinesApi.get.mockRejectedValue(new ApiError("Not found", 404, null));
    const root = renderProperties(container, {
      issue: createIssue({ originKind: "routine_execution", originId: "routine-gone" }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });

    await waitForAssertion(() => {
      expect(mockRoutinesApi.get).toHaveBeenCalledWith("routine-gone");
    });
    await flush();
    expect(container.querySelector('[data-property-label="Routine"]')).toBeNull();

    act(() => root.unmount());
  });

  it("omits the Routine row for tasks not created by a routine", async () => {
    const root = renderProperties(container, {
      issue: createIssue(),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    expect(container.querySelector('[data-property-label="Routine"]')).toBeNull();
    expect(mockRoutinesApi.get).not.toHaveBeenCalled();

    act(() => root.unmount());
  });

  it("groups the assignee picker and gates a live-run reassign behind an interrupt confirm", async () => {
    const minimalAgent = (id: string, name: string) =>
      ({
        id,
        name,
        role: "",
        title: null,
        icon: null,
        status: "active",
        orgChainHealth: { status: "ok" },
      } as unknown as Parameters<typeof mockAgentsApi.list.mockResolvedValue>[0][number]);
    mockAgentsApi.list.mockResolvedValue([minimalAgent("agent-1", "ClaudeCoder"), minimalAgent("agent-2", "QA")]);
    const onUpdate = vi.fn();
    const root = renderProperties(container, {
      issue: createIssue({ assigneeAgentId: "agent-1" }),
      childIssues: [],
      onUpdate,
      inline: true,
      hasActiveRun: true,
    });
    await flush();

    // Wait for the agents query to resolve so the current assignee renders.
    let trigger: HTMLButtonElement | undefined;
    await waitForAssertion(() => {
      trigger = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("ClaudeCoder"),
      );
      expect(trigger).toBeTruthy();
    });
    await act(async () => {
      trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    // Live-run banner + grouped section headers are present.
    expect(container.querySelector("[data-testid='assignee-running-banner']")?.textContent).toContain(
      "ClaudeCoder is running",
    );
    expect(container.textContent).toContain("Agents");
    expect(container.textContent).toContain("Board users");

    // Picking a different agent mid-run stages a confirm rather than applying.
    const qaOption = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "QA",
    );
    expect(qaOption).toBeTruthy();
    await act(async () => {
      qaOption!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(container.querySelector("[data-testid='interrupt-assign-confirm']")).not.toBeNull();
    expect(onUpdate).not.toHaveBeenCalled();

    // Confirming applies the reassignment.
    const confirmBtn = container.querySelector<HTMLButtonElement>(
      "[data-testid='interrupt-assign-confirm-action']",
    )!;
    await act(async () => {
      confirmBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(onUpdate).toHaveBeenCalledWith({ assigneeAgentId: "agent-2", assigneeUserId: null });

    act(() => root.unmount());
  });

  it("filters the no-assignee option with assignee search", async () => {
    mockAgentsApi.list.mockResolvedValue([
      {
        id: "agent-1",
        name: "ClaudeCoder",
        role: "",
        title: null,
        icon: null,
        status: "active",
        orgChainHealth: { status: "ok" },
      } as unknown as Parameters<typeof mockAgentsApi.list.mockResolvedValue>[0][number],
    ]);
    const root = renderProperties(container, {
      issue: createIssue(),
      childIssues: [],
      onUpdate: vi.fn(),
    });
    await flush();

    const searchInput = container.querySelector(
      'input[placeholder="Search assignees..."]',
    ) as HTMLInputElement | null;
    expect(searchInput).not.toBeNull();

    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      nativeSetter?.call(searchInput, "no");
      searchInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain("No assignee");
    expect(container.textContent).not.toContain("No matches.");

    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      nativeSetter?.call(searchInput, "zzzz");
      searchInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();

    expect(container.textContent).not.toContain("No assignee");
    expect(container.textContent).toContain("No matches.");

    act(() => root.unmount());
  });

  it("exposes the add-subtask action from the relationships picker", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableClassicTaskInterface: true,
    });
    const onAddSubIssue = vi.fn();
    const root = renderProperties(container, {
      issue: createIssue(),
      childIssues: [],
      onAddSubIssue,
      onUpdate: vi.fn(),
    });
    await waitForAssertion(() => {
      expect(container.textContent).toContain("Add subtask");
    });

    expect(container.textContent).toContain("Subtasks");

    const addButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Add subtask"));
    expect(addButton).not.toBeUndefined();

    await act(async () => {
      addButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onAddSubIssue).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
  });

  it("gives sub-tasks a dedicated chat-shell panel tab", async () => {
    const onAddSubIssue = vi.fn();
    const root = renderProperties(container, {
      issue: createIssue(),
      childIssues: [createIssue({ id: "child-2", identifier: "PAP-2", title: "Panel child" })],
      onAddSubIssue,
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    const subtasksTab = Array.from(container.querySelectorAll<HTMLButtonElement>('button[role="tab"]'))
      .find((button) => button.textContent?.includes("Subtasks"));
    expect(subtasksTab).not.toBeUndefined();
    await act(async () => {
      subtasksTab!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    });
    expect(container.textContent).toContain("Panel child");
    expect(container.textContent).toContain("0 of 1 complete");
    expect(container.textContent).toContain("Next action");
    expect(container.querySelector('[data-slot="task-row"]')).not.toBeNull();
    const addButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Add subtask"));
    await act(async () => addButton!.click());
    expect(onAddSubIssue).toHaveBeenCalledOnce();

    act(() => root.unmount());
  });

  it("always shows watchdog setup controls", async () => {
    const root = renderProperties(container, {
      issue: createIssue(),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Watchdog");
      // Empty watchdog uses the uniform muted "None" empty state (ux-spec §6).
      expect(findRowTrigger(container, "Watchdog")?.textContent).toContain("None");
    });

    act(() => root.unmount());
  });

  it("passes blocker attention to the sidebar status icon", async () => {
    const root = renderProperties(container, {
      issue: createIssue({
        status: "blocked",
        blockerAttention: {
          state: "covered",
          reason: "active_child",
          unresolvedBlockerCount: 1,
          coveredBlockerCount: 1,
          stalledBlockerCount: 0,
          attentionBlockerCount: 0,
          sampleBlockerIdentifier: "PAP-2",
          sampleStalledBlockerIdentifier: null,
        },
      }),
      childIssues: [],
      onUpdate: vi.fn(),
    });
    await flush();

    expect(container.querySelector('[data-status-icon-state="covered"]')?.textContent).toBe("blocked");

    act(() => root.unmount());
  });

  it.each([false, true])("keeps relationship badges mounted as queries settle (inline=%s)", async (inline) => {
    let resolveProjects!: (projects: Project[]) => void;
    mockProjectsApi.list.mockReturnValue(new Promise<Project[]>((resolve) => { resolveProjects = resolve; }));
    const onUpdate = vi.fn();
    const issue = createIssue({
      blockedBy: [createIssue({ id: "blocker-1", identifier: "PAP-2", status: "in_progress" })],
    });
    const props = { issue, childIssues: [], onUpdate, inline, sidePanelContentOnly: true };
    const { root, queryClient } = renderPropertiesWithQueryClient(container, props);
    const link = container.querySelector('a[href="/issues/PAP-2"]');
    const remove = container.querySelector('[aria-label="Remove PAP-2 as blocker"]');
    expect(link).not.toBeNull();
    expect(remove).not.toBeNull();
    await flush();
    await act(async () => resolveProjects([]));
    await flush();
    // A parent page can provide a fresh task object after a query refresh.
    await act(async () => root.render(
      <QueryClientProvider client={queryClient}>
        <IssueProperties {...props} issue={{ ...issue, blockedBy: [...issue.blockedBy!] }} />
      </QueryClientProvider>,
    ));
    expect(container.querySelector('a[href="/issues/PAP-2"]')).toBe(link);
    expect(container.querySelector('[aria-label="Remove PAP-2 as blocker"]')).toBe(remove);
    expect(link?.textContent).toContain("in_progress");
    expect(onUpdate).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-expanded="true"]')).toBeNull();
    act(() => root.unmount());
  });

  it("preserves a locked parent stub without manufacturing a title or navigation link", async () => {
    const root = renderProperties(container, {
      issue: createIssue({ parentId: "private-parent", ancestors: [{ id: "private-parent", identifier: "PAP-99", locked: true }] as unknown as Issue["ancestors"] }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();
    expect(container.querySelector('[data-testid="locked-issue-chip"]')?.textContent).toContain("PAP-99");
    expect(container.querySelector('a[href="/issues/PAP-99"]')).toBeNull();
    expect(container.querySelector('[title="private-"]')).toBeNull();
    act(() => root.unmount());
  });

  it("links relationship status and IDs and removes only the selected blocker with its X", async () => {
    const onUpdate = vi.fn();
    const blockers = [
      createIssue({ id: "issue-2", identifier: "PAP-2", title: "Existing blocker", status: "in_progress" }),
      createIssue({ id: "issue-3", identifier: "PAP-3", title: "Keep blocker", status: "todo" }),
    ];
    const root = renderProperties(container, {
      issue: createIssue({ blockedBy: blockers }),
      childIssues: [createIssue({ id: "child-1", identifier: "PAP-4", status: "done" })],
      onUpdate,
      inline: true,
    });
    await flush();
    const row = container.querySelector('[data-property-label="Blocked by"]')!.closest('[data-property-row]')!;
    const link = row.querySelector<HTMLAnchorElement>('a[href="/issues/PAP-2"]')!;
    expect(link).not.toBeNull();
    expect(link.textContent).toContain("in_progress");
    expect(link.closest("button")).toBeNull();
    link.addEventListener("click", (event) => event.preventDefault());
    await act(async () => link.click());
    expect(onUpdate).not.toHaveBeenCalled();
    expect(container.querySelector('input[aria-label="Search tasks to add as blockers"]')).toBeNull();
    const remove = row.querySelector<HTMLButtonElement>('button[aria-label="Remove PAP-2 as blocker"]')!;
    expect(remove.closest("a")).toBeNull();
    await act(async () => remove.click());
    expect(onUpdate).toHaveBeenCalledExactlyOnceWith({ blockedByIssueIds: ["issue-3"] });
    expect(container.querySelector('a[href="/issues/PAP-4"]')?.textContent).toContain("done");
    act(() => root.unmount());
  });

  it("edits blockers from the blocked-by relationship flyout", async () => {
    const onUpdate = vi.fn();
    mockIssuesApi.list.mockResolvedValue([
      createIssue({ id: "issue-3", identifier: "PAP-3", title: "New blocker", status: "todo" }),
    ]);

    const root = renderProperties(container, {
      issue: createIssue({
        blockedBy: [
          createRelation("issue-2", "PAP-2", "Existing blocker", "in_progress"),
        ],
      }),
      childIssues: [],
      onUpdate,
      inline: true,
    });
    await flush();

    const blockerTrigger = findRowTrigger(container, "Blocked by");
    expect(blockerTrigger?.closest('[data-property-row="true"]')?.textContent).toContain("PAP-2");
    expect(container.textContent).not.toContain("Add blocker");
    expect(container.querySelector('input[placeholder="Search tasks..."]')).toBeNull();

    await act(async () => {
      blockerTrigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(container.querySelector('input[placeholder="Search tasks..."]')).not.toBeNull();

    const candidateButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("PAP-3 New blocker"));
    expect(candidateButton).not.toBeUndefined();

    await act(async () => {
      candidateButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onUpdate).toHaveBeenCalledWith({ blockedByIssueIds: ["issue-2", "issue-3"] });

    act(() => root.unmount());
  });

  it("searches all company issues when adding a blocker", async () => {
    const onUpdate = vi.fn();
    const loadedIssue = createIssue({ id: "issue-3", identifier: "PAP-3", title: "Loaded issue", status: "todo" });
    const remoteIssue = createIssue({ id: "issue-99", identifier: "PAP-99", title: "Remote blocker", status: "in_progress" });
    mockIssuesApi.list.mockImplementation((_companyId: string, filters?: { q?: string; limit?: number }) => {
      if (filters?.q === "remote") return Promise.resolve([remoteIssue]);
      return Promise.resolve([loadedIssue]);
    });

    const root = renderProperties(container, {
      issue: createIssue(),
      childIssues: [],
      onUpdate,
      inline: true,
    });
    await flush();

    const blockerTrigger = findRowTrigger(container, "Blocked by");
    expect(blockerTrigger).not.toBeUndefined();

    await act(async () => {
      blockerTrigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const searchInput = container.querySelector('input[aria-label="Search tasks to add as blockers"]') as HTMLInputElement | null;
    expect(searchInput).not.toBeNull();

    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      nativeSetter?.call(searchInput, "remote");
      searchInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(mockIssuesApi.list).toHaveBeenCalledWith("company-1", { q: "remote", limit: 50 });
      expect(container.textContent).toContain("PAP-99 Remote blocker");
      expect(container.textContent).not.toContain("PAP-3 Loaded issue");
    });

    const candidateButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("PAP-99 Remote blocker"));
    expect(candidateButton).not.toBeUndefined();

    await act(async () => {
      candidateButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onUpdate).toHaveBeenCalledWith({ blockedByIssueIds: ["issue-99"] });

    act(() => root.unmount());
  });

  it("removes a blocked-by issue by toggling it in the relationship flyout", async () => {
    const onUpdate = vi.fn();
    const root = renderProperties(container, {
      issue: createIssue({
        blockedBy: [
          createRelation("issue-2", "PAP-2", "Existing blocker", "in_progress"),
          createRelation("issue-4", "PAP-4", "Keep blocker"),
        ],
      }),
      childIssues: [],
      onUpdate,
      inline: true,
    });
    await flush();

    const blockerTrigger = findRowTrigger(container, "Blocked by");
    expect(blockerTrigger).not.toBeUndefined();

    await act(async () => {
      blockerTrigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const selectedBlocker = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("PAP-2 Existing blocker"));
    expect(selectedBlocker).not.toBeUndefined();

    await act(async () => {
      selectedBlocker!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onUpdate).toHaveBeenCalledWith({ blockedByIssueIds: ["issue-4"] });

    act(() => root.unmount());
  });

  it("uses the same blocked-by relationship picker on mobile", async () => {
    mockSidebarState.isMobile = true;
    const onUpdate = vi.fn();
    const root = renderProperties(container, {
      issue: createIssue({
        blockedBy: [
          createRelation("issue-2", "PAP-2", "Existing blocker", "in_progress"),
          createRelation("issue-4", "PAP-4", "Keep blocker"),
        ],
      }),
      childIssues: [],
      onUpdate,
      inline: true,
    });
    await flush();

    const blockerTrigger = findRowTrigger(container, "Blocked by");
    expect(blockerTrigger?.closest('[data-property-row="true"]')?.textContent).toContain("PAP-2");

    await act(async () => {
      blockerTrigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const selectedBlocker = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("PAP-2 Existing blocker"));
    expect(selectedBlocker).not.toBeUndefined();

    await act(async () => {
      selectedBlocker!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onUpdate).toHaveBeenCalledWith({ blockedByIssueIds: ["issue-4"] });

    act(() => root.unmount());
  });

  it("summarizes long blocked-by and subtask relationships in their picker triggers", async () => {
    const blockedBy = Array.from({ length: 7 }, (_, index) => (createRelation(`blocker-${index + 1}`, `BLOCK-${index + 1}`, `Blocker ${index + 1}`))) as NonNullable<Issue["blockedBy"]>;
    const childIssues = Array.from({ length: 7 }, (_, index) => createIssue({
      id: `child-${index + 1}`,
      identifier: `SUB-${index + 1}`,
      title: `Sub-task ${index + 1}`,
    }));
    const root = renderProperties(container, {
      issue: createIssue({ blockedBy }),
      childIssues,
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    const blockedByTrigger = findRowTrigger(container, "Blocked by");
    expect(blockedByTrigger?.closest('[data-property-row="true"]')?.textContent).toContain("BLOCK-1");
    expect(blockedByTrigger?.closest('[data-property-row="true"]')?.textContent).toContain("BLOCK-2");
    expect(blockedByTrigger?.closest('[data-property-row="true"]')?.textContent).toContain("+5 more");
    expect(blockedByTrigger?.closest('[data-property-row="true"]')?.textContent).not.toContain("BLOCK-7");

    const subtasksTrigger = findRowTrigger(container, "Subtasks");
    expect(subtasksTrigger?.closest('[data-property-row="true"]')?.textContent).toContain("SUB-1");
    expect(subtasksTrigger?.closest('[data-property-row="true"]')?.textContent).toContain("SUB-2");
    expect(subtasksTrigger?.closest('[data-property-row="true"]')?.textContent).toContain("+5 more");
    expect(subtasksTrigger?.closest('[data-property-row="true"]')?.textContent).not.toContain("SUB-7");

    await act(async () => {
      blockedByTrigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain("BLOCK-7");

    await act(async () => {
      blockedByTrigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    await act(async () => {
      subtasksTrigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain("SUB-7");

    act(() => root.unmount());
  });

  it("collapses long blocking and related task lists until the more button is clicked", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableTaskWatchdogs: false,
      enableClassicTaskInterface: true,
    });
    const blocking = Array.from({ length: 7 }, (_, index) => (createRelation(`blocking-${index + 1}`, `BLOCKING-${index + 1}`, `Blocking issue ${index + 1}`))) as NonNullable<Issue["blocks"]>;
    const relatedIssues = Array.from({ length: 7 }, (_, index) => ({
      id: `related-${index + 1}`,
      identifier: `RELATED-${index + 1}`,
      title: `Related issue ${index + 1}`,
      status: "todo" as const,
      priority: "medium" as const,
      assigneeAgentId: null,
      assigneeUserId: null,
    }));
    const root = renderProperties(container, {
      issue: createIssue({
        blocks: blocking,
        relatedWork: {
          outbound: relatedIssues.map((issue) => ({
            issue,
            mentionCount: 1,
            sources: [{ kind: "description", sourceRecordId: null, label: "description", matchedText: issue.identifier }],
          })),
          inbound: [],
        },
      }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("RELATED-5");
    });
    expect(container.textContent).toContain("BLOCKING-5");
    expect(container.textContent).not.toContain("BLOCKING-6");
    expect(container.textContent).not.toContain("RELATED-6");
    expect(
      Array.from(container.querySelectorAll("button")).filter((button) =>
        button.textContent?.trim() === "Show 2 more",
      ),
    ).toHaveLength(2);

    const expandBlocking = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.trim() === "Show 2 more",
    );
    expect(expandBlocking).not.toBeUndefined();
    await act(async () => {
      expandBlocking!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("BLOCKING-6");
    expect(container.textContent).toContain("BLOCKING-7");
    expect(container.textContent).not.toContain("RELATED-6");

    const expandRelated = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.trim() === "Show 2 more",
    );
    expect(expandRelated).not.toBeUndefined();
    await act(async () => {
      expandRelated!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("RELATED-6");
    expect(container.textContent).toContain("RELATED-7");

    act(() => root.unmount());
  });

  it("collapses long external URL rows until the more button is clicked", async () => {
    const externalObjects = Array.from({ length: 7 }, (_, index) => ({
      mentionCount: 1,
      sourceLabels: ["Description"],
      pill: {
        providerKey: "url" as const,
        objectType: "link" as const,
        displayKey: null,
        iconKey: null,
        statusCategory: "unknown" as const,
        statusIconKey: null,
        statusLabel: null,
        liveness: "unknown" as const,
        displayTitle: `https://example.com/reference-${index + 1}`,
        url: `https://example.com/reference-${index + 1}`,
      },
      group: {
        object: null,
        mentions: [],
        mentionCount: 1,
        sourceLabels: ["Description"],
      },
    }));
    const root = renderProperties(container, {
      issue: createIssue(),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
      externalObjects,
    });
    await flush();

    expect(container.textContent).toContain("reference-5");
    expect(container.textContent).not.toContain("reference-6");
    expect(container.textContent).toContain("References");
    const expandUrls = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.trim() === "Show 2 more",
    );
    expect(expandUrls).not.toBeUndefined();

    await act(async () => {
      expandUrls!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("reference-6");
    expect(container.textContent).toContain("reference-7");
    expect(container.textContent).toContain("Show less");

    act(() => root.unmount());
  });

  it("updates the blocked-by relationship summary when the issue changes", async () => {
    const blockedBy = Array.from({ length: 7 }, (_, index) => (createRelation(`blocker-${index + 1}`, `BLOCK-${index + 1}`, `Blocker ${index + 1}`))) as NonNullable<Issue["blockedBy"]>;
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    const root = createRoot(container);

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueProperties
            issue={createIssue({ id: "issue-a", blockedBy })}
            childIssues={[]}
            onUpdate={vi.fn()}
            inline
          />
        </QueryClientProvider>,
      );
    });
    await flush();

    expect(findRowTrigger(container, "Blocked by")?.closest('[data-property-row="true"]')?.textContent).toContain("BLOCK-1");
    expect(findRowTrigger(container, "Blocked by")?.closest('[data-property-row="true"]')?.textContent).toContain("+5 more");

    const nextBlockedBy = [{
      id: "next-blocker",
      identifier: "NEXT-1",
      title: "Next blocker",
      status: "todo" as const,
      priority: "medium" as const,
      assigneeAgentId: null,
      assigneeUserId: null,
    }];

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueProperties
            issue={createIssue({ id: "issue-b", blockedBy: nextBlockedBy })}
            childIssues={[]}
            onUpdate={vi.fn()}
            inline
          />
        </QueryClientProvider>,
      );
    });
    await flush();

    expect(findRowTrigger(container, "Blocked by")?.closest('[data-property-row="true"]')?.textContent).toContain("NEXT-1");
    expect(findRowTrigger(container, "Blocked by")?.closest('[data-property-row="true"]')?.textContent).not.toContain("BLOCK-1");
    expect(findRowTrigger(container, "Blocked by")?.closest('[data-property-row="true"]')?.textContent).not.toContain("more");

    act(() => root.unmount());
  });

  it("keeps the current archived project visible in the project property", async () => {
    mockProjectsApi.list.mockResolvedValue([
      createProject({
        id: "archived-project",
        name: "Archived Project",
        archivedAt: new Date("2026-04-08T00:00:00.000Z"),
      }),
    ]);

    const root = renderProperties(container, {
      issue: createIssue({ projectId: "archived-project" }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    expect(mockProjectsApi.list).toHaveBeenCalledWith("company-1", { includeArchived: true });
    await waitForAssertion(() => {
      expect(findRowTrigger(container, "Project")?.textContent).toContain("Archived Project");
    });

    act(() => root.unmount());
  });

  it("uses the configured project color and icon in the project property", async () => {
    mockProjectsApi.list.mockResolvedValue([
      createProject({
        name: "Configured Project",
        color: "#0ea5e9",
        icon: "rocket",
      }),
    ]);

    const root = renderProperties(container, {
      issue: createIssue({ projectId: "project-1" }),
      childIssues: [],
      onUpdate: vi.fn(),
      sidePanelContentOnly: true,
    });
    await waitForAssertion(() => {
      expect(findRowTrigger(container, "Project")?.textContent).toContain("Configured Project");
    });

    const projectTrigger = findRowTrigger(container, "Project");
    const projectTile = projectTrigger?.querySelector<HTMLElement>('span.inline-flex[aria-hidden="true"]');
    expect(projectTile?.style.backgroundColor).toBe("rgb(14, 165, 233)");
    expect(projectTile?.querySelector("svg")?.classList).toContain("lucide-rocket");

    act(() => root.unmount());
  });

  it("leaves project memory unchanged until task property edits are persisted", async () => {
    localStorage.clear();
    mockProjectsApi.list.mockResolvedValue([createProject({ name: "Remembered Project" })]);
    const root = renderProperties(container, {
      issue: createIssue(), childIssues: [], onUpdate: vi.fn(), inline: true,
    });
    await flush();
    await act(() => findRowTrigger(container, "Project")!.click());
    const option = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Remembered Project")!;
    expect(option).toBeDefined();
    act(() => option.click());
    expect(getLastProjectId("company-1")).toBeUndefined();
    await act(() => findRowTrigger(container, "Project")!.click());
    const none = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "No project")!;
    act(() => none.click());
    expect(getLastProjectId("company-1")).toBeUndefined();
    expect(getLastProjectId("company-2")).toBeUndefined();
    act(() => root.unmount());
    localStorage.clear();
  });

  it("changes only project organization while preserving the bound workspace", async () => {
    mockProjectsApi.list.mockResolvedValue([createProject({ name: "Target Project" })]);
    const workspace = createExecutionWorkspace({ projectId: null, projectWorkspaceId: null });
    const issue = createIssue({
      executionWorkspaceId: workspace.id,
      currentExecutionWorkspace: workspace,
    });
    const onUpdate = vi.fn();
    const root = renderProperties(container, { issue, childIssues: [], onUpdate, inline: true });
    await flush();
    await act(() => findRowTrigger(container, "Project")!.click());
    const project = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Target Project")!;
    act(() => project.click());
    expect(onUpdate).toHaveBeenLastCalledWith({ projectId: "project-1" });
    const assigned = applyOptimisticIssueFieldUpdate(issue, onUpdate.mock.lastCall![0])!;
    expect(assigned.executionWorkspaceId).toBe(workspace.id);
    expect(assigned.currentExecutionWorkspace).toBe(workspace);
    await act(() => findRowTrigger(container, "Project")!.click());
    const none = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "No project")!;
    act(() => none.click());
    expect(onUpdate).toHaveBeenLastCalledWith({ projectId: null });
    const cleared = applyOptimisticIssueFieldUpdate(assigned, onUpdate.mock.lastCall![0])!;
    expect(cleared.executionWorkspaceId).toBe(workspace.id);
    expect(cleared.currentExecutionWorkspace).toBe(workspace);
    expect(cleared.currentExecutionWorkspace?.cwd).toBe(workspace.cwd);
    act(() => root.unmount());
  });

  it("shows a green service link above the workspace row for a live non-main workspace", async () => {
    mockProjectsApi.list.mockResolvedValue([createProject()]);
    const serviceUrl = "http://127.0.0.1:62475";
    const updatedWorkspace = createExecutionWorkspace({
      mode: "isolated_workspace",
      runtimeServices: [createRuntimeService({ url: serviceUrl, status: "stopped", stoppedAt: new Date("2026-04-06T12:06:00.000Z") })],
    });
    mockExecutionWorkspacesApi.controlRuntimeCommands.mockResolvedValue({
      workspace: updatedWorkspace,
      operation: {},
    });
    const root = renderProperties(container, {
      issue: createIssue({
        projectId: "project-1",
        projectWorkspaceId: "workspace-main",
        executionWorkspaceId: "workspace-1",
        currentExecutionWorkspace: createExecutionWorkspace({
          mode: "isolated_workspace",
          config: {
            environmentId: null,
            provisionCommand: null,
            teardownCommand: null,
            cleanupCommand: null,
            desiredState: null,
            workspaceRuntime: {
              services: [{ name: "web", command: "pnpm dev" }],
            },
          },
          runtimeServices: [createRuntimeService({ url: serviceUrl, status: "running", configIndex: 0 })],
        }),
      }),
      childIssues: [],
      onUpdate: vi.fn(),
    });
    await flush();

    const serviceLink = container.querySelector(`a[href="${serviceUrl}"]`);
    expect(serviceLink).not.toBeNull();
    expect(serviceLink?.className).toContain("sm:self-start");
    expect(serviceLink?.className).not.toContain("sm:self-end");
    expect((container.textContent ?? "").indexOf("Workspace")).toBeLessThan(
      (container.textContent ?? "").indexOf("Service"),
    );
    const stopButton = container.querySelector<HTMLButtonElement>('button[aria-label="Stop"]');
    expect(stopButton).not.toBeUndefined();
    expect(stopButton?.getAttribute("data-size")).toBe("icon-xs");
    expect(stopButton?.getAttribute("data-variant")).toBe("outline");

    await act(async () => {
      stopButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockExecutionWorkspacesApi.controlRuntimeCommands).toHaveBeenCalledWith(
      "workspace-1",
      "stop",
      expect.objectContaining({ action: "stop", runtimeServiceId: "service-1" }),
    );
    expect(container.textContent).toContain("Workspace service stopped.");

    act(() => root.unmount());
  });

  it("shows full date and time for issue metadata timestamps", async () => {
    const root = renderProperties(container, {
      issue: createIssue({
        createdAt: new Date(2026, 3, 6, 12, 34),
        startedAt: new Date(2026, 3, 6, 12, 35),
        completedAt: new Date(2026, 3, 6, 12, 36),
      }),
      childIssues: [],
      onUpdate: vi.fn(),
    });
    await flush();

    expect(container.textContent).toMatch(/CreatedApr 6, 2026, \d{1,2}:34 (AM|PM)/);
    expect(container.textContent).toMatch(/StartedApr 6, 2026, \d{1,2}:35 (AM|PM)/);
    expect(container.textContent).toMatch(/CompletedApr 6, 2026, \d{1,2}:36 (AM|PM)/);

    for (const label of ["Started", "Completed", "Created"]) {
      const labelNode = container.querySelector(`[data-property-label="${label}"]`);
      const value = labelNode?.parentElement?.querySelector<HTMLElement>('[data-property-value="true"] > span');
      expect(value?.classList).toContain("min-w-0");
      expect(value?.classList).toContain("truncate");
      expect(value?.classList).toContain("whitespace-nowrap");
      expect(value?.title).toBe(value?.textContent);
    }

    act(() => root.unmount());
  });

  it.each([false, true])("shows the workspace detail link only when its destination is enabled: %s", async enabled => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: enabled });
    mockProjectsApi.list.mockResolvedValue([createProject()]);
    const root = renderProperties(container, {
      issue: createIssue({
        projectId: "project-1",
        projectWorkspaceId: "workspace-main",
        executionWorkspaceId: "workspace-1",
        currentExecutionWorkspace: createExecutionWorkspace({
          mode: "isolated_workspace",
        }),
      }),
      childIssues: [],
      onUpdate: vi.fn(),
    });
    await flush();
    await flush();

    expect(container.textContent).not.toContain("View workspace tasks");
    await vi.waitFor(() => {
      const workspaceLink = Array.from(container.querySelectorAll("a")).find(link => link.textContent?.trim() === "View workspace");
      if (enabled) expect(workspaceLink?.getAttribute("href")).toBe("/execution-workspaces/workspace-1");
      else expect(workspaceLink).toBeUndefined();
    });

    act(() => root.unmount());
  });

  it("copies branch and folder values with visible feedback", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const root = renderProperties(container, {
      issue: createIssue({
        executionWorkspaceId: "workspace-1",
        currentExecutionWorkspace: createExecutionWorkspace({
          branchName: "pap-1-workspace",
          cwd: "/tmp/paperclip/PAP-1",
        }),
      }),
      childIssues: [],
      onUpdate: vi.fn(),
    });
    await flush();
    await flush();

    const branchCopyButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy pap-1-workspace to clipboard"]',
    );
    const folderCopyButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy /tmp/paperclip/PAP-1 to clipboard"]',
    );
    expect(branchCopyButton).not.toBeNull();
    expect(folderCopyButton?.querySelector('[data-middle-truncate="true"]')?.textContent)
      .toBe("/tmp/paperclip/PAP-1");
    expect(folderCopyButton?.title).toBe("/tmp/paperclip/PAP-1");

    await act(async () => {
      branchCopyButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(writeText).toHaveBeenCalledWith("pap-1-workspace");
    expect(container.textContent).toContain("Copied");

    act(() => root.unmount());
  });

  it("does not show a service link for the main shared workspace", async () => {
    mockProjectsApi.list.mockResolvedValue([createProject()]);
    const serviceUrl = "http://127.0.0.1:62475";
    const root = renderProperties(container, {
      issue: createIssue({
        projectId: "project-1",
        projectWorkspaceId: "workspace-main",
        executionWorkspaceId: "workspace-1",
        currentExecutionWorkspace: createExecutionWorkspace({
          mode: "shared_workspace",
          projectWorkspaceId: "workspace-main",
          runtimeServices: [createRuntimeService({ url: serviceUrl, status: "running" })],
        }),
      }),
      childIssues: [],
      onUpdate: vi.fn(),
    });
    await flush();

    expect(container.querySelector(`a[href="${serviceUrl}"]`)).toBeNull();
    expect(container.textContent).not.toContain("View workspace tasks");
    expect(Array.from(container.querySelectorAll("a")).some(
      (link) => link.textContent?.trim() === "View workspace",
    )).toBe(false);

    act(() => root.unmount());
  });

  it("separates referenced tasks from tasks that mention this task", async () => {
    const root = renderProperties(container, {
      issue: createIssue({
        relatedWork: {
          outbound: [
            {
              issue: createRelation("issue-22", "PAP-22", "Related task"),
              mentionCount: 1,
              sources: [{ kind: "description", sourceRecordId: null, label: "description", matchedText: "PAP-22" }],
            },
          ],
          inbound: [
            {
              issue: createRelation("issue-23", "PAP-23", "Mentions this task", "in_progress"),
              mentionCount: 1,
              sources: [{ kind: "description", sourceRecordId: null, label: "description", matchedText: "PAP-1" }],
            },
          ],
        },
      }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    expect(container.textContent).not.toContain("Task ids");
    expect(container.textContent).not.toContain("Related tasks");
    const referencesTab = Array.from(container.querySelectorAll<HTMLButtonElement>('button[role="tab"]'))
      .find((button) => button.textContent === "References");
    await act(async () => {
      referencesTab!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    });
    expect(container.textContent).toContain("Referenced");
    expect(container.textContent).toContain("PAP-22");
    expect(container.textContent).toContain("Mentioned in");
    expect(container.textContent).toContain("PAP-23");

    act(() => root.unmount());
  });

  it("hides related task references already covered by blockers, blocking, and sub-issues", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableTaskWatchdogs: false,
      enableClassicTaskInterface: true,
    });
    const root = renderProperties(container, {
      issue: createIssue({
        blockedBy: [
          createRelation("issue-22", "PAP-22", "Blocker"),
        ],
        blocks: [
          createRelation("issue-33", "PAP-33", "Blocked issue"),
        ],
        relatedWork: {
          outbound: [
            {
              issue: createRelation("issue-22", "PAP-22", "Blocker"),
              mentionCount: 1,
              sources: [{ kind: "description", sourceRecordId: null, label: "description", matchedText: "PAP-22" }],
            },
            {
              issue: createRelation("issue-33", "PAP-33", "Blocked issue"),
              mentionCount: 1,
              sources: [{ kind: "description", sourceRecordId: null, label: "description", matchedText: "PAP-33" }],
            },
            {
              issue: createRelation("child-44", "PAP-44", "Child issue"),
              mentionCount: 1,
              sources: [{ kind: "description", sourceRecordId: null, label: "description", matchedText: "PAP-44" }],
            },
          ],
          inbound: [],
        },
      }),
      childIssues: [
        createIssue({
          id: "child-44",
          identifier: "PAP-44",
          title: "Child issue",
        }),
      ],
      onUpdate: vi.fn(),
    });
    await flush();

    await waitForAssertion(() => {
      expect(container.textContent).not.toContain("Referenced");
    });

    act(() => root.unmount());
  });

  it("opens the label picker from its relationship value without a redundant add button", async () => {
    const root = renderProperties(container, {
      issue: createIssue({
        labels: [{ id: "label-1", companyId: "company-1", name: "Bug", color: "#ef4444", createdAt: new Date("2026-04-06T12:00:00.000Z"), updatedAt: new Date("2026-04-06T12:00:00.000Z") }],
        labelIds: ["label-1"],
      }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    expect(container.querySelector('button[aria-label="Add label"]')).toBeNull();
    expect(container.querySelector('input[placeholder="Search labels..."]')).toBeNull();
    const labelsTrigger = findRowTrigger(container, "Labels");
    expect(labelsTrigger?.textContent).toContain("Bug");
    const labelChip = labelsTrigger?.querySelector<HTMLElement>('[title="Bug"]');
    expect(labelChip?.classList).toContain("border-0");
    expect(labelChip?.style.borderColor).toBe("");
    expect(labelChip?.style.color).not.toBe("");

    await act(async () => {
      labelsTrigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(container.querySelector('input[placeholder="Search labels..."]')).not.toBeNull();
    expect(container.querySelector('button[title="Delete Bug"]')).toBeNull();

    act(() => root.unmount());
  });

  it("shows selected labels from labelIds even before the issue labels relation refreshes", async () => {
    mockIssuesApi.listLabels.mockResolvedValue([createLabel()]);

    const root = renderProperties(container, {
      issue: createIssue({
        labels: [],
        labelIds: ["label-1"],
      }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();
    await flush();

    expect(container.textContent).toContain("Bug");
    expect(container.textContent).not.toContain("No labels");

    act(() => root.unmount());
  });
});
