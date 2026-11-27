# Neon database for Paperclip: what it is and how agents use it

> **Status: planned, not live yet.** Today the live Paperclip at `app.increaseai.tech` uses Paperclip's
> built-in database (`embedded-postgres`, stored in `data/instances/default/db` on paperclip-server).
> Everything below becomes available once Alex creates the Neon project and the data is moved. Until
> then, agents can plan work around it but must not assume a Neon database exists.

## Why we are adding Neon

Paperclip's own docs (`docs/deploy/database.md`) list three ways to run its database: embedded (the
default, "local development, one-command installs"), Postgres in Docker, and hosted Postgres ("production
and shared deployments"). We are moving to hosted Postgres, and we picked **Neon**.

### What makes Neon different

Neon **splits the database into two parts**: the storage (the data) and the compute (the engine that runs
queries). Normal Postgres keeps both on one machine. That split is what makes these possible:

1. **Instant copies (branches).** A copy of the whole database is ready in seconds and costs almost
   nothing at first, because it shares the same stored data and only saves what changes. Like git
   branches, for the database.
2. **Time travel.** Neon keeps the change history, so it can make a copy of the database exactly as it
   was at any minute inside the history window (1 day on Free, up to 7 days on paid plans). Undo without
   restoring backups.
3. **The engine sizes itself.** It scales up when busy and down when quiet, and can switch off when idle.
4. **Built for AI agents.** Agents can create and delete their own databases on the fly.

### What it means for us

- **Every agent gets its own copy of real Paperclip data.** An agent building a feature tests on its own
  instant copy of our real companies, tasks and agents: not fake data, and never live. When it is done,
  the copy is deleted.
- **Every swap is tested on real data first.** Before a new Paperclip image goes live, point it at a fresh
  copy and confirm it works (see `SWAP.md` in `increase-roas/paperclip-server`).
- **Any mistake can be undone to the minute.**

We compared Supabase (the example in Paperclip's docs). Supabase sells minute-level restore as an add-on
(about $100 a month for 7 days), and its branches start empty unless that add-on is bought. Neon includes
both, which is what matters most while agents are changing our company OS.

## How Paperclip connects (from Paperclip's docs)

- Paperclip uses `DATABASE_URL`. Not set means embedded; set means that Postgres. The app logic and the
  Drizzle schema (`packages/db/src/schema/`) are the same in every mode.
- Paperclip runs as one long-lived server, so use Neon's **direct** connection (not the `-pooler` host).
  Neon's pooler runs PgBouncer in transaction mode, which does not support session features.
- If a pooled connection is ever used, set `DATABASE_PREPARED_STATEMENTS=false`.
- Pool settings (`DATABASE_POOL_MAX` and others) are documented in `docs/deploy/database.md`.
- **Production branch:** turn scale-to-zero **off**, so live Paperclip never waits for the engine to wake.
- Back up the secrets master key with the database. A database without the key cannot decrypt agent
  secrets (`docs/deploy/secrets.md`).

## Rules for agents

1. **Never connect to the production branch** (`main`). Always work on your own branch.
2. **Name branches** `agent/<task-or-issue>-<yyyymmdd>` so anyone can see who made them.
3. **Delete your branch when the task is done**, pass or fail.
4. **Never print, log or commit a connection string or key.** Use `--no-secrets` and pass the URL through
   an environment variable. `NEON_API_KEY` lives only in the environment, never in the repo.
5. **Never restore over production yourself.** You may create a time-travel copy to look at data; putting
   it back into production is Alex's call (see example 3).
6. If Neon is not set up yet, say so and use the local embedded database (`pnpm dev`) instead.

## Three simple examples

All three use the Neon CLI (`neon`). Commands come from Neon's CLI docs.

### 1. Build a feature against a copy of real data

Task: "Add a status chip to the top of the left menu."

```sh
# make my own copy of production, named for the task
neon branches create --name agent/status-chip-20261121 --no-secrets

# get its connection string into an env var (never echo it)
export DATABASE_URL="$(neon connection-string agent/status-chip-20261121)"

# run Paperclip against the copy and build/QA the feature
pnpm dev:once

# done: delete the copy
neon branches delete agent/status-chip-20261121
```

The agent sees real companies, real tasks and Javar in the sidebar while it works. Nothing it does
touches live data.

### 2. Test an upstream Paperclip update before it goes live

Task: "Check that the upstream-sync PR for v2026.1117.0 works with our data."

```sh
neon branches create --name agent/upstream-v2026.1117.0-20261121 --no-secrets
export DATABASE_URL="$(neon connection-string agent/upstream-v2026.1117.0-20261121)"

# start the new version; it applies its database migrations to the COPY
pnpm dev:once
curl -fsS http://127.0.0.1:3100/api/health    # expect "status":"ok"

neon branches delete agent/upstream-v2026.1117.0-20261121
```

If the migrations or the app fail here, the PR is not ready, and live Paperclip never saw the problem.

### 3. Undo a mistake (look first, Alex decides)

Task: "Tasks for a client disappeared around 3:15 pm. Find out what happened."

```sh
# a copy of the database as it was at 3:10 pm (time in UTC, RFC 3339)
neon branches create --name agent/before-3pm-20261121 --parent 2026-11-21T20:10:00Z --no-secrets
export DATABASE_URL="$(neon connection-string agent/before-3pm-20261121)"

# compare: query the copy, list what existed at 3:10 pm, write the findings in the task
```

The agent reports exactly what was lost and when. Restoring production from that point is a decision
for Alex, made in the Neon console.

## Setup still waiting on Alex

- [ ] Create the Neon project (region near paperclip-server, US East) on a paid plan for the 7-day history.
- [ ] Turn scale-to-zero off on the production branch.
- [ ] Move the data from the embedded database to Neon, with a snapshot first and rollback ready (its own
      runbook, like `SWAP.md`).
- [ ] Put `NEON_API_KEY` and `NEON_PROJECT_ID` where agents run (server-only env, never in a repo).
- [ ] Later: move uploads to Cloudflare R2 (Paperclip's docs: "For production or multi-node deployments,
      use S3-compatible object storage").

## Sources

- Paperclip: `docs/deploy/database.md`, `docs/deploy/secrets.md`, `docs/deploy/storage.md` in this repo
- Neon: connection pooling, branching, instant restore and CLI docs (neon.com/docs)
- Supabase: backups / point-in-time recovery pricing and branching docs (supabase.com/docs)
