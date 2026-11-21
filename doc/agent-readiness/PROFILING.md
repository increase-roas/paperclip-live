# Profiling

The API server can be started with V8 profiling enabled when an endpoint is
slow or memory grows unexpectedly. Profiles stay local and are not committed.

```sh
pnpm profile:server          # CPU profile
pnpm profile:server --heap   # heap (memory) profile
```

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
