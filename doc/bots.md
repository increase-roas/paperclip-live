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

Reading the gateway's own key registry is deliberately out of scope: the gateway
is a separate deployment and this page never calls it.

## Tests

- `server/src/__tests__/bots.test.ts` — roster composition, catalog fallback,
  routine/trigger/activity detail, malformed gateway metadata, cross-company
  isolation.
- `ui/src/pages/Bots.test.tsx` — registered vs unregistered sections, search,
  detail sections, and the unregistered empty states.
