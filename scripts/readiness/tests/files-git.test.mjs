import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { gitTrackedFiles, listGitFiles, repoRoot } from "../lib/files.mjs";

const DUBIOUS_OWNERSHIP = "fatal: detected dubious ownership in repository at '/repo'";

const fakeSpawn = (results) => {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const next = results[Math.min(calls.length - 1, results.length - 1)];
    return { status: 0, stdout: "", stderr: "", ...next };
  };
  return { spawn, calls };
};

test("lists this repository's files instead of reporting an empty scan", () => {
  const files = gitTrackedFiles();
  assert.ok(files.length > 1000, `expected a full file list, got ${files.length}`);
  assert.ok(files.includes(resolve(repoRoot, "package.json")));
  assert.ok(files.includes(resolve(repoRoot, "scripts/readiness/lib/files.mjs")));
});

test("fails when the directory is not a Git repository", () => {
  const directory = mkdtempSync(join(tmpdir(), "paperclip-readiness-"));
  try {
    assert.throws(() => listGitFiles(directory), /git ls-files failed/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("retries a checkout owned by another user with an explicit exception", () => {
  const { spawn, calls } = fakeSpawn([
    { status: 128, stderr: DUBIOUS_OWNERSHIP },
    { status: 0, stdout: "server/src/a.ts\0ui/src/b.tsx\0" },
  ]);

  const files = listGitFiles("/repo", { spawn });

  assert.deepEqual(files, [resolve("/repo", "server/src/a.ts"), resolve("/repo", "ui/src/b.tsx")]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]?.args.slice(0, 2), ["-c", "safe.directory=/repo"]);
});

test("does not swallow other Git failures", () => {
  const { spawn, calls } = fakeSpawn([{ status: 128, stderr: "fatal: not a git repository" }]);

  assert.throws(() => listGitFiles("/repo", { spawn }), /not a git repository/);
  assert.equal(calls.length, 1);
});

test("treats a successful but empty file list as a failure", () => {
  const { spawn } = fakeSpawn([{ status: 0, stdout: "" }]);

  assert.throws(() => listGitFiles("/repo", { spawn }), /returned no files/);
});
