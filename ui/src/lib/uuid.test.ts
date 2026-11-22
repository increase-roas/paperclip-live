import { afterEach, describe, expect, it, vi } from "vitest";
import { createUuid } from "./uuid";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createUuid", () => {
  it("uses the platform UUID when the browser provides one", () => {
    const randomUUID = vi.fn(() => "0b7a2c1e-9f7d-4f1a-9c1e-2f7d3a4b5c6d");
    vi.stubGlobal("crypto", { randomUUID });

    expect(createUuid()).toBe("0b7a2c1e-9f7d-4f1a-9c1e-2f7d3a4b5c6d");
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("returns a valid v4 UUID when randomUUID is unavailable on a plain-HTTP page", () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.set(Array.from({ length: bytes.length }, (_, index) => index));
      return bytes;
    });
    vi.stubGlobal("crypto", { getRandomValues });

    const value = createUuid();

    expect(value).toMatch(UUID_V4);
    expect(getRandomValues).toHaveBeenCalledOnce();
  });

  it("returns a valid v4 UUID when the page has no Web Crypto at all", () => {
    vi.stubGlobal("crypto", undefined);

    expect(createUuid()).toMatch(UUID_V4);
  });
});
