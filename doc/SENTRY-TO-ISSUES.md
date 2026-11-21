# Sentry to GitHub issues

`scripts/sentry-to-issues.mjs` turns unresolved Sentry issues into tracked
GitHub issues. It closes the error-to-insight loop without a CI dependency.

## Configure

Set these in the environment or the deployment secret manager. Never commit
them.

```sh
SENTRY_ORG=your-org
SENTRY_PROJECT=paperclip
SENTRY_AUTH_TOKEN=...
GITHUB_TOKEN=...
```

`gh` must be able to reach the target repository. When `GITHUB_REPOSITORY` or
`GH_REPO` is unset, the script asks `gh repo view` for the current repository.

## Run

```sh
pnpm sentry:issues                         # dry run: list what would be created
pnpm sentry:issues -- --apply              # create the missing issues
pnpm sentry:issues -- --limit 10 --apply   # bound one run
```

The script:

1. Reads unresolved Sentry issues for the project.
2. Lists GitHub issues labeled `sentry`.
3. Skips anything whose body already carries the hidden marker
   `<!-- paperclip-sentry-issue:<id> -->`.
4. Creates an issue with the Sentry short id, culprit, event and user counts,
   first/last seen, environment, release, and a permalink.

It creates the `bug` and `sentry` labels when the token allows it. It never
copies stack traces or user content into the issue; follow the Sentry link for
the full event.

Run it from a workstation, an incident review, or a scheduled job outside the
repository's CI. Resolve the issue in Sentry as well, so the next sync does
not recreate it.
