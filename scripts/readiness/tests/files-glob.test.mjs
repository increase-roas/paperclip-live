import assert from "node:assert/strict";
import test from "node:test";

import { matchesGlob } from "../lib/files.mjs";

test("matches a double-star prefix at any depth", () => {
  assert.equal(matchesGlob("server/src/x.test.ts", "**/*.test.ts"), true);
  assert.equal(matchesGlob("x.test.ts", "**/*.test.ts"), true);
  assert.equal(matchesGlob("ui/src/x.test.ts", "**/*.test.ts"), true);
  assert.equal(matchesGlob("ui/src/x.tsx", "**/*.test.ts"), false);
});

test("matches a trailing double star under a directory", () => {
  assert.equal(matchesGlob("ui/src/pages/IssueDetail.tsx", "ui/**"), true);
  assert.equal(matchesGlob("server/src/index.ts", "ui/**"), false);
});

test("expands single-star segments without crossing directories", () => {
  assert.equal(matchesGlob("packages/shared/src/a.ts", "packages/*/src/**"), true);
  assert.equal(matchesGlob("packages/shared/nested/src/a.ts", "packages/*/src/**"), false);
});

test("matches negated-style nested generated directories", () => {
  assert.equal(matchesGlob("server/src/generated/client.ts", "**/generated/**"), true);
  assert.equal(matchesGlob("server/src/generatedness/client.ts", "**/generated/**"), false);
});

test("matches a plain file name at the repository root", () => {
  assert.equal(matchesGlob("pnpm-lock.yaml", "pnpm-lock.yaml"), true);
  assert.equal(matchesGlob("docs/pnpm-lock.yaml", "pnpm-lock.yaml"), true);
});
