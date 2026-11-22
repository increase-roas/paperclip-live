import { useCallback } from "react";
import { normalizeInboxIssueColumns, type InboxIssueColumn } from "../../lib/inbox";

/**
 * Column visibility for the task list. The caller owns how a choice is
 * persisted (per-view preference or legacy storage keys); toggling and
 * normalization are the same in both variants.
 */
export function useIssueColumns({
  setVisibleIssueColumns,
  visibleIssueColumns,
  save,
}: {
  setVisibleIssueColumns: (columns: InboxIssueColumn[]) => void;
  visibleIssueColumns: InboxIssueColumn[];
  save: (columns: InboxIssueColumn[]) => void;
}) {
  const setIssueColumns = useCallback((next: InboxIssueColumn[]) => {
    const normalized = normalizeInboxIssueColumns(next);
    setVisibleIssueColumns(normalized);
    save(normalized);
  }, [save, setVisibleIssueColumns]);

  const toggleIssueColumn = useCallback((column: InboxIssueColumn, enabled: boolean) => {
    if (enabled) {
      setIssueColumns([...visibleIssueColumns, column]);
      return;
    }
    setIssueColumns(visibleIssueColumns.filter((value) => value !== column));
  }, [setIssueColumns, visibleIssueColumns]);

  return { setIssueColumns, toggleIssueColumn };
}
