// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PageSkeleton } from "./PageSkeleton";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("<PageSkeleton>", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it.each([
    ["list", "Loading page"],
    ["issues-list", "Loading tasks"],
    ["detail", "Loading details"],
    ["dashboard", "Loading dashboard"],
    ["approvals", "Loading approvals"],
    ["costs", "Loading costs"],
    ["inbox", "Loading tasks"],
    ["org-chart", "Loading organization chart"],
  ] as const)("announces the pending page for the %s variant", (variant, label) => {
    act(() => {
      root.render(<PageSkeleton variant={variant} />);
    });
    const statuses = container.querySelectorAll('[role="status"]');
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.getAttribute("aria-label")).toBe(label);
  });
});
