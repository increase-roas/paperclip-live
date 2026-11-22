// @vitest-environment jsdom

import { act } from "react";
import { ONBOARDING_CONNECTION_TEST_TIMEOUT_MS } from "../lib/onboarding-connection-test";
import { buildClaudeLocalConfig } from "../../../packages/adapters/claude-local/src/ui/build-config";
import { buildCodexRunnerConfig } from "../adapters/codex-local/config-fields";
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
import { getEnvironmentCapabilities } from "@paperclipai/shared";

import { ONBOARDING_STORAGE_KEY, OnboardingWizard } from "./OnboardingWizard";

import { TooltipProvider } from "./ui/tooltip";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** React tracks input value on the DOM node; set it the way React will see. */
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
describe("OnboardingWizard subscription verification", () => {
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

  describe("the adapter step login panel (cheap auth signal, no adapter test) — subscription verification", () => {
    const SANDBOX_ENVIRONMENT = {
      id: "env-sandbox-1",
      driver: "sandbox" as const,
      status: "active" as const,
      config: { provider: "daytona" },
      metadata: {},
    };

    const LOCAL_ENVIRONMENT = {
      id: "env-local-1",
      driver: "local" as const,
      status: "active" as const,
      config: { provider: "daytona" },
      metadata: { defaultForInstance: true },
    };

    beforeEach(() => {
      mockEnvironmentsApi.list.mockReset();
      mockEnvironmentsApi.probe.mockReset().mockResolvedValue({ ok: true, driver: "sandbox", summary: "Measured image",
        details: { platformQualificationRecorded: true, leaseId: "owned-platform-lease" } });
      mockEnvironmentsApi.list.mockResolvedValue([SANDBOX_ENVIRONMENT]);
      mockEnvironmentsApi.capabilities.mockReset();
      mockEnvironmentsApi.capabilities.mockResolvedValue(
        getEnvironmentCapabilities([], {
          sandboxProviders: { daytona: { supportsLoginPty: true } },
        }),
      );
      mockInstanceSettingsApi.get.mockReset();
      mockInstanceSettingsApi.get.mockResolvedValue({ defaultEnvironmentId: "env-sandbox-1" });
      mockInstanceSettingsApi.getExperimental.mockReset();
      mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableManagedSandboxOnly: false });
      mockAgentsApi.getAdapterAuthSignal.mockReset();
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "present" });
      // The row has to actually offer the adapter these drafts name. The login
      // panel lives inside the input canvas, and the canvas opens for a chosen
      // source — a saved adapter the row cannot show is not a chosen one, so
      // without this the panel is absent for a reason that has nothing to do
      // with the auth signal these tests are about.
      mockAdapterRegistry.list = [{ type: "claude_local" }, { type: "codex_local" }];
    });

    /** Drives the wizard to the Connect step with a company already created. */
    async function openStep4(overrides: Record<string, unknown> = {}, staleTime = 0) {
      mockCompany.companies = [{ id: "company-new", name: "Initech", issuePrefix: "INI" }];
      mockCompany.loading = false;
      mockCompaniesApi.list.mockResolvedValue(mockCompany.companies);
      window.localStorage.setItem(
        ONBOARDING_STORAGE_KEY,
        JSON.stringify({
          step: 4,
          companyName: "Initech",
          agentName: "Ada",
          createdCompanyId: "company-new",
          adapterType: "claude_local",
          ...overrides,
        }),
      );
      mockDialog.onboardingOptions = {};

      const { root, queryClient } = render(staleTime);
      await renderWizardView(root, queryClient);
      // The login-panel gate chains several dependent queries (environments,
      // instance settings, environment capabilities, then the auth signal
      // itself), each settling on its own render. One flush is not always
      // enough to reach the end of that chain.
      for (let i = 0; i < 5; i++) await flushReact();
      expect(document.body.textContent).toContain("Connect a model");
      // No pick needed here: the draft this helper restores already names an
      // adapter, which is what a run returning to this step actually carries.
      return { root, queryClient };
    }

    /**
     * Press a source tile. This is what starts the sign-in — the row is the
     * question, and answering it is the whole of the trigger. Nothing is
     * selected on arrival, including from a draft that names an adapter.
     */
    async function pickSource(match: RegExp) {
      const tile = [...document.body.querySelectorAll('[role="radio"]')].find((t) =>
        match.test(t.textContent ?? ""),
      );
      expect(tile, "the row should offer that source").toBeTruthy();
      await act(async () => {
        tile!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      for (let i = 0; i < 10; i++) await flushReact();
    }

    describe("automatic subscription verification", () => {
      const providers = [
        ["claude_local", "anthropic", /Claude/],
        ["codex_local", "openai", /OpenAI/],
      ] as const;
      const passed = { adapterType: "codex_local", status: "pass" as const, checks: [], testedAt: new Date().toISOString() };

      beforeEach(() => {
        localHealth.get.mockResolvedValue({ deploymentMode: "local_trusted" });
        mockEnvironmentsApi.list.mockResolvedValue([LOCAL_ENVIRONMENT]);
        mockInstanceSettingsApi.get.mockResolvedValue({ defaultEnvironmentId: null });
      });

      async function settle() {
        for (let i = 0; i < 10; i++) await flushReact();
      }
      function button(label: string) {
        const found = [...document.body.querySelectorAll("button")].find(b => b.textContent?.trim() === label);
        expect(found, label).toBeTruthy();
        return found!;
      }
      async function click(label: string) {
        await act(async () => button(label).click());
        await settle();
      }
      async function detected() {
        managedApi.checkLocalLogin.mockResolvedValue({ status: "ready" });
        await act(async () => window.dispatchEvent(new Event("focus")));
        await settle();
      }
      function expectTesting() {
        expect(button("Testing…").disabled).toBe(true);
        expect(button("Testing…").querySelector("svg.animate-spin")).not.toBeNull();
        expect([...document.body.querySelectorAll('[role="status"]')].some(e => e.textContent === "Testing connection…")).toBe(true);
        expect(document.body.querySelector('[aria-label="Saved subscription"]')).toBeNull();
        expect(document.body.textContent).not.toContain("Run this in a terminal");
        expect(document.body.textContent).not.toContain("Start sign-in again");
      }

      it.each(providers.flatMap(([adapterType, provider, source]) =>
        (["paperclip", "legacy"] as const).map(defaultRunner => ({ adapterType, provider, source, defaultRunner })),
      ))("waits for $adapterType discovery before verification and keeps $defaultRunner routing automatic", async ({ adapterType, provider, source, defaultRunner }) => {
        let finish!: (value: import("../api/adapters").AdapterInfo[]) => void;
        mockAdaptersApi.list.mockReturnValue(new Promise<import("../api/adapters").AdapterInfo[]>(resolve => { finish = resolve; }));
        mockAdapterBuild.buildAdapterConfig.mockImplementation(values => adapterType === "claude_local"
          ? buildClaudeLocalConfig(values!) : buildCodexRunnerConfig(values!));
        const { root, queryClient } = await openStep4({ adapterType });
        try {
          await act(async () => queryClient.setQueryData(["ai-connections", "company-new"], {
            currentUserId: "user-1", connections: [{ id: "saved", grantId: "grant", companyId: "company-new", provider, method: "subscription", ownership: "personal", ownerUserId: "user-1", status: "connected", isDefault: true }],
          }));
          await pickSource(source);
          await settle();
          expect(document.body.querySelector('[aria-label="Runner"]')).toBeNull();
          expect([...document.body.querySelectorAll("summary")].some(summary => summary.textContent === "Advanced")).toBe(false);
          expect(button("Connect").disabled).toBe(true);
          await act(async () => button("Connect").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true })));
          await settle();
          expect(mockAgentsApi.testEnvironment).not.toHaveBeenCalled();
          expect(mockAgentsApi.hire).not.toHaveBeenCalled();
          await act(async () => finish([setupAdapterInfo({ type: adapterType, defaultRunner, supportedRunners: defaultRunner === "paperclip" ? ["paperclip", "legacy"] : ["legacy"] })]));
          await settle();
          expect(mockAgentsApi.testEnvironment).toHaveBeenCalledTimes(1);
          expect(mockAgentsApi.hire).toHaveBeenCalledTimes(1);
          const tested = mockAgentsApi.testEnvironment.mock.calls[0] as unknown as [string, string, { adapterConfig: Record<string, unknown> }];
          const hired = mockAgentsApi.hire.mock.calls[0] as unknown as [string, { adapterConfig: Record<string, unknown> }];
          expect(mockAdapterBuild.buildAdapterConfig).toHaveBeenCalledWith(expect.objectContaining({ adapterType, runner: "auto", resolvedRunner: defaultRunner }));
          expect(tested[1]).toBe(adapterType);
          expect(tested[2]).not.toHaveProperty("runner");
          expect(hired[1]).toMatchObject({ adapterType, onboardingFirstAgent: true });
          expect(hired[1]).not.toHaveProperty("runner");
          expect(hired[1].adapterConfig).toEqual(tested[2].adapterConfig);
          if (adapterType === "claude_local") {
            if (defaultRunner === "paperclip") expect(hired[1].adapterConfig).not.toHaveProperty("maxTurnsPerRun");
            else expect(hired[1].adapterConfig.maxTurnsPerRun).toBe(1000);
          }
          expect(hired[1].adapterConfig).not.toHaveProperty("resolvedRunner");
        } finally { await act(async () => root.unmount()); }
      });

      it.each(["environments", "settings", "policy"] as const)("does not use warm Claude discovery before %s resolves", async pending => {
        let finish!: (value: any) => void;
        const delayed = new Promise<any>(resolve => { finish = resolve; });
        if (pending === "environments") mockEnvironmentsApi.list.mockReturnValue(delayed);
        else if (pending === "settings") mockInstanceSettingsApi.get.mockReturnValue(delayed);
        else mockInstanceSettingsApi.getExperimental.mockReturnValue(delayed);
        mockAdapterBuild.buildAdapterConfig.mockImplementation(values => buildClaudeLocalConfig(values!));
        const { root, queryClient } = await openStep4({ adapterType: "claude_local" });
        try {
          await act(async () => {
            if (pending === "environments") queryClient.setQueryData(queryKeys.environments.list("company-new"), [LOCAL_ENVIRONMENT]);
            else if (pending === "settings") queryClient.setQueryData(queryKeys.instance.settings, { defaultEnvironmentId: null });
            else queryClient.setQueryData(queryKeys.instance.experimentalSettings, { enableManagedSandboxOnly: false });
            for (const environmentId of [null, LOCAL_ENVIRONMENT.id]) queryClient.setQueryData(queryKeys.adapters.availability("company-new", environmentId), [{ type: "claude_local", defaultRunner: "paperclip" }]);
            queryClient.setQueryData(["ai-connections", "company-new"], { currentUserId: "user-1", connections: [{ id: "saved", grantId: "grant", companyId: "company-new", provider: "anthropic", method: "subscription", ownership: "personal", ownerUserId: "user-1", status: "connected", isDefault: true }] });
          });
          await pickSource(/Claude/);
          await settle();
          expect(mockAdapterBuild.buildAdapterConfig).not.toHaveBeenCalled();
          expect(mockAgentsApi.testEnvironment).not.toHaveBeenCalled();
          expect(mockAgentsApi.hire).not.toHaveBeenCalled();
          await act(async () => finish(pending === "environments" ? [LOCAL_ENVIRONMENT] : pending === "settings" ? { defaultEnvironmentId: null } : { enableManagedSandboxOnly: false }));
          await settle();
          expect(mockAgentsApi.hire).toHaveBeenCalledTimes(1);
          const hired = mockAgentsApi.hire.mock.calls[0] as unknown as [string, { adapterConfig: Record<string, unknown> }];
          expect(hired[1].adapterConfig.maxTurnsPerRun).toBe(1000);
        } finally { await act(async () => root.unmount()); }
      });

      it.each(["environments", "settings", "policy"] as const)("reports failed Claude %s resolution and retries without early verification", async failed => {
        if (failed === "environments") mockEnvironmentsApi.list.mockRejectedValue(new Error("Unavailable"));
        else if (failed === "settings") mockInstanceSettingsApi.get.mockRejectedValue(new Error("Unavailable"));
        else mockInstanceSettingsApi.getExperimental.mockRejectedValue(new Error("Unavailable"));
        const { root, queryClient } = await openStep4({ adapterType: "claude_local" });
        try {
          await act(async () => queryClient.setQueryData(["ai-connections", "company-new"], { currentUserId: "user-1", connections: [{ id: "saved", grantId: "grant", companyId: "company-new", provider: "anthropic", method: "subscription", ownership: "personal", ownerUserId: "user-1", status: "connected", isDefault: true }] }));
          await pickSource(/Claude/);
          await settle();
          expect(document.body.textContent).toContain("Could not load execution environment settings");
          expect(mockAgentsApi.testEnvironment).not.toHaveBeenCalled();
          expect(mockAgentsApi.hire).not.toHaveBeenCalled();
          mockEnvironmentsApi.list.mockResolvedValue([LOCAL_ENVIRONMENT]);
          mockInstanceSettingsApi.get.mockResolvedValue({ defaultEnvironmentId: null });
          mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableManagedSandboxOnly: false });
          await click("Retry setup");
          expect(mockAgentsApi.testEnvironment).toHaveBeenCalledTimes(1);
          expect(mockAgentsApi.hire).toHaveBeenCalledTimes(1);
        } finally { await act(async () => root.unmount()); }
      });

      it("does not hire from obsolete Claude discovery after the target changes during verification", async () => {
        mockAdapterBuild.buildAdapterConfig.mockImplementation(values => buildClaudeLocalConfig(values!));
        mockAdaptersApi.list.mockImplementation(async context => [setupAdapterInfo({ type: "claude_local", defaultRunner: context?.environmentId === "new-local-default" ? "paperclip" : "legacy" })]);
        const finishes: Array<(value: typeof passed) => void> = [];
        mockAgentsApi.testEnvironment.mockImplementation(() => new Promise(resolve => finishes.push(resolve)));
        const { root, queryClient } = await openStep4({ adapterType: "claude_local" });
        try {
          await pickSource(/Claude/);
          await detected();
          expect(mockAgentsApi.testEnvironment).toHaveBeenCalledTimes(1);
          await act(async () => queryClient.setQueryData(queryKeys.environments.list("company-new"), [{ ...LOCAL_ENVIRONMENT, id: "new-local-default" }]));
          await settle();
          expect(mockAgentsApi.testEnvironment).toHaveBeenCalledTimes(1);
          await act(async () => finishes[0](passed));
          await settle();
          expect(mockAgentsApi.hire).not.toHaveBeenCalled();
          expect(mockAgentsApi.testEnvironment).toHaveBeenCalledTimes(1);
          expect(document.body.textContent).toContain("Configuration changed during setup");
          await click("Connect");
          expect(mockAgentsApi.testEnvironment).toHaveBeenCalledTimes(2);
          await act(async () => finishes[1](passed));
          await settle();
          expect(mockAgentsApi.hire).toHaveBeenCalledTimes(1);
          const tested = mockAgentsApi.testEnvironment.mock.calls as unknown as Array<[string, string, { environmentId: string; adapterConfig: Record<string, unknown> }]>;
          expect(tested[0][2].adapterConfig.maxTurnsPerRun).toBe(1000);
          expect(tested[1][2].environmentId).toBe("new-local-default");
          expect(tested[1][2].adapterConfig).not.toHaveProperty("maxTurnsPerRun");
          const hired = mockAgentsApi.hire.mock.calls[0] as unknown as [string, { adapterConfig: Record<string, unknown> }];
          expect(hired[1].adapterConfig).toEqual(tested[1][2].adapterConfig);
        } finally { await act(async () => root.unmount()); }
      });

      it("unlocks Claude setup when automatic runner availability changes during verification", async () => {
        mockAdapterBuild.buildAdapterConfig.mockImplementation(values => buildClaudeLocalConfig(values!));
        mockAdaptersApi.list.mockResolvedValue([setupAdapterInfo({ type: "claude_local", defaultRunner: "paperclip" })]);
        const finishes: Array<(value: typeof passed) => void> = [];
        mockAgentsApi.testEnvironment.mockImplementation(() => new Promise(resolve => finishes.push(resolve)));
        const { root, queryClient } = await openStep4({ adapterType: "claude_local" });
        try {
          await pickSource(/Claude/);
          await detected();
          expect(mockAgentsApi.testEnvironment).toHaveBeenCalledTimes(1);
          expectTesting();
          mockAdaptersApi.list.mockResolvedValue([setupAdapterInfo({ type: "claude_local", defaultRunner: "legacy" })]);
          await act(async () => queryClient.setQueryData(queryKeys.adapters.availability("company-new", LOCAL_ENVIRONMENT.id), [setupAdapterInfo({ type: "claude_local", defaultRunner: "legacy" })]));
          await settle();
          expect(document.body.textContent).toContain("Configuration changed during setup");
          expect(button("Connect").disabled).toBe(false);
          expect(mockAgentsApi.testEnvironment).toHaveBeenCalledTimes(1);
          await act(async () => finishes[0](passed));
          await settle();
          expect(mockAgentsApi.hire).not.toHaveBeenCalled();
          await click("Connect");
          expect(mockAgentsApi.testEnvironment).toHaveBeenCalledTimes(2);
          await act(async () => finishes[1](passed));
          await settle();
          expect(mockAgentsApi.hire).toHaveBeenCalledTimes(1);
          const hired = mockAgentsApi.hire.mock.calls[0] as unknown as [string, { adapterConfig: Record<string, unknown> }];
          expect(hired[1].adapterConfig.maxTurnsPerRun).toBe(1000);
        } finally { await act(async () => root.unmount()); }
      });

      it("fails closed on Claude discovery rejection and retries availability before verification", async () => {
        mockAdaptersApi.list.mockRejectedValue(new Error("Discovery unavailable"));
        const { root, queryClient } = await openStep4({ adapterType: "claude_local" });
        try {
          await act(async () => queryClient.setQueryData(["ai-connections", "company-new"], {
            currentUserId: "user-1", connections: [{ id: "saved", grantId: "grant", companyId: "company-new", provider: "anthropic", method: "subscription", ownership: "personal", ownerUserId: "user-1", status: "connected", isDefault: true }],
          }));
          await pickSource(/Claude/);
          await settle();
          expect(mockAgentsApi.testEnvironment).not.toHaveBeenCalled();
          expect(mockAgentsApi.hire).not.toHaveBeenCalled();
          expect(document.body.textContent).toContain("Could not load runner availability");
          mockAdaptersApi.list.mockResolvedValue([setupAdapterInfo({ type: "claude_local", defaultRunner: "paperclip" })]);
          await click("Retry setup");
          expect(mockAgentsApi.testEnvironment).toHaveBeenCalledTimes(1);
          expect(mockAgentsApi.hire).toHaveBeenCalledTimes(1);
        } finally { await act(async () => root.unmount()); }
      });

      it.each(providers)("automatically verifies detected %s once through connection refreshes and advances", async (adapterType, provider, label) => {
        let finish!: (result: typeof passed) => void;
        mockAgentsApi.testEnvironment.mockReturnValue(new Promise(resolve => { finish = resolve; }));
        const { root, queryClient } = await openStep4({ adapterType });
        try {
          await pickSource(label);
          expect(document.body.textContent).toContain("Sign in to");
          expect(document.body.textContent).not.toContain("Run this in a terminal");
          expect(button("Connect").disabled).toBe(false);
          await detected();
          expectTesting();
          // The saved account can become visible while its hello test is pending.
          await act(async () => {
            queryClient.setQueryData(["ai-connections", "company-new"], {
              currentUserId: "user-1",
              connections: [{ id: "local-connection", grantId: "local-grant", companyId: "company-new", provider, method: "subscription", name: "My subscription", ownership: "personal", ownerUserId: "user-1", status: "connected", isDefault: true }],
            });
            window.dispatchEvent(new Event("focus"));
          });
          await settle();
          expectTesting();
          expect(managedApi.connectLocal).toHaveBeenCalledTimes(1);
          expect(mockAgentsApi.testEnvironment).toHaveBeenCalledTimes(1);
          expect(mockAgentsApi.hire).not.toHaveBeenCalled();
          await act(async () => finish(passed));
          await settle();
          expect(document.body.textContent).toContain("is ready to work!");
          expect(mockAgentsApi.hire).toHaveBeenCalledTimes(1);
          expect(mockAgentsApi.hire).toHaveBeenCalledWith("company-new", expect.objectContaining({ runtimeConfig: expect.objectContaining({ aiConnection: { provider, method: "subscription", mode: "responsible_user" } }) }));
        } finally { await act(async () => root.unmount()); }
      });

      it.each(providers)("automatically verifies a saved %s subscription only after selecting its provider", async (adapterType, provider, label) => {
        const { root, queryClient } = await openStep4({ adapterType });
        try {
          await act(async () => queryClient.setQueryData(["ai-connections", "company-new"], {
            currentUserId: "user-1",
            connections: [{ id: "saved", grantId: "grant", companyId: "company-new", provider, method: "subscription", name: "My subscription", ownership: "personal", ownerUserId: "user-1", status: "connected", isDefault: true }],
          }));
          await settle();
          expect(mockAgentsApi.testEnvironment).not.toHaveBeenCalled();
          await pickSource(label);
          await settle();
          expect(mockAgentsApi.testEnvironment).toHaveBeenCalledTimes(1);
          expect(managedApi.connectLocal).not.toHaveBeenCalled();
          expect(document.body.textContent).toContain("is ready to work!");
        } finally { await act(async () => root.unmount()); }
      });

      it.each(providers)("prefers the personal default %s subscription over an earlier shared account", async (adapterType, provider, label) => {
        const { root, queryClient } = await openStep4({ adapterType });
        try {
          await act(async () => queryClient.setQueryData(["ai-connections", "company-new"], {
            currentUserId: "user-1",
            connections: [
              { id: "shared", grantId: "shared-grant", companyId: "company-new", provider, method: "subscription", name: "Shared", ownership: "shared", status: "connected" },
              { id: "personal", grantId: "personal-grant", companyId: "company-new", provider, method: "subscription", name: "Personal", ownership: "personal", ownerUserId: "user-1", status: "connected", isDefault: true },
            ],
          }));
          await pickSource(label);
          await settle();
          expect(mockAgentsApi.hire).toHaveBeenCalledWith("company-new", expect.objectContaining({
            runtimeConfig: expect.objectContaining({ aiConnection: { provider, method: "subscription", mode: "responsible_user" } }),
          }));
          expect(managedApi.connectLocal).not.toHaveBeenCalled();
        } finally { await act(async () => root.unmount()); }
      });

      it.each(providers)("does not choose an arbitrary %s account when several shared subscriptions exist", async (adapterType, provider, label) => {
        const { root, queryClient } = await openStep4({ adapterType });
        try {
          await act(async () => queryClient.setQueryData(["ai-connections", "company-new"], {
            currentUserId: "user-1",
            connections: ["first", "second"].map(id => ({ id, grantId: `${id}-grant`, companyId: "company-new", provider, method: "subscription", name: id, ownership: "shared", status: "connected" })),
          }));
          await pickSource(label);
          await settle();
          expect(mockAgentsApi.testEnvironment).not.toHaveBeenCalled();
          expect(mockAgentsApi.hire).not.toHaveBeenCalled();
          expect(document.body.textContent).toContain("Sign in to");
          expect(button("Connect").disabled).toBe(false);
        } finally { await act(async () => root.unmount()); }
      });

      it.each(providers)("keeps %s verification pending through environment query updates", async (adapterType, _provider, label) => {
        let finish!: (result: typeof passed) => void;
        mockAgentsApi.testEnvironment.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
        const { root, queryClient } = await openStep4({ adapterType });
        try {
          await pickSource(label);
          await detected();
          expectTesting();
          await act(async () => queryClient.setQueryData(queryKeys.environments.list("company-new"), [
            { ...LOCAL_ENVIRONMENT, name: "Refreshed local environment" },
          ]));
          await settle();
          expectTesting();
          expect(mockAgentsApi.testEnvironment).toHaveBeenCalledTimes(1);
          expect(mockAgentsApi.hire).not.toHaveBeenCalled();
          await act(async () => finish(passed));
          await settle();
          expect(mockAgentsApi.hire).toHaveBeenCalledTimes(1);
          expect(document.body.textContent).toContain("is ready to work!");
        } finally { await act(async () => root.unmount()); }
      });

      it.each(["back", "unmount"] as const)("ignores an already-submitted hire response after %s", async navigation => {
        let finishHire!: (value: { agent: { id: string }; approval: null }) => void;
        mockAgentsApi.hire.mockReturnValueOnce(new Promise(resolve => { finishHire = resolve; }));
        const { root } = await openStep4({ adapterType: "codex_local" });
        let mounted = true;
        try {
          await pickSource(/OpenAI/);
          await detected();
          expect(mockAgentsApi.hire).toHaveBeenCalledTimes(1);
          if (navigation === "back") await click("Back");
          else {
            await act(async () => root.unmount());
            mounted = false;
          }
          await act(async () => finishHire({ agent: { id: "agent-1" }, approval: null }));
          await settle();
          expect(mockAgentsApi.hire).toHaveBeenCalledTimes(1);
          expect(document.body.textContent).not.toContain("is ready to work!");
        } finally { if (mounted) await act(async () => root.unmount()); }
      });

      it.each(providers)("offers a manual retry after failed %s verification without signing in again", async (adapterType, _provider, label) => {
        mockAgentsApi.testEnvironment.mockRejectedValueOnce(new Error("Provider request timed out. Try again."));
        const { root } = await openStep4({ adapterType });
        try {
          await pickSource(label);
          await detected();
          expect(document.body.textContent).toContain("Provider request timed out. Try again.");
          expect(button("Connect").disabled).toBe(false);
          await detected();
          expect(mockAgentsApi.testEnvironment).toHaveBeenCalledTimes(1);
          expect(mockAgentsApi.hire).not.toHaveBeenCalled();
          await click("Connect");
          expect(mockAgentsApi.testEnvironment).toHaveBeenCalledTimes(2);
          expect(managedApi.connectLocal).toHaveBeenCalledTimes(1);
          expect(document.body.textContent).toContain("is ready to work!");
        } finally { await act(async () => root.unmount()); }
      });

      it("releases a hung test, ignores its late result, and retries with the saved login", async () => {
        let finish!: (result: typeof passed) => void;
        mockAgentsApi.testEnvironment.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
        const timerSpy = vi.spyOn(globalThis, "setTimeout");
        const { root } = await openStep4({ adapterType: "claude_local" });
        try {
          await pickSource(/Claude/);
          await detected();
          expectTesting();
          const deadline = timerSpy.mock.calls.find(([, ms]) => ms === ONBOARDING_CONNECTION_TEST_TIMEOUT_MS);
          expect(deadline).toBeDefined();
          const options = (mockAgentsApi.testEnvironment.mock.calls[0] as unknown[])[3] as { signal: AbortSignal };
          await act(async () => (deadline![0] as () => void)());
          await settle();
          expect(options.signal.aborted).toBe(true);
          expect(document.body.textContent).toContain("The connection test took too long.");
          expect(button("Connect").disabled).toBe(false);
          await act(async () => finish(passed));
          await settle();
          expect(mockAgentsApi.hire).not.toHaveBeenCalled();
          await click("Connect");
          expect(mockAgentsApi.testEnvironment).toHaveBeenCalledTimes(2);
          expect(managedApi.connectLocal).toHaveBeenCalledTimes(1);
          expect(mockAgentsApi.hire).toHaveBeenCalledTimes(1);
          expect(document.body.textContent).toContain("is ready to work!");
        } finally {
          timerSpy.mockRestore();
          await act(async () => root.unmount());
        }
      });

      it.each(providers)("keeps Connect usable when %s detection has not completed", async (adapterType, _provider, label) => {
        const { root } = await openStep4({ adapterType });
        try {
          await pickSource(label);
          expect(mockAgentsApi.testEnvironment).not.toHaveBeenCalled();
          await click("Connect");
          expect(managedApi.connectLocal).toHaveBeenCalledTimes(1);
          expect(mockAgentsApi.testEnvironment).toHaveBeenCalledTimes(1);
          expect(document.body.textContent).toContain("is ready to work!");
        } finally { await act(async () => root.unmount()); }
      });

      it("shows Connecting while saving, then Testing while verifying", async () => {
        let saved!: (result: { connectionId: string; grantId: string }) => void;
        managedApi.connectLocal.mockReturnValue(new Promise(resolve => { saved = resolve; }));
        mockAgentsApi.testEnvironment.mockReturnValue(new Promise(() => {}));
        const { root } = await openStep4({ adapterType: "codex_local" });
        try {
          await pickSource(/OpenAI/);
          await detected();
          expect(button("Connecting…").disabled).toBe(true);
          expect(document.body.textContent).not.toContain("Run this in a terminal");
          await act(async () => saved({ connectionId: "local-connection", grantId: "local-grant" }));
          await settle();
          expectTesting();
        } finally { await act(async () => root.unmount()); }
      });

      it.each(["back", "provider", "company", "unmount"] as const)("ignores verification completion after %s navigation", async navigation => {
        let finish!: (result: typeof passed) => void;
        mockAgentsApi.testEnvironment.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
        const { root, queryClient } = await openStep4({ adapterType: "codex_local" });
        let mounted = true;
        try {
          await pickSource(/OpenAI/);
          await detected();
          expectTesting();
          if (navigation === "company") {
            mockCompany.companies.push({ id: "company-other", name: "Other", issuePrefix: "OTH" });
            mockDialog.onboardingOptions = { initialStep: 4, companyId: "company-other" };
            managedApi.checkLocalLogin.mockResolvedValue({ status: "sign_in_required" });
            await act(async () => root.render(<QueryClientProvider client={queryClient}><OnboardingWizard /></QueryClientProvider>));
            await settle();
          } else if (navigation === "unmount") {
            await act(async () => root.unmount());
            mounted = false;
          } else {
            await click("Back");
            if (navigation === "provider") {
              managedApi.checkLocalLogin.mockResolvedValue({ status: "sign_in_required" });
              await pickSource(/Claude/);
            }
          }
          await act(async () => finish(passed));
          await settle();
          expect(mockAgentsApi.hire).not.toHaveBeenCalled();
          expect(document.body.textContent).not.toContain("is ready to work!");
          if (navigation === "provider") expect(document.body.textContent).toContain("Preparing browser sign-in");
        } finally { if (mounted) await act(async () => root.unmount()); }
      });
    });

    it("does not offer Gemini from a saved initial onboarding draft", async () => {
      localHealth.get.mockResolvedValue({ deploymentMode: "local_trusted" });
      mockEnvironmentsApi.list.mockResolvedValue([LOCAL_ENVIRONMENT]);
      mockInstanceSettingsApi.get.mockResolvedValue({ defaultEnvironmentId: null });
      mockAdapterRegistry.list.push({ type: "gemini_local", recommended: true });
      const { root } = await openStep4({ adapterType: "gemini_local" });
      try {
        const sources = [...document.body.querySelectorAll("button[aria-checked]")];
        expect(sources).toHaveLength(2);
        expect(sources.some(source => /Gemini|Google|gemini_local/.test(source.textContent ?? ""))).toBe(false);
        expect(document.body.querySelector('button[aria-checked="true"]')).toBeNull();
        expect(managedApi.startLocalLogin).not.toHaveBeenCalled();
        expect(managedApi.connectLocal).not.toHaveBeenCalled();
        expect(document.body.textContent).not.toContain("claude auth login");
        expect(mockAgentsApi.startClaudeSetupTokenLogin).not.toHaveBeenCalled();
      } finally { await act(async () => root.unmount()); }
    });

    it("shows the Claude browser sign-in card and saves its connection before hiring", async () => {
      localHealth.get.mockResolvedValue({ deploymentMode: "local_trusted" });
      mockEnvironmentsApi.list.mockResolvedValue([LOCAL_ENVIRONMENT]);
      mockInstanceSettingsApi.get.mockResolvedValue({ defaultEnvironmentId: null });
      const { root } = await openStep4({ adapterType: "claude_local" });
      await pickSource(/Claude/);
      expect(document.body.textContent).toContain("Sign in to Claude then come back and enter authorization code");
      expect(document.body.textContent).not.toContain("claude auth login");
      expect(document.body.textContent).not.toContain("No managed sandbox");
      expect(mockAgentsApi.startClaudeSetupTokenLogin).not.toHaveBeenCalled();
      const connect = [...document.body.querySelectorAll("button")].find(b => b.textContent?.trim().startsWith("Connect"));
      expect(connect).toBeTruthy();
      await act(async () => connect!.click());
      for (let i = 0; i < 6; i++) await flushReact();
      expect(managedApi.connectLocal).toHaveBeenCalledWith("company-new", expect.objectContaining({ provider: "anthropic", method: "subscription", ownership: "personal" }));
      expect(mockAgentsApi.hire).toHaveBeenCalled();
      const hire = (mockAgentsApi.hire.mock.calls.at(-1) as unknown[])[1] as { runtimeConfig: { aiConnection: unknown } };
      expect(hire.runtimeConfig.aiConnection).toEqual({ provider: "anthropic", method: "subscription", mode: "responsible_user" });
      await act(async () => root.unmount());
    });

    it("hides the panel when the resolved login environment driver is not sandbox", async () => {
      mockEnvironmentsApi.list.mockResolvedValue([LOCAL_ENVIRONMENT]);
      mockInstanceSettingsApi.get.mockResolvedValue({ defaultEnvironmentId: null });
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
      const { root } = await openStep4({ adapterType: "claude_local" });
      expect(document.body.textContent).not.toContain("Sign in to Anthropic");
      expect(mockAgentsApi.getAdapterAuthSignal).not.toHaveBeenCalled();
      await act(async () => root.unmount());
    });

    it("restores the started-login state after a reload, resuming the active session with no press", async () => {
      // A reload loses `connectPhase` — the draft deliberately does not carry
      // it, because a login is a live server session with a deadline, not
      // wizard state to replay blindly. The step must instead re-derive it
      // from the caller's active session, so a customer who reloads mid-login
      // sees their sign-in still running rather than the tile row again.
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
      mockAgentsApi.getActiveClaudeSetupTokenLoginSession.mockResolvedValue({
        sessionId: "claude-session-1",
        environmentId: "env-sandbox-1",
        status: "waiting_for_user",
        expiresAt: null,
        failure: null,
        panelMode: "submitted_browser_code",
        aiConnection: { provider: "anthropic", method: "subscription", ownership: "personal", agentIds: [], allAgents: true },
        prompt: { authorizationUrl: "https://claude.ai/oauth/authorize?code=true" },
      });
      const { root } = await openStep4({ adapterType: "claude_local" });
      // A reload's resume now runs one layer deeper than a fresh press: the
      // step's own active-session read has to land before it opens the
      // sequence, and only then does the mounted panel run its own resume
      // read. Each is a further round trip `flushReact` has to catch up to.
      for (let i = 0; i < 10; i += 1) await flushReact();

      // No press: the resumed session is discovered on load and the card
      // shows the login already running.
      expect(mockAgentsApi.startClaudeSetupTokenLogin).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain(
        "Sign in to Claude then come back and enter authorization code",
      );

      await act(async () => root.unmount());
    });
  });
});
