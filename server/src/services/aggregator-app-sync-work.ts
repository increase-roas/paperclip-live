import { AGGREGATOR_APP_SYNC_SWEEP_MS, AGGREGATOR_APP_SYNC_TTL_MS } from "@paperclipai/shared/aggregator-apps";
import { logger } from "../middleware/logger.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";

/**
 * Refreshes cached Composio account lists before they age out, so a connector's
 * accounts stay verified without a person pressing Refresh. The interval is
 * shorter than the shared freshness window; the sweep itself only picks rows
 * older than that window, so overlapping ticks do no extra work.
 */
export function registerAggregatorAppSyncWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: {
    sweep(staleAfterMs?: number): Promise<{ failedConnectionIds?: string[]; refreshed?: number; skipped?: number; hasTrackedSyncs?: boolean } | void>;
  },
  canRun: () => boolean,
  intervalMs: number = AGGREGATOR_APP_SYNC_SWEEP_MS,
) {
  // An instance with no Composio sync stays quiet: no timer until a new sync
  // lease notifies this queue.
  let idle = false;
  return coordinator.register(DELIVERY_QUEUES.aggregatorAppSync, {
    retryMs: intervalMs,
    pausePassiveMaintenance: true,
    run: async signal => {
      signal.throwIfAborted();
      if (!canRun()) return;
      const result = await service.sweep(AGGREGATOR_APP_SYNC_TTL_MS);
      idle = result?.hasTrackedSyncs === false;
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
    hasPending: async () => false,
    // While syncs exist, the next pass is always one interval out, and a
    // failing gateway is left to the explicit Refresh path.
    nextRunAt: () => idle ? null : Date.now() + intervalMs,
  });
}
