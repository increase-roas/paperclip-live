// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { NotConnected } from "./NotConnected";
import { Tile, readAtLabel } from "./Tile";

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
});

describe("Tile", () => {
  it("carries value, label, period, red line, state, source and read time", async () => {
    const readAt = Date.now() - 90 * 60 * 1000;
    const container = await render(
      <Tile
        testId="tile-under-test"
        label="Blocked tasks"
        value="3"
        periodLabel="Right now"
        redLine="Zero; any blocked task escalates"
        state="red"
        source="Paperclip tasks"
        readAt={readAt}
        note="A blocked task is work nobody is doing."
      />,
    );

    const tile = container.querySelector('[data-testid="tile-under-test"]');
    expect(tile).not.toBeNull();
    expect(tile?.getAttribute("data-tile-state")).toBe("red");

    const text = container.textContent ?? "";
    expect(text).toContain("Blocked tasks");
    expect(text).toContain("3");
    expect(text).toContain("Right now");
    expect(text).toContain("Red line:");
    expect(text).toContain("Zero; any blocked task escalates");
    expect(text).toContain("Red line");
    expect(text).toContain("Source: Paperclip tasks");
    expect(text).toContain("read 1h ago");
    expect(text).toContain("A blocked task is work nobody is doing.");
  });

  it("marks an unjudged number as unknown rather than green", async () => {
    const container = await render(
      <Tile label="Open tasks" value="12" periodLabel="Right now" source="Paperclip tasks" />,
    );
    const tile = container.querySelector("[data-tile-state]");
    expect(tile?.getAttribute("data-tile-state")).toBe("unknown");
    expect(container.textContent).toContain("No red line");
  });

  it("says not read yet instead of inventing a read time", async () => {
    const container = await render(<Tile label="Open tasks" value="0" periodLabel="Right now" source="Paperclip tasks" />);
    expect(container.textContent).toContain("not read yet");
  });
});

describe("readAtLabel", () => {
  it("handles absent, invalid and real timestamps", () => {
    expect(readAtLabel(null)).toBe("not read yet");
    expect(readAtLabel(undefined)).toBe("not read yet");
    expect(readAtLabel("not-a-date")).toBe("read time unknown");
    expect(readAtLabel(Date.now() - 90 * 60 * 1000)).toBe("read 1h ago");
  });
});

describe("NotConnected", () => {
  it("names the missing source and what is needed, and shows no value", async () => {
    const container = await render(
      <NotConnected
        testId="not-connected-under-test"
        label="Show rate"
        source="GHL appointments"
        periodLabel="Last 30 days"
        needs="Appointment status per client: booked versus held."
        target="70–80% healthy; below 60% red"
      />,
    );

    const tile = container.querySelector('[data-testid="not-connected-under-test"]');
    expect(tile?.getAttribute("data-connection-state")).toBe("not-connected");

    const text = container.textContent ?? "";
    expect(text).toContain("Show rate");
    expect(text).toContain("Not connected: GHL appointments");
    expect(text).toContain("Appointment status per client: booked versus held.");
    expect(text).toContain("70–80% healthy; below 60% red");
    expect(text).toContain("Last 30 days");
    expect(text).toContain("No number is shown until this source is wired.");
  });
});
