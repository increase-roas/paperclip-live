import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";

async function json(response: APIResponse) {
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

async function seedInbox(request: APIRequestContext) {
  const company = await json(
    await request.post("/api/companies", { data: { name: `Inbox read errors ${Date.now().toString(36)}` } }),
  );
  await json(
    await request.post(`/api/companies/${company.id}/issues`, {
      data: {
        title: "Unread inbox task",
        description: "Created for the inbox read-error check.",
        status: "todo",
        priority: "medium",
        assigneeUserId: "local-board",
      },
    }),
  );
  return company;
}

test("a failed mark-all-read explains the failure and can be dismissed", async ({ page, request }) => {
  test.setTimeout(90_000);
  const company = await seedInbox(request);

  await page.route("**/api/companies/*/inbox/mine*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.issues = (body.issues ?? []).map((issue: Record<string, unknown>) => ({
      ...issue,
      isUnreadForMe: true,
    }));
    await route.fulfill({ response, body: JSON.stringify(body) });
  });

  await page.route("**/api/issues/*/read", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "read unavailable" }),
    });
  });

  await page.goto(`/${company.issuePrefix}/inbox/mine`);
  await expect(page.getByRole("link", { name: /Unread inbox task/ })).toBeVisible();

  await page.getByRole("button", { name: "Mark all as read" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Mark all as read?")).toBeVisible();
  await dialog.getByRole("button", { name: "Mark all as read" }).click();

  const alert = page.getByRole("alert").filter({ hasText: "Couldn't mark all items read" });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("read unavailable");

  await alert.getByRole("button", { name: "Dismiss" }).click();
  await expect(alert).toHaveCount(0);
});
