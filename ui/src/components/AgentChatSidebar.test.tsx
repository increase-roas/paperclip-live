// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AgentChatSidebar } from "./AgentChatSidebar";

const state = vi.hoisted(() => ({ collapsed: false, peeking: false, onOpenChat: vi.fn() }));

vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({ collapsed: state.collapsed, peeking: state.peeking }),
}));
vi.mock("@/lib/router", () => ({
  NavLink: ({ to, children, className, ...props }: {
    to: string;
    children: ReactNode;
    className?: string | ((state: { isActive: boolean }) => string);
  }) => (
    <a href={to} className={typeof className === "function" ? className({ isActive: false }) : className} {...props}>
      {children}
    </a>
  ),
}));

const agent = (id: string): Agent => ({
  id,
  companyId: "company-a",
  name: id,
  urlKey: id,
  role: "engineer",
  title: "Engineer",
  icon: null,
  status: "idle",
} as Agent);

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  state.collapsed = false;
  state.peeking = false;
  state.onOpenChat.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function render() {
  root.render(
    <TooltipProvider>
    <AgentChatSidebar
      agents={[agent("alice"), agent("bob")]}
      activeId=""
      starredIds={[]}
      recentIds={[]}
      onToggleStar={() => {}}
      onOpenChat={state.onOpenChat}
    />
    </TooltipProvider>,
  );
}

describe("AgentChatSidebar", () => {
  it("keeps a visible New chat action in the expanded sidebar", async () => {
    await act(async () => render());
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="New chat"]');
    expect(button).not.toBeNull();
    expect(button?.textContent).toContain("New chat");
    expect(button?.className).not.toContain("opacity-0");
    await act(async () => button!.click());
    expect(state.onOpenChat).toHaveBeenCalledOnce();
  });

  it("keeps the New chat action reachable in the collapsed rail", async () => {
    state.collapsed = true;
    await act(async () => render());
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="New chat"]');
    expect(button).not.toBeNull();
    expect(button?.getAttribute("title")).toBe("New chat");
  });

  it("does not offer New chat while the collapsed rail is peeking", async () => {
    state.collapsed = true;
    state.peeking = true;
    await act(async () => render());
    expect(container.querySelector('button[aria-label="New chat"]')?.textContent).toContain("New chat");
  });
});
