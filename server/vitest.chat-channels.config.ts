import { defineConfig } from "vitest/config";

import base from "./vitest.config";

/**
 * The chat-channel area files each boot and tear down their own embedded
 * Postgres, and each file runs its cases serially. Several files can run at
 * once, which is what makes a whole-directory run practical: at one worker the
 * 47 files take about 54 minutes, and at four they take about 16.
 *
 * This config is separate from `vitest.config.ts` because the rest of the
 * server suite keeps `maxWorkers: 1` for the reasons recorded there.
 *
 * The default stays at one worker, which gives the deterministic 47-file result.
 * `PAPERCLIP_CHAT_CHANNELS_WORKERS=4` runs the directory in about 19 minutes
 * instead of 54, and it is how this config was measured. Two suites are
 * timing-sensitive under that load and failed there while passing alone:
 * `08-github-webhook-recovery-scheduling` (a 10s real-time poll for 21 database
 * batches; PR #110 replaces it with an explicit pass loop) and
 * `24-publishes-a-closed-choice-question-sett` (a 250 ms acknowledgement race,
 * fixed by the Slack three-second window in #121). Re-run after those land.
 *
 * The timeouts are higher than the base config because several embedded
 * Postgres instances and Node workers share one machine: a case that takes 3s
 * alone can take 10s under that load, and a 15s budget then fails a test that
 * is merely queued. Above four workers the box saturates and the run gets
 * slower, not faster.
 *
 * `include` replaces the base list instead of extending it, so this config runs
 * the chat-channel directory only. Merge utilities concatenate arrays, which
 * would quietly run the whole server suite instead.
 */
const baseTest = (base as { test?: Record<string, unknown> }).test ?? {};

export default defineConfig({
  ...(base as Record<string, unknown>),
  test: {
    ...baseTest,
    include: ["src/__tests__/chat-channels/**/*.test.ts"],
    maxWorkers: Number(process.env.PAPERCLIP_CHAT_CHANNELS_WORKERS ?? 1),
    testTimeout: 45_000,
    hookTimeout: 60_000,
  },
});
