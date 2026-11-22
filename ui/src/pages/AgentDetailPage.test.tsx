// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { BreadcrumbProvider } from "@/context/BreadcrumbContext";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { AgentDetailPage } from "./AgentDetailPage";
const params = vi.hoisted(() => ({ agentId: "agent", companyPrefix: "CO", tab: "plugin:test.plugin:insights" }));
const state = vi.hoisted(() => ({ slots: [{ pluginKey: "test.plugin", id: "insights", displayName: "Insights" }, { pluginKey: "test.plugin", id: "notes", displayName: "Notes" }] as unknown[], isLoading: false, errorMessage: null }));
const mount = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/router", () => ({ useParams: () => params, useNavigate: () => mockNavigate, Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "other", companies: [{ id: "company", issuePrefix: "CO" }] }) }));
vi.mock("./AgentDetail", async () => {
  const { useEffect } = await import("react");
  const { useBreadcrumbs } = await import("@/context/BreadcrumbContext");
  return { AgentDetail: () => {
    const { setBreadcrumbs } = useBreadcrumbs();
    useEffect(() => { setBreadcrumbs([{ label: "Overview" }]); }, [setBreadcrumbs]);
    return <p>Built-in agent view</p>;
  } };
});
vi.mock("@/plugins/slots", () => ({ usePluginSlots: () => state, PluginSlotMount: (props: unknown) => { mount(props); return <p>Plugin contribution</p>; } }));
function view() {
  const client = new QueryClient();
  client.setQueryData([...queryKeys.agents.detail("agent"), "company"], { id: "agent-id", companyId: "company", name: "Agent" });
  return <QueryClientProvider client={client}><BreadcrumbProvider companyName="Test company"><AgentDetailPage /></BreadcrumbProvider></QueryClientProvider>;
}
function loadingView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}><BreadcrumbProvider companyName="Test company"><AgentDetailPage /></BreadcrumbProvider></QueryClientProvider>;
}
async function failingView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity, gcTime: Infinity } } });
  const key = [...queryKeys.agents.detail("agent"), "company"];
  await client.fetchQuery({ queryKey: key, queryFn: () => Promise.reject(new Error("upstream unavailable")) }).catch(() => undefined);
  return <QueryClientProvider client={client}><BreadcrumbProvider companyName="Test company"><AgentDetailPage /></BreadcrumbProvider></QueryClientProvider>;
}
function render() {
  return renderToStaticMarkup(view());
}
describe("agent plugin detail views", () => {
  it.each(["insights", "notes"])("mounts arbitrary %s contributions with the resolved agent/company", (id) => {
    params.tab = `plugin:test.plugin:${id}`;
    expect(render()).toContain("Plugin contribution");
    expect(mount).toHaveBeenCalledWith(expect.objectContaining({ slot: expect.objectContaining({ id }), context: expect.objectContaining({ companyId: "company", entityId: "agent-id", entityType: "agent" }) }));
  });
  it("shows unavailable for a removed contribution", () => {
    params.tab = "plugin:removed:insights";
    expect(render()).toContain("This plugin view is unavailable");
    expect(render()).toContain("Back to overview");
    params.tab = "plugin:test.plugin:insights";
  });
  it("names the loading state for a plugin view", () => {
    params.tab = "plugin:test.plugin:insights";
    expect(renderToStaticMarkup(loadingView())).toContain('aria-label="Loading agent view"');
  });
  it("shows the standard error presentation when the agent read fails", async () => {
    params.tab = "plugin:test.plugin:insights";
    const markup = renderToStaticMarkup(await failingView());
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Retry");
    expect(markup).toContain("Couldn&#x27;t load this agent view");
  });
  it("preserves built-in agent routes", () => {
    params.tab = "overview";
    expect(render()).toContain("Built-in agent view");
    params.tab = "plugin:test.plugin:insights";
  });
});

it.each(["plugin:test.plugin:insights", "overview"])("updates headings on entry from %s and between plugin views", (initialTab) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    params.tab = initialTab;
    act(() => { root.render(view()); });
    if (initialTab === "overview") {
      expect(document.title).toBe("Overview • Test company • Paperclip");
      params.tab = "plugin:test.plugin:insights";
      act(() => { root.render(view()); });
    }
    expect(document.title).toBe("Insights • Agent • Agents • Test company • Paperclip");
    params.tab = "plugin:test.plugin:notes";
    act(() => { root.render(view()); });
    expect(document.title).toBe("Notes • Agent • Agents • Test company • Paperclip");
    params.tab = "plugin:removed:notes";
    act(() => { root.render(view()); });
    expect(document.title).toBe("Plugin view • Agent • Agents • Test company • Paperclip");
  } finally {
    act(() => { root.unmount(); });
    params.tab = "plugin:test.plugin:insights";
  }
});
