# Agent Readiness checks

The rubric source for the in-app **Readiness** page (`/readiness`) is
[AGENT-READINESS-CHECKLIST.md](./AGENT-READINESS-CHECKLIST.md). That document
defines the per-agent and per-bot levels, the must-pass rules and the manual
attestations. The check catalog in `packages/shared/src/agent-readiness.ts` must
stay aligned with it.

This directory also documents the repository checks that make autonomous agent
work safer and more predictable. The checks are plain Node scripts (no
additional service or dependency), run in CI and in the pre-commit hook, and
each one has a committed baseline of acknowledged debt.

**v1.4 scope.** Readiness scores the company, Hermes-profile agents
(`hermes_local` / `hermes_gateway`) and Hermes bots hired from the
grok-bot-twin plugin. Dot, Muse and Paperclip's native `grok_bot` provider are
out of scope: those subjects are not scored and cannot block a level. Each
checklist box names its catalog id, and a shared test fails if the checklist
and `packages/shared/src/agent-readiness.ts` drift apart.

## Run everything

```sh
pnpm check:readiness                 # static checks (no production build)
pnpm check:readiness --with-bundle   # also checks the built UI bundle
```

Individual checks:

| Criterion | Command | Rules |
| --- | --- | --- |
| Lint | `pnpm lint` / `pnpm lint:fix` | oxlint correctness rules with a reviewed baseline |
| AGENTS.md | `pnpm check:agents-md` | documented paths and pnpm scripts exist |
| Formatter | `pnpm format:check` / `pnpm format` | LF, UTF-8, no trailing whitespace, one final newline |
| Pre-commit hooks | `pnpm hooks:install` | formats/secrets/size/debt on staged files |
| Naming | `pnpm check:naming` | kebab-case backend files, `useThing` hooks, PascalCase types/components |
| Complexity | `pnpm check:complexity` | cyclomatic complexity budget (80 default, 120 for UI) |
| Large files | `pnpm check:large-files` | 2,500 lines / 750 KB |
| Dead code | `pnpm check:dead-code` | modules nothing imports |
| Dead feature flags | `pnpm check:dead-flags` | flags with no readers or marked deprecated |
| Duplicates | `pnpm check:duplicates` | 12-line copy/paste clone detector |
| Modularization | `pnpm check:boundaries` | server layers, UI dependency direction, cross-package imports |
| Tech debt | `pnpm check:tech-debt` | TODO/FIXME/HACK/XXX must link an issue |
| N+1 queries | `pnpm check:n-plus-one` | awaited DB calls inside loops/iteration callbacks |
| Unused dependencies | `pnpm check:unused-deps` | declared but never imported |
| Version drift | `pnpm check:dependency-drift` | same dependency declared with different ranges |
| Bundle size | `pnpm check:bundle-size` | per-asset and total raw/gzip budgets |
| Secrets | `pnpm check:secrets` | cloud tokens, private keys, JWTs, high-entropy values |
| Security review | `pnpm security:review` | Markdown report; `--check` fails on critical findings |
| API schema | `pnpm docs:openapi` / `pnpm docs:openapi:check` | checked-in OpenAPI document |

Supporting infrastructure:

- `.devcontainer/` provides Node 24, pnpm and GitHub CLI for a clean workspace.
- `.editorconfig` aligns editors with the formatter.
- `docs/api/openapi.json` is the generated API contract.
- `scripts/readiness/tests/` unit-tests the analyzers (`pnpm test:readiness`).
- `pnpm profile:server` starts the API with V8 CPU/heap profiling
  (see [PROFILING.md](./PROFILING.md)).

## Baselines

Checks that found pre-existing debt record it in
`.quality/baselines/<check>.json`. A baseline entry is an acknowledgement, not
an exemption: the check still reports the total and fails on any new finding.
Keys include the measured value (line counts, duplicate block hashes, secret
value hashes), so an acknowledged item still fails when it grows.

When you fix an acknowledged item, run the check with `--update-baseline` to
drop the stale entry. Do not add an entry to silence a new finding; fix it or
document the exception in the check's configuration file under `.quality/`.

| Baseline | Meaning |
| --- | --- |
| `complexity` | functions over budget when the gate landed |
| `dead-code` | orphan modules pending deletion |
| `dependency-drift` | packages that still disagree on a version range |
| `duplicate-code` | existing copy/paste blocks pending extraction |
| `feature-flags` | deprecated flags retained for compatibility |
| `format` | files pending whitespace normalization (`pnpm format` fixes them) |
| `large-files` | files over the size budget |
| `module-boundaries` | existing dependency-direction violations |
| `n-plus-one` | sequential query patterns pending batching |
| `naming` | files/declarations that predate the naming standard |
| `secrets` | verified placeholders and fixtures (value hash only) |
| `tech-debt` | unlinked markers that predate the issue-link policy |
| `unused-dependencies` | declarations pending cleanup |

## CI

`.github/workflows/ir-readiness.yml` runs the static suite on every pull
request and on pushes to `master`. A second job builds the UI and runs the
bundle-budget check. The workflow is additive; it does not replace the existing
CI pipeline.

## Operational readiness scripts

These run on demand or from an operator timer. They are not CI-only checks.

| Command | Purpose |
| --- | --- |
| `pnpm health:export` | Probe every component and write Prometheus `paperclip_component_*` text for node_exporter |
| `pnpm test:dast -- --base http://127.0.0.1:3100` | Active DAST against a disposable local or staging instance |
| `pnpm sentry:issues` | Dry-run unresolved Sentry issues to GitHub issues; add `--apply` to create |
| `pnpm issues:triage` | Dry-run type and area labels for untriaged GitHub issues; add `--apply` to label |

Their unit tests run with `pnpm test:health-export`, `pnpm test:dast:self` and
`pnpm test:sentry-issues`.

## Adding a check

1. Put reusable logic in `scripts/readiness/lib/`.
2. Put the CLI in `scripts/check-<topic>.mjs` and support `--update-baseline`,
   `--staged` where it is cheap enough for a hook, and a JSON report under
   `.quality/reports/` when the output is worth inspecting.
3. Add it to `scripts/run-readiness-checks.mjs`, `package.json`, the table
   above and the CI workflow.
4. Add a unit test under `scripts/readiness/tests/`.
