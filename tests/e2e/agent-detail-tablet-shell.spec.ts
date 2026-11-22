import { expect, test, type APIRequestContext, type APIResponse, type Page } from "@playwright/test";

/**
 * A 768px tablet used to reserve two 240px rails and leave the agent-detail
 * content column at 225px. Below `lg`, routes with a contextual rail keep that
 * rail in flow and move the primary navigation into the existing off-canvas
 * drawer. Desktop keeps the in-flow primary nav.
 */

async function json(response: APIResponse) {
  const text = await response.text();
  expect(response.ok(), `${response.url()}: ${response.status()} ${text}`).toBe(true);
  return JSON.parse(text);
}

async function seedAgent(request: APIRequestContext) {
  const company = await json(await request.post("/api/companies", { data: { name: `Tablet shell ${Date.now().toString(36)}` } }));
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

test.describe("agent detail tablet shell", () => {
  test("a 768px tablet keeps a readable content column with the primary nav in a drawer", async ({ page, request }) => {
    test.setTimeout(120_000);
    const { company, agent } = await seedAgent(request);
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto(`/${company.issuePrefix}/agents/${agent.id}`);
    await expect(page.getByRole("heading", { name: "Engineer" })).toBeVisible({ timeout: 30_000 });

    expect(await contentWidth(page), "content column at 768px").toBeGreaterThanOrEqual(480);
    const menu = page.getByRole("button", { name: "Open sidebar" });
    await expect(menu).toBeVisible();
    await expect(page.getByRole("button", { name: "Close sidebar" })).toHaveCount(0);

    await menu.click();
    await expect(page.getByRole("button", { name: "Close sidebar" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Workspace navigation" })).toBeVisible();
    await page.getByRole("navigation", { name: "Workspace navigation" }).getByRole("link", { name: "Tasks" }).click();
    await expect(page).toHaveURL(new RegExp(`/${company.issuePrefix}/issues`));
    await expect(page.getByRole("button", { name: "Close sidebar" })).toHaveCount(0);
  });

  test("desktop keeps the in-flow primary navigation without a menu trigger", async ({ page, request }) => {
    test.setTimeout(120_000);
    const { company, agent } = await seedAgent(request);

    await page.setViewportSize({ width: 1024, height: 900 });
    await page.goto(`/${company.issuePrefix}/agents/${agent.id}`);
    await expect(page.getByRole("heading", { name: "Engineer" })).toBeVisible({ timeout: 30_000 });
    const tabletContent = await contentWidth(page);
    expect(tabletContent, "content column at 1024px").toBeGreaterThanOrEqual(480);
    await expect(page.getByRole("button", { name: "Open sidebar" })).toHaveCount(0);
    const sidebar = await page.locator(".coordinator-sidebar").first().boundingBox();
    expect(sidebar).not.toBeNull();
    expect(sidebar!.x).toBe(0);
    expect(sidebar!.width).toBeGreaterThanOrEqual(208);

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.reload();
    await expect(page.getByRole("heading", { name: "Engineer" })).toBeVisible({ timeout: 30_000 });
    const desktopContent = await contentWidth(page);
    expect(desktopContent, "content column at 1280px").toBeGreaterThan(tabletContent);
    expect(desktopContent).toBeGreaterThanOrEqual(700);
    await expect(page.getByRole("button", { name: "Open sidebar" })).toHaveCount(0);
  });

  test("a 375px phone stays on the mobile shell without horizontal overflow", async ({ page, request }) => {
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
