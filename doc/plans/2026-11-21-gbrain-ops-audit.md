# GBrain server ops audit (read-only) — 2026-11-21

Status: **audit only. Nothing on `srv2155332` was changed.** Every command below
was read-only; the fixes are a plan and wait for Alex.

## Access used

| Item | Value |
| --- | --- |
| Host | `srv2155332` / `100.84.1.118` (tailnet `srv2155332.tailde26a1.ts.net`) |
| Reachability | `tailscale ping` pong in 5 ms; tailscale status `active` |
| SSH | `ssh -i /root/.ssh/backup_to_brain root@srv2155332` (key already on this host) |
| Uptime | 9 days, load 0.14 |
| Runbook read | `/root/ops/RUNBOOK.md` (nine systems) |

## Findings

### 1. “INDEX.md points at …/sources/Team” is a false positive

The audit's path extractor truncates a backticked path at the first space:

- `ops-audit.sh` reads every backtick span, then matches
  `/(root|usr|…)(/[A-Za-z0-9._@%+-]+)+` — a character class **without spaces**.
- `INDEX.md:74` points at
  `` `/root/company-brain/sources/Team Hub + SOPs/01 SOPs & Playbooks/…` ``.
- The extractor keeps only `/root/company-brain/sources/Team`, which does not
  exist, and `ops-audit.sh:411` writes:
  “INDEX.md points at /root/company-brain/sources/Team, which does not exist.”

The directory really is `/root/company-brain/sources/Team Hub + SOPs` (verified
with `ls`). The index text is correct; the checker is wrong.

**Fix (choose one):**

- **A (recommended):** teach the extractor to accept a whole backticked path when
  it exists. In the loop after `rg -o '`[^`]+`'`, before the regex fallback:

```bash
case "$span" in
  /root/*|/usr/*|/etc/*|/var/*|/opt/*|/srv/*|/home/*)
    if [ -e "$span" ]; then printf '%s\n' "$span"; continue; fi ;;
esac
```

- **B (no code):** stop using spaces in the path inside INDEX.md, e.g. write the
  directory as `Team Hub + SOPs` in prose and keep the backticked path escaped
  differently. Lower value: the real directory keeps its name.

**Verify:** `bash /root/ops/watchdog/ops-audit.sh --dry-run` (writes the report,
does not commit) and confirm the flag line is gone.
**Rollback:** `git -C /root/ops checkout -- watchdog/ops-audit.sh`.

### 2. The watchdog is running; “stalled / something marked down” is the audit

| Check | Output |
| --- | --- |
| `cat /root/ops/watchdog/state/last-run` | `2026-11-21T19:40:03Z` (2 minutes before the audit) |
| `systemctl is-active cron` | `active` |
| `bash -n watchdog.sh` | ok |
| `ls state/*.down` | `bkaudit.down` (created 2026-11-19 09:20) |

`check bkaudit … fresh ops-audit.status` requires the status file to contain
` ok`. The file says `2026-11-21T09:11:33Z FLAGGED flags=4`, so the check has
been failing since the audit first flagged. The watchdog did not stall; it is
reporting the audit's own failure. It clears after two passing 5-minute runs once
the audit is green.

**Fix:** resolve findings 1, 3 and 4. No watchdog change is needed. If it ever is
needed, the runbook's single restart is `bash /root/ops/watchdog/watchdog.sh` by
hand, then re-read `last-run`.

### 3. The nightly audit cannot push because the repo is on a feature branch

| Fact | Value |
| --- | --- |
| `origin/main` (remote) | `aebbbc2f43af63d035cb39fdfe738ed09d1e65af` |
| Local `origin/main` / `main` | `50ce10a` (stale, behind remote) |
| Checked-out branch | `readiness/linter-configuration` |
| Audit commit | `a3d336b Nightly audit 2026-11-21` on that branch |
| Dirty files | `TOOLS.md`, `watchdog/watchdog.sh`, plus untracked `crontab.bak`, `drive-sop-sync/`, `watchdog.sh.bak` |

`ops-audit.sh` commits with `git commit` on **whatever branch is checked out**,
then runs `git push origin main`. Local `main` is behind the remote, so the push
is rejected as non-fast-forward; the audit's own commit never reaches `main`.

**Fix (quiet window, no force push):**

```bash
cd /root/ops
git status --short > /tmp/ops-dirty-before.txt
git branch -f backup/audit-2026-11-21 HEAD          # keep the audit commit
git stash push -u -m "pre-reconcile 2026-11-21"     # keep the WIP on its branch
git fetch origin
git checkout main
git merge --ff-only origin/main                     # now aebbbc2
# optional: review `git show a3d336b` and cherry-pick it if its docs belong on main
git log --oneline -1
```

Then leave `main` checked out so the next nightly audit commits and pushes on the
right branch.

**Rollback:** `git checkout readiness/linter-configuration && git stash pop`.
Nothing is pushed or deleted by these steps; `backup/audit-2026-11-21` keeps the
audit commit.

### 4. The Droid check fails for two environment reasons, not a real outage

Running the check the way cron does:

```bash
env -i PATH=/usr/bin:/bin bash -c 'command -v droid || echo NOT_IN_CRON_PATH'
# NOT_IN_CRON_PATH
```

`droid mcp list` with a login shell shows the real state:

| Server | Status |
| --- | --- |
| composio, context7 | connected |
| fireflies, supabase | connected (authenticated) after a slower handshake |
| gbrain | **failed** — “credential references an unset environment variable `GBRAIN_DROID_TOKEN`” |
| vercel | needs authentication (known, not a fault) |

The daemon loads `/root/.config/gbrain-droid.env` (`EnvironmentFiles` in the
unit, file is `600`, defines `GBRAIN_DROID_TOKEN`). Cron does not: no
`/root/.local/bin` in `PATH`, and no env file. So the audit's check fails even
though the daemon is healthy.

**Fix:** in `ops-audit.sh` (once, near the top) give the check the same
environment:

```bash
export PATH="/root/.local/bin:$PATH"
set -a; . /root/.config/gbrain-droid.env 2> /dev/null; set +a
```

**Verify:**

```bash
env -i PATH=/usr/bin:/bin HOME=/root bash -c '
  export PATH=/root/.local/bin:$PATH
  set -a; . /root/.config/gbrain-droid.env; set +a
  droid mcp list | grep -E "^(composio|context7|fireflies|gbrain|supabase) "'
# every listed server says connected; gbrain included
```

No secret is printed or moved. The env file already exists.
**Rollback:** `git -C /root/ops checkout -- watchdog/ops-audit.sh`.

## Order of fixes

1. Findings 3 and 4 (repo branch + audit environment) — they make the audit
   trustworthy.
2. Finding 1 (path extractor) — removes the false INDEX flag.
3. Let the audit run once by hand (`bash /root/ops/watchdog/ops-audit.sh`), read
   `ops-audit.status` and `state/ops-audit-flags.txt`.
4. Watchdog clears `bkaudit.down` on the next two 5-minute passes. No restart.

## Approval

> Approve the brain-server ops fixes: reconcile `/root/ops` onto `main` without
> force, give the nightly audit the Droid PATH and `gbrain-droid.env`, and fix
> the path extractor that truncates the “Team Hub + SOPs” directory.

Nothing in this audit was executed. No file, service, cron entry or repo on
`srv2155332` was changed.
