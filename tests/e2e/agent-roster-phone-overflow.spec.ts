import { expect, test, type APIRequestContext, type APIResponse, type Page } from "@playwright/test";

async function json(response: APIResponse) {
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

async function createRosterCompany(request: APIRequestContext) {
  const company = await json(
    await request.post("/api/companies", { data: { name: `Roster phone ${Date.now()}` } }),
  );
  for (const spec of [
    { name: "Ada Controller", role: "ceo" },
    { name: "Robotics Integration And Fleet Operations Specialist With A Long Name", role: "engineer" },
  ]) {
    const agent = await json(
      await request.post(`/api/companies/${company.id}/agents`, {
        data: {
          ...spec,
          adapterType: "process",
          adapterConfig: { command: "/usr/bin/true" },
          runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
        },
      }),
    );
    await request.post(`/api/agents/${agent.id}/pause`);
  }
  return company;
}

async function expectNoDocumentOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "the agent roster should not widen the page").toBeLessThanOrEqual(1);
}

for (const viewport of [
  { label: "phone", width: 390, height: 844 },
  { label: "desktop", width: 1280, height: 800 },
]) {
  test(`the agent roster keeps a long name and the Chat column inside the page (${viewport.label})`, async ({ page, request }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const company = await createRosterCompany(request);

    await page.goto(`/${company.issuePrefix}/agents/all`);
    await expect(page.getByRole("table", { name: "Agent roster" })).toBeVisible();
    await expect(page.getByText("Robotics Integration And Fleet Operations Specialist With A Long Name")).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Chat" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Default model" })).toBeAttached();
    await expectNoDocumentOverflow(page);

    // The roster still scrolls inside its own frame, so the metadata columns
    // stay reachable without moving the page shell.
    const roster = page.getByRole("table", { name: "Agent roster" });
    const scroll = await roster.evaluate((table) => {
      const frame = table.parentElement!;
      return { frameOverflow: getComputedStyle(frame).overflowX, scrollable: frame.scrollWidth > frame.clientWidth };
    });
    expect(scroll.frameOverflow).toBe("auto");
    if (viewport.width < 600) expect(scroll.scrollable).toBe(true);
  });
}
