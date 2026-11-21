#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

import { pathToFileURL } from "node:url";

import { repoRoot } from "./readiness/lib/files.mjs";
import { parseArgs, printTitle } from "./readiness/lib/report.mjs";

/**
 * Export health for every shipped Paperclip component as Prometheus text.
 *
 * Components expose health in different ways: the API and UI over HTTP, the
 * MCP servers and standalone services through `--health` commands, and the
 * Runner through its package health probe. This exporter normalizes them into
 * `paperclip_component_*` series that a node_exporter textfile collector can
 * scrape. It never changes a service; it only reads its health surface.
 *
 * Usage:
 *   pnpm health:export
 *   pnpm health:export -- --output /var/lib/node_exporter/textfile/paperclip.prom
 *   pnpm health:export -- --json
 */

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_OUTPUT = ".quality/reports/paperclip-health.prom";

function apiBase(env = process.env) {
  return (env.PAPERCLIP_API_URL ?? "http://127.0.0.1:3100").replace(/\/$/, "");
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: "application/json,text/html" } });
    const body = await response.text();
    return { ok: response.ok, status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

async function runCommand(command, args, timeoutMs) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: timeoutMs,
      env: { ...process.env, PAPERCLIP_METRICS: "1" },
    });
    return { ok: true, status: 0, body: result.stdout };
  } catch (error) {
    return {
      ok: false,
      status: typeof error?.code === "number" ? error.code : 1,
      body: `${error?.stdout ?? ""}${error?.stderr ?? ""}`.trim() || (error instanceof Error ? error.message : String(error)),
    };
  }
}

function parseJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function httpProbe(name, url, { validate } = {}) {
  return {
    name,
    async run({ timeoutMs }) {
      const startedAt = Date.now();
      try {
        const response = await fetchWithTimeout(url, timeoutMs);
        const valid = validate ? validate(response) : response.ok;
        return {
          name,
          ok: valid,
          status: response.status,
          detail: valid ? "ok" : `unexpected response (${response.status})`,
          durationMs: Date.now() - startedAt,
          body: response.body,
        };
      } catch (error) {
        return {
          name,
          ok: false,
          status: null,
          detail: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - startedAt,
        };
      }
    },
  };
}

function commandProbe(name, command, args) {
  return {
    name,
    async run({ timeoutMs }) {
      const startedAt = Date.now();
      const result = await runCommand(command, args, timeoutMs);
      return {
        name,
        ok: result.ok,
        status: result.status,
        detail: result.ok ? "ok" : "command failed",
        durationMs: Date.now() - startedAt,
        body: result.body,
      };
    },
  };
}

export function defaultProbes(env = process.env) {
  const base = apiBase(env);
  return [
    httpProbe("server", `${base}/api/health`, {
      validate: (response) => response.ok,
    }),
    httpProbe("ui", `${base}/`, {
      validate: (response) => response.ok && /<html[\s>]/i.test(response.body),
    }),
    httpProbe("google-sheets-mcp-server", env.GOOGLE_SHEETS_HEALTH_URL ?? "http://127.0.0.1:8849/healthz"),
    commandProbe(
      "mcp-server",
      process.execPath,
      [resolve(repoRoot, "packages/mcp-server/dist/stdio.js"), "--health"],
    ),
    commandProbe(
      "tailscale-https-broker",
      process.execPath,
      [resolve(repoRoot, "packages/tailscale-https-broker/dist/main.js"), "--health"],
    ),
    commandProbe("paperclip-runner", process.execPath, [resolve(repoRoot, "packages/paperclip-runner/scripts/health.mjs")]),
  ];
}

function escapeLabel(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function circuitOpen(body) {
  const parsed = parseJson(body ?? "");
  const state = parsed?.circuit?.state;
  return state === "open" || state === "half-open" ? 1 : 0;
}

export function buildPrometheusText(results, { now = new Date() } = {}) {
  const lines = [
    "# HELP paperclip_component_up 1 when the component health probe succeeded.",
    "# TYPE paperclip_component_up gauge",
  ];
  for (const result of results) {
    lines.push(`paperclip_component_up{component="${escapeLabel(result.name)}"} ${result.ok ? 1 : 0}`);
  }
  lines.push(
    "# HELP paperclip_component_probe_duration_ms Health probe duration in milliseconds.",
    "# TYPE paperclip_component_probe_duration_ms gauge",
  );
  for (const result of results) {
    lines.push(
      `paperclip_component_probe_duration_ms{component="${escapeLabel(result.name)}"} ${Math.max(0, Math.round(result.durationMs))}`,
    );
  }
  lines.push(
    "# HELP paperclip_component_last_probe_timestamp_seconds Unix time of the last health probe.",
    "# TYPE paperclip_component_last_probe_timestamp_seconds gauge",
  );
  const timestamp = Math.floor(now.getTime() / 1000);
  for (const result of results) {
    lines.push(
      `paperclip_component_last_probe_timestamp_seconds{component="${escapeLabel(result.name)}"} ${timestamp}`,
    );
  }
  lines.push(
    "# HELP paperclip_component_circuit_open 1 when the component reports an open or half-open circuit.",
    "# TYPE paperclip_component_circuit_open gauge",
  );
  for (const result of results) {
    lines.push(`paperclip_component_circuit_open{component="${escapeLabel(result.name)}"} ${circuitOpen(result.body)}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function runProbes(probes, { timeoutMs = DEFAULT_TIMEOUT_MS, concurrency = 4 } = {}) {
  const results = [];
  let index = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, probes.length)) }, async () => {
    while (index < probes.length) {
      const probe = probes[index];
      index += 1;
      results.push(await probe.run({ timeoutMs }));
    }
  });
  await Promise.all(workers);
  return results.sort((left, right) => left.name.localeCompare(right.name));
}

function main() {
  const args = parseArgs();
  const timeoutMs = Number(args.values.get("timeout-ms") ?? DEFAULT_TIMEOUT_MS);
  const only = args.values.get("only");
  const output = resolve(repoRoot, args.values.get("output") ?? process.env.PAPERCLIP_HEALTH_TEXTFILE ?? DEFAULT_OUTPUT);
  const probes = defaultProbes().filter((probe) => !only || probe.name === only);
  if (probes.length === 0) {
    process.stderr.write(`Unknown component "${only}".\n`);
    process.exitCode = 2;
    return;
  }

  runProbes(probes, { timeoutMs }).then((results) => {
    const text = buildPrometheusText(results);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, text, "utf8");

    if (args.flags.has("json")) {
      process.stdout.write(`${JSON.stringify({ output, results }, null, 2)}\n`);
    } else {
      printTitle("Component health");
      for (const result of results) {
        process.stdout.write(`  ${result.ok ? "✔" : "✖"} ${result.name} (${result.durationMs}ms)\n`);
      }
      process.stdout.write(`  wrote ${output}\n`);
    }
    if (results.some((result) => !result.ok)) process.exitCode = 1;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
