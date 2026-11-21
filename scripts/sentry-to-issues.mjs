#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { parseArgs, printTitle } from "./readiness/lib/report.mjs";

/**
 * Turn unresolved Sentry issues into tracked GitHub issues.
 *
 * This closes the error-to-insight loop without a CI dependency: run it from a
 * timer, a workstation, or an incident review. It is idempotent through a
 * hidden marker in the GitHub issue body. The default is a dry run; pass
 * `--apply` to create issues.
 *
 * Required environment:
 *   SENTRY_ORG, SENTRY_PROJECT, SENTRY_AUTH_TOKEN
 *   GITHUB_TOKEN (or any environment where `gh` is authenticated)
 *
 * Usage:
 *   pnpm sentry:issues
 *   pnpm sentry:issues -- --apply
 *   pnpm sentry:issues -- --limit 10 --query "is:unresolved level:error"
 */

const execFileAsync = promisify(execFile);
const SENTRY_API = "https://sentry.io/api/0";
const MARKER_PREFIX = "paperclip-sentry-issue:";
const ISSUE_LABELS = ["bug", "sentry"];

export function sentryMarker(issueId) {
  return `<!-- ${MARKER_PREFIX}${issueId} -->`;
}

export function parseMarkers(bodies) {
  const keys = new Set();
  for (const body of bodies) {
    for (const match of String(body ?? "").matchAll(new RegExp(`<!-- ${MARKER_PREFIX}([^\\s>]+) -->`, "g"))) {
      keys.add(match[1]);
    }
  }
  return keys;
}

function truncate(value, length) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

export function buildIssueBody(issue) {
  const lines = [
    sentryMarker(issue.id),
    "## Sentry issue",
    "",
    `- **Short ID:** \`${issue.shortId ?? issue.id}\``,
    `- **Culprit:** \`${truncate(issue.culprit ?? "unknown", 200)}\``,
    `- **Events:** ${issue.count ?? "unknown"}`,
    `- **Users affected:** ${issue.userCount ?? "unknown"}`,
    `- **First seen:** ${issue.firstSeen ?? "unknown"}`,
    `- **Last seen:** ${issue.lastSeen ?? "unknown"}`,
    `- **Environment:** ${issue.environment ?? "unknown"}`,
    `- **Release:** ${issue.release ?? "unknown"}`,
    "",
    `[Open the issue in Sentry](${issue.permalink ?? issue.url ?? "https://sentry.io"})`,
    "",
    "This issue was created from Sentry. Resolve it in Sentry as well so the next sync does not open it again.",
  ];
  return `${lines.join("\n")}\n`;
}

export function buildIssueTitle(issue) {
  return truncate(`[Sentry] ${issue.shortId ?? issue.id}: ${issue.title ?? "Untitled error"}`, 120);
}

export function selectNewIssues(sentryIssues, existingKeys) {
  return sentryIssues.filter((issue) => issue?.id && !existingKeys.has(String(issue.id)));
}

async function fetchSentryIssues({ org, project, token, query, limit }, fetchImpl = fetch) {
  const endpoint = new URL(`${SENTRY_API}/projects/${encodeURIComponent(org)}/${encodeURIComponent(project)}/issues/`);
  endpoint.searchParams.set("query", query);
  endpoint.searchParams.set("limit", String(limit));
  const response = await fetchImpl(endpoint, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Sentry returned ${response.status}; check SENTRY_ORG, SENTRY_PROJECT and SENTRY_AUTH_TOKEN.`);
  }
  return response.json();
}

async function runGh(args, { execImpl = execFileAsync } = {}) {
  const result = await execImpl("gh", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  return String(result.stdout ?? "");
}

async function listGithubIssues({ repo, runGhImpl }) {
  try {
    const output = await runGhImpl([
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "all",
      "--limit",
      "200",
      "--json",
      "number,body",
    ]);
    return JSON.parse(output);
  } catch {
    // A read-only token, a missing label, or an empty repository must not stop
    // a dry run. The marker scan simply finds nothing.
    return [];
  }
}

async function ensureLabels({ repo, runGhImpl }) {
  for (const label of ISSUE_LABELS) {
    try {
      await runGhImpl(["label", "create", label, "--repo", repo, "--color", label === "bug" ? "d73a4a" : "5319e7", "--force"]);
    } catch {
      // A missing permission to manage labels must not block issue creation.
    }
  }
}

async function createGithubIssue({ repo, issue, runGhImpl }) {
  const output = await runGhImpl([
    "issue",
    "create",
    "--repo",
    repo,
    "--title",
    buildIssueTitle(issue),
    "--body",
    buildIssueBody(issue),
    "--label",
    "bug",
    "--label",
    "sentry",
  ]);
  return output.trim();
}

export async function syncSentryIssues({
  sentry,
  github,
  apply = false,
  fetchImpl = fetch,
  runGhImpl = (args) => runGh(args),
  log = (message) => process.stdout.write(`${message}\n`),
}) {
  const sentryIssues = await fetchSentryIssues(sentry, fetchImpl);
  await ensureLabels({ repo: github.repo, runGhImpl });
  const existing = await listGithubIssues({ repo: github.repo, runGhImpl });
  const existingKeys = parseMarkers(existing.map((entry) => entry.body));
  const fresh = selectNewIssues(sentryIssues, existingKeys);

  const created = [];
  for (const issue of fresh) {
    if (!apply) {
      log(`would create: ${buildIssueTitle(issue)}`);
      continue;
    }
    const url = await createGithubIssue({ repo: github.repo, issue, runGhImpl });
    created.push({ id: issue.id, url });
    log(`created: ${url}`);
  }

  return { fetched: sentryIssues.length, existing: existingKeys.size, fresh: fresh.length, created };
}

function parseGitHubRepo(remote) {
  const match = String(remote).trim().match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  return match?.[1] ?? null;
}

async function resolveRepo() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  if (process.env.GH_REPO) return process.env.GH_REPO;
  try {
    const result = await execFileAsync("git", ["remote", "get-url", "origin"], { encoding: "utf8" });
    const parsed = parseGitHubRepo(result.stdout);
    if (parsed) return parsed;
  } catch {
    // Fall through to gh when the checkout has no origin remote.
  }
  const output = await runGh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  return output.trim();
}

async function main() {
  const args = parseArgs();
  const required = ["SENTRY_ORG", "SENTRY_PROJECT", "SENTRY_AUTH_TOKEN"];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    process.stderr.write(`Missing ${missing.join(", ")}. Set them in the environment, never in the repository.\n`);
    process.exitCode = 2;
    return;
  }
  const sentry = {
    org: process.env.SENTRY_ORG,
    project: process.env.SENTRY_PROJECT,
    token: process.env.SENTRY_AUTH_TOKEN,
    query: args.values.get("query") ?? "is:unresolved",
    limit: Number(args.values.get("limit") ?? 25),
  };
  const repo = await resolveRepo();
  const result = await syncSentryIssues({
    sentry,
    github: { repo },
    apply: args.flags.has("apply"),
  });
  printTitle("Sentry to GitHub issues");
  process.stdout.write(`  fetched ${result.fetched} Sentry issue(s)\n`);
  process.stdout.write(`  already tracked ${result.existing}\n`);
  process.stdout.write(`  new ${result.fresh}${args.flags.has("apply") ? `, created ${result.created.length}` : " (dry run)"}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
