import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import {
  reserveShutdownListenerCapacity,
  SHUTDOWN_LISTENER_CAPACITY,
} from "./listener-capacity.js";
import { createPaperclipHttpServer } from "./server.js";

describe("shutdown listener capacity", () => {
  it("raises Node's default ceiling before the shutdown hooks are registered", () => {
    const server = createServer();
    expect(server.getMaxListeners()).toBe(10);

    reserveShutdownListenerCapacity(server);

    expect(server.getMaxListeners()).toBe(SHUTDOWN_LISTENER_CAPACITY);
  });

  it("keeps twelve startup close hooks from exceeding the ceiling", () => {
    const server = createServer();
    reserveShutdownListenerCapacity(server);
    for (let index = 0; index < 12; index += 1) server.on("close", () => {});

    expect(server.listenerCount("close")).toBe(12);
    expect(server.listenerCount("close")).toBeLessThanOrEqual(
      server.getMaxListeners(),
    );
  });

  it("never lowers a ceiling that is already higher", () => {
    const server = createServer();
    server.setMaxListeners(100);

    reserveShutdownListenerCapacity(server);

    expect(server.getMaxListeners()).toBe(100);
  });

  it("is idempotent", () => {
    const server = createServer();
    reserveShutdownListenerCapacity(server);
    reserveShutdownListenerCapacity(server);

    expect(server.getMaxListeners()).toBe(SHUTDOWN_LISTENER_CAPACITY);
  });
});

describe("the server every launcher gets", () => {
  it("already has room for the startup shutdown hooks", () => {
    const server = createPaperclipHttpServer(
      (_request, response) => response.end("ok"),
      {
        apiUrl: "http://127.0.0.1:0",
      },
    );
    try {
      const baseline = server.listenerCount("close");
      for (let index = 0; index < 12; index += 1) server.on("close", () => {});
      expect(server.getMaxListeners()).toBe(SHUTDOWN_LISTENER_CAPACITY);
      expect(server.listenerCount("close")).toBe(baseline + 12);
    } finally {
      server.close();
    }
  });
});
