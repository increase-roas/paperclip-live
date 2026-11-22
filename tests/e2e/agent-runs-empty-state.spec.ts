import { expect, test } from "@playwright/test";

test("an agent with no runs points to the next step without a filter or a limit notice", async ({ page, request }) => {
  test.setTimeout(90_000);
  const company = await (await request.post("/api/companies", { data: { name: `Runs empty ${Date.now()}` } })).json();
  const agent = await (await request.post(`/api/companies/${company.id}/agents`, {
    data: {
      name: "Quiet Agent",
      role: "engineer",
      adapterType: "process",
      adapterConfig: { command: "/usr/bin/true" },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
    },
  })).json();
  await request.post(`/api/agents/${agent.id}/pause`);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/${company.issuePrefix}/agents/${agent.id}/runs`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Runs", exact: true })).toBeVisible();
  await expect(page.getByText("No runs yet.", { exact: true })).toBeVisible();
  await expect(page.getByText("No runs match these filters.", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Showing the 200 most recent runs.", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Clear filters" })).toHaveCount(0);
});
