#!/usr/bin/env node

import { createHash } from "node:crypto";
import { extname } from "node:path";

import { loadBaseline, saveBaseline, splitByBaseline } from "./readiness/lib/baselines.mjs";
import { gitTrackedFiles, isIgnoredPath, readText, repoPath, repoRoot, stagedFiles } from "./readiness/lib/files.mjs";
import { parseArgs, readJsonFile, settle } from "./readiness/lib/report.mjs";

/**
 * Technical-debt marker policy.
 *
 * Markers from .quality/tech-debt.json must reference a tracked issue, for
 * example a marker followed by `(PAP-1234)` or `(#1234)`, or an issue URL. The
 * check fails on new unlinked markers so debt stays addressable, and reports
 * linked markers as inventory. Existing unlinked markers are acknowledged in
 * the baseline.
 */
const REFERENCE_PATTERN =
  /(?:\(\s*(?:[A-Z][A-Z0-9]+-\d+|#\d+)\s*\)|(?:[A-Z][A-Z0-9]+-\d+|#\d+))|https?:\/\/\S+/;

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".css",
  ".sh",
  ".yml",
  ".yaml",
  ".sql",
  ".rs",
]);

function markerKey(relativePath, marker) {
  const digest = createHash("sha1").update(marker).digest("hex").slice(0, 12);
  return `${relativePath}#${digest}`;
}

function main() {
  const args = parseArgs();
  const config = readJsonFile(".quality/tech-debt.json", {});
  if (!Array.isArray(config.tags) || config.tags.length === 0) {
    process.stderr.write(".quality/tech-debt.json must list the marker tags to scan for.\n");
    process.exit(2);
  }
  const tags = config.tags;
  const exclude = config.exclude ?? [];
  const tagPattern = new RegExp(`\\b(${tags.join("|")})\\b`);
  const stagedOnly = args.flags.has("staged");
  const files = (stagedOnly ? (stagedFiles() ?? []) : (gitTrackedFiles() ?? []))
    .map((file) => repoPath(file))
    .filter((relativePath) => !isIgnoredPath(relativePath, { ignore: exclude }))
    .filter((relativePath) => CODE_EXTENSIONS.has(extname(relativePath)));

  const unlinked = [];
  const linked = [];
  for (const relativePath of files) {
    let text;
    try {
      text = readText(`${repoRoot}/${relativePath}`);
    } catch {
      continue;
    }
    const lines = text.split("\n");
    let inBlockComment = false;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      let isComment = inBlockComment;
      if (inBlockComment && line.includes("*/")) inBlockComment = false;
      if (!inBlockComment) {
        const lineComment = line.indexOf("//");
        const blockComment = line.indexOf("/*");
        if (lineComment !== -1 || blockComment !== -1 || line.trimStart().startsWith("*")) {
          isComment = true;
        }
        if (blockComment !== -1 && line.indexOf("*/", blockComment + 2) === -1) {
          inBlockComment = true;
        }
      }
      if (!isComment) continue;

      const match = line.match(tagPattern);
      if (!match) continue;
      const marker = line.trim().replace(/\s+/g, " ").slice(0, 240);
      const record = {
        file: relativePath,
        line: index + 1,
        key: markerKey(relativePath, marker),
        message: `${match[1]} marker is not linked to an issue`,
        note: marker,
      };
      if (REFERENCE_PATTERN.test(line)) linked.push(record);
      else unlinked.push(record);
    }
  }

  if (args.flags.has("update-baseline")) {
    const { count, path } = saveBaseline("tech-debt", unlinked, (finding) => finding.key, {
      note: "Unlinked debt markers that predate the policy. Rewrite them as TODO(PAP-1234) when touching the code.",
    });
    process.stdout.write(`Wrote ${count} entries to ${repoPath(path)}\n`);
    process.stdout.write(`Linked markers: ${linked.length}\n`);
    return;
  }

  const baseline = loadBaseline("tech-debt");
  const { newFindings, knownFindings } = splitByBaseline(unlinked, baseline, (finding) => finding.key);
  settle({
    title: "Technical debt markers",
    newFindings,
    knownFindings,
    notes: [
      `Scanned ${files.length} files: ${linked.length} linked marker(s), ${unlinked.length} unlinked.`,
      "Use TODO(PAP-1234): ... so every marker points at an issue.",
    ],
  });
}

main();
