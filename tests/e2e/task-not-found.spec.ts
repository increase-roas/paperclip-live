import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";

async function json(response: APIResponse) {
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

async function seedCompany(request: APIRequestContext) {
  return json(
    await request.post("/api/companies", {
      data: { name: `Missing task ${Date.now().toString(36)}` },
    }),
  );
}

test("a missing task names the id and links back to the task list", async ({ page, request }) => {
  test.setTimeout(90_000);
  const company = await seedCompany(request);

  await page.goto(`/${company.issuePrefix}/issues/DOES-NOT-EXIST`);

  await expect(page.getByText("Task not found")).toBeVisible();
  await expect(page.getByText("DOES-NOT-EXIST")).toBeVisible();
  const back = page.getByRole("button", { name: "Back to tasks" });
  await expect(back).toBeVisible();

  await back.click();
  await expect(page).toHaveURL(new RegExp(`/${company.issuePrefix}/issues(/\\?.*)?$`));
  await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
});
