import { expect, test, type APIRequestContext, type APIResponse, type Page } from "@playwright/test";

const LONG_NAME = "Robotics Integration And Fleet Operations Specialist With A Long Name";

async function json(response: APIResponse) {
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

async function createAgent(request: APIRequestContext) {
  const company = await json(
    await request.post("/api/companies", { data: { name: `Header phone ${Date.now()}` } }),
  );
  const agent = await json(
    await request.post(`/api/companies/${company.id}/agents`, {
      data: {
        name: LONG_NAME,
        role: "engineer",
        adapterType: "process",
        adapterConfig: { command: "/usr/bin/true" },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
      },
    }),
  );
  await request.post(`/api/agents/${agent.id}/pause`);
  return { company, agent };
}

async function expectNoDocumentOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "the agent header should not widen the page").toBeLessThanOrEqual(1);
}

for (const viewport of [
  { label: "phone", width: 390, height: 844 },
  { label: "desktop", width: 1280, height: 800 },
]) {
  test(`the agent header keeps its title and name readable (${viewport.label})`, async ({ page, request }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const { company, agent } = await createAgent(request);
    const agentRef = agent.urlKey ?? agent.id;

    await page.goto(`/${company.issuePrefix}/agents/${agentRef}/overview`);
    const header = page.locator("header.agent-character-header");
    await expect(header).toBeVisible();
    await expect(header.getByText(LONG_NAME, { exact: true })).toBeVisible();

    // The identity block must keep enough width for the title and the
    // "harness • name" line. Before the fix the action buttons held the row
    // and the title collapsed to a few pixels of ellipsis.
    const title = header.getByRole("heading", { level: 1 });
    const box = await title.boundingBox();
    expect(box, "the agent title should render").not.toBeNull();
    expect(Math.round(box!.width), "the agent title should not collapse").toBeGreaterThanOrEqual(48);
    if (viewport.width < 600) {
      const nameLine = await header.getByText(LONG_NAME, { exact: true }).boundingBox();
      expect(Math.round(nameLine!.width)).toBeGreaterThanOrEqual(80);
    }
    await expectNoDocumentOverflow(page);
  });
}
