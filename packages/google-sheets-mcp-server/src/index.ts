import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readConfigFromEnv, type GoogleSheetsMcpConfig } from "./config.js";
import { createGoogleSheetsClient, type GoogleSheetsClient } from "./google-client.js";
import { guardGoogleSheetsClient, sheetsProductAnalytics } from "./observability.js";
import { createToolDefinitions } from "./tools.js";

export interface CreateGoogleSheetsMcpServerOptions {
  client?: GoogleSheetsClient;
}

export function createGoogleSheetsMcpServer(
  config: GoogleSheetsMcpConfig = readConfigFromEnv(),
  options: CreateGoogleSheetsMcpServerOptions = {},
) {
  const server = new McpServer({
    name: "paperclip-google-sheets",
    version: "0.1.0",
  });

  const client = guardGoogleSheetsClient(
    options.client ?? createGoogleSheetsClient(config.serviceAccount),
  );
  const tools = createToolDefinitions({
    client,
    allowedSpreadsheetIds: config.allowedSpreadsheetIds,
    secretRedactions: config.secretRedactions,
  });

  for (const tool of tools) {
    const execute = tool.execute;
    const tracked = async (input: Parameters<typeof execute>[0]) => {
      const startedAt = Date.now();
      try {
        const result = await execute(input);
        sheetsProductAnalytics.capture("sheets_tool_called", {
          tool: tool.name,
          outcome: "ok",
          duration_ms: Date.now() - startedAt,
        });
        return result;
      } catch (error) {
        sheetsProductAnalytics.capture("sheets_tool_called", {
          tool: tool.name,
          outcome: "error",
          duration_ms: Date.now() - startedAt,
        });
        throw error;
      }
    };
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.schema.shape,
        annotations: tool.annotations,
      },
      tracked as typeof execute,
    );
  }
  sheetsProductAnalytics.capture("sheets_server_started", { tool_count: tools.length });

  return {
    server,
    tools,
    client,
  };
}

export async function runServer(config: GoogleSheetsMcpConfig = readConfigFromEnv()) {
  const { server } = createGoogleSheetsMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export { createGoogleSheetsClient } from "./google-client.js";
export { createToolDefinitions } from "./tools.js";
export type { GoogleSheetsMcpConfig } from "./config.js";
export type { GoogleSheetsClient } from "./google-client.js";
