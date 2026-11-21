#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { parseArgs, printTitle } from "./readiness/lib/report.mjs";

/**
 * Label untriaged GitHub issues so automated backlog queries can filter them.
 *
 * The default is a dry run. `--apply` adds a type label (bug, enhancement,
 * documentation, or needs-triage) and an area label inferred from the title.
 * It never changes a title, body, assignee, milestone, or state, and it skips
 * any issue that already has a label.
 *
 * Usage:
 *   pnpm issues:triage
 *   pnpm issues:triage -- --apply
 *   pnpm issues:triage -- --apply --limit 100 --delay-ms 150
 */

const execFileAsync = promisify(execFile);
const LABELS = [
  { name: "needs-triage", color: "ededed", description: "Not yet classified for type or area" },
  { name: "bug", color: "d73a4a", description: "Something is not working" },
  { name: "enhancement", color: "a2eeef", description: "New feature or request" },
  { name: "documentation", color: "0075ca", description: "Documentation only" },
  { name: "area:server", color: "1d76db", description: "API and orchestration server" },
  { name: "area:ui", color: "5319e7", description: "Board UI" },
  { name: "area:cli", color: "0e8a16", description: "paperclipai CLI" },
  { name: "area:runner", color: "d4c5f9", description: "Native Runner and provider adapters" },
  { name: "area:connectors", color: "bfd4f2", description: "Apps, connections, and MCP surfaces" },
  { name: "area:skills", color: "fef2c0", description: "Skills catalog and runtime skills" },
  { name: "area:release", color: "1D76DB", description: "Release, packaging, and publishing" },
];

const BUG_WORDS = [
  /\bfix(?:\(|:|\s)/i, /\bbug\b/i, /\bcrash/i, /\berror\b/i, /\bfail/i, /\bbroken\b/i,
  /\bregression\b/i, /\btypeerror\b/i, /\bundefined\b/i, /\bcannot\b/i, /\bcan't\b/i,
  /\bwrong\b/i, /\bmissing\b/i, /\bstuck\b/i, /\btimeout\b/i, /\bpanic\b/i, /\bexception\b/i,
  /\bdoes not\b/i, /\bdoesn't\b/i, /\bpremature\b/i, /\bunexpected/i, /\b500\b/, /\b400\b/,
];
const FEATURE_WORDS = [
  /\bfeat(?:\(|:|\s)/i, /\bfeature\b/i, /\bproposal\b/i, /\badd\b/i, /\bsupport\b/i,
  /\bexpose\b/i, /\ballow\b/i, /\bintroduce\b/i, /\bimprov/i, /\brequest\b/i, /\bwould like\b/i,
];
const DOC_WORDS = [/\bdocs?(?:\(|:|\s)/i, /\bdocumentation\b/i, /\breadme\b/i, /\btypo\b/i];

const AREA_RULES = [
  { area: "area:ui", words: [/\bui\b/i, /\bboard\b/i, /\bdashboard\b/i, /\bsidebar\b/i, /\bdesign\b/i, /\bcss\b/i, /\bbutton\b/i, /\bmodal\b/i, /\bdark mode\b/i] },
  { area: "area:cli", words: [/\bcli\b/i, /\bpaperclipai\b/i, /\bonboard/i, /\binstall/i] },
  { area: "area:runner", words: [/\brunner\b/i, /\bcodex\b/i, /\bclaude\b/i, /\bacpx\b/i, /\bprovider\b/i, /\bharness\b/i, /\bcursor\b/i, /\bopencode\b/i, /\bpi\b/i] },
  { area: "area:connectors", words: [/\bconnector\b/i, /\bslack\b/i, /\bgithub\b/i, /\bdiscord\b/i, /\bmcp\b/i, /\bintegration\b/i, /\bcomposio\b/i] },
  { area: "area:skills", words: [/\bskill/i, /\bcatalog\b/i] },
  { area: "area:release", words: [/\brelease\b/i, /\bversion\b/i, /\bpublish\b/i, /\bnpm\b/i, /\bdocker\b/i, /\bchangelog\b/i] },
];

export function inferLabels(issue) {
  const title = String(issue.title ?? "");
  if (DOC_WORDS.some((pattern) => pattern.test(title))) return ["documentation", inferArea(title)];
  if (BUG_WORDS.some((pattern) => pattern.test(title))) return ["bug", inferArea(title)];
  if (FEATURE_WORDS.some((pattern) => pattern.test(title))) return ["enhancement", inferArea(title)];
  return ["needs-triage", inferArea(title)];
}

export function inferArea(title) {
  for (const rule of AREA_RULES) {
    if (rule.words.some((pattern) => pattern.test(title))) return rule.area;
  }
  return "area:server";
}

async function gh(args, { execImpl = execFileAsync } = {}) {
  const result = await execImpl("gh", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  return String(result.stdout ?? "").trim();
}

async function ensureLabels(repo, ghImpl) {
  for (const label of LABELS) {
    try {
      await ghImpl(["label", "create", label.name, "--repo", repo, "--color", label.color, "--description", label.description, "--force"]);
    } catch {
      // Label management needs write access; issue editing may still work.
    }
  }
}

function parseGitHubRepo(remote) {
  const match = String(remote).trim().match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  return match?.[1] ?? null;
}

async function resolveRepo(ghImpl, execImpl = execFileAsync) {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  if (process.env.GH_REPO) return process.env.GH_REPO;
  try {
    const result = await execImpl("git", ["remote", "get-url", "origin"], { encoding: "utf8" });
    const parsed = parseGitHubRepo(result.stdout);
    if (parsed) return parsed;
  } catch {
    // Fall through to gh when the checkout has no origin remote.
  }
  return ghImpl(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
}

export async function triageIssues({
  repo,
  limit = 200,
  apply = false,
  delayMs = 150,
  ghImpl = (args) => gh(args),
  log = (message) => process.stdout.write(`${message}\n`),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  await ensureLabels(repo, ghImpl);
  const raw = await ghImpl([
    "issue", "list", "--repo", repo, "--state", "open", "--limit", String(limit),
    "--json", "number,title,labels",
  ]);
  const issues = JSON.parse(raw || "[]");
  const untriaged = issues.filter((issue) => (issue.labels ?? []).length === 0);
  const planned = [];

  for (const issue of untriaged) {
    const labels = inferLabels(issue);
    planned.push({ number: issue.number, title: issue.title, labels });
    if (!apply) {
      log(`would label #${issue.number} ${labels.join(",")}: ${issue.title}`);
      continue;
    }
    try {
      await ghImpl(["issue", "edit", String(issue.number), "--repo", repo, ...labels.flatMap((label) => ["--add-label", label])]);
      log(`labeled #${issue.number} ${labels.join(",")}`);
    } catch (error) {
      log(`failed #${issue.number}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (delayMs > 0) await sleep(delayMs);
  }

  return { total: issues.length, untriaged: untriaged.length, planned, applied: apply };
}

async function main() {
  const args = parseArgs();
  const repo = await resolveRepo((cliArgs) => gh(cliArgs));
  const result = await triageIssues({
    repo,
    limit: Number(args.values.get("limit") ?? 200),
    apply: args.flags.has("apply"),
    delayMs: Number(args.values.get("delay-ms") ?? 150),
  });
  printTitle("Issue triage");
  process.stdout.write(`  repository: ${repo}\n`);
  process.stdout.write(`  open issues read: ${result.total}\n`);
  process.stdout.write(`  untriaged: ${result.untriaged}\n`);
  process.stdout.write(`  ${result.applied ? "applied" : "planned"}: ${result.planned.length}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
