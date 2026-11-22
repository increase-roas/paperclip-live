// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Field } from "./agent-config-primitives";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("Field", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  function render(children: React.ReactNode) {
    const root = createRoot(container);
    act(() =>
      root.render(
        <TooltipProvider>
          {children}
        </TooltipProvider>,
      ),
    );
    return root;
  }

  it("names a direct input with its visible label", () => {
    const root = render(
      <Field label="Organization name" hint="Shown in the organization switcher.">
        <input type="text" />
      </Field>,
    );

    const input = container.querySelector("input");
    expect(input?.getAttribute("aria-label")).toBe("Organization name");

    act(() => root.unmount());
  });

  it("keeps an explicit accessible name on the control", () => {
    const root = render(
      <Field label="Description">
        <input type="text" aria-label="Short description" />
      </Field>,
    );

    expect(container.querySelector("input")?.getAttribute("aria-label")).toBe("Short description");

    act(() => root.unmount());
  });

  it("does not label a composite child", () => {
    const root = render(
      <Field label="Logo">
        <div>
          <input type="file" aria-label="Logo image" />
        </div>
      </Field>,
    );

    expect(container.querySelector("div > input")?.getAttribute("aria-labelledby")).toBeNull();
    expect(container.querySelector("input")?.getAttribute("aria-label")).toBe("Logo image");

    act(() => root.unmount());
  });
});
