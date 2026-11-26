# Increase ROAS copy of Paperclip

Private copy of [paperclipai/paperclip](https://github.com/paperclipai/paperclip) used to build features for the Increase ROAS Paperclip at `https://app.increaseai.tech`. Read upstream's `AGENTS.md` and `doc/DEVELOPING.md` first; this file only covers what is different here.

## Base

- Started from `beta/v2026.1110.0-beta.0` = upstream commit `09e24dd12c36251dd12af2d73dbc715ce990f922`, the version the live server ran on 2026-11-20 (`paperclipai@2026.1110.0-beta.0`, confirmed by its `/api/health` `commit`).
- Remotes: `origin` = this repo, `upstream` = `https://github.com/paperclipai/paperclip.git`.
- Default branch `master` (same name as upstream, so merges stay simple).

## What we add (keep it all under these paths)

| Path | Purpose |
|---|---|
| `IR.md` | This file |
| `.github/workflows/ir-ci.yml` | CI on GitHub-hosted runners: install, `pnpm build`, `pnpm typecheck`, `pnpm test:run:general`, `pnpm test:run:serialized`. PRs run build + typecheck only; the test suites run on `master` pushes and on PRs with the `full-ci` label |
| `.github/workflows/ir-image.yml` | Builds and publishes `ghcr.io/increase-roas/paperclip` (private) on every push to `master` |
| `.github/workflows/ir-upstream-sync.yml` + `scripts/ir/upstream-sync.sh` | Daily: one PR per new upstream release; clashes listed in the PR |
| `.github/workflows/ir-guard.yml` | Switches off upstream's workflows in repo settings (they need Paperclip's own runners and secrets) |
| `.github/actions/ir-setup/` | Shared Node/pnpm/Rust setup for IR CI |
| `docker/increase-roas/` | Our image: upstream `production` target + the live server's Python/Playwright toolbox |
| `packages/shared/src/ir-metrics.ts` | The one metric library (show, offer, close, set rate, CPL, CTR, CAC, agency vs client ROAS, MRR, active/paused/cancelled). GBrain `definitions/` pages point here with `calculation: ir-metrics#<fn>` |
| `packages/shared/src/ir-system-map.ts` + `server/src/ir/system-map.ts` + `ui/src/ir/pages/SystemMapPage.tsx` | Native System Map (`/INC/system-map`): live topology, health checks, data age and the GBrain skeleton, read from the brain-vps `ir-system-feed` (company-ops `tools/ir-system-feed`). Instance admins only |
| `server/src/ir/proof-gate.ts` | Proof-gated closure: an issue with a `proof:<check>` label (for example `proof:gateway`) cannot move to `done` until that ir-doctor check passes (422 `ir_proof_check_not_passing`) |
| `scripts/ir/ir-metric-guard.mjs` | CI guard in the IR files job: no inline metric formulas, static client counts or hardcoded GHL/Meta IDs in `ui/src/ir` and `server/src/ir` |

Removed from upstream: `.github/dependabot.yml` (dependency updates arrive through upstream-sync PRs).

## Rules

- Change upstream files only when a feature needs it, and keep changes small: every change is a possible clash in future upstream-sync PRs.
- Every PR needs **IR CI passed** green before merging. Add the `full-ci` label to run the test suites on a PR before merge.
- Never bulk re-run failed CI runs. After a billing block, fix the cause, then re-run one PR at a time.
- Keep open agent PRs to a small number at a time, or batch work into one PR. Every PR push starts CI.
- Merging to `master` publishes a new image. It does **not** change the server. Switching the server follows `SWAP.md` in [increase-roas/paperclip-server](https://github.com/increase-roas/paperclip-server), only with Alex's yes.
- No keys in this repo. Repo secret `IR_SYNC_TOKEN` (fine-grained, this repo only) is used by upstream sync.
- No account IDs in code. The server reads them from env: `META_AGENCY_INCREASE_ROAS_ACCOUNT_ID`, `META_AGENCY_ALEX_BLOOMFIELD_ACCOUNT_ID`, `META_AGENCY_HOT_TUB_LAUNCH_ACCOUNT_ID`, `GHL_AGENCY_COMPANY_ID`, `GHL_AGENCY_INCREASE_ROAS_LOCATION_ID`, `GHL_AGENCY_HOT_TUB_LAUNCH_LOCATION_ID`, `GHL_ALEX_BLOOMFIELD_LOCATION_ID` (register: brain `ops/agency-vs-client-accounts.md`). An unset ID shows that account as needs-config.
- The System Map and proof checks read `IR_SYSTEM_FEED_URL` + `IR_SYSTEM_FEED_KEY` (key also in `/root/.config/ir-system-feed/feed.key` on brain-vps). Unset means the page says "not configured" and proof-labelled issues cannot close.
