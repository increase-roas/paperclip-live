# Agent Readiness Checklist v1.4 (Paperclip agents)

Nov 21, 2026 · @Alex

This is the rubric source for **Readiness** at `/readiness`. The in-app check
catalog lives in `packages/shared/src/agent-readiness.ts`; every box below names
its catalog id in backticks, and a test fails if either side drifts.

**Scope.** Readiness scores the company, Hermes-profile agents (`adapterType`
`hermes_local` or `hermes_gateway`) and Hermes bots hired from the grok-bot-twin
plugin (tagged in agent metadata as `grokBotTwin: true`). Paperclip's native Dot,
Muse and `grok_bot` providers are deliberately out of scope: those agents are not
scored and cannot block a level.

Every box is yes or no, checked live (ping it, run it, look it up), never by
reading a config or this doc alone. Every built-in command must be run live.

Company-wide boxes are checked once. Per-agent boxes are checked for each agent
and bot. Each numbered section is a level. Pass 80% of a level to clear it.

**Must-pass** — if any of these fail, the level fails, even if 80% of the rest pass:

1. Model answers, and the adapter works
2. The Hermes profile is selected with the `mcp` toolset
3. Required logins work
4. Spend, send, and delete need approval
5. Tests never touch real clients, accounts, or money
6. Secrets come from the vault, never from instructions
7. GBrain is attached to every agent and bot
8. The company GBrain connector is healthy

Commands: `test-environment` = `paperclipai adapter test-environment`,
`heartbeat` = `paperclipai heartbeat run --agent-id …`,
`skills` = `paperclipai skills agent list`.

In-app kinds: **auto** checks are computed from the company database and files;
**live** checks run only when a board member chooses **Run with live probes**;
**manual** checks pass only after a person attests them with a note. An
un-attested manual check is **Not checked**, never a pass, and it marks the
subject **Unverified**.

## Built-in Paperclip tests

The built-ins below cover the auto and live paths. They are not proof; run each
one live.

| Area | Boxes it tests | Built-in check | Thoughts |
| --- | --- | --- | --- |
| 1 Instructions | Bundle, dead references | `agent instructions-bundle`, `instructions-file:get` | Reads them only; judging them is our job. |
| 1 / 4 Skills | Each skill tested | `agent skills`, skill audit, skill test runs | One test template per skill turns "skills work" into a button. |
| 2 Model & runtime | Model answers, adapter works, profile selected | AI connection check, environment probe, `adapter test-environment` | Run before every agent change. |
| 2 Snapshots | Setup snapshotted, undo | `agent config-revisions`, `config-revision:rollback` | Fastest fix when an agent breaks after a change. |
| 3 Testing | Test task, heartbeat run, review, pass rate | `agent heartbeat:invoke` / `wake`, Execution Policy, completion contracts | We write the task and the expected result; someone other than the agent checks it. |
| 3 / 6 Smoke Lab | Daily tests | Smoke Lab runs and routine | Turning it on covers several boxes at once. |
| 4 / 5 Tools & logins | Every tool works with its login | Tool connection health check | Covers the "GHL only works in the UI" failure before a task hits it. |
| 5 / 13 Server | Database, secrets, storage | `doctor --fix`, `secrets doctor` | Company-wide, after any server change. |
| 6 Run visibility | Failures, stuck runs, metrics | Run watchdog, task monitor, `dashboard get` | Watchdog covers stuck runs. |
| 6 / 13 Audit | What agents did | Agent actions audit, tool gateway audit | Best source for "what went wrong". |
| 7 Permissions | Only the tools it needs | `agent permissions:update`, tool policy | Needs a one-time pass per agent. |
| 10 Memory | GBrain attached | Connector health, profile `mcp_servers` | Auto-attached at hire; the check proves it. |
| 13 Neon | App database, ads access | Runtime config inspection, Neon connector | Reports the embedded database as a failure, never a pass. |

## 1. Instructions & output

- [ ] Every agent has a readable instructions bundle with a non-empty entry file — auto — `instructions.configured`
- [ ] No missing skill references in the saved skill selection — auto; fix **Remove missing skills** — `instructions.no_dead_skill_refs`
- [ ] No two agents have overlapping or conflicting instructions — manual — `instructions.no_conflicts`
- [ ] No dead references in instructions (tools, skills, memory that no longer exist) — manual — `instructions.no_dead_references`
- [ ] The agent output format matches the task type — manual — `instructions.output_format`

## 2. Model & runtime

- [ ] **Must-pass.** The configured model exists and answers — live `test-environment`; fix **Run live probe** — `model.probe`
- [ ] **Must-pass.** An adapter and model are configured, or a Hermes profile supplies one — auto — `model.configured`
- [ ] Model is pinned to a specific version (or a Hermes profile pins one) — auto — `model.pinned`
- [ ] A backup model is set (or the Hermes profile owns model fallback) — auto — `model.backup`
- [ ] **Must-pass.** A Hermes profile is selected (`hermesCommand` alias or `-p <profile>`) and the toolset includes `mcp` — auto — `runtime.hermes_profile`
- [ ] Each agent's setup is snapshotted; a bad change can be undone — auto; fix **Snapshot configuration** — `runtime.config_revision`
- [ ] The current harness configuration has a recorded passing verification — auto; fix **Run live probe** — `runtime.harness_verified`
- [ ] The agent is active, not paused — auto; fix **Resume agent** — `runtime.active`

## 3. Testing

- [ ] Each agent has a test task linked in `agents.metadata.readinessTestIssueId` — auto; fix **Create test task** — `tests.task_linked`
- [ ] The test task has at least one heartbeat run, not a manual chat reply — auto — `tests.heartbeat_run`
- [ ] The test task is run several times and records at least an 80% pass rate — auto — `tests.pass_rate`
- [ ] The test task went through review: an approved review decision, the required run comment, and no rejected completion contract — auto (Execution Policy, completion contracts) — `tests.reviewed`
- [ ] **Must-pass.** Tests never touch real clients, accounts or money — manual — `tests.no_real_clients`
- [ ] Smoke Lab daily routine is on and has a recent run — auto — `tests.smoke_lab`

## 4. Skills & tools

- [ ] Each agent has the company skills it needs — auto — `skills.desired`
- [ ] Every enabled tool connection is healthy — auto — `tools.health`
- [ ] Any Neon credential for ad data targets the `ads` database with a read-only role, not the app database — auto, optional live — `tools.neon_ads_readonly`
- [ ] Each skill the agent uses has a test — manual — `skills.tested`
- [ ] The agent has only the tools it needs — manual — `tools.least_privilege`

## 5. Workspace & access

- [ ] Each agent has a working workspace or a company environment that exists — auto — `workspace.environment`
- [ ] **Must-pass.** Required logins work: browser, GHL, Meta, and any other login that agent needs — live; not checked until a real login probe exists — `access.logins`
- [ ] Sandbox actually starts — auto — `access.sandbox`
- [ ] New agent setup is one step — manual — `workspace.setup`

## 6. Run visibility

- [ ] Run logs are structured and readable, with at least 80% success across the last 20 runs — auto — `runs.recent`
- [ ] Stuck runs get cleaned up automatically, with no run older than an hour — auto; fix **Pause agent** — `runs.no_stuck`
- [ ] Every failed run files a task with the error, context, and a link to the run — manual — `runs.failure_issue`
- [ ] No keys or personal data in logs — manual — `runs.no_secrets`

## 7. Permissions & secrets

- [ ] **Must-pass.** Risky actions (spend, send, delete) need approval. Board approval for new agents does not count — auto — `permissions.approval_policy`
- [ ] Each agent has a budget cap or active budget policy — auto — `permissions.budget`
- [ ] **Must-pass.** Secrets come from the vault: no plaintext environment value and no credential in any instruction file — auto — `permissions.vault_secrets`
- [ ] An owner approves changes to each agent — manual — `permissions.owner`

## 8. Task intake & routing

- [ ] Clear which agent picks up which task: a reporting line, role, title or capability summary — auto — `intake.manager`
- [ ] The role is a real description. `"general"` with an empty title and capabilities is a failure — auto — `intake.description`
- [ ] No stale or blocked tasks piling up (nothing blocked more than 14 days) — auto — `intake.no_stale_blocked`
- [ ] Routing rules written in its instructions: which kind of task goes to which agent — manual — `intake.routing`
- [ ] Unclear or cross-team tasks get split into one task per owner — manual — `intake.split`

## 9. Outcomes & improvement

- [ ] Models and prompts can be compared head to head — manual — `outcomes.comparison`
- [ ] The agent learns from corrections — manual — `outcomes.corrections`
- [ ] Before vs after a fix: success rate, interventions, cost and time are recorded — manual — `outcomes.recorded`

## 10. Memory

- [ ] Hindsight removed from every instruction file — auto — `memory.hindsight_removed`
- [ ] **Must-pass.** GBrain is attached: the connector is installed, or the Hermes profile `config.yaml` names the GBrain MCP server — auto, optional live — `memory.gbrain_connected`
- [ ] Honcho is connected to Paperclip and each agent and person is set up — manual — `memory.honcho`
- [ ] Corrections saved back to memory — manual — `memory.corrections`

## 11. Orchestration — the lead agent

- [ ] The lead's instructions and tools match the rule: delegate worker tasks; the lead handles priorities, conflicts, talking to Alex, approving, hiring and unblocking — manual — `orchestration.policy`
- [ ] Every delegated task has: objective, owner, output format, tools/sources, boundaries, acceptance criteria — manual — `orchestration.handoffs`
- [ ] The lead waits for wake-ups, checks stale or blocked tasks, and reviews finished subtasks before closing the parent — manual — `orchestration.follow_through`

## 12. Hermes bots (Grok twins)

Applies only to Hermes agents hired from the grok-bot-twin plugin. The plugin
twins a Grok desktop-app bot into a Hermes profile; once hired, the agent is a
`hermes_local` (or gateway) agent with a profile and `grokBotTwin: true` in
metadata. Paperclip-native `grok_bot` invitations are a different product and
are out of scope.

- [ ] The agent is tagged as a Hermes twin (`grokBotTwin: true` in metadata) — auto — `bot.hermes_twin`
- [ ] The twin's Hermes profile is selected and its toolset includes `mcp` — auto — `bot.twin_profile`
- [ ] A live probe reached the twin's Hermes profile — live; fix **Run live probe** — `bot.twin_verified`
- [ ] Unmetered provider cost is explicitly acknowledged — manual — `bot.unmetered`

## 13. Company operations

Checked once per company.

- [ ] Smoke Lab daily routine is on and has a recent run — auto — `company.smoke_lab`
- [ ] Company tool connections are healthy — auto — `company.tool_health`
- [ ] Company approval policy requires approval for risky tool actions or new agents — auto — `company.approval_policy`
- [ ] No agent stores a plaintext environment value — auto — `company.secrets`
- [ ] **Must-pass.** The company GBrain connector exists, is enabled and is healthy — auto — `company.gbrain`
- [ ] Paperclip's application database is Neon: runtime `DATABASE_URL` on a Neon host, `DATABASE_MIGRATION_URL` direct, `DATABASE_PREPARED_STATEMENTS=false` — auto — `company.neon_app_db`
- [ ] Database and storage backups can be restored — manual — `company.backups`

## Tools decided

- **Paperclip built-ins** (test-environment, heartbeat, skills, Smoke Lab): use as the main tests.
- **Neon**: the app database moves to Neon; ad data lives in the `ads` database with a read-only role.
- **Braintrust:** not now. Only if we start grading agent output regularly.
- **Linear:** no. Paperclip is the task board; two boards drift.

## Appendix: add a Hermes agent

1. Duplicate an existing Hermes agent or create one from the Agents page. The duplicate
   copies role, adapter type and config, runtime config, environment, budget,
   permissions, title/icon, `reportsTo`, capabilities, metadata and the
   instructions bundle. It does **not** copy desired/installed skills, secrets
   and env bindings, workspace, API keys, external accounts or run history.
2. Confirm the adapter is `hermes_local` and the profile is selected with
   `hermesCommand` or `-p <profile>` in `extraArgs`. The toolset must include `mcp`.
3. GBrain is attached at hire. Open **Connectors** and confirm the GBrain
   connector is healthy; the Readiness page fails the must-pass if it is missing.
4. Open **Runtime** and run `paperclipai adapter test-environment` before the first task.
5. Set desired skills in **Identity**, a budget in **Budget**, and a reporting line in **Org**.
6. Open **Readiness**, select the agent, and use **Create test task**. Run it at
   least twice via heartbeat, take it through review, and confirm the run comment.
7. Attest the manual boxes with a note that says what you checked.

## Appendix: invite a Hermes twin

1. Invite the Grok desktop bot with the grok-bot-twin plugin. The plugin creates a
   Hermes profile and hires a `hermes_local` agent tagged `grokBotTwin: true`.
2. Do not create a native Paperclip `grok_bot` invitation for the same bot; that
   provider is out of readiness scope.
3. Confirm the twin's Hermes profile is selected and includes `mcp`.
4. Confirm GBrain is attached, then run **Readiness → Run with live probes**.
5. Attest **Unmetered provider cost is acknowledged** if the provider bills
   outside Paperclip.
6. Reconnect the provider from **Runtime**, never from the readiness page.

## Changes from v1.3

- Scope is now the company, Hermes-profile agents and Hermes twins. Dot, Muse and
  native `grok_bot` are skipped entirely.
- Level 12 is rewritten around the Hermes-twin path.
- Added `runtime.hermes_profile`, `memory.gbrain_connected`, `company.gbrain`,
  `company.neon_app_db`, `tools.neon_ads_readonly`, `tests.heartbeat_run` and
  `tests.reviewed`; added the missing v1.3 manual boxes that fit this scope.
- The approval must-pass no longer passes on hire approval.
- `role: "general"` with no title or capabilities fails the role box.
- Every box names its catalog id, and a test enforces the 1:1 mapping.
