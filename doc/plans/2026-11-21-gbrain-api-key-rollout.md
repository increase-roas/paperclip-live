# GBrain connection: roll `api_key` live (rollout + rollback)

Status: **plan, not executed.** The live connection was not touched.

## Current state (read from the live database)

| Field | Value |
| --- | --- |
| Connection | `2a6b1bcc-e0ed-4855-94ec-a4af618b9879` |
| Name | GBrain |
| Status / health | `draft` / `error` |
| Auth kind | `oauth` |
| Credential policy | `shared` |
| Transport | `mcp_remote` at `https://srv2155332.tailde26a1.ts.net/mcp` |

The running image predates the fix, so the connection cannot be repaired on the
live container until the image that contains master `7161102a` (or later) is
deployed. The fix itself is on master: an explicit `api_key` is honoured for
header credentials, and the probe no longer flips the connection to `oauth`.

## What was proven on master

On a PGlite instance built from `4da6c538dbdb` (merged master `7161102a`):

- connection created with `authKind: "api_key"` plus a header credential ref →
  health check 200, `authKind` stays `api_key`, "Remote MCP server responded to
  `tools/list`".
- `PATCH authKind: "oauth"` → health check 422, which is the failure the fix
  prevents.
- `PATCH` back to `api_key` → health check 200, `authKind` stays `api_key`.
- `whoami` and `search` executed through the app returned GBrain data.

Operational finding: a connection created through the API with `credentialRefs`
does not send a credential on **tool execution** until its connection grant also
carries a matching `credentialSecretRefs` entry
(`configPath: credentials.authorization`). Health checks and catalog refresh read
the connection refs directly, so they pass while tool calls 401. The measured
rerank is `voyage:rerank-3-lite` with timings and cost reported by GBrain.

## Prerequisite

The Paperclip image on the live host must be the one built from master
`7161102a` or later. Confirm before starting:

```sh
docker exec paperclip-wze4-paperclip-1 sh -c 'curl -s http://localhost:3100/api/health' | jq -r .version
# expect 2026.1106.0+<commit> with commit >= 7161102a, or the release that contains it
```

If the running commit is older, stop. Do not PATCH the live connection on the old
image: it will flip back to `oauth` and fail again.

## Rollout

1. **Record the current row** for rollback (read-only):

```sql
select id, status, auth_kind, credential_policy, transport, credential_refs, credential_secret_refs
from tool_connections where id = '2a6b1bcc-e0ed-4855-94ec-a4af618b9879';
select id, credential_secret_refs from connection_grants
where connection_id = '2a6b1bcc-e0ed-4855-94ec-a4af618b9879';
```

2. **Store the token as a secret** (raw token, no `Bearer ` prefix in the value):

```sh
POST /api/companies/<companyId>/secrets
{ "name": "GBrain MCP token", "provider": "local_encrypted",
  "value": "<op read op://JAVAR AGENT/gbrain-mcp-token/credential>" }
```

   Record the returned secret id. The value is the 1Password item; it is never
   printed, logged or committed.

3. **Patch the connection to `api_key` with a header ref:**

```sh
PATCH /api/tool-connections/2a6b1bcc-e0ed-4855-94ec-a4af618b9879
{
  "authKind": "api_key",
  "credentialPolicy": "shared",
  "status": "active",
  "credentialRefs": [
    { "name": "authorization", "secretId": "<secret id>",
      "placement": "header", "key": "Authorization", "prefix": "Bearer " }
  ],
  "credentialSecretRefs": [
    { "secretId": "<secret id>", "configPath": "credentials.authorization", "versionSelector": "latest" }
  ]
}
```

4. **Add the same ref to the grant** so tool calls carry it:

```sh
POST /api/tool-connections/2a6b1bcc-e0ed-4855-94ec-a4af618b9879/grants/installations
{ "credentialSecretRefs": [
  { "secretId": "<secret id>", "configPath": "credentials.authorization", "versionSelector": "latest" }
] }
```

5. **Health check, then one real tool call per installed agent:**

```sh
POST /api/tool-connections/2a6b1bcc-e0ed-4855-94ec-a4af618b9879/health-check
POST /api/tool-connections/2a6b1bcc-e0ed-4855-94ec-a4af618b9879/test-calls
{ "agentId": "<agent id>", "toolName": "search", "parameters": { "query": "increase roas" } }
```

   Expect health `ok`, `authKind` still `api_key`, and a search result that shows
   `reranker_model: voyage:rerank-3-lite` when the tool exposes search modes.

6. **Confirm the connection did not flip.** Re-read the row; `auth_kind` must be
   `api_key` and `status` must not be `draft`.

## Rollback

1. Re-apply the recorded pre-change values:

```sh
PATCH /api/tool-connections/2a6b1bcc-e0ed-4855-94ec-a4af618b9879
{ "authKind": "oauth", "status": "draft", "credentialRefs": [], "credentialSecretRefs": [] }
```

2. Leave the new secret in the vault. It is not readable in plaintext from the
   API and does not grant anything without the refs.
3. If a tool call still fails, the connection is back to its pre-change shape;
   agents keep using whatever GBrain path they used before (profile MCP entry).

Rollback is immediate and needs no restart: connection rows are read per request.

## Why not `oauth`

GBrain is a bearer-token server. OAuth discovery at that endpoint fails, so every
automatic token refresh writes `authKind: oauth` and the connection error returns.
The fix keeps an explicit `api_key`, which the probe must not override. If a
future probe changes it back, that is a regression, not a configuration error.

## Open question for Alex

The token in 1Password is the same one already rendered into each Hermes profile
`.env`. Reusing it here is one more holder of the same secret. If you prefer a
separate token for Paperclip, create it in GBrain first and use it in step 2
instead; nothing else changes.
