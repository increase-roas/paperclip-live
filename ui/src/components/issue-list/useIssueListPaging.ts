import { useCallback, useEffect, useRef, type RefObject } from "react";

/** Rows added per "load more" step for both rendered rows and hierarchy rows. */
export const ISSUE_ROW_RENDER_BATCH_SIZE = 150;
/** Distance from the bottom, in pixels, that starts the next page. */
export const ISSUE_SCROLL_LOAD_THRESHOLD_PX = 320;

/**
 * Finds the nearest scrollable ancestor of the list root. The board and the
 * list live inside different shells, so the caller passes its own root.
 */
export function findIssuesScrollContainer(element: HTMLElement | null): HTMLElement | null {
  if (!element || typeof window === "undefined") return null;
  let current = element.parentElement;
  while (current && current !== document.body && current !== document.documentElement) {
    const overflowY = window.getComputedStyle(current).overflowY;
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

export interface IssueListPagingInput {
  viewMode: string;
  renderedIssueRowLimit: number;
  setRenderedIssueRowLimit: (update: (current: number) => number) => void;
  setHierarchyRowBudget: (update: (current: number) => number) => void;
  visibleListRowCount: number;
  hasMoreHierarchyRows?: boolean;
  hierarchyFetching?: boolean;
  hasMoreIssues: boolean;
  isLoadingMoreIssues?: boolean;
  isLoading?: boolean;
  /** Set when the last page failed. A failed page waits for an explicit retry. */
  loadMoreError?: unknown;
  onLoadMoreIssues?: () => void;
  rootRef: RefObject<HTMLElement | null>;
}

/**
 * Shared list paging for the task list and its legacy variant: how many rows
 * are revealed, which source supplies the next page, and the scroll sentinel
 * that asks for it.
 */
export function useIssueListPaging({
  viewMode,
  renderedIssueRowLimit,
  setRenderedIssueRowLimit,
  setHierarchyRowBudget,
  visibleListRowCount,
  hasMoreHierarchyRows,
  hierarchyFetching,
  hasMoreIssues,
  isLoadingMoreIssues,
  isLoading,
  loadMoreError,
  onLoadMoreIssues,
  rootRef,
}: IssueListPagingInput) {
  const initialServerFillRequestedRef = useRef(false);
  const hasMoreRenderedRows = viewMode === "list" && renderedIssueRowLimit < visibleListRowCount;
  const remainingIssueRowCount = Math.max(visibleListRowCount - renderedIssueRowLimit, 0);

  const loadMoreIssueRows = useCallback(() => {
    if (viewMode !== "list") return;
    // A failed page waits for an explicit retry. Without this gate every
    // scroll event next to the sentinel would send the same failing request.
    if (loadMoreError) return;
    if (hasMoreHierarchyRows && !hierarchyFetching) {
      setHierarchyRowBudget((current) => current + ISSUE_ROW_RENDER_BATCH_SIZE);
      setRenderedIssueRowLimit((current) => current + ISSUE_ROW_RENDER_BATCH_SIZE);
      return;
    }
    if (hasMoreRenderedRows) {
      setRenderedIssueRowLimit((current) => Math.min(visibleListRowCount, current + ISSUE_ROW_RENDER_BATCH_SIZE));
      return;
    }
    if (hasMoreIssues && !isLoadingMoreIssues) {
      onLoadMoreIssues?.();
    }
  }, [
    visibleListRowCount,
    hasMoreIssues,
    hasMoreRenderedRows,
    hasMoreHierarchyRows,
    hierarchyFetching,
    isLoadingMoreIssues,
    loadMoreError,
    onLoadMoreIssues,
    viewMode,
  ]);

  const canLoadMoreIssues = viewMode === "list"
    && !isLoading
    && !loadMoreError
    && (hasMoreRenderedRows || (hasMoreHierarchyRows && !hierarchyFetching) || (hasMoreIssues && !isLoadingMoreIssues));

  useEffect(() => {
    if (!canLoadMoreIssues) return;
    let animationFrameId: number | null = null;
    const scrollContainer = findIssuesScrollContainer(rootRef.current);
    const scrollTarget: Window | HTMLElement = scrollContainer ?? window;

    const checkScrollPosition = (trigger: "initial" | "scroll" | "resize" = "scroll") => {
      if (animationFrameId !== null) return;
      animationFrameId = window.requestAnimationFrame(() => {
        animationFrameId = null;
        const scrollHeight = scrollContainer?.scrollHeight ?? document.documentElement.scrollHeight;
        if (scrollHeight === 0) return;
        const viewportHeight = scrollContainer?.clientHeight ?? window.innerHeight;
        const scrollBottom = scrollContainer
          ? scrollContainer.scrollTop + scrollContainer.clientHeight
          : window.scrollY + window.innerHeight;
        const hasScrollableOverflow = scrollHeight > viewportHeight + 1;
        const threshold = scrollHeight - ISSUE_SCROLL_LOAD_THRESHOLD_PX;
        if (scrollBottom >= threshold) {
          if (trigger === "initial" && !hasMoreRenderedRows && hasMoreIssues && !hasScrollableOverflow) {
            if (initialServerFillRequestedRef.current) return;
            initialServerFillRequestedRef.current = true;
          }
          loadMoreIssueRows();
        }
      });
    };

    const handleScroll = () => checkScrollPosition("scroll");
    const handleResize = () => checkScrollPosition("resize");
    scrollTarget.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", handleResize);
    checkScrollPosition("initial");

    return () => {
      scrollTarget.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", handleResize);
      if (animationFrameId !== null) window.cancelAnimationFrame(animationFrameId);
    };
  }, [canLoadMoreIssues, hasMoreIssues, hasMoreRenderedRows, loadMoreIssueRows, rootRef]);

  return { hasMoreRenderedRows, remainingIssueRowCount, loadMoreIssueRows, canLoadMoreIssues };
}
