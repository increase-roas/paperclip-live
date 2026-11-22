import { createRequire } from "node:module";
import path from "node:path";
import { expect, test, type APIRequestContext, type APIResponse, type Page } from "@playwright/test";

/**
 * Two gaps from the page audit:
 * - the Bots registration example is a horizontally scrollable block that must
 *   be reachable and scrollable from the keyboard;
 * - Approval Detail started at level two, and the approvals list jumped from
 *   the page title to level three.
 */

const axePath = createRequire(path.join(import.meta.dirname, "../../packages/paperclip-runner/package.json")).resolve("axe-core");

type AxeResult = {
  violations: Array<{ id: string; nodes: Array<{ target: unknown[]; failureSummary?: string }> }>;
};

async function json(response: APIResponse) {
  const text = await response.text();
  expect(response.ok(), `${response.url()}: ${response.status()} ${text}`).toBe(true);
  return JSON.parse(text);
}

async function axeViolations(page: Page, rules: string[]) {
  const hasAxe = await page.evaluate(() => Boolean((window as unknown as { axe?: unknown }).axe));
  if (!hasAxe) await page.addScriptTag({ path: axePath });
  return page.evaluate(async (values) => {
    const axe = (window as unknown as {
      axe: { run: (context: Document, options: unknown) => Promise<AxeResult> };
    }).axe;
    const result = await axe.run(document, { runOnly: { type: "rule", values } });
    return result.violations.map((violation) => ({
      id: violation.id,
      nodes: violation.nodes.map((node) => ({
        target: node.target.map((target) => String(target)),
        summary: node.failureSummary ?? "",
      })),
    }));
  }, rules);
}

async function seedApproval(request: APIRequestContext) {
  const company = await json(await request.post("/api/companies", { data: { name: `Approval a11y ${Date.now().toString(36)}` } }));
  const agent = await json(
    await request.post(`/api/companies/${company.id}/agents`, {
      data: {
        name: "Approval Agent",
        role: "engineer",
        adapterType: "process",
        adapterConfig: { command: "/usr/bin/true" },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
      },
    }),
  );
  await request.post(`/api/agents/${agent.id}/pause`);
  const issue = await json(
    await request.post(`/api/companies/${company.id}/issues`, {
      data: { title: "Approval a11y task", status: "todo", assigneeAgentId: agent.id },
    }),
  );
  const approval = await json(
    await request.post(`/api/companies/${company.id}/approvals`, {
      data: {
        type: "request_board_approval",
        payload: { title: "Approve the a11y plan", summary: "A short summary." },
        issueIds: [issue.id],
      },
    }),
  );
  return { company, approval };
}

test.describe("bots and approvals accessibility", () => {
  test("the bot metadata example scrolls from the keyboard", async ({ page, request }) => {
    test.setTimeout(120_000);
    const company = await json(await request.post("/api/companies", { data: { name: "Increase Roas" } }));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/${company.issuePrefix}/bots/catalog:funnel-builder`);

    const example = page.getByLabel("Bot metadata example");
    await expect(example).toBeVisible({ timeout: 30_000 });
    const metrics = await example.evaluate((node) => ({
      tabIndex: (node as HTMLElement).tabIndex,
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
    }));
    expect(metrics.tabIndex, "the scroll region joins the tab order").toBe(0);
    expect(metrics.scrollWidth, "the example overflows on a phone").toBeGreaterThan(metrics.clientWidth);

    await example.focus();
    await expect(example).toBeFocused();
    for (let index = 0; index < 6; index += 1) await page.keyboard.press("ArrowRight");
    expect(await example.evaluate((node) => node.scrollLeft), "arrow keys scroll the example").toBeGreaterThan(0);
  });

  test("approval detail starts at level one and the list keeps heading order", async ({ page, request }) => {
    test.setTimeout(120_000);
    const { company, approval } = await seedApproval(request);
    await page.setViewportSize({ width: 1280, height: 900 });

    await page.goto(`/${company.issuePrefix}/approvals/${approval.id}`);
    await expect(
      page.getByRole("heading", { level: 1, name: "Board Approval: Approve the a11y plan" }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("heading", { level: 2, name: /^Comments/ })).toBeVisible();
    expect(await axeViolations(page, ["page-has-heading-one", "heading-order"]), "approval detail headings").toEqual([]);

    await page.goto(`/${company.issuePrefix}/approvals/pending`);
    await expect(page.getByRole("heading", { level: 2, name: "Approve the a11y plan" })).toBeVisible({
      timeout: 30_000,
    });
    expect(await axeViolations(page, ["heading-order"]), "approvals list headings").toEqual([]);
  });
});
