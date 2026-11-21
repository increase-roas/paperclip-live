#!/usr/bin/env node

import { dirname, extname, resolve } from "node:path";

import { extractImportSpecifiers } from "./check-module-boundaries.mjs";
import { loadBaseline, saveBaseline, splitByBaseline } from "./readiness/lib/baselines.mjs";
import {
  SOURCE_EXTENSIONS,
  gitTrackedFiles,
  matchesGlob,
  readText,
  repoPath,
  repoRoot,
} from "./readiness/lib/files.mjs";
import { parseArgs, readJsonFile, settle } from "./readiness/lib/report.mjs";

/**
 * Cross-package and UI layer boundary enforcement.
 *
 * `scripts/check-module-boundaries.mjs` already guards the server's
 * domain/application/adapters layers. This check covers the rest of the
 * workspace: the UI's dependency direction (lib/api -> components -> pages),
 * and the rule that packages, the CLI and the server do not reach into each
 * other's source trees.
 *
 * Rules live in .quality/module-boundaries.json:
 *   from    - globs for importing files
 *   forbid  - globs for resolved imported files
 *   allow   - optional globs that override `forbid` for known bridge modules
 */

function resolveImport(importer, specifier, trackedSet) {
  const candidates = [];
  if (specifier.startsWith("@/")) {
    candidates.push(resolve(repoRoot, "ui/src", specifier.slice(2)));
  } else if (specifier.startsWith(".")) {
    candidates.push(resolve(dirname(importer), specifier));
  } else {
    return null;
  }
  const extensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
  for (const candidate of candidates) {
    const direct = repoPath(candidate);
    if (trackedSet.has(direct)) return direct;
    const extension = extname(candidate);
    const withoutExtension = extension ? candidate.slice(0, -extension.length) : candidate;
    for (const replacement of extensions) {
      const relative = repoPath(`${withoutExtension}${replacement}`);
      if (trackedSet.has(relative)) return relative;
    }
    for (const replacement of extensions) {
      const relative = repoPath(resolve(candidate, `index${replacement}`));
      if (trackedSet.has(relative)) return relative;
    }
  }
  return null;
}

function main() {
  const args = parseArgs();
  const config = readJsonFile(".quality/module-boundaries.json", { rules: [] });
  const rules = config.rules ?? [];
  const tracked = (gitTrackedFiles() ?? []).map((file) => repoPath(file));
  const trackedSet = new Set(tracked);
  const findings = [];

  for (const relativePath of tracked) {
    if (!SOURCE_EXTENSIONS.has(extname(relativePath))) continue;
    const applicable = rules.filter((rule) => (rule.from ?? []).some((pattern) => matchesGlob(relativePath, pattern)));
    if (applicable.length === 0) continue;

    let text;
    try {
      text = readText(`${repoRoot}/${relativePath}`);
    } catch {
      continue;
    }
    for (const specifier of extractImportSpecifiers(text)) {
      const resolved = resolveImport(resolve(repoRoot, relativePath), specifier, trackedSet);
      if (!resolved) continue;
      for (const rule of applicable) {
        if ((rule.allow ?? []).some((pattern) => matchesGlob(resolved, pattern))) continue;
        const forbidden = (rule.forbid ?? []).find((pattern) => matchesGlob(resolved, pattern));
        if (!forbidden) continue;
        findings.push({
          file: relativePath,
          key: `${relativePath}->${resolved}`,
          message: `imports ${resolved}, which crosses a module boundary`,
          detail: rule.reason,
        });
      }
    }
  }

  if (args.flags.has("update-baseline")) {
    const { count, path } = saveBaseline("module-boundaries", findings, (finding) => finding.key, {
      note: "Boundary crossings that predate the check. Fix the dependency direction before adding new ones.",
    });
    process.stdout.write(`Wrote ${count} entries to ${repoPath(path)}\n`);
    return;
  }

  const baseline = loadBaseline("module-boundaries");
  const { newFindings, knownFindings } = splitByBaseline(findings, baseline, (finding) => finding.key);
  settle({
    title: "Module boundaries",
    newFindings,
    knownFindings,
    notes: [`Applied ${rules.length} boundary rules to ${tracked.length} tracked files.`],
  });
}

main();
