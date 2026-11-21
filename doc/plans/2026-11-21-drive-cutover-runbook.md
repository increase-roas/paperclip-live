# Drive cutover runbook: gateway connection replaces 689b44c0

Status: **prepared, not executed.** Nothing below was run against the live
instance. No connection, grant, secret or key was created, and `689b44c0` was
not touched.

This is the executable half of
[2026-11-21-drive-via-gateway.md](2026-11-21-drive-via-gateway.md). The design
did not need new Paperclip code: the remote MCP transport, header credentials,
catalog refresh, agent installs and test calls already exist. The only
Paperclip-side work is API calls in the order below.

## What exists already

| Need | Existing surface |
| --- | --- |
| One MCP connection with an agent key | `POST /api/tool-connections` (`transport: "mcp_remote"`, `config.url`, `credentialRefs` header) |
| Credential on tool execution, not just health | `POST /api/tool-connections/:id/grants/installations` with `credentialSecretRefs` |
| Install for one agent | `PUT /api/tool-connections/:id/installs` `{installs:[{targetType:"agent",targetId}]}` |
| Discover `provider_list` / `provider_call` | `POST /api/tool-connections/:id/catalog/refresh`, then `GET …/catalog` |
| Real proof | `POST /api/tool-connections/:id/test-calls` `{agentId, toolName:"provider_call", parameters}` |
| Disable without deleting | `PATCH /api/tool-connections/:id` `{status:"disabled",enabled:false}` |

Gateway side (PR #4): `POST /mcp` accepts an agent key and exposes
`provider_list` and `provider_call`; read/write and named actions come from the
key's policy.

## Identifiers

```sh
GW=https://increase-roas-oauth-gateway.increase-roas.workers.dev
PAPER=https://app.increaseai.tech
COMPANY=05d9915d-c489-4f17-a919-7603354be43f      # Increase Roas
OLD_DRIVE=689b44c0-9163-4496-8827-531d803f7507
BOARD_KEY=...                                      # board key, never printed
ADMIN_KEY=...                                       # gateway admin key
```

Resolve the agent ids by name; do not hardcode them:

```sql
select id, name, adapter_type, status
from agents
where company_id = '05d9915d-c489-4f17-a919-7603354be43f'
  and name in ('Funnel Builder', 'Web Builder', 'Research Analyst', 'Ads Auditor')
order by name;
```

## 0. Record the current state (read-only)

```sh
curl -s -H "authorization: Bearer $BOARD_KEY" \
  "$PAPER/api/tool-connections/$OLD_DRIVE" | jq '{id,name,status,enabled,authKind,transport}' > /tmp/old-drive.json
curl -s -H "authorization: Bearer $BOARD_KEY" \
  "$PAPER/api/tool-connections/$OLD_DRIVE/installs" | jq . > /tmp/old-drive-installs.json
```

```sql
select id, name, status, enabled, auth_kind, credential_policy, transport, config->>'url' as url
from tool_connections where id = '689b44c0-9163-4496-8827-531d803f7507';
select id, kind, subject_agent_id, credential_secret_refs
from connection_grants where connection_id = '689b44c0-9163-4496-8827-531d803f7507';
select target_type, target_id from tool_connection_installs
where connection_id = '689b44c0-9163-4496-8827-531d803f7507';
```

Keep the three files/rows. They are the rollback record.

## 1. Gateway key per agent (after Alex approves issuance)

```sh
for agent in website-builder funnel-builder ads-checker research; do
  curl -s -H "authorization: Bearer $ADMIN_KEY" -X POST \
    "$GW/api/admin/agents/$agent/keys" | jq -r '"\(.agent) \(.key)"'
done
```

- Store each key in 1Password (`JAVAR AGENT` vault, `gateway-<agent>-key`).
- Never echo a key into a file, a ticket or a log.
- Policies are already right: `funnel-builder` writes Drive; `website-builder`
  and `research` read; `ads-checker` has no Drive grant.

Prove the key and the tool before touching Paperclip:

```sh
KEY=<website-builder key>
curl -s -X POST -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "$GW/mcp" \
  | jq '[.result.tools[].name] | index("provider_call") != null'            # true

curl -s -X POST -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"provider_call",
       "arguments":{"provider":"google_drive","path":"/files",
       "query":{"q":"'"'"'0AMHpEV4U3WCiUk9PVA'"'"' in parents and trashed = false","pageSize":5}}}}' \
  "$GW/mcp" | jq -r '.result.content[0].text' | head -c 400                    # drive files, not an error
```

## 2. Store the agent key as a Paperclip secret

Repeat per agent. The secret value is the raw key; the `Bearer ` prefix lives in
the credential ref.

```sh
curl -s -X POST -H "authorization: Bearer $BOARD_KEY" -H 'content-type: application/json' \
  -d '{"name":"Gateway key — Funnel Builder","provider":"local_encrypted","value":"<agent key>"}' \
  "$PAPER/api/companies/$COMPANY/secrets" | jq -r '.id'
# -> SECRET_ID
```

## 3. Create one connection for that agent

```sh
curl -s -X POST -H "authorization: Bearer $BOARD_KEY" -H 'content-type: application/json' -d '{
  "name": "Gateway — Funnel Builder",
  "applicationName": "Increase ROAS Gateway",
  "transport": "mcp_remote",
  "authKind": "api_key",
  "credentialPolicy": "shared",
  "status": "active",
  "enabled": true,
  "config": { "url": "'"$GW"'/mcp" },
  "credentialRefs": [
    { "name": "authorization", "secretId": "'"$SECRET_ID"'",
      "placement": "header", "key": "Authorization", "prefix": "Bearer " }
  ],
  "credentialSecretRefs": [
    { "secretId": "'"$SECRET_ID"'", "configPath": "credentials.authorization", "versionSelector": "latest" }
  ]
}' "$PAPER/api/tool-connections" | jq -r '.id'
# -> CONNECTION_ID
```

## 4. Put the credential on the grant (the GBrain lesson)

Health discovery reads connection refs; tool execution reads the grant. Without
this, discovery passes and every call 401s.

```sh
curl -s -X POST -H "authorization: Bearer $BOARD_KEY" -H 'content-type: application/json' -d '{
  "credentialSecretRefs": [
    { "secretId": "'"$SECRET_ID"'", "configPath": "credentials.authorization", "versionSelector": "latest" }
  ]
}' "$PAPER/api/tool-connections/$CONNECTION_ID/grants/installations" | jq .
```

## 5. Discover the tools, then install for this agent only

```sh
curl -s -X POST -H "authorization: Bearer $BOARD_KEY" \
  "$PAPER/api/tool-connections/$CONNECTION_ID/catalog/refresh" | jq .
curl -s -H "authorization: Bearer $BOARD_KEY" \
  "$PAPER/api/tool-connections/$CONNECTION_ID/catalog" | jq '[.catalog[] | .toolName // .name]'
# expect provider_list and provider_call

curl -s -X PUT -H "authorization: Bearer $BOARD_KEY" -H 'content-type: application/json' \
  -d '{"installs":[{"targetType":"agent","targetId":"'"$AGENT_ID"'"}]}' \
  "$PAPER/api/tool-connections/$CONNECTION_ID/installs" | jq .
```

## 6. Prove it with a real read

```sh
curl -s -X POST -H "authorization: Bearer $BOARD_KEY" -H 'content-type: application/json' -d '{
  "agentId": "'"$AGENT_ID"'",
  "toolName": "provider_call",
  "parameters": { "provider": "google_drive", "path": "/files",
    "query": { "q": "'"'"'0AMHpEV4U3WCiUk9PVA'"'"' in parents and trashed = false", "pageSize": 5 } }
}' "$PAPER/api/tool-connections/$CONNECTION_ID/test-calls" \
  | jq '{decision, body: (.result.content // .result.data // .result | tostring | .[0:300])}'
# expect decision "allowed" and Drive file names inside body (not an error object)
```

Write proof only for `funnel-builder`, in a scratch folder, never a client
folder:

```sh
# parameters.body = { "name": "cutover-proof.txt", "parents": ["<scratch folder id>"], ... }
# method POST, path /files, provider google_drive
```

For `research` and `website-builder`, also assert a write is refused:

```sh
# same call with method POST -> expect policy_provider_read_only in the result
```

Repeat steps 2–6 for each agent that needs Drive: `funnel-builder` (write),
`website-builder` (read), `research` (read).

## 7. Disable the old connection (not delete)

Only after every agent that needs Drive passed step 6:

```sh
curl -s -X PATCH -H "authorization: Bearer $BOARD_KEY" -H 'content-type: application/json' \
  -d '{"status":"disabled","enabled":false}' \
  "$PAPER/api/tool-connections/$OLD_DRIVE" | jq '{id,status,enabled}'
```

Do not delete it. Its row, grant and installs are the rollback path.

## Verification

| Check | Expected |
| --- | --- |
| `GET /api/tool-connections/<new>/catalog` | contains `provider_list`, `provider_call` |
| `POST …/test-calls` read for each agent | `decision: allowed`, HTTP 200, shared-drive files |
| Write for `funnel-builder` in the scratch folder | 200 and the file exists afterwards |
| Write for `research` / `website-builder` | refused with `policy_provider_read_only` |
| `GET /api/tool-connections/689b44c0…` | `status: disabled`, `enabled: false`, row still present |
| One agent task that used Drive before | succeeds through the new connection |

## Rollback

1. Re-enable the old connection:

```sh
curl -s -X PATCH -H "authorization: Bearer $BOARD_KEY" -H 'content-type: application/json' \
  -d '{"status":"active","enabled":true}' "$PAPER/api/tool-connections/$OLD_DRIVE" | jq .
```

2. Remove the agent install from each new connection, then disable the
   connection (do not delete it):

```sh
curl -s -X PUT -H "authorization: Bearer $BOARD_KEY" -H 'content-type: application/json' \
  -d '{"installs":[]}' "$PAPER/api/tool-connections/$CONNECTION_ID/installs"
curl -s -X PATCH -H "authorization: Bearer $BOARD_KEY" -H 'content-type: application/json' \
  -d '{"status":"disabled","enabled":false}' "$PAPER/api/tool-connections/$CONNECTION_ID"
```

3. Leave the gateway Worker and the gateway keys alone. They are additive and
   other callers are unaffected.
4. The old OAuth token may still fail with `disabled_client`; rollback restores
   the previous wiring, not a working Google token. If Drive is needed during a
   rollback window, the gateway connection is the only working path.

## Approval needed before any of this runs

> Alex: approve the Drive cutover — deploy the gateway with `provider_call`,
> issue gateway keys for funnel-builder, website-builder and research, create
> one Paperclip MCP connection per agent, prove a read, prove a funnel-builder
> write in a scratch folder, then disable (not delete) `689b44c0`.

Nothing in this document has been executed. It is the only remaining work: no
Paperclip code change, no migration, no new dependency.
