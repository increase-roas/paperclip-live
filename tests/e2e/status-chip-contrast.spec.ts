import { createRequire } from "node:module";
import path from "node:path";
import { expect, test, type APIRequestContext, type APIResponse, type Locator, type Page } from "@playwright/test";

/**
 * Light-mode status chips mixed their hue at 82% with black, which left the
 * gray, amber and green labels near 2.8-3.0:1 on the tinted fill. The Agents
 * roster and task detail both render these chips.
 */

const axePath = createRequire(path.join(import.meta.dirname, "../../packages/paperclip-runner/package.json")).resolve("axe-core");

type AxeResult = {
  violations: Array<{ nodes: Array<{ target: unknown[]; failureSummary?: string }> }>;
};

async function json(response: APIResponse) {
  const text = await response.text();
  expect(response.ok(), `${response.url()}: ${response.status()} ${text}`).toBe(true);
  return JSON.parse(text);
}

async function expectNoContrast(page: Page, locator: Locator, label: string) {
  await expect(locator, `${label} should be visible`).toBeVisible();
  await page.addScriptTag({ path: axePath });
  const handle = await locator.elementHandle();
  expect(handle).not.toBeNull();
  const violations = await page.evaluate(async (element) => {
    const axe = (window as unknown as {
      axe: { run: (node: Element, options: unknown) => Promise<AxeResult> };
    }).axe;
    const result = await axe.run(element, { runOnly: { type: "rule", values: ["color-contrast"] } });
    return result.violations.flatMap((violation) =>
      violation.nodes.map((node) => ({ target: node.target.map((target) => String(target)), summary: node.failureSummary ?? "" })),
    );
  }, handle!);
  await handle!.dispose();
  expect(violations, `${label} must not fail color-contrast`).toEqual([]);
}

async function seed(request: APIRequestContext) {
  const company = await json(await request.post("/api/companies", { data: { name: `Chip contrast ${Date.now().toString(36)}` } }));
  const agent = await json(
    await request.post(`/api/companies/${company.id}/agents`, {
      data: {
        name: "Chip Agent",
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

test.describe("status chip contrast", () => {
  test("the paused agent chip clears AA on a phone roster", async ({ page, request }) => {
    test.setTimeout(120_000);
    const { company } = await seed(request);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/${company.issuePrefix}/agents/all`);
    const chip = page.locator(".status-chip").filter({ hasText: /^paused$/ }).first();
    await expectNoContrast(page, chip, "paused agent chip");
  });
});
