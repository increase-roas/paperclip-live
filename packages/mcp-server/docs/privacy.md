# Privacy and personal data in the Paperclip MCP server

The MCP server is a thin transport over the Paperclip REST API. It does not own
a database and does not store company records.

## What it handles

- Paperclip API responses: agent, task, project, approval and document
  metadata requested by the caller.
- The bearer API key from `PAPERCLIP_API_KEY`.
- Optional company, agent and run identifiers.

## Rules

1. **Least data.** Tools request only the fields the Paperclip API returns for
   the caller's authorized scope; the server does not add analytics payloads.
2. **Credential handling.** The API key is read from the environment and sent
   only as an `Authorization: Bearer` header. It is never written to stdout,
   stderr, metrics or trace attributes.
3. **Redaction.** Structured logs and error context pass through the shared
   observer redactor, which masks bearer tokens, API keys and private keys.
4. **No first-party analytics.** The server emits no product analytics. Its
   counters and durations are in-process metrics exposed by `--metrics`.
5. **Transport separation.** stdout carries the MCP protocol; diagnostics go
   to stderr so a client cannot receive log content as a tool result.
6. **Retention.** Logs and metrics live in the process and its host's log sink.
   Paperclip's API retains the underlying records under the instance's own
   retention policy.

## Reporting a privacy issue

Follow the repository `SECURITY.md`. Do not paste tokens, task content or
customer data into a public issue.
