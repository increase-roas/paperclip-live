/**
 * Prototype gate for replaying a read-only tool call once after an OAuth
 * refresh. Default off: the shipped behavior refreshes the credential and
 * refuses to replay, because a server can apply a request before answering
 * 401. See doc/plans/2026-11-22-drive-mcp-401-replay.md.
 */
export const OAUTH_READ_REPLAY_ENV = "PAPERCLIP_TOOL_GATEWAY_REPLAY_READS_AFTER_OAUTH_REFRESH";

export function oauthRefreshReplayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[OAUTH_READ_REPLAY_ENV] === "1";
}

/**
 * A replay is only considered for a read-only call that does not carry an MCP
 * session. A session would need its own re-initialize handshake before the
 * retry, which is outside this prototype.
 */
export function shouldReplayReadAfterOAuthRefresh({
  enabled,
  riskLevel,
  usesMcpSession,
}: {
  enabled: boolean;
  riskLevel: string | null | undefined;
  usesMcpSession: boolean;
}): boolean {
  return enabled && riskLevel === "read" && !usesMcpSession;
}
