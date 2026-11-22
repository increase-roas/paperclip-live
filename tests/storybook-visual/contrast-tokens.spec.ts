import { expect, test } from "@playwright/test";

type Target = { foreground: string; background: string };

async function measureContrast(page: import("@playwright/test").Page, target: Target) {
  return page.evaluate(({ foreground, background }) => {
    function channels(value: string): [number, number, number] {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#000000";
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
      return [r, g, b];
    }
    function luminance(value: string): number {
      const [r, g, b] = channels(value).map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
    const foregroundElement = document.querySelector(foreground);
    const backgroundElement = document.querySelector(background);
    if (!foregroundElement || !backgroundElement) {
      throw new Error(`Missing contrast target: ${foreground} or ${background}`);
    }
    const foregroundColor = getComputedStyle(foregroundElement).color;
    const backgroundColor = getComputedStyle(backgroundElement).backgroundColor;
    const [lighter, darker] = [luminance(foregroundColor), luminance(backgroundColor)].sort((a, b) => b - a);
    return {
      foregroundColor,
      backgroundColor,
      ratio: (lighter + 0.05) / (darker + 0.05),
    };
  }, target);
}

async function openStory(page: import("@playwright/test").Page, path: string) {
  await page.goto(path);
}

test.describe("scoped contrast tokens", () => {
  test("sidebar recents clear AA in both themes", async ({ page }) => {
    const target: Target = {
      foreground: ".design-sidebar-recents .design-sidebar-item",
      background: ".design-sidebar",
    };

    await openStory(page, "/iframe.html?id=design-sidebar--default&viewMode=story&globals=theme:light");
    await expect(page.locator(target.foreground).first()).toBeVisible();
    const light = await measureContrast(page, target);
    expect(light.foregroundColor).toBe("rgb(102, 102, 102)");
    expect(light.ratio).toBeGreaterThanOrEqual(4.5);

    await openStory(page, "/iframe.html?id=design-sidebar--default&viewMode=story&globals=theme:dark");
    await expect(page.locator(target.foreground).first()).toBeVisible();
    const dark = await measureContrast(page, target);
    expect(dark.ratio).toBeGreaterThanOrEqual(4.5);
  });

  test("avatar fallbacks clear AA in both themes", async ({ page }) => {
    const target: Target = {
      foreground: '[data-slot="avatar-fallback"]',
      background: '[data-slot="avatar-fallback"]',
    };

    await openStory(page, "/iframe.html?id=foundations-primitive-coverage--avatar-states&viewMode=story&globals=theme:light");
    await expect(page.locator(target.foreground).first()).toBeVisible();
    const light = await measureContrast(page, target);
    expect(light.foregroundColor).toBe("rgb(102, 102, 102)");
    expect(light.ratio).toBeGreaterThanOrEqual(4.5);

    await openStory(page, "/iframe.html?id=foundations-primitive-coverage--avatar-states&viewMode=story&globals=theme:dark");
    await expect(page.locator(target.foreground).first()).toBeVisible();
    const dark = await measureContrast(page, target);
    expect(dark.ratio).toBeGreaterThanOrEqual(4.5);
  });
});
