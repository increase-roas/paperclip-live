#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * CI-independent local gate.
 *
 * Hosted Actions can be unavailable (for example while an organization Actions
 * budget is exhausted). This command produces the same PR evidence locally in
 * one pass: readiness checks, lint, actionlint, recursive typecheck, and a
 * bounded Vitest unit/jsdom lane.
 *
 * Usage:
 *   pnpm check:local
 *   pnpm check:local --full             # add server, db and integration suites
 *   pnpm check:local --quick            # readiness, lint, actionlint only
 *   pnpm check:local --skip tests
 *   pnpm check:local --only actionlint
 *   pnpm check:local --keep-going
 *   pnpm check:local --no-download      # actionlint must already be installed
 *
 * The default tests step is bounded so the gate finishes in about 15 minutes on
 * a laptop-class machine: it runs the non-server workspace projects only (ui,
 * cli, shared, adapters and plugins). `--full` runs the complete `test:run`
 * path, including the server shards, embedded-Postgres suites and chat
 * integration. Run a full gate as a non-root account when you need the
 * embedded PostgreSQL tests; root runs skip the chat integration shard.
 */

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

export const STEPS = [
  { name: "lint", command: [pnpm, "run", "lint"] },
  { name: "actionlint", command: [process.execPath, "scripts/check-actionlint.mjs"] },
  { name: "readiness", command: [process.execPath, "scripts/run-readiness-checks.mjs"] },
  { name: "typecheck", command: [pnpm, "run", "typecheck"] },
  {
    name: "tests",
    // The bounded lane is the non-server workspace projects. It needs no
    // embedded PostgreSQL and stays well inside a single local command budget.
    command: [pnpm, "run", "test:run", "--", "--mode", "general", "--group", "general-unit"],
  },
];

export const FULL_TEST_COMMAND = [pnpm, "run", "test:run"];

export function selectSteps({ only = [], skip = [], quick = false } = {}) {
  const skipped = new Set(skip);
  if (quick) {
    skipped.add("typecheck");
    skipped.add("tests");
  }
  const wanted = new Set(only);
  return STEPS.filter((step) => {
    if (wanted.size > 0 && !wanted.has(step.name)) return false;
    return !skipped.has(step.name);
  });
}

export function parseArguments(argv) {
  const options = { only: [], skip: [], quick: false, keepGoing: false, noDownload: false, list: false, full: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    switch (argument) {
      case "--only":
        if (!value) throw new Error("--only needs a step name");
        options.only.push(value);
        index += 1;
        break;
      case "--skip":
        if (!value) throw new Error("--skip needs a step name");
        options.skip.push(value);
        index += 1;
        break;
      case "--quick":
        options.quick = true;
        break;
      case "--full":
        options.full = true;
        break;
      case "--keep-going":
        options.keepGoing = true;
        break;
      case "--no-download":
        options.noDownload = true;
        break;
      case "--list":
        options.list = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }
  const known = new Set(STEPS.map((step) => step.name));
  for (const name of [...options.only, ...options.skip]) {
    if (!known.has(name)) {
      throw new Error(`Unknown step "${name}". Steps: ${[...known].join(", ")}`);
    }
  }
  return options;
}

function usage() {
  return [
    "Usage: pnpm check:local [options]",
    "",
    "Runs the CI-independent PR gate: lint, actionlint, readiness, typecheck and a",
    "bounded unit/jsdom test lane (or the full Vitest suite with --full).",
    "",
    "Options:",
    "  --only <step>      Run one step (repeatable).",
    "  --skip <step>      Skip one step (repeatable).",
    "  --quick            Skip typecheck and tests.",
    "  --full             Run the full Vitest suite instead of the bounded lane.",
    "  --keep-going       Run every selected step even after a failure.",
    "  --no-download      Do not download actionlint.",
    "  --list             Print the steps and exit.",
    "  --help             Print this help.",
    "",
    "The bounded tests step runs the non-server workspace projects only. Use",
    "--full for server shards, embedded-Postgres suites and chat integration.",
    "",
    `Steps: ${STEPS.map((step) => step.name).join(", ")}`,
  ].join("\n");
}

function seconds(startedAt) {
  return `${(Number(process.hrtime.bigint() - startedAt) / 1e9).toFixed(1)}s`;
}

export function stepCommand(step, { noDownload = false, isRoot = isRootUser(), full = false } = {}) {
  const command = step.name === "tests" && full
    ? [...FULL_TEST_COMMAND]
    : [...step.command];
  if (step.name === "actionlint" && noDownload) command.push("--no-download");
  // The embedded-Postgres chat shard cannot start as root. The runner can
  // skip it cleanly so the rest of the full unit/jsdom gate still runs. The
  // bounded lane never includes the chat suite.
  if (step.name === "tests" && full && isRoot) command.push("--", "--skip-chat-integration");
  return command;
}

function isRootUser() {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

/**
 * The tests step matches PR CI's one-retry contention safety net. A loaded
 * machine can miss a wall-clock perf assertion or a 5s component timeout on
 * the first pass; the retry reporter prints anything that needed the retry.
 * An explicit PAPERCLIP_VITEST_RETRY (including 0) still wins.
 */
export function stepEnv(step, baseEnv = process.env) {
  if (step.name !== "tests") return baseEnv;
  return { ...baseEnv, PAPERCLIP_VITEST_RETRY: baseEnv.PAPERCLIP_VITEST_RETRY ?? "1" };
}

function runStep(step, { noDownload, full }) {
  const command = stepCommand(step, { noDownload, full });
  if (step.name === "tests" && full && isRootUser()) {
    process.stdout.write("  Root run: skipping the embedded-Postgres chat integration shard. Run as a non-root user to include it.\n");
  }
  const printable = command
    .map((part) => (part === process.execPath ? "node" : part))
    .map((part) => (/\s/.test(part) ? JSON.stringify(part) : part))
    .join(" ");
  process.stdout.write(`\n▶ ${step.name}: ${printable}\n`);
  const startedAt = process.hrtime.bigint();
  const result = spawnSync(command[0], command.slice(1), {
    cwd: repoRoot,
    env: stepEnv(step),
    stdio: "inherit",
    shell: process.platform === "win32" && command[0] === pnpm,
  });
  const elapsed = seconds(startedAt);
  if (result.error) {
    process.stderr.write(`✖ ${step.name} could not start: ${result.error.message} (${elapsed})\n`);
    return { name: step.name, ok: false, elapsed, status: 1 };
  }
  if (result.signal) {
    process.stderr.write(`✖ ${step.name} interrupted by ${result.signal} (${elapsed})\n`);
    return { name: step.name, ok: false, elapsed, status: 130 };
  }
  const ok = result.status === 0;
  process.stdout.write(`${ok ? "✔" : "✖"} ${step.name} (${elapsed})\n`);
  return { name: step.name, ok, elapsed, status: result.status ?? 1 };
}

function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`check:local: ${error.message}\n\n${usage()}\n`);
    process.exit(2);
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (options.list) {
    for (const step of STEPS) {
      process.stdout.write(`${step.name}\t${stepCommand(step, { full: options.full }).join(" ")}\n`);
    }
    return;
  }

  const steps = selectSteps(options);
  if (steps.length === 0) {
    process.stderr.write("check:local: no steps selected\n");
    process.exit(2);
  }

  process.stdout.write(`check:local — ${steps.length} step(s): ${steps.map((step) => step.name).join(", ")}\n`);
  const results = [];
  for (const [index, step] of steps.entries()) {
    process.stdout.write(`\n[${index + 1}/${steps.length}] ${step.name}`);
    const result = runStep(step, options);
    results.push(result);
    if (!result.ok && !options.keepGoing) break;
  }

  process.stdout.write("\ncheck:local summary\n");
  for (const result of results) {
    process.stdout.write(`  ${result.ok ? "✔" : "✖"} ${result.name} (${result.elapsed})\n`);
  }
  const skipped = steps.filter((step) => !results.some((result) => result.name === step.name));
  for (const step of skipped) {
    process.stdout.write(`  - ${step.name} (not run)\n`);
  }

  const failed = results.find((result) => !result.ok);
  if (failed) {
    const interrupted = results.some((result) => result.status === 130);
    process.stderr.write(`\ncheck:local failed at ${failed.name}\n`);
    process.exit(interrupted ? 130 : 1);
  }
  process.stdout.write("\ncheck:local passed\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
