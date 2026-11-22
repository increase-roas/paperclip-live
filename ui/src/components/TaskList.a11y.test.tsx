// @vitest-environment jsdom
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIssue } from "../../storybook/fixtures/paperclipData";
import { TaskList, type TaskListItem } from "./TaskList";
import { TooltipProvider } from "./ui/tooltip";
import { EmptyState } from "./EmptyState";
import { ListChecks } from "lucide-react";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, state: _state, disableIssueQuicklook: _quicklook, issuePrefetch: _prefetch, ...props }:
    ComponentProps<"a"> & { to?: string; state?: unknown; disableIssueQuicklook?: boolean; issuePrefetch?: unknown }) =>
    <a href={to} {...props}>{children}</a>,
}));

const require = createRequire(import.meta.url);
const uiRoot = process.cwd().endsWith("/ui") ? process.cwd() : resolve(process.cwd(), "ui");
const addonPath = require.resolve("@storybook/addon-a11y/package.json", { paths: [uiRoot] });
const axe = require(require.resolve("axe-core", { paths: [addonPath] })) as {
  run: (context: Element, options: unknown) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }>;
};

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const items = (count: number, extra: Partial<TaskListItem>[] = []): TaskListItem[] => Array.from({ length: count }, (_, i) => ({
  issue: createIssue({ id: `task-${i}`, title: `Task ${i}`, parentId: null, createdAt: new Date(0), updatedAt: new Date(100_000 - i) }),
  ...extra[i],
}));

describe("TaskList table semantics", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function render(node: ReactNode) {
    await act(async () => root.render(<TooltipProvider>{node}</TooltipProvider>));
  }

  async function expectNoAriaStructureViolations() {
    const results = await axe.run(host, { runOnly: { type: "rule", values: ["aria-required-children", "aria-required-parent"] } });
    expect(results.violations.map(violation => ({
      id: violation.id,
      targets: violation.nodes.map(node => node.target.join(" ")),
    }))).toEqual([]);
  }

  it("gives the table, header and task rows valid parent and child roles", async () => {
    await render(<TaskList items={items(4, [{ unread: true }])} />);
    const table = host.querySelector('[role="table"]')!;
    expect(table).not.toBeNull();
    expect(host.querySelectorAll('[role="table"]')).toHaveLength(1);
    expect(host.querySelector('[role="rowgroup"] [role="row"] [role="columnheader"]')).not.toBeNull();
    expect(host.querySelector('[role="row"] [role="cell"] [data-slot="task-row-title"]')).not.toBeNull();
    await expectNoAriaStructureViolations();
  });

  it("keeps the row overlay link inside a cell", async () => {
    await render(<TaskList items={items(2)} />);
    for (const row of host.querySelectorAll('[data-slot="task-row"][role="row"]')) {
      for (const child of row.children) {
        const role = child.getAttribute("role");
        // Presentation wrappers are flattened into the row by the accessibility tree.
        expect(role === "presentation" || ["cell", "gridcell", "columnheader", "rowheader"].includes(role ?? "")).toBe(true);
      }
    }
    const link = host.querySelector<HTMLAnchorElement>('[data-inbox-issue-link]')!;
    expect(link.closest('[role="cell"]')).not.toBeNull();
    await expectNoAriaStructureViolations();
  });

  it("wraps group headings and the Show more footer in table rows", async () => {
    await render(<TaskList items={items(101)} groupBy="status" />);
    const heading = host.querySelector(".task-list-group-heading")!;
    expect(heading.closest('[role="row"]')?.querySelector('[role="cell"], [role="columnheader"]')).not.toBeNull();
    expect(host.textContent).toContain("Show more tasks");
    const footer = [...host.querySelectorAll("span")].find(element => element.textContent?.startsWith("Rendering "))!;
    expect(footer.closest('[role="row"]')).not.toBeNull();
    expect(footer.closest('[role="cell"]')).not.toBeNull();
    await expectNoAriaStructureViolations();
  }, 30_000);

  it("wraps the empty state in a table row and cell", async () => {
    await render(<TaskList items={[]} emptyState={<EmptyState icon={ListChecks} message="No tasks" />} />);
    const emptyText = [...host.querySelectorAll("p, span, div")].find(element => element.children.length === 0 && element.textContent === "No tasks")!;
    expect(emptyText.closest('[role="row"]')).not.toBeNull();
    expect(emptyText.closest('[role="cell"]')).not.toBeNull();
    await expectNoAriaStructureViolations();
  });
});
