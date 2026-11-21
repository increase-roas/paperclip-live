#!/usr/bin/env node

import { loadBaseline, saveBaseline, splitByBaseline } from "./readiness/lib/baselines.mjs";
import { analyzeComplexity } from "./readiness/lib/complexity.mjs";
import {
  gitTrackedFiles,
  isIgnoredPath,
  matchesGlob,
  readText,
  repoPath,
  repoRoot,
} from "./readiness/lib/files.mjs";
import { parseArgs, readJsonFile, settle, writeJsonArtifact } from "./readiness/lib/report.mjs";

/**
 * Cyclomatic-complexity gate.
 *
 * Every TypeScript/JavaScript function is measured with the McCabe definition
 * (see scripts/readiness/lib/complexity.mjs). Functions above the configured
 * budget must be recorded in .quality/baselines/complexity.json; any new
 * offender fails. The report artifact lists the largest functions so an agent
 * can find the next refactor target without guessing.
 */

function thresholdFor(relativePath, config) {
  let threshold = config.defaultThreshold ?? 80;
  for (const rule of config.thresholds ?? []) {
    if (!matchesGlob(relativePath, rule.pattern)) continue;
    threshold = rule.threshold;
  }
  return threshold;
}

function main() {
  const args = parseArgs();
  const config = readJsonFile(".quality/complexity.json", {
    defaultThreshold: 80,
    thresholds: [],
    exclude: [],
  });
  const exclude = config.exclude ?? [];
  const files = (gitTrackedFiles() ?? [])
    .map((file) => repoPath(file))
    .filter((relativePath) => /\.(?:ts|tsx)$/.test(relativePath))
    .filter((relativePath) => !isIgnoredPath(relativePath, { ignore: exclude }));

  const functions = [];
  const parseFailures = [];
  for (const relativePath of files) {
    let result;
    try {
      result = analyzeComplexity(relativePath, readText(`${repoRoot}/${relativePath}`));
    } catch (error) {
      parseFailures.push({ file: relativePath, message: error.message });
      continue;
    }
    if (result.errors.length) {
      parseFailures.push({ file: relativePath, message: `${result.errors.length} parser error(s)` });
      continue;
    }
    functions.push(...result.functions);
  }

  const findings = [];
  for (const entry of functions) {
    const threshold = thresholdFor(entry.file, config);
    if (entry.complexity <= threshold) continue;
    findings.push({
      file: entry.file,
      line: entry.line,
      key: `${entry.file}::${entry.name}`,
      message: `${entry.name} has cyclomatic complexity ${entry.complexity} (budget ${threshold})`,
      note: `complexity=${entry.complexity}`,
    });
  }
  findings.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);

  const report = {
    generatedAt: new Date().toISOString(),
    files: files.length,
    functions: functions.length,
    threshold: config.defaultThreshold,
    overBudget: findings.length,
    worst: [...functions]
      .sort((left, right) => right.complexity - left.complexity)
      .slice(0, 25)
      .map((entry) => ({
        file: entry.file,
        line: entry.line,
        name: entry.name,
        complexity: entry.complexity,
      })),
    parseFailures,
  };

  if (args.flags.has("update-baseline")) {
    const { count, path } = saveBaseline("complexity", findings, (finding) => finding.key, {
      note: "Functions already over the complexity budget. Split or simplify them before adding new offenders.",
    });
    writeJsonArtifact(".quality/reports/complexity.json", report);
    process.stdout.write(`Wrote ${count} entries to ${repoPath(path)}\n`);
    process.stdout.write(`Wrote ${files.length}-file report to .quality/reports/complexity.json\n`);
    return;
  }

  writeJsonArtifact(".quality/reports/complexity.json", report);
  const baseline = loadBaseline("complexity");
  const { newFindings, knownFindings } = splitByBaseline(findings, baseline, (finding) => finding.key);
  const worst = report.worst[0];
  settle({
    title: "Cyclomatic complexity",
    newFindings,
    knownFindings,
    notes: [
      `Analyzed ${functions.length} functions in ${files.length} files (budget ${config.defaultThreshold}).`,
      worst
        ? `Worst: ${worst.file}:${worst.line} ${worst.name} (${worst.complexity}).`
        : "No functions analyzed.",
      `Report: .quality/reports/complexity.json`,
    ],
  });
}

main();
