/**
 * Agent inserts for catalog-bot registration.
 *
 * Agent rows are owned by this module: the lifecycle boundary check rejects a
 * direct `insert(agents)` anywhere else, because a row that skips lifecycle
 * initialization can start without the pause and hold bookkeeping the rest of
 * the module maintains. Registration writes `paused` bots only, so it needs the
 * insert without the hire and approval side effects.
 */
import { agents } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface BotAgentInsert {
  companyId: string;
  name: string;
  role: string;
  title: string | null;
  adapterType: string;
  status: string;
  metadata: Record<string, unknown>;
}

/** Insert already-planned bot agents in one statement and return what landed. */
export async function insertBotAgents(
  executor: Db | Transaction,
  rows: BotAgentInsert[],
): Promise<Array<{ id: string; name: string }>> {
  if (rows.length === 0) return [];
  return executor.insert(agents).values(rows).returning({ id: agents.id, name: agents.name });
}
