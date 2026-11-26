// Run: node --test scripts/ir/ir-metric-guard.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkRepo, checkSource } from "./ir-metric-guard.mjs";

const rules = (source) => checkSource("server/src/ir/x.ts", source).map((f) => f.rule);

test("flags inline metric formulas", () => {
  assert.deepEqual(rules("const showRate = round1((m.showed / m.booked) * 100);"), ["inline-metric-formula"]);
  assert.deepEqual(rules("const cpl = leads > 0 ? round2(roundedSpend / leads) : null;"), ["inline-metric-formula"]);
  assert.deepEqual(rules("ctr: round2((linkClicks / impressions) * 100),"), ["inline-metric-formula"]);
  assert.deepEqual(rules("round2(portfolio.totalAdSpend / portfolio.totalWon)"), ["inline-metric-formula"]);
  assert.deepEqual(rules("round1((entry.wonDeals / entry.pitched) * 100)"), ["inline-metric-formula"]);
});

test("allows library calls, comments and non-metric math", () => {
  assert.deepEqual(rules("const r = showRate({ booked, showed });"), []);
  assert.deepEqual(rules("// show rate = showed / booked"), []);
  assert.deepEqual(rules("const hours = (now - createdAt) / HOUR_MS;"), []);
  assert.deepEqual(rules("round2(cashCollectedUsd / cashMultipleDenominator)"), []);
  assert.deepEqual(rules('const url = "https://dashboard.increaseai.tech/api/pilot/neon-ads";'), []);
});

test("flags hardcoded Meta and GHL account IDs", () => {
  assert.deepEqual(rules('defaultAccountId: "act_1751702711685898",'), ["hardcoded-account-id"]);
  assert.deepEqual(rules('const LOC = "Sr90yJUmFoBTgBQuejtU";'), ["hardcoded-account-id"]);
  assert.deepEqual(rules('fetch(`/locations/AG47jEV5rVUrGLt5FlKO/`)'), ["hardcoded-account-id"]);
  assert.deepEqual(rules('const id = "931652032962948";'), ["hardcoded-account-id"]);
  assert.deepEqual(rules('const label = "ghl_payment_scope_or_access";'), []);
});

test("flags a static client count", () => {
  assert.deepEqual(rules("<span>Active Clients: 3</span>"), ["static-client-count"]);
  assert.deepEqual(rules("<span>Active {lifecycle.active}</span>"), []);
});

test("scans only ui/src/ir and server/src/ir and skips tests", () => {
  const root = mkdtempSync(join(tmpdir(), "ir-metrics-"));
  try {
    for (const dir of ["server/src/ir/__tests__", "ui/src/ir/pages", "server/src/services"]) mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, "server/src/ir/__tests__/a.test.ts"), 'const id = "act_1751702711685898";\n');
    writeFileSync(join(root, "server/src/services/b.ts"), "const r = showed / booked;\n");
    writeFileSync(join(root, "ui/src/ir/pages/C.tsx"), "const r = (clicks / impressions) * 100;\n");
    const findings = checkRepo(root);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].path, "ui/src/ir/pages/C.tsx");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
