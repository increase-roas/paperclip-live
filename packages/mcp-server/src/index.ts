import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PaperclipApiClient } from "./client.js";
import { readConfigFromEnv, type PaperclipMcpConfig } from "./config.js";
import { createToolDefinitions } from "./tools.js";
import { mcpProductAnalytics } from "./observability.js";

export function createPaperclipMcpServer(config: PaperclipMcpConfig = readConfigFromEnv()) {
  const server = new McpServer({
    name: "paperclip",
    version: "0.1.0",
  });

  const client = new PaperclipApiClient(config);
  const tools = createToolDefinitions(client);
  for (const tool of tools) {
    const execute = tool.execute;
    const tracked = async (input: Parameters<typeof execute>[0]) => {
      const startedAt = Date.now();
      try {
        const result = await execute(input);
        mcpProductAnalytics.capture("mcp_tool_called", {
          tool: tool.name,
          outcome: "ok",
          duration_ms: Date.now() - startedAt,
        });
        return result;
      } catch (error) {
        mcpProductAnalytics.capture("mcp_tool_called", {
          tool: tool.name,
          outcome: "error",
          duration_ms: Date.now() - startedAt,
        });
        throw error;
      }
    };
    server.tool(tool.name, tool.description, tool.schema.shape, tracked as typeof execute);
  }
  mcpProductAnalytics.capture("mcp_server_started", { tool_count: tools.length });

  return {
    server,
    tools,
    client,
  };
}

export async function runServer(config: PaperclipMcpConfig = readConfigFromEnv()) {
  const { server } = createPaperclipMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
