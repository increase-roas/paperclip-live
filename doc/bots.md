# Bots

Bots are the long-running personas a company runs outside its org chart. Paperclip
tracks two kinds:

- **Agent bots** — a normal agent row tagged as a bot. Hermes twins hired from the
  `grok-bot-twin` plugin carry `grokBotTwin: true`; other bots carry
  `agentKind: "bot"`.
- **Gateway bots** — bots that answer through the OAuth gateway and have no
  Paperclip agent row yet. They appear as `registered: false` until one is created.

The Bots page (`/bots`) lists both, and each bot has its own page (`/bots/:id`)
showing what it does, its gateway key id and policy, its routines and schedules,
its status and its recent activity.

## Gateway key metadata

Gateway key **ids** and policy names live in agent metadata. Secret values never
do: the key itself stays in the gateway or the company secret store.

```json
{
  "metadata": {
    "grokBotTwin": true,
    "bot": {
      "purpose": "Researches accounts and markets with GBrain.",
      "transport": "hermes_gateway",
      "gateway": {
        "keyId": "gk_live_research",
        "policy": "researcher",
        "provider": "increase-roas-oauth-gateway"
      }
    }
  }
}
```

`readBotMetadata` in `packages/shared/src/bots.ts` drops a half-filled gateway
block instead of guessing, so a page never shows a key id without its policy.
The API returns `gateway: null` in that case and the page says "Not linked".

## Pages for untagged Hermes agents

A Hermes gateway agent with no `grokBotTwin` or `agentKind: "bot"` metadata is
not in the registered roster, but it is a bot in practice: it answers through
the gateway and it is the assignee of real routines. Such an agent still has a
page at `/bots/:agentId` (or its slug). The page shows its routines, status and
recent activity from the agent records, carries a **Not tagged as a bot** badge,
and asks the operator to add the metadata. The roster keeps a separate
"Agents that look like bots" list that links to those pages.

## Read-only by design

`GET /api/companies/:companyId/bots` and
`GET /api/companies/:companyId/bots/:botId` are read-only. They build the roster
from agents, `routines`, `routine_triggers` and `activity_log`. Activity entries
omit `details`, which can carry arbitrary payloads.

## Known gateway bots

`KNOWN_GATEWAY_BOTS` in `packages/shared/src/bots.ts` lists the gateway bots Alex
runs that Paperclip cannot discover on its own: `funnel-builder`, `kiwi`,
`dr-eggbot`, `workflow-builder`, `drive-organizer` and `hermes-specialist`, each
scoped to its company by name. They render on that company's Bots page as
**Not registered yet** and never appear in another company. To register
one, either create the bot as an agent with `grokBotTwin: true` (or
`agentKind: "bot"`) and fill in `bot.gateway`, or keep it gateway-only and link a
key later.

## Live gateway data (optional)

Each bot page can read that bot's live gateway record: key fingerprint, key
created and rotated times, effective policy, granted providers, 24-hour and
7-day request/error counts, last-used time and the last ten body-free audit
rows. The contract is the gateway's `PAPERCLIP-BOTS-API.md`
(`GET /api/admin/bots` and `GET /api/admin/bots/{agent}/summary`).

The feature is **off by default** and needs three server-only values:

| Variable | Purpose |
| --- | --- |
| `PAPERCLIP_GATEWAY_BOTS_ENABLED` | `true`/`1` turns the gateway reads on. Anything else, including unset, leaves them off. |
| `PAPERCLIP_GATEWAY_ADMIN_URL` | Gateway origin, for example `https://gateway.increase-roas.example`. |
| `PAPERCLIP_GATEWAY_ADMIN_KEY` | Alex's owner key. Server environment only. |

Rules the implementation keeps:

- The owner key is read from `process.env` inside `server/src/services/gateway-bots.ts`.
  It is never sent to a browser, never logged, and never included in an error
  message. The page receives a fingerprint, never a key or a full hash.
- With the flag off, or with a missing URL/key, the server makes no request and
  the page says **Gateway not connected** while the roster keeps working from
  agent records.
- An unreachable gateway, a refused key and a rate limit all degrade the same
  way: a short explanation, no failing page, no cached summary
  (`cache-control: no-store`).
- `GET /api/companies/:companyId/bots/gateway` returns only the bots in that
  company's roster, even though the gateway answers with every bot it knows.
- Responses are normalized field by field, so a new gateway field cannot reach a
  Paperclip page without a matching change here.

## Tests

- `server/src/__tests__/bots.test.ts` — roster composition, catalog fallback,
  routine/trigger/activity detail, malformed gateway metadata, cross-company
  isolation, and gateway routes through a fake gateway client.
- `server/src/services/gateway-bots.test.ts` — flag default-off, missing
  credentials, owner-key placement, normalization, refusal mapping, unreachable
  gateway and non-JSON bodies.
- `ui/src/pages/Bots.test.tsx` — registered vs unregistered sections, search,
  detail sections, and the unregistered empty states.
