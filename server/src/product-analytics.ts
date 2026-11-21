import { createProductAnalytics } from "@paperclipai/shared/analytics";

/**
 * Opt-in product analytics for the server.
 *
 * Disabled unless `PAPERCLIP_POSTHOG_KEY` (or `POSTHOG_API_KEY`) is set. The
 * server records named product events: startup and mutation route templates.
 * It never sends request bodies, query strings, user content, or credentials.
 */
export const serverProductAnalytics = createProductAnalytics({
  app: "paperclip-server",
  apiKey: process.env.PAPERCLIP_POSTHOG_KEY ?? process.env.POSTHOG_API_KEY,
  host: process.env.PAPERCLIP_POSTHOG_HOST ?? process.env.POSTHOG_HOST,
});
