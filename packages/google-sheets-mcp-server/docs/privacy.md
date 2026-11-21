# Privacy and personal data in the Google Sheets MCP server

The server exposes Google Sheets tools to Paperclip. Spreadsheet content is
user data; treat every tool result and error as sensitive.

## What it handles

- Spreadsheet ids, titles, ranges, cell values and row matches.
- The Google service-account email and private key from configuration.
- Per-connection allowlists supplied by Paperclip.

## Rules

1. **Explicit allowlist.** Every call is checked against
   `GOOGLE_SHEETS_ALLOWED_SPREADSHEET_IDS` before the Google API is called.
2. **Service-account only.** OAuth is not supported in v1. Credentials come
   from environment variables or a mounted JSON file and are never printed.
3. **Secret redaction.** Tool errors replace configured secret values and pass
   through the shared text redactor, which masks private keys and token shapes.
4. **No analytics.** The server emits no product analytics. Counters and
   durations are local and exposed by `/metrics` or `--metrics`.
5. **Transport separation.** stdio mode keeps stdout for the MCP protocol and
   writes diagnostics to stderr. HTTP mode binds loopback by default and
   requires `GOOGLE_SHEETS_MCP_TOKEN` for non-loopback hosts.
6. **Retention.** Google retains its copy under the customer's Google Workspace
   policy. Paperclip stores only the connection configuration and tool output
   it records as run evidence; the server itself stores no spreadsheet copy.

## Reporting a privacy issue

Follow the repository `SECURITY.md`. Redact spreadsheet ids, cell values,
service-account emails and keys before reporting.
