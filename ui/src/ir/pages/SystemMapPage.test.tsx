// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GbrainSkeletonResponse, SystemMapResponse } from "@paperclipai/shared/ir-system-map";
import { IrApiError } from "../api/irOps";
import { SystemMapPage } from "./SystemMapPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = vi.hoisted(() => ({
  systemMap: vi.fn(),
  gbrainSkeleton: vi.fn(),
  setBreadcrumbs: vi.fn(),
}));

vi.mock("../api/irOps", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/irOps")>();
  return {
    ...actual,
    irSystemMapApi: { systemMap: fixture.systemMap, gbrainSkeleton: fixture.gbrainSkeleton, proofChecks: vi.fn() },
  };
});
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { id: "c1", issuePrefix: "INC", name: "Increase ROAS" } }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: fixture.setBreadcrumbs }) }));

const MAP: SystemMapResponse = {
  feed: {
    feedVersion: "1",
    generatedAt: "2026-11-26T17:58:00Z",
    doctor: {
      observedAt: "2026-11-26T17:58:00Z",
      overallStatus: "yellow",
      anomalies: [],
      checks: [
        { key: "gateway", status: "green", anomalies: [] },
        { key: "db_feeds", status: "yellow", anomalies: ["sales_dashboard_snapshots_fail:401"] },
        { key: "hermes", status: "red", anomalies: ["hermes_gateway:unknown"] },
      ],
      error: null,
    },
    hosts: [
      { key: "brain-vps", label: "brain-vps", role: "GBrain, Javar", services: ["gbrain_alert"] },
      { key: "paperclip-vps", label: "paperclip-vps", role: "Paperclip control plane", services: ["paperclip"] },
    ],
    services: [
      { key: "gbrain_alert", label: "GBrain", host: "brain-vps", status: "ok", detail: "rc=0", latencyMs: null },
      { key: "paperclip", label: "Paperclip", host: "paperclip-vps", status: "down", detail: "HTTP 502", latencyMs: 900 },
    ],
    registers: [],
    sources: [{ key: "ir-doctor", label: "ir-doctor health checks", observedAt: "2026-11-26T17:58:00Z", detail: "10 checks" }],
  },
  freshness: { observedAt: "2026-11-26T17:58:00Z", ageSeconds: 7200, stale: true, thresholdSeconds: 900 },
};

const SKELETON: GbrainSkeletonResponse = {
  skeleton: {
    generatedAt: "2026-11-26T17:58:00Z",
    pack: { name: "increase-roas", version: "1.0.0", identity: "increase-roas@1.0.0+bc07fac6", description: null },
    requiredFieldsVersion: "1.0.0",
    requiredFolders: [{ prefix: "people/", fields: ["type", "title", "kind"], pages: 526, violations: 526 }],
    totals: { totalPages: 4765, typedPages: 4765, undeclaredPages: 2, coverage: 0.9996 },
    pageTypes: [
      { name: "person", primitive: "entity", pathPrefixes: ["people/"], aliases: [], count: 518, violationCount: 714 },
      { name: "tweet", primitive: "media", pathPrefixes: ["tweets/"], aliases: [], count: 0, violationCount: 0 },
    ],
    linkTypes: [{ name: "works_at", inverse: "employs" }],
    edges: [{ fromType: "person", toType: "meeting", count: 5728 }],
    lint: { ok: true, errors: [], warningCount: 61 },
    violations: {
      brokenLinks: { count: 449, sample: [{ page: "meetings/a", detail: "[[how-alex-thinks]]" }] },
      missingRequired: { count: 804, sample: [] },
      undeclaredTypes: { count: 0, sample: [] },
      invalidBrands: { count: 0, sample: [] },
    },
    definitions: [
      { slug: "definitions/show-rate", title: "Show rate", term: "Show rate", brands: ["IR"], calculation: "ir-metrics#showRate", certified: false },
      { slug: "definitions/priority", title: "Priority", term: "Priority", brands: [], calculation: "none", certified: false },
      { slug: "definitions/lead", title: "Lead", term: "Lead", brands: ["IR"], calculation: "none", certified: true },
      { slug: "definitions/mrr", title: "MRR", term: "MRR", brands: ["IR"], calculation: "ir-metrics#mrr", certified: true },
      { slug: "definitions/bad", title: "Bad", term: "Bad", brands: [], calculation: "ir-metrics#magicRoas", certified: false },
    ],
    brands: [
      { slug: "brands/increase-roas", code: "IR", title: "Increase ROAS (IR)", company: "companies/increase-roas" },
      { slug: "brands/revstead", code: "REVSTEAD", title: "Revstead", company: null },
    ],
    clients: [],
  },
  freshness: { observedAt: "2026-11-26T17:58:00Z", ageSeconds: 60, stale: false, thresholdSeconds: 900 },
};

let root: Root;
let container: HTMLDivElement;

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <SystemMapPage />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function openSkeletonTab() {
  const trigger = [...container.querySelectorAll<HTMLButtonElement>("[role=tab]")].find((tab) => tab.textContent?.includes("GBrain skeleton"));
  await act(async () => {
    trigger?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    trigger?.click();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  fixture.systemMap.mockReset();
  fixture.gbrainSkeleton.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("SystemMapPage", () => {
  it("renders live hosts, services and checks with a stale-data alert", async () => {
    fixture.systemMap.mockResolvedValue(MAP);
    await render();
    const text = container.textContent ?? "";
    expect(text).toContain("System Map");
    expect(text).toContain("Stale · 2 h ago");
    expect(container.querySelector("[role=alert]")?.textContent).toContain("Health data is stale");
    expect(container.querySelector('[data-testid="host-paperclip-vps"]')?.textContent).toContain("Down");
    expect(text).toContain("sales_dashboard_snapshots_fail:401");
    expect(text).toContain("Javar profiles");
    expect(text).toContain("javar_gateway:unknown");
    expect(text).not.toMatch(/Jarvis|Hermes|ticket/i);
    expect(fixture.gbrainSkeleton).not.toHaveBeenCalled();
  });

  it("shows a clear error instead of fallback data when the feed is unavailable", async () => {
    fixture.systemMap.mockRejectedValue(new IrApiError("The live system feed is not configured on this server.", 503));
    await render();
    expect(container.textContent).toContain("Live system data is unavailable");
    expect(container.textContent).toContain("not configured");
    expect(container.querySelector('[data-testid^="host-"]')).toBeNull();
  });

  it("renders the GBrain skeleton with red violations, definitions and brand checks", async () => {
    fixture.systemMap.mockResolvedValue(MAP);
    fixture.gbrainSkeleton.mockResolvedValue(SKELETON);
    await render();
    await openSkeletonTab();
    const text = container.textContent ?? "";
    expect(text).toContain("increase-roas v1.0.0");
    expect(container.querySelector('[data-testid="violation-Broken links"] [data-tone]')?.getAttribute("data-tone")).toBe("bad");
    expect(container.querySelector('[data-testid="violation-Undeclared page types"] [data-tone]')?.getAttribute("data-tone")).toBe("ok");
    expect(text).toContain("person → meeting");
    expect(text).toContain("526/526 pages missing fields");
    expect(container.querySelector('[data-testid="definition-definitions/show-rate"]')?.textContent).toContain("Pending owner sign-off");
    expect(container.querySelector('[data-testid="definition-definitions/priority"]')?.textContent).toContain("Not defined yet");
    expect(container.querySelector('[data-testid="definition-definitions/lead"]')?.textContent).toContain("Certified");
    expect(container.querySelector('[data-testid="definition-definitions/lead"]')?.textContent).toContain("Term definition (no formula)");
    expect(container.querySelector('[data-testid="definition-definitions/mrr"]')?.textContent).toContain("Certified");
    expect(container.querySelector('[data-testid="definition-definitions/bad"]')?.textContent).toContain("Broken pointer");
    expect(text).toContain("Page missing");
    expect(text).toContain("Not an own brand: brands/revstead (REVSTEAD)");
  });
});
