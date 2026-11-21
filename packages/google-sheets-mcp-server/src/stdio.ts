#!/usr/bin/env node
import { readConfigFromEnv } from "./config.js";
import { runServer } from "./index.js";
import { sheetsApiCircuit, sheetsErrorTracker, sheetsMetrics } from "./observability.js";

if (process.argv.includes("--metrics")) {
  process.stdout.write(sheetsMetrics.render() || "# no metrics recorded\n");
  process.exit(0);
}

if (process.argv.includes("--health")) {
  try {
    const config = readConfigFromEnv();
    process.stdout.write(
      `${JSON.stringify({
        status: "ok",
        service: "paperclip-google-sheets-mcp",
        allowedSpreadsheets: config.allowedSpreadsheetIds.length,
        circuit: sheetsApiCircuit.snapshot(),
      }, null, 2)}\n`,
    );
    process.exit(0);
  } catch (error) {
    sheetsErrorTracker.capture(error, { tags: { surface: "google-sheets-mcp", phase: "health" } });
    process.stdout.write(
      `${JSON.stringify({
        status: "unhealthy",
        service: "paperclip-google-sheets-mcp",
        error: error instanceof Error ? error.message : String(error),
      }, null, 2)}\n`,
    );
    process.exit(1);
  }
}

void runServer().catch(async (error) => {
  sheetsErrorTracker.capture(error, { tags: { surface: "google-sheets-mcp", phase: "startup" } });
  await sheetsErrorTracker.flush(2_000);
  console.error("Failed to start Google Sheets MCP server:", error instanceof Error ? error.message : error);
  process.exit(1);
});
