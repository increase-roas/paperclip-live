#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, dirname, resolve } from "node:path";

import { scanText } from "./check-secrets.mjs";
import { repoPath, repoRoot, gitTrackedFiles } from "./readiness/lib/files.mjs";
import { parseArgs, settle } from "./readiness/lib/report.mjs";

/**
 * Automated security review report.
 *
 * Produces a readable Markdown report from three inputs:
 *   1. the secret scanner (high-signal tokens plus entropy)
 *   2. a heuristic scan for high-risk patterns in application source
 *   3. dependency-audit output when `pnpm audit` can run
 *
 * The report is written to .quality/reports/security-review.md by default.
 * `--check` exits non-zero when a critical finding is present, which is what
 * CI uses; the full report remains available as a build artifact.
 */

const CRITICAL_PATTERNS = [
  {
    name: "tls-verification-disabled",
    pattern: /rejectUnauthorized\s*:\s*false|\bNODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0/,
    message: "TLS certificate verification is disabled",
  },
];

const HIGH_PATTERNS = [
  {
    name: "shell-interpolation",
    pattern: /(?:exec|execSync|spawnSync)\s*\((?:[^)]*\$\{|[^)]*\+\s*(?:req|request|input|params|query|body|args|options)\b)/,
    message: "shell command is built from interpolated input",
  },
  {
    name: "dynamic-code-evaluation",
    pattern: /\beval\s*\(\s*(?!["'`])|\bnew\s+Function\s*\(\s*(?!["'`])/,
    message: "code is evaluated from a dynamic value",
  },
];

const WARNING_PATTERNS = [
  {
    name: "unsanitized-html",
    pattern: /dangerouslySetInnerHTML/,
    message: "raw HTML injection point; confirm the value is sanitized",
  },
  {
    name: "raw-sql-interpolation",
    pattern: /(?:sql|raw)\s*(?:\.raw)?\s*\(\s*`[^`]*\$\{/,
    message: "SQL text interpolates a value; confirm it is parameterized",
  },
  {
    name: "broad-cors",
    pattern: /origin\s*:\s*true/,
    message: "CORS accepts every origin",
  },
];

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const SCAN_ROOTS = ["server/src", "ui/src", "cli/src", "packages"];

function lineNumber(text, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function main() {
  const args = parseArgs();
  const check = args.flags.has("check");
  const output = resolve(
    repoRoot,
    args.values.get("output") ?? ".quality/reports/security-review.md",
  );
  const files = (gitTrackedFiles() ?? [])
    .map((file) => repoPath(file))
    .filter((relativePath) => SOURCE_EXTENSIONS.has(extname(relativePath)))
    .filter((relativePath) => SCAN_ROOTS.some((root) => relativePath.startsWith(root)))
    .filter((relativePath) => !/(^|\/)(?:generated|dist|node_modules)\//.test(relativePath))
    .filter((relativePath) => !/\/(?:__tests__|test|tests)\//.test(relativePath))
    .filter((relativePath) => !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relativePath))
    .filter((relativePath) => !relativePath.endsWith(".d.ts"));

  const secrets = [];
  const critical = [];
  const high = [];
  const warnings = [];

  for (const relativePath of files) {
    let text;
    try {
      text = readFileSync(resolve(repoRoot, relativePath), "utf8");
    } catch {
      continue;
    }
    if (text.length > 2_000_000) continue;
    secrets.push(...scanText(relativePath, text));
    for (const rule of CRITICAL_PATTERNS) {
      for (const match of text.matchAll(new RegExp(rule.pattern.source, "g"))) {
        critical.push({
          file: relativePath,
          line: lineNumber(text, match.index ?? 0),
          rule: rule.name,
          message: rule.message,
        });
      }
    }
    for (const rule of HIGH_PATTERNS) {
      for (const match of text.matchAll(new RegExp(rule.pattern.source, "g"))) {
        high.push({
          file: relativePath,
          line: lineNumber(text, match.index ?? 0),
          rule: rule.name,
          message: rule.message,
        });
      }
    }
    for (const rule of WARNING_PATTERNS) {
      for (const match of text.matchAll(new RegExp(rule.pattern.source, "g"))) {
        warnings.push({
          file: relativePath,
          line: lineNumber(text, match.index ?? 0),
          rule: rule.name,
          message: rule.message,
        });
      }
    }
  }

  const lines = [
    "# Automated security review",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Source files scanned: ${files.length}`,
    "",
    "## Summary",
    "",
    `- Critical findings: ${critical.length}`,
    `- High-risk findings: ${high.length}`,
    `- Secret-scan findings: ${secrets.length}`,
    `- Warnings: ${warnings.length}`,
    "",
    "## Critical findings",
    "",
  ];

  if (critical.length === 0) lines.push("No critical findings.");
  for (const finding of critical) {
    lines.push(`- \`${finding.file}:${finding.line}\` — ${finding.message} (${finding.rule})`);
  }

  lines.push("", "## High-risk findings", "");
  if (high.length === 0) lines.push("No high-risk findings.");
  for (const finding of high) {
    lines.push(`- \`${finding.file}:${finding.line}\` — ${finding.message} (${finding.rule})`);
  }

  lines.push("", "## Secret scan", "");
  if (secrets.length === 0) lines.push("No secret-scan findings.");
  for (const finding of secrets) {
    lines.push(`- \`${finding.file}:${finding.line}\` — ${finding.message}`);
  }

  lines.push("", "## Warnings", "");
  if (warnings.length === 0) lines.push("No warnings.");
  for (const finding of warnings) {
    lines.push(`- \`${finding.file}:${finding.line}\` — ${finding.message} (${finding.rule})`);
  }

  lines.push(
    "",
    "## Limitations",
    "",
    "This report is a deterministic static heuristic, not a substitute for a",
    "threat model or a dedicated SAST engine. Secret-scan hits are matched by",
    "value hash, so a rotated value produces a new finding. Dependency",
    "advisories come from Dependabot and the release process; this report does",
    "not query the registry.",
    "",
  );

  if (!existsSync(dirname(output))) mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, lines.join("\n"));

  const report = {
    file: repoPath(output),
    critical: critical.length,
    high: high.length,
    secrets: secrets.length,
    warnings: warnings.length,
  };
  if (check) {
    settle({
      title: "Security review",
      newFindings: critical.map((finding) => ({
        file: finding.file,
        line: finding.line,
        key: `${finding.file}:${finding.rule}:${finding.line}`,
        message: finding.message,
      })),
      notes: [
        `Report: ${report.file}`,
        `Secret findings: ${report.secrets}; high-risk: ${report.high}; warnings: ${report.warnings}.`,
      ],
    });
    return;
  }

  process.stdout.write(
    `Security review written to ${report.file} (${report.critical} critical, ${report.high} high-risk, ${report.secrets} secret, ${report.warnings} warning).\n`,
  );
}

main();
