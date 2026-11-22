import { expect, test, type APIRequestContext, type APIResponse, type Page } from "@playwright/test";

/**
 * These cases force the query states a real outage or an empty company
 * produces: an empty agent record, a failed agent load with Retry, a slow
 * agent load, and an empty approvals queue. They assert readable copy and a
 * recovery action instead of a blank screen or raw error text.
 */

async function json(response: APIResponse) {
  const text = await response.text();
  expect(response.ok(), `${response.url()}: ${response.status()} ${text}`).toBe(true);
  return JSON.parse(text);
}

async function seedCompanyAndAgent(request: APIRequestContext) {
  const company = await json(await request.post("/api/companies", { data: { name: `State recovery ${Date.now().toString(36)}` } }));
  const agent = await json(
    await request.post(`/api/companies/${company.id}/agents`, {
      data: {
        name: "State Agent",
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

function agentPath(agentId: string) {
  return new RegExp(`/api/agents/${agentId}(\\?.*)?$`);
}

async function waitForMain(page: Page) {
  await expect(page.locator("#main-content")).toBeVisible({ timeout: 30_000 });
}

test.describe("empty and failed query states", () => {
  test("an agent record that resolves empty names the missing agent", async ({ page, request }) => {
    test.setTimeout(120_000);
    const { company, agent } = await seedCompanyAndAgent(request);
    await page.route(agentPath(agent.id), async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "null" });
    });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/${company.issuePrefix}/agents/${agent.id}`);
    await waitForMain(page);

    await expect(page.getByText("Agent not found")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Open agents" })).toBeVisible();
    await expect(page.locator("#main-content")).not.toHaveText("");
  });

  test("a failed agent load keeps a named error and Retry recovers", async ({ page, request }) => {
    test.setTimeout(120_000);
    const { company, agent } = await seedCompanyAndAgent(request);
    let fail = true;
    await page.route(agentPath(agent.id), async (route) => {
      if (!fail) return route.fallback();
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: "upstream unavailable" } }),
      });
    });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/${company.issuePrefix}/agents/${agent.id}`);
    await waitForMain(page);

    const alert = page.locator("#main-content [role='alert']").first();
    await expect(alert).toBeVisible({ timeout: 30_000 });
    await expect(alert).toContainText(/couldn't|unavailable|went wrong/i);

    fail = false;
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByRole("heading", { name: "Engineer" })).toBeVisible({ timeout: 30_000 });
  });

  test("a slow agent load shows a busy placeholder, not a blank page", async ({ page, request }) => {
    test.setTimeout(120_000);
    const { company, agent } = await seedCompanyAndAgent(request);
    await page.route(agentPath(agent.id), async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await route.fallback();
    });

    await page.setViewportSize({ width: 1280, height: 900 });
    const navigation = page.goto(`/${company.issuePrefix}/agents/${agent.id}`);
    await waitForMain(page);

    const placeholder = page.locator("#main-content [data-slot='skeleton']").first();
    await expect(placeholder).toBeVisible({ timeout: 10_000 });
    await navigation;
    await expect(page.getByRole("heading", { name: "Engineer" })).toBeVisible({ timeout: 30_000 });
  });

  test("an empty approvals queue explains what will appear there", async ({ page, request }) => {
    test.setTimeout(120_000);
    const { company } = await seedCompanyAndAgent(request);
    await page.route(new RegExp(`/api/companies/${company.id}/approvals(\\?.*)?$`), async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/${company.issuePrefix}/approvals/pending`);
    await waitForMain(page);

    await expect(page.getByText("No pending approvals")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/approvals appear here when an agent needs a decision/i)).toBeVisible();
  });
});
