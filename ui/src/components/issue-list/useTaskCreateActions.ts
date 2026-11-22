import { useCallback } from "react";
import type { Issue } from "@paperclipai/shared";

/** Label plus open/filter actions shared by the task list and its legacy variant. */
export function useTaskCreateActions({
  createIssueLabel,
  newIssueDefaults,
  openNewIssue,
  updateView,
}: {
  createIssueLabel?: string | null;
  newIssueDefaults: (group?: { key: string; items: Issue[] }) => Record<string, unknown>;
  openNewIssue: (defaults?: Record<string, unknown>) => void;
  updateView: (patch: { workspaces: string[] }) => void;
}) {
  const createActionLabel = createIssueLabel ? `Create ${createIssueLabel}` : "Create Task";
  const createButtonLabel = createIssueLabel ? `New ${createIssueLabel}` : "New Task";
  const openCreateIssueDialog = useCallback((group?: { key: string; items: Issue[] }) => {
    openNewIssue(newIssueDefaults(group));
  }, [newIssueDefaults, openNewIssue]);
  const filterToWorkspace = useCallback((workspaceId: string) => {
    updateView({ workspaces: [workspaceId] });
  }, [updateView]);
  return { createActionLabel, createButtonLabel, openCreateIssueDialog, filterToWorkspace };
}
