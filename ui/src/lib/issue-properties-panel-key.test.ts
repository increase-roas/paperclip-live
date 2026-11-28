import { describe, expect, it } from "vitest";
import type { Issue, IssueRelationIssueSummary } from "@paperclipai/shared";
import { buildIssuePropertiesPanelKey } from "./issue-properties-panel-key";

function createIssue(overrides: Partial<Issue> = {}) {
  return {
    id: "issue-1",
    status: "in_progress" as const,
    priority: "medium" as const,
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    projectId: "project-1",
    projectWorkspaceId: null,
    parentId: null,
    createdByUserId: "user-1",
    hiddenAt: null,
    labelIds: ["label-1"],
    executionPolicy: null,
    executionState: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    currentExecutionWorkspace: null,
    blocks: [],
    blockedBy: [],
    ancestors: [],
    updatedAt: new Date("2026-04-12T12:00:00.000Z"),
    ...overrides,
  };
}

describe("buildIssuePropertiesPanelKey", () => {
  describe.each(["blocks", "blockedBy"] as const)("%s relations", (relationField) => {
    const relation: IssueRelationIssueSummary = {
      id: "related-1",
      identifier: null,
      title: "Related task",
      status: "todo",
      priority: "medium",
      assigneeAgentId: null,
      assigneeUserId: null,
    };

    it("changes when a displayed relation property changes", () => {
      const first = buildIssuePropertiesPanelKey(createIssue({ [relationField]: [relation] }), []);
      const changes: Partial<IssueRelationIssueSummary>[] = [
        { id: "related-2" },
        { identifier: "PAP-2" },
        { title: "Renamed task" },
        { status: "done" },
        { displayStatus: "monitoring" },
      ];

      for (const change of changes) {
        const second = buildIssuePropertiesPanelKey(
          createIssue({ [relationField]: [{ ...relation, ...change }] }),
          [],
        );
        expect(second, Object.keys(change)[0]).not.toBe(first);
      }
    });

    it("ignores relation fields that the panel does not use", () => {
      const first = buildIssuePropertiesPanelKey(createIssue({ [relationField]: [relation] }), []);
      const second = buildIssuePropertiesPanelKey(
        createIssue({
          [relationField]: [{ ...relation, priority: "high", assigneeAgentId: "agent-2", assigneeUserId: "user-2" }],
        }),
        [],
      );

      expect(second).toBe(first);
    });

    it("preserves relation order", () => {
      const other = { ...relation, id: "related-2" };
      const first = buildIssuePropertiesPanelKey(createIssue({ [relationField]: [relation, other] }), []);
      const second = buildIssuePropertiesPanelKey(createIssue({ [relationField]: [other, relation] }), []);

      expect(second).not.toBe(first);
    });

    it("treats an absent relation list as empty", () => {
      const first = buildIssuePropertiesPanelKey(createIssue({ [relationField]: undefined }), []);
      const second = buildIssuePropertiesPanelKey(createIssue({ [relationField]: [] }), []);

      expect(second).toBe(first);
    });
  });

  it("ignores plain updatedAt churn", () => {
    const first = buildIssuePropertiesPanelKey(createIssue(), []);
    const second = buildIssuePropertiesPanelKey(
      createIssue({ updatedAt: new Date("2026-04-12T12:05:00.000Z") }),
      [],
    );

    expect(second).toBe(first);
  });

  it("changes when a displayed property changes", () => {
    const first = buildIssuePropertiesPanelKey(createIssue(), []);
    const second = buildIssuePropertiesPanelKey(
      createIssue({ assigneeAgentId: "agent-2" }),
      [],
    );

    expect(second).not.toBe(first);
  });

  it("changes when watchdog configuration changes", () => {
    const first = buildIssuePropertiesPanelKey(createIssue({ watchdog: null }), []);
    const second = buildIssuePropertiesPanelKey(
      createIssue({
        watchdog: {
          id: "watchdog-1",
          companyId: "company-1",
          issueId: "issue-1",
          watchdogAgentId: "agent-1",
          instructions: "Keep the tree moving.",
          status: "active",
          watchdogIssueId: null,
          lastObservedFingerprint: null,
          lastReviewedFingerprint: null,
          lastTriggeredAt: null,
          lastCompletedAt: null,
          triggerCount: 0,
          createdAt: new Date("2026-04-12T12:01:00.000Z"),
          updatedAt: new Date("2026-04-12T12:01:00.000Z"),
        },
      }),
      [],
    );

    expect(second).not.toBe(first);
  });

  it("changes when workspace detail hydrates after opening from a cached issue", () => {
    const first = buildIssuePropertiesPanelKey(createIssue(), []);
    const second = buildIssuePropertiesPanelKey(
      createIssue({
        executionWorkspaceId: "workspace-1",
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "isolated_workspace" },
        currentExecutionWorkspace: {
          id: "workspace-1",
          companyId: "company-1",
          projectId: "project-1",
          projectWorkspaceId: "project-workspace-1",
          sourceIssueId: "issue-1",
          mode: "isolated_workspace",
          strategyType: "git_worktree",
          name: "PAP-1 workspace",
          status: "active",
          deliveryState: "unknown",
          cwd: "/tmp/paperclip/PAP-1",
          repoUrl: null,
          baseRef: "master",
          branchName: "PAP-1-workspace",
          providerType: "git_worktree",
          providerRef: "/tmp/paperclip/PAP-1",
          derivedFromExecutionWorkspaceId: null,
          lastUsedAt: new Date("2026-04-12T12:01:00.000Z"),
          openedAt: new Date("2026-04-12T12:01:00.000Z"),
          closedAt: null,
          cleanupEligibleAt: null,
          cleanupReason: null,
          config: null,
          metadata: null,
          runtimeServices: [],
          createdAt: new Date("2026-04-12T12:01:00.000Z"),
          updatedAt: new Date("2026-04-12T12:01:00.000Z"),
        },
      }),
      [],
    );

    expect(second).not.toBe(first);
  });
});
