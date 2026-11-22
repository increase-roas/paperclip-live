import { expect, test, type APIResponse } from "@playwright/test";

async function json(response: APIResponse) {
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

test("timeline summary stays readable and the zoom controls move below it on a phone", async ({ page, request }) => {
  test.setTimeout(90_000);
  const company = await json(await request.post("/api/companies", { data: { name: `Timeline fit ${Date.now().toString(36)}` } }));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/${company.issuePrefix}/activity/timeline`);
  await expect(page.getByText("Not tracked")).toBeVisible();

  const value = page.getByText("Not tracked");
  expect(await value.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);

  const stats = await page.locator("dl").boundingBox();
  const zoom = await page.locator('[data-canonical-toolbar="timeline-zoom"]').boundingBox();
  expect(zoom!.y).toBeGreaterThanOrEqual(stats!.y + stats!.height - 2);

  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByText("Not tracked")).toBeVisible();
  const wideStats = await page.locator("dl").boundingBox();
  const wideZoom = await page.locator('[data-canonical-toolbar="timeline-zoom"]').boundingBox();
  expect(wideZoom!.y).toBeLessThan(wideStats!.y + wideStats!.height);
});
