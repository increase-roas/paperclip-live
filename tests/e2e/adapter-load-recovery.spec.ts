import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";

async function json(response: APIResponse) {
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

async function seedCompany(request: APIRequestContext) {
  return json(
    await request.post("/api/companies", {
      data: { name: `Adapters recovery ${Date.now().toString(36)}` },
    }),
  );
}

test("a failed adapter list says so and retries instead of showing an empty inventory", async ({ page, request }) => {
  test.setTimeout(90_000);
  const company = await seedCompany(request);

  await page.route("**/api/adapters", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "adapter registry unavailable" }),
    });
  });

  await page.goto(`/${company.issuePrefix}/company/settings/instance/adapters`);

  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Couldn't load adapters");
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(page.getByText("No external adapters installed")).toHaveCount(0);

  await page.unroute("**/api/adapters");
  await page.getByRole("button", { name: "Retry" }).click();

  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "External Adapters" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Built-in Adapters" })).toBeVisible();
});
