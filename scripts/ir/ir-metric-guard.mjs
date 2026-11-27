#!/usr/bin/env node
// IR metric guard: rejects inline metric formulas, static client counts and
// hardcoded GHL / Meta account IDs in ui/src/ir and server/src/ir. Metrics are computed only by
// packages/shared/src/ir-metrics.ts; account IDs are configuration.
//
// Usage: node scripts/ir/ir-metric-guard.mjs [root]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const SCANNED_DIRS = ["ui/src/ir", "server/src/ir"];

const NUMERATOR = /(showed|shows|pitched|offers|won|wins|spend|clicks|revenue|booked|sold)/i;
const DENOMINATOR = /(booked|bookings|showed|shows|pitched|offers|lost|leads|impressions|spend|won|wins|acquisitions|sold)/i;
const OPERAND = String.raw`[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*(?:\s*\?\?\s*0)?`;
const DIVISION = new RegExp(String.raw`\(?\s*(${OPERAND})\s*\)?\s*\/\s*\(?\s*(${OPERAND})`, "g");

const ID_RULES = [
  { name: "Meta ad account ID", pattern: /\bact_\d{6,}\b/g },
  { name: "Meta numeric account ID", pattern: /["'`]\d{15,17}["'`]/g },
  {
    name: "GHL location or company ID",
    pattern: /["'`/]([A-Za-z0-9]{20})["'`/]/g,
    accept: (match) => /\d/.test(match[1]) && /[a-z]/.test(match[1]) && /[A-Z]/.test(match[1]),
  },
];

function isTestFile(path) {
  return /(^|\/)__tests__\//.test(path) || /\.(test|spec|stories)\.[cm]?[jt]sx?$/.test(path);
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.[cm]?[jt]sx?$/.test(entry)) out.push(full);
  }
  return out;
}

function stripComment(line) {
  const trimmed = line.trim();
  if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return "";
  const idx = line.indexOf("//");
  return idx >= 0 && !/https?:$/.test(line.slice(0, idx)) ? line.slice(0, idx) : line;
}

function lastSegment(operand) {
  const parts = operand.replace(/\?\?\s*0/, "").split(/\??\./);
  return parts[parts.length - 1].trim();
}

/** Findings for one file's source text. */
export function checkSource(path, source) {
  const findings = [];
  const lines = source.split("\n");
  lines.forEach((raw, index) => {
    const line = stripComment(raw);
    if (!line) return;
    for (const match of line.matchAll(DIVISION)) {
      const numerator = lastSegment(match[1]);
      const denominator = lastSegment(match[2]);
      if (NUMERATOR.test(numerator) && DENOMINATOR.test(denominator)) {
        findings.push({
          path,
          line: index + 1,
          rule: "inline-metric-formula",
          message: `"${numerator} / ${denominator}" is a metric formula; use @paperclipai/shared/ir-metrics`,
        });
      }
    }
    if (/active\s+clients?\s*[:=]?\s*\d+/i.test(line)) {
      findings.push({ path, line: index + 1, rule: "static-client-count", message: "client counts come from live data (ir-metrics#clientStatusCounts)" });
    }
    for (const rule of ID_RULES) {
      for (const match of raw.matchAll(rule.pattern)) {
        if (rule.accept && !rule.accept(match)) continue;
        findings.push({ path, line: index + 1, rule: "hardcoded-account-id", message: `${rule.name} in code; read it from config` });
      }
    }
  });
  return findings;
}

export function checkRepo(root) {
  const findings = [];
  for (const dir of SCANNED_DIRS) {
    for (const file of walk(join(root, dir))) {
      const rel = relative(root, file).split("\\").join("/");
      if (isTestFile(rel)) continue;
      findings.push(...checkSource(rel, readFileSync(file, "utf8")));
    }
  }
  return findings;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = process.argv[2] ?? process.cwd();
  const findings = checkRepo(root);
  for (const f of findings) console.error(`${f.path}:${f.line}: [${f.rule}] ${f.message}`);
  if (findings.length > 0) {
    console.error(`\nIR metric guard: ${findings.length} finding(s).`);
    process.exit(1);
  }
  console.log(`IR metric guard: clean (${SCANNED_DIRS.join(", ")}).`);
}
