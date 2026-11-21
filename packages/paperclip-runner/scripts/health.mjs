#!/usr/bin/env node

/**
 * Machine-readable health probe for the reference Runner package.
 *
 * The production binary is Rust, so this script checks the JavaScript package
 * prerequisites an operator can verify without starting a run: supported Node,
 * runner source, built TypeScript entrypoint and optional native binary.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const [major, minor] = process.versions.node.split(".").map(Number);
const nodeSupported = major > 24 || (major === 24 && minor >= 11);

const checks = {
  status: "ok",
  service: "paperclip-runner",
  version: packageJson.version,
  nodeVersion: process.versions.node,
  nodeSupported,
  runnerSource: existsSync(resolve(root, "runner", "Cargo.toml")),
  builtTypescript: existsSync(resolve(root, "dist", "index.js")),
  nativeBinary: existsSync(resolve(root, "runner", "target", "release", "paperclip-runnerd")),
};

if (!nodeSupported || !checks.runnerSource) checks.status = "unhealthy";
else if (!checks.builtTypescript && !checks.nativeBinary) checks.status = "degraded";

process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
process.exit(checks.status === "unhealthy" ? 1 : 0);
