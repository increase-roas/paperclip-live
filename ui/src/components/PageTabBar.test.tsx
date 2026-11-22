// @vitest-environment jsdom
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageTabBar } from "./PageTabBar";
import { Tabs, TabsContent } from "./ui/tabs";

vi.mock("../context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false }) }));

const require = createRequire(resolve(process.cwd(), "package.json"));
const uiRoot = process.cwd().endsWith("/ui") ? process.cwd() : resolve(process.cwd(), "ui");
const addonPath = require.resolve("@storybook/addon-a11y/package.json", { paths: [uiRoot] });
const axe = require(require.resolve("axe-core", { paths: [addonPath] })) as {
  run: (context: Element, options: unknown) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }>;
};

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const items = [
  { value: "activity", label: "Activity" },
  { value: "runs", label: "Runs" },
];

describe("PageTabBar navigation mode", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function render(node: ReactNode) {
    await act(async () => root.render(node));
  }

  async function invalidAriaValues() {
    const results = await axe.run(host, { runOnly: { type: "rule", values: ["aria-valid-attr-value"] } });
    return results.violations.map(violation => ({
      id: violation.id,
      targets: violation.nodes.map(node => node.target.join(" ")),
    }));
  }

  it("renders page sections as a named navigation with aria-current instead of tabs", async () => {
    const onValueChange = vi.fn();
    await render(<PageTabBar mode="navigation" label="Audit sections" items={items} value="activity" onValueChange={onValueChange} />);

    const nav = host.querySelector('nav[aria-label="Audit sections"]')!;
    expect(nav).not.toBeNull();
    expect(host.querySelector('[role="tab"]')).toBeNull();
    expect(host.querySelector('[role="tablist"]')).toBeNull();
    const buttons = [...nav.querySelectorAll("button")];
    expect(buttons.map(button => button.textContent)).toEqual(["Activity", "Runs"]);
    expect(buttons[0].getAttribute("aria-current")).toBe("page");
    expect(buttons[1].hasAttribute("aria-current")).toBe(false);
    expect(await invalidAriaValues()).toEqual([]);

    await act(async () => buttons[1].click());
    expect(onValueChange).toHaveBeenCalledWith("runs");
  });

  it("keeps content tabs for callers with real panels", async () => {
    await render(
      <Tabs defaultValue="activity">
        <PageTabBar label="Audit sections" items={items} />
        <TabsContent value="activity">Activity panel</TabsContent>
        <TabsContent value="runs">Runs panel</TabsContent>
      </Tabs>,
    );

    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(2);
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Activity");
    expect(host.textContent).toContain("Activity panel");
    expect(await invalidAriaValues()).toEqual([]);
  });
});
