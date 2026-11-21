import { describe, expect, it } from "vitest";
import type { Issue, IssueExecutionState } from "@paperclipai/shared";
import {
  activeStageReviewStage,
  buildStageDecisionUpdate,
} from "./stage-review-actions";

function createIssue(overrides: Partial<Issue> = {}): Pick<Issue, "status" | "executionState"> {
  return {
    status: "in_review",
    executionState: {
      status: "pending",
      currentStageId: "stage-1",
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "user", agentId: null, userId: "user-1" },
      returnAssignee: { type: "agent", agentId: "agent-1", userId: null },
      reviewRequest: null,
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
    } satisfies IssueExecutionState,
    ...overrides,
  };
}

describe("activeStageReviewStage", () => {
  it("returns the stage when the viewer is the pending user participant", () => {
    expect(activeStageReviewStage(createIssue(), "user-1")).toBe("review");
  });

  it("returns the approval stage for an approval participant", () => {
    const issue = createIssue({
      executionState: {
        ...createIssue().executionState!,
        currentStageType: "approval",
      },
    });
    expect(activeStageReviewStage(issue, "user-1")).toBe("approval");
  });

  it("hides verdicts from other board users", () => {
    expect(activeStageReviewStage(createIssue(), "user-2")).toBeNull();
    expect(activeStageReviewStage(createIssue(), null)).toBeNull();
    expect(activeStageReviewStage(createIssue(), undefined)).toBeNull();
  });

  it("does not offer verdicts to an agent participant", () => {
    const issue = createIssue({
      executionState: {
        ...createIssue().executionState!,
        currentParticipant: { type: "agent", agentId: "agent-1", userId: null },
      },
    });
    expect(activeStageReviewStage(issue, "user-1")).toBeNull();
  });

  it("requires a pending stage on an in-review task", () => {
    const notInReview = createIssue({ status: "in_progress" });
    expect(activeStageReviewStage(notInReview, "user-1")).toBeNull();

    const changesRequested = createIssue({
      executionState: { ...createIssue().executionState!, status: "changes_requested" },
    });
    expect(activeStageReviewStage(changesRequested, "user-1")).toBeNull();

    const completed = createIssue({
      executionState: { ...createIssue().executionState!, status: "completed" },
    });
    expect(activeStageReviewStage(completed, "user-1")).toBeNull();
  });

  it("returns null without an execution state", () => {
    expect(activeStageReviewStage(createIssue({ executionState: null }), "user-1")).toBeNull();
  });
});

describe("buildStageDecisionUpdate", () => {
  it("sends approve as done with the trimmed comment in the same body", () => {
    expect(buildStageDecisionUpdate("approve", "  Looks good  ")).toEqual({
      status: "done",
      comment: "Looks good",
    });
  });

  it("sends request changes as in_progress with the trimmed comment", () => {
    expect(buildStageDecisionUpdate("request_changes", "Please cover the edge case")).toEqual({
      status: "in_progress",
      comment: "Please cover the edge case",
    });
  });
});
