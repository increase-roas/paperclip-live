#!/usr/bin/env node

import { resolve } from "node:path";

import { parseProgram, walkAst } from "./readiness/lib/ast.mjs";
import { loadBaseline, saveBaseline, splitByBaseline } from "./readiness/lib/baselines.mjs";
import { gitTrackedFiles, readText, repoPath, repoRoot } from "./readiness/lib/files.mjs";
import { parseArgs, readJsonFile, settle, writeJsonArtifact } from "./readiness/lib/report.mjs";

/**
 * Dead feature-flag detector.
 *
 * Reads the boolean keys of `InstanceExperimentalSettings`, then scans the
 * codebase for references outside the definition file. A flag with no readers
 * is dead: its setting can be removed together with the branch it guarded.
 * Flags marked `@deprecated` are reported as retirement candidates even while
 * code still reads them for compatibility.
 *
 * This is a static inventory, not a runtime usage report. A flag referenced
 * only in test fixtures still counts as referenced; the report lists the
 * files so a reviewer can judge.
 */

const DEPRECATED_PATTERN = /@deprecated/i;

function collectFlags(definitionFile, interfaceName) {
  const code = readText(resolve(repoRoot, definitionFile));
  const { program, errors } = parseProgram(definitionFile, code);
  if (errors.length) {
    throw new Error(`Could not parse ${definitionFile}: ${errors.length} parser error(s)`);
  }
  const flags = [];
  walkAst(program, (node) => {
    if (node.type !== "TSInterfaceDeclaration" || node.id?.name !== interfaceName) return;
    for (const member of node.body.body) {
      if (member.type !== "TSPropertySignature") continue;
      const name = member.key?.name;
      if (!name) continue;
      const isBoolean = member.typeAnnotation?.typeAnnotation?.type === "TSBooleanKeyword";
      if (!isBoolean) continue;
      const prefix = code.slice(Math.max(0, member.start - 400), member.start);
      const lastComment = prefix.lastIndexOf("/**");
      const depreciated = lastComment !== -1 && DEPRECATED_PATTERN.test(prefix.slice(lastComment));
      flags.push({ name, deprecated: depreciated });
    }
  });
  return { flags };
}

function main() {
  const args = parseArgs();
  const config = readJsonFile(".quality/feature-flags.json", {});
  const definitionFile = config.definitionFile ?? "packages/shared/src/types/instance.ts";
  const interfaceName = config.interfaceName ?? "InstanceExperimentalSettings";
  const scanRoots = config.scanRoots ?? ["server/src", "ui/src", "cli/src", "packages"];
  const exclude = config.exclude ?? [];

  const { flags } = collectFlags(definitionFile, interfaceName);
  const referenceCounts = new Map(flags.map((flag) => [flag.name, []]));
  const files = (gitTrackedFiles() ?? [])
    .map((file) => repoPath(file))
    .filter((relativePath) => /\.(?:ts|tsx|mts|cts|mjs|js)$/.test(relativePath))
    .filter((relativePath) => scanRoots.some((root) => relativePath.startsWith(root)))
    .filter((relativePath) => relativePath !== definitionFile)
    .filter((relativePath) => !exclude.some((pattern) => relativePath.includes(pattern.replace(/\*\*/g, ""))))
    .filter((relativePath) => !/(^|\/)(?:node_modules|dist|generated)\//.test(relativePath));

  for (const relativePath of files) {
    let text;
    try {
      text = readText(resolve(repoRoot, relativePath));
    } catch {
      continue;
    }
    for (const flag of flags) {
      if (new RegExp(`\\b${flag.name}\\b`).test(text)) referenceCounts.get(flag.name).push(relativePath);
    }
  }

  const findings = [];
  for (const flag of flags) {
    const references = referenceCounts.get(flag.name);
    if (references.length === 0) {
      findings.push({
        file: definitionFile,
        key: `dead::${flag.name}`,
        message: `feature flag "${flag.name}" has no readers outside its definition`,
        detail: "Remove the setting and the branch it guarded, or wire the flag where it should be read.",
      });
    }
    if (flag.deprecated) {
      findings.push({
        file: definitionFile,
        key: `deprecated::${flag.name}`,
        message: `feature flag "${flag.name}" is marked @deprecated`,
        detail:
          references.length > 0
            ? `Still read by: ${references.slice(0, 4).join(", ")}`
            : "No readers remain; remove the key.",
      });
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    definitionFile,
    interfaceName,
    flags: flags.length,
    dead: findings.filter((finding) => finding.key.startsWith("dead::")).length,
    deprecated: findings.filter((finding) => finding.key.startsWith("deprecated::")).length,
    inventory: flags.map((flag) => ({
      name: flag.name,
      deprecated: flag.deprecated,
      readers: referenceCounts.get(flag.name).length,
    })),
  };
  writeJsonArtifact(".quality/reports/feature-flags.json", report);

  if (args.flags.has("update-baseline")) {
    const { count, path } = saveBaseline("feature-flags", findings, (finding) => finding.key, {
      note: "Deprecated or already-dead flags retained for compatibility. Remove them in a dedicated change.",
    });
    process.stdout.write(`Wrote ${count} entries to ${repoPath(path)}\n`);
    return;
  }

  const baseline = loadBaseline("feature-flags");
  const { newFindings, knownFindings } = splitByBaseline(findings, baseline, (finding) => finding.key);
  settle({
    title: "Feature flags",
    newFindings,
    knownFindings,
    notes: [
      `Tracked ${flags.length} boolean flags; ${report.dead} unread, ${report.deprecated} deprecated.`,
      "Inventory: .quality/reports/feature-flags.json",
    ],
  });
}

main();
