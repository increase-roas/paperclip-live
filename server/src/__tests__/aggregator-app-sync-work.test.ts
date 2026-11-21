import { describe, expect, it, vi } from "vitest";
import { AGGREGATOR_APP_SYNC_SWEEP_MS, AGGREGATOR_APP_SYNC_TTL_MS } from "@paperclipai/shared/aggregator-apps";
import { registerAggregatorAppSyncWork } from "../services/aggregator-app-sync-work.js";
import { logger } from "../middleware/logger.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import type { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";

function coordinator() {
  const registrations: { queue: string; task: any }[] = [];
  return {
    registrations,
    register: (queue: string, task: any) => { registrations.push({ queue, task }); return { ready: Promise.resolve(), wake() {}, stop: async () => {} }; },
  } as unknown as ReturnType<typeof createDeliveryWorkCoordinator> & { registrations: typeof registrations };
}

describe("scheduled aggregator app refresh", () => {
  it("refreshes on the sweep interval and asks for rows older than the shared freshness window", async () => {
    const fake = coordinator();
    const sweep = vi.fn(async () => ({ checked: 2, refreshed: 2, failedConnectionIds: [] }));
    registerAggregatorAppSyncWork(fake, { sweep }, () => true);
    const [{ queue, task }] = fake.registrations;
    expect(queue).toBe(DELIVERY_QUEUES.aggregatorAppSync);
    expect(AGGREGATOR_APP_SYNC_SWEEP_MS).toBeLessThan(AGGREGATOR_APP_SYNC_TTL_MS);
    await task.run(new AbortController().signal);
    expect(sweep).toHaveBeenCalledWith(AGGREGATOR_APP_SYNC_TTL_MS);
    // The sweep never reports pending work; the next pass is a timer.
    expect(await task.hasPending()).toBe(false);
    expect(task.nextRunAt()).toBeGreaterThan(Date.now() + AGGREGATOR_APP_SYNC_SWEEP_MS - 5_000);
  });

  it("names a gateway whose refresh could not start instead of staying silent", async () => {
    const fake = coordinator();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const sweep = vi.fn(async () => ({ checked: 1, refreshed: 0, failedConnectionIds: ["connection-1"] }));
    registerAggregatorAppSyncWork(fake, { sweep }, () => true);
    await fake.registrations[0].task.run(new AbortController().signal);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ failed: 1, connectionIds: ["connection-1"] }),
      expect.stringContaining("could not start"),
    );
    warn.mockRestore();
  });

  it("does no upstream work while the scheduler is paused or idle-draining", async () => {
    const fake = coordinator();
    const sweep = vi.fn(async () => ({}));
    registerAggregatorAppSyncWork(fake, { sweep }, () => false);
    await fake.registrations[0].task.run(new AbortController().signal);
    expect(sweep).not.toHaveBeenCalled();
  });

  it("honours an aborted signal before touching the network", async () => {
    const fake = coordinator();
    const sweep = vi.fn(async () => ({}));
    registerAggregatorAppSyncWork(fake, { sweep }, () => true);
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    await expect(fake.registrations[0].task.run(controller.signal)).rejects.toThrow("stopped");
    expect(sweep).not.toHaveBeenCalled();
  });
});
