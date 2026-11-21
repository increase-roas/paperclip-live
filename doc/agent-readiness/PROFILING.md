# Profiling

The API server can be started with V8 profiling enabled when an endpoint is
slow or memory grows unexpectedly. Profiles stay local and are not committed.

```sh
pnpm profile:server          # CPU profile
pnpm profile:server --heap   # heap (memory) profile
```

Other bundled entrypoints use the same profiling wrapper with a bounded smoke
command. Build the target first (`pnpm build`).

```sh
pnpm profile:cli             # CLI --help
pnpm profile:mcp-server      # MCP server --metrics
pnpm profile:google-sheets   # Sheets server --metrics
pnpm profile:broker          # broker module import
pnpm profile:runner          # runner module import
pnpm profile:ui              # Vite dev server with a CPU profile
```

Add `--heap` after the script name for a heap profile, or pass a different
entry with `node scripts/profile-app.mjs --name <name> --entry <path>`. The UI
is a browser bundle; profile it with Chrome DevTools Performance and Memory
panels against the served app rather than V8's Node flags.

Profiles are written to `.quality/reports/profiles/` (ignored by Git). Open a
`.cpuprofile` or `.heapprofile` in Chrome DevTools: **Performance → Load
profile**. For a quick text summary of a heap snapshot, use the DevTools
Memory panel; for CPU, sort by self time and look for the hot frame that
matches the slow request.

Recommended workflow:

1. Reproduce the slow request against the profiled server (curl or the UI).
2. Stop the server with Ctrl-C so V8 flushes the profile.
3. Compare the hot frames with the query benchmarks in `scripts/benchmark-*`.
4. Add a regression benchmark when the fix targets a specific query path.

The profile reflects the local development configuration (embedded PGlite,
development middleware). It identifies code paths, not production latency
numbers; use the CI benchmarks for absolute comparisons.
