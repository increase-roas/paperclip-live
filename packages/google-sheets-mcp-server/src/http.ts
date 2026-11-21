import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createGoogleSheetsMcpServer } from "./index.js";
import type { GoogleSheetsMcpConfig } from "./config.js";
import { createGoogleSheetsClient, type GoogleSheetsClient } from "./google-client.js";
import {
  createSheetsLogger,
  newTraceContext,
  sheetsApiCircuit,
  sheetsMetrics,
} from "./observability.js";

const SERVER_STARTED_AT = Date.now();

export interface GoogleSheetsMcpHttpOptions {
  config: GoogleSheetsMcpConfig;
  client?: GoogleSheetsClient;
  /** Optional shared secret required on the MCP route when provided. */
  token?: string | null;
}

export interface GoogleSheetsMcpHttpServer {
  server: Server;
  /** Resolves to the bound port once listening. */
  listen: (port: number, host?: string) => Promise<number>;
  close: () => Promise<void>;
}

const MCP_PATH = "/mcp";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function presentedToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length).trim();
  return null;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > 1_000_000) throw new Error("Request body too large.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return undefined;
  return JSON.parse(raw);
}

async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  config: GoogleSheetsMcpConfig,
  client: GoogleSheetsClient,
): Promise<void> {
  let parsedBody: unknown;
  try {
    parsedBody = req.method === "POST" ? await readJsonBody(req) : undefined;
  } catch (error) {
    sendJson(res, 400, {
      jsonrpc: "2.0",
      error: { code: -32700, message: error instanceof Error ? error.message : "Parse error" },
      id: null,
    });
    return;
  }

  const { server } = createGoogleSheetsMcpServer(config, { client });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, parsedBody);
}

export function createGoogleSheetsMcpHttpServer(
  options: GoogleSheetsMcpHttpOptions,
): GoogleSheetsMcpHttpServer {
  const requiredToken = options.token?.trim() || null;
  const client = options.client ?? createGoogleSheetsClient(options.config.serviceAccount);

  const server = createServer((req, res) => {
    void (async () => {
      const trace = newTraceContext();
      const logger = createSheetsLogger(trace);
      res.setHeader("x-request-id", trace.requestId);
      try {
        const url = new URL(req.url ?? "/", "http://localhost");

        if (req.method === "GET" && url.pathname === "/healthz") {
          sendJson(res, 200, {
            status: "ok",
            service: "paperclip-google-sheets-mcp",
            uptimeMs: Date.now() - SERVER_STARTED_AT,
            circuit: sheetsApiCircuit.snapshot(),
          });
          return;
        }

        if (req.method === "GET" && url.pathname === "/metrics") {
          if (requiredToken && presentedToken(req) !== requiredToken) {
            sendJson(res, 401, { error: "Unauthorized. Provide GOOGLE_SHEETS_MCP_TOKEN." });
            return;
          }
          res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
          res.end(sheetsMetrics.render());
          return;
        }

        if (url.pathname !== MCP_PATH) {
          sendJson(res, 404, { error: "Not found." });
          return;
        }

        if (requiredToken && presentedToken(req) !== requiredToken) {
          sendJson(res, 401, { error: "Unauthorized. Provide GOOGLE_SHEETS_MCP_TOKEN." });
          return;
        }

        await handleMcp(req, res, options.config, client);
      } catch (error) {
        logger.error("Google Sheets MCP request failed", {
          path: req.url,
          error: error instanceof Error ? error.message : String(error),
        });
        if (!res.headersSent) {
          sendJson(res, 500, { error: error instanceof Error ? error.message : "Internal error." });
        } else {
          res.end();
        }
      }
    })();
  });

  return {
    server,
    listen: (port, host = "127.0.0.1") =>
      new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          const address = server.address();
          resolve(typeof address === "object" && address ? address.port : port);
        });
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
