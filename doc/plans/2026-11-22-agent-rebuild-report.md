# Bot rebuild report — Increase Roas (read-only, 2026-11-22)

Generated from `GET /api/companies/:companyId/agents` and the catalog in
`packages/shared/src/bots.ts`; nothing was written. Reproduce with:

```sh
pnpm agents:rebuild-report -- --company 05d9915d-c489-4f17-a919-7603354be43f
```

The planner behind it is `server/src/services/agent-rebuild-plan.ts`; its tests
are `server/src/__tests__/agent-rebuild-plan.test.ts`.

## Result

12 bot(s) need attention: 0 unregistered catalog bot(s), 2 missing a purpose,
6 missing a gateway link, 6 untagged Hermes agent(s), 0 inactive.

| Bot | Kind | Reasons | Recommended action | Owner decision |
| --- | --- | --- | --- | --- |
| Funnel Builder | agent | missing_gateway_link | Record `bot.gateway.keyId` and `bot.gateway.policy` from the gateway key registry. | yes |
| Video Editor | agent | hermes_agent_untagged | Tag the agent with `grokBotTwin: true` or `agentKind: "bot"`. | yes |
| Kiwi | agent | missing_purpose, missing_gateway_link | Add `bot.purpose`; the page shows a placeholder until then. | yes |
| dr eggbot | agent | missing_purpose, missing_gateway_link | Add `bot.purpose`; the page shows a placeholder until then. | yes |
| Workflow Builder | agent | missing_gateway_link | Record `bot.gateway.keyId` and `bot.gateway.policy`. | yes |
| Drive Organizer | agent | missing_gateway_link | Record `bot.gateway.keyId` and `bot.gateway.policy`. | yes |
| Hermes Specialist | agent | missing_gateway_link | Record `bot.gateway.keyId` and `bot.gateway.policy`. | yes |
| Ads checker | agent | hermes_agent_untagged | Tag the agent as a bot. | yes |
| Ads Auditor | agent | hermes_agent_untagged | Tag the agent as a bot. | yes |
| Web Builder | agent | hermes_agent_untagged | Tag the agent as a bot. | yes |
| Research Analyst | agent | hermes_agent_untagged | Tag the agent as a bot. | yes |
| Javar | agent | hermes_agent_untagged | Tag the agent as a bot. | yes |

## What this means

- No rebuild is needed for a missing agent row: the six catalog bots already have
  rows (all `paused`). Registration is done; what remains is metadata.
- The six `paused` bots each lack `bot.gateway`, so their pages show
  "Not linked" and the gateway section stays empty even with #100's flag on.
  Those key ids and policies live in the gateway registry, not in Paperclip.
- Kiwi and dr eggbot have no purpose anywhere in the repo or ops notes. dr eggbot
  gains one in #125's stack from Alex's own description; Kiwi stays an explicit
  TODO.
- Six Hermes agents are not tagged as bots. They already have pages (#108) and
  real routines and activity, so tagging only files them under "Registered bots".

## Suggested order (all operator actions, no code)

1. Fill `bot.gateway` on the six paused bots from the gateway key registry.
2. Tag the six Hermes agents (`grokBotTwin: true` for twins, `agentKind: "bot"`
   for the rest).
3. Decide Kiwi's purpose, then add `bot.purpose`.

A rebuild of the runtime is not part of this report: no agent here records a
stale adapter version or a missing profile.
