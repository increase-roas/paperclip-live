import os from "node:os";

/**
 * How many chat shard workers one invocation may run.
 *
 * The monolithic chat integration file is sharded by collected case count, and
 * each shard runs its own embedded Postgres and server. Two workers was a fixed
 * conservative choice; on an eight-core host each shard spends most of its time
 * waiting on its database, so more workers cut wall time until the box is busy.
 *
 * Measured on this host (2026-11-22) over the same 151 tests: two workers took
 * 323 s, four took 245 s, six took 200 s. Six is the cap because past that the
 * transform and import work each worker redoes starts to dominate the win.
 *
 * A shared test database (DATABASE_URL in the environment) keeps one worker per
 * invocation: those workers would share the one database the caller provided.
 * `PAPERCLIP_CHAT_SHARD_WORKERS` pins the count for a host that needs it.
 */
export function chatWorkerCount(options = {}) {
  const cpuCount = options.cpuCount ?? os.cpus().length;
  const pinned = options.pinned ?? Number.parseInt(process.env.PAPERCLIP_CHAT_SHARD_WORKERS ?? "", 10);
  if (Number.isInteger(pinned) && pinned > 0) return pinned;
  // Leave two cores for the test process itself and its database consoles.
  return Math.max(2, Math.min(6, cpuCount - 2));
}
