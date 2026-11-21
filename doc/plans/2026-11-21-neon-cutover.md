# Neon cutover, migration 0452, and tracing: one 10-minute window

Date: 2026-11-21. Status: **prepared, not executed**. The live container
(`paperclip-wze4-paperclip-1`, image `paperclip-ir:e83b7aa109`) was never
stopped, restarted, or migrated.

This replaces the earlier multi-step draft. Everything below happens in one
maintenance window with **one container restart**.

## What is already staged and verified

| Item | Value |
| --- | --- |
| Branch / commit | `feat/agent-readiness-2026-11-21` @ `d1e17b4e33` (33 files, not merged) |
| Neon project | `paperclip` (`twilight-glade-11976094`) |
| Staging branch | `agent/paperclip-app-stage-20261121` (`br-raspy-glade-b4iffe62`) |
| Staging database | `paperclip_stage` (direct URL, prepared statements off) |
| Migration 0452 | applied on the staging branch only; `drizzle.__drizzle_migrations` row added (id 451) |
| Source | embedded PostgreSQL 18.1, 618 MB, 320 public base tables |
| Dump | `paperclip-embedded-20261121.dump`, 194 MB, 13:42Z |
| Restore | under one minute, 0 errors, `--no-owner --no-privileges -j4` |
| Verification | 321 user tables both sides, 231,817 rows total, **0 mismatches** |
| Schema | 450 migrations both sides; extensions `plpgsql, pg_trgm, fuzzystrmatch` |
| Spot check | `companies=2`, `agents=23`, `heartbeat_runs=1044`, `issues=210` |
| Readiness on the copy | 160 findings for 4 subjects; catalog is 62 checks, 58 reachable for these subjects |
| OTel | proven on the staging instance: 14 spans exported to a local collector |
| Connectors | GBrain + Neon ads read-only created on staging and live |

The dump lives in `/docker/paperclip-wze4/backups/readiness-20261121/` with
`source_counts.txt`, `target_counts.txt` and `restore.log` (all `pcdev`).

## Preconditions (do these before the window opens)

1. **Image with the readiness code and OTel packages.** The runtime bundle
   prints `OTEL_EXPORTER_OTLP_ENDPOINT is set but the @opentelemetry/* packages
   are not installed` until these are in the dependency tree:
   `@opentelemetry/sdk-node@0.221.0`,
   `@opentelemetry/auto-instrumentations-node@0.79.0`,
   `@opentelemetry/resources@2.10.0`,
   `@opentelemetry/semantic-conventions@1.43.0`,
   `@opentelemetry/exporter-trace-otlp-proto@0.221.0`.
   They were installed as a sidecar on the staging host because this checkout's
   pnpm store does not match the lockfile; **add them to the workspace and
   rebuild the image**, or the OTel switch below does nothing.
2. **1Password item for the GBrain token.** Service account `factory`
   (Integration ID `UBHCMQPAWFA3LLTPHYQLN2COHU`) can **read** vault
   `JAVAR AGENT` but not create items. Either grant it "Can edit" on that vault
   or have the operator create `gbrain-mcp-token` (password field).
3. **Never restore through the pooler.** `pg_restore` ends with
   `set_config('search_path', '', false)`; through the pooler that leaks an
   empty `search_path` into later pooled sessions (observed on staging, cleared
   with `DISCARD ALL`). Restore with `DATABASE_MIGRATION_URL`.

## Window: 10 minutes, one restart

Times are measured, not estimated. Total expected downtime **3–5 minutes**.

| t | Step |
| --- | --- |
| 0:00 | Announce; pause agents; record `heartbeat_runs` count and last `started_at` |
| 0:30 | `docker stop paperclip-wze4-paperclip-1` (embedded DB shuts down cleanly) |
| 0:45 | Final dump from the stopped data dir (below) |
| 1:45 | Restore into `paperclip_cutover` via the direct URL (below) |
| 3:00 | Verify counts, migration row, extensions, sample rows |
| 4:30 | Write compose env (below), `op run ... docker compose up -d` (single restart) |
| 5:30 | Migrations: startup applies 0452; confirm 451 journal rows |
| 6:00 | Smoke test list (below) |
| 8:00 | Tracing check: one run, spans in the collector |
| 9:30 | Record results; unpause agents |

### 1. Final dump while stopped

The embedded cluster must have exited cleanly in the `docker stop`.

```sh
docker run --rm \
  -v /docker/paperclip-wze4/data/db:/pgdata \
  -v /docker/paperclip-wze4/backups/cutover-20261121:/dump \
  -e PGPASSWORD=paperclip \
  postgres:18 sh -c '
    pg_ctl -D /pgdata -o "-p 54329 -k /tmp" -w start &&
    pg_dump -h /tmp -p 54329 -U paperclip -d paperclip \
      --no-owner --no-privileges --format=custom --file=/dump/final.dump ;
    pg_ctl -D /pgdata -m fast -w stop'
```

### 2. Restore into a fresh database (direct URL only)

```sh
docker run --rm -v /docker/paperclip-wze4/backups/cutover-20261121:/dump \
  postgres:18 pg_restore --no-owner --no-privileges -j 4 \
  -d "$DATABASE_MIGRATION_URL" /dump/final.dump
```

`DATABASE_MIGRATION_URL` comes from `op run`; never typed on the command line.

### 3. Compose change (single restart)

```yaml
    environment:
      PAPERCLIP_PUBLIC_URL: https://app.increaseai.tech
      PAPERCLIP_ALLOWED_HOSTNAMES: app.increaseai.tech,srv2116418.hstgr.cloud
      DATABASE_URL: ${DATABASE_URL}
      DATABASE_MIGRATION_URL: ${DATABASE_MIGRATION_URL}
      DATABASE_PREPARED_STATEMENTS: "false"
      OTEL_EXPORTER_OTLP_ENDPOINT: ${OTEL_EXPORTER_OTLP_ENDPOINT}
      OTEL_EXPORTER_OTLP_PROTOCOL: http/protobuf
      OTEL_EXPORTER_OTLP_INSECURE: "true"
      OTEL_SERVICE_NAME: paperclip
```

Start with `op run --env-file=/docker/paperclip-wze4/op.env -- docker compose up -d`.
The `op.env` file holds `op://` references only:

```
DATABASE_URL=op://Paperclip/neon-app-database-url/password
DATABASE_MIGRATION_URL=op://Paperclip/neon-app-migration-url/password
DATABASE_PREPARED_STATEMENTS=op://Paperclip/database-prepared-statements/password
NEON_ADS_RO=op://Paperclip/neon-ads-dashboard-ro/password
GBRAIN_TOKEN=op://JAVAR AGENT/gbrain-mcp-token/password
OTEL_EXPORTER_OTLP_ENDPOINT=op://Paperclip/otel-collector-endpoint/password
```

Use the **direct** (non-pooler) URL for `DATABASE_URL` too: the pooler rejects
`options=-c search_path=public`, and an empty `search_path` breaks unqualified
queries.

### 4. Smoke test (all must pass)

- `GET /api/health` 200 through `https://app.increaseai.tech`.
- Startup banner reports a Postgres/Neon database, not `embedded-postgres`.
- `select count(*) from drizzle.__drizzle_migrations` = 451.
- `companies`, `agents`, `heartbeat_runs` load; counts match step 3's record.
- Readiness page renders; `company.neon_app_db` passes.
- `memory.gbrain_connected` and `tools.neon_ads_readonly` pass (connectors exist:
  GBrain `2a6b1bcc-e0ed-4855-94ec-a4af618b9879`, Neon ads
  `bbeff1ff-22f0-4c6e-bf73-9b5d7f064e1e`, both installed for the three agents).
- `company.gbrain` stays **not checked**: Paperclip discovers the GBrain MCP's
  OAuth metadata on health check and rewrites `authKind` to `oauth`, ignoring the
  bearer secret; the probe then 401s. Completing OAuth in the UI, or teaching the
  app sync to respect an explicit `api_key`, is a separate fix.
- One heartbeat run writes events and one OTLP batch arrives.

## Rollback (single restart)

The embedded data directory is the rollback source and is never modified.

1. `docker stop paperclip-wze4-paperclip-1`.
2. Restore the previous compose file (one backup:
   `docker-compose.yml.bak-cutover-<stamp>`), so `DATABASE_URL`,
   `DATABASE_MIGRATION_URL`, `DATABASE_PREPARED_STATEMENTS` and the `OTEL_*`
   variables are gone; keep `env_file: .env`.
3. `docker compose up -d` and confirm the banner reports `embedded-postgres`.
4. `/api/health`, companies, agents, one heartbeat run.
5. Writes made in Neon between cutover and rollback are not in the embedded
   copy. Either accept and record the gap or restore Neon into the data
   directory (destructive, needs an explicit decision).

## Known limitations found while staging

- **GBrain OAuth override** (above). `memory.gbrain_connected` still passes via
  the connector install; `company.gbrain` needs the OAuth fix.
- **Neon ads connector** stores the `dashboard_ro` connection string as a
  secret (`connectionString`), but the hosted Neon MCP (`mcp.neon.tech`) still
  authenticates with OAuth or a Neon API key, so the MCP transport itself is
  declarative today. The credential is real and proven: 81 tables readable,
  0 writable, `has_schema_privilege(create)=false`, INSERT rejected.
- **`company.secrets` fails** in the readiness report because two agents carry
  plaintext environment values (pre-existing, unrelated to this cutover).

## Go / no-go

**No-go until** the image contains the OTel packages and the GBrain item exists
in 1Password. With those two done: **go**, with **3–5 minutes of downtime**
inside the 10-minute window.
