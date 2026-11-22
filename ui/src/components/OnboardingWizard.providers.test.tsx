// @vitest-environment jsdom

import { act } from "react";

import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import type { LocalAiLoginStatus } from "@paperclipai/shared";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (hoisted so vi.mock factories can close over them) ----------------

// The company list is keyed by account, so it holds until the session query
// *succeeds*. A seeded entry is stale under the test client and refetches, so
// the refetch has to answer too — otherwise the identity errors and the list
// never runs.
const mockAdaptersApi = vi.hoisted(() => ({ list: vi.fn(async (_context?: { companyId: string; environmentId?: string | null }) => [] as import("../api/adapters").AdapterInfo[]) }));
vi.mock("../api/adapters", () => ({ adaptersApi: mockAdaptersApi }));

function setupAdapterInfo(input: Pick<import("../api/adapters").AdapterInfo, "type"> & Partial<import("../api/adapters").AdapterInfo>): import("../api/adapters").AdapterInfo {
  return { label: input.type, source: "builtin", modelsCount: 0, loaded: true, disabled: false,
    capabilities: { supportsInstructionsBundle: true, supportsSkills: true, supportsLocalAgentJwt: true,
      requiresMaterializedRuntimeSkills: false, supportsAcp: true }, ...input };
}

const mockAuthApi = vi.hoisted(() => ({ getSession: vi.fn() }));
const localHealth = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/api/health", () => ({ healthApi: localHealth }));
const managedApi = vi.hoisted(() => ({
  list: vi.fn(async () => ({ currentUserId: "user-1", connections: [] })),
  startLocalLogin: vi.fn(async () => ({ sessionId: "local-attempt", expiresAt: "2099-01-01T00:00:00Z" })),
  submitLocalLoginCode: vi.fn(async () => ({ ok: true })),
  checkLocalLogin: vi.fn(async (): Promise<LocalAiLoginStatus> => ({ status: "sign_in_required" })),
  cancelLocalLogin: vi.fn(async () => ({})),
  connectLocal: vi.fn(async () => ({ connectionId: "local-connection", grantId: "local-grant" })),
  create: vi.fn(async () => ({ connectionId: "managed-connection", grantId: "managed-grant" })),
  setDefault: vi.fn(async (_companyId: string, _grantId: string) => ({})),
  loginResult: vi.fn(async () => ({ connectionId: "subscription-account", grantId: "subscription-grant" })),
}));
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: managedApi }));
vi.mock("../api/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/auth")>();
  return { ...actual, authApi: { ...actual.authApi, getSession: mockAuthApi.getSession } };
});

const mockDialog = vi.hoisted(() => ({
  onboardingOpen: true,
  onboardingOptions: {} as { initialStep?: number; companyId?: string },
  closeOnboarding: vi.fn(),
  onboardingRouteDismissed: false,
  setOnboardingRouteDismissed: vi.fn(),
}));

const mockCompany = vi.hoisted(() => ({
  companies: [] as Array<{ id: string; name: string; issuePrefix: string }>,
  setSelectedCompanyId: vi.fn(),
  loading: false,
  error: null as Error | null,
}));

const mockCompaniesApi = vi.hoisted(() => ({
  detachInflightList: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  // The gate fetches the list itself now, rather than reading the shared
  // cache, so ownership cases are driven from here. `mockCompany.companies`
  // below still feeds the *inner* wizard, which is a different question.
  list: vi.fn(),
}));
const mockGoalsApi = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(async () => []),
}));
const mockAgentsApi = vi.hoisted(() => ({
  get: vi.fn(),
  create: vi.fn(async (_company: string, input: Record<string, unknown>) => ({ ...input, id: input.setupId, pauseReason: "setup" })),
  update: vi.fn(async (_id: string, input: Record<string, unknown>) => input),
  adapterModels: vi.fn(async () => [] as Array<{ id: string; label: string }>),
  testEnvironment: vi.fn(
    async (): Promise<import("@paperclipai/shared").AdapterEnvironmentTestResult> => ({
      adapterType: "claude_local",
      status: "pass",
      checks: [],
      testedAt: new Date().toISOString(),
    }),
  ),
  hire: vi.fn(async () => ({ agent: { id: "agent-1" }, approval: null })),
  // The hire step lists the company's agents first and adopts one that already
  // carries the typed name on the same source, so a wizard that reopens on the
  // agent step cannot hire "Ada 2". Empty by default: the company is new.
  list: vi.fn(async () => [] as Array<{ id: string; name: string; adapterType: string; adapterConfig?: Record<string, unknown> }>),
  instructionsBundle: vi.fn(async () => ({ entryFile: "AGENTS.md" })),
  saveInstructionsFile: vi.fn(async () => ({})),
  // No default implementation: the top-level `beforeEach` sets the "no
  // stored value" 404 rejection, using the real `ApiError` class the code
  // under test checks with `instanceof`.
  getClaudeOAuthTokenStatus: vi.fn(),
  getAdapterAuthSignal: vi.fn(
    async (): Promise<import("@paperclipai/shared").AdapterAuthSignalResponse> => ({
      status: "present",
    }),
  ),
  // The sign-in routes. The connect step's Connect button starts a login rather
  // than hiring when the signal says the source has no credential, so the two
  // login shapes need enough of a server to reach the state the step is about:
  // a session that is running, and a prompt to show for it.
  startClaudeSetupTokenLogin: vi.fn(async () => ({
    sessionId: "claude-session-1",
    status: "pending",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  })),
  getClaudeSetupTokenLoginStatus: vi.fn(async () => ({
    sessionId: "claude-session-1",
    status: "pending",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  })),
  getClaudeSetupTokenLoginPrompt: vi.fn(async () => ({
    authorizationUrl: "https://claude.ai/oauth/authorize?code=true",
    transportAdvisory: null,
  })),
  cancelClaudeSetupTokenLogin: vi.fn(async () => ({})),
  submitClaudeSetupTokenBrowserCode: vi.fn(async () => ({})),
  completeClaudeSetupTokenLogin: vi.fn(async () => ({ storedSessionId: "stored-1" })),
  startAdapterAuthLogin: vi.fn(async () => ({
    sessionId: "codex-session-1",
    status: "pending",
  })),
  getAdapterAuthLoginStatus: vi.fn(async () => ({
    sessionId: "codex-session-1",
    status: "pending",
    prompt: { url: "https://auth.openai.com/codex/device", code: "Q2RJ-E1YIF" },
  })),
  cancelAdapterAuthLogin: vi.fn(async () => ({})),
  // No default implementation: the top-level `beforeEach` sets the "no active
  // session" 404 rejection, matching the real route.
  getActiveAdapterAuthLoginSession: vi.fn(),
  getActiveClaudeSetupTokenLoginSession: vi.fn(),
}));
// The adapter registry mock below always returns this function, so a test
// can shape the built adapter config (e.g. a configured ANTHROPIC_API_KEY)
// without a real adapter package.
const mockAdapterBuild = vi.hoisted(() => ({
  buildAdapterConfig: vi.fn((_values?: CreateConfigValues) => ({}) as Record<string, unknown>),
}));
// The Connect path loads environment settings before probing; without these
// the probe dies on "Could not load environment settings" and the hire never
// runs — which reads as a mysterious 0-call assertion, not an error.
const mockEnvironmentsApi = vi.hoisted(() => ({
  probe: vi.fn(async (): Promise<import("@paperclipai/shared").EnvironmentProbeResult> => ({ ok: true, driver: "sandbox", summary: "Measured image", details: { platformQualificationRecorded: true, leaseId: "platform-lease" } })),
  list: vi.fn(async () => [] as Array<Record<string, unknown>>),
  capabilities: vi.fn(
    async (): Promise<import("@paperclipai/shared").EnvironmentCapabilities> =>
      (await import("@paperclipai/shared")).getEnvironmentCapabilities([]),
  ),
}));
const mockInstanceSettingsApi = vi.hoisted(() => ({
  get: vi.fn(async () => ({ defaultEnvironmentId: null as string | null })),
  getExperimental: vi.fn(async (): Promise<{ enableManagedSandboxOnly: boolean; enableNativeRunner?: boolean }> => ({ enableManagedSandboxOnly: false })),
}));
const mockApprovalsApi = vi.hoisted(() => ({
  create: vi.fn(),
}));
const mockSecretsApi = vi.hoisted(() => ({
  list: vi.fn(),
  removeUserSecretDefinition: vi.fn(),
  listMyUserSecrets: vi.fn(),
  createUserSecretDefinition: vi.fn(),
  createMyUserSecret: vi.fn(),
  rotateMyUserSecret: vi.fn(),
}));
const mockIssuesApi = vi.hoisted(() => ({
  create: vi.fn(),
}));
const mockProjectsApi = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(async () => []),
}));

// The real adapter registry eagerly imports every adapter package. The
// model/harness picker internals are out of scope here, so stub the adapter
// layer entirely and drive it through this knob.
const mockAdapterRegistry = vi.hoisted(() => ({
  list: [] as Array<{ type: string; recommended?: boolean }>,
  disabled: new Set<string>(),
}));

const mockRouterState = vi.hoisted(() => ({ pathname: "/" }));

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: mockRouterState.pathname, search: "", hash: "", state: null }),
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
}));
vi.mock("../context/DialogContext", () => ({
  useDialog: () => mockDialog,
}));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => mockCompany,
}));
vi.mock("../api/companies", () => ({ companiesApi: mockCompaniesApi }));
vi.mock("../api/goals", () => ({ goalsApi: mockGoalsApi }));
vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/approvals", () => ({ approvalsApi: mockApprovalsApi }));
vi.mock("../api/secrets", () => ({ secretsApi: mockSecretsApi }));
vi.mock("../api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("../api/projects", () => ({ projectsApi: mockProjectsApi }));
vi.mock("../api/environments", () => ({ environmentsApi: mockEnvironmentsApi }));
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: mockInstanceSettingsApi }));
vi.mock("../adapters", () => ({
  listUIAdapters: () => mockAdapterRegistry.list,
  getUIAdapter: () => ({ buildAdapterConfig: mockAdapterBuild.buildAdapterConfig }),
}));
vi.mock("../adapters/metadata", () => ({ isVisualAdapterChoice: () => true }));
vi.mock("../adapters/adapter-display-registry", () => ({
  getAdapterDisplay: (type: string) => ({
    type,
    // Mirrors the real registry, where these two and only these two are
    // `recommended`. A blanket `false` used to be harmless because every adapter
    // then sat in the "Advanced settings" disclosure and was reachable anyway;
    // with the step down to a tile row built from this flag, it made that row
    // empty in every test and hid the surface under it.
    recommended: type === "claude_local" || type === "codex_local" || mockAdapterRegistry.list.some(entry => entry.type === type && entry.recommended),
    label: type,
    description: "",
    icon: () => null,
  }),
  getAdapterLabel: (type: string) => type,
  getAdapterLabels: () => ({}) as Record<string, string>,
  isKnownAdapterType: () => true,
}));
vi.mock("../adapters/use-disabled-adapters", () => ({
  useDisabledAdaptersSync: () => mockAdapterRegistry.disabled,
  // Added by #11371's adapter snap. A module mock replaces the whole module,
  // so every export the component reaches for has to be here — omitting one
  // makes it undefined and the call throws.
  useAdapterRegistryLoaded: () => true,
}));
// Adapters with a declared login capability, mirroring the real registry:
// `claude_local` and `codex_local` both support a sandbox login, and every
// other type has none, matching the real `useAdapterCapabilities` fallback for
// an unlisted type.
//
// The panel modes are the real ones rather than one mode for both. They used to
// be, back when nothing outside the panel dispatcher read them. The connect
// step reads them now — the two logins end in different places, so its button
// waits differently for each — and a mock that called Claude's login
// `displayed_code` would have the step testing the wrong half of that.
// Reconcile with KNOWN_DEFAULTS in `adapters/use-adapter-capabilities.ts`.
const ADAPTER_LOGIN_MODES: Record<string, "displayed_code" | "submitted_browser_code"> = {
  claude_local: "submitted_browser_code",
  codex_local: "displayed_code",
};
vi.mock("../adapters/use-adapter-capabilities", () => ({
  useAdapterCapabilities: () => (type: string) => ({
    supportsInstructionsBundle: false,
    supportsSkills: false,
    supportsLocalAgentJwt: false,
    requiresMaterializedRuntimeSkills: false,
    login: ADAPTER_LOGIN_MODES[type]
      ? { panelMode: ADAPTER_LOGIN_MODES[type]!, timeoutPolicy: "fixed" as const }
      : undefined,
  }),
}));
// Animation / canvas-ish children that add nothing to the logic under test.
vi.mock("./AsciiArtAnimation", () => ({ AsciiArtAnimation: () => null }));
vi.mock("./AgentCapsule", () => ({ AgentCapsule: () => null }));

import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";

import { ONBOARDING_STORAGE_KEY, OnboardingWizard } from "./OnboardingWizard";

import { TooltipProvider } from "./ui/tooltip";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** React tracks input value on the DOM node; set it the way React will see. */
function setControlledValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function renderWizardView(root: ReturnType<typeof createRoot>, queryClient: QueryClient) {
  return act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider><OnboardingWizard /></TooltipProvider>
      </QueryClientProvider>,
    );
  });
}

const SESSION_USER_ID = "user-b";

function render(staleTime = 0) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime } },
  });
  // The company list is keyed by account, so it stays disabled until the
  // session is known. Seeding it is how these tests say "signed in as B".
  queryClient.setQueryData(queryKeys.auth.session, {
    session: { id: "session-b", userId: SESSION_USER_ID },
    user: { id: SESSION_USER_ID, name: "B", email: "b@example.com", image: null },
  });
  return { container, root, queryClient };
}

/**
 * Press the first model-source tile.
 *
 * By `aria-checked` rather than by label: the display registry is mocked in this
 * suite, so a tile reads "claude_localSubscription" rather than "Claude Code",
 * and a test that selected on the visible name would be asserting the mock.
 *
 * The connect step arrives with nothing chosen, so this is what opens the input
 * surface and lets the step advance.
 */
async function pickFirstSource(
  click: (match: (text: string) => boolean) => Promise<void>,
): Promise<void> {
  const tile = [...document.body.querySelectorAll("button[aria-checked]")][0];
  const label = tile?.textContent?.trim() ?? "";
  await click((text) => text === label);
}

/**
 * The arc footer's primary button, whatever this step calls it.
 *
 * Step 4 calls it "Connect", because there it starts a sign-in rather than
 * simply advancing; every other arc step calls it "Next". These tests are about
 * what the press does, not what it reads, so they match either — restating the
 * label at twenty call sites would make a copy change look like a behaviour
 * regression. The label itself is pinned once, in the step test that is about
 * the label.
 */
function isArcPrimary(text: string): boolean {
  return text.startsWith("Next") || text.startsWith("Connect");
}

describe("OnboardingWizard provider choices and step 1", () => {
  beforeEach(() => {
    managedApi.list.mockReset().mockResolvedValue({ currentUserId: "user-1", connections: [] });
    managedApi.create.mockReset().mockResolvedValue({ connectionId: "managed-connection", grantId: "managed-grant" });
    mockAdaptersApi.list.mockReset().mockResolvedValue([]);
    mockEnvironmentsApi.probe.mockReset().mockResolvedValue({ ok: true, driver: "sandbox", summary: "Measured image", details: { platformQualificationRecorded: true, leaseId: "platform-lease" } });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableManagedSandboxOnly: false });
    localHealth.get.mockResolvedValue({ deploymentMode: "authenticated" });
    managedApi.checkLocalLogin.mockReset().mockResolvedValue({
      status: "sign_in_required",
      authorizationUrl: "https://claude.ai/oauth/authorize?code=true",
      code: "TEST-CODE",
    });
    managedApi.connectLocal.mockReset().mockResolvedValue({ connectionId: "local-connection", grantId: "local-grant" });
    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-b", userId: SESSION_USER_ID },
      user: { id: SESSION_USER_ID, name: "B", email: "b@example.com", image: null },
    });
    mockSecretsApi.list.mockResolvedValue([]);
    mockSecretsApi.listMyUserSecrets.mockResolvedValue([]);
    mockSecretsApi.removeUserSecretDefinition.mockResolvedValue({ ok: true });
    window.localStorage.clear();
    mockRouterState.pathname = "/";
    mockDialog.onboardingOpen = true;
    mockDialog.onboardingOptions = {};
    mockDialog.onboardingRouteDismissed = false;
    mockCompany.companies = [];
    mockCompany.loading = false;
    mockCompany.error = null;
    mockCompaniesApi.list.mockResolvedValue([]);
    mockAdapterRegistry.list = [];
    mockAdapterRegistry.disabled = new Set<string>();
    mockAdaptersApi.list.mockReset().mockResolvedValue(["claude_local", "codex_local"].map(type => setupAdapterInfo({ type, loaded: true, disabled: false, supportedRunners: ["paperclip", "legacy"], defaultRunner: "legacy" })));
    mockAdapterBuild.buildAdapterConfig.mockReset();
    mockAdapterBuild.buildAdapterConfig.mockReturnValue({});
    // Default: no stored Claude login for the owner. The route returns a
    // fixed 404 for a missing value, so the client treats a real `ApiError`
    // with that status as "no stored value" rather than a hard failure.
    mockAgentsApi.getClaudeOAuthTokenStatus.mockReset();
    mockAgentsApi.getClaudeOAuthTokenStatus.mockRejectedValue(
      new ApiError("Not found", 404, null),
    );
    // Default: no active login session for the caller. A resume test
    // overrides this with a resolved session body.
    mockAgentsApi.getActiveAdapterAuthLoginSession.mockReset();
    mockAgentsApi.getActiveAdapterAuthLoginSession.mockRejectedValue(
      new ApiError("Not found", 404, null),
    );
    for (const mock of [mockAgentsApi.startClaudeSetupTokenLogin, mockAgentsApi.getClaudeSetupTokenLoginStatus,
      mockAgentsApi.getClaudeSetupTokenLoginPrompt, mockAgentsApi.cancelClaudeSetupTokenLogin,
      mockAgentsApi.submitClaudeSetupTokenBrowserCode, mockAgentsApi.completeClaudeSetupTokenLogin,
      mockAgentsApi.startAdapterAuthLogin, mockAgentsApi.getAdapterAuthLoginStatus, mockAgentsApi.cancelAdapterAuthLogin]) {
      mock.mockReset();
    }
    mockAgentsApi.getActiveClaudeSetupTokenLoginSession.mockReset();
    mockAgentsApi.getActiveClaudeSetupTokenLoginSession.mockRejectedValue(
      new ApiError("Not found", 404, null),
    );
    // Reset to each mock's original default. `mockResolvedValue` /
    // `mockReturnValue` overrides a mock's implementation permanently — it
    // is not undone by `afterEach`'s `vi.clearAllMocks()`, which only clears
    // call history — so a test that customizes one of these must not leak
    // its override into the next test.
    mockAgentsApi.testEnvironment.mockReset();
    mockAgentsApi.adapterModels.mockReset().mockResolvedValue([]);
    mockAgentsApi.testEnvironment.mockResolvedValue({
      adapterType: "claude_local",
      status: "pass" as const,
      checks: [],
      testedAt: new Date().toISOString(),
    });
    mockAgentsApi.hire.mockReset();
    mockAgentsApi.get.mockReset();
    managedApi.setDefault.mockReset().mockResolvedValue({});
    managedApi.loginResult.mockReset().mockResolvedValue({ connectionId: "subscription-account", grantId: "subscription-grant" });
    mockAgentsApi.list.mockReset().mockResolvedValue([]);
    mockAgentsApi.create.mockReset().mockImplementation(async (_company, input) => ({ ...input, id: input.setupId, pauseReason: "setup" }));
    mockAgentsApi.hire.mockResolvedValue({ agent: { id: "agent-1" }, approval: null });
    mockCompaniesApi.create.mockResolvedValue({
      id: "created",
      name: "Created Co",
      issuePrefix: "CRE",
    });
    mockCompaniesApi.update.mockResolvedValue({
      id: "c1",
      name: "Acme Rockets",
      issuePrefix: "PAP",
    });
    mockGoalsApi.create.mockResolvedValue({ id: "goal-1" });
    mockGoalsApi.list.mockResolvedValue([]);
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  describe("first-agent provider choices", () => {
    async function openProviderChoices(savedOverrides: Record<string, unknown> = {}) {
      mockCompany.companies = [{ id: "c1", name: "Acme", issuePrefix: "ACM" }];
      mockCompaniesApi.list.mockResolvedValue(mockCompany.companies);
      mockAdapterRegistry.list = [
        { type: "claude_local" }, { type: "codex_local" },
        { type: "paperclip_runner" }, { type: "copilot_runtime", recommended: true },
        { type: "gemini_local", recommended: true }, { type: "opencode_local" },
      ];
      window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({
        step: 4, createdCompanyId: "c1", agentName: "Ada", ...savedOverrides,
      }));
      const { root, queryClient } = render();
      await renderWizardView(root, queryClient);
      await flushReact();
      return root;
    }

    it.each([true, false, undefined].flatMap(enableNativeRunner =>
      (["paperclip", "legacy"] as const).map(defaultRunner => ({ enableNativeRunner, defaultRunner })),
    ))("offers the same Claude and Codex choices with $defaultRunner availability and native runner setting $enableNativeRunner", async ({ enableNativeRunner, defaultRunner }) => {
      mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableManagedSandboxOnly: false, enableNativeRunner });
      mockAdaptersApi.list.mockResolvedValue(["claude_local", "codex_local"].map(type =>
        setupAdapterInfo({ type, defaultRunner, supportedRunners: defaultRunner === "paperclip" ? ["paperclip", "legacy"] : ["legacy"] }),
      ));
      const root = await openProviderChoices();
      try {
        const sources = [...document.body.querySelectorAll("button[aria-checked]")];
        expect(sources).toHaveLength(4);
        expect(sources.map(source => source.textContent)).toEqual([
          expect.stringContaining("Claude"),
          expect.stringContaining("OpenAI"),
          expect.stringContaining("OpenCode"),
          expect.stringContaining("OpenAI-compatible / custom"),
        ]);
        expect(document.body.textContent).not.toContain("GitHub Copilot");
        expect(document.body.textContent).not.toContain("Windows");
        expect(JSON.parse(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)!).runner).toBe("auto");
      } finally { await act(async () => root.unmount()); }
    });

    it("still hides disabled providers from first-agent setup", async () => {
      mockAdapterRegistry.disabled = new Set(["claude_local"]);
      const root = await openProviderChoices();
      try {
        const sources = [...document.body.querySelectorAll("button[aria-checked]")];
        expect(sources).toHaveLength(3);
        expect(sources[0]?.textContent).toContain("OpenAI");
        expect(sources.map(source => source.textContent)).toEqual([
          expect.stringContaining("OpenAI"),
          expect.stringContaining("OpenCode"),
          expect.stringContaining("OpenAI-compatible / custom"),
        ]);
      } finally { await act(async () => root.unmount()); }
    });

    async function clickProviderSource(match: (text: string) => boolean) {
      const button = [...document.body.querySelectorAll<HTMLButtonElement>("button")]
        .find((candidate) => match(candidate.textContent ?? ""));
      expect(button).toBeTruthy();
      await act(async () => {
        button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    }

    it("selects OpenCode with an editable provider/model", async () => {
      const root = await openProviderChoices();
      try {
        await clickProviderSource((text) => /OpenCode/.test(text) && !text.includes("compatible"));
        await flushReact();
        expect(JSON.parse(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)!)).toMatchObject({
          adapterType: "opencode_local",
        });
        const model = document.body.querySelector<HTMLInputElement>("#onboarding-opencode-model");
        expect(model).not.toBeNull();
        await act(async () => setControlledValue(model!, "openai/gpt-5"));
        await flushReact();
        expect(model!.value).toBe("openai/gpt-5");
      } finally { await act(async () => root.unmount()); }
    });

    it("offers the OpenAI-compatible custom row as OpenCode with a free-form model", async () => {
      const root = await openProviderChoices();
      try {
        await clickProviderSource((text) => text.includes("OpenAI-compatible / custom"));
        await flushReact();
        expect(JSON.parse(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)!)).toMatchObject({
          adapterType: "opencode_local",
        });
        expect(document.body.querySelector<HTMLInputElement>("#onboarding-opencode-model")).not.toBeNull();
        expect(document.body.textContent).toContain("Custom Gateway");
      } finally { await act(async () => root.unmount()); }
    });

    it("creates the agent from Skip without probing a provider", async () => {
      const root = await openProviderChoices({ adapterType: "claude_local", runner: "legacy" });
      try {
        mockAgentsApi.testEnvironment.mockClear();
        await clickProviderSource((text) => text.trim() === "Skip for now");
        for (let index = 0; index < 8; index++) await flushReact();
        expect(mockAgentsApi.testEnvironment).not.toHaveBeenCalled();
        expect(mockAgentsApi.hire).toHaveBeenCalled();
        expect(JSON.parse(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)!)).toMatchObject({
          adapterType: "claude_local",
        });
      } finally { await act(async () => root.unmount()); }
    });

    it("skips the local sign-in attempt when the customer chooses Skip for now", async () => {
      mockEnvironmentsApi.list.mockResolvedValue([{
        id: "env-local",
        name: "Local",
        driver: "local",
        metadata: { defaultForInstance: true },
        config: {},
      }]);
      localHealth.get.mockResolvedValue({ deploymentMode: "authenticated", localAiLoginSupported: true });
      const root = await openProviderChoices({ adapterType: "claude_local", runner: "legacy" });
      try {
        mockAgentsApi.hire.mockClear();
        await clickProviderSource((text) => text.trim() === "Skip for now");
        for (let index = 0; index < 10; index++) await flushReact();
        expect(document.body.textContent).not.toContain("Prepare local sign-in before connecting.");
        expect(mockAgentsApi.hire).toHaveBeenCalled();
      } finally { await act(async () => root.unmount()); }
    });

    it("requires a new choice when resuming a Copilot draft", async () => {
      const root = await openProviderChoices({
        adapterType: "paperclip_runner", onboardingCopilot: true, model: "copilot-model",
      });
      try {
        expect(document.body.querySelector('button[aria-checked="true"]')).toBeNull();
        expect(document.body.textContent).not.toContain("Connect GitHub Copilot");
        const connect = [...document.body.querySelectorAll("button")].find(button => isArcPrimary(button.textContent?.trim() ?? ""));
        expect(connect?.disabled).toBe(true);
        expect(mockAgentsApi.hire).not.toHaveBeenCalled();
        expect(JSON.parse(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)!)).toMatchObject({
          adapterType: "claude_local", runner: "auto", model: "",
        });
      } finally { await act(async () => root.unmount()); }
    });

    it("clears a saved Gemini model when only Codex is available", async () => {
      mockAdapterRegistry.disabled = new Set(["claude_local"]);
      const root = await openProviderChoices({ adapterType: "gemini_local", model: "gemini-model" });
      try {
        expect(document.body.querySelector('button[aria-checked="true"]')).toBeNull();
        expect(JSON.parse(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)!)).toMatchObject({
          adapterType: "codex_local", model: "",
        });
        expect(mockAgentsApi.hire).not.toHaveBeenCalled();
      } finally { await act(async () => root.unmount()); }
    });

    it.each([false, true])("explains unavailable onboarding providers and clears an old Copilot draft: %s", async savedCopilot => {
      mockAdapterRegistry.disabled = new Set(["claude_local", "codex_local", "opencode_local"]);
      const root = await openProviderChoices(savedCopilot ? {
        adapterType: "paperclip_runner", onboardingCopilot: true, runner: "paperclip", model: "copilot-model",
      } : {});
      try {
        expect(document.body.querySelectorAll("button[aria-checked]")).toHaveLength(0);
        expect(document.body.textContent).toContain("No model provider is enabled on this instance.");
        expect(document.body.textContent).toContain("Skip for now");
        const next = [...document.body.querySelectorAll("button")].find(button => isArcPrimary(button.textContent?.trim() ?? ""));
        expect(next?.disabled).toBe(true);
        expect(mockAgentsApi.hire).not.toHaveBeenCalled();
        const saved = JSON.parse(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)!);
        expect(saved).toMatchObject({ adapterType: "claude_local", runner: "auto", model: "" });
        expect(saved).not.toHaveProperty("onboardingCopilot");
      } finally { await act(async () => root.unmount()); }
    });
  });

  describe("step 1 leads straight to the agent — there is no mission step 2", () => {
    // One path now: Name your organization → Name your agent → Connect → Get
    // started. The Build / Grow front door and both mission screens are gone,
    // so "Continue" on step 1 creates the organization and lands on the agent
    // step with no mission question in between.

    async function openStepOne(savedOverrides: Record<string, unknown> = {}) {
      window.localStorage.setItem(
        ONBOARDING_STORAGE_KEY,
        JSON.stringify({ step: 1, companyName: "Initech", ...savedOverrides }),
      );
      mockDialog.onboardingOptions = {};
      mockCompany.companies = [];
      mockCompany.loading = false;
      mockCompaniesApi.list.mockResolvedValue([]);

      // The model step needs tiles to pick from, and this suite's default
      // registry is empty.
      mockAdapterRegistry.list = [{ type: "claude_local" }, { type: "codex_local" }];
      const { root, queryClient } = render();
      const renderTree = () =>
        renderWizardView(root, queryClient);
      await renderTree();
      await flushReact();
      return { root, renderTree };
    }

    async function clickByText(match: (text: string) => boolean) {
      const el = [...document.body.querySelectorAll("button")].find((b) =>
        match(b.getAttribute("aria-label")?.startsWith("Use ") ? b.getAttribute("aria-label")! : b.textContent?.trim() ?? ""),
      )!;
      await act(async () => {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();
    }

    it("defers the native runner until the name-only setup has a chosen provider", async () => {
      mockCompaniesApi.create.mockResolvedValue({ id: "company-new", issuePrefix: "INI" });
      const { root } = await openStepOne({ adapterType: "codex_local", runner: "paperclip" });
      try {
        await clickByText((text) => text.startsWith("Continue"));
        const field = document.body.querySelector("#onboarding-agent-name") as HTMLInputElement;
        await act(async () => setControlledValue(field, "Chief of Staff"));
        await flushReact();
        await clickByText((text) => isArcPrimary(text));

        expect(document.body.textContent).toContain("Connect a model");
        expect(mockAgentsApi.create).toHaveBeenCalledTimes(1);
        const setup = mockAgentsApi.create.mock.calls[0][1];
        expect(setup).toMatchObject({ adapterType: "process", metadata: { setupAdapterPending: true } });
        expect(setup).not.toHaveProperty("runner");
        expect(mockAgentsApi.hire).not.toHaveBeenCalled();

        await clickByText((text) => /OpenAI.*Subscription/.test(text));
        for (let i = 0; i < 3; i++) await flushReact();
        expect(mockAgentsApi.update).toHaveBeenCalledWith(setup.setupId, expect.objectContaining({
          adapterType: "codex_local", runner: "paperclip", metadata: { setupAdapterPending: false },
        }), "company-new");
        expect(mockAgentsApi.create).toHaveBeenCalledTimes(1);
      } finally {
        await act(async () => root.unmount());
      }
    });

    it("shows no environment-check card on the model step, and no Mission row on review", async () => {
      // Round-3 walk feedback: the adapter environment check still runs —
      // Connect probes before hiring and blocks on a fail — but its idle card
      // (explainer plus "Test now") is gone. And the review checklist lost its
      // "Mission" row: onboarding stopped asking, so the row could only ever
      // render unchecked. Both asserted against positive anchors so an
      // unrendered step cannot pass as an absence.
      mockCompaniesApi.create.mockResolvedValue({ id: "company-new", issuePrefix: "INI" });
      const { root } = await openStepOne();
      await clickByText((t) => t.startsWith("Continue"));

      expect(mockCompaniesApi.create).toHaveBeenCalledWith({ name: "Initech" });
      expect(document.body.textContent).not.toContain("Define your mission");
      expect(document.body.textContent).not.toContain("Tell us about your team");
      expect(document.body.textContent).toContain("Create your first agent");

      // Step 3 → 4 needs an agent name — the one field the step has now.
      const agentField = document.body.querySelector(
        "#onboarding-agent-name",
      ) as HTMLInputElement;
      await act(async () => {
        setControlledValue(agentField, "Ada");
      });
      await flushReact();
      await clickByText((t) => isArcPrimary(t));

      expect(document.body.textContent).toContain("Connect a model");
      await pickFirstSource(clickByText);
      expect(document.body.textContent).not.toContain("Adapter environment check");
      expect(document.body.textContent).not.toContain("Test now");

      // Through Connect to Review, so the Mission-row assertion runs against
      // the checklist that actually renders it — stopping at the model step
      // would let a Mission regression pass unseen.
      await clickByText((t) => isArcPrimary(t));
      // The review step is the heading and the woken agent, nothing else: the
      // checklist that restated the walk in three rows is gone, and with it
      // the Mission row that could only render unchecked.
      expect(document.body.textContent).toContain("Let's get started...");
      expect(document.body.textContent).toContain("Ada is ready to work!");
      expect(document.body.textContent).not.toContain("Organization name");
      expect(document.body.textContent).not.toContain("Model connected");
      expect(document.body.textContent).not.toContain("Mission");

      await act(async () => root.unmount());
    });

    it("adopts an agent the company already has under that name instead of hiring it twice", async () => {
      // The wizard can reopen on the agent step for a company that just got
      // its first agent — the dashboard's agentless offer on a stale list is
      // one way — with nothing in its state to say the hire happened. The
      // server numbers a repeat name, so without this the walk produced
      // "Ada" and "Ada 2". Same name on the same source is the same agent.
      mockDialog.onboardingOptions = {};
      mockCompany.companies = [];
      mockCompany.loading = false;
      mockCompaniesApi.list.mockResolvedValue([]);
      mockCompaniesApi.create.mockResolvedValue({ id: "company-new", issuePrefix: "INI" });
      mockAgentsApi.list.mockResolvedValue([
        { id: "agent-existing", name: "Ada", adapterType: "claude_local" },
      ]);
      mockAdapterRegistry.list = [{ type: "claude_local" }, { type: "codex_local" }];
      const { root, queryClient } = render();
      await renderWizardView(root, queryClient);
      await flushReact();

      const clickText = async (match: (t: string) => boolean) => {
        const el = [...document.body.querySelectorAll("button")].find((b) =>
          match(b.getAttribute("aria-label")?.startsWith("Use ") ? b.getAttribute("aria-label")! : b.textContent?.trim() ?? ""),
        )!;
        await act(async () => {
          el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        await flushReact();
      };

      const nameField = document.body.querySelector(
        "#onboarding-company-name",
      ) as HTMLInputElement | null;
      if (nameField) {
        await act(async () => {
          setControlledValue(nameField, "Initech");
        });
        await flushReact();
      } else {
        const anyName = document.body.querySelector(
          'input[placeholder="e.g. Northwind Labs"]',
        ) as HTMLInputElement;
        await act(async () => {
          setControlledValue(anyName, "Initech");
        });
        await flushReact();
      }
      await clickText((t) => t.startsWith("Continue"));
      const agentField = document.body.querySelector(
        "#onboarding-agent-name",
      ) as HTMLInputElement;
      await act(async () => {
        setControlledValue(agentField, "ada ");
      });
      await flushReact();
      await clickText((t) => isArcPrimary(t));
      await pickFirstSource(clickText);
      await clickText((t) => isArcPrimary(t));

      expect(mockAgentsApi.list).toHaveBeenCalledWith("company-new");
      expect(mockAgentsApi.hire).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain("ada is ready to work!");

      await act(async () => root.unmount());
    });

    it.each([false, true])("shows manual CLI debugging only outside managed Cloud (managed: %s)", async managed => {
      localHealth.get.mockResolvedValue({ deploymentMode: "authenticated", ...(managed ? { cloud: { managed: true, managedBy: "paperclip-cloud" } } : {}) });
      mockAgentsApi.testEnvironment.mockResolvedValue({ adapterType: "claude_local", status: "fail", testedAt: new Date().toISOString(),
        checks: [{ code: "claude_hello_probe_failed", level: "error", message: "The runtime test did not finish.",
          detail: "The provider exited with code 1.",
          hint: "Exit code 1. Run `claude --print - --output-format stream-json --verbose` manually in this directory and prompt `Respond with hello` to debug." }] });
      mockCompaniesApi.create.mockResolvedValue({ id: "company-new", issuePrefix: "INI" });
      const { root } = await openStepOne();
      try {
        await clickByText(t => t.startsWith("Continue"));
        await act(async () => setControlledValue(document.body.querySelector("#onboarding-agent-name") as HTMLInputElement, "Ada"));
        await flushReact();
        await clickByText(isArcPrimary);
        await pickFirstSource(clickByText);
        await clickByText(isArcPrimary);
        expect(document.body.textContent).toContain("The runtime test did not finish.");
        expect(document.body.textContent).toContain("The provider exited with code 1.");
        expect(document.body.textContent?.includes("manually in this directory")).toBe(!managed);
        expect(document.body.textContent?.includes("Manual debug")).toBe(!managed);
        expect(document.body.textContent?.includes("--output-format stream-json")).toBe(!managed);
        expect(document.body.textContent?.includes("Fix the reported checks")).toBe(!managed);
        expect(mockAgentsApi.hire).not.toHaveBeenCalled();
      } finally {
        await act(async () => root.unmount());
      }
    });

    it("hires from a legacy draft that saved an empty role", async () => {
      // `agentRole: ""` was this field's default before the arc stopped asking
      // for a role, so every draft saved by an earlier build carries it. `??`
      // would pass the empty string straight through to the hire's silent
      // return — the same no-op the default exists to prevent, arriving
      // through a restored draft instead of a fresh one.
      window.localStorage.setItem(
        ONBOARDING_STORAGE_KEY,
        JSON.stringify({ step: 1, companyName: "Initech", agentRole: "" }),
      );
      mockDialog.onboardingOptions = {};
      mockCompany.companies = [];
      mockCompany.loading = false;
      mockCompaniesApi.list.mockResolvedValue([]);
      mockCompaniesApi.create.mockResolvedValue({ id: "company-new", issuePrefix: "INI" });

      // The model step needs tiles to pick from, and this suite's default
      // registry is empty.
      mockAdapterRegistry.list = [{ type: "claude_local" }, { type: "codex_local" }];
      const { root, queryClient } = render();
      const renderTree = () =>
        renderWizardView(root, queryClient);
      await renderTree();
      await flushReact();

      const clickText = async (match: (t: string) => boolean) => {
        const el = [...document.body.querySelectorAll("button")].find((b) =>
          match(b.getAttribute("aria-label")?.startsWith("Use ") ? b.getAttribute("aria-label")! : b.textContent?.trim() ?? ""),
        )!;
        await act(async () => {
          el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        await flushReact();
      };

      await clickText((t) => t.startsWith("Continue"));
      const agentField = document.body.querySelector(
        "#onboarding-agent-name",
      ) as HTMLInputElement;
      await act(async () => {
        setControlledValue(agentField, "Ada");
      });
      await flushReact();
      await clickText((t) => isArcPrimary(t));
      await pickFirstSource(clickText);
      await clickText((t) => isArcPrimary(t));

      expect(mockAgentsApi.hire).toHaveBeenCalled();
      // The mock is declared with no parameters, so index the call rather than
      // destructuring a zero-length tuple type.
      const hireArgs = mockAgentsApi.hire.mock.calls.at(-1) as unknown[];
      expect((hireArgs[1] as { role: string }).role).toBe("general");

      await act(async () => root.unmount());
    });

    it("hires one agent when Connect fires twice in one breath", async () => {
      // The Connect handler re-runs a cached failed probe now that "Test now"
      // is gone — so two overlapping submissions could both pass the fresh
      // probe and both hire. `loading` cannot stop the second caller: it is
      // state, unwritten while the first call is still awaiting. The ref
      // guard must make the second submission a no-op.
      let resolveHire: (v: { agent: { id: string }; approval: null }) => void = () => {};
      mockAgentsApi.hire.mockReturnValue(
        new Promise((resolve) => {
          resolveHire = resolve;
        }),
      );
      mockCompaniesApi.create.mockResolvedValue({ id: "company-new", issuePrefix: "INI" });
      const { root } = await openStepOne();
      await clickByText((t) => t.startsWith("Continue"));
      const agentField = document.body.querySelector(
        "#onboarding-agent-name",
      ) as HTMLInputElement;
      await act(async () => {
        setControlledValue(agentField, "Ada");
      });
      await flushReact();
      await clickByText((t) => isArcPrimary(t));
      expect(document.body.textContent).toContain("Connect a model");
      await pickFirstSource(clickByText);

      const connect = [...document.body.querySelectorAll("button")].find((b) =>
        isArcPrimary(b.textContent?.trim() ?? ""),
      )!;
      await act(async () => {
        connect.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        connect.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();
      await act(async () => resolveHire({ agent: { id: "agent-1" }, approval: null }));
      await flushReact();

      expect(mockAgentsApi.hire).toHaveBeenCalledTimes(1);

      await act(async () => root.unmount());
    });

    it("creates one company for one keystroke, modifier or not", async () => {
      // The name field handles Enter itself and does not check for a modifier,
      // so Cmd+Enter in that field reaches the field's handler *and* the
      // wizard's step-level one. Both would start creating. The step-level
      // `loading` guard cannot stop it — `setLoading(true)` has not landed
      // while the same event is still bubbling — so the second caller reads a
      // value the first has not written. Two companies, one keystroke.
      mockCompaniesApi.create.mockResolvedValue({ id: "company-new", issuePrefix: "INI" });
      const { root } = await openStepOne();

      const nameInput = document.body.querySelector(
        'input[placeholder="e.g. Northwind Labs"]',
      ) as HTMLInputElement;
      await act(async () => {
        nameInput.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }),
        );
      });
      await flushReact();

      expect(mockCompaniesApi.create).toHaveBeenCalledTimes(1);
      expect(document.body.textContent).toContain("Create your first agent");

      await act(async () => root.unmount());
    });

    it("creates one company however many times Enter repeats", async () => {
      // Holding Enter down fires keydown repeatedly. Each one is a separate
      // event, so `defaultPrevented` says nothing about the others, and neither
      // `loading` nor `createdCompanyId` has been written by the time the next
      // arrives — the first is state, the second is not set until the request
      // it guards resolves. Only a ref written before the request goes out is
      // visible to the caller behind it.
      let resolveCreate: (c: { id: string; issuePrefix: string }) => void = () => {};
      mockCompaniesApi.create.mockReturnValue(
        new Promise<{ id: string; issuePrefix: string }>((resolve) => {
          resolveCreate = resolve;
        }),
      );
      const { root } = await openStepOne();

      const nameInput = document.body.querySelector(
        'input[placeholder="e.g. Northwind Labs"]',
      ) as HTMLInputElement;
      await act(async () => {
        for (let i = 0; i < 4; i++) {
          nameInput.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
          );
        }
      });

      expect(mockCompaniesApi.create).toHaveBeenCalledTimes(1);

      await act(async () => resolveCreate({ id: "company-new", issuePrefix: "INI" }));
      await flushReact();
      expect(document.body.textContent).toContain("Create your first agent");

      await act(async () => root.unmount());
    });

    it("sends Back to the screen the run actually came from", async () => {
      // A create run reached the agent step from step 1, so Back owes it step 1 —
      // not the mission screen it never saw.
      mockCompaniesApi.create.mockResolvedValue({ id: "company-new", issuePrefix: "INI" });
      const { root } = await openStepOne();
      await clickByText((t) => t.startsWith("Continue"));
      expect(document.body.textContent).toContain("Create your first agent");

      await clickByText((t) => t.includes("Back"));

      expect(document.body.textContent).toContain("What is the name of your organization?");
      expect(document.body.textContent).not.toContain("Define your mission");

      await act(async () => root.unmount());
    });
  });
});
