# Lane D merge train runbook — 2026-11-22

Status: Ready for Alex
Owner: Lane D
Base: `origin/master` (`6de064ea94` when this runbook was written)

This page is the single source of truth for the usability train: the 42-PR
initial batch, the four follow-up PRs from the same round, the five newer PRs
added on the next pass, the lane A test-helper PR, the six usability fixes plus
two lane A fixes added on the final pass, and eleven lane A test and report PRs
added on this pass. It lists the exact merge order, which PRs are superseded,
what to check after each batch, and one command that proves the whole order
still merges cleanly.

## One-command verification

```sh
git fetch origin --prune
node scripts/merge-train-simulate.mjs
```

The script is read-only: it moves no refs, does not touch the working tree, and
pushes nothing. It merges each PR head into a running tree with
`git merge-tree`, records the result as an unreachable commit, and stops at the
first conflict with the conflicted paths. Exit code `0` means the whole order is
clean; `1` means a conflict; `2` means a usage or git error.

Last verified: 2026-11-22 (seventh pass), 71 of 71 merged, no conflicts, base
`6de064ea94`. #158 was rebased onto #118 to clear the one conflict (see below).
#167 is a draft combo branch and must be marked ready before it merges. #167 now
contains all of #145, #162's first commit and #162's `--proposals` commit, so
#145 and #162 both close as covered; #158 still merges first. #171 is stacked on
#167 and must merge after it. #173, #174, #176, #181 and the eleven lane A PRs
from #119 through #146 are independent. #175 is stacked on #169 and must merge
after it. #177-#182 are independent usability fixes. #89, #97 and #112 stay out
of the train: #112's base is the draft #97 branch, which is stacked on the draft
#89 branch.

Useful variants:

```sh
node scripts/merge-train-simulate.mjs --order 158,162   # check a pair
node scripts/merge-train-simulate.mjs --section standalone
node scripts/merge-train-simulate.mjs --json
```

## Exact merge order

```merge-train
#126
#127
#128
#132
#133
#104
#105
#100
#108
#109
#110
#111
#113
#114
#115
#116
#117
#118
#122
#123
#124
#135
#136
#137
#141
#142
#143
#144
#147
#148
#149
#150
#151
#154
#155
#156
#158
#167
#171
#159
#160
#161
#163
#164
#166
#168
#169
#170
#157
#165
#173
#174
#176
#181
#175
#177
#178
#179
#180
#182
#119
#120
#121
#129
#130
#131
#134
#138
#139
#140
#146
```

Keep `#115` before `#149` and `#136` before `#148`; those pairs touch the same
files and the later PR expects the earlier copy. Keep `#158` immediately before
`#167`: the combo branch contains #158 and applies #162 (plus #145) on top of it.
Keep `#167` before `#171`: the routine-link branch is stacked on the combo so it
inherits the skeleton, coverage and gateway sections. Keep `#169` before `#175`:
the timeline recovery branch is stacked on the state-recovery PR, which adds the
timeline Retry, and adds the range controls, section heading and range group.

### Batches and what to check after each

| Batch | PRs | Check after the batch |
| --- | --- | --- |
| A. Shared UI and a11y primitives | #126 #127 #128 #132 #133 | `pnpm --filter @paperclipai/ui test` for side-panel tabs, menus and icon buttons. Storybook token gates: `pnpm check:token-gates`. |
| B. CI and local gate | #104 #105 #109 | After #105 lands: `pnpm check:local --quick` (lint, actionlint, readiness) and `pnpm check:actionlint`. Before #105, run `pnpm lint` and the workspace typecheck. |
| C. Bots foundations (lane A) | #100 #108 #118 | `pnpm --filter @paperclipai/server test -- bots` and open `/bots` for one tagged and one untagged Hermes bot. |
| D. UI behavior and tests | #110 #111 #113 | The dashboard renders paused agents as paused; the chat batch test and dark-mode e2e pass. |
| E. Bots roster and guidance | #114 #115 | Roster shows routine count and last activity; a bot with no gateway link lands on the agent metadata editor. |
| F. Settings and agent contrast | #116 #117 | Company settings fields have labels; agent metric description meets AA. |
| G. Task list and navigation | #122 #123 #124 | Task list has table semantics; page tabs are links; the design page scrolls by keyboard. |
| H. Phone and detail polish | #135 #136 #137 #141 #142 #143 #144 | 390px-wide agent header; announcement does not cover the composer; loading/error copy names the subject; composer says why submit is disabled. |
| I. Tablet and mobile shell | #147 #148 | Tablet agent page keeps a readable column; phone announcement is a compact bar. |
| J. Keyboard and contrast | #149 #150 #151 | Bot example scrolls by keyboard; light status chips meet AA; permission switches have names. |
| K. State recovery | #154 #155 #156 | Empty, loading and failed query states name their subject; drawer keeps focus inside and Esc closes; activity metric error is visible. |
| L. Bots loading, copy, forms, approvals | #158 #159 #160 #161 | Bot roster and bot page reserve their shape; file-panel controls are labelled; empty routine title blocks save with a message; one approval decision locks the others. |
| M. Bots invalidation and links | #163 #164 | Renaming an agent refreshes the roster and bot page; every bot back link stays inside `/<prefix>/bots`. |
| N. Follow-up batch | #166 #168 #169 #170 | #166 is this runbook and simulator. #168 restores keyboard focus rings on toolbars and dialogs. #169 explains failed loads on adapters, the timeline and user profiles. #170 names direct fields that have no htmlFor association and the inbox search. Run the keyboard and state Playwright specs named in each PR. |
| O. Newer lane A gates | #167 #157 #165 | #167 is the draft combo of #158 + #145 + #162; mark it ready, then open one tagged and one untagged bot page and run `pnpm --filter @paperclipai/ui exec vitest run src/pages/Bots.test.tsx`. #157: `node scripts/agent-preflight.mjs` logs the plugin-sdk build. #165: `node --test scripts/__tests__/chat-shard-workers.test.mjs`. |
| P. Bot detail routine links | #171 | Bot pages list each routine as a link. Run `cd ui && npx vitest run src/pages/Bots.test.tsx` (24) and the bots Playwright file (5 passed) at 390px and 1280px. |
| Q. Bot detail run links | #173 | Bot pages list each run row with a "View run" link. Run `cd ui && npx vitest run src/pages/Bots.test.tsx` (24) and `npx playwright test --config tests/e2e/playwright.config.ts tests/e2e/bot-run-link.spec.ts` (1 passed; it seeds a heartbeat run through the test database). |
| R. Maintenance test helper | #174 | `cd server && npx vitest run src/__tests__/helpers/maintenance/runtime-build.test.ts` (5 passed). Then rerun it under `npx vitest` to confirm the setup no longer reports `Unknown command: "@paperclipai/plugin-sdk"`. |
| S. Final lane A fixes | #176 #181 | #176: run the wake-diagnostic server tests named in the PR body and confirm a raw provider error no longer reaches the wake copy. #181: run the aggregator freshness tests named in the PR body and confirm the sync waits for the deadline instead of polling. |
| T. Timeline recovery | #175 | `cd ui && npx vitest run src/pages/Timeline.test.tsx` (10 passed) and `npx playwright test --config tests/e2e/playwright.config.ts tests/e2e/timeline-load-recovery.spec.ts` (1 passed). Requires #169 first. |
| U. Adapter list recovery | #177 | `cd ui && npx vitest run src/pages/AdapterManager.test.tsx` (1 passed) and the `tests/e2e/adapter-load-recovery.spec.ts` browser case (1 passed). |
| V. Missing task | #178 | `cd ui && npx vitest run src/pages/IssueDetail.test.tsx -t "names a missing task"` (1 passed) and `tests/e2e/task-not-found.spec.ts` (1 passed). |
| W. Routine Runs empty state | #179 | `cd ui && npx vitest run src/components/routine-sections/operate-sections.test.tsx` (5 passed) and `tests/e2e/routine-runs-empty-state.spec.ts` (1 passed). |
| X. Routine archive Undo | #180 | `cd ui && npx vitest run src/pages/Routines.test.tsx -t "offers Undo after archiving"` (1 passed) and `tests/e2e/routine-archive-undo.spec.ts` (1 passed). |
| Y. Inbox read errors | #182 | `cd ui && npx vitest run src/pages/Inbox.test.tsx -t "reports a failed mark-all-read"` (1 passed) and `tests/e2e/inbox-read-error.spec.ts` (1 passed). |
| Z. Lane A test fixes and rebuild report | #119 #120 #121 #129 #130 #131 #134 #138 #139 #140 #146 | Each PR body names its focused suite and counts. Run server tests for #119 (openapi), `pnpm --filter @paperclipai/server test -- <area>` for #121/#129/#130/#131/#138/#139/#140, the skills test for #120, the rebuild-report tests for #134, and the shutdown-hook tests for #146. All eleven merged after the usability stack in the simulation. |

## What supersedes what

- **#154 contains #123.** #123 (page-tab navigation) is an ancestor of #154
  (state recovery). Merge both in the order above; when #154 lands, #123 has no
  unique commits left.
- **#155 contains #147.** #147 (tablet agent shell) is an ancestor of #155
  (mobile keyboard containment). Merge both; #155 carries #147's commits.
- **#152 is the draft alternative to #147/#155.** It offers a 64px icon rail
  instead of the drawer. It is deliberately outside the train and stays
  `MERGEABLE` alone. If Alex prefers the rail, merge #152 instead of #147/#155
  and drop those two; do not merge all three.
- **#167 contains #158, #145 and #162.** #167 is the conflict-resolved combo:
  it carries #158's skeleton loading, #145's gateway-policy derivation and #162's
  coverage report. Merge #158 first, then #167, and close #145 and #162 as
  covered. Do not merge all four. Evidence on 2026-11-22: `git range-diff`
  matches #145's commit `96a23ffe14` to #167's `e0a7f31615` and #162's
  `73c362926c` to #167's `2478b96f1a`; the catalog `purpose` additions come from
  #118, which #167 also contains. #167 originally lacked #162's second commit
  `fff7dda7df` (`--proposals`), so that commit was cherry-picked onto #167 as
  `17821aa104` before #162 was closed. The tree is now a true superset for these
  three PRs.
- **#171 is stacked on #167.** Its bot-detail routine links start from the #167
  combo, so it inherits the skeleton, coverage and gateway sections. Merge #167,
  then #171. A browser case clicks a routine title at 390px and lands on the
  routine page.
- **#172 was closed as covered.** It proposed splitting the registered-bot gateway
  setup step, but #149 already does that: registered bots get a "Link a gateway
  key" panel with `spec.metadata.bot.gateway` and an Advanced configuration link,
  and the tagging step does not repeat. Do not reopen it.
- **#173 is independent and merges last.** It adds a "View run" link to run rows
  in the bot page's Recent activity. Its test lives mid-file and its UI hunk is
  separate from #167/#171, so it does not need the stack.
- **#174 is independent and merges last.** It is a lane A test-helper change that
  picks pnpm for the maintenance runtime build regardless of the launcher. It
  touches only `server/src/__tests__/helpers/maintenance/`, so it neither needs
  nor blocks the stack.
- **#175 is stacked on #169.** #169 already replaces the gray timeline error with
  `QueryErrorState` and Retry in `ui/src/pages/Timeline.tsx`. #175 was rebased
  onto #169 and adds the range controls to the error branch, an `h2` for the
  embedded audit view, and a name for the range preset group. Merge #169 first.
- **#176 and #181 are the final lane A fixes.** #176 keeps raw wake errors out of
  the diagnostic copy. #181 makes the aggregator sync wait for the freshness
  deadline instead of polling. Both are independent of the stack.
- **#177-#182 are independent usability fixes.** They touch the adapter list, the
  missing-task state, the routine Runs tab, routine archive Undo and the inbox
  read-error alert. None overlaps another train PR, so they merge last in any
  order after the stack.
- **Branches edited in this pass.** #167 moved its `bots:coverage` script next to
  `bots:register` so #165's `test:chat-shard-workers` entry no longer contests
  the same `package.json` slot, and then received #162's `--proposals` commit.
  #171 was rebased onto #167 and #158 was rebased onto #118. Both additions are
  kept. #145 and #162 need no further edits because they close as covered by
  #167.
- **#89, #97 and #112 stay out of the train.** #89 (shared fixture module) and
  #97 (suite harness plus the 47-file split) are drafts. #112's base is #97, so
  it inherits the split and conflicts with #110 on
  `server/src/__tests__/chat-channels.integration.test.ts`. Merge #89, then #97,
  then #112 separately once those drafts are ready; do not insert #112 into this
  train. #121 is the independent acknowledgement-window fix and is in batch Z.
- **#158 must precede #167.** Reversing them conflicts in `ui/src/pages/Bots.tsx`
  and `ui/src/pages/BotDetail.tsx`.
- **#158 is stacked on #118.** Lane A's #100/#108 changed the same `BotDetail`
  import line that #158 shortened. #158 was rebased onto a base that contains
  #118, so it now carries lane A's bot commits until #118 merges. That is the
  only stacked lane-D PR; it must merge after #118, as the order says. The
  resolution keeps `RefreshCw` (the gateway live-data block uses it) and adds
  `Skeleton` and `QueryPlaceholder`.
- **#145 is stacked on #118 and #162 is stacked on #145.** #167 is the only
  branch in the train that contains all three; that is why it replaces them.

### Standalone (draft) order

```standalone
#152
```

## Conflict playbook

1. Rerun `node scripts/merge-train-simulate.mjs`. It names the first conflicting
   PR and its files.
2. Rebase that PR's branch onto the tip of the previous batch:
   `git fetch origin && git rebase origin/<previous-branch>`.
3. Resolve by keeping both sides unless the PR explicitly supersedes the other
   one. For #158/#118 specifically: keep `RefreshCw` (the gateway block uses it)
   and add `Skeleton` and `QueryPlaceholder`. For #158/#145/#162: merge #158,
   then #167, and close #145 and #162 as covered.
4. Push the rebased branch and rerun the script from PR 1. Your local branch
   must be the PR's head branch; do not force-push a branch another lane owns.

## Hosted CI

Hosted Actions is budget-blocked. Every PR is `UNSTABLE` at the hosted level and
carries local commands and counts in its body. Treat local evidence plus a clean
simulation as the merge gate, and rerun the affected local checks after a rebase.
