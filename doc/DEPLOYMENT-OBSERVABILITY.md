# Deployment observability

Where to look after a deploy, per application. This page covers the shipped
signals; the collector setup is described in [observability.md](./observability.md).

## Server (`server`)

| Signal | Where |
| --- | --- |
| Liveness | `GET /api/liveness` |
| Readiness | `GET /api/ready` |
| Health summary | `GET /api/health` |
| Request counters and latency | `GET /metrics` (Prometheus text, network-restricted) |
| Error events | Sentry, when `SENTRY_DSN_BACKEND` or `SENTRY_DSN` is set |
| Traces | OTLP endpoint from `OTEL_EXPORTER_OTLP_ENDPOINT`; Honeycomb is the documented backend |
| Deploy version | build stamp from `scripts/write-build-stamp.mjs` and the startup log |

Check `/api/ready` after a rollout, then compare the 5xx ratio and p95 latency
on `/api/metrics` with the pre-deploy window.

## UI (`ui`)

| Signal | Where |
| --- | --- |
| Asset availability | `GET /` and `GET /assets/*` through the server |
| Browser errors | Sentry (`SENTRY_DSN` / `VITE_SENTRY_DSN`), PII suppressed |
| Route and visibility hints | `X-Paperclip-Route` and `X-Paperclip-Tab-Visible` request headers |
| Request tracing | `traceparent` and `x-request-id` on same-origin API calls |

The UI ships as static assets, so there is no separate process uptime signal.
Use the server's asset-request metrics and the browser Sentry release.

## CLI (`cli`)

| Signal | Where |
| --- | --- |
| Structured diagnostics | stderr JSON from `cli/src/observability.ts` |
| Request tracing | `traceparent` and `x-request-id` on API calls |
| Local counters and durations | `cliMetrics` snapshot in the process |
| Telemetry | opt-out first-party telemetry; see `packages/shared/src/telemetry/README.md` |

Set `PAPERCLIP_LOG_LEVEL=debug` to include request-level diagnostics. The CLI
reports transport failures and breaker opens without printing credentials.

## Runner (`packages/paperclip-runner`)

| Signal | Where |
| --- | --- |
| Package health | `pnpm --filter @paperclipai/paperclip-runner health` (JSON) |
| Run log | `heartbeat_run_events` and the run detail activity |
| Structured diagnostics | stderr JSON from `src/observability.ts` |
| Copilot probe counters and durations | `PAPERCLIP_METRICS=1` or `--metrics` |
| Trace and request ids | emitted with each diagnostic record |
| Recovery state | native run checkpoints and the runner recovery views |

The production runner binary is Rust; the TypeScript surfaces share the same
run log and diagnostic vocabulary.

## MCP server (`packages/mcp-server`)

| Signal | Where |
| --- | --- |
| Health | `node dist/stdio.js --health` |
| Metrics | `node dist/stdio.js --metrics` |
| Diagnostics | stderr JSON from `src/observability.ts` |
| API tracing | `traceparent` and `x-request-id` on Paperclip API calls |

## Tailscale HTTPS broker (`packages/tailscale-https-broker`)

| Signal | Where |
| --- | --- |
| Health probe | `paperclip-tailscale-https-broker --health` (JSON, exit 0/1) |
| Doctor | `paperclip-tailscale-https-broker --doctor` |
| Audit | append-only JSONL at the configured `auditPath`, including `traceId` |
| Metrics | `metrics` object in `--health` and `--doctor` |
| Breaker state | `circuit` object in `--health` and `--doctor` |

## Google Sheets MCP server (`packages/google-sheets-mcp-server`)

| Signal | Where |
| --- | --- |
| Health | `GET /healthz` (HTTP mode) or `--health` (stdio) |
| Metrics | `GET /metrics` (HTTP mode) or `--metrics` (stdio) |
| Diagnostics | stderr JSON with `x-request-id` on HTTP responses |
| Circuit state | `circuit` in `/healthz` and `--health` |

## Alerting

Prometheus rules and a scrape example live in
[`docker/prometheus/`](../docker/prometheus/). See
[`doc/observability/ALERTS.md`](./observability/ALERTS.md) for the intended
routing and runbook links.
