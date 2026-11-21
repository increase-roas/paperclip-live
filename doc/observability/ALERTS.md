# Prometheus alerts

`docker/prometheus/alerts.yml` defines the shipped alert rules and
`docker/prometheus/prometheus.yml` is a local scrape example. The rules cover
every shipped component:

- **Paperclip API** (`/api/metrics`): scrape failure, 5xx ratio, p95 latency,
  and a no-traffic signal.
- **Google Sheets MCP server** (`/metrics`): scrape failure and Google API
  error ratio.
- **All components** (`paperclip_component_*`): normalized health, probe
  freshness, and circuit state exported by `pnpm health:export`.

## Routing

Route `severity: critical` to the on-call page and `severity: warning` to the
team channel. The expected first checks are in
[DEPLOYMENT-OBSERVABILITY.md](../DEPLOYMENT-OBSERVABILITY.md): `/api/ready`,
the 5xx ratio, and the recent Sentry release.

## Alert design

- Every rule uses a `for` window so a single failed scrape does not page.
- The 5xx and latency rules divide by a clamped denominator so low traffic
  does not create a false ratio.
- Labels carry `service` and every annotation links to the deployment
  observability runbook.

## Component health

Broker, Runner, MCP stdio and the UI are host-local by design. The readiness
suite normalizes their health into Prometheus series instead of asking each
process to expose a network listener:

```sh
pnpm health:export
pnpm health:export -- --output /var/lib/node_exporter/textfile/paperclip.prom
```

The exporter probes the API (`/api/health`), the UI (`/`), the Google Sheets
MCP server (`/healthz`), the MCP server (`--health`), the broker (`--health`),
and the Runner package health script. It writes:

| Series | Meaning |
| --- | --- |
| `paperclip_component_up` | `1` when the component probe succeeded |
| `paperclip_component_probe_duration_ms` | Probe duration in milliseconds |
| `paperclip_component_last_probe_timestamp_seconds` | When the probe last ran |
| `paperclip_component_circuit_open` | `1` for an open or half-open circuit |

Run the exporter from a systemd timer and point node_exporter at its output
directory with `--collector.textfile.directory`. The shipped rules page on a
failed probe (`PaperclipComponentDown`), an open circuit
(`PaperclipComponentCircuitOpen`), and a stale exporter
(`PaperclipComponentProbeStale`). Keep the process supervisor's restart alert
as well; the exporter reports health, not restart loops.
