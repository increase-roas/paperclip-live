// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { queryKeys } from "@/lib/queryKeys";
import { CompanySettings } from "./CompanySettings";

const mockCompaniesApi = vi.hoisted(() => ({ update: vi.fn(), archive: vi.fn() }));
const mockAssetsApi = vi.hoisted(() => ({ uploadCompanyLogo: vi.fn() }));
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockSetSelectedCompanyId = vi.hoisted(() => vi.fn());

const SELECTED_COMPANY = {
  id: "company-1",
  name: "Acme Robotics",
  description: null,
  status: "active",
  issuePrefix: "ACM",
  brandColor: null,
  logoUrl: null,
  attachmentMaxBytes: null,
  requireBoardApprovalForNewAgents: false,
  interactionResolverGovernance: {},
};

vi.mock("../api/companies", () => ({ companiesApi: mockCompaniesApi }));
vi.mock("../api/assets", () => ({ assetsApi: mockAssetsApi }));
vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [SELECTED_COMPANY],
    selectedCompany: SELECTED_COMPANY,
    selectedCompanyId: SELECTED_COMPANY.id,
    setSelectedCompanyId: mockSetSelectedCompanyId,
  }),
}));
vi.mock("../components/decision-models/DecisionModelSettings", () => ({
  DecisionModelSettingsSection: () => <div data-testid="decision-model-settings" />,
}));
vi.mock("../components/InteractionGovernancePanel", () => ({
  InteractionGovernancePanel: () => null,
  applyGovernanceChange: (governance: unknown) => governance,
}));
vi.mock("./InstanceGeneralSettings", () => ({ InstanceGeneralSettings: () => null }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const CLOUD_HEALTH = {
  status: "ok" as const,
  cloud: {
    managed: true as const,
    managedBy: "paperclip-cloud" as const,
    stackSlug: "acme-labs",
    cloudBaseUrl: "https://cloud.example.test",
  },
};
const SELF_HOSTED_HEALTH = { status: "ok" as const, cloud: null };

describe("CompanySettings accessibility", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  function render(health: unknown) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.health, health);
    queryClient.setQueryData(queryKeys.instance.experimentalSettings, { enableFastResponses: true });
    const root = createRoot(container);
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <MemoryRouter>
              <CompanySettings />
            </MemoryRouter>
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    return root;
  }

  function labeledControl(id: string) {
    const control = container.querySelector<HTMLElement>(`#${id}`);
    const label = container.querySelector<HTMLLabelElement>(`label[for="${id}"]`);
    return { control, label };
  }

  it("associates the General and Appearance fields with their visible labels", () => {
    const root = render(SELF_HOSTED_HEALTH);

    for (const id of ["company-settings-name", "company-settings-description", "company-settings-logo"]) {
      const { control, label } = labeledControl(id);
      expect(control, `${id} should render`).toBeTruthy();
      expect(label?.textContent?.trim(), `${id} should have a label`).toBeTruthy();
    }
    expect(labeledControl("company-settings-logo").label?.textContent?.trim()).toBe("Logo");

    flushSync(() => root.unmount());
  });

  it("gives every hint button an accessible name", () => {
    const root = render(SELF_HOSTED_HEALTH);

    const hintButtons = [...container.querySelectorAll<HTMLButtonElement>('[data-slot="tooltip-trigger"]')];
    expect(hintButtons.length).toBeGreaterThan(0);
    for (const button of hintButtons) {
      expect(button.getAttribute("aria-label")?.trim(), "each hint button needs a name").toBeTruthy();
    }
    expect(hintButtons[0].getAttribute("aria-label")).toContain("Organization name");

    flushSync(() => root.unmount());
  });

  it("describes the rename consequence from the name field on a managed instance", () => {
    const root = render(CLOUD_HEALTH);

    const input = container.querySelector<HTMLInputElement>("#company-settings-name");
    const hint = container.querySelector<HTMLElement>("#company-settings-rename-hint");
    expect(input?.getAttribute("aria-describedby")).toBe("company-settings-rename-hint");
    expect(hint?.textContent).toContain("Renaming can change this company's task ID prefix");

    flushSync(() => root.unmount());
  });
});
