import { expect, test, type APIRequestContext, type APIResponse, type Page } from "@playwright/test";

async function json(response: APIResponse) {
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

/** Create the company whose catalog autofills the six known gateway bots. */
async function createBotCompany(request: APIRequestContext, name = "Increase Roas") {
  const company = await json(await request.post("/api/companies", { data: { name } }));
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
          bot: {
            purpose: "Drafts and schedules the weekly posting plan.",
            gateway: { keyId: "gk_live_posting", policy: "posting", provider: "increase-roas-oauth-gateway" },
          },
        },
      },
    }),
  );
  await request.post(`/api/agents/${agent.id}/pause`);
  return { company, agent };
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "the page should not scroll horizontally").toBeLessThanOrEqual(1);
}

for (const viewport of [
  { label: "desktop", width: 1280, height: 800, mobile: false },
  { label: "mobile", width: 390, height: 844, mobile: true },
]) {
  test(`a bot roster and both kinds of bot page stay readable (${viewport.label})`, async ({ page, request }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const { company } = await createBotCompany(request);
    const untagged = await json(
      await request.post(`/api/companies/${company.id}/agents`, {
        data: {
          name: "Gateway Twin",
          role: "engineer",
          adapterType: "process",
          adapterConfig: { command: "/usr/bin/true" },
          runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
          metadata: { grokBotTwin: true, bot: { purpose: "Waits for a gateway key." } },
        },
      }),
    );
    await request.post(`/api/agents/${untagged.id}/pause`);

    await page.goto(`/${company.issuePrefix}/bots`);
    await expect(page.getByText("Every bot this company runs", { exact: false }).first()).toBeVisible();
    await expect(page.locator('a[href$="/bots/catalog:funnel-builder"]')).toBeVisible();
    await expect(page.locator('a[href*="/bots/"]').filter({ hasText: "Posting Twin" })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // A known gateway bot with no agent row still gets the full five-section page.
    await page.goto(`/${company.issuePrefix}/bots/catalog:funnel-builder`);
    for (const title of ["What it does", "Gateway key and policy", "Routines and schedules", "Status", "Recent activity"]) {
      await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
    }
    await expect(page.getByText("Not registered", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("No gateway key is linked to this bot yet.", { exact: false }).first()).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // A tagged agent gets its own page with the key and policy it runs on.
    await page.goto(`/${company.issuePrefix}/bots`);
    await page.locator('a[href*="/bots/"]').filter({ hasText: "Posting Twin" }).click();
    await expect(page).toHaveURL(/\/bots\/[^/]+$/);
    await expect(page.getByText("Drafts and schedules the weekly posting plan.")).toBeVisible();
    await expect(page.getByText("gk_live_posting")).toBeVisible();
    await expect(page.getByText("posting", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Registered in this company.", { exact: false }).first()).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // Search that matches nothing explains how to get back to the roster.
    await page.goto(`/${company.issuePrefix}/bots`);
    await page.getByLabel("Search bots").fill("nothing-matches");
    await expect(page.getByText("No bots match", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Show all bots" }).click();
    await expect(page.locator('a[href*="/bots/"]').filter({ hasText: "Posting Twin" })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // A tagged bot without a gateway link points at the metadata editor, not a
    // plain agent page, and does not repeat the tagging step.
    await page.goto(`/${company.issuePrefix}/bots`);
    await page.locator('a[href*="/bots/"]').filter({ hasText: "Gateway Twin" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Link a gateway key" })).toBeVisible();
    await expect(page.getByText("This bot is tagged, but it has no gateway key id or policy yet.")).toBeVisible();
    await expect(page.getByText("spec.metadata.bot.gateway")).toBeVisible();
    await expect(page.getByText("Tag the agent as a bot")).toHaveCount(0);
    const advancedLink = page.getByRole("link", { name: "Open Advanced configuration" });
    await expect(advancedLink).toHaveAttribute("href", new RegExp(`/agents/${untagged.id}/advanced$`));
    await advancedLink.click();
    await expect(page).toHaveURL(new RegExp(`/agents/${untagged.id}/advanced$`));
    await expect(page.locator(".cm-content")).toContainText("metadata", { timeout: 30_000 });
    await expectNoHorizontalOverflow(page);
  });
}

test("an empty roster and a missing bot each name the next step", async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const company = await json(
    await request.post("/api/companies", { data: { name: `Quiet company ${Date.now()}` } }),
  );

  await page.goto(`/${company.issuePrefix}/bots`);
  await expect(page.getByText("No bots yet", { exact: true })).toBeVisible();
  await expect(page.getByText("Tag an agent as a bot", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Open agents" }).click();
  await expect(page).toHaveURL(/\/agents\/all$/);
  await expectNoHorizontalOverflow(page);

  await page.goto(`/${company.issuePrefix}/bots/missing-bot`);
  await expect(page.getByText("Bot not found", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open Bots" }).click();
  await expect(page).toHaveURL(/\/bots$/);
  await expectNoHorizontalOverflow(page);
});
