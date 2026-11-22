import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";

/**
 * Loading placeholders must tell assistive technology that a page is pending.
 * Inline request errors must say what failed instead of repeating a terse
 * server message on its own.
 */

async function json(response: APIResponse) {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function seed(request: APIRequestContext) {
  const company = await json(await request.post("/api/companies", { data: { name: `States ${Date.now().toString(36)}` } }));
  const agent = await json(await request.post(`/api/companies/${company.id}/agents`, {
    data: {
      name: "States Agent",
      role: "engineer",
      adapterType: "process",
      adapterConfig: { command: "/usr/bin/true" },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
    },
  }));
  await request.post(`/api/agents/${agent.id}/pause`);
  const issue = await json(await request.post(`/api/companies/${company.id}/issues`, {
    data: { title: "States task", status: "todo", assigneeAgentId: agent.id },
  }));
  await json(await request.post(`/api/companies/${company.id}/approvals`, {
    data: {
      type: "request_board_approval",
      payload: { title: "States approval", summary: "Pending." },
      issueIds: [issue.id],
    },
  }));
  return { company, issue };
}

test("an approvals skeleton announces that the page is loading", async ({ page, request }) => {
  const { company } = await seed(request);
  // Hold the approvals request open so the skeleton stays mounted.
  await page.route("**/api/companies/*/approvals**", () => undefined);
  await page.goto(`/${company.issuePrefix}/approvals/pending`, { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("status", { name: "Loading approvals" })).toBeVisible({ timeout: 30_000 });
});

test("a failed task list keeps its action context and retry", async ({ page, request }) => {
  const { company } = await seed(request);
  await page.route("**/api/companies/*/issues?**", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "boom", message: "Upstream failed" }),
    }),
  );
  await page.goto(`/${company.issuePrefix}/issues`, { waitUntil: "domcontentloaded" });

  const alert = page.getByRole("alert").first();
  await expect(alert).toBeVisible({ timeout: 30_000 });
  await expect(alert).toContainText(/Couldn.t load tasks/);
  await expect(alert).toContainText("Upstream failed");
  await expect(alert.getByRole("button", { name: "Retry" })).toBeVisible();
});
