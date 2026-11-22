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
import { getEnvironmentCapabilities } from "@paperclipai/shared";

import { ONBOARDING_STORAGE_KEY, OnboardingWizard } from "./OnboardingWizard";
import { CONNECTED_HOLD_MS } from "./onboarding/onboarding-motion";
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

describe("OnboardingWizard login panel background and adapter switching", () => {
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

  describe("the adapter step login panel (cheap auth signal, no adapter test) — backgrounding, back and adapter switching", () => {
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

    /** Press the step's forward button and let the sign-in queries settle. */
    async function pressArcPrimary() {
      const cta = [...document.body.querySelectorAll("button")].find((b) =>
        isArcPrimary(b.textContent?.trim() ?? ""),
      );
      expect(cta, "the step should render its forward button").toBeTruthy();
      await act(async () => {
        cta!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      for (let i = 0; i < 8; i++) await flushReact();
    }

    it("does not reopen the card when a pasted code fails after Back", async () => {
      // The panel stays mounted through Back's exit, so its report of a failed
      // submit can land mid-exit. Restoring the button there reopened the card
      // the customer was leaving, without the address Back had cleared.
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
      let refuse: (error: Error) => void = () => {};
      mockAgentsApi.submitClaudeSetupTokenBrowserCode.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            refuse = reject;
          }),
      );
      const { root } = await openStep4({ adapterType: "claude_local" });
      await pickSource(/Claude/);

      const field = document.body.querySelector(
        'input[aria-label="Authorization code"]',
      ) as HTMLInputElement;
      await act(async () => {
        field.dispatchEvent(new Event("paste", { bubbles: true }));
        setControlledValue(field, "Q2RJ-E1YIF-authorization-code");
      });
      for (let i = 0; i < 4; i++) await flushReact();

      const cta = () =>
        [...document.body.querySelectorAll("button")].pop()?.textContent?.trim();
      expect(mockAgentsApi.submitClaudeSetupTokenBrowserCode).toHaveBeenCalledTimes(1);
      expect(cta(), "the paste should have started Connecting").toBe("Connecting");

      // Hold the exit open so the refusal lands inside it. Without a
      // `matchMedia` to ask, every beat collapses to zero and the exit would be
      // over before the refusal arrived — which would pass for the wrong reason.
      const realMatchMedia = window.matchMedia;
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        writable: true,
        value: (query: string) => ({
          matches: false,
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }),
      });
      try {
        const back = [...document.body.querySelectorAll("button")].find((b) =>
          b.textContent?.trim().startsWith("Back"),
        );
        await act(async () => {
          back!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        await act(async () => {
          refuse(new Error("That authorization code was not accepted."));
        });
        for (let i = 0; i < 4; i++) await flushReact();

        // Still leaving: the button shows the step's resting face, not the
        // sign-in it would have reopened.
        expect(cta()).toBe("Next");

        // And the exit finishes — the row is a question again. Waited in short
        // slices, each its own `act`. One long `act` defers React's commits to
        // its end, so a beat's timer fires on time but its phase only commits
        // when the wait is over — and the next beat is scheduled only then. The
        // exit crawls one step per wait and never gets back to the question.
        for (let i = 0; i < 30; i++) {
          await act(async () => {
            await new Promise((resolve) => window.setTimeout(resolve, 50));
          });
        }
        expect(
          document.body
            .querySelector('[role="radiogroup"]')!
            .className.includes("justify-center"),
        ).toBe(false);
        expect(mockAgentsApi.hire).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(window, "matchMedia", {
          configurable: true,
          writable: true,
          value: realMatchMedia,
        });
      }

      await act(async () => root.unmount());
    });

    it("does not hire when the login finishes after Back", async () => {
      // The same window from the other side. A login can complete while Back's
      // exit is still running, and reporting that success pulled the step back
      // into "Connecting" and on into a hire the customer had backed away from.
      // No paste needed: here the server has already authenticated, and the
      // completion read is simply slow.
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
      mockAgentsApi.getClaudeSetupTokenLoginStatus.mockResolvedValue({
        sessionId: "claude-session-1",
        status: "authenticated",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      });
      let finishCompletion: (value: { storedSessionId: string }) => void = () => {};
      mockAgentsApi.completeClaudeSetupTokenLogin.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishCompletion = resolve;
          }),
      );
      const realMatchMedia = window.matchMedia;
      try {
        const { root } = await openStep4({ adapterType: "claude_local" });
        await pickSource(/Claude/);
        for (let i = 0; i < 6; i++) await flushReact();

        // The completion read is out and has not answered, and the card is up.
        expect(mockAgentsApi.completeClaudeSetupTokenLogin).toHaveBeenCalledTimes(1);
        const cta = () =>
          [...document.body.querySelectorAll("button")].pop()?.textContent?.trim();
        expect(cta()).toBe("Sign in to Claude");

        // Hold the exit open, as above, so the success lands inside it.
        Object.defineProperty(window, "matchMedia", {
          configurable: true,
          writable: true,
          value: (query: string) => ({
            matches: false,
            media: query,
            onchange: null,
            addListener: () => {},
            removeListener: () => {},
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: () => false,
          }),
        });
        const back = [...document.body.querySelectorAll("button")].find((b) =>
          b.textContent?.trim().startsWith("Back"),
        );
        await act(async () => {
          back!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        await act(async () => {
          finishCompletion({ storedSessionId: "stored-1" });
        });
        for (let i = 0; i < 4; i++) await flushReact();

        expect(cta()).toBe("Next");

        // Past the exit, and past the full hold a late success would have
        // started. In short slices, each its own `act`, for the reason given in
        // the test above — and here it matters twice: a hire scheduled by a late
        // "Connecting" is only scheduled once that phase commits, so one long
        // `act` would hide the very hire this is looking for.
        const slices = Math.ceil((CONNECTED_HOLD_MS + 1200) / 50);
        for (let i = 0; i < slices; i++) {
          await act(async () => {
            await new Promise((resolve) => window.setTimeout(resolve, 50));
          });
        }

        expect(mockAgentsApi.hire).not.toHaveBeenCalled();
        expect(
          document.body
            .querySelector('[role="radiogroup"]')!
            .className.includes("justify-center"),
        ).toBe(false);

        await act(async () => root.unmount());
      } finally {
        Object.defineProperty(window, "matchMedia", {
          configurable: true,
          writable: true,
          value: realMatchMedia,
        });
        mockAgentsApi.getClaudeSetupTokenLoginStatus.mockResolvedValue({
          sessionId: "claude-session-1",
          status: "pending",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        });
      }
    }, 15_000);

    it("starts the sign-in on the first press, even when it changes the adapter", async () => {
      // The regression this is here for. Picking a source sets the phase *and*
      // the adapter, and a reset keyed on the adapter then put the phase
      // straight back — so the first press did nothing and only a second one,
      // which changed no adapter and so woke no effect, was allowed to stand.
      //
      // It only showed when the chosen source differed from the one the draft
      // carried: picking the adapter already in state is a no-op React bails
      // out of, so every existing case here happened to miss it.
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "unknown" });
      const { root } = await openStep4({ adapterType: "claude_local" });

      await pickSource(/OpenAI/);

      expect(mockAgentsApi.startAdapterAuthLogin).toHaveBeenCalledTimes(1);
      expect(
        document.body
          .querySelector('[role="radiogroup"]')!
          .className.includes("justify-center"),
        "one press should have answered the row",
      ).toBe(true);

      await act(async () => root.unmount());
    });

    it("opens the OpenAI card's sign-in once the prompt lands", async () => {
      // The panel that shows a code owns its session and the wizard learns the
      // prompt's URL only by being told. When it was not told, the step waited
      // on a card that had already opened: the code sat on screen under a
      // button still reading "Next", disabled, with nothing left to wait for.
      //
      // The sibling test above stops at the login having started, which is why
      // this went unseen — and the harness could not see it either, since it
      // supplies the prompt itself rather than going through the panel.
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "unknown" });
      const { root } = await openStep4({ adapterType: "claude_local" });

      await pickSource(/OpenAI/);
      for (let i = 0; i < 6; i++) await flushReact();

      // The displayed-code panel is the one under test: if the row picked a
      // source the other panel serves, the rest of this proves nothing.
      expect(mockAgentsApi.startAdapterAuthLogin).toHaveBeenCalled();
      expect(mockAgentsApi.startClaudeSetupTokenLogin).not.toHaveBeenCalled();

      const cta = [...document.body.querySelectorAll("button")].pop()!;
      expect(cta.textContent?.trim()).toBe("Sign in to OpenAI");
      // The code is the card's own content, and it arrives with the URL.
      expect(document.body.textContent).toContain("Q2RJ-E1YIF");
      // The button is the whole point: its destination is the URL the panel
      // reports, so an unreported prompt leaves it reading like an offer and
      // refusing the press. The label alone does not catch that — the phase can
      // reach `ready` before the signal resolves, which names the button
      // without enabling it.
      expect(cta.hasAttribute("disabled"), "the sign-in should be pressable").toBe(
        false,
      );

      await act(async () => root.unmount());
    });

    it("does not hire after Back interrupts the hold before step 5", async () => {
      // "Connecting" is held for two seconds so it reads as a state rather than
      // a flicker, and Back stays live throughout. The hire behind that hold
      // knows nothing about the phase, so a timer left running took a customer
      // who had just backed out to Review with an agent hired anyway.
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
      // A session the server has already authenticated, so the panel completes
      // and reports success on its own. The paste that normally gets it there
      // is the sibling test's subject; this one is about what the success does.
      mockAgentsApi.getClaudeSetupTokenLoginStatus.mockResolvedValue({
        sessionId: "claude-session-1",
        status: "authenticated",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      });
      const { root } = await openStep4({ adapterType: "claude_local" });
      await pickSource(/Claude/);
      for (let i = 0; i < 8; i++) await flushReact();

      const cta = () =>
        [...document.body.querySelectorAll("button")].pop()?.textContent?.trim();
      expect(cta(), "success should have taken the button to the hold").toBe(
        "Connecting",
      );

      const back = [...document.body.querySelectorAll("button")].find((b) =>
        b.textContent?.trim().startsWith("Back"),
      );
      await act(async () => {
        back!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      for (let i = 0; i < 10; i++) await flushReact();

      // Past the hold: whatever it was going to do, it has had its chance.
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, CONNECTED_HOLD_MS + 400));
      });
      for (let i = 0; i < 6; i++) await flushReact();

      expect(mockAgentsApi.hire).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain("Connect a model");

      await act(async () => root.unmount());
    });

    it("shows no probe diagnostics between the sign-in succeeding and the step advancing", async () => {
      // Reported from staging: a block of amber diagnostics flashed up right
      // after a successful sign-in. They are the identity and target INFO
      // checks every run reports, which make the result a `warn` without
      // blocking anything — so they rendered for the window between the probe
      // returning and the step advancing, reading as an error thrown by the
      // sign-in that had just succeeded.
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
      mockAgentsApi.getClaudeSetupTokenLoginStatus.mockResolvedValue({
        sessionId: "claude-session-1",
        status: "authenticated",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      });
      mockAgentsApi.testEnvironment.mockResolvedValue({
        adapterType: "claude_local",
        status: "warn",
        checks: [
          {
            code: "environment_identity",
            level: "info",
            message: 'Environment test identity for "Paperclip Sandbox".',
            detail: "paperclipLeaseId=ff9e58e9; provider=daytona",
          },
        ],
        testedAt: new Date().toISOString(),
      });
      // Hold the hire open, which is the window the diagnostics appeared in:
      // the probe has returned but `loading` is not cleared until the `finally`
      // that runs after the step advances.
      let finishHire: (v: { agent: { id: string }; approval: null }) => void = () => {};
      mockAgentsApi.hire.mockReturnValue(
        new Promise((resolve) => {
          finishHire = resolve;
        }),
      );

      const { root } = await openStep4({ adapterType: "claude_local" });
      await pickSource(/Claude/);
      for (let i = 0; i < 8; i++) await flushReact();

      // Past the deliberate hold, so the hire is running and its probe is done.
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, CONNECTED_HOLD_MS + 400));
      });
      for (let i = 0; i < 8; i++) await flushReact();

      expect(mockAgentsApi.hire).toHaveBeenCalled();
      expect(document.body.textContent).not.toContain("Environment test identity");
      expect(document.body.textContent).not.toContain("Warnings");
      // And the button goes on saying what is happening rather than going quiet.
      expect(
        [...document.body.querySelectorAll("button")].pop()?.textContent?.trim(),
      ).toBe("Connecting…");

      await act(async () => finishHire({ agent: { id: "agent-1" }, approval: null }));
      for (let i = 0; i < 6; i++) await flushReact();

      await act(async () => root.unmount());
    });

    it("starts no login when Back interrupts the collapse", async () => {
      // Backing out before the card has opened has nothing to close. Unwinding
      // through the card beat regardless mounted the panel — which starts a
      // server login on mount — only for the unmount to cancel it, and a cancel
      // that fails holds the per-owner reservation until the server deadline,
      // so the retry the customer is about to make cannot start.
      //
      // The beats collapse to zero without a `matchMedia` to ask, which is why
      // this stubs one: the collapse has to still be running when Back lands.
      const realMatchMedia = window.matchMedia;
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        writable: true,
        value: (query: string) => ({
          matches: false,
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }),
      });
      try {
        mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
        const { root } = await openStep4({ adapterType: "claude_local" });

        await pickSource(/Claude/);
        // Still collapsing: the flushes above are microtasks and 0ms timers,
        // far inside the collapse's own duration.
        expect(mockAgentsApi.startClaudeSetupTokenLogin).not.toHaveBeenCalled();

        const back = [...document.body.querySelectorAll("button")].find((b) =>
          b.textContent?.trim().startsWith("Back"),
        );
        await act(async () => {
          back!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        for (let i = 0; i < 10; i++) await flushReact();
        await act(async () => {
          await new Promise((resolve) => window.setTimeout(resolve, 1200));
        });
        for (let i = 0; i < 6; i++) await flushReact();

        expect(mockAgentsApi.startClaudeSetupTokenLogin).not.toHaveBeenCalled();
        expect(document.body.textContent).toContain("Connect a model");

        await act(async () => root.unmount());
      } finally {
        Object.defineProperty(window, "matchMedia", {
          configurable: true,
          writable: true,
          value: realMatchMedia,
        });
      }
    });

    it("starts the codex_local sign-in on Connect when the signal cannot decide", async () => {
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "unknown" });
      const { root } = await openStep4({ adapterType: "codex_local" });

      expect(mockAgentsApi.startAdapterAuthLogin).not.toHaveBeenCalled();

      await pickSource(/OpenAI/);

      expect(mockAgentsApi.startAdapterAuthLogin).toHaveBeenCalled();
      expect(mockAgentsApi.hire).not.toHaveBeenCalled();
      // The displayed-code login hands a code over rather than taking one back,
      // so both halves of it have to reach the screen.
      expect(document.body.textContent).toContain(
        "Sign in to OpenAI by providing the authorization code below",
      );
      expect(document.body.textContent).toContain("Q2RJ-E1YIF");

      // The link lives inside the sentence now rather than in a row of its own,
      // and points at the same address the step's button opens — it is the
      // path for anyone finishing the sign-in in another browser.
      const link = document.body.querySelector('a[href*="auth.openai.com"]');
      expect(link, "the sign-in link should be in the instruction").toBeTruthy();
      expect(link!.textContent).toBe("Sign in to OpenAI");

      // And the code sits below the sentence carrying it.
      const code = [...document.body.querySelectorAll("span")].find(
        (el) => el.textContent?.trim() === "Q2RJ-E1YIF",
      );
      expect(code, "the code row should render").toBeTruthy();
      expect(
        link!.compareDocumentPosition(code!) & Node.DOCUMENT_POSITION_FOLLOWING,
        "the code should follow the sentence that links to the sign-in",
      ).toBeTruthy();

      await act(async () => root.unmount());
    });

    it("shows the failure instead of starting a codex_local login when the active-session read fails", async () => {
      // A transient active-session lookup failure is not proof that no
      // session exists — only a successful lookup that resolves to null is.
      // The step must not start a second login the server would reject
      // against the per-owner cap; it shows the failure instead.
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "unknown" });
      mockAgentsApi.getActiveAdapterAuthLoginSession.mockReset();
      mockAgentsApi.getActiveAdapterAuthLoginSession.mockRejectedValue(
        new ApiError("Service unavailable", 503, null),
      );
      const { root } = await openStep4({ adapterType: "codex_local" });

      await pickSource(/OpenAI/);

      expect(mockAgentsApi.startAdapterAuthLogin).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain("Sign-in didn’t finish");

      await act(async () => root.unmount());
    });

    it("shows the failure instead of starting a claude_local login when the active-session read fails", async () => {
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
      mockAgentsApi.getActiveClaudeSetupTokenLoginSession.mockReset();
      mockAgentsApi.getActiveClaudeSetupTokenLoginSession.mockRejectedValue(
        new ApiError("Service unavailable", 503, null),
      );
      const { root } = await openStep4({ adapterType: "claude_local" });

      await pickSource(/Claude/);

      expect(mockAgentsApi.startClaudeSetupTokenLogin).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain("Sign-in didn’t finish");

      await act(async () => root.unmount());
    });

    it.each(([
      ["claude_local", "resume"], ["codex_local", "resume"],
      ["claude_local", "start"], ["codex_local", "start"],
      ["claude_local", "prompt"], ["codex_local", "prompt"],
    ] as const).flatMap(([adapterType, stage]) => [false, true].map(afterExit => [adapterType, stage, afterExit] as const)))("keeps %s cancelled when its pending %s response arrives after Back (exit finished: %s)", async (adapterType, stage, afterExit) => {
      const claude = adapterType === "claude_local";
      const activeApi = claude ? mockAgentsApi.getActiveClaudeSetupTokenLoginSession : mockAgentsApi.getActiveAdapterAuthLoginSession;
      const startApi = claude ? mockAgentsApi.startClaudeSetupTokenLogin : mockAgentsApi.startAdapterAuthLogin;
      const promptApi = claude ? mockAgentsApi.getClaudeSetupTokenLoginPrompt : mockAgentsApi.getAdapterAuthLoginStatus;
      const cancelApi = claude ? mockAgentsApi.cancelClaudeSetupTokenLogin : mockAgentsApi.cancelAdapterAuthLogin;
      const session = {
        sessionId: claude ? "claude-session-1" : "codex-session-1", environmentId: "env-sandbox-1",
        status: "waiting_for_user", expiresAt: null, failure: null,
        aiConnection: { provider: claude ? "anthropic" : "openai", method: "subscription", ownership: "personal", agentIds: [], allAgents: true },
        panelMode: claude ? "submitted_browser_code" : "displayed_code",
        prompt: claude ? { authorizationUrl: "https://claude.ai/oauth/authorize?cancelled=true" }
          : { url: "https://auth.openai.com/codex/device", code: "CANCELLED-CODE" },
      };
      let finish!: (value: unknown) => void;
      const pending = new Promise(resolve => { finish = resolve; });
      const pendingApi = stage === "resume" ? activeApi : stage === "start" ? startApi : promptApi;
      pendingApi.mockReturnValue(pending as never);
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
      const { root } = await openStep4({ adapterType });
      try {
        await pickSource(claude ? /Claude/ : /OpenAI/);
        expect(pendingApi).toHaveBeenCalled();
        await act(async () => [...document.body.querySelectorAll("button")].find(button => button.textContent?.trim().startsWith("Back"))!.click());
        if (afterExit) for (let i = 0; i < 12; i++) await flushReact();
        if (stage !== "start") {
          const signals = (pendingApi.mock.calls as unknown[][]).map(call => (call.at(-1) as { signal?: AbortSignal })?.signal).filter(signal => signal !== undefined);
          expect(signals.length).toBeGreaterThan(0);
          expect(signals.every(signal => signal.aborted)).toBe(true);
        }
        await act(async () => finish(stage === "prompt" && claude ? session.prompt : session));
        for (let i = 0; i < 12; i++) await flushReact();
        expect(document.querySelectorAll('[role="radio"][aria-checked="true"]')).toHaveLength(0);
        expect(document.body.textContent).not.toContain("CANCELLED-CODE");
        expect(document.querySelector('input[aria-label="Authorization code"]')).toBeNull();
        expect(document.body.textContent).not.toContain("Let's get started...");
        expect(mockAgentsApi.hire).not.toHaveBeenCalled();
        if (claude) expect(cancelApi).toHaveBeenCalledWith("company-new", session.sessionId);
        else expect(cancelApi).toHaveBeenCalledWith("company-new", "codex_local", session.sessionId);
      } finally { await act(async () => root.unmount()); }
    });

    it.each([
      ["claude_local", false], ["codex_local", false], ["claude_local", true], ["codex_local", true],
    ] as const)("discovers and releases %s after its resume read rejects on abort (panel mounted: %s)", async (adapterType, panelMounted) => {
      const claude = adapterType === "claude_local";
      const activeApi = claude ? mockAgentsApi.getActiveClaudeSetupTokenLoginSession : mockAgentsApi.getActiveAdapterAuthLoginSession;
      const cancelApi = claude ? mockAgentsApi.cancelClaudeSetupTokenLogin : mockAgentsApi.cancelAdapterAuthLogin;
      const startApi = claude ? mockAgentsApi.startClaudeSetupTokenLogin : mockAgentsApi.startAdapterAuthLogin;
      const session = { sessionId: "abandoned-session", environmentId: "env-sandbox-1", status: "waiting_for_user", expiresAt: null,
        panelMode: claude ? "submitted_browser_code" : "displayed_code",
        aiConnection: { provider: claude ? "anthropic" : "openai", method: "subscription", ownership: "personal", agentIds: [], allAgents: true } };
      let serverActive = true;
      let aborts = 0;
      let finishDiscovery!: () => void;
      let finishCancellation = () => {};
      const discovery = new Promise<void>(resolve => { finishDiscovery = resolve; });
      activeApi.mockImplementation((...args: unknown[]) => {
        const options = args.at(-1) as { signal?: AbortSignal; fresh?: boolean };
        if (options?.fresh) return discovery.then(() => serverActive ? session : null);
        if (!serverActive) return Promise.resolve(null);
        return new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => {
          aborts++;
          reject(new DOMException("The request was aborted", "AbortError"));
        }, { once: true }));
      });
      cancelApi.mockImplementation(() => new Promise(resolve => { finishCancellation = () => { serverActive = false; resolve({}); }; }));
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
      const { root } = await openStep4({ adapterType });
      const matchMedia = window.matchMedia;
      const restoreMotion = () => Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: matchMedia });
      try {
        if (panelMounted) await pickSource(claude ? /Claude/ : /OpenAI/);
        else {
          Object.defineProperty(window, "matchMedia", { configurable: true, writable: true,
            value: (media: string) => ({ matches: false, media, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }) });
          const tile = [...document.body.querySelectorAll('[role="radio"]')].find(tile => (claude ? /Claude/ : /OpenAI/).test(tile.textContent ?? ""))!;
          await act(async () => (tile as HTMLElement).click());
          expect(activeApi).toHaveBeenCalledTimes(1);
          restoreMotion();
        }
        await act(async () => [...document.body.querySelectorAll("button")].find(button => button.textContent?.trim().startsWith("Back"))!.click());
        for (let i = 0; i < 12; i++) await flushReact();
        expect(aborts).toBeGreaterThan(0);
        await vi.waitFor(() => expect((activeApi.mock.calls as unknown[][]).some(call => (call.at(-1) as { fresh?: boolean })?.fresh)).toBe(true));
        expect(document.querySelectorAll('[role="radio"][aria-checked="true"]')).toHaveLength(0);
        await pickSource(claude ? /Claude/ : /OpenAI/);
        expect(startApi).not.toHaveBeenCalled();
        await act(async () => finishDiscovery());
        await vi.waitFor(() => expect(cancelApi).toHaveBeenCalled());
        expect(startApi).not.toHaveBeenCalled();
        await act(async () => finishCancellation());
        for (let i = 0; i < 12; i++) await flushReact();
        expect(serverActive).toBe(false);
        expect(startApi).toHaveBeenCalledTimes(1);
        expect(mockAgentsApi.hire).not.toHaveBeenCalled();
      } finally {
        restoreMotion();
        finishDiscovery();
        finishCancellation();
        await act(async () => root.unmount());
      }
    });

    it.each((["claude_local", "codex_local"] as const).flatMap(adapterType =>
      (["environment", "legacy", "connection", "ownership", "agents", "allAgents"] as const).map(difference => [adapterType, difference] as const)))("preserves another %s sign-in after Back when %s differs", async (adapterType, difference) => {
      const claude = adapterType === "claude_local";
      const activeApi = claude ? mockAgentsApi.getActiveClaudeSetupTokenLoginSession : mockAgentsApi.getActiveAdapterAuthLoginSession;
      const cancelApi = claude ? mockAgentsApi.cancelClaudeSetupTokenLogin : mockAgentsApi.cancelAdapterAuthLogin;
      const startApi = claude ? mockAgentsApi.startClaudeSetupTokenLogin : mockAgentsApi.startAdapterAuthLogin;
      const intent = { provider: claude ? "anthropic" : "openai", method: "subscription", ownership: "personal", agentIds: [] as string[], allAgents: true };
      const session = { sessionId: "settings-sign-in", environmentId: difference === "environment" ? "other-environment" : "env-sandbox-1",
        status: "waiting_for_user", expiresAt: null, aiConnection: difference === "legacy" ? undefined : { ...intent,
          ...(difference === "connection" ? { connectionId: "other-connection" } : {}),
          ...(difference === "ownership" ? { ownership: "organization" } : {}),
          ...(difference === "agents" ? { agentIds: ["other-agent"] } : {}),
          ...(difference === "allAgents" ? { allAgents: false } : {}) } };
      activeApi.mockResolvedValue(session);
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
      const { root } = await openStep4({ adapterType });
      try {
        for (let i = 0; i < 12; i++) await flushReact();
        expect(document.body.textContent).toContain("Sign-in didn’t finish");
        await act(async () => [...document.body.querySelectorAll("button")].find(button => button.textContent?.trim().startsWith("Back"))!.click());
        for (let i = 0; i < 12; i++) await flushReact();
        expect(cancelApi).not.toHaveBeenCalled();
        expect(startApi).not.toHaveBeenCalled();
        expect(document.querySelectorAll('[role="radio"][aria-checked="true"]')).toHaveLength(0);
      } finally { await act(async () => root.unmount()); }
    });

    it.each(["claude_local", "codex_local"] as const)("preserves a conflicting %s resume response received after Back", async adapterType => {
      const claude = adapterType === "claude_local";
      const activeApi = claude ? mockAgentsApi.getActiveClaudeSetupTokenLoginSession : mockAgentsApi.getActiveAdapterAuthLoginSession;
      const cancelApi = claude ? mockAgentsApi.cancelClaudeSetupTokenLogin : mockAgentsApi.cancelAdapterAuthLogin;
      let finish!: (session: unknown) => void;
      activeApi.mockReturnValue(new Promise(resolve => { finish = resolve; }));
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
      const { root } = await openStep4({ adapterType });
      try {
        await pickSource(claude ? /Claude/ : /OpenAI/);
        await act(async () => [...document.body.querySelectorAll("button")].find(button => button.textContent?.trim().startsWith("Back"))!.click());
        await act(async () => finish({ sessionId: "settings-sign-in", environmentId: "another-environment", status: "waiting_for_user" }));
        for (let i = 0; i < 12; i++) await flushReact();
        expect(cancelApi).not.toHaveBeenCalled();
        expect(document.querySelectorAll('[role="radio"][aria-checked="true"]')).toHaveLength(0);
      } finally { await act(async () => root.unmount()); }
    });

    it("cancels claude_local on Back and starts a fresh sign-in when selected again", async () => {
      const session = {
        sessionId: "claude-session-1",
        status: "pending",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      };
      let started = false;
      let finishCancellation!: () => void;
      mockAgentsApi.cancelClaudeSetupTokenLogin.mockImplementation(() => new Promise(resolve => { finishCancellation = () => { started = false; resolve({}); }; }));
      mockAgentsApi.startClaudeSetupTokenLogin.mockImplementation(async () => {
        started = true;
        return session;
      });
      mockAgentsApi.getActiveClaudeSetupTokenLoginSession.mockReset();
      mockAgentsApi.getActiveClaudeSetupTokenLoginSession.mockImplementation(async () =>
        started ? session : null,
      );
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
      const { root } = await openStep4({ adapterType: "claude_local" });

      await pickSource(/Claude/);
      expect(mockAgentsApi.startClaudeSetupTokenLogin).toHaveBeenCalledTimes(1);

      const back = [...document.body.querySelectorAll("button")].find((b) =>
        b.textContent?.trim().startsWith("Back"),
      );
      await act(async () => {
        back!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      for (let i = 0; i < 12; i++) await flushReact();

      expect(mockAgentsApi.cancelClaudeSetupTokenLogin).toHaveBeenCalled();
      await pickSource(/Claude/);
      expect(mockAgentsApi.startClaudeSetupTokenLogin).toHaveBeenCalledTimes(1);
      await act(async () => finishCancellation());
      for (let i = 0; i < 8; i++) await flushReact();

      expect(mockAgentsApi.startClaudeSetupTokenLogin).toHaveBeenCalledTimes(2);
      expect(mockAgentsApi.getActiveClaudeSetupTokenLoginSession).toHaveBeenCalled();

      await act(async () => root.unmount());
    });

    it("cancels codex_local on Back and starts a fresh sign-in when selected again", async () => {
      const session = { sessionId: "codex-session-1", status: "pending" };
      let started = false;
      let finishCancellation!: () => void;
      mockAgentsApi.cancelAdapterAuthLogin.mockImplementation(() => new Promise(resolve => { finishCancellation = () => { started = false; resolve({}); }; }));
      mockAgentsApi.startAdapterAuthLogin.mockImplementation(async () => {
        started = true;
        return session;
      });
      mockAgentsApi.getActiveAdapterAuthLoginSession.mockReset();
      mockAgentsApi.getActiveAdapterAuthLoginSession.mockImplementation(async () =>
        started ? session : null,
      );
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "unknown" });
      const { root } = await openStep4({ adapterType: "claude_local" });

      await pickSource(/OpenAI/);
      expect(mockAgentsApi.startAdapterAuthLogin).toHaveBeenCalledTimes(1);

      const back = [...document.body.querySelectorAll("button")].find((b) =>
        b.textContent?.trim().startsWith("Back"),
      );
      await act(async () => {
        back!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      for (let i = 0; i < 12; i++) await flushReact();

      expect(mockAgentsApi.cancelAdapterAuthLogin).toHaveBeenCalled();
      await pickSource(/OpenAI/);
      expect(mockAgentsApi.startAdapterAuthLogin).toHaveBeenCalledTimes(1);
      await act(async () => finishCancellation());
      for (let i = 0; i < 8; i++) await flushReact();

      expect(mockAgentsApi.startAdapterAuthLogin).toHaveBeenCalledTimes(2);
      expect(mockAgentsApi.getActiveAdapterAuthLoginSession).toHaveBeenCalled();

      await act(async () => root.unmount());
    });

    it("starts the other source's login after backing out of the first", async () => {
      // The abandonment case, raised in review against removing the card's
      // Cancel: with no explicit release, does a source switch still get a
      // login? It does. The server's lease is keyed on the adapter type as
      // well as the company and environment, so the abandoned Claude session
      // does not stand in the way of a Codex one — and it is collected on its
      // own five-minute timer regardless (DEVICE_LOGIN_TIMEOUT_MS), with the
      // reaper as the restart-safe backstop.
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
      const { root } = await openStep4({ adapterType: "claude_local" });

      await pickSource(/Claude/);

      expect(document.body.textContent).toContain("Sign in to Claude then come back and enter authorization code");
      expect(document.body.textContent).not.toContain("Use saved login");
      expect(mockAgentsApi.startClaudeSetupTokenLogin).toHaveBeenCalledTimes(1);

      const back = [...document.body.querySelectorAll("button")].find((b) =>
        b.textContent?.trim().startsWith("Back"),
      );
      await act(async () => {
        back!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      for (let i = 0; i < 12; i++) await flushReact();

      await pickSource(/OpenAI/);
      for (let i = 0; i < 8; i++) await flushReact();

      expect(mockAgentsApi.startAdapterAuthLogin).toHaveBeenCalledTimes(1);
      expect(mockAgentsApi.startClaudeSetupTokenLogin).toHaveBeenCalledTimes(1);

      await act(async () => root.unmount());
    });

    it("hires on Connect, with no sign-in, when the signal reports a ready credential", async () => {
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "present" });
      const { root } = await openStep4({ adapterType: "claude_local" });

      // Answer the row, then press: with a credential already in place there is
      // no sign-in to run, so the button goes straight to the hire.
      await pickSource(/Claude/);
      await pressArcPrimary();

      // The positive half is what makes this a test: a source that is already
      // signed in goes straight to the hire, so Connect keeps its old meaning
      // wherever there is no sign-in to do. Asserting only the absence of a
      // card would pass just as well if the button had stopped working.
      expect(mockAgentsApi.hire).toHaveBeenCalled();
      expect(mockAgentsApi.startClaudeSetupTokenLogin).not.toHaveBeenCalled();

      await act(async () => root.unmount());
    });

    it("reads the signal again after an adapter change", async () => {
      mockAdapterRegistry.list = [setupAdapterInfo({ type: "claude_local" }), { type: "codex_local" }];
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
      const { root } = await openStep4({ adapterType: "claude_local" });

      expect(mockAgentsApi.getAdapterAuthSignal).toHaveBeenCalledWith(
        "company-new",
        "claude_local",
        "env-sandbox-1",
      );

      const clickByText = async (match: (text: string) => boolean) => {
        const el = [...document.body.querySelectorAll("button")].find((b) =>
          match(b.getAttribute("aria-label")?.startsWith("Use ") ? b.getAttribute("aria-label")! : b.textContent?.trim() ?? ""),
        )!;
        await act(async () => {
          el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        await flushReact();
      };

      // Straight to the tile. The adapter change used to be reached through an
      // "Advanced settings" disclosure listing every non-recommended adapter;
      // the step now offers Claude and Codex as tiles and spends that line on
      // the credential switch instead. What is asserted below is unchanged —
      // changing the source re-reads the signal — only the route there is.
      // The tile's text is the label plus its credential tag, hence the prefix.
      // That label is the provider name now, not the adapter type: this row
      // asks which provider you are signing in to, so it reads through
      // `MODEL_SOURCE_NAMES` rather than the display registry.
      await clickByText((t) => t.startsWith("OpenAI"));

      expect(mockAgentsApi.getAdapterAuthSignal).toHaveBeenCalledWith(
        "company-new",
        "codex_local",
        "env-sandbox-1",
      );

      await act(async () => root.unmount());
    });

    describe("managed Codex automatic setup qualification", () => {
      const image = `registry.example.test/runtime@sha256:${"a".repeat(64)}`;
      const discovery = (defaultRunner: "paperclip" | "legacy") => [{ type: "codex_local", defaultRunner,
        supportedRunners: defaultRunner === "paperclip" ? ["paperclip", "legacy"] : ["legacy"] }] as import("../api/adapters").AdapterInfo[];

      async function openManaged(overrides: Record<string, unknown> = {}, config: Record<string, unknown> = { provider: "daytona", image }, staleTime = 0) {
        mockEnvironmentsApi.list.mockResolvedValue([{ ...SANDBOX_ENVIRONMENT, config }]);
        mockAdaptersApi.list.mockResolvedValue(discovery("legacy"));
        const handles = await openStep4({ adapterType: "codex_local", runner: "auto", ...overrides }, staleTime);
        await act(async () => handles.queryClient.setQueryData(["ai-connections", "company-new"], {
          currentUserId: "user-1", connections: [{ id: "saved", grantId: "grant", companyId: "company-new", provider: "openai", method: "subscription", name: "My subscription", ownership: "personal", ownerUserId: "user-1", status: "connected", isDefault: true }],
        }));
        return handles;
      }

      it.each([["paperclip", 0], ["legacy", 0], ["paperclip", 30_000], ["legacy", 30_000]] as const)("qualifies the image on Connect and honors the measured %s default with %i ms cache", async (defaultRunner, staleTime) => {
        const calls: string[] = [];
        const handles = await openManaged({}, { provider: "daytona", image }, staleTime);
        let qualified = false;
        mockAdaptersApi.list.mockImplementation(async context => {
          expect(context).toEqual({ companyId: "company-new", environmentId: "env-sandbox-1" });
          calls.push(qualified ? "discovery-after" : "discovery-before");
          return discovery(qualified ? defaultRunner : "legacy");
        });
        mockEnvironmentsApi.probe.mockImplementation(async () => {
          calls.push("platform");
          qualified = true;
          return { ok: true, driver: "sandbox", summary: "Measured image", details: { platformQualificationRecorded: true, leaseId: "platform-lease" } };
        });
        mockAgentsApi.testEnvironment.mockImplementation(async () => {
          calls.push("adapter");
          return { adapterType: defaultRunner === "paperclip" ? "paperclip_runner" : "codex_local", status: "pass", checks: [], testedAt: "2026-10-13T00:00:00Z" };
        });
        mockAgentsApi.hire.mockImplementation(async () => { calls.push("hire"); return { agent: { id: "agent-1" }, approval: null }; });
        try {
          expect(mockEnvironmentsApi.probe).not.toHaveBeenCalled();
          await pickSource(/OpenAI/);
          expect(calls).toEqual(["discovery-before", "platform", "discovery-after", "adapter", "hire"]);
          expect(handles.queryClient.getQueryData(queryKeys.adapters.availability("company-new", "env-sandbox-1"))).toEqual(discovery(defaultRunner));
          expect(mockEnvironmentsApi.probe).toHaveBeenCalledExactlyOnceWith("env-sandbox-1", "company-new", expect.objectContaining({ signal: expect.any(AbortSignal) }));
          expect(mockAgentsApi.testEnvironment).toHaveBeenCalledWith("company-new", "codex_local", expect.objectContaining({ environmentId: "env-sandbox-1", aiConnection: { provider: "openai", method: "subscription", mode: "responsible_user" } }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
          expect((mockAgentsApi.testEnvironment.mock.calls[0] as unknown[])[2]).not.toHaveProperty("runner");
          expect((mockAgentsApi.hire.mock.calls[0] as unknown[])[1]).not.toHaveProperty("runner");
          expect(managedApi.connectLocal).not.toHaveBeenCalled();
        } finally { await act(async () => handles.root.unmount()); }
      });

      it.each(["permission", "cleanup", "config-race", "missing-lease", "connection", "discovery"].flatMap(failure => [0, 30_000].map(staleTime => [failure, staleTime] as const)))("stops managed automatic setup after %s qualification failure with %i ms cache", async (failure, staleTime) => {
        const handles = await openManaged({}, { provider: "daytona", image }, staleTime);
        const diagnostic = failure === "permission" ? "Instance admin access required" : "Qualification could not be confirmed";
        if (failure === "permission") mockEnvironmentsApi.probe.mockRejectedValue(new ApiError(diagnostic, 403, null));
        else mockEnvironmentsApi.probe.mockImplementation(async () => {
          if (failure === "discovery") mockAdaptersApi.list.mockRejectedValue(new Error(diagnostic));
          return { ok: failure !== "connection", driver: "sandbox", summary: diagnostic,
            details: { platformQualificationRecorded: !["cleanup", "config-race"].includes(failure),
              ...(failure === "missing-lease" ? {} : { leaseId: "platform-lease" }), platformQualificationDiagnostic: diagnostic } };
        });
        try {
          await pickSource(/OpenAI/);
          expect(document.body.textContent).toContain(diagnostic);
          expect(mockEnvironmentsApi.probe).toHaveBeenCalledTimes(1);
          expect(mockAgentsApi.testEnvironment).not.toHaveBeenCalled();
          expect(mockAgentsApi.hire).not.toHaveBeenCalled();
        } finally { await act(async () => handles.root.unmount()); }
      });

      it.each(["legacy", "native-cache", "snapshot", "tag", "local", "saved"])("keeps the %s path free of an extra platform probe", async mode => {
        const handles = await openManaged(mode === "legacy" ? { runner: "legacy" } : mode === "saved" ? { createdAgentId: "existing" } : {},
          mode === "snapshot" ? { provider: "daytona", snapshot: "named" } : mode === "tag" ? { provider: "daytona", image: "ubuntu:24.04" } : { provider: "daytona", image });
        if (mode === "native-cache") {
          mockAdaptersApi.list.mockResolvedValue(discovery("paperclip"));
          await act(async () => handles.queryClient.setQueryData(queryKeys.adapters.availability("company-new", "env-sandbox-1"), discovery("paperclip")));
        }
        if (mode === "local") {
          await act(async () => handles.queryClient.setQueryData(queryKeys.environments.list("company-new"), [LOCAL_ENVIRONMENT]));
          mockInstanceSettingsApi.get.mockResolvedValue({ defaultEnvironmentId: null });
          await act(async () => handles.queryClient.setQueryData(queryKeys.instance.settings, { defaultEnvironmentId: null }));
        }
        try {
          await pickSource(/OpenAI/);
          expect(mockEnvironmentsApi.probe).not.toHaveBeenCalled();
        } finally { await act(async () => handles.root.unmount()); }
      });

      it.each(["missing", "invalid-default", "unsupported-default"])("does not probe or hire with %s authoritative discovery", async mode => {
        const handles = await openManaged();
        mockAdaptersApi.list.mockResolvedValue(mode === "missing" ? [] : mode === "invalid-default"
          ? [{ type: "codex_local", supportedRunners: ["legacy"] }] as import("../api/adapters").AdapterInfo[]
          : [{ type: "codex_local", defaultRunner: "paperclip", supportedRunners: ["legacy"] }] as import("../api/adapters").AdapterInfo[]);
        try {
          await pickSource(/OpenAI/);
          expect(document.body.textContent).toContain("Could not confirm Codex runner availability");
          expect(mockEnvironmentsApi.probe).not.toHaveBeenCalled();
          expect(mockAgentsApi.testEnvironment).not.toHaveBeenCalled();
          expect(mockAgentsApi.hire).not.toHaveBeenCalled();
        } finally { await act(async () => handles.root.unmount()); }
      });

      it.each([0, 30_000])("rechecks stale native discovery and stops a changed image from becoming an unnoticed Legacy hire with %i ms cache", async staleTime => {
        const handles = await openManaged({}, { provider: "daytona", image }, staleTime);
        await act(async () => handles.queryClient.setQueryData(queryKeys.adapters.availability("company-new", "env-sandbox-1"), discovery("paperclip")));
        mockEnvironmentsApi.probe.mockResolvedValue({ ok: true, driver: "sandbox", summary: "Connected", details: {
          platformQualificationRecorded: false, leaseId: "platform-lease", platformQualificationDiagnostic: "The environment changed during the probe. Probe its current configuration again." } });
        try {
          await pickSource(/OpenAI/);
          expect(mockAdaptersApi.list).toHaveBeenCalledWith({ companyId: "company-new", environmentId: "env-sandbox-1" });
          expect(mockEnvironmentsApi.probe).toHaveBeenCalledTimes(1);
          expect(document.body.textContent).toContain("The environment changed during the probe");
          expect(mockAgentsApi.testEnvironment).not.toHaveBeenCalled();
          expect(mockAgentsApi.hire).not.toHaveBeenCalled();
        } finally { await act(async () => handles.root.unmount()); }
      });

      it.each(["authentication", "dependency", "model"])("keeps selected native %s setup failures actionable without retrying Legacy", async failure => {
        const handles = await openManaged();
        mockEnvironmentsApi.probe.mockImplementation(async () => {
          mockAdaptersApi.list.mockResolvedValue(discovery("paperclip"));
          return { ok: true, driver: "sandbox", summary: "Measured image", details: { platformQualificationRecorded: true, leaseId: "platform-lease" } };
        });
        mockAgentsApi.testEnvironment.mockResolvedValue({ adapterType: "paperclip_runner", status: "fail", testedAt: "2026-10-13T00:00:00Z",
          checks: [{ code: `native_${failure}`, level: "error", message: `Repair native ${failure}` }] });
        try {
          await pickSource(/OpenAI/);
          expect(mockEnvironmentsApi.probe).toHaveBeenCalledTimes(1);
          expect(mockAgentsApi.testEnvironment).toHaveBeenCalledTimes(1);
          expect((mockAgentsApi.testEnvironment.mock.calls[0] as unknown[])[2]).not.toHaveProperty("runner");
          expect(mockAgentsApi.hire).not.toHaveBeenCalled();
          expect(document.body.textContent).toContain(`Repair native ${failure}`);
        } finally { await act(async () => handles.root.unmount()); }
      });

      it.each(["back", "environment-config"])("does not test or hire after a held probe is abandoned by %s", async change => {
        let finish!: (value: import("@paperclipai/shared").EnvironmentProbeResult) => void;
        const handles = await openManaged();
        mockEnvironmentsApi.probe.mockReturnValue(new Promise(resolve => { finish = resolve; }));
        try {
          await pickSource(/OpenAI/);
          expect(mockEnvironmentsApi.probe).toHaveBeenCalledTimes(1);
          expect(mockAgentsApi.testEnvironment).not.toHaveBeenCalled();
          await act(async () => document.querySelector('[data-testid="onboarding-wizard"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true })));
          await flushReact();
          expect(mockEnvironmentsApi.probe).toHaveBeenCalledTimes(1);
          if (change === "back") await act(async () => [...document.body.querySelectorAll("button")].find(button => button.textContent?.trim() === "Back")!.click());
          else {
            await act(async () => handles.queryClient.setQueryData(queryKeys.environments.list("company-new"), [{ ...SANDBOX_ENVIRONMENT, config: { provider: "daytona", image: `registry.example.test/runtime@sha256:${"b".repeat(64)}` } }]));
            await flushReact();
          }
          await act(async () => finish({ ok: true, driver: "sandbox", summary: "Measured image", details: { platformQualificationRecorded: true, leaseId: "platform-lease" } }));
          for (let i = 0; i < 8; i++) await flushReact();
          expect(mockEnvironmentsApi.probe).toHaveBeenCalledTimes(1);
          expect(mockAgentsApi.testEnvironment).not.toHaveBeenCalled();
          expect(mockAgentsApi.hire).not.toHaveBeenCalled();
        } finally { await act(async () => handles.root.unmount()); }
      });
    });
  });
});
