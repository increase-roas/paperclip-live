import { CircleDot, FilterX } from "lucide-react";
import { EmptyState } from "./EmptyState";

/**
 * The one empty list state shared by the task list and its legacy variant.
 * Filtered and unfiltered states differ only in copy and the actions offered.
 */
export function TaskListEmptyState({
  filtered,
  createActionLabel,
  onClearFilters,
  onCreateIssue,
}: {
  filtered: boolean;
  createActionLabel: string;
  onClearFilters: () => void;
  onCreateIssue: () => void;
}) {
  return (
    <EmptyState
      icon={CircleDot}
      title={filtered ? "No tasks match" : "No tasks yet"}
      message={filtered ? "Nothing matches this search and filter combination." : "Create a task to start work."}
      action={filtered ? "Clear filters & search" : createActionLabel}
      actionIcon={filtered ? FilterX : undefined}
      onAction={filtered ? onClearFilters : onCreateIssue}
      secondaryAction={filtered ? createActionLabel : undefined}
      onSecondaryAction={filtered ? onCreateIssue : undefined}
    />
  );
}
