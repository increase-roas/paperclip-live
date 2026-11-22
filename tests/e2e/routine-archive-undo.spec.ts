import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";

async function json(response: APIResponse) {
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

async function seedRoutine(request: APIRequestContext) {
  const company = await json(
    await request.post("/api/companies", { data: { name: `Routine archive ${Date.now().toString(36)}` } }),
  );
  const agent = await json(
    await request.post(`/api/companies/${company.id}/agents`, {
      data: {
        name: "Routine archive agent",
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
        title: "Morning sync",
        description: "Review the queue every Monday.",
        assigneeAgentId: agent.id,
      },
    }),
  );
  return { company, routine };
}

test("archiving a routine from its row offers Undo and restores it", async ({ page, request }) => {
  test.setTimeout(90_000);
  const { company } = await seedRoutine(request);

  await page.goto(`/${company.issuePrefix}/routines`);
  await expect(page.getByText("Morning sync")).toBeVisible();

  await page.getByRole("button", { name: "More actions for Morning sync" }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();

  const toast = page.getByText("Routine archived");
  await expect(toast).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Morning sync")).toBeVisible();
});
