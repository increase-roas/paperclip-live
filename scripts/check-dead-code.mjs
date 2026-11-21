#!/usr/bin/env node

import { existsSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

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
 * Dead-module detector.
 *
 * Builds the import graph for repository source trees and reports modules
 * that nothing imports and no config, HTML entry point, workflow or test
 * references. This catches files that were superseded but never deleted,
 * which otherwise stay invisible because typecheck happily compiles them.
 *
 * Dynamic imports, `import.meta.glob` patterns and path references from
 * HTML/config/shell files are resolved before a file is considered unused.
 * Barrel files (`index.*`) and declared entry points are excluded.
 */

const RESOLUTION_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const DYNAMIC_GLOB = /import\.meta\.glob(?:<[^>]*>)?\(\s*["'`]([^"'`]+)["'`]/g;

function tryFile(candidate) {
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return null;
}

function resolveCandidate(baseDirectory, specifier) {
  const target = resolve(baseDirectory, specifier);
  const direct = tryFile(target);
  if (direct) return direct;

  // NodeNext-style source imports reference the emitted `.js` file while the
  // repository stores TypeScript. Swap the extension before appending one.
  const extension = extname(specifier);
  const withoutExtension = extension ? specifier.slice(0, -extension.length) : specifier;
  const extensionlessTarget = resolve(baseDirectory, withoutExtension);
  for (const replacement of RESOLUTION_EXTENSIONS) {
    const swapped = tryFile(`${extensionlessTarget}${replacement}`);
    if (swapped) return swapped;
  }

  for (const replacement of RESOLUTION_EXTENSIONS) {
    const withExtension = tryFile(`${target}${replacement}`);
    if (withExtension) return withExtension;
  }
  for (const replacement of RESOLUTION_EXTENSIONS) {
    const asIndex = tryFile(join(target, `index${replacement}`));
    if (asIndex) return asIndex;
  }
  return null;
}

function resolveSpecifier(importer, specifier) {
  if (specifier.startsWith(".")) return resolveCandidate(dirname(importer), specifier);
  if (specifier.startsWith("@/")) return resolveCandidate(resolve(repoRoot, "ui/src"), specifier.slice(2));
  return null;
}

function isSourceFile(relativePath) {
  return SOURCE_EXTENSIONS.has(extname(relativePath));
}

function main() {
  const args = parseArgs();
  const config = readJsonFile(".quality/dead-code.json", {});
  const roots = config.roots ?? ["server/src", "cli/src", "ui/src", "packages/*/src"];
  const entryPoints = config.entryPoints ?? [];
  const referencePatterns = config.referenceFiles ?? [];
  const tracked = (gitTrackedFiles() ?? []).map((file) => repoPath(file));
  const trackedSet = new Set(tracked);
  const candidates = tracked.filter(
    (relativePath) =>
      isSourceFile(relativePath) &&
      !relativePath.endsWith(".d.ts") &&
      !/(^|\/)(?:node_modules|dist|generated)\//.test(relativePath) &&
      roots.some((root) => matchesGlob(relativePath, `${root}/**`)) &&
      !entryPoints.some((pattern) => matchesGlob(relativePath, pattern)),
  );

  const referenced = new Map();
  const mark = (relativePath) => {
    if (relativePath && trackedSet.has(relativePath)) {
      referenced.set(relativePath, (referenced.get(relativePath) ?? 0) + 1);
    }
  };

  const globPatterns = [];
  for (const relativePath of tracked) {
    if (!isSourceFile(relativePath)) continue;
    let text;
    try {
      text = readText(resolve(repoRoot, relativePath));
    } catch {
      continue;
    }
    const absolute = resolve(repoRoot, relativePath);
    for (const specifier of extractImportSpecifiers(text)) {
      const resolved = resolveSpecifier(absolute, specifier);
      if (resolved) mark(repoPath(resolved));
    }
    for (const match of text.matchAll(DYNAMIC_GLOB)) {
      globPatterns.push(match[1]);
    }
  }

  for (const pattern of globPatterns) {
    const normalized = pattern.replace(/^\.\//, "").replace(/^@\//, "ui/src/");
    for (const relativePath of tracked) {
      if (relativePath.endsWith(normalized) || matchesGlob(relativePath, `**/${normalized}`)) {
        mark(relativePath);
      }
    }
  }

  const candidatesByBase = new Map();
  for (const candidate of candidates) {
    const base = candidate.split("/").pop();
    if (!base) continue;
    if (!candidatesByBase.has(base)) candidatesByBase.set(base, []);
    candidatesByBase.get(base).push(candidate);
  }

  for (const relativePath of tracked) {
    if (!referencePatterns.some((pattern) => matchesGlob(relativePath, pattern))) continue;
    let text;
    try {
      text = readText(resolve(repoRoot, relativePath));
    } catch {
      continue;
    }
    if (!text.includes(".")) continue;
    for (const token of new Set(text.match(/[A-Za-z0-9_.@/-]+/g) ?? [])) {
      const base = token.split("/").pop();
      if (!base) continue;
      for (const candidate of candidatesByBase.get(base) ?? []) mark(candidate);
    }
  }

  const findings = candidates
    .filter((relativePath) => !referenced.has(relativePath))
    .map((relativePath) => ({
      file: relativePath,
      key: relativePath,
      message: "module is not imported by source, tests, config or entry points",
    }));

  if (args.flags.has("update-baseline")) {
    const { count, path } = saveBaseline("dead-code", findings, (finding) => finding.key, {
      note: "Modules that were already orphaned when the check was introduced. Delete them or add an explicit reference.",
    });
    process.stdout.write(`Wrote ${count} entries to ${repoPath(path)}\n`);
    return;
  }

  const baseline = loadBaseline("dead-code");
  const { newFindings, knownFindings } = splitByBaseline(findings, baseline, (finding) => finding.key);
  settle({
    title: "Dead code",
    newFindings,
    knownFindings,
    notes: [
      `Resolved ${referenced.size} referenced modules; ${candidates.length} candidate modules checked.`,
    ],
  });
}

main();
