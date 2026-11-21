#!/usr/bin/env node

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { repoRoot } from "./readiness/lib/files.mjs";
import { parseArgs } from "./readiness/lib/report.mjs";

/**
 * Runs a bounded entrypoint with V8 CPU (and optional heap) profiling.
 *
 * Usage:
 *   node scripts/profile-app.mjs --name cli --entry cli/dist/index.js -- --help
 *   node scripts/profile-app.mjs --name broker --heap --entry packages/tailscale-https-broker/dist/index.js
 *
 * Profiles land in `.quality/reports/profiles/<name>/` and are ignored by Git.
 * Open a `.cpuprofile` or `.heapprofile` in Chrome DevTools.
 */

const args = parseArgs();
const name = args.values.get("name");
const entry = args.values.get("entry");
const withHeap = args.flags.has("heap");

if (!name || !entry) {
  process.stderr.write(
    "Usage: node scripts/profile-app.mjs --name <name> --entry <dist-entry> [--heap] [-- <args>]\n",
  );
  process.exit(2);
}

const outputDirectory = resolve(repoRoot, ".quality", "reports", "profiles", name);
mkdirSync(outputDirectory, { recursive: true });

const nodeFlags = [
  "--cpu-prof",
  `--cpu-prof-dir=${outputDirectory}`,
  ...(withHeap ? ["--heap-prof", `--heap-prof-dir=${outputDirectory}`] : []),
];

const result = spawnSync(
  process.execPath,
  [...nodeFlags, resolve(repoRoot, entry), ...args.positional],
  { cwd: repoRoot, stdio: "inherit" },
);

process.stdout.write(
  `\nProfile written to ${outputDirectory}${withHeap ? " (CPU + heap)" : " (CPU)"}.\n`,
);

if (result.error) {
  process.stderr.write(`Unable to start ${entry}: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
