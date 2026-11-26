import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const runnerManifest = new URL("../../packages/paperclip-runner/package.json", import.meta.url);
const retiredCollector = new URL("../../zzdump.mjs", import.meta.url);

test("paid live evals have no implicit pre or post scripts", () => {
  const { scripts } = JSON.parse(readFileSync(runnerManifest, "utf8"));
  for (const name of ["prereport:runner-live-evals", "postreport:runner-live-evals"]) {
    assert.equal(Object.hasOwn(scripts, name), false, `${name} must not run with provider credentials`);
  }
  assert.ok(scripts["report:runner-live-evals"].includes("run-runner-live-eval-schedule.mjs"));
});

test("the retired collector is absent or contains no executable code", () => {
  if (!existsSync(retiredCollector)) return;
  const source = readFileSync(retiredCollector, "utf8");
  const statements = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "").trim();
  // Report only the presence of code; a failing test must not print credentials.
  assert.equal(statements.length === 0, true, "The retired collector must remain inert");
});
