import { logger } from "../middleware/logger.js";

/**
 * Answers a failed tool call from a plugin route.
 *
 * A stopped worker is something the caller can act on, and its message is
 * written for them ("worker for plugin X is not running"), so it keeps its own
 * status and text. Any other failure is unexpected: it can carry SQL text, a
 * filesystem path or a provider URL, so the detail goes to the server log and
 * the caller gets a stable message.
 */
export function toolCallFailure(err: unknown): { status: number; body: { error: string } } {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("not running")) return { status: 502, body: { error: message } };
  logger.error({ err }, "plugin tool call failed unexpectedly");
  return {
    status: 500,
    body: { error: "The tool call could not complete. Try again, then check the server log." },
  };
}
