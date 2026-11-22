// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  Agent,
  AgentInstructionsBundle,
  AgentInstructionsFileDetail,
  AgentInstructionsFileSummary,
} from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PromptsTab } from "./AgentDetail";
import { PromptsTab as ProductionPromptsTab } from "./AgentDetail.production";

const { bundleMock, fileMock, mobile } = vi.hoisted(() => ({
  bundleMock: vi.fn(),
  fileMock: vi.fn(),
  mobile: { value: true },
}));

vi.mock("../context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: mobile.value }) }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("../api/agents", () => ({
  agentsApi: {
    instructionsBundle: bundleMock,
    instructionsFile: fileMock,
    instructionCandidates: async () => [],
    updateInstructionsBundle: async () => ({}),
    saveInstructionsFile: async () => ({}),
    deleteInstructionsFile: async () => ({}),
  },
}));
vi.mock("../api/assets", () => ({ assetsApi: { uploadImage: async () => "/assets/uploaded.png" } }));
vi.mock("@/adapters/use-adapter-capabilities", () => ({
  useAdapterCapabilities: () => () => ({
    supportsInstructionsBundle: true,
    supportsSkills: true,
    supportsLocalAgentJwt: true,
    requiresMaterializedRuntimeSkills: false,
  }),
}));
vi.mock("../components/MarkdownEditor", () => ({ MarkdownEditor: () => <div data-testid="markdown-editor" /> }));
vi.mock("../components/MarkdownBody", () => ({ MarkdownBody: () => <div data-testid="markdown-body" /> }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeAgent(): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Codex Coder",
    urlKey: "codexcoder",
    role: "engineer",
    title: null,
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

const summary: AgentInstructionsFileSummary = {
  path: "AGENTS.md",
  size: 24,
  language: "markdown",
  markdown: true,
  isEntryFile: true,
  editable: true,
  deprecated: false,
  virtual: false,
};

const detail: AgentInstructionsFileDetail = { ...summary, content: "# Agent instructions" };

const bundle: AgentInstructionsBundle = {
  agentId: "agent-1",
  companyId: "company-1",
  mode: "managed",
  rootPath: "/paperclip/agents/agent-1/instructions",
  managedRootPath: "/paperclip/agents/agent-1/instructions",
  entryFile: "AGENTS.md",
  resolvedEntryPath: "/paperclip/agents/agent-1/instructions/AGENTS.md",
  editable: true,
  warnings: [],
  legacyPromptTemplateActive: false,
  legacyBootstrapPromptTemplateActive: false,
  files: [summary],
};

/** Name a control the way assistive technology will read it. */
function accessibleName(button: HTMLButtonElement): string {
  return (
    button.getAttribute("aria-label") ??
    button.getAttribute("title") ??
    button.textContent ??
    ""
  ).trim();
}

describe.each([
  ["streamlined", PromptsTab],
  ["legacy", ProductionPromptsTab],
] as const)("PromptsTab file panel controls (%s)", (_label, Tab) => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let client: QueryClient;

  beforeEach(() => {
    mobile.value = true;
    bundleMock.mockReset();
    fileMock.mockReset();
    bundleMock.mockResolvedValue(bundle);
    fileMock.mockResolvedValue(detail);
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

  it("names every file-panel icon control and offers the file-list toggle", async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Tab
            agent={makeAgent()}
            companyId="company-1"
            onDirtyChange={vi.fn()}
            onSaveActionChange={vi.fn()}
            onCancelActionChange={vi.fn()}
            onSavingChange={vi.fn()}
          />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Files");
      expect(container.querySelector('button[aria-label="Add agent file"]')).not.toBeNull();
    });

    const unnamed = Array.from(container.querySelectorAll("button"))
      .filter((button) => accessibleName(button).length === 0)
      .map((button) => button.outerHTML);
    expect(unnamed).toEqual([]);

    expect(container.querySelector('button[aria-label="Add agent file"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Hide file list"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Show file list"]')).not.toBeNull();
  });
});
