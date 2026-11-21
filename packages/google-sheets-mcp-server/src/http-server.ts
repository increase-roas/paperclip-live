#!/usr/bin/env node
import { readHttpConfigFromEnv } from "./config.js";
import { createGoogleSheetsMcpHttpServer } from "./http.js";
import { createSheetsLogger, sheetsErrorTracker } from "./observability.js";

async function main(): Promise<void> {
  const logger = createSheetsLogger();
  const config = readHttpConfigFromEnv();
  const { listen } = createGoogleSheetsMcpHttpServer({
    config: config.mcpConfig,
    token: config.token,
  });
  const port = await listen(config.port, config.host);
  const base = `http://${config.host}:${port}`;

  logger.info("Google Sheets MCP HTTP server listening", {
    base,
    mcpEndpoint: `${base}/mcp`,
    healthEndpoint: `${base}/healthz`,
    metricsEndpoint: `${base}/metrics`,
    tokenRequired: Boolean(config.token),
  });
}

void main().catch(async (error) => {
  sheetsErrorTracker.capture(error, { tags: { surface: "google-sheets-mcp", transport: "http" } });
  await sheetsErrorTracker.flush(2_000);
  createSheetsLogger().error("Failed to start Google Sheets MCP HTTP server", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
