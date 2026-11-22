import { expect, test, type APIRequestContext, type APIResponse, type Locator, type Page } from "@playwright/test";

async function json(response: APIResponse) {
  const text = await response.text();
  expect(response.ok(), `${response.url()}: ${response.status()} ${text}`).toBe(true);
  return JSON.parse(text);
}

async function seedCompany(request: APIRequestContext) {
  const company = await json(await request.post("/api/companies", { data: { name: `Mobile keyboard ${Date.now().toString(36)}` } }));
  await json(
    await request.post(`/api/companies/${company.id}/agents`, {
      data: {
        name: "Mobile Agent",
        role: "engineer",
        adapterType: "process",
        adapterConfig: { command: "/usr/bin/true" },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
      },
    }),
  );
  return company;
}

async function expectNoPageOverflow(page: Page, label: string) {
  // The phone shell scrolls the body, not the document element. Chromium can
  // report a few extra pixels on documentElement.scrollWidth from clipped
  // descendants, so measure the body and confirm the page cannot scroll
  // sideways.
  const { bodyOverflow, scrolledX } = await page.evaluate(() => {
    const body = document.body;
    const startX = window.scrollX;
    window.scrollTo(startX + 100, window.scrollY);
    const moved = window.scrollX;
    window.scrollTo(startX, window.scrollY);
    return { bodyOverflow: body.scrollWidth - body.clientWidth, scrolledX: moved };
  });
  expect(bodyOverflow, `${label} body overflow at ${page.viewportSize()?.width}px`).toBeLessThanOrEqual(1);
  expect(scrolledX, `${label} can scroll sideways at ${page.viewportSize()?.width}px`).toBe(0);
}

async function expectWithinViewport(page: Page, locator: Locator, label: string) {
  await expect(locator, `${label} is visible`).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${label} has a box`).not.toBeNull();
  const width = page.viewportSize()!.width;
  expect(box!.x, `${label} starts inside the viewport`).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width, `${label} ends inside the viewport`).toBeLessThanOrEqual(width + 1);
}

test.describe("phone lists stay inside the viewport", () => {
  for (const width of [320, 390]) {
    test(`${width}px lists and settings do not overflow horizontally`, async ({ page, request }) => {
      test.setTimeout(120_000);
      const company = await seedCompany(request);
      await page.setViewportSize({ width, height: 812 });

      const paths = ["bots", "routines", "approvals/pending", "agents/all", "issues", "company/settings"];
      for (const path of paths) {
        await page.goto(`/${company.issuePrefix}/${path}`);
        await expect(page.locator("#main-content")).toBeVisible({ timeout: 30_000 });
        await page.waitForTimeout(750);
        await expectNoPageOverflow(page, path);
      }

      await page.goto(`/${company.issuePrefix}/bots`);
      await expectWithinViewport(page, page.getByRole("textbox", { name: "Search bots" }), "Bots search");

      await page.goto(`/${company.issuePrefix}/routines`);
      await expectWithinViewport(page, page.getByRole("button", { name: "Create routine" }), "Create routine");

      await page.goto(`/${company.issuePrefix}/agents/all`);
      await expectWithinViewport(page, page.getByRole("button", { name: /New agent/i }).first(), "New agent");
    });
  }
});

test.describe("phone drawer keyboard contract", () => {
  test("Escape closes the drawer and returns focus to the menu trigger", async ({ page, request }) => {
    test.setTimeout(120_000);
    const company = await seedCompany(request);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/${company.issuePrefix}/dashboard`);
    await expect(page.locator("#main-content")).toBeVisible({ timeout: 30_000 });

    const trigger = page.getByRole("button", { name: "Open sidebar" });
    await trigger.click();
    const drawer = page.locator("[data-mobile-drawer]");
    await expect(page.getByRole("dialog", { name: "Navigation" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest("[data-mobile-drawer]")))).toBe(true);

    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Close sidebar" })).toHaveCount(0);
    await expect(drawer).toHaveAttribute("inert", "");
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Open sidebar");
  });
});

test.describe("desktop dialog and skip-link keyboard contract", () => {
  test("Escape closes the New task dialog and restores its trigger", async ({ page, request }) => {
    test.setTimeout(120_000);
    const company = await seedCompany(request);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/${company.issuePrefix}/dashboard`);
    await expect(page.locator("#main-content")).toBeVisible({ timeout: 30_000 });

    const trigger = page.getByRole("button", { name: "New task" }).first();
    await trigger.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("New task");
  });

  test("the skip link moves focus to main content", async ({ page, request }) => {
    test.setTimeout(120_000);
    const company = await seedCompany(request);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/${company.issuePrefix}/dashboard`);
    await expect(page.locator("#main-content")).toBeVisible({ timeout: 30_000 });

    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to Main Content" });
    await expect(skip).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("main-content");
  });
});
