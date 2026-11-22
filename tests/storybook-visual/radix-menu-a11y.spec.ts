import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "../..");
const addon = require.resolve("@storybook/addon-a11y/package.json", { paths: [resolve(root, "ui")] });
const axePath = require.resolve("axe-core/axe.min.js", { paths: [addon] });
const storybookIndex = JSON.parse(readFileSync(resolve(root, "ui/storybook-static/index.json"), "utf8"));

function requireStory(id: string) {
  const story = (Object.values(storybookIndex.entries) as { id: string; type: string }[]).find(
    (entry) => entry.type === "story" && entry.id === id,
  );
  expect(story, `Missing ${id} in the built Storybook`).toBeTruthy();
  return story!;
}

const menuRules = ["aria-hidden-focus", "aria-required-children", "aria-required-parent", "aria-allowed-role"];

async function menuViolations(page: Page) {
  await page.addScriptTag({ path: axePath });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await page.evaluate(async (rules) => {
        const result = await (window as unknown as {
          axe: { run: (context: unknown, options: unknown) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> };
        }).axe.run(
          { include: ["#storybook-root", '[role="menu"]', "[data-radix-popper-content-wrapper]"] },
          { runOnly: { type: "rule", values: rules } },
        );
        return result.violations.map((violation) => ({
          id: violation.id,
          targets: violation.nodes.map((node) => node.target.join(" ")),
        }));
      }, menuRules);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("Axe is already running")) throw error;
      await page.waitForTimeout(100);
    }
  }
  throw new Error("Axe stayed busy while the Storybook a11y addon ran its own scan");
}

test("organization menu is non-modal and returns focus on Escape", async ({ page }) => {
  const story = requireStory("design-sidebar--organization-menu");
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto(`/iframe.html?id=${story.id}&viewMode=story&globals=theme:dark`);
  const trigger = page.getByRole("button", { name: /organization switcher/ });
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  // Radix's modal menu hides the rest of the page with aria-hidden, which
  // leaves focusable elements inside a hidden subtree.
  await expect(page.locator("#storybook-root")).not.toHaveAttribute("aria-hidden", "true");
  expect(await menuViolations(page)).toEqual([]);

  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.press("Enter");
  await expect(menu).toBeVisible();
});

test("task views flyout is non-modal and returns focus on Escape", async ({ page }) => {
  const story = requireStory("design-toolbars--tasks");
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto(`/iframe.html?id=${story.id}&viewMode=story&globals=theme:dark`);
  const trigger = page.getByRole("button", { name: /Task view:/ });
  await trigger.click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(page.locator("#storybook-root")).not.toHaveAttribute("aria-hidden", "true");
  expect(await menuViolations(page)).toEqual([]);

  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.press("Enter");
  await expect(menu).toBeVisible();
  await page.getByRole("menuitemradio", { name: "Needs attention" }).click();
  await expect(menu).toBeHidden();
  await expect(page.getByRole("button", { name: "Task view: Needs attention" })).toBeVisible();
});
