import { expect, test, type Page } from "@playwright/test";

/**
 * The agent detail header keeps the avatar, title and actions on one row where
 * it fits, and never pushes the primary task action off the screen. The chat
 * action keeps its icon and accessible name but drops its text below `sm`.
 */
async function headerActions(page: Page) {
  return page.locator("header").first().evaluate((node) => {
    const header = node.getBoundingClientRect();
    return {
      headerRight: header.right,
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
      buttons: [...node.querySelectorAll("button,a")].map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          text: (element.textContent ?? "").trim(),
          aria: element.getAttribute("aria-label"),
          left: rect.left,
          right: rect.right,
        };
      }),
    };
  });
}

test("agent detail actions stay inside a phone viewport", async ({ page, request }) => {
  test.setTimeout(120_000);
  const company = await (await request.post("/api/companies", { data: { name: `Agent header ${Date.now()}` } })).json();
  const agent = await (await request.post(`/api/companies/${company.id}/agents`, {
    data: {
      name: "Header Agent",
      role: "engineer",
      adapterType: "process",
      adapterConfig: { command: "/usr/bin/true" },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
    },
  })).json();
  await request.post(`/api/agents/${agent.id}/pause`);

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/${company.issuePrefix}/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Engineer" })).toBeVisible();
    await page.waitForTimeout(500);
    const data = await headerActions(page);
    const viewport = await page.evaluate(() => window.innerWidth);
    for (const button of data.buttons) {
      const label = button.aria ?? button.text ?? "<unnamed>";
      expect(button.right, `${label} must not cross the right edge at ${width}px`).toBeLessThanOrEqual(viewport + 0.5);
      expect(button.left, `${label} must not cross the left edge at ${width}px`).toBeGreaterThanOrEqual(-0.5);
    }
    expect(data.scrollWidth, "header content must not overflow its row").toBeLessThanOrEqual(data.clientWidth + 1);
    await expect(page.getByRole("button", { name: `New chat with Header Agent` })).toBeVisible();
    await expect(page.getByRole("button", { name: "New task" }).first()).toBeVisible();
  }
});
