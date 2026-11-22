import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Route } from "@playwright/test";

async function json(response: Awaited<ReturnType<APIRequestContext["post"]>>) {
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

async function createCompany(request: APIRequestContext) {
  const company = await json(await request.post("/api/companies", { data: { name: `States ${randomUUID()}` } }));
  const agent = await json(
    await request.post(`/api/companies/${company.id}/agents`, {
      data: {
        name: "State Bot",
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

async function failWith(route: Route, status: number, code: string) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify({ error: code }),
  });
}

test.describe("list and detail pages explain failures and let people retry", () => {
  test("the adapters page shows readable copy and a retry instead of an empty list", async ({ page, request }) => {
    test.setTimeout(90_000);
    const { company } = await createCompany(request);
    let failing = true;
    await page.route(/\/api\/adapters(\?|$)/, async (route) => {
      if (failing) await failWith(route, 500, "internal_error");
      else await route.continue();
    });

    await page.goto(`/${company.issuePrefix}/company/settings/instance/adapters`);
    const error = page.locator('[data-query-view="error"]');
    await expect(error).toBeVisible({ timeout: 20_000 });
    await expect(error).toContainText("Retry");
    await expect(page.getByText("Loading adapters...")).toHaveCount(0);

    failing = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Adapters", exact: true })).toBeVisible();
    await expect(error).toHaveCount(0);
  });

  test("a user profile outage is not reported as a missing person", async ({ page, request }) => {
    test.setTimeout(90_000);
    const { company } = await createCompany(request);
    let status = 500;
    await page.route(new RegExp(`/api/companies/${company.id}/users/.*/profile`), async (route) => {
      if (status === 500) await failWith(route, 500, "internal_error");
      else if (status === 404) await failWith(route, 404, "not_found");
      else await route.continue();
    });

    await page.goto(`/${company.issuePrefix}/u/jane-example`);
    const error = page.locator('[data-query-view="error"]');
    await expect(error).toBeVisible({ timeout: 20_000 });
    await expect(error).toContainText("Retry");
    await expect(page.getByText("No profile for this person")).toHaveCount(0);

    // Once the server says the person is gone, say that and offer the member list.
    status = 404;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByText("No profile for this person", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "View organization members", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "View organization members", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${company.issuePrefix}/company/settings/members$`));
  });
});
