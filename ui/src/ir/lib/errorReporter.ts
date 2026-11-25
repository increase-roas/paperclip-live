import { redactIncidentText } from "@paperclipai/shared/observability";

const WINDOW_MS = 60_000;
const MAX_FINGERPRINTS = 256;
const MAX_BODY_BYTES = 16 * 1024;
const NOISE = /^(?:ResizeObserver loop limit exceeded|ResizeObserver loop completed with undelivered notifications)\.?$/i;

const recent = new Map<string, number>();
let installed = false;

type ErrorDetails = {
  severity?: "error" | "fatal";
  componentStack?: string | null;
};

function isDuplicate(fingerprint: string): boolean {
  const now = Date.now();
  for (const [key, expires] of recent) {
    if (expires > now) break;
    recent.delete(key);
  }
  if (recent.has(fingerprint)) return true;
  if (recent.size >= MAX_FINGERPRINTS) {
    const oldest = recent.keys().next().value;
    if (oldest !== undefined) recent.delete(oldest);
  }
  recent.set(fingerprint, now + WINDOW_MS);
  return false;
}

export function reportClientError(error: unknown, details: ErrorDetails = {}): void {
  try {
    const rawMessage = error instanceof Error ? error.message : typeof error === "string" ? error : "";
    if (NOISE.test(rawMessage.trim())) return;
    const message = redactIncidentText(rawMessage, 2048).trim() || "Unknown browser error";
    const stack = error instanceof Error && typeof error.stack === "string" ? redactIncidentText(error.stack, 4096) : undefined;
    const route = redactIncidentText(window.location.pathname, 1024);
    const fingerprint = JSON.stringify([message, stack?.split("\n", 2)[1], route]);
    if (isDuplicate(fingerprint)) return;

    const release = typeof __PAPERCLIP_BUILD_COMMIT__ === "string"
      ? redactIncidentText(__PAPERCLIP_BUILD_COMMIT__, 128)
      : undefined;
    const base = { message, route, release, severity: details.severity ?? "error" };
    const componentStack = details.componentStack ? redactIncidentText(details.componentStack, 2048) : undefined;
    let body = JSON.stringify({ ...base, stack, componentStack });
    if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
      body = JSON.stringify({ message, release, severity: base.severity });
    }

    void fetch("/api/ir/errors/client", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
      credentials: "include",
    }).catch(() => {});
  } catch {
    // Reporting must stay safe even when the browser is failing.
  }
}

export function installErrorReporter(): void {
  if (installed) return;
  installed = true;
  window.addEventListener("error", (event) => {
    if (event.error || event.message) reportClientError(event.error ?? event.message);
  });
  window.addEventListener("unhandledrejection", (event) => reportClientError(event.reason));
}
