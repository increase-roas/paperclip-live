# Mission Control: Bots section for grok-bot-twin Hermes twins

Status: **plan, not executed.** No UI change is in this PR; this records the
remaining work and the evidence that it is missing, so it can be scheduled
without re-discovery.

## What exists today

- Readiness subjects already distinguish agents from bots.
  `server/src/services/agent-readiness/catalog.ts`:
  - `isGrokBotTwin(agent)` reads `metadata.grokBotTwin` (line ~155).
  - `readinessSubjectType(agent)` returns `"bot"` for a tagged twin, `"agent"`
    otherwise (line ~168).
  - The catalog records a check that says whether the agent is tagged
    (line ~1030).
- The company report returns those subjects, and
  `ui/src/pages/AgentReadiness.tsx` renders one combined card titled
  **Agents and bots** (line ~591) with a single search and table. Bots are
  labelled in the **Type** column and in the detail header ("Bot checks"), and a
  twin's provider renders as "Grok twin".
- `ui/src/pages/AgentReadiness.test.tsx` covers the page; no case distinguishes a
  bots group from an agents group.
- `doc/agent-readiness/README.md` scopes v1.4 to Hermes-profile agents and
  grok-bot-twin bots.

## What is missing

1. No Bots section. A twin is only discoverable by scanning the Type column.
2. No visible `grokBotTwin` marker in the list. The tag is proven by a readiness
   finding, not shown as a property of the subject.
3. No count of bots versus agents on the company card.
4. No test that a twin lands in the Bots group and a plain Hermes agent does not.

## Proposed change

Keep the existing report and API contracts. This is a presentation change plus
one shared field.

1. **Expose the tag on the subject summary.** Add `grokBotTwin: boolean` to the
   readiness subject summary in `packages/shared/src/agent-readiness.ts`, filled
   from `isGrokBotTwin(agent)` in the catalog. Do not infer it from the provider
   string; the metadata key is the source of truth.
2. **Split the card** in `ui/src/pages/AgentReadiness.tsx` into two sections:
   - **Bots** — `subjectType === "bot"`. Each row shows a `Grok twin` badge when
     `grokBotTwin` is true, next to the status.
   - **Agents** — `subjectType === "agent"`.
   The company row stays in the summary card above, not in either list.
   Search filters both sections. A section with no matches is hidden; when both
   are empty show the current "No subject matches this search." empty state.
3. **Counts in the header**: `Agents (n)` and `Bots (n)` so an operator sees a
   missing twin immediately. A twin with `status: paused/terminated` still
   counts; the count is about presence, not health.
4. **Readiness check wording.** The existing catalog check already states whether
   the agent is tagged. Keep it as the authoritative signal; the badge is a
   display of the same boolean, not a second check.

## Tests

- `ui/src/pages/AgentReadiness.test.tsx`: a fixture with one tagged Hermes twin
  and one Hermes agent asserts the twin renders under **Bots** with the
  `Grok twin` badge and the agent under **Agents**; search for the twin hides the
  agent section.
- `server/src/services/agent-readiness/catalog.ts` test: a twin subject has
  `subjectType: "bot"` and `grokBotTwin: true`; an untagged Hermes agent has
  `false`. `server/src/__tests__/agent-readiness.test.ts` already creates
  `metadata: { grokBotTwin: true }` (line ~187); extend it to assert the summary
  field.
- No server route change, no migration.

## Why this is a plan, not code

The surface name "Mission Control" is not in the repository. This plan targets
the in-app operator surface that already owns the concept: the Readiness page at
`/readiness`. If Alex means a different dashboard, the same two changes (summary
field plus a Bots group) apply there; confirm the surface before implementing so
the UI work is not duplicated.

## Acceptance

- A grok-bot-twin twin appears in a **Bots** section with a `Grok twin` badge.
- A plain Hermes agent appears under **Agents** and never under Bots.
- The counts match the report; search filters both sections.
- `pnpm vitest run ui/src/pages/AgentReadiness.test.tsx` and the server readiness
  tests pass; no live configuration change.
