import { createProductAnalytics } from "@paperclipai/shared/analytics";

const env = import.meta.env as Record<string, string | undefined>;

/**
 * Opt-in product analytics for the board UI.
 *
 * The client is a no-op unless `VITE_POSTHOG_KEY` is set at build time and the
 * operator has not opted out with `PAPERCLIP_TELEMETRY_DISABLED`. Only named
 * events and sanitized route templates leave the browser.
 */
export const uiProductAnalytics = createProductAnalytics({
  app: "paperclip-ui",
  apiKey: env.VITE_POSTHOG_KEY,
  host: env.VITE_POSTHOG_HOST,
});

/** Replace ids in a route so analytics never receives a task or company id. */
export function sanitizeAnalyticsRoute(pathname: string): string {
  return pathname
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "/:id")
    .replace(/\/[A-Z][A-Z0-9]+-\d+/g, "/:task")
    .replace(/\/\d+/g, "/:n")
    .slice(0, 200);
}
