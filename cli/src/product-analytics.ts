import { createProductAnalytics } from "@paperclipai/shared/analytics";

/**
 * Opt-in product analytics for the CLI.
 *
 * Disabled unless `PAPERCLIP_POSTHOG_KEY` (or `POSTHOG_API_KEY`) is set. The
 * CLI records the command name and outcome only; it never sends arguments,
 * environment, paths, prompts, or server responses.
 */
export const cliProductAnalytics = createProductAnalytics({
  app: "paperclipai-cli",
  apiKey: process.env.PAPERCLIP_POSTHOG_KEY ?? process.env.POSTHOG_API_KEY,
  host: process.env.PAPERCLIP_POSTHOG_HOST ?? process.env.POSTHOG_HOST,
});
