import { createServer, type RequestListener, type ServerOptions } from "node:http";
import { setupPluginApiWebSocketServer } from "../realtime/plugin-api-ws.js";
import { setupRunnerPrpWebSocketServer } from "../realtime/runner-prp-ws.js";
import { registerLocalRuntimeApiServer } from "../runtime-api.js";
import { reserveShutdownListenerCapacity } from "./listener-capacity.js";

/** Create the HTTP listener used by both production and custom launchers. */
export function createPaperclipHttpServer(
  listener: RequestListener,
  options: { apiUrl: string; httpOptions?: ServerOptions },
) {
  const server = createServer(options.httpOptions ?? {}, listener);
  // The launcher registers one shutdown hook per worker at startup; reserve the
  // ceiling before any of them so every boot does not emit a listener warning.
  reserveShutdownListenerCapacity(server);
  registerLocalRuntimeApiServer(server);
  // Native execution uses the listener even when a launcher has no browser
  // realtime connection. Register it before any run can be admitted.
  setupRunnerPrpWebSocketServer(server);
  setupPluginApiWebSocketServer(server, listener);
  return server;
}
