# Security checks

## Secret scanning

`pnpm check:secrets`

Scans tracked files for:

- AWS access keys, GitHub tokens (classic and fine-grained PATs)
- Slack, Stripe, OpenAI, Anthropic and Google API keys
- PEM private-key blocks and JWTs
- long high-entropy values assigned to secret-like names

The value is never printed or stored. Findings show a masked prefix, and the
baseline stores only a SHA-256 hash. If a real secret is ever committed:

1. Rotate it immediately; assume it is public.
2. Remove it from the working tree.
3. Purge it from history before merging if the branch is shared.
4. Record the incident in the PR and notify the owner of the credential.

The same scanner runs in the pre-commit hook on staged files, so a secret is
blocked before it reaches a commit. `SKIP_READINESS_HOOKS=1` is for emergencies
only.

## Automated security review

`pnpm security:review` writes `.quality/reports/security-review.md` with:

- critical findings (TLS verification disabled)
- high-risk findings (shell command interpolation, dynamic code evaluation)
- secret-scan findings
- warnings (raw HTML injection, raw SQL interpolation, broad CORS)

`pnpm security:review:check` fails CI only on critical findings. High-risk and
warning findings are reported for review because some are legitimate, for
example a launcher building a command from validated arguments. CI uploads the
report as a build artifact so reviewers can see the full list.

## Error tracking

Server, UI and CLI initialize Sentry only when a DSN is configured and always
set `sendDefaultPii: false` (see `doc/observability.md`). Source maps are
uploaded for the server and UI builds. The runner emits structured diagnostics
and redacts credential material; it does not send a separate Sentry payload.

## Log scrubbing

- Server: pino redact paths for authorization headers, cookies and credentials.
- CLI: credential-bearing fields are redacted before output.
- Runner: diagnostic redaction for provider credentials and prompts.
- Telemetry: the event contract forbids personal data; review is required for
  new events (see `packages/shared/src/telemetry/README.md`).

## What is not covered

- GitHub-native code scanning and secret scanning are repository settings; this
  checkout does not change them.
- DAST requires a deployed staging target and is not run from this repository.
- Dependency advisories come from `pnpm audit` and Dependabot in the release
  process; the static report does not query the registry.
