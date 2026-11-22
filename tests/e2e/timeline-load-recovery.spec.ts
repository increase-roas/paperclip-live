import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";

async function json(response: APIResponse) {
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

async function seedCompany(request: APIRequestContext) {
  return json(
    await request.post("/api/companies", {
      data: { name: `Timeline recovery ${Date.now().toString(36)}` },
    }),
  );
}

test("a failed timeline explains the failure and retries in place", async ({ page, request }) => {
  test.setTimeout(90_000);
  const company = await seedCompany(request);
  let timelineRequests = 0;

  await page.route("**/api/companies/*/timeline*", async (route) => {
    timelineRequests += 1;
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "timeline unavailable" }),
    });
  });

  await page.goto(`/${company.issuePrefix}/activity/timeline`);

  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Couldn't load the work timeline");
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Range" })).toBeVisible();
  // The audit hub owns the only page title; the embedded timeline is a section.
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);

  await page.unroute("**/api/companies/*/timeline*");
  await page.getByRole("button", { name: "Retry" }).click();

  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("No activity in this window.")).toBeVisible();
  expect(timelineRequests).toBeGreaterThan(1);
});
