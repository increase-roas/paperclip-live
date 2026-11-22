import { expect, test, type APIRequestContext, type APIResponse, type Page } from "@playwright/test";

/**
 * The phone announcement is optional product news. It rests as a compact bar
 * that takes at most 15% of the viewport, opens on tap, and stays dismissible.
 * Tablet and desktop keep the full card. The composer-safe placement from the
 * preceding overlay fix remains in force.
 */

const ANNOUNCEMENT = {
  id: "2026-09-14-connectors",
  eyebrow: "Introducing Connectors",
  title: "Give your agents the access they need",
  description:
    "Connect Gmail, GitHub, Notion, and more. Choose which agents get access, which accounts they use, and which actions they can take.",
  image: { path: `assets/${"a".repeat(64)}.png`, alt: "Paperclip agents with connected apps." },
  primaryAction: { kind: "route", label: "Explore connectors", path: "/apps" },
};

const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

async function json(response: APIResponse) {
  const text = await response.text();
  expect(response.ok(), `${response.url()}: ${response.status()} ${text}`).toBe(true);
  return JSON.parse(text);
}

async function serveAnnouncement(page: Page) {
  let dismissals = 0;
  await page.route("**/api/announcements/current", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ANNOUNCEMENT) }),
  );
  await page.route(`**/api/announcements/${ANNOUNCEMENT.id}/image`, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PIXEL_PNG }),
  );
  await page.route(`**/api/announcements/${ANNOUNCEMENT.id}/dismiss`, (route) => {
    dismissals += 1;
    return route.fulfill({ status: 204 });
  });
  return { dismissals: () => dismissals };
}

async function seed(request: APIRequestContext) {
  const company = await json(await request.post("/api/companies", { data: { name: `Compact announcement ${Date.now().toString(36)}` } }));
  const agent = await json(
    await request.post(`/api/companies/${company.id}/agents`, {
      data: {
        name: "Announcement Agent",
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
      data: { title: "Announcement task", status: "todo", assigneeAgentId: agent.id },
    }),
  );
  await json(
    await request.post(`/api/companies/${company.id}/approvals`, {
      data: {
        type: "request_board_approval",
        payload: { title: "Approve the announcement plan", summary: "A short summary." },
        issueIds: [issue.id],
      },
    }),
  );
  return { company, issue };
}

async function boxHeight(page: Page, name = "Paperclip announcements") {
  const box = await page.getByRole("complementary", { name }).boundingBox();
  expect(box).not.toBeNull();
  return box!.height;
}

test.describe("compact phone announcement", () => {
  test("rests as a two-line bar, expands on tap, collapses and dismisses", async ({ page, request }) => {
    test.setTimeout(120_000);
    const { company } = await seed(request);
    const dismissal = await serveAnnouncement(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/${company.issuePrefix}/approvals/pending`, { waitUntil: "domcontentloaded" });

    const announcement = page.getByRole("complementary", { name: "Paperclip announcements" });
    await expect(announcement).toBeVisible({ timeout: 30_000 });
    await expect(announcement.getByText(ANNOUNCEMENT.title)).toBeVisible();
    await expect(announcement.getByText(ANNOUNCEMENT.eyebrow)).toBeVisible();
    await expect(announcement.getByRole("button", { name: "Dismiss announcement" })).toBeVisible();
    await expect(announcement.getByText(ANNOUNCEMENT.description)).toHaveCount(0);

    const compactHeight = await boxHeight(page);
    expect(compactHeight, "compact bar fits 15% of an 812px phone").toBeLessThanOrEqual(812 * 0.15);

    await announcement.getByRole("button", { name: new RegExp(`Expand announcement: ${ANNOUNCEMENT.title}`) }).click();
    await expect(announcement.getByText(ANNOUNCEMENT.description)).toBeVisible();
    await expect(announcement.getByRole("link", { name: "Explore connectors" })).toBeVisible();
    const expandedHeight = await boxHeight(page);
    expect(expandedHeight, "expanding reveals more than the resting bar").toBeGreaterThan(compactHeight);

    await announcement.getByRole("button", { name: "Collapse announcement" }).click();
    await expect(announcement.getByText(ANNOUNCEMENT.description)).toHaveCount(0);
    expect(await boxHeight(page), "collapsing restores the compact bar").toBeLessThanOrEqual(812 * 0.15);

    await announcement.getByRole("button", { name: "Dismiss announcement" }).click();
    await expect(announcement).toHaveCount(0);
    expect(dismissal.dismissals()).toBe(1);
  });

  test("stays under 15% on a shorter phone", async ({ page, request }) => {
    test.setTimeout(120_000);
    const { company } = await seed(request);
    await serveAnnouncement(page);
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(`/${company.issuePrefix}/approvals/pending`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("complementary", { name: "Paperclip announcements" })).toBeVisible({ timeout: 30_000 });
    expect(await boxHeight(page)).toBeLessThanOrEqual(667 * 0.15);
  });

  test("tablet and desktop keep the full card", async ({ page, request }) => {
    test.setTimeout(120_000);
    const { company } = await seed(request);
    await serveAnnouncement(page);
    for (const viewport of [{ width: 768, height: 1024 }, { width: 1280, height: 800 }]) {
      await page.setViewportSize(viewport);
      await page.goto(`/${company.issuePrefix}/approvals/pending`, { waitUntil: "domcontentloaded" });
      const announcement = page.getByRole("complementary", { name: "Paperclip announcements" });
      await expect(announcement).toBeVisible({ timeout: 30_000 });
      await expect(announcement.getByText(ANNOUNCEMENT.description)).toBeVisible();
      await expect(announcement.getByRole("button", { name: /Expand announcement/ })).toHaveCount(0);
      expect(await boxHeight(page), `${viewport.width}px keeps the full card`).toBeGreaterThan(viewport.height * 0.15);
    }
  });

  test("a phone task composer still never renders the announcement", async ({ page, request }) => {
    test.setTimeout(120_000);
    const { company, issue } = await seed(request);
    await serveAnnouncement(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/${company.issuePrefix}/issues/${issue.identifier}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("task-chat-composer-dock")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("complementary", { name: "Paperclip announcements" })).toHaveCount(0);
  });
});
