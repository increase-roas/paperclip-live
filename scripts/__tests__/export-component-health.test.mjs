import assert from "node:assert/strict";
import test from "node:test";

import { buildPrometheusText, runProbes } from "../export-component-health.mjs";

function probe(name, result) {
  return {
    name,
    async run() {
      return { name, durationMs: 7, body: "", ...result };
    },
  };
}

test("renders up, duration, timestamp and circuit series for every component", async () => {
  const results = await runProbes([
    probe("server", { ok: true, status: 200 }),
    probe("mcp-server", { ok: false, status: 1, body: '{"circuit":{"state":"open"}}' }),
  ]);
  const text = buildPrometheusText(results, { now: new Date("2026-01-02T03:04:05Z") });

  assert.match(text, /paperclip_component_up\{component="server"\} 1/);
  assert.match(text, /paperclip_component_up\{component="mcp-server"\} 0/);
  assert.match(text, /paperclip_component_probe_duration_ms\{component="server"\} 7/);
  assert.match(text, /paperclip_component_last_probe_timestamp_seconds\{component="server"\} 1767323045/);
  assert.match(text, /paperclip_component_circuit_open\{component="mcp-server"\} 1/);
  assert.match(text, /paperclip_component_circuit_open\{component="server"\} 0/);
});

test("escapes quotes, backslashes and newlines in component labels", () => {
  const text = buildPrometheusText([
    { name: 'odd"component\\name\nnext', ok: true, durationMs: 1, body: "" },
  ]);
  assert.match(text, /paperclip_component_up\{component="odd\\"component\\\\name\\nnext"\} 1/);
});

test("runs probes concurrently and sorts by component", async () => {
  const results = await runProbes(
    [probe("z", { ok: true }), probe("a", { ok: true }), probe("m", { ok: true })],
    { concurrency: 3 },
  );
  assert.deepEqual(results.map((result) => result.name), ["a", "m", "z"]);
});
