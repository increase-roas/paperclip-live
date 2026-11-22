import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";

async function json(response: APIResponse) {
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

async function createCompany(request: APIRequestContext, label: string) {
  return json(await request.post("/api/companies", { data: { name: `Deep link ${label} ${Date.now().toString(36)}` } }));
}

async function createAgent(request: APIRequestContext, companyId: string, name: string) {
  const agent = await json(
    await request.post(`/api/companies/${companyId}/agents`, {
      data: {
        name,
        role: "engineer",
        adapterType: "process",
        adapterConfig: { command: "/usr/bin/true" },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
      },
    }),
  );
  await request.post(`/api/agents/${agent.id}/pause`);
  return agent;
}

/** A cold load must render the record. A reload must not drop it. */
async function expectColdLoadAndReload(
  page: import("@playwright/test").Page,
  route: string,
  assertion: () => Promise<void>,
) {
  await page.goto(route, { waitUntil: "domcontentloaded" });
  await assertion();
  await page.reload({ waitUntil: "domcontentloaded" });
  await assertion();
}

test("a task detail page survives a cold deep link and refresh", async ({ page, request }) => {
  const company = await createCompany(request, "task");
  const project = await json(
    await request.post(`/api/companies/${company.id}/projects`, { data: { name: "Deep link project" } }),
  );
  const title = "Cold linked task";
  const issue = await json(
    await request.post(`/api/companies/${company.id}/issues`, {
      data: { title, status: "backlog", projectId: project.id },
    }),
  );

  await expectColdLoadAndReload(page, `/${company.issuePrefix}/issues/${issue.identifier}`, async () => {
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("heading", { name: /Something went wrong|Couldn’t load/i })).toHaveCount(0);
  });
});

test("an agent detail page survives a cold deep link and refresh", async ({ page, request }) => {
  const company = await createCompany(request, "agent");
  const agent = await createAgent(request, company.id, "Cold linked agent");

  await expectColdLoadAndReload(page, `/${company.issuePrefix}/agents/${agent.id}`, async () => {
    await expect(page.getByText("Cold linked agent", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Agent not found", { exact: false })).toHaveCount(0);
  });
});

test("a routine detail page survives a cold deep link and refresh", async ({ page, request }) => {
  const company = await createCompany(request, "routine");
  const agent = await createAgent(request, company.id, "Cold linked routine agent");
  const routine = await json(
    await request.post(`/api/companies/${company.id}/routines`, {
      data: {
        title: "Cold linked routine",
        description: "Load this routine from a cold URL.",
        assigneeAgentId: agent.id,
      },
    }),
  );

  await expectColdLoadAndReload(page, `/${company.issuePrefix}/routines/${routine.id}`, async () => {
    await expect(page.getByRole("heading", { level: 1, name: "Cold linked routine" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Routine not found", { exact: false })).toHaveCount(0);
  });
});

test("a project detail page survives a cold deep link and refresh", async ({ page, request }) => {
  const company = await createCompany(request, "project");
  const project = await json(
    await request.post(`/api/companies/${company.id}/projects`, { data: { name: "Cold linked project" } }),
  );

  await expectColdLoadAndReload(page, `/${company.issuePrefix}/projects/${project.id}`, async () => {
    await expect(page.getByRole("heading", { name: "Cold linked project" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Project not found", { exact: false })).toHaveCount(0);
  });
});

test("a bot page survives a cold deep link and refresh", async ({ page, request }) => {
  const company = await createCompany(request, "bot");
  const agent = await json(
    await request.post(`/api/companies/${company.id}/agents`, {
      data: {
        name: "Cold linked bot",
        role: "engineer",
        adapterType: "process",
        adapterConfig: { command: "/usr/bin/true" },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
        metadata: {
          agentKind: "bot",
          bot: {
            purpose: "Cold link bot purpose.",
            gateway: { keyId: "gk_live_cold", policy: "cold-link", provider: "test-gateway" },
          },
        },
      },
    }),
  );
  await request.post(`/api/agents/${agent.id}/pause`);

  await expectColdLoadAndReload(page, `/${company.issuePrefix}/bots/${agent.id}`, async () => {
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Cold linked bot", { timeout: 30_000 });
    await expect(page.getByText("Bot not found", { exact: true })).toHaveCount(0);
  });
});

test("the bot roster shows an agent rename without a manual reload", async ({ page, request }) => {
  test.setTimeout(90_000);
  const company = await createCompany(request, "rename");
  const agent = await json(
    await request.post(`/api/companies/${company.id}/agents`, {
      data: {
        name: "Old bot name",
        role: "engineer",
        adapterType: "process",
        adapterConfig: { command: "/usr/bin/true" },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
        metadata: { agentKind: "bot", bot: { purpose: "Rename this bot." } },
      },
    }),
  );
  await request.post(`/api/agents/${agent.id}/pause`);

  // Cache the roster first, so a stale cached read is what the assertion sees.
  await page.goto(`/${company.issuePrefix}/bots`);
  await expect(page.locator('a[href*="/bots/"]').filter({ hasText: "Old bot name" })).toBeVisible();

  await page.locator('a[href*="/bots/"]').filter({ hasText: "Old bot name" }).click();
  await expect(page.getByRole("heading", { level: 1 }).first()).toContainText("Old bot name");
  await page.getByRole("link", { name: "Open agent" }).click();
  await expect(page.locator("main").getByText("Old bot name", { exact: true }).first()).toBeVisible();

  await page.locator("main").getByText("Old bot name", { exact: true }).first().click();
  const nameField = page.getByRole("textbox", { name: "Agent name" });
  await nameField.fill("New bot name");
  await nameField.press("Enter");
  await expect(page.getByRole("textbox", { name: "Agent name" })).toHaveCount(0);

  // Back navigation stays in the single-page app, so the cached roster is reused.
  await page.goBack();
  await page.goBack();
  await expect(page.locator('a[href*="/bots/"]').filter({ hasText: "New bot name" })).toBeVisible();
  await expect(page.locator('a[href*="/bots/"]').filter({ hasText: "Old bot name" })).toHaveCount(0);
});
