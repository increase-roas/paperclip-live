import { AGGREGATOR_APP_SYNC_SWEEP_MS, AGGREGATOR_APP_SYNC_TTL_MS } from "@paperclipai/shared/aggregator-apps";
import { logger } from "../middleware/logger.js";
import { registerDeadlineWork } from "./deadline-work.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";

/**
 * Refreshes cached Composio account lists before they age out, so a connector's
 * accounts stay verified without a person pressing Refresh.
 *
 * This is deadline work, not a timer: the next pass is scheduled at the oldest
 * cached list's freshness deadline, and a request that creates a row wakes the
 * queue. An instance that never cached an account list therefore performs no
 * database work at all, which keeps an idle instance quiet.
 */
export function registerAggregatorAppSyncWork(
  coordinator: Pick<ReturnType<typeof createDeliveryWorkCoordinator>, "register">,
  service: {
    sweep(staleAfterMs?: number): Promise<{ failedConnectionIds?: string[]; refreshed?: number; skipped?: number } | void>;
    nextDueAt(): Promise<number | null>;
  },
  canRun: () => boolean,
  intervalMs: number = AGGREGATOR_APP_SYNC_SWEEP_MS,
) {
  return registerDeadlineWork(coordinator, DELIVERY_QUEUES.aggregatorAppSync, {
    retryMs: intervalMs,
    minimumSpacingMs: intervalMs,
    canRun,
    run: async signal => {
      signal.throwIfAborted();
      const result = await service.sweep(AGGREGATOR_APP_SYNC_TTL_MS);
      const failed = result?.failedConnectionIds ?? [];
      if (failed.length > 0) {
        // The affected rows are marked failed, so the app shows "Last check
        // failed". The log names the gateways so an operator can find them
        // without reading every app page.
        logger.warn(
          { failed: failed.length, connectionIds: failed.slice(0, 10) },
          "aggregator app sweep could not start planned refreshes",
        );
      }
    },
    // A failing gateway is left to the explicit Refresh path, so the next pass
    // comes from the oldest healthy deadline rather than a retry loop.
    next: () => service.nextDueAt(),
  });
}
