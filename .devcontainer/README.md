# Development container

The dev container provides Node 24, pnpm (through Corepack) and the GitHub CLI
so an agent or contributor can build, typecheck and test the repository from a
clean environment.

## Use

1. Open the repository in a Dev Containers-compatible editor.
2. Reopen in container. The first build runs `corepack pnpm install --frozen-lockfile`.
3. Run `pnpm dev` and open <http://localhost:3100>.

The container uses the repository's embedded PGlite database by default, so no
external PostgreSQL service is required. Ports 3100 (API + UI), 5173 (Vite) and
6006 (Storybook) are forwarded.

## What it does not do

- It does not install Rust or build the native runner. Use
  `node scripts/agent-preflight.mjs` for that path (see `doc/DEVELOPING.md`).
- It does not seed company data, configure credentials or enable telemetry.
- It does not replace CI: `pnpm verify` remains the local verification command.
