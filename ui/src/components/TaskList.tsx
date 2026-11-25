import { Fragment, useId, useState, type ReactNode } from "react";
import type { Issue } from "@paperclipai/shared";
import { ChevronDown, ChevronRight, GitBranch } from "lucide-react";
import { buildIssueTree } from "../lib/issue-tree";
import { paperclipHumanAvatarUrl } from "../lib/issue-chat-human-author";
import { defaultTaskListColumns, defaultTaskListSort, isTaskListColumnSort, taskListOrderToIssueSort, type TaskListColumnId, type TaskListSort, type TaskListOrder } from "../lib/task-list";
import { sortIssues } from "../lib/issue-sort";
import { timeAgo } from "../lib/timeAgo";
import { IssueRow, type IssueRowDensity } from "./IssueRow";
import { IssueGroupHeader } from "./IssueGroupHeader";
import { StatusIcon } from "./StatusIcon";
import { TaskListColumnHeader, TaskListColumnSettings, TaskListViewport } from "./TaskListColumns";
import { TaskRowGroup } from "./TaskRowGroup";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { useTaskRowBudget } from "../hooks/useTaskRowBudget";
import { AgentAvatar, type AvatarAgent } from "./AgentAvatar";
import { deriveInitials } from "./Identity";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";
import { useTaskListColumnPreferences } from "../hooks/useTaskListColumnPreferences";
import type { TaskCollectionPreferenceLocation } from "../lib/task-collection-preferences";

export type TaskListItem = {
  issue: Issue;
  unread?: boolean;
  createdBy?: string | null;
  assignee?: string | null;
  assigneeAgent?: AvatarAgent | null;
  assigneeUserAvatarUrl?: string | null;
};

export type TaskListGrouping = "none" | "status" | "project";

export type TaskStatusGroupKey = "in_progress" | "in_review" | "todo" | "completed";

export const TASK_STATUS_GROUPS: ReadonlyArray<{
  key: TaskStatusGroupKey;
  label: string;
  iconStatus: string;
  defaultCollapsed?: boolean;
}> = [
  { key: "in_progress", label: "In Progress", iconStatus: "in_progress" },
  { key: "in_review", label: "In Review", iconStatus: "in_review" },
  { key: "todo", label: "Todo", iconStatus: "todo" },
  { key: "completed", label: "Completed", iconStatus: "done", defaultCollapsed: true },
];

export function resolveTaskStatusGroup(status: string): TaskStatusGroupKey {
  switch (status) {
    case "in_progress":
    case "monitoring":
    case "blocked":
      return "in_progress";
    case "in_review":
      return "in_review";
    case "done":
    case "cancelled":
      return "completed";
    case "todo":
    case "backlog":
    default:
      return "todo";
  }
}

/** Keep matching subtasks in their hierarchy without pulling in unrelated siblings. */
export function includeTaskListAncestors(items: readonly TaskListItem[], matches: readonly TaskListItem[]): TaskListItem[] {
  const byId = new Map(items.map(item => [item.issue.id, item]));
  const included = new Set<string>();
  for (const match of matches) {
    let item: TaskListItem | undefined = match;
    while (item && !included.has(item.issue.id)) {
      included.add(item.issue.id);
      item = item.issue.parentId ? byId.get(item.issue.parentId) : undefined;
    }
  }
  return items.filter(item => included.has(item.issue.id));
}

/** Opt-in collection built from the reviewed row, hierarchy and column primitives. */
export function TaskList({ items, allItems = items, initialColumns = defaultTaskListColumns, density = "comfortable", collapsedIds, onCollapsedIdsChange, groupBy = "none", emptyState, issueLinkState, collectionKey, preferenceLocation, sort: controlledSort, onSortChange }: {
  items: readonly TaskListItem[];
  allItems?: readonly TaskListItem[];
  initialColumns?: readonly TaskListColumnId[];
  density?: IssueRowDensity;
  collapsedIds?: ReadonlySet<string>;
  onCollapsedIdsChange?: (ids: ReadonlySet<string>) => void;
  groupBy?: TaskListGrouping;
  emptyState?: ReactNode;
  issueLinkState?: unknown;
  /** Company/person/view/filter identity; membership changes do not reset it. */
  collectionKey?: string;
  preferenceLocation?: TaskCollectionPreferenceLocation;
  sort?: TaskListOrder;
  onSortChange?: (sort: TaskListSort | undefined) => void;
}) {
  const localKey = useId();
  const { columns, order: columnOrder, setColumns, setOrder: setColumnOrder } = useTaskListColumnPreferences(preferenceLocation, initialColumns);
  const [localSort, setLocalSort] = useState<TaskListSort>();
  const sort = controlledSort ?? (onSortChange ? undefined : localSort);
  const setSort = (next: TaskListSort | undefined) => {
    setLocalSort(next);
    onSortChange?.(next);
  };
  const [localCollapsed, setLocalCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(
    () => new Set(TASK_STATUS_GROUPS.filter(group => group.defaultCollapsed).map(group => group.key)),
  );
  const toggleGroup = (key: string) => {
    setCollapsedGroups(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const collapsed = collapsedIds ?? localCollapsed;
  const setCollapsed = onCollapsedIdsChange ?? setLocalCollapsed;
  const byId = new Map(allItems.map(item => [item.issue.id, item]));
  const visibleById = new Map(items.map(item => [item.issue.id, item]));
  const ordered = sortIssues(items.map(item => item.issue), taskListOrderToIssueSort(sort ?? defaultTaskListSort), issue => {
    const item = byId.get(issue.id)!;
    const parent = issue.parentId ? byId.get(issue.parentId)?.issue : null;
    return { createdBy: item.createdBy, assignee: item.assignee, parentTask: parent ? `${parent.identifier} ${parent.title}` : null };
  });
  const { roots, childMap } = buildIssueTree(ordered);
  type RenderedGroup = { key: string; label: string; iconStatus?: string; collapsible?: boolean; roots: Issue[] };
  const groupedSections: RenderedGroup[] = (() => {
    if (groupBy === "status") {
      const buckets = new Map<TaskStatusGroupKey, Issue[]>(TASK_STATUS_GROUPS.map(group => [group.key, []]));
      for (const root of roots) {
        const key = resolveTaskStatusGroup(root.status);
        buckets.get(key)!.push(root);
      }
      return TASK_STATUS_GROUPS.flatMap(group => {
        const groupRoots = buckets.get(group.key) ?? [];
        return groupRoots.length > 0
          ? [{ key: group.key, label: group.label, iconStatus: group.iconStatus, collapsible: true, roots: groupRoots }]
          : [];
      });
    }
    if (groupBy === "project") {
      const byProject = new Map<string, Issue[]>();
      for (const root of roots) {
        const label = root.project?.name ?? "No project";
        byProject.set(label, [...(byProject.get(label) ?? []), root]);
      }
      return [...byProject].map(([label, groupRoots]) => ({ key: label, label, roots: groupRoots }));
    }
    return [{ key: "", label: "", roots }];
  })();
  const rowIds: string[] = [];
  const collectRows = (issue: Issue) => {
    rowIds.push(issue.id);
    if (!collapsed.has(issue.id)) for (const child of childMap.get(issue.id) ?? []) collectRows(child);
  };
  for (const section of groupedSections) {
    if (section.collapsible && collapsedGroups.has(section.key)) continue;
    section.roots.forEach(collectRows);
  }
  const { limit, hasMore, sentinel, loadMore } = useTaskRowBudget(rowIds, JSON.stringify([collectionKey ?? localKey, sort ?? defaultTaskListSort, groupBy]));
  const renderedIds = new Set(rowIds.slice(0, limit));
  const updateColumns = (next: readonly TaskListColumnId[]) => {
    setColumns(next);
    if (sort && isTaskListColumnSort(sort) && !next.includes(sort.column)) setSort(undefined);
  };
  const renderBranch = (issue: Issue, depth: number): ReactNode => {
    if (!renderedIds.has(issue.id)) return null;
    const item = visibleById.get(issue.id)!;
    const children = childMap.get(issue.id) ?? [];
    const expanded = !collapsed.has(issue.id);
    const parent = issue.parentId ? byId.get(issue.parentId)?.issue : null;
    const branch = issue.currentExecutionWorkspace?.branchName;
    const assigneeName = item.assignee ?? (issue.assigneeAgentId ? "Unknown agent" : issue.assigneeUserId ? "User" : "Unassigned");
    const assigneeUserAvatarUrl = paperclipHumanAvatarUrl(item.assigneeUserAvatarUrl);
    return (
      <Fragment key={issue.id}>
        <IssueRow
          issue={issue} presentation="task" appearance="refreshed" density={density} issueLinkState={issueLinkState}
          unreadState={item.unread ? "visible" : "hidden"}
          treeGuides={depth} chevronInGuide={depth > 0 && children.length > 0}
          leadingControl={children.length ? (
            <Button variant="ghost" size="icon-xs" className="task-row-disclosure" aria-label={`${expanded ? "Collapse" : "Expand"} ${issue.title}`} aria-expanded={expanded} onClick={() => {
              const next = new Set(collapsed);
              if (next.has(issue.id)) next.delete(issue.id); else next.add(issue.id);
              setCollapsed(next);
            }}>{expanded ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}</Button>
          ) : undefined}
          columnValues={{
            createdBy: item.createdBy,
            assignee: assigneeName,
            assigneeAvatar: issue.assigneeAgentId ? (
              <AgentAvatar agent={item.assigneeAgent ?? { id: issue.assigneeAgentId, name: assigneeName }} size={20} />
            ) : issue.assigneeUserId ? (
              <Avatar size="xs" aria-hidden="true">
                {assigneeUserAvatarUrl ? <AvatarImage src={assigneeUserAvatarUrl} alt="" /> : null}
                <AvatarFallback>{deriveInitials(assigneeName)}</AvatarFallback>
              </Avatar>
            ) : null,
            project: issue.project?.name,
            parentTask: parent ? <span><span className="font-mono">{parent.identifier}</span> {parent.title}</span> : undefined,
            tags: issue.labels?.length ? <span className="inline-flex items-center gap-1">{issue.labels.map(label => <Badge key={label.id} variant="secondary" className="shrink-0 px-1.5 py-0">{label.name}</Badge>)}</span> : undefined,
            worktree: branch ? <span className="inline-flex items-center gap-1.5"><GitBranch className="size-3 shrink-0" aria-hidden />{branch}</span> : undefined,
            lastUpdated: timeAgo(issue.updatedAt),
          }}
        />
        {expanded ? children.map(child => renderBranch(child, depth + 1)) : null}
      </Fragment>
    );
  };
  return (
    <TaskListViewport visibleColumns={columns} columnOrder={columnOrder} controls={<TaskListColumnSettings visibleColumns={columns} onVisibleColumnsChange={updateColumns} onColumnOrderChange={setColumnOrder} onResetDefaults={() => setSort(undefined)} />}>
      <TaskListColumnHeader sort={sort && isTaskListColumnSort(sort) ? sort : undefined} onSortChange={setSort} onColumnOrderChange={setColumnOrder} />
      {items.length === 0 ? emptyState : (
        <div aria-label={`${density} task list`}>
          {groupedSections.map(section => {
            const isCollapsed = Boolean(section.collapsible && collapsedGroups.has(section.key));
            const visibleRoots = isCollapsed ? [] : section.roots.filter(issue => renderedIds.has(issue.id));
            if (!isCollapsed && !section.collapsible && visibleRoots.length === 0) return null;
            return (
              <section key={section.key} data-status-group={section.collapsible ? section.key : undefined} className={section.collapsible ? "mt-3 first:mt-0" : undefined}>
                {section.label ? (
                  <IssueGroupHeader
                    label={section.label}
                    icon={section.iconStatus ? <StatusIcon status={section.iconStatus} size="md" /> : undefined}
                    collapsible={section.collapsible}
                    collapsed={isCollapsed}
                    onToggle={section.collapsible ? () => toggleGroup(section.key) : undefined}
                    labelClassName={section.collapsible ? "truncate text-sm font-semibold text-foreground" : undefined}
                    className="task-list-group-heading"
                    trailing={
                      <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1.5 text-xs font-medium text-muted-foreground">
                        {section.roots.length}
                      </span>
                    }
                  />
                ) : null}
                {!isCollapsed && visibleRoots.map(issue => (
                  <TaskRowGroup
                    key={issue.id}
                    role="rowgroup"
                    aria-label={`${issue.title} task group`}
                    data-density={density}
                    className={childMap.get(issue.id)?.length ? undefined : "task-row-deferred"}
                  >
                    {renderBranch(issue, 0)}
                  </TaskRowGroup>
                ))}
              </section>
            );
          })}
        </div>
      )}
      {hasMore ? <div ref={sentinel} className="flex items-center gap-3 py-2 text-sm text-muted-foreground">
        <span>Rendering {Math.min(limit, rowIds.length)} of {rowIds.length} tasks</span>
        <Button variant="outline" size="sm" onClick={loadMore}>Show more tasks</Button>
      </div> : null}
    </TaskListViewport>
  );
}
