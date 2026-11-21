#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { gzipSync } from "node:zlib";

import { repoPath, repoRoot } from "./readiness/lib/files.mjs";
import { parseArgs, printTitle, readJsonFile, settle, writeJsonArtifact } from "./readiness/lib/report.mjs";

/**
 * Bundle budgets for every bundled Paperclip surface.
 *
 * `ui/dist` is the production board bundle, `cli/dist` is the esbuild CLI,
 * `packages/paperclip-runner/dist-browser` is the Runner browser SDK, and
 * `server/dist-runtime` is the bundled server runtime. Each target is measured
 * independently so a heavy dependency is attributed to the app that carries it.
 *
 * Usage:
 *   pnpm build && node scripts/check-bundle-size.mjs
 *   node scripts/check-bundle-size.mjs --require-build   # CI: UI required
 *   node scripts/check-bundle-size.mjs --only cli
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

function resolveTargets(config) {
  if (Array.isArray(config.targets) && config.targets.length > 0) return config.targets;
  return [
    {
      name: "ui",
      distDir: config.distDir ?? "ui/dist",
      requiredInCi: true,
      perChunkGzipBytes: config.perChunkGzipBytes,
      perChunkRawBytes: config.perChunkRawBytes,
      totalGzipBytes: config.totalGzipBytes,
      totalRawBytes: config.totalRawBytes,
    },
  ];
}

function main() {
  const args = parseArgs();
  const config = readJsonFile(".quality/bundle-budget.json", {});
  const requireBuild = args.flags.has("require-build");
  const only = args.values.get("only");
  const allTargets = resolveTargets(config);
  const targets = only ? allTargets.filter((target) => target.name === only) : allTargets;
  const findings = [];
  const notes = [];
  const report = { generatedAt: new Date().toISOString(), targets: [] };

  if (targets.length === 0) {
    process.stderr.write(`Unknown bundle target "${only}".\n`);
    process.exitCode = 2;
    return;
  }

  for (const target of targets) {
    const distDirectory = join(repoRoot, target.distDir);
    const assets = walkAssets(distDirectory);
    if (assets.length === 0) {
      const message = `${target.name}: no built assets in ${repoPath(distDirectory)}`;
      const required = target.requiredInCi ?? false;
      if (requireBuild && required) {
        findings.push({ key: `${target.name}::missing-build`, message: `${message}; build it before this check.` });
      } else {
        notes.push(`⚠ ${message} (skipped)`);
      }
      continue;
    }

    const measurements = assets.map((asset) => {
      const stats = statSync(asset);
      const raw = stats.size;
      const gzip = gzipSync(readFileSync(asset)).length;
      return { file: `${target.name}:${repoPath(asset)}`, raw, gzip };
    });
    measurements.sort((left, right) => right.gzip - left.gzip);

    const totalRaw = measurements.reduce((sum, entry) => sum + entry.raw, 0);
    const totalGzip = measurements.reduce((sum, entry) => sum + entry.gzip, 0);
    const perChunkGzip = target.perChunkGzipBytes ?? 1_500_000;
    const perChunkRaw = target.perChunkRawBytes ?? 4_000_000;
    const totalGzipBudget = target.totalGzipBytes ?? 8_000_000;
    const totalRawBudget = target.totalRawBytes ?? 30_000_000;

    for (const entry of measurements) {
      if (entry.gzip > perChunkGzip) {
        findings.push({
          file: entry.file,
          key: `${entry.file}::gzip`,
          message: `asset gzip size ${formatBytes(entry.gzip)} exceeds ${target.name} per-asset budget ${formatBytes(perChunkGzip)}`,
        });
      }
      if (entry.raw > perChunkRaw) {
        findings.push({
          file: entry.file,
          key: `${entry.file}::raw`,
          message: `asset raw size ${formatBytes(entry.raw)} exceeds ${target.name} per-asset budget ${formatBytes(perChunkRaw)}`,
        });
      }
    }
    if (totalGzip > totalGzipBudget) {
      findings.push({
        key: `${target.name}::total::gzip`,
        message: `${target.name} total gzip size ${formatBytes(totalGzip)} exceeds budget ${formatBytes(totalGzipBudget)}`,
      });
    }
    if (totalRaw > totalRawBudget) {
      findings.push({
        key: `${target.name}::total::raw`,
        message: `${target.name} total raw size ${formatBytes(totalRaw)} exceeds budget ${formatBytes(totalRawBudget)}`,
      });
    }

    notes.push(
      `${target.name}: ${measurements.length} assets, ${formatBytes(totalRaw)} raw / ${formatBytes(totalGzip)} gzip; top ${measurements[0].file} (${formatBytes(measurements[0].gzip)} gzip).`,
    );
    report.targets.push({
      name: target.name,
      distDir: target.distDir,
      assets: measurements.length,
      totalRaw,
      totalGzip,
      top: measurements.slice(0, 20),
    });
  }

  writeJsonArtifact(".quality/reports/bundle-size.json", report);

  if (report.targets.length === 0 && findings.length === 0) {
    printTitle("Bundle size");
    process.stdout.write(`  ⚠ No bundle builds found.\n${notes.map((note) => `  ${note}\n`).join("")}`);
    return;
  }

  settle({
    title: "Bundle size",
    newFindings: findings,
    notes: [...notes, "Report: .quality/reports/bundle-size.json"],
  });
}

main();
