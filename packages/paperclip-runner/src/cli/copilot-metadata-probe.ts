#!/usr/bin/env node
import { probeCopilotMetadata } from "../drivers/copilot-metadata-probe.js";
import { runnerMetrics } from "../observability.js";
const result = await probeCopilotMetadata(process.env.COPILOT_GITHUB_TOKEN ?? "", process.env.PAPERCLIP_COPILOT_PROBE_MODEL);
process.stdout.write(`${JSON.stringify(result)}\n`);
if (process.argv.includes("--metrics") || process.env.PAPERCLIP_METRICS === "1") {
  process.stderr.write(`${JSON.stringify(runnerMetrics.snapshot())}\n`);
}
if (result.status === "failed") process.exitCode = 1;
