// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ExecutionWorkspace,
  Issue,
  IssueExecutionPolicy,
  IssueExecutionState,
  IssueLabel,
  Project,
  WorkspaceRuntimeService,
} from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IssueProperties } from "./IssueProperties";

import { queryKeys } from "../lib/queryKeys";

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

function createExecutionPolicy(overrides: Partial<IssueExecutionPolicy> = {}): IssueExecutionPolicy {
  return {
    mode: "normal",
    commentRequired: true,
    stages: [],
    ...overrides,
  };
}

function createExecutionState(overrides: Partial<IssueExecutionState> = {}): IssueExecutionState {
  return {
    status: "changes_requested",
    currentStageId: "stage-1",
    currentStageIndex: 0,
    currentStageType: "review",
    currentParticipant: { type: "agent", agentId: "agent-1", userId: null },
    returnAssignee: { type: "agent", agentId: "agent-2", userId: null },
    reviewRequest: null,
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: "changes_requested",
    ...overrides,
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

function seniorProductEngineer() {
  return {
    id: "agent-1",
    name: "Senior Product Engineer",
    role: "engineer",
    title: null,
    status: "active",
    adapterType: "codex_local",
    icon: null,
  };
}

function reviewPolicyStages(): Pick<IssueExecutionPolicy, "stages"> {
  return {
    stages: [
      {
        id: "00000000-0000-4000-8000-000000000010",
        type: "review",
        approvalsNeeded: 1,
        participants: [{ id: "00000000-0000-4000-8000-000000000012", type: "agent", agentId: "00000000-0000-4000-8000-000000000013", userId: null }],
      },
    ],
  };
}

describe("IssueProperties execution policy, watchdogs and workspace picker", () => {
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

  it("hides model options when the issue uses the responsible default", async () => {
    mockAgentsApi.list.mockResolvedValue([
      seniorProductEngineer(),
    ]);

    const root = renderProperties(container, {
      issue: createIssue({
        assigneeAgentId: "agent-1",
        assigneeAdapterOverrides: null,
      }),
      childIssues: [],
      onUpdate: vi.fn(),
    });
    await flush();

    expect(container.textContent).not.toContain("Model lane");
    expect(container.textContent).not.toContain("Codex options");

    act(() => root.unmount());
  });

  it.each([
    { name: "Copilot", acpxAgent: "copilot", provider: "github", method: "api_key", model: "gpt-5.6-luna", label: "Copilot Luna" },
    { name: "Antigravity", acpxAgent: "antigravity", provider: "google", method: "subscription", model: "gemini-exact", label: "Personal Gemini" },
  ] as const)("discovers $name overrides with the assignee connection and environment", async ({ acpxAgent, provider, method, model, label }) => {
    const binding = { provider, method, mode: "shared", connectionId: "11111111-1111-4111-8111-111111111111", grantId: "33333333-3333-4333-8333-333333333333" };
    mockAgentsApi.list.mockResolvedValue([{ id: "agent-1", name: acpxAgent, role: "engineer", status: "active",
      adapterType: "paperclip_runner", defaultEnvironmentId: "daytona-1",
      adapterConfig: { provider: "acpx", acpxAgent, model },
      runtimeConfig: { aiConnection: binding } }]);
    mockAgentsApi.adapterModels.mockResolvedValue([{ id: model, label }]);
    const { root, queryClient } = renderPropertiesWithQueryClient(container, {
      issue: createIssue({ assigneeAgentId: "agent-1", assigneeAdapterOverrides: { adapterConfig: { model } } }),
      childIssues: [], onUpdate: vi.fn(), inline: true,
    });
    await flush();
    await flush();
    expect(mockAgentsApi.adapterModels).not.toHaveBeenCalled();
    const modelTrigger = findRowTrigger(container, "Model");
    expect(modelTrigger).toBeDefined();
    await act(async () => modelTrigger!.click());
    await waitForAssertion(() => expect(mockAgentsApi.adapterModels).toHaveBeenCalledWith("company-1", "paperclip_runner", {
      environmentId: "daytona-1", provider: "acpx", acpxAgent, agentId: "agent-1", aiConnection: binding,
    }));
    await act(async () => { await queryClient.invalidateQueries({ type: "active" }, { cancelRefetch: false }); });
    expect(mockAgentsApi.adapterModels).toHaveBeenCalledTimes(1);
    await act(async () => modelTrigger!.click());
    await act(async () => modelTrigger!.click());
    await waitForAssertion(() => expect(mockAgentsApi.adapterModels).toHaveBeenCalledTimes(2));
    act(() => root.unmount());
  });

  it("edits existing custom assignee model options from the properties pane", async () => {
    const onUpdate = vi.fn();
    mockAgentsApi.list.mockResolvedValue([
      seniorProductEngineer(),
    ]);
    mockAgentsApi.adapterModels.mockResolvedValue([
      { id: "gpt-6-astra", label: "gpt-6-astra" },
      { id: "gpt-5.4", label: "GPT-5.4" },
    ]);

    const root = renderProperties(container, {
      issue: createIssue({
        assigneeAgentId: "agent-1",
        assigneeAdapterOverrides: {
          adapterConfig: {
            model: "gpt-5.4",
            modelReasoningEffort: "high",
          },
        },
      }),
      childIssues: [],
      onUpdate,
    });
    await flush();
    await flush();

    expect(container.textContent).toContain("Override · gpt-5.4 · high");
    expect(container.textContent).toContain("Model lane");

    // Wait for the adapter-models query to resolve so the model options render.
    let modelButton: HTMLButtonElement | undefined;
    await waitForAssertion(() => {
      modelButton = Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("gpt-6-astra"));
      expect(modelButton).not.toBeUndefined();
    });

    await act(async () => {
      modelButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onUpdate).toHaveBeenCalledWith({
      assigneeAdapterOverrides: {
        adapterConfig: {
          model: "gpt-6-astra",
          modelReasoningEffort: "high",
        },
      },
    });

    act(() => root.unmount());
  });

  it("keeps Astra-only task efforts when the task inherits the agent model", async () => {
    const onUpdate = vi.fn();
    mockAgentsApi.list.mockResolvedValue([
      {
        id: "agent-1",
        name: "Senior Product Engineer",
        role: "engineer",
        title: null,
        status: "active",
        adapterType: "codex_local",
        adapterConfig: { model: "gpt-6-astra" },
        icon: null,
      },
    ]);
    mockAgentsApi.adapterModels.mockResolvedValue([
      { id: "gpt-6-astra", label: "gpt-6-astra" },
      { id: "gpt-5.4", label: "GPT-5.4" },
    ]);

    const root = renderProperties(container, {
      issue: createIssue({
        assigneeAgentId: "agent-1",
        assigneeAdapterOverrides: {
          adapterConfig: { modelReasoningEffort: "ultra" },
        },
      }),
      childIssues: [],
      onUpdate,
    });
    await flush();
    await flush();

    expect(container.textContent).toContain("Ultra");
    expect(container.textContent).toContain("Max");
    expect(container.textContent).not.toContain("Minimal");

    const defaultModelButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Default model"));
    expect(defaultModelButton).not.toBeUndefined();
    await act(async () => {
      defaultModelButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const defaultModelOption = Array.from(document.body.querySelectorAll("button"))
      .filter((button) => button.textContent?.trim() === "Default model")
      .at(-1);
    expect(defaultModelOption).not.toBeUndefined();
    await act(async () => {
      defaultModelOption!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onUpdate).toHaveBeenCalledWith({
      assigneeAdapterOverrides: {
        adapterConfig: { modelReasoningEffort: "ultra" },
      },
    });

    act(() => root.unmount());
  });

  it("clears existing assignee adapter overrides from the properties pane", async () => {
    const onUpdate = vi.fn();
    mockAgentsApi.list.mockResolvedValue([
      seniorProductEngineer(),
    ]);

    const root = renderProperties(container, {
      issue: createIssue({
        assigneeAgentId: "agent-1",
        assigneeAdapterOverrides: {
          adapterConfig: {
            model: "gpt-5.4",
          },
        },
      }),
      childIssues: [],
      onUpdate,
    });
    await flush();

    // The trailing "clear" X was removed (ux-spec: one trailing-action style).
    // Clearing now happens by selecting the "Primary" model lane inside the picker.
    const optionsTrigger = findRowTrigger(container, "Model");
    expect(optionsTrigger).toBeTruthy();
    await act(async () => {
      optionsTrigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const primaryLane = Array.from(container.querySelectorAll('button[role="radio"]'))
      .find((button) => button.textContent?.trim() === "Primary");
    expect(primaryLane).not.toBeUndefined();

    await act(async () => {
      primaryLane!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onUpdate).toHaveBeenCalledWith({ assigneeAdapterOverrides: null });

    act(() => root.unmount());
  });

  it("shows a checkmark on selected labels in the picker", async () => {
    mockIssuesApi.listLabels.mockResolvedValue([
      createLabel(),
      createLabel({ id: "label-2", name: "Feature", color: "#22c55e" }),
    ]);

    const root = renderProperties(container, {
      issue: createIssue({
        labels: [createLabel()],
        labelIds: ["label-1"],
      }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    const labelsTrigger = findRowTrigger(container, "Labels");
    expect(labelsTrigger?.textContent).toContain("Bug");
    await act(async () => {
      labelsTrigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const labelButtons = Array.from(container.querySelectorAll("button"))
      .filter((button) => button.textContent?.includes("Bug") || button.textContent?.includes("Feature"));
    const bugButton = labelButtons.find((button) => button.textContent?.includes("Bug") && button.querySelector("svg"));
    const featureButton = labelButtons.find((button) => button.textContent?.includes("Feature"));
    expect(bugButton).not.toBeUndefined();
    expect(featureButton?.querySelector("svg")).toBeNull();

    act(() => root.unmount());
  });

  it("allows setting and clearing a parent issue from the properties pane", async () => {
    const onUpdate = vi.fn();
    mockIssuesApi.list.mockResolvedValue([
      createIssue({ id: "issue-2", identifier: "PAP-2", title: "Candidate parent", status: "in_progress" }),
    ]);

    const root = renderProperties(container, {
      issue: createIssue(),
      childIssues: [],
      onUpdate,
      inline: true,
    });
    await flush();

    // Empty parent now uses the uniform muted "None" empty state (ux-spec §6).
    const parentTrigger = findRowTrigger(container, "Parent");
    expect(parentTrigger?.textContent).toContain("None");

    await act(async () => {
      parentTrigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const candidateButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("PAP-2 Candidate parent"));
    expect(candidateButton).not.toBeUndefined();

    await act(async () => {
      candidateButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onUpdate).toHaveBeenCalledWith({ parentId: "issue-2" });

    onUpdate.mockClear();
    const rerenderedIssue = createIssue({
      parentId: "issue-2",
      ancestors: [
        {
          id: "issue-2",
          identifier: "PAP-2",
          title: "Candidate parent",
          description: null,
          status: "in_progress",
          priority: "medium",
          assigneeAgentId: null,
          assigneeUserId: null,
          projectId: null,
          goalId: null,
          project: null,
          goal: null,
        },
      ],
    });

    act(() => root.unmount());

    const rerenderedRoot = renderProperties(container, {
      issue: rerenderedIssue,
      childIssues: [],
      onUpdate,
      inline: true,
    });
    await flush();

    const selectedParentTrigger = findRowTrigger(container, "Parent");
    expect(selectedParentTrigger).not.toBeUndefined();
    const parentLink = container.querySelector('a[href="/issues/PAP-2"]');
    expect(parentLink).not.toBeNull();
    expect(selectedParentTrigger!.contains(parentLink)).toBe(false);

    await act(async () => {
      selectedParentTrigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const clearParentButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("No parent"));
    expect(clearParentButton).not.toBeUndefined();

    await act(async () => {
      clearParentButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onUpdate).toHaveBeenCalledWith({ parentId: null });

    act(() => rerenderedRoot.unmount());
  });

  it("searches the server for parent candidates so a lower-priority match past the default page stays selectable", async () => {
    const onUpdate = vi.fn();
    // The default list is priority-first and caps at 500 rows, so a low-priority
    // match past that cap never enters the client list. Model that gap: the default
    // page returns only a high-priority candidate, and the server search with `q`
    // returns the low-priority match that the default page hides.
    const defaultPageCandidate = createIssue({
      id: "issue-2",
      identifier: "PAP-2",
      title: "High priority candidate",
      status: "in_progress",
      priority: "high",
    });
    const lowPriorityMatch = createIssue({
      id: "issue-900",
      identifier: "PAP-900",
      title: "Low priority needle",
      status: "todo",
      priority: "low",
    });
    mockIssuesApi.list.mockImplementation((_companyId: string, filters?: { q?: string; limit?: number }) => {
      if (filters?.q === "needle") return Promise.resolve([lowPriorityMatch]);
      return Promise.resolve([defaultPageCandidate]);
    });

    const root = renderProperties(container, {
      issue: createIssue(),
      childIssues: [],
      onUpdate,
      inline: true,
    });
    await flush();

    const parentTrigger = findRowTrigger(container, "Parent");
    expect(parentTrigger).not.toBeUndefined();
    await act(async () => {
      parentTrigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    // With an empty search the picker shows the default page. The low-priority match is absent.
    await waitForAssertion(() => {
      expect(container.textContent).toContain("PAP-2 High priority candidate");
    });
    expect(container.textContent).not.toContain("PAP-900 Low priority needle");

    const searchInput = container.querySelector('input[placeholder="Search tasks..."]') as HTMLInputElement | null;
    expect(searchInput).not.toBeNull();

    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      nativeSetter?.call(searchInput, "needle");
      searchInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // The typed text re-queries the server with `q`, and the low-priority match now appears.
    await waitForAssertion(() => {
      expect(mockIssuesApi.list).toHaveBeenCalledWith("company-1", { q: "needle", limit: 50 });
      expect(container.textContent).toContain("PAP-900 Low priority needle");
      expect(container.textContent).not.toContain("PAP-2 High priority candidate");
    });

    const candidateButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("PAP-900 Low priority needle"));
    expect(candidateButton).not.toBeUndefined();

    await act(async () => {
      candidateButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onUpdate).toHaveBeenCalledWith({ parentId: "issue-900" });

    act(() => root.unmount());
  });

  it("renders reviewer and approver controls for a monitor-only execution policy", async () => {
    const policy = {
      monitor: {
        nextCheckAt: "2026-10-08T16:00:00.000Z",
        notes: "Check pull request",
        scheduledBy: "assignee",
        kind: "external_service",
        serviceName: "github-pr",
      },
    } as IssueExecutionPolicy;
    const root = renderProperties(container, {
      issue: createIssue({ executionPolicy: policy }),
      childIssues: [],
      onUpdate: vi.fn(),
    });
    await flush();

    expect(findRowTrigger(container, "Reviewers")?.textContent).toContain("None");
    expect(findRowTrigger(container, "Approvers")?.textContent).toContain("None");
    expect(container.querySelector('[data-testid="monitor-row-trigger"]')).not.toBeNull();

    act(() => root.unmount());
  });

  it("shows a run review action after reviewers are configured and starts execution explicitly when clicked", async () => {
    const onUpdate = vi.fn();
    const root = renderProperties(container, {
      issue: createIssue({
        executionPolicy: createExecutionPolicy(reviewPolicyStages()),
      }),
      childIssues: [],
      onUpdate,
    });
    await flush();

    const runReviewButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Run review now"));
    expect(runReviewButton).not.toBeUndefined();

    await act(async () => {
      runReviewButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onUpdate).toHaveBeenCalledWith({ status: "in_review" });

    act(() => root.unmount());
  });

  it("shows a run approval action when approval is the next runnable stage", async () => {
    const root = renderProperties(container, {
      issue: createIssue({
        executionPolicy: createExecutionPolicy({
          stages: [
            {
              id: "00000000-0000-4000-8000-000000000011",
              type: "approval",
              approvalsNeeded: 1,
              participants: [{ id: "00000000-0000-4000-8000-000000000014", type: "user", agentId: null, userId: "user-1" }],
            },
          ],
        }),
      }),
      childIssues: [],
      onUpdate: vi.fn(),
    });
    await flush();

    expect(container.textContent).toContain("Run approval now");
    expect(container.textContent).not.toContain("Run review now");

    act(() => root.unmount());
  });

  it("keeps the run review action available after changes are requested", async () => {
    const root = renderProperties(container, {
      issue: createIssue({
        status: "in_progress",
        executionPolicy: createExecutionPolicy(reviewPolicyStages()),
        executionState: createExecutionState(),
      }),
      childIssues: [],
      onUpdate: vi.fn(),
    });
    await flush();

    expect(container.textContent).toContain("Run review now");

    act(() => root.unmount());
  });

  it("hides the run action while an execution stage is already pending", async () => {
    const root = renderProperties(container, {
      issue: createIssue({
        status: "in_review",
        executionPolicy: createExecutionPolicy(reviewPolicyStages()),
        executionState: createExecutionState({
          status: "pending",
          currentStageType: "review",
          lastDecisionOutcome: null,
        }),
      }),
      childIssues: [],
      onUpdate: vi.fn(),
    });
    await flush();

    expect(container.textContent).not.toContain("Run review now");
    expect(container.textContent).not.toContain("Run approval now");

    act(() => root.unmount());
  });

  const statusIcon = () => container.querySelector('[data-testid="status-icon"]');

  it("offers Approve and Request changes to the pending user participant", async () => {
    const root = renderProperties(container, {
      issue: createIssue({
        status: "in_review",
        executionPolicy: createExecutionPolicy({
          stages: [{
            id: "00000000-0000-4000-8000-000000000010",
            type: "review",
            approvalsNeeded: 1,
            participants: [{
              id: "00000000-0000-4000-8000-000000000012",
              type: "user",
              agentId: null,
              userId: "user-1",
            }],
          }],
        }),
        executionState: createExecutionState({
          status: "pending",
          currentStageType: "review",
          currentParticipant: {
            type: "user",
            agentId: null,
            userId: "user-1",
          },
        }),
      }),
      childIssues: [],
      onUpdate: vi.fn(),
    });
    await flush();

    await waitForAssertion(() => {
      expect(statusIcon()?.getAttribute("data-commentable")).toBe("true");
      expect(statusIcon()?.getAttribute("data-review-stage")).toBe("review");
    });

    act(() => root.unmount());
  });

  it("does not offer stage verdicts to a board user who is not the participant", async () => {
    const root = renderProperties(container, {
      issue: createIssue({
        status: "in_review",
        executionPolicy: createExecutionPolicy({
          stages: [{
            id: "00000000-0000-4000-8000-000000000010",
            type: "review",
            approvalsNeeded: 1,
            participants: [{
              id: "00000000-0000-4000-8000-000000000015",
              type: "user",
              agentId: null,
              userId: "user-2",
            }],
          }],
        }),
        executionState: createExecutionState({
          status: "pending",
          currentStageType: "review",
          currentParticipant: {
            type: "user",
            agentId: null,
            userId: "user-2",
          },
        }),
      }),
      childIssues: [],
      onUpdate: vi.fn(),
    });
    await flush();

    await waitForAssertion(() => {
      expect(statusIcon()?.getAttribute("data-commentable")).toBe("true");
      expect(statusIcon()?.getAttribute("data-review-stage")).toBeNull();
    });

    act(() => root.unmount());
  });

  it("renders monitor controls and clears an existing monitor", async () => {
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(new Date("2026-04-11T10:00:00.000Z").getTime());
    const onUpdate = vi.fn();
    const root = renderProperties(container, {
      issue: createIssue({
        status: "in_progress",
        assigneeAgentId: "agent-1",
        executionPolicy: createExecutionPolicy({
          monitor: {
            nextCheckAt: "2026-04-11T12:30:00.000Z",
            notes: "Check deployment",
            scheduledBy: "board",
          },
        }),
        executionState: createExecutionState({
          status: "idle",
          currentStageId: null,
          currentStageIndex: null,
          currentStageType: null,
          currentParticipant: null,
          returnAssignee: null,
          lastDecisionOutcome: null,
          monitor: {
            status: "scheduled",
            nextCheckAt: "2026-04-11T12:30:00.000Z",
            lastTriggeredAt: null,
            attemptCount: 0,
            notes: "Check deployment",
            scheduledBy: "board",
            clearedAt: null,
            clearReason: null,
          },
        }),
      }),
      childIssues: [],
      onUpdate,
      inline: true,
    });
    await flush();

    expect(container.textContent).toContain("Monitor");
    expect(container.textContent).toContain("In 2h 30m");
    expect(container.querySelector('input[type="datetime-local"]')).toBeNull();
    expect(container.querySelector('input[placeholder="What should the agent re-check?"]')).toBeNull();

    const monitorTrigger = container.querySelector('[data-testid="monitor-row-trigger"]')?.closest("button");
    expect(monitorTrigger).not.toBeUndefined();

    await act(async () => {
      monitorTrigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const inputs = Array.from(container.querySelectorAll("input"));
    const datetimeInput = inputs.find((input) => input.getAttribute("type") === "datetime-local");
    const textInput = inputs.find((input) => input.getAttribute("placeholder") === "What should the agent re-check?");
    const clearButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Clear"));

    expect(datetimeInput).toBeTruthy();
    expect(textInput).toBeTruthy();
    expect(clearButton).toBeTruthy();
    expect(datetimeInput!.value).toBeTruthy();
    expect(textInput!.value).toBe("Check deployment");

    act(() => {
      clearButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onUpdate).toHaveBeenCalledWith({
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [],
      },
    });

    act(() => root.unmount());
    dateNowSpy.mockRestore();
  });

  it.each([true, false])("clears a monitor with omitted stages while preserving independent limits (authorization: %s)", async (withAuthorization) => {
    const onUpdate = vi.fn();
    const executionPolicy = {
      ...(withAuthorization ? { authorizationPolicy: { trustPreset: "standard" } } : {}),
      maxReviewRounds: 4,
      monitor: { nextCheckAt: "2099-01-01T12:00:00.000Z", notes: "Check service", scheduledBy: "board" },
    } as IssueExecutionPolicy;
    const before = structuredClone(executionPolicy);
    const root = renderProperties(container, {
      issue: createIssue({ executionPolicy }), childIssues: [], onUpdate, inline: true,
    });
    await flush();

    expect(container.textContent).toContain("Reviewers");
    expect(container.textContent).not.toContain("Execution policy unavailable");
    const monitorTrigger = container.querySelector('[data-testid="monitor-row-trigger"]')?.closest("button");
    expect(monitorTrigger).toBeTruthy();
    await act(async () => { monitorTrigger!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const clearButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Clear");
    expect(clearButton).toBeTruthy();
    await act(async () => { clearButton!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    expect(onUpdate).toHaveBeenCalledWith({ executionPolicy: {
      mode: "normal", commentRequired: true, stages: [],
      ...(withAuthorization ? { authorizationPolicy: before.authorizationPolicy } : {}), maxReviewRounds: 4,
    } });
    expect(executionPolicy).toEqual(before);
    act(() => root.unmount());
  });

  it.each([
    { stages: {} },
    { stages: [null] },
    { stages: [{ type: "review", participants: {} }] },
    { monitor: { nextCheckAt: {}, notes: {} } },
  ])("keeps malformed policies unavailable without exposing destructive edits: %j", async (executionPolicy) => {
    const onUpdate = vi.fn();
    const root = renderProperties(container, {
      issue: createIssue({ executionPolicy: executionPolicy as unknown as IssueExecutionPolicy }),
      childIssues: [], onUpdate, inline: true,
    });
    await flush();

    expect(container.textContent).toContain("Execution policy unavailable. Refresh to try again.");
    expect(container.textContent).toContain("Assignee");
    expect(container.textContent).not.toContain("No reviewers");
    expect(container.textContent).not.toContain("No approvers");
    expect(container.textContent).not.toContain("Run review now");
    expect(container.querySelector('[data-testid="monitor-row-trigger"]')).toBeNull();
    expect(container.querySelector('input[type="datetime-local"]')).toBeNull();
    expect(onUpdate).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("renders scheduled, retrying, due, overdue, cleared, and empty monitor row states", async () => {
    // Anchored to a fixed *local* time, not a fixed UTC instant. The row renders
    // these in the machine's timezone and labels them "Today" only while they
    // share a local calendar day with `now`. Pinned to UTC, the pair straddles
    // local midnight from UTC+8 to UTC+9:30 — the label becomes a date and every
    // assertion below fails for a reason that has nothing to do with row states.
    // Anchoring locally keeps them on one day everywhere, which also makes the
    // rendered clock identical in every timezone, so the times below can stay
    // exact rather than being relaxed to a pattern.
    const NOW = new Date(2026, 6, 17, 13, 56, 0, 0);
    const at = (minutesFromNow: number) =>
      new Date(NOW.getTime() + minutesFromNow * 60_000).toISOString();
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(NOW.getTime());
    const baseMonitorState = {
      status: "scheduled" as const,
      nextCheckAt: at(132),
      lastTriggeredAt: null,
      attemptCount: 1,
      notes: "Verify deployment",
      scheduledBy: "board" as const,
      clearedAt: null,
      clearReason: null,
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createRoot(container);
    const monitorRowText = () => container.querySelector('[data-testid="monitor-row-trigger"]')?.textContent;
    const renderMonitor = (issue: Issue) => {
      act(() => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <IssueProperties issue={issue} childIssues={[]} onUpdate={vi.fn()} inline />
          </QueryClientProvider>,
        );
      });
    };

    renderMonitor(createIssue({
      status: "in_progress",
      executionPolicy: createExecutionPolicy({ monitor: { ...baseMonitorState, serviceName: "vercel-deploy" } }),
      executionState: createExecutionState({ monitor: baseMonitorState }),
      monitorAttemptCount: 1,
    }));
    await flush();
    expect(monitorRowText()).toContain("In 2h 12m");
    // The hour is rendered in the machine's timezone, so it is not pinned here:
    // this instant is 4:08 PM at UTC and 9:08 AM at UTC-7. What the row states
    // are actually about — the countdown and the attempt suffix — is asserted
    // exactly, and the countdown above is timezone-independent already.
    expect(monitorRowText()).toContain("Today, 4:08 PM · Attempt 1");

    renderMonitor(createIssue({
      status: "in_progress",
      executionPolicy: createExecutionPolicy({ monitor: { ...baseMonitorState, nextCheckAt: at(252) } }),
      executionState: createExecutionState({ monitor: { ...baseMonitorState, nextCheckAt: at(132) } }),
      monitorNextCheckAt: new Date(at(192)),
    }));
    await flush();
    expect(monitorRowText()).toContain("In 2h 12m");
    expect(monitorRowText()).toContain("Today, 4:08 PM");

    renderMonitor(createIssue({
      status: "in_progress",
      executionPolicy: createExecutionPolicy({ monitor: { ...baseMonitorState, serviceName: "vercel-deploy" } }),
      executionState: createExecutionState({ monitor: { ...baseMonitorState, attemptCount: 3 } }),
      monitorAttemptCount: 3,
    }));
    await flush();
    expect(monitorRowText()).toContain("Attempt 3");

    renderMonitor(createIssue({
      status: "in_progress",
      executionPolicy: createExecutionPolicy({ monitor: { ...baseMonitorState, nextCheckAt: at(0) } }),
      executionState: createExecutionState({ monitor: { ...baseMonitorState, nextCheckAt: at(0) } }),
    }));
    await flush();
    expect(monitorRowText()).toContain("Due now");
    expect(monitorRowText()).toContain("checking momentarily…");

    renderMonitor(createIssue({
      status: "in_progress",
      executionPolicy: createExecutionPolicy({ monitor: { ...baseMonitorState, nextCheckAt: at(-18) } }),
      executionState: createExecutionState({ monitor: { ...baseMonitorState, nextCheckAt: at(-18) } }),
    }));
    await flush();
    expect(monitorRowText()).toContain("Overdue by 18m");
    expect(monitorRowText()).toContain("Today, 1:38 PM · fires on next tick");

    renderMonitor(createIssue({
      status: "blocked",
      executionPolicy: createExecutionPolicy({ monitor: { ...baseMonitorState, nextCheckAt: at(-18) } }),
      executionState: createExecutionState({ monitor: { ...baseMonitorState, nextCheckAt: at(-18) } }),
    }));
    await flush();
    expect(monitorRowText()).toContain("Automatic checks paused");
    expect(monitorRowText()).toContain("Check now to request a manual check");
    expect(monitorRowText()).not.toMatch(/overdue|next tick/i);

    renderMonitor(createIssue({
      status: "in_progress",
      executionPolicy: createExecutionPolicy(),
      executionState: createExecutionState({ monitor: {
        ...baseMonitorState,
        status: "cleared",
        nextCheckAt: null,
        lastTriggeredAt: at(-120),
        attemptCount: 2,
        clearedAt: at(-116),
        clearReason: "manual",
      } }),
      monitorAttemptCount: 2,
      monitorLastTriggeredAt: new Date(at(-120)),
    }));
    await flush();
    expect(monitorRowText()).toContain("Cleared");
    expect(monitorRowText()).toContain("last checked 2h ago · after attempt 2");

    renderMonitor(createIssue());
    await flush();
    expect(monitorRowText()).toContain("None");

    act(() => root.unmount());
    dateNowSpy.mockRestore();
  });

  const watchdogAgent = {
    id: "agent-1",
    name: "ClaudeCoder",
    role: "",
    title: null,
    icon: null,
    status: "active",
    orgChainHealth: { status: "ok" },
  } as unknown as Parameters<typeof mockAgentsApi.list.mockResolvedValue>[0][number];

  function createWatchdogSummary(overrides: Record<string, unknown> = {}) {
    return {
      id: "watchdog-1",
      companyId: "company-1",
      issueId: "issue-1",
      watchdogAgentId: "agent-1",
      instructions: "Keep the tree moving.",
      status: "active",
      watchdogIssueId: null,
      lastObservedFingerprint: null,
      lastReviewedFingerprint: null,
      lastTriggeredAt: null,
      lastCompletedAt: null,
      triggerCount: 0,
      createdAt: new Date("2026-04-06T12:00:00.000Z"),
      updatedAt: new Date("2026-04-06T12:00:00.000Z"),
      ...overrides,
    } as unknown as NonNullable<Issue["watchdog"]>;
  }

  it("shows the empty watchdog state and saves a new watchdog via the API", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
    });
    mockAgentsApi.list.mockResolvedValue([watchdogAgent]);
    const onUpdate = vi.fn();
    const root = renderProperties(container, {
      issue: createIssue({ watchdog: null }),
      childIssues: [],
      onUpdate,
      inline: true,
    });
    await flush();

    let trigger: HTMLButtonElement | undefined;
    await waitForAssertion(() => {
      expect(container.textContent).toContain("Watchdog");
      trigger = findRowTrigger(container, "Watchdog");
      expect(trigger).toBeTruthy();
    });

    await act(async () => {
      trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    // Choose the agent through the inline selector, then save.
    let agentOption: HTMLElement | undefined;
    await waitForAssertion(() => {
      agentOption = Array.from(container.querySelectorAll("button, [role='option']"))
        .find((node) => node.textContent?.includes("ClaudeCoder")) as HTMLElement | undefined;
      expect(agentOption).toBeTruthy();
    });
    // Open the selector if the option is not yet visible, then click it.
    await act(async () => {
      agentOption!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const instructions = Array.from(container.querySelectorAll("textarea"))
      .find((node) => node.getAttribute("placeholder")?.includes("watchdog"));
    expect(instructions).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(instructions!, "Watch the deploy");
      instructions!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();

    const saveButton = Array.from(container.querySelectorAll("button"))
      .find((button) => /Set watchdog|Update/.test(button.textContent ?? "") && button.closest("[class*='space-y']"));
    const finalSave = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Set watchdog" && button !== trigger) ?? saveButton;
    expect(finalSave).toBeTruthy();
    await act(async () => {
      finalSave!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockIssuesApi.upsertWatchdog).toHaveBeenCalledWith(
      "issue-1",
      expect.objectContaining({ agentId: "agent-1" }),
    );

    act(() => root.unmount());
  });

  it("updates cached issue detail when saving a watchdog", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
    });
    mockAgentsApi.list.mockResolvedValue([watchdogAgent]);
    const savedWatchdog = createWatchdogSummary({
      instructions: "Watch the deploy",
    });
    mockIssuesApi.upsertWatchdog.mockResolvedValueOnce(savedWatchdog);
    const issue = createIssue({ watchdog: null });
    const { root, queryClient } = renderPropertiesWithQueryClient(container, {
      issue,
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    queryClient.setQueryData(queryKeys.issues.detail(issue.id), issue);
    await flush();

    let trigger: HTMLButtonElement | undefined;
    await waitForAssertion(() => {
      trigger = findRowTrigger(container, "Watchdog");
      expect(trigger).toBeTruthy();
    });

    await act(async () => {
      trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    let agentOption: HTMLElement | undefined;
    await waitForAssertion(() => {
      agentOption = Array.from(container.querySelectorAll("button, [role='option']"))
        .find((node) => node.textContent?.includes("ClaudeCoder")) as HTMLElement | undefined;
      expect(agentOption).toBeTruthy();
    });
    await act(async () => {
      agentOption!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const finalSave = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Set watchdog" && button !== trigger);
    expect(finalSave).toBeTruthy();
    await act(async () => {
      finalSave!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(queryClient.getQueryData<Issue>(queryKeys.issues.detail(issue.id))?.watchdog)
      .toEqual(savedWatchdog);

    act(() => root.unmount());
  });

  it("renders an existing watchdog and removes it via the API", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
    });
    mockAgentsApi.list.mockResolvedValue([watchdogAgent]);
    const onUpdate = vi.fn();
    const issue = createIssue({ watchdog: createWatchdogSummary() });
    const { root, queryClient } = renderPropertiesWithQueryClient(container, {
      issue,
      childIssues: [],
      onUpdate,
      inline: true,
    });
    queryClient.setQueryData(queryKeys.issues.detail(issue.id), issue);
    await flush();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("ClaudeCoder");
    });

    const trigger = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("ClaudeCoder"));
    await act(async () => {
      trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const removeButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Remove"));
    expect(removeButton).toBeTruthy();
    await act(async () => {
      removeButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockIssuesApi.deleteWatchdog).toHaveBeenCalledWith("issue-1");
    expect(queryClient.getQueryData<Issue>(queryKeys.issues.detail(issue.id))?.watchdog)
      .toBeNull();

    act(() => root.unmount());
  });

  it("truncates the watchdog instructions one-line summary in the properties value column", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
    });
    mockAgentsApi.list.mockResolvedValue([watchdogAgent]);
    const instructions = "get greptile to stop re-reviewing the same task unless a fresh code change lands";
    const root = renderProperties(container, {
      issue: createIssue({
        watchdog: createWatchdogSummary({ instructions }),
      }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    // ux-spec: watchdog row shows agent + a truncated one-line summary; the
    // full instructions live in the popover (surfaced here via the row title).
    let instructionNode: HTMLSpanElement | undefined;
    await waitForAssertion(() => {
      instructionNode = Array.from(container.querySelectorAll("span"))
        .find((node) =>
          node.textContent?.includes("get greptile")
          && node.className.includes("text-muted-foreground")
          && !node.className.includes("inline-flex")
        ) as HTMLSpanElement | undefined;
      expect(instructionNode).toBeTruthy();
    });

    expect(instructionNode!.className).toContain("truncate");
    expect(instructionNode!.className).not.toContain("whitespace-normal");
    expect(instructionNode!.className).not.toContain("break-words");

    const watchdogTrigger = findRowTrigger(container, "Watchdog");
    expect(watchdogTrigger?.querySelector("[title]")?.getAttribute("title")).toBe(instructions);

    act(() => root.unmount());
  });

  it("links to the generated watchdog task when one exists", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
    });
    mockAgentsApi.list.mockResolvedValue([watchdogAgent]);
    const root = renderProperties(container, {
      issue: createIssue({ watchdog: createWatchdogSummary({ watchdogIssueId: "issue-wd" }) }),
      childIssues: [
        createIssue({
          id: "issue-wd",
          identifier: "PAP-42",
          title: "Watchdog: Parent issue",
          originKind: "task_watchdog",
        }),
      ],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    // The link is now an icon-only "open task" affordance (ux-spec: one
    // trailing-action style), so we assert on href + accessible label.
    await waitForAssertion(() => {
      const link = Array.from(container.querySelectorAll("a"))
        .find((anchor) => anchor.getAttribute("href") === "/issues/issue-wd");
      expect(link).toBeTruthy();
      expect(link!.getAttribute("aria-label")).toBe("Open watchdog task");
    });

    act(() => root.unmount());
  });

  it("renders each external object as its own properties row using display metadata", async () => {
    const root = renderProperties(container, {
      issue: createIssue(),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
      externalObjects: [
        {
          mentionCount: 2,
          sourceLabels: ["Description"],
          pill: {
            providerKey: "github",
            objectType: "pull_request",
            displayKey: null,
            iconKey: "github",
            statusCategory: "succeeded",
            statusIconKey: null,
            statusLabel: "Merged",
            liveness: "fresh",
            displayTitle: "acme/web#241: Add rich object presentation metadata",
            url: "https://github.com/acme/web/pull/241",
          },
          group: {
            object: null,
            mentions: [],
            mentionCount: 2,
            sourceLabels: ["Description"],
          },
        },
        {
          mentionCount: 1,
          sourceLabels: ["Comment"],
          pill: {
            providerKey: "github",
            objectType: "issue",
            displayKey: "Github Issue",
            iconKey: "github",
            statusCategory: "open",
            statusIconKey: "circle-dot",
            statusLabel: "Open",
            liveness: "fresh",
            displayTitle: "acme/web#12: Follow-up",
            url: "https://github.com/acme/web/issues/12",
          },
          group: {
            object: null,
            mentions: [],
            mentionCount: 1,
            sourceLabels: ["Comment"],
          },
        },
        {
          mentionCount: 1,
          sourceLabels: ["Comment"],
          pill: {
            providerKey: "url",
            objectType: "link",
            displayKey: null,
            iconKey: null,
            statusCategory: "unknown",
            statusIconKey: null,
            statusLabel: null,
            liveness: "unknown",
            displayTitle: "https://example.com/release-notes",
            url: "https://example.com/release-notes",
          },
          group: {
            object: null,
            mentions: [],
            mentionCount: 1,
            sourceLabels: ["Comment"],
          },
        },
        {
          mentionCount: 1,
          sourceLabels: ["Comment"],
          pill: {
            providerKey: "github",
            objectType: "pull_request",
            displayKey: "Github PR",
            iconKey: "github",
            statusCategory: "unknown",
            statusIconKey: null,
            statusLabel: null,
            liveness: "unknown",
            displayTitle: "acme/web#242",
            url: "https://github.com/acme/web/pull/242",
          },
          group: {
            object: null,
            mentions: [],
            mentionCount: 1,
            sourceLabels: ["Comment"],
          },
        },
      ],
    });
    await flush();

    expect(container.textContent).toContain("Github PR");
    expect(container.textContent).not.toContain("Github Pull Request");
    expect(container.textContent).not.toContain("×2");
    expect(container.textContent).toContain("Github Issue");
    expect(container.textContent).toContain("URL");
    expect(container.textContent).not.toContain("URL link");
    expect(container.textContent).toContain("PR 241 - Merged");
    expect(container.textContent).toContain("Merged");
    expect(container.textContent).toContain("Open");
    expect(container.textContent).not.toContain("External objects");
    const label = Array.from(container.querySelectorAll("span"))
      .find((span) => span.textContent === "Github PR");
    expect(label?.querySelector("svg")).toBeTruthy();
    const pullRequestLink = Array.from(container.querySelectorAll("a"))
      .find((anchor) => anchor.getAttribute("href") === "https://github.com/acme/web/pull/241");
    expect(pullRequestLink?.textContent).toContain("PR 241 - Merged");
    expect(pullRequestLink?.textContent).not.toContain("acme/web#241");
    expect(pullRequestLink?.textContent).not.toContain("Github PR");
    expect(pullRequestLink?.querySelectorAll("svg")).toHaveLength(1);
    expect(pullRequestLink?.className).not.toContain("paperclip-mention-chip");
    expect(pullRequestLink?.className).not.toContain("rounded-full");
    expect(pullRequestLink?.className).not.toContain("border");
    const unrefreshedPullRequestLink = Array.from(container.querySelectorAll("a"))
      .find((anchor) => anchor.getAttribute("href") === "https://github.com/acme/web/pull/242");
    expect(unrefreshedPullRequestLink?.textContent).toContain("PR 242 - Not yet refreshed");
    expect(unrefreshedPullRequestLink?.textContent).not.toContain("Not yet resolved");

    act(() => root.unmount());
  });

  it("shows agent-archive attribution and unarchive only in the properties pane", async () => {
    mockAgentsApi.list.mockResolvedValue([
      { id: "agent-9", name: "Gardener", status: "active", adapterType: "codex_local", icon: null },
    ]);
    const root = renderProperties(container, {
      issue: createIssue({
        archivedAt: new Date("2026-04-06T12:10:00.000Z"),
        archivedByActorType: "agent",
        archivedByAgentId: "agent-9",
        archivedByRunId: "run-1",
      }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Archived");
      // The value shows just the agent name (the row label already says
      // "Archived"), giving the name the full column width at 320px.
      expect(container.textContent).toContain("Gardener");
      const unarchive = Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Unarchive"));
      expect(unarchive).toBeTruthy();
    });

    // The tooltip must carry the full "Archived by <name> · <time>" phrasing so
    // the attribution is recoverable if a long name truncates at the 320px pane
    // width (PAP-14182 review fix).
    const attribution = Array.from(container.querySelectorAll("span"))
      .find((span) => span.getAttribute("title")?.startsWith("Archived by Gardener"));
    expect(attribution).toBeTruthy();

    const unarchiveButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Unarchive"))!;
    await act(async () => {
      unarchiveButton.click();
    });
    await flush();
    expect(mockIssuesApi.unarchiveFromInbox).toHaveBeenCalledWith("issue-1");

    act(() => root.unmount());
  });

  it("surfaces unarchive failures inline", async () => {
    mockAgentsApi.list.mockResolvedValue([
      { id: "agent-9", name: "Gardener", status: "active", adapterType: "codex_local", icon: null },
    ]);
    mockIssuesApi.unarchiveFromInbox.mockRejectedValue(new Error("Archive policy denied"));
    const root = renderProperties(container, {
      issue: createIssue({
        archivedAt: new Date("2026-04-06T12:10:00.000Z"),
        archivedByActorType: "agent",
        archivedByAgentId: "agent-9",
        archivedByRunId: "run-1",
      }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    let unarchiveButton: HTMLButtonElement | undefined;
    await waitForAssertion(() => {
      unarchiveButton = Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Unarchive"));
      expect(unarchiveButton).toBeTruthy();
    });
    await act(async () => {
      unarchiveButton!.click();
    });
    await flush();

    await waitForAssertion(() => {
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("Archive policy denied");
    });

    act(() => root.unmount());
  });

  it("does not render archive attribution for user (manual) archives", async () => {
    const root = renderProperties(container, {
      issue: createIssue({
        archivedAt: new Date("2026-04-06T12:10:00.000Z"),
        archivedByActorType: "user",
        archivedByAgentId: null,
      }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Updated");
    });
    expect(container.textContent).not.toContain("Archived by");
    expect(
      Array.from(container.querySelectorAll("button")).some((button) => button.textContent?.includes("Unarchive")),
    ).toBe(false);

    act(() => root.unmount());
  });

  // PAP-16506 P4: only an agent sets `reviewPolicy`, so the panel shows it and
  // never offers a control. The default — a NULL column, meaning anyone with
  // write access can approve — is what every issue already does, so it shows
  // nothing at all rather than a row reading "Anyone" or "None".
  const findApprovalsRow = () =>
    container.querySelector('[data-property-label="Approvals"]')?.closest('[data-property-row="true"]') ?? null;

  it("shows no approvals row on an issue that has never set a policy", async () => {
    const root = renderProperties(container, {
      issue: createIssue({ reviewPolicy: null }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    expect(findApprovalsRow()).toBeNull();
    expect(container.textContent).not.toContain("Review policy");

    act(() => root.unmount());
  });

  it("shows no approvals row when the policy is the explicit default", async () => {
    const root = renderProperties(container, {
      issue: createIssue({ reviewPolicy: "anyone" }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    expect(findApprovalsRow()).toBeNull();

    act(() => root.unmount());
  });

  it("badges an opt-in constraint read-only, with no control to change it", async () => {
    const onUpdate = vi.fn();
    const root = renderProperties(container, {
      issue: createIssue({ reviewPolicy: "human_only" }),
      childIssues: [],
      onUpdate,
      inline: true,
    });
    await flush();

    const row = findApprovalsRow();
    expect(row?.textContent).toContain("Human only");
    // Read-only: the row is a chip, not a picker — nothing here can PATCH.
    expect(row?.querySelector("button")).toBeNull();
    expect(onUpdate).not.toHaveBeenCalled();

    act(() => root.unmount());
  });

  it("badges a not_creator policy as 'Anyone else'", async () => {
    const root = renderProperties(container, {
      issue: createIssue({ reviewPolicy: "not_creator" }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    expect(findApprovalsRow()?.textContent).toContain("Anyone else");

    act(() => root.unmount());
  });

  it("hides the execution workspace picker without an enabled project policy", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    mockProjectsApi.list.mockResolvedValue([createProject({ executionWorkspacePolicy: null })]);
    const root = renderProperties(container, {
      issue: createIssue({ projectId: "project-1" }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });

    await flush();

    expect(container.querySelector('[data-property-label="Execution"]')).toBeNull();
    expect(mockExecutionWorkspacesApi.list).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("hides workspace selection but keeps the bound workspace accessible", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    mockProjectsApi.list.mockResolvedValue([createProject({ executionWorkspacePolicy: { enabled: true, defaultMode: "isolated_workspace" } })]);
    const onUpdate = vi.fn();
    const { root } = renderPropertiesWithQueryClient(container, {
      issue: createIssue({ projectId: "project-1", executionWorkspaceId: "workspace-1", currentExecutionWorkspace: createExecutionWorkspace() }),
      childIssues: [], onUpdate, inline: true,
    }, ["workspaces.isolation"]);
    await flush();
    expect(container.querySelector('[data-property-label="Execution"]')).toBeNull();
    await vi.waitFor(() => expect(container.querySelector('a[href="/execution-workspaces/workspace-1"]')).not.toBeNull());
    expect(onUpdate).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("shows the workspace picker with no bound workspace", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    mockProjectsApi.list.mockResolvedValue([createProject({
      executionWorkspacePolicy: { enabled: true, defaultMode: "isolated_workspace" },
    })]);
    const root = renderProperties(container, {
      issue: createIssue({ projectId: "project-1" }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });

    await waitForAssertion(() => {
      expect(findRowTrigger(container, "Execution")?.textContent).toBe("Default");
    });

    act(() => root.unmount());
  });

  it("saves the exact isolated-workspace payload", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    mockProjectsApi.list.mockResolvedValue([createProject({
      executionWorkspacePolicy: { enabled: true, defaultMode: "shared_workspace" },
    })]);
    const onUpdate = vi.fn();
    const root = renderProperties(container, {
      issue: createIssue({ projectId: "project-1" }),
      childIssues: [],
      onUpdate,
      inline: true,
    });

    await waitForAssertion(() => expect(findRowTrigger(container, "Execution")).toBeDefined());
    act(() => findRowTrigger(container, "Execution")!.click());
    const isolatedOption = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("New isolated workspace"));
    act(() => isolatedOption!.click());

    expect(onUpdate).toHaveBeenCalledWith({
      executionWorkspacePreference: "isolated_workspace",
      executionWorkspaceId: null,
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
        environmentId: null,
      },
    });
    act(() => root.unmount());
  });

  it("searches reusable workspaces and saves the selected workspace", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    mockProjectsApi.list.mockResolvedValue([createProject({
      executionWorkspacePolicy: { enabled: true, defaultMode: "shared_workspace" },
    })]);
    const alphaWorkspace = createExecutionWorkspace({
      id: "workspace-alpha",
      name: "Alpha workspace",
      cwd: "/tmp/paperclip/alpha",
      branchName: "alpha-branch",
      lastUsedAt: new Date(),
    });
    const betaWorkspace = createExecutionWorkspace({
      id: "workspace-beta",
      name: "Beta workspace",
      cwd: "/tmp/paperclip/beta",
      branchName: "beta-branch",
      lastUsedAt: new Date(),
    });
    mockExecutionWorkspacesApi.list.mockResolvedValue([alphaWorkspace, betaWorkspace]);
    const onUpdate = vi.fn();
    const root = renderProperties(container, {
      issue: createIssue({ projectId: "project-1", projectWorkspaceId: "workspace-main" }),
      childIssues: [],
      onUpdate,
      inline: true,
    });

    await waitForAssertion(() => expect(findRowTrigger(container, "Execution")).toBeDefined());
    act(() => findRowTrigger(container, "Execution")!.click());
    const reuseOption = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Reuse existing workspace"));
    act(() => reuseOption!.click());

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Recent");
      expect(container.textContent).toContain("Alpha workspace");
      expect(container.textContent).toContain("Beta workspace");
    });
    expect(mockExecutionWorkspacesApi.list).toHaveBeenCalledWith("company-1", {
      projectId: "project-1",
      projectWorkspaceId: "workspace-main",
      reuseEligible: true,
    });

    const search = container.querySelector('input[aria-label="Search reusable workspaces"]') as HTMLInputElement;
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      nativeSetter?.call(search, "Beta");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.textContent).not.toContain("Alpha workspace");
    expect(container.textContent).toContain("Beta workspace");

    const betaOption = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Beta workspace"));
    act(() => betaOption!.click());
    expect(onUpdate).toHaveBeenCalledWith({
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceId: "workspace-beta",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
        environmentId: null,
      },
    });

    act(() => root.unmount());
  });
});
