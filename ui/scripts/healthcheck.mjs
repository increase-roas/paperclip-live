#!/usr/bin/env node

/**
 * UI health probe for a served board.
 *
 * The UI is static assets behind the Paperclip server, so it has no process of
 * its own. This probe checks the served document and its first same-origin
 * asset. Run it after a deploy, from a container healthcheck, or from the
 * component health exporter:
 *
 *   PAPERCLIP_UI_URL=http://127.0.0.1:3100 pnpm --filter @paperclipai/ui healthcheck
 *
 * Exit codes: 0 = healthy, 1 = unhealthy, 2 = usage error.
 */

const base = (process.env.PAPERCLIP_UI_URL ?? process.env.PAPERCLIP_API_URL ?? "http://127.0.0.1:3100").replace(/\/$/, "");
const timeoutMs = Number(process.env.PAPERCLIP_UI_HEALTH_TIMEOUT_MS ?? 5_000);
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), timeoutMs);

function fail(message, detail = {}) {
  process.stdout.write(`${JSON.stringify({ status: "unhealthy", base, error: message, ...detail }, null, 2)}\n`);
  process.exitCode = 1;
}

try {
  const index = await fetch(`${base}/`, { signal: controller.signal, headers: { accept: "text/html" } });
  const html = await index.text();
  if (!index.ok) {
    fail(`index returned ${index.status}`, { indexStatus: index.status });
  } else if (!/<div[^>]+id=["']root["']/i.test(html)) {
    fail("index is missing the application root element", { indexStatus: index.status });
  } else {
    const assetPath = /(?:src|href)=["'](\/assets\/[^"']+)["']/i.exec(html)?.[1];
    if (!assetPath) {
      fail("index does not reference a built asset", { indexStatus: index.status });
    } else {
      const asset = await fetch(`${base}${assetPath}`, { signal: controller.signal });
      if (!asset.ok) {
        fail(`asset returned ${asset.status}`, { indexStatus: index.status, assetPath, assetStatus: asset.status });
      } else {
        process.stdout.write(
          `${JSON.stringify({
            status: "ok",
            base,
            indexStatus: index.status,
            assetPath,
            assetStatus: asset.status,
          }, null, 2)}\n`,
        );
      }
    }
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  clearTimeout(timer);
}
