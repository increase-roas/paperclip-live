#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { extname } from "node:path";

import { loadBaseline, saveBaseline, splitByBaseline } from "./readiness/lib/baselines.mjs";
import { gitTrackedFiles, isIgnoredPath, listFiles, readText, repoPath, stagedFiles } from "./readiness/lib/files.mjs";
import { parseArgs, printTitle, readJsonFile, settle } from "./readiness/lib/report.mjs";
import { formatSource } from "./readiness/lib/source-format.mjs";

/**
 * Repository formatter for the mechanical layer of the style contract:
 * UTF-8 without BOM, LF endings, no trailing whitespace, no whitespace-only
 * lines and exactly one final newline.
 *
 * The repository does not install a general TypeScript printer (adding one
 * would change the lockfile), so this checker owns the rules that can be
 * applied safely without parsing or re-printing code. Structural style is
 * covered by typecheck plus the naming and complexity checks.
 *
 * Usage:
 *   node scripts/check-source-format.mjs            # verify the worktree
 *   node scripts/check-source-format.mjs --write    # normalize in place
 *   node scripts/check-source-format.mjs --staged   # verify staged files only
 */

const FORMATTABLE_EXTENSIONS = new Set([
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
]);

const DEFAULT_IGNORE = [
  ".agents/skills/**/assets/**",
  "**/*.generated.ts",
  "**/generated/**",
  "docs/api/openapi.json",
  "packages/db/src/migrations/meta/**",
  "packages/paperclip-runner/**/*.lock",
  "report/**",
  "releases/**",
];

function main() {
  const args = parseArgs();
  const config = readJsonFile(".quality/source-format.json", { ignore: [] });
  const ignore = [...DEFAULT_IGNORE, ...(config.ignore ?? [])];
  const write = args.flags.has("write");
  const stagedOnly = args.flags.has("staged");

  const candidates = stagedOnly
    ? (stagedFiles() ?? []).filter((file) => FORMATTABLE_EXTENSIONS.has(extname(file)))
    : (gitTrackedFiles() ?? listFiles({ roots: ["."], extensions: FORMATTABLE_EXTENSIONS, ignore })).filter(
        (file) => FORMATTABLE_EXTENSIONS.has(extname(file)),
      );

  const files = candidates.filter((file) => !isIgnoredPath(repoPath(file), { ignore }));
  const findings = [];
  let rewritten = 0;

  for (const file of files) {
    let text;
    try {
      text = readText(file);
    } catch {
      continue;
    }
    const { formatted, violations } = formatSource(text, extname(file));
    if (!violations.length) continue;
    if (write) {
      writeFileSync(file, formatted);
      rewritten += 1;
      continue;
    }
    findings.push({
      file: repoPath(file),
      line: violations[0].line,
      key: repoPath(file),
      message: violations.map((violation) => violation.message).join("; "),
      detail: violations.length > 3 ? `${violations.length} rule violations` : undefined,
    });
  }

  if (write) {
    printTitle("Source format");
    process.stdout.write(
      `  ✔ Normalized ${rewritten} file${rewritten === 1 ? "" : "s"} (${files.length} checked).\n`,
    );
    return;
  }

  if (args.flags.has("update-baseline")) {
    const { count, path } = saveBaseline("format", findings, (finding) => finding.key, {
      note: "Files that still need normalization. Running `pnpm format` fixes them and makes these entries stale.",
    });
    process.stdout.write(`Wrote ${count} entries to ${repoPath(path)}\n`);
    return;
  }

  const baseline = loadBaseline("format");
  const { newFindings, knownFindings } = splitByBaseline(findings, baseline, (finding) => finding.key);
  settle({
    title: "Source format",
    newFindings,
    knownFindings,
    notes: [`Checked ${files.length} files. Run \`pnpm format\` to normalize them.`],
  });
}

main();
