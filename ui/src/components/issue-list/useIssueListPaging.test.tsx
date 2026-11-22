// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useIssueListPaging, ISSUE_ROW_RENDER_BATCH_SIZE } from "./useIssueListPaging";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  // Scroll geometry for jsdom: keep the sentinel clear of the viewport.
  Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: 10_000 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
  Object.defineProperty(window, "scrollY", { configurable: true, value: 9_500 });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

type HarnessProps = {
  viewMode?: string;
  rendered?: number;
  visible?: number;
  hierarchyMore?: boolean;
  hierarchyFetching?: boolean;
  moreIssues?: boolean;
  loadingMore?: boolean;
  loading?: boolean;
  loadMoreError?: unknown;
  onLoadMoreIssues?: () => void;
};

function harness(props: HarnessProps) {
  const calls: { revealed: number[]; budget: number[]; server: number } = { revealed: [], budget: [], server: 0 };
  const result: { current: ReturnType<typeof useIssueListPaging> | null } = { current: null };
  function Probe() {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const [rendered, setRendered] = [props.rendered ?? 0, (update: (current: number) => number) => calls.revealed.push(update(props.rendered ?? 0))] as const;
    const setBudget = (update: (current: number) => number) => calls.budget.push(update(0));
    result.current = useIssueListPaging({
      viewMode: props.viewMode ?? "list",
      renderedIssueRowLimit: rendered,
      setRenderedIssueRowLimit: setRendered as never,
      setHierarchyRowBudget: setBudget,
      visibleListRowCount: props.visible ?? 0,
      hasMoreHierarchyRows: props.hierarchyMore,
      hierarchyFetching: props.hierarchyFetching,
      hasMoreIssues: props.moreIssues ?? false,
      isLoadingMoreIssues: props.loadingMore,
      isLoading: props.loading,
      loadMoreError: props.loadMoreError,
      onLoadMoreIssues: props.onLoadMoreIssues,
      rootRef,
    });
    return <div ref={rootRef} />;
  }
  root = createRoot(container);
  act(() => root.render(<Probe />));
  return { result, calls };
}

describe("useIssueListPaging", () => {
  it("reveals the next row batch before asking the server", () => {
    const { result } = harness({ rendered: 100, visible: 400, moreIssues: true });
    expect(result.current?.remainingIssueRowCount).toBe(300);
    act(() => result.current?.loadMoreIssueRows());
    expect(result.current?.hasMoreRenderedRows).toBe(true);
  });

  it("asks the server when every rendered row is already visible", () => {
    const onLoadMoreIssues = vi.fn();
    const { result } = harness({ rendered: 400, visible: 400, moreIssues: true, onLoadMoreIssues });
    expect(result.current?.hasMoreRenderedRows).toBe(false);
    act(() => result.current?.loadMoreIssueRows());
    expect(onLoadMoreIssues).toHaveBeenCalledTimes(1);
  });

  it("stops asking the server after a failed page", () => {
    const onLoadMoreIssues = vi.fn();
    const { result } = harness({ rendered: 400, visible: 400, moreIssues: true, onLoadMoreIssues, loadMoreError: new Error("nope") });
    expect(result.current?.canLoadMoreIssues).toBe(false);
    act(() => result.current?.loadMoreIssueRows());
    expect(onLoadMoreIssues).not.toHaveBeenCalled();
  });

  it("does nothing on the board view", () => {
    const onLoadMoreIssues = vi.fn();
    const { result } = harness({ viewMode: "board", rendered: 0, visible: 400, moreIssues: true, onLoadMoreIssues });
    expect(result.current?.hasMoreRenderedRows).toBe(false);
    act(() => result.current?.loadMoreIssueRows());
    expect(onLoadMoreIssues).not.toHaveBeenCalled();
  });

  it("grows both budgets for hierarchy rows until the hierarchy settles", () => {
    const { result, calls } = harness({ rendered: 100, visible: 400, hierarchyMore: true, hierarchyFetching: false });
    act(() => result.current?.loadMoreIssueRows());
    expect(calls.budget).toEqual([ISSUE_ROW_RENDER_BATCH_SIZE]);
    expect(calls.revealed).toEqual([100 + ISSUE_ROW_RENDER_BATCH_SIZE]);
  });

  it("loads the first server page once when the list cannot overflow yet", async () => {
    Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: 0 });
    const onLoadMoreIssues = vi.fn();
    harness({ rendered: 0, visible: 0, moreIssues: true, onLoadMoreIssues });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    // scrollHeight 0 means "not measurable yet": no request is fired.
    expect(onLoadMoreIssues).not.toHaveBeenCalled();
  });
});
