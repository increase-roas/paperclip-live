# Go live: Composio app-list freshness (PR #48)

Status: **prepared, not executed.** The live container was not touched.

This is the release procedure for
[PR #48](https://github.com/increase-roas/paperclip-live/pull/48). The change
has no database migration, so a rollback is an image swap only.

## What the change does

- One shared freshness window (`AGGREGATOR_APP_SYNC_TTL_MS`) and one sweep
  cadence (`AGGREGATOR_APP_SYNC_SWEEP_MS`) in `@paperclipai/shared/aggregator-apps`.
- A scheduled Composio refresh (`aggregator-app-sync` delivery queue) that
  refreshes only active gateways with a healthy, due sync row, skips rows whose
  credential version changed, and leaves failed checks for the manual Refresh.
- Age alone no longer marks an account as needing attention. The chip says
  "Last check failed · Refresh to verify" only when the last check failed.
- No schema change, no migration, no new environment variable.

## Before you start

```sh
# On the host, as root.
export C=paperclip-wze4-paperclip-1
export D=/docker/paperclip-wze4

# 1. The PR is merged to master and the merge commit is known.
git -C /srv/paperclip-report fetch origin
git -C /srv/paperclip-report log --oneline -1 origin/master   # record <merge-sha>

# 2. Baseline: current image and health.
docker inspect $C --format '{{.Config.Image}}'                # paperclip-ir:e83b7aa109 (rollback tag)
curl -s https://app.increaseai.tech/api/health | jq -r .status # ok
docker exec $C paperclipai --version 2>&1 | tail -1
```

Record the current image tag. `paperclip-ir:e83b7aa109` is the rollback image
unless the live tag changed since this document was written.

## Build the image

Use the same bake target as the live image (repo `docker/increase-roas/docker-bake.hcl`).
Build from a clean checkout of the merge commit, never from a dirty worktree.
The host has no `ir-builder` builder today; the command below creates one limited
to 4 CPUs / 12 GB on first use.

```sh
RELEASE=/srv/paperclip-release
git -C /srv/paperclip-report fetch origin

# Clean worktree at the merge commit (replace <merge-sha>).
git -C /srv/paperclip-report worktree remove --force "$RELEASE" 2>/dev/null || true
git -C /srv/paperclip-report worktree add --detach "$RELEASE" <merge-sha>
cd "$RELEASE"

SHA=$(git rev-parse --short=12 HEAD)
export TAG=paperclip-ir:$SHA
docker buildx inspect ir-builder >/dev/null 2>&1 || \
  docker buildx create --name ir-builder --driver docker-container \
    --driver-opt cpu-quota=400000 --driver-opt memory=12g

PAPERCLIP_BUILD_COMMIT=$(git rev-parse HEAD) \
PAPERCLIP_BUILD_VERSION="$(node -p "require('./cli/package.json').version")-ir.${SHA:0:7}" \
TAGS="$TAG" \
  docker buildx bake --builder ir-builder -f docker/increase-roas/docker-bake.hcl ir --load \
  | tee /tmp/build-$SHA.log
```

The `--load` step copies the image into the local Docker engine, which the
compose file uses. Expect a 15–40 minute first build; later builds reuse the
builder cache.

Verify the image before it goes near the compose file:

```sh
docker run --rm --entrypoint sh $TAG -c '
  paperclipai --version
  for c in node pnpm rg jq gh git; do command -v $c >/dev/null && echo -n "$c ok, " || echo "$c MISSING"; done; echo'
```

Expect the version line and no `MISSING`. If the build or the check fails, stop:
the live container is untouched.

## Deploy

```sh
TS=$(date -u +%Y%m%dT%H%M%S)
cd $D

# 1. Snapshot the compose file and the embedded database (reversible).
cp docker-compose.yml docker-compose.yml.bak-$TS
cp -a data/instances/default/db db-snapshot-$TS
du -sh db-snapshot-$TS

# 2. Point the service at the new image.
sed -i "s|image: paperclip-ir:e83b7aa109|image: $TAG|" docker-compose.yml
grep -n "image:" docker-compose.yml

# 3. Recreate the container. This is a restart: run it in a quiet window.
docker compose up -d
```

Wait for health (up to 5 minutes; the first boot runs schema checks):

```sh
for i in $(seq 1 60); do
  sleep 5
  H=$(docker exec $C sh -c 'curl -s -m 8 http://localhost:3100/api/health' 2>/dev/null | grep -o '"status":"[a-z]*"' | head -1)
  P=$(curl -s -o /dev/null -m 10 -w '%{http_code}' https://app.increaseai.tech/)
  echo "$H site=$P"
  [ "$H" = '"status":"ok"' ] && [ "$P" = "200" ] && break
done
```

If health or the public URL does not recover, run the rollback immediately.

## Smoke test: the reported bug

1. Open `https://app.increaseai.tech` → **Connectors** → the Composio gateway →
   an app with at least one healthy account.
2. If the account was last checked more than five minutes ago and the last check
   succeeded, it must read **Connected**, not "Last check failed · Refresh to
   verify".
3. Leave the page open for six minutes without pressing Refresh. The chip must
   stay **Connected**.

Server evidence that the sweep is running (the scheduled worker refreshes due
rows without a user action):

```sh
# Inside the container namespace, read-only.
CID=$(docker inspect -f '{{.Id}}' $C)
docker run --rm --network container:$CID -e PGPASSWORD=paperclip postgres:18 \
  psql -h 127.0.0.1 -p 54329 -U paperclip -d paperclip -At -F '|' -c "
    select connection_id, status,
           to_char(last_completed_at, 'HH24:MI:SS') as completed,
           round(extract(epoch from (now() - last_completed_at)) / 60) as age_min
    from tool_connection_app_syncs
    where status = 'ready'
    order by last_completed_at desc limit 5;"
```

Expect at least one `ready` row with `age_min` below the five-minute window
shortly after the deploy, and `last_completed_at` advancing on later checks
without anyone pressing Refresh.

If the RSS/tick log is enabled, the delivery worker also appears as
`aggregator-app-sync` in the queue logs. Absence of that line is not a failure by
itself; the database check above is the authoritative one.

## Rollback

The change has no migration. Roll back the image and leave the data alone:

```sh
cd $D
sed -i "s|image: $TAG|image: paperclip-ir:e83b7aa109|" docker-compose.yml
docker compose up -d
for i in $(seq 1 60); do sleep 5; H=$(docker exec $C sh -c 'curl -s -m 8 http://localhost:3100/api/health' | grep -o '"status":"[a-z]*"' | head -1); [ "$H" = '"status":"ok"' ] && break; done
docker exec $C paperclipai --version 2>&1 | tail -1
```

Restore the database snapshot only if the failed attempt wrote data (this PR
does not change the schema, so normally you do not):

```sh
# Stop first; then swap the directories; then start.
docker compose stop
mv data/instances/default/db data/instances/default/db-failed-$TS
cp -a db-snapshot-$TS data/instances/default/db
docker compose up -d
```

A sync-row change is harmless to keep: the old code ignores the sweep and still
reads the same table.

## After go-live — planned, needs a second approval

These steps are not part of the deploy:

1. Issue the four gateway keys and store them in 1Password
   (`website-builder`, `funnel-builder`, `ads-checker`, `research`) using
   `docs/GOLIVE-2026-11-21.md` in the gateway repo.
2. Replace the broken Google Drive OAuth connection `689b44c0` with the
   gateway-backed connection described in
   `doc/plans/2026-11-21-drive-via-gateway.md`.
3. Cut each agent over one at a time with a real read, then disable — do not
   delete — the old connection.

## Abort criteria

- `/api/health` is not `ok` after 5 minutes.
- The public site does not return 200.
- Any agent run fails with a tool-access error that did not occur before.
- The Composio sweep refreshes a failed row automatically (it must not).
