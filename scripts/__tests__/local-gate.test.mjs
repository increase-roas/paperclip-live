import assert from "node:assert/strict";
import test from "node:test";

import { STEPS, FULL_TEST_COMMAND, parseArguments, selectSteps, stepCommand, stepEnv } from "../check-local.mjs";
import { assetFor, PINNED_VERSION, versionAtLeast } from "../check-actionlint.mjs";

test("default gate runs every step in the documented order", () => {
  assert.deepEqual(
    selectSteps().map((step) => step.name),
    ["lint", "actionlint", "readiness", "typecheck", "tests"],
  );
  assert.deepEqual(
    STEPS.map((step) => step.name),
    ["lint", "actionlint", "readiness", "typecheck", "tests"],
  );
});

test("quick mode keeps the static checks and skips the slow suites", () => {
  assert.deepEqual(
    selectSteps({ quick: true }).map((step) => step.name),
    ["lint", "actionlint", "readiness"],
  );
});

test("only and skip select a precise subset", () => {
  assert.deepEqual(
    selectSteps({ only: ["typecheck"] }).map((step) => step.name),
    ["typecheck"],
  );
  assert.deepEqual(
    selectSteps({ skip: ["tests", "typecheck"] }).map((step) => step.name),
    ["lint", "actionlint", "readiness"],
  );
});

test("arguments parse repeatable selectors and reject unknown steps", () => {
  assert.deepEqual(parseArguments(["--quick", "--only", "lint", "--skip", "tests", "--keep-going"]), {
    only: ["lint"],
    skip: ["tests"],
    quick: true,
    keepGoing: true,
    noDownload: false,
    list: false,
    full: false,
  });
  assert.throws(() => parseArguments(["--only", "nope"]), /Unknown step "nope"/);
  assert.throws(() => parseArguments(["--skip"]), /--skip needs a step name/);
  assert.throws(() => parseArguments(["--bogus"]), /Unknown argument: --bogus/);
});

test("the default tests step is the bounded non-server unit/jsdom lane", () => {
  const tests = STEPS.find((step) => step.name === "tests");
  assert.deepEqual(tests.command.slice(-6), ["test:run", "--", "--mode", "general", "--group", "general-unit"]);
  assert.ok(tests.command.includes("test:run"));
  assert.equal(selectSteps().length, STEPS.length);
});

test("--full swaps the tests step to the complete Vitest path", () => {
  const parsed = parseArguments(["--full"]);
  assert.equal(parsed.full, true);
  const tests = STEPS.find((step) => step.name === "tests");
  assert.deepEqual(stepCommand(tests, { full: true, isRoot: false }), FULL_TEST_COMMAND);
  assert.deepEqual(stepCommand(tests, { full: false, isRoot: false }), tests.command);
  assert.notDeepEqual(FULL_TEST_COMMAND, tests.command);
});

test("the pinned actionlint release has a checksum for each supported platform", () => {
  const linux = assetFor("linux", "x64");
  assert.equal(linux.fileName, `actionlint_${PINNED_VERSION}_linux_amd64.tar.gz`);
  assert.match(linux.checksum, /^[a-f0-9]{64}$/);
  assert.equal(assetFor("darwin", "arm64").key, "darwin_arm64");
  assert.equal(assetFor("linux", "ia32"), null);
  assert.equal(assetFor("win32", "x64"), null);
});

test("actionlint versions below the pin are rejected", () => {
  assert.equal(versionAtLeast("1.7.12", PINNED_VERSION), true);
  assert.equal(versionAtLeast("v1.7.12", PINNED_VERSION), true);
  assert.equal(versionAtLeast("1.8.0", PINNED_VERSION), true);
  assert.equal(versionAtLeast("1.7.7", PINNED_VERSION), false);
  assert.equal(versionAtLeast("1.6.9", PINNED_VERSION), false);
});

test("root skips the embedded-Postgres chat shard only for the full tests step", () => {
  const tests = STEPS.find((step) => step.name === "tests");
  const lint = STEPS.find((step) => step.name === "lint");
  assert.deepEqual(stepCommand(tests, { isRoot: true, full: true }).slice(-2), ["--", "--skip-chat-integration"]);
  assert.ok(!stepCommand(tests, { isRoot: false, full: true }).includes("--skip-chat-integration"));
  assert.ok(!stepCommand(tests, { isRoot: true, full: false }).includes("--skip-chat-integration"));
  assert.ok(!stepCommand(lint, { isRoot: true }).includes("--skip-chat-integration"));
});

test("the tests step carries PR CI's one-retry contention safety net", () => {
  const tests = STEPS.find((step) => step.name === "tests");
  const lint = STEPS.find((step) => step.name === "lint");
  assert.equal(stepEnv(tests, {}).PAPERCLIP_VITEST_RETRY, "1");
  assert.equal(stepEnv(tests, { PAPERCLIP_VITEST_RETRY: "0" }).PAPERCLIP_VITEST_RETRY, "0");
  assert.equal(stepEnv(tests, { PAPERCLIP_VITEST_RETRY: "3" }).PAPERCLIP_VITEST_RETRY, "3");
  assert.equal(stepEnv(lint, {}).PAPERCLIP_VITEST_RETRY, undefined);
});
