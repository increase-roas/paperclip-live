import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Locator } from "@playwright/test";

async function json(response: Awaited<ReturnType<APIRequestContext["post"]>>) {
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

/** True when the element shows either an outline or a non-transparent ring. */
function hasFocusIndicator(element: Element) {
  const style = getComputedStyle(element);
  const outline = style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0;
  const shadow = style.boxShadow.trim();
  const onlyPlaceholders = /^(rgba?\(0, 0, 0, 0\) 0px 0px 0px 0px(, )?)+$/.test(shadow);
  return outline || (shadow !== "none" && shadow !== "" && !onlyPlaceholders);
}

async function expectVisibleFocus(locator: Locator) {
  await expect
    .poll(async () => locator.evaluate(hasFocusIndicator), {
      message: "keyboard focus should be visible on this control",
      timeout: 3_000,
    })
    .toBe(true);
}

async function createCompany(request: APIRequestContext) {
  const company = await json(await request.post("/api/companies", { data: { name: `Keyboard ${randomUUID()}` } }));
  const agent = await json(
    await request.post(`/api/companies/${company.id}/agents`, {
      data: {
        name: "Keyboard Bot",
        role: "engineer",
        adapterType: "process",
        adapterConfig: { command: "/usr/bin/true" },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
        metadata: {
          grokBotTwin: true,
          bot: {
            purpose: "Checks keyboard access.",
            gateway: { keyId: "gk_lane_d", policy: "auditor", provider: "lane-d-gateway" },
          },
        },
      },
    }),
  );
  await request.post(`/api/agents/${agent.id}/pause`);
  const routine = await json(
    await request.post(`/api/companies/${company.id}/routines`, {
      data: { title: "Keyboard routine", description: "Tab through me.", assigneeAgentId: agent.id },
    }),
  );
  const issue = await json(
    await request.post(`/api/companies/${company.id}/issues`, {
      data: { title: "Keyboard task", status: "todo" },
    }),
  );
  const approval = await json(
    await request.post(`/api/companies/${company.id}/approvals`, {
      data: {
        type: "request_board_approval",
        payload: {
          title: "Keyboard approval",
          summary: "Approve this from the keyboard.",
          requestedAction: "Approve this request",
        },
      },
    }),
  );
  return { company, agent, routine, issue, approval };
}

test.describe("keyboard access to the operator surfaces", () => {
  test("the bot roster and a bot page work from the keyboard with a visible focus ring", async ({ page, request }) => {
    test.setTimeout(90_000);
    const { company, agent } = await createCompany(request);

    await page.goto(`/${company.issuePrefix}/bots`);
    const search = page.getByLabel("Search bots");
    await expect(search).toBeVisible();
    await search.focus();
    await page.keyboard.type("Keyboard Bot");
    const botLink = page.getByRole("link", { name: /Keyboard Bot/ }).first();
    await expect(botLink).toBeVisible();

    // The shared search surface owns the ring, not the inner input.
    await expect
      .poll(() => page.locator("[data-toolbar-search]").first().evaluate(hasFocusIndicator))
      .toBe(true);

    await botLink.focus();
    await expectVisibleFocus(botLink);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/${company.issuePrefix}/bots/${agent.id}$`));

    const back = page.getByRole("link", { name: "All bots", exact: true }).first();
    await back.focus();
    await expectVisibleFocus(back);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/${company.issuePrefix}/bots$`));
  });

  test("the task list toolbar keeps a visible focus ring and names the filter control", async ({ page, request }) => {
    test.setTimeout(90_000);
    const { company } = await createCompany(request);

    await page.goto(`/${company.issuePrefix}/issues`);
    const newTask = page.getByRole("button", { name: "New Task", exact: true }).first();
    await expect(newTask).toBeVisible();

    const listView = page.getByRole("button", { name: "List view", exact: true }).first();
    await listView.focus();
    await expectVisibleFocus(listView);

    // The icon-only filter trigger used to have only a title attribute.
    const filter = page.getByRole("button", { name: "Filters", exact: true }).first();
    await expect(filter).toBeVisible();
    await filter.focus();
    await expectVisibleFocus(filter);

    const rowLink = page.getByRole("link", { name: /: Keyboard task$/ }).first();
    await expect(rowLink).toBeVisible();
    await rowLink.focus();
    await expectVisibleFocus(rowLink);
  });

  test("the new task dialog takes focus, accepts typing, and returns focus on Escape", async ({ page, request }) => {
    test.setTimeout(90_000);
    const { company } = await createCompany(request);

    await page.goto(`/${company.issuePrefix}/issues`);
    const trigger = page.getByRole("button", { name: "New Task", exact: true }).first();
    await trigger.focus();
    await page.keyboard.press("Enter");

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const editor = document.querySelector('[role="dialog"] [contenteditable="true"]');
            return Boolean(editor && document.activeElement === editor);
          }),
        { message: "the composer editor should own focus", timeout: 10_000 },
      )
      .toBe(true);

    await page.keyboard.type("Typed from the keyboard");
    await expect(dialog).toContainText("Typed from the keyboard");

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("the routine editor shows focus on its title and its dialog returns focus", async ({ page, request }) => {
    test.setTimeout(90_000);
    const { company, routine } = await createCompany(request);

    await page.goto(`/${company.issuePrefix}/routines`);
    const create = page.getByRole("button", { name: "Create routine", exact: true }).first();
    await create.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Routine title" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(create).toBeFocused();

    await page.goto(`/${company.issuePrefix}/routines/${routine.id}/overview`);
    const edit = page.getByRole("button", { name: "Edit routine", exact: true }).first();
    await expect(edit).toBeVisible();
    await edit.focus();
    await page.keyboard.press("Enter");
    const title = page.locator('textarea[placeholder="Routine title"]').first();
    await expect(title).toBeVisible();
    await title.focus();
    await expectVisibleFocus(title);
  });

  test("approval decisions are reachable in order and show a focus ring", async ({ page, request }) => {
    test.setTimeout(90_000);
    const { company } = await createCompany(request);

    await page.goto(`/${company.issuePrefix}/approvals`);
    const pending = page.getByRole("tab", { name: /^Pending/ }).first();
    await expect(pending).toBeVisible();
    await pending.focus();
    await expectVisibleFocus(pending);

    // Tab order inside the card: Pending tab -> Approve -> Reject -> Add note.
    await page.keyboard.press("Tab");
    const approve = page.getByRole("button", { name: "Approve", exact: true }).first();
    await expect(approve).toBeFocused();
    await expectVisibleFocus(approve);

    await page.keyboard.press("Tab");
    const reject = page.getByRole("button", { name: "Reject", exact: true }).first();
    await expect(reject).toBeFocused();
    await expectVisibleFocus(reject);

    const details = page.getByRole("link", { name: "View details", exact: true }).first();
    await details.focus();
    await expectVisibleFocus(details);
  });
});
