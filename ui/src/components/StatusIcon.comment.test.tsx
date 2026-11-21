// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatusPickerMenu } from "./StatusIcon";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function renderMenu(ui: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function click(element: Element | null | undefined) {
  expect(element).toBeTruthy();
  act(() => {
    element!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function typeInto(element: HTMLTextAreaElement | null | undefined, value: string) {
  expect(element).toBeTruthy();
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(element, value);
    element!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function baseProps() {
  return {
    currentStatus: "in_review",
    presentation: { status: "in_review" },
  };
}

describe("StatusPickerMenu", () => {
  let rendered: ReturnType<typeof renderMenu> | null = null;

  beforeEach(() => {
    rendered = null;
  });

  afterEach(() => {
    rendered?.unmount();
  });

  it("keeps the immediate status change when no comment is collected", () => {
    const onSelect = vi.fn();
    rendered = renderMenu(<StatusPickerMenu {...baseProps()} onSelect={onSelect} />);

    expect(rendered.container.querySelector('[data-testid="status-change-comment"]')).toBeNull();
    click(
      Array.from(rendered.container.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Done"),
      ),
    );

    expect(onSelect).toHaveBeenCalledWith("done");
  });

  it("stages a status and submits the status with the comment in one callback", () => {
    const onSelect = vi.fn();
    rendered = renderMenu(
      <StatusPickerMenu {...baseProps()} commentable onSelect={onSelect} />,
    );

    click(
      Array.from(rendered.container.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Todo"),
      ),
    );
    expect(onSelect).not.toHaveBeenCalled();
    expect(rendered.container.textContent).toContain("Change to Todo");

    typeInto(
      rendered.container.querySelector<HTMLTextAreaElement>(
        '[data-testid="status-change-comment"]',
      ),
      "  Starting this now  ",
    );
    click(rendered.container.querySelector('[data-testid="status-change-submit"]'));

    expect(onSelect).toHaveBeenCalledWith("todo", "Starting this now");
  });

  it("submits status only when the comment stays empty", () => {
    const onSelect = vi.fn();
    rendered = renderMenu(
      <StatusPickerMenu {...baseProps()} commentable onSelect={onSelect} />,
    );

    click(
      Array.from(rendered.container.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Done"),
      ),
    );
    click(rendered.container.querySelector('[data-testid="status-change-submit"]'));

    expect(onSelect).toHaveBeenCalledWith("done", undefined);
  });

  it("shows stage verdicts only with a comment and labels the stage participant", () => {
    const onApprove = vi.fn();
    const onRequestChanges = vi.fn();
    rendered = renderMenu(
      <StatusPickerMenu
        {...baseProps()}
        commentable
        reviewActions={{
          stageType: "review",
          onApprove,
          onRequestChanges,
        }}
        onSelect={vi.fn()}
      />,
    );

    expect(rendered.container.textContent).toContain("You are the reviewer for this task.");
    const approve = rendered.container.querySelector<HTMLButtonElement>(
      '[data-testid="status-approve"]',
    );
    const requestChanges = rendered.container.querySelector<HTMLButtonElement>(
      '[data-testid="status-request-changes"]',
    );
    expect(approve?.disabled).toBe(true);
    expect(requestChanges?.disabled).toBe(true);

    typeInto(
      rendered.container.querySelector<HTMLTextAreaElement>(
        '[data-testid="status-change-comment"]',
      ),
      "Looks good to ship",
    );
    expect(approve?.disabled).toBe(false);
    expect(requestChanges?.disabled).toBe(false);

    click(approve);
    expect(onApprove).toHaveBeenCalledWith("Looks good to ship");
    expect(onRequestChanges).not.toHaveBeenCalled();
  });

  it("routes Request changes with the comment and calls the approver stage by name", () => {
    const onApprove = vi.fn();
    const onRequestChanges = vi.fn();
    rendered = renderMenu(
      <StatusPickerMenu
        {...baseProps()}
        commentable
        reviewActions={{
          stageType: "approval",
          pending: false,
          onApprove,
          onRequestChanges,
        }}
        onSelect={vi.fn()}
      />,
    );

    expect(rendered.container.textContent).toContain("You are the approver for this task.");
    typeInto(
      rendered.container.querySelector<HTMLTextAreaElement>(
        '[data-testid="status-change-comment"]',
      ),
      "Please add tests",
    );
    click(rendered.container.querySelector('[data-testid="status-request-changes"]'));

    expect(onRequestChanges).toHaveBeenCalledWith("Please add tests");
    expect(onApprove).not.toHaveBeenCalled();
  });
});
