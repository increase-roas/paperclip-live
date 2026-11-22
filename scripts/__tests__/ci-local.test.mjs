import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = path.join(repoRoot, "scripts", "ci-local.sh");
const matrix = JSON.parse(readFileSync(path.join(repoRoot, ".github", "ci-task-matrix.json"), "utf8"));

function run(args) {
  return spawnSync("bash", [script, ...args], { cwd: repoRoot, encoding: "utf8" });
}

function plan(args) {
  const result = run([...args, "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("local CI plan covers the workflow's build, typecheck, lint, and gate jobs", () => {
  const steps = plan([]).steps;
  const names = steps.map((step) => step.name);
  for (const name of ["build", "typecheck", "lint", "tokens"]) {
    assert.ok(names.includes(name), `missing ${name}`);
  }
  assert.match(steps.find((step) => step.name === "build").command, /pnpm build/);
  assert.match(steps.find((step) => step.name === "typecheck").command, /typecheck:build-gaps/);
  assert.match(steps.find((step) => step.name === "lint").command, /pnpm lint/);
  assert.match(steps.find((step) => step.name === "tokens").command, /check:token-gates/);
});

test("local CI plan mirrors the general test matrix, shard for shard", () => {
  const steps = plan([]).steps.filter((step) => step.category === "general");
  assert.equal(steps.length, matrix.general_tests.length);
  for (const entry of matrix.general_tests) {
    const label = entry.group_label.split(" ")[0];
    const name = entry.shard_count
      ? `${label}-${entry.shard_index + 1}-of-${entry.shard_count}`
      : label;
    const step = steps.find((candidate) => candidate.name === name);
    assert.ok(step, `missing general step ${name}`);
    assert.match(step.command, /run-vitest-stable\.mjs --mode general/);
    assert.ok(
      step.command.includes(`--group ${entry.group}`),
      `${name} does not run group ${entry.group}`,
    );
    if (entry.shard_count) {
      assert.ok(
        step.command.includes(`--shard-index ${entry.shard_index}`) &&
          step.command.includes(`--shard-count ${entry.shard_count}`),
        `${name} does not carry its shard coordinates`,
      );
    }
  }
});

test("local CI plan mirrors the serialized server matrix, shard for shard", () => {
  const steps = plan([]).steps.filter((step) => step.category === "serialized");
  assert.equal(steps.length, matrix.verify_serialized_server.length);
  for (const entry of matrix.verify_serialized_server) {
    const name = `serialized-${entry.shard_index + 1}-of-${entry.shard_count}`;
    const step = steps.find((candidate) => candidate.name === name);
    assert.ok(step, `missing serialized step ${name}`);
    assert.match(step.command, /run-vitest-stable\.mjs --mode serialized/);
    assert.ok(step.command.includes(`--shard-index ${entry.shard_index}`));
    assert.ok(step.command.includes(`--shard-count ${entry.shard_count}`));
  }
});

test("--only and --skip narrow the plan by category or step name", () => {
  assert.deepEqual(plan(["--only", "lint,tokens"]).steps.map((step) => step.name), ["lint", "tokens"]);
  assert.deepEqual(plan(["--only", "server-3-of-12"]).steps.map((step) => step.name), ["server-3-of-12"]);
  const withoutBuild = plan(["--skip", "build"]).steps.map((step) => step.name);
  assert.ok(!withoutBuild.includes("build"));
  assert.ok(withoutBuild.includes("typecheck"));
  assert.ok(withoutBuild.includes("server-1-of-12"));
});

test("rejects an unknown argument and a bad concurrency", () => {
  assert.equal(run(["--wat"]).status, 2);
  assert.equal(run(["--concurrency", "0", "--only", "lint"]).status, 2);
});
