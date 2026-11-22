import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";

async function json(response: APIResponse) {
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

async function seedRoutine(request: APIRequestContext) {
  const company = await json(
    await request.post("/api/companies", { data: { name: `Routine layout ${Date.now().toString(36)}` } }),
  );
  const agent = await json(
    await request.post(`/api/companies/${company.id}/agents`, {
      data: {
        name: "Routine layout agent",
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

for (const viewport of [
  { label: "mobile", width: 390, height: 844 },
  { label: "desktop", width: 1280, height: 800 },
]) {
  test(`a routine detail page shows its sections and actions (${viewport.label})`, async ({ page, request }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const { company, routine } = await seedRoutine(request);

    await page.goto(`/${company.issuePrefix}/routines/${routine.id}`);
    await expect(page.getByRole("heading", { level: 1, name: "Weekly posting review" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Overview" })).toBeVisible();
    await expect(page.getByText("Review the queue every Monday.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit routine" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Run now/ })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Recent runs" })).toBeVisible();

    const layout = await page.evaluate(() => {
      const main = document.querySelector("#main-content");
      const section = document.querySelector("#routine-section");
      const heading = document.querySelector("h1");
      return {
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        mainHeight: main?.getBoundingClientRect().height ?? 0,
        sectionHeight: section?.getBoundingClientRect().height ?? 0,
        headingTop: heading?.getBoundingClientRect().top ?? 0,
        scrollHeight: document.documentElement.scrollHeight,
      };
    });
    expect(layout.overflow, "the page should not scroll horizontally").toBeLessThanOrEqual(1);
    expect(layout.headingTop, "the title should not be clipped above the fold").toBeLessThan(viewport.height);
    expect(layout.sectionHeight, "the section content should occupy real space").toBeGreaterThan(400);
    if (viewport.label === "mobile") {
      expect(layout.mainHeight, "mobile content should grow with the page").toBeGreaterThan(800);
      expect(layout.scrollHeight, "mobile content should scroll in the page").toBeGreaterThan(viewport.height);
    }
  });
}
