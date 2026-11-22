# Chat integration suite: where the wall time goes

Date: 2026-11-22. Lane A. Measured on an 8-core host, one embedded Postgres per
shard worker.

## The question

The chat shard that the earlier mission watched spent more than 25 minutes on
`chat shard 1/6: 154/919 tests`. Which part is slow, and what can be cut without
touching an assertion?

## Method

1. Ran `chat-channels.integration.test.ts` with `--reporter=verbose`,
   `--maxWorkers=1`, and read per-case durations from the output.
2. Temporarily timed the fixture and each await inside one 12.5 s case
   (`answers each finding thread in its own run instead of one unattestable
   batch`), then reverted the probes.
3. Timed one shard batch with two workers (the previous fixed count) and with the
   new CPU-aware count.

## Per-case cost

155 completed cases averaged **13.5 s**. The slowest were all in the
`GitHub agent review workflow` block: 13.5 s, 13.3 s, 10.7 s, 8.5 s, 8.1 s, then
a long tail of 4-6 s cases. Everything in that block runs at least two real
heartbeat executions with a mocked adapter.

Phase breakdown of the 12.5 s case:

| Phase | Time |
| --- | --- |
| `reviewBotFixture` (company, endpoint, GitHub configuration, identity link) | 1.45-1.64 s |
| two delivered replies (wake is fire-and-forget: 166 ms and 150 ms) | 0.87-0.91 s |
| comment lookup | ~0 s |
| `finishActiveRun` = cancel + drain | 6.2-7.1 s |
| `followUpRuns` read | ~0 s |

Inside `finishActiveRun`:

| Step | Time |
| --- | --- |
| `heartbeat.cancelRun` | 0.31-0.34 s |
| `heartbeat.drainActiveRunExecutions` | **6.2-7.1 s** |

The drain is not idle waiting: it awaits the two follow-up runs that the replies
queued. Each is a real heartbeat execution — budget reservation, local dispatch,
the mocked adapter, then the post-terminal finalization measured separately
(`doc/plans/2026-11-22-heartbeat-executor-tail.md`: ~0.7-0.8 s quiet, more under
load). Those runs are the subject of the assertions, so they cannot be skipped.

**Conclusion:** the suite's cost is `tests x (fixture + runs-per-test)`, and the
runs are real work. There is no single wasteful wait to delete.

## Where the wall time can move

Two knobs remain, and only one is free:

1. **Fixture reuse** — the fixture is ~12% of a slow case. Sharing one company and
   endpoint per `describe` would save that at the cost of a large, risky rewrite
   of a 150-case block.
2. **Worker count** — each shard owns an embedded Postgres and most of its time is
   spent waiting on it, so shards parallelise well. The runner pinned two
   workers; on eight cores four shards run in about the wall time of two.

## Change

`scripts/chat-shard-workers.mjs` chooses the worker count:
`max(2, min(6, cpus - 2))`, with `PAPERCLIP_CHAT_SHARD_WORKERS` as an explicit
pin. A shared test database (`DATABASE_URL` set) still keeps one worker per
invocation, because those workers would share the caller's database.

Same 151 tests of the chat file, six shards of the file selected
(`--group general-chat --shard-count 6 --shard-index 0`), slowest worker:

| Workers | Slowest worker | Speedup |
| --- | --- | --- |
| 2 (previous fixed count) | 323 s | — |
| 4 | 245 s | 24% |
| 6 | 200 s | 38% |

Six is the cap: each worker redoes the transform and import work (28-37% of a
worker's time at six, 7-16% at two), so more workers keep shrinking the test
share without shrinking the setup share.

## Not done, and why

- No assertion was changed, and no run was mocked away.
- The suite still boots a fresh embedded Postgres per shard; sharing one database
  across shards would remove the isolation the tests rely on.
- `scripts/run-vitest-stable.mjs` keeps its default shard count; only the worker
  count changes, so shard membership and the exact-filter validation stay as they
  were.
