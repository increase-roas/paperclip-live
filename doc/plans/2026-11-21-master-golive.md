# Master go-live sequence (2026-11-21)

One ordered list. Each step names the approval, the command or the runbook
section, and its own rollback. Nothing here was executed.

Two windows need a restart; everything after them is API-only.

| Window | What | Downtime | Steps |
| --- | --- | --- | --- |
| 1 | Gateway Worker release | none (versioned traffic) | 1–5 |
| 2 | Paperclip image swap | one container restart | 6–7 |
| After | GBrain, keys, Drive, agent cutover | none | 8–11 |
| Later | ElevenLabs release | none (versioned traffic) | 12 |

## Runbooks this sequence uses

| Area | Document |
| --- | --- |
| Gateway deploy, secrets, smoke, rollback | gateway `docs/GOLIVE-2026-11-21.md` (PR #4) |
| Paperclip image build, swap, smoke, rollback | `doc/plans/2026-11-21-composio-freshness-golive.md` (PR #48) |
| Drive cutover | `doc/plans/2026-11-21-drive-cutover-runbook.md` (PR #49) |
| GBrain | `doc/plans/2026-11-21-gbrain-api-key-rollout.md` (PR #49) |
| Design context | `doc/plans/2026-11-21-drive-via-gateway.md` (PR #49) |
| Bots UI | PR #50 |

## Preflight (read-only, before the first approval)

```sh
# Gateway: which version is live (needs the fixed Cloudflare token).
npx wrangler@4 deployments list --name increase-roas-oauth-gateway | head -20
# Expect 934d6934-8e4b-4c10-951a-7549ba1573b1 at 100%.

# Gateway: which secrets exist (names only, never values).
npx wrangler@4 secret list --name increase-roas-oauth-gateway

# Paperclip: live image, rollback tag.
docker inspect paperclip-wze4-paperclip-1 --format '{{.Config.Image}}'
# Expect paperclip-ir:e83b7aa109.

# Paperclip: running commit (GBrain prerequisite needs >= 7161102a).
docker exec paperclip-wze4-paperclip-1 sh -c 'curl -s http://localhost:3100/api/health' | jq -r .commit
```

If the gateway is no longer on `934d6934`, use the current version id as the
rollback target everywhere below and bump the new tag by one.

## Window 1 — Gateway (no downtime)

### 1. Fix the Cloudflare token permissions

**Approval:** none (dashboard work). Do it first; the deploy fails without it.

Follow gateway `docs/GOLIVE-2026-11-21.md` §1. Required, account
`a3f549867f040e13df33e5bd18f785f4`: Workers Scripts **Read + Edit**, D1 Edit,
Cloudflare Pages Edit, Turnstile Edit, Account Settings Read, Zone Read, DNS Edit.

**Proof before moving on:**

```sh
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/a3f549867f040e13df33e5bd18f785f4/workers/scripts" \
  | jq '{success, errors}'
# expect success: true, errors: []
```

**Rollback:** none. Tokens are additive; no state changes.

### 2. Merge gateway PR #4 — not #5

**Approval:** “Merge gateway PR #4.”

PR #4 code was tested at `66467f0` (129/129); the only later commits are docs (this pass included). PR #5 (ElevenLabs) targets
`feat/provider-registry` and has not merged; merging it now would change the
code under test and add a provider whose secret is not set. Ship #4 as v103, #5
as v104 (step 12).

**Rollback:** none for a merge; the deploy is a separate step and reversible.

### 3. Set only the READY Worker secrets

**Approval:** “Set the ready Worker secrets for v103.”

Follow gateway §2. Set:

```sh
npx wrangler@4 secret put GOOGLE_SA_DRIVE_ROBOT < /root/.config/gcp/drive-robot.json
npx wrangler@4 secret put CLOUDFLARE_API_TOKEN
npx wrangler@4 secret put CLOUDFLARE_ACCOUNT_ID
npx wrangler@4 secret put META_ACCESS_TOKEN      # confirm present first
npx wrangler@4 secret put COMPOSIO_API_KEY       # confirm present first
```

`wrangler secret list` from preflight decides “set” vs “already present”; do not
re-put a present secret with an unknown value. **Stop and ask Alex** per provider
whose secret is missing (`GITHUB_APP_*` or `GITHUB_TOKEN`, `RESEND_API_KEY`,
`HOSTINGER_API_TOKEN`, Google Ads OAuth + developer token, optional
Neon/Voyage). A missing secret is a 503 on that route; it does not block the
release.

**Rollback:** `npx wrangler@4 secret delete <NAME>` only for a wrong value.
Secrets do not affect traffic until the next deploy.

### 4. Deploy gateway v103

**Approval:** “Deploy gateway v103.”

Tag: **v103** (next after the live 102). If preflight shows a newer live
version, use the next number.

Follow gateway §3, or the short form:

```sh
cd /workspace/gw/repo && git checkout main && git pull --ff-only
node --test test/*.test.mjs            # 129 pass
deployed/build.sh "Providers v103: registry, GitHub App, Google SA/Ads, Cloudflare, Meta" v103
# upload /workspace/gw/deploy/upload.js through the Composio Cloudflare connection
#   -> NEW_VERSION=<uuid>
BASE="https://${NEW_VERSION:0:8}-increase-roas-oauth-gateway.increase-roas.workers.dev"
curl -s "$BASE/health" | jq .status                                  # "ok"
curl -s -H "authorization: Bearer $ADMIN_KEY" "$BASE/api/providers" | jq '.providers | length'   # 14
deployed/promote.sh "$NEW_VERSION" "Providers v103"
```

**Rollback:**

```sh
npx wrangler@4 versions deploy 934d6934-8e4b-4c10-951a-7549ba1573b1@100% --yes
```

No D1 change; secrets stay set.

### 5. Verify, then re-consent GHL if needed

**Approval:** none for verification; the re-consent is a browser click.

Run gateway §4. Then:

```sh
curl -s -H "authorization: Bearer $ADMIN_KEY" "$BASE/api/status" | jq '.ghlScopes'
```

If `missing` is not empty, open `$BASE/oauth/start`, finish the HighLevel
consent, and repeat until `missing: []` (gateway §4.1). Consent is additive.

**Rollback:** redeploy the previous version id; scopes are unaffected.

## Window 2 — Paperclip image (one restart)

### 6. Merge #48 and #50, then swap the image once

**Approval:** “Merge #48 and #50 and swap the Paperclip image.”

Both are no-migration changes: #48 adds the Composio background refresh, #50 is
the readiness Bots/Agents split. Merging both before the build means one image
and one restart.

Follow `2026-11-21-composio-freshness-golive.md` §Build the image and §Deploy,
with two corrections already applied there: build from a clean worktree of the
merge commit (the old `/srv/paperclip-dev/wt-integration` path does not exist),
and create the `ir-builder` builder if it is missing.

**Rollback:** point the compose image back to `paperclip-ir:e83b7aa109` and
`docker compose up -d`. No database restore (no migration).

### 7. Smoke both changes

**Approval:** none.

- Composio: a healthy account older than five minutes reads **Connected**, not
  “Last check failed”; `tool_connection_app_syncs.last_completed_at` advances
  without a manual Refresh (runbook §Smoke test).
- Readiness: `/readiness` shows **Bots** and **Agents** sections with counts; a
  `grokBotTwin` agent carries the **Grok twin** badge.

**Rollback:** same image rollback as step 6.

## After both windows — API only, no restart

### 8. GBrain `api_key` cutover

**Approval:** “Approve the GBrain cutover.”

Follow `2026-11-21-gbrain-api-key-rollout.md`: store the token, PATCH to
`api_key`, add the grant credential ref, prove a search (`voyage:rerank-3-lite`),
confirm the connection did not flip.

**Rollback:** PATCH back to `authKind: "oauth"`, `status: "draft"`, empty refs.
Immediate; no restart.

### 9. Issue and store the gateway keys

**Approval:** “Issue the gateway keys.”

Gateway §6.1: keys for `website-builder`, `funnel-builder`, `ads-checker`,
`research`; store each in 1Password (`gateway-<agent>-key`); never print them.
Policies already enforce Drive write only on `funnel-builder`.

**Rollback:** `POST /api/admin/agents/<agent>/keys/revoke`; the old key stops
working on the next request.

### 10. Drive cutover

**Approval:** “Approve the Drive cutover: connections, read proof, funnel-builder
write proof, then disable (not delete) `689b44c0`.”

Follow `2026-11-21-drive-cutover-runbook.md` in order: record `689b44c0`, secret
per agent, one connection per agent, grant credential ref, catalog refresh,
install for that agent only, read proof, write proof for `funnel-builder`, then
disable `689b44c0` last.

**Rollback:** re-enable `689b44c0`, remove the new installs, disable the new
connections. Keep the old row.

### 11. Cut the remaining agents over

**Approval:** “Cut the remaining agents over to their gateway keys.”

Same pattern as step 10 for any other provider: one MCP connection per agent, its
own key, install for that agent, prove one real call. No deploy.

**Rollback:** disable the new connection and remove its install; the agent falls
back to its previous connection.

## Later

### 12. ElevenLabs PR #5 as v104

**Approval:** “Merge ElevenLabs PR #5 and deploy v104” — and set
`ELEVENLABS_API_KEY` before anyone calls that provider.

Merge #5 into `feat/provider-registry`, confirm tests (144), then repeat gateway
§3–§4 with tag `v104`. Until the secret is set, that provider returns 503.

**Rollback:** deploy the step-4 v103 version id.

## Contradictions resolved in this pass

- **v103 vs v104:** `docs/DEPLOY-2026-11-21.md` said v103, `docs/GOLIVE` said
  v104, live is 102. Standardised on **v103** for PR #4; #5 becomes v104.
- **“Ready” secrets:** the gateway runbook listed Meta and Composio as ready while
  the deploy notes said Meta was not set for v102. The sequence now requires
  `wrangler secret list` and treats “ready” as “confirmed present”.
- **Paperclip build path:** the #48 runbook used `/srv/paperclip-dev/wt-integration`,
  which does not exist; replaced with a clean worktree of the merge commit.
- **Missing builder:** `ir-builder` does not exist on this host; the runbook now
  creates it.
- **GBrain prerequisite:** it checked `/api/health .version`, which is null on
  the live build; it now checks `.commit`.
- **Key order:** keys must exist before Drive connections; the sequence issues
  them at step 9, before step 10.

## First approval

> **Approve the Cloudflare token fix and the gateway v103 release.**

Then the later approvals in order: Paperclip image (step 6), GBrain (8), keys (9),
Drive (10), remaining agents (11), ElevenLabs (12).
