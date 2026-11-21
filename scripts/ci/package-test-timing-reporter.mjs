import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { moduleDurationMs } from "./test-timing-reporter.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fallbackProject = basename(process.cwd());

/**
 * Vitest reporter for packages outside the root server lane.
 *
 * The root `test-timing-reporter` only emits records for the server inventory
 * that the duration refresh consumes. This reporter keeps one bounded JSON
 * report per project so the smaller packages also expose suite durations in CI
 * artifacts without changing the server timing contract.
 */
export default class PackageTimingReporter {
  constructor() {
    this.records = [];
    this.startedAt = Date.now();
    this.written = false;
  }

  onTestModuleEnd(module) {
    if (module.state() !== "passed") return;
    const durationMs = moduleDurationMs(module.diagnostic());
    if (durationMs === null) return;
    this.records.push({
      project: module.project?.name || fallbackProject,
      file: module.moduleId.split(repoRoot).join("").replace(/^[\\/]/, ""),
      durationMs,
    });
  }

  onTestRunEnd() {
    this.writeReport();
  }

  onFinished() {
    this.writeReport();
  }

  writeReport() {
    if (this.written) return;
    this.written = true;
    const project = this.records[0]?.project ?? fallbackProject;
    const payload = {
      version: 1,
      project,
      generatedAt: new Date().toISOString(),
      wallClockMs: Date.now() - this.startedAt,
      files: this.records.sort((left, right) => right.durationMs - left.durationMs),
    };
    const directory = resolve(repoRoot, ".quality", "reports", "test-timings");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, `${project.replace(/[^a-z0-9._-]+/gi, "-")}.json`), `${JSON.stringify(payload, null, 2)}\n`);
    const slowest = payload.files.slice(0, 3);
    process.stdout.write(
      `\nTest timing (${project}): ${payload.files.length} files, ${payload.wallClockMs}ms total\n` +
        slowest.map((entry) => `  ${entry.durationMs}ms ${entry.file}`).join("\n") +
        (slowest.length ? "\n" : ""),
    );
  }
}
