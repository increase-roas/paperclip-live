import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";

async function json(response: APIResponse) {
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

async function seedRoutine(request: APIRequestContext) {
  const company = await json(
    await request.post("/api/companies", { data: { name: `Routine runs ${Date.now().toString(36)}` } }),
  );
  const agent = await json(
    await request.post(`/api/companies/${company.id}/agents`, {
      data: {
        name: "Routine runs agent",
        role: "engineer",
        adapterType: "process",
        adapterConfig: { command: "/usr/bin/true" },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
      },
    }),
  );
  await request.post(`/api/agents/${agent.id}/pause`);
  const routine = await json(
    await request.post(`/api/companies/${company.id}/routines`, {
      data: {
        title: "Weekly posting review",
        description: "Review the queue every Monday.",
        assigneeAgentId: agent.id,
      },
    }),
  );
  return { company, routine };
}

test("a routine with no runs offers the run action instead of the task create action", async ({ page, request }) => {
  test.setTimeout(90_000);
  const { company, routine } = await seedRoutine(request);

  await page.goto(`/${company.issuePrefix}/routines/${routine.id}/runs`);

  await expect(page.getByText("No runs yet")).toBeVisible();
  await expect(page.getByText("Run the routine now, or wait for its schedule.")).toBeVisible();
  await expect(page.getByText("No tasks yet")).toHaveCount(0);
  await expect(page.getByText("Create a task to start work.")).toHaveCount(0);

  await page.getByRole("button", { name: "Run routine" }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Run routine" })).toBeVisible();
});
