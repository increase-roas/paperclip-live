#!/usr/bin/env node

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { parseArgs, printTitle } from "./readiness/lib/report.mjs";
import { repoRoot } from "./readiness/lib/files.mjs";

/**
 * Runs the static Agent Readiness checks in one pass.
 *
 * The bundle budget needs a production build, so it is skipped unless
 * `--with-bundle` is passed or ui/dist already exists. Every other check is
 * deterministic and reads only tracked files plus committed baselines.
 */

const checks = [
  { name: "lint", script: "scripts/check-lint.mjs" },
  { name: "agents-md", script: "scripts/check-agents-md.mjs" },
  { name: "format", script: "scripts/check-source-format.mjs" },
  { name: "naming", script: "scripts/check-naming-conventions.mjs" },
  { name: "complexity", script: "scripts/check-code-complexity.mjs" },
  { name: "large-files", script: "scripts/check-large-files.mjs" },
  { name: "dead-code", script: "scripts/check-dead-code.mjs" },
  { name: "dead-flags", script: "scripts/check-dead-feature-flags.mjs" },
  { name: "duplicates", script: "scripts/check-duplicate-code.mjs" },
  { name: "server-boundaries", script: "scripts/check-module-boundaries.mjs" },
  { name: "cross-package-boundaries", script: "scripts/check-cross-package-boundaries.mjs" },
  { name: "tech-debt", script: "scripts/check-tech-debt.mjs" },
  { name: "n-plus-one", script: "scripts/check-n-plus-one.mjs" },
  { name: "unused-dependencies", script: "scripts/check-unused-dependencies.mjs" },
  { name: "dependency-drift", script: "scripts/check-dependency-drift.mjs" },
  { name: "secrets", script: "scripts/check-secrets.mjs" },
  { name: "security-review", script: "scripts/security-review.mjs", args: ["--check"] },
  {
    name: "bundle-size",
    script: "scripts/check-bundle-size.mjs",
    requiresBuild: true,
  },
];

function main() {
  const args = parseArgs();
  const only = args.values.get("only");
  const withBundle = args.flags.has("with-bundle");
  const hasBuild = existsSync(resolve(repoRoot, "ui/dist"));

  const selected = checks.filter((check) => {
    if (only && check.name !== only) return false;
    if (check.requiresBuild && !withBundle && !hasBuild) return false;
    return true;
  });

  const results = [];
  for (const check of selected) {
    const result = spawnSync(process.execPath, [check.script, ...(check.args ?? [])], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    results.push({ name: check.name, ok: result.status === 0 });
  }

  printTitle("Agent readiness summary");
  for (const result of results) {
    process.stdout.write(`  ${result.ok ? "✔" : "✖"} ${result.name}\n`);
  }
  if (!selected.some((check) => check.requiresBuild)) {
    process.stdout.write("  ⚠ bundle-size skipped (run with --with-bundle after building the UI)\n");
  }

  if (results.some((result) => !result.ok)) process.exitCode = 1;
}

main();
