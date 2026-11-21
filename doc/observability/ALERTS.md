# Prometheus alerts

`docker/prometheus/alerts.yml` defines the shipped alert rules and
`docker/prometheus/prometheus.yml` is a local scrape example. The rules cover
the two surfaces that expose a Prometheus endpoint:

- **Paperclip API** (`/api/metrics`): scrape failure, 5xx ratio, p95 latency,
  and a no-traffic signal.
- **Google Sheets MCP server** (`/metrics`): scrape failure and Google API
  error ratio.

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

Broker, Runner, MCP stdio and CLI signals are host-local by design. Alert on
the surrounding process supervisor (systemd, container restart count) and use
their `--health` / `--metrics` output in the incident timeline rather than
scraping their ephemeral processes.
