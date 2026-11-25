// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIssue } from "../../storybook/fixtures/paperclipData";
import { TaskList, type TaskListItem } from "./TaskList";
import { TooltipProvider } from "./ui/tooltip";
import { readTaskListSortParams } from "../lib/task-list";

vi.mock("./IssueRow", () => ({ IssueRow: ({ issue, leadingControl }: { issue: { id: string; title: string }; leadingControl?: ReactNode }) =>
  <div data-issue-row-details={issue.id}>{leadingControl}<button>{issue.title}</button></div> }));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const tasks = (count: number, parentId: string | null = null): TaskListItem[] => Array.from({ length: count }, (_, i) => ({
  issue: createIssue({ id: `task-${i}`, title: `Task ${i}`, parentId, createdAt: new Date(0), updatedAt: new Date(100_000 - i) }),
}));
describe("TaskList progressive rendering", () => {
  let host: HTMLDivElement, root: Root;
  beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
  const rows = () => host.querySelectorAll("[data-issue-row-details]");
  async function render(items: TaskListItem[], collectionKey?: string) {
    await act(async () => root.render(<TooltipProvider><TaskList items={items} collectionKey={collectionKey} /></TooltipProvider>));
  }
  async function more() {
    await act(async () => Array.from(host.querySelectorAll("button")).find(b => b.textContent === "Show more tasks")!.click());
  }
  it.each([false, true])("defaults to newest updates while keeping children after their parent (controlled=%s)", async controlled => {
    const items = [
      { issue: createIssue({ id: "child-older", parentId: "parent", updatedAt: new Date(4000) }) },
      { issue: createIssue({ id: "parent", parentId: null, updatedAt: new Date(1000) }) },
      { issue: createIssue({ id: "newest-root", parentId: null, updatedAt: new Date(3000) }) },
      { issue: createIssue({ id: "child-newest", parentId: "parent", updatedAt: new Date(5000) }) },
    ];
    await act(async () => root.render(<TooltipProvider><TaskList items={items} onSortChange={controlled ? vi.fn() : undefined} /></TooltipProvider>));
    expect([...rows()].map(row => row.getAttribute("data-issue-row-details"))).toEqual(["newest-root", "parent", "child-newest", "child-older"]);
    expect(host.querySelector('[role="columnheader"][aria-sort="descending"]')).toBeNull();
    expect(host.querySelector('.task-list-sort-button[data-active]')).toBeNull();
    expect(host.querySelector('[data-slot="task-list-sort-direction"]')).toBeNull();
  });
  it("highlights Last updated only after selection and returns to the unhighlighted default when reset", async () => {
    const items = tasks(2).reverse();
    await render(items);
    const orderedIds = () => [...rows()].map(row => row.getAttribute("data-issue-row-details"));
    expect(orderedIds()).toEqual(["task-0", "task-1"]);
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Last updated: sort ascending"]')!.click());
    expect(orderedIds()).toEqual(["task-1", "task-0"]);
    expect(host.querySelector('.task-list-sort-button[data-active]')?.textContent).toBe("Last updated");
    expect(host.querySelector('[data-column="lastUpdated"][aria-sort="ascending"]')).not.toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Last updated: sort descending"]')!.click());
    expect(orderedIds()).toEqual(["task-0", "task-1"]);
    expect(host.querySelector('[data-column="lastUpdated"][aria-sort="descending"]')).not.toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Columns"]')!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
    const reset = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === "Reset defaults");
    expect(reset).toBeDefined();
    await act(async () => reset!.click());
    expect(orderedIds()).toEqual(["task-0", "task-1"]);
    expect(host.querySelector('.task-list-sort-button[data-active]')).toBeNull();
  });
  it("honors a creation-time URL sort and reports column sorting", async () => {
    const items = [
      { issue: createIssue({ id: "older", title: "Older", identifier: "PAP-1", createdAt: new Date(0) }) },
      { issue: createIssue({ id: "newer", title: "Newer", identifier: "PAP-2", createdAt: new Date(1000) }) },
    ];
    const onSortChange = vi.fn();
    await act(async () => root.render(<TooltipProvider><TaskList items={items}
      sort={{ column: "created", direction: "descending" }} onSortChange={onSortChange} /></TooltipProvider>));
    expect([...rows()].map(row => row.getAttribute("data-issue-row-details"))).toEqual(["newer", "older"]);
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Task ID: sort ascending"]')!.click());
    expect(onSortChange).toHaveBeenLastCalledWith({ column: "taskId", direction: "ascending" });
    await act(async () => root.render(<TooltipProvider><TaskList items={items}
      sort={{ column: "taskId", direction: "ascending" }} onSortChange={onSortChange} /></TooltipProvider>));
    expect([...rows()].map(row => row.getAttribute("data-issue-row-details"))).toEqual(["older", "newer"]);
    expect(host.querySelector('[data-column="taskId"][aria-sort="ascending"]')).not.toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Task ID: sort descending"]')!.click());
    expect(onSortChange).toHaveBeenLastCalledWith({ column: "taskId", direction: "descending" });
  });

  it.each(["status", "workflow"])("honors a Classic %s sort link", async field => {
    const items = [
      { issue: createIssue({ id: "later", identifier: "PAP-1", status: "done", createdAt: new Date("2026-02-01") }) },
      { issue: createIssue({ id: "earlier", identifier: "PAP-2", status: "in_progress", createdAt: new Date("2026-01-01") }) },
    ];
    await act(async () => root.render(<TooltipProvider><TaskList items={items}
      sort={readTaskListSortParams(new URLSearchParams(`sortField=${field}&sortDir=asc`))} /></TooltipProvider>));
    expect([...rows()].map(row => row.getAttribute("data-issue-row-details"))).toEqual(["earlier", "later"]);
  });

  it("bounds the first render, reveals batches, and retains mounted rows through enrichment and append", async () => {
    const items = tasks(400);
    await render(items);
    expect(rows()).toHaveLength(100);
    const first = rows()[0];
    await more();
    expect(rows()).toHaveLength(250);
    await render(items.map(item => ({ ...item, assignee: "New name" })));
    expect(rows()).toHaveLength(250);
    expect(rows()[0]).toBe(first);
    await render(tasks(450));
    expect(rows()).toHaveLength(250);
    await more(); await more();
    expect(rows()).toHaveLength(450);
    expect(host.textContent).not.toContain("Show more tasks");
  });
  it("retains revealed rows when another server page sorts before them", async () => {
    const items = tasks(200).map((item, i) => ({ issue: { ...item.issue, identifier: `PAP-${i + 21}` } }));
    await render(items, "company:person:paged");
    await more();
    const originalRows = [...rows()];
    const older = tasks(20).map((item, i) => ({ issue: { ...item.issue, id: `older-${i}`, identifier: `PAP-${i + 1}`, updatedAt: new Date(200_000 - i) } }));
    await render([...items, ...older], "company:person:paged");
    expect(rows()).toHaveLength(220);
    expect(originalRows.every(row => row.isConnected)).toBe(true);
    expect(rows()[0].getAttribute("data-issue-row-details")).toBe("older-0");
    await act(async () => root.unmount());
    root = createRoot(host);
    await render([...items, ...older], "company:person:paged");
    expect(rows()).toHaveLength(220);
  });

  it("uses one budget across a large expanded tree, preserving its disclosure and parent", async () => {
    const parent = { issue: createIssue({ id: "root", title: "Root", parentId: null }) };
    await render([parent, ...tasks(220, "root")]);
    expect(rows()).toHaveLength(100);
    expect(rows()[0].getAttribute("data-issue-row-details")).toBe("root");
    const collapse = host.querySelector<HTMLButtonElement>('button[aria-label="Collapse Root"]')!;
    await act(async () => collapse.click());
    expect(rows()).toHaveLength(1);
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Expand Root"]')!.click());
    expect(rows()).toHaveLength(100);
    await more();
    expect(rows()).toHaveLength(221);
  });
  it("reveals more when the sentinel intersects and resets the budget for a different result set", async () => {
    let intersect!: (entries: { isIntersecting: boolean }[]) => void;
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: typeof intersect) { intersect = callback; }
      observe() {} disconnect() {}
    });
    await render(tasks(300));
    expect(rows()).toHaveLength(100);
    await act(async () => intersect([{ isIntersecting: true }]));
    expect(rows()).toHaveLength(250);
    await render(tasks(300).map(item => ({ issue: { ...item.issue, id: `other-${item.issue.id}` } })), "different-filter");
    expect(rows()).toHaveLength(100);
  });

  it("groups tasks into collapsible In Progress, In Review, Todo, and Completed (collapsed by default) sections", async () => {
    const items: TaskListItem[] = [
      { issue: createIssue({ id: "done-1", title: "Finished task", status: "done", updatedAt: new Date(5000) }) },
      { issue: createIssue({ id: "cancelled-1", title: "Cancelled task", status: "cancelled", updatedAt: new Date(4000) }) },
      { issue: createIssue({ id: "todo-1", title: "Todo task", status: "todo", updatedAt: new Date(3000) }) },
      { issue: createIssue({ id: "backlog-1", title: "Backlog task", status: "backlog", updatedAt: new Date(2500) }) },
      { issue: createIssue({ id: "review-1", title: "Review task", status: "in_review", updatedAt: new Date(2000) }) },
      { issue: createIssue({ id: "prog-1", title: "Active task", status: "in_progress", updatedAt: new Date(1000) }) },
    ];
    await act(async () => root.render(<TooltipProvider><TaskList items={items} groupBy="status" /></TooltipProvider>));

    const sections = [...host.querySelectorAll<HTMLElement>("section[data-status-group]")];
    expect(sections.map(s => s.dataset.statusGroup)).toEqual(["in_progress", "in_review", "todo", "completed"]);

    const groupButtons = sections.map(s => s.querySelector<HTMLButtonElement>("button[aria-expanded]")!);
    expect(groupButtons.map(b => b.getAttribute("aria-expanded"))).toEqual(["true", "true", "true", "false"]);
    expect([...rows()].map(r => r.getAttribute("data-issue-row-details"))).toEqual([
      "prog-1",
      "review-1",
      "todo-1",
      "backlog-1",
    ]);

    await act(async () => groupButtons[3].click());
    expect(groupButtons[3].getAttribute("aria-expanded")).toBe("true");
    expect([...rows()].map(r => r.getAttribute("data-issue-row-details"))).toEqual([
      "prog-1",
      "review-1",
      "todo-1",
      "backlog-1",
      "done-1",
      "cancelled-1",
    ]);

    await act(async () => groupButtons[0].click());
    expect(groupButtons[0].getAttribute("aria-expanded")).toBe("false");
    expect([...rows()].map(r => r.getAttribute("data-issue-row-details"))).toEqual([
      "review-1",
      "todo-1",
      "backlog-1",
      "done-1",
      "cancelled-1",
    ]);
  });
});
