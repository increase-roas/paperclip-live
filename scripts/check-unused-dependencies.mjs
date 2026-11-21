#!/usr/bin/env node

import { readdirSync } from "node:fs";
import { extname, join } from "node:path";

import { extractImportSpecifiers } from "./check-module-boundaries.mjs";
import { loadBaseline, saveBaseline, splitByBaseline } from "./readiness/lib/baselines.mjs";
import {
  findWorkspacePackages,
  readText,
  repoPath,
} from "./readiness/lib/files.mjs";
import { parseArgs, readJsonFile, settle } from "./readiness/lib/report.mjs";

/**
 * Unused dependency detector for the pnpm workspace.
 *
 * A declared dependency is considered used when its package name appears in
 * an import/require specifier in the package's source or config, or when the
 * package name (or a bin it provides) appears in a package.json script. Type
 * packages (`@types/*`) count as used when their runtime package is imported.
 *
 * Only unused declarations are reported. Missing declarations are covered by
 * typecheck and the build.
 */

const SCANNED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".yml",
  ".yaml",
  ".sh",
]);

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "storybook-static",
  "ui-dist",
]);

function packageNameOfSpecifier(specifier) {
  if (!specifier || specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("@/")) {
    return null;
  }
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  return parts[0];
}

function collectTextFiles(directory, results = []) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) collectTextFiles(absolutePath, results);
    else if (entry.isFile() && SCANNED_EXTENSIONS.has(extname(entry.name))) results.push(absolutePath);
  }
  return results;
}

function main() {
  const args = parseArgs();
  const config = readJsonFile(".quality/unused-dependencies.json", {});
  const globalIgnore = new Set(config.ignore ?? []);
  const perPackageIgnore = config.ignoreByPackage ?? {};
  const workspacePackages = findWorkspacePackages();

  const findings = [];
  for (const workspacePackage of workspacePackages) {
    const declared = new Set([
      ...Object.keys(workspacePackage.manifest.dependencies ?? {}),
      ...Object.keys(workspacePackage.manifest.devDependencies ?? {}),
      ...Object.keys(workspacePackage.manifest.optionalDependencies ?? {}),
    ]);
    const ignore = new Set([...globalIgnore, ...(perPackageIgnore[workspacePackage.relativeDir] ?? [])]);
    const scriptsText = Object.values(workspacePackage.manifest.scripts ?? {}).join(" ");
    const used = new Set();

    const files = collectTextFiles(workspacePackage.dir);
    for (const file of files) {
      if (file === join(workspacePackage.dir, "package.json")) continue;
      let text;
      try {
        text = readText(file);
      } catch {
        continue;
      }
      for (const specifier of extractImportSpecifiers(text)) {
        const name = packageNameOfSpecifier(specifier);
        if (name) used.add(name);
      }
      for (const match of text.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)) {
        const name = packageNameOfSpecifier(match[1]);
        if (name) used.add(name);
      }
    }

    for (const dependency of declared) {
      if (used.has(dependency)) continue;
      if (scriptsText.includes(dependency)) continue;
      if (dependency.startsWith("@types/")) {
        const runtime = dependency.slice("@types/".length);
        if (used.has(runtime) || used.has(`@types/${runtime}`)) continue;
      }
      if (ignore.has(dependency)) continue;
      findings.push({
        file: `${workspacePackage.relativeDir}/package.json`,
        key: `${workspacePackage.relativeDir}::${dependency}`,
        message: `declared dependency "${dependency}" is never imported or invoked`,
        detail: "Remove it or add a documented exception in .quality/unused-dependencies.json.",
      });
    }
  }

  if (args.flags.has("update-baseline")) {
    const { count, path } = saveBaseline("unused-dependencies", findings, (finding) => finding.key, {
      note: "Declarations that predate the check. Remove them when touching the package; new unused declarations fail.",
    });
    process.stdout.write(`Wrote ${count} entries to ${repoPath(path)}\n`);
    return;
  }

  const baseline = loadBaseline("unused-dependencies");
  const { newFindings, knownFindings } = splitByBaseline(findings, baseline, (finding) => finding.key);
  settle({
    title: "Unused dependencies",
    newFindings,
    knownFindings,
    notes: [`Checked ${workspacePackages.length} workspace packages.`],
  });
}

main();
