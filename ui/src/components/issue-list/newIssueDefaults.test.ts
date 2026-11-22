import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { buildNewIssueDefaults } from "./newIssueDefaults";

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: null,
    executionWorkspaceId: null,
    parentId: null,
    title: "Parent",
    status: "todo",
    assigneeAgentId: null,
    assigneeUserId: null,
    ...overrides,
  } as Issue;
}

const empty = {
  baseCreateIssueDefaults: undefined,
  projectId: undefined,
  currentUserId: "user-1",
  executionWorkspaceById: new Map(),
  projectWorkspaceById: new Map(),
  issueById: new Map(),
};

describe("buildNewIssueDefaults", () => {
  it("seeds status, including monitoring as todo", () => {
    expect(buildNewIssueDefaults({ ...empty, groupBy: "status", group: { key: "in_progress", items: [] } }))
      .toMatchObject({ status: "in_progress" });
    expect(buildNewIssueDefaults({ ...empty, groupBy: "status", group: { key: "monitoring", items: [] } }))
      .toMatchObject({ status: "todo" });
  });

  it("seeds priority and splits user and agent assignees", () => {
    expect(buildNewIssueDefaults({ ...empty, groupBy: "priority", group: { key: "high", items: [] } }))
      .toMatchObject({ priority: "high" });
    expect(buildNewIssueDefaults({ ...empty, groupBy: "assignee", group: { key: "__user:user-9", items: [] } }))
      .toMatchObject({ assigneeUserId: "user-9" });
    expect(buildNewIssueDefaults({ ...empty, groupBy: "assignee", group: { key: "agent-9", items: [] } }))
      .toMatchObject({ assigneeAgentId: "agent-9" });
  });

  it("lets the grouping project win, while the page project only fills an empty slot", () => {
    // The group the user opened names the project they meant, so it wins over
    // both the page prop and any inherited default.
    expect(buildNewIssueDefaults({
      ...empty,
      projectId: "project-1",
      baseCreateIssueDefaults: { projectId: "explicit" },
      groupBy: "project",
      group: { key: "project-2", items: [] },
    })).toMatchObject({ projectId: "project-2" });
    expect(buildNewIssueDefaults({ ...empty, projectId: "project-1", groupBy: "status" }))
      .toMatchObject({ projectId: "project-1" });
  });

  it("reuses an execution workspace and falls back to its project", () => {
    const defaults = buildNewIssueDefaults({
      ...empty,
      groupBy: "workspace",
      group: { key: "ws-1", items: [issue({ executionWorkspaceId: "ws-1" , projectId: "project-from-issue" })] },
      executionWorkspaceById: new Map([["ws-1", { projectWorkspaceId: null, projectId: null }]]),
    });
    expect(defaults).toMatchObject({
      executionWorkspaceId: "ws-1",
      executionWorkspaceMode: "reuse_existing",
      projectId: "project-from-issue",
    });
  });

  it("uses a project workspace when the group names one", () => {
    expect(buildNewIssueDefaults({
      ...empty,
      groupBy: "workspace",
      group: { key: "project-ws-1", items: [] },
      projectWorkspaceById: new Map([["project-ws-1", { projectId: "project-3" }]]),
    })).toMatchObject({ projectWorkspaceId: "project-ws-1", projectId: "project-3" });
  });

  it("seeds a parent by id when the parent task is not loaded", () => {
    expect(buildNewIssueDefaults({ ...empty, groupBy: "parent", group: { key: "missing-parent", items: [] } }))
      .toMatchObject({ parentId: "missing-parent" });
  });

  it("copies base defaults instead of mutating them", () => {
    const base = { priority: "low" };
    const result = buildNewIssueDefaults({ ...empty, baseCreateIssueDefaults: base, groupBy: "status", group: { key: "todo", items: [] } });
    expect(result).not.toBe(base);
    expect(base).toEqual({ priority: "low" });
  });
});
