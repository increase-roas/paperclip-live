export const PROVIDER_AUTH_FAILURE_CODES = [
  "claude_auth_required",
  "acpx_auth_required",
  "native_provider_auth_required",
] as const;

export function isProviderAuthFailureCode(code: string | null | undefined): boolean {
  return Boolean(code && (PROVIDER_AUTH_FAILURE_CODES as readonly string[]).includes(code));
}

/** The agent-level state that needs a person to reconnect a provider account. */
export function agentNeedsAuthReconnect(agent: { status?: string | null; pauseReason?: string | null }): boolean {
  return agent.status === "paused" && agent.pauseReason === "auth_required";
}

/** The name a person sees on the reconnect action for this agent's provider. */
export function providerAuthLabel(agent: {
  adapterType?: string | null;
  adapterConfig?: Record<string, unknown> | null;
}): string {
  const config = agent.adapterConfig ?? {};
  const acpxAgent = typeof config.acpxAgent === "string" ? config.acpxAgent : "";
  const provider = typeof config.provider === "string" ? config.provider : "";
  if (agent.adapterType === "claude_local" || acpxAgent === "claude" || provider === "claude") return "Claude";
  if (agent.adapterType === "codex_local" || acpxAgent === "codex") return "Codex";
  if (agent.adapterType === "gemini_local" || acpxAgent === "gemini") return "Gemini";
  if (agent.adapterType === "opencode_local" || acpxAgent === "opencode") return "OpenCode";
  return "provider";
}
