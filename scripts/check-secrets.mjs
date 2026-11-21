#!/usr/bin/env node

import { createHash } from "node:crypto";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadBaseline, saveBaseline, splitByBaseline } from "./readiness/lib/baselines.mjs";
import {
  gitTrackedFiles,
  isIgnoredPath,
  readText,
  repoPath,
  stagedFiles,
} from "./readiness/lib/files.mjs";
import { parseArgs, readJsonFile, settle } from "./readiness/lib/report.mjs";

/**
 * Secret scanner.
 *
 * High-signal token formats (cloud keys, GitHub/Slack/Stripe/OpenAI tokens,
 * private key blocks, JWTs) plus an entropy check for long values assigned to
 * secret-like names. The matched value is never printed: findings show a
 * masked prefix and a hash, and the baseline stores only the hash.
 *
 * Usage:
 *   node scripts/check-secrets.mjs            # whole worktree
 *   node scripts/check-secrets.mjs --staged   # pre-commit
 */

const PATTERNS = [
  { name: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { name: "github-pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { name: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "stripe-key", pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
  { name: "openai-key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/g },
  { name: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9-]{20,}\b/g },
  { name: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "private-key-block", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
];

const GENERIC_ASSIGNMENT =
  /(?:api[_-]?key|apikey|secret|token|password|passwd|private[_-]?key)\s*[:=]\s*["'`]([^"'`\s]{16,})["'`]/gi;

const PLACEHOLDER = /(?:process\.env|import\.meta\.env|<[^>]+>|example|placeholder|changeme|change-me|dummy|sample|your[-_]|test[-_]|fake|xxx+|\.\.\.|redacted|token-here|\[)/i;

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
  ".wasm",
]);

const EXCLUDED_EXTENSIONS = new Set([".lock"]);

function shannonEntropy(value) {
  const counts = new Map();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function mask(value) {
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 4)}…${value.slice(-2)}`;
}

function findingFor(relativePath, line, patternName, value) {
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return {
    file: relativePath,
    line,
    key: `${relativePath}::${patternName}::${hash}`,
    message: `possible ${patternName} secret (${mask(value)})`,
    detail: "Move it to a secret store or environment variable; never commit the value.",
  };
}

export function scanText(relativePath, text) {
  const findings = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const { name, pattern } of PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of line.matchAll(pattern)) {
        findings.push(findingFor(relativePath, index + 1, name, match[0]));
      }
    }
    GENERIC_ASSIGNMENT.lastIndex = 0;
    for (const match of line.matchAll(GENERIC_ASSIGNMENT)) {
      const value = match[1];
      if (PLACEHOLDER.test(value)) continue;
      if (/^[a-z0-9-]+$/i.test(value) && !/[0-9]/.test(value)) continue;
      if (shannonEntropy(value) < 4.2) continue;
      findings.push(findingFor(relativePath, index + 1, "high-entropy-credential", value));
    }
  }
  return findings;
}

function main() {
  const args = parseArgs();
  const config = readJsonFile(".quality/secrets.json", {});
  const exclude = config.exclude ?? [];
  const stagedOnly = args.flags.has("staged");
  const candidates = stagedOnly
    ? (stagedFiles() ?? [])
    : (gitTrackedFiles() ?? []);

  const findings = [];
  for (const file of candidates) {
    const relativePath = repoPath(file);
    if (!relativePath || relativePath.startsWith("..")) continue;
    const extension = extname(relativePath);
    if (BINARY_EXTENSIONS.has(extension) || EXCLUDED_EXTENSIONS.has(extension)) continue;
    if (isIgnoredPath(relativePath, { ignore: exclude })) continue;
    let text;
    try {
      text = readText(file);
    } catch {
      continue;
    }
    if (text.length > 2_000_000) continue;
    findings.push(...scanText(relativePath, text));
  }

  if (args.flags.has("update-baseline")) {
    const { count, path } = saveBaseline("secrets", findings, (finding) => finding.key, {
      note: "Values that look like secrets but are verified placeholders or fixtures. The stored hash changes if the value changes.",
    });
    process.stdout.write(`Wrote ${count} entries to ${repoPath(path)}\n`);
    return;
  }

  const baseline = loadBaseline("secrets");
  const { newFindings, knownFindings } = splitByBaseline(findings, baseline, (finding) => finding.key);
  settle({
    title: "Secret scanning",
    newFindings,
    knownFindings,
    notes: [`Scanned ${candidates.length} files.`],
  });
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
