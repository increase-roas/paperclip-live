import { expect, test, type APIRequestContext, type APIResponse, type Page } from "@playwright/test";

/**
 * Alternative to the tablet drawer: between the mobile breakpoint and `lg`,
 * routes with a contextual rail keep the primary navigation in flow as the
 * existing 64px icon rail. Desktop keeps the expanded 240px navigation.
 *
 * The rail keeps one-click access to every primary destination on a tablet, at
 * the cost of a narrower content column than the drawer (64px reserved vs 0).
 */

async function json(response: APIResponse) {
  const text = await response.text();
  expect(response.ok(), `${response.url()}: ${response.status()} ${text}`).toBe(true);
  return JSON.parse(text);
}

async function seedAgent(request: APIRequestContext) {
  const company = await json(await request.post("/api/companies", { data: { name: `Tablet rail ${Date.now().toString(36)}` } }));
  const agent = await json(
    await request.post(`/api/companies/${company.id}/agents`, {
      data: {
        name: "Tablet Agent",
        role: "engineer",
        adapterType: "process",
        adapterConfig: { command: "/usr/bin/true" },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
      },
    }),
  );
  await request.post(`/api/agents/${agent.id}/pause`);
  return { company, agent };
}

async function contentWidth(page: Page) {
  const content = page.locator(".agent-settings-content").first();
  await expect(content).toBeVisible({ timeout: 30_000 });
  const box = await content.boundingBox();
  expect(box).not.toBeNull();
  return box!.width;
}

async function primaryNavWidth(page: Page) {
  const nav = page.locator(".coordinator-sidebar").first();
  await expect(nav).toBeVisible({ timeout: 30_000 });
  const box = await nav.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

test.describe("agent detail tablet icon rail", () => {
  test("a 768px tablet keeps the primary nav as a 64px icon rail", async ({ page, request }) => {
    test.setTimeout(120_000);
    const { company, agent } = await seedAgent(request);
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto(`/${company.issuePrefix}/agents/${agent.id}`);
    await expect(page.getByRole("heading", { name: "Engineer" })).toBeVisible({ timeout: 30_000 });

    expect(await contentWidth(page), "content column at 768px").toBeGreaterThanOrEqual(420);
    const rail = await primaryNavWidth(page);
    expect(rail.x, "primary rail starts at the left edge").toBe(0);
    expect(rail.width, "primary rail width").toBeGreaterThanOrEqual(63);
    expect(rail.width, "primary rail width").toBeLessThanOrEqual(65);
    await expect(page.getByRole("button", { name: "Open sidebar" })).toHaveCount(0);

    const navigation = page.getByRole("navigation", { name: "Workspace navigation" });
    await expect(navigation).toBeVisible();
    await expect(navigation.getByRole("link", { name: "Tasks" })).toBeVisible();
    await navigation.getByRole("link", { name: "Tasks" }).click();
    await expect(page).toHaveURL(new RegExp(`/${company.issuePrefix}/issues`));
    expect((await primaryNavWidth(page)).width, "rail persists after navigation").toBeLessThanOrEqual(65);
  });

  test("1024px and 1280px keep the expanded in-flow navigation", async ({ page, request }) => {
    test.setTimeout(120_000);
    const { company, agent } = await seedAgent(request);

    await page.setViewportSize({ width: 1024, height: 900 });
    await page.goto(`/${company.issuePrefix}/agents/${agent.id}`);
    await expect(page.getByRole("heading", { name: "Engineer" })).toBeVisible({ timeout: 30_000 });
    const tabletContent = await contentWidth(page);
    expect(tabletContent, "content column at 1024px").toBeGreaterThanOrEqual(480);
    expect((await primaryNavWidth(page)).width, "expanded nav at 1024px").toBeGreaterThanOrEqual(208);
    await expect(page.getByRole("button", { name: "Open sidebar" })).toHaveCount(0);

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.reload();
    await expect(page.getByRole("heading", { name: "Engineer" })).toBeVisible({ timeout: 30_000 });
    const desktopContent = await contentWidth(page);
    expect(desktopContent, "content column at 1280px").toBeGreaterThan(tabletContent);
    expect(desktopContent, "content column at 1280px").toBeGreaterThanOrEqual(700);
    expect((await primaryNavWidth(page)).width, "expanded nav at 1280px").toBeGreaterThanOrEqual(208);
    await expect(page.getByRole("button", { name: "Open sidebar" })).toHaveCount(0);
  });

  test("a 375px phone stays on the mobile drawer without horizontal overflow", async ({ page, request }) => {
    test.setTimeout(120_000);
    const { company, agent } = await seedAgent(request);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/${company.issuePrefix}/agents/${agent.id}`);
    await expect(page.getByRole("heading", { name: "Engineer" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Open sidebar" })).toBeVisible();
    expect(await contentWidth(page)).toBeGreaterThanOrEqual(300);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
