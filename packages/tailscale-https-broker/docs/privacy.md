# Privacy and personal data in the Tailscale HTTPS broker

The broker runs as a dedicated host service. It mediates Tailscale Serve
listeners; it does not proxy application traffic or read request bodies.

## What it handles

- Peer credentials (`uid`, `gid`, `pid`) for socket admission.
- Runtime ids, ports, operation names and request ids.
- Redacted command outcome categories from the Tailscale CLI.

It never logs lease handles, bearer/session material, full environments or raw
unbounded CLI output.

## Rules

1. **Peer identity only.** `SO_PEERCRED` is read before admission and used for
   authorization. The audit record stores the numeric ids, not a user name or
   email address.
2. **Bounded, sanitized audit.** Every allow/deny event is written as one JSON
   line. Control characters are stripped and every string field is length
   bounded to defeat log forging.
3. **Traceable operations.** Each audit record carries the request id and the
   same value as its trace id, so an operator can follow one request through
   the socket, core and audit sink.
4. **No analytics.** The broker emits no product analytics and no remote error
   payload. Metrics stay in the process and the `--health` snapshot.
5. **Retention.** The audit file is append-only and host-local. Rotation and
   retention are the host operator's responsibility.
6. **Failure handling.** Errors are classified into stable codes; raw command
   output is not copied into an audit reason.

## Reporting a privacy issue

Follow the repository `SECURITY.md`. Do not include host paths, peer ids or
customer identifiers in a public report.
