import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "../..");
const addon = require.resolve("@storybook/addon-a11y/package.json", { paths: [resolve(root, "ui")] });
const axePath = require.resolve("axe-core/axe.min.js", { paths: [addon] });
const index = JSON.parse(readFileSync(resolve(root, "ui/storybook-static/index.json"), "utf8"));
const story = (Object.values(index.entries) as { id: string; type: string }[]).find(
  (entry) => entry.type === "story" && entry.id === "design-app-shell--three-panes",
);

async function openTabs(page: Page, theme: "light" | "dark") {
  expect(story, "Missing app-shell story in the built Storybook").toBeTruthy();
  await page.goto(`/iframe.html?id=${story!.id}&viewMode=story&globals=theme:${theme}`);
  const tabs = page.locator('[role="tablist"]');
  await expect(tabs).toBeVisible();
  return tabs;
}

async function axeViolations(page: Page) {
  await page.addScriptTag({ path: axePath });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await page.evaluate(async () => {
        const result = await (window as unknown as {
          axe: { run: (context: unknown, options: unknown) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> };
        }).axe.run(
          { include: ['[role="tablist"]', "[data-side-panel-close-layer]"] },
          { runOnly: { type: "rule", values: ["aria-required-children", "aria-required-parent", "aria-hidden-focus", "aria-allowed-role", "nested-interactive"] } },
        );
        return result.violations.map((violation) => ({
          id: violation.id,
          targets: violation.nodes.map((node) => node.target.join(" ")),
        }));
      });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("Axe is already running")) throw error;
      await page.waitForTimeout(100);
    }
  }
  throw new Error("Axe stayed busy while the Storybook a11y addon ran its own scan");
}

for (const theme of ["light", "dark"] as const) {
  test(`side-panel tabs expose a valid tablist in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const tabs = await openTabs(page, theme);

    const structure = await tabs.evaluate((tablist) => {
      const owned = Array.from(tablist.querySelectorAll("[role]"))
        .map((element) => element.getAttribute("role"))
        .filter((role) => role !== null && role !== "presentation" && role !== "none");
      return {
        roles: owned,
        liveRegions: tablist.querySelectorAll("[aria-live]").length,
        closeButtons: tablist.querySelectorAll('button[aria-label^="Close "]').length,
      };
    });
    expect(structure.roles.every((role) => role === "tab")).toBe(true);
    expect(structure.liveRegions).toBe(0);
    expect(structure.closeButtons).toBe(0);
    expect(await axeViolations(page)).toEqual([]);
  });
}

test("close controls stay keyboard reachable and Delete/Backspace close a tab", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const tabs = await openTabs(page, "dark");

  const activeTab = tabs.locator('[role="tab"][aria-selected="true"]');
  await activeTab.focus();
  const activeName = await activeTab.getAttribute("aria-label");
  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => ({
    label: document.activeElement?.getAttribute("aria-label"),
    role: document.activeElement?.getAttribute("role"),
  }));
  expect(focused.label).toBe(`Close ${activeName}`);
  expect(focused.role).toBeNull();

  // The portaled close control still sits on its tab's right edge.
  const activeWrapper = tabs.locator('[data-side-panel-tab-wrapper][data-active="true"]');
  const activeTabId = await activeWrapper.getAttribute("data-side-panel-tab-wrapper");
  const closeBox = (await page.locator(`[data-side-panel-tab-close="${activeTabId}"]`).boundingBox())!;
  const tabBox = (await activeWrapper.boundingBox())!;
  expect(closeBox.x).toBeGreaterThan(tabBox.x + tabBox.width / 2);
  expect(closeBox.x + closeBox.width).toBeLessThanOrEqual(tabBox.x + tabBox.width + 1);

  const before = await tabs.locator('[role="tab"]').count();
  await activeTab.focus();
  await page.keyboard.press("Delete");
  await expect(tabs.locator('[role="tab"]')).toHaveCount(before - 1);

  const nextActive = tabs.locator('[role="tab"][aria-selected="true"]');
  await nextActive.focus();
  await page.keyboard.press("Backspace");
  await expect(tabs.locator('[role="tab"]')).toHaveCount(before - 2);
});
