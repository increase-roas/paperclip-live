import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createPaperclipMcpServer } from "./index.js";
import { mcpMetrics } from "./observability.js";

interface CapturedRequest {
  url: string;
  method: string;
  headers: IncomingHttpHeaders;
}

const servers: Server[] = [];

async function startFakePaperclipApi(): Promise<{ apiUrl: string; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  const api = createServer((req, res) => {
    requests.push({ url: req.url ?? "", method: req.method ?? "GET", headers: req.headers });
    const send = (body: unknown) => {
      const payload = JSON.stringify(body);
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
      res.end(payload);
    };
    if (req.url === "/api/agents/me") {
      send({ id: "agent-1", name: "Ada", companyId: "company-1" });
      return;
    }
    if (req.url?.startsWith("/api/companies/company-1/issues")) {
      send([{ id: "issue-1", identifier: "PAP-1", title: "Ship the integration test" }]);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  servers.push(api);
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  const address = api.address();
  if (typeof address !== "object" || address === null) throw new Error("Expected a bound TCP address");
  return { apiUrl: `http://127.0.0.1:${address.port}`, requests };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

describe("Paperclip MCP server integration", () => {
  it("serves tools over the MCP transport and forwards trace headers to the API", async () => {
    const { apiUrl, requests } = await startFakePaperclipApi();
    const { server } = createPaperclipMcpServer({
      apiUrl: `${apiUrl}/api`,
      apiKey: "token-123",
      companyId: "company-1",
      agentId: "agent-1",
      runId: null,
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "paperclip-mcp-integration", version: "1.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);

    try {
      const me = await client.callTool({ name: "paperclipMe", arguments: {} });
      expect(me.isError).not.toBe(true);
      expect(me.content).toEqual([
        expect.objectContaining({ type: "text", text: expect.stringContaining('"agent-1"') }),
      ]);

      const issues = await client.callTool({ name: "paperclipListIssues", arguments: {} });
      expect(issues.isError).not.toBe(true);
      expect(issues.content).toEqual([
        expect.objectContaining({ type: "text", text: expect.stringContaining("PAP-1") }),
      ]);

      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.headers.authorization).toBe("Bearer token-123");
        expect(request.headers["x-request-id"]).toMatch(/^[0-9a-f]{16}$/);
        expect(request.headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
      }

      const metricNames = mcpMetrics.snapshot().map((entry) => entry.name);
      expect(metricNames).toContain("paperclip_mcp_api_requests_total");
      expect(metricNames).toContain("paperclip_mcp_api_request_duration_ms");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns an error result when the API rejects the request", async () => {
    const { apiUrl } = await startFakePaperclipApi();
    const { server } = createPaperclipMcpServer({
      apiUrl: `${apiUrl}/api`,
      apiKey: "token-123",
      companyId: "company-1",
      agentId: null,
      runId: null,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "paperclip-mcp-integration", version: "1.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({ name: "paperclipGetAgent", arguments: { agentId: "missing" } });
      expect(result.content).toEqual([
        expect.objectContaining({ type: "text", text: expect.stringContaining("404") }),
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
