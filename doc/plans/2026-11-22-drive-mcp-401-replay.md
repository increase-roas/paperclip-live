# Drive MCP 401 replay after an OAuth refresh — design and prototype

Status: proposed. The prototype is behind a flag that defaults **off**, so shipped
behavior does not change. Decision needed from Alex (see the end).

Date: 2026-11-22. Author: Lane A.

## The evidence

Two live failures in the Increase Roas company, connection `689b44c0` (Google
Drive MCP, provider `drivemcp.googleapis.com/mcp/v1`), 2.5 seconds apart on
2026-11-21T17:52Z, both manual connection tests:

```
tool_gateway.call_failed   agent 985ad70c   tool: …:search-files   risk: read
  httpStatus 401
  reasonCode "oauth_refreshed_retry_required"
  error "The provider rejected the saved OAuth token, which has now been
         refreshed. Retry the action explicitly; the original call was not
         replayed."
```

The credential refresh worked. The user still lost the call, and the second
attempt 2.5 s later failed the same way, which is the experience the agent team
reports as "Drive is broken sometimes".

Full triage: `/root/ops/audit-2026-11-22-logs.md`.

## Current behavior, and why it exists

`server/src/services/tool-gateway.ts` refreshes the grant on a 401 and then
throws a 409 with `oauth_refreshed_retry_required` instead of replaying. The
in-code reason is deliberate:

> The provider rejected this dispatch, but automatic replay is unsafe: a server
> can apply a request before returning 401.

That is correct for writes. It is costly for reads: an expired access token is
the normal steady state of OAuth, so every expiry turns into a user-visible
failure with a manual retry the model may never make.

## Option A — replay a read once after the refresh

Mechanics:

1. Provider answers 401.
2. Gateway refreshes the grant (unchanged).
3. Rebuild the request with the new credential and dispatch **once**.
4. If the replay also answers 401, fall back to today's 409.
5. Record in the audit that a replay happened.

Risk analysis:

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Provider applied the call before answering 401, so the replay double-applies | high for writes, low for reads | only `riskLevel: "read"`; writes keep the 409 |
| A "read" tool mutates as a side effect (misclassified catalog entry) | medium | catalog review of read entries; the audit records the replay |
| Replay loops | low | exactly one replay per call |
| Session-based MCP breaks because the session was bound to the old token | medium | not replayed in the prototype (`usesMcpSession` must be false) |
| Two dispatches double the load on a flaky provider | low | one extra dispatch, bounded by the existing timeout |

## Option B — the test button retries itself

Keep the gateway policy exactly as it is. The connection "Test" action (and any
agent retry helper) catches `oauth_refreshed_retry_required`, waits, and calls
again once.

Risk analysis:

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Agents still fail when the model does not retry | high — this is the reported pain | none inside the gateway; would need a retry rule in every caller |
| Runs retry a tool call they already booked as failed | medium | the run log shows two attempts |
| Touches UI and runner call sites instead of one gateway rule | medium | more places to keep consistent |

Option B fixes the demo but not agent runs. Option A fixes both, at the cost of
a narrower safety model for reads.

## Prototype in this PR (default off)

- `server/src/services/tool-gateway-oauth-replay.ts`:
  - `PAPERCLIP_TOOL_GATEWAY_REPLAY_READS_AFTER_OAUTH_REFRESH=1` enables it.
  - `shouldReplayReadAfterOAuthRefresh({ enabled, riskLevel, usesMcpSession })`
    is the whole decision: enabled **and** read **and** no MCP session.
- `tool-gateway.ts`: the paperclip-vault OAuth branch (the Drive path) rebuilds
  the request with refreshed headers and dispatches once when the decision says
  so. A second 401 falls back to the existing 409. Every other branch, and every
  write, is untouched.
- Tests: `tool-gateway-oauth-replay.test.ts` covers the decision (5 cases,
  including the flag-off and the write cases). The existing gateway tests that
  assert "refresh without replay" still pass unchanged.

What is deliberately **not** covered: session-based MCP replay (needs a
re-initialize handshake), and any change to the default path.

## Verification plan before the flag can default on

1. An integration test in `tool-gateway-service.test.ts` with the flag on: a
   read call gets 401, refreshes, replays, and returns the tool result; a write
   call with the same provider still gets the 409.
2. A session-based test that shows the 409 still happens (the prototype skips it).
3. One live Drive search through a read-only key, twice: once with an expired
   token to force the replay, watched in the audit log for `replayedAfterRefresh`.

## Decision needed

Choose one:

- **A**: replay reads once (open the flag after the verification plan above), or
- **B**: keep the gateway strict and make the UI test button retry, or
- **C**: keep both off and treat the explicit 409 as the intended answer.

No live configuration, key, or gateway setting changes in this PR.
