#!/usr/bin/env node
import { readConfigFromEnv } from "./config.js";
import { runServer } from "./index.js";
import { mcpApiCircuit, mcpMetrics } from "./observability.js";

if (process.argv.includes("--metrics")) {
  process.stdout.write(mcpMetrics.render() || "# no metrics recorded\n");
  process.exit(0);
}

if (process.argv.includes("--health")) {
  try {
    const config = readConfigFromEnv();
    process.stdout.write(
      `${JSON.stringify({
        status: "ok",
        service: "paperclip-mcp-server",
        apiUrl: config.apiUrl,
        hasApiKey: Boolean(config.apiKey),
        circuit: mcpApiCircuit.snapshot(),
      }, null, 2)}\n`,
    );
    process.exit(0);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        status: "unhealthy",
        service: "paperclip-mcp-server",
        error: error instanceof Error ? error.message : String(error),
      }, null, 2)}\n`,
    );
    process.exit(1);
  }
}

void runServer().catch((error) => {
  console.error("Failed to start Paperclip MCP server:", error);
  process.exit(1);
});
