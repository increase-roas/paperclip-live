import { describe, expect, it } from "vitest";

import { parseNativeExecutionInput } from "../vendor/paperclip-runner/index.js";

/**
 * Server acceptance boundary for the closed native-execution input parser.
 *
 * The Runner package owns the exhaustive v1-v10 contract suite. The server
 * only needs to prove that the boundary it calls still accepts a valid
 * envelope and rejects malformed ones before a run starts. Keeping the test
 * here (instead of importing the package's `.test.ts` file) makes discovery
 * independent of the Runner package's build output and of which Vitest copy
 * the imported file resolves.
 */
const validInput = {
  schema: "paperclip.native-execution-input.v1",
  binding: {
    companyId: "company-1",
    runId: "run-1",
    issueId: "issue-1",
    agentId: "agent-1",
    executionWorkspaceId: "workspace-1",
  },
  task: {
    identifier: "PAP-1",
    title: "Safe task",
    description: null,
    prompt: "# PAP-1: Safe task\n\nPlease address the latest comment.",
    workMode: "standard",
  },
  workspace: { cwd: "/safe/workspace", repoUrl: null, repoRef: null, branchName: null },
  session: {
    normalizedSessionId: null,
    driverKind: "codex_app_server",
    protocolVersion: 1,
    lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
  },
  provider: { kind: "codex", model: null },
  completionContract: {
    id: "contract-1",
    sha256: "abc123",
    schemaVersion: "paperclip.completion-contract.v1",
    contract: {
      revision: "1",
      objective: "Complete the safe task.",
      criteria: [{ id: "objective", requirement: "The task is complete." }],
    },
  },
  interactionResponses: [],
  credentialBindings: [],
};

describe("native execution input boundary", () => {
  it("accepts a valid v1 envelope and preserves its run binding", () => {
    const parsed = parseNativeExecutionInput(structuredClone(validInput));
    expect(parsed.schema).toBe("paperclip.native-execution-input.v1");
    expect(parsed.binding).toEqual(validInput.binding);
    expect(parsed.task.identifier).toBe("PAP-1");
  });

  it("round-trips an already parsed envelope", () => {
    const parsed = parseNativeExecutionInput(structuredClone(validInput));
    expect(parseNativeExecutionInput(parsed)).toEqual(parsed);
  });

  it("rejects an unknown schema version", () => {
    expect(() =>
      parseNativeExecutionInput({ ...structuredClone(validInput), schema: "paperclip.native-execution-input.v99" }),
    ).toThrow();
  });

  it("rejects an envelope with no run binding", () => {
    const withoutBinding = structuredClone(validInput) as Record<string, unknown>;
    delete withoutBinding.binding;
    expect(() => parseNativeExecutionInput(withoutBinding)).toThrow();
  });
});
