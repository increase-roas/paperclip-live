import { useId, useState } from "react";
import type { IssueBlockerAttention } from "@paperclipai/shared";
import { cn } from "../lib/utils";
import { StatusGlyph, type StatusGlyphSize } from "./StatusGlyph";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { resolveTaskStatusPresentation, taskStatusLabel, type TaskStatusPresentationInput } from "../lib/task-status-presentation";

const allStatuses = ["backlog", "todo", "in_progress", "in_review", "done", "cancelled", "blocked"];

/** Stage verdicts the active review/approval participant can record from the picker. */
export interface StatusDecisionActions {
  stageType: "review" | "approval";
  pending?: boolean;
  onApprove: (comment: string) => void;
  onRequestChanges: (comment: string) => void;
}

interface StatusIconProps extends TaskStatusPresentationInput {
  /**
   * `comment` is present only when the picker collected one. Callers forward
   * both fields in the same issue PATCH so a stage decision is never split
   * into a status write and a separate comment write.
   */
  onChange?: (status: string, comment?: string) => void;
  className?: string;
  /** Optional layout wrapper around the glyph. Does not change glyph dimensions. */
  glyphContainerClassName?: string;
  showLabel?: boolean;
  /** Glyph size (PAP-243a). Default `md` (16px); lists/detail/mentions use `lg` (20px). */
  size?: StatusGlyphSize;
  /** Offer a comment field; selecting a status then stages it for one submit. */
  commentable?: boolean;
  /** Stage verdict shortcuts for the viewer acting as the current participant. */
  reviewActions?: StatusDecisionActions | null;
}

/** Shared accessible/tooltip copy, including waiting and covered-blocker states. */
export function getStatusIconLabel(status: string, externalConversationState?: "active" | "waiting" | null, blockerAttention?: IssueBlockerAttention | null, presentationStatus?: string | null): string {
  return resolveTaskStatusPresentation({ status, displayStatus: presentationStatus, externalConversationState, blockerAttention }).ariaLabel;
}

interface StatusPickerMenuProps {
  currentStatus: string;
  presentation: TaskStatusPresentationInput;
  commentable?: boolean;
  reviewActions?: StatusDecisionActions | null;
  onSelect: (status: string, comment?: string) => void;
}

/**
 * Picker body, split out so the comment and stage-verdict flows are testable
 * without mounting a Radix popover. Radix unmounts the content on close, so
 * each open starts with an empty comment and no staged status.
 */
export function StatusPickerMenu({
  currentStatus,
  presentation,
  commentable = false,
  reviewActions,
  onSelect,
}: StatusPickerMenuProps) {
  const commentId = useId();
  const [comment, setComment] = useState("");
  const [stagedStatus, setStagedStatus] = useState<string | null>(null);
  const trimmedComment = comment.trim();
  const commentRequired = Boolean(reviewActions);
  const withComment = commentable || commentRequired;
  const activeStatus = stagedStatus ?? currentStatus;
  const decisionLabel = reviewActions?.stageType === "approval" ? "approver" : "reviewer";

  const chooseStatus = (status: string) => {
    if (!withComment) {
      onSelect(status);
      return;
    }
    // Stage the choice so the comment and status leave in one submit.
    setStagedStatus(status);
  };

  const submitStagedStatus = () => {
    if (!stagedStatus) return;
    onSelect(stagedStatus, trimmedComment || undefined);
  };

  return (
    <div data-testid="status-picker-menu">
      {reviewActions ? (
        <div
          className="mb-1 space-y-2 border-b border-border px-1 pb-2"
          data-testid="status-review-actions"
        >
          <p className="text-xs text-muted-foreground">
            You are the {decisionLabel} for this task. Add a comment to approve or request changes.
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              className="flex-1"
              disabled={reviewActions.pending || !trimmedComment}
              title={trimmedComment ? undefined : "Add a comment to approve"}
              onClick={() => reviewActions.onApprove(trimmedComment)}
              data-testid="status-approve"
            >
              Approve
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="flex-1"
              disabled={reviewActions.pending || !trimmedComment}
              title={trimmedComment ? undefined : "Add a comment to request changes"}
              onClick={() => reviewActions.onRequestChanges(trimmedComment)}
              data-testid="status-request-changes"
            >
              Request changes
            </Button>
          </div>
        </div>
      ) : null}

      <div role="group" aria-label="Change status">
        {allStatuses.map((s) => (
          <Button
            key={s}
            type="button"
            variant="ghost"
            size="sm"
            className={cn("w-full justify-start gap-2 text-xs", s === activeStatus && "bg-accent")}
            aria-pressed={withComment ? s === stagedStatus : undefined}
            onClick={() => chooseStatus(s)}
          >
            {/* The current row is the task's state: draw it exactly like the trigger. */}
            <StatusIcon {...(s === currentStatus ? presentation : { status: s })} size="lg" />
            {taskStatusLabel(s)}
          </Button>
        ))}
      </div>

      {withComment ? (
        <div className="mt-1 space-y-2 border-t border-border px-1 pt-2">
          <label htmlFor={commentId} className="block text-xs text-muted-foreground">
            Comment {commentRequired ? "(required)" : "(optional)"}
          </label>
          <Textarea
            id={commentId}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder={
              reviewActions
                ? "Explain your decision…"
                : "Add a note with this status change…"
            }
            className="min-h-14 text-xs"
            disabled={reviewActions?.pending}
            data-testid="status-change-comment"
          />
          {withComment ? (
            <Button
              type="button"
              size="sm"
              className="w-full"
              disabled={!stagedStatus}
              onClick={submitStagedStatus}
              data-testid="status-change-submit"
            >
              {stagedStatus ? `Change to ${taskStatusLabel(stagedStatus)}` : "Select a status"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Task/issue status indicator — renders the unified, color-blind-safe
 * {@link StatusGlyph} (one distinct shape per status). With `onChange` it also
 * acts as a status picker (popover). This one component drives every standalone
 * status surface: list, kanban, detail header, properties row + picker flyout,
 * sub-task / blocked-by pills, blocked inbox, quicklook, sibling nav, filters,
 * search, columns, dashboard.
 *
 * A "covered" blocked task (waiting on active work) maps to the `in_queue`
 * glyph — the blocked shape recoloured blue — while the full blocked reason
 * still rides on the accessible label.
 */
export function StatusIcon({ status, displayStatus: presentationStatus, externalConversationState, blockerAttention, onChange, className, glyphContainerClassName, showLabel, size = "md", commentable, reviewActions }: StatusIconProps) {
  const [open, setOpen] = useState(false);
  const presentation = { status, displayStatus: presentationStatus, externalConversationState, blockerAttention };
  const { glyphStatus, label, ariaLabel } = resolveTaskStatusPresentation(presentation);

  const glyphIcon = (
    <StatusGlyph
      status={glyphStatus}
      size={size}
      className={cn(onChange && !showLabel && "cursor-pointer", className)}
      title={ariaLabel}
    />
  );
  const glyph = glyphContainerClassName ? (
    <span className={glyphContainerClassName} data-status-glyph-container="true">
      {glyphIcon}
    </span>
  ) : glyphIcon;

  if (!onChange) {
    return showLabel ? (
      <span className="inline-flex items-center gap-1.5">
        {glyph}
        <span className="text-sm">{label}</span>
      </span>
    ) : (
      glyph
    );
  }

  const trigger = showLabel ? (
    <button
      type="button"
      aria-label={`Change status (current: ${ariaLabel})`}
      className="inline-flex min-h-5 items-center gap-1.5 cursor-pointer hover:bg-accent/50 rounded px-1 -mx-1 py-0.5 transition-colors"
    >
      {glyph}
      <span className="text-sm">{label}</span>
    </button>
  ) : (
    <button
      type="button"
      data-slot="icon-button"
      aria-label={`Change status (current: ${ariaLabel})`}
      className="inline-flex cursor-pointer items-center justify-center rounded-sm focus-visible:outline-none focus-visible:ring-(length:--rad-3) focus-visible:ring-ring"
    >
      {glyph}
    </button>
  );

  const closePicker = () => setOpen(false);
  const pickerReviewActions = reviewActions
    ? {
        ...reviewActions,
        onApprove: (comment: string) => {
          reviewActions.onApprove(comment);
          closePicker();
        },
        onRequestChanges: (comment: string) => {
          reviewActions.onRequestChanges(comment);
          closePicker();
        },
      }
    : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className={cn("p-1", commentable || reviewActions ? "w-72" : "w-40")} align="start">
        <StatusPickerMenu
          currentStatus={status}
          presentation={presentation}
          commentable={commentable}
          reviewActions={pickerReviewActions}
          onSelect={(nextStatus, comment) => {
            onChange(nextStatus, comment);
            closePicker();
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
