// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IrApiError } from "../api/irOps";
import { WorkflowsPage } from "./WorkflowsPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const wfApiMocks = vi.hoisted(() => ({
  list: vi.fn(),
  read: vi.fn(),
  create: vi.fn(),
  save: vi.fn(),
}));

vi.mock("../api/irOps", async () => {
  const actual = await vi.importActual<typeof import("../api/irOps")>("../api/irOps");
  return {
    ...actual,
    irOpsApi: {
      ...actual.irOpsApi,
      workflows: {
        list: wfApiMocks.list,
        read: wfApiMocks.read,
        create: wfApiMocks.create,
        save: wfApiMocks.save,
      },
    },
  };
});

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <pre>{children}</pre>,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (val: string) => void;
    children: ReactNode;
  }) => (
    <div>
      <select
        data-testid="wf-profile-select"
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
      >
        <option value="general">general</option>
        <option value="ads-checker">ads-checker</option>
      </select>
      {children}
    </div>
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

function setNativeInput(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll("button")).find((el) =>
    el.textContent?.includes(text),
  );
  if (!btn) throw new Error(`Button containing "${text}" not found`);
  return btn;
}

describe("WorkflowsPage SOP overwrite protection", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();

    wfApiMocks.list.mockResolvedValue({
      ok: true,
      workflows: [
        {
          path: "general/daily-brief.md",
          profile: "general",
          title: "Daily Brief",
          updatedAt: 1_764_000_000,
        },
      ],
    });
    wfApiMocks.read.mockResolvedValue({
      ok: true,
      path: "general/daily-brief.md",
      content: "# Daily Brief\nOriginal content",
    });
    wfApiMocks.create.mockResolvedValue({ ok: true, path: "general/new-playbook.md" });
    wfApiMocks.save.mockResolvedValue({ ok: true, path: "general/daily-brief.md" });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("blocks duplicate SOP creation in the dialog without calling create or save", async () => {
    await act(async () => {
      root.render(<WorkflowsPage />);
    });

    await act(async () => {
      findButton(container, "New workflow").click();
    });

    const nameInput = container.querySelector("#wf-name") as HTMLInputElement;
    await act(async () => {
      setNativeInput(nameInput, "Daily Brief!!!");
    });

    const form = container.querySelector("form")!;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(wfApiMocks.create).not.toHaveBeenCalled();
    expect(wfApiMocks.save).not.toHaveBeenCalled();
    expect(container.textContent).toContain("A playbook already exists at general/daily-brief.md");
  });

  it("calls workflows.create for new SOPs, surfaces server 409 conflicts, and uses workflows.save only for explicit edits", async () => {
    wfApiMocks.create.mockRejectedValueOnce(
      new IrApiError(
        'A playbook already exists at "general/new-playbook.md". Choose a different name or edit the existing playbook.',
        409,
        "workflow_already_exists",
      ),
    );

    await act(async () => {
      root.render(<WorkflowsPage />);
    });

    await act(async () => {
      findButton(container, "New workflow").click();
    });

    const nameInput = container.querySelector("#wf-name") as HTMLInputElement;
    await act(async () => {
      setNativeInput(nameInput, "New Playbook");
    });

    const form = container.querySelector("form")!;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(wfApiMocks.create).toHaveBeenCalledTimes(1);
    expect(wfApiMocks.create.mock.calls[0]?.[0]).toBe("general/new-playbook.md");
    expect(wfApiMocks.save).not.toHaveBeenCalled();
    expect(container.textContent).toContain('A playbook already exists at "general/new-playbook.md"');

    // Close dialog and explicitly edit existing playbook -> calls workflows.save (update mode).
    await act(async () => {
      findButton(container, "Cancel").click();
    });
    await act(async () => {
      findButton(container, "Edit").click();
    });

    const editor = container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      setNativeInput(editor, "# Daily Brief\nUpdated content");
    });
    await act(async () => {
      findButton(container, "Save & Sync to GBrain").click();
    });

    expect(wfApiMocks.save).toHaveBeenCalledTimes(1);
    expect(wfApiMocks.save).toHaveBeenCalledWith(
      "general/daily-brief.md",
      "# Daily Brief\nUpdated content",
    );
  });
});
