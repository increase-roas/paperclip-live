# GBrain cutover runbook: `api_key` on the live connection

Status: **prepared, not executed.** The live connection
`2a6b1bcc-e0ed-4855-94ec-a4af618b9879` was not touched.

This replaces the earlier prose plan with commands. It is the same procedure that
was proven on a master-based instance; only the live API calls are new.

## Current state (read from the live database)

| Field | Value |
| --- | --- |
| Connection | `2a6b1bcc-e0ed-4855-94ec-a4af618b9879` |
| Name | GBrain |
| Status / health | `draft` / `error` |
| Auth kind | `oauth` |
| Credential policy | `shared` |
| Transport | `mcp_remote` at `https://srv2155332.tailde26a1.ts.net/mcp` |

## What was proven on master

On a PGlite instance built from `4da6c538dbdb` (merged master `7161102a`):

- `authKind: "api_key"` with a header credential ref → health 200, stays
  `api_key`, "Remote MCP server responded to `tools/list`".
- `PATCH authKind: "oauth"` → health 422; `PATCH` back → 200 and still `api_key`.
- `whoami` and `search` through the app returned GBrain data, rerank model
  `voyage:rerank-3-lite`, with timings and cost in the result.

Operational finding: `credentialRefs` alone is not enough. Health and catalog
read the connection; **tool execution** reads the grant, so the grant needs the
matching `credentialSecretRefs` entry or every call 401s.

## Prerequisite

The running Paperclip image must contain master `7161102a` (the `api_key` fix).

```sh
docker exec paperclip-wze4-paperclip-1 sh -c 'curl -s http://localhost:3100/api/health' \
  | jq -r .commit
# expect the merge commit of PR #48/#50, or any master commit >= 7161102a
```

If the commit is older, stop. On the old image the probe flips the connection
back to `oauth` and it fails again.

## Approval

> Approve the GBrain cutover: store the token as a secret, switch the connection
> to `api_key`, add the grant credential ref, and prove one search.

## Rollout

```sh
PAPER=https://app.increaseai.tech
BOARD_KEY=...                                   # board key, never printed
COMPANY=05d9915d-c489-4f17-a919-7603354be43f    # Increase Roas
GBRAIN=2a6b1bcc-e0ed-4855-94ec-a4af618b9879
AUTH="authorization: Bearer $BOARD_KEY"
```

### 1. Record the current shape (read-only)

```sh
curl -s -H "$AUTH" "$PAPER/api/tool-connections/$GBRAIN" \
  | jq '{id,status,enabled,authKind,credentialPolicy,transport}' > /tmp/gbrain-before.json
cat /tmp/gbrain-before.json
```

```sql
select id, status, auth_kind, credential_policy, transport, credential_refs, credential_secret_refs
from tool_connections where id = '2a6b1bcc-e0ed-4855-94ec-a4af618b9879';
select id, credential_secret_refs from connection_grants
where connection_id = '2a6b1bcc-e0ed-4855-94ec-a4af618b9879';
```

Keep both. `/tmp/gbrain-before.json` is the rollback record.

### 2. Store the token as a secret

The value is the raw token from 1Password, with no `Bearer ` prefix.

```sh
TOKEN="$(op read 'op://JAVAR AGENT/gbrain-mcp-token/credential')"
curl -s -X POST -H "$AUTH" -H 'content-type: application/json' -d "$(jq -n \
  --arg name "GBrain MCP token" --arg value "$TOKEN" \
  '{name:$name, provider:"local_encrypted", value:$value}')" \
  "$PAPER/api/companies/$COMPANY/secrets" | jq -r .id
# -> SECRET_ID
```

Never echo `$TOKEN`. If a separate Paperclip token is preferred, create it in
GBrain first and use it here instead; nothing else changes.

### 3. Switch the connection to `api_key`

```sh
curl -s -X PATCH -H "$AUTH" -H 'content-type: application/json' -d "$(jq -n \
  --arg secret "$SECRET_ID" '{
    authKind: "api_key",
    credentialPolicy: "shared",
    status: "active",
    credentialRefs: [{name:"authorization", secretId:$secret, placement:"header", key:"Authorization", prefix:"Bearer "}],
    credentialSecretRefs: [{secretId:$secret, configPath:"credentials.authorization", versionSelector:"latest"}]
  }')" "$PAPER/api/tool-connections/$GBRAIN" \
  | jq '{id,status,authKind}'
# expect authKind: "api_key", status: "active"
```

### 4. Put the same ref on the grant

```sh
curl -s -X POST -H "$AUTH" -H 'content-type: application/json' -d "$(jq -n \
  --arg secret "$SECRET_ID" '{credentialSecretRefs:[
    {secretId:$secret, configPath:"credentials.authorization", versionSelector:"latest"}]}')" \
  "$PAPER/api/tool-connections/$GBRAIN/grants/installations" | jq .
```

### 5. Health check, then a real search

```sh
curl -s -X POST -H "$AUTH" "$PAPER/api/tool-connections/$GBRAIN/health-check" \
  | jq '{status, healthStatus, message}'
# expect status active, healthStatus ok, tools/list answered

curl -s -H "$AUTH" "$PAPER/api/tool-connections/$GBRAIN/catalog" \
  | jq '[.catalog[] | .toolName // .name]' | head -c 400
# find the search tool name; the proven one is "search"

curl -s -X POST -H "$AUTH" -H 'content-type: application/json' -d '{
  "agentId": "<agent id>",
  "toolName": "search",
  "parameters": { "query": "increase roas" }
}' "$PAPER/api/tool-connections/$GBRAIN/test-calls" \
  | jq '{decision, body: (.result.content // .result.data // .result | tostring | .[0:400])}'
# expect decision "allowed" and GBrain hits; search_modes reports voyage:rerank-3-lite
```

### 6. Confirm the connection did not flip

```sh
curl -s -H "$AUTH" "$PAPER/api/tool-connections/$GBRAIN" \
  | jq '{status,authKind,healthStatus}'
# expect authKind "api_key"; status not "draft"
```

## Verification

| Check | Expected |
| --- | --- |
| `GET /api/tool-connections/<id>` | `authKind: "api_key"`, `status: "active"` |
| `POST …/health-check` | `healthStatus: "ok"`, tools/list answered |
| `POST …/test-calls` `search` | `decision: "allowed"`, GBrain hits, `voyage:rerank-3-lite` |
| One agent task that uses GBrain | still succeeds |

## Rollback

```sh
curl -s -X PATCH -H "$AUTH" -H 'content-type: application/json' -d '{
  "authKind": "oauth", "status": "draft", "credentialRefs": [], "credentialSecretRefs": []
}' "$PAPER/api/tool-connections/$GBRAIN" | jq '{status,authKind}'
```

Leave the secret in the vault; without refs it grants nothing. Rollback is
immediate and needs no restart: connection rows are read per request. Agents keep
using the Hermes-profile MCP entry they used before.

## Why not `oauth`

GBrain is a bearer-token server. OAuth discovery at that endpoint fails, so any
automatic refresh writes `authKind: oauth` and the connection errors again. The
fix keeps an explicit `api_key`, which the probe must not override. If a future
probe flips it back, that is a regression, not a configuration error.

## Open question for Alex

The 1Password token is the same one already rendered into each Hermes profile
`.env`. If you prefer a separate holder, create a GBrain token for Paperclip and
use it in step 2; nothing else changes.

Nothing in this document has been executed.
