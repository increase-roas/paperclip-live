import { createRequire } from "node:module";
import path from "node:path";
import { expect, test, type APIRequestContext, type APIResponse, type Page } from "@playwright/test";

/**
 * The three Agent permissions switches are icon-only buttons. They had no
 * accessible name, so a screen-reader user heard only "switch".
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

async function seed(request: APIRequestContext) {
  const company = await json(await request.post("/api/companies", { data: { name: `Toggle names ${Date.now().toString(36)}` } }));
  const agent = await json(
    await request.post(`/api/companies/${company.id}/agents`, {
      data: {
        name: "Toggle Agent",
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

async function buttonNameViolations(page: Page) {
  const hasAxe = await page.evaluate(() => Boolean((window as unknown as { axe?: unknown }).axe));
  if (!hasAxe) await page.addScriptTag({ path: axePath });
  return page.evaluate(async () => {
    const axe = (window as unknown as {
      axe: { run: (context: Document, options: unknown) => Promise<AxeResult> };
    }).axe;
    const result = await axe.run(document, { runOnly: { type: "rule", values: ["button-name"] } });
    return result.violations.flatMap((violation) =>
      violation.nodes.map((node) => ({
        target: node.target.map((target) => String(target)),
        summary: node.failureSummary ?? "",
      })),
    );
  });
}

test("the agent permission switches expose their names", async ({ page, request }) => {
  test.setTimeout(120_000);
  const { company, agent } = await seed(request);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/${company.issuePrefix}/agents/${agent.id}/permissions`);
  await expect(page.getByRole("heading", { name: "Capabilities" })).toBeVisible({ timeout: 30_000 });

  for (const name of ["Can create new agents", "Can create/import skills", "Can assign tasks"]) {
    await expect(page.getByRole("switch", { name })).toBeVisible();
  }
  expect(await buttonNameViolations(page), "permission switches must not fail button-name").toEqual([]);
});
