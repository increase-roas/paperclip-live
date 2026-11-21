#!/usr/bin/env node

import { createHash } from "node:crypto";
import { extname } from "node:path";

import { loadBaseline, saveBaseline, splitByBaseline } from "./readiness/lib/baselines.mjs";
import {
  gitTrackedFiles,
  isIgnoredPath,
  readText,
  repoPath,
  repoRoot,
} from "./readiness/lib/files.mjs";
import { parseArgs, readJsonFile, settle } from "./readiness/lib/report.mjs";

/**
 * Duplicate-code detector (tokenized, line based).
 *
 * Normalizes comments, whitespace, import statements and blank lines, then
 * compares every 12-line window. Matching windows that continue an already
 * reported clone are collapsed, and each surviving cross-file clone is
 * reported once with its maximal length. This is the same class of signal a
 * copy-paste detector (jscpd/CPD) produces, without a new dependency.
 */

const WINDOW = 12;
const MIN_CHARS = 240;

function normalizeFile(text) {
  const normalized = [];
  const originalLines = text.split("\n");
  let inBlockComment = false;

  for (let index = 0; index < originalLines.length; index += 1) {
    let line = originalLines[index];

    if (inBlockComment) {
      const end = line.indexOf("*/");
      if (end === -1) continue;
      line = line.slice(end + 2);
      inBlockComment = false;
    }

    // Remove block comments that start and finish on this line.
    line = line.replace(/\/\*.*?\*\//g, "");
    const blockStart = line.indexOf("/*");
    if (blockStart !== -1) {
      if (line.indexOf("*/", blockStart + 2) === -1) {
        inBlockComment = true;
        line = line.slice(0, blockStart);
      }
    }

    const commentStart = line.indexOf("//");
    if (commentStart !== -1) {
      // Keep URLs and strings that legitimately contain `//`.
      const before = line.slice(0, commentStart);
      const quotes = (before.match(/["'`]/g) ?? []).length;
      if (quotes % 2 === 0) line = before;
    }

    line = line.replace(/\s+/g, " ").trim();
    if (!line) continue;
    if (/^import\b/.test(line) || /^export .* from\b/.test(line)) continue;
    if (/^["']use strict["'];?$/.test(line)) continue;
    normalized.push({ line: index + 1, text: line });
  }

  return normalized;
}

function hashWindow(texts) {
  return createHash("sha1").update(texts.join("\n")).digest("hex");
}

function extension(relativePath) {
  return extname(relativePath);
}

function main() {
  const args = parseArgs();
  const config = readJsonFile(".quality/duplicate-code.json", {});
  const exclude = config.exclude ?? [];
  const updateBaseline = args.flags.has("update-baseline");

  const files = (gitTrackedFiles() ?? [])
    .map((file) => repoPath(file))
    .filter((relativePath) => [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs"].includes(extension(relativePath)))
    .filter((relativePath) => !isIgnoredPath(relativePath, { ignore: exclude }));

  const windows = new Map();
  const fileLines = new Map();

  for (const relativePath of files) {
    let text;
    try {
      text = readText(`${repoRoot}/${relativePath}`);
    } catch {
      continue;
    }
    const normalized = normalizeFile(text);
    fileLines.set(relativePath, normalized);
    for (let index = 0; index + WINDOW <= normalized.length; index += 1) {
      const slice = normalized.slice(index, index + WINDOW);
      const textSlice = slice.map((entry) => entry.text);
      if (textSlice.join("").length < MIN_CHARS) continue;
      const key = hashWindow(textSlice);
      if (!windows.has(key)) windows.set(key, []);
      windows.get(key).push({
        file: relativePath,
        index,
        line: slice[0].line,
        chars: textSlice.join("").length,
      });
    }
  }

  const reported = new Map();
  for (const [hash, positions] of windows) {
    if (positions.length < 2 || positions.length > 60) continue;
    const ordered = [...positions].sort(
      (left, right) => left.file.localeCompare(right.file) || left.index - right.index,
    );
    for (let leftIndex = 0; leftIndex < ordered.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex += 1) {
        const left = ordered[leftIndex];
        const right = ordered[rightIndex];
        if (left.file === right.file) continue;

        // Skip windows that continue a clone already reported one line above.
        if (left.index > 0 && right.index > 0) {
          const previousLeft = fileLines.get(left.file)[left.index - 1]?.text;
          const previousRight = fileLines.get(right.file)[right.index - 1]?.text;
          if (previousLeft && previousLeft === previousRight) continue;
        }

        const leftLines = fileLines.get(left.file).map((entry) => entry.text);
        const rightLines = fileLines.get(right.file).map((entry) => entry.text);
        let length = 0;
        while (
          left.index + length < leftLines.length &&
          right.index + length < rightLines.length &&
          leftLines[left.index + length] === rightLines[right.index + length]
        ) {
          length += 1;
        }
        if (length < WINDOW) continue;

        const key = `${left.file}::${right.file}::${hash}`;
        if (reported.has(key)) continue;
        reported.set(key, {
          file: right.file,
          line: right.line,
          key,
          message: `${length} duplicated lines copied from ${left.file}:${left.line}`,
          note: `block=${length}`,
        });
      }
    }
  }

  const findings = [...reported.values()].sort(
    (left, right) => left.file.localeCompare(right.file) || left.line - right.line,
  );

  if (updateBaseline) {
    const { count, path } = saveBaseline("duplicate-code", findings, (finding) => finding.key, {
      note: "Duplicate blocks that already existed. Extract shared helpers before adding new copies.",
    });
    process.stdout.write(`Wrote ${count} entries to ${repoPath(path)}\n`);
    return;
  }

  const baseline = loadBaseline("duplicate-code");
  const { newFindings, knownFindings } = splitByBaseline(findings, baseline, (finding) => finding.key);
  settle({
    title: "Duplicate code",
    newFindings,
    knownFindings,
    notes: [`Scanned ${files.length} source files with a ${WINDOW}-line window.`],
  });
}

main();
