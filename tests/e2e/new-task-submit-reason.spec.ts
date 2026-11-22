import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";

async function json(response: APIResponse) {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function seed(request: APIRequestContext) {
  const company = await json(await request.post("/api/companies", { data: { name: `Submit reason ${Date.now().toString(36)}` } }));
  const agent = await json(await request.post(`/api/companies/${company.id}/agents`, {
    data: {
      name: "Submit Agent",
      role: "engineer",
      adapterType: "process",
      adapterConfig: { command: "/usr/bin/true" },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
    },
  }));
  await request.post(`/api/agents/${agent.id}/pause`);
  return company;
}

/**
 * The New Task create button starts disabled. Its tooltip used to name only the
 * keyboard shortcut, so neither pointer nor assistive-technology users knew
 * what was missing. The button now names the missing description.
 */
test("the New Task create button explains why it is disabled", async ({ page, request }) => {
  test.setTimeout(120_000);
  const company = await seed(request);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/${company.issuePrefix}/dashboard`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await page.getByRole("button", { name: /new task/i }).first().click();

  const dialog = page.getByRole("dialog").filter({ has: page.getByTestId("task-chat-composer-input") });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  const create = dialog.getByRole("button", { name: "Create task", exact: true });
  await expect(create).toBeDisabled();
  await expect(create).toHaveAttribute("title", "Add a task description to create the task.");
  const describedBy = await create.getAttribute("aria-describedby");
  expect(describedBy, "the disabled button has an accessible description").toBeTruthy();
  await expect(page.locator(`[id="${describedBy}"]`)).toHaveText("Add a task description to create the task.");

  // Typing a description clears the reason and restores the shortcut hint.
  await dialog.getByTestId("task-chat-composer-input").click();
  await page.keyboard.type("Submit reason probe");
  await expect(create).toBeEnabled();
  await expect(create).toHaveAttribute("title", "Create task (Enter)");
});
