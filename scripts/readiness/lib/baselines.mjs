import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { repoRoot } from "./files.mjs";

/**
 * Baseline ratchet shared by the readiness checks.
 *
 * A baseline records findings that already existed when a check was
 * introduced. The check still reports them (as known debt) and fails only on
 * new findings, so the rule becomes enforceable immediately without a
 * repository-wide rewrite in the same change.
 */

export function baselinePath(name) {
  return resolve(repoRoot, ".quality", "baselines", `${name}.json`);
}

export function loadBaseline(name) {
  const path = baselinePath(name);
  if (!existsSync(path)) return { version: 1, entries: [] };
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return {
    version: parsed.version ?? 1,
    entries: Array.isArray(parsed.entries) ? parsed.entries : [],
  };
}

export function splitByBaseline(findings, baseline, keyOf) {
  const knownKeys = new Set(baseline.entries.map((entry) => entry.key));
  const newFindings = [];
  const knownFindings = [];
  const seenKeys = new Set();
  for (const finding of findings) {
    const key = keyOf(finding);
    seenKeys.add(key);
    if (knownKeys.has(key)) knownFindings.push(finding);
    else newFindings.push(finding);
  }
  const staleEntries = baseline.entries.filter((entry) => !seenKeys.has(entry.key));
  return { newFindings, knownFindings, staleEntries };
}

export function saveBaseline(name, findings, keyOf, { note } = {}) {
  const entries = [...new Map(findings.map((finding) => {
    const key = keyOf(finding);
    return [key, {
      key,
      note: finding.note || undefined,
      file: finding.file,
      line: finding.line,
    }];
  })).values()].sort((left, right) => left.key.localeCompare(right.key));

  const path = baselinePath(name);
  mkdirSync(dirname(path), { recursive: true });
  const document = {
    version: 1,
    description:
      note ||
      "Acknowledged pre-existing findings. Checks fail only on entries that are not listed here.",
    generatedAt: new Date().toISOString().slice(0, 10),
    entries,
  };
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
  return { path, count: entries.length };
}

export function describeStale(staleEntries) {
  if (!staleEntries.length) return null;
  return `${staleEntries.length} baseline entr${staleEntries.length === 1 ? "y is" : "ies are"} stale; remove them with --update-baseline.`;
}
