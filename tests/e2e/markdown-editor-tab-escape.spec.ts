import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";

async function json(response: APIResponse) {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function seed(request: APIRequestContext) {
  const company = await json(await request.post("/api/companies", { data: { name: `Editor focus ${Date.now().toString(36)}` } }));
  const agent = await json(await request.post(`/api/companies/${company.id}/agents`, {
    data: {
      name: "Editor Focus Agent",
      role: "engineer",
      adapterType: "process",
      adapterConfig: { command: "/usr/bin/true" },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
    },
  }));
  await request.post(`/api/agents/${agent.id}/pause`);
  const issue = await json(await request.post(`/api/companies/${company.id}/issues`, {
    data: { title: "Editor focus task", description: "Body.", status: "todo", assigneeAgentId: agent.id },
  }));
  return { company, issue };
}

/**
 * Lexical's tab-indentation plugin swallowed Tab and Shift+Tab, so focus never
 * left the Markdown comment editor. A keyboard-only user could not reach the
 * Send button or any control after the editor.
 */
test("Tab and Shift+Tab leave the Markdown editor", async ({ page, request }) => {
  test.setTimeout(120_000);
  const { company, issue } = await seed(request);
  await page.goto(`/${company.issuePrefix}/issues/${issue.id}`, { waitUntil: "domcontentloaded" });

  const editor = page.locator('[aria-label="editable markdown"]').first();
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await editor.click();

  const active = () => page.evaluate(() => {
    const element = document.activeElement;
    return {
      insideEditor: Boolean(element?.closest('[aria-label="editable markdown"]')),
      tag: element?.tagName ?? null,
      name: (element?.getAttribute("aria-label") || element?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 50),
    };
  });

  await page.keyboard.press("Tab");
  await expect.poll(active, { message: "Tab moves focus out of the editor" }).toMatchObject({ insideEditor: false });
  const forward = await active();

  await editor.click();
  await page.keyboard.press("Shift+Tab");
  await expect.poll(active, { message: "Shift+Tab moves focus out of the editor" }).toMatchObject({ insideEditor: false });
  const backward = await active();

  expect(forward.tag, "forward focus lands on a real control").not.toBe("BODY");
  expect(backward.tag, "backward focus lands on a real control").not.toBe("BODY");
});
