#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { extname, resolve } from "node:path";

import { loadBaseline, saveBaseline, splitByBaseline } from "./readiness/lib/baselines.mjs";
import { repoRoot, stagedFiles } from "./readiness/lib/files.mjs";
import { parseArgs, printTitle, settle, writeJsonArtifact } from "./readiness/lib/report.mjs";

/**
 * Repository lint gate backed by oxlint.
 *
 * Oxlint is fast enough to run from the pre-commit hook and in CI. The
 * repository predates the gate, so `.quality/baselines/lint.json` records the
 * findings that existed when it landed. The gate still counts and reports
 * them, but only a new finding fails the check. Fixing a baselined finding and
 * running `--update-baseline` ratchets the baseline down.
 *
 * Usage:
 *   node scripts/check-lint.mjs                  # whole repository
 *   node scripts/check-lint.mjs --staged         # staged JS/TS files only
 *   node scripts/check-lint.mjs --update-baseline
 */

const LINTABLE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

function resolveOxlint() {
  return resolve(repoRoot, "node_modules", ".bin", "oxlint");
}

function findingKey(finding) {
  return `${finding.file}|${finding.code}|${finding.message}`;
}

function normalizeDiagnostic(diagnostic) {
  const firstLabel = Array.isArray(diagnostic.labels) ? diagnostic.labels[0] : undefined;
  return {
    file: diagnostic.filename ?? "<unknown>",
    line: firstLabel?.span?.line ?? 1,
    column: firstLabel?.span?.column ?? 1,
    code: diagnostic.code ?? "oxlint",
    severity: diagnostic.severity ?? "warning",
    message: diagnostic.message ?? "lint finding",
  };
}

function runOxlint(paths) {
  const result = spawnSync(
    resolveOxlint(),
    [
      "--config",
      resolve(repoRoot, ".oxlintrc.json"),
      "--format",
      "json",
      "--no-error-on-unmatched-pattern",
      ...paths,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    },
  );

  if (result.error) {
    throw new Error(`Unable to run oxlint: ${result.error.message}`);
  }
  if (result.status === 2) {
    throw new Error(`oxlint configuration error: ${result.stderr || result.stdout}`);
  }

  const raw = result.stdout?.trim();
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`oxlint did not return JSON: ${raw.slice(0, 400)}`);
  }
  return (parsed.diagnostics ?? []).map(normalizeDiagnostic);
}

function main() {
  const args = parseArgs();
  const staged = args.flags.has("staged");
  const updateBaseline = args.flags.has("update-baseline");

  const paths = staged
    ? (stagedFiles() ?? []).filter((file) => LINTABLE_EXTENSIONS.has(extname(file)))
    : ["."];

  if (staged && paths.length === 0) {
    process.stdout.write("\nLint\n----\n  ℹ No staged JavaScript or TypeScript files.\n");
    return;
  }

  const findings = runOxlint(paths);
  const baseline = loadBaseline("lint");

  if (updateBaseline) {
    const saved = saveBaseline("lint", findings, findingKey, {
      note: "Pre-existing oxlint findings acknowledged when the lint gate landed. Fix them and rerun --update-baseline to ratchet down.",
    });
    writeJsonArtifact(".quality/reports/lint.json", {
      generatedAt: new Date().toISOString(),
      total: findings.length,
      baseline: saved.path,
      byRule: countByRule(findings),
    });
    printTitle("Lint baseline");
    process.stdout.write(`  Wrote ${saved.count} finding(s) to ${saved.path}\n`);
    return;
  }

  const { newFindings, knownFindings, staleEntries } = splitByBaseline(
    findings,
    baseline,
    findingKey,
  );

  const notes = [
    `Analyzed ${paths.length === 1 && paths[0] === "." ? "the repository" : `${paths.length} staged file(s)`} with oxlint.`,
    `Total findings: ${findings.length} (${knownFindings.length} baselined).`,
    ...topRules(findings),
  ];
  if (staleEntries.length) {
    notes.push(
      `${staleEntries.length} baseline entr${staleEntries.length === 1 ? "y is" : "ies are"} stale; run --update-baseline after fixing them.`,
    );
  }

  writeJsonArtifact(".quality/reports/lint.json", {
    generatedAt: new Date().toISOString(),
    total: findings.length,
    newFindings: newFindings.length,
    baselined: knownFindings.length,
    byRule: countByRule(findings),
  });

  settle({
    title: "Lint",
    newFindings,
    knownFindings,
    notes,
    json: ".quality/reports/lint.json",
  });
}

function countByRule(findings) {
  const counts = new Map();
  for (const finding of findings) {
    counts.set(finding.code, (counts.get(finding.code) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((left, right) => right[1] - left[1]));
}

function topRules(findings, limit = 6) {
  return Object.entries(countByRule(findings))
    .slice(0, limit)
    .map(([rule, count]) => `  ${rule}: ${count}`);
}

main();
