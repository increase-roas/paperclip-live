import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { parseMergeTrainOrder, simulateMergeTrain } from "../merge-train-simulate.mjs";

function git(cwd, args, env = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
      ...env,
    },
  });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function makeRepo() {
  const cwd = mkdtempSync(path.join(tmpdir(), "merge-train-sim-"));
  git(cwd, ["init", "-q", "-b", "master"]);
  writeFileSync(path.join(cwd, "shared.txt"), "base\n");
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-q", "-m", "base"]);
  return cwd;
}

function commitOn(cwd, branch, files, message) {
  git(cwd, ["checkout", "-q", "master"]);
  git(cwd, ["checkout", "-q", "-B", branch]);
  for (const [name, contents] of Object.entries(files)) writeFileSync(path.join(cwd, name), contents);
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-q", "-m", message]);
  git(cwd, ["checkout", "-q", "master"]);
}

test("reads the entry order from a tagged fenced block", () => {
  const markdown = [
    "# Runbook",
    "",
    "```merge-train",
    "#126",
    "#158",
    "fix/lane-d-thing-2026-11-22",
    "```",
    "",
    "```standalone",
    "#152",
    "```",
  ].join("\n");

  assert.deepEqual(parseMergeTrainOrder(markdown), [
    { kind: "pr", number: 126 },
    { kind: "pr", number: 158 },
    { kind: "branch", name: "fix/lane-d-thing-2026-11-22" },
  ]);
  assert.deepEqual(parseMergeTrainOrder(markdown, "standalone"), [{ kind: "pr", number: 152 }]);
});

test("returns no entries when the section is absent", () => {
  assert.deepEqual(parseMergeTrainOrder("# Nothing here\n"), []);
});

test("simulates a clean train in order", () => {
  const cwd = makeRepo();
  commitOn(cwd, "feature-a", { "a.txt": "a\n" }, "add a");
  commitOn(cwd, "feature-b", { "b.txt": "b\n" }, "add b");

  const result = simulateMergeTrain(
    cwd,
    [
      { kind: "branch", name: "feature-a" },
      { kind: "branch", name: "feature-b" },
    ],
    { baseRef: "master" },
  );

  assert.equal(result.merged, 2);
  assert.equal(result.conflicts.length, 0);
  assert.deepEqual(
    result.steps.map((step) => step.ok),
    [true, true],
  );
});

test("stops at the first conflict and names the conflicted paths", () => {
  const cwd = makeRepo();
  commitOn(cwd, "feature-a", { "shared.txt": "from a\n" }, "edit shared from a");
  commitOn(cwd, "feature-b", { "shared.txt": "from b\n" }, "edit shared from b");

  const result = simulateMergeTrain(
    cwd,
    [
      { kind: "branch", name: "feature-a" },
      { kind: "branch", name: "feature-b" },
    ],
    { baseRef: "master" },
  );

  assert.equal(result.merged, 1);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.steps[0].ok, true);
  assert.equal(result.steps[1].ok, false);
  assert.deepEqual(result.steps[1].conflictFiles, ["shared.txt"]);
  assert.equal(result.steps[1].index, 2);
});

test("does not report a false conflict for a PR stacked on an earlier one", () => {
  const cwd = makeRepo();
  commitOn(cwd, "feature-a", { "shared.txt": "from a\n" }, "edit shared from a");
  // feature-b is stacked on feature-a and edits the same line. A real merge
  // applies only B's change (base A), so the result is clean and B wins.
  git(cwd, ["checkout", "-q", "feature-a"]);
  git(cwd, ["checkout", "-q", "-B", "feature-b"]);
  writeFileSync(path.join(cwd, "shared.txt"), "from b\n");
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-q", "-m", "edit shared from b"]);
  git(cwd, ["checkout", "-q", "master"]);

  const result = simulateMergeTrain(
    cwd,
    [
      { kind: "branch", name: "feature-a" },
      { kind: "branch", name: "feature-b" },
    ],
    { baseRef: "master" },
  );

  assert.equal(result.conflicts.length, 0, JSON.stringify(result.steps.map((step) => step.conflictFiles)));
  assert.equal(result.merged, 2);
  assert.equal(git(cwd, ["show", `${result.steps[1].commit}:shared.txt`]), "from b");
});

test("does not touch branches or the working tree", () => {
  const cwd = makeRepo();
  commitOn(cwd, "feature-a", { "a.txt": "a\n" }, "add a");
  const before = git(cwd, ["rev-parse", "master"]);
  const statusBefore = git(cwd, ["status", "--porcelain"]);

  simulateMergeTrain(cwd, [{ kind: "branch", name: "feature-a" }], { baseRef: "master" });

  assert.equal(git(cwd, ["rev-parse", "master"]), before);
  assert.equal(git(cwd, ["status", "--porcelain"]), statusBefore);
  assert.equal(git(cwd, ["branch", "--list", "feature-a"]), "feature-a");
});
