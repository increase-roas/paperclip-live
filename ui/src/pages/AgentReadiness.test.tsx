// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentReadinessCheck,
  scoreReadinessSubject,
  summarizeAgentReadiness,
  type AgentReadinessCheckStatus,
  type AgentReadinessFinding,
  type AgentReadinessReport,
} from "@paperclipai/shared";
import { AgentReadiness } from "./AgentReadiness";

const getMock = vi.hoisted(() => vi.fn());
const runMock = vi.hoisted(() => vi.fn());
const fixMock = vi.hoisted(() => vi.fn());
const attestMock = vi.hoisted(() => vi.fn());
const pushToastMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/agentReadiness", () => ({
  agentReadinessApi: {
    get: (companyId: string) => getMock(companyId),
    run: (companyId: string, includeLive: boolean) => runMock(companyId, includeLive),
    fix: (companyId: string, input: unknown) => fixMock(companyId, input),
    attest: (companyId: string, input: unknown) => attestMock(companyId, input),
  },
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1", name: "Paperclip" } }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: pushToastMock }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function finding(
  checkId: string,
  status: AgentReadinessCheckStatus,
  overrides: Partial<AgentReadinessFinding> = {},
): AgentReadinessFinding {
  const definition = agentReadinessCheck(checkId)!;
  return {
    checkId,
    level: definition.level,
    title: definition.title,
    description: definition.description,
    kind: definition.kind,
    severity: definition.severity,
    subjectType: "agent",
    subjectId: "agent-1",
    subjectName: "Agent One",
    provider: null,
    status,
    message: status === "pass" ? "This check passed." : "This check needs work.",
    evidence: { sample: true },
    checkedAt: new Date().toISOString(),
    fix: definition.fix ?? null,
    deepLink: definition.deepLink
      ? { ...definition.deepLink, path: definition.deepLink.path.replace("{agentId}", "agent-1") }
      : null,
    ...overrides,
  };
}

function buildReport(overrides: Partial<AgentReadinessReport> = {}): AgentReadinessReport {
  const findings = [
    finding("model.probe", "pass"),
    finding("runtime.config_revision", "fail"),
    finding("tests.no_real_clients", "not_checked", {
      level: 3,
      severity: "must_pass",
      kind: "manual",
      fix: null,
    }),
  ];
  const subject = scoreReadinessSubject(
    { subjectType: "agent", subjectId: "agent-1", name: "Agent One", provider: null },
    findings,
  );
  const summary = summarizeAgentReadiness([subject], findings);
  return {
    id: "report-1",
    companyId: "company-1",
    status: "complete",
    includeLive: false,
    summary,
    findings,
    requestedByUserId: "board-user",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    error: null,
    ...overrides,
  };
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function click(element: Element | null | undefined) {
  if (!element) throw new Error("Expected an element to click");
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("AgentReadiness", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    getMock.mockReset();
    runMock.mockReset();
    fixMock.mockReset();
    attestMock.mockReset();
    pushToastMock.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderPage(report: AgentReadinessReport) {
    getMock.mockResolvedValue(report);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <AgentReadiness />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  it("renders the overall status, level list and subject table", async () => {
    await renderPage(buildReport());
    expect(container.textContent).toContain("Readiness");
    expect(container.textContent).toContain("Run with live probes");
    expect(container.textContent).toContain("Levels 1–13");
    expect(container.textContent).toContain("Agent One");
    expect(container.textContent).toContain("Must-pass");
    expect(getMock).toHaveBeenCalledWith("company-1");
  });

  it("runs a static report on demand", async () => {
    const report = buildReport();
    await renderPage(report);
    runMock.mockResolvedValue({ ...report, includeLive: true });
    const button = Array.from(container.querySelectorAll("button")).find((entry) => entry.textContent?.includes("Run with live probes"));
    click(button);
    await flushReact();
    expect(runMock).toHaveBeenCalledWith("company-1", true);
    expect(pushToastMock).toHaveBeenCalled();
  });

  it("selects a subject, applies a safe fix and refreshes the report", async () => {
    const report = buildReport();
    await renderPage(report);
    const row = Array.from(container.querySelectorAll('[role="button"]')).find((entry) => entry.textContent?.includes("Agent One"));
    click(row);
    await flushReact();
    const fixButton = Array.from(container.querySelectorAll("button")).find((entry) => entry.textContent === "Snapshot configuration");
    expect(fixButton).toBeTruthy();
    const updatedFinding = finding("runtime.config_revision", "pass");
    const updated = buildReport({ findings: [finding("model.probe", "pass"), updatedFinding, finding("tests.no_real_clients", "not_checked")] });
    fixMock.mockResolvedValue({
      applied: true,
      action: "snapshot_config",
      message: "Saved a configuration snapshot.",
      finding: updatedFinding,
      report: updated,
    });
    click(fixButton);
    await flushReact();
    expect(fixMock).toHaveBeenCalledWith("company-1", expect.objectContaining({
      subjectType: "agent",
      subjectId: "agent-1",
      checkId: "runtime.config_revision",
      action: "snapshot_config",
      confirm: true,
    }));
    expect(pushToastMock).toHaveBeenCalledWith(expect.objectContaining({ title: "Saved a configuration snapshot." }));
  });

  it("attests a manual check with a note", async () => {
    const report = buildReport();
    await renderPage(report);
    const row = Array.from(container.querySelectorAll('[role="button"]')).find((entry) => entry.textContent?.includes("Agent One"));
    click(row);
    await flushReact();
    const input = container.querySelector('input[aria-label="Attestation note for Tests never touch real clients, accounts or money"]') as HTMLInputElement | null;
    expect(input).toBeTruthy();
    const attestButton = Array.from(container.querySelectorAll("button")).find((entry) => entry.textContent === "Attest") as HTMLButtonElement | undefined;
    expect(attestButton).toBeTruthy();
    // A manual check cannot pass without saying what was checked.
    expect(attestButton!.disabled).toBe(true);
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setValue.call(input, "Checked the fixture task.");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(attestButton!.disabled).toBe(false);
    attestMock.mockResolvedValue({
      attestation: {
        id: "attestation-1",
        companyId: "company-1",
        subjectType: "agent",
        subjectId: "agent-1",
        checkId: "tests.no_real_clients",
        note: "Checked the fixture task.",
        attestedByUserId: "board-user",
        attestedAt: new Date().toISOString(),
      },
      finding: finding("tests.no_real_clients", "pass"),
      report: buildReport(),
    });
    click(attestButton);
    await flushReact();
    expect(attestMock).toHaveBeenCalledWith("company-1", expect.objectContaining({
      checkId: "tests.no_real_clients",
      note: "Checked the fixture task.",
    }));
  });

  it("closes the detail pane and keeps a chosen subject when search excludes it", async () => {
    await renderPage(buildReport());
    const row = Array.from(container.querySelectorAll('[role="button"]')).find((entry) => entry.textContent?.includes("Agent One"));
    click(row);
    await flushReact();
    const search = container.querySelector('input[aria-label="Search readiness subjects"]') as HTMLInputElement | null;
    expect(search).toBeTruthy();
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setValue.call(search, "no-such-subject");
      search!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();
    // The explicit selection survives a search that matches nothing.
    expect(container.querySelector('button[aria-label="Close readiness detail"]')).toBeTruthy();
    expect(container.textContent).toContain("Agent One");
    click(container.querySelector('button[aria-label="Close readiness detail"]'));
    await flushReact();
    expect(container.querySelector('button[aria-label="Close readiness detail"]')).toBeNull();
  });
});
