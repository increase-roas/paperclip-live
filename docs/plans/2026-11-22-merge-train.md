# Lane D merge train runbook — 2026-11-22

Status: Ready for Alex
Owner: Lane D
Base: `origin/master` (`6de064ea94` when this runbook was written)

This page is the single source of truth for the usability train: the 42-PR
initial batch, the four follow-up PRs from the same round, and the five newer
PRs added on the next pass. It lists the exact merge order, which PRs are
superseded, what to check after each batch, and one command that proves the
whole order still merges cleanly.

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

Last verified: 2026-11-22 (fourth pass), 51 of 51 merged, no conflicts, base
`6de064ea94`. #158 was rebased onto #118 to clear the one conflict (see below).
#167 is a draft combo branch and must be marked ready before it merges. #145 and
#162 are covered by #167; do not merge all three. #171 is stacked on #167 and
must merge after it. #173 merges last and is independent of the stack.

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
```

Keep `#115` before `#149` and `#136` before `#148`; those pairs touch the same
files and the later PR expects the earlier copy. Keep `#158` immediately before
`#167`: the combo branch contains #158 and applies #162 (plus #145) on top of it.
Keep `#167` before `#171`: the routine-link branch is stacked on the combo so it
inherits the skeleton, coverage and gateway sections.

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
  covered. Do not merge all four.
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
- **Branches edited in this pass.** #167 moved its `bots:coverage` script next to
  `bots:register` so #165's `test:chat-shard-workers` entry no longer contests
  the same `package.json` slot. #171 was rebased onto #167 and #158 was rebased
  onto #118. Both additions are kept.
- **#158 must precede #167** (and must have preceded #162 if merged directly).
  Reversing them conflicts in `ui/src/pages/Bots.tsx` and
  `ui/src/pages/BotDetail.tsx`.
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
