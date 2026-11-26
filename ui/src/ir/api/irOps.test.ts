import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IrApiError, irOpsApi } from "./irOps";

// irFetch is the one transport behind every IR page. The page tests build
// IrApiError by hand, so these cases pin how real responses become errors.

const fetchMock = vi.fn<typeof fetch>();

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function rejectOnAbort(_url: RequestInfo | URL, init?: RequestInit) {
  return new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    const fail = () => reject(new DOMException("The operation was aborted.", "AbortError"));
    if (signal?.aborted) fail();
    signal?.addEventListener("abort", fail, { once: true });
  });
}

async function caught(promise: Promise<unknown>): Promise<IrApiError> {
  const err = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(IrApiError);
  return err as IrApiError;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", globalThis);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("irFetch request shape", () => {
  it("sends cookies and adds a JSON content type only when there is a body", async () => {
    fetchMock.mockImplementation(async () => json({ ok: true }, 200));

    await irOpsApi.gateway.getStatus();
    await irOpsApi.gateway.saveProviderSecrets("fireflies", { FIREFLIES_API_KEY: "ff" });

    const [getUrl, getInit] = fetchMock.mock.calls[0];
    expect(getUrl).toBe("/api/gateway/status");
    expect(getInit?.credentials).toBe("include");
    expect(getInit?.headers).toEqual({ accept: "application/json" });

    const [putUrl, putInit] = fetchMock.mock.calls[1];
    expect(putUrl).toBe("/api/gateway/admin/secrets/fireflies");
    expect(putInit?.method).toBe("PUT");
    expect(putInit?.headers).toEqual({ accept: "application/json", "content-type": "application/json" });
    expect(JSON.parse(String(putInit?.body))).toEqual({ secrets: { FIREFLIES_API_KEY: "ff" } });
  });

  it("returns an empty object for an empty success body", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    await expect(irOpsApi.salesDashboard.disconnectAccounting("acme")).resolves.toEqual({});
  });
});

describe("irFetch error mapping", () => {
  it("keeps updatedKeys on a Gateway secret save that failed partway", async () => {
    fetchMock.mockResolvedValue(
      json(
        {
          ok: false,
          error: "Cloudflare rejected QBO_CLIENT_SECRET: Authentication error",
          updatedKeys: ["QBO_CLIENT_ID"],
        },
        502,
      ),
    );

    const err = await caught(
      irOpsApi.gateway.saveProviderSecrets("quickbooks", { QBO_CLIENT_ID: "id", QBO_CLIENT_SECRET: "secret" }),
    );

    expect(err.status).toBe(502);
    expect(err.message).toBe("Cloudflare rejected QBO_CLIENT_SECRET: Authentication error");
    expect(err.body?.updatedKeys).toEqual(["QBO_CLIENT_ID"]);
  });

  it("shows the server detail and keeps the error code for a playbook conflict", async () => {
    const detail = 'A playbook already exists at "general/new.md". Choose a different name or edit the existing playbook.';
    fetchMock.mockResolvedValue(json({ ok: false, error: "workflow_already_exists", detail }, 409));

    const err = await caught(irOpsApi.workflows.create("general/new.md", "# New"));

    expect(err.status).toBe(409);
    expect(err.message).toBe(detail);
    expect(err.code).toBe("workflow_already_exists");
  });

  it("passes a 503 through so the Gateway page can explain the missing admin key", async () => {
    fetchMock.mockResolvedValue(
      json({ ok: false, error: "Gateway admin key is not configured on this server." }, 503),
    );

    const err = await caught(irOpsApi.gateway.getRoles());

    expect(err.status).toBe(503);
    expect(err.message).toBe("Gateway admin key is not configured on this server.");
  });

  it("prefers detail, then message, then hint, then error for the message", async () => {
    fetchMock.mockResolvedValueOnce(json({ message: "m", hint: "h", error: "e" }, 400));
    expect((await caught(irOpsApi.gateway.getScopes())).message).toBe("m");

    fetchMock.mockResolvedValueOnce(json({ hint: "Reconnect QuickBooks", error: "e" }, 400));
    const hinted = await caught(irOpsApi.gateway.getScopes());
    expect(hinted.message).toBe("Reconnect QuickBooks");
    expect(hinted.hint).toBe("Reconnect QuickBooks");
    expect(hinted.code).toBe("e");

    fetchMock.mockResolvedValueOnce(json({}, 418));
    expect((await caught(irOpsApi.gateway.getScopes())).message).toBe("Request failed (418)");
  });

  it("uses the first 200 characters of a non-JSON error page", async () => {
    const page = `<html>${"x".repeat(400)}</html>`;
    fetchMock.mockResolvedValue(new Response(page, { status: 502 }));

    const err = await caught(irOpsApi.gateway.getProviders());

    expect(err.status).toBe(502);
    expect(err.message).toBe(page.slice(0, 200));
  });

  it("reports a network failure as status 0 with a network_error code", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const err = await caught(irOpsApi.gateway.getHealth());

    expect(err.status).toBe(0);
    expect(err.code).toBe("network_error");
    expect(err.message).toBe("Failed to fetch");
  });
});

describe("irFetch timeouts and cancels", () => {
  it("times out at the call's own limit with a 504 timeout error", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(rejectOnAbort);

    const pending = caught(irOpsApi.voice.getStatus());
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const err = await pending;
    expect(err.status).toBe(504);
    expect(err.code).toBe("timeout");
  });

  it("reports a Javar hang-up as a cancel, not a timeout", async () => {
    fetchMock.mockImplementation(rejectOnAbort);
    const hangUp = new AbortController();

    const pending = caught(irOpsApi.voice.createSession({ signal: hangUp.signal }));
    hangUp.abort();

    const err = await pending;
    expect(err.status).toBe(0);
    expect(err.code).toBe("aborted");
    expect(err.message).toBe("Request cancelled.");
  });

  it("cancels at once when the caller's signal is already aborted", async () => {
    fetchMock.mockImplementation(rejectOnAbort);
    const hangUp = new AbortController();
    hangUp.abort();

    const err = await caught(irOpsApi.voice.runTool("lookup", {}, { signal: hangUp.signal }));

    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(err.code).toBe("aborted");
  });

  it("clears its timer and abort listener once the request settles", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(json({ runs: [] }, 200));
    const session = new AbortController();
    const remove = vi.spyOn(session.signal, "removeEventListener");

    await irOpsApi.voice.getRuns({ signal: session.signal });

    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    session.abort();
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(false);
  });
});
