// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayAgentRecord, GatewayBotSummary, GatewayPolicy } from "../../api/irOps";
import { AgentPolicySheet } from "./AgentPolicySheet";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({
  updateAgentPolicy: vi.fn(),
  createAgentKey: vi.fn(),
  rotateAgentKey: vi.fn(),
  revokeAgentKey: vi.fn(),
  upsertAgent: vi.fn(),
}));

vi.mock("../../api/irOps", async () => {
  const actual = await vi.importActual<typeof import("../../api/irOps")>("../../api/irOps");
  return {
    ...actual,
    irOpsApi: {
      ...actual.irOpsApi,
      gateway: {
        ...actual.irOpsApi.gateway,
        updateAgentPolicy: apiMocks.updateAgentPolicy,
        createAgentKey: apiMocks.createAgentKey,
        rotateAgentKey: apiMocks.rotateAgentKey,
        revokeAgentKey: apiMocks.revokeAgentKey,
        upsertAgent: apiMocks.upsertAgent,
      },
    },
  };
});

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div>{children}</div> : null),
  SheetContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  SheetDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  SheetFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (val: string) => void;
    children: ReactNode;
  }) => (
    <div data-select-value={value}>
      <select
        data-testid={`select-${value}`}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
      >
        <option value="">—</option>
        <option value="all">all</option>
        <option value="scoped">scoped</option>
        <option value="read_only">read_only</option>
        <option value="drafts_only">drafts_only</option>
        <option value="write">write</option>
        <option value="none">none</option>
        <option value="read">read</option>
      </select>
      {children}
    </div>
  ),
  SelectTrigger: ({ id, children }: { id?: string; children: ReactNode }) => (
    <div data-trigger-id={id}>{children}</div>
  ),
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <span data-option={value}>{children}</span>
  ),
}));

vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  AlertDialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogCancel: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  AlertDialogAction: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

const basePolicy: GatewayPolicy = {
  mode: "read_only",
  allowDelete: false,
  allowOutbound: false,
  allowAgencyWrite: false,
  allowBulk: false,
  allowSpend: false,
  allowBuild: false,
  outboundChannels: null,
  locations: "*",
  providers: {},
};

function setNativeInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function setNativeSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set;
  setter?.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll("button")).find((el) =>
    el.textContent?.includes(text),
  );
  if (!btn) throw new Error(`Button containing "${text}" not found`);
  return btn;
}

describe("AgentPolicySheet location restrictions", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    apiMocks.updateAgentPolicy.mockResolvedValue({ agent: "scoped-bot", policy: basePolicy });
    apiMocks.createAgentKey.mockResolvedValue({ agent: "scoped-bot", key: "gw_scoped_test_key" });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("preserves edited location restrictions when issuing a new key", async () => {
    const agent: GatewayAgentRecord = {
      agent: "scoped-bot",
      hasKey: false,
      enabled: false,
      opRef: null,
      policy: { ...basePolicy, locations: "*" },
    };

    await act(async () => {
      root.render(
        <AgentPolicySheet
          open={true}
          onOpenChange={vi.fn()}
          agent={agent}
          providers={[]}
          roles={[]}
          onSaved={vi.fn()}
        />,
      );
    });

    const locationsSelect = container.querySelector(
      'select[data-testid="select-all"]',
    ) as HTMLSelectElement | null;
    expect(locationsSelect).not.toBeNull();

    await act(async () => {
      setNativeSelectValue(locationsSelect!, "scoped");
    });

    const locationsInput = container.querySelector("#policy-locations-input") as HTMLInputElement | null;
    expect(locationsInput).not.toBeNull();

    await act(async () => {
      setNativeInputValue(locationsInput!, "loc_alpha, loc_beta");
    });

    await act(async () => {
      findButton(container, "Issue key").click();
    });

    expect(apiMocks.createAgentKey).toHaveBeenCalledTimes(1);
    const [agentArg, bodyArg] = apiMocks.createAgentKey.mock.calls[0]!;
    expect(agentArg).toBe("scoped-bot");
    expect(bodyArg.role).toBe("custom");
    expect(bodyArg.replace).toBe(true);
    expect(bodyArg.locations).toEqual(["loc_alpha", "loc_beta"]);
    expect(bodyArg.policy?.locations).toEqual(["loc_alpha", "loc_beta"]);
  });

  it("preserves a restricted preset's location limits on reset instead of granting every location", async () => {
    const presetPolicy: GatewayPolicy = {
      ...basePolicy,
      mode: "drafts_only",
      locations: ["loc_preset_1", "loc_preset_2"],
    };
    const agent: GatewayAgentRecord = {
      agent: "scoped-bot",
      hasKey: false,
      enabled: true,
      opRef: null,
      policy: { ...basePolicy, mode: "write", locations: "*" },
    };
    const bot: GatewayBotSummary = {
      agent: "scoped-bot",
      name: "Scoped Bot",
      preset: { name: "scoped-bot", description: "Location-restricted bot", policy: presetPolicy },
      enabled: true,
      hasKey: false,
      key: {
        present: false,
        algorithm: null,
        fingerprint: null,
        createdAt: null,
        rotatedAt: null,
        updatedAt: null,
      },
      providers: {},
      grantedProviders: [],
      policy: agent.policy,
      usage: { lastUsedAt: null },
      presetDrift: true,
      presetPolicy,
    };

    await act(async () => {
      root.render(
        <AgentPolicySheet
          open={true}
          onOpenChange={vi.fn()}
          agent={agent}
          bot={bot}
          providers={[]}
          roles={[]}
          onSaved={vi.fn()}
        />,
      );
    });

    await act(async () => {
      findButton(container, "Reset to preset").click();
    });

    const locationsInput = container.querySelector("#policy-locations-input") as HTMLInputElement | null;
    expect(locationsInput).not.toBeNull();
    expect(locationsInput?.value).toBe("loc_preset_1, loc_preset_2");

    await act(async () => {
      findButton(container, "Save policy").click();
    });

    expect(apiMocks.updateAgentPolicy).toHaveBeenCalledTimes(1);
    expect(apiMocks.updateAgentPolicy.mock.calls[0]?.[1]?.locations).toEqual([
      "loc_preset_1",
      "loc_preset_2",
    ]);

    await act(async () => {
      findButton(container, "Issue key").click();
    });

    expect(apiMocks.createAgentKey).toHaveBeenCalledTimes(1);
    expect(apiMocks.createAgentKey.mock.calls[0]?.[1]?.locations).toEqual([
      "loc_preset_1",
      "loc_preset_2",
    ]);
    expect(apiMocks.createAgentKey.mock.calls[0]?.[1]?.policy?.locations).toEqual([
      "loc_preset_1",
      "loc_preset_2",
    ]);
  });
});
