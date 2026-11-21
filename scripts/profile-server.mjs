#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { repoRoot } from "./readiness/lib/files.mjs";

/**
 * Starts the API server with V8 profiling enabled.
 *
 * Profiles are written to .quality/reports/profiles and can be opened in
 * Chrome DevTools (Performance panel -> Load profile) or summarized with
 * `node --prof-process` for legacy isolate logs.
 *
 * Usage:
 *   pnpm profile:server            # CPU profile
 *   pnpm profile:server --heap     # heap (memory) profile
 */

const passthrough = process.argv.slice(2);
const heap = passthrough.includes("--heap");
const outputDirectory = resolve(repoRoot, ".quality/reports/profiles");
mkdirSync(outputDirectory, { recursive: true });

const loader = resolve(repoRoot, "cli/node_modules/tsx/dist/loader.mjs");
const entry = resolve(repoRoot, "server/src/index.ts");
const profileFlag = heap ? "--heap-prof" : "--cpu-prof";

const child = spawn(
  process.execPath,
  [
    profileFlag,
    `${profileFlag}-dir`,
    outputDirectory,
    "--import",
    loader,
    entry,
    ...passthrough.filter((argument) => argument !== "--heap"),
  ],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env },
  },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code) => {
  process.stdout.write(`\nProfiles written to ${outputDirectory}\n`);
  process.exitCode = code ?? 0;
});
