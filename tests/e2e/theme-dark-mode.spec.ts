import { randomUUID } from "node:crypto";
import { expect, test, type APIResponse, type Page } from "@playwright/test";

async function json<T = Record<string, any>>(response: APIResponse): Promise<T> {
  expect(response.ok(), `${response.status()}: ${await response.text()}`).toBe(true);
  return response.json();
}

async function readTheme(page: Page) {
  return page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      scheme: document.documentElement.style.colorScheme,
      dark: document.documentElement.classList.contains("dark"),
      background: style.getPropertyValue("--background").trim(),
      foreground: style.getPropertyValue("--foreground").trim(),
      card: style.getPropertyValue("--card").trim(),
      body: getComputedStyle(document.body).backgroundColor,
      stored: window.localStorage.getItem("paperclip.theme"),
    };
  });
}

test.describe("Dark mode", () => {
  let companyId: string;
  let prefix: string;

  test.beforeAll(async ({ request }) => {
    const company = await json(await request.post("/api/companies", {
      data: { name: `Theme assertions ${randomUUID()}` },
    }));
    companyId = company.id;
    prefix = company.issuePrefix ?? company.prefix ?? company.urlKey ?? "E2E";
    // Keep the dashboard on the company page instead of the agentless
    // onboarding redirect. No heartbeat runs.
    await json(await request.post(`/api/companies/${companyId}/agents`, {
      data: {
        name: "Theme assertion agent",
        role: "engineer",
        adapterType: "process",
        adapterConfig: { command: "/usr/bin/false" },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
      },
    }));
  });

  test.afterAll(async ({ request }) => {
    await request.patch(`/api/companies/${companyId}`, { data: { status: "archived" } }).catch(() => {});
  });

  test("toggles tokens, body surface and persistence across reloads", async ({ page }) => {
    page.setDefaultTimeout(15_000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/${prefix}/dashboard`);
    // Start from a known light theme. Set it once, then reload, so later
    // reloads prove the app persisted the toggle instead of a test-only
    // init script resetting it.
    await page.evaluate(() => window.localStorage.setItem("paperclip.theme", "light"));
    await page.reload();

    const light = await readTheme(page);
    expect(light.dark).toBe(false);
    expect(light.scheme).toBe("light");
    expect(light.stored).toBe("light");
    expect(light.background).toMatch(/^oklch\((1|100%) 0 0\)$/);
    expect(light.body).not.toBe("rgba(0, 0, 0, 0)");

    await page.getByRole("button", { name: "Open account menu" }).click();
    await page.getByRole("button", { name: "Switch to dark mode" }).click();
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);

    const dark = await readTheme(page);
    expect(dark.dark).toBe(true);
    expect(dark.scheme).toBe("dark");
    expect(dark.stored).toBe("dark");
    expect(dark.background).toMatch(/^oklch\((0\.205|20\.5%) 0 0\)$/);
    expect(dark.foreground).not.toBe(light.foreground);
    expect(dark.card).not.toBe(light.card);
    expect(dark.body).not.toBe(light.body);
    expect(dark.body).not.toBe("rgba(0, 0, 0, 0)");

    await page.reload();
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    const reloaded = await readTheme(page);
    expect(reloaded.stored).toBe("dark");
    expect(reloaded.background).toBe(dark.background);
    expect(reloaded.body).toBe(dark.body);

    await page.getByRole("button", { name: "Open account menu" }).click();
    await page.getByRole("button", { name: "Switch to light mode" }).click();
    await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
    const restored = await readTheme(page);
    expect(restored.stored).toBe("light");
    expect(restored.background).toBe(light.background);
    expect(restored.body).toBe(light.body);
  });
});
