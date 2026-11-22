// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AnchorHTMLAttributes } from "react";
import type { Approval } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "./ApprovalCard";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "hire_agent",
    requestedByAgentId: null,
    requestedByUserId: null,
    status: "pending",
    payload: {},
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date("2026-11-21T00:00:00.000Z"),
    updatedAt: new Date("2026-11-21T00:00:00.000Z"),
    ...overrides,
  };
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!button) throw new Error(`Button "${label}" not found`);
  return button as HTMLButtonElement;
}

function typeInto(element: HTMLTextAreaElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  setValue?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ApprovalCard decision note", () => {
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

  function render(props: Parameters<typeof ApprovalCard>[0]) {
    act(() => {
      root.render(<ApprovalCard {...props} />);
    });
  }

  it("keeps quick approve a single click without a note", () => {
    const onApprove = vi.fn();
    render({
      approval: createApproval(),
      requesterAgent: null,
      onApprove,
      onReject: vi.fn(),
      allowDecisionNote: true,
    });

    act(() => findButton(container, "Approve").click());

    expect(onApprove).toHaveBeenCalledWith(undefined);
  });

  it("sends a trimmed note with approve", () => {
    const onApprove = vi.fn();
    render({
      approval: createApproval(),
      requesterAgent: null,
      onApprove,
      onReject: vi.fn(),
      allowDecisionNote: true,
    });

    act(() => findButton(container, "Add note").click());
    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();
    act(() => typeInto(textarea as HTMLTextAreaElement, "  Covered by Q4 budget.  "));
    act(() => findButton(container, "Approve").click());

    expect(onApprove).toHaveBeenCalledWith("Covered by Q4 budget.");
  });

  it("sends the same note with reject", () => {
    const onReject = vi.fn();
    render({
      approval: createApproval(),
      requesterAgent: null,
      onApprove: vi.fn(),
      onReject,
      allowDecisionNote: true,
    });

    act(() => findButton(container, "Add note").click());
    const textarea = container.querySelector("textarea");
    act(() => typeInto(textarea as HTMLTextAreaElement, "Scope is too broad"));
    act(() => findButton(container, "Reject").click());
    act(() => findButton(container, "Confirm reject").click());

    expect(onReject).toHaveBeenCalledWith("Scope is too broad");
  });

  it("treats a whitespace-only note as no note", () => {
    const onApprove = vi.fn();
    render({
      approval: createApproval(),
      requesterAgent: null,
      onApprove,
      onReject: vi.fn(),
      allowDecisionNote: true,
    });

    act(() => findButton(container, "Add note").click());
    const textarea = container.querySelector("textarea");
    act(() => typeInto(textarea as HTMLTextAreaElement, "   "));
    act(() => findButton(container, "Approve").click());

    expect(onApprove).toHaveBeenCalledWith(undefined);
  });

  it("hides the note affordance when the caller does not allow it", () => {
    render({
      approval: createApproval(),
      requesterAgent: null,
      onApprove: vi.fn(),
      onReject: vi.fn(),
    });

    expect(container.textContent).not.toContain("Add note");
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("hides the note affordance while no decision actions are shown", () => {
    render({
      approval: createApproval({ status: "approved" }),
      requesterAgent: null,
      onApprove: vi.fn(),
      onReject: vi.fn(),
      allowDecisionNote: true,
    });

    expect(container.textContent).not.toContain("Add note");
  });
});
