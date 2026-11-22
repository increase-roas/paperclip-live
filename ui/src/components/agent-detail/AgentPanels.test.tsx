// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { act } from "react";
import { Box } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentMetricTile } from "./AgentPanels";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: React.ComponentProps<"a"> & { to?: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("AgentMetricTile", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("keeps the metric description at the readable muted-foreground contrast", () => {
    act(() => {
      root.render(
        <AgentMetricTile
          icon={Box}
          value={3}
          label="Agents"
          description="Active this week"
          to="/agents"
        />,
      );
    });

    const description = [...container.querySelectorAll("span")].find(
      (span) => span.textContent === "Active this week",
    );
    expect(description, "the description should render").toBeTruthy();
    // 12px text at 70% muted-foreground measured 2.71:1 against the tile.
    expect(description?.className).toContain("text-muted-foreground");
    expect(description?.className).not.toContain("text-muted-foreground/70");
  });
});
