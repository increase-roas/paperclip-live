import { expect, test, type APIResponse } from "@playwright/test";

async function json(response: APIResponse) {
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

for (const viewport of [
  { label: "desktop", width: 1280, height: 800 },
  { label: "mobile", width: 390, height: 844 },
]) {
  test(`an instance without a public assistant endpoint explains the setup state (${viewport.label})`, async ({ page, request }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const company = await json(
      await request.post("/api/companies", { data: { name: `Assistant unavailable ${Date.now().toString(36)}` } }),
    );

    await page.goto(`/${company.issuePrefix}/apps`);
    await expect(page.getByText("Assistant Connection (MCP)")).toBeVisible();
    await expect(page.getByText("Assistant connections are unavailable on this instance.")).toBeVisible();
    await expect(page.getByText("Couldn't load your connection status")).toHaveCount(0);

    await page.getByRole("button", { name: "Open Assistant Connection (MCP)" }).click();
    await expect(page).toHaveURL(/\/apps\/assistant-connection$/);
    await expect(page.getByRole("heading", { name: "Enable assistant connections" })).toBeVisible();
    await expect(page.getByText("This instance has no public assistant endpoint yet.")).toBeVisible();
    await expect(page.getByText("API route not found")).toHaveCount(0);
    await expect(page.getByText("Couldn't load assistant setup")).toHaveCount(0);
  });
}
