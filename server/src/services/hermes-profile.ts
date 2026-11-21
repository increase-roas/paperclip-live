/**
 * Pure Hermes-profile helpers for readiness.
 *
 * Hermes has no first-class "profile" column: a profile is selected by the
 * command alias (`hermesCommand`) or by `-p <profile>` / `--profile=<profile>`
 * in `extraArgs`, and `toolsets` is free text that must include `mcp`.
 */

export const HERMES_ADAPTER_TYPES = new Set(["hermes_local", "hermes_gateway"]);

export function isHermesAdapter(adapterType: string | null | undefined): boolean {
  return typeof adapterType === "string" && HERMES_ADAPTER_TYPES.has(adapterType);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** The selected profile, or null when none is expressed. */
export function resolveHermesProfile(config: Record<string, unknown>): string | null {
  const extraArgs = strings(config.extraArgs);
  for (let index = 0; index < extraArgs.length; index += 1) {
    const arg = extraArgs[index]!.trim();
    if (arg === "-p" || arg === "--profile") {
      const value = extraArgs[index + 1]?.trim();
      if (value) return value;
    }
    if (arg.startsWith("--profile=")) {
      const value = arg.slice("--profile=".length).trim();
      if (value) return value;
    }
  }
  const command = typeof config.hermesCommand === "string" ? config.hermesCommand.trim() : "";
  // A bare invocation of the `hermes` binary is not a profile.
  if (command && command !== "hermes") return command;
  return null;
}

export function hermesToolsets(config: Record<string, unknown>): string[] {
  const raw = typeof config.toolsets === "string" ? config.toolsets : "";
  const fromText = raw.split(/[,\s]+/).map((entry) => entry.trim()).filter(Boolean);
  const fromList = strings(config.enabledToolsets);
  return [...new Set([...fromText, ...fromList].map((entry) => entry.toLowerCase()))];
}

export function hermesHasMcpToolset(config: Record<string, unknown>): boolean {
  return hermesToolsets(config).includes("mcp");
}
