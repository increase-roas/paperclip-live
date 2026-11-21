import assert from "node:assert/strict";
import test from "node:test";

import {
  buildIssueBody,
  buildIssueTitle,
  parseMarkers,
  selectNewIssues,
  sentryMarker,
  syncSentryIssues,
} from "../sentry-to-issues.mjs";

const issue = {
  id: "4509",
  shortId: "PAPERCLIP-1A",
  title: "TypeError: cannot read properties of undefined",
  culprit: "server/src/services/example.ts in run",
  count: "42",
  userCount: 3,
  firstSeen: "2026-11-01T00:00:00Z",
  lastSeen: "2026-11-21T00:00:00Z",
  environment: "production",
  release: "v2026.1117.0",
  permalink: "https://sentry.io/organizations/example/issues/4509/",
};

test("builds a deduplicable issue body with the Sentry marker and link", () => {
  const body = buildIssueBody(issue);
  assert.match(body, /<!-- paperclip-sentry-issue:4509 -->/);
  assert.match(body, /PAPERCLIP-1A/);
  assert.match(body, /https:\/\/sentry\.io\/organizations\/example\/issues\/4509\//);
  assert.doesNotMatch(body, /undefined/);
});

test("parses markers from existing issue bodies", () => {
  const keys = parseMarkers([
    `before\n${sentryMarker("4509")}\nafter`,
    sentryMarker("9999"),
    "no marker",
  ]);
  assert.deepEqual([...keys].sort(), ["4509", "9999"]);
});

test("selects only issues that are not tracked yet", () => {
  const fresh = selectNewIssues([issue, { ...issue, id: "2", shortId: "PAPERCLIP-2" }], new Set(["4509"]));
  assert.deepEqual(fresh.map((entry) => entry.id), ["2"]);
});

test("truncates a long title", () => {
  const title = buildIssueTitle({ ...issue, title: "x".repeat(300) });
  assert.ok(title.length <= 120);
  assert.match(title, /^\[Sentry\] PAPERCLIP-1A:/);
});

test("dry run lists fresh issues and creates nothing", async () => {
  const logs = [];
  const result = await syncSentryIssues({
    sentry: { org: "example", project: "paperclip", token: "secret", query: "is:unresolved", limit: 10 },
    github: { repo: "example/paperclip" },
    fetchImpl: async () => new Response(JSON.stringify([issue]), { status: 200 }),
    runGhImpl: async (args) => {
      if (args[0] === "issue" && args[1] === "list") return JSON.stringify([{ number: 1, body: "no marker" }]);
      return "";
    },
    log: (message) => logs.push(message),
  });
  assert.equal(result.fetched, 1);
  assert.equal(result.fresh, 1);
  assert.equal(result.created.length, 0);
  assert.match(logs[0], /would create: \[Sentry\] PAPERCLIP-1A/);
});
