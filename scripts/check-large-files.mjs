#!/usr/bin/env node

import { statSync } from "node:fs";

import { loadBaseline, saveBaseline, splitByBaseline } from "./readiness/lib/baselines.mjs";
import {
  gitTrackedFiles,
  isIgnoredPath,
  listFiles,
  readText,
  repoPath,
  stagedFiles,
} from "./readiness/lib/files.mjs";
import { parseArgs, readJsonFile, settle } from "./readiness/lib/report.mjs";

/**
 * Flags tracked text files that exceed the configured line or byte budget.
 *
 * Rationale: very large files are expensive for an agent to read, review and
 * edit, and they usually hide several responsibilities. The check does not
 * force a split in the same change; it stops the situation from getting worse
 * while acknowledged offenders stay in the baseline.
 */

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".mdx",
  ".yml",
  ".yaml",
  ".css",
  ".html",
  ".rs",
  ".sql",
  ".sh",
]);

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".mp4",
  ".webm",
  ".zip",
  ".gz",
  ".pdf",
]);

function extensionOf(filePath) {
  const index = filePath.lastIndexOf(".");
  return index === -1 ? "" : filePath.slice(index).toLowerCase();
}

export function analyzeFile(filePath) {
  const stats = statSync(filePath);
  if (!stats.isFile()) return null;
  const extension = extensionOf(filePath);
  if (BINARY_EXTENSIONS.has(extension)) return null;
  if (!TEXT_EXTENSIONS.has(extension)) return null;
  let lines = null;
  try {
    lines = readText(filePath).split("\n").length;
  } catch {
    return null;
  }
  return { bytes: stats.size, lines };
}

function main() {
  const args = parseArgs();
  const config = readJsonFile(".quality/large-files.json", {});
  const maxLines = config.maxLines ?? 2500;
  const maxBytes = config.maxBytes ?? 750000;
  const ignore = config.ignore ?? [];
  const updateBaseline = args.flags.has("update-baseline");
  const stagedOnly = args.flags.has("staged");

  const candidates = stagedOnly
    ? (stagedFiles() ?? [])
    : (gitTrackedFiles() ?? listFiles({ roots: ["."] }));

  const findings = [];
  for (const file of candidates) {
    const relativePath = repoPath(file);
    if (!relativePath || relativePath.startsWith("..")) continue;
    if (isIgnoredPath(relativePath, { ignore })) continue;
    let analysis;
    try {
      analysis = analyzeFile(file);
    } catch {
      continue;
    }
    if (!analysis) continue;
    if (analysis.lines <= maxLines && analysis.bytes <= maxBytes) continue;
    const reasons = [];
    if (analysis.lines > maxLines) reasons.push(`${analysis.lines} lines (limit ${maxLines})`);
    if (analysis.bytes > maxBytes) reasons.push(`${analysis.bytes} bytes (limit ${maxBytes})`);
    findings.push({
      file: relativePath,
      // Bucket the measurements so an acknowledged file still fails once it
      // grows by another 500 lines or 250 KB. A path-only key would let a
      // baselined file grow without limit.
      key: `${relativePath}#lines:${Math.floor(analysis.lines / 500)}#bytes:${Math.floor(analysis.bytes / 250000)}`,
      message: `oversized file: ${reasons.join(", ")}`,
      detail: "Split it by responsibility or record an explicit exception in the baseline.",
    });
  }

  if (updateBaseline) {
    const { count, path } = saveBaseline("large-files", findings, (finding) => finding.key, {
      note: "Files already over the size budget when the check was introduced. New or growing files fail the check.",
    });
    process.stdout.write(`Wrote ${count} entries to ${repoPath(path)}\n`);
    return;
  }

  const baseline = loadBaseline("large-files");
  const { newFindings, knownFindings } = splitByBaseline(findings, baseline, (finding) => finding.key);
  settle({
    title: "Large files",
    newFindings,
    knownFindings,
    notes: [
      `Checked ${candidates.length} files; limits: ${maxLines} lines / ${maxBytes} bytes.`,
    ],
  });
}

main();
