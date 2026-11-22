import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type APIResponse, type APIRequestContext } from "@playwright/test";
import { closeRegisteredClients, createDb, heartbeatRuns } from "../../packages/db/src/index.ts";

async function json(response: APIResponse) {
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

/** The running test server's database URL, embedded or external. */
async function databaseUrl() {
  const config = JSON.parse(await readFile(process.env.PAPERCLIP_E2E_SERVER_CONFIG!, "utf8"));
  if (config.database.mode === "postgres") return config.database.connectionString as string;
  const pidFile = await readFile(path.join(config.database.embeddedPostgresDataDir, "postmaster.pid"), "utf8");
  return `postgres://paperclip:paperclip@127.0.0.1:${pidFile.split("\n")[3]}/paperclip`;
}

async function seedBot(request: APIRequestContext) {
  const company = await json(await request.post("/api/companies", { data: { name: `Run link ${Date.now()}` } }));
  const agent = await json(
    await request.post(`/api/companies/${company.id}/agents`, {
      data: {
        name: "Posting Twin",
        role: "engineer",
        adapterType: "process",
        adapterConfig: { command: "/usr/bin/true" },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
        metadata: {
          grokBotTwin: true,
          bot: { purpose: "Drafts and schedules the weekly posting plan." },
        },
      },
    }),
  );
  await request.post(`/api/agents/${agent.id}/pause`);
  return { company, agent };
}

test("a recent run opens from the bot page", async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const { company, agent } = await seedBot(request);

  const runId = randomUUID();
  const url = await databaseUrl();
  const db = createDb(url);
  try {
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: company.id,
      agentId: agent.id,
      status: "succeeded",
      runtimeMode: "legacy",
      startedAt: new Date(Date.now() - 10_000),
      finishedAt: new Date(Date.now() - 5_000),
    });
  } finally {
    await closeRegisteredClients(url);
  }

  await page.goto(`/${company.issuePrefix}/bots/${agent.id}`);
  const runLink = page.getByRole("link", { name: "View run" });
  await expect(runLink).toBeVisible();
  await expect(runLink).toHaveAttribute("href", `/${company.issuePrefix}/agents/${agent.id}/runs/${runId}`);

  await runLink.click();
  await expect(page).toHaveURL(new RegExp(`/${company.issuePrefix}/agents/${agent.id}/runs/${runId}$`));
});
