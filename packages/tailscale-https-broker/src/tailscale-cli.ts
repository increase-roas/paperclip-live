/**
 * Real Tailscale CLI runner: direct spawn with shell:false, absolute binary,
 * minimal environment, closed inherited fds, bounded output, and a hard
 * timeout+kill (PAP-17050 verdict requirement #4). Used by `main.ts` to build
 * the BrokerCore `runTailscale` dependency.
 */
import { spawnSync } from "node:child_process";
import type { CliResult } from "./broker-core.js";
import { brokerMetrics, brokerTailscaleCircuit } from "./observability.js";

const MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Minimum Tailscale CLI version the broker accepts. Serve subcommand syntax and
 * JSON status output are stable from this release onward, so newer releases are
 * accepted by numeric comparison rather than a pinned allowlist.
 */
export const MIN_TAILSCALE_VERSION = { major: 1, minor: 80 } as const;

export function createTailscaleRunner(options: { timeoutMs?: number } = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return (argv: string[]): CliResult => {
    if (!brokerTailscaleCircuit.allow()) {
      brokerMetrics.inc("paperclip_tailscale_calls_total", { outcome: "circuit_open" });
      return {
        code: 1,
        stdout: "",
        stderr: "tailscale CLI circuit is open after repeated failures",
        timedOut: false,
      };
    }
    const [bin, ...args] = argv;
    const result = spawnSync(bin, args, {
      shell: false,
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
        HOME: "/nonexistent",
      },
      cwd: "/",
    });
    const timedOut = result.error !== undefined && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    const code = typeof result.status === "number" ? result.status : timedOut ? 124 : 1;
    if (code === 0 && !timedOut) {
      brokerTailscaleCircuit.recordSuccess();
      brokerMetrics.inc("paperclip_tailscale_calls_total", { outcome: "success" });
    } else {
      brokerTailscaleCircuit.recordFailure();
      brokerMetrics.inc("paperclip_tailscale_calls_total", { outcome: timedOut ? "timeout" : "failure" });
    }
    return {
      code,
      stdout: (result.stdout ?? "").toString("utf8").slice(0, MAX_OUTPUT_BYTES),
      stderr: (result.stderr ?? "").toString("utf8").slice(0, MAX_OUTPUT_BYTES),
      timedOut,
    };
  };
}

/** Parse the numeric `major.minor` prefix of `tailscale version` output. */
export function parseTailscaleVersion(versionOutput: string): { major: number; minor: number } | null {
  const match = /^\s*(\d+)\.(\d+)/.exec(versionOutput);
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : null;
}

export function isSupportedTailscaleVersion(versionOutput: string): boolean {
  const version = parseTailscaleVersion(versionOutput);
  if (version === null) return false;
  if (version.major !== MIN_TAILSCALE_VERSION.major) return version.major > MIN_TAILSCALE_VERSION.major;
  return version.minor >= MIN_TAILSCALE_VERSION.minor;
}
