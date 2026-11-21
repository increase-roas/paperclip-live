# Data model

This page maps every persisted state surface to its schema. Agents should read
the owning schema before changing a table, registry, or checkpoint.

## Canonical relational schema (server and CLI)

PostgreSQL is the canonical store. Drizzle owns the schema and migrations.

| Surface | Location |
| --- | --- |
| Table and enum definitions | `packages/db/src/schema/*.ts` |
| Schema exports | `packages/db/src/schema/index.ts` |
| Generated SQL migrations | `packages/db/src/migrations/` |
| Migration journal | `packages/db/src/migrations/meta/_journal.json` |

The server and CLI both import `@paperclipai/db`; neither keeps a second
relational schema. Add a table in `packages/db/src/schema/`, export it, run
`pnpm db:generate`, and update the shared validators and API contracts in the
same change.

## Tailscale HTTPS broker registry

The broker persists its ownership registry as JSON under
`BROKER_REGISTRY_PATH`. The file is root-owned, mode `0600`, and written with a
temp file, `fsync`, and rename.

Schema: `packages/tailscale-https-broker/schema/lease-registry.schema.json`

The registry records the node identity, a monotonic generation counter, lease
records (`reserved` or `exposed`), and quarantined ports. Lease handles are
ownership capabilities and must never be logged or returned by `list`.

## Native Runner controller checkpoint

The native Runner writes durable controller state as a record map. Each value is
a JSON string. `header` carries the schema version, runner version, runner
digest, and state; `cursor` carries the acknowledged source sequence and replay
deliveries; `command:<seq>` and `event:<seq>` records carry the protocol
history.

Schema: `packages/paperclip-runner/schema/controller-checkpoint.schema.json`

The header schema is `paperclip.runner.controller-checkpoint.v2`; readers still
accept v1 checkpoints. A checkpoint is only authoritative when its runner digest
and recovery evidence match the current artifact.

## State-free surfaces

`ui`, `packages/mcp-server`, and `packages/google-sheets-mcp-server` keep no
persistent database of their own:

- The UI reads the server API and stores only browser preferences.
- The MCP server is a stateless wrapper over the Paperclip REST API.
- The Google Sheets MCP server is a stateless wrapper over the Google Sheets API
  and stores only the connection configuration that Paperclip records.

Their service contracts are documented by the server OpenAPI document
(`docs/api/openapi.json`) and the Google Sheets HTTP OpenAPI document
(`packages/google-sheets-mcp-server/openapi.yaml`).
