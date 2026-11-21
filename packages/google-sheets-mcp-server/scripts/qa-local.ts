#!/usr/bin/env node

/**
 * Local Google Sheets MCP QA with an in-memory client.
 *
 * Starts the real Streamable HTTP MCP server, then drives `/healthz`,
 * `/metrics`, tool discovery and one tool call. No Google service account or
 * network access is required, so an agent can exercise the full transport path
 * on a laptop.
 *
 * Run with:
 *   pnpm --filter @paperclipai/google-sheets-mcp-server qa:local
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createGoogleSheetsMcpHttpServer } from "../src/http.js";
import type { GoogleSheetsClient, SpreadsheetSummary } from "../src/google-client.js";

const spreadsheet: SpreadsheetSummary = {
  spreadsheetId: "sheet-qa-1",
  title: "QA Budget",
  spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-qa-1",
};

const client: GoogleSheetsClient = {
  async listSpreadsheets() {
    return [spreadsheet];
  },
  async getSpreadsheetInfo() {
    return { ...spreadsheet, sheets: [{ sheetId: 1, title: "Sheet1", index: 0, rowCount: 10, columnCount: 5 }] };
  },
  async readValues(_spreadsheetId, range) {
    return { spreadsheetId: "sheet-qa-1", range, values: [["item", "cost"], ["hosting", "10"]] };
  },
  async searchRows({ spreadsheetId, range, query }) {
    return { spreadsheetId, range, query, matches: [{ rowIndex: 1, values: ["hosting", "10"] }] };
  },
  async appendRows({ spreadsheetId, range }) {
    return { spreadsheetId, range, updatedRows: 1, updatedCells: 2 };
  },
  async updateValues({ spreadsheetId, range }) {
    return { spreadsheetId, range, updatedRows: 1, updatedCells: 2 };
  },
  async addSheetTab({ spreadsheetId, title }) {
    return { spreadsheetId, sheet: { sheetId: 2, title, index: 1, rowCount: 10, columnCount: 5 } };
  },
  async clearValues(spreadsheetId, range) {
    return { spreadsheetId, range, updatedCells: 0 };
  },
  async deleteRows({ spreadsheetId, sheetId, startIndex, endIndex }) {
    return { spreadsheetId, sheetId, deletedRows: endIndex - startIndex };
  },
};

const server = createGoogleSheetsMcpHttpServer({
  config: {
    serviceAccount: { client_email: "qa@example.test", private_key: "qa-local-placeholder-key" },
    allowedSpreadsheetIds: ["sheet-qa-1"],
    secretRedactions: ["qa@example.test"],
  },
  client,
});

try {
  const port = await server.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${port}`;
  const health = await fetch(`${base}/healthz`).then((response) => response.json());
  const metrics = await fetch(`${base}/metrics`).then((response) => response.text());
  console.log("health:", JSON.stringify(health));
  console.log("metrics contains tool counter:", metrics.includes("paperclip_google_sheets_api_requests_total"));

  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
  const mcp = new Client({ name: "paperclip-google-sheets-qa", version: "1.0.0" }, { capabilities: {} });
  await mcp.connect(transport);

  const tools = await mcp.listTools();
  console.log("tools:", tools.tools.map((tool) => tool.name).join(","));

  const result = await mcp.callTool({ name: "list_spreadsheets", arguments: {} });
  console.log("list_spreadsheets:", JSON.stringify(result.content));

  await mcp.close();
} finally {
  await server.close();
}
