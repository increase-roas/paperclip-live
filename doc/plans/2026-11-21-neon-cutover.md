# Neon cutover runbook (staged, not executed)

Date: 2026-11-21. Status: **staged only**. The live container
(`paperclip-wze4-paperclip-1`, image `paperclip-ir:e83b7aa109`) still runs
embedded PostgreSQL on port 54329 inside the container. Nothing in this
runbook has been applied to production.

## What is staged

| Item | Value |
| --- | --- |
| Neon project | `paperclip` (`twilight-glade-11976094`), org `org-cold-paper-48054737` |
| Staging branch | `agent/paperclip-app-stage-20261121` (`br-raspy-glade-b4iffe62`) |
| Staging database | `paperclip_stage` |
| Source | embedded PostgreSQL 18.1, container port 54329, 618 MB, 320 public base tables |
| Dump | `paperclip-embedded-20261121.dump` (custom format, 194 MB), taken 2026-11-21 13:42 UTC |
| Restore | completed in under a minute, **0 errors** |
| Verification | 321 user tables on both sides, 231,817 rows total, **0 row-count mismatches**, no missing/extra tables |
| Schema check | 450 Drizzle migrations on both sides; extensions `plpgsql, pg_trgm, fuzzystrmatch` on both sides |
| Data spot-check | `companies=2`, `agents=23`, `heartbeat_runs=1044`, `issues=210` |

The dump lives at
`/docker/paperclip-wze4/backups/readiness-20261121/paperclip-embedded-20261121.dump`
on `paperclip-vps`, alongside `source_counts.txt`, `target_counts.txt` and
`restore.log`. Keep one backup per file; do not overwrite the dump.

## 1Password: current blocker and exact commands

**Blocker (measured).** Nearest host with the CLI is `srv2155332.tailde26a1.ts.net`
(`op` v2.42.0) but it reports `no account found for filter`; `paperclip-vps`
(this host) has no `op` binary. No `OP_SERVICE_ACCOUNT_TOKEN` is set on either
host. So credentials cannot be written to 1Password from this session. Nothing
below has been run; the secret values themselves were produced and verified in
this session (staging URL, `dashboard_ro` login, GBrain bearer token).

Run on `paperclip-vps` after installing the CLI (`apt install 1password-cli` or
the official tarball), then authenticate once:

```sh
op account add --address my.1password.com --email <operator-email>   # interactive
# unattended alternative:
export OP_SERVICE_ACCOUNT_TOKEN=...   # paste into a shell, do not echo, do not commit
```

Create the items. Omitting the value makes `op` prompt with echo disabled, so
the secret never lands in shell history or the process list:

```sh
for t in neon-app-database-url neon-app-migration-url neon-ads-dashboard-ro gbrain-mcp-token; do
  op item create --category=password --vault=Paperclip --title="$t"
done
op item edit neon-app-database-url password            # prompt: pooled Neon URL
op item edit neon-app-migration-url password           # prompt: direct Neon URL
op item edit neon-ads-dashboard-ro password            # prompt: dashboard_ro password
op item edit gbrain-mcp-token password                 # prompt: GBrain bearer token
op item create --category=password --vault=Paperclip \
  --title=database-prepared-statements password=false
```

Write the reference file (references only, no secrets, mode 600 root):

```sh
install -m 600 /dev/null /docker/paperclip-wze4/op.env
cat > /docker/paperclip-wze4/op.env <<'EOF'
DATABASE_URL=op://Paperclip/neon-app-database-url/password
DATABASE_MIGRATION_URL=op://Paperclip/neon-app-migration-url/password
DATABASE_PREPARED_STATEMENTS=op://Paperclip/database-prepared-statements/password
NEON_ADS_RO=op://Paperclip/neon-ads-dashboard-ro/password
GBRAIN_TOKEN=op://Paperclip/gbrain-mcp-token/password
EOF
```

`docker-compose.yml` currently passes credentials through `env_file: .env`
(world-readable `0644`; it already holds provider API keys). At cutover, add
these to the `environment:` block so `op run` supplies them, and start through
`op run` so no plaintext copy is needed:

```yaml
    environment:
      PAPERCLIP_PUBLIC_URL: https://app.increaseai.tech
      PAPERCLIP_ALLOWED_HOSTNAMES: app.increaseai.tech,srv2116418.hstgr.cloud
      DATABASE_URL: ${DATABASE_URL}
      DATABASE_MIGRATION_URL: ${DATABASE_MIGRATION_URL}
      DATABASE_PREPARED_STATEMENTS: "false"
```

```sh
cd /docker/paperclip-wze4
cp -a docker-compose.yml docker-compose.yml.bak-cutover-$(date +%Y%m%dT%H%M%S)
op run --env-file=/docker/paperclip-wze4/op.env -- docker compose up -d
```

The old `.env` file is left untouched (it carries the provider keys); tighten it
to `chmod 600` as separate hygiene, not as part of the cutover.

## Preconditions

- A staging restore has been verified (above). Re-check after any delay.
- The embedded data directory `/docker/paperclip-wze4/data/db` is left untouched
  as the rollback source. Do not delete it during the cutover.
- A maintenance window of **10 minutes** is reserved. Expected downtime is
  **3–5 minutes**: final dump (~1 min for 194 MB), restore (~1 min), checks
  (~2 min), container restart (~1 min).

## Known Neon pooler pitfall (found while staging)

Staging restored through the **pooled** URL. `pg_restore` ends with
`set_config('search_path', '', false)`, which is session-level, but the pooler
reused that server session: a later pooled connection to `paperclip_stage`
reported an **empty `search_path`**, so unqualified queries such as
`select count(*) from companies` failed. The direct URL was unaffected.
`DISCARD ALL` through the pooled URL cleared it, and pooled sessions then
reported `"$user", public` again.

Consequences for the cutover:

- Restore with `DATABASE_MIGRATION_URL` (direct), never through the pooler.
- If a pooled `DATABASE_URL` is used, verify
  `select current_setting('search_path')` after cutover and run `DISCARD ALL`
  from the pooler if it is empty. The project's other Neon databases keep the
  normal `"$user", public`, so this is a restore-session side effect, not a
  database default.
- The Neon pooler rejects `options=-c search_path=public` ("unsupported startup
  parameter"), so the app cannot set it through the URL.

## Cutover steps

1. **Announce and freeze.** Stop new work in the app (pause agents if desired).
   Record the current run count and the last `heartbeat_runs.started_at`.
2. **Stop the container** so no writes land during the final copy:
   `docker stop paperclip-wze4-paperclip-1`
3. **Take the final dump** from the stopped data directory with a temporary
   server (the embedded cluster must have shut down cleanly in step 2):
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
   The temporary server only reads the cluster; stop it before continuing. If
   `pg_ctl` refuses to start, the app did not shut down cleanly: restart the
   container, let it stop normally, and retry.
4. **Restore into a fresh database** (do not `--clean` the staging database;
   create `paperclip_cutover` on the same branch, or create a new branch).
   Restore through the **direct** URL, not the pooler, because `pg_restore`
   issues session-level commands a pooler can reject:
   ```sh
   docker run --rm -v /docker/paperclip-wze4/backups/cutover-20261121:/dump \
     postgres:18 pg_restore --no-owner --no-privileges -j 4 \
     -d "$DATABASE_MIGRATION_URL" /dump/final.dump
   ```
   `DATABASE_MIGRATION_URL` is read from the 1Password-referenced environment,
   never typed on the command line.
5. **Verify the copy** before starting the app:
   - row counts per table: reuse the `query_to_xml` count query and diff against
     `source_counts.txt`;
   - `select count(*) from drizzle.__drizzle_migrations` matches the embedded DB;
   - `select extname from pg_extension` contains `plpgsql`, `pg_trgm`,
     `fuzzystrmatch`;
   - a sample read (`companies`, `agents`, `heartbeat_runs`) returns the expected
     rows.
6. **Set the container environment** from 1Password:
   `DATABASE_URL` (pooled), `DATABASE_MIGRATION_URL` (direct),
   `DATABASE_PREPARED_STATEMENTS=false`. Keep all other environment unchanged.
7. **Start the container** and watch the startup banner. It must report
   `postgres` (Neon), not `embedded-postgres`.
8. **Run migrations** if the startup path does not:
   `paperclipai db:migrate` (or the image's equivalent). Confirm it reports the
   same migration count as step 5.
9. **Smoke test:**
   - `GET /api/health` returns 200 through `https://app.increaseai.tech`;
   - companies and agents load;
   - the Readiness page's `company.neon_app_db` now passes;
   - start one Hermes heartbeat run and confirm it completes;
   - confirm a task comment and a run-log entry are written.
10. **Record** the cutover time, final row counts, migration count and the first
    successful heartbeat run id in this document (or the incident ticket).

## Rollback

The embedded data directory is the rollback source and is never modified during
the cutover.

1. Stop the container.
2. Restore the previous environment: remove `DATABASE_URL`,
   `DATABASE_MIGRATION_URL` and `DATABASE_PREPARED_STATEMENTS` (or point them at
   the embedded defaults).
3. Start the container and confirm the banner reports `embedded-postgres`.
4. Verify `/api/health`, companies, agents and one heartbeat run.
5. If the app wrote to Neon between cutover and rollback, those writes are not in
   the embedded database. Either accept the loss window (record its start and
   end) or dump the Neon database and restore it into the embedded data
   directory before step 3. That restore is destructive to the embedded copy and
   needs an explicit decision.

## Explicit non-goals of this pass

- The live container was not restarted, stopped, or reconfigured.
- No migration was applied to the live database.
- No production env var or 1Password item was written from this session.
- The staging branch compute can be suspended or removed after the cutover; that
  is a separate, operator-approved cleanup.

## Neon ads connector

`ads` already exists on the production branch of the `paperclip` project.
`dashboard_ro` exists on the branch and reads all 80 `ads` tables with zero
write privileges (`rolsuper=false`, no INSERT/UPDATE/DELETE). The existing
Paperclip Neon connection is disabled, its OAuth token has expired, and
`methodConfig.readOnly` is `false`, so it cannot satisfy
`tools.neon_ads_readonly`.

Create a company tool connection that names the ads database, for example:

```json
{
  "name": "Neon ads (read-only)",
  "applicationName": "Neon",
  "transport": "mcp_remote",
  "authKind": "api_key",
  "enabled": true,
  "config": {
    "url": "https://mcp.neon.tech/mcp",
    "database": "ads",
    "readOnly": true,
    "projectId": "twilight-glade-11976094"
  },
  "credentialSecretRefs": [
    { "secretId": "<Paperclip secret id for NEON_ADS_RO>", "configPath": "headers.Authorization" }
  ]
}
```

POST `/api/companies/05d9915d-c489-4f17-a919-7603354be43f/tools/connections`
as a board user. The secret must come from the 1Password connector or a
company secret; do not put the password in `config`.

## GBrain MCP connector

The live GBrain MCP endpoint is `https://srv2155332.tailde26a1.ts.net/mcp`
(streamable HTTP, bearer auth, read-only access). Verified in this session from
the host and from inside the app container: `GET` returns 405 (the transport
rejects GET, so the process is reachable), and a real MCP `tools/call` through
the bearer token returned 131 tools and a reranked search.

All three Hermes profiles on `srv2155332` already point at it, so no profile
edit or backup was needed:

| Profile | Entry |
| --- | --- |
| `ads-checker` | `mcp_servers.gbrain.url = http://127.0.0.1:3131/mcp` |
| `research` | same |
| `website-builder` | same |

Each carries `Authorization: Bearer ${GBRAIN_TOKEN}` and the token is in
`/root/.hermes/.env` (mode 600). Nothing was changed there.

Search proof (real `tools/call`, token never printed): `search_modes` reports
`reranker_readiness: {model: "voyage:rerank-3-lite", enabled: true, ready: true}`;
a `query` returned hit `score 0.8185`, `score_details.final 0.9416`, with the
vector arm rank 1 and the keyword arm rank 1, RRF applied, blend `rrf 0.7 /
cosine 0.3`.

Paperclip does not yet have a GBrain connector on any company, so
`memory.gbrain_connected` and `company.gbrain` fail live. The connection body:

```json
{
  "name": "GBrain",
  "applicationName": "GBrain",
  "transport": "mcp_remote",
  "authKind": "api_key",
  "enabled": true,
  "config": {
    "url": "https://srv2155332.tailde26a1.ts.net/mcp"
  },
  "credentialSecretRefs": [
    { "secretId": "<Paperclip secret id for GBRAIN_TOKEN>", "configPath": "headers.Authorization" }
  ]
}
```

POST the same path as above. Board authentication is required and was not
available from this session (the deployment is `authenticated`, `/api/companies`
returns 403 without a session, and board keys are stored hashed), so the
connector could not be created here.
