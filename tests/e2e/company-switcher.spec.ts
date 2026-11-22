import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";

async function json<T = Record<string, any>>(response: APIResponse): Promise<T> {
  expect(response.ok(), `${response.status()}: ${await response.text()}`).toBe(true);
  return response.json();
}

type Company = { id: string; name: string; prefix: string };

async function createCompany(request: APIRequestContext, label: string): Promise<Company> {
  const created = await json(await request.post("/api/companies", {
    data: { name: `${label} ${randomUUID()}` },
  }));
  return {
    id: created.id,
    name: created.name,
    prefix: created.issuePrefix ?? created.prefix ?? created.urlKey ?? "E2E",
  };
}

test.describe.serial("Company switcher", () => {
  let first: Company;
  let second: Company;

  test.beforeAll(async ({ request }) => {
    first = await createCompany(request, "Switcher Alpha");
    second = await createCompany(request, "Switcher Beta");
    // Give both companies agents (an agentless company auto-opens onboarding)
    // but different counts, so the dashboard headline proves the selected
    // company scopes the data. No heartbeat runs.
    const createAgent = async (company: Company, name: string) =>
      json(await request.post(`/api/companies/${company.id}/agents`, {
        data: {
          name,
          role: "engineer",
          adapterType: "process",
          adapterConfig: { command: "/usr/bin/false" },
          runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
        },
      }));
    await createAgent(first, "Alpha agent one");
    await createAgent(first, "Alpha agent two");
    await createAgent(second, "Beta agent one");
  });

  test.afterAll(async ({ request }) => {
    await Promise.all([first, second].map(company =>
      request.patch(`/api/companies/${company.id}`, { data: { status: "archived" } }).catch(() => {})));
  });

  test("lists organizations, switches scope and persists the choice", async ({ page }) => {
    page.setDefaultTimeout(15_000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/${first.prefix}/dashboard`);
    const enabled = page.getByRole("link").filter({ hasText: "Agents Enabled" });
    await expect(enabled.locator("p").first()).toHaveText("2");

    const firstTrigger = page.getByRole("button", { name: `Open ${first.name} organization switcher` });
    await expect(firstTrigger).toBeVisible({ timeout: 30_000 });
    await firstTrigger.click();

    const menu = page.getByRole("menu");
    // "Invite people to <name>" is also a menuitem. Match the organization row
    // by its exact name span so the action does not also resolve.
    const firstItem = menu.getByRole("menuitem").filter({ has: page.getByText(first.name, { exact: true }) });
    const secondItem = menu.getByRole("menuitem").filter({ has: page.getByText(second.name, { exact: true }) });
    await expect(firstItem).toBeVisible();
    await expect(secondItem).toBeVisible();
    await expect(menu.locator("svg.lucide-check")).toHaveCount(1);
    await expect(firstItem.locator("svg.lucide-check")).toHaveCount(1);

    await secondItem.click();
    await expect(page).toHaveURL(new RegExp(`/${second.prefix}/dashboard$`));
    const secondTrigger = page.getByRole("button", { name: `Open ${second.name} organization switcher` });
    await expect(secondTrigger).toBeVisible();
    await expect(enabled.locator("p").first()).toHaveText("1");
    expect(await page.evaluate(() => window.localStorage.getItem("paperclip.selectedCompanyId"))).toBe(second.id);

    await page.reload();
    await expect(secondTrigger).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/${second.prefix}/dashboard$`));
    await expect(enabled.locator("p").first()).toHaveText("1");

    await secondTrigger.click();
    await page.getByRole("menu").getByRole("menuitem")
      .filter({ has: page.getByText(first.name, { exact: true }) }).click();
    await expect(page).toHaveURL(new RegExp(`/${first.prefix}/dashboard$`));
    await expect(firstTrigger).toBeVisible();
    await expect(enabled.locator("p").first()).toHaveText("2");
  });

  test("opens from the mobile navigation drawer", async ({ page }) => {
    page.setDefaultTimeout(15_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/${first.prefix}/dashboard`);
    await page.getByRole("button", { name: "Open sidebar" }).click();
    const trigger = page.getByRole("button", { name: `Open ${first.name} organization switcher` });
    await expect(trigger).toBeVisible();
    await trigger.click();
    const menu = page.getByRole("menu");
    const secondItem = menu.getByRole("menuitem")
      .filter({ has: page.getByText(second.name, { exact: true }) });
    await expect(secondItem).toBeVisible();
    await secondItem.click();
    await expect(page).toHaveURL(new RegExp(`/${second.prefix}/dashboard$`));
  });
});
