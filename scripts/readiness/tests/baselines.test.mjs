import assert from "node:assert/strict";
import test from "node:test";

import { splitByBaseline } from "../lib/baselines.mjs";

const keyOf = (finding) => finding.key;

test("separates new findings from acknowledged baseline entries", () => {
  const baseline = { version: 1, entries: [{ key: "a" }, { key: "b" }] };
  const result = splitByBaseline([{ key: "a" }, { key: "c" }], baseline, keyOf);
  assert.deepEqual(result.newFindings, [{ key: "c" }]);
  assert.deepEqual(result.knownFindings, [{ key: "a" }]);
  assert.deepEqual(result.staleEntries, [{ key: "b" }]);
});

test("treats a changed key as new so growth still fails", () => {
  const baseline = { version: 1, entries: [{ key: "file.ts#lines:1" }] };
  const result = splitByBaseline([{ key: "file.ts#lines:2" }], baseline, keyOf);
  assert.equal(result.newFindings.length, 1);
  assert.equal(result.knownFindings.length, 0);
});

test("an empty baseline reports every finding", () => {
  const result = splitByBaseline([{ key: "x" }], { version: 1, entries: [] }, keyOf);
  assert.equal(result.newFindings.length, 1);
  assert.equal(result.knownFindings.length, 0);
  assert.equal(result.staleEntries.length, 0);
});
