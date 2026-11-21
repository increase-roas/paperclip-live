#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { repoRoot } from "./readiness/lib/files.mjs";

/**
 * Emits the server's OpenAPI document as a checked-in artifact so agents can
 * read the API contract without booting the server.
 *
 * Usage (package script wires the TypeScript loader):
 *   node --import ./cli/node_modules/tsx/dist/loader.mjs scripts/generate-openapi-artifact.mjs
 *   node --import ./cli/node_modules/tsx/dist/loader.mjs scripts/generate-openapi-artifact.mjs --check
 */

const OUTPUT_PATH = resolve(repoRoot, "docs/api/openapi.json");

async function buildDocument() {
  const { buildOpenApiDocument } = await import("../server/src/routes/openapi.ts");
  return buildOpenApiDocument();
}

function main() {
  const check = process.argv.includes("--check");
  return buildDocument().then((document) => {
    const serialized = `${JSON.stringify(document, null, 2)}\n`;
    if (check) {
      if (!existsSync(OUTPUT_PATH)) {
        process.stderr.write("docs/api/openapi.json is missing. Run pnpm docs:openapi.\n");
        process.exitCode = 1;
        return;
      }
      const current = readFileSync(OUTPUT_PATH, "utf8");
      if (current !== serialized) {
        process.stderr.write(
          "docs/api/openapi.json is out of date. Run pnpm docs:openapi and commit the result.\n",
        );
        process.exitCode = 1;
        return;
      }
      process.stdout.write("OpenAPI artifact is up to date.\n");
      return;
    }

    mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
    writeFileSync(OUTPUT_PATH, serialized);
    const pathCount = Object.keys(document.paths ?? {}).length;
    process.stdout.write(
      `Wrote docs/api/openapi.json (${pathCount} paths, ${(serialized.length / 1024).toFixed(0)} KiB).\n`,
    );
  });
}

main().catch((error) => {
  process.stderr.write(`Failed to build the OpenAPI document: ${error.message}\n`);
  process.exitCode = 1;
});
