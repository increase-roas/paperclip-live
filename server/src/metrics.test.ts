import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { metricsMiddleware, renderMetrics } from "./metrics.js";

describe("server metrics", () => {
  it("counts completed requests by method, matched route and status", async () => {
    const app = express();
    app.use(metricsMiddleware);
    app.get("/metrics-test/ping", (_req, res) => {
      res.status(204).end();
    });

    await request(app).get("/metrics-test/ping").expect(204);

    const rendered = renderMetrics();
    expect(rendered).toContain(
      'paperclip_http_requests_total{method="GET",route="/metrics-test/ping",status="204"} 1',
    );
    expect(rendered).toContain(
      'paperclip_http_request_duration_ms_count{method="GET",route="/metrics-test/ping"} 1',
    );
  });
});
