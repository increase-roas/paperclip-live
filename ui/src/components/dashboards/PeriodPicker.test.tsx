// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoardPlaceholder } from "./BoardPlaceholder";
import { PeriodPicker } from "./PeriodPicker";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Array<{ root: Root; container: HTMLDivElement }> = [];

async function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push({ root, container });
  await act(async () => {
    root.render(node);
  });
  return container;
}

afterEach(async () => {
  for (const { root, container } of roots.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("PeriodPicker", () => {
  it("shows the three periods and marks the active one", async () => {
    const container = await render(<PeriodPicker value="30d" onChange={() => {}} />);

    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.map((button) => button.textContent)).toEqual(["7d", "30d", "Month"]);
    expect(container.querySelector('[data-testid="dashboard-period-30d"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector('[data-testid="dashboard-period-7d"]')?.getAttribute("aria-pressed")).toBe("false");
  });

  it("reports the chosen period", async () => {
    const onChange = vi.fn();
    const container = await render(<PeriodPicker value="30d" onChange={onChange} />);

    const sevenDays = container.querySelector('[data-testid="dashboard-period-7d"]') as HTMLButtonElement;
    await act(async () => {
      sevenDays.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith("7d");
  });
});

describe("BoardPlaceholder", () => {
  it("says Being built and names the board", async () => {
    const container = await render(<BoardPlaceholder title="Sales" />);
    const text = container.textContent ?? "";
    expect(text).toContain("Being built");
    expect(text).toContain("The Sales board is being built.");
  });
});
