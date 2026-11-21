#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { repoRoot } from "./readiness/lib/files.mjs";

/**
 * Installs the checked-in Git hooks in .githooks by pointing
 * `core.hooksPath` at that directory for this clone.
 *
 * The hooks are plain reproducible files, so this script only needs to make
 * them executable and update local Git config. It never touches tracked
 * content and is safe to re-run.
 */

const hooksDirectory = resolve(repoRoot, ".githooks");

if (!existsSync(hooksDirectory)) {
  process.stderr.write("Missing .githooks directory.\n");
  process.exit(1);
}

for (const entry of readdirSync(hooksDirectory)) {
  chmodSync(resolve(hooksDirectory, entry), 0o755);
}

const result = spawnSync("git", ["config", "core.hooksPath", ".githooks"], {
  cwd: repoRoot,
  encoding: "utf8",
});
if (result.status !== 0) {
  process.stderr.write(result.stderr || "Failed to set core.hooksPath.\n");
  process.exit(1);
}

process.stdout.write(
  "Installed repository hooks (.githooks). Bypass with SKIP_READINESS_HOOKS=1.\n",
);
