import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

/**
 * The package-manager command that can run the workspace builds this suite needs.
 *
 * `process.env.npm_execpath` names whatever launcher started the test process.
 * That is pnpm when the suite runs through the repository's scripts, but it is
 * npm when someone runs `npx vitest` directly — and npm does not understand
 * pnpm's `--filter`, so the build step dies with `Unknown command:
 * "@paperclipai/plugin-sdk"` and every case skips. This repository is a pnpm
 * workspace, so fall back to pnpm instead of trusting the launcher blindly.
 */
export function maintenanceRuntimePackageManager(
  env: NodeJS.ProcessEnv,
  execPath = process.execPath,
): { command: string; prefix: string[] } {
  const script = env.npm_execpath?.trim();
  if (!script) return { command: "pnpm", prefix: [] };
  const javascript = /\.[cm]?js$/i.test(script);
  if (!javascript) return { command: script, prefix: [] };
  if (!/pnpm/i.test(script)) return { command: "pnpm", prefix: [] };
  return { command: execPath, prefix: [script] };
}

let ready: Promise<void> | undefined;
export function prepareMaintenanceRuntime() {
  ready ??= (async () => {
    const { command, prefix } = maintenanceRuntimePackageManager(process.env);
    for (const args of [
      ["--filter", "@paperclipai/plugin-sdk", "ensure-build-deps"],
      ["--filter", "@paperclipai/paperclip-runner", "build:typescript"],
    ]) await promisify(execFile)(command, [...prefix, ...args], {
      cwd: fileURLToPath(new URL("../../../../..", import.meta.url)), env: process.env,
      timeout: 90_000, maxBuffer: 8 * 1024 * 1024,
    });
  })();
  return ready;
}
