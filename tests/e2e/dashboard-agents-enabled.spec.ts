import { randomUUID } from "node:crypto";
import { expect, test, type APIResponse } from "@playwright/test";

async function json<T = Record<string, any>>(response: APIResponse): Promise<T> {
  expect(response.ok(), `${response.status()}: ${await response.text()}`).toBe(true);
  return response.json();
}

const COMPANY_NAME = `Dashboard enabled agents ${randomUUID()}`;

test.describe("Dashboard Agents Enabled", () => {
  let companyId: string;
  let prefix: string;
  let agentId: string;

  test.beforeAll(async ({ request }) => {
    const company = await json(await request.post("/api/companies", {
      data: { name: COMPANY_NAME },
    }));
    companyId = company.id;
    prefix = company.issuePrefix ?? company.prefix ?? company.urlKey ?? "E2E";
    const agent = await json(await request.post(`/api/companies/${companyId}/agents`, {
      data: {
        name: "Paused dashboard agent",
        role: "engineer",
        adapterType: "process",
        adapterConfig: { command: "/usr/bin/false" },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
      },
    }));
    agentId = agent.id;
    await json(await request.post(`/api/agents/${agentId}/pause`));
  });

  test.afterAll(async ({ request }) => {
    await request.patch(`/api/companies/${companyId}`, { data: { status: "archived" } }).catch(() => {});
  });

  test("excludes paused agents from the headline and agrees with the all-paused banner", async ({ page, request }) => {
    page.setDefaultTimeout(15_000);
    const metric = page.getByRole("link").filter({ hasText: "Agents Enabled" });
    const banner = page.getByText(/all agents in this organization are paused/i);

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/${prefix}/dashboard`);
    await expect(banner).toBeVisible();
    await expect(metric.locator("p").first()).toHaveText("0");
    await expect(metric).toContainText("1 paused");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(banner).toBeVisible();
    await expect(metric.locator("p").first()).toHaveText("0");

    await json(await request.post(`/api/agents/${agentId}/resume`));
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.reload();
    await expect(banner).toHaveCount(0);
    await expect(metric.locator("p").first()).toHaveText("1");
  });
});
