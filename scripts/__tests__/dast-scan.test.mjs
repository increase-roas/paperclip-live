import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { runDastScan } from "../dast-scan.mjs";

async function startServer(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("reports a safe target as clean", async () => {
  const target = await startServer((req, res) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("content-security-policy", "default-src 'self'; frame-ancestors 'none'");
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (req.url?.startsWith("/api/")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.end('<div id="root"></div>');
  });
  try {
    const result = await runDastScan({ base: target.base });
    assert.equal(result.findings.length, 0, JSON.stringify(result.findings));
    assert.equal(result.highestSeverity, "none");
  } finally {
    await target.close();
  }
});

test("detects reflected script, SQL leakage, traversal and credential CORS", async () => {
  const target = await startServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api/health") {
      res.setHeader("access-control-allow-origin", "https://dast.invalid");
      res.setHeader("access-control-allow-credentials", "true");
      res.setHeader("content-type", "application/json");
      res.end("{}");
      return;
    }
    if (url.pathname.startsWith("/api/assets/")) {
      res.setHeader("content-type", "text/plain");
      res.end("root:x:0:0:root:/root:/bin/bash\n");
      return;
    }
    if (url.pathname.startsWith("/api/issues")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "syntax error at or near \"OR\"" }));
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end(`<div id="root">${url.searchParams.get("q") ?? ""}</div>`);
  });
  try {
    const result = await runDastScan({ base: target.base });
    const ids = new Set(result.findings.map((entry) => entry.id));
    assert.ok(ids.has("reflected-xss"), JSON.stringify(result.findings));
    assert.ok(ids.has("sql-error-leak"), JSON.stringify(result.findings));
    assert.ok(ids.has("path-traversal-read"), JSON.stringify(result.findings));
    assert.ok(ids.has("reflected-cors-credentials"), JSON.stringify(result.findings));
    assert.ok(ids.has("missing-nosniff"), JSON.stringify(result.findings));
    assert.equal(result.highestSeverity, "high");
  } finally {
    await target.close();
  }
});

test("only runs the selected check", async () => {
  const target = await startServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end('<div id="root"></div>');
  });
  try {
    const result = await runDastScan({ base: target.base, only: "open-redirect" });
    assert.equal(result.executed.length, 1);
    assert.equal(result.executed[0].id, "open-redirect");
  } finally {
    await target.close();
  }
});
