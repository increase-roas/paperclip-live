# The heartbeat executor tail after a terminal run record

Date: 2026-11-22. Lane A. Read-only investigation; no product behaviour changed.

## Question

`waitForRunExecutionDrain` keeps reporting a run as live for seconds after the
run row says `succeeded`. Is that a product delay — a lock, a missed notify, a
poll interval, an ordering problem — or something else?

## Method

Two temporary probes, both reverted before the change was committed:

1. Inside `waitForRunExecutionDrain`, log `liveRunExecutions.has(runId)` with
   which map holds the id (`runningProcesses` vs the module-level
   `activeRunExecutions`).
2. Around `activeRunExecutions.add` / `.delete`, log the run id and, at delete
   time, `Date.now() - run.finishedAt` — the tail between the terminal record and
   the executor releasing the run.

Driver: `server/src/__tests__/heartbeat-stale-queue-invalidation.test.ts >
delivers an accepted non-assignee queue after its legacy owner finished`, which
delivers one queued run and then waits for its drain.

## Results

| Condition                         | Tail (`finishedAt` → release)                     |
| --------------------------------- | ------------------------------------------------- |
| Quiet host, 1 run                 | **727 ms**, **797 ms**                            |
| 6 busy-loop processes on 8 cores  | **1 936 ms**                                      |
| Parallel workspace suites running | **~5 000 ms** (the observation that started this) |

The slow map is always `activeRunExecutions`; `runningProcesses` stays `false`
throughout, so no child process is involved. Each probe shows exactly one
`add` and one `delete` for the delivered run: nothing leaks, and nothing returns
to the registry later.

Under the heaviest load the whole test body then exceeded vitest's 15 s
`testTimeout` and failed as `Test timed out in 15000ms` — not on any assertion.

## Cause

The tail is **post-terminal finalization**: after the run row turns terminal the
executor still writes the settled execution stage, retries the scratch cleanup,
appends the `task.run.measured` event, and re-reads the run. On the embedded
Postgres this suite starts, each of those is a separate round trip, and they
queue behind whatever else is competing for the machine. There is no timer, no
lock wait, and no missed notify: the same code finishes in under a second when
the machine is quiet, and scales with contention.

The live instance is not in that regime: its container log shows ordinary API
requests answering in tens of milliseconds in the same window, so no product
latency claim is made here and no product code is changed.

## Decision

- No production change. The executor is behaving as documented: a run stays
  "live" while host finalization is still writing, which is exactly what
  `activeRunExecutions` is for (see the comment at its `add` site).
- The test now waits on the real lifecycle with an explicit bound, and that bound
  fits inside the test's own timeout, so contention surfaces as itself rather
  than as a mysterious 15 s timeout.
- If a future report shows a multi-second tail on a quiet host with a healthy
  database, that is a different problem and this document is the baseline to
  compare against.
