#!/usr/bin/env node

import { statSync } from "node:fs";

import { describeStale, loadBaseline, saveBaseline } from "./readiness/lib/baselines.mjs";
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

/**
 * Bucketed identity for an oversized file. Buckets keep the ratchet: an
 * acknowledged file still fails once it grows by another 500 lines or 250 KB.
 */
export function largeFileKey(relativePath, analysis) {
  return `${relativePath}#lines:${Math.floor(analysis.lines / 500)}#bytes:${Math.floor(analysis.bytes / 250000)}`;
}

const LARGE_FILE_KEY = /^(?<file>.*)#lines:(?<lines>\d+)#bytes:(?<bytes>\d+)$/;

function parseLargeFileKey(key) {
  const match = LARGE_FILE_KEY.exec(key ?? "");
  if (!match?.groups) return null;
  return {
    file: match.groups.file,
    lines: Number(match.groups.lines),
    bytes: Number(match.groups.bytes),
  };
}

/**
 * Classifies findings against the baseline by file and by recorded size.
 *
 * The baseline records the bucket a file was acknowledged at. A file that
 * shrinks, even into a smaller bucket, is still the same acknowledged debt and
 * must not read as a new finding: splitting a large file made the check fail
 * here, which punished the very work the check asks for. Growth past the
 * recorded bucket is new. An entry whose file is no longer oversized is stale.
 */
export function classifyLargeFileFindings(findings, baselineEntries) {
  const recorded = new Map();
  for (const entry of baselineEntries) {
    const parsed = parseLargeFileKey(entry.key);
    if (!parsed) continue;
    const list = recorded.get(parsed.file) ?? [];
    list.push(parsed);
    recorded.set(parsed.file, list);
  }

  const newFindings = [];
  const knownFindings = [];
  const matchedFiles = new Set();
  for (const finding of findings) {
    const current = parseLargeFileKey(finding.key);
    const entries = recorded.get(current?.file ?? finding.file) ?? [];
    matchedFiles.add(current?.file ?? finding.file);
    const acknowledged = entries.some(
      (entry) => current !== null && entry.lines >= current.lines && entry.bytes >= current.bytes,
    );
    if (acknowledged) knownFindings.push(finding);
    else newFindings.push(finding);
  }

  const staleEntries = baselineEntries.filter((entry) => {
    const parsed = parseLargeFileKey(entry.key);
    return !parsed || !matchedFiles.has(parsed.file);
  });

  return { newFindings, knownFindings, staleEntries };
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
      key: largeFileKey(relativePath, analysis),
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
  const { newFindings, knownFindings, staleEntries } = classifyLargeFileFindings(
    findings,
    baseline.entries,
  );
  const staleNote = describeStale(staleEntries);
  settle({
    title: "Large files",
    newFindings,
    knownFindings,
    notes: [
      `Checked ${candidates.length} files; limits: ${maxLines} lines / ${maxBytes} bytes.`,
      ...(staleNote ? [staleNote] : []),
    ],
  });
}

main();
