import type { Server } from "node:http";

/**
 * Listener ceiling reserved for the HTTP server's startup shutdown hooks.
 *
 * `index.ts` registers one `close` hook per worker or subscription it has to
 * stop — instance lease, backup expiration, task drain, provider-trace
 * retention, login cleanup, native cleanup, budget worker, accounting worker,
 * runtime-asset cleanup, chat completions, and more. Node's default ceiling is
 * 10, so the eleventh hook makes every boot emit `MaxListenersExceededWarning`
 * and a real listener leak later would look like the same noise.
 *
 * 64 leaves room for the current set plus new workers without the warning
 * becoming meaningless. Raising the ceiling does not stop a leak from growing;
 * it only keeps the warning honest for the fixed startup set.
 */
export const SHUTDOWN_LISTENER_CAPACITY = 64;

type ListenerCapacityHost = Pick<Server, "getMaxListeners" | "setMaxListeners">;

/** Raises the server's listener ceiling for the startup shutdown hooks. */
export function reserveShutdownListenerCapacity(
  host: ListenerCapacityHost,
): void {
  if (host.getMaxListeners() < SHUTDOWN_LISTENER_CAPACITY) {
    host.setMaxListeners(SHUTDOWN_LISTENER_CAPACITY);
  }
}
