#!/usr/bin/env node

import { loadBaseline, saveBaseline, splitByBaseline } from "./readiness/lib/baselines.mjs";
import { findWorkspacePackages, repoPath } from "./readiness/lib/files.mjs";
import { parseArgs, readJsonFile, settle } from "./readiness/lib/report.mjs";

/**
 * Dependency version-drift detector.
 *
 * Every workspace package must agree on the version range for a shared
 * dependency. Divergent ranges silently install several copies, change
 * behavior between apps, and split security fixes. Intentional differences
 * are recorded in .quality/baselines/dependency-drift.json.
 *
 * `workspace:` protocol ranges are internal references and are ignored.
 */

const SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"];

function main() {
  const args = parseArgs();
  const config = readJsonFile(".quality/dependency-drift.json", {});
  const allow = new Set(config.allow ?? []);
  const packages = findWorkspacePackages();

  const declarations = new Map();
  for (const workspacePackage of packages) {
    for (const section of SECTIONS) {
      for (const [name, range] of Object.entries(workspacePackage.manifest[section] ?? {})) {
        if (typeof range !== "string") continue;
        if (range.startsWith("workspace:") || range.startsWith("file:")) continue;
        if (!declarations.has(name)) declarations.set(name, new Map());
        const versions = declarations.get(name);
        if (!versions.has(range)) versions.set(range, []);
        versions.get(range).push(workspacePackage.relativeDir);
      }
    }
  }

  const findings = [];
  for (const [name, versions] of declarations) {
    if (allow.has(name)) continue;
    if (versions.size <= 1) continue;
    const ranges = [...versions.keys()].sort();
    const locations = [...versions.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([range, directories]) => `${range} (${directories.join(", ")})`)
      .join("; ");
    findings.push({
      file: "pnpm-workspace.yaml",
      key: `${name}::${ranges.join(" | ")}`,
      message: `dependency "${name}" is declared with ${versions.size} different version ranges`,
      detail: locations,
    });
  }

  findings.sort((left, right) => left.key.localeCompare(right.key));

  if (args.flags.has("update-baseline")) {
    const { count, path } = saveBaseline("dependency-drift", findings, (finding) => finding.key, {
      note: "Version differences that predate the check. Converge them when touching the package; new drift fails.",
    });
    process.stdout.write(`Wrote ${count} entries to ${repoPath(path)}\n`);
    return;
  }

  const baseline = loadBaseline("dependency-drift");
  const { newFindings, knownFindings } = splitByBaseline(findings, baseline, (finding) => finding.key);
  settle({
    title: "Dependency version drift",
    newFindings,
    knownFindings,
    notes: [`Compared ${declarations.size} dependency names across ${packages.length} workspace packages.`],
  });
}

main();
