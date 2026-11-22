import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";

async function json(response: APIResponse) {
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

async function seedTask(request: APIRequestContext) {
  const company = await json(
    await request.post("/api/companies", { data: { name: `Hide task ${Date.now().toString(36)}` } }),
  );
  const agent = await json(
    await request.post(`/api/companies/${company.id}/agents`, {
      data: {
        name: "Hide task agent",
        role: "engineer",
        adapterType: "process",
        adapterConfig: { command: "/usr/bin/true" },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
      },
    }),
  );
  await request.post(`/api/agents/${agent.id}/pause`);
  const task = await json(
    await request.post(`/api/companies/${company.id}/issues`, {
      data: { title: "Hide this task fixture", status: "todo", assigneeAgentId: agent.id },
    }),
  );
  return { company, task };
}

test("hiding a task offers Undo and restores it", async ({ page, request }) => {
  test.setTimeout(90_000);
  const { company, task } = await seedTask(request);

  await page.goto(`/${company.issuePrefix}/issues/${task.identifier}`);
  await page.getByRole("button", { name: "More task actions" }).click();
  await page.getByRole("button", { name: "Hide this task" }).click();

  await expect(page).toHaveURL(/\/issues\/all/);
  await expect(page.getByText("Task hidden")).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();

  await expect.poll(async () => (await json(await request.get(`/api/issues/${task.id}`))).hiddenAt).toBeNull();
});
