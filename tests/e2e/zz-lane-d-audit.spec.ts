import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const OUT = "/tmp/lane-d-audit";

async function json(response: Awaited<ReturnType<APIRequestContext["post"]>>) {
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

async function createAuditCompany(request: APIRequestContext) {
  const company = await json(await request.post("/api/companies", { data: { name: `Usability Audit ${Date.now()}` } }));
  const agents = [];
  const specs = [
    { name: "Ada Controller", role: "ceo" },
    { name: "Robotics Integration And Fleet Operations Specialist With A Long Name", role: "engineer" },
    { name: "Quiet Reviewer", role: "qa" },
  ];
  for (const spec of specs) {
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
    agents.push(agent);
    await request.post(`/api/agents/${agent.id}/pause`);
  }
  const routines = [];
  for (const spec of [
    { title: "Daily revenue report", assigneeAgentId: agents[0].id },
    { title: "Reconcile the very long weekly partner attribution spreadsheet against the warehouse export before the finance review", assigneeAgentId: agents[1].id },
    { title: "Nightly cleanup", assigneeAgentId: agents[2].id, status: "paused" },
  ]) {
    routines.push(await json(await request.post(`/api/companies/${company.id}/routines`, { data: spec })));
  }
  const approvals = [];
  for (const spec of [
    {
      type: "request_board_approval",
      requestedByAgentId: agents[0].id,
      payload: { title: "Increase the weekly spend ceiling", summary: "The current ceiling blocks the scheduled report once a week.", amountCents: 25000, currency: "USD" },
    },
    {
      type: "hire_agent",
      requestedByAgentId: agents[0].id,
      payload: { name: "Night shift analyst", role: "analyst", rationale: "Coverage for the 02:00 window." },
    },
  ]) {
    approvals.push(await json(await request.post(`/api/companies/${company.id}/approvals`, { data: spec })));
  }
  return { company, agents, routines, approvals };
}

function watchPage(page: Page) {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error)));
  return errors;
}

async function shot(page: Page, name: string) {
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const text = (await page.locator("body").innerText()).slice(0, 1200);
  return { overflow, text };
}

for (const viewport of [
  { label: "390", width: 390, height: 844 },
  { label: "1280", width: 1280, height: 800 },
]) {
  test(`usability audit pages ${viewport.label}`, async ({ page, request }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const { company, agents, routines, approvals } = await createAuditCompany(request);
    const errors = watchPage(page);
    const base = `/${company.issuePrefix}`;
    const report: Record<string, unknown> = {};

    const visits: Array<[string, string]> = [
      ["agents", `${base}/agents/all`],
      ["agent-detail", `${base}/agents/${agents[0].id}`],
      ["agent-detail-long-name", `${base}/agents/${agents[1].id}`],
      ["routines", `${base}/routines`],
      ["routine-detail", `${base}/routines/${routines[0].id}`],
      ["routine-detail-long", `${base}/routines/${routines[1].id}`],
      ["approvals-pending", `${base}/approvals/pending`],
      ["approvals-all", `${base}/approvals/all`],
      ["approval-detail", `${base}/approvals/${approvals[0].id}`],
      ["costs", `${base}/costs`],
      ["plugins", `${base}/company/settings/instance/plugins`],
      ["onboarding", `${base}/onboarding`],
    ];

    for (const [name, url] of visits) {
      await page.goto(url);
      await page.waitForTimeout(1500);
      const result = await shot(page, `${name}-${viewport.label}`);
      report[name] = { url: page.url(), ...result };
    }
    fs.writeFileSync(path.join(OUT, `report-${viewport.label}.json`), JSON.stringify({ report, errors }, null, 2));
  });
}
