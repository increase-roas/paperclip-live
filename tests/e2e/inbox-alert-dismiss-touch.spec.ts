import { expect, test, type APIResponse } from "@playwright/test";

async function json(response: APIResponse) {
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

test("inbox alert dismiss buttons are visible and touch-sized on a phone", async ({ page, request }) => {
  test.setTimeout(90_000);
  const company = await json(
    await request.post("/api/companies", { data: { name: `Inbox alerts ${Date.now().toString(36)}` } }),
  );

  await page.route(`**/api/companies/${company.id}/dashboard`, (route) => route.fulfill({
    json: {
      companyId: company.id,
      agents: { active: 1, running: 0, paused: 0, error: 2 },
      tasks: { open: 0, inProgress: 0, blocked: 0, done: 0 },
      costs: { monthSpendCents: 9_200, monthBudgetCents: 10_000, monthUtilizationPercent: 92 },
      pendingApprovals: 0,
      budgets: { activeIncidents: 0, pendingApprovals: 0, pausedAgents: 0 },
    },
  }));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/${company.issuePrefix}/inbox/all`);

  await expect(page.getByText("Alerts")).toBeVisible();
  const dismissButtons = page.getByRole("button", { name: "Dismiss" });
  await expect(dismissButtons).toHaveCount(2);

  for (const button of await dismissButtons.all()) {
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(await button.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
  }
});
