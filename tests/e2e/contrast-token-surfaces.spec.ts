import { createRequire } from "node:module";
import path from "node:path";
import { expect, test, type APIRequestContext, type APIResponse, type Locator, type Page } from "@playwright/test";

/**
 * Remaining contrast findings from the a11y sweep:
 * - the 10px "Recents"/"Operate" sidebar labels,
 * - the neutral `.bg-muted` status badge,
 * - the routine "Active" label,
 * - the paused-agent banner body,
 * - the "No project" placeholder.
 *
 * Each assertion runs axe's color-contrast rule scoped to the element that
 * regressed, so an unrelated page-level finding cannot mask or duplicate this
 * coverage. The shared avatar fallback is fixed by the contrast-tokens PR that
 * precedes this one in the merge train.
 */

const axePath = createRequire(path.join(import.meta.dirname, "../../packages/paperclip-runner/package.json")).resolve("axe-core");

type AxeResult = {
  violations: Array<{ nodes: Array<{ target: unknown[]; failureSummary?: string }> }>;
};

async function ensureAxe(page: Page) {
  // A reload replaces the page context and drops the injected global.
  const hasAxe = await page.evaluate(() => Boolean((window as unknown as { axe?: unknown }).axe));
  if (!hasAxe) await page.addScriptTag({ path: axePath });
}

async function expectNoContrastViolations(page: Page, locator: Locator, label: string) {
  await expect(locator, `${label} should be visible`).toBeVisible();
  await ensureAxe(page);
  const handle = await locator.elementHandle();
  expect(handle, `${label} should have an element handle`).not.toBeNull();
  const violations = await page.evaluate(async (element) => {
    const axe = (window as unknown as { axe: { run: (node: Element, options: unknown) => Promise<AxeResult> } }).axe;
    const result = await axe.run(element, { runOnly: { type: "rule", values: ["color-contrast"] } });
    return result.violations.flatMap((violation) =>
      violation.nodes.map((node) => ({
        target: node.target.map((target) => String(target)),
        summary: node.failureSummary ?? "",
      })),
    );
  }, handle!);
  await handle!.dispose();
  expect(violations, `${label} must not fail color-contrast`).toEqual([]);
}

async function json(response: APIResponse) {
  const text = await response.text();
  expect(response.ok(), `${response.url()}: ${response.status()} ${text}`).toBe(true);
  return JSON.parse(text);
}

async function seed(request: APIRequestContext) {
  const company = await json(await request.post("/api/companies", { data: { name: `Contrast ${Date.now().toString(36)}` } }));
  const agent = await json(
    await request.post(`/api/companies/${company.id}/agents`, {
      data: {
        name: "Contrast Agent",
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
      data: {
        title: "Contrast task",
        description: "Exercise the remaining contrast findings.",
        status: "todo",
        assigneeAgentId: agent.id,
      },
    }),
  );
  const approval = await json(
    await request.post(`/api/companies/${company.id}/approvals`, {
      data: {
        type: "request_board_approval",
        payload: { title: "Approve the axe plan", summary: "A short summary." },
        issueIds: [issue.id],
      },
    }),
  );
  const routine = await json(
    await request.post(`/api/companies/${company.id}/routines`, {
      data: { title: "Contrast routine", description: "Routine contrast check.", assigneeAgentId: agent.id },
    }),
  );
  return { company, agent, issue, approval, routine };
}

test.describe("remaining contrast findings", () => {
  test("task detail labels and banners clear AA", async ({ page, request }) => {
    test.setTimeout(120_000);
    const { company, issue } = await seed(request);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/${company.issuePrefix}/issues/${issue.identifier}`);
    await expect(page.getByTestId("task-chat-composer-dock")).toBeVisible({ timeout: 30_000 });

    await expectNoContrastViolations(
      page,
      page.getByText("Recents", { exact: true }).first(),
      "sidebar Recents label",
    );
    await expectNoContrastViolations(
      page,
      page.getByText("No project", { exact: true }).first(),
      "task No project placeholder",
    );
    await expectNoContrastViolations(
      page,
      page.getByTestId("issue-assignee-paused-notice").getByText(/New runs will not start/),
      "paused-agent banner body",
    );
  });

  test("approvals page keeps its sidebar label and card readable", async ({ page, request }) => {
    test.setTimeout(120_000);
    const { company } = await seed(request);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/${company.issuePrefix}/approvals/pending`);
    await expect(page.getByText("Approve the axe plan", { exact: true })).toBeVisible({ timeout: 30_000 });

    await expectNoContrastViolations(page, page.locator("#main-content"), "approvals main content");
    await expectNoContrastViolations(
      page,
      page.locator('[data-slot="card"]').filter({ hasText: "Approve the axe plan" }).first(),
      "approval card",
    );
  });

  test("routines list keeps the page readable", async ({ page, request }) => {
    test.setTimeout(120_000);
    const { company, routine } = await seed(request);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/${company.issuePrefix}/routines`);
    await expect(page.getByText(routine.title, { exact: true }).first()).toBeVisible({ timeout: 30_000 });

    await expectNoContrastViolations(page, page.locator("#main-content"), "routines main content");
  });

  test("routine detail labels, active state and neutral badge clear AA in both themes", async ({ page, request }) => {
    test.setTimeout(120_000);
    const { company, routine } = await seed(request);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/${company.issuePrefix}/routines/${routine.id}`);
    await expect(page.getByRole("heading", { level: 1, name: routine.title })).toBeVisible({ timeout: 30_000 });

    await expectNoContrastViolations(page, page.locator("#main-content"), "routine detail main content");
    await expectNoContrastViolations(
      page,
      page.getByText("Operate", { exact: true }),
      "routine detail Operate label",
    );
    await expectNoContrastViolations(page, page.getByText("Active", { exact: true }).first(), "routine Active label");

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await expectNoContrastViolations(page, page.getByText("Operate", { exact: true }), "dark routine Operate label");
    await expectNoContrastViolations(
      page,
      page.getByText("Active", { exact: true }).first(),
      "dark routine Active label",
    );
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    await request.patch(`/api/routines/${routine.id}`, { data: { status: "archived" } });
    await page.reload();
    await expect(page.getByText("archived", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    await expectNoContrastViolations(
      page,
      page.getByText("archived", { exact: true }).first(),
      "neutral archived status badge",
    );
  });
});
