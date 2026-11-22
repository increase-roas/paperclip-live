// @vitest-environment jsdom

import { act } from "react";

import { buildClaudeLocalConfig } from "../../../packages/adapters/claude-local/src/ui/build-config";

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

describe("OnboardingWizard login panel", () => {
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

  describe("the adapter step login panel (cheap auth signal, no adapter test) — start, retry and mode", () => {
    const SANDBOX_ENVIRONMENT = {
      id: "env-sandbox-1",
      driver: "sandbox" as const,
      status: "active" as const,
      config: { provider: "daytona" },
      metadata: {},
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

    it.each((["success", "failed probe", "failed save"] as const).flatMap(outcome => [false, true].map(native => ({ outcome, native }))))("saves the API connection after returning from a completed subscription setup: $outcome, native $native", async ({ outcome, native }) => {
      managedApi.list.mockResolvedValue({ currentUserId: "user-1", connections: [{
        id: "subscription-account", grantId: "subscription-grant", companyId: "company-new",
        provider: "openai", method: "subscription", ownership: "personal", ownerUserId: "user-1",
        isDefault: true, status: "connected", name: "OpenAI subscription",
      }] } as never);
      mockEnvironmentsApi.list.mockResolvedValue([SANDBOX_ENVIRONMENT, { ...SANDBOX_ENVIRONMENT, id: "saved-environment" }]);
      mockAgentsApi.get.mockResolvedValue({ id: "agent-1", companyId: "company-new", adapterType: native ? "paperclip_runner" : "codex_local", defaultEnvironmentId: "saved-environment",
        adapterConfig: { ...(native ? { provider: "codex" } : {}), model: "gpt-5.4", customSetting: "preserve", env: { CODEX_HOME: { type: "secret_ref", secretId: "old-home" }, KEEP: { type: "plain", value: "keep" } } },
        runtimeConfig: { aiConnection: { provider: "openai", method: "subscription", mode: "responsible_user" }, customRuntime: "preserve", heartbeat: { intervalSec: 300, enabled: false } },
      });
      const { root } = await openStep4({ adapterType: "codex_local", model: "gpt-5.4" });
      try {
        await pickSource(/OpenAI/);
        expect(mockAgentsApi.hire).toHaveBeenCalledTimes(1);
        expect(document.body.textContent).toContain("Let's get started...");
        if (outcome === "failed probe") mockAgentsApi.testEnvironment.mockResolvedValue({ adapterType: "codex_local", status: "fail", checks: [], testedAt: new Date().toISOString() });
        if (outcome === "failed save") mockAgentsApi.update.mockRejectedValueOnce(new Error("account save failed"));
        const back = () => [...document.body.querySelectorAll("button")].find(button => button.textContent?.trim().startsWith("Back"))!;
        await act(async () => back().click());
        for (let i = 0; i < 10; i++) await flushReact();
        await act(async () => (document.querySelector('[aria-label="Use API key instead"]') as HTMLButtonElement).click());
        await pickSource(/OpenAI.*API/);
        await act(async () => setControlledValue(document.querySelector('input[aria-label="API key"]')!, "example-api-key"));
        await pressArcPrimary();
        expect(managedApi.create).toHaveBeenCalledWith("company-new", expect.objectContaining({ provider: "openai", method: "api_key", apiKey: "example-api-key" }));
        expect(managedApi.setDefault).toHaveBeenLastCalledWith("company-new", "managed-grant");
        expect(mockAgentsApi.testEnvironment).toHaveBeenLastCalledWith("company-new", "codex_local", expect.objectContaining({ agentId: "agent-1", environmentId: "saved-environment", runner: native ? "paperclip" : "legacy" }), expect.anything());
        expect(mockAgentsApi.hire).toHaveBeenCalledTimes(1);
        const update = mockAgentsApi.update.mock.calls.find(([id, body]) => id === "agent-1" && (body.runtimeConfig as Record<string, unknown>)?.aiConnection);
        if (outcome === "failed probe") {
          expect(update).toBeUndefined();
          expect(document.body.textContent).toContain("Connect a model");
          return;
        }
        expect(update).toBeTruthy();
        expect(update![1]).toMatchObject({ runner: native ? "paperclip" : "legacy", runtimeConfig: { aiConnection: { provider: "openai", method: "api_key", mode: "responsible_user" }, customRuntime: "preserve", heartbeat: { intervalSec: 300, enabled: false } }, adapterConfig: { customSetting: "preserve", env: { KEEP: { type: "plain", value: "keep" } } } });
        expect((update![1].adapterConfig as { env?: Record<string, unknown> }).env).not.toHaveProperty("CODEX_HOME");
        expect(JSON.stringify(update![1])).not.toContain("example-api-key");
        expect(document.body.textContent).toContain(outcome === "failed save" ? "Connect a model" : "Let's get started...");
      } finally { await act(async () => root.unmount()); }
    });

    it.each(["completed", "before selection", "after selection", "failed response after selection"] as const)("selects the subscription again after a subscription to API to subscription round trip (API save: %s)", async completion => {
      const interrupted = completion !== "completed";
      const accounts: import("@paperclipai/shared").AiConnectionList = { currentUserId: "user-1", canManageConnections: true, connections: [{
        id: "subscription-account", grantId: "subscription-grant", companyId: "company-new", provider: "openai", method: "subscription",
        ownership: "personal", ownerUserId: "user-1", isDefault: true, status: "connected", name: "My subscription",
      }] };
      managedApi.list.mockImplementation(async () => structuredClone(accounts) as never);
      managedApi.create.mockImplementationOnce(async () => {
        accounts.connections.push({ ...accounts.connections[0]!, id: "managed-connection", grantId: "managed-grant", method: "api_key", isDefault: false, name: "My API key" });
        return { connectionId: "managed-connection", grantId: "managed-grant" };
      });
      let finishApiDefault!: () => void;
      let held = false;
      managedApi.setDefault.mockImplementation(async (_companyId, grantId) => {
        const apply = () => { for (const account of accounts.connections) account.isDefault = account.grantId === grantId; };
        if (interrupted && grantId === "managed-grant" && !held) {
          held = true;
          return new Promise<Record<string, never>>((resolve, reject) => { finishApiDefault = () => {
            apply();
            if (completion === "failed response after selection") reject(new Error("API default response was lost"));
            else resolve({});
          }; });
        }
        apply();
        return {};
      });
      mockAgentsApi.get.mockResolvedValue({ id: "agent-1", companyId: "company-new", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {} });
      const { root } = await openStep4({ adapterType: "codex_local" });
      const goBack = async () => {
        await act(async () => [...document.querySelectorAll("button")].find(button => button.textContent?.trim().startsWith("Back"))!.click());
        for (let i = 0; i < 10; i++) await flushReact();
      };
      try {
        await pickSource(/OpenAI/);
        await goBack();
        await act(async () => (document.querySelector('[aria-label="Use API key instead"]') as HTMLButtonElement).click());
        await pickSource(/OpenAI.*API/);
        await act(async () => setControlledValue(document.querySelector('input[aria-label="API key"]')!, "example-api-key"));
        await pressArcPrimary();
        if (!interrupted) expect(accounts.connections.find(account => account.isDefault)?.method).toBe("api_key");
        await goBack();
        if (completion === "before selection") await act(async () => finishApiDefault());
        await act(async () => (document.querySelector('[aria-label="Use subscription instead"]') as HTMLButtonElement).click());
        await pickSource(/OpenAI/);
        if (completion === "after selection" || completion === "failed response after selection") {
          expect(document.body.textContent).toContain("Connect a model");
          expect(document.body.textContent).not.toContain("Let's get started...");
          await act(async () => finishApiDefault());
          await vi.waitFor(() => expect(document.body.textContent).toContain("Let's get started..."));
        }
        expect(accounts.connections.find(account => account.isDefault)?.grantId).toBe("subscription-grant");
        expect(document.body.textContent).toContain("Let's get started...");
        await goBack();
        await act(async () => (document.querySelector('[aria-label="Use API key instead"]') as HTMLButtonElement).click());
        await pickSource(/OpenAI.*API/);
        await pressArcPrimary();
        expect(accounts.connections.find(account => account.isDefault)?.grantId).toBe("managed-grant");
        if (completion === "completed") for (const completeBeforeReselect of [true, false]) {
          let finishSubscriptionDefault!: () => void;
          managedApi.setDefault.mockImplementationOnce(async (_companyId, grantId) => new Promise<Record<string, never>>(resolve => {
            finishSubscriptionDefault = () => { for (const account of accounts.connections) account.isDefault = account.grantId === grantId; resolve({}); };
          }));
          await goBack();
          await act(async () => (document.querySelector('[aria-label="Use subscription instead"]') as HTMLButtonElement).click());
          await pickSource(/OpenAI/);
          await goBack();
          if (completeBeforeReselect) await act(async () => finishSubscriptionDefault());
          await act(async () => (document.querySelector('[aria-label="Use API key instead"]') as HTMLButtonElement).click());
          await pickSource(/OpenAI.*API/);
          await pressArcPrimary();
          if (!completeBeforeReselect) {
            expect(document.body.textContent).toContain("Connect a model");
            expect(document.body.textContent).not.toContain("Let's get started...");
            await act(async () => finishSubscriptionDefault());
          }
          await vi.waitFor(() => expect(document.body.textContent).toContain("Let's get started..."));
          expect(accounts.connections.find(account => account.isDefault)?.grantId).toBe("managed-grant");
        }
        expect(managedApi.create).toHaveBeenCalledTimes(1);
        expect(mockAgentsApi.hire).toHaveBeenCalledTimes(1);
      } finally { await act(async () => root.unmount()); }
    });

    it("selects the exact newly signed-in subscription when an API account was the default", async () => {
      managedApi.list.mockResolvedValue({ currentUserId: "user-1", connections: [{
        id: "api-account", grantId: "api-grant", companyId: "company-new", provider: "openai", method: "api_key",
        ownership: "personal", ownerUserId: "user-1", isDefault: true, status: "connected", name: "My API key",
      }] } as never);
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
      mockAgentsApi.getAdapterAuthLoginStatus.mockResolvedValue({ sessionId: "codex-session-1", status: "authenticated", prompt: { url: "https://auth.openai.com/codex/device", code: "TEST-CODE" } });
      managedApi.loginResult.mockResolvedValue({ connectionId: "new-subscription", grantId: "new-subscription-grant" });
      const { root } = await openStep4({ adapterType: "codex_local", credentialModeChoice: "subscription" });
      try {
        await pickSource(/OpenAI/);
        await vi.waitFor(() => expect(managedApi.loginResult).toHaveBeenCalledWith("company-new", "codex-session-1"), { timeout: CONNECTED_HOLD_MS + 1500 });
        expect(managedApi.setDefault).toHaveBeenLastCalledWith("company-new", "new-subscription-grant");
        await vi.waitFor(() => expect(mockAgentsApi.hire).toHaveBeenCalledTimes(1));
      } finally { await act(async () => root.unmount()); }
    });

    it.each(["company", "user"])("keeps a managed agent on Connect when a saved %s key needs a connected API account", async scope => {
      managedApi.list.mockResolvedValue({ currentUserId: "user-1", connections: [{
        id: "subscription-account", grantId: "subscription-grant", companyId: "company-new", provider: "openai", method: "subscription",
        ownership: "personal", ownerUserId: "user-1", isDefault: true, status: "connected", name: "My subscription",
      }] } as never);
      if (scope === "company") mockSecretsApi.list.mockResolvedValue([{ id: "saved-key", companyId: "company-new", name: "Saved API key", key: "OPENAI_API_KEY", scope: "company", status: "active" }] as never);
      else mockSecretsApi.listMyUserSecrets.mockResolvedValue([{ definition: { id: "saved-key", companyId: "company-new", name: "Saved API key", key: "OPENAI_API_KEY", status: "active" }, secret: { companyId: "company-new", status: "active" } }] as never);
      mockAgentsApi.get.mockResolvedValue({ id: "agent-1", companyId: "company-new", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: { aiConnection: { provider: "openai", method: "subscription", mode: "responsible_user" } } });
      const { root } = await openStep4({ adapterType: "codex_local" });
      try {
        await pickSource(/OpenAI/);
        await act(async () => [...document.querySelectorAll("button")].find(button => button.textContent?.trim().startsWith("Back"))!.click());
        for (let i = 0; i < 10; i++) await flushReact();
        await act(async () => (document.querySelector('[aria-label="Use API key instead"]') as HTMLButtonElement).click());
        await pickSource(/OpenAI.*API/);
        await pressArcPrimary();
        expect(document.body.textContent).toContain("Connect a model");
        expect(document.body.textContent).toContain("Enter a new API key");
        expect(mockAgentsApi.update.mock.calls.filter(([id]) => id === "agent-1")).toHaveLength(0);
        const select = document.querySelector('select[aria-label="Saved API key"]') as HTMLSelectElement;
        await act(async () => { select.value = ""; select.dispatchEvent(new Event("change", { bubbles: true })); });
        await act(async () => setControlledValue(document.querySelector('input[aria-label="API key"]')!, "example-api-key"));
        await pressArcPrimary();
        expect(document.body.textContent).toContain("Let's get started...");
        expect(mockAgentsApi.hire).toHaveBeenCalledTimes(1);
        expect(managedApi.create).toHaveBeenCalledTimes(1);
      } finally { await act(async () => root.unmount()); }
    });

    // N-16: the gateway is an advanced route, not the next thing after the key.
    // It sat directly under the API key field, inside the key card; it belongs
    // in the step's Advanced disclosure, hidden until that is opened.
    it.each([["Claude API", "claude_local", /Claude.*API/], ["Codex API", "codex_local", /OpenAI.*API/]] as const)("keeps Use a custom gateway in the closed Advanced disclosure on the %s key step", async (_path, adapterType, source) => {
      const handles = await openStep4({ adapterType, runner: "paperclip", credentialMode: "api" });
      try {
        await pickSource(source);
        const keyField = document.body.querySelector('input[type="password"]') as HTMLInputElement;
        expect(keyField, "the API key field should be showing").toBeTruthy();
        const gateway = () => [...document.body.querySelectorAll("button")].find(entry => entry.textContent?.trim() === "Use a custom gateway");
        expect(gateway(), "the custom gateway control should still exist").toBeTruthy();
        expect(document.body.querySelector('[aria-label="Runner"]')).toBeNull();
        const advanced = gateway()!.closest("details");
        expect(advanced, "Use a custom gateway should live inside the Advanced disclosure").toBeTruthy();
        expect(advanced!.querySelector(":scope > summary")?.textContent?.trim()).toBe("Advanced");
        expect(advanced!.open, "Advanced should start closed").toBe(false);
        expect(advanced!.contains(keyField), "the key field stays outside Advanced").toBe(false);
        await act(async () => { advanced!.open = true; });
        await flushReact();
        await act(async () => gateway()!.click());
        await flushReact();
        expect(document.querySelector('input[aria-label="Provider URL"]'), "the gateway dialog should still open from Advanced").toBeTruthy();
      } finally { await act(async () => handles.root.unmount()); }
    });

    it.each([["successful refresh", false], ["failed refresh and retry", true]] as const)("saves a custom gateway without probing, then explicitly tests and hires with its selected model: %s", async (_scenario, failRefresh) => {
      const gatewayAccounts: import("@paperclipai/shared").AiConnectionList = {
        currentUserId: "user-1", canManageConnections: true, connections: [],
      };
      let lookupFails = false;
      managedApi.list.mockImplementation(async () => {
        if (lookupFails) throw new Error("connection lookup failed");
        return structuredClone(gatewayAccounts) as never;
      });
      managedApi.create.mockImplementationOnce(async () => {
        gatewayAccounts.connections = [{
          id: "managed-connection", grantId: "managed-grant", companyId: "company-new",
          name: "My gateway.example.test", provider: "openai", method: "api_key", ownership: "personal",
          ownerUserId: "user-1", isDefault: false, status: "connected",
          routing: { kind: "gateway", protocol: "responses", auth: "bearer", baseUrl: "https://gateway.example.test/v1", models: [{ id: "gpt-5.4-mini" }] },
        }];
        lookupFails = failRefresh;
        return { connectionId: "managed-connection", grantId: "managed-grant" };
      });
      mockAdapterBuild.buildAdapterConfig.mockImplementation(values => ({ provider: "codex", model: values?.model }));
      const handles = await openStep4({ adapterType: "codex_local", runner: "paperclip", credentialMode: "api" });
      const click = async (label: string) => {
        const button = [...document.body.querySelectorAll("button")].find(entry => entry.textContent?.trim() === label)!;
        expect(button).toBeTruthy();
        await act(async () => button.click());
        await flushReact();
      };
      try {
        await pickSource(/OpenAI.*API/);
        await click("Use a custom gateway");
        const gatewayDialog = document.querySelector('input[aria-label="Provider URL"]')!.closest('[role="dialog"]')!;
        await act(async () => {
          setControlledValue(gatewayDialog.querySelector('input[aria-label="Provider URL"]')!, "https://gateway.example.test/v1");
          setControlledValue(gatewayDialog.querySelector('input[aria-label="API key"]')!, "example-gateway-key");
        });
        await click("Change");
        await act(async () => setControlledValue(document.querySelector('input[aria-label="Model IDs"]')!, "gpt-5.4-mini"));
        await act(async () => gatewayDialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true })));
        expect(mockAgentsApi.testEnvironment).not.toHaveBeenCalled();
        expect(mockAgentsApi.hire).not.toHaveBeenCalled();
        await click("Save connection");
        expect(managedApi.create).toHaveBeenCalledExactlyOnceWith("company-new", expect.objectContaining({
          provider: "openai", method: "api_key", apiKey: "example-gateway-key", ownership: "personal",
          agentIds: [expect.any(String)], routing: expect.objectContaining({ kind: "gateway", protocol: "responses", models: [{ id: "gpt-5.4-mini" }] }),
        }));
        if (failRefresh) {
          await vi.waitFor(() => expect(document.body.textContent).toContain("Your saved gateway connection could not be loaded."));
          expect(document.querySelector('select[aria-label="Model"]')).toBeNull();
          expect([...document.body.querySelectorAll("button")].find(entry => entry.textContent?.trim() === "Connect")!.disabled).toBe(true);
          expect(mockEnvironmentsApi.probe).not.toHaveBeenCalled();
          expect(mockAgentsApi.testEnvironment).not.toHaveBeenCalled();
          expect(mockAgentsApi.hire).not.toHaveBeenCalled();
          lookupFails = false;
          await click("Retry loading connection");
        }
        await vi.waitFor(() => expect(document.querySelector('select[aria-label="Model"]'), document.body.textContent ?? "").toBeTruthy());
        expect(mockEnvironmentsApi.probe).not.toHaveBeenCalled();
        expect(mockAgentsApi.testEnvironment).not.toHaveBeenCalled();
        expect(mockAgentsApi.hire).not.toHaveBeenCalled();
        expect(document.body.textContent).toContain("Gateway connection saved.");
        const connect = [...document.body.querySelectorAll("button")].find(entry => entry.textContent?.trim() === "Connect")!;
        expect(connect.disabled).toBe(true);
        const select = document.querySelector('select[aria-label="Model"]') as HTMLSelectElement;
        expect([...select.options].map(option => option.value)).toEqual(["", "gpt-5.4-mini"]);
        await act(async () => { select.value = "gpt-5.4-mini"; select.dispatchEvent(new Event("change", { bubbles: true })); });
        await flushReact();
        expect(mockAgentsApi.testEnvironment).not.toHaveBeenCalled();
        expect(mockAgentsApi.hire).not.toHaveBeenCalled();
        expect(JSON.stringify(window.localStorage)).not.toContain("example-gateway-key");
        await click("Connect");
        const binding = { provider: "openai", method: "api_key", mode: "delegated", connectionId: "managed-connection", grantId: "managed-grant" };
        expect(mockAgentsApi.testEnvironment).toHaveBeenCalledExactlyOnceWith("company-new", "codex_local", expect.objectContaining({
          environmentId: "env-sandbox-1", aiConnection: binding, adapterConfig: expect.objectContaining({ model: "gpt-5.4-mini" }),
        }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
        expect(mockAgentsApi.hire).toHaveBeenCalledExactlyOnceWith("company-new", expect.objectContaining({
          runtimeConfig: expect.objectContaining({ aiConnection: binding }), adapterConfig: expect.objectContaining({ model: "gpt-5.4-mini" }),
        }));
        expect(JSON.stringify(mockAgentsApi.hire.mock.calls)).not.toContain("example-gateway-key");
      } finally {
        await act(async () => handles.root.unmount());
        managedApi.list.mockResolvedValue({ currentUserId: "user-1", connections: [] });
      }
    }, 15_000);

    it.each([["paperclip", "image"], ["legacy", "image"], ["paperclip", "snapshot"], ["legacy", "snapshot"]] as const)("qualifies managed Claude during Connect and tests/hire with measured %s configuration from %s", async (measured, source) => {
      mockAdapterBuild.buildAdapterConfig.mockImplementation(values => buildClaudeLocalConfig(values!));
      mockEnvironmentsApi.list.mockResolvedValue([{ ...SANDBOX_ENVIRONMENT, config: {
        provider: "daytona", ...(source === "snapshot" ? { snapshot: "managed-snapshot" } : { image: `registry.example.test/runtime@sha256:${"a".repeat(64)}` }),
      } }]);
      const discovery = (runner: "paperclip" | "legacy") => [
        setupAdapterInfo({ type: "claude_local", loaded: true, disabled: false, defaultRunner: runner, supportedRunners: [runner] }),
        setupAdapterInfo({ type: "paperclip_runner", loaded: true, disabled: false }),
      ];
      let qualified = false;
      mockAdaptersApi.list.mockImplementation(async () => discovery(qualified ? measured : "legacy"));
      const handles = await openStep4({ adapterType: "claude_local", runner: "auto" });
      await act(async () => handles.queryClient.setQueryData(["ai-connections", "company-new"], {
        currentUserId: "user-1", connections: [{ id: "saved", grantId: "grant", companyId: "company-new", provider: "anthropic", method: "subscription", name: "My subscription", ownership: "personal", ownerUserId: "user-1", status: "connected", isDefault: true }],
      }));
      const calls: string[] = [];
      mockAdaptersApi.list.mockImplementation(async context => {
        expect(context).toEqual({ companyId: "company-new", environmentId: "env-sandbox-1" });
        calls.push(qualified ? "discovery-after" : "discovery-before");
        return discovery(qualified ? measured : "legacy");
      });
      mockEnvironmentsApi.probe.mockImplementation(async () => {
        calls.push("platform"); qualified = true;
        return { ok: true, driver: "sandbox", summary: "Measured image", details: { platformQualificationRecorded: true, leaseId: "owned-platform-lease" } };
      });
      mockAgentsApi.testEnvironment.mockImplementation(async () => {
        calls.push("adapter"); return { adapterType: measured === "paperclip" ? "paperclip_runner" : "claude_local", status: "pass", checks: [], testedAt: "2026-10-13T00:00:00Z" };
      });
      mockAgentsApi.hire.mockImplementation(async () => { calls.push("hire"); return { agent: { id: "agent-1" }, approval: null }; });
      try {
        expect(mockEnvironmentsApi.probe).not.toHaveBeenCalled();
        await pickSource(/Claude/);
        expect(calls).toEqual(["discovery-before", "platform", "discovery-after", "adapter", "hire"]);
        expect(mockEnvironmentsApi.probe).toHaveBeenCalledExactlyOnceWith("env-sandbox-1", "company-new", expect.objectContaining({ signal: expect.any(AbortSignal) }));
        const tested = (mockAgentsApi.testEnvironment.mock.calls[0] as unknown[])[2] as { adapterConfig: Record<string, unknown> };
        const saved = (mockAgentsApi.hire.mock.calls[0] as unknown[])[1] as { adapterConfig: Record<string, unknown> };
        expect(saved).not.toHaveProperty("runner");
        expect(saved.adapterConfig).toMatchObject(tested.adapterConfig);
        if (measured === "paperclip") expect(tested.adapterConfig).not.toHaveProperty("maxTurnsPerRun");
        else expect(tested.adapterConfig.maxTurnsPerRun).toBe(1000);
      } finally { await act(async () => handles.root.unmount()); }
    });

    it("stores a new API key once before managed qualification and hires with the same native configuration", async () => {
      const key = "example-scoped-api-key";
      mockAdapterBuild.buildAdapterConfig.mockImplementation(values => buildClaudeLocalConfig(values!));
      mockEnvironmentsApi.list.mockResolvedValue([{ ...SANDBOX_ENVIRONMENT, config: {
        provider: "daytona", image: `registry.example.test/runtime@sha256:${"a".repeat(64)}`,
      } }]);
      let qualified = false;
      mockAdaptersApi.list.mockImplementation(async () => [
        setupAdapterInfo({ type: "claude_local", defaultRunner: qualified ? "paperclip" : "legacy", supportedRunners: qualified ? ["paperclip"] : ["legacy"] }),
        setupAdapterInfo({ type: "paperclip_runner" }),
      ]);
      mockEnvironmentsApi.probe.mockImplementation(async () => {
        qualified = true;
        return { ok: true, driver: "sandbox", summary: "Measured image", details: { platformQualificationRecorded: true, leaseId: "owned-platform-lease" } };
      });
      const handles = await openStep4({ adapterType: "claude_local", runner: "auto", credentialMode: "api" });
      try {
        await pickSource(/Claude.*API/);
        const field = document.body.querySelector('input[type="password"]') as HTMLInputElement;
        await act(async () => setControlledValue(field, key));
        await flushReact();
        await pressArcPrimary();
        expect(managedApi.create).toHaveBeenCalledExactlyOnceWith("company-new", expect.objectContaining({ provider: "anthropic", method: "api_key", apiKey: key }));
        expect(mockEnvironmentsApi.probe).toHaveBeenCalledExactlyOnceWith("env-sandbox-1", "company-new", expect.objectContaining({ signal: expect.any(AbortSignal) }));
        expect(mockAgentsApi.testEnvironment).toHaveBeenCalledTimes(1);
        expect(mockAgentsApi.hire).toHaveBeenCalledTimes(1);
        const tested = (mockAgentsApi.testEnvironment.mock.calls[0] as unknown[])[2] as { adapterConfig: object };
        const saved = (mockAgentsApi.hire.mock.calls[0] as unknown[])[1] as { adapterConfig: object; runtimeConfig: object };
        expect(saved.adapterConfig).toMatchObject(tested.adapterConfig);
        expect(saved.adapterConfig).not.toHaveProperty("maxTurnsPerRun");
        expect(saved.runtimeConfig).toMatchObject({ aiConnection: { provider: "anthropic", method: "api_key", mode: "responsible_user" } });
        expect(JSON.stringify(saved)).not.toContain(key);
      } finally { await act(async () => handles.root.unmount()); }
    });

    it.each(["back", "environment-config"])("abandons held managed Claude qualification after %s without another probe", async change => {
      const image = `registry.example.test/runtime@sha256:${"a".repeat(64)}`;
      mockEnvironmentsApi.list.mockResolvedValue([{ ...SANDBOX_ENVIRONMENT, config: { provider: "daytona", image } }]);
      mockAdaptersApi.list.mockResolvedValue([
        setupAdapterInfo({ type: "claude_local", defaultRunner: "legacy", supportedRunners: ["legacy"] }), setupAdapterInfo({ type: "paperclip_runner" }),
      ]);
      const handles = await openStep4({ adapterType: "claude_local", runner: "auto" });
      await act(async () => handles.queryClient.setQueryData(["ai-connections", "company-new"], {
        currentUserId: "user-1", connections: [{ id: "saved", grantId: "grant", companyId: "company-new", provider: "anthropic", method: "subscription", name: "My subscription", ownership: "personal", ownerUserId: "user-1", status: "connected", isDefault: true }],
      }));
      let finish!: (value: import("@paperclipai/shared").EnvironmentProbeResult) => void;
      mockEnvironmentsApi.probe.mockReturnValue(new Promise(resolve => { finish = resolve; }));
      try {
        await pickSource(/Claude/);
        expect(mockEnvironmentsApi.probe).toHaveBeenCalledTimes(1);
        await act(async () => document.querySelector('[data-testid="onboarding-wizard"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true })));
        await flushReact();
        expect(mockEnvironmentsApi.probe).toHaveBeenCalledTimes(1);
        if (change === "back") await act(async () => [...document.body.querySelectorAll("button")].find(button => button.textContent?.trim() === "Back")!.click());
        else {
          await act(async () => handles.queryClient.setQueryData(queryKeys.environments.list("company-new"), [{ ...SANDBOX_ENVIRONMENT, config: {
            provider: "daytona", image: `registry.example.test/runtime@sha256:${"b".repeat(64)}`,
          } }]));
          await flushReact();
        }
        await act(async () => finish({ ok: true, driver: "sandbox", summary: "Measured image", details: { platformQualificationRecorded: true, leaseId: "owned-lease" } }));
        for (let i = 0; i < 8; i++) await flushReact();
        expect(mockEnvironmentsApi.probe).toHaveBeenCalledTimes(1);
        expect(mockAgentsApi.testEnvironment).not.toHaveBeenCalled();
        expect(mockAgentsApi.hire).not.toHaveBeenCalled();
      } finally { await act(async () => handles.root.unmount()); }
    });

    it("stops managed Claude onboarding at the existing platform-probe permission boundary", async () => {
      mockEnvironmentsApi.list.mockResolvedValue([{ ...SANDBOX_ENVIRONMENT, config: {
        provider: "daytona", image: `registry.example.test/runtime@sha256:${"a".repeat(64)}`,
      } }]);
      mockAdaptersApi.list.mockResolvedValue([
        setupAdapterInfo({ type: "claude_local", defaultRunner: "legacy", supportedRunners: ["legacy"] }), setupAdapterInfo({ type: "paperclip_runner" }),
      ]);
      const handles = await openStep4({ adapterType: "claude_local", runner: "auto" });
      await act(async () => handles.queryClient.setQueryData(["ai-connections", "company-new"], {
        currentUserId: "user-1", connections: [{ id: "saved", grantId: "grant", companyId: "company-new", provider: "anthropic", method: "subscription", name: "My subscription", ownership: "personal", ownerUserId: "user-1", status: "connected", isDefault: true }],
      }));
      mockEnvironmentsApi.probe.mockRejectedValue(new ApiError("Instance admin access required", 403, null));
      try {
        await pickSource(/Claude/);
        expect(document.body.textContent).toContain("Instance admin access required");
        expect(mockEnvironmentsApi.probe).toHaveBeenCalledTimes(1);
        expect(mockAgentsApi.testEnvironment).not.toHaveBeenCalled();
        expect(mockAgentsApi.hire).not.toHaveBeenCalled();
      } finally { await act(async () => handles.root.unmount()); }
    });

    it.each([
      ["claude_local", "anthropic", /Claude/, "claude-session-1", "claude-setup-token-status"],
      ["codex_local", "openai", /OpenAI/, "codex-session-1", "adapter-login-status"],
    ] as const)("finishes %s sign-in when its connection becomes visible before the completion poll", async (adapterType, provider, label, sessionId, statusKey) => {
      managedApi.loginResult.mockResolvedValue({ connectionId: "managed-connection", grantId: "managed-grant" });
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
      mockAgentsApi.hire.mockRejectedValueOnce(new Error("Temporary hire failure"));
      const { root, queryClient } = await openStep4({ adapterType });
      await pickSource(label);
      for (let i = 0; i < 6; i++) await flushReact();
      try {
        // The connection activity event arrives before the login poll. It must
        // not replace/unmount the controller that still owns the completion.
        await act(async () => {
          queryClient.setQueryData(["ai-connections", "company-new"], {
            currentUserId: "user-1",
            connections: [{ id: "managed-connection", grantId: "managed-grant", companyId: "company-new", provider, method: "subscription", name: "My subscription", ownership: "personal", ownerUserId: "user-1", status: "connected", isDefault: true }],
          });
        });
        for (let i = 0; i < 4; i++) await flushReact();
        expect(document.body.textContent).toContain(adapterType === "claude_local" ? "authorization code" : "Q2RJ-E1YIF");
        expect(mockAgentsApi.hire).not.toHaveBeenCalled();
        await act(async () => {
          queryClient.setQueryData(
            adapterType === "claude_local" ? [statusKey, "company-new", sessionId] : [statusKey, "company-new", adapterType, sessionId],
            { sessionId, status: "authenticated", expiresAt: new Date(Date.now() + 600_000).toISOString() },
          );
        });
        for (let i = 0; i < 120 && !mockAgentsApi.hire.mock.calls.length; i++) {
          await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
        }
        expect(mockAgentsApi.hire).toHaveBeenCalledTimes(1);
        expect(mockAgentsApi.hire).toHaveBeenCalledWith("company-new", expect.objectContaining({ runtimeConfig: expect.objectContaining({ aiConnection: { provider, method: "subscription", mode: "responsible_user" } }) }));
        for (let i = 0; i < 4; i++) await flushReact();
        expect(document.body.textContent).toContain("Temporary hire failure");
        const retry = [...document.body.querySelectorAll("button")].find(button => button.textContent?.trim() === "Connect");
        expect(retry).toBeTruthy();
        expect(retry!.disabled).toBe(false);
        await act(async () => { retry!.click(); });
        for (let i = 0; i < 6; i++) await flushReact();
        expect(mockAgentsApi.hire).toHaveBeenCalledTimes(2);
        expect(mockAgentsApi.startClaudeSetupTokenLogin.mock.calls.length + mockAgentsApi.startAdapterAuthLogin.mock.calls.length).toBe(1);
      } finally {
        await act(async () => root.unmount());
      }
    });

    it("names the tiles for the provider, not the adapter type", async () => {
      // `MODEL_SOURCE_NAMES` exists so this row says "Claude" and "OpenAI" —
      // which provider you are signing in to, the question the step's heading
      // asks — rather than the display registry's tool names, which the agent
      // config screens want. It was added with a long comment justifying it and
      // then never read, so the row went on rendering whatever the registry
      // supplied: "Claude Code" and "Codex" in the app, and the bare type here,
      // since this suite's registry mock returns `label: type`.
      mockAdapterRegistry.list = [setupAdapterInfo({ type: "claude_local" }), { type: "codex_local" }];
      const { root } = await openStep4({ adapterType: "claude_local" });

      const labels = [...document.body.querySelectorAll("button[aria-checked]")].map(
        (tile) => tile.textContent ?? "",
      );
      expect(labels.length, "both recommended sources should render").toBe(2);
      expect(labels.some((l) => l.includes("Claude"))).toBe(true);
      expect(labels.some((l) => l.includes("OpenAI"))).toBe(true);
      // The negative half is the one that fails on the unwired version: the
      // registry label is the adapter type, and it must not reach the tile.
      expect(labels.join(" ")).not.toContain("claude_local");
      expect(labels.join(" ")).not.toContain("codex_local");

      await act(async () => root.unmount());
    });

    it("will not advance on a saved adapter the step no longer offers", async () => {
      // A draft can name an adapter this registry does not carry — a cloud
      // sandbox without claude_local, an adapter since disabled. The row hides
      // it, so the step shows an unanswered question: no tile filled, no input
      // canvas. The CTA has to agree with that.
      //
      // It did not. The gate asked `sourcePicked`, which only means "a draft
      // named something", so Next stayed live on a step that had visibly asked
      // nothing and would hire against the hidden name. Reported by Greptile on
      // #12726.
      mockAdapterRegistry.list = [{ type: "codex_local" }];
      const { root } = await openStep4({ adapterType: "some_retired_adapter" });

      const tiles = [...document.body.querySelectorAll("button[aria-checked]")];
      expect(tiles.length, "the row should still offer what it has").toBeGreaterThan(0);
      expect(
        tiles.some((t) => t.getAttribute("aria-checked") === "true"),
        "no tile should read as chosen",
      ).toBe(false);

      const cta = [...document.body.querySelectorAll("button")].find(
        (b) => isArcPrimary(b.textContent?.trim() ?? ""),
      );
      expect(cta, "the step should render its forward button").toBeTruthy();
      expect(
        cta!.hasAttribute("disabled"),
        "Connect must not advance a question the step has not visibly asked",
      ).toBe(true);

      // And it opens again the moment the customer answers it themselves.
      await act(async () => {
        tiles[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      for (let i = 0; i < 5; i++) await flushReact();
      const ctaAfter = [...document.body.querySelectorAll("button")].find(
        (b) => isArcPrimary(b.textContent?.trim() ?? ""),
      );
      expect(ctaAfter!.hasAttribute("disabled")).toBe(false);

      await act(async () => root.unmount());
    });

    it("will not advance on a saved adapter the row does not show", async () => {
      mockAdapterRegistry.list = [setupAdapterInfo({ type: "claude_local" }), { type: "opencode_local" }];
      const { root } = await openStep4({ adapterType: "opencode_local" });

      const tiles = [...document.body.querySelectorAll("button[aria-checked]")];
      expect(
        tiles.some((t) => t.getAttribute("aria-checked") === "true"),
        "the saved adapter is not in this row, so nothing should read as chosen",
      ).toBe(false);

      const cta = [...document.body.querySelectorAll("button")].find(
        (b) => isArcPrimary(b.textContent?.trim() ?? ""),
      );
      expect(
        cta!.hasAttribute("disabled"),
        "Connect must not hire an adapter the row never offered",
      ).toBe(true);

      await act(async () => root.unmount());
    });

    it("will not hire from the keyboard on a source nobody selected", async () => {
      // The step has two ways forward, and gating only the visible one leaves
      // the defect intact behind a keystroke. Cmd+Enter called
      // `handleGiveHeartbeat` directly with its own, older list of conditions,
      // so with the button correctly disabled the same screen still hired on
      // Cmd+Enter. Reported by Greptile on #12726 after the button was fixed.
      //
      // The saved adapter is one the registry no longer carries, so the snap
      // replaces it with `claude_local` and clears the pick: the row shows two
      // tiles, neither chosen. A keystroke that gets through hires claude_local
      // — a real, offerable adapter that nobody on this screen selected, which
      // is what makes the bypass worth a test rather than a comment.
      mockAdapterRegistry.list = [setupAdapterInfo({ type: "claude_local" }), { type: "codex_local" }];
      const { root } = await openStep4({ adapterType: "some_retired_adapter" });

      const tiles = [...document.body.querySelectorAll("button[aria-checked]")];
      expect(
        tiles.some((t) => t.getAttribute("aria-checked") === "true"),
        "the snap must not leave a tile reading as chosen",
      ).toBe(false);

      const wizard = document.querySelector('[data-testid="onboarding-wizard"]');
      expect(wizard, "the wizard should be mounted").not.toBeNull();
      for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
        await act(async () => {
          wizard!.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true, ...modifier }),
          );
        });
        for (let i = 0; i < 6; i++) await flushReact();
      }

      expect(
        mockAgentsApi.hire,
        "no keystroke may hire a source nobody selected",
      ).not.toHaveBeenCalled();

      // And it works once the question is answered, so this is a gate rather
      // than a dead shortcut.
      await act(async () => {
        tiles[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      for (let i = 0; i < 6; i++) await flushReact();
      await act(async () => {
        wizard!.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, metaKey: true }),
        );
      });
      for (let i = 0; i < 6; i++) await flushReact();
      expect(mockAgentsApi.hire).toHaveBeenCalled();

      await act(async () => root.unmount());
    });

    it("starts no call to the test-environment route on adapter selection", async () => {
      const { root } = await openStep4();
      expect(mockAgentsApi.testEnvironment).not.toHaveBeenCalled();
      await act(async () => root.unmount());
    });

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

    it("saves the submitted name before any provider choice or authentication", async () => {
      const { root } = await openStep4();
      expect(mockAgentsApi.create).toHaveBeenCalledTimes(1);
      expect(mockAgentsApi.create.mock.calls[0][1]).toMatchObject({ name: "Ada", adapterType: "process", metadata: { setupAdapterPending: true }, runtimeConfig: { heartbeat: { enabled: false } } });
      expect(document.body.querySelector('[role="radio"][aria-checked="true"]')).toBeNull();
      expect(mockAgentsApi.startClaudeSetupTokenLogin).not.toHaveBeenCalled();
      expect(mockAgentsApi.startAdapterAuthLogin).not.toHaveBeenCalled();
      expect(managedApi.startLocalLogin).not.toHaveBeenCalled();
      await pickSource(/OpenAI/);
      expect(mockAgentsApi.create).toHaveBeenCalledTimes(1);
      expect(mockAgentsApi.update).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ adapterType: "codex_local", metadata: { setupAdapterPending: false } }), "company-new");
      await act(async () => root.unmount());
    });

    it("saves a provisional enabled provider when process is disabled without choosing its tile", async () => {
      mockAdapterRegistry.disabled = new Set(["process"]);
      const { root } = await openStep4();
      expect(mockAgentsApi.create.mock.calls[0][1]).toMatchObject({ adapterType: "claude_local", metadata: { setupAdapterPending: true } });
      expect(document.body.querySelector('[role="radio"][aria-checked="true"]')).toBeNull();
      expect(mockAgentsApi.startClaudeSetupTokenLogin).not.toHaveBeenCalled();
      await act(async () => root.unmount());
    });

    it("creates its own record instead of adopting another user's name-only setup", async () => {
      mockAgentsApi.list.mockResolvedValue([{ id: "another-user-setup", companyId: "company-new", name: "Ada", pauseReason: "setup", createdByUserId: "other-user", adapterType: "process", adapterConfig: {}, metadata: { setupAdapterPending: true } } as never]);
      mockAgentsApi.create.mockImplementationOnce(async (_company, input) => ({ ...input, id: input.setupId, name: "Ada 2", pauseReason: "setup" }));
      const { root } = await openStep4();
      expect(mockAgentsApi.create).toHaveBeenCalledTimes(1);
      const setupId = mockAgentsApi.create.mock.calls[0][1].setupId;
      expect(setupId).not.toBe("another-user-setup");
      expect(JSON.parse(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)!)).toMatchObject({ agentName: "Ada 2", setupAgentId: setupId });
      await pickSource(/OpenAI/);
      expect(mockAgentsApi.update.mock.calls.every(([id]) => id === setupId)).toBe(true);
      expect(mockAgentsApi.update).toHaveBeenCalledWith(setupId, expect.objectContaining({ name: "Ada 2" }), "company-new");
      await act(async () => root.unmount());
    });

    it("restores a name-only record without restoring its provisional runner or model", async () => {
      const setupId = "00000000-0000-4000-8000-000000000094";
      mockAgentsApi.create.mockResolvedValueOnce({ id: setupId, companyId: "company-new", name: "Ada", role: "general", adapterType: "process", adapterConfig: { model: "provisional-model" }, runtimeConfig: {}, pauseReason: "setup", metadata: { setupAdapterPending: true } } as never);
      const { root } = await openStep4({ adapterType: "process", runner: "legacy", model: "stale-model", setupAgentId: setupId });
      expect(JSON.parse(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)!)).toMatchObject({ runner: "auto", model: "", setupAgentId: setupId });
      expect(document.body.querySelector('[role="radio"][aria-checked="true"]')).toBeNull();
      await pickSource(/Claude/);
      expect(JSON.parse(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)!).runner).toBe("auto");
      expect(mockAgentsApi.update).toHaveBeenCalledWith(setupId, expect.objectContaining({ runner: "auto" }), "company-new");
      await act(async () => root.unmount());
    });

    it("creates and saves an inactive identity before starting sandbox sign-in", async () => {
      let finish!: (agent: { id: string; pauseReason: string }) => void;
      mockAgentsApi.create.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }) as never);
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
      const { root } = await openStep4({ adapterType: "claude_local" });
      await pickSource(/Claude/);
      expect(mockAgentsApi.create).toHaveBeenCalledTimes(1);
      const input = mockAgentsApi.create.mock.calls[0][1];
      expect(input).toMatchObject({ name: "Ada", runtimeConfig: { heartbeat: { enabled: false } } });
      expect(JSON.parse(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)!)).toMatchObject({ setupAgentId: input.setupId });
      expect(mockAgentsApi.startClaudeSetupTokenLogin).not.toHaveBeenCalled();
      expect(mockAgentsApi.hire).not.toHaveBeenCalled();
      await act(async () => finish({ id: String(input.setupId), pauseReason: "setup" }));
      for (let i = 0; i < 10; i++) await flushReact();
      expect(mockAgentsApi.startClaudeSetupTokenLogin).toHaveBeenCalledTimes(1);
      await act(async () => root.unmount());
    });

    it("reuses the persisted setup identity on a fresh onboarding mount", async () => {
      const setupId = "00000000-0000-4000-8000-000000000081";
      const { root } = await openStep4({ adapterType: "claude_local", setupAgentId: setupId });
      await pickSource(/Claude/);
      expect(mockAgentsApi.create).toHaveBeenCalledWith("company-new", expect.objectContaining({ setupId }));
      await act(async () => root.unmount());
    });

    it("saves chosen model settings on the setup record before hiring", async () => {
      mockAdapterBuild.buildAdapterConfig.mockImplementation(values => ({ model: values?.model }));
      const { root } = await openStep4({ adapterType: "codex_local", model: "gpt-5.4" });
      await pickSource(/OpenAI/);
      const setupId = mockAgentsApi.create.mock.calls[0][1].setupId;
      expect(mockAgentsApi.update).toHaveBeenCalledWith(setupId, expect.objectContaining({
        adapterConfig: { model: "gpt-5.4" }, runtimeConfig: expect.objectContaining({ heartbeat: expect.objectContaining({ enabled: false }) }),
      }), "company-new");
      expect(mockAgentsApi.hire).not.toHaveBeenCalled();
      await act(async () => root.unmount());
    });

    it("loads the server setup before an older local draft can autosave over it", async () => {
      const setupId = "00000000-0000-4000-8000-000000000082";
      mockAdapterBuild.buildAdapterConfig.mockImplementation(values => ({ model: values?.model }));
      mockAgentsApi.create.mockResolvedValueOnce({ id: setupId, companyId: "company-new", name: "Ada", role: "general",
        adapterType: "codex_local", adapterConfig: { model: "server-model", customSetting: "preserve" },
        runtimeConfig: {}, pauseReason: "setup", defaultEnvironmentId: "env-sandbox-1" } as never);
      const { root } = await openStep4({ adapterType: "codex_local", model: "old-local-model", setupAgentId: setupId });
      await pickSource(/OpenAI/);
      const saves = mockAgentsApi.update.mock.calls.filter(call => call[0] === setupId);
      expect(saves.length).toBeGreaterThan(0);
      for (const [, body] of saves.filter(([, body]) => body.adapterConfig)) expect(body.adapterConfig).toMatchObject({ model: "server-model", customSetting: "preserve" });
      expect(JSON.parse(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)!).model).toBe("server-model");
      await act(async () => root.unmount());
    });

    it.each([false, true])("migrates a stored Copilot setup without reusing its model or binding, with providers disabled: %s", async providersDisabled => {
      const setupId = "00000000-0000-4000-8000-000000000095";
      if (providersDisabled) mockAdapterRegistry.disabled = new Set(["claude_local", "codex_local"]);
      mockAgentsApi.create.mockResolvedValueOnce({ id: setupId, companyId: "company-new", name: "Ada", role: "general",
        adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "copilot", model: "copilot-model" },
        runtimeConfig: { aiConnection: { provider: "github", method: "api_key", mode: "responsible_user" } },
        pauseReason: "setup", defaultEnvironmentId: "env-sandbox-1" } as never);
      const { root } = await openStep4({ adapterType: "paperclip_runner", onboardingCopilot: true, setupAgentId: setupId });
      try {
        const saved = JSON.parse(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)!);
        expect(saved).toMatchObject({ adapterType: "claude_local", runner: "auto", model: "", setupAgentId: setupId });
        expect(saved).not.toHaveProperty("onboardingCopilot");
        expect(document.body.querySelector('button[aria-checked="true"]')).toBeNull();
        expect(mockAgentsApi.hire).not.toHaveBeenCalled();
        if (!providersDisabled) {
          await pickSource(/Claude/);
          const saves = mockAgentsApi.update.mock.calls.filter(([id, body]) => id === setupId && body.adapterConfig);
          expect(saves.length).toBeGreaterThan(0);
          for (const [, body] of saves) {
            expect(body).toMatchObject({ adapterType: "claude_local", runner: "auto" });
            expect(body.adapterConfig).not.toHaveProperty("acpxAgent", "copilot");
            expect(body.adapterConfig).not.toHaveProperty("model", "copilot-model");
            expect(body.runtimeConfig).not.toHaveProperty("aiConnection.provider", "github");
          }
        }
      } finally { await act(async () => root.unmount()); }
    });

    it("tests and hires in the restored setup environment instead of the instance default", async () => {
      const setupId = "00000000-0000-4000-8000-000000000083";
      mockEnvironmentsApi.list.mockResolvedValue([SANDBOX_ENVIRONMENT, { ...SANDBOX_ENVIRONMENT, id: "saved-environment" }]);
      mockAgentsApi.getClaudeOAuthTokenStatus.mockResolvedValue({ secretId: "saved-claude", latestVersion: 1 });
      mockAgentsApi.create.mockResolvedValueOnce({ id: setupId, companyId: "company-new", name: "Ada", role: "general",
        adapterType: "claude_local", adapterConfig: { model: "server-model" }, runtimeConfig: {},
        pauseReason: "setup", defaultEnvironmentId: "saved-environment" } as never);
      const { root } = await openStep4({ adapterType: "claude_local", setupAgentId: setupId });
      await pickSource(/Claude/);
      expect(mockAgentsApi.testEnvironment).toHaveBeenCalledWith("company-new", "claude_local", expect.objectContaining({ environmentId: "saved-environment" }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
      expect(mockAgentsApi.hire).toHaveBeenCalledWith("company-new", expect.objectContaining({ defaultEnvironmentId: "saved-environment" }));
      await act(async () => root.unmount());
    });

    it("drops the restored OpenAI connection after switching to a stored Claude login", async () => {
      mockAgentsApi.testEnvironment.mockImplementation(async (...args: unknown[]) => ({ adapterType: args[1] as string,
        status: args[1] === "codex_local" ? "fail" as const : "pass" as const, checks: [], testedAt: new Date().toISOString() }));
      const setupId = "00000000-0000-4000-8000-000000000084";
      mockAgentsApi.getClaudeOAuthTokenStatus.mockResolvedValue({ secretId: "saved-claude", latestVersion: 1 });
      mockAgentsApi.create.mockResolvedValueOnce({ id: setupId, companyId: "company-new", name: "Ada", role: "general",
        adapterType: "codex_local", adapterConfig: { model: "gpt-5.4" }, runtimeConfig: {
          aiConnection: { provider: "openai", method: "subscription", mode: "responsible_user" }, customSetting: "preserve",
        }, pauseReason: "setup", defaultEnvironmentId: "env-sandbox-1" } as never);
      const { root } = await openStep4({ adapterType: "codex_local", setupAgentId: setupId });
      await pickSource(/OpenAI/);
      const back = [...document.body.querySelectorAll("button")].find(button => button.textContent?.trim().startsWith("Back"))!;
      await act(async () => back.click());
      for (let i = 0; i < 10; i++) await flushReact();
      await pickSource(/Claude/);
      const saves = mockAgentsApi.update.mock.calls.filter(([, body]) => body.adapterType === "claude_local");
      expect(saves.length).toBeGreaterThan(0);
      for (const [, body] of saves) expect(body.runtimeConfig).not.toHaveProperty("aiConnection");
      const hire = (mockAgentsApi.hire.mock.calls as unknown as Array<[string, { adapterType: string; runtimeConfig: Record<string, unknown> }]>).find(([, body]) => body.adapterType === "claude_local")?.[1];
      expect(hire).toBeTruthy();
      expect(hire!.runtimeConfig).toMatchObject({ customSetting: "preserve" });
      expect(hire!.runtimeConfig).not.toHaveProperty("aiConnection");
      await act(async () => root.unmount());
    });

    it("tests restored redacted environment values using the setup record", async () => {
      const setupId = "00000000-0000-4000-8000-000000000086";
      mockAgentsApi.create.mockResolvedValueOnce({ id: setupId, companyId: "company-new", name: "Ada", role: "general",
        adapterType: "codex_local", adapterConfig: { env: { CODEX_HOME: { type: "plain", value: "***REDACTED***" }, OPENAI_API_KEY: { type: "secret_ref", secretId: "saved-key" } } },
        runtimeConfig: {}, pauseReason: "setup", defaultEnvironmentId: "env-sandbox-1" } as never);
      const { root } = await openStep4({ adapterType: "codex_local", setupAgentId: setupId });
      await pickSource(/OpenAI/);
      await pressArcPrimary();
      expect(mockAgentsApi.testEnvironment).toHaveBeenCalledWith("company-new", "codex_local", expect.objectContaining({ agentId: setupId,
        adapterConfig: expect.objectContaining({ env: expect.objectContaining({ CODEX_HOME: { type: "plain", value: "***REDACTED***" } }) }),
      }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
      await act(async () => root.unmount());
    });

    it.each(["api", "subscription"] as const)("removes old Claude credentials when resuming with %s authentication", async mode => {
      let changedMode = false;
      mockAgentsApi.testEnvironment.mockImplementation(async () => ({ adapterType: "claude_local",
        status: changedMode ? "pass" as const : "fail" as const, checks: [], testedAt: new Date().toISOString() }));
      const setupId = "00000000-0000-4000-8000-000000000087";
      const secret = { type: "secret_ref", secretId: "saved-key" };
      mockAgentsApi.getClaudeOAuthTokenStatus.mockResolvedValue({ secretId: "saved-claude", latestVersion: 1 });
      mockSecretsApi.list.mockResolvedValue([{ id: "saved-key", companyId: "company-new", name: "Saved API key", key: "ANTHROPIC_API_KEY", scope: "company", status: "active" }] as never);
      mockAgentsApi.create.mockResolvedValueOnce({ id: setupId, companyId: "company-new", name: "Ada", role: "general",
        adapterType: "claude_local", adapterConfig: { env: { KEEP: { type: "plain", value: "***REDACTED***" },
          [mode === "api" ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY"]: secret } },
        runtimeConfig: {}, pauseReason: "setup", defaultEnvironmentId: "env-sandbox-1" } as never);
      const { root } = await openStep4({ adapterType: "claude_local", setupAgentId: setupId, credentialModeChoice: mode });
      await pickSource(/Claude/);
      expect(JSON.parse(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)!).credentialMode).toBe(mode === "api" ? "subscription" : "api");
      const back = [...document.body.querySelectorAll("button")].find(button => button.textContent?.trim().startsWith("Back"))!;
      await act(async () => back.click());
      for (let i = 0; i < 10; i++) await flushReact();
      changedMode = true;
      const switcher = document.body.querySelector(`[aria-label="Use ${mode === "api" ? "API key" : "subscription"} instead"]`) as HTMLButtonElement;
      await act(async () => switcher.click());
      await pickSource(/Claude/);
      if (mode === "api") await pressArcPrimary();
      const call = (mockAgentsApi.testEnvironment.mock.calls as unknown[][]).at(-1);
      expect(call).toBeTruthy();
      const config = (call![2] as { adapterConfig: { env: Record<string, unknown> } }).adapterConfig;
      expect(config.env).toHaveProperty("KEEP");
      expect(config.env).not.toHaveProperty(mode === "api" ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY");
      expect(config.env).toHaveProperty(mode === "api" ? "ANTHROPIC_API_KEY" : "CLAUDE_CODE_OAUTH_TOKEN");
      await act(async () => root.unmount());
    });

    it("starts setup for the new company while the previous company's creation is pending", async () => {
      let finish!: (agent: unknown) => void;
      mockAgentsApi.create.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }) as never);
      const { root, queryClient } = await openStep4({ adapterType: "codex_local" });
      await pickSource(/OpenAI/);
      expect(mockAgentsApi.create).toHaveBeenCalledTimes(1);
      mockCompany.companies.push({ id: "company-other", name: "Other", issuePrefix: "OTH" });
      mockDialog.onboardingOptions = { initialStep: 4, companyId: "company-other" };
      await act(async () => root.render(<QueryClientProvider client={queryClient}><OnboardingWizard /></QueryClientProvider>));
      for (let i = 0; i < 10; i++) await flushReact();
      expect(mockAgentsApi.create).toHaveBeenCalledWith("company-other", expect.objectContaining({ setupId: expect.any(String) }));
      const nextId = mockAgentsApi.create.mock.calls.find(call => call[0] === "company-other")![1].setupId;
      await act(async () => finish({ id: "old-company-setup", pauseReason: "setup" }));
      for (let i = 0; i < 5; i++) await flushReact();
      expect(JSON.parse(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)!)).toMatchObject({ createdCompanyId: "company-other", setupAgentId: nextId });
      expect(document.body.textContent).not.toContain("Creating your agent…");
      await act(async () => root.unmount());
    });

    it("starts the claude_local sign-in on Connect when the signal reports no ready credential", async () => {
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
      const { root } = await openStep4({ adapterType: "claude_local" });

      // Nothing before the press. The card *is* the sign-in now, so it does not
      // exist until the step has been asked to start one — which is the whole
      // difference between this step and the one it replaced.
      expect(mockAgentsApi.startClaudeSetupTokenLogin).not.toHaveBeenCalled();

      await pickSource(/Claude/);

      expect(mockAgentsApi.startClaudeSetupTokenLogin).toHaveBeenCalled();
      // Connect started a sign-in rather than hiring. The ordering is the point:
      // a hire here would create an agent with no credential to run on.
      expect(mockAgentsApi.hire).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain(
        "Sign in to Claude then come back and enter authorization code",
      );

      await act(async () => root.unmount());
    });

    it("collapses the row to the chosen source and walks the button through the sign-in", async () => {
      // The sequence, end to end, as the step actually runs it: the row is the
      // question, answering it starts the sign-in, and the button reports where
      // that has got to rather than offering an action it cannot perform.
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
      const { root } = await openStep4({ adapterType: "claude_local" });

      // Collapse is read off the row's own layout, not off how many tiles are
      // in the DOM: the leaving tile exits through AnimatePresence, and in
      // jsdom an exit never completes, so it stays mounted either way.
      const rowCentred = () =>
        document.body
          .querySelector('[role="radiogroup"]')!
          .className.includes("justify-center");
      const cta = () =>
        [...document.body.querySelectorAll("button")].pop()?.textContent?.trim();

      // Nothing chosen yet on a fresh arrival: the row is a question.
      expect(rowCentred()).toBe(false);

      await pickSource(/Claude/);

      // The row has been answered, so it now shows only the answer — leaving
      // the alternative up would invite a press that has to cancel a live
      // session to honour.
      expect(rowCentred()).toBe(true);
      expect(mockAgentsApi.startClaudeSetupTokenLogin).toHaveBeenCalled();

      // And the button has become the sign-in rather than a step advance.
      expect(cta()).toBe("Sign in to Claude");

      // Back unwinds rather than leaving the step: the row is a question again.
      const back = [...document.body.querySelectorAll("button")].find((b) =>
        b.textContent?.trim().startsWith("Back"),
      );
      await act(async () => {
        back!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      for (let i = 0; i < 10; i++) await flushReact();

      expect(rowCentred()).toBe(false);
      expect(cta()).toBe("Next");
      expect(document.body.textContent).toContain("Connect a model");

      await act(async () => root.unmount());
    });

    it.each([
      ["claude_local", /Claude/, "claude.ai", "link"],
      ["claude_local", /Claude/, "claude.ai", "button"],
      ["codex_local", /OpenAI/, "auth.openai.com", "link"],
      ["codex_local", /OpenAI/, "auth.openai.com", "button"],
    ] as const)("shows the provider waiting state after the %s %s %s %s opens sign-in", async (adapterType, source, host, control) => {
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
      const { root } = await openStep4({ adapterType });
      await pickSource(source);
      const open = vi.spyOn(window, "open").mockImplementation(() => null);
      try {
        const link = document.body.querySelector(`a[href*="${host}"]`) as HTMLAnchorElement;
        expect(link.target).toBe("_blank");
        await act(async () => {
          if (control === "link") link.click();
          else [...document.body.querySelectorAll("button")].at(-1)!.click();
        });
        expect(open).toHaveBeenCalledExactlyOnceWith(link.href, "_blank", "noreferrer,noopener");
        const primary = [...document.body.querySelectorAll("button")].at(-1)!;
        expect(primary.textContent?.trim()).toBe(adapterType === "codex_local" ? "Waiting for auth…" : "Waiting for code…");
        expect(primary.disabled).toBe(true);
        await act(async () => primary.click());
        await act(async () => document.querySelector('[data-testid="onboarding-wizard"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true })));
        expect(open).toHaveBeenCalledTimes(1);
        await act(async () => link.click());
        expect(open).toHaveBeenNthCalledWith(2, link.href, "_blank", "noreferrer,noopener");
        expect(primary.textContent?.trim()).toBe(adapterType === "codex_local" ? "Waiting for auth…" : "Waiting for code…");
        expect(primary.disabled).toBe(true);
        if (adapterType === "claude_local") expect((document.querySelector('input[aria-label="Authorization code"]') as HTMLInputElement).disabled).toBe(false);
        expect(mockAgentsApi.hire).not.toHaveBeenCalled();
        expect(adapterType === "claude_local" ? mockAgentsApi.startClaudeSetupTokenLogin : mockAgentsApi.startAdapterAuthLogin).toHaveBeenCalledTimes(1);
      } finally {
        open.mockRestore();
        await act(async () => root.unmount());
      }
    });

    it.each([false, true])("submits a code inserted without a paste event from the footer (opened link: %s)", async openedLink => {
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
      const { root } = await openStep4({ adapterType: "claude_local" });
      await pickSource(/Claude/);
      const open = vi.spyOn(window, "open").mockImplementation(() => null);
      try {
        if (openedLink) await act(async () => (document.body.querySelector('a[href*="claude.ai"]') as HTMLAnchorElement).click());
        open.mockClear();
        const field = document.body.querySelector('input[aria-label="Authorization code"]') as HTMLInputElement;
        await act(async () => setControlledValue(field, "authorization-code"));
        expect(mockAgentsApi.submitClaudeSetupTokenBrowserCode).not.toHaveBeenCalled();
        const primary = [...document.body.querySelectorAll("button")].at(-1)!;
        expect(primary.textContent?.trim()).toBe("Submit code");
        expect(primary.disabled).toBe(false);
        await act(async () => { primary.click(); primary.click(); });
        expect(mockAgentsApi.submitClaudeSetupTokenBrowserCode).toHaveBeenCalledExactlyOnceWith("company-new", "claude-session-1", "authorization-code");
        expect(open).not.toHaveBeenCalled();
        expect([...document.body.querySelectorAll("button")].at(-1)!.textContent?.trim()).toBe("Connecting");
        expect(mockAgentsApi.startClaudeSetupTokenLogin).toHaveBeenCalledTimes(1);
        expect(mockAgentsApi.hire).not.toHaveBeenCalled();
      } finally {
        open.mockRestore();
        await act(async () => root.unmount());
      }
    });

    it.each([{}, { metaKey: true }, { ctrlKey: true }])("submits the code once with Enter from its field (%j)", async modifier => {
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
      const { root } = await openStep4({ adapterType: "claude_local" });
      await pickSource(/Claude/);
      const open = vi.spyOn(window, "open").mockImplementation(() => null);
      try {
        open.mockClear();
        const field = document.body.querySelector('input[aria-label="Authorization code"]') as HTMLInputElement;
        await act(async () => setControlledValue(field, "authorization-code"));
        await act(async () => field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...modifier })));
        expect(mockAgentsApi.submitClaudeSetupTokenBrowserCode).toHaveBeenCalledExactlyOnceWith("company-new", "claude-session-1", "authorization-code");
        expect(open).not.toHaveBeenCalled();
        expect(mockAgentsApi.hire).not.toHaveBeenCalled();
      } finally {
        open.mockRestore();
        await act(async () => root.unmount());
      }
    });

    it.each([{ metaKey: true }, { ctrlKey: true }])("submits the code with the wizard shortcut while waiting (%j)", async modifier => {
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
      const { root } = await openStep4({ adapterType: "claude_local" });
      await pickSource(/Claude/);
      const open = vi.spyOn(window, "open").mockImplementation(() => null);
      try {
        await act(async () => (document.body.querySelector('a[href*="claude.ai"]') as HTMLAnchorElement).click());
        open.mockClear();
        const field = document.body.querySelector('input[aria-label="Authorization code"]') as HTMLInputElement;
        await act(async () => setControlledValue(field, "authorization-code"));
        const wizard = document.querySelector('[data-testid="onboarding-wizard"]')!;
        await act(async () => wizard.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...modifier })));
        expect(mockAgentsApi.submitClaudeSetupTokenBrowserCode).toHaveBeenCalledExactlyOnceWith("company-new", "claude-session-1", "authorization-code");
        expect(open).not.toHaveBeenCalled();
        expect(mockAgentsApi.hire).not.toHaveBeenCalled();
      } finally {
        open.mockRestore();
        await act(async () => root.unmount());
      }
    });

    it("withdraws the footer submit action when the code is cleared or the card is closed", async () => {
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
      const { root } = await openStep4({ adapterType: "claude_local" });
      await pickSource(/Claude/);
      const field = document.body.querySelector('input[aria-label="Authorization code"]') as HTMLInputElement;
      await act(async () => (document.body.querySelector('a[href*="claude.ai"]') as HTMLAnchorElement).click());
      await act(async () => setControlledValue(field, "authorization-code"));
      const primary = () => [...document.body.querySelectorAll("button")].at(-1)!;
      expect(primary().textContent?.trim()).toBe("Submit code");
      await act(async () => setControlledValue(field, ""));
      expect(primary().textContent?.trim()).toBe("Waiting for code…");
      expect(primary().disabled).toBe(true);
      await act(async () => setControlledValue(field, "authorization-code"));
      const back = [...document.body.querySelectorAll("button")].find(button => button.textContent?.trim().startsWith("Back"))!;
      await act(async () => back.click());
      for (let i = 0; i < 10; i++) await flushReact();
      expect(primary().textContent?.trim()).toBe("Next");
      expect(primary().disabled).toBe(true);
      expect(mockAgentsApi.submitClaudeSetupTokenBrowserCode).not.toHaveBeenCalled();
      await act(async () => root.unmount());
    });

    it("submits the browser code on the paste, not on the first keystroke", async () => {
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
      const { root } = await openStep4({ adapterType: "claude_local" });
      await pickSource(/Claude/);

      const field = document.body.querySelector(
        'input[aria-label="Authorization code"]',
      ) as HTMLInputElement | null;
      expect(field, "the Claude card should offer a code field").toBeTruthy();

      // The trap this pins. `isValidBrowserCode` reads like a completeness
      // check and is not one — it accepts any printable ASCII from a single
      // character up — so an auto-submit keyed off the value fires here, on the
      // first character of anyone typing the code rather than pasting it, and
      // clears the field they are typing into.
      await act(async () => {
        setControlledValue(field!, "Q");
      });
      for (let i = 0; i < 4; i++) await flushReact();
      expect(mockAgentsApi.submitClaudeSetupTokenBrowserCode).not.toHaveBeenCalled();

      // The paste is the answer, so it goes without a press. Order matches a
      // real paste: the event lands before the value changes.
      await act(async () => {
        field!.dispatchEvent(new Event("paste", { bubbles: true }));
        setControlledValue(field!, "Q2RJ-E1YIF-authorization-code");
      });
      for (let i = 0; i < 4; i++) await flushReact();
      expect(mockAgentsApi.submitClaudeSetupTokenBrowserCode).toHaveBeenCalledWith(
        "company-new",
        "claude-session-1",
        "Q2RJ-E1YIF-authorization-code",
      );
      // And it stays on screen. Clearing the field on submit emptied it in the
      // same frame the paste landed, so the only feedback for the seconds that
      // followed was an input that had just gone blank — reported from staging
      // as the paste looking dropped, or the step looking stuck.
      expect(field!.value).toBe("Q2RJ-E1YIF-authorization-code");
      // As dots. The code is kept so the customer can see the paste landed,
      // and that is all the field needs to show of it.
      expect(field!.type).toBe("password");
      // And the button answers the paste itself. The status here never reaches
      // authenticated, so this is "Connecting" before any server confirmation —
      // waiting for that left about a second of a button still reading
      // "Waiting for code" after the code had gone in.
      expect(
        [...document.body.querySelectorAll("button")].pop()?.textContent?.trim(),
      ).toBe("Connecting");

      await act(async () => root.unmount());
    });

    it("does not hire on the paste alone, before the login is stored", async () => {
      // "Connecting" appears at the paste now, ahead of the server confirming
      // anything. The two-second hold used to start at that same moment, so
      // moving one without the other would hire at the paste plus two seconds
      // whether or not a credential existed. The status here stays pending, so
      // the login is never stored.
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
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
      // The paste really did start Connecting; without this the assertion
      // below would hold for a flow that never got that far.
      expect(cta(), "the paste should have started Connecting").toBe("Connecting");

      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, CONNECTED_HOLD_MS + 400));
      });
      for (let i = 0; i < 4; i++) await flushReact();

      expect(mockAgentsApi.hire).not.toHaveBeenCalled();
      expect(cta()).toBe("Connecting");

      await act(async () => root.unmount());
    });

    it("gives the button back when the pasted code is refused", async () => {
      // The other half of answering the paste early: a button that says
      // "Connecting" before the server answers has to stop saying it when the
      // answer is no, or it spins on a login that is not coming.
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
      mockAgentsApi.submitClaudeSetupTokenBrowserCode.mockRejectedValueOnce(
        new Error("That authorization code was not accepted."),
      );
      const { root } = await openStep4({ adapterType: "claude_local" });
      await pickSource(/Claude/);

      const cta = () =>
        [...document.body.querySelectorAll("button")].pop()?.textContent?.trim();
      expect(cta()).toBe("Sign in to Claude");

      const field = document.body.querySelector(
        'input[aria-label="Authorization code"]',
      ) as HTMLInputElement;
      await act(async () => {
        field.dispatchEvent(new Event("paste", { bubbles: true }));
        setControlledValue(field, "Q2RJ-E1YIF-authorization-code");
      });
      for (let i = 0; i < 8; i++) await flushReact();

      expect(mockAgentsApi.submitClaudeSetupTokenBrowserCode).toHaveBeenCalledTimes(1);
      expect(document.body.textContent).toContain("Sign-in didn’t finish");
      expect(document.body.textContent).not.toContain("That authorization code was not accepted.");
      expect(cta()).toBe("Retry sign-in");
      expect(mockAgentsApi.hire).not.toHaveBeenCalled();

      await act(async () => root.unmount());
    });

    it.each(["code", "start", "lookup", "prompt", "status", "failed", "timed_out", "gone", "completion"] as const)("retries Claude sign-in after a %s failure", async failure => {
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
      if (failure === "code") mockAgentsApi.submitClaudeSetupTokenBrowserCode.mockRejectedValueOnce(new Error("Private provider detail"));
      if (failure === "start") mockAgentsApi.startClaudeSetupTokenLogin.mockRejectedValueOnce(new Error("Sandbox unavailable"));
      if (failure === "lookup") mockAgentsApi.getActiveClaudeSetupTokenLoginSession.mockRejectedValue(new Error("Lookup unavailable"));
      if (failure === "gone" || failure === "status") mockAgentsApi.getClaudeSetupTokenLoginStatus.mockRejectedValueOnce(new ApiError("Session unavailable", failure === "gone" ? 404 : 503, {}));
      if (failure === "prompt") mockAgentsApi.getClaudeSetupTokenLoginPrompt.mockRejectedValueOnce(new ApiError("Sandbox unavailable", 503, {}));
      if (failure === "failed" || failure === "timed_out" || failure === "completion") {
        mockAgentsApi.getClaudeSetupTokenLoginStatus.mockResolvedValueOnce({
          sessionId: "claude-session-1", status: failure === "completion" ? "authenticated" : failure,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        });
      }
      if (failure === "completion") mockAgentsApi.completeClaudeSetupTokenLogin.mockRejectedValueOnce(new Error("Completion unavailable"));
      const { root } = await openStep4({ adapterType: "claude_local" });
      try {
        await pickSource(/Claude/);
        if (failure === "code") {
          const field = document.querySelector('input[aria-label="Authorization code"]') as HTMLInputElement;
          await act(async () => {
            field.dispatchEvent(new Event("paste", { bubbles: true }));
            setControlledValue(field, "expired-code");
          });
        }
        for (let i = 0; i < 8; i++) await flushReact();
        const primary = () => [...document.body.querySelectorAll("button")].at(-1)!;
        expect(document.body.textContent).toContain(failure === "timed_out" ? "This sign-in expired" : "Sign-in didn’t finish");
        expect(document.querySelector('[role="alert"]')?.className).not.toContain("text-destructive");
        expect(document.body.textContent).toContain("Retry sign-in to get a fresh code. Your setup is saved.");
        expect(document.body.textContent).not.toContain("Private provider detail");
        expect(document.querySelector('a[href*="claude.ai"]')).toBeNull();
        expect(document.querySelector('input[aria-label="Authorization code"]')).toBeNull();
        expect(primary().textContent?.trim()).toBe("Retry sign-in");
        expect(primary().disabled).toBe(false);
        const startsBeforeRetry = mockAgentsApi.startClaudeSetupTokenLogin.mock.calls.length;
        let release: () => void = () => {};
        if (failure !== "start" && failure !== "lookup") mockAgentsApi.cancelClaudeSetupTokenLogin.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({}); }));
        mockAgentsApi.getActiveClaudeSetupTokenLoginSession.mockRejectedValue(new ApiError("Not found", 404, null));
        mockAgentsApi.startClaudeSetupTokenLogin.mockResolvedValueOnce({
          sessionId: "claude-session-2", status: "pending", expiresAt: new Date(Date.now() + 600_000).toISOString(),
        });
        mockAgentsApi.getClaudeSetupTokenLoginStatus.mockResolvedValue({
          sessionId: "claude-session-2", status: "pending", expiresAt: new Date(Date.now() + 600_000).toISOString(),
        });
        mockAgentsApi.getClaudeSetupTokenLoginPrompt.mockResolvedValue({ authorizationUrl: "https://claude.ai/oauth/authorize?attempt=2", transportAdvisory: null });
        await act(async () => { primary().click(); primary().click(); });
        if (failure !== "start" && failure !== "lookup") {
          expect(mockAgentsApi.cancelClaudeSetupTokenLogin).toHaveBeenCalledExactlyOnceWith("company-new", "claude-session-1");
          expect(mockAgentsApi.startClaudeSetupTokenLogin).toHaveBeenCalledTimes(startsBeforeRetry);
          expect(primary().disabled).toBe(true);
          await act(async () => release());
        }
        for (let i = 0; i < 12; i++) await flushReact();
        expect(mockAgentsApi.startClaudeSetupTokenLogin).toHaveBeenCalledTimes(startsBeforeRetry + 1);
        expect(primary().textContent?.trim()).toBe("Sign in to Claude");
        const field = document.querySelector('input[aria-label="Authorization code"]') as HTMLInputElement;
        expect(field.value).toBe("");
        expect(document.querySelector('[role="alert"]')).toBeNull();
        await act(async () => setControlledValue(field, "fresh-code"));
        await act(async () => primary().click());
        expect(mockAgentsApi.submitClaudeSetupTokenBrowserCode).toHaveBeenLastCalledWith("company-new", "claude-session-2", "fresh-code");
        expect(mockAgentsApi.hire).not.toHaveBeenCalled();
      } finally {
        await act(async () => root.unmount());
      }
    });

    it.each(["claude_local", "codex_local"] as const)("keeps a missing resumed %s session retryable", async adapterType => {
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
      const claude = adapterType === "claude_local";
      const active = {
        sessionId: claude ? "claude-session-1" : "codex-session-1", environmentId: "env-sandbox-1",
        status: "waiting_for_user", expiresAt: null, failure: null,
        aiConnection: { provider: claude ? "anthropic" : "openai", method: "subscription", ownership: "personal", agentIds: [], allAgents: true },
        panelMode: claude ? "submitted_browser_code" : "displayed_code",
        prompt: claude ? { authorizationUrl: "https://claude.ai/oauth/authorize?code=true" } : { url: "https://auth.openai.com/codex/device", code: "OLD-CODE" },
      };
      const activeApi = claude ? mockAgentsApi.getActiveClaudeSetupTokenLoginSession : mockAgentsApi.getActiveAdapterAuthLoginSession;
      activeApi.mockResolvedValue(active);
      const statusApi = claude ? mockAgentsApi.getClaudeSetupTokenLoginStatus : mockAgentsApi.getAdapterAuthLoginStatus;
      statusApi.mockRejectedValueOnce(new ApiError("Session gone", 404, {}));
      const { root } = await openStep4({ adapterType });
      try {
        for (let i = 0; i < 10; i++) await flushReact();
        const primary = () => [...document.body.querySelectorAll("button")].at(-1)!;
        expect(primary().textContent?.trim()).toBe("Retry sign-in");
        expect(document.body.textContent).toContain("Sign-in didn’t finish");
        activeApi.mockRejectedValue(new ApiError("Not found", 404, null));
        await act(async () => primary().click());
        for (let i = 0; i < 12; i++) await flushReact();
        expect(primary().textContent?.trim()).toBe(claude ? "Sign in to Claude" : "Sign in to OpenAI");
        expect(mockAgentsApi.hire).not.toHaveBeenCalled();
      } finally {
        await act(async () => root.unmount());
      }
    });

    it("keeps retry available after cancellation fails, and accepts an already-removed session", async () => {
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
      mockAgentsApi.getClaudeSetupTokenLoginStatus.mockResolvedValueOnce({ sessionId: "claude-session-1", status: "failed", expiresAt: new Date(Date.now() + 600_000).toISOString() });
      mockAgentsApi.cancelClaudeSetupTokenLogin.mockRejectedValueOnce(new Error("Temporary error"))
        .mockRejectedValueOnce(new ApiError("Session gone", 404, {}));
      const { root } = await openStep4({ adapterType: "claude_local" });
      try {
        await pickSource(/Claude/);
        const primary = () => [...document.body.querySelectorAll("button")].at(-1)!;
        await act(async () => primary().click());
        for (let i = 0; i < 8; i++) await flushReact();
        expect(primary().textContent?.trim()).toBe("Retry sign-in");
        expect(mockAgentsApi.startClaudeSetupTokenLogin).toHaveBeenCalledTimes(1);
        mockAgentsApi.startClaudeSetupTokenLogin.mockResolvedValueOnce({ sessionId: "claude-session-2", status: "pending", expiresAt: new Date(Date.now() + 600_000).toISOString() });
        await act(async () => primary().click());
        for (let i = 0; i < 12; i++) await flushReact();
        expect(mockAgentsApi.startClaudeSetupTokenLogin).toHaveBeenCalledTimes(2);
        expect(primary().textContent?.trim()).toBe("Sign in to Claude");
      } finally {
        await act(async () => root.unmount());
      }
    });

    it.each(["timed_out", "gone"] as const)("retries OpenAI sign-in after the session is %s", async failure => {
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
      if (failure === "gone") mockAgentsApi.getAdapterAuthLoginStatus.mockRejectedValueOnce(new ApiError("Session gone", 404, {}));
      else mockAgentsApi.getAdapterAuthLoginStatus.mockResolvedValueOnce({ sessionId: "codex-session-1", status: "timed_out", prompt: { url: "https://auth.openai.com/codex/device", code: "OLD-CODE" } });
      const { root } = await openStep4({ adapterType: "codex_local" });
      try {
        await pickSource(/OpenAI/);
        const primary = () => [...document.body.querySelectorAll("button")].at(-1)!;
        expect(primary().textContent?.trim()).toBe("Retry sign-in");
        mockAgentsApi.startAdapterAuthLogin.mockResolvedValueOnce({ sessionId: "codex-session-2", status: "pending" });
        mockAgentsApi.getAdapterAuthLoginStatus.mockResolvedValue({ sessionId: "codex-session-2", status: "pending", prompt: { url: "https://auth.openai.com/codex/device", code: "FRESH-CODE" } });
        await act(async () => { primary().click(); primary().click(); });
        for (let i = 0; i < 12; i++) await flushReact();
        expect(mockAgentsApi.cancelAdapterAuthLogin).toHaveBeenCalledExactlyOnceWith("company-new", "codex_local", "codex-session-1");
        expect(mockAgentsApi.startAdapterAuthLogin).toHaveBeenCalledTimes(2);
        expect(primary().textContent?.trim()).toBe("Sign in to OpenAI");
        expect(document.body.textContent).toContain("FRESH-CODE");
        expect(mockAgentsApi.hire).not.toHaveBeenCalled();
      } finally {
        await act(async () => root.unmount());
      }
    });
  });
});
