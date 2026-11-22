#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Runs actionlint with a version that understands the workflow syntax in this
 * repository.
 *
 * actionlint older than 1.7.12 rejects aliased `steps` sequences and does not
 * know the reusable-workflow `job.workflow_*` contexts. The gate therefore
 * prefers a local binary at or above the pinned version and otherwise
 * downloads the pinned release into the agent cache, verifying the published
 * SHA-256 before extraction.
 *
 * Usage:
 *   node scripts/check-actionlint.mjs
 *   node scripts/check-actionlint.mjs --no-download
 *   node scripts/check-actionlint.mjs -- .github/workflows/ir-ci.yml
 *
 * Environment:
 *   ACTIONLINT_BIN        Explicit binary. Fails if it is older than the pin.
 *   ACTIONLINT_NO_DOWNLOAD=1  Never use the network.
 */

export const PINNED_VERSION = "1.7.12";

const RELEASE_SHA256 = {
  linux_amd64: "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
  linux_arm64: "325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6",
  darwin_amd64: "5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644",
  darwin_arm64: "aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f",
};

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

export function assetFor(platform, arch) {
  const platformName = platform === "linux" ? "linux" : platform === "darwin" ? "darwin" : null;
  const archName = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : null;
  if (!platformName || !archName) return null;
  const key = `${platformName}_${archName}`;
  const checksum = RELEASE_SHA256[key];
  if (!checksum) return null;
  return {
    key,
    checksum,
    fileName: `actionlint_${PINNED_VERSION}_${key}.tar.gz`,
    binaryName: platform === "win32" ? "actionlint.exe" : "actionlint",
  };
}

export function versionAtLeast(actual, minimum) {
  const parse = (value) =>
    String(value)
      .trim()
      .replace(/^v/, "")
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(actual);
  const right = parse(minimum);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

function binaryVersion(binary) {
  const result = spawnSync(binary, ["--version"], { encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  return result.stdout.split("\n")[0].trim();
}

function cacheDirectory() {
  return process.env.PAPERCLIP_ACTIONLINT_CACHE
    ? path.resolve(process.env.PAPERCLIP_ACTIONLINT_CACHE)
    : path.join(homedir(), ".cache", "paperclip", "actionlint", PINNED_VERSION);
}

async function downloadPinned(asset, directory) {
  const url = `https://github.com/rhysd/actionlint/releases/download/v${PINNED_VERSION}/${asset.fileName}`;
  const archivePath = path.join(directory, asset.fileName);
  const binaryPath = path.join(directory, asset.binaryName);
  mkdirSync(directory, { recursive: true });
  process.stdout.write(`  Downloading ${url}\n`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`download failed with HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== asset.checksum) {
    throw new Error(`checksum mismatch for ${asset.fileName}: got ${digest}`);
  }
  const temporaryArchive = `${archivePath}.tmp`;
  writeFileSync(temporaryArchive, bytes);
  renameSync(temporaryArchive, archivePath);
  const extracted = spawnSync("tar", ["-xzf", archivePath, "-C", directory, asset.binaryName], {
    encoding: "utf8",
  });
  if (extracted.error || extracted.status !== 0) {
    throw new Error(`unable to extract ${asset.fileName}: ${extracted.stderr || extracted.error?.message}`);
  }
  chmodSync(binaryPath, 0o755);
  rmSync(archivePath, { force: true });
  return binaryPath;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function resolveBinary({ allowDownload }) {
  const explicit = process.env.ACTIONLINT_BIN;
  if (explicit) {
    const version = binaryVersion(explicit);
    if (!version) fail(`ACTIONLINT_BIN=${explicit} is not runnable.`);
    if (!versionAtLeast(version, PINNED_VERSION)) {
      fail(`ACTIONLINT_BIN version ${version} is older than ${PINNED_VERSION}; install a current release.`);
    }
    return { binary: explicit, version, source: "ACTIONLINT_BIN" };
  }

  const asset = assetFor(process.platform, process.arch);
  const cached = asset ? path.join(cacheDirectory(), asset.binaryName) : null;
  if (cached && existsSync(cached)) {
    const version = binaryVersion(cached);
    if (version && versionAtLeast(version, PINNED_VERSION)) {
      return { binary: cached, version, source: "cache" };
    }
  }

  const onPath = spawnSync(process.platform === "win32" ? "where" : "which", ["actionlint"], {
    encoding: "utf8",
  });
  if (onPath.status === 0) {
    const candidate = onPath.stdout.split("\n")[0].trim();
    const version = binaryVersion(candidate);
    if (version && versionAtLeast(version, PINNED_VERSION)) {
      return { binary: candidate, version, source: "PATH" };
    }
  }

  if (!allowDownload) {
    fail(
      `actionlint ${PINNED_VERSION} or newer was not found. Install it, set ACTIONLINT_BIN, or allow the download.`,
    );
  }
  if (!asset) {
    fail(
      `No pinned actionlint release for ${process.platform}/${process.arch}. Install actionlint ${PINNED_VERSION}+ and set ACTIONLINT_BIN.`,
    );
  }
  const binary = await downloadPinned(asset, cacheDirectory());
  const version = binaryVersion(binary);
  if (!version) fail(`Downloaded actionlint at ${binary} is not runnable.`);
  return { binary, version, source: "download" };
}

async function main() {
  const args = process.argv.slice(2);
  const allowDownload = !args.includes("--no-download") && process.env.ACTIONLINT_NO_DOWNLOAD !== "1";
  const forwarded = args.filter((arg) => arg !== "--no-download");
  const separator = forwarded.indexOf("--");
  const actionlintArgs = separator === -1 ? [] : forwarded.slice(separator + 1);

  const resolved = await resolveBinary({ allowDownload });
  process.stdout.write(
    `Actionlint ${resolved.version.replace(/^v/, "")} (${resolved.source}) over .github/workflows\n`,
  );
  const result = spawnSync(resolved.binary, ["-no-color", ...actionlintArgs], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.error) fail(`Unable to run actionlint: ${result.error.message}`);

  if (result.status === 0) {
    process.stdout.write("Actionlint: OK\n");
  } else {
    process.stderr.write("Actionlint: findings above\n");
  }
  process.exit(result.status ?? 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
