#!/usr/bin/env node

/**
 * Sequential merge simulation for a stacked pull-request train.
 *
 * "Mergeable" on GitHub only means a PR merges cleanly against the base branch
 * today. A train of PRs that each expect the previous one still has to prove
 * that merging them in order produces no conflicts. This script performs those
 * merges without touching a branch or the working tree:
 *
 *   1. read the order from a fenced ```merge-train block in the plan document
 *      (or from --order),
 *   2. resolve `#123` entries to a PR head branch with `gh`, or accept plain
 *      branch names,
 *   3. merge each branch into the running result with
 *      `git merge-tree --write-tree`,
 *   4. record the merged tree as a dangling commit (`git commit-tree`) so the
 *      next merge sees the previous result,
 *   5. stop at the first conflict and print the conflicted paths.
 *
 * No ref moves, nothing is pushed, and the checkout is not modified. The only
 * side effect is unreachable commit objects, which Git prunes on its own. The
 * script never fetches; run `git fetch origin --prune` first when a branch is
 * missing.
 *
 * Usage:
 *   node scripts/merge-train-simulate.mjs
 *   node scripts/merge-train-simulate.mjs --plan docs/plans/2026-11-22-merge-train.md
 *   node scripts/merge-train-simulate.mjs --order 158,162
 *   node scripts/merge-train-simulate.mjs --section standalone
 *   node scripts/merge-train-simulate.mjs --branch origin/fix/a,origin/fix/b --base origin/master
 *   node scripts/merge-train-simulate.mjs --json
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PLAN = "docs/plans/2026-11-22-merge-train.md";
const DEFAULT_SECTION = "merge-train";
const DEFAULT_REPO = "increase-roas/paperclip-live";
const SIM_IDENTITY = {
  GIT_AUTHOR_NAME: "merge-train-simulate",
  GIT_AUTHOR_EMAIL: "merge-train-simulate@example.invalid",
  GIT_COMMITTER_NAME: "merge-train-simulate",
  GIT_COMMITTER_EMAIL: "merge-train-simulate@example.invalid",
};

/** Extract the entries of a fenced block tagged `tag` from Markdown. */
export function parseMergeTrainOrder(markdown, tag = DEFAULT_SECTION) {
  const fence = new RegExp("^```" + tag + "[ \\t]*\\r?\\n([\\s\\S]*?)^```[ \\t]*$", "m");
  const match = markdown.match(fence);
  if (!match) return [];
  return match[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//"))
    .map((line) => {
      if (/^#\d+$/.test(line)) return { kind: "pr", number: Number(line.slice(1)) };
      if (/^\d+$/.test(line)) return { kind: "pr", number: Number(line) };
      if (/^[\w./#-]+$/.test(line)) return { kind: "branch", name: line };
      throw new Error(`Unrecognized merge-train entry: ${line}`);
    });
}

function git(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return { status: result.status, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() };
}

function revParse(cwd, ref) {
  const result = git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFailure: true });
  return result.status === 0 ? result.stdout : null;
}

function ghPr(cwd, repo, number) {
  const result = spawnSync(
    "gh",
    ["pr", "view", String(number), "--repo", repo, "--json", "headRefName,state,isDraft,mergeable,title"],
    { cwd, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`gh pr view ${number} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return JSON.parse(result.stdout);
}

/** Resolve one entry to { label, ref, commit, meta }. */
export function resolveEntry(cwd, entry, { repo = DEFAULT_REPO } = {}) {
  if (entry.kind === "pr") {
    const pr = ghPr(cwd, repo, entry.number);
    const ref = revParse(cwd, `origin/${pr.headRefName}`) ? `origin/${pr.headRefName}` : pr.headRefName;
    const commit = revParse(cwd, ref);
    if (!commit) {
      throw new Error(
        `PR #${entry.number} branch ${pr.headRefName} is not available locally. Run "git fetch origin --prune" first.`,
      );
    }
    return {
      label: `#${entry.number}`,
      ref,
      commit,
      meta: { number: entry.number, branch: pr.headRefName, state: pr.state, draft: pr.isDraft, mergeable: pr.mergeable, title: pr.title },
    };
  }
  const candidates = [entry.name, `origin/${entry.name}`];
  for (const candidate of candidates) {
    const commit = revParse(cwd, candidate);
    if (commit) return { label: entry.name, ref: candidate, commit, meta: { branch: entry.name } };
  }
  throw new Error(`Branch ${entry.name} is not available locally. Run "git fetch origin --prune" first.`);
}

function commitTree(cwd, tree, parents, message) {
  const args = ["commit-tree", tree];
  for (const parent of parents) args.push("-p", parent);
  args.push("-m", message);
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...SIM_IDENTITY },
  });
  if (result.status !== 0) throw new Error(`git commit-tree failed: ${(result.stderr || "").trim()}`);
  return result.stdout.trim();
}

/**
 * Merge `entries` one after another onto `baseRef`.
 *
 * Returns { base, baseCommit, steps, conflicts, merged, total }. Each step is
 * { index, label, ref, commit, ok, tree?, conflictFiles?, error? }.
 */
export function simulateMergeTrain(cwd, entries, { baseRef = "origin/master", keepGoing = false, repo = DEFAULT_REPO } = {}) {
  const baseCommit = revParse(cwd, baseRef);
  if (!baseCommit) throw new Error(`Base ${baseRef} is not available locally.`);

  const steps = [];
  let cursor = baseCommit;
  let stopped = false;

  entries.forEach((entry, index) => {
    const resolved = resolveEntry(cwd, entry, { repo });
    const stepBase = { index: index + 1, label: resolved.label, ref: resolved.ref, commit: resolved.commit, meta: resolved.meta };
    if (stopped && !keepGoing) {
      steps.push({ ...stepBase, ok: null, skipped: true });
      return;
    }
    const merge = spawnSync("git", ["merge-tree", "--write-tree", "--name-only", "--no-messages", cursor, resolved.commit], {
      cwd,
      encoding: "utf8",
    });
    if (merge.error) throw merge.error;
    const lines = (merge.stdout ?? "").split(/\r?\n/).filter((line) => line.trim().length > 0);
    const tree = lines[0] ?? "";
    if (merge.status !== 0) {
      const conflictFiles = lines.slice(1).filter((line) => !line.startsWith("CONFLICT") && !line.startsWith("Auto-merging"));
      steps.push({ ...stepBase, ok: false, conflictFiles });
      stopped = true;
      return;
    }
    // Record a real merge commit (both parents) so the next merge sees the
    // merged PR as an ancestor. Without the second parent a stacked PR would
    // re-apply its parent's diff and report false conflicts.
    cursor = commitTree(cwd, tree, [cursor, resolved.commit], `sim: merge ${resolved.label}`);
    steps.push({ ...stepBase, ok: true, tree });
  });

  const conflicts = steps.filter((step) => step.ok === false);
  const merged = steps.filter((step) => step.ok === true);
  return { baseRef, baseCommit, steps, conflicts, merged: merged.length, total: entries.length };
}

function parseArgs(argv) {
  const options = {
    cwd: process.cwd(),
    base: "origin/master",
    plan: null,
    section: DEFAULT_SECTION,
    order: null,
    branches: null,
    repo: DEFAULT_REPO,
    json: false,
    keepGoing: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      index += 1;
      return value;
    };
    switch (arg) {
      case "--base": options.base = next(); break;
      case "--plan": options.plan = next(); break;
      case "--section": options.section = next(); break;
      case "--order": options.order = next(); break;
      case "--branch": options.branches = next(); break;
      case "--repo": options.repo = next(); break;
      case "--cwd": options.cwd = next(); break;
      case "--json": options.json = true; break;
      case "--keep-going": options.keepGoing = true; break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function readEntries(options) {
  if (options.branches) {
    return options.branches
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => ({ kind: "branch", name }));
  }
  if (options.order) {
    return options.order
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => ({ kind: "pr", number: Number(value.replace(/^#/, "")) }));
  }
  const planPath = path.resolve(options.cwd, options.plan ?? DEFAULT_PLAN);
  if (!existsSync(planPath)) {
    throw new Error(`Plan document not found: ${planPath}. Pass --plan or --order.`);
  }
  const entries = parseMergeTrainOrder(readFileSync(planPath, "utf8"), options.section);
  if (entries.length === 0) {
    throw new Error(`No \`\`\`${options.section} block found in ${planPath}.`);
  }
  return entries;
}

function printReport(result, options) {
  const head = result.steps[0];
  const planLine = options.plan ?? (options.order || options.branches ? "(inline)" : DEFAULT_PLAN);
  console.log(`Merge train simulation — base ${result.baseRef} @ ${result.baseCommit.slice(0, 10)}`);
  console.log(`Plan: ${planLine} (${result.total} entries)\n`);
  console.log("  #  PR       Result    Branch");
  for (const step of result.steps) {
    const resultLabel = step.ok === true ? "merged" : step.ok === false ? "CONFLICT" : "skipped";
    const branch = step.meta?.branch ?? step.ref;
    console.log(`  ${String(step.index).padStart(2)}  ${step.label.padEnd(7)}  ${resultLabel.padEnd(8)}  ${branch}`);
    if (step.ok === false) {
      for (const file of step.conflictFiles) console.log(`        conflict: ${file}`);
    }
  }
  console.log("");
  if (result.conflicts.length === 0) {
    console.log(`Merged ${result.merged} of ${result.total}. No conflicts.`);
  } else {
    const first = result.conflicts[0];
    console.log(`Merged ${result.merged} of ${result.total}. First conflict at #${first.index} ${first.label} (${first.ref}).`);
    console.log("Fix that PR or its order, then rerun. No refs were moved.");
  }
  if (head?.meta?.draft !== undefined) {
    const drafts = result.steps.filter((step) => step.meta?.draft);
    if (drafts.length > 0) console.log(`Note: ${drafts.length} draft PR(s) in this order: ${drafts.map((d) => d.label).join(", ")}.`);
  }
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log("Usage: node scripts/merge-train-simulate.mjs [--base ref] [--plan file] [--section tag] [--order 1,2] [--branch a,b] [--json] [--keep-going]");
      return 0;
    }
    const entries = readEntries(options);
    const result = simulateMergeTrain(options.cwd, entries, {
      baseRef: options.base,
      keepGoing: options.keepGoing,
      repo: options.repo,
    });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printReport(result, options);
    }
    return result.conflicts.length === 0 ? 0 : 1;
  } catch (error) {
    console.error(`merge-train-simulate: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exitCode = main();
}
