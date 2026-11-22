import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";

async function json(response: APIResponse) {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function seedAgent(request: APIRequestContext) {
  const company = await json(
    await request.post("/api/companies", { data: { name: `Agent identity ${Date.now().toString(36)}` } }),
  );
  const agent = await json(
    await request.post(`/api/companies/${company.id}/agents`, {
      data: {
        name: "Identity Agent With A Long Name",
        title: "Staff Platform Engineer",
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

/**
 * A phone or tablet must still read the agent's title and name. The header
 * previously let the action buttons compress the identity to a few pixels, so
 * the page showed only a sliver of each label. The identity now keeps the first
 * row and the actions move below it until the desktop layout has room.
 */
test("an agent header keeps its title and name readable on a phone and tablet", async ({ page, request }) => {
  test.setTimeout(120_000);
  const { company, agent } = await seedAgent(request);

  for (const viewport of [
    { width: 375, height: 812, label: "phone" },
    { width: 768, height: 1024, label: "tablet" },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(`/${company.issuePrefix}/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Staff Platform Engineer" })).toBeVisible();
    await expect(page.locator("main header").getByText("Identity Agent With A Long Name", { exact: true })).toBeVisible();
    await page.waitForTimeout(500);

    const measurements = await page.evaluate(() => {
      const header = document.querySelector("main header");
      if (!header) return null;
      const nodes = [...header.querySelectorAll("h1, span, p")].filter((el) => el.children.length === 0 && (el.textContent ?? "").trim());
      const find = (text: string) => {
        const el = nodes.find((node) => (node.textContent ?? "").trim() === text);
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { width: Math.round(rect.width), height: Math.round(rect.height), right: Math.round(rect.right) };
      };
      const headerRect = header.getBoundingClientRect();
      return {
        title: find("Staff Platform Engineer"),
        name: find("Identity Agent With A Long Name"),
        headerRight: Math.round(headerRect.right),
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        actions: [...header.querySelectorAll("button, a")].map((el) => {
          const rect = el.getBoundingClientRect();
          return { label: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 40), left: rect.left, right: rect.right };
        }),
      };
    });
    expect(measurements, "agent header should render").not.toBeNull();
    const data = measurements!;

    expect(data.title, "the agent title keeps a readable width").not.toBeNull();
    expect(data.name, "the agent name keeps a readable width").not.toBeNull();
    // At 768 the desktop three-pane shell leaves a narrow content column; the
    // header keeps the identity readable there (the shell width itself is a
    // separate layout decision), while a phone keeps the full title.
    expect(data.title!.width, `${viewport.label}: title must not collapse`).toBeGreaterThan(viewport.label === "phone" ? 120 : 70);
    expect(data.name!.width, `${viewport.label}: name must not collapse`).toBeGreaterThan(viewport.label === "phone" ? 80 : 70);
    expect(data.scrollWidth, `${viewport.label}: no horizontal page overflow`).toBeLessThanOrEqual(data.clientWidth + 1);
    for (const action of data.actions) {
      if (!action.label) continue;
      expect(action.right, `${viewport.label}: ${action.label} stays inside the viewport`).toBeLessThanOrEqual(viewport.width + 0.5);
    }
    await expect(page.getByRole("button", { name: `New chat with ${agent.name}` })).toBeVisible();
    await expect(page.getByRole("button", { name: "New task" }).first()).toBeVisible();
  }
});
