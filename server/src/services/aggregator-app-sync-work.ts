import { AGGREGATOR_APP_SYNC_SWEEP_MS, AGGREGATOR_APP_SYNC_TTL_MS } from "@paperclipai/shared/aggregator-apps";
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
  service: { sweep(staleAfterMs?: number): Promise<unknown> },
  canRun: () => boolean,
  intervalMs: number = AGGREGATOR_APP_SYNC_SWEEP_MS,
) {
  return coordinator.register(DELIVERY_QUEUES.aggregatorAppSync, {
    retryMs: intervalMs,
    pausePassiveMaintenance: true,
    run: async signal => {
      signal.throwIfAborted();
      if (!canRun()) return;
      await service.sweep(AGGREGATOR_APP_SYNC_TTL_MS);
    },
    hasPending: async () => false,
    // A pure timer: the next pass is always one interval out, and a failing
    // gateway is left to the explicit Refresh path.
    nextRunAt: () => Date.now() + intervalMs,
  });
}
