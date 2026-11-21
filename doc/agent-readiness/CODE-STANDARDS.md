# Code standards enforced by tooling

This is the human-readable version of the rules implemented in `scripts/`.
When a rule changes, change the script, its test and this document together.

## Naming

`pnpm check:naming`

| Area | Rule |
| --- | --- |
| `server/src`, `cli/src`, `packages/*/src`, `scripts/` | kebab-case file names |
| `packages/db/src/schema` | snake_case file names (they mirror table names) |
| `ui/src/hooks` | `useThing.ts` modules only |
| UI component modules that render JSX | PascalCase file names |
| Classes, interfaces, type aliases, enums | PascalCase names |
| Unit tests | `.test.ts` / `.test.tsx` next to the source |
| Browser/e2e suites | `.spec.ts` under `tests/` only |

Variables and functions use camelCase; module-level constants use
`UPPER_SNAKE_CASE` only when they are true constants. React components use
PascalCase. Names should say what the thing is, not how it is currently
implemented. Existing violations are baselined; new files must comply.

## Complexity

`pnpm check:complexity`

Cyclomatic complexity (McCabe) is measured per function. The budget is 80 for
server/CLI/package code and 120 for UI components (JSX conditional rendering
adds decision points). Test files are excluded.

When a function exceeds the budget:

1. Extract cohesive branches into named helpers.
2. Replace long `if`/`else` chains with a lookup table or early returns.
3. Split the orchestration step from the policy step.

A function may stay in the baseline only if it is actively being worked on;
baseline entries should shrink over time. The report at
`.quality/reports/complexity.json` lists the current largest functions.

## Large files

`pnpm check:large-files`

Files over 2,500 lines or 750 KB are flagged. Generated files, migrations,
fixtures and the OpenAPI artifact are excluded. Split by responsibility rather
than by line count: a route module can usually separate validation, policy and
persistence.

## Duplicate code

`pnpm check:duplicates`

A 12-line normalized window duplicated across two files is reported. Imports,
comments and blank lines are ignored before comparison. Extract the shared
behavior into a helper rather than copying it; if the two cases only look alike
today, document why the duplication is intentional in the PR.

## Technical debt markers

`pnpm check:tech-debt`

`TODO`, `FIXME`, `HACK` and `XXX` must reference an issue:

```ts
// TODO(PAP-1234): replace the temporary fallback once adapter selection lands
// FIXME(#1234): remove after the migration is complete
```

A URL also counts. An unlinked marker is fine only while it is baselined; when
you touch the code, either link it or remove it. `TD-` style references are not
accepted because they cannot be resolved to an issue.

## Formatting

`pnpm format:check` / `pnpm format`

The formatter owns the mechanical layer: LF endings, no BOM, no trailing
whitespace, exactly one final newline, no whitespace-only lines. Markdown hard
line breaks (two trailing spaces) are preserved. `.editorconfig` applies the
same rules in editors. Run `pnpm format` to normalize the whole tree; existing
files are recorded in `.quality/baselines/format.json`, so a new file with
trailing whitespace fails the check immediately.

The repository does not install a TypeScript printer (adding one would change
the lockfile and rewrite the whole tree). Structural TypeScript style is
enforced by `pnpm typecheck`, the naming and complexity checks, and review.
