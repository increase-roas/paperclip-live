import type { Issue, IssueExecutionStageType } from "@paperclipai/shared";

export type StageDecisionAction = "approve" | "request_changes";

/**
 * The review/approval stage the viewer may decide, or null.
 *
 * The server advances a pending stage through the ordinary issue PATCH: the
 * active participant sends `status=done` with a comment to approve, or any
 * other non-review status with a comment to request changes. The board UI can
 * only offer those verbs when the viewer *is* that user — an agent participant
 * decides inside its own run, and other board users are not the stage actor.
 */
export function activeStageReviewStage(
  issue: Pick<Issue, "status" | "executionState">,
  currentUserId: string | null | undefined,
): IssueExecutionStageType | null {
  if (!currentUserId) return null;
  if (issue.status !== "in_review") return null;
  const state = issue.executionState;
  if (!state || state.status !== "pending") return null;
  const participant = state.currentParticipant;
  if (!participant || participant.type !== "user" || participant.userId !== currentUserId) {
    return null;
  }
  return state.currentStageType;
}

/**
 * The one PATCH body for a stage verdict. Both fields must travel together:
 * the execution-policy service rejects an approval or changes request whose
 * comment is absent from the same request.
 */
export function buildStageDecisionUpdate(action: StageDecisionAction, comment: string) {
  return {
    status: action === "approve" ? "done" : "in_progress",
    comment: comment.trim(),
  };
}
