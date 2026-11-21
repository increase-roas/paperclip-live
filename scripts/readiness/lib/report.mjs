import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { repoRoot } from "./files.mjs";

/**
 * Output helpers shared by the readiness checks.
 *
 * Exit codes: 0 = clean, 1 = findings, 2 = usage/configuration error.
 */

export function parseArgs(argv = process.argv.slice(2)) {
  const args = { positional: [], flags: new Set(), values: new Map() };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      args.positional.push(...argv.slice(index + 1));
      break;
    }
    if (!argument.startsWith("--")) {
      args.positional.push(argument);
      continue;
    }
    const [name, inlineValue] = argument.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      args.values.set(name, inlineValue);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args.values.set(name, next);
      index += 1;
      continue;
    }
    args.flags.add(name);
  }
  return args;
}

export function formatFinding(finding) {
  const location = finding.file
    ? `${finding.file}${finding.line ? `:${finding.line}` : ""}`
    : finding.location || "";
  const detail = finding.detail ? ` — ${finding.detail}` : "";
  return `${location}${location ? ": " : ""}${finding.message}${detail}`;
}

export function printTitle(title) {
  process.stdout.write(`\n${title}\n${"-".repeat(title.length)}\n`);
}

export function printFindings(findings, { limit = 40 } = {}) {
  for (const finding of findings.slice(0, limit)) {
    process.stdout.write(`  ✖ ${formatFinding(finding)}\n`);
  }
  if (findings.length > limit) {
    process.stdout.write(`  … ${findings.length - limit} more finding(s)\n`);
  }
}

export function printSummary(summary) {
  for (const line of summary) process.stdout.write(`  ${line}\n`);
}

/**
 * Prints a check result and sets the process exit code. `newFindings` are the
 * findings that are not covered by a committed baseline (the only findings
 * that fail a check); `knownFindings` are acknowledged debt.
 */
export function settle({
  title,
  newFindings = [],
  knownFindings = [],
  notes = [],
  json = null,
  stdout = true,
}) {
  const ok = newFindings.length === 0;
  if (stdout) {
    printTitle(title);
    if (notes.length) printSummary(notes);
    if (knownFindings.length) {
      process.stdout.write(
        `  ℹ ${knownFindings.length} known finding(s) are recorded in the baseline.\n`,
      );
    }
    if (newFindings.length) {
      printFindings(newFindings);
      process.stdout.write(
        `  ✖ ${newFindings.length} new finding(s). Fix them or run with --update-baseline after review.\n`,
      );
    } else {
      process.stdout.write("  ✔ No new findings.\n");
    }
    if (json) process.stdout.write(`  JSON: ${json}\n`);
  }
  if (!ok) process.exitCode = 1;
  return ok;
}

export function writeJsonArtifact(relativePath, value) {
  const absolutePath = resolve(repoRoot, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${JSON.stringify(value, null, 2)}\n`);
  return absolutePath;
}

export function readJsonFile(relativePath, fallback = null) {
  const absolutePath = resolve(repoRoot, relativePath);
  if (!existsSync(absolutePath)) return fallback;
  return JSON.parse(readFileSync(absolutePath, "utf8"));
}
