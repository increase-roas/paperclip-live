import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import {
  createPluginStreamBus,
  createPluginStreamPublisher,
  type PluginStreamBus,
  type StreamEventType,
} from "../services/plugin-stream-bus.js";
import { pluginRoutes } from "../routes/plugins.js";

function fakeBus() {
  const publish = vi.fn<(pluginId: string, channel: string, companyId: string, event: unknown, eventType?: StreamEventType) => void>();
  const bus: PluginStreamBus = { subscribe: () => () => {}, publish };
  return { bus, publish };
}

function boardApp(options: { streamBus?: PluginStreamBus } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "board-user",
      userName: "Board User",
      userEmail: null,
      isInstanceAdmin: true,
      source: "local_implicit",
      companyIds: [],
    };
    next();
  });
  app.use(
    "/api",
    pluginRoutes(
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      options.streamBus ? { workerManager: {} as never, streamBus: options.streamBus } : { workerManager: {} as never },
    ),
  );
  app.use((error: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status ?? 500).json({ error: error.message });
  });
  return app;
}

describe("plugin stream bridge", () => {
  it("answers 501 when the server has no stream bus wired", async () => {
    await request(boardApp())
      .get("/api/plugins/plugin-1/bridge/stream/channel-1?companyId=company-1")
      .expect(501);
  });

  it("reaches the stream route when a bus is wired and rejects a missing company", async () => {
    // 400 here proves the route passed the bridge-deps check: before the bus was
    // wired every request stopped at 501, which is how the Jarvis runs page
    // silently lost its live stream.
    await request(boardApp({ streamBus: createPluginStreamBus() }))
      .get("/api/plugins/plugin-1/bridge/stream/channel-1")
      .expect(400);
  });
});

describe("createPluginStreamPublisher", () => {
  const publishCalls = (publish: ReturnType<typeof fakeBus>["publish"]) =>
    publish.mock.calls.map(([pluginId, channel, companyId, event, eventType]) => ({
      pluginId,
      channel,
      companyId,
      event,
      eventType,
    }));

  it("maps open, emit and close onto bus events", () => {
    const { bus, publish } = fakeBus();
    const publishStream = createPluginStreamPublisher(bus);

    publishStream("plugin-1", "streams.open", { channel: "jarvis:company-1", companyId: "company-1" });
    publishStream("plugin-1", "streams.emit", { channel: "jarvis:company-1", companyId: "company-1", event: { text: "hi" } });
    publishStream("plugin-1", "streams.close", { channel: "jarvis:company-1", companyId: "company-1" });

    expect(publishCalls(publish)).toEqual([
      { pluginId: "plugin-1", channel: "jarvis:company-1", companyId: "company-1", event: { channel: "jarvis:company-1", companyId: "company-1" }, eventType: "open" },
      { pluginId: "plugin-1", channel: "jarvis:company-1", companyId: "company-1", event: { text: "hi" }, eventType: "message" },
      { pluginId: "plugin-1", channel: "jarvis:company-1", companyId: "company-1", event: { channel: "jarvis:company-1", companyId: "company-1" }, eventType: "close" },
    ]);
  });

  it("drops notifications without a channel or company and unknown methods", () => {
    const { bus, publish } = fakeBus();
    const publishStream = createPluginStreamPublisher(bus);

    publishStream("plugin-1", "streams.emit", { companyId: "company-1", event: {} });
    publishStream("plugin-1", "streams.emit", { channel: "channel-1", event: {} });
    publishStream("", "streams.emit", { channel: "channel-1", companyId: "company-1", event: {} });
    publishStream("plugin-1", "streams.unknown", { channel: "channel-1", companyId: "company-1" });

    expect(publish).not.toHaveBeenCalled();
  });
});
