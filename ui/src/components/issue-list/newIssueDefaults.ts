import { useCallback } from "react";
import type { Issue } from "@paperclipai/shared";
import { buildSubIssueDefaultsForViewer } from "../../lib/subIssueDefaults";

export interface NewIssueDefaultsInput {
  group?: { key: string; items: Issue[] };
  baseCreateIssueDefaults?: Record<string, unknown>;
  projectId?: string;
  currentUserId?: string | null;
  groupBy: string;
  executionWorkspaceById: ReadonlyMap<string, {
    projectWorkspaceId: string | null;
    projectId: string | null;
  }>;
  projectWorkspaceById: ReadonlyMap<string, { projectId: string }>;
  issueById: ReadonlyMap<string, Issue>;
}

/**
 * Defaults for the new-task dialog when it opens from a specific group: the
 * group's status, priority, assignee, project, workspace or parent seed the
 * form. Shared by the task list and its legacy variant.
 */
export function buildNewIssueDefaults({
  group,
  baseCreateIssueDefaults,
  projectId,
  currentUserId,
  groupBy,
  executionWorkspaceById,
  projectWorkspaceById,
  issueById,
}: NewIssueDefaultsInput): Record<string, unknown> {
  const groupKey = group?.key;
  const defaults: Record<string, unknown> = { ...(baseCreateIssueDefaults ?? {}) };
  if (projectId && defaults.projectId === undefined) defaults.projectId = projectId;
  if (groupKey) {
    if (groupBy === "status") defaults.status = groupKey === "monitoring" ? "todo" : groupKey;
    else if (groupBy === "priority") defaults.priority = groupKey;
    else if (groupBy === "assignee" && groupKey !== "__unassigned") {
      if (groupKey.startsWith("__user:")) defaults.assigneeUserId = groupKey.slice("__user:".length);
      else defaults.assigneeAgentId = groupKey;
    }
    else if (groupBy === "project" && groupKey !== "__no_project") defaults.projectId = groupKey;
    else if (groupBy === "workspace" && groupKey !== "__no_workspace") {
      const representativeIssue = group?.items.find((issue) =>
        issue.executionWorkspaceId === groupKey || issue.projectWorkspaceId === groupKey,
      ) ?? null;
      const executionWorkspace = executionWorkspaceById.get(groupKey);
      if (executionWorkspace) {
        defaults.executionWorkspaceId = groupKey;
        defaults.executionWorkspaceMode = "reuse_existing";
        if (executionWorkspace.projectWorkspaceId) defaults.projectWorkspaceId = executionWorkspace.projectWorkspaceId;
        const groupedProjectId = executionWorkspace.projectId
          ?? (executionWorkspace.projectWorkspaceId
            ? projectWorkspaceById.get(executionWorkspace.projectWorkspaceId)?.projectId
            : null)
          ?? (representativeIssue?.executionWorkspaceId === groupKey ? representativeIssue.projectId : null);
        if (groupedProjectId) defaults.projectId = groupedProjectId;
      } else {
        const projectWorkspace = projectWorkspaceById.get(groupKey);
        if (projectWorkspace) {
          defaults.projectWorkspaceId = groupKey;
          defaults.projectId = projectWorkspace.projectId;
        }
      }
    }
    else if (groupBy === "parent" && groupKey !== "__no_parent") {
      const parentIssue = issueById.get(groupKey);
      if (parentIssue) Object.assign(defaults, buildSubIssueDefaultsForViewer(parentIssue, currentUserId));
      else defaults.parentId = groupKey;
    }
  }
  return defaults;
}

/**
 * Memoized `buildNewIssueDefaults` for a component. `viewState.groupBy` is the
 * only view field the builder reads, so it takes the whole view state to keep
 * the dependency list short.
 */
export function useNewIssueDefaults(
  input: Omit<NewIssueDefaultsInput, "group" | "groupBy"> & { viewState: { groupBy: string } },
) {
  const {
    baseCreateIssueDefaults,
    currentUserId,
    executionWorkspaceById,
    issueById,
    projectId,
    projectWorkspaceById,
    viewState,
  } = input;
  return useCallback(
    (group?: { key: string; items: Issue[] }) =>
      buildNewIssueDefaults({
        group,
        baseCreateIssueDefaults,
        projectId,
        currentUserId,
        groupBy: viewState.groupBy,
        executionWorkspaceById,
        projectWorkspaceById,
        issueById,
      }),
    [
      baseCreateIssueDefaults,
      currentUserId,
      executionWorkspaceById,
      issueById,
      projectId,
      projectWorkspaceById,
      viewState.groupBy,
    ],
  );
}
