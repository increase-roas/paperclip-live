import assert from "node:assert/strict";
import test from "node:test";

import { splitByBaseline } from "../lib/baselines.mjs";
import {
  classifyLargeFileFindings,
  largeFileKey,
} from "../../check-large-files.mjs";

const SUITE = "server/src/__tests__/chat-channels.integration.test.ts";

function finding(file, lines, bytes) {
  const analysis = { lines, bytes };
  return { file, key: largeFileKey(file, analysis), analysis };
}

function baselineFor(file, lines, bytes) {
  return [{ key: largeFileKey(file, { lines, bytes }), file }];
}

test("a baselined file that shrinks is acknowledged debt, not a new finding", () => {
  // The real pair: 85,395 lines before the fixture extraction, 84,567 after.
  // Both stay above the limit, but the file got smaller.
  const before = finding(SUITE, 85_395, 3_617_000);
  const after = finding(SUITE, 84_567, 3_585_492);

  // The previous comparison was key equality, so shrinking reported a
  // brand-new finding for work that reduces the problem.
  const oldWay = splitByBaseline([after], { version: 1, entries: [{ key: before.key }] }, (item) => item.key);
  assert.equal(oldWay.newFindings.length, 1);

  const result = classifyLargeFileFindings([after], [{ key: before.key, file: SUITE }]);
  assert.deepEqual(result.newFindings, []);
  assert.deepEqual(result.knownFindings, [after]);
  assert.deepEqual(result.staleEntries, []);
});

test("the same measurement is acknowledged", () => {
  const current = finding("big.ts", 5_200, 900_000);
  const result = classifyLargeFileFindings(
    [current],
    baselineFor("big.ts", 5_200, 900_000),
  );
  assert.deepEqual(result.newFindings, []);
  assert.deepEqual(result.knownFindings, [current]);
});

test("growth past the recorded bucket is a new finding", () => {
  const baseline = baselineFor("big.ts", 5_100, 800_000);
  const grown = finding("big.ts", 5_700, 830_000);
  const result = classifyLargeFileFindings([grown], baseline);
  assert.deepEqual(result.knownFindings, []);
  assert.deepEqual(result.newFindings, [grown]);
});

test("growth in bytes alone is a new finding", () => {
  const baseline = baselineFor("big.ts", 5_100, 760_000);
  const grown = finding("big.ts", 5_100, 1_020_000);
  const result = classifyLargeFileFindings([grown], baseline);
  assert.deepEqual(result.newFindings, [grown]);
  assert.deepEqual(result.knownFindings, []);
});

test("a file with no baseline entry is new", () => {
  const unknown = finding("new.ts", 9_000, 2_000_000);
  const result = classifyLargeFileFindings([unknown], []);
  assert.deepEqual(result.newFindings, [unknown]);
  assert.deepEqual(result.knownFindings, []);
});

test("an entry whose file is no longer oversized is stale", () => {
  const result = classifyLargeFileFindings(
    [],
    baselineFor("shrunk.ts", 8_000, 1_500_000),
  );
  assert.deepEqual(result.newFindings, []);
  assert.equal(result.staleEntries.length, 1);
});

test("an entry with an unreadable key is stale instead of crashing", () => {
  const result = classifyLargeFileFindings([], [{ key: "legacy-entry", file: "x.ts" }]);
  assert.equal(result.staleEntries.length, 1);
});

test("a different file in the same buckets is not acknowledged", () => {
  const result = classifyLargeFileFindings(
    [finding("other.ts", 5_100, 760_000)],
    baselineFor("big.ts", 5_100, 760_000),
  );
  assert.equal(result.newFindings.length, 1);
  assert.equal(result.knownFindings.length, 0);
});
