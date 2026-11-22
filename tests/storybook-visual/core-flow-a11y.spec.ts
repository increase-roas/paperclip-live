import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "../..");
const addon = require.resolve("@storybook/addon-a11y/package.json", { paths: [resolve(root, "ui")] });
const axePath = require.resolve("axe-core/axe.min.js", { paths: [addon] });
const index = JSON.parse(readFileSync(resolve(root, "ui/storybook-static/index.json"), "utf8"));

const rules = ["button-name", "aria-hidden-focus", "aria-required-children", "aria-required-parent", "nested-interactive"];

function storyId(id: string) {
  const story = (Object.values(index.entries) as { id: string; type: string }[]).find((entry) => entry.type === "story" && entry.id === id);
  expect(story, `Missing ${id} in the built Storybook`).toBeTruthy();
  return story!.id;
}

async function violations(page: Page) {
  await page.addScriptTag({ path: axePath });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await page.evaluate(async (values) => {
        const result = await (window as unknown as {
          axe: { run: (context: unknown, options: unknown) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> };
        }).axe.run(
          { include: ["#storybook-root", "[role=dialog]"] },
          { runOnly: { type: "rule", values } },
        );
        return result.violations.map((violation) => ({
          id: violation.id,
          targets: violation.nodes.map((node) => node.target.join(" ")),
        }));
      }, rules);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("Axe is already running")) throw error;
      await page.waitForTimeout(100);
    }
  }
  throw new Error("Axe stayed busy while the Storybook a11y addon ran its own scan");
}

for (const [label, story, width] of [
  ["grok bot configuration", "grok-bot-configuration--connected-bot", 1280],
  ["private task sharing", "private-tasks-02-sharing--choose-person-or-agent", 1280],
  ["private task sharing phone", "private-tasks-02-sharing--choose-person-or-agent", 390],
] as const) {
  test(`${label} names every control`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/iframe.html?id=${storyId(story)}&viewMode=story&globals=theme:dark`);
    await page.waitForTimeout(600);
    expect(await violations(page)).toEqual([]);
  });
}

test("grok bot help and sharing picker expose their names to assistive tech", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/iframe.html?id=${storyId("grok-bot-configuration--connected-bot")}&viewMode=story&globals=theme:dark`);
  const unnamed = await page.evaluate(() => Array.from(document.querySelectorAll("#storybook-root button"))
    .filter((button) => !(button.getAttribute("aria-label") ?? button.textContent ?? "").trim())
    .map((button) => button.outerHTML.slice(0, 120)));
  expect(unnamed).toEqual([]);

  await page.goto(`/iframe.html?id=${storyId("private-tasks-02-sharing--choose-person-or-agent")}&viewMode=story&globals=theme:dark`);
  const picker = page.getByRole("combobox", { name: "Choose a person or agent…" });
  await expect(picker).toBeVisible();
  await picker.focus();
  await expect(picker).toBeFocused();
});
