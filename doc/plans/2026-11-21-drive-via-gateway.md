# Drive through the gateway (replace OAuth connection 689b44c0)

Status: **plan, not executed.** No live connection, grant or secret was changed.

## Why

The Google Drive MCP connection `689b44c0-9163-4496-8827-531d803f7507` uses Google
OAuth with the `drive.readonly` scope. Google now rejects its stored token
(`disabled_client`), so agent Drive tools fail. It is also read-only by scope, so
no agent could write to a client folder even when the token worked.

The gateway already holds a proven Google service account
(`lead-vault@increase-roas-hot-tub-launch.iam.gserviceaccount.com`, Content
manager on shared drive `0AMHpEV4U3WCiUk9PVA`). The gateway mints short-lived
tokens; the private key stays in the Worker secret and never reaches an agent.

One gateway key per agent replaces the OAuth connection. Read vs write is decided
by that key's policy, not by a per-agent connector:

| Agent | Drive policy |
| --- | --- |
| `website-builder` | read (client assets) |
| `funnel-builder` | **write** (the Drive keeper) |
| `ads-checker` | none |
| `research` | read |

## Prerequisite

The gateway must be live and must expose `provider_call` over MCP. Check:

```sh
curl -s -X POST -H "authorization: Bearer <agent gateway key>" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  https://increase-roas-oauth-gateway.increase-roas.workers.dev/mcp \
  | jq '[.result.tools[].name] | index("provider_call") != null'
# expected: true
```

## Steps (after Alex approves the gateway deploy and key issuance)

1. **Record the current state** for rollback:

```sql
select id, name, status, auth_kind, credential_policy, transport
from tool_connections where id = '689b44c0-9163-4496-8827-531d803f7507';
select * from connection_grants where connection_id = '689b44c0-9163-4496-8827-531d803f7507';
```

2. **Create one gateway MCP connection per agent.** Repeat with each agent's
   key; never share one connection between agents.

```sh
POST /api/tool-connections
{
  "name": "Gateway — Funnel Builder",
  "applicationName": "Increase ROAS Gateway",
  "transport": "mcp_remote",
  "authKind": "api_key",
  "credentialPolicy": "shared",
  "status": "active",
  "config": { "url": "https://increase-roas-oauth-gateway.increase-roas.workers.dev/mcp" },
  "credentialRefs": [
    { "name": "authorization", "secretId": "<gateway-key-secret-id>",
      "placement": "header", "key": "Authorization", "prefix": "Bearer " }
  ],
  "credentialSecretRefs": [
    { "secretId": "<gateway-key-secret-id>", "configPath": "credentials.authorization", "versionSelector": "latest" }
  ]
}
```

   The secret is the agent's gateway key, stored in 1Password and in the
   Paperclip vault. Do not paste it into a document.

3. **Refresh the catalog, then install it for that agent.** Confirm the catalog
   contains `provider_call` and `provider_list`.

4. **Add the grant credential ref.** A connection created through the API does
   not send a credential on tool execution until the grant carries the matching
   ref (the GBrain lesson):

```sh
POST /api/tool-connections/<new-id>/grants/installations
{ "credentialSecretRefs": [
  { "secretId": "<gateway-key-secret-id>", "configPath": "credentials.authorization", "versionSelector": "latest" }
] }
```

5. **Prove it with a real call** for one agent before touching the old
   connection:

```sh
POST /api/tool-connections/<new-id>/test-calls
{ "agentId": "<agent id>", "toolName": "provider_call",
  "parameters": { "provider": "google_drive",
                  "path": "/files",
                  "query": { "q": "'<shared drive id>' in parents and trashed = false", "pageSize": 5 } } }
```

   Expect `decision: "allowed"`, HTTP 200, and Drive files from the shared drive.
   A write proof belongs to `funnel-builder` only, in a scratch folder:
   `provider_call` with `method: "POST"`, `path: "/files"`, and a small body.

6. **Switch the agent over.** Remove the old Drive installation for that agent,
   or leave it installed but disabled. Then repeat steps 2–5 for the next agent.

7. **Disable — do not delete — connection `689b44c0`** after every agent that
   needs Drive has a working gateway connection. Keep its row and grants for
   rollback.

## Rollback

1. Re-enable `689b44c0` (`PATCH /api/tool-connections/689b44c0-…` with
   `status: "active"`) and reinstall its grant for the affected agents.
2. Disable the new gateway connection (`status: "disabled"`) so nothing keeps
   calling it.
3. Leave the gateway Worker untouched: its Drive provider is additive and other
   callers are unaffected.

The old connection may still fail with `disabled_client`; rollback restores the
previous wiring, not a working Google token. If Google access is needed during a
rollback window, the gateway connection is the only working path, so rollback is
"stop using the new path" rather than "restore the old one".

## What must not happen

- No agent gets the service-account JSON. Only the gateway sees it.
- No agent gets write on Drive except the Drive keeper (`funnel-builder`).
- No delete: the old connection is disabled, not removed.
- No change here before the gateway release is approved.
