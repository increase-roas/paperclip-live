// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReadingOrderStrip } from "./ReadingOrderStrip";
import { READING_ORDER_STEPS } from "./reading-order";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode } & Record<string, unknown>) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

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

describe("ReadingOrderStrip", () => {
  it("shows the eight questions in order even when no source is connected", async () => {
    const container = await render(<ReadingOrderStrip />);
    const strip = container.querySelector('[data-testid="dashboard-reading-order"]');

    expect(strip).not.toBeNull();
    const steps = Array.from(strip?.querySelectorAll("[data-reading-order-step]") ?? []);
    expect(steps).toHaveLength(8);
    expect(steps.map((step) => step.getAttribute("data-question"))).toEqual(
      READING_ORDER_STEPS.map((step) => step.question),
    );

    // Grey is unknown, and the first grey is where the reader stops.
    expect(steps.map((step) => step.getAttribute("data-state"))).toEqual(Array(8).fill("unknown"));
    expect(steps[0].getAttribute("data-attention")).toBe("true");
    expect(steps.slice(1).every((step) => step.getAttribute("data-attention") === null)).toBe(true);
  });

  it("highlights the first red step when earlier steps are green", async () => {
    const container = await render(
      <ReadingOrderStrip
        statuses={{
          cash: "ok",
          "cash-multiple": "ok",
          "ltgp-cac": "red",
          "gross-margin": "ok",
          churn: "ok",
          "show-rate": "ok",
          "speed-to-lead": "ok",
          cac: "ok",
        }}
      />,
    );

    const steps = Array.from(container.querySelectorAll("[data-reading-order-step]"));
    expect(steps[2].getAttribute("data-state")).toBe("red");
    expect(steps[2].getAttribute("data-attention")).toBe("true");
    expect(steps.filter((step) => step.getAttribute("data-attention") === "true")).toHaveLength(1);
    expect(container.textContent).toContain("Stop here");
  });

  it("does not read past an earlier grey to find a later red", async () => {
    const container = await render(
      <ReadingOrderStrip
        statuses={{ cash: "unknown", "cash-multiple": "red" }}
      />,
    );

    const steps = Array.from(container.querySelectorAll("[data-reading-order-step]"));
    expect(steps[0].getAttribute("data-attention")).toBe("true");
    expect(steps[1].getAttribute("data-attention")).toBeNull();
  });

  it("says all eight are green without inventing a stop", async () => {
    const allGreen = Object.fromEntries(READING_ORDER_STEPS.map((step) => [step.id, "ok" as const]));
    const container = await render(<ReadingOrderStrip statuses={allGreen} />);

    expect(container.textContent).toContain("All eight green");
    expect(
      container.querySelector('[data-reading-order-step][data-attention="true"]'),
    ).toBeNull();
  });

  it("links every step to its owning board and renders live metric values when connected", async () => {
    const container = await render(
      <ReadingOrderStrip
        statuses={{ cash: "ok", "show-rate": "ok", cac: "red" }}
        metrics={{
          cash: "$42,000",
          "show-rate": { formatted: "74.5%" },
          cac: { value: "$1,250" },
        }}
      />,
    );

    const links = Array.from(container.querySelectorAll("[data-reading-order-step] a"));
    expect(links).toHaveLength(8);
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/dashboard/ceo",
      "/dashboard/ceo",
      "/dashboard/ceo",
      "/dashboard/ceo",
      "/dashboard/fulfillment",
      "/dashboard/sales",
      "/dashboard/sales",
      "/dashboard/marketing",
    ]);

    expect(container.querySelector('[data-reading-order-metric="cash"]')?.textContent).toBe("$42,000");
    expect(container.querySelector('[data-reading-order-metric="show-rate"]')?.textContent).toBe("74.5%");
    expect(container.querySelector('[data-reading-order-metric="cac"]')?.textContent).toBe("$1,250");
  });
});
