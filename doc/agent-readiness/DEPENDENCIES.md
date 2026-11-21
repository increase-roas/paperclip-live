# Dependency policy

Paperclip is a pnpm workspace with 36 packages. Dependency changes are reviewed
like code: they affect install time, bundle size, security surface and runtime
behavior.

## Minimum release age

New versions are not adopted on release day. Dependabot applies a cooldown in
`.github/dependabot.yml`:

| Update type | Cooldown |
| --- | --- |
| patch | 3 days |
| minor | 7 days |
| major | 30 days |

The cooldown gives the ecosystem time to publish a broken or compromised
release and lets advisories surface before the version reaches the default
branch. For a security fix that must land sooner, open the bump manually and
explain in the PR why the cooldown is being bypassed (link the advisory).

Dependabot updates are grouped as follows: one pull request per dependency
update, no grouped major upgrades, and one lockfile per sandbox-provider
workspace. Do not widen a range merely to make a bump fit; evaluate the API
change first.

## Version drift

`pnpm check:dependency-drift`

Every dependency must use one version range across the workspace. Divergent
ranges install multiple copies, split security fixes and change behavior
between apps. Intentional differences are baselined with a reason; fix the
drift rather than extending the baseline. `workspace:` ranges are internal
references and are not compared.

## Unused dependencies

`pnpm check:unused-deps`

A dependency declared in a package but never imported or invoked by a script is
dead weight. Remove it in the same change that removes the last usage. Tooling
that is only invoked by a binary in a `package.json` script counts as used.
`@types/*` packages count as used when their runtime package is imported.

## Bundle size

`pnpm check:bundle-size`

The production UI build is measured per asset and in total. Current budgets live
in `.quality/bundle-budget.json`. A new dependency that materially increases
the bundle must be justified in the PR (what it replaces, why a smaller
alternative does not work). Prefer route-level code splitting over raising the
budget.

```sh
pnpm --filter @paperclipai/ui build
pnpm check:bundle-size
```

## Lockfile rules

- CI installs with `--frozen-lockfile`; a manifest change without the matching
  lockfile change cannot merge.
- Never hand-edit `pnpm-lock.yaml`. Generate it with pnpm.
- The sandbox providers under `packages/plugins/sandbox-providers/` are separate
  workspaces with their own lockfiles; update them with their own install.
- Pinned provider releases in the Runner are part of the ACPX identity contract
  (see `rules/acpx-profile-identity.mdc`); do not bump them as routine updates.
