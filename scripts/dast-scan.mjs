#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { parseArgs, printTitle } from "./readiness/lib/report.mjs";

/**
 * Local/staging DAST for a running Paperclip instance.
 *
 * This is an active, black-box scan: it sends hostile input to the served UI
 * and API and reports reflected script, SQL error leakage, path traversal,
 * missing browser defenses, credential CORS and open redirects. It runs against
 * a disposable local or staging instance, never production data. The scan is
 * read-only apart from the requests themselves.
 *
 * Usage:
 *   pnpm test:dast -- --base http://127.0.0.1:3100
 *   pnpm test:dast -- --base https://staging.example --json
 */

const DEFAULT_BASE = process.env.PAPERCLIP_URL ?? "http://127.0.0.1:3100";
const DEFAULT_TIMEOUT_MS = 8_000;

const SQL_ERROR_PATTERNS = [
  /syntax error at or near/i,
  /unterminated quoted string/i,
  /SQLITE_ERROR/i,
  /PostgresError/i,
  /pg_catalog/i,
  /SequelizeDatabaseError/i,
  /ER_PARSE_ERROR/i,
];

function severityRank(severity) {
  return { high: 3, medium: 2, low: 1 }[severity] ?? 0;
}

async function request(base, path, { timeoutMs, headers } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}${path}`, {
      signal: controller.signal,
      redirect: "manual",
      headers: { accept: "text/html,application/json;q=0.9,*/*;q=0.8", ...headers },
    });
    const body = await response.text();
    return {
      path,
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
      location: response.headers.get("location"),
    };
  } finally {
    clearTimeout(timer);
  }
}

function finding(id, severity, message, evidence) {
  return { id, severity, message, evidence };
}

export function defaultChecks() {
  return [
    {
      id: "browser-defense-headers",
      severity: "medium",
      async run(context) {
        const response = await request(context.base, "/", context);
        const findings = [];
        if (response.headers["x-content-type-options"]?.toLowerCase() !== "nosniff") {
          findings.push(finding("missing-nosniff", "medium", "X-Content-Type-Options is not nosniff", { status: response.status }));
        }
        if (!response.headers["content-security-policy"]) {
          findings.push(finding("missing-csp", "low", "No Content-Security-Policy header", { status: response.status }));
        }
        if (!response.headers["x-frame-options"] && !/frame-ancestors/i.test(response.headers["content-security-policy"] ?? "")) {
          findings.push(finding("missing-frame-defense", "low", "No frame embedding defense", { status: response.status }));
        }
        if (context.base.startsWith("https://") && !response.headers["strict-transport-security"]) {
          findings.push(finding("missing-hsts", "low", "HTTPS response has no Strict-Transport-Security", { status: response.status }));
        }
        return findings;
      },
    },
    {
      id: "reflected-script",
      severity: "high",
      async run(context) {
        const payload = `<script>alert("dast")</script>`;
        const findings = [];
        for (const path of [`/?q=${encodeURIComponent(payload)}`, `/api/issues?search=${encodeURIComponent(payload)}`]) {
          const response = await request(context.base, path, context);
          const html = (response.headers["content-type"] ?? "").includes("text/html");
          if (html && response.body.includes(payload)) {
            findings.push(finding("reflected-xss", "high", "Script payload is reflected unescaped", { path, status: response.status }));
          }
          if (!html && /<script>alert\("dast"\)<\/script>/.test(response.body) && !/application\/json/.test(response.headers["content-type"] ?? "")) {
            findings.push(finding("script-in-response", "high", "Script payload is returned in an executable content type", { path, status: response.status }));
          }
        }
        return findings;
      },
    },
    {
      id: "sql-error-leakage",
      severity: "high",
      async run(context) {
        const payload = encodeURIComponent("' OR 1=1 --");
        const findings = [];
        for (const path of [`/api/issues?search=${payload}`, `/api/companies?search=${payload}`]) {
          const response = await request(context.base, path, context);
          const matched = SQL_ERROR_PATTERNS.find((pattern) => pattern.test(response.body));
          if (matched) {
            findings.push(
              finding("sql-error-leak", response.status >= 500 ? "high" : "medium", "Database error text is exposed", {
                path,
                status: response.status,
                pattern: String(matched),
              }),
            );
          }
        }
        return findings;
      },
    },
    {
      id: "path-traversal",
      severity: "high",
      async run(context) {
        const findings = [];
        for (const path of [
          "/api/assets/..%2F..%2F..%2Fetc%2Fpasswd",
          "/api/assets/%2e%2e/%2e%2e/%2e%2e/etc/passwd",
        ]) {
          const response = await request(context.base, path, context);
          if (response.status === 200 && /root:[x*]?:0:0:/.test(response.body)) {
            findings.push(finding("path-traversal-read", "high", "Path traversal returned a system file", { path, status: response.status }));
          }
        }
        return findings;
      },
    },
    {
      id: "credential-cors",
      severity: "high",
      async run(context) {
        const response = await request(context.base, "/api/health", {
          ...context,
          headers: { origin: "https://dast.invalid" },
        });
        const allowOrigin = response.headers["access-control-allow-origin"];
        const allowCredentials = response.headers["access-control-allow-credentials"];
        if (allowOrigin === "*" && allowCredentials === "true") {
          return [finding("wildcard-cors-credentials", "high", "Wildcard CORS is combined with credentials", { status: response.status })];
        }
        if (allowOrigin === "https://dast.invalid" && allowCredentials === "true") {
          return [finding("reflected-cors-credentials", "high", "CORS reflects an arbitrary origin with credentials", { status: response.status })];
        }
        return [];
      },
    },
    {
      id: "open-redirect",
      severity: "high",
      async run(context) {
        const response = await request(context.base, "/?next=https%3A%2F%2Fdast.invalid%2Ftakeover", context);
        if (response.status >= 300 && response.status < 400 && response.location) {
          try {
            const target = new URL(response.location, context.base);
            if (target.host === "dast.invalid") {
              return [finding("open-redirect", "high", "Redirect leaves the origin for attacker-controlled input", { status: response.status, location: response.location })];
            }
          } catch {
            // An unparseable Location is not a proven redirect.
          }
        }
        return [];
      },
    },
  ];
}

export async function runDastScan({ base, checks = defaultChecks(), timeoutMs = DEFAULT_TIMEOUT_MS, only } = {}) {
  const selected = checks.filter((check) => !only || check.id === only);
  const findings = [];
  const executed = [];
  for (const check of selected) {
    try {
      const result = await check.run({ base, timeoutMs });
      findings.push(...result);
      executed.push({ id: check.id, findings: result.length });
    } catch (error) {
      executed.push({ id: check.id, error: error instanceof Error ? error.message : String(error) });
      findings.push(finding(`${check.id}-error`, "medium", "DAST check could not complete", { error: error instanceof Error ? error.message : String(error) }));
    }
  }
  const highest = findings.reduce((rank, entry) => Math.max(rank, severityRank(entry.severity)), 0);
  return { base, executed, findings, highestSeverity: Object.keys({ high: 3, medium: 2, low: 1 }).find((key) => severityRank(key) === highest) ?? "none" };
}

function main() {
  const args = parseArgs();
  const base = (args.values.get("base") ?? DEFAULT_BASE).replace(/\/$/, "");
  const timeoutMs = Number(args.values.get("timeout-ms") ?? DEFAULT_TIMEOUT_MS);
  const only = args.values.get("only");

  runDastScan({ base, timeoutMs, only }).then((result) => {
    if (args.flags.has("json")) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      printTitle(`DAST scan: ${base}`);
      for (const check of result.executed) {
        process.stdout.write(`  ${check.error ? "✖" : "✔"} ${check.id}${check.error ? ` — ${check.error}` : ` (${check.findings} finding(s))`}\n`);
      }
      for (const entry of result.findings) {
        process.stdout.write(`  [${entry.severity}] ${entry.id}: ${entry.message}\n`);
      }
      process.stdout.write(`  highest severity: ${result.highestSeverity}\n`);
    }
    if (result.findings.some((entry) => entry.severity === "high")) process.exitCode = 1;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
