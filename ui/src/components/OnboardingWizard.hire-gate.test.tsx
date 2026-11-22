// @vitest-environment jsdom

import { act, StrictMode } from "react";

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
import { ADAPTER_AUTH_MISSING_CHECK_CODE } from "@paperclipai/shared";
import { CLAUDE_OAUTH_TOKEN_ENV_KEY } from "./environment-variables-editor/model";
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

describe("OnboardingWizard hire gate and restored route progress", () => {
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

  describe("hire gate: adapter authentication (claude_local, the default onboarding adapter)", () => {
    /** Drives the wizard to the Connect step, agent name already filled in. */
    async function openConnectStep({ useApiKeys = false } = {}) {
      // The tile row is built from this registry, and the suite's default is
      // empty. That was survivable while the step preselected a source; now that
      // nothing is chosen until a tile is pressed, a step with no tiles is a step
      // that can never advance.
      mockAdapterRegistry.list = [{ type: "claude_local" }, { type: "codex_local" }];
      mockCompaniesApi.create.mockResolvedValue({ id: "company-new", issuePrefix: "INI" });
      window.localStorage.setItem(
        ONBOARDING_STORAGE_KEY,
        JSON.stringify({ step: 1, companyName: "Initech" }),
      );
      mockDialog.onboardingOptions = {};
      mockCompany.companies = [];
      mockCompany.loading = false;
      mockCompaniesApi.list.mockResolvedValue([]);

      const { root, queryClient } = render();
      await renderWizardView(root, queryClient);
      await flushReact();

      const clickByText = async (match: (text: string) => boolean) => {
        const el = [...document.body.querySelectorAll("button")].find((b) =>
          match(b.getAttribute("aria-label")?.startsWith("Use ") ? b.getAttribute("aria-label")! : b.textContent?.trim() ?? ""),
        )!;
        await act(async () => {
          el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        await flushReact();
      };

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

      // The credential mode is chosen *before* a source, because picking a
      // source starts the sequence and the mode link fades out with the row —
      // after that it is inert, and switching would mean changing the card out
      // from under a running sign-in.
      if (useApiKeys) {
        await clickByText((t) => t.startsWith("Use API key"));
      }

      // Pick a source. The step arrives with nothing chosen — `adapterType`
      // carries a value for the hire, but that is not the same as the customer
      // having answered — so the input surface stays closed and the step will
      // not advance until a tile is pressed. Every case below is about what
      // happens *after* that choice, so the helper makes it.
      await pickFirstSource(clickByText);

      return { root, clickByText };
    }

    it("blocks the hire on a warn result that holds adapter_auth_missing, and shows the returned checks", async () => {
      mockAgentsApi.testEnvironment.mockResolvedValue({
        adapterType: "claude_local",
        status: "warn" as const,
        checks: [
          {
            code: ADAPTER_AUTH_MISSING_CHECK_CODE,
            level: "warn" as const,
            message: "No stored Claude login was found for this agent.",
          },
        ],
        testedAt: new Date().toISOString(),
      });
      const { root, clickByText } = await openConnectStep();

      await clickByText((t) => isArcPrimary(t));

      expect(mockAgentsApi.hire).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain(
        "No stored Claude login was found for this agent.",
      );

      expect(document.body.textContent).toContain("No working authentication was found");

      await act(async () => root.unmount());
    });

    it("still hires on a warn result that carries no adapter_auth_missing check", async () => {
      mockAgentsApi.testEnvironment.mockResolvedValue({
        adapterType: "claude_local",
        status: "warn" as const,
        checks: [
          {
            code: "claude_anthropic_api_key_overrides_subscription",
            level: "warn" as const,
            message: "ANTHROPIC_API_KEY overrides the subscription login.",
          },
        ],
        testedAt: new Date().toISOString(),
      });
      const { root, clickByText } = await openConnectStep();

      await clickByText((t) => isArcPrimary(t));

      expect(mockAgentsApi.hire).toHaveBeenCalled();

      await act(async () => root.unmount());
    });

    // The Connect handler reuses a passing probe instead of re-running it, so the
    // effect that clears the cache has to name every input to the configuration
    // the probe tested. `credentialMode` and `apiKey` were missing from it, and
    // the gap is reachable: the probe and the hire share one try/catch, so a hire
    // that throws leaves the pass in state. Switching to a key and pressing
    // Connect again then hired against a key nothing had tested.
    /**
     * Typing a key into this step must not put the key into the agent's stored
     * configuration. That configuration is persisted and revisioned, so a plain
     * value there is a live credential at rest in every copy of it — which is
     * what this step did before, and what the Claude token path has always
     * avoided by holding a `user_secret_ref` instead.
     */
    it.each(["personal", "organization"])("defaults to a saved %s API key and uses the same reference for probe and hire", async (scope) => {
      const key = "ANTHROPIC_API_KEY";
      const binding = scope === "personal"
        ? { type: "user_secret_ref", key, version: "latest" }
        : { type: "secret_ref", secretId: "saved-org-key", version: "latest" };
      if (scope === "personal") {
        mockSecretsApi.listMyUserSecrets.mockResolvedValue([{
          definition: { id: "saved-key", companyId: "company-new", key, name: "Saved key", status: "active" },
          secret: { companyId: "company-new", status: "active" },
        }]);
      } else {
        mockSecretsApi.list.mockResolvedValue([{
          id: "saved-org-key", companyId: "company-new", key, name: "Saved key", scope: "company", status: "active",
        }]);
      }
      const { root, clickByText } = await openConnectStep();
      const picker = document.body.querySelector('select[aria-label="Saved API key"]') as HTMLSelectElement;
      expect(picker.value).toBe(scope === "personal" ? "user:saved-key" : "company:saved-org-key");
      await clickByText((t) => isArcPrimary(t));
      expect((mockAgentsApi.testEnvironment.mock.calls.at(-1) as unknown[])[2]).toMatchObject({ adapterConfig: { env: { [key]: binding } } });
      expect((mockAgentsApi.hire.mock.calls.at(-1) as unknown[])[1]).toMatchObject({ adapterConfig: { env: { [key]: binding } } });
      expect(mockSecretsApi.createMyUserSecret).not.toHaveBeenCalled();
      expect(mockSecretsApi.rotateMyUserSecret).not.toHaveBeenCalled();
      await act(async () => root.unmount());
    });

    describe("an API key typed on the step", () => {
      // Built from parts so the repository secret scanner does not flag the fixture.
      const KEY = ["sk", "ant", "api03", "onboarding", "fixture", "0000000000000000000000000"].join("-");

      // The canvas holding the key field only opens once a source is selected,
      // and the tile row that selects one is built from this registry. The
      // suite's default is empty, which leaves the step with no tiles, no
      // canvas, and no field to type into.
      beforeEach(() => {
        mockAdapterRegistry.list = [{ type: "claude_local" }, { type: "codex_local" }];
        // No definition and no stored value yet: the first customer to type a key.
        mockSecretsApi.listMyUserSecrets.mockResolvedValue([]);
        mockSecretsApi.createUserSecretDefinition.mockResolvedValue({ id: "def-1" });
        mockSecretsApi.createMyUserSecret.mockResolvedValue({ id: "secret-abc" });
        mockSecretsApi.rotateMyUserSecret.mockResolvedValue({ id: "secret-existing" });
      });

      async function connectWithApiKey() {
        const handles = await openConnectStep({ useApiKeys: true });
        const field = document.body.querySelector(
          'input[type="password"]',
        ) as HTMLInputElement;
        await act(async () => {
          setControlledValue(field, KEY);
        });
        await flushReact();
        await handles.clickByText((t) => isArcPrimary(t));
        return handles;
      }

      it("is stored as a personal connection and referenced, never carried in the hire", async () => {
        const { root } = await connectWithApiKey();

        expect(managedApi.create).toHaveBeenCalledTimes(1);
        expect(managedApi.create).toHaveBeenCalledWith("company-new", expect.objectContaining({ provider: "anthropic", method: "api_key", ownership: "personal", apiKey: KEY }));
        expect(managedApi.setDefault).toHaveBeenLastCalledWith("company-new", "managed-grant");
        const hireBody = (mockAgentsApi.hire.mock.calls.at(-1) as unknown[])[1] as { runtimeConfig: { aiConnection: unknown }; adapterConfig: { env?: Record<string, unknown> } };
        expect(hireBody.runtimeConfig.aiConnection).toEqual({ provider: "anthropic", method: "api_key", mode: "responsible_user" });
        expect(hireBody.adapterConfig.env?.ANTHROPIC_API_KEY).toBeUndefined();
        // The whole payload, not just that one field: the point is that the key
        // is nowhere in what gets persisted, however it might be nested.
        expect(JSON.stringify(hireBody)).not.toContain(KEY);

        await act(async () => root.unmount());
      });

      it("retries selecting the saved API account without creating another connection", async () => {
        managedApi.setDefault.mockRejectedValueOnce(new Error("default selection failed"));
        const { root, clickByText } = await connectWithApiKey();
        try {
          expect(mockAgentsApi.hire).not.toHaveBeenCalled();
          expect(document.body.textContent).toContain("default selection failed");
          await clickByText(t => isArcPrimary(t));
          expect(managedApi.create).toHaveBeenCalledTimes(1);
          expect(managedApi.setDefault).toHaveBeenCalledTimes(2);
          expect(mockAgentsApi.hire).toHaveBeenCalledTimes(1);
        } finally { await act(async () => root.unmount()); }
      });

      it("creates a managed connection without rotating an existing saved key", async () => {
        mockSecretsApi.listMyUserSecrets.mockResolvedValue([
          { definition: { id: "old-def", key: "ANTHROPIC_API_KEY" }, secret: { id: "secret-existing" } },
        ]);
        const { root } = await connectWithApiKey();
        expect(managedApi.create).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ apiKey: KEY }));
        expect(mockSecretsApi.rotateMyUserSecret).not.toHaveBeenCalled();
        expect(managedApi.create).toHaveBeenCalledTimes(1);
        await act(async () => root.unmount());
      });

      // The one outcome that must never happen is a hire that falls back to
      // embedding the key because storing it failed.
      it("blocks the hire when the key cannot be stored", async () => {
        managedApi.create.mockRejectedValueOnce(new Error("vault unreachable"));
        const { root } = await connectWithApiKey();

        expect(mockAgentsApi.hire).not.toHaveBeenCalled();
        expect(document.body.textContent).toContain("Could not store the API key");

        await act(async () => root.unmount());
      });

      it("stores one connection when Connect is pressed twice with the same key", async () => {
        mockAgentsApi.hire.mockRejectedValueOnce(new Error("network went away"));
        const { root, clickByText } = await connectWithApiKey();

        await clickByText((t) => isArcPrimary(t));

        expect(managedApi.create).toHaveBeenCalledTimes(1);

        await act(async () => root.unmount());
      });
    });

    it("re-probes rather than reusing a pass when the credential mode changes", async () => {
      mockAgentsApi.testEnvironment.mockResolvedValue({
        adapterType: "claude_local",
        status: "pass" as const,
        checks: [],
        testedAt: new Date().toISOString(),
      });
      // The hire fails, which is what leaves the passing probe behind.
      mockAgentsApi.hire.mockRejectedValueOnce(new Error("network went away"));

      const { root, clickByText } = await openConnectStep();

      await clickByText((t) => isArcPrimary(t));
      expect(mockAgentsApi.testEnvironment).toHaveBeenCalledTimes(1);

      // Switching the credential mode means backing out first: the mode link
      // fades away with the row once a source is chosen, and is inert after
      // that, so it cannot be used to change the card out from under a running
      // sign-in. Back unwinds to the question, and the answer is given again.
      await clickByText((t) => t.startsWith("Back"));
      await clickByText((t) => t.startsWith("Use API key"));
      await pickFirstSource(clickByText);

      const field = document.body.querySelector(
        'input[type="password"]',
      ) as HTMLInputElement;
      await act(async () => {
        setControlledValue(field, "sk-ant-rekey");
      });
      await flushReact();
      await clickByText((t) => isArcPrimary(t));

      // A different configuration, so the passing probe from before it cannot
      // stand in for one against this one.
      expect(mockAgentsApi.testEnvironment).toHaveBeenCalledTimes(2);

      await act(async () => root.unmount());
    });

    it("does not open the create path on a cached warn result that holds adapter_auth_missing", async () => {
      mockAgentsApi.testEnvironment.mockResolvedValue({
        adapterType: "claude_local",
        status: "warn" as const,
        checks: [
          {
            code: ADAPTER_AUTH_MISSING_CHECK_CODE,
            level: "warn" as const,
            message: "No stored Claude login was found for this agent.",
          },
        ],
        testedAt: new Date().toISOString(),
      });
      const { root, clickByText } = await openConnectStep();

      await clickByText((t) => isArcPrimary(t));
      expect(mockAgentsApi.testEnvironment).toHaveBeenCalledTimes(1);
      expect(mockAgentsApi.hire).not.toHaveBeenCalled();

      // A second Connect must not treat the first (cached) blocking result as
      // reusable — it re-probes, and the create path stays closed.
      await clickByText((t) => isArcPrimary(t));
      expect(mockAgentsApi.testEnvironment).toHaveBeenCalledTimes(2);
      expect(mockAgentsApi.hire).not.toHaveBeenCalled();

      await act(async () => root.unmount());
    });

    it("sends the fixed Claude binding and applyStoredClaudeLogin when a stored login exists", async () => {
      mockAgentsApi.getClaudeOAuthTokenStatus.mockReset();
      mockAgentsApi.getClaudeOAuthTokenStatus.mockResolvedValue({
        secretId: "11111111-1111-1111-1111-111111111111",
        latestVersion: 1,
      });
      const { root } = await openConnectStep();
      // Selecting the provider automatically verifies the saved subscription.
      await flushReact();

      expect(mockAgentsApi.testEnvironment).toHaveBeenCalled();
      const testArgs = mockAgentsApi.testEnvironment.mock.calls.at(-1) as unknown[];
      const testBody = testArgs[2] as { adapterConfig: { env?: Record<string, unknown> } };
      expect(testBody.adapterConfig.env?.[CLAUDE_OAUTH_TOKEN_ENV_KEY]).toEqual({
        type: "user_secret_ref",
        key: CLAUDE_OAUTH_TOKEN_ENV_KEY,
        version: "latest",
        required: true,
      });

      expect(mockAgentsApi.hire).toHaveBeenCalled();
      const hireArgs = mockAgentsApi.hire.mock.calls.at(-1) as unknown[];
      const hireBody = hireArgs[1] as {
        adapterConfig: { env?: Record<string, unknown> };
        applyStoredClaudeLogin?: boolean;
      };

      const binding = hireBody.adapterConfig.env?.[CLAUDE_OAUTH_TOKEN_ENV_KEY] as
        | { type: string }
        | undefined;
      expect(binding?.type).toBe("user_secret_ref");
      expect(JSON.stringify(hireBody)).not.toContain("secretId");
      expect(hireBody.applyStoredClaudeLogin).toBe(true);
      expect(hireBody.adapterConfig.env?.[CLAUDE_OAUTH_TOKEN_ENV_KEY]).toEqual({
        type: "user_secret_ref",
        key: CLAUDE_OAUTH_TOKEN_ENV_KEY,
        version: "latest",
        required: true,
      });

      await act(async () => root.unmount());
    });

    it("sends no binding and no flag when the Claude status route returns 404", async () => {
      // The default `beforeEach` mock already rejects with a 404 `ApiError`,
      // matching "no stored value" — asserted explicitly here to pin the
      // scenario this test is named for.
      const { root, clickByText } = await openConnectStep();

      await clickByText((t) => isArcPrimary(t));

      expect(mockAgentsApi.testEnvironment).toHaveBeenCalled();
      const testArgs = mockAgentsApi.testEnvironment.mock.calls.at(-1) as unknown[];
      const testBody = testArgs[2] as { adapterConfig: { env?: Record<string, unknown> } };
      expect(testBody.adapterConfig.env?.[CLAUDE_OAUTH_TOKEN_ENV_KEY]).toBeUndefined();

      expect(mockAgentsApi.hire).toHaveBeenCalled();
      const hireArgs = mockAgentsApi.hire.mock.calls.at(-1) as unknown[];
      const hireBody = hireArgs[1] as {
        adapterConfig: { env?: Record<string, unknown> };
        applyStoredClaudeLogin?: boolean;
      };
      expect(hireBody.applyStoredClaudeLogin).toBeUndefined();
      expect(hireBody.adapterConfig.env?.[CLAUDE_OAUTH_TOKEN_ENV_KEY]).toBeUndefined();

      await act(async () => root.unmount());
    });

    it("sends no binding when the adapter configuration holds a non-empty ANTHROPIC_API_KEY", async () => {
      mockAgentsApi.getClaudeOAuthTokenStatus.mockReset();
      mockAgentsApi.getClaudeOAuthTokenStatus.mockResolvedValue({
        secretId: "11111111-1111-1111-1111-111111111111",
        latestVersion: 1,
      });
      mockAdapterBuild.buildAdapterConfig.mockReturnValue({
        env: { ANTHROPIC_API_KEY: { type: "plain", value: "sk-ant-configured" } },
      });
      const { root } = await openConnectStep();
      // Selecting the provider automatically verifies the saved subscription.
      await flushReact();

      expect(mockAgentsApi.hire).toHaveBeenCalled();
      // Discovery reads saved-login metadata once; the hire does not re-read
      // or apply it when the configuration already has an API key.
      expect(mockAgentsApi.getClaudeOAuthTokenStatus).toHaveBeenCalledTimes(1);
      const hireArgs = mockAgentsApi.hire.mock.calls.at(-1) as unknown[];
      const hireBody = hireArgs[1] as {
        adapterConfig: { env?: Record<string, unknown> };
        applyStoredClaudeLogin?: boolean;
      };
      expect(hireBody.applyStoredClaudeLogin).toBeUndefined();
      expect(hireBody.adapterConfig.env?.[CLAUDE_OAUTH_TOKEN_ENV_KEY]).toBeUndefined();

      await act(async () => root.unmount());
    });

    it("hires when a stored login exists, even though a probe without the binding would warn adapter_auth_missing", async () => {
      mockAgentsApi.getClaudeOAuthTokenStatus.mockReset();
      mockAgentsApi.getClaudeOAuthTokenStatus.mockResolvedValue({
        secretId: "11111111-1111-1111-1111-111111111111",
        latestVersion: 1,
      });
      // Answers like the real sandbox probe: `warn` with `adapter_auth_missing`
      // for a configuration with no binding, `pass` once the binding is
      // present. This proves the wizard sends the probe the SAME configuration
      // it hires with — a probe still sent without the binding would warn and
      // block the hire below.
      mockAgentsApi.testEnvironment.mockImplementation(
        (async (...args: unknown[]) => {
          const request = args[2] as {
            adapterConfig: { env?: Record<string, unknown> };
          };
          const hasBinding = Boolean(
            request.adapterConfig.env?.[CLAUDE_OAUTH_TOKEN_ENV_KEY],
          );
          return hasBinding
            ? {
                adapterType: "claude_local" as const,
                status: "pass" as const,
                checks: [],
                testedAt: new Date().toISOString(),
              }
            : {
                adapterType: "claude_local" as const,
                status: "warn" as const,
                checks: [
                  {
                    code: ADAPTER_AUTH_MISSING_CHECK_CODE,
                    level: "warn" as const,
                    message: "No stored Claude login was found for this agent.",
                  },
                ],
                testedAt: new Date().toISOString(),
              };
        }) as unknown as () => Promise<
          import("@paperclipai/shared").AdapterEnvironmentTestResult
        >,
      );
      const { root } = await openConnectStep();
      // Selecting the provider automatically verifies the saved subscription.
      await flushReact();

      expect(mockAgentsApi.hire).toHaveBeenCalled();

      await act(async () => root.unmount());
    });

    ;

    it("reads the stored-login status once for each create attempt", async () => {
      mockAgentsApi.getClaudeOAuthTokenStatus.mockReset();
      mockAgentsApi.getClaudeOAuthTokenStatus.mockResolvedValue({
        secretId: "11111111-1111-1111-1111-111111111111",
        latestVersion: 1,
      });
      // Fails after the gate opens, so the button stays clickable for a
      // second attempt instead of advancing past step 4.
      mockAgentsApi.hire.mockRejectedValue(new Error("hire failed"));
      const { root, clickByText } = await openConnectStep();

      const discoveryReads = mockAgentsApi.getClaudeOAuthTokenStatus.mock.calls.length;
      await clickByText((t) => isArcPrimary(t));
      expect(mockAgentsApi.getClaudeOAuthTokenStatus).toHaveBeenCalledTimes(discoveryReads + 1);

      await clickByText((t) => isArcPrimary(t));
      expect(mockAgentsApi.getClaudeOAuthTokenStatus).toHaveBeenCalledTimes(discoveryReads + 2);

      await act(async () => root.unmount());
    });
  });

  describe("restored route progress", () => {
    function savedReview(runner = "auto") {
      return { step: 5, companyName: "Saved Co", createdCompanyId: "c1", createdCompanyPrefix: "SC",
        createdAgentId: "saved-agent", agentName: "Saved lead", adapterType: "codex_local", runner,
        model: "gpt-5.6-sol", credentialMode: "api" };
    }

    async function openSavedReview(pathname: string, runner = "auto", options: { strict?: boolean; companiesLoading?: boolean; dialogStep?: number } = {}) {
      const draft = savedReview(runner);
      window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(draft));
      mockRouterState.pathname = pathname;
      mockDialog.onboardingOpen = options.dialogStep !== undefined;
      mockDialog.onboardingOptions = options.dialogStep === undefined ? {} : { initialStep: options.dialogStep, companyId: "c1" };
      const companies = [{ id: "c1", name: "Saved Co", issuePrefix: "SC" },
        { id: "c2", name: "Other Co", issuePrefix: "OTHER" }];
      mockCompany.companies = companies;
      mockCompany.loading = options.companiesLoading ?? false;
      mockCompaniesApi.list.mockResolvedValue(companies);
      const handles = render();
      if (options.strict) {
        await act(async () => handles.root.render(
          <QueryClientProvider client={handles.queryClient}><StrictMode><OnboardingWizard /></StrictMode></QueryClientProvider>,
        ));
      } else await renderWizardView(handles.root, handles.queryClient);
      for (let tick = 0; tick < 8; tick++) await flushReact();
      return { ...handles, draft };
    }

    it.each([
      ["/onboarding", "auto"], ["/SC/onboarding", "auto"],
      ["/onboarding", "legacy"], ["/SC/onboarding", "legacy"],
    ])("restores the authorized review draft after route reload %s with %s runner", async (pathname, runner) => {
      const { root, draft } = await openSavedReview(pathname, runner);
      try {
        expect([...document.querySelectorAll("button")].some(button => button.textContent?.trim() === "Get started")).toBe(true);
        expect(document.body.textContent).not.toContain("What is the name of your organization?");
        const persisted = JSON.parse(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)!);
        expect(persisted).toMatchObject(draft);
        expect(mockAgentsApi.hire).not.toHaveBeenCalled();
        expect(mockAgentsApi.testEnvironment).not.toHaveBeenCalled();
      } finally { await act(async () => root.unmount()); }
    });

    it("keeps restored review progress when initial effects replay in StrictMode", async () => {
      const { root, draft } = await openSavedReview("/SC/onboarding", "auto", { strict: true });
      try {
        expect([...document.querySelectorAll("button")].some(button => button.textContent?.trim() === "Get started")).toBe(true);
        expect(JSON.parse(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)!)).toMatchObject(draft);
      } finally { await act(async () => root.unmount()); }
    });

    it("waits for route company loading before deciding the initial restored step", async () => {
      const { root, queryClient, draft } = await openSavedReview("/SC/onboarding", "auto", { companiesLoading: true });
      try {
        mockCompany.loading = false;
        await renderWizardView(root, queryClient);
        for (let tick = 0; tick < 8; tick++) await flushReact();
        expect([...document.querySelectorAll("button")].some(button => button.textContent?.trim() === "Get started")).toBe(true);
        expect(JSON.parse(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)!)).toMatchObject(draft);
      } finally { await act(async () => root.unmount()); }
    });

    it("does not restore another company's review into a different route", async () => {
      const { root } = await openSavedReview("/OTHER/onboarding");
      try {
        expect(document.querySelector("#onboarding-agent-name")).not.toBeNull();
        const persisted = JSON.parse(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)!);
        expect(persisted.createdCompanyId).toBe("c2");
        expect(persisted.createdAgentId).toBeNull();
        expect(persisted.step).toBe(3);
      } finally { await act(async () => root.unmount()); }
    });

    it("does not bind an unmatched company prefix to the restored company", async () => {
      const { root } = await openSavedReview("/MISSING/onboarding");
      try {
        const persisted = JSON.parse(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)!);
        expect(persisted.step).toBe(1);
        expect(persisted.createdCompanyId).toBeNull();
        expect(persisted.createdAgentId).toBeNull();
        expect(persisted.companyName).toBe("");
      } finally { await act(async () => root.unmount()); }
    });

    it.each([2, 3])("honors explicit prefilled-company dialog step %s on initial mount", async initialStep => {
      const { root } = await openSavedReview("/SC/onboarding", "auto", { dialogStep: initialStep });
      try {
        const persisted = JSON.parse(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)!);
        expect(persisted.step).toBe(initialStep);
        expect(persisted.createdCompanyId).toBe("c1");
        expect([...document.querySelectorAll("button")].some(button => button.textContent?.trim() === "Get started")).toBe(false);
      } finally { await act(async () => root.unmount()); }
    });

    it("honors an explicit dialog step instead of resuming the route draft", async () => {
      const { root, queryClient } = await openSavedReview("/SC/onboarding");
      try {
        mockDialog.onboardingOpen = true;
        mockDialog.onboardingOptions = { companyId: "c2", initialStep: 3 };
        await renderWizardView(root, queryClient);
        await flushReact();
        expect(document.querySelector("#onboarding-agent-name")).not.toBeNull();
        const persisted = JSON.parse(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)!);
        expect(persisted.createdCompanyId).toBe("c2");
        expect(persisted.createdAgentId).toBeNull();
        expect(persisted.step).toBe(3);
      } finally { await act(async () => root.unmount()); }
    });
  });

  it("re-syncs a restored draft once companies resolve asynchronously (companies start empty/loading)", async () => {
    // Regression for the initializer-only restore bug: the inner wizard's
    // ~20 useState(saved?.x ?? default) initializers only read `saved` on
    // their very first render. useCompany() starts with companies=[] and
    // loading=true and resolves later; if the inner component mounted before
    // that resolution, restoreOnboardingState would see an empty companies
    // list and the whole draft would lock to defaults forever, even after
    // companies arrive. The fix defers mounting the inner wizard until
    // companies settle.
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        step: 3,
        companyName: "Saved Co",
        agentName: "Ops Lead",
        createdCompanyId: "c1",
      }),
    );
    mockDialog.onboardingOptions = {};
    mockCompany.companies = [];
    mockCompany.loading = true;
    // Deferred rather than swapped later: the gate's fetch fires on the first
    // render, so replacing the mock afterwards would never reach it.
    let resolveList: (companies: Array<{ id: string; name: string; issuePrefix: string }>) => void =
      () => {};
    mockCompaniesApi.list.mockReturnValue(
      new Promise<Array<{ id: string; name: string; issuePrefix: string }>>((resolve) => {
        resolveList = resolve;
      }),
    );

    const { container, root, queryClient } = render();
    const renderTree = () =>
      renderWizardView(root, queryClient);

    await renderTree();
    await flushReact();

    // Nothing mounts yet: no premature guess, and the draft is not touched.
    expect(container.textContent).toBe("");
    expect(document.body.textContent).toBe("");
    expect(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)).not.toBeNull();

    // Companies resolve asynchronously, owning the saved company.
    mockCompany.companies = [{ id: "c1", name: "Saved Co", issuePrefix: "SC" }];
    mockCompany.loading = false;
    await act(async () => {
      resolveList([{ id: "c1", name: "Saved Co", issuePrefix: "SC" }]);
    });

    await renderTree();
    await flushReact();

    // The draft is restored once companies settle: step 3 (Create your first
    // agent) with the saved agent name in the input, not the defaults
    // (step 0, "Chief of staff").
    expect(document.body.textContent).toContain("Create your first agent");
    const nameInput = document.body.querySelector(
      "#onboarding-agent-name",
    ) as HTMLInputElement | null;
    expect(nameInput?.value).toBe("Ops Lead");
    // The run entered on the agent arc, so the arc strip is the progress
    // indicator and counts 1-3 over the wizard's steps 3-5. Segments are
    // labelled by destination: the wizard has its own numbering, and two
    // controls both announcing "Step 1" would mean different things.
    const currentStep = document.body.querySelector('[aria-current="step"]');
    expect(currentStep?.getAttribute("aria-label")).toBe("Create your first agent");
    expect(document.body.textContent).toContain("Step 1 of 3");

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps the live wizard mounted while a post-create company-list refetch runs", async () => {
    // The authorization fetch needs to delay the first mount when a draft
    // exists. Once the customer has typed, though, invalidating that query is
    // normal background work. Unmounting for the refetch remounted the wizard
    // from this page-load draft and made a successful create look like a reset.
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({ step: 1, companyName: "", createdCompanyId: null }),
    );
    let resolveRefetch: (companies: Array<{ id: string; name: string; issuePrefix: string }>) => void =
      () => {};
    mockCompaniesApi.list
      .mockResolvedValueOnce([])
      .mockImplementationOnce(
        () =>
          new Promise<Array<{ id: string; name: string; issuePrefix: string }>>((resolve) => {
            resolveRefetch = resolve;
          }),
      );
    mockCompaniesApi.create.mockResolvedValue({
      id: "created",
      name: "Created Co",
      issuePrefix: "CRE",
    });

    const { root, queryClient } = render();
    await renderWizardView(root, queryClient);
    await flushReact();

    const companyNameInput = document.querySelector("input") as HTMLInputElement;
    setControlledValue(companyNameInput, "Created Co");
    await act(async () => {
      [...document.body.querySelectorAll("button")]
        .find((button) => button.textContent?.trim() === "Continue")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockCompaniesApi.create).toHaveBeenCalledWith({ name: "Created Co" });
    expect(mockCompaniesApi.list).toHaveBeenCalledTimes(2);
    expect(document.querySelector("#onboarding-agent-name")).not.toBeNull();

    await act(async () => {
      resolveRefetch([{ id: "created", name: "Created Co", issuePrefix: "CRE" }]);
    });
    await act(async () => {
      root.unmount();
    });
  });
});
