# Product analytics

Paperclip has two separate data paths:

| Path | Question it answers | Default |
| --- | --- | --- |
| First-party telemetry (`packages/shared/src/telemetry`) | Does this build work? | Opt-out |
| Product analytics (`packages/shared/src/analytics.ts`) | Is this feature used? | Off |

Product analytics is a PostHog capture bridge. It is a no-op unless an operator
sets a project key. It also honors `PAPERCLIP_TELEMETRY_DISABLED=1` and
`PAPERCLIP_PRODUCT_ANALYTICS_DISABLED=1`.

## Configuration

Server, CLI, MCP servers, broker and Runner:

```sh
PAPERCLIP_POSTHOG_KEY=phc_...
PAPERCLIP_POSTHOG_HOST=https://us.i.posthog.com
```

UI (build time):

```sh
VITE_POSTHOG_KEY=phc_...
VITE_POSTHOG_HOST=https://us.i.posthog.com
```

The distinct id is the opaque user id from the board session. No email, display
name, task id, company id, query string, prompt, file, or response body is sent.

## Events

| Surface | Event | Properties |
| --- | --- | --- |
| UI | `page_view` | sanitized route template |
| UI | `$identify` | opaque user id |
| Server | `server_started` | Node version, platform |
| Server | `api_mutation` | method, route template, status, duration |
| CLI | `cli_command_completed` | command name, outcome |
| MCP server | `mcp_server_started`, `mcp_tool_called` | tool count, tool name, outcome, duration |
| Google Sheets MCP | `sheets_server_started`, `sheets_tool_called` | tool count, tool name, outcome, duration |
| Broker | `broker_operation` | operation, outcome, duration |
| Runner | `runner_cli_started` | command name |

The client batches events and sends them to PostHog's `/capture/` endpoint.
Analytics failures never change a command, request, run, or broker operation.
