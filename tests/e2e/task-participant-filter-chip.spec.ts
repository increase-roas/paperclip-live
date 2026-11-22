import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";

async function json(response: APIResponse) {
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

async function seedParticipantTask(request: APIRequestContext) {
  const company = await json(
    await request.post("/api/companies", { data: { name: `Participant filter ${Date.now().toString(36)}` } }),
  );
  const agent = await json(
    await request.post(`/api/companies/${company.id}/agents`, {
      data: {
        name: "Nova Participant",
        role: "engineer",
        adapterType: "process",
        adapterConfig: { command: "/usr/bin/true" },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
      },
    }),
  );
  await request.post(`/api/agents/${agent.id}/pause`);
  await json(
    await request.post(`/api/companies/${company.id}/issues`, {
      data: { title: "Participant filter task", status: "todo", assigneeAgentId: agent.id },
    }),
  );
  return { company, agent };
}

test("an agent task link shows its participant filter as a removable chip", async ({ page, request }) => {
  test.setTimeout(90_000);
  const { company, agent } = await seedParticipantTask(request);

  await page.goto(`/${company.issuePrefix}/issues?participantAgentId=${agent.id}`);

  const chip = page.getByTestId("task-participant-filter");
  await expect(chip).toContainText(`Participant: ${agent.name}`);

  await chip.getByRole("button", { name: `Remove filter Participant: ${agent.name}` }).click();

  await expect(chip).toHaveCount(0);
  await expect(page).not.toHaveURL(/participantAgentId/);
});
