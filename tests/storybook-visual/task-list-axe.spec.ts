import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "../..");
const addon = require.resolve("@storybook/addon-a11y/package.json", { paths: [resolve(root, "ui")] });
const axePath = require.resolve("axe-core/axe.min.js", { paths: [addon] });

test.use({ viewport: { width: 1512, height: 862 } });

async function openStory(page: Page, id: string) {
  await page.goto(`/iframe.html?id=${id}&viewMode=story&globals=theme:dark`);
  await expect(page.locator("#storybook-root")).not.toBeEmpty({ timeout: 15_000 });
  await expect(page.locator(".sb-errordisplay")).not.toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function ariaStructureViolations(page: Page, selector: string) {
  await page.addScriptTag({ path: axePath });
  return page.evaluate(async (target) => {
    const result = await (window as Window & { axe: { run: (context: unknown, options: unknown) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe.run(
      { include: [target] },
      { runOnly: { type: "rule", values: ["aria-required-children", "aria-required-parent"] } },
    );
    return result.violations.map(violation => ({ id: violation.id, targets: violation.nodes.map(node => node.target) }));
  }, selector);
}

test("task table exposes rowgroups, rows and cells with no ARIA structure violations", async ({ page }) => {
  await openStory(page, "tasks-list-page-design--default");
  const table = page.locator('[role="table"][aria-label="Task list"]').first();
  await expect(table).toBeVisible();
  await expect(table.locator('[role="rowgroup"]').first()).toBeVisible();
  await expect(table.locator('[role="row"] [role="columnheader"]').first()).toBeVisible();
  expect(await ariaStructureViolations(page, '[role="table"]')).toEqual([]);
});

test("task table all-columns specimen keeps the overlay link and cells valid", async ({ page }) => {
  await openStory(page, "tasks-row-design--all-columns");
  const table = page.locator('[role="table"][aria-label="Task list"]').first();
  await expect(table).toBeVisible();
  await expect(table.locator('[role="row"] [role="cell"] [data-inbox-issue-link]').first()).toBeAttached();
  expect(await ariaStructureViolations(page, '[role="table"]')).toEqual([]);
});

test("task table empty state sits inside a row and cell", async ({ page }) => {
  await openStory(page, "tasks-list-page-design--no-results");
  const table = page.locator('[role="table"][aria-label="Task list"]').first();
  await expect(table).toBeVisible();
  await expect(table.locator('[role="row"] [role="cell"]').first()).toBeVisible();
  expect(await ariaStructureViolations(page, '[role="table"]')).toEqual([]);
});
