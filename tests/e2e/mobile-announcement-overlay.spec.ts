import { expect, test, type APIRequestContext, type APIResponse, type Page } from "@playwright/test";

/**
 * The floating announcement is optional product news. On a phone it used to
 * cover the pinned task composer and the Approve/Reject actions in the
 * approvals list. It must not cover a composer at all, and the rest of the page
 * must be able to scroll clear of the card.
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
  await page.route("**/api/announcements/current", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ANNOUNCEMENT) }),
  );
  await page.route(`**/api/announcements/${ANNOUNCEMENT.id}/image`, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PIXEL_PNG }),
  );
  await page.route(`**/api/announcements/${ANNOUNCEMENT.id}/dismiss`, (route) => route.fulfill({ status: 204 }));
}

async function seed(request: APIRequestContext) {
  const company = await json(await request.post("/api/companies", { data: { name: `Overlay ${Date.now().toString(36)}` } }));
  const agent = await json(await request.post(`/api/companies/${company.id}/agents`, {
    data: {
      name: "Overlay Agent",
      role: "engineer",
      adapterType: "process",
      adapterConfig: { command: "/usr/bin/true" },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
    },
  }));
  await request.post(`/api/agents/${agent.id}/pause`);
  const issue = await json(await request.post(`/api/companies/${company.id}/issues`, {
    data: { title: "Overlay task", status: "todo", assigneeAgentId: agent.id },
  }));
  const approval = await json(await request.post(`/api/companies/${company.id}/approvals`, {
    data: {
      type: "request_board_approval",
      payload: { title: "Approve the overlay plan", summary: "A short summary." },
      issueIds: [issue.id],
    },
  }));
  return { company, agent, issue, approval };
}

test("a phone announcement never covers the task composer", async ({ page, request }) => {
  test.setTimeout(120_000);
  const { company, issue } = await seed(request);
  await serveAnnouncement(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/${company.issuePrefix}/issues/${issue.id}`, { waitUntil: "domcontentloaded" });

  const composer = page.getByTestId("task-chat-composer-dock");
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1000);

  await expect(
    page.getByRole("complementary", { name: "Paperclip announcements" }),
    "the floating card is not rendered over a pinned composer",
  ).toHaveCount(0);
  const composerBox = await composer.boundingBox();
  expect(composerBox).not.toBeNull();
  expect(composerBox!.y + composerBox!.height, "the composer ends inside the viewport").toBeLessThanOrEqual(812);
  await expect(page.getByRole("textbox").first()).toBeVisible();
});

test("a phone announcement leaves the approval actions reachable", async ({ page, request }) => {
  test.setTimeout(120_000);
  const { company } = await seed(request);
  await serveAnnouncement(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/${company.issuePrefix}/approvals/pending`, { waitUntil: "domcontentloaded" });

  const announcement = page.getByRole("complementary", { name: "Paperclip announcements" });
  await expect(announcement).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(800);
  const approve = page.getByRole("button", { name: /^Approve/ }).first();
  await expect(approve).toBeVisible();

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(300);

  const card = await announcement.boundingBox();
  const approveBox = await approve.boundingBox();
  expect(card).not.toBeNull();
  expect(approveBox).not.toBeNull();
  expect(approveBox!.y + approveBox!.height, "Approve scrolls clear of the card").toBeLessThanOrEqual(card!.y + 1);

  // The card is fixed, so a covered button still has a rectangle. Hit testing
  // proves the click reaches the button and not the card.
  const hits = await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((node) => /^Approve/.test((node.textContent ?? "").trim()));
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return { inside: Boolean(top && (top === button || button.contains(top))) };
  });
  expect(hits, "Approve is exposed to pointer hit testing").toEqual({ inside: true });
  await page.screenshot({ path: "/tmp/lane-d-announcement-approvals-phone.png" });
});

test("a tablet keeps the announcement in the sidebar and away from the composer", async ({ page, request }) => {
  test.setTimeout(120_000);
  const { company, issue } = await seed(request);
  await serveAnnouncement(page);
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto(`/${company.issuePrefix}/issues/${issue.id}`, { waitUntil: "domcontentloaded" });

  const announcement = page.getByRole("complementary", { name: "Paperclip announcements" });
  await expect(announcement).toBeVisible({ timeout: 30_000 });
  const composer = page.getByTestId("task-chat-composer-dock");
  await expect(composer).toBeVisible();
  await page.waitForTimeout(800);

  const card = (await announcement.boundingBox())!;
  const composerBox = (await composer.boundingBox())!;
  const overlap =
    Math.max(0, Math.min(card.x + card.width, composerBox.x + composerBox.width) - Math.max(card.x, composerBox.x)) *
    Math.max(0, Math.min(card.y + card.height, composerBox.y + composerBox.height) - Math.max(card.y, composerBox.y));
  expect(overlap, "docked card does not overlap the composer").toBe(0);
  expect(card.x + card.width, "the card stays in the sidebar column").toBeLessThanOrEqual(composerBox.x + 1);
});
