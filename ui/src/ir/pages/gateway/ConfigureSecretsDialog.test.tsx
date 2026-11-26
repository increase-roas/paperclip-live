// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IrApiError } from "../../api/irOps";
import { ConfigureSecretsDialog, type ProviderSecretSchema } from "./ConfigureSecretsDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const saveProviderSecrets = vi.hoisted(() => vi.fn());

vi.mock("../../api/irOps", async () => {
  const actual = await vi.importActual<typeof import("../../api/irOps")>("../../api/irOps");
  return {
    ...actual,
    irOpsApi: {
      ...actual.irOpsApi,
      gateway: { ...actual.irOpsApi.gateway, saveProviderSecrets },
    },
  };
});

vi.mock("@/components/ui/dialog", () => {
  const Pass = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div>{children}</div> : null),
    DialogContent: Pass,
    DialogDescription: Pass,
    DialogFooter: Pass,
    DialogHeader: Pass,
    DialogTitle: Pass,
  };
});

const schema: ProviderSecretSchema = {
  provider: "quickbooks",
  label: "QuickBooks Online",
  fields: [
    { key: "QBO_CLIENT_ID", label: "QuickBooks Client ID" },
    { key: "QBO_CLIENT_SECRET", label: "QuickBooks Client Secret" },
  ],
};

function typeInto(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ConfigureSecretsDialog", () => {
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
    saveProviderSecrets.mockReset();
  });

  it("names the keys already written when a save fails partway", async () => {
    saveProviderSecrets.mockRejectedValue(
      new IrApiError("Cloudflare rejected QBO_CLIENT_SECRET: Authentication error", 502, undefined, undefined, {
        ok: false,
        error: "Cloudflare rejected QBO_CLIENT_SECRET: Authentication error",
        updatedKeys: ["QBO_CLIENT_ID"],
      }),
    );

    await act(async () => {
      root.render(
        <ConfigureSecretsDialog
          open
          schema={schema}
          workerName="increase-roas-oauth-gateway"
          writerConfigured
          onClose={() => {}}
          onSaved={() => {}}
        />,
      );
    });

    const inputs = Array.from(container.querySelectorAll("input"));
    await act(async () => {
      typeInto(inputs[0]!, "id-value");
      typeInto(inputs[1]!, "secret-value");
    });
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(saveProviderSecrets).toHaveBeenCalledWith("quickbooks", {
      QBO_CLIENT_ID: "id-value",
      QBO_CLIENT_SECRET: "secret-value",
    });
    expect(container.textContent).toContain("Cloudflare rejected QBO_CLIENT_SECRET: Authentication error");
    expect(container.textContent).toContain("Already saved: QBO_CLIENT_ID.");
  });
});
