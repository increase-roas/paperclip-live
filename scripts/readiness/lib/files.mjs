import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Shared repository walking helpers for the Agent Readiness checks.
 *
 * The checks intentionally avoid third-party analysis dependencies beyond the
 * parser already pinned in the workspace (`oxc-parser`). Everything here is a
 * pure function of the working tree so CI and local hooks see the same input.
 */

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

export const DEFAULT_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "storybook-static",
  "tmp",
  "ui-dist",
  "vendor",
]);

export function toPosix(filePath) {
  return filePath.split(sep).join("/");
}

export function repoPath(absolutePath) {
  return toPosix(relative(repoRoot, absolutePath));
}

export function readText(absolutePath) {
  return readFileSync(absolutePath, "utf8");
}

export function fileExists(absolutePath) {
  try {
    return statSync(absolutePath).isFile();
  } catch {
    return false;
  }
}

export function matchesGlob(filePath, pattern) {
  // Small glob subset used by the readiness checks:
  //   `**` spans any number of path segments, `*` spans one segment.
  const segments = pattern.split("/");
  let translated = "";
  segments.forEach((segment, index) => {
    const isLast = index === segments.length - 1;
    if (segment === "**") {
      translated += isLast ? ".*" : "(?:[^/]+/)*";
      return;
    }
    translated += segment
      .split("*")
      .map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]*");
    if (!isLast) translated += "/";
  });
  return new RegExp(`(?:^|/)${translated}$`).test(filePath);
}

export function isIgnoredPath(filePath, { ignore = [], ignoreDirs = DEFAULT_IGNORED_DIRECTORIES } = {}) {
  const normalized = toPosix(filePath).replace(/^\.\//, "");
  const segments = normalized.split("/");
  if (segments.some((segment) => ignoreDirs.has(segment))) return true;
  return ignore.some((pattern) => matchesGlob(normalized, pattern));
}

/**
 * Yields absolute file paths under each root. Results are sorted so check
 * output and baselines are stable across machines.
 */
export function listFiles({
  roots = ["."],
  extensions = null,
  ignore = [],
  ignoreDirs = DEFAULT_IGNORED_DIRECTORIES,
} = {}) {
  const results = [];
  const seen = new Set();
  const extensionSet = extensions ? new Set(extensions) : null;

  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = resolve(directory, entry.name);
      const relativePath = repoPath(absolutePath);
      if (entry.isDirectory()) {
        if (ignoreDirs.has(entry.name)) continue;
        if (isIgnoredPath(`${relativePath}/`, { ignore, ignoreDirs })) continue;
        walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (extensionSet && !extensionSet.has(extname(entry.name))) continue;
      if (isIgnoredPath(relativePath, { ignore, ignoreDirs })) continue;
      if (seen.has(absolutePath)) continue;
      seen.add(absolutePath);
      results.push(absolutePath);
    }
  };

  for (const root of roots) {
    const absoluteRoot = resolve(repoRoot, root);
    if (!existsSync(absoluteRoot)) continue;
    if (statSync(absoluteRoot).isDirectory()) walk(absoluteRoot);
    else if (!extensionSet || extensionSet.has(extname(absoluteRoot))) results.push(absoluteRoot);
  }

  return results.sort();
}

function runGitPathList(args, cwd, spawn) {
  const attempt = (gitArgs) => spawn("git", gitArgs, { cwd, encoding: "utf8" });
  let result = attempt(args);
  if (result.status !== 0 && /dubious ownership/i.test(String(result.stderr ?? ""))) {
    // Worktrees and shared clones are often owned by another user. Git only
    // blocks the lookup, so retry with this checkout as an explicit exception.
    result = attempt(["-c", `safe.directory=${cwd}`, ...args]);
  }
  if (result.status !== 0) {
    const reason = String(result.stderr ?? "").trim() || `git exited with status ${result.status}`;
    throw new Error(`git ${args[0]} failed in ${cwd}: ${reason}`);
  }
  return String(result.stdout ?? "")
    .split("\0")
    .filter(Boolean)
    .map((filePath) => resolve(cwd, filePath));
}

/**
 * Lists the repository's files through Git.
 *
 * Include untracked, non-ignored files so local checks see work in progress
 * before it is staged. CI has only tracked files, so the behavior matches.
 */
export function listGitFiles(cwd, { spawn = spawnSync } = {}) {
  const files = runGitPathList(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd, spawn);
  if (files.length === 0) {
    throw new Error(`git ls-files returned no files in ${cwd}; readiness checks need the repository file list`);
  }
  return files;
}

export function gitTrackedFiles() {
  return listGitFiles(repoRoot);
}

export function stagedFiles() {
  return runGitPathList(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], repoRoot, spawnSync);
}

export function changedFilesSince(base) {
  const result = spawnSync(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMR", "-z", `${base}...HEAD`],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (result.status !== 0) return null;
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .map((filePath) => resolve(repoRoot, filePath));
}

export function isTestFile(filePath) {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(filePath);
}

export function isDeclarationFile(filePath) {
  return /\.d\.[cm]?ts$/.test(filePath);
}

/**
 * Reads every workspace package listed by pnpm-workspace.yaml. Negated
 * patterns (for example the sandbox providers with their own lockfiles) are
 * skipped, matching pnpm's own selection.
 */
export function findWorkspacePackages() {
  const workspacePath = resolve(repoRoot, "pnpm-workspace.yaml");
  const patterns = [];
  const negations = [];
  if (existsSync(workspacePath)) {
    for (const line of readText(workspacePath).split("\n")) {
      const match = line.match(/^\s{2}-\s+(.+?)\s*$/);
      if (!match) continue;
      const pattern = match[1].replace(/^["']|["']$/g, "");
      if (pattern.startsWith("!")) negations.push(pattern.slice(1));
      else patterns.push(pattern);
    }
  }

  const candidates = new Set([repoRoot]);
  const expand = (pattern) => {
    if (!pattern.includes("*")) {
      const absolutePath = resolve(repoRoot, pattern);
      if (existsSync(resolve(absolutePath, "package.json"))) candidates.add(absolutePath);
      return;
    }
    const prefix = pattern.slice(0, pattern.indexOf("*")).replace(/\/$/, "");
    const directory = resolve(repoRoot, prefix);
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules") continue;
      const candidate = resolve(directory, entry.name);
      // Only single-segment patterns are used by this repository.
      const relativePattern = toPosix(relative(repoRoot, candidate));
      const regex = new RegExp(
        `^${pattern
          .split("*")
          .map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join("[^/]+")}$`,
      );
      if (regex.test(relativePattern) && existsSync(resolve(candidate, "package.json"))) {
        candidates.add(candidate);
      }
    }
  };
  for (const pattern of patterns) expand(pattern);

  const isNegated = (absolutePath) => {
    const relativePath = repoPath(absolutePath);
    return negations.some((pattern) => {
      if (pattern.endsWith("/**")) return relativePath.startsWith(pattern.slice(0, -3));
      return matchesGlob(relativePath, pattern) || relativePath === pattern;
    });
  };

  return [...candidates]
    .filter((directory) => !isNegated(directory))
    .map((directory) => {
      const manifest = JSON.parse(readText(resolve(directory, "package.json")));
      return { dir: directory, relativeDir: repoPath(directory) || ".", manifest };
    })
    .sort((left, right) => left.relativeDir.localeCompare(right.relativeDir));
}

export function packageSourceRoots(workspacePackage) {
  const roots = [];
  for (const name of ["src", "app", "lib"]) {
    const candidate = resolve(workspacePackage.dir, name);
    if (existsSync(candidate)) roots.push(candidate);
  }
  return roots;
}
