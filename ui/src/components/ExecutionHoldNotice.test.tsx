// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecutionHoldNotice } from "./ExecutionHoldNotice";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const baseHold = {
  recoveryActionId: "action-1",
  runId: "run-1",
  agentId: "agent-1",
  cause: "legacy_execution_requires_reconciliation",
  nextAction: "Inspect the cancelled run before continuing.",
  runStatus: "cancelled",
  runError: "Cancelled before issue reassignment",
  canRetry: false,
};

describe("ExecutionHoldNotice", () => {
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (container) {
      act(() => {
        container!.remove();
      });
      container = null;
    }
  });

  it("shows the real cause, next action, and recorded stop reason", () => {
    const html = renderToStaticMarkup(
      <ExecutionHoldNotice hold={baseHold} canClearHold onClearHold={() => {}} />,
    );
    expect(html).toContain("This task is on an execution hold.");
    expect(html).toContain("Legacy Execution Requires Reconciliation");
    expect(html).toContain("Inspect the cancelled run before continuing.");
    expect(html).toContain("Cancelled before issue reassignment");
    expect(html).toContain("Clear hold");
  });

  it("clears the hold from the board action", () => {
    const onClearHold = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <ExecutionHoldNotice hold={baseHold} canClearHold onClearHold={onClearHold} />,
      );
    });
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="execution-hold-clear"]',
    );
    expect(button).not.toBeNull();
    act(() => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClearHold).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it("offers Retry when the hold is retryable", () => {
    const onRetry = vi.fn();
    const html = renderToStaticMarkup(
      <ExecutionHoldNotice
        hold={{ ...baseHold, canRetry: true }}
        canClearHold={false}
        onClearHold={() => {}}
        onRetry={onRetry}
      />,
    );
    expect(html).toContain("Retry");
  });

  it("stays out of the workspace-repair path and reports no hold when absent", () => {
    expect(
      renderToStaticMarkup(
        <ExecutionHoldNotice
          hold={{ ...baseHold, workspaceRepairRequired: true }}
          canClearHold
          onClearHold={() => {}}
        />,
      ),
    ).toBe("");
    expect(
      renderToStaticMarkup(
        <ExecutionHoldNotice hold={null} canClearHold onClearHold={() => {}} />,
      ),
    ).toBe("");
  });

  it("shows an inline error instead of a toast", () => {
    const html = renderToStaticMarkup(
      <ExecutionHoldNotice
        hold={baseHold}
        canClearHold
        onClearHold={() => {}}
        error="This run may have performed work."
      />,
    );
    expect(html).toContain("This run may have performed work.");
  });
});
