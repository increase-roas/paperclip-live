# Privacy and personal data in the Runner

The Runner executes provider processes on behalf of a company. It handles
personal data because prompts, task text, repository files and provider
responses can contain it. This document states the handling rules that the
Runner code follows.

## What the Runner handles

- Task instructions, conversation history and repository content supplied by
  the control plane.
- Provider credentials injected by the server for the selected connection.
- Provider stream events (reasoning, tool calls, stdout/stderr) that become run
  diagnostics.
- Local workspace files and process output inside the execution sandbox.

## Rules

1. **Control-plane scoping.** Every Runner request carries the company, agent
   and run identity. The Runner does not accept cross-company work; the server
   authorizes the run before the process starts.
2. **Credential redaction.** Semantic tool payloads pass through
   `src/semantic-tools/redaction.ts`, which masks credential-like keys,
   secret-shaped values, secret query parameters, and caps string length.
   Credentials are supplied as environment variables or short-lived files, not
   as command-line arguments where they would appear in process listings.
3. **No first-party analytics.** The Runner does not emit product analytics or
   a separate error-tracking payload. Diagnostic events belong to the run log
   and are scoped to the run that produced them.
4. **Prompt and output boundaries.** Provider prompts and responses are user
   content. Do not copy them into bug reports, pull requests, commits or logs
   outside the run record. When reproducing an issue, redact names, email
   addresses, tokens and customer identifiers.
5. **Local retention.** Workspace files and process output live in the run's
   workspace. Cleanup is the control plane's responsibility; an operator who
   copies a workspace elsewhere takes on its retention obligations.
6. **Provider retention.** The selected model provider receives prompt and tool
   content as part of the run. Its data-retention policy applies to that copy;
   the Runner cannot delete it.

## Reporting a privacy issue

Follow `SECURITY.md` at the repository root. Do not open a public issue that
contains personal data, credentials or customer content.

## Known limits

- Redaction is pattern- and key-based. A secret embedded in free-form prose
  that does not match a known shape can still be logged; reviewers must treat
  run diagnostics as sensitive.
- The Runner cannot verify a provider's retention or training policy. That is a
  connection and vendor-review decision.
