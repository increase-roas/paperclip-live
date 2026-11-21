# Agent rebuild and connector proof — 2026-11-21

Status: executed. Every claim below carries the command output, API response or run
record that produced it in the same session. Anything not proven is listed under
**Unverified** instead of being described as working.

## Scope

Five objectives were worked in order: Drive routing, GBrain auth shape, Neon + Voyage,
eggbot-v2 agents, and the pstack/poteto-mode run. Boundaries held: the live container
`paperclip-wze4-paperclip-1` was never restarted, migrated or redeployed; no branch,
snapshot or record was deleted; no token, connection string or password was printed
or committed.

## Results

| # | Objective | Result |
| --- | --- | --- |
| 1 | Agents read `Increase ROAS — Company OS` (`0AMHpEV4U3WCiUk9PVA`) | Connector proof passes. Agent proof **unverified**: the saved Drive OAuth token is rejected at execution and re-refresh loops. |
| 2 | GBrain healthy, stays `api_key` | Proven on a master-based instance (`authKind` stays `api_key`, health `ok`); live connector still `oauth` on the old image. |
| 3 | Neon staging copy + Voyage | Proven read-only: staging branch counts, and one search with rerank timings and cost. |
| 4 | eggbot-v2 agents with skills, role, model, GBrain, Hermes profile | Proven: 3 agents ready, 8 skills visible inside each profile, one succeeded heartbeat each. |
| 5 | pstack / poteto-mode | `poteto-mode` loaded; this document is the run artifact. |

## 1. Google Drive

Connector-level proof, this session:

- `list_drives` → `0AMHpEV4U3WCiUk9PVA` = "Increase ROAS — Company OS".
- `list_files` with `corpora=drive, drive_id=0AMHpEV4U3WCiUk9PVA` → 10 files, each
  carrying `"drive_id": "0AMHpEV4U3WCiUk9PVA"`.
- `search_files` through the live Paperclip tool gateway as Research Analyst → HTTP 200,
  then `reasonCode: oauth_refreshed_retry_required` on every retry. The provider keeps
  rejecting the refreshed token, so no Drive row was returned through the app.

Live writes made: connection `689b44c0-9163-4496-8827-531d803f7507` moved `archived` →
`active`; its application `a5afb4b0-703f-411e-adf0-2241fb0195c8` moved `archived` →
`active`; one organization grant `72209982-d2f1-406e-a009-c6fc9a4e12d0`; agent installs
for the three new agents; 9 tools in the catalog.

Why agent-level proof failed: the connection's stored OAuth grant is invalid at Google.
Re-consent is a browser action only Alex can perform. Until that happens the agent path
cannot list a file, so the drive ID cannot be shown from an agent-side response.

## 2. GBrain

Direct MCP against `https://srv2155332.tailde26a1.ts.net/mcp` with the 1Password-rendered
token:

- `initialize` → HTTP 200, `serverInfo gbrain 0.60.734.0`.
- `get_brain_health` → `{"status":"ok",...}`.
- `search` (hybrid) → `vector_enabled: true`, `timings.stages_ms.rerank 173`,
  `cost.rerank {"calls":1,"input_tokens":20705,"usd":0.000414}`.
- `search_modes` → `reranker_model: "voyage:rerank-3-lite"`, `embedding_model: voyage:voyage-4`.
- Token provenance: sha256 of `op read op://JAVAR AGENT/gbrain-mcp-token/credential`
  equals sha256 of the local token file (`4c95c0a7…` prefix), so the token used is the
  one in 1Password.

Auth-shape proof on a master-based instance (PGlite, port 3101, commit `6778fcde9d`,
tree `4da6c538dbdb…` = merged master `7161102a`):

- connection created with `authKind: api_key` + header credential ref → health-check 200,
  `authKind api_key`, `healthStatus ok`, "Remote MCP server responded to tools/list."
- PATCH `authKind: oauth` → health-check 422 (the failure mode the fix prevents).
- PATCH back to `api_key` → health-check 200, still `api_key`.
- Executed `whoami` and `search` through the app afterwards; both returned GBrain data.

Operational finding: a connection created through the API with `credentialRefs` does not
send a credential on tool execution until the connection grant carries a matching
`credentialSecretRefs` entry (`configPath: credentials.authorization`). Health checks and
catalog refresh read the connection refs directly, so they pass while tool calls 401.
The grant ref was added and tool calls then succeeded.

Live connector status remains `draft | error | oauth` on image `09e24dd12c`. It was not
touched, per instruction, and the old image cannot honour `api_key`.

## 3. Neon and Voyage

Read-only SQL on `paperclip_stage` (`br-raspy-glade-b4iffe62`, `current_state: ready`):
`451` migrations, `322` public tables, `23` agents, `1044` heartbeat runs, `2`
`agent_readiness*` tables. No production branch was connected; no connection string was
printed.

Voyage runs inside GBrain: `embedding_model voyage:voyage-4`, reranker
`voyage:rerank-3-lite`, one search showing `embed 409 ms`, `rerank 169 ms`,
`$0.000414` for 20,705 rerank input tokens.

## 4. eggbot-v2 agents

Source archive: `eggbot-v2-skills-export.zip`, Drive id `16Jqzl6Y4AsUqLVoQMrrGLnZCUthH1Ylw`,
12,997 bytes, sha256 `aab8cb350cb749a726592e49522f51725825fc887f2d11b0af4bbde4a2ed6552`.
Fetched through the Drive connector in five verified byte ranges, reassembled, and the
sha256 matched the Drive checksum. Contents: 8 skill directories plus `DEPENDENCIES.md`
and `README.md`; `zipfile.testzip()` returned `ok`.

Skills installed at `/root/.hermes/profiles/<profile>/skills/eggbot-v2/` on `srv2155332`;
`find … -name SKILL.md | wc -l` returned `8` for `ads-checker`, `research` and
`website-builder`.

Runtime discovery proof (direct gateway call per profile, HTTP 200 each) returned all
eight names: `eggbot-v2-getting-started`, `find-the-goal`, `design-a-grok-bot`,
`capture-the-process`, `automate-anything`, `close-the-loop`, `routine-healthcheck`,
`transcript-healthcheck`.

`research` had no `API_SERVER_KEY`; one was generated into its `.env` and the gateway
served `/p/research` without a restart (`/v1/models` → 200). Each profile path accepts
only its own key: the default key returned 401 on `/p/ads-checker`, `/p/research` and
`/p/website-builder`.

Agents created through the hire approval flow (the company requires board approval):

| Agent | Role | Hermes profile | Status | Skills |
| --- | --- | --- | --- | --- |
| Research Analyst `985ad70c-b441-4c6a-97fb-788101209933` | researcher | research | idle / ready | 8 |
| Ads Auditor `640a4097-c351-4504-b0e2-f1296ad889bd` | general | ads-checker | idle / ready | 8 |
| Web Builder `2b2eeb1e-8844-4be8-be3c-7078a774df72` | engineer | website-builder | idle / ready | 8 |

Each carries `apiBaseUrl .../p/<profile>`, `extraArgs ["-p","<profile>"]`,
`toolsets "mcp"`, a secret-ref `apiKey`, and GBrain through its profile's MCP entry.

Heartbeats, one per agent, all `succeeded` with `exitCode 0`:

| Agent | Run | Window |
| --- | --- | --- |
| Research Analyst | `f12b1c3d-4ce7-40dd-97b2-4878938feaf3` | 17:49:11 → 17:49:55 |
| Ads Auditor | `872ab0f3-c515-4102-b305-a931350c4818` | 17:50:22 → 17:52:04 |
| Web Builder | `d39411db-6b70-4b3d-850e-1744f2f62512` | 17:50:24 → 17:51:04 |

Run output is real model text from the target profile: Research Analyst identifies itself
and reports the board state; Web Builder names the `website-builder` profile's env
contents and its blocked access; Ads Auditor closed the stale INC-96 after rechecking the
dashboard. Research and Web Builder both report that the wake carried an empty task,
which is a dispatch-payload fact, not a run failure.

Cleanup note: a second Research Analyst hire was created by re-running the flow during a
permission fix. Its approval was rejected, leaving the agent `terminated | rejected`.
Two probe secrets (`probe-perm`, `probe-perm2`) were created while diagnosing a 403 and
were deleted on Alex's instruction after this work (`DELETE /api/secrets/{id}` → 200 for
both; the company secret list no longer contains either).

## 5. pstack / poteto-mode

`poteto-mode` (pstack 0.15.46) was loaded and its evidence rule applied to every claim
here: name the check, run it after the change, put the output beside the claim.
`setup-pstack` was read for the role and budget table. This harness exposes
DeepSeek V4.1 Flash, not the Claude/Gemini slugs the rule defaults to, so every role
resolves to `inherit-parent` and no `~/.cursor/rules/pstack-models.mdc` was written
(Cursor-only path).

Principles exercised: **Prove It Works** (each objective has a command output, not a
summary), **Fix Root Causes** (the GBrain 401 traced to the missing grant credential ref,
not the transport), **Sequence Work into Verifiable Units** (connector proof before agent
proof), and **Encode Lessons in Structure** (the grant-ref requirement is recorded above
so the next connection does not repeat the failure).

Artifact: this document.

## Unverified

- Agent-side Google Drive read, because the stored OAuth grant is rejected by the provider
  and needs a browser re-consent (`oauth_refreshed_retry_required` on every retry).
- Live GBrain `authKind`, because the running image predates the fix; proven on the
  master-based instance instead.
- The `grok-bot-twin` plugin path: no such plugin is installed on the live instance
  (`plugins`: only `increase-roas.jarvis-orb` is `ready`), so the agents carry the
  eggbot-v2 skill set and Hermes profile but not the plugin tag.
- Company-library registration of the 8 skills: the supported import path is a GitHub
  skill source, and no such repository was authorised. The skills are installed in the
  Hermes profiles the agents actually run in, and each profile enumerates them.
