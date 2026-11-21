#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { gzipSync } from "node:zlib";

import { repoPath, repoRoot } from "./readiness/lib/files.mjs";
import { parseArgs, readJsonFile, settle, writeJsonArtifact } from "./readiness/lib/report.mjs";

/**
 * Bundle budget check for the Vite UI.
 *
 * Reads the production build (ui/dist), measures every emitted JS/CSS asset,
 * and compares raw and gzip sizes against .quality/bundle-budget.json. The
 * report ranks the heaviest assets, which is how a large new dependency
 * becomes visible in review.
 *
 * Usage:
 *   pnpm --filter @paperclipai/ui build && node scripts/check-bundle-size.mjs
 * The check treats a missing build as skipped unless --require-build is given
 * (CI passes it after building).
 */

const MEASURED_EXTENSIONS = new Set([".js", ".mjs", ".css"]);

function walkAssets(directory, results = []) {
  if (!existsSync(directory)) return results;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) walkAssets(absolutePath, results);
    else if (entry.isFile() && MEASURED_EXTENSIONS.has(extname(entry.name))) results.push(absolutePath);
  }
  return results;
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

function main() {
  const args = parseArgs();
  const config = readJsonFile(".quality/bundle-budget.json", {});
  const distDirectory = join(repoRoot, config.distDir ?? "ui/dist");
  const requireBuild = args.flags.has("require-build");
  const assets = walkAssets(distDirectory);

  if (assets.length === 0) {
    const message = `No built assets found in ${repoPath(distDirectory)}. Build the UI first.`;
    if (requireBuild) {
      settle({ title: "Bundle size", newFindings: [{ message, key: "missing-build" }] });
    } else {
      process.stdout.write(`Bundle size\n------------\n  ⚠ ${message} (skipped)\n`);
    }
    return;
  }

  const measurements = assets.map((asset) => {
    const stats = statSync(asset);
    const raw = stats.size;
    const gzip = gzipSync(readFileSync(asset)).length;
    return { file: repoPath(asset), raw, gzip };
  });
  measurements.sort((left, right) => right.gzip - left.gzip);

  const totalRaw = measurements.reduce((sum, entry) => sum + entry.raw, 0);
  const totalGzip = measurements.reduce((sum, entry) => sum + entry.gzip, 0);
  const perChunkGzip = config.perChunkGzipBytes ?? 1_500_000;
  const perChunkRaw = config.perChunkRawBytes ?? 4_000_000;
  const totalGzipBudget = config.totalGzipBytes ?? 8_000_000;
  const totalRawBudget = config.totalRawBytes ?? 30_000_000;

  const findings = [];
  for (const entry of measurements) {
    if (entry.gzip > perChunkGzip) {
      findings.push({
        file: entry.file,
        key: `${entry.file}::gzip`,
        message: `asset gzip size ${formatBytes(entry.gzip)} exceeds per-asset budget ${formatBytes(perChunkGzip)}`,
      });
    }
    if (entry.raw > perChunkRaw) {
      findings.push({
        file: entry.file,
        key: `${entry.file}::raw`,
        message: `asset raw size ${formatBytes(entry.raw)} exceeds per-asset budget ${formatBytes(perChunkRaw)}`,
      });
    }
  }
  if (totalGzip > totalGzipBudget) {
    findings.push({
      key: "total::gzip",
      message: `total gzip size ${formatBytes(totalGzip)} exceeds budget ${formatBytes(totalGzipBudget)}`,
    });
  }
  if (totalRaw > totalRawBudget) {
    findings.push({
      key: "total::raw",
      message: `total raw size ${formatBytes(totalRaw)} exceeds budget ${formatBytes(totalRawBudget)}`,
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    assets: measurements.length,
    totalRaw,
    totalGzip,
    top: measurements.slice(0, 20),
  };
  writeJsonArtifact(".quality/reports/bundle-size.json", report);

  settle({
    title: "Bundle size",
    newFindings: findings,
    notes: [
      `${measurements.length} assets: ${formatBytes(totalRaw)} raw, ${formatBytes(totalGzip)} gzip.`,
      `Top asset: ${measurements[0].file} (${formatBytes(measurements[0].gzip)} gzip).`,
      "Report: .quality/reports/bundle-size.json",
    ],
  });
}

main();
