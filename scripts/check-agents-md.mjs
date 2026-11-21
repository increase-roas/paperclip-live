#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { findWorkspacePackages, repoRoot } from "./readiness/lib/files.mjs";
import { parseArgs, printTitle, settle } from "./readiness/lib/report.mjs";

/**
 * Validates the commands and repository paths documented in AGENTS.md.
 *
 * The file is the first thing an agent reads, so a stale path or a renamed
 * package script sends every agent down a broken path. This check reads the
 * root AGENTS.md, extracts:
 *
 *   1. relative Markdown links,
 *   2. inline-code repository paths,
 *   3. `pnpm` commands,
 *
 * and verifies that each resolved path exists and each referenced script is
 * declared by the owning package. It intentionally ignores globs, URLs,
 * placeholders and command flags.
 */

const PATH_PREFIXES = [
  ".github/",
  ".quality/",
  "adapter-plugin.md",
  "cli/",
  "docker/",
  "doc/",
  "docs/",
  "maps/",
  "packages/",
  "rules/",
  "scripts/",
  "server/",
  "skills/",
  "tests/",
  "tools/",
  "ui/",
];

const ROOT_FILES = [
  "AGENTS.md",
  "CONTRIBUTING.md",
  "DESIGN.md",
  "README.md",
  "SECURITY.md",
  "package.json",
  "pnpm-workspace.yaml",
  "turbo.json",
  "tsconfig.base.json",
];

// pnpm commands that are built in rather than package scripts.
const PNPM_BUILTINS = new Set([
  "add",
  "audit",
  "config",
  "dedupe",
  "deploy",
  "dlx",
  "exec",
  "fetch",
  "import",
  "install",
  "licenses",
  "link",
  "list",
  "ls",
  "outdated",
  "pack",
  "patch",
  "patch-commit",
  "patch-remove",
  "prune",
  "publish",
  "rebuild",
  "recursive",
  "remove",
  "root",
  "run",
  "server",
  "setup",
  "store",
  "unlink",
  "uninstall",
  "up",
  "update",
  "why",
]);

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(repoRoot, relativePath), "utf8"));
}

function loadWorkspacePackages() {
  const packages = new Map();
  for (const workspacePackage of findWorkspacePackages()) {
    const manifest = workspacePackage.manifest;
    if (typeof manifest.name === "string") packages.set(manifest.name, manifest);
  }
  return packages;
}

function collectMarkdownLinks(text) {
  const links = [];
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    if (/^(?:https?:|mailto:|#)/.test(target)) continue;
    links.push(target.replace(/^<|>$/g, "").split("#")[0]);
  }
  return links;
}

function collectInlineCode(text) {
  return [...text.matchAll(/`([^`\n]+)`/g)].map((match) => match[1].trim());
}

function looksLikeRepoPath(token) {
  if (!token || /\s/.test(token)) return false;
  if (/[<>{}]/.test(token)) return false;
  if (/^(?:pnpm|node|git|curl|bash|\.\/|npm|npx)\b/.test(token)) return false;
  if (token.startsWith("/") || token.startsWith("~")) return false;
  return PATH_PREFIXES.some((prefix) => token.startsWith(prefix)) || ROOT_FILES.includes(token);
}

function normalizePathToken(token) {
  let candidate = token.replace(/[),.;:]+$/g, "");
  if (candidate.includes("#")) candidate = candidate.split("#")[0];
  return candidate;
}

function pathExists(candidate) {
  if (candidate.includes("*")) {
    const base = candidate.slice(0, candidate.indexOf("*")).replace(/\/$/, "");
    return existsSync(resolve(repoRoot, base || "."));
  }
  return existsSync(resolve(repoRoot, candidate));
}

function collectPnpmCommands(text) {
  const commands = [];
  const commandPattern = /pnpm\s+((?:--?[\w-]+(?:=\S+)?\s+)*)([\w:.-]+)([^\n`]*)/g;
  for (const match of text.matchAll(commandPattern)) {
    const flags = match[1] ?? "";
    const script = match[2]?.trim();
    if (!script) continue;
    const filter = flags.match(/--filter(?:=|\s+)(\S+)/);
    const recursive = /(?:^|\s)-r(?:\s|$)/.test(flags);
    commands.push({ script, filter: filter?.[1], recursive });
  }
  return commands;
}

function main() {
  const args = parseArgs();
  const file = args.values.get("file") ?? "AGENTS.md";
  const absolute = resolve(repoRoot, file);
  if (!existsSync(absolute)) {
    process.stderr.write(`Missing ${file}.\n`);
    process.exitCode = 1;
    return;
  }

  const text = readFileSync(absolute, "utf8");
  const rootManifest = readJson("package.json");
  const packages = loadWorkspacePackages();
  const findings = [];
  const seen = new Set();

  const addFinding = (message, detail) => {
    const key = `${message}|${detail}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ file, message, detail });
  };

  for (const link of collectMarkdownLinks(text)) {
    const candidate = normalizePathToken(link);
    if (!candidate || /^(?:https?:|mailto:)/.test(candidate)) continue;
    if (!pathExists(candidate)) addFinding(`Broken Markdown link: ${link}`, "path does not exist");
  }

  for (const token of collectInlineCode(text)) {
    const candidate = normalizePathToken(token);
    if (!looksLikeRepoPath(candidate)) continue;
    if (candidate.includes("...") || candidate.length > 240) continue;
    if (!pathExists(candidate)) addFinding(`Missing documented path: ${token}`, "path does not exist");
  }

  for (const command of collectPnpmCommands(text)) {
    const { script, filter, recursive } = command;
    if (script.startsWith("-") || PNPM_BUILTINS.has(script)) continue;
    if (filter) {
      const manifest = packages.get(filter);
      if (!manifest) {
        addFinding(`Unknown pnpm filter package: ${filter}`, "package is not in the workspace");
      } else if (!manifest.scripts?.[script]) {
        addFinding(`Missing pnpm script: --filter ${filter} ${script}`, "script is not declared");
      }
      continue;
    }
    if (recursive) {
      const missing = [...packages.values()].filter((manifest) => manifest.scripts?.typecheck === undefined);
      if (script === "typecheck" && missing.length > 0) {
        addFinding(
          `Recursive script is not declared by every package: ${script}`,
          missing.map((manifest) => manifest.name).join(", "),
        );
      }
      continue;
    }
    if (!rootManifest.scripts?.[script]) {
      addFinding(`Missing root pnpm script: ${script}`, "script is not declared in package.json");
    }
  }

  printTitle("AGENTS.md");
  settle({
    title: "AGENTS.md commands and paths",
    newFindings: findings,
    notes: [
      `Checked ${file} against the workspace manifests and tracked paths.`,
      "Markdown links, inline-code paths and pnpm commands are validated.",
    ],
  });
}

main();
