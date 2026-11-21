# API contract artifacts

`openapi.json` is generated from the running server's route registry. It is the
readable API contract for agents and for tooling that cannot boot the server.

Regenerate it after changing a route, request schema or response schema:

```sh
pnpm docs:openapi
```

Check that the committed copy matches the code:

```sh
pnpm docs:openapi:check
```

The generator imports `server/src/routes/openapi.ts` directly, so the artifact
always reflects `buildOpenApiDocument()` — the same function served at
`GET /api/openapi.json`. CI runs the check job after installing dependencies.
