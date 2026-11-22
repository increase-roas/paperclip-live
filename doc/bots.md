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

A known bot with no agent row shows the **policy preset it ships with**:
`KNOWN_GATEWAY_BOTS` carries the preset name (the gateway repository keeps one
preset per bot in `policies/presets.mjs`, so `dr-eggbot` runs the `dr-eggbot`
policy). `catalogGatewayLink` turns that into `{ keyId: null, policy,
source: "catalog_preset" }` and the page says the key id is not recorded until an
operator writes one down. A catalog bot with no known preset keeps the honest
empty state.

When metadata records no link, a Hermes gateway agent's own `adapterConfig.apiBaseUrl`
still names the policy it talks to: the gateway serves each profile under
`/p/<policy>`. The service derives a **policy-only** link from that URL and
marks it `source: "agent_config"`; `keyId` is then `null` and the page says
"Key id not recorded". Only the URL is read. The adapter's `apiKey` is a secret
reference, never a key id, and is never inspected for this.

## Registering a catalog bot

The six catalog bots have no agent row until someone registers them. Registration
is a plan first and a write second:

```sh
pnpm bots:register                                  # dry run: what it would create
pnpm bots:register -- --company <companyId>          # one company
pnpm bots:register -- --company <companyId> --apply  # create the rows
```

- The plan lists every catalog bot for the company with `CREATE` or `skip` and
  the exact row (`name`, `adapter`, `status`, `metadata`). Nothing is written
  without `--apply`.
- Every created agent is `paused`, uses `hermes_gateway`, and carries
  `metadata.agentKind: "bot"` plus `metadata.bot.purpose`. Registration gives the
  bot a page, a status and a place for routines; it does not start work.
- `apply` is idempotent: the slug check runs inside the inserting transaction, so
  a second run — or a concurrent one — creates nothing twice, and an existing
  agent's metadata is never overwritten.
- `GET /api/companies/:companyId/bots/registration` returns the same plan, and
  the Bots page shows it under **Registration plan** with the apply action
  disabled: applying stays an operator step with the runbook.

## What a page still needs from its owner

A page never leaves a required fact blank. `botNeedsInput` in
`packages/shared/src/bots.ts` derives the list from the same payload the page
renders, and `<BotDetail>` shows it as a "Needs owner input (n)" card above the
sections:

- **What it does** — no `bot.purpose` recorded.
- **Gateway key id** — no key id recorded. The detail says whether the policy is
  known, because a known policy with a missing id is a different state from no
  gateway link at all.
- **Grok twin** — an agent bot without `grokBotTwin`. Catalog bots have no agent
  row to tag, so they never get this row.

Each row names the metadata key that fills it, so an operator can act without
reading this document. A fully recorded bot returns an empty list and the card is
not rendered. Routines, status and recent activity render the same way for a
catalog bot; the server returns empty arrays for a bot with no agent row.

## Pages for untagged Hermes agents

A Hermes gateway agent with no `grokBotTwin` or `agentKind: "bot"` metadata is
not in the registered roster, but it is a bot in practice: it answers through
the gateway and it is the assignee of real routines. Such an agent still has a
page at `/bots/:agentId` (or its slug). The page shows its routines, status and
recent activity from the agent records, carries a **Not tagged as a bot** badge,
and asks the operator to add the metadata. The roster keeps a separate
"Agents that look like bots" list that links to those pages.

## Coverage check

`pnpm bots:coverage --company <companyId>` reads a running instance (add
`--base-url` and `--header-file` for a remote one) and prints one row per bot
whose page cannot show something: `bot_tag`, `purpose`, `gateway_policy`,
`routines` or `activity`. The check measures the Bots API, so a field it reports
missing is a field the page genuinely cannot render.

```
pnpm bots:coverage --company 05d9915d-… --header-file ~/.config/paperclip/auth.hdr
pnpm bots:coverage --company <id> --json --fail-on-gaps
```

A missing routine, activity row, purpose or gateway policy is often the truth
rather than a defect; the report says "the page cannot show this". Purpose and
the bot tag are the two gaps an operator fixes from metadata. `--fail-on-gaps`
exits 1, which is how a seeded fixture or a migration check can gate on it.

`--proposals <file>` takes a drafted write per bot slug
(`{ "kiwi": { "purpose": "…" }, "funnel-builder": { "gateway": { "policy": "website-builder" } } }`)
and reports the gaps that write would fill as **proposed** instead of missing.
Nothing applies the draft; it only keeps a reviewed plan visible next to the gaps.
`--fail-on-gaps` ignores proposed gaps, so a gate fails only on data nobody has a
plan for.

The gateway never exposes a key id: it stores a SHA-256 hash per agent
(`agent_keys.key_hash`) and its read-only admin list returns `{agent, hasKey,
policy, enabled, opRef}`. `bot.gateway.keyId` is therefore an operator-recorded
identifier, and an absent one is a page state, not a lookup failure.

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
